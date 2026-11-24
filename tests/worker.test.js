import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_RAW = path.join(REPO_ROOT, "core", "worker.js");
const CATALOG_RAW = path.join(REPO_ROOT, "core", "catalog.js");

function spawnWorker({ workerPath = WORKER_RAW, catalogPath = CATALOG_RAW } = {}) {
  const wReal = fs.realpathSync(workerPath);
  const cReal = fs.realpathSync(catalogPath);
  const child = spawn(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${wReal}`,
      `--allow-fs-read=${cReal}`,
      "--max-old-space-size=128",
      wReal,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "", HOME: os.homedir(), LANG: "en_US.UTF-8" },
    },
  );
  const queue = [];
  const waiters = [];
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  function nextMsg(timeoutMs = 5000) {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for worker msg (stderr: ${stderr})`)), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }
  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }
  async function close() {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return { child, send, nextMsg, close, getStderr: () => stderr };
}

test("worker handles init, exec, console.log, and symlinked worker path", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-sym-"));
  const linkDir = path.join(tmpDir, "linked-core");
  fs.symlinkSync(path.join(REPO_ROOT, "core"), linkDir);
  const w = spawnWorker({
    workerPath: path.join(linkDir, "worker.js"),
    catalogPath: path.join(linkDir, "catalog.js"),
  });
  try {
    const ready = await w.nextMsg();
    assert.equal(ready.type, "ready");
    w.send({ type: "init", tools: [], helperBindings: {} });
    w.send({
      type: "exec",
      exec_id: 1,
      code: 'console.log("hello", 42); return { sum: 20 + 22 };',
    });
    const done = await w.nextMsg();
    assert.equal(done.type, "done");
    assert.equal(done.exec_id, 1);
    assert.equal(done.ok, true);
    assert.deepEqual(done.result, { sum: 42 });
    assert.deepEqual(done.logs, ["hello 42"]);
  } finally {
    await w.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Promise.all emits concurrent call frames with exec_id before any reply", async () => {
  const w = spawnWorker();
  try {
    await w.nextMsg();
    w.send({
      type: "init",
      tools: [
        { name: "tool_a", description: "A", schema: {} },
        { name: "tool_b", description: "B", schema: {} },
      ],
      helperBindings: {},
    });
    w.send({
      type: "exec",
      exec_id: 7,
      code: "const res = await Promise.all([tools.tool_a({x:1}), tools.tool_b({x:2})]); return res;",
    });
    const c1 = await w.nextMsg();
    const c2 = await w.nextMsg();
    assert.equal(c1.type, "call");
    assert.equal(c2.type, "call");
    assert.equal(c1.exec_id, 7);
    assert.equal(c2.exec_id, 7);
    assert.equal(c1.tool, "tool_a");
    assert.equal(c2.tool, "tool_b");
    w.send({ type: "reply", exec_id: 7, id: c2.id, ok: true, result: { got: "b" } });
    w.send({ type: "reply", exec_id: 7, id: c1.id, ok: true, result: { got: "a" } });
    const done = await w.nextMsg();
    assert.equal(done.ok, true);
    assert.deepEqual(done.result, [{ got: "a" }, { got: "b" }]);
  } finally {
    await w.close();
  }
});

test("persistent state survives across exec calls", async () => {
  const w = spawnWorker();
  try {
    await w.nextMsg();
    w.send({ type: "init", tools: [], helperBindings: {} });
    w.send({ type: "exec", exec_id: 1, code: "state.n = 41; return state.n;" });
    assert.equal((await w.nextMsg()).result, 41);
    w.send({ type: "exec", exec_id: 2, code: "return state.n + 1;" });
    assert.equal((await w.nextMsg()).result, 42);
  } finally {
    await w.close();
  }
});

test("unhandled rejection does not crash worker and stale exec calls are dropped", async () => {
  const w = spawnWorker();
  try {
    await w.nextMsg();
    w.send({
      type: "init",
      tools: [
        { name: "slow", description: "slow", schema: {} },
        { name: "fastFail", description: "fails", schema: {} },
        { name: "after", description: "after", schema: {} },
      ],
      helperBindings: {},
    });
    w.send({
      type: "exec",
      exec_id: 1,
      code: `
        state.alive = true;
        const p1 = tools.slow({});
        p1.then(() => tools.after({ stale: true })).catch(() => {});
        const p2 = tools.fastFail({});
        await p2;
        return await p1;
      `,
    });
    const c1 = await w.nextMsg();
    const c2 = await w.nextMsg();
    assert.equal(c1.tool, "slow");
    assert.equal(c2.tool, "fastFail");
    // Reject fastFail while slow is still pending
    w.send({ type: "reply", exec_id: 1, id: c2.id, ok: false, error: "boom" });
    const done1 = await w.nextMsg();
    assert.equal(done1.type, "done");
    assert.equal(done1.ok, false);
    assert.match(done1.error, /boom/);

    // Now start exec 2 and also send late reply for exec 1's slow call; worker must stay alive and drop stale call
    w.send({ type: "reply", exec_id: 1, id: c1.id, ok: true, result: { ok: 1 } });
    w.send({ type: "exec", exec_id: 2, code: "return { survived: state.alive };" });
    const done2 = await w.nextMsg();
    assert.equal(done2.type, "done");
    assert.equal(done2.exec_id, 2);
    assert.equal(done2.ok, true);
    assert.deepEqual(done2.result, { survived: true });
  } finally {
    await w.close();
  }
});

test("helperBindings support Hermes and Pi conventions with POSIX quoting and read line-stripping", async () => {
  const w = spawnWorker();
  try {
    await w.nextMsg();
    // 1) Hermes bindings
    w.send({
      type: "init",
      tools: [
        { name: "terminal", description: "run cmd", schema: {} },
        { name: "read_file", description: "read file", schema: {} },
        { name: "patch", description: "edit file", schema: {} },
        { name: "write_file", description: "write file", schema: {} },
        { name: "search_files", description: "search", schema: {} },
      ],
      helperBindings: {
        shell: "terminal",
        shellCwdKey: "workdir",
        read: "read_file",
        readStripLineNums: true,
        edit: "patch",
        editKeys: ["path", "old_string", "new_string"],
        write: "write_file",
        grep: "search_files",
        glob: "search_files",
      },
    });
    w.send({
      type: "exec",
      exec_id: 1,
      code: `
        const out = await $\`echo \${"a; echo pwned"}\`.cwd("/tmp").text();
        const failed = await $\`false\`.nothrow();
        const f = await read("/tmp/demo.json");
        await edit("/tmp/demo.json", "old", "new");
        await write("/tmp/out.txt", "hi");
        const g1 = await grep("foo", { path: "src" });
        const g2 = await glob("*.js");
        return { out, failedCode: failed.exit_code, parsed: JSON.parse(f.text), raw: f.content, g1, g2 };
      `,
    });
    const calls = [];
    const replies = [
      (c) => ({ output: "a; echo pwned\n", exit_code: 0, _seen: c.args }),
      (c) => ({ output: "", exit_code: 1, _seen: c.args }),
      () => ({ content: '1|{"k": 1}\n2|', total_lines: 2 }),
      () => ({ success: true }),
      () => ({ verified: true }),
      () => ({ matches: ["a.js:1"] }),
      () => ({ matches: ["a.js"] }),
    ];
    for (let i = 0; i < replies.length; i++) {
      const c = await w.nextMsg();
      calls.push(c);
      w.send({ type: "reply", exec_id: 1, id: c.id, ok: true, result: replies[i](c) });
    }
    const done1 = await w.nextMsg();
    assert.equal(done1.ok, true, done1.error);
    assert.equal(calls[0].tool, "terminal");
    assert.equal(calls[0].args.command, "echo 'a; echo pwned'");
    assert.equal(calls[0].args.workdir, "/tmp");
    assert.equal(done1.result.failedCode, 1);
    assert.deepEqual(done1.result.parsed, { k: 1 });
    assert.equal(calls[3].tool, "patch");
    assert.deepEqual(calls[3].args, { path: "/tmp/demo.json", old_string: "old", new_string: "new" });
    assert.equal(calls[5].args.target, "content");
    assert.equal(calls[6].args.target, "files");

    // 2) Pi bindings via update_catalog
    w.send({
      type: "update_catalog",
      tools: [
        { name: "bash", description: "run bash", schema: {} },
        { name: "read", description: "read", schema: {} },
        { name: "edit", description: "edit", schema: {} },
        { name: "write", description: "write", schema: {} },
        { name: "grep", description: "grep", schema: {} },
        { name: "find", description: "find", schema: {} },
      ],
      helperBindings: {
        shell: "bash",
        shellCwdKey: null,
        read: "read",
        readStripLineNums: false,
        edit: "edit",
        editKeys: ["path", "oldText", "newText"],
        write: "write",
        grep: "grep",
        glob: "find",
      },
    });
    w.send({
      type: "exec",
      exec_id: 2,
      code: `
        const s = await $\`ls\`.cwd("/tmp/work").text();
        await edit("a.ts", "foo", "bar");
        return s;
      `,
    });
    const piShell = await w.nextMsg();
    assert.equal(piShell.tool, "bash");
    assert.equal(piShell.args.command, "cd '/tmp/work' && ls");
    w.send({ type: "reply", exec_id: 2, id: piShell.id, ok: true, result: { output: "ok", exit_code: 0 } });
    const piEdit = await w.nextMsg();
    assert.equal(piEdit.tool, "edit");
    assert.deepEqual(piEdit.args, { path: "a.ts", oldText: "foo", newText: "bar" });
    w.send({ type: "reply", exec_id: 2, id: piEdit.id, ok: true, result: { ok: true } });
    const done2 = await w.nextMsg();
    assert.equal(done2.ok, true);
    assert.equal(done2.result, "ok");
  } finally {
    await w.close();
  }
});

test("searchTools, describeTool, and unknown tool hints work locally without RPC", async () => {
  const w = spawnWorker();
  try {
    await w.nextMsg();
    w.send({
      type: "init",
      tools: [
        { name: "mcp__tracker__list_issues", description: "List issues", schema: { type: "object" } },
        { name: "mcp__weather__forecast", description: "Weather forecast", schema: { type: "object" } },
      ],
      helperBindings: {},
    });
    w.send({
      type: "exec",
      exec_id: 1,
      code: `
        const hits = searchTools("weather forecast", 3);
        const desc = describeTool("mcp__tracker__list_issues");
        let typoErr = "";
        try { await tools.mcp__tracker__list_isues({}); } catch (e) { typoErr = e.message; }
        return { first: hits[0].name, schema: desc.schema, typoErr };
      `,
    });
    const done = await w.nextMsg();
    assert.equal(done.ok, true);
    assert.equal(done.result.first, "mcp__weather__forecast");
    assert.deepEqual(done.result.schema, { type: "object" });
    assert.match(done.result.typoErr, /did you mean:.*mcp__tracker__list_issues/);
  } finally {
    await w.close();
  }
});

test("primitive-only VM boundary blocks process/require/fetch and constructor escapes on Promise/Error/result", async () => {
  const w = spawnWorker();
  try {
    await w.nextMsg();
    w.send({
      type: "init",
      tools: [
        { name: "ok_tool", description: "returns obj", schema: { type: "object" } },
        { name: "err_tool", description: "throws err", schema: {} },
      ],
      helperBindings: {},
    });
    w.send({
      type: "exec",
      exec_id: 1,
      code: `
        const checks = {
          process: typeof process,
          require: typeof require,
          fetch: typeof fetch,
          rpcGlobal: typeof __rpc,
        };
        const p = tools.ok_tool({ a: 1 });
        const r = await p;
        let errObj = null;
        try { await tools.err_tool({}); } catch (e) { errObj = e; }
        const sHits = searchTools("returns obj", 3);
        const dRes = describeTool("ok_tool");

        const escaped = [];
        for (const [label, val] of [
          ["promise", p],
          ["result", r],
          ["error", errObj],
          ["search", sHits],
          ["describe", dRes],
          ["toolFn", tools.ok_tool],
          ["state", state],
        ]) {
          try {
            const t = val.constructor.constructor("return typeof process")();
            if (t !== "undefined") escaped.push(label + ":" + t);
          } catch {}
        }
        return { checks, escaped };
      `,
    });
    const c1 = await w.nextMsg();
    assert.equal(c1.tool, "ok_tool");
    w.send({ type: "reply", exec_id: 1, id: c1.id, ok: true, result: { nested: [1, 2, 3] } });
    const c2 = await w.nextMsg();
    assert.equal(c2.tool, "err_tool");
    w.send({ type: "reply", exec_id: 1, id: c2.id, ok: false, error: "upstream 500" });
    const done = await w.nextMsg();
    assert.equal(done.ok, true, done.error);
    assert.deepEqual(done.result.checks, {
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      rpcGlobal: "undefined",
    });
    assert.deepEqual(done.result.escaped, []);
  } finally {
    await w.close();
  }
});
