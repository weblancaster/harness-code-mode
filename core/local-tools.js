/**
 * Opt-in workspace-confined local coding tools for standalone MCP hosts
 * (Codex, Claude Code, Cursor, etc.). Off by default; enabled only with
 * `--allow-local-tools --workspace <dir>`.
 *
 * Every path and shell working directory is realpath-checked to stay inside
 * `workspaceRoot`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const LOCAL_HELPER_BINDINGS = {
  shell: "local_shell",
  shellCwdKey: "workdir",
  read: "local_read",
  readStripLineNums: false,
  edit: "local_edit",
  editKeys: ["path", "old_string", "new_string"],
  write: "local_write",
  grep: "local_grep",
  glob: "local_glob",
};

function isInside(rootReal, targetReal) {
  const rel = path.relative(rootReal, targetReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveContained(rootReal, userPath, { allowMissing = false } = {}) {
  const raw = String(userPath ?? "").trim();
  if (!raw) throw new Error("path is required");
  const candidate = path.resolve(rootReal, raw);
  if (!isInside(rootReal, candidate)) {
    throw new Error(`path escapes workspace: ${userPath}`);
  }
  if (fs.existsSync(candidate)) {
    const real = fs.realpathSync(candidate);
    if (!isInside(rootReal, real)) {
      throw new Error(`path escapes workspace via symlink: ${userPath}`);
    }
    return real;
  }
  if (!allowMissing) {
    throw new Error(`file not found: ${userPath}`);
  }
  // Walk up to nearest existing ancestor and verify its realpath is inside rootReal.
  let probe = path.dirname(candidate);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const ancestorReal = fs.realpathSync(probe);
  if (!isInside(rootReal, ancestorReal)) {
    throw new Error(`path escapes workspace via parent symlink: ${userPath}`);
  }
  return candidate;
}

function globToRegExp(pattern) {
  const escaped = String(pattern || "*")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/___GLOBSTAR___/g, ".*");
  return new RegExp(`(^|/)${escaped}$`);
}

function walkFiles(dirReal, rootReal, out, maxFiles = 2000) {
  if (out.length >= maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(dirReal, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) return;
    if (ent.name === ".git" || ent.name === "node_modules" || ent.name === "__pycache__") continue;
    const full = path.join(dirReal, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      walkFiles(full, rootReal, out, maxFiles);
    } else if (ent.isFile()) {
      out.push(path.relative(rootReal, full));
    }
  }
}

export function createLocalTools(workspaceRoot) {
  const rootReal = fs.realpathSync(path.resolve(workspaceRoot));

  const tools = [
    {
      name: "local_read",
      description: "Read a text file inside the workspace",
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        required: ["path"],
      },
    },
    {
      name: "local_write",
      description: "Write a file inside the workspace",
      schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "local_edit",
      description: "Find-and-replace edit in a workspace file",
      schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "local_grep",
      description: "Search file contents inside the workspace",
      schema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "integer" } },
        required: ["pattern"],
      },
    },
    {
      name: "local_glob",
      description: "Find files by glob pattern inside the workspace",
      schema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" }, limit: { type: "integer" } },
        required: ["pattern"],
      },
    },
    {
      name: "local_shell",
      description: "Run a foreground shell command confined to the workspace",
      schema: {
        type: "object",
        properties: {
          command: { type: "string" },
          workdir: { type: "string" },
          timeout: { type: "number" },
        },
        required: ["command"],
      },
    },
  ];

  async function dispatch(name, args = {}) {
    switch (name) {
      case "local_read": {
        const target = resolveContained(rootReal, args.path);
        const raw = fs.readFileSync(target, "utf8");
        const lines = raw.split("\n");
        const offset = Math.max(1, Number(args.offset) || 1);
        const limit = Math.max(1, Math.min(Number(args.limit) || 2000, 5000));
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        return { content: slice.join("\n"), total_lines: lines.length };
      }
      case "local_write": {
        const target = resolveContained(rootReal, args.path, { allowMissing: true });
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(args.content ?? ""), "utf8");
        return { ok: true, path: path.relative(rootReal, target) };
      }
      case "local_edit": {
        const target = resolveContained(rootReal, args.path);
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        if (!oldStr) throw new Error("old_string must be non-empty");
        const current = fs.readFileSync(target, "utf8");
        if (!current.includes(oldStr)) {
          throw new Error(`old_string not found in ${args.path}`);
        }
        const updated = args.replace_all
          ? current.split(oldStr).join(newStr)
          : current.replace(oldStr, newStr);
        fs.writeFileSync(target, updated, "utf8");
        return { ok: true, path: path.relative(rootReal, target) };
      }
      case "local_grep": {
        const base = args.path ? resolveContained(rootReal, args.path) : rootReal;
        const limit = Math.max(1, Math.min(Number(args.limit) || 100, 1000));
        const re = new RegExp(String(args.pattern ?? ""));
        const files = [];
        const stat = fs.statSync(base);
        if (stat.isFile()) files.push(path.relative(rootReal, base));
        else walkFiles(base, rootReal, files);
        const matches = [];
        for (const rel of files) {
          if (matches.length >= limit) break;
          let text;
          try {
            text = fs.readFileSync(path.join(rootReal, rel), "utf8");
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matches.push(`${rel}:${i + 1}:${lines[i]}`);
              if (matches.length >= limit) break;
            }
          }
        }
        return { matches };
      }
      case "local_glob": {
        const base = args.path ? resolveContained(rootReal, args.path) : rootReal;
        const limit = Math.max(1, Math.min(Number(args.limit) || 200, 2000));
        const re = globToRegExp(args.pattern);
        const files = [];
        walkFiles(base, rootReal, files);
        return { matches: files.filter((f) => re.test(f)).slice(0, limit) };
      }
      case "local_shell": {
        const cwd = args.workdir ? resolveContained(rootReal, args.workdir) : rootReal;
        const timeoutMs = Math.max(1000, Math.min((Number(args.timeout) || 60) * 1000, 600_000));
        const command = String(args.command ?? "");
        return await new Promise((resolve) => {
          const proc = spawn("/bin/sh", ["-c", command], {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          const maxBytes = 100_000;
          const append = (chunk) => {
            if (out.length < maxBytes) out += chunk.toString("utf8");
          };
          proc.stdout.on("data", append);
          proc.stderr.on("data", append);
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            try {
              proc.kill("SIGKILL");
            } catch {
              // Ignore.
            }
          }, timeoutMs);
          proc.once("exit", (code) => {
            clearTimeout(timer);
            resolve({
              output: timedOut ? `${out}\n[command timed out]` : out,
              exit_code: timedOut ? 124 : (typeof code === "number" ? code : 1),
            });
          });
          proc.once("error", (err) => {
            clearTimeout(timer);
            resolve({ output: err.message, exit_code: 1 });
          });
        });
      }
      default:
        throw new Error(`unknown local tool: ${name}`);
    }
  }

  return { tools, dispatch, helperBindings: LOCAL_HELPER_BINDINGS, rootReal };
}
