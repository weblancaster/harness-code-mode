#!/usr/bin/env node
/**
 * Universal stdio MCP CLI (`codemode-mcp`) for Codex, Claude Code, Cursor, OpenCode, etc.
 */

import path from "node:path";
import { CodemodeManager, assertSupportedNode } from "../../core/session.js";
import { createLocalTools } from "../../core/local-tools.js";
import { McpAggregator, expandHome, loadUpstreamConfig } from "../../core/mcp-client.js";
import { McpServer } from "./server.js";

function parseArgs(argv) {
  const opts = {
    configPath: null,
    codexConfigPath: null,
    includeDisabled: false,
    allowLocalTools: false,
    workspace: null,
    timeoutSec: 60,
    memoryMb: 256,
    maxToolCalls: 200,
    maxConcurrency: 8,
    maxResultChars: 50000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" && argv[i + 1]) opts.configPath = expandHome(argv[++i]);
    else if (a === "--from-codex" && argv[i + 1]) opts.codexConfigPath = expandHome(argv[++i]);
    else if (a === "--include-disabled") opts.includeDisabled = true;
    else if (a === "--allow-local-tools") opts.allowLocalTools = true;
    else if (a === "--workspace" && argv[i + 1]) opts.workspace = path.resolve(expandHome(argv[++i]));
    else if (a === "--timeout" && argv[i + 1]) opts.timeoutSec = Number(argv[++i]);
    else if (a === "--memory-mb" && argv[i + 1]) opts.memoryMb = Number(argv[++i]);
    else if (a === "--max-calls" && argv[i + 1]) opts.maxToolCalls = Number(argv[++i]);
    else if (a === "--max-concurrency" && argv[i + 1]) opts.maxConcurrency = Number(argv[++i]);
    else if (a === "--max-result-chars" && argv[i + 1]) opts.maxResultChars = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      process.stderr.write(
        "Usage: codemode-mcp [--config mcp.json] [--from-codex ~/.codex/config.toml [--include-disabled]] " +
          "[--allow-local-tools --workspace dir] [--timeout 60] [--memory-mb 256] [--max-calls 200] [--max-concurrency 8]\n",
      );
      process.exit(0);
    }
  }
  if (opts.allowLocalTools && !opts.workspace) {
    throw new Error("--allow-local-tools requires an explicit --workspace <dir>");
  }
  return opts;
}

async function main() {
  assertSupportedNode();
  const opts = parseArgs(process.argv.slice(2));

  const serverConfigs = loadUpstreamConfig({
    configPath: opts.configPath,
    codexConfigPath: opts.codexConfigPath,
    includeDisabled: opts.includeDisabled,
  });
  const aggregator = new McpAggregator(serverConfigs);
  await aggregator.connect();

  const local = opts.allowLocalTools ? createLocalTools(opts.workspace) : null;
  const tools = [...aggregator.tools, ...(local ? local.tools : [])];
  const helperBindings = local ? local.helperBindings : {};

  const dispatch = async (name, args) => {
    if (aggregator.has(name)) return aggregator.dispatch(name, args);
    if (local) return local.dispatch(name, args);
    throw new Error(`unknown tool: ${name}`);
  };

  const manager = new CodemodeManager({
    timeoutSec: opts.timeoutSec,
    memoryMb: opts.memoryMb,
    maxToolCalls: opts.maxToolCalls,
    maxConcurrency: opts.maxConcurrency,
    maxResultChars: opts.maxResultChars,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.allSettled([manager.closeAll(), aggregator.close()]);
  };

  process.once("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });

  const server = new McpServer({
    manager,
    tools,
    helperBindings,
    dispatch,
    hasLocalTools: Boolean(local),
    upstreamCount: aggregator.tools.length,
    onClose: () => shutdown().finally(() => process.exit(0)),
  });
  server.start();
}

main().catch((err) => {
  process.stderr.write(`[codemode-mcp] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
