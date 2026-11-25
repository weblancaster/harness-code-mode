import test from "node:test";
import assert from "node:assert/strict";
import registerPiExtension from "../adapters/pi/index.ts";

function makeFakePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    getAllTools() {
      return Array.from(tools.values());
    },
  };
  return { pi, tools, commands, handlers };
}

test("Pi extension registers codemode with exposure, reachesTools, prepareLoadout, /codemode, and session_shutdown", () => {
  const { pi, tools, commands, handlers } = makeFakePi();
  registerPiExtension(pi);

  const tool = tools.get("codemode");
  assert.ok(tool);
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.reachesTools({ code: "return 1;" }), "all");
  assert.equal(typeof tool.prepareLoadout, "function");

  const loadout = tool.prepareLoadout({
    callableTools: [
      { name: "mcp__jira__search", description: "Search Jira", exposure: "codemode" },
      { name: "bash", description: "Run shell", exposure: "direct" },
    ],
  });
  assert.ok(loadout.descriptions.codemode.includes("mcp__jira__search") || loadout.descriptions.codemode.includes("1"));
  assert.ok(commands.has("codemode"));
  assert.ok(handlers.has("session_shutdown"));
  assert.equal(handlers.has("session_before_switch"), false);
});

test("Pi extension executes parallel ctx.executeTool calls, prefers structuredContent, handles Pi helpers and errors", async () => {
  const { pi, tools, handlers } = makeFakePi();
  registerPiExtension(pi);
  const codemode = tools.get("codemode");
  const seen = [];

  const ctx = {
    sessionId: "pi-sess-1",
    tools: [
      { name: "codemode", description: "self", parameters: {} },
      { name: "bash", description: "Run shell", parameters: { type: "object" } },
      { name: "read", description: "Read file", parameters: { type: "object" } },
      { name: "edit", description: "Edit file", parameters: { type: "object" } },
      { name: "mcp__svc__get", description: "Get structured record", parameters: { type: "object" } },
      { name: "mcp__svc__denied", description: "Blocked by permission gate", parameters: { type: "object" } },
    ],
    async executeTool(name, args) {
      seen.push({ name, args });
      if (name === "bash") {
        if (String(args.command || "").includes("false")) {
          return { isError: true, content: [{ type: "text", text: "Command exited with code 1" }] };
        }
        if (String(args.command || "").includes("json-out")) {
          return { content: [{ type: "text", text: '{"a":1}' }] };
        }
        return { content: [{ type: "text", text: "ok\n" }] };
      }
      if (name === "read") {
        return { content: [{ type: "text", text: '{"pkg":"demo"}' }] };
      }
      if (name === "edit") {
        return { content: [{ type: "text", text: "edited" }] };
      }
      if (name === "mcp__svc__get") {
        // Must prefer structuredContent over text content
        return {
          structuredContent: { id: args.id, fromStructured: true },
          content: [{ type: "text", text: "fallback-text-should-not-win" }],
        };
      }
      if (name === "mcp__svc__denied") {
        return {
          isError: true,
          content: [{ type: "text", text: "Blocked by user permission gate" }],
        };
      }
      return { isError: true, content: [{ type: "text", text: "unknown" }] };
    },
    ui: { notify() {} },
  };

  try {
    const res = await codemode.execute(
      "call-1",
      {
        code: `
          const [a, b] = await Promise.all([
            tools.mcp__svc__get({ id: 1 }),
            tools.mcp__svc__get({ id: 2 }),
          ]);
          const sh = await $\`echo hi\`.cwd("/tmp").text();
          const shJson = await $\`echo json-out\`.json();
          const shFail = await $\`false\`.nothrow();
          const pkgFile = await read("package.json");
          await edit("a.ts", "old", "new");
          let caught = "";
          try { await tools.mcp__svc__denied({}); } catch (e) { caught = e.message; }
          return { a, b, sh: sh.trim(), shJson, shFailCode: shFail.exit_code, pkg: JSON.parse(pkgFile.text), caught };
        `,
      },
      new AbortController().signal,
      () => {},
      ctx,
    );
    const out = res.details;
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(out.result.a, { id: 1, fromStructured: true });
    assert.deepEqual(out.result.b, { id: 2, fromStructured: true });
    assert.equal(out.result.sh, "ok");
    assert.deepEqual(out.result.shJson, { a: 1 });
    assert.equal(out.result.shFailCode, 1);
    assert.deepEqual(out.result.pkg, { pkg: "demo" });
    assert.match(out.result.caught, /permission gate/i);

    const bashCall = seen.find((s) => s.name === "bash");
    assert.equal(bashCall.args.command, "cd '/tmp' && echo hi");
    const editCall = seen.find((s) => s.name === "edit");
    assert.deepEqual(editCall.args, { path: "a.ts", oldText: "old", newText: "new" });
  } finally {
    for (const fn of handlers.get("session_shutdown") || []) await fn();
  }
});

test("Pi extension honors AbortSignal lock-free and /codemode reset clears worker", async () => {
  const { pi, tools, commands, handlers } = makeFakePi();
  registerPiExtension(pi);
  const codemode = tools.get("codemode");
  const notices = [];
  const ctx = {
    sessionId: "pi-sess-2",
    tools: [],
    async executeTool() {
      return { content: [] };
    },
    ui: {
      notify(msg) {
        notices.push(msg);
      },
    },
  };

  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const res = await codemode.execute(
      "call-abort",
      { code: "while (true) {}", timeout: 30 },
      ac.signal,
      () => {},
      ctx,
    );
    assert.equal(res.details.ok, false);
    assert.match(res.details.error, /abort/i);
    assert.ok(Date.now() - t0 < 1500);

    await commands.get("codemode").handler("status", ctx);
    await commands.get("codemode").handler("reset", ctx);
    assert.ok(notices.length >= 2);
  } finally {
    for (const fn of handlers.get("session_shutdown") || []) await fn();
  }
});
