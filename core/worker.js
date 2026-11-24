/**
 * Hardened async Node.js `node:vm` REPL worker speaking NDJSON over stdin/stdout.
 *
 * Security invariants:
 * - Scrubs `process.env` immediately after startup.
 * - Intended to run under `node --permission --allow-fs-read=<worker> --allow-fs-read=<catalog>`.
 * - Only primitive strings / `undefined` cross the VM realm boundary (zero host-realm
 *   Promises, Errors, Objects, or Arrays ever enter user code), and host callbacks
 *   never throw into the VM.
 * - Every `call` / `reply` frame carries `exec_id`; stale promises from earlier
 *   executions cannot emit calls or resolve into a later execution.
 */

import vm from "node:vm";
import readline from "node:readline";
import { Catalog } from "./catalog.js";

// Scrub environment before creating any user VM context.
for (const key of Object.keys(process.env)) {
  delete process.env[key];
}

// Prevent Node v26+ from crashing the persistent worker on un-awaited rejected tool promises.
process.on("unhandledRejection", () => {});
process.on("uncaughtException", (err) => {
  if (activeExecId !== null && !execSettled) {
    execSettled = true;
    emit({
      type: "done",
      exec_id: activeExecId,
      ok: false,
      error: String(err && err.message ? err.message : err),
      logs: currentLogs.slice(),
    });
  }
});

let catalog = new Catalog([]);
let vmContext = null;
let vmApi = null;
let activeExecId = null;
let execSettled = true;
let currentLogs = [];

function emit(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {
    // Ignore broken pipe during host teardown.
  }
}

const VM_PRELUDE = `(function(hostSend, hostSearch, hostDescribe, hostHint, hostLog) {
  "use strict";

  const pending = new Map();
  let nextCallId = 1;
  let currentExecId = null;
  let toolMap = Object.create(null); // jsName -> registryName
  let bindings = Object.create(null);

  function shellQuote(val) {
    return "'" + String(val).replace(/'/g, "'\\\\''") + "'";
  }

  function invokeByRegistryName(regName, args) {
    const capturedExecId = currentExecId;
    const id = nextCallId++;
    const p = new Promise((resolve, reject) => {
      if (capturedExecId === null) {
        reject(new Error("no active execution"));
        return;
      }
      pending.set(id, { execId: capturedExecId, resolve, reject });
      let payload;
      try {
        payload = JSON.stringify({
          exec_id: capturedExecId,
          id,
          tool: regName,
          args: args && typeof args === "object" ? args : {},
        });
      } catch (e) {
        pending.delete(id);
        reject(new Error("tool arguments are not JSON-serializable: " + String(e)));
        return;
      }
      hostSend(payload);
    });
    // Attach no-op rejection handler so un-awaited tool failures never trigger UnhandledPromiseRejection.
    p.catch(() => {});
    return p;
  }

  function invokeByJsName(jsName, args) {
    const regName = toolMap[jsName];
    if (!regName) {
      const p = Promise.reject(new Error(hostHint(String(jsName))));
      p.catch(() => {});
      return p;
    }
    return invokeByRegistryName(regName, args);
  }

  function invokeBinding(kind, args) {
    const target = bindings[kind];
    if (!target) {
      const p = Promise.reject(new Error("helper '" + kind + "' is not bound in this harness"));
      p.catch(() => {});
      return p;
    }
    // Resolve either registry name or JS name against current toolMap.
    if (toolMap[target]) {
      return invokeByRegistryName(toolMap[target], args);
    }
    for (const k of Object.keys(toolMap)) {
      if (toolMap[k] === target) {
        return invokeByRegistryName(target, args);
      }
    }
    const p = Promise.reject(new Error(hostHint(String(target))));
    p.catch(() => {});
    return p;
  }

  const toolsProxy = new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop === "then" || prop === "toJSON" || prop === "valueOf" || prop === "toString") {
        return undefined;
      }
      return (args = {}) => invokeByJsName(prop, args);
    },
    has(_target, prop) {
      return typeof prop === "string" && Boolean(toolMap[prop]);
    },
    ownKeys() {
      return Object.keys(toolMap);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && toolMap[prop]) {
        return { enumerable: true, configurable: true, writable: false };
      }
      return undefined;
    },
  });

  function makeShellPromise(command, initialOpts = {}) {
    const opts = {
      cwd: initialOpts.cwd ?? initialOpts.workdir ?? null,
      timeout: initialOpts.timeout ?? null,
      nothrow: Boolean(initialOpts.nothrow),
    };
    let started = null;

    function start() {
      if (started) return started;
      let cmd = command;
      const args = {};
      if (opts.cwd) {
        if (bindings.shellCwdKey) {
          args[bindings.shellCwdKey] = String(opts.cwd);
        } else {
          cmd = "cd " + shellQuote(opts.cwd) + " && " + cmd;
        }
      }
      args.command = cmd;
      if (opts.timeout != null) args.timeout = opts.timeout;

      started = invokeBinding("shell", args).then((res) => {
        const out = res && typeof res === "object"
          ? res
          : { output: String(res ?? ""), exit_code: 0 };
        const exitCode = typeof out.exit_code === "number"
          ? out.exit_code
          : (typeof out.exitCode === "number" ? out.exitCode : 0);
        const output = typeof out.output === "string"
          ? out.output
          : (typeof out.stdout === "string" ? out.stdout : String(out.output ?? ""));
        const enriched = Object.assign({}, out, {
          output,
          exit_code: exitCode,
          text() { return output; },
          json() { return JSON.parse(output); },
        });
        if (!opts.nothrow && exitCode !== 0) {
          const err = new Error("Command failed with exit code " + exitCode + ": " + output.slice(0, 500));
          err.exit_code = exitCode;
          err.output = output;
          throw err;
        }
        return enriched;
      });
      started.catch(() => {});
      return started;
    }

    const handle = {
      nothrow() { opts.nothrow = true; return handle; },
      cwd(dir) { opts.cwd = dir; return handle; },
      workdir(dir) { opts.cwd = dir; return handle; },
      timeout(sec) { opts.timeout = sec; return handle; },
      text() {
        const p = start().then((r) => r.output);
        p.catch(() => {});
        return p;
      },
      json() {
        const p = start().then((r) => JSON.parse(r.output));
        p.catch(() => {});
        return p;
      },
      then(onFulfilled, onRejected) {
        return start().then(onFulfilled, onRejected);
      },
      catch(onRejected) {
        return start().catch(onRejected);
      },
      finally(onFinally) {
        return start().finally(onFinally);
      },
    };
    return handle;
  }

  function $(stringsOrCmd, ...values) {
    if (Array.isArray(stringsOrCmd) && Object.prototype.hasOwnProperty.call(stringsOrCmd, "raw")) {
      let cmd = stringsOrCmd[0];
      for (let i = 0; i < values.length; i++) {
        cmd += shellQuote(values[i]) + stringsOrCmd[i + 1];
      }
      return makeShellPromise(cmd);
    }
    const opts = values[0] && typeof values[0] === "object" ? values[0] : {};
    return makeShellPromise(String(stringsOrCmd ?? ""), opts);
  }

  async function read(pathOrOpts, opts = {}) {
    const args = typeof pathOrOpts === "string"
      ? Object.assign({ path: pathOrOpts }, opts)
      : Object.assign({}, pathOrOpts);
    const res = await invokeBinding("read", args);
    if (res && typeof res === "object") {
      const rawContent = typeof res.content === "string" ? res.content : "";
      const text = bindings.readStripLineNums
        ? rawContent.split("\\n").map((line) => line.replace(/^\\d+\\|/, "")).join("\\n")
        : rawContent;
      return Object.assign({}, res, { text });
    }
    const text = String(res ?? "");
    return { content: text, text };
  }

  async function edit(pathOrOpts, oldStr, newStr, opts = {}) {
    const keys = Array.isArray(bindings.editKeys) && bindings.editKeys.length === 3
      ? bindings.editKeys
      : ["path", "old_string", "new_string"];
    const args = typeof pathOrOpts === "string"
      ? Object.assign({ [keys[0]]: pathOrOpts, [keys[1]]: oldStr, [keys[2]]: newStr }, opts)
      : Object.assign({}, pathOrOpts);
    return invokeBinding("edit", args);
  }

  async function write(pathOrOpts, content, opts = {}) {
    const args = typeof pathOrOpts === "string"
      ? Object.assign({ path: pathOrOpts, content }, opts)
      : Object.assign({}, pathOrOpts);
    return invokeBinding("write", args);
  }

  async function grep(patternOrOpts, opts = {}) {
    const base = typeof patternOrOpts === "string"
      ? Object.assign({ pattern: patternOrOpts }, opts)
      : Object.assign({}, patternOrOpts);
    if (bindings.grep === "search_files" && base.target === undefined) {
      base.target = "content";
    }
    return invokeBinding("grep", base);
  }

  async function glob(patternOrOpts, opts = {}) {
    const base = typeof patternOrOpts === "string"
      ? Object.assign({ pattern: patternOrOpts }, opts)
      : Object.assign({}, patternOrOpts);
    if (bindings.glob === "search_files" && base.target === undefined) {
      base.target = "files";
    }
    return invokeBinding("glob", base);
  }

  function searchTools(query, topK = 5) {
    return JSON.parse(hostSearch(String(query ?? ""), Number(topK) || 5));
  }

  function describeTool(name) {
    return JSON.parse(hostDescribe(String(name ?? "")));
  }

  function formatArg(a) {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }

  const sandboxConsole = {
    log(...args) { hostLog(args.map(formatArg).join(" ")); },
    info(...args) { hostLog(args.map(formatArg).join(" ")); },
    warn(...args) { hostLog("WARN: " + args.map(formatArg).join(" ")); },
    error(...args) { hostLog("ERROR: " + args.map(formatArg).join(" ")); },
  };

  globalThis.tools = toolsProxy;
  globalThis.$ = $;
  globalThis.read = read;
  globalThis.edit = edit;
  globalThis.write = write;
  globalThis.grep = grep;
  globalThis.glob = glob;
  globalThis.searchTools = searchTools;
  globalThis.describeTool = describeTool;
  globalThis.console = sandboxConsole;
  globalThis.state = Object.create(null);

  return {
    configure(configJson) {
      const cfg = JSON.parse(configJson);
      toolMap = Object.create(null);
      for (const entry of cfg.tools || []) {
        toolMap[entry.js] = entry.name;
      }
      if (cfg.helperBindings && typeof cfg.helperBindings === "object") {
        bindings = Object.assign(Object.create(null), cfg.helperBindings);
      }
    },
    setExecId(id) {
      // Cancel any leftover pending calls from previous execs so they cannot interfere.
      for (const [callId, entry] of pending.entries()) {
        if (entry.execId !== id) {
          pending.delete(callId);
        }
      }
      currentExecId = id;
    },
    deliver(replyJson) {
      const msg = JSON.parse(replyJson);
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.exec_id !== currentExecId || entry.execId !== currentExecId) {
        return;
      }
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(String(msg.error || "tool error")));
      }
    },
    runExec(codeStr, onDoneJson) {
      let fn;
      try {
        fn = new Function("return (async () => {\\n" + codeStr + "\\n})();");
      } catch (e) {
        onDoneJson(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
        return;
      }
      let p;
      try {
        p = fn();
      } catch (e) {
        onDoneJson(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
        return;
      }
      Promise.resolve(p).then(
        (value) => {
          let serialized;
          try {
            serialized = JSON.stringify({ ok: true, result: value === undefined ? null : value });
          } catch (e) {
            serialized = JSON.stringify({
              ok: false,
              error: "return value is not JSON-serializable: " + String(e && e.message ? e.message : e),
            });
          }
          onDoneJson(serialized);
        },
        (err) => {
          const msg = err && typeof err === "object" && err.message ? err.message : String(err);
          onDoneJson(JSON.stringify({ ok: false, error: msg }));
        },
      );
    },
  };
})`;

function ensureContext() {
  if (vmContext && vmApi) return;
  vmContext = vm.createContext(Object.create(null), {
    codeGeneration: { strings: true, wasm: false },
  });
  const initFn = vm.runInContext(VM_PRELUDE, vmContext, { filename: "codemode-prelude.js" });

  // All host callbacks accept/return primitive strings or undefined and NEVER throw into the VM.
  const hostSend = (payloadJson) => {
    try {
      const req = JSON.parse(String(payloadJson));
      if (req.exec_id !== activeExecId || execSettled) return;
      emit({
        type: "call",
        exec_id: req.exec_id,
        id: req.id,
        tool: String(req.tool),
        args: req.args && typeof req.args === "object" ? req.args : {},
      });
    } catch {
      // Never throw across realm boundary.
    }
  };

  const hostSearch = (query, topK) => {
    try {
      return JSON.stringify(catalog.search(String(query), Number(topK) || 5));
    } catch {
      return "[]";
    }
  };

  const hostDescribe = (name) => {
    try {
      return JSON.stringify(catalog.describe(String(name)));
    } catch {
      return JSON.stringify({ ok: false, error: "describe failed" });
    }
  };

  const hostHint = (name) => {
    try {
      return catalog.hint(String(name));
    } catch {
      return "unknown tool";
    }
  };

  const hostLog = (line) => {
    try {
      if (currentLogs.length < 500) {
        currentLogs.push(String(line));
      }
    } catch {
      // Ignore.
    }
  };

  vmApi = initFn(hostSend, hostSearch, hostDescribe, hostHint, hostLog);
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "init": {
      catalog = new Catalog(Array.isArray(msg.tools) ? msg.tools : []);
      vmContext = null;
      vmApi = null;
      ensureContext();
      vmApi.configure(JSON.stringify({
        tools: catalog.toWire(),
        helperBindings: msg.helperBindings || {},
      }));
      break;
    }
    case "update_catalog": {
      catalog = new Catalog(Array.isArray(msg.tools) ? msg.tools : []);
      ensureContext();
      vmApi.configure(JSON.stringify({
        tools: catalog.toWire(),
        helperBindings: msg.helperBindings,
      }));
      break;
    }
    case "exec": {
      ensureContext();
      const execId = msg.exec_id;
      activeExecId = execId;
      execSettled = false;
      currentLogs = [];
      vmApi.setExecId(execId);
      vmApi.runExec(String(msg.code ?? ""), (doneJson) => {
        try {
          if (activeExecId !== execId || execSettled) return;
          execSettled = true;
          const parsed = JSON.parse(String(doneJson));
          const out = {
            type: "done",
            exec_id: execId,
            ok: Boolean(parsed.ok),
            logs: currentLogs.slice(),
          };
          if (parsed.ok) out.result = parsed.result;
          else out.error = String(parsed.error || "unknown error");
          emit(out);
        } catch (e) {
          if (activeExecId === execId && !execSettled) {
            execSettled = true;
            emit({ type: "done", exec_id: execId, ok: false, error: String(e), logs: currentLogs.slice() });
          }
        }
      });
      break;
    }
    case "reply": {
      if (!vmApi || msg.exec_id !== activeExecId || execSettled) return;
      try {
        vmApi.deliver(JSON.stringify({
          exec_id: msg.exec_id,
          id: msg.id,
          ok: Boolean(msg.ok),
          result: msg.result,
          error: msg.error,
        }));
      } catch {
        // Ignore malformed reply.
      }
      break;
    }
    default:
      break;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handleMessage(msg);
});
rl.on("close", () => {
  process.exit(0);
});

emit({ type: "ready" });
