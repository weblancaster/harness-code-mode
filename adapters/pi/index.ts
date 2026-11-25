/**
 * Native Pi extension for `harness-code-mode`.
 *
 * Explicitly overrides Pi's built-in `codemode` tool by default (set
 * `HARNESS_CODEMODE_PI_TOOL_NAME` to register under an alternate name side-by-side).
 * Declares `exposure: "model-only"`, `reachesTools: () => "all"`, and
 * `prepareLoadout` so Pi's MCP extension activates this tool for `exposure: "codemode"`
 * servers and passes nested calls through Pi's `tool_call` permission gates.
 */

import { Catalog } from "../../core/catalog.js";
import { CodemodeManager } from "../../core/session.js";

interface PiToolMeta {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  exposure?: string;
}

interface PiToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}

interface PiToolContext {
  sessionId?: string;
  sessionManager?: { getSessionId?: () => string };
  tools?: PiToolMeta[];
  executeTool: (
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; onUpdate?: unknown },
  ) => Promise<PiToolResult>;
  ui?: { notify?: (msg: string, level?: string) => void };
}

interface PiLoadout {
  declaredTools?: PiToolMeta[];
  callableTools?: PiToolMeta[];
  allTools?: PiToolMeta[];
}

interface PiExtensionAPI {
  registerTool: (definition: Record<string, unknown>) => void;
  registerCommand: (
    name: string,
    definition: { description: string; handler: (args: string, ctx: PiToolContext) => Promise<void> | void },
  ) => void;
  on: (event: string, handler: (...args: unknown[]) => Promise<void> | void) => void;
  getAllTools?: () => PiToolMeta[];
}

const PI_HELPER_BINDINGS = {
  shell: "bash",
  shellCwdKey: null,
  read: "read",
  readStripLineNums: false,
  edit: "edit",
  editKeys: ["path", "oldText", "newText"],
  write: "write",
  grep: "grep",
  glob: "find",
};

const BASE_DESCRIPTION =
  "Run an async JavaScript body in a hardened persistent Node.js sandbox with parallel Promise.all " +
  "tool dispatch via ctx.executeTool, Claude Code-style $, read, edit, write, grep, and glob helpers, " +
  "BM25 searchTools(query, topK) / describeTool(name), and persistent `state`. Overrides Pi's built-in " +
  "codemode when registered as `codemode`.";

function unpackPiResult(toolName: string, res: PiToolResult | undefined): unknown {
  if (!res || typeof res !== "object") return res;
  const rawText = Array.isArray(res.content)
    ? res.content
        .filter((c) => c && (c.type === "text" || typeof c.text === "string"))
        .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
        .join("\n")
    : "";

  if (res.isError) {
    // Pi bash returns isError=true on non-zero exit; preserve output+exit_code so $.nothrow() works.
    if (toolName === "bash") {
      return { output: rawText, exit_code: 1 };
    }
    throw new Error(rawText || "tool execution failed");
  }
  if (res.structuredContent !== undefined) {
    return res.structuredContent;
  }
  if (toolName === "read" || toolName === "bash") {
    return toolName === "bash" ? { output: rawText, exit_code: 0 } : { content: rawText };
  }
  if (Array.isArray(res.content)) {
    const texts = res.content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string);
    if (texts.length === 1) {
      try {
        return JSON.parse(texts[0]);
      } catch {
        return texts[0];
      }
    }
    if (texts.length > 1) return texts.join("\n");
    return res.content;
  }
  return res;
}

function getSessionId(ctx: PiToolContext): string {
  if (ctx.sessionId) return ctx.sessionId;
  const fromMgr = ctx.sessionManager?.getSessionId?.();
  return fromMgr || "pi-default";
}

export default function registerPiCodeMode(pi: PiExtensionAPI): void {
  const toolName = (process.env.HARNESS_CODEMODE_PI_TOOL_NAME || "codemode").trim() || "codemode";
  const manager = new CodemodeManager();
  let lastTools: PiToolMeta[] = [];

  pi.registerTool({
    name: toolName,
    label: "Code Mode",
    exposure: "model-only",
    description: BASE_DESCRIPTION,
    promptGuidelines: [
      `Use ${toolName} when a task needs 3+ tool calls, parallel Promise.all fan-out, or filtering large outputs before returning.`,
      "Inside the JS body: call tools.<name>(args), $, read(path), edit(path, old, new), write(path, content), grep(pat), glob(pat), searchTools(q), describeTool(name), persist via state.<k>, and return only the summary.",
    ],
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Async JS function body; use await, Promise.all([...]), state.<key>, and return <value>.",
        },
        timeout: {
          type: "number",
          description: "Wall-clock timeout in seconds (default 60, max 600).",
        },
        reset: {
          type: "boolean",
          description: "Reset the persistent JS sandbox and clear state before running.",
        },
      },
      required: ["code"],
    },
    reachesTools(_input: unknown) {
      return "all";
    },
    prepareLoadout(loadout: PiLoadout) {
      const callable = Array.isArray(loadout?.callableTools) ? loadout.callableTools : [];
      const codemodeTools = callable.filter((t) => t.exposure === "codemode");
      const summary = codemodeTools.length
        ? ` Callable codemode-exposure tools (${codemodeTools.length}): ${codemodeTools
            .slice(0, 12)
            .map((t) => t.name)
            .join(", ")}${codemodeTools.length > 12 ? ", ..." : ""}. Use searchTools()/describeTool() for schemas.`
        : "";
      return {
        descriptions: {
          [toolName]: BASE_DESCRIPTION + summary,
        },
      };
    },
    async execute(
      _toolCallId: string,
      params: { code: string; timeout?: number; reset?: boolean },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PiToolContext,
    ) {
      const rawTools = Array.isArray(ctx.tools) ? ctx.tools : [];
      const exposed = rawTools
        .filter((t) => t && t.name && t.name !== toolName && t.exposure !== "model-only" && t.exposure !== "hidden")
        .map((t) => ({
          name: t.name,
          description: t.description || "",
          schema: (t.parameters || t.schema || {}) as Record<string, unknown>,
        }));
      lastTools = exposed;

      const sessionId = getSessionId(ctx);
      const out = await manager.run({
        sessionId,
        code: String(params?.code ?? ""),
        tools: exposed,
        helperBindings: PI_HELPER_BINDINGS,
        timeoutSec: params?.timeout,
        reset: Boolean(params?.reset),
        signal: signal ?? null,
        dispatch: async (name: string, args: Record<string, unknown>) => {
          const res = await ctx.executeTool(name, args, { signal });
          return unpackPiResult(name, res);
        },
      });

      return {
        isError: !out.ok,
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
        details: out,
      };
    },
  });

  pi.registerCommand("codemode", {
    description: "Inspect or reset the Code Mode sandbox: /codemode [status|reset|tools <query>]",
    async handler(rawArgs: string, ctx: PiToolContext) {
      const parts = String(rawArgs || "").trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "status").toLowerCase();
      const notify = (msg: string) => ctx.ui?.notify?.(msg, "info");

      if (sub === "reset") {
        await manager.resetSession(getSessionId(ctx));
        notify("Code Mode sandbox reset.");
        return;
      }
      if (sub === "tools") {
        const query = parts.slice(1).join(" ");
        const cat = new Catalog(lastTools);
        const list = query ? cat.search(query, 10) : lastTools.slice(0, 20);
        notify(
          list.length
            ? list.map((t) => `${t.name}: ${t.description || ""}`).join("\n")
            : "No matching Code Mode tools.",
        );
        return;
      }
      notify(
        `Code Mode (${toolName}): ${manager.activeCount()} active worker(s), ${lastTools.length} last-exposed tool(s).`,
      );
    },
  });

  // Clean up workers only on full session shutdown (never on session_before_switch).
  pi.on("session_shutdown", async () => {
    await manager.closeAll();
  });
}
