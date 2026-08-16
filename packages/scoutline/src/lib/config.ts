/**
 * Configuration and environment loading for Scoutline
 */

import { ConfigurationError } from "./errors.js";

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

const MISSING_KEY_HELP = [
  "To set it:",
  '  export Z_AI_API_KEY="your-api-key"',
  "",
  "Get your API key at:",
  "  https://z.ai/manage-apikey/apikey-list",
].join("\n");

//
// T2a — Credential view: `loadConfig` and `getApiKey` accept an explicit
// `env` parameter (defaulting to `process.env`) so the resolved
// environment built in `main` — which merges file-configured keys on top
// of the injected `MainDependencies.env` — reaches every Z.AI credential
// reader. The signature is additive: existing no-argument callers keep
// working unchanged against ambient `process.env`.
//

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ZaiConfig {
  const apiKey = env.Z_AI_API_KEY || env.ZAI_API_KEY;

  if (!apiKey) {
    // P1-09: throw a normalized ConfigurationError (exit 3) instead of
    // terminating the process. Callers route through invokeCommand, which
    // converts the thrown error into one structured stderr value. No
    // transport is constructed and no process streams are touched here.
    throw new ConfigurationError("Z_AI_API_KEY environment variable is required", MISSING_KEY_HELP);
  }

  const mode = (env.Z_AI_MODE || env.PLATFORM_MODE || "ZAI").toUpperCase() as "ZAI" | "ZHIPU";
  const baseUrl = env.Z_AI_BASE_URL || BASE_URLS[mode] || BASE_URLS.ZAI;

  return {
    apiKey,
    mode,
    baseUrl,
    timeout: parseInt(env.Z_AI_TIMEOUT || "30000", 10),
    visionModel: env.Z_AI_VISION_MODEL || "glm-5v-turbo",
    temperature: parseFloat(env.Z_AI_TEMPERATURE || "0.8"),
    topP: parseFloat(env.Z_AI_TOP_P || "0.6"),
    maxTokens: parseInt(env.Z_AI_MAX_TOKENS || "32768", 10),
  };
}

export function getMcpEndpoints() {
  return MCP_ENDPOINTS;
}

export function getApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.Z_AI_API_KEY || env.ZAI_API_KEY;
  if (!apiKey) {
    // P1-09: throw instead of process.exit(3); see loadConfig for rationale.
    throw new ConfigurationError(
      "Z_AI_API_KEY environment variable is required",
      'export Z_AI_API_KEY="your-api-key"',
    );
  }
  return apiKey;
}
