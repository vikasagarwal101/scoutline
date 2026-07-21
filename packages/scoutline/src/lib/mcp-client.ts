/**
 * MCP (Model Context Protocol) client for Z.AI services using UTCP
 *
 * Supports four MCP servers:
 * - Vision: Image and video analysis (stdio)
 * - ZRead: GitHub repository exploration
 * - Web Search: Real-time web search
 * - Web Reader: Web page content extraction
 */

import { UtcpClient, type Tool } from "@utcp/sdk";
import "@utcp/mcp";
import {
  buildMcpCallTemplate,
  getMcpToolName,
  projectInternalToolName,
  MCP_MANUAL_NAME,
} from "./mcp-config.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  TimeoutError,
  ValidationError,
} from "./errors.js";
import { loadConfig, getMcpEndpoints } from "./config.js";
import { buildCacheKey, readCache, writeCache } from "./cache.js";
import { readToolCache, writeToolCache, type ToolCacheConfig } from "./tool-cache.js";
import { redactSecrets, configuredSecrets } from "./redact.js";
import type { ReaderRawResponse } from "../capabilities/reader.js";

const DEFAULT_TIMEOUT_MS = parseInt(process.env.Z_AI_TIMEOUT || "30000", 10);
const DEFAULT_RETRY_BASE_MS = parseInt(process.env.ZAI_MCP_RETRY_BASE_MS || "500", 10);
const DEFAULT_RETRY_MAX_MS = parseInt(process.env.ZAI_MCP_RETRY_MAX_MS || "8000", 10);
const DEFAULT_RETRY_JITTER_MS = parseInt(process.env.ZAI_MCP_RETRY_JITTER_MS || "250", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ZRead response types
export interface ZReadSearchResult {
  title: string;
  content: string;
  url?: string;
  type?: string;
}

// Web Search response types
export interface WebSearchResult {
  refer: string;
  title: string;
  link: string;
  media: string;
  content: string;
  icon: string;
  publish_date?: string;
}

/**
 * Constructor options for {@link ZaiMcpClient}.
 *
 * `utcpFactory` is a behaviour-preserving injection seam: when omitted the
 * production path uses `UtcpClient.create()`. Tests inject a fake to avoid
 * touching process globals.
 *
 * `disableRetry` (P2-03) lets the Z.AI Search Adapter hand retry policy
 * to shared execution. When omitted, the client retains its existing
 * direct-client retry behaviour.
 */
export interface ZaiMcpClientOptions {
  enableVision?: boolean;
  noCache?: boolean;
  disableRetry?: boolean;
  utcpFactory?: () => Promise<UtcpClient>;
}

/**
 * Unified MCP client for all Z.AI MCP services
 */
export class ZaiMcpClient {
  private client: UtcpClient | null = null;
  private initPromise: Promise<void> | null = null;
  private isInitialized = false;
  private options: ZaiMcpClientOptions;

  constructor(options: ZaiMcpClientOptions = {}) {
    this.options = options;
  }

  /**
   * Initialize the UTCP client and register all MCP servers
   */
  private async init(): Promise<void> {
    if (this.isInitialized) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    try {
      const factory = this.options.utcpFactory || (() => UtcpClient.create());
      this.client = await factory();
      const result = await this.client.registerManual(buildMcpCallTemplate(this.options));

      if (!result.success) {
        // Registration errors may carry raw Provider response bodies.
        // Never copy them into either the public error or process stderr.
        throw new ApiError("MCP tool registration failed", 500);
      }

      this.isInitialized = true;
    } catch (error) {
      this.initPromise = null;

      if (error instanceof ApiError) {
        // A factory may reject with a typed ApiError whose message embeds a
        // raw Provider body. Preserve only the status used for retry
        // classification and replace the message at this outward boundary.
        throw new ApiError("MCP initialization failed", error.statusCode ?? 500);
      }

      // NFR-001 + Fixup C — B8: a missing or invalid credential surfaces
      // as ConfigurationError (exit 3). The dispatched handler must fail
      // fast, BEFORE making any real network call. Propagating the typed
      // ConfigurationError directly also keeps the public envelope's
      // `code` field correct — wrapping it as ApiError would lie about
      // the failure class.
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
          throw new NetworkError("MCP network error");
        }
      }

      throw new ApiError("MCP initialization failed", 500);
    }
  }

  /**
   * Call an MCP tool
   */
  private async callTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    // Cache check (unless caller disabled it for this client instance).
    // Vision tool calls are never cached — they're expensive, rarely repeated,
    // and accept arbitrary image inputs.
    const cacheable = !this.options.noCache && !toolName.includes(".vision.");
    if (cacheable) {
      const key = buildCacheKey(toolName, args);
      const hit = await readCache<T>(key);
      if (hit !== null) return hit;
      try {
        const result = await this.callToolUncached<T>(toolName, args);
        // F2 (code-review-baseline): scrub the response before it is
        // persisted to the response cache AND before it is returned, so
        // credential-shaped fields never reach the on-disk cache
        // (cleartext-at-rest leak) and never propagate past the client
        // boundary. Mirrors `writeToolCache`'s `redactTool` scrub. A
        // no-op for normalised Capability data (no credential fields).
        const safe = redactSecrets(result, configuredSecrets()) as T;
        await writeCache(key, safe);
        return safe;
      } catch (err) {
        throw err;
      }
    }
    return this.callToolUncached<T>(toolName, args);
  }

  private async callToolUncached<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    const maxRetries = this.options.disableRetry ? 0 : this.getRetryCount(toolName);
    let attempt = 0;

    while (true) {
      await this.init();

      if (!this.client) {
        throw new ApiError("MCP client not initialized", 500);
      }

      try {
        const result = await this.client.callTool(toolName, args);

        // The result might be a string or already parsed object
        if (typeof result === "string") {
          try {
            return JSON.parse(result) as T;
          } catch {
            return result as unknown as T;
          }
        }

        return result as T;
      } catch (error) {
        attempt += 1;

        if (attempt <= maxRetries && this.isRetriableError(error)) {
          await this.close().catch(() => {});
          const backoff = Math.min(
            DEFAULT_RETRY_MAX_MS,
            DEFAULT_RETRY_BASE_MS * Math.pow(2, attempt - 1),
          );
          const jitter = Math.floor(Math.random() * DEFAULT_RETRY_JITTER_MS);
          await sleep(backoff + jitter);
          continue;
        }

        if (error instanceof Error) {
          if (error.message.includes("401") || error.message.includes("403")) {
            // NFR-006: the underlying message may carry a raw Provider
            // response body; surface only the stable code for classification.
            throw new AuthError("Authentication failed");
          }
          if (error.message.includes("timeout") || error.message.includes("ETIMEDOUT")) {
            throw new TimeoutError(DEFAULT_TIMEOUT_MS);
          }
          if (error.message.includes("ECONNREFUSED") || error.message.includes("network")) {
            throw new NetworkError("MCP network error");
          }
          if (error.message.includes("-500") || error.message.includes("Unexpected system error")) {
            // B6b: an unexpected-system failure is a 500-equivalent and
            // MUST be retryable. Emit statusCode 500 (never a negative
            // code the execution layer can't match) with a clean message.
            throw new ApiError("MCP unexpected system error", 500);
          }
        }

        throw new ApiError("MCP tool call failed", 500);
      }
    }
  }

  private getRetryCount(toolName: string): number {
    const globalRetries = parseInt(process.env.ZAI_MCP_RETRY_COUNT || "1", 10);
    if (toolName.includes(".vision.")) {
      const visionRetriesRaw =
        process.env.ZAI_MCP_VISION_RETRY_COUNT || process.env.Z_AI_RETRY_COUNT;
      if (visionRetriesRaw !== undefined) {
        const parsed = parseInt(visionRetriesRaw, 10);
        return Number.isFinite(parsed) ? parsed : 0;
      }
      return 2;
    }
    return Number.isFinite(globalRetries) ? globalRetries : 0;
  }

  private isRetriableError(error: unknown): boolean {
    if (error instanceof AuthError || error instanceof ValidationError) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    if (normalized.includes("401") || normalized.includes("403") || normalized.includes("auth")) {
      return false;
    }

    return (
      normalized.includes("timeout") ||
      normalized.includes("timed out") ||
      normalized.includes("etimedout") ||
      normalized.includes("econnrefused") ||
      normalized.includes("econnreset") ||
      normalized.includes("network") ||
      normalized.includes("fetch") ||
      normalized.includes("internal network failure") ||
      normalized.includes("unexpected system error") ||
      normalized.includes("http 500") ||
      normalized.includes("http 502") ||
      normalized.includes("http 503") ||
      normalized.includes("http 504") ||
      normalized.includes("rate limit") ||
      normalized.includes("429") ||
      normalized.includes("-500")
    );
  }

  private resolveEnableVision(): boolean {
    const envVision = !["0", "false"].includes((process.env.Z_AI_VISION_MCP || "").toLowerCase());
    return this.options.enableVision ?? envVision;
  }

  /**
   * Build the tool-cache config (D4 — adapter encapsulates the
   * config + endpoints + vision-resolution inputs that the extracted
   * `tool-cache.ts` needs to compute a stable key). Owned here because
   * the inputs come from this class's options and the shared config
   * module; the extracted module stays pure of `loadConfig` / `getMcpEndpoints`.
   */
  private getToolCacheConfig(): ToolCacheConfig {
    const config = loadConfig();
    return {
      mode: config.mode,
      baseUrl: config.baseUrl,
      endpoints: getMcpEndpoints(),
      enableVision: this.resolveEnableVision(),
    };
  }

  /**
   * List all discovered tools from registered MCP servers.
   *
   * Returns the PUBLIC projected view: internal UTCP names (e.g.
   * `scoutline_zai.search.web_search_prime`) are rewritten to the
   * stable dotted form (e.g. `scoutline.zai.search.web_search_prime`).
   * The private unprojected discovery list is retained for invocation
   * through {@link getTool} / {@link resolveToolName}.
   */
  async listTools(refresh: boolean = false): Promise<Tool[]> {
    const tools = await this.discoverTools(refresh);
    return tools.map((tool) => ({ ...tool, name: projectInternalToolName(tool.name) }));
  }

  /**
   * Private unprojected discovery list. Tools keep their exact UTCP
   * names so {@link getTool} can resolve public aliases back to the
   * internal invocation identity.
   *
   * Tool-cache I/O is delegated to the extracted {@link tool-cache.ts}
   * module (D1 — owns its I/O directly against the `tools/` subdir).
   */
  private async discoverTools(refresh: boolean = false): Promise<Tool[]> {
    if (!refresh) {
      const cached = await readToolCache(this.getToolCacheConfig());
      if (cached) {
        return cached;
      }
    }

    await this.init();
    if (!this.client) {
      throw new ApiError("MCP client not initialized", 500);
    }
    const tools = await this.client.getTools();
    await writeToolCache(this.getToolCacheConfig(), tools);
    return tools;
  }

  /**
   * Find a tool by exact internal name, public dotted name, or leaf
   * suffix. Resolution order:
   *   1. Exact discovered name (e.g. `scoutline_zai.search.web_search_prime`).
   *   2. Public dotted name (e.g. `scoutline.zai.search.web_search_prime`):
   *      derive the provider-relative suffix after the public prefix and
   *      match exactly one discovered name ending in `.<suffix>`. Zero or
   *      multiple matches fail.
   *   3. Legacy short-suffix fallback: a single discovered name ending in
   *      `.<name>` (e.g. for callers that pass only `web_search_prime`).
   *
   * Public names never replace the private discovered-name record — the
   * returned {@link Tool} always carries its internal UTCP name.
   */
  async getTool(toolName: string): Promise<Tool | undefined> {
    let tools = await this.discoverTools(false);
    let found = this.findToolByResolvedName(tools, toolName);
    if (found) return found;

    tools = await this.discoverTools(true);
    return this.findToolByResolvedName(tools, toolName);
  }

  private findToolByResolvedName(tools: Tool[], name: string): Tool | undefined {
    // 1. Exact internal name wins before any aliasing.
    const exact = tools.find((tool) => tool.name === name);
    if (exact) return exact;

    // 2. Public prefix → suffix match. Exactly one discovered name must
    //    end in `.<suffix>`; zero or multiple matches fail.
    const publicPrefix = `${MCP_MANUAL_NAME}.`;
    if (name.startsWith(publicPrefix)) {
      const suffix = name.slice(publicPrefix.length);
      const matches = tools.filter((tool) => tool.name.endsWith(`.${suffix}`));
      if (matches.length === 1) return matches[0];
      return undefined;
    }

    // 3. Legacy short-suffix fallback for callers that pass only a leaf
    //    or partial name. Preserves the pre-P2-03 loose-match behaviour.
    return tools.find((tool) => tool.name.endsWith(`.${name}`));
  }

  /**
   * Resolve a tool name, accepting full names or suffixes
   */
  async resolveToolName(toolName: string): Promise<string> {
    const tool = await this.getTool(toolName);
    if (!tool) {
      throw new ApiError(`Unknown tool: ${toolName}`, 400);
    }
    return tool.name;
  }

  /**
   * Call a tool by full name or suffix
   */
  async callToolRaw<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    const resolved = await this.resolveToolName(toolName);
    return this.callTool<T>(resolved, args);
  }

  /**
   * P6-01A: invoke a tool while preserving the public dotted tool name as
   * the cache identity, then resolve to the internal sanitized identity
   * only on a cache miss.
   *
   * The legacy v0.2 repository cache contract (P0–P2) keyed entries under
   * the public dotted name and returned them before any transport work.
   * A naive `callToolRaw` migration routes through `resolveToolName` first,
   * which forces discovery, registration, and `init()` even when a v0.2
   * hit is present. This helper restores the legacy cache identity and
   * skips discovery on hits while keeping the translation fix for misses.
   *
   * Other callers (`callTool`, `callToolRaw`, Vision, Search, Reader, raw
   * tools) are unchanged.
   */
  private async callToolWithPublicCacheIdentity<T>(
    publicToolName: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const cacheable = !this.options.noCache && !publicToolName.includes(".vision.");
    if (!cacheable) {
      // No-cache path: resolve the internal identity and invoke directly.
      const internal = await this.resolveToolName(publicToolName);
      return this.callToolUncached<T>(internal, args);
    }
    const key = buildCacheKey(publicToolName, args);
    const hit = await readCache<T>(key);
    if (hit !== null) return hit;
    const internal = await this.resolveToolName(publicToolName);
    try {
      const result = await this.callToolUncached<T>(internal, args);
      // F2: scrub before persist + return (see callTool above).
      const safe = redactSecrets(result, configuredSecrets()) as T;
      await writeCache(key, safe);
      return safe;
    } catch (err) {
      throw err;
    }
  }

  // ============ ZRead Methods ============

  /**
   * Search documentation and code in a GitHub repository
   */
  async zreadSearch(repo: string, query: string, language?: "zh" | "en"): Promise<string> {
    // P6-01 / P6-01A: route through `callToolWithPublicCacheIdentity` so
    //   - the public dotted name is preserved as the cache identity
    //     (legacy v0.2 cache hits still return without transport work);
    //   - on a cache miss the public name is resolved to the discovered
    //     internal UTCP identity before invocation (fixes the public-name
    //     translation regression);
    // The legacy `ZReadMcpClient.searchDoc` wrapper delegates here.
    return this.callToolWithPublicCacheIdentity<string>(getMcpToolName("zread", "search_doc"), {
      repo_name: repo,
      query,
      ...(language && { language }),
    });
  }

  /**
   * Get the directory structure of a GitHub repository
   */
  async zreadTree(repo: string, dirPath?: string): Promise<string> {
    // P6-01 / P6-01A: see `zreadSearch` for the cache identity and
    // translation rationale. The legacy `ZReadMcpClient.getRepoStructure`
    // wrapper delegates here.
    return this.callToolWithPublicCacheIdentity<string>(
      getMcpToolName("zread", "get_repo_structure"),
      { repo_name: repo, ...(dirPath && { dir_path: dirPath }) },
    );
  }

  /**
   * Read a file from a GitHub repository
   */
  async zreadFile(repo: string, path: string): Promise<string> {
    // P6-01 / P6-01A: see `zreadSearch` for the cache identity and
    // translation rationale. The legacy `ZReadMcpClient.readFile` wrapper
    // delegates here.
    return this.callToolWithPublicCacheIdentity<string>(getMcpToolName("zread", "read_file"), {
      repo_name: repo,
      file_path: path,
    });
  }

  // ============ Web Search Methods ============

  /**
   * Search the web using WebSearchPrime
   */
  async webSearch(params: {
    query: string;
    count?: number;
    domainFilter?: string;
    recencyFilter?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
    contentSize?: "medium" | "high";
    location?: "cn" | "us";
  }): Promise<WebSearchResult[]> {
    const args: Record<string, unknown> = {
      search_query: params.query,
    };

    if (params.count) {
      args.count = params.count;
    }
    if (params.domainFilter) {
      args.search_domain_filter = params.domainFilter;
    }
    if (params.recencyFilter) {
      args.search_recency_filter = params.recencyFilter;
    }
    if (params.contentSize) {
      args.content_size = params.contentSize;
    }
    if (params.location) {
      args.location = params.location;
    }

    return this.callToolWithPublicCacheIdentity<WebSearchResult[]>(
      getMcpToolName("search", "web_search_prime"),
      args,
    );
  }

  // ============ Web Reader Methods ============

  /**
   * Read and parse web page content
   */
  async webRead(params: {
    url: string;
    timeout?: number;
    noCache?: boolean;
    format?: "markdown" | "text";
    retainImages?: boolean;
    withLinksSummary?: boolean;
    noGfm?: boolean;
    keepImgDataUrl?: boolean;
    withImagesSummary?: boolean;
  }): Promise<ReaderRawResponse> {
    const args: Record<string, unknown> = {
      url: params.url,
    };

    if (params.timeout !== undefined) {
      args.timeout = params.timeout;
    }
    if (params.noCache !== undefined) {
      args.no_cache = params.noCache;
    }
    if (params.format) {
      args.return_format = params.format;
    }
    if (params.retainImages !== undefined) {
      args.retain_images = params.retainImages;
    }
    if (params.withLinksSummary !== undefined) {
      args.with_links_summary = params.withLinksSummary;
    }
    if (params.noGfm !== undefined) {
      args.no_gfm = params.noGfm;
    }
    if (params.keepImgDataUrl !== undefined) {
      args.keep_img_data_url = params.keepImgDataUrl;
    }
    if (params.withImagesSummary !== undefined) {
      args.with_images_summary = params.withImagesSummary;
    }

    // Reader Migration Ticket 02: route through
    // `callToolWithPublicCacheIdentity` so:
    //   - the public dotted name is preserved as the cache identity
    //     (legacy v0.2 reader cache hits still return without any
    //     transport work, matching the v0.2 contract);
    //   - on a cache miss the public name is resolved to the discovered
    //     internal UTCP identity before invocation (fixes the
    //     public-name translation regression where UTCP rejected the
    //     dotted name with "Tool not found in UTCP manual").
    // Mirrors the P6-01A fix applied to `zreadSearch` / `zreadTree` /
    // `zreadFile`. The TypeScript return type widens from
    // `Promise<string>` to `Promise<ReaderRawResponse>` to honestly
    // reflect the runtime shape of the Z.AI WebReader MCP response
    // (structured object on success; bare string for MCP-level error
    // envelopes like `"MCP error -500: ..."`).
    return this.callToolWithPublicCacheIdentity<ReaderRawResponse>(
      getMcpToolName("reader", "webReader"),
      args,
    );
  }

  // ============ Vision Methods ============

  async visionAnalyze(params: { imageSource: string; prompt: string }): Promise<string> {
    return this.callToolWithPublicCacheIdentity<string>(getMcpToolName("vision", "analyze_image"), {
      image_source: params.imageSource,
      prompt: params.prompt,
    });
  }

  async visionUiToArtifact(params: {
    imageSource: string;
    outputType: "code" | "prompt" | "spec" | "description";
    prompt: string;
  }): Promise<string> {
    return this.callToolWithPublicCacheIdentity<string>(
      getMcpToolName("vision", "ui_to_artifact"),
      {
        image_source: params.imageSource,
        output_type: params.outputType,
        prompt: params.prompt,
      },
    );
  }

  async visionExtractText(params: {
    imageSource: string;
    prompt: string;
    programmingLanguage?: string;
  }): Promise<string> {
    return this.callToolWithPublicCacheIdentity<string>(
      getMcpToolName("vision", "extract_text_from_screenshot"),
      {
        image_source: params.imageSource,
        prompt: params.prompt,
        ...(params.programmingLanguage && { programming_language: params.programmingLanguage }),
      },
    );
  }

  async visionDiagnoseError(params: {
    imageSource: string;
    prompt: string;
    context?: string;
  }): Promise<string> {
    return this.callToolWithPublicCacheIdentity<string>(
      getMcpToolName("vision", "diagnose_error_screenshot"),
      {
        image_source: params.imageSource,
        prompt: params.prompt,
        ...(params.context && { context: params.context }),
      },
    );
  }

  async visionDiagram(params: {
    imageSource: string;
    prompt: string;
    diagramType?: string;
  }): Promise<string> {
    return this.callToolWithPublicCacheIdentity<string>(
      getMcpToolName("vision", "understand_technical_diagram"),
      {
        image_source: params.imageSource,
        prompt: params.prompt,
        ...(params.diagramType && { diagram_type: params.diagramType }),
      },
    );
  }

  async visionChart(params: {
    imageSource: string;
    prompt: string;
    focus?: string;
  }): Promise<string> {
    return this.callToolWithPublicCacheIdentity<string>(
      getMcpToolName("vision", "analyze_data_visualization"),
      {
        image_source: params.imageSource,
        prompt: params.prompt,
        ...(params.focus && { analysis_focus: params.focus }),
      },
    );
  }

  async visionDiff(params: {
    expectedImageSource: string;
    actualImageSource: string;
    prompt: string;
  }): Promise<string> {
    return this.callToolWithPublicCacheIdentity<string>(getMcpToolName("vision", "ui_diff_check"), {
      expected_image_source: params.expectedImageSource,
      actual_image_source: params.actualImageSource,
      prompt: params.prompt,
    });
  }

  async visionVideo(params: { videoSource: string; prompt: string }): Promise<string> {
    return this.callToolWithPublicCacheIdentity<string>(getMcpToolName("vision", "analyze_video"), {
      video_source: params.videoSource,
      prompt: params.prompt,
    });
  }

  /**
   * Close the MCP client and cleanup resources
   */
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

// Legacy exports for backward compatibility
export class ZReadMcpClient extends ZaiMcpClient {
  constructor(options: ZaiMcpClientOptions = {}) {
    super(options);
  }

  async searchDoc(repo: string, query: string, language?: "zh" | "en") {
    return this.zreadSearch(repo, query, language);
  }

  async getRepoStructure(repo: string, dirPath?: string) {
    return this.zreadTree(repo, dirPath);
  }

  async readFile(repo: string, path: string) {
    return this.zreadFile(repo, path);
  }
}
