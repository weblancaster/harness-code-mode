/**
 * Zero-dependency JSON-RPC 2.0 upstream MCP client & aggregator (stdio + Streamable HTTP)
 * plus config loaders for `mcp.json` and Codex `config.toml`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SELF_NAMES = new Set(["codemode", "code-mode", "harness-code-mode"]);

export function expandHome(filePath) {
  if (!filePath) return filePath;
  const s = String(filePath);
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

function isSelfServer(name, cfg) {
  if (SELF_NAMES.has(String(name || "").toLowerCase())) return true;
  const cmd = String(cfg?.command || "");
  const args = Array.isArray(cfg?.args) ? cfg.args.join(" ") : "";
  const combined = `${cmd} ${args}`.toLowerCase();
  return (
    combined.includes("codemode-mcp") ||
    combined.includes("harness-code-mode") ||
    combined.includes("adapters/mcp/cli.js")
  );
}

function splitTopLevel(inner, sep = ",") {
  const items = [];
  let cur = "";
  let inQuote = null;
  let esc = false;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (esc) { cur += ch; esc = false; continue; }
    if (inQuote === '"' && ch === "\\") { cur += ch; esc = true; continue; }
    if (inQuote) { cur += ch; if (ch === inQuote) inQuote = null; continue; }
    if (ch === '"' || ch === "'") { inQuote = ch; cur += ch; continue; }
    if (ch === "[" || ch === "{") { depth++; cur += ch; continue; }
    if (ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); cur += ch; continue; }
    if (ch === sep && depth === 0) {
      if (cur.trim()) items.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function parseTomlValue(raw) {
  const s = raw.trim();
  if (!s) return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    if (s.startsWith('"')) {
      try {
        return JSON.parse(s);
      } catch {
        return s.slice(1, -1);
      }
    }
    return s.slice(1, -1);
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ",").map((item) => parseTomlValue(item));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    const obj = {};
    if (!inner) return obj;
    for (const pair of splitTopLevel(inner, ",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim().replace(/^["']|["']$/g, "");
      obj[k] = parseTomlValue(pair.slice(eq + 1));
    }
    return obj;
  }
  return s;
}

function stripTomlComment(line) {
  let inQuote = null;
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inQuote === '"' && ch === "\\") {
      esc = true;
      continue;
    }
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function bracketDelta(str) {
  let delta = 0;
  let inQuote = null;
  let esc = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (esc) { esc = false; continue; }
    if (inQuote === '"' && ch === "\\") { esc = true; continue; }
    if (inQuote) { if (ch === inQuote) inQuote = null; continue; }
    if (ch === '"' || ch === "'") { inQuote = ch; continue; }
    if (ch === "[" || ch === "{") delta++;
    else if (ch === "]" || ch === "}") delta--;
  }
  return delta;
}

function parseCodexTomlMcpServers(tomlText) {
  const servers = {};
  let currentServer = null;
  let subtable = null;
  const rawLines = tomlText.split(/\r?\n/);

  for (let idx = 0; idx < rawLines.length; idx++) {
    let line = stripTomlComment(rawLines[idx]).trim();
    if (!line) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      const parts = splitTopLevel(sec[1], ".").map((p) => p.replace(/^["']|["']$/g, ""));
      if (parts[0] === "mcp_servers" && parts[1]) {
        currentServer = parts[1];
        subtable = parts[2] || null;
        if (!servers[currentServer]) servers[currentServer] = {};
        if (subtable && !servers[currentServer][subtable]) {
          servers[currentServer][subtable] = {};
        }
      } else {
        currentServer = null;
        subtable = null;
      }
      continue;
    }
    if (!currentServer) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, "");
    let rawVal = line.slice(eq + 1).trim();
    let open = bracketDelta(rawVal);
    while (open > 0 && idx + 1 < rawLines.length) {
      idx++;
      const cont = stripTomlComment(rawLines[idx]).trim();
      if (!cont) continue;
      rawVal += " " + cont;
      open += bracketDelta(cont);
    }
    const val = parseTomlValue(rawVal);
    if (subtable) {
      servers[currentServer][subtable][key] = val;
    } else {
      servers[currentServer][key] = val;
    }
  }
  return servers;
}

export function loadUpstreamConfig({
  configPath = null,
  codexConfigPath = null,
  includeDisabled = false,
  warn = (m) => process.stderr.write(m + "\n"),
} = {}) {
  const merged = {};

  const absorb = (entries) => {
    for (const [name, cfg] of Object.entries(entries || {})) {
      if (!cfg || typeof cfg !== "object") continue;
      if (cfg.enabled === false && !includeDisabled) continue;
      if (isSelfServer(name, cfg)) continue;
      if (cfg.auth === "oauth" || cfg.oauth) {
        warn(`[codemode-mcp] skipping OAuth-authenticated upstream server '${name}' (not supported in v0.1)`);
        continue;
      }
      if (!cfg.command && !cfg.url) continue;
      merged[name] = cfg;
    }
  };

  if (configPath) {
    const resolved = path.resolve(expandHome(configPath));
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    absorb(parsed.mcpServers || parsed.servers || parsed);
  }
  if (codexConfigPath) {
    const resolved = path.resolve(expandHome(codexConfigPath));
    const toml = fs.readFileSync(resolved, "utf8");
    absorb(parseCodexTomlMcpServers(toml));
  }
  return merged;
}

function extractMcpResult(res) {
  if (!res || typeof res !== "object") return res;
  if (res.isError) {
    const text = Array.isArray(res.content)
      ? res.content.map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c))).join("\n")
      : String(res.error || "upstream MCP tool error");
    throw new Error(text || "upstream MCP tool error");
  }
  if (res.structuredContent !== undefined) return res.structuredContent;
  if (Array.isArray(res.content)) {
    const texts = res.content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text);
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

class StdioMcpClient {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this._proc = null;
    this._nextId = 1;
    this._pending = new Map();
  }

  async connect() {
    const env = { ...process.env, ...(this.cfg.env || {}) };
    const args = Array.isArray(this.cfg.args) ? this.cfg.args.map(String) : [];
    const cwd = this.cfg.cwd ? expandHome(this.cfg.cwd) : undefined;
    // Ignore stderr (never leave an unread pipe that deadlocks after 16-64KB of logs).
    const proc = spawn(String(this.cfg.command), args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this._proc = proc;
    const failPending = (errMsg) => {
      for (const { reject, timer } of this._pending.values()) {
        if (timer) clearTimeout(timer);
        reject(new Error(errMsg));
      }
      this._pending.clear();
    };
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject, timer } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (timer) clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    proc.once("error", (err) => {
      this._proc = null;
      failPending(`upstream MCP server '${this.name}' failed to spawn: ${err.message}`);
    });
    proc.once("exit", (code) => {
      this._proc = null;
      failPending(`upstream MCP server '${this.name}' exited (${code})`);
    });

    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "harness-code-mode", version: "0.1.0" },
    });
    this._notify("notifications/initialized", {});
  }

  _notify(method, params) {
    if (!this._proc || !this._proc.stdin.writable) return;
    try {
      this._proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      // Ignore write to exiting child.
    }
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      if (!this._proc || !this._proc.stdin.writable) {
        reject(new Error(`upstream MCP server '${this.name}' is not connected`));
        return;
      }
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`upstream MCP server '${this.name}' timed out on ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(toolName, args) {
    const res = await this.request("tools/call", { name: toolName, arguments: args || {} });
    return extractMcpResult(res);
  }

  async close() {
    const proc = this._proc;
    this._proc = null;
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.stdin.end();
    } catch {
      // Ignore.
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore.
        }
        resolve();
      }, 500);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

class HttpMcpClient {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this._nextId = 1;
    this._sessionId = null;
  }

  _headers() {
    const h = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(this.cfg.headers || {}),
      ...(this.cfg.http_headers || {}),
    };
    if (this.cfg.bearer_token_env_var && process.env[this.cfg.bearer_token_env_var]) {
      h.Authorization = `Bearer ${process.env[this.cfg.bearer_token_env_var]}`;
    }
    if (this._sessionId) {
      h["Mcp-Session-Id"] = this._sessionId;
    }
    return h;
  }

  async request(method, params) {
    const id = this._nextId++;
    const res = await fetch(String(this.cfg.url), {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this._sessionId = sid;
    if (!res.ok) {
      throw new Error(`HTTP MCP '${this.name}' error ${res.status}: ${await res.text()}`);
    }
    const ctype = res.headers.get("content-type") || "";
    const text = await res.text();
    let payload;
    if (ctype.includes("text/event-stream")) {
      const dataLines = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      payload = JSON.parse(dataLines[dataLines.length - 1] || "{}");
    } else {
      payload = JSON.parse(text || "{}");
    }
    if (payload.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    return payload.result;
  }

  async connect() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "harness-code-mode", version: "0.1.0" },
    });
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(toolName, args) {
    const res = await this.request("tools/call", { name: toolName, arguments: args || {} });
    return extractMcpResult(res);
  }

  async close() {
    // Stateless HTTP; nothing to tear down.
  }
}

export class McpAggregator {
  constructor(serverConfigs = {}) {
    this.serverConfigs = serverConfigs;
    this.clients = new Map();
    this.tools = [];
    this._routes = new Map();
  }

  async connect() {
    const entries = Object.entries(this.serverConfigs);
    try {
      await Promise.all(
        entries.map(async ([name, cfg]) => {
          const client = cfg.url ? new HttpMcpClient(name, cfg) : new StdioMcpClient(name, cfg);
          this.clients.set(name, client);
          await client.connect();
          const list = await client.listTools();
          for (const t of list) {
            const fqName = `mcp__${name}__${t.name}`;
            this.tools.push({
              name: fqName,
              description: String(t.description || ""),
              schema: t.inputSchema || t.schema || {},
            });
            this._routes.set(fqName, { client, toolName: t.name });
          }
        }),
      );
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  has(name) {
    return this._routes.has(name);
  }

  async dispatch(name, args) {
    const route = this._routes.get(name);
    if (!route) throw new Error(`unknown upstream MCP tool: ${name}`);
    return route.client.callTool(route.toolName, args);
  }

  async close() {
    const list = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.all(list.map((c) => c.close()));
  }
}
