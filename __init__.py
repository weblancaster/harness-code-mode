"""Hermes Agent plugin entrypoint for `harness-code-mode`.

Exposes `codemode` tool, `/codemode` slash command, cache-safe system prompt
guidance, bundled skill `code-mode:code-mode`, and full session teardown hooks.

Security & parity invariants with Hermes's built-in `execute_code`:
- Fail-closed: `check_fn` returns False if Node >=22 or Hermes core dispatch/context
  hooks (`model_tools.handle_function_call`, `tools.thread_context.capture_thread_callbacks`,
  `tools.interrupt`) are unavailable — never silently degrades to `ctx.dispatch_tool`.
- Strips `_TERMINAL_BLOCKED_PARAMS` on nested `terminal` calls.
- Forwards `task_id`, `session_id`, `conversation_id`, and `turn_id` to
  `handle_function_call` under `programmatic_file_read()` + `thread_scoped_silence()`.
- Enforces host-side allowlist (`exposed - NEVER`) and blocks restricted subagents
  until Hermes exposes `enabled_tools` to plugin handlers.
- Redacts final JSON output via `ctx.redact_text()`.
"""

from __future__ import annotations

from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
from typing import Any, Callable, Optional

_PLUGIN_ROOT = Path(__file__).resolve().parent


def _load_runtime_module():
    try:
        from .adapters.hermes import runtime as mod
        return mod
    except Exception:
        spec = importlib.util.spec_from_file_location(
            "harness_code_mode_runtime",
            _PLUGIN_ROOT / "adapters" / "hermes" / "runtime.py",
        )
        mod = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(mod)
        return mod


_rt = _load_runtime_module()
CodemodeManager = _rt.CodemodeManager
HERMES_HELPER_BINDINGS = _rt.HERMES_HELPER_BINDINGS
resolve_node_binary = _rt.resolve_node_binary

DEFAULT_EXTRA_TOOLS = [
    "terminal",
    "read_file",
    "write_file",
    "patch",
    "search_files",
    "web_search",
    "web_extract",
]

NEVER = frozenset({
    "codemode",
    "delegate_task",
    "clarify",
    "execute_code",
    "memory",
    "skill_manage",
    "cronjob",
    "cronjob_manage",
    "send_message",
    "tool_call",
    "tool_search",
    "tool_describe",
})

_TERMINAL_BLOCKED_PARAMS = frozenset({
    "background",
    "pty",
    "notify",
    "notify_on_complete",
    "watch_patterns",
    "heartbeat",
    "persist_on_release",
})

CODEMODE_SCHEMA = {
    "name": "codemode",
    "description": (
        "Run an async JavaScript function body in a persistent per-session Node.js sandbox with "
        "parallel Promise.all tool calls, Claude Code-style $, read, edit, write, grep, and glob helpers, "
        "on-demand BM25 searchTools(query, topK) / describeTool(name), and persistent `state`. "
        "Only the returned value re-enters context."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": (
                    "Async JS function body. Use await, Promise.all([...]), tools.<name>(args), "
                    "$, read, edit, write, grep, glob, searchTools, describeTool, console.log, "
                    "state.<key>, and return <value>."
                ),
            },
            "timeout": {
                "type": "number",
                "description": "Wall-clock timeout in seconds before hard-killing the sandbox (max 600).",
            },
            "reset": {
                "type": "boolean",
                "description": "Restart the session's persistent JS sandbox before executing (clears state).",
            },
        },
        "required": ["code"],
    },
}

_PROMPT_GUIDANCE = """## Code Mode (`codemode`)
Use `codemode` when a task needs 3+ tool calls, parallel `Promise.all` fan-out, or filtering large MCP/file outputs before returning.
When `tool_search` defers `codemode`, invoke it in one step without calling `tool_describe`:
`tool_call(calls=[{"name": "codemode", "arguments": {"code": "<async JS body>", "timeout": 60, "reset": false}}])`
Inside the async JS body:
- `await tools.<name>(args)` — call any exposed MCP or built-in tool (use `Promise.all([...])` for parallelism)
- `searchTools(query, topK=5)` / `describeTool(name)` — discover tool schemas on demand (zero round-trip)
- ``await $`cmd ${arg}`.cwd(dir).nothrow().text()`` — POSIX-quoted shell helper
- `await read(path)` (`.text` strips `LINE_NUM|` prefixes), `await edit(path, old, new)`, `await write(path, content)`, `await grep(pat, opts)`, `await glob(pat, opts)`
- `state.<key>` persists across calls in this session; `return <value>` sends only the compact summary back to context."""

_ctx: Any = None
_manager: Optional[Any] = None
_test_registry_override: Any = None
_test_dispatch_override: Optional[Callable[..., Any]] = None


def _setting(key: str, default: Any) -> Any:
    if _ctx is None:
        return default
    try:
        val = _ctx.get_config(key, default=default)
        return default if val is None else val
    except Exception:
        return default


def _hermes_runtime_available() -> bool:
    try:
        import model_tools  # noqa: F401
        from tools import interrupt, thread_context  # noqa: F401

        return (
            hasattr(model_tools, "handle_function_call")
            and hasattr(thread_context, "capture_thread_callbacks")
            and hasattr(interrupt, "is_interrupted")
            and hasattr(interrupt, "acting_for_tid")
        )
    except Exception:
        return False


def _check() -> bool:
    node_bin = resolve_node_binary(str(_setting("node_binary", "") or ""))
    if not node_bin:
        return False
    if _test_dispatch_override is not None:
        return True
    return _hermes_runtime_available()


def _is_delegated_subagent() -> bool:
    if os.environ.get("HERMES_DELEGATED_CHILD_CONTEXT"):
        return True
    try:
        from agent.delegation_context import is_delegated_child_context
        return bool(is_delegated_child_context())
    except Exception:
        return False


def _session_key() -> str:
    try:
        from gateway.session_context import get_session_env
        return str(get_session_env("HERMES_SESSION_KEY", "") or "")
    except Exception:
        return ""


def _exposed_entries(registry_override: Any = None) -> list[dict[str, Any]]:
    reg = registry_override or _test_registry_override
    check_cached = None
    if reg is None:
        try:
            from tools import registry as reg_mod
            reg = reg_mod.registry
            check_cached = getattr(reg_mod, "_check_fn_cached", None)
            if not reg.get_all_entries():
                discover = getattr(reg_mod, "discover_builtin_tools", None)
                if callable(discover):
                    discover()
        except Exception:
            return []

    extra_raw = _setting("extra_tools", DEFAULT_EXTRA_TOOLS)
    extra = set(extra_raw) if isinstance(extra_raw, (list, tuple, set)) else set(DEFAULT_EXTRA_TOOLS)

    out: list[dict[str, Any]] = []
    for entry in reg.get_all_entries():
        name = getattr(entry, "name", "")
        if not name or name in NEVER:
            continue
        if not (name.startswith("mcp__") or name in extra):
            continue
        check_fn = getattr(entry, "check_fn", None)
        if callable(check_fn):
            try:
                ok = check_cached(check_fn) if callable(check_cached) else check_fn()
                if not ok:
                    continue
            except Exception:
                continue
        raw_schema = getattr(entry, "schema", None) or {}
        desc = str(getattr(entry, "description", "") or "")
        if not desc and isinstance(raw_schema, dict) and isinstance(raw_schema.get("description"), str):
            desc = raw_schema["description"]
        schema = raw_schema
        if isinstance(schema, dict) and "parameters" in schema and isinstance(schema["parameters"], dict):
            schema = schema["parameters"]
        out.append({
            "name": name,
            "description": desc,
            "schema": schema if isinstance(schema, dict) else {},
        })
    return out


def _sanitize_tool_args(tool_name: str, tool_args: dict[str, Any]) -> dict[str, Any]:
    if tool_name != "terminal":
        return dict(tool_args)
    return {k: v for k, v in tool_args.items() if k not in _TERMINAL_BLOCKED_PARAMS}


def _dispatch_hermes_tool(tool_name: str, tool_args: dict[str, Any], fwd_kwargs: dict[str, Any]) -> str:
    clean_args = _sanitize_tool_args(tool_name, tool_args)
    if _test_dispatch_override is not None:
        return _test_dispatch_override(tool_name, clean_args, **fwd_kwargs)

    from model_tools import handle_function_call

    try:
        from tools.file_tools_read_tracking import programmatic_file_read
        read_cm = programmatic_file_read()
    except Exception:
        read_cm = nullcontext()

    try:
        from agent.thread_scoped_output import thread_scoped_silence
        silence_cm = thread_scoped_silence()
    except Exception:
        silence_cm = nullcontext()

    with read_cm, silence_cm:
        return handle_function_call(tool_name, clean_args, **fwd_kwargs)


def _redact(payload_json: str) -> str:
    if _ctx is not None and hasattr(_ctx, "redact_text"):
        try:
            return _ctx.redact_text(payload_json)
        except Exception:
            pass
    return payload_json


def _handle(
    args: dict[str, Any],
    *,
    task_id: Optional[str] = None,
    session_id: Optional[str] = None,
    conversation_id: Optional[str] = None,
    turn_id: Optional[str] = None,
    **_extra: Any,
) -> str:
    try:
        if _is_delegated_subagent() and not _setting("allow_in_subagents", False):
            return json.dumps({
                "ok": False,
                "error": "codemode is disabled in restricted subagents until enabled_tools is exposed to plugins",
            })

        if not isinstance(args, dict):
            return json.dumps({"ok": False, "error": "arguments must be an object"})

        code = args.get("code")
        if not isinstance(code, str) or not code.strip():
            return json.dumps({"ok": False, "error": "code must be a non-empty string"})

        if not _check():
            return json.dumps({"ok": False, "error": "codemode unavailable (requires Node >=22 and Hermes core dispatch)"})

        exposed = _exposed_entries()
        fwd_kwargs: dict[str, Any] = {}
        if task_id is not None:
            fwd_kwargs["task_id"] = task_id
        if session_id is not None:
            fwd_kwargs["session_id"] = session_id
        if conversation_id is not None:
            fwd_kwargs["conversation_id"] = conversation_id
        if turn_id is not None:
            fwd_kwargs["turn_id"] = turn_id

        timeout_default = float(_setting("timeout_s", 60))
        raw_timeout = args.get("timeout", timeout_default)
        try:
            timeout_s = max(1.0, min(float(raw_timeout), 600.0))
        except (TypeError, ValueError):
            timeout_s = max(1.0, min(timeout_default, 600.0))

        thread_callbacks = ()
        interrupt_fn = None
        acting_for_var = None
        if _test_dispatch_override is None:
            from tools import interrupt, thread_context

            thread_callbacks = thread_context.capture_thread_callbacks()
            interrupt_fn = interrupt.is_interrupted
            acting_for_var = interrupt.acting_for_tid

        assert _manager is not None
        out = _manager.run(
            session_id=session_id or task_id or "default",
            session_key=_session_key(),
            code=code,
            tools=exposed,
            helper_bindings=HERMES_HELPER_BINDINGS,
            dispatch_fn=lambda name, a: _dispatch_hermes_tool(name, a, fwd_kwargs),
            timeout_s=timeout_s,
            max_tool_calls=int(_setting("max_tool_calls", 200)),
            max_concurrency=int(_setting("max_concurrency", 8)),
            max_result_chars=int(_setting("max_result_chars", 50000)),
            reset=bool(args.get("reset", False)),
            interrupt_fn=interrupt_fn,
            thread_callbacks=thread_callbacks,
            acting_for_var=acting_for_var,
        )
        return _redact(json.dumps(out))
    except Exception as exc:
        return _redact(json.dumps({"ok": False, "error": str(exc)}))


def _handle_command(raw_args: str) -> str:
    parts = str(raw_args or "").strip().split()
    sub = parts[0].lower() if parts else "status"
    if sub == "reset":
        if _manager is not None:
            _manager.close_all()
        return "Code Mode sandbox workers reset."
    if sub == "tools":
        query = " ".join(parts[1:]).lower()
        exposed = _exposed_entries()
        if query:
            terms = query.split()
            exposed = [
                e for e in exposed
                if all(t in f"{e['name']} {e['description']}".lower() for t in terms)
            ]
        if not exposed:
            return "No matching exposed Code Mode tools."
        lines = [f"- {e['name']}: {e['description'][:80]}" for e in exposed[:25]]
        return "\n".join(lines)

    node_bin = resolve_node_binary(str(_setting("node_binary", "") or "")) or "(not found)"
    exposed_count = len(_exposed_entries())
    workers = _manager.active_count() if _manager is not None else 0
    return f"Code Mode: {exposed_count} exposed tool(s), {workers} active worker(s), node={node_bin}"


def register(ctx: Any) -> None:
    global _ctx, _manager
    _ctx = ctx
    _manager = CodemodeManager(
        node_binary=str(_setting("node_binary", "") or ""),
        memory_mb=int(_setting("memory_mb", 256)),
        max_sessions=int(_setting("max_sessions", 16)),
        idle_ttl_s=float(_setting("idle_ttl_s", 1800)),
    )

    ctx.register_tool(
        name="codemode",
        toolset="codemode",
        schema=CODEMODE_SCHEMA,
        handler=_handle,
        check_fn=_check,
        description=CODEMODE_SCHEMA["description"],
        emoji="⚡",
    )

    ctx.register_command(
        "codemode",
        _handle_command,
        description="Inspect or reset Code Mode sandbox: /codemode [status|reset|tools <query>]",
    )

    if _setting("prompt_guidance", True) and hasattr(ctx, "register_system_prompt_section"):
        ctx.register_system_prompt_section(
            "code-mode.guidance",
            _PROMPT_GUIDANCE,
            position="after_memory",
            max_chars=2000,
        )

    skill_md = _PLUGIN_ROOT / "skills" / "code-mode" / "SKILL.md"
    if hasattr(ctx, "register_skill") and skill_md.exists():
        ctx.register_skill("code-mode", skill_md)

    ctx.register_hook(
        "on_session_finalize",
        lambda **kw: _manager.close_session(kw.get("session_id")) if _manager else None,
    )
    ctx.register_hook(
        "on_session_reset",
        lambda **kw: (
            _manager.close_session(kw.get("old_session_id")),
            _manager.close_session(kw.get("session_id")),
        )
        if _manager
        else None,
    )
    ctx.register_hook(
        "agent_loop_stopped",
        lambda **kw: _manager.close_by_session_key(kw.get("session_key")) if _manager else None,
    )
    ctx.register_hook(
        "subagent_stop",
        lambda **kw: _manager.close_session(kw.get("child_session_id")) if _manager else None,
    )

    if hasattr(ctx, "on_unload"):
        ctx.on_unload(_manager.close_all)
