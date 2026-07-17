/**
 * Code Mode client for tool chaining with UTCP
 */

import { CodeModeUtcpClient } from "@utcp/code-mode";
import "@utcp/mcp";
import { buildMcpCallTemplate } from "./mcp-config.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  TimeoutError,
} from "./errors.js";

const DEFAULT_TIMEOUT_MS = parseInt(process.env.Z_AI_TIMEOUT || "30000", 10);

/**
 * Constructor options for {@link ZaiCodeModeClient}.
 *
 * `clientFactory` is a behaviour-preserving injection seam: when omitted
 * the production path uses `CodeModeUtcpClient.create()`. Tests inject a
 * fake to drive the error path without spinning up a real UTCP client.
 */
export interface ZaiCodeModeClientOptions {
  clientFactory?: () => Promise<CodeModeUtcpClient>;
}

export class ZaiCodeModeClient {
  private client: CodeModeUtcpClient | null = null;
  private initPromise: Promise<void> | null = null;
  private isInitialized = false;
  private options: ZaiCodeModeClientOptions;

  constructor(options: ZaiCodeModeClientOptions = {}) {
    this.options = options;
  }

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
      const factory = this.options.clientFactory || (() => CodeModeUtcpClient.create());
      this.client = await factory();
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

      // NFR-001 + Fixup C — B8: a missing or invalid credential surfaces
      // as ConfigurationError (exit 3). The handler MUST fail fast before
      // making any real network call. Propagating the typed
      // ConfigurationError directly also keeps the public envelope's
      // `code` field correct.
      if (error instanceof ConfigurationError) {
        throw error;
      }

      if (error instanceof Error) {
        if (
          error.message.includes("401") ||
          error.message.includes("403") ||
          error.message.includes("auth")
        ) {
          // NFR-006: do not embed the underlying message — it may carry a
          // raw Provider response body. The stable code is the classifier.
          throw new AuthError("Authentication failed");
        }
        if (error.message.includes("timeout") || error.message.includes("ETIMEDOUT")) {
          throw new TimeoutError(DEFAULT_TIMEOUT_MS);
        }
        if (
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("network") ||
          error.message.includes("fetch")
        ) {
          throw new NetworkError("Code Mode network error");
        }
      }

      throw new ApiError("Code Mode initialization failed", 500);
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
