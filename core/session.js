/**
 * Persistent per-session Node.js Code Mode worker manager (used by Pi and MCP adapters).
 *
 * Host-side trust boundary:
 * - Treats every frame from the worker as untrusted.
 * - Verifies `exec_id === activeExecId`, tool membership in the active allowlist,
 *   tool-call budget, and bounded concurrency semaphore on the host side.
 * - Spawns worker with `--permission --allow-fs-read=<realpath(worker.js)> --allow-fs-read=<realpath(catalog.js)>`,
 *   `--max-old-space-size=<memoryMb>`, and scrubbed environment.
 * - Lock-free `forceKill()` kills the child via SIGKILL and rejects the active run immediately.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_PATH = path.join(CORE_DIR, "worker.js");
const DEFAULT_CATALOG_PATH = path.join(CORE_DIR, "catalog.js");

export function assertSupportedNode(versionStr = process.versions.node) {
  const major = Number(String(versionStr || "0").split(".")[0]);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`harness-code-mode requires Node.js >=22.0.0 (found ${versionStr || "unknown"})`);
  }
  return major;
}

function makeSemaphore(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  let peak = 0;
  const queue = [];
  return {
    get peak() {
      return peak;
    },
    async run(fn) {
      if (active >= max) {
        await new Promise((resolve) => queue.push(resolve));
      }
      active++;
      if (active > peak) peak = active;
      try {
        return await fn();
      } finally {
        active--;
        if (queue.length) queue.shift()();
      }
    },
  };
}

function scrubEnv() {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: os.homedir(),
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
  };
}

function truncateResult(result, maxChars) {
  const limit = Math.max(64, Number(maxChars) || 50000);
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch {
    serialized = String(result);
  }
  if (!serialized || serialized.length <= limit) {
    return { result, truncated: false };
  }
  if (typeof result === "string") {
    return {
      result: result.slice(0, limit) + `\n...[truncated ${result.length - limit} chars]`,
      truncated: true,
    };
  }
  return {
    result: serialized.slice(0, limit) + `\n...[truncated ${serialized.length - limit} chars]`,
    truncated: true,
  };
}

export class CodemodeSession {
  constructor(sessionId, options = {}) {
    assertSupportedNode();
    this.sessionId = sessionId;
    this.memoryMb = Math.max(32, Number(options.memoryMb) || 256);
    this.nodeBinary = options.nodeBinary || process.execPath;
    this.workerPath = fs.realpathSync(options.workerPath || DEFAULT_WORKER_PATH);
    this.catalogPath = fs.realpathSync(options.catalogPath || DEFAULT_CATALOG_PATH);

    this._proc = null;
    this._rl = null;
    this._readyPromise = null;
    this._catalogKey = "";
    this._execSeq = 0;
    this._activeRun = null;
    this._tail = Promise.resolve();
    this.lastUsed = Date.now();
  }

  _ensureProcess() {
    if (this._proc && this._proc.exitCode === null && !this._proc.killed) {
      return this._readyPromise;
    }
    this._catalogKey = "";
    const args = [
      "--permission",
      `--allow-fs-read=${this.workerPath}`,
      `--allow-fs-read=${this.catalogPath}`,
      `--max-old-space-size=${this.memoryMb}`,
      this.workerPath,
    ];
    const proc = spawn(this.nodeBinary, args, {
      cwd: fs.realpathSync(os.tmpdir()),
      stdio: ["pipe", "pipe", "pipe"],
      env: scrubEnv(),
    });
    this._proc = proc;
    let stderrBuf = "";
    proc.stderr.on("data", (chunk) => {
      if (stderrBuf.length < 4000) stderrBuf += chunk.toString();
    });

    let resolveReady;
    let rejectReady;
    this._readyPromise = new Promise((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this._readyPromise.catch(() => {});

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this._rl = rl;
    let readySeen = false;

    rl.on("line", (line) => {
      if (this._proc !== proc) return;
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!readySeen && msg.type === "ready") {
        readySeen = true;
        resolveReady();
        return;
      }
      this._handleWorkerFrame(msg);
    });

    const onDead = (reason) => {
      if (!readySeen) {
        readySeen = true;
        rejectReady(new Error(`worker exited before ready (${reason}): ${stderrBuf.trim()}`));
      }
      if (this._proc !== proc) {
        return;
      }
      this._proc = null;
      this._rl = null;
      const run = this._activeRun;
      if (run && !run.settled) {
        run.finish({
          ok: false,
          error: run.abortReason || `sandbox worker terminated (${reason})${stderrBuf ? `: ${stderrBuf.trim()}` : ""}`,
        });
      }
    };

    proc.once("exit", (code, sig) => onDead(sig ? `signal ${sig}` : `code ${code}`));
    proc.once("error", (err) => onDead(err.message));

    return this._readyPromise;
  }

  _send(obj) {
    if (!this._proc || this._proc.exitCode !== null || !this._proc.stdin.writable) {
      return false;
    }
    try {
      this._proc.stdin.write(JSON.stringify(obj) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  _handleWorkerFrame(msg) {
    const run = this._activeRun;
    if (!run || run.settled) return;
    if (msg.exec_id !== run.execId) {
      // Untrusted or stale frame from an earlier execution — drop silently.
      return;
    }
    if (msg.type === "done") {
      run.finish({
        ok: Boolean(msg.ok),
        result: msg.result,
        error: msg.error,
        logs: Array.isArray(msg.logs) ? msg.logs : [],
      });
      return;
    }
    if (msg.type === "call") {
      const toolName = String(msg.tool || "");
      const callId = msg.id;
      const args = msg.args && typeof msg.args === "object" ? msg.args : {};

      // Host-side allowlist enforcement (never trust worker frame).
      if (!run.allowedTools.has(toolName)) {
        this._send({
          type: "reply",
          exec_id: run.execId,
          id: callId,
          ok: false,
          error: `tool not allowed: ${toolName}`,
        });
        return;
      }

      // Host-side tool-call budget enforcement.
      run.toolCalls++;
      if (run.toolCalls > run.maxToolCalls) {
        this._send({
          type: "reply",
          exec_id: run.execId,
          id: callId,
          ok: false,
          error: `tool call budget exceeded (${run.maxToolCalls})`,
        });
        return;
      }
      if (run.calls.length < 50) {
        run.calls.push(toolName);
      }

      run.sem.run(async () => {
        if (run.settled) return;
        try {
          const res = await run.dispatch(toolName, args);
          if (run.settled) return;
          this._send({
            type: "reply",
            exec_id: run.execId,
            id: callId,
            ok: true,
            result: res,
          });
        } catch (err) {
          if (run.settled) return;
          this._send({
            type: "reply",
            exec_id: run.execId,
            id: callId,
            ok: false,
            error: String(err && err.message ? err.message : err),
          });
        }
      });
    }
  }

  /** Lock-free hard kill so AbortSignal / cancellation never deadlocks on queued runs. */
  forceKill(reason = "execution aborted") {
    const run = this._activeRun;
    if (run && !run.settled) {
      run.abortReason = reason;
    }
    const proc = this._proc;
    this._proc = null;
    this._rl = null;
    this._catalogKey = "";
    if (proc && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
    if (run && !run.settled) {
      run.finish({ ok: false, error: reason });
    }
  }

  async close() {
    const run = this._activeRun;
    if (run && !run.settled) {
      run.finish({ ok: false, error: "session closed" });
    }
    const proc = this._proc;
    this._proc = null;
    this._rl = null;
    this._catalogKey = "";
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.stdin.end();
    } catch {
      // Ignore.
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore.
        }
        resolve();
      }, 500);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  run(params) {
    const next = this._tail.then(() => this._runSerial(params));
    this._tail = next.catch(() => {});
    return next;
  }

  async _runSerial({
    code,
    tools = [],
    helperBindings = {},
    dispatch,
    timeoutSec = 60,
    maxToolCalls = 200,
    maxConcurrency = 8,
    maxResultChars = 50000,
    reset = false,
    signal = null,
  }) {
    this.lastUsed = Date.now();
    const t0 = Date.now();
    const clampedTimeout = Math.max(0.1, Math.min(Number(timeoutSec) || 60, 600));

    if (signal && signal.aborted) {
      return { ok: false, error: "execution aborted", stats: { tool_calls: 0, calls: [], elapsed_s: 0, parallel_peak: 0 } };
    }

    if (reset) {
      this.forceKill("session reset");
    }

    const allowedTools = new Set();
    const wireTools = [];
    for (const t of tools) {
      if (!t || !t.name) continue;
      const name = String(t.name);
      allowedTools.add(name);
      wireTools.push({
        name,
        description: String(t.description || ""),
        schema: t.schema && typeof t.schema === "object" ? t.schema : {},
      });
    }

    try {
      await this._ensureProcess();
    } catch (err) {
      return {
        ok: false,
        error: String(err && err.message ? err.message : err),
        stats: { tool_calls: 0, calls: [], elapsed_s: 0, parallel_peak: 0 },
      };
    }

    // Re-check signal after async spawn in case abort fired while worker was starting.
    if (signal && signal.aborted) {
      this.forceKill("execution aborted");
      return { ok: false, error: "execution aborted", stats: { tool_calls: 0, calls: [], elapsed_s: 0, parallel_peak: 0 } };
    }

    const nextKey = JSON.stringify({ tools: wireTools, helperBindings });
    if (!this._catalogKey) {
      this._send({ type: "init", tools: wireTools, helperBindings });
      this._catalogKey = nextKey;
    } else if (this._catalogKey !== nextKey) {
      this._send({ type: "update_catalog", tools: wireTools, helperBindings });
      this._catalogKey = nextKey;
    }

    const execId = ++this._execSeq;
    const sem = makeSemaphore(maxConcurrency);

    return await new Promise((resolve) => {
      let timer = null;
      const onAbort = () => this.forceKill("execution aborted");

      const runState = {
        execId,
        allowedTools,
        dispatch,
        maxToolCalls: Math.max(1, Number(maxToolCalls) || 200),
        toolCalls: 0,
        calls: [],
        sem,
        settled: false,
        abortReason: null,
        finish: (outcome) => {
          if (runState.settled) return;
          runState.settled = true;
          if (timer) clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (this._activeRun === runState) this._activeRun = null;
          this.lastUsed = Date.now();

          const elapsed = Math.round(((Date.now() - t0) / 1000) * 1000) / 1000;
          const stats = {
            tool_calls: runState.toolCalls,
            calls: runState.calls,
            elapsed_s: elapsed,
            parallel_peak: sem.peak,
          };
          if (!outcome.ok) {
            const resp = { ok: false, error: String(outcome.error || "execution failed"), stats };
            if (outcome.logs && outcome.logs.length) resp.logs = outcome.logs;
            resolve(resp);
            return;
          }
          const { result, truncated } = truncateResult(outcome.result, maxResultChars);
          const resp = { ok: true, result, stats };
          if (truncated) resp.truncated = true;
          if (outcome.logs && outcome.logs.length) resp.logs = outcome.logs;
          resolve(resp);
        },
      };

      this._activeRun = runState;
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timer = setTimeout(() => {
        this.forceKill(`timeout after ${clampedTimeout}s (sandbox process killed)`);
      }, clampedTimeout * 1000);

      if (!this._send({ type: "exec", exec_id: execId, code: String(code ?? "") })) {
        runState.finish({ ok: false, error: "failed to write exec frame to sandbox worker" });
      }
    });
  }
}

export class CodemodeManager {
  constructor(options = {}) {
    assertSupportedNode();
    this.options = options;
    this.maxSessions = Math.max(1, Number(options.maxSessions) || 16);
    this.idleTtlMs = Math.max(1000, Number(options.idleTtlMs) || 30 * 60 * 1000);
    this._sessions = new Map();
    this._exitHandler = () => {
      for (const s of this._sessions.values()) {
        s.forceKill("host exiting");
      }
      this._sessions.clear();
    };
    process.once("exit", this._exitHandler);
  }

  activeCount() {
    return this._sessions.size;
  }

  _reapAndEvict(keepId) {
    const now = Date.now();
    for (const [id, sess] of this._sessions.entries()) {
      if (id === keepId || sess._activeRun) continue;
      if (now - sess.lastUsed > this.idleTtlMs) {
        this._sessions.delete(id);
        sess.forceKill("idle ttl expired");
      }
    }
    while (this._sessions.size >= this.maxSessions) {
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [id, sess] of this._sessions.entries()) {
        if (id === keepId || sess._activeRun) continue;
        if (sess.lastUsed < oldestTime) {
          oldestTime = sess.lastUsed;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      const victim = this._sessions.get(oldestId);
      this._sessions.delete(oldestId);
      victim.forceKill("session evicted (LRU)");
    }
  }

  _getOrCreate(sessionId) {
    const id = String(sessionId || "default");
    let sess = this._sessions.get(id);
    if (!sess) {
      this._reapAndEvict(id);
      sess = new CodemodeSession(id, this.options);
      this._sessions.set(id, sess);
    }
    return sess;
  }

  run(params) {
    const sess = this._getOrCreate(params.sessionId || "default");
    return sess.run({
      timeoutSec: this.options.timeoutSec ?? 60,
      maxToolCalls: this.options.maxToolCalls ?? 200,
      maxConcurrency: this.options.maxConcurrency ?? 8,
      maxResultChars: this.options.maxResultChars ?? 50000,
      ...params,
    });
  }

  forceKill(sessionId, reason = "execution aborted") {
    const sess = this._sessions.get(String(sessionId || "default"));
    if (sess) sess.forceKill(reason);
  }

  async resetSession(sessionId) {
    await this.closeSession(sessionId);
  }

  async closeSession(sessionId) {
    const id = String(sessionId || "default");
    const sess = this._sessions.get(id);
    if (!sess) return;
    this._sessions.delete(id);
    await sess.close();
  }

  async closeAll() {
    process.removeListener("exit", this._exitHandler);
    const list = Array.from(this._sessions.values());
    this._sessions.clear();
    await Promise.all(list.map((s) => s.close()));
  }
}
