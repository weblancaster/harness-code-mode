import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "adapters", "mcp", "cli.js");

function spawnMcp(args = []) {
  const proc = spawn(process.execPath, [CLI_PATH, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 1;
  const pending = new Map();
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP timeout for ${method} (stderr: ${stderr})`));
      }, 10000);
      pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params = {}) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async function close() {
    proc.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 1500);
      proc.once("exit", () => { clearTimeout(t); resolve(); });
    });
  }
  return { proc, rpc, notify, close };
}

test("MCP server negotiates protocolVersion, exposes only codemode + codemode_reset, and aggregates upstream MCP", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-mcp-srv-"));
  const upstreamScript = path.join(tmp, "upstream.js");
  fs.writeFileSync(
    upstreamScript,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const r = JSON.parse(line);
  if (r.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }) + "\\n");
  } else if (r.method === "tools/list") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: r.id,
      result: { tools: [{ name: "double", description: "Double a number", inputSchema: { type: "object" } }] }
    }) + "\\n");
  } else if (r.method === "tools/call") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: r.id,
      result: { content: [{ type: "text", text: JSON.stringify({ out: r.params.arguments.n * 2 }) }] }
    }) + "\\n");
  }
});
`,
  );
  const cfgPath = path.join(tmp, "mcp.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ mcpServers: { math: { command: process.execPath, args: [upstreamScript] } } }),
  );

  const client = spawnMcp(["--config", cfgPath]);
  try {
    const init = await client.rpc("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(init.result.protocolVersion, "2024-11-05");
    client.notify("notifications/initialized", {});

    const list = await client.rpc("tools/list", {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ["codemode", "codemode_reset"]);

    const call = await client.rpc("tools/call", {
      name: "codemode",
      arguments: {
        code: `
          const found = searchTools("double number", 3);
          const vals = await Promise.all([10, 21].map((n) => tools.mcp__math__double({ n })));
          state.total = vals.reduce((s, v) => s + v.out, 0);
          return { tool: found[0].name, total: state.total };
        `,
      },
    });
    const parsed = JSON.parse(call.result.content[0].text);
    assert.equal(parsed.ok, true, parsed.error);
    assert.deepEqual(parsed.result, { tool: "mcp__math__double", total: 62 });

    // Local tools must be absent by default
    const noLocal = await client.rpc("tools/call", {
      name: "codemode",
      arguments: { code: 'return await read("README.md");' },
    });
    const noLocalParsed = JSON.parse(noLocal.result.content[0].text);
    assert.equal(noLocalParsed.ok, false);

    // codemode_reset clears persistent state
    await client.rpc("tools/call", { name: "codemode_reset", arguments: {} });
    const afterReset = await client.rpc("tools/call", {
      name: "codemode",
      arguments: { code: "return state.total ?? null;" },
    });
    assert.equal(JSON.parse(afterReset.result.content[0].text).result, null);
  } finally {
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("MCP server with --allow-local-tools runs workspace helpers and handles cancellation", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cm-mcp-local-"));
  fs.writeFileSync(path.join(ws, "note.txt"), "hello world\n");
  const client = spawnMcp(["--allow-local-tools", "--workspace", ws]);
  try {
    await client.rpc("initialize", { protocolVersion: "2025-03-26" });
    const res = await client.rpc("tools/call", {
      name: "codemode",
      arguments: {
        code: `
          await edit("note.txt", "world", "codemode");
          const f = await read("note.txt");
          const out = await $\`echo ok\`.text();
          return { text: f.text.trim(), out: out.trim() };
        `,
      },
    });
    const parsed = JSON.parse(res.result.content[0].text);
    assert.equal(parsed.ok, true, parsed.error);
    assert.deepEqual(parsed.result, { text: "hello codemode", out: "ok" });

    // Cancellation kills runaway script quickly
    const reqPromise = client.rpc("tools/call", {
      name: "codemode",
      arguments: { code: "while (true) {}", timeout: 30 },
    });
    setTimeout(() => client.notify("notifications/cancelled", { reason: "user cancel" }), 150);
    const cancelled = await reqPromise;
    const cancelParsed = JSON.parse(cancelled.result.content[0].text);
    assert.equal(cancelParsed.ok, false);
    assert.match(cancelParsed.error, /cancel|abort/i);
  } finally {
    await client.close();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
