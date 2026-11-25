"""Unit tests for adapters/hermes/runtime.py against real core/worker.js."""

import contextvars
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from adapters.hermes.runtime import (  # noqa: E402
    CodemodeManager,
    HERMES_HELPER_BINDINGS,
    resolve_node_binary,
)

CALLER_VAR: contextvars.ContextVar[str] = contextvars.ContextVar("caller_var", default="missing")


class TestHermesRuntime(unittest.TestCase):
    def setUp(self):
        self.node_bin = resolve_node_binary()
        self.assertIsNotNone(self.node_bin, "Node >=22 binary required")
        self.mgr = CodemodeManager(node_binary=self.node_bin, max_sessions=2, idle_ttl_s=60)

    def tearDown(self):
        self.mgr.close_all()

    def test_chain_context_reduction_and_parallel_speedup(self):
        issues = [{"id": i, "urgent": (i % 3 == 0)} for i in range(1, 31)]

        def dispatch(name, args):
            if name == "list_issues":
                return json.dumps(issues)
            if name == "get_issue":
                time.sleep(0.05)
                return json.dumps({"id": args["id"], "body": "x" * 5000})
            if name == "slow_op":
                time.sleep(0.2)
                return json.dumps({"i": args["i"]})
            raise RuntimeError(f"unexpected {name}")

        tools = [
            {"name": "list_issues", "description": "list", "schema": {}},
            {"name": "get_issue", "description": "get", "schema": {}},
            {"name": "slow_op", "description": "sleep", "schema": {}},
        ]
        out = self.mgr.run(
            session_id="s-chain",
            code="""
                const urgent = (await tools.list_issues({})).filter((i) => i.urgent);
                const bodies = await Promise.all(urgent.map((i) => tools.get_issue({ id: i.id })));
                return { count: urgent.length, chars: bodies.reduce((s, b) => s + b.body.length, 0) };
            """,
            tools=tools,
            dispatch_fn=dispatch,
            helper_bindings=HERMES_HELPER_BINDINGS,
        )
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["result"], {"count": 10, "chars": 50000})
        self.assertEqual(out["stats"]["tool_calls"], 11)
        self.assertLess(len(json.dumps(out)), 2000)

        t0 = time.monotonic()
        par = self.mgr.run(
            session_id="s-chain",
            code="return await Promise.all([1,2,3,4].map((i) => tools.slow_op({ i })));",
            tools=tools,
            dispatch_fn=dispatch,
            max_concurrency=4,
        )
        elapsed = time.monotonic() - t0
        self.assertTrue(par["ok"], par)
        self.assertEqual(len(par["result"]), 4)
        self.assertLess(elapsed, 0.55)

    def test_parallel_contextvar_copy_and_callbacks_do_not_collide(self):
        token = CALLER_VAR.set("profile-secret-scope")
        seen_vals = []
        seen_lock = threading.Lock()
        cb_installed = []

        def fake_setter(val):
            with seen_lock:
                cb_installed.append(val)

        def dispatch(_name, args):
            time.sleep(0.05)
            val = CALLER_VAR.get()
            with seen_lock:
                seen_vals.append(val)
            return json.dumps({"i": args["i"], "ctx": val})

        try:
            out = self.mgr.run(
                session_id="s-ctx",
                code="return await Promise.all([1,2,3,4].map((i) => tools.echo({ i })));",
                tools=[{"name": "echo", "description": "echo", "schema": {}}],
                dispatch_fn=dispatch,
                max_concurrency=4,
                thread_callbacks=((fake_setter, "cb-fn"),),
            )
            self.assertTrue(out["ok"], out)
            self.assertEqual(seen_vals, ["profile-secret-scope"] * 4)
            self.assertIn("cb-fn", cb_installed)
            self.assertIn(None, cb_installed)
        finally:
            CALLER_VAR.reset(token)

    def test_host_allowlist_blocks_forged_call_and_stale_exec_id(self):
        dispatched = []
        sess = self.mgr._get_or_create("s-allow")
        sent = []
        orig_send = sess._send
        sess._send = lambda obj: sent.append(obj) or True
        try:
            res = sess._validate_call_frame(
                {"type": "call", "exec_id": 5, "id": 1, "tool": "tool_call", "args": {}},
                active_exec_id=5,
                allowed_tools={"read_file"},
                max_tool_calls=10,
                tool_calls=0,
            )
            self.assertEqual(res, "rejected")
            self.assertEqual(len(sent), 1)
            self.assertFalse(sent[0]["ok"])
            self.assertIn("not allowed", sent[0]["error"])

            stale = sess._validate_call_frame(
                {"type": "call", "exec_id": 4, "id": 2, "tool": "read_file", "args": {}},
                active_exec_id=5,
                allowed_tools={"read_file"},
                max_tool_calls=10,
                tool_calls=0,
            )
            self.assertEqual(stale, "ignored")
            self.assertEqual(len(dispatched), 0)
        finally:
            sess._send = orig_send

    def test_cli_interrupt_polling_and_gateway_lock_free_stop(self):
        flag = {"stop": False}
        threading.Timer(0.2, lambda: flag.__setitem__("stop", True)).start()
        t0 = time.monotonic()
        out = self.mgr.run(
            session_id="s-int",
            code="while (true) {}",
            tools=[],
            dispatch_fn=lambda n, a: "{}",
            timeout_s=30,
            interrupt_fn=lambda: flag["stop"],
        )
        self.assertFalse(out["ok"])
        self.assertIn("interrupt", out["error"].lower())
        self.assertLess(time.monotonic() - t0, 1.5)

        # Gateway /stop via session_key lock-free kill
        threading.Timer(0.2, lambda: self.mgr.close_by_session_key("sk-gw-1")).start()
        t1 = time.monotonic()
        out2 = self.mgr.run(
            session_id="s-gw",
            session_key="sk-gw-1",
            code="while (true) {}",
            tools=[],
            dispatch_fn=lambda n, a: "{}",
            timeout_s=30,
        )
        self.assertFalse(out2["ok"])
        self.assertLess(time.monotonic() - t1, 1.5)

    def test_state_reset_timeout_symlink_and_lru(self):
        # Symlinked worker dir still boots cleanly
        with tempfile.TemporaryDirectory() as tmp:
            sym_core = Path(tmp) / "core_link"
            os.symlink(REPO_ROOT / "core", sym_core)
            sym_mgr = CodemodeManager(
                node_binary=self.node_bin,
                worker_path=sym_core / "worker.js",
                catalog_path=sym_core / "catalog.js",
            )
            try:
                r = sym_mgr.run(session_id="sym", code="return 7;", tools=[], dispatch_fn=lambda n, a: "{}")
                self.assertTrue(r["ok"], r)
                self.assertEqual(r["result"], 7)
            finally:
                sym_mgr.close_all()

        # State + reset
        self.mgr.run(session_id="p1", code="state.v = 11; return 11;", tools=[], dispatch_fn=lambda n, a: "{}")
        r2 = self.mgr.run(session_id="p1", code="return state.v;", tools=[], dispatch_fn=lambda n, a: "{}")
        self.assertEqual(r2["result"], 11)
        r3 = self.mgr.run(session_id="p1", code="return state.v ?? null;", tools=[], dispatch_fn=lambda n, a: "{}", reset=True)
        self.assertIsNone(r3["result"])

        # Timeout hard-kill + clean respawn
        t0 = time.monotonic()
        tout = self.mgr.run(session_id="p1", code="while (true) {}", tools=[], dispatch_fn=lambda n, a: "{}", timeout_s=0.6)
        self.assertFalse(tout["ok"])
        self.assertIn("timeout", tout["error"].lower())
        self.assertLess(time.monotonic() - t0, 2.5)
        ok_after = self.mgr.run(session_id="p1", code="return 123;", tools=[], dispatch_fn=lambda n, a: "{}")
        self.assertEqual(ok_after["result"], 123)

        # LRU eviction (max_sessions=2)
        self.mgr.run(session_id="p2", code="return 2;", tools=[], dispatch_fn=lambda n, a: "{}")
        self.mgr.run(session_id="p3", code="return 3;", tools=[], dispatch_fn=lambda n, a: "{}")
        self.assertEqual(self.mgr.active_count(), 2)

    def test_mcp_result_envelope_unwrapping_preserves_builtin_and_errors(self):
        def dispatch(name, _args):
            if name == "mcp__ld__get_flags":
                return json.dumps({"result": json.dumps({"items": [{"key": "flag-a"}, {"key": "flag-b"}]})})
            if name == "mcp__pd__structured":
                return json.dumps({"result": "summary", "structuredContent": {"services": [{"id": "S1"}]}})
            if name == "mcp__plain__ping":
                return json.dumps({"result": "pong"})
            if name == "mcp__err__fail":
                return json.dumps({"error": "rate limited"})
            if name == "read_file":
                return json.dumps({"result": '{"not_unwrapped": true}'})
            raise RuntimeError(f"unexpected {name}")

        tools = [
            {"name": n, "description": n, "schema": {}}
            for n in (
                "mcp__ld__get_flags",
                "mcp__pd__structured",
                "mcp__plain__ping",
                "mcp__err__fail",
                "read_file",
            )
        ]
        out = self.mgr.run(
            session_id="s-mcp-unwrap",
            code="""
                const [flags, structured, plain, errRes, builtin] = await Promise.all([
                    tools.mcp__ld__get_flags({}),
                    tools.mcp__pd__structured({}),
                    tools.mcp__plain__ping({}),
                    tools.mcp__err__fail({}),
                    tools.read_file({}),
                ]);
                await sleep(15);
                return {
                    flagKeys: flags.items.map((f) => f.key),
                    serviceId: structured.services[0].id,
                    plain,
                    errRes,
                    builtinRawType: typeof builtin.result,
                };
            """,
            tools=tools,
            dispatch_fn=dispatch,
        )
        self.assertTrue(out["ok"], out)
        self.assertEqual(
            out["result"],
            {
                "flagKeys": ["flag-a", "flag-b"],
                "serviceId": "S1",
                "plain": "pong",
                "errRes": {"error": "rate limited"},
                "builtinRawType": "string",
            },
        )


if __name__ == "__main__":
    unittest.main()
