import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createLocalTools } from "../core/local-tools.js";
import { McpAggregator, expandHome, loadUpstreamConfig } from "../core/mcp-client.js";

test("local-tools confines reads, writes, edits, grep, glob, and shell to workspace", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cm-ws-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cm-out-"));
  const outsideFile = path.join(outside, "secret.txt");
  fs.writeFileSync(outsideFile, "outside-secret");
  fs.symlinkSync(outsideFile, path.join(ws, "escape-link.txt"));

  try {
    const local = createLocalTools(ws);
    await local.dispatch("local_write", { path: "src/app.js", content: "const retry = 3;\nconst ok = true;\n" });
    const r = await local.dispatch("local_read", { path: "src/app.js" });
    assert.match(r.content, /retry = 3/);

    await local.dispatch("local_edit", {
      path: "src/app.js",
      old_string: "retry = 3",
      new_string: "retry = 5",
    });
    const r2 = await local.dispatch("local_read", { path: "src/app.js" });
    assert.match(r2.content, /retry = 5/);

    const gr = await local.dispatch("local_grep", { pattern: "retry = 5" });
    assert.ok(gr.matches.length >= 1);

    const gl = await local.dispatch("local_glob", { pattern: "*.js" });
    assert.ok(gl.matches.some((m) => m.endsWith("app.js")));

    const sh = await local.dispatch("local_shell", { command: "echo hello-local" });
    assert.equal(sh.exit_code, 0);
    assert.match(sh.output, /hello-local/);

    // Traversal and symlink escapes MUST be rejected
    await assert.rejects(
      () => local.dispatch("local_read", { path: "../outside.txt" }),
      /escapes workspace/i,
    );
    await assert.rejects(
      () => local.dispatch("local_read", { path: "escape-link.txt" }),
      /escapes workspace/i,
    );
    await assert.rejects(
      () => local.dispatch("local_shell", { command: "pwd", workdir: outside }),
      /escapes workspace/i,
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("McpAggregator connects stdio upstream server and dispatches concurrent calls", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-mcp-stdio-"));
  const fakeServer = path.join(tmpDir, "fake-mcp.js");
  fs.writeFileSync(
    fakeServer,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } }
    }) + "\\n");
  } else if (req.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          { name: "echo", description: "Echo input", inputSchema: { type: "object" } },
          { name: "add", description: "Add numbers", inputSchema: { type: "object" } }
        ]
      }
    }) + "\\n");
  } else if (req.method === "tools/call") {
    const { name, arguments: a } = req.params;
    const payload = name === "add" ? { sum: a.a + a.b } : { echoed: a.msg };
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] }
      }) + "\\n");
    }, 30);
  }
});
`,
  );

  const agg = new McpAggregator({
    demo: { command: process.execPath, args: [fakeServer] },
  });
  try {
    await agg.connect();
    const names = agg.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["mcp__demo__add", "mcp__demo__echo"]);
    const [r1, r2] = await Promise.all([
      agg.dispatch("mcp__demo__echo", { msg: "hi" }),
      agg.dispatch("mcp__demo__add", { a: 19, b: 23 }),
    ]);
    assert.deepEqual(r1, { echoed: "hi" });
    assert.deepEqual(r2, { sum: 42 });
  } finally {
    await agg.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("McpAggregator connects Streamable HTTP upstream server with Bearer env token", async () => {
  process.env.TEST_MCP_TOKEN = "tok-123";
  let seenAuth = "";
  const srv = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || "";
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Mcp-Session-Id", "sess-http-1");
      if (msg.method === "initialize") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }));
      } else if (msg.method === "tools/list") {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [{ name: "ping", description: "Ping HTTP", inputSchema: { type: "object" } }] },
        }));
      } else if (msg.method === "tools/call") {
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { structuredContent: { pong: msg.params.arguments.v } },
        }));
      } else {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
      }
    });
  });

  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  const agg = new McpAggregator({
    remote: { url: `http://127.0.0.1:${port}/mcp`, bearer_token_env_var: "TEST_MCP_TOKEN" },
  });
  try {
    await agg.connect();
    assert.equal(seenAuth, "Bearer tok-123");
    const out = await agg.dispatch("mcp__remote__ping", { v: 7 });
    assert.deepEqual(out, { pong: 7 });
  } finally {
    await agg.close();
    await new Promise((resolve) => srv.close(resolve));
    delete process.env.TEST_MCP_TOKEN;
  }
});

test("loadUpstreamConfig expands ~, parses mcp.json + Codex TOML, honors enabled=false, skips self", () => {
  assert.equal(expandHome("~/foo/bar"), path.join(os.homedir(), "foo/bar"));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-cfg-"));
  try {
    const mcpJson = path.join(tmpDir, "mcp.json");
    fs.writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "server-github"] },
          codemode: { command: "node", args: ["adapters/mcp/cli.js"] },
        },
      }),
    );
    const codexToml = path.join(tmpDir, "config.toml");
    fs.writeFileSync(
      codexToml,
      `
model = "o4-mini"

[mcp_servers.docs]
url = "https://example.invalid/mcp"
bearer_token_env_var = "DOCS_TOKEN"

[mcp_servers.disabled_srv]
command = "node"
args = ["disabled.js"]
enabled = false

[mcp_servers.oauth_srv]
url = "https://oauth.invalid/mcp"
auth = "oauth"

[mcp_servers.codemode]
command = "npx"
args = ["-y", "github:weblancaster/harness-code-mode"]

[mcp_servers.local_stdio]
command = "node"
args = ["srv.js", "--flag"]

[mcp_servers.local_stdio.env]
FOO = "bar"
`,
    );

    const servers = loadUpstreamConfig({ configPath: mcpJson, codexConfigPath: codexToml });
    assert.deepEqual(Object.keys(servers).sort(), ["docs", "github", "local_stdio"]);
    assert.equal(servers.docs.url, "https://example.invalid/mcp");
    assert.equal(servers.docs.bearer_token_env_var, "DOCS_TOKEN");
    assert.deepEqual(servers.local_stdio.args, ["srv.js", "--flag"]);
    assert.deepEqual(servers.local_stdio.env, { FOO: "bar" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
