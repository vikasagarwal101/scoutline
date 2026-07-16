/**
 * Code Mode client for tool chaining with UTCP
 */

import { CodeModeUtcpClient } from "@utcp/code-mode";
import "@utcp/mcp";
import { buildMcpCallTemplate } from "./mcp-config.js";
import { ApiError, AuthError, NetworkError, TimeoutError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = parseInt(process.env.Z_AI_TIMEOUT || "30000", 10);

export class ZaiCodeModeClient {
  private client: CodeModeUtcpClient | null = null;
  private initPromise: Promise<void> | null = null;
  private isInitialized = false;

  static getPromptTemplate(): string {
    return CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE;
  }

  private async init(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    try {
      this.client = await CodeModeUtcpClient.create();
      const result = await this.client.registerManual(buildMcpCallTemplate());
      if (!result.success) {
        throw new ApiError(`Failed to register MCP servers: ${result.errors.join(", ")}`, 500);
      }
      this.isInitialized = true;
    } catch (error) {
      this.initPromise = null;

      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof Error) {
        if (
          error.message.includes("401") ||
          error.message.includes("403") ||
          error.message.includes("auth")
        ) {
          throw new AuthError(`Authentication failed: ${error.message}`);
        }
        if (error.message.includes("timeout") || error.message.includes("ETIMEDOUT")) {
          throw new TimeoutError(DEFAULT_TIMEOUT_MS);
        }
        if (
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("network") ||
          error.message.includes("fetch")
        ) {
          throw new NetworkError(error.message);
        }
      }

      throw new ApiError(
        `Code Mode initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        500,
      );
    }
  }

  async callToolChain(
    code: string,
    timeoutMs?: number,
  ): Promise<{ result: unknown; logs: string[] }> {
    await this.init();
    if (!this.client) {
      throw new ApiError("Code Mode client not initialized", 500);
    }
    const timeout = timeoutMs ?? 30000;
    return this.client.callToolChain(code, timeout);
  }

  async getAllInterfaces(): Promise<string> {
    await this.init();
    if (!this.client) {
      throw new ApiError("Code Mode client not initialized", 500);
    }
    return this.client.getAllToolsTypeScriptInterfaces();
  }

  async close(timeoutMs: number = 2000): Promise<void> {
    if (this.client) {
      await Promise.race([
        this.client.close(),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      this.client = null;
      this.isInitialized = false;
      this.initPromise = null;
    }
  }
}
