import test from "node:test";
import assert from "node:assert/strict";
import { CodemodeManager } from "../core/session.js";

const ISSUES = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  title: `issue ${i + 1}`,
  labels: (i + 1) % 3 === 0 ? ["urgent"] : [],
}));

test("end-to-end chain filters 50KB inside sandbox and returns compact summary", async () => {
  const mgr = new CodemodeManager();
  try {
    const tools = [
      { name: "list_issues", description: "List issues", schema: {} },
      { name: "get_issue", description: "Get issue body", schema: {} },
    ];
    const dispatch = async (name, args) => {
      if (name === "list_issues") return ISSUES;
      if (name === "get_issue") return { id: args.id, body: "x".repeat(5000) };
      throw new Error("unexpected " + name);
    };
    const out = await mgr.run({
      sessionId: "s1",
      code: `
        const urgent = (await tools.list_issues({})).filter((i) => i.labels.includes("urgent"));
        const bodies = await Promise.all(urgent.map((i) => tools.get_issue({ id: i.id })));
        return { count: urgent.length, totalChars: bodies.reduce((s, b) => s + b.body.length, 0) };
      `,
      tools,
      dispatch,
    });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(out.result, { count: 10, totalChars: 50000 });
    assert.equal(out.stats.tool_calls, 11);
    assert.ok(JSON.stringify(out).length < 2000);
  } finally {
    await mgr.closeAll();
  }
});

test("Promise.all achieves parallel speedup bounded by maxConcurrency", async () => {
  const mgr = new CodemodeManager({ maxConcurrency: 4 });
  try {
    let active = 0;
    let peak = 0;
    const tools = [{ name: "slow_op", description: "sleeps 200ms", schema: {} }];
    const dispatch = async (_name, args) => {
      active++;
      if (active > peak) peak = active;
      await new Promise((r) => setTimeout(r, 200));
      active--;
      return { i: args.i };
    };
    const t0 = Date.now();
    const out = await mgr.run({
      sessionId: "par",
      code: "return await Promise.all([1,2,3,4].map((i) => tools.slow_op({ i })));",
      tools,
      dispatch,
      maxConcurrency: 4,
    });
    const elapsed = Date.now() - t0;
    assert.equal(out.ok, true, out.error);
    assert.equal(out.result.length, 4);
    assert.ok(elapsed < 600, `expected <600ms parallel wall clock, got ${elapsed}ms`);
    assert.ok(peak >= 2, `expected parallel peak >=2, got ${peak}`);
  } finally {
    await mgr.closeAll();
  }
});

test("persistent state, reset, and session isolation", async () => {
  const mgr = new CodemodeManager();
  try {
    const run = (sessionId, code, reset = false) =>
      mgr.run({ sessionId, code, tools: [], dispatch: async () => null, reset });

    assert.equal((await run("s1", "state.x = 7; return state.x;")).result, 7);
    assert.equal((await run("s1", "return state.x;")).result, 7);
    assert.equal((await run("s2", "return state.x ?? null;")).result, null);
    assert.equal((await run("s1", "return state.x ?? null;", true)).result, null);
  } finally {
    await mgr.closeAll();
  }
});

test("runaway timeout hard-kills worker and AbortSignal interrupts lock-free", async () => {
  const mgr = new CodemodeManager();
  try {
    const t0 = Date.now();
    const out1 = await mgr.run({
      sessionId: "t1",
      code: "while (true) {}",
      tools: [],
      dispatch: async () => null,
      timeoutSec: 0.6,
    });
    assert.equal(out1.ok, false);
    assert.match(out1.error, /timeout/i);
    assert.ok(Date.now() - t0 < 2500);

    // Next run auto-respawns cleanly
    const out2 = await mgr.run({
      sessionId: "t1",
      code: "return 99;",
      tools: [],
      dispatch: async () => null,
    });
    assert.equal(out2.ok, true);
    assert.equal(out2.result, 99);

    // AbortSignal lock-free interrupt
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t1 = Date.now();
    const out3 = await mgr.run({
      sessionId: "t1",
      code: "while (true) {}",
      tools: [],
      dispatch: async () => null,
      timeoutSec: 30,
      signal: ac.signal,
    });
    assert.equal(out3.ok, false);
    assert.match(out3.error, /abort|interrupt/i);
    assert.ok(Date.now() - t1 < 1500);
  } finally {
    await mgr.closeAll();
  }
});

test("enforces tool-call budget, host allowlist, truncation, env scrubbing, and LRU eviction", async () => {
  process.env.SECRET_API_KEY = "super-secret-value";
  const mgr = new CodemodeManager({ maxSessions: 2, idleTtlMs: 60_000 });
  try {
    const tools = [{ name: "ping", description: "ping", schema: {} }];
    const dispatch = async () => ({ ok: true });

    // Budget
    const over = await mgr.run({
      sessionId: "b1",
      code: `
        for (let i = 0; i < 6; i++) {
          await tools.ping({ i });
        }
        return "done";
      `,
      tools,
      dispatch,
      maxToolCalls: 3,
    });
    assert.equal(over.ok, false);
    assert.match(over.error, /budget/i);

    // Truncation
    const big = await mgr.run({
      sessionId: "b1",
      code: 'return "a".repeat(2000);',
      tools: [],
      dispatch,
      maxResultChars: 200,
    });
    assert.equal(big.ok, true);
    assert.equal(big.truncated, true);
    assert.ok(String(big.result).length <= 260);

    // LRU maxSessions=2: creating b1, b2, b3 evicts b1
    await mgr.run({ sessionId: "b2", code: "state.v = 2; return 2;", tools: [], dispatch });
    await mgr.run({ sessionId: "b3", code: "state.v = 3; return 3;", tools: [], dispatch });
    assert.equal(mgr.activeCount(), 2);

    // Host-side allowlist rejects forged call frame for disallowed tool without invoking dispatch
    let forgedDispatched = false;
    const sess = mgr._getOrCreate("b3");
    const sent = [];
    const origSend = sess._send.bind(sess);
    sess._send = (obj) => {
      sent.push(obj);
      return true;
    };
    sess._activeRun = {
      execId: 99,
      allowedTools: new Set(["ping"]),
      dispatch: async () => {
        forgedDispatched = true;
        return null;
      },
      maxToolCalls: 10,
      toolCalls: 0,
      calls: [],
      sem: { run: (fn) => fn() },
      settled: false,
      finish: () => {},
    };
    sess._handleWorkerFrame({ type: "call", exec_id: 99, id: 1, tool: "delegate_task", args: {} });
    sess._handleWorkerFrame({ type: "call", exec_id: 98, id: 2, tool: "ping", args: {} }); // stale exec_id
    sess._activeRun = null;
    sess._send = origSend;
    assert.equal(forgedDispatched, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].ok, false);
    assert.match(sent[0].error, /not allowed/);
  } finally {
    delete process.env.SECRET_API_KEY;
    await mgr.closeAll();
  }
});
