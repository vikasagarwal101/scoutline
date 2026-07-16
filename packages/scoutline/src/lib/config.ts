/**
 * Configuration and environment loading for Scoutline
 */

export interface ZaiConfig {
  apiKey: string;
  mode: "ZAI" | "ZHIPU";
  baseUrl: string;
  timeout: number;
  visionModel: string;
  temperature: number;
  topP: number;
  maxTokens: number;
}

const BASE_URLS = {
  // Z.AI Coding Plan requires the /coding/ endpoint
  ZAI: "https://api.z.ai/api/coding/paas/v4",
  ZHIPU: "https://open.bigmodel.cn/api/paas/v4",
} as const;

// MCP server endpoints
const MCP_ENDPOINTS = {
  ZREAD: "https://api.z.ai/api/mcp/zread/mcp",
  WEB_SEARCH: "https://api.z.ai/api/mcp/web_search_prime/mcp",
  WEB_READER: "https://api.z.ai/api/mcp/web_reader/mcp",
} as const;

export function loadConfig(): ZaiConfig {
  const apiKey = process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY;

  if (!apiKey) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: "Z_AI_API_KEY environment variable is required",
          help: [
            "To set it:",
            '  export Z_AI_API_KEY="your-api-key"',
            "",
            "Get your API key at:",
            "  https://z.ai/manage-apikey/apikey-list",
          ].join("\n"),
        },
        null,
        2,
      ),
    );
    process.exit(3);
  }

  const mode = (process.env.Z_AI_MODE || process.env.PLATFORM_MODE || "ZAI").toUpperCase() as
    | "ZAI"
    | "ZHIPU";
  const baseUrl = process.env.Z_AI_BASE_URL || BASE_URLS[mode] || BASE_URLS.ZAI;

  return {
    apiKey,
    mode,
    baseUrl,
    timeout: parseInt(process.env.Z_AI_TIMEOUT || "30000", 10),
    visionModel: process.env.Z_AI_VISION_MODEL || "glm-4.6v",
    temperature: parseFloat(process.env.Z_AI_TEMPERATURE || "0.8"),
    topP: parseFloat(process.env.Z_AI_TOP_P || "0.6"),
    maxTokens: parseInt(process.env.Z_AI_MAX_TOKENS || "32768", 10),
  };
}

export function getMcpEndpoints() {
  return MCP_ENDPOINTS;
}

export function getApiKey(): string {
  const apiKey = process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY;
  if (!apiKey) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: "Z_AI_API_KEY environment variable is required",
          help: 'export Z_AI_API_KEY="your-api-key"',
        },
        null,
        2,
      ),
    );
    process.exit(3);
  }
  return apiKey;
}
