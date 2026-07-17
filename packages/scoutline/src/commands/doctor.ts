/**
 * Doctor command for environment and MCP diagnostics.
 *
 * P1-09: returns a `CommandResult` instead of writing to stdout/stderr and
 * terminating. Dependency-log suppression is owned by the invocation seam's
 * `runQuietly` (via `invokeCommand`); this handler no longer silences or
 * restores the console itself. Errors propagate to `invokeCommand`, which
 * converts them into one structured stderr value.
 */

import { ZaiMcpClient } from "../lib/mcp-client.js";
import type { CommandContext, CommandResult } from "../command-invocation.js";

export interface DoctorOptions {
  noTools?: boolean;
  enableVision?: boolean;
}

/**
 * Behaviour-preserving optional dependencies for testing the doctor command.
 * Omitted dependencies use the current {@link ZaiMcpClient} constructor.
 */
export interface DoctorDependencies {
  clientFactory?: (options: {
    enableVision?: boolean;
  }) => Pick<ZaiMcpClient, "listTools" | "close">;
}

function getNodeMajor(): number {
  const [major] = process.versions.node.split(".");
  return parseInt(major, 10);
}

export async function doctor(
  options: DoctorOptions = {},
  deps: DoctorDependencies = {},
  _context?: CommandContext,
): Promise<CommandResult> {
  const apiKey = process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY;
  const mode = (process.env.Z_AI_MODE || process.env.PLATFORM_MODE || "ZAI").toUpperCase();
  const nodeMajor = getNodeMajor();

  const report: Record<string, unknown> = {
    env: {
      apiKeyPresent: Boolean(apiKey),
      mode,
      baseUrl: process.env.Z_AI_BASE_URL || undefined,
    },
    node: {
      version: process.versions.node,
      visionMcpCompatible: nodeMajor >= 22,
    },
  };

  // Env-only path: skip tool discovery when requested or when no credential
  // is present (no transport is constructed).
  if (options.noTools || !apiKey) {
    return { kind: "data", data: report };
  }

  const clientFactory =
    deps.clientFactory || ((opts) => new ZaiMcpClient({ enableVision: opts.enableVision }));
  const client = clientFactory({ enableVision: options.enableVision });
  try {
    const tools = await client.listTools();
    const byServer = tools.reduce<Record<string, number>>((acc, tool) => {
      const parts = tool.name.split(".");
      const server = parts.length >= 2 ? parts[1] : "unknown";
      acc[server] = (acc[server] || 0) + 1;
      return acc;
    }, {});

    report.mcp = {
      toolCount: tools.length,
      servers: byServer,
    };

    return { kind: "data", data: report };
  } finally {
    await client.close().catch(() => {});
  }
}

export const DOCTOR_HELP = `
Doctor - Check environment and MCP connectivity

Usage: scoutline doctor [options]

Options:
  --no-tools   Skip tool discovery (env-only check)
  --no-vision  Skip vision MCP server (faster startup)

Examples:
  scoutline doctor
  scoutline doctor --no-tools
`.trim();
