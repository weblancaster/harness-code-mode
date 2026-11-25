---
name: code-mode
description: "Use when orchestrating 3+ tool calls in Code Mode."
version: 0.1.0
license: MIT
---

# Code Mode

Run multi-step tool orchestration as a single async JavaScript snippet inside a persistent per-session Node.js sandbox so intermediate payloads stay out of the model context window.

## When to Use

- 3+ related tool calls (search → fan-out fetch → aggregate → return compact summary)
- Parallel independent calls using `await Promise.all([...])`
- Filtering large MCP or file outputs before returning results to the conversation

Skip Code Mode for a single straightforward tool call or anything needing user interaction mid-step.

## Sandbox API

| Helper | Behavior |
| --- | --- |
| `await tools.<name>(args)` | Calls any exposed MCP or built-in tool (MCP JSON payloads are auto-unwrapped); throws on tool error |
| `searchTools(query, topK=5)` | Local BM25 search over exposed tools (`[{name, js, description, score}]`) |
| `describeTool(name)` | Local schema lookup (`{ok, name, js, description, schema}`) |
| `await sleep(ms)` / `setTimeout` / `clearTimeout` | Realm-isolated, execution-scoped timers for rate-limited API pacing |
| `` await $`cmd ${arg}` `` | POSIX-quoted shell helper; chain `.cwd(dir)`, `.timeout(sec)`, `.nothrow()`, `.text()`, `.json()` |
| `await read(path, opts)` | Reads a file; `.text` provides line-number-stripped content |
| `await edit(path, oldStr, newStr, opts)` | Targeted find-and-replace edit |
| `await write(path, content)` | Writes a file |
| `await grep(pattern, opts)` / `await glob(pattern, opts)` | Searches file contents or finds files by glob |
| `state.<key>` | Persists values across calls in the current session |
| `console.log(...)` | Captured and returned as `logs` |
| `return <value>` | Only JSON-serializable data returned re-enters context |

## Idiomatic Patterns

### Discover unfamiliar MCP schemas first

```js
const hits = searchTools("pull requests github", 5);
return hits.map((h) => describeTool(h.name));
```

### Parallel fan-out with compact aggregation

```js
const items = await tools.mcp__tracker__list_issues({ state: "open" });
const urgent = items.filter((i) => i.priority === "high");
const details = await Promise.all(
  urgent.map((i) => tools.mcp__tracker__get_issue({ id: i.id })),
);
state.lastUrgent = details;
return { count: details.length, titles: details.map((d) => d.title) };
```

### Shell + file edit in one turn

```js
const files = (await $`rg -l "retryPolicy" src`.text()).trim().split("\n").filter(Boolean);
await edit(files[0], "maxAttempts: 3", "maxAttempts: 5");
const testRun = await $`npm test -- retryPolicy`.nothrow();
return { edited: files[0], exitCode: testRun.exit_code, output: testRun.output.slice(-1000) };
```

## Pitfalls

- Do not mutate `tools`; pass plain JSON-serializable objects as arguments and return values.
- Pass `reset: true` (or run `/codemode reset` / `codemode_reset`) if `state` becomes stale.
- Chain `.nothrow()` on `` $`...` `` whenever a non-zero exit code is expected.
- On Hermes, `terminal` background/pty flags (`background`, `pty`, `notify`, `persist_on_release`) are stripped inside Code Mode for sandbox safety.
