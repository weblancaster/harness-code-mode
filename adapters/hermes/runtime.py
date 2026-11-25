"""Persistent per-session Node.js Code Mode runtime for Hermes Agent.

Spawns the shared `core/worker.js` under `node --permission` with canonicalized
paths, scrubbed environment, and strict host-side enforcement (active `exec_id`,
tool allowlist, budget, concurrency, and truncation).

Thread-context & interrupt invariants (verified against Hermes v0.23.4):
- Captures `base_ctx = contextvars.copy_context()`, `capture_thread_callbacks()`,
  and `handler_tid = threading.current_thread().ident` on the tool-handler thread.
- Clones `base_ctx.copy()` per `ThreadPoolExecutor` task (never reusing a single
  `Context` concurrently, which raises `RuntimeError: cannot enter context`).
- Sets `tools.interrupt.acting_for_tid` to `handler_tid` on each pool task so
  nested `terminal` commands honour `/stop`.
- Polls `interrupt_fn()` (`tools.interrupt.is_interrupted`) every <=0.15s in the
  wait loop so classic CLI `/stop` kills the worker even without `agent_loop_stopped`.
- `force_kill()` never acquires `_run_lock`, preventing `/stop` deadlocks.
"""

from __future__ import annotations

import atexit
from concurrent.futures import ThreadPoolExecutor
import contextvars
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable, Optional, Sequence

HERMES_HELPER_BINDINGS = {
    "shell": "terminal",
    "shellCwdKey": "workdir",
    "read": "read_file",
    "readStripLineNums": True,
    "edit": "patch",
    "editKeys": ["path", "old_string", "new_string"],
    "write": "write_file",
    "grep": "search_files",
    "glob": "search_files",
}

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_WORKER = _REPO_ROOT / "core" / "worker.js"
_DEFAULT_CATALOG = _REPO_ROOT / "core" / "catalog.js"
_NODE_MAJOR_CACHE: dict[str, int] = {}


def _node_major(node_bin: str) -> int:
    if node_bin in _NODE_MAJOR_CACHE:
        return _NODE_MAJOR_CACHE[node_bin]
    try:
        out = subprocess.check_output([node_bin, "--version"], text=True, timeout=5, stderr=subprocess.DEVNULL).strip()
        major = int(out.lstrip("v").split(".")[0])
    except Exception:
        major = 0
    _NODE_MAJOR_CACHE[node_bin] = major
    return major


def resolve_node_binary(override: str = "") -> Optional[str]:
    """Return a Node.js >=22 binary path (override -> Hermes bundled -> PATH)."""
    candidates: list[str] = []
    if override:
        candidates.append(os.path.expanduser(override))
    bundled = Path.home() / ".hermes" / "node" / "bin" / "node"
    if bundled.is_file():
        candidates.append(str(bundled))
    on_path = shutil.which("node")
    if on_path:
        candidates.append(on_path)

    for cand in candidates:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            if _node_major(cand) >= 22:
                return cand
    return None


def _scrub_env() -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(Path.home()),
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "en_US.UTF-8"),
    }


def _truncate_result(result: Any, max_chars: int) -> tuple[Any, bool]:
    limit = max(64, int(max_chars or 50000))
    try:
        serialized = json.dumps(result)
    except Exception:
        serialized = str(result)
    if len(serialized) <= limit:
        return result, False
    if isinstance(result, str):
        return f"{result[:limit]}\n...[truncated {len(result) - limit} chars]", True
    return f"{serialized[:limit]}\n...[truncated {len(serialized) - limit} chars]", True


def _parse_dispatch_result(raw: Any, tool_name: str = "") -> Any:
    parsed = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except Exception:
            return raw
    if tool_name.startswith("mcp__") and isinstance(parsed, dict):
        # Hermes MCP handlers wrap CallToolResult as {"result": text_result}
        # (and optionally "structuredContent" / "_meta"). Match core/mcp-client.js
        # and adapters/pi/index.ts by returning structuredContent or JSON-parsed text.
        if "error" in parsed and "result" not in parsed:
            return parsed
        if "structuredContent" in parsed and parsed["structuredContent"] is not None:
            return parsed["structuredContent"]
        if "result" in parsed and set(parsed.keys()) <= {"result", "_meta"}:
            inner = parsed["result"]
            if isinstance(inner, str):
                try:
                    return json.loads(inner)
                except Exception:
                    return inner
            return inner
    return parsed


class CodemodeSession:
    def __init__(
        self,
        session_id: str,
        *,
        node_binary: str,
        memory_mb: int = 256,
        worker_path: Optional[Path] = None,
        catalog_path: Optional[Path] = None,
    ) -> None:
        self.session_id = session_id
        self.node_binary = node_binary
        self.memory_mb = max(32, int(memory_mb or 256))
        self.worker_path = Path(worker_path or _DEFAULT_WORKER).resolve()
        self.catalog_path = Path(catalog_path or _DEFAULT_CATALOG).resolve()

        self._run_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._proc: Optional[subprocess.Popen[str]] = None
        self._queue: queue.Queue[Optional[dict[str, Any]]] = queue.Queue()
        self._reader_thread: Optional[threading.Thread] = None
        self._stderr_lines: list[str] = []
        self._catalog_key = ""
        self._exec_seq = 0
        self.last_used = time.monotonic()
        self._active = False

    def _spawn(self) -> None:
        self._catalog_key = ""
        self._queue = queue.Queue()
        self._stderr_lines = []
        cmd = [
            self.node_binary,
            "--permission",
            f"--allow-fs-read={self.worker_path}",
            f"--allow-fs-read={self.catalog_path}",
            f"--max-old-space-size={self.memory_mb}",
            str(self.worker_path),
        ]
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(Path(tempfile.gettempdir()).resolve()),
            env=_scrub_env(),
        )
        self._proc = proc
        q = self._queue

        def _read_stdout() -> None:
            assert proc.stdout is not None
            try:
                for line in proc.stdout:
                    s = line.strip()
                    if not s:
                        continue
                    try:
                        q.put(json.loads(s))
                    except Exception:
                        continue
            except Exception:
                pass
            finally:
                q.put(None)

        def _read_stderr() -> None:
            assert proc.stderr is not None
            try:
                for line in proc.stderr:
                    if len(self._stderr_lines) < 50:
                        self._stderr_lines.append(line.rstrip())
            except Exception:
                pass

        self._reader_thread = threading.Thread(target=_read_stdout, daemon=True)
        self._reader_thread.start()
        threading.Thread(target=_read_stderr, daemon=True).start()

        try:
            ready = q.get(timeout=10.0)
        except queue.Empty as exc:
            self.force_kill()
            raise RuntimeError("sandbox worker timed out before ready") from exc
        if not ready or ready.get("type") != "ready":
            err = "; ".join(self._stderr_lines[-5:])
            self.force_kill()
            raise RuntimeError(f"sandbox worker failed to start: {err or 'EOF'}")

    def _ensure_process(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            self._spawn()

    def _send(self, obj: dict[str, Any]) -> bool:
        with self._write_lock:
            proc = self._proc
            if proc is None or proc.poll() is not None or proc.stdin is None:
                return False
            try:
                proc.stdin.write(json.dumps(obj) + "\n")
                proc.stdin.flush()
                return True
            except Exception:
                return False

    def force_kill(self) -> None:
        """Lock-free hard kill: never acquires `_run_lock`, so `/stop` cannot deadlock."""
        proc = self._proc
        self._proc = None
        self._catalog_key = ""
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass
            try:
                proc.wait(timeout=2.0)
            except Exception:
                pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

    def close(self) -> None:
        proc = self._proc
        self._proc = None
        self._catalog_key = ""
        if proc is None:
            return
        if proc.poll() is None:
            try:
                if proc.stdin:
                    proc.stdin.close()
            except Exception:
                pass
            try:
                proc.wait(timeout=0.5)
            except Exception:
                try:
                    proc.kill()
                    proc.wait(timeout=1.0)
                except Exception:
                    pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

    def _validate_call_frame(
        self,
        msg: dict[str, Any],
        *,
        active_exec_id: int,
        allowed_tools: set[str],
        max_tool_calls: int,
        tool_calls: int,
    ) -> str:
        if msg.get("exec_id") != active_exec_id:
            return "ignored"
        tool_name = str(msg.get("tool") or "")
        call_id = msg.get("id")
        if tool_name not in allowed_tools:
            self._send({
                "type": "reply",
                "exec_id": active_exec_id,
                "id": call_id,
                "ok": False,
                "error": f"tool not allowed: {tool_name}",
            })
            return "rejected"
        if tool_calls + 1 > max_tool_calls:
            self._send({
                "type": "reply",
                "exec_id": active_exec_id,
                "id": call_id,
                "ok": False,
                "error": f"tool call budget exceeded ({max_tool_calls})",
            })
            return "budget"
        return "ok"

    def run(
        self,
        *,
        code: str,
        tools: Sequence[dict[str, Any]],
        dispatch_fn: Callable[[str, dict[str, Any]], Any],
        helper_bindings: Optional[dict[str, Any]] = None,
        timeout_s: float = 60.0,
        max_tool_calls: int = 200,
        max_concurrency: int = 8,
        max_result_chars: int = 50000,
        reset: bool = False,
        interrupt_fn: Optional[Callable[[], bool]] = None,
        thread_callbacks: tuple[tuple[Callable[[Any], None], Any], ...] = (),
        acting_for_var: Optional[contextvars.ContextVar[Optional[int]]] = None,
    ) -> dict[str, Any]:
        # Snapshot caller-thread context & tid BEFORE acquiring lock or spawning worker threads.
        base_ctx = contextvars.copy_context()
        handler_tid = threading.current_thread().ident
        clamped_timeout = max(0.1, min(float(timeout_s or 60.0), 600.0))
        max_calls = max(1, int(max_tool_calls or 200))
        max_workers = max(1, int(max_concurrency or 8))
        bindings = dict(helper_bindings or {})

        wire_tools: list[dict[str, Any]] = []
        allowed_tools: set[str] = set()
        for t in tools:
            if not t or not t.get("name"):
                continue
            name = str(t["name"])
            allowed_tools.add(name)
            wire_tools.append({
                "name": name,
                "description": str(t.get("description") or ""),
                "schema": t.get("schema") if isinstance(t.get("schema"), dict) else {},
            })

        with self._run_lock:
            self._active = True
            self.last_used = time.monotonic()
            t0 = time.monotonic()
            tool_calls = 0
            calls_log: list[str] = []
            inflight_lock = threading.Lock()
            inflight = 0
            parallel_peak = 0

            def _stats() -> dict[str, Any]:
                return {
                    "tool_calls": tool_calls,
                    "calls": calls_log,
                    "elapsed_s": round(time.monotonic() - t0, 3),
                    "parallel_peak": parallel_peak,
                }

            try:
                if interrupt_fn and interrupt_fn():
                    return {"ok": False, "error": "execution interrupted", "stats": _stats()}
                if reset:
                    self.force_kill()
                try:
                    self._ensure_process()
                except Exception as exc:
                    return {"ok": False, "error": str(exc), "stats": _stats()}

                next_key = json.dumps({"tools": wire_tools, "helperBindings": bindings}, sort_keys=True)
                if not self._catalog_key:
                    self._send({"type": "init", "tools": wire_tools, "helperBindings": bindings})
                    self._catalog_key = next_key
                elif self._catalog_key != next_key:
                    self._send({"type": "update_catalog", "tools": wire_tools, "helperBindings": bindings})
                    self._catalog_key = next_key

                self._exec_seq += 1
                exec_id = self._exec_seq
                if not self._send({"type": "exec", "exec_id": exec_id, "code": str(code)}):
                    self.force_kill()
                    return {"ok": False, "error": "failed to send exec frame", "stats": _stats()}

                deadline = t0 + clamped_timeout
                settled = threading.Event()
                pool = ThreadPoolExecutor(max_workers=max_workers)
                try:
                    def _run_tool_call(call_id: Any, tool_name: str, tool_args: dict[str, Any]) -> None:
                        nonlocal inflight, parallel_peak
                        if settled.is_set():
                            return
                        with inflight_lock:
                            inflight += 1
                            if inflight > parallel_peak:
                                parallel_peak = inflight

                        # Fresh Context copy per concurrent worker task (avoids RuntimeError: cannot enter context).
                        task_ctx = base_ctx.copy()

                        def _inner() -> Any:
                            tid_token = None
                            if acting_for_var is not None:
                                tid_token = acting_for_var.set(handler_tid)
                            for setter, cb in thread_callbacks:
                                try:
                                    setter(cb)
                                except Exception:
                                    pass
                            try:
                                return dispatch_fn(tool_name, tool_args)
                            finally:
                                for setter, _cb in thread_callbacks:
                                    try:
                                        setter(None)
                                    except Exception:
                                        pass
                                if tid_token is not None and acting_for_var is not None:
                                    acting_for_var.reset(tid_token)

                        try:
                            raw_res = task_ctx.run(_inner)
                            if settled.is_set():
                                return
                            self._send({
                                "type": "reply",
                                "exec_id": exec_id,
                                "id": call_id,
                                "ok": True,
                                "result": _parse_dispatch_result(raw_res, tool_name),
                            })
                        except Exception as exc:
                            if settled.is_set():
                                return
                            self._send({
                                "type": "reply",
                                "exec_id": exec_id,
                                "id": call_id,
                                "ok": False,
                                "error": str(exc),
                            })
                        finally:
                            with inflight_lock:
                                inflight -= 1

                    while True:
                        if interrupt_fn and interrupt_fn():
                            settled.set()
                            self.force_kill()
                            return {"ok": False, "error": "execution interrupted", "stats": _stats()}
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            settled.set()
                            self.force_kill()
                            return {
                                "ok": False,
                                "error": f"timeout after {clamped_timeout}s (sandbox process killed)",
                                "stats": _stats(),
                            }
                        try:
                            msg = self._queue.get(timeout=min(0.15, remaining))
                        except queue.Empty:
                            continue

                        if msg is None:
                            settled.set()
                            self.force_kill()
                            err_tail = "; ".join(self._stderr_lines[-3:])
                            return {
                                "ok": False,
                                "error": f"sandbox worker terminated unexpectedly{f': {err_tail}' if err_tail else ''}",
                                "stats": _stats(),
                            }

                        if msg.get("exec_id") != exec_id:
                            continue

                        mtype = msg.get("type")
                        if mtype == "call":
                            verdict = self._validate_call_frame(
                                msg,
                                active_exec_id=exec_id,
                                allowed_tools=allowed_tools,
                                max_tool_calls=max_calls,
                                tool_calls=tool_calls,
                            )
                            if verdict != "ok":
                                continue
                            tool_calls += 1
                            tool_name = str(msg.get("tool") or "")
                            if len(calls_log) < 50:
                                calls_log.append(tool_name)
                            tool_args = msg.get("args") if isinstance(msg.get("args"), dict) else {}
                            pool.submit(_run_tool_call, msg.get("id"), tool_name, tool_args)
                        elif mtype == "done":
                            settled.set()
                            logs = msg.get("logs") if isinstance(msg.get("logs"), list) else []
                            if not msg.get("ok"):
                                out: dict[str, Any] = {
                                    "ok": False,
                                    "error": str(msg.get("error") or "execution failed"),
                                    "stats": _stats(),
                                }
                                if logs:
                                    out["logs"] = logs
                                return out
                            val, truncated = _truncate_result(msg.get("result"), max_result_chars)
                            out = {"ok": True, "result": val, "stats": _stats()}
                            if truncated:
                                out["truncated"] = True
                            if logs:
                                out["logs"] = logs
                            return out
                finally:
                    settled.set()
                    pool.shutdown(wait=False, cancel_futures=True)
            finally:
                self._active = False
                self.last_used = time.monotonic()


class CodemodeManager:
    def __init__(
        self,
        *,
        node_binary: Optional[str] = None,
        memory_mb: int = 256,
        max_sessions: int = 16,
        idle_ttl_s: float = 1800.0,
        worker_path: Optional[Path] = None,
        catalog_path: Optional[Path] = None,
    ) -> None:
        self._node_binary_override = node_binary or ""
        self.memory_mb = max(32, int(memory_mb or 256))
        self.max_sessions = max(1, int(max_sessions or 16))
        self.idle_ttl_s = max(5.0, float(idle_ttl_s or 1800.0))
        self.worker_path = worker_path
        self.catalog_path = catalog_path

        self._map_lock = threading.Lock()
        self._sessions: dict[str, CodemodeSession] = {}
        self._key_to_sids: dict[str, set[str]] = {}
        atexit.register(self.close_all)

    def active_count(self) -> int:
        with self._map_lock:
            return len(self._sessions)

    def _reap_and_evict_locked(self, keep_sid: str) -> list[CodemodeSession]:
        victims: list[CodemodeSession] = []
        now = time.monotonic()
        for sid, sess in list(self._sessions.items()):
            if sid == keep_sid or sess._active:
                continue
            if now - sess.last_used > self.idle_ttl_s:
                victims.append(self._sessions.pop(sid))
        while len(self._sessions) >= self.max_sessions:
            oldest_sid = None
            oldest_time = float("inf")
            for sid, sess in self._sessions.items():
                if sid == keep_sid or sess._active:
                    continue
                if sess.last_used < oldest_time:
                    oldest_time = sess.last_used
                    oldest_sid = sid
            if oldest_sid is None:
                break
            victims.append(self._sessions.pop(oldest_sid))
        if victims:
            victim_ids = {v.session_id for v in victims}
            for k, sids in list(self._key_to_sids.items()):
                sids.difference_update(victim_ids)
                if not sids:
                    self._key_to_sids.pop(k, None)
        return victims

    def _get_or_create(self, session_id: str, session_key: str = "") -> CodemodeSession:
        sid = str(session_id or "default")
        victims: list[CodemodeSession] = []
        with self._map_lock:
            sess = self._sessions.get(sid)
            if sess is None:
                victims = self._reap_and_evict_locked(sid)
                node_bin = resolve_node_binary(self._node_binary_override)
                if not node_bin:
                    raise RuntimeError("Node.js >=22 binary not found")
                sess = CodemodeSession(
                    sid,
                    node_binary=node_bin,
                    memory_mb=self.memory_mb,
                    worker_path=self.worker_path,
                    catalog_path=self.catalog_path,
                )
                self._sessions[sid] = sess
            if session_key:
                self._key_to_sids.setdefault(session_key, set()).add(sid)
        for v in victims:
            v.force_kill()
        return sess

    def run(
        self,
        *,
        session_id: str = "default",
        session_key: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        sess = self._get_or_create(session_id, session_key=session_key)
        return sess.run(**kwargs)

    def reset_session(self, session_id: str) -> None:
        self.close_session(session_id)

    def close_session(self, session_id: Optional[str]) -> None:
        if not session_id:
            return
        sid = str(session_id)
        with self._map_lock:
            sess = self._sessions.pop(sid, None)
            for k, sids in list(self._key_to_sids.items()):
                sids.discard(sid)
                if not sids:
                    self._key_to_sids.pop(k, None)
        if sess is not None:
            sess.force_kill()

    def close_by_session_key(self, session_key: Optional[str]) -> None:
        """Lock-free interrupt for gateway/TUI `agent_loop_stopped`."""
        if not session_key:
            return
        with self._map_lock:
            sids = self._key_to_sids.pop(str(session_key), set())
            victims = [self._sessions.pop(sid, None) for sid in sids]
        for sess in victims:
            if sess is not None:
                sess.force_kill()

    def close_all(self) -> None:
        with self._map_lock:
            victims = list(self._sessions.values())
            self._sessions.clear()
            self._key_to_sids.clear()
        for sess in victims:
            sess.force_kill()
