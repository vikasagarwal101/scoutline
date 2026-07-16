/**
 * Shared MCP configuration for Z.AI services
 */

import { loadConfig, getApiKey, getMcpEndpoints } from "./config.js";

export const MCP_MANUAL_NAME = "scoutline.zai";
export const MCP_SERVERS = {
  vision: "vision",
  search: "search",
  reader: "reader",
  zread: "zread",
} as const;

export type McpServerName = keyof typeof MCP_SERVERS;

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseArgs(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // Fall through to space-split
    }
  }
  return trimmed.split(/\s+/);
}

function toEnvString(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return String(value);
}

export interface McpTemplateOptions {
  enableVision?: boolean;
}

export function buildMcpCallTemplate(options: McpTemplateOptions = {}) {
  const config = loadConfig();
  const apiKey = getApiKey();
  const endpoints = getMcpEndpoints();

  const timeoutSeconds = Math.max(1, Math.ceil(config.timeout / 1000));
  const sseReadTimeoutSeconds = Math.max(1, Math.ceil(config.timeout / 1000));

  const visionCommand = process.env.Z_AI_VISION_MCP_COMMAND || "npx";
  const visionArgs = parseArgs(process.env.Z_AI_VISION_MCP_ARGS, ["-y", "@z_ai/mcp-server@latest"]);
  const visionCwd = process.env.Z_AI_VISION_MCP_CWD || process.cwd();

  const mode = config.mode;
  const baseUrl = ensureTrailingSlash(config.baseUrl);

  const visionEnv: Record<string, string> = {
    Z_AI_API_KEY: apiKey,
    Z_AI_BASE_URL: baseUrl,
    Z_AI_MODE: mode,
    PLATFORM_MODE: mode,
  };

  const envEntries: Array<[string, string | undefined]> = [
    ["Z_AI_VISION_MODEL", toEnvString(config.visionModel)],
    ["Z_AI_VISION_MODEL_TEMPERATURE", toEnvString(config.temperature)],
    ["Z_AI_VISION_MODEL_TOP_P", toEnvString(config.topP)],
    ["Z_AI_VISION_MODEL_MAX_TOKENS", toEnvString(config.maxTokens)],
    ["Z_AI_TIMEOUT", toEnvString(config.timeout)],
    ["Z_AI_RETRY_COUNT", toEnvString(process.env.Z_AI_RETRY_COUNT)],
  ];

  for (const [key, value] of envEntries) {
    if (value !== undefined) {
      visionEnv[key] = value;
    }
  }

  const envVision = !["0", "false"].includes((process.env.Z_AI_VISION_MCP || "").toLowerCase());
  const enableVision = options.enableVision ?? envVision;

  const mcpServers: Record<string, unknown> = {
    search: {
      transport: "http",
      url: endpoints.WEB_SEARCH,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      timeout: timeoutSeconds,
      sse_read_timeout: sseReadTimeoutSeconds,
      terminate_on_close: true,
    },
    reader: {
      transport: "http",
      url: endpoints.WEB_READER,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      timeout: timeoutSeconds,
      sse_read_timeout: sseReadTimeoutSeconds,
      terminate_on_close: true,
    },
    zread: {
      transport: "http",
      url: endpoints.ZREAD,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      timeout: timeoutSeconds,
      sse_read_timeout: sseReadTimeoutSeconds,
      terminate_on_close: true,
    },
  };

  if (enableVision) {
    mcpServers.vision = {
      transport: "stdio",
      command: visionCommand,
      args: visionArgs,
      cwd: visionCwd,
      env: visionEnv,
      timeout: timeoutSeconds,
    };
  }

  return {
    name: MCP_MANUAL_NAME,
    call_template_type: "mcp",
    config: { mcpServers },
    register_resources_as_tools: false,
  };
}

export function getMcpToolName(server: McpServerName, tool: string): string {
  return `${MCP_MANUAL_NAME}.${MCP_SERVERS[server]}.${tool}`;
}
