/**
 * Meta commands: tool discovery, schema inspection, and raw calls
 *
 * P1-06: each command returns a CommandResult instead of writing
 * directly to stdout/stderr. stdin is read through CommandContext
 * rather than the process stream directly. The public `scoutline.zai.*`
 * tool names are preserved; no Provider selection is introduced.
 */

import * as fs from "node:fs/promises";
import { ZaiMcpClient } from "../lib/mcp-client.js";
import { ZaiCodeModeClient } from "../lib/code-mode.js";
import { ValidationError } from "../lib/errors.js";
import { redactTool } from "../lib/redact.js";
import type { CommandContext, CommandResult } from "../command-invocation.js";

export interface ToolsOptions {
  filter?: string;
  full?: boolean;
  typescript?: boolean;
  enableVision?: boolean;
}

export async function listTools(
  options: ToolsOptions = {},
  context?: CommandContext,
): Promise<CommandResult> {
  if (options.typescript) {
    const codeClient = new ZaiCodeModeClient();
    try {
      const interfaces = await codeClient.getAllInterfaces();
      return { kind: "data", data: interfaces };
    } finally {
      await codeClient.close().catch(() => {});
    }
  }

  const client = new ZaiMcpClient({ enableVision: options.enableVision });
  try {
    const tools = await client.listTools();
    const filtered = options.filter
      ? tools.filter((tool) => tool.name.toLowerCase().includes(options.filter!.toLowerCase()))
      : tools;

    if (options.full) {
      return { kind: "data", data: filtered.map((tool) => redactTool(tool)) };
    }

    return { kind: "data", data: filtered.map((tool) => tool.name) };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function showTool(
  name: string,
  options: ToolsOptions = {},
  context?: CommandContext,
): Promise<CommandResult> {
  const client = new ZaiMcpClient({ enableVision: options.enableVision });
  try {
    const tool = await client.getTool(name);
    if (!tool) {
      throw new ValidationError(`Unknown tool: ${name}`);
    }
    return { kind: "data", data: redactTool(tool) };
  } finally {
    await client.close().catch(() => {});
  }
}

export interface CallToolOptions {
  json?: string;
  file?: string;
  stdin?: boolean;
  dryRun?: boolean;
  enableVision?: boolean;
}

/**
 * Parse tool arguments from one of three sources: --json inline, --file,
 * or stdin (when --stdin or stdin is not a TTY). The caller's
 * CommandContext is required so stdin reads route through the invocation
 * adapter rather than `process.stdin` directly.
 */
async function parseToolArgs(
  options: CallToolOptions,
  context: CommandContext,
): Promise<Record<string, unknown>> {
  if (options.json) {
    const raw = options.json.trim();
    const value = raw.startsWith("@") ? await fs.readFile(raw.slice(1), "utf8") : raw;
    return JSON.parse(value);
  }

  if (options.file) {
    const value = await fs.readFile(options.file, "utf8");
    return JSON.parse(value);
  }

  if (options.stdin || !context.stdinIsTTY) {
    const value = await context.readStdin();
    if (value.trim().length === 0) {
      return {};
    }
    return JSON.parse(value);
  }

  return {};
}

export async function callTool(
  toolName: string,
  options: CallToolOptions = {},
  context?: CommandContext,
): Promise<CommandResult> {
  if (!context) {
    throw new Error("callTool requires a CommandContext (for stdin access)");
  }

  let args: Record<string, unknown>;
  try {
    args = await parseToolArgs(options, context);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ValidationError(`Invalid JSON: ${error.message}`);
    }
    throw error;
  }

  const client = new ZaiMcpClient({ enableVision: options.enableVision });
  try {
    const resolved = await client.resolveToolName(toolName);

    if (options.dryRun) {
      return { kind: "data", data: { tool: resolved, args } };
    }

    const result = await client.callToolRaw(resolved, args);
    return { kind: "data", data: result };
  } finally {
    await client.close().catch(() => {});
  }
}

// Help text
export const TOOLS_HELP = `
Tools - Discover MCP tools and schemas

Usage:
  scoutline tools [options]
  scoutline tool <name>

Options:
  --filter <text>   Filter tools by name
  --full            Return full tool schemas
  --typescript      Output TypeScript interfaces (Code Mode)
  --no-vision       Skip vision MCP server (faster startup)

Examples:
  scoutline tools
  scoutline tools --filter vision
  scoutline tools --full
  scoutline tools --typescript
  scoutline tool scoutline.zai.vision.analyze_image
`.trim();

export const CALL_HELP = `
Call - Invoke a tool by name with JSON arguments

Usage: scoutline call <tool> [options]

Options:
  --json <json>     Inline JSON args (prefix with @file to load)
  --file <path>     Read JSON args from file
  --stdin           Read JSON args from stdin
  --dry-run         Print resolved tool name + args without calling
  --no-vision       Skip vision MCP server (faster startup)

Examples:
  scoutline call scoutline.zai.search.webSearchPrime --json '{"search_query":"LLM tools"}'
  scoutline call scoutline.zai.reader.webReader --file ./args.json
  echo '{"repo_name":"owner/repo"}' | scoutline call scoutline.zai.zread.get_repo_structure --stdin
`.trim();
