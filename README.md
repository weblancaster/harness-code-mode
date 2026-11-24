# harness-code-mode

Universal async JavaScript **Code Mode** for **Hermes Agent**, **Pi**, **Codex**, **Claude Code**, **Cursor**, and any MCP-compatible AI harness — with **zero runtime dependencies**.

Write one short async JavaScript snippet that discovers tools on demand via BM25, fans out parallel calls with `Promise.all`, uses Claude Code-style `$` / `read` / `edit` / `write` / `grep` / `glob` helpers, persists `state` across turns, and returns only the compact summary to the model context.

```js
// One model turn: search + parallel fetch + filter + return ~200 bytes
const hits = searchTools("issues tracker", 3);
const issues = await tools.mcp__tracker__list_issues({ state: "open" });
const urgent = issues.filter((i) => i.labels.includes("urgent"));
const bodies = await Promise.all(
  urgent.map((i) => tools.mcp__tracker__get_issue({ id: i.id })),
);
return { count: bodies.length, totalChars: bodies.reduce((s, b) => s + b.body.length, 0) };
```

## Install per Harness

Requires **Node.js `>=22`** (Node `>=25` / Hermes-bundled Node `v26` recommended for OS-level network denial under `--permission`).

### Hermes Agent

```bash
hermes plugins install weblancaster/harness-code-mode --enable
```

> If Hermes prompts to install Node dependencies for the root `package.json`, answer **`N`** (or pass `--no-deps`) — `harness-code-mode` has **zero** npm dependencies. Restart Hermes Desktop / gateway after installing so the running process loads the plugin.

Configure settings in `config.yaml` (`plugins.entries.code-mode.settings`) or Desktop **Settings → Plugins → Code Mode**.

### Pi (`@earendil-works/pi-coding-agent`)

```bash
pi install git:github.com/weblancaster/harness-code-mode
```

Pi auto-discovers `adapters/pi/index.ts` and `skills/code-mode` from `package.json`. By default this registers as `codemode` (explicitly overriding Pi's built-in `codemode` with `exposure: "model-only"`, `reachesTools: () => "all"`, and `prepareLoadout`). Set `HARNESS_CODEMODE_PI_TOOL_NAME=harness_codemode` to run it side-by-side instead.

### Codex (`~/.codex/config.toml`)

Clone once (recommended over cold `npx github:` to avoid MCP startup timeouts):

```bash
git clone https://github.com/weblancaster/harness-code-mode ~/Code/harness-code-mode
```

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.codemode]
command = "node"
args = ["/ABS/PATH/TO/harness-code-mode/adapters/mcp/cli.js", "--from-codex", "~/.codex/config.toml"]
tool_timeout_sec = 600
startup_timeout_sec = 30
```

Or via `npx` (allow extra `startup_timeout_sec` for cold fetch):

```toml
[mcp_servers.codemode]
command = "npx"
args = ["-y", "github:weblancaster/harness-code-mode", "--from-codex", "~/.codex/config.toml"]
tool_timeout_sec = 600
startup_timeout_sec = 60
```

> **Avoid double-spawning upstream MCP servers:** Once you aggregate your upstream servers through `codemode`, set `enabled = false` on those individual `[mcp_servers.<name>]` entries in Codex (or put them in a separate `mcp.json` passed via `--config`) so Codex does not spawn a second copy alongside `codemode`.

### Claude Code / Cursor / OpenCode / any MCP host

```bash
claude mcp add codemode -- node /ABS/PATH/TO/harness-code-mode/adapters/mcp/cli.js --config /path/to/mcp.json
```

Optional local coding helpers (`$`, `read`, `edit`, `write`, `grep`, `glob`) are **off by default** in MCP mode. Opt in explicitly with `--allow-local-tools --workspace /path/to/repo`.

## Sandbox API

| In JS | Behavior |
| --- | --- |
| `await tools.<name>(args)` | Calls any exposed MCP or built-in tool; throws catchable JS Error on failure |
| `searchTools(query, topK=5)` | Local BM25 search (`[{name, js, description, score}]`), zero IPC round-trip |
| `describeTool(name)` | Local JSON Schema lookup (`{ok, name, js, description, schema}`) |
| `` await $`cmd ${arg}` `` | POSIX single-quoted shell helper; supports `.cwd(dir)`, `.timeout(sec)`, `.nothrow()`, `.text()`, `.json()` |
| `await read(path, opts?)` | Reads a file (`.text` strips Hermes `LINE_NUM\|` prefixes; `.content` preserves raw output) |
| `await edit(path, old, new, opts?)` | Targeted find-and-replace edit |
| `await write(path, content)` | Writes a file |
| `await grep(pattern, opts?)` / `await glob(pattern, opts?)` | Searches file contents or finds files by glob |
| `state.<key>` | Persists across calls in the same session |
| `console.log(...)` | Captured and returned as `logs` |
| `return <value>` | The only value returned to the model context |

### Harness Tool Bindings (`helperBindings`)

| Helper | Hermes | Pi | Standalone MCP (`--allow-local-tools`) |
| --- | --- | --- | --- |
| `$` | `terminal` (`workdir`) | `bash` (`cd '...' &&`) | `local_shell` (`workdir`, confined) |
| `read` | `read_file` (strips `LINE_NUM\|`) | `read` | `local_read` (confined) |
| `edit` | `patch` (`old_string`/`new_string`) | `edit` (`oldText`/`newText`) | `local_edit` (confined) |
| `write` | `write_file` | `write` | `local_write` (confined) |
| `grep` | `search_files` (`target="content"`) | `grep` | `local_grep` (confined) |
| `glob` | `search_files` (`target="files"`) | `find` | `local_glob` (confined) |

## Slash Commands (Hermes & Pi)

- `/codemode status` — show exposed tool count, active sandbox workers, and Node binary
- `/codemode reset` — terminate active sandbox workers and clear `state`
- `/codemode tools [query]` — search exposed Code Mode tools

## Hermes Settings (`plugin.yaml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `extra_tools` | `[terminal, read_file, write_file, patch, search_files, web_search, web_extract]` | Non-MCP built-in tools exposed alongside all `mcp__*` tools |
| `timeout_s` | `60` | Default per-execution wall-clock timeout in seconds (max `600`) |
| `memory_mb` | `256` | Node.js V8 `--max-old-space-size` cap per session worker |
| `max_tool_calls` | `200` | Tool-call budget per execution |
| `max_concurrency` | `8` | Max parallel tool calls for `Promise.all` (set `1` to serialize) |
| `max_sessions` | `16` | LRU cap on live session workers |
| `idle_ttl_s` | `1800` | Reap idle workers after N seconds |
| `max_result_chars` | `50000` | Truncation limit on serialized output |
| `node_binary` | `""` | Optional Node `>=22` binary path override |
| `prompt_guidance` | `true` | Register cache-safe system prompt guidance |

Never exposed on Hermes: `codemode`, `delegate_task`, `clarify`, `execute_code`, `memory`, `skill_manage`, `cronjob`, `cronjob_manage`, `send_message`, `tool_call`, `tool_search`, `tool_describe`.

## Security Model & Disclosure

- **Child-process isolation:** Each session runs a dedicated Node.js child process launched with `--permission --allow-fs-read=<realpath(core/worker.js)> --allow-fs-read=<realpath(core/catalog.js)>`, `--max-old-space-size`, and a scrubbed environment (`PATH`, `HOME`, `LANG`, `LC_ALL` only — zero API keys). On Node `>=25` (including Hermes-bundled Node v26), `--permission` denies filesystem, child processes, workers, FFI, WASI, **and** outbound network sockets (`ERR_ACCESS_DENIED`). On Node `22–24`, `--permission` denies fs/child_process/workers but does not gate raw sockets.
- **Primitive-only VM realm boundary:** User code runs inside `vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } })`. Only primitive strings and `undefined` cross the bridge (`hostSend(json)` never throws; replies enter via in-context `deliver(json)`), so no host-realm `Promise`, `Error`, or `Object` enters the sandbox.
- **Untrusted worker framing:** The host enforces active `exec_id`, tool allowlist membership, tool-call budget, concurrency cap, and wall-clock `SIGKILL` hard timeout on every worker frame.
- **Native harness approvals & redaction:**
  - **Hermes:** Dispatches fail-closed through `model_tools.handle_function_call` under `programmatic_file_read()` + `thread_scoped_silence()` with per-call `contextvars.Context.copy()`, `capture_thread_callbacks()`, `tools.interrupt.acting_for_tid`, `is_interrupted()` polling, `_TERMINAL_BLOCKED_PARAMS` stripping, subagent guard, and `ctx.redact_text()`.
  - **Pi:** Dispatches via `ctx.executeTool(name, args, { signal })` so Pi's `tool_call` permission gates, validation, and `nestedCalls` stay in charge.
  - **Standalone MCP (`--allow-local-tools`):** Off by default. When opted in, file and shell operations run inside the MCP server process confined by `fs.realpathSync` to `--workspace <dir>`, and the host only approves the outer `codemode` call.

## Tests

```bash
node --test tests/*.test.js
python3 -m unittest discover -s tests -v
```

## License

MIT © 2026 Michael Lancaster
