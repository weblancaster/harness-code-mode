"""Unit tests for Hermes plugin entrypoint (__init__.py)."""

import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_plugin_module():
    spec = importlib.util.spec_from_file_location("code_mode_plugin", REPO_ROOT / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["code_mode_plugin"] = mod
    spec.loader.exec_module(mod)
    return mod


class FakePluginContext:
    def __init__(self, config=None):
        self.config = config or {}
        self.tools = {}
        self.commands = {}
        self.hooks = {}
        self.prompt_sections = {}
        self.skills = {}
        self.unload_callbacks = []

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_tool(self, **kw):
        self.tools[kw["name"]] = kw

    def register_command(self, name, handler, description=""):
        self.commands[name] = {"handler": handler, "description": description}

    def register_hook(self, event, callback):
        self.hooks[event] = callback

    def register_system_prompt_section(self, section_id, content, **kw):
        self.prompt_sections[section_id] = {"content": content, **kw}

    def register_skill(self, name, path):
        self.skills[name] = path

    def on_unload(self, cb):
        self.unload_callbacks.append(cb)

    def redact_text(self, text, *, force=False):
        return text.replace("sk-secret-token-1234", "«redacted:sk-…»")


class FakeRegistry:
    def __init__(self, entries):
        self._entries = entries

    def get_all_entries(self):
        return list(self._entries)


class TestHermesPlugin(unittest.TestCase):
    def setUp(self):
        self.mod = load_plugin_module()
        self.ctx = FakePluginContext(
            {
                "extra_tools": ["terminal", "read_file", "patch"],
                "timeout_s": 30,
                "max_concurrency": 4,
                "prompt_guidance": True,
            }
        )
        self.dispatched = []
        self.fake_entries = [
            SimpleNamespace(name="terminal", description="Run shell", schema={"type": "object"}, check_fn=None),
            SimpleNamespace(name="read_file", description="Read file", schema={"type": "object"}, check_fn=None),
            SimpleNamespace(name="patch", description="Patch file", schema={"type": "object"}, check_fn=None),
            SimpleNamespace(name="mcp__github__list_prs", description="List PRs", schema={"type": "object"}, check_fn=None),
            SimpleNamespace(name="delegate_task", description="Subagent", schema={}, check_fn=None),
            SimpleNamespace(name="tool_call", description="Deferred bridge", schema={}, check_fn=None),
            SimpleNamespace(name="disabled_mcp", description="Off", schema={}, check_fn=lambda: False),
        ]

    def tearDown(self):
        if getattr(self.mod, "_manager", None):
            self.mod._manager.close_all()

    def test_register_wires_tool_command_hooks_prompt_skill_and_unload(self):
        self.mod.register(self.ctx)
        self.assertIn("codemode", self.ctx.tools)
        self.assertIn("codemode", self.ctx.commands)
        for ev in ("on_session_finalize", "on_session_reset", "agent_loop_stopped", "subagent_stop"):
            self.assertIn(ev, self.ctx.hooks)
        self.assertIn("code-mode.guidance", self.ctx.prompt_sections)
        section_text = self.ctx.prompt_sections["code-mode.guidance"]["content"]
        if callable(section_text):
            section_text = section_text({})
        self.assertIn("tool_call", section_text)
        self.assertIn("code-mode", self.ctx.skills)
        self.assertEqual(len(self.ctx.unload_callbacks), 1)

    def test_exposed_entries_excludes_never_tools_and_false_check_fn(self):
        self.mod.register(self.ctx)
        exposed = self.mod._exposed_entries(registry_override=FakeRegistry(self.fake_entries))
        names = {e["name"] for e in exposed}
        self.assertEqual(names, {"terminal", "read_file", "patch", "mcp__github__list_prs"})
        self.assertNotIn("delegate_task", names)
        self.assertNotIn("tool_call", names)
        self.assertNotIn("disabled_mcp", names)

    def test_handler_strips_terminal_blocked_params_forwards_ids_and_redacts(self):
        def fake_handle_fn(tool_name, tool_args, **fwd):
            self.dispatched.append((tool_name, tool_args, fwd))
            if tool_name == "terminal":
                return json.dumps({"output": "token=sk-secret-token-1234", "exit_code": 0})
            if tool_name == "read_file":
                return json.dumps({"content": "1|hello\n2|world"})
            return json.dumps({"ok": True})

        self.mod.register(self.ctx)
        self.mod._test_registry_override = FakeRegistry(self.fake_entries)
        self.mod._test_dispatch_override = fake_handle_fn

        handler = self.ctx.tools["codemode"]["handler"]
        raw = handler(
            {
                "code": """
                    const sh = await tools.terminal({
                        command: "echo hi",
                        background: true,
                        pty: true,
                        persist_on_release: true,
                    });
                    const f = await read("demo.txt");
                    return { out: sh.output, text: f.text };
                """,
            },
            task_id="task-42",
            session_id="sess-99",
            conversation_id="conv-7",
            turn_id="turn-3",
        )
        self.assertNotIn("sk-secret-token-1234", raw)
        self.assertIn("«redacted:sk-…»", raw)
        parsed = json.loads(raw)
        self.assertTrue(parsed["ok"], parsed)
        self.assertEqual(parsed["result"]["text"], "hello\nworld")

        term_call = [c for c in self.dispatched if c[0] == "terminal"][0]
        self.assertNotIn("background", term_call[1])
        self.assertNotIn("pty", term_call[1])
        self.assertNotIn("persist_on_release", term_call[1])
        self.assertEqual(term_call[2]["task_id"], "task-42")
        self.assertEqual(term_call[2]["session_id"], "sess-99")
        self.assertEqual(term_call[2]["conversation_id"], "conv-7")

    def test_fail_closed_check_and_subagent_block(self):
        self.mod.register(self.ctx)
        orig_probe = self.mod._hermes_runtime_available
        try:
            self.mod._hermes_runtime_available = lambda: False
            self.assertFalse(self.ctx.tools["codemode"]["check_fn"]())
        finally:
            self.mod._hermes_runtime_available = orig_probe

        # Restricted subagent guard
        os.environ["HERMES_DELEGATED_CHILD_CONTEXT"] = "1"
        try:
            raw = self.ctx.tools["codemode"]["handler"]({"code": "return 1;"}, session_id="sub-1")
            parsed = json.loads(raw)
            self.assertFalse(parsed["ok"])
            self.assertIn("subagent", parsed["error"].lower())
        finally:
            os.environ.pop("HERMES_DELEGATED_CHILD_CONTEXT", None)

    def test_cleanup_hooks_and_slash_command(self):
        self.mod.register(self.ctx)
        self.mod._test_registry_override = FakeRegistry(self.fake_entries)
        self.mod._test_dispatch_override = lambda n, a, **kw: json.dumps({"ok": True})

        handler = self.ctx.tools["codemode"]["handler"]
        handler({"code": "state.x = 1; return 1;"}, session_id="old-s")
        self.assertEqual(self.mod._manager.active_count(), 1)

        # on_session_reset closes old_session_id even when session_id is new
        self.ctx.hooks["on_session_reset"](session_id="new-s", old_session_id="old-s", new_session_id="new-s")
        self.assertEqual(self.mod._manager.active_count(), 0)

        # on_session_finalize and subagent_stop close their targets
        handler({"code": "return 1;"}, session_id="fin-s")
        self.ctx.hooks["on_session_finalize"](session_id="fin-s")
        self.assertEqual(self.mod._manager.active_count(), 0)

        handler({"code": "return 1;"}, session_id="child-s")
        self.ctx.hooks["subagent_stop"](child_session_id="child-s")
        self.assertEqual(self.mod._manager.active_count(), 0)

        # Slash command status / tools / reset
        cmd = self.ctx.commands["codemode"]["handler"]
        self.assertIn("Code Mode", cmd("status"))
        self.assertIn("mcp__github__list_prs", cmd("tools github"))
        self.assertIn("reset", cmd("reset").lower())


if __name__ == "__main__":
    unittest.main()
