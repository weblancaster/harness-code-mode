/**
 * Zero-dependency stdio JSON-RPC 2.0 MCP server exposing `codemode` and `codemode_reset`
 * for Codex, Claude Code, Cursor, OpenCode, Windsurf, and any MCP-compatible harness.
 *
 * Session state is scoped to this stdio MCP server connection (one connection = one
 * persistent sandbox `state` object; callers can pass `reset: true` or call `codemode_reset`).
 */

import readline from "node:readline";

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-03-26", "2024-11-05"]);
const LATEST_PROTOCOL_VERSION = "2025-03-26";

export function buildToolDefinitions({ hasLocalTools = false, upstreamCount = 0 } = {}) {
  const localNote = hasLocalTools
    ? " Also includes workspace-confined $, read, edit, write, grep, and glob helpers."
    : "";
  return [
    {
      name: "codemode",
      description:
        `Run an async JavaScript body in a persistent Node.js sandbox with parallel Promise.all tool calls ` +
        `across ${upstreamCount} aggregated upstream MCP tool(s).${localNote} ` +
        `Use searchTools(query, topK) and describeTool(name) to discover schemas on demand, ` +
        `tools.<name>(args) to invoke tools, state.<key> to persist values across calls, and return only the compact summary.`,
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Async JS function body. Supports await, Promise.all([...]), tools.<name>(args), " +
              "searchTools(query, topK), describeTool(name), console.log(...), persistent state, and return <value>.",
          },
          timeout: {
            type: "number",
            description: "Wall-clock timeout in seconds before hard-killing the sandbox (max 600).",
          },
          reset: {
            type: "boolean",
            description: "Restart the persistent JS sandbox before executing (clears state).",
          },
        },
        required: ["code"],
      },
    },
    {
      name: "codemode_reset",
      description: "Reset the persistent Code Mode JavaScript sandbox and clear `state`.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

export class McpServer {
  constructor({
    manager,
    tools = [],
    helperBindings = {},
    dispatch,
    hasLocalTools = false,
    upstreamCount = 0,
    input = process.stdin,
    output = process.stdout,
    sessionId = `mcp-${process.pid}`,
    onClose = null,
  }) {
    this.manager = manager;
    this.tools = tools;
    this.helperBindings = helperBindings;
    this.dispatch = dispatch;
    this.hasLocalTools = hasLocalTools;
    this.upstreamCount = upstreamCount;
    this.input = input;
    this.output = output;
    this.sessionId = sessionId;
    this.onClose = onClose;
    this._rl = null;
  }

  _write(obj) {
    try {
      this.output.write(JSON.stringify(obj) + "\n");
    } catch {
      // Broken pipe during host shutdown.
    }
  }

  _ok(id, result) {
    this._write({ jsonrpc: "2.0", id, result });
  }

  _err(id, code, message) {
    this._write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async _handle(msg) {
    if (!msg || typeof msg !== "object" || !msg.method) return;
    const { id, method, params = {} } = msg;

    if (method === "notifications/initialized") {
      return;
    }
    if (method === "notifications/cancelled") {
      this.manager.forceKill(this.sessionId, params.reason || "cancelled by MCP host");
      return;
    }

    if (method === "initialize") {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      this._ok(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "harness-code-mode", version: "0.1.0" },
      });
      return;
    }

    if (method === "ping") {
      this._ok(id, {});
      return;
    }

    if (method === "tools/list") {
      this._ok(id, {
        tools: buildToolDefinitions({
          hasLocalTools: this.hasLocalTools,
          upstreamCount: this.upstreamCount,
        }),
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = String(params.name || "");
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};

      if (toolName === "codemode_reset") {
        await this.manager.resetSession(this.sessionId);
        const payload = { ok: true, reset: true };
        this._ok(id, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
        });
        return;
      }

      if (toolName === "codemode") {
        const code = typeof args.code === "string" ? args.code : "";
        if (!code.trim()) {
          const payload = { ok: false, error: "code must be a non-empty string" };
          this._ok(id, {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(payload) }],
            structuredContent: payload,
          });
          return;
        }
        const out = await this.manager.run({
          sessionId: this.sessionId,
          code,
          tools: this.tools,
          helperBindings: this.helperBindings,
          dispatch: this.dispatch,
          timeoutSec: args.timeout,
          reset: Boolean(args.reset),
        });
        this._ok(id, {
          isError: !out.ok,
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
        });
        return;
      }

      this._err(id, -32601, `Unknown tool: ${toolName}`);
      return;
    }

    if (id !== undefined) {
      this._err(id, -32601, `Method not found: ${method}`);
    }
  }

  start() {
    this._rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    this._rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      this._handle(msg).catch((err) => {
        if (msg && msg.id !== undefined) {
          this._err(msg.id, -32603, String(err && err.message ? err.message : err));
        }
      });
    });
    this._rl.on("close", () => {
      if (this.onClose) {
        Promise.resolve(this.onClose()).finally(() => process.exit(0));
      }
    });
  }
}
