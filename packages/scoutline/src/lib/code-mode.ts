/**
 * Code Mode client for tool chaining with UTCP
 */

import { CodeModeUtcpClient } from "@utcp/code-mode";
import "@utcp/mcp";
import { buildMcpCallTemplate } from "./mcp-config.js";
import { getApiKey, getMcpEndpoints } from "./config.js";
import { ApiError, AuthError, ConfigurationError, NetworkError, TimeoutError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = parseInt(process.env.Z_AI_TIMEOUT || "30000", 10);

/**
 * #135 — upper bound for the failure-path auth probe (mirrors the #117
 * constant in mcp-client.ts). The probe runs only after initialization
 * already failed, so it must not add the full request timeout to that
 * failure; auth rejections answer fast, and a slow/unreachable probe
 * endpoint is simply inconclusive (null → today's error shape).
 */
const PROBE_TIMEOUT_MS = 5_000;
/**
 * #135 — provenance sentinel stamped on the ApiError constructed when
 * registerManual reports failure (`result.success === false`), mirroring
 * the #128 gate in mcp-client.ts. The failure-path auth probe is allowed
 * to classify ONLY this error class; factory/transport-thrown ApiErrors
 * stay untagged so they fail fast with the original error and zero
 * probe network requests.
 */
const REGISTRATION_FAILURE = Symbol("zaiCodeModeRegistrationFailure");

/** Build the registerManual-failure ApiError carrying the probe sentinel. */
function newRegistrationFailureError(): ApiError {
  const error = new ApiError("Code Mode tool registration failed", 500);
  Object.defineProperty(error, REGISTRATION_FAILURE, { value: true });
  return error;
}

/** True only for errors built by {@link newRegistrationFailureError}. */
function isRegistrationFailureError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<symbol, unknown>)[REGISTRATION_FAILURE] === true
  );
}

/**
 * Constructor options for {@link ZaiCodeModeClient}.
 *
 * `clientFactory` is a behaviour-preserving injection seam: when omitted
 * the production path uses `CodeModeUtcpClient.create()`. Tests inject a
 * fake to drive the error path without spinning up a real UTCP client.
 */
export interface ZaiCodeModeClientOptions {
  clientFactory?: () => Promise<CodeModeUtcpClient>;
  /**
   * T2b — Credential view: resolved env (injected env + file keys).
   * When omitted, ambient `process.env` is used so existing direct
   * constructors keep working. When supplied, the registration
   * template authorises with the resolved credential rather than
   * ambient state.
   */
  env?: NodeJS.ProcessEnv;
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
      // T2b: thread the captured env so the registration template
      // authorises with the resolved credential.
      const result = await this.client.registerManual(
        buildMcpCallTemplate({ env: this.options.env }),
      );
      if (!result.success) {
        // Registration errors may carry raw Provider response bodies.
        // Never copy them into either the public error or process stderr.
        // #135: the sentinel tag marks this as the ONLY error class the
        // failure-path auth probe may classify (see _doInit's catch).
        throw newRegistrationFailureError();
      }
      this.isInitialized = true;
    } catch (error) {
      this.initPromise = null;

      if (error instanceof ApiError) {
        // #135 — the registerManual failure arrives here as an opaque
        // ApiError whose message no longer carries the Provider's body —
        // frequently a 200-wrapped auth rejection ({"code":401,...})
        // whose VALUES zod dropped (only keys survive), so no
        // message-based classifier can ever see it. One cheap
        // authenticated probe against the endpoint the registration
        // template was going to use recovers the real status. Runs ONLY
        // on this already-failed path — success never pays for it — and
        // its own failure must never mask the original error.
        // #128-parity provenance gate: ONLY the registerManual-failure
        // class (sentinel-tagged) may probe; a factory/transport-thrown
        // ApiError keeps its own status and fails fast with zero probe
        // network requests, because a 401/403 probe answer would say
        // nothing about that failure's cause.
        const probedStatus = isRegistrationFailureError(error)
          ? await this.probeAuthStatusOnFailure()
          : null;
        if (probedStatus !== null) {
          // NFR-006: the probe body was read for classification only; the
          // public message is static credential guidance, never body text.
          throw new AuthError(
            "Z.AI Code Mode authentication failed: token expired or incorrect — check Z_AI_API_KEY, the configured API key, or GLM Coding Plan status",
            "Z_AI_API_KEY",
          );
        }
        // A factory may reject with a typed ApiError whose message embeds a
        // raw Provider body. Preserve only the status used for retry
        // classification and replace the message at this outward boundary.
        throw new ApiError("Code Mode initialization failed", error.statusCode ?? 500);
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

  /**
   * #135 — classify the real HTTP status behind an initialization failure
   * with ONE cheap authenticated `initialize` against the MCP endpoint the
   * registration template was going to use (the same request and Bearer
   * credential the template carries). Mirrors ZaiMcpClient's #117 probe.
   *
   * Z.AI rejects bad credentials as a JSON body (`{"code":401,...}`)
   * inside HTTP 200, and UTCP's registration error collection drops the
   * body's values, so the status must be re-read here. Classification
   * reads the HTTP status and the body's numeric `code` field ONLY — no
   * byte of the body ever reaches the public error message (NFR-006).
   *
   * Returns 401/403 when the failure is an auth rejection, `null` when
   * the probe is inconclusive (any other status, unreachable endpoint,
   * unparsable body, missing credential) so the caller keeps today's
   * error shape. Runs exclusively on the already-failed init path.
   */
  private async probeAuthStatusOnFailure(): Promise<number | null> {
    try {
      const env = this.options.env ?? process.env;
      const apiKey = getApiKey(env);
      const response = await fetch(getMcpEndpoints().WEB_SEARCH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "scoutline-auth-probe",
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "scoutline-auth-probe", version: "0.0.0" },
          },
        }),
        // The probe must never delay an already-failing command by the
        // full request timeout — auth rejections answer fast, so a short
        // bound keeps classification quality while capping the added
        // latency on inconclusive probes.
        signal: AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)),
      });
      // undici retains the connection until the body is consumed or
      // cancelled — release it on every exit that does not read the body.
      const releaseBody = async () => {
        await response.body?.cancel().catch(() => {});
      };
      if (response.status === 401 || response.status === 403) {
        await releaseBody();
        return response.status;
      }
      if (response.status === 200) {
        // Z.AI wraps auth rejections in HTTP 200 (issue #117): classify
        // from the body's numeric `code` only — never its message text.
        const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
        if (typeof body?.code === "number" && (body.code === 401 || body.code === 403)) {
          return body.code;
        }
        return null;
      }
      await releaseBody();
      return null;
    } catch {
      // Best-effort diagnostics on an already-failing path: a failed probe
      // must never mask the original initialization error.
      return null;
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
      // 5.2: capture the timeout timer so it is cleared after the race
      // completes. NO unref(): an unref'd fallback timer lets the event
      // loop drain in a quiet process while close() is still awaited —
      // the await never resolves and the runner dies with "Promise
      // resolution is still pending but the event loop has already
      // resolved" (GitHub Actions 2-core runners, 2026-09-10; reproduced
      // in a bare script: await close(100) with a hanging client never
      // returns). The timer is bounded by timeoutMs and cleared in the
      // finally block the moment either race arm settles, so the worst
      // case loop-hold equals the timeout.
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timer = setTimeout(() => resolve(), timeoutMs);
      });
      try {
        await Promise.race([this.client.close().catch(() => undefined), timeoutPromise]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      this.client = null;
      this.isInitialized = false;
      this.initPromise = null;
    }
  }
}
