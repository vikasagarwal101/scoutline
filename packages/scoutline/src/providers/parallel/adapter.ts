/**
 * Parallel AI Provider Adapter.
 *
 * Implements Search, Research, and Diagnostics capabilities for Parallel AI.
 *
 * Field mapping (Parallel API → Provider-neutral):
 *   results[].title         -> title
 *   results[].url           -> url
 *   results[].excerpts[]    -> summary (joined with double newlines)
 *   results[].publish_date  -> date
 *
 * Reader (Extract API):
 *   results[].full_content  -> content (primary; excerpts are a degraded fallback)
 *   results[].title         -> title
 *   results[].url           -> finalUrl
 *   Request: advanced_settings.full_content = true (8P.2)
 *
 * Research (Task / Deep Research API — 8P.1):
 *   POST /v1/tasks/runs      → create async task run (pro/ultra processor)
 *   GET  /v1/tasks/runs/{id}/result → long-poll until terminal
 *   output.content            -> report (markdown report string)
 *   output.basis[].citations  -> sources (flattened + deduplicated by URL)
 *   run.processor             -> model (echoed)
 *
 * Control mapping (SearchControls → Parallel-native API params):
 *   topic       -> appended to query string (Parallel has no native topic field)
 *   type        -> REJECTED (UnsupportedOptionError)
 *   domain      -> advanced_settings.source_policy.include_domains (8P.3)
 *   recency     -> advanced_settings.source_policy.after_date (RFC 3339) (8P.3)
 *   location    -> advanced_settings.location (8P.3; only "us" accepted)
 *   contentSize -> advanced_settings.excerpt_settings.max_chars_per_result (8P.3)
 *
 * Control mapping (ResearchRequest → Parallel Task API params):
 *   model          -> processor (mini→pro-fast, pro→ultra, auto→pro)
 *   domain         -> source_policy.include_domains
 *   outputLength   -> task_spec.output_schema.description (length steering)
 *   citationFormat -> task_spec.output_schema.description (format steering)
 */

import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
  ProviderId,
} from "../types.js";
import type {
  SearchCacheIdentity,
  SearchCapability,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import type {
  ResearchCapability,
  ResearchRequest,
  ResearchResult,
  ResearchSource,
} from "../../capabilities/research.js";
import { decodeResearchResult } from "../../capabilities/research.js";
import type {
  ReaderCapability,
  ReaderFetchRequest,
  ReaderFetchResult,
} from "../../capabilities/reader.js";
import { decodeReaderFetchResult } from "../../capabilities/reader.js";
import type { DiagnosticsCapability } from "../../capabilities/diagnostics.js";
import type { AsyncJobStateFile } from "../../lib/async-job-state.js";
import {
  computeAsyncJobStateHash,
  createProductionAsyncJobStateFile,
} from "../../lib/async-job-state.js";
import { asyncJobStateDir } from "../../lib/cache.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  UnsupportedOptionError,
  ValidationError,
} from "../../lib/errors.js";
import { requireParallelApiKey, isParallelConfigured } from "./credentials.js";
import { applySearchTopic } from "../../lib/search-topic.js";
import { validateDomain } from "../../lib/domain-validation.js";
import {
  fetchParallelSearch,
  fetchParallelExtract,
  createParallelTaskRun,
  retrieveParallelTaskRunResult,
  type ParallelSearchParams,
  type ParallelTaskParams,
  type ParallelTaskRunResult,
  type ParallelTransportDeps,
} from "./client.js";
import { createParallelDiagnosticsCapability } from "./diagnostics.js";

function credentialFingerprint(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Normalize a Provider failure with sanitized messages. Raw response
 * bodies never cross the adapter boundary. Same pattern as the Tavily
 * adapter's `normalizeTavilyError` — curated constant messages only,
 * never interpolate `error.message`.
 */
function normalizeParallelError(error: unknown): Error {
  // QuotaError pass-through — terminal retry guarantee preserved.
  if (error instanceof QuotaError) return error;

  // Configuration/option/validation errors carry clean, human-authored
  // messages and are safe to surface verbatim.
  if (
    error instanceof ValidationError ||
    error instanceof UnsupportedOptionError ||
    error instanceof ConfigurationError
  ) {
    return error;
  }
  // Re-wrap typed transport errors with sanitized messages so a raw
  // Provider response body embedded upstream never survives. Code +
  // statusCode (retry signal) are preserved.
  if (error instanceof AuthError) {
    return new AuthError("Parallel AI authentication failed", "PARALLEL_API_KEY");
  }
  if (error instanceof NetworkError) {
    return new NetworkError("Parallel AI network error");
  }
  if (error instanceof TimeoutError) {
    return new TimeoutError(
      error.durationMs,
      "Try again or increase timeout with PARALLEL_TIMEOUT env var",
    );
  }
  if (error instanceof ApiError) {
    const statusCode = error.statusCode || 500;
    if (statusCode === 429) {
      return new ApiError("Parallel AI rate limit exceeded", 429);
    }
    return new ApiError("Parallel AI request failed", statusCode);
  }
  return new ApiError("Parallel AI request failed", 500);
}

export interface ParallelAdapterDependencies {
  readonly transport?: ParallelTransportDeps;
  /**
   * Optional Research state-file port (8P.1). Production defaults to the
   * on-disk implementation under `~/.scoutline/research/`; tests inject
   * in-memory doubles to exercise the lifecycle deterministically.
   */
  readonly researchStateFile?: AsyncJobStateFile;
  /**
   * Disk dir for the research create-lock (Cubic P1); defaults to
   * `asyncJobStateDir("research")`. When undefined (in-memory test
   * mode), the lock is a no-op.
   */
  readonly researchStateDir?: string;
}

function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Parallel reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

/**
 * Maximum query length enforced by Parallel's Search API (8P.4).
 * Each element of `search_queries` is capped at 200 characters.
 */
const PARALLEL_MAX_QUERY_LENGTH = 200;

/**
 * Bounded Unicode code-point counter for the query-length limit. Uses a
 * quick upper-bound check with `.length` (UTF-16 code units) first; only
 * strings exceeding the limit are iterated, and the iteration
 * short-circuits at the (limit+1)th code point so rejecting an oversized
 * input is O(limit), not O(input).
 */
function exceedsCodePointLimit(str: string, limit: number): boolean {
  // Fast path: UTF-16 length ≤ limit means code points are also ≤ limit
  // (each code point is 1-2 UTF-16 code units, never more).
  if (str.length <= limit) return false;
  // Bounded code-point count (for...of yields code points). Short-circuit
  // at limit+1 so a huge payload is rejected without proportional work.
  let count = 0;
  for (const _ of str) {
    if (++count > limit) return true;
  }
  return false;
}

/**
 * Map a provider-neutral SearchRecency to a Parallel `after_date` string
 * (RFC 3339 / ISO 8601 date). Returns `undefined` for `noLimit` (no date
 * filter). Uses a 30-day convention for `oneMonth` to avoid month-end
 * rollover issues with `setUTCMonth`.
 */
function recencyToAfterDate(
  recency: import("../../capabilities/search.js").SearchRecency,
  now: Date = new Date(),
): string | undefined {
  if (recency === "noLimit") return undefined;
  const d = new Date(now.getTime());
  switch (recency) {
    case "oneDay":
      d.setUTCDate(d.getUTCDate() - 1);
      break;
    case "oneWeek":
      d.setUTCDate(d.getUTCDate() - 7);
      break;
    case "oneMonth":
      d.setUTCDate(d.getUTCDate() - 30);
      break;
    case "oneYear":
      d.setUTCDate(d.getUTCDate() - 365);
      break;
  }
  return d.toISOString().split("T")[0]!;
}

/**
 * Map contentSize to an excerpt budget (max_chars_per_result).
 * `high` requests more content per result; `medium` is the default
 * budget. Values are conservative within Parallel's documented ranges.
 */
function contentSizeToExcerptBudget(contentSize: "medium" | "high"): number {
  return contentSize === "high" ? 5000 : 1000;
}

/**
 * Map provider-neutral SearchControls to Parallel-native advanced_settings.
 * Returns `undefined` when no controls apply.
 */
function mapSearchControlsToParams(
  controls: import("../../capabilities/search.js").SearchControls | undefined,
  now: Date = new Date(),
): ParallelSearchParams | undefined {
  if (!controls) return undefined;
  if (!controls.domain && !controls.recency && !controls.location && !controls.contentSize)
    return undefined;

  const sourcePolicy: { include_domains?: readonly string[]; after_date?: string } = {};
  if (controls.domain) {
    sourcePolicy.include_domains = [controls.domain];
  }
  if (controls.recency) {
    const afterDate = recencyToAfterDate(controls.recency, now);
    if (afterDate) {
      sourcePolicy.after_date = afterDate;
    }
  }

  const advancedSettings: Record<string, unknown> = {};
  if (Object.keys(sourcePolicy).length > 0) {
    advancedSettings.source_policy = sourcePolicy;
  }
  if (controls.location) {
    advancedSettings.location = controls.location;
  }
  if (controls.contentSize) {
    advancedSettings.excerpt_settings = {
      max_chars_per_result: contentSizeToExcerptBudget(controls.contentSize),
    };
  }

  return {
    ...(Object.keys(advancedSettings).length > 0 ? { advanced_settings: advancedSettings } : {}),
  };
}

// ---------------------------------------------------------------------------
// Research control mapping (ResearchRequest → Task API params) (8P.1)
// ---------------------------------------------------------------------------

/**
 * Maximum input length for the Task API's `input` field. Parallel
 * documents this as 15,000 characters for Deep Research.
 */
const PARALLEL_MAX_TASK_INPUT_LENGTH = 15000;

/**
 * Map a provider-neutral research model to a Parallel processor tier.
 *
 *   mini → pro-fast   (cheapest/fastest deep research tier)
 *   pro  → ultra      (deepest, most capable — scoutline "pro" = deepest)
 *   auto → pro        (standard deep research processor, the default)
 */
function modelToProcessor(model: "mini" | "pro" | "auto" | undefined): string {
  switch (model) {
    case "mini":
      return "pro-fast";
    case "pro":
      return "ultra";
    case "auto":
    case undefined:
      return "pro";
    default:
      return "pro";
  }
}

/**
 * Map a provider-neutral `ResearchRequest` into Parallel-native Task API
 * params (processor, source_policy, task_spec).
 *
 *   model          -> processor (via {@link modelToProcessor})
 *   domain         -> source_policy.include_domains
 *   outputLength   -> task_spec.output_schema.description (length steering)
 *   citationFormat -> task_spec.output_schema.description (format steering)
 *
 * The output_schema description is documented by Parallel as giving
 * "control over the length or the content" of the report.
 */
function mapResearchControlsToTaskParams(request: ResearchRequest): ParallelTaskParams {
  const processor = modelToProcessor(request.model);

  const params: {
    processor: string;
    source_policy?: { include_domains: readonly string[] };
    task_spec: { output_schema: { type: "text"; description?: string } };
  } = {
    processor,
    task_spec: { output_schema: { type: "text" } },
  };

  if (request.domain) {
    params.source_policy = { include_domains: [request.domain] };
  }

  // Fold outputLength and citationFormat into the output_schema
  // description — Parallel documents this as the steering mechanism for
  // report length and content.
  const descParts: string[] = [];
  if (request.outputLength === "short") {
    descParts.push("Keep the report concise and brief.");
  } else if (request.outputLength === "long") {
    descParts.push("Write a comprehensive, detailed report.");
  }
  if (request.citationFormat && request.citationFormat !== "numbered") {
    descParts.push(`Use ${request.citationFormat.toUpperCase()} citation format.`);
  }
  if (descParts.length > 0) {
    params.task_spec = {
      output_schema: { type: "text", description: descParts.join(" ") },
    };
  }

  return params;
}

/**
 * Normalize a completed Parallel Task run result into a provider-neutral
 * `ResearchResult`.
 *
 *   output.content → report
 *   output.basis[].citations → sources (flattened + deduplicated by URL)
 *   run.processor → model (echoed, falling back to the requested processor)
 */
function normalizeParallelResearchResult(
  result: ParallelTaskRunResult,
  request: ResearchRequest,
): ResearchResult {
  // Deduplicate citations by URL, preserving first-seen order.
  const seen = new Set<string>();
  const sources: ResearchSource[] = [];
  if (result.citations) {
    for (const citation of result.citations) {
      if (citation.url && !seen.has(citation.url)) {
        seen.add(citation.url);
        sources.push({
          title: citation.title || "Untitled",
          url: citation.url,
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    query: request.query,
    model: result.processor ?? modelToProcessor(request.model),
    report: result.content ?? "",
    sources,
  };
}

function isEexistError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

// ---------------------------------------------------------------------------
// Concurrent-create lock (cost-safety — Cubic P1)
// ---------------------------------------------------------------------------

/** How long to wait for a contended research create-lock before giving up. */
const RESEARCH_LOCK_TIMEOUT_MS = 30000;
/** A lock older than this is treated as stale (holder died) and broken. */
const RESEARCH_LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Serialize the create→persist critical section per request so two
 * concurrent identical research invocations can't both POST (and charge)
 * a task — the second waits, then re-reads the state file and finds the
 * first's persisted `run_id` instead of re-POSTing. Uses an exclusive
 * `wx`-create lockfile sibling to the state file; a stale lock (holder
 * crashed) is broken after {@link RESEARCH_LOCK_STALE_MS}.
 *
 * Mirrors Firecrawl's `withCrawlLock` pattern. When `stateDir` is
 * undefined (in-memory test mode), the lock is a no-op.
 */
async function withResearchLock<T>(
  stateDir: string | undefined,
  identityHash: string,
  fn: () => Promise<T>,
  deps: ParallelTransportDeps | undefined,
): Promise<T> {
  if (stateDir === undefined) return fn();
  const setT = deps?.setTimeout ?? setTimeout;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setT(() => r(), ms));
  await fs.mkdir(stateDir, { recursive: true }).catch(() => {});
  const lockPath = path.join(stateDir, `${identityHash}.lock`);
  const deadline = Date.now() + RESEARCH_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (err) {
      if (!isEexistError(err)) throw err;
      if (Date.now() > deadline) {
        throw new ApiError("Parallel AI research create-lock timed out", 500);
      }
      // Break a stale lock (the holder died without releasing).
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > RESEARCH_LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => {});
        continue;
      }
      await sleep(500);
    }
  }
}

export class ParallelAdapter implements ProviderAdapter {
  readonly id: ProviderId = "parallel";
  readonly search: SearchCapability;
  readonly research: ResearchCapability;
  readonly reader: ReaderCapability;
  readonly diagnostics: DiagnosticsCapability;

  constructor(
    private readonly context: ProviderContext,
    deps: ParallelAdapterDependencies = {},
  ) {
    const transport = deps.transport;
    const env = context.env;
    const researchStateFile =
      deps.researchStateFile ?? createProductionAsyncJobStateFile(asyncJobStateDir("research"));
    const researchStateDir = deps.researchStateDir ?? asyncJobStateDir("research");

    this.search = {
      validate(request: SearchRequest): void {
        if (!request.query || request.query.trim().length === 0) {
          throw new ValidationError("Search query must not be empty");
        }
        // Enforce Parallel's documented 200-char per-query limit (8P.4).
        // Validate the final expanded query (after topic suffix) so topic
        // appends don't turn a locally-valid request into a remote 422.
        // Count Unicode code points (not UTF-16 code units) so queries
        // with non-BMP characters (emoji etc.) are not over-rejected.
        const expandedQuery = applySearchTopic(request.query.trim(), request.controls?.topic);
        if (exceedsCodePointLimit(expandedQuery, PARALLEL_MAX_QUERY_LENGTH)) {
          throw new ValidationError(
            `Parallel AI search query exceeds the ${PARALLEL_MAX_QUERY_LENGTH}-character limit (after topic expansion)`,
          );
        }
        if (request.controls?.type !== undefined) {
          throw new UnsupportedOptionError("parallel", "search", "type");
        }
        // Accept domain, recency, location, and contentSize (8P.3).
        // Validate domain syntax; reject locations Parallel can't honor.
        if (request.controls?.domain !== undefined) {
          validateDomain(request.controls.domain);
        }
        if (request.controls?.location !== undefined && request.controls.location !== "us") {
          throw new UnsupportedOptionError("parallel", "search", "location");
        }
      },

      cacheIdentity(request: SearchRequest): SearchCacheIdentity {
        const apiKey = requireParallelApiKey(env);
        return {
          provider: "parallel",
          capability: "search",
          credentialFingerprint: credentialFingerprint(apiKey),
          request: {
            query: request.query.trim(),
            controls: request.controls,
          },
        };
      },

      async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
        this.validate(request);
        const apiKey = requireParallelApiKey(env);
        const query = applySearchTopic(request.query.trim(), request.controls?.topic);

        const controlParams = mapSearchControlsToParams(request.controls);
        const params: ParallelSearchParams = { ...controlParams };

        try {
          const response = await fetchParallelSearch(apiKey, query, params, transport);
          const results = response.results || [];

          return results.map((item) => {
            const result: SearchSource = {
              title: item.title || "Untitled",
              url: item.url || "",
              summary: item.excerpts?.join("\n\n") || "",
            };
            if (item.publish_date) result.date = item.publish_date;
            return result;
          });
        } catch (error) {
          throw normalizeParallelError(error);
        }
      },
    };

    this.research = {
      run: {
        kind: "research-fetch",
        validate(request: ResearchRequest): void {
          if (!request.query || request.query.trim().length === 0) {
            throw new ValidationError("Research query must not be empty");
          }
          // The Task API's `input` field accepts up to 15,000 characters
          // (documented). This replaces the old 200-char search-query
          // limit that applied when research was a search alias (8P.1).
          const researchInput = request.query.trim();
          if (exceedsCodePointLimit(researchInput, PARALLEL_MAX_TASK_INPUT_LENGTH)) {
            throw new ValidationError(
              `Parallel AI research input exceeds the ${PARALLEL_MAX_TASK_INPUT_LENGTH}-character limit`,
            );
          }
          // Validate domain syntax (same as search).
          if (request.domain !== undefined) {
            validateDomain(request.domain);
          }
        },

        cacheIdentity(request: ResearchRequest) {
          const apiKey = requireParallelApiKey(env);
          return {
            provider: "parallel",
            capability: "research",
            operation: "research-fetch",
            credentialFingerprint: credentialFingerprint(apiKey),
            request,
          };
        },

        decodeCached: decodeResearchResult,

        async invoke(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchResult> {
          this.validate(request);
          if (signal?.aborted) throw new TimeoutError(0, "Research aborted before start");
          const apiKey = requireParallelApiKey(env);
          const taskParams = mapResearchControlsToTaskParams(request);
          const credFingerprint = credentialFingerprint(apiKey);
          const identityHash = computeAsyncJobStateHash({
            provider: "parallel",
            capability: "research",
            credentialFingerprint: credFingerprint,
            request,
          });

          try {
            // 1. Check for an in-flight task (resume after Ctrl-C / crash).
            //    A valid state file means a task was already created
            //    server-side — poll it instead of creating a second one
            //    (double-charge prevention).
            const existingState = await researchStateFile.read(identityHash);
            let runId: string;

            if (existingState !== null) {
              runId = existingState.requestId;
            } else {
              // 2. No in-flight task: create under a lock so concurrent
              //    identical invocations serialize. The second caller
              //    waits, then re-reads the state file and finds the
              //    first's persisted run_id instead of creating (and
              //    billing) a second task (Cubic P1).
              runId = await withResearchLock(
                researchStateDir,
                identityHash,
                async () => {
                  // Re-check under the lock — another caller may have
                  // created and persisted while we waited to acquire.
                  const state = await researchStateFile.read(identityHash);
                  if (state !== null) {
                    return state.requestId;
                  }
                  // No existing task: POST to create one. NO retry — a
                  // transient POST failure is terminal (the user re-runs);
                  // retrying risks a double-charge if the POST succeeded
                  // server-side but the response was lost.
                  return createParallelResearchTask(
                    apiKey,
                    request,
                    taskParams,
                    identityHash,
                    researchStateFile,
                    transport,
                    signal,
                  );
                },
                transport,
              );
            }

            // 3. Poll loop — the /result endpoint is a server-side
            //    long-poll (blocks up to 60s, then returns 408 if still
            //    active). No client-side sleep is needed between polls;
            //    the server IS the wait. A setImmediate yield between
            //    iterations lets signal handlers fire.
            let recreatedAfterNotFound = false;
            for (;;) {
              if (signal?.aborted) {
                throw new TimeoutError(0, "Research polling aborted");
              }
              const result = await retrieveParallelTaskRunResult(
                apiKey,
                runId,
                transport,
                signal,
              );

              if (result.status === "completed") {
                // Best-effort cleanup — a filesystem error here must
                // not discard a successfully completed paid report.
                await researchStateFile.remove(identityHash).catch(() => {});
                return normalizeParallelResearchResult(result, request);
              }

              if (result.status === "failed") {
                await researchStateFile.remove(identityHash).catch(() => {});
                // Note: normalizeParallelError sanitizes this to a constant
                // message at the adapter boundary (NFR-006). The provider's
                // raw error message never reaches the user by design.
                throw new ApiError("Parallel AI research task failed", 500);
              }

              if (result.status === "not_found") {
                // 404 — the server-side task expired/disappeared.
                // Allow at most ONE recreation; a second 404 means the
                // freshly created task also failed to register, so we
                // terminate rather than risk unbounded paid creations.
                if (recreatedAfterNotFound) {
                  await researchStateFile.remove(identityHash).catch(() => {});
                  throw new ApiError(
                    "Parallel AI research task not found after creation",
                    500,
                  );
                }
                recreatedAfterNotFound = true;
                await researchStateFile.remove(identityHash).catch(() => {});
                runId = await createParallelResearchTask(
                  apiKey,
                  request,
                  taskParams,
                  identityHash,
                  researchStateFile,
                  transport,
                  signal,
                );
                continue;
              }

              // running (408 or non-terminal 200): yield to the event
              // loop so signal handlers can fire, then re-poll. The
              // server already waited RESULT_POLL_SERVER_TIMEOUT_S.
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          } catch (error) {
            throw normalizeParallelError(error);
          }
        },
      },
    };

    this.reader = {
      fetch: {
        kind: "reader-fetch",
        validate(request: ReaderFetchRequest): void {
          assertHttpUrl(request.url);
          // Parallel Extract always returns markdown content.
          if (request.format === "text") {
            throw new UnsupportedOptionError("parallel", "reader", "format");
          }
          for (const key of [
            "withLinksSummary",
            "noGfm",
            "keepImgDataUrl",
            "withImagesSummary",
            "retainImages",
          ] as const) {
            if (request[key] === true) {
              throw new UnsupportedOptionError("parallel", "reader", key);
            }
          }
        },

        cacheIdentity(request: ReaderFetchRequest) {
          const apiKey = requireParallelApiKey(env);
          return {
            provider: "parallel",
            capability: "reader",
            operation: "reader-fetch",
            credentialFingerprint: credentialFingerprint(apiKey),
            request,
            legacyCandidates: [],
          };
        },

        decodeCached: decodeReaderFetchResult,

        async invoke(request: ReaderFetchRequest): Promise<ReaderFetchResult> {
          this.validate(request);
          const apiKey = requireParallelApiKey(env);

          try {
            const response = await fetchParallelExtract(apiKey, request.url, transport);

            // Check for extraction errors for the requested URL
            if (response.errors && response.errors.length > 0) {
              for (const err of response.errors) {
                if (err.url === request.url) {
                  throw new ApiError(
                    `Parallel AI extract failed for URL (${err.error_type || "unknown"})`,
                    err.http_status_code || 422,
                  );
                }
              }
            }

            const result = response.results?.[0];
            const content = result?.full_content || result?.excerpts?.join("\n\n") || "";

            if (content.length === 0) {
              throw new ApiError("Parallel AI extract returned no content", 422);
            }

            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: result?.url || request.url,
              title: result?.title || null,
              content,
              contentFormat: "markdown",
            };
          } catch (error) {
            throw normalizeParallelError(error);
          }
        },
      },
    };

    this.diagnostics = createParallelDiagnosticsCapability({ env, transport });
  }
}

/**
 * POST /v1/tasks/runs to create a Deep Research task, then persist its
 * runId in the state file atomically. On EEXIST (a concurrent invocation
 * already created a task for this request), read the existing state file
 * and return its runId instead — the concurrent task is polled, not
 * duplicated. Mirrors Tavily's `createResearchTask` pattern.
 */
async function createParallelResearchTask(
  apiKey: string,
  request: ResearchRequest,
  taskParams: ParallelTaskParams,
  identityHash: string,
  stateFile: AsyncJobStateFile,
  transport: ParallelTransportDeps | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const created = await createParallelTaskRun(
    apiKey,
    request.query.trim(),
    taskParams,
    transport,
    signal,
  );
  const runId = created.runId;

  const state = {
    requestId: runId,
    identityHash,
    createdAt: new Date().toISOString(),
    status: "pending" as const,
  };
  try {
    await stateFile.write(identityHash, state);
  } catch (err) {
    if (isEexistError(err)) {
      // Concurrent invocation won the race — poll its task instead.
      const existing = await stateFile.read(identityHash);
      if (existing !== null) {
        return existing.requestId;
      }
      // The existing file was corrupt (read returned null after deleting
      // it). Fall through and poll the task we just created — it is
      // valid server-side even if we cannot persist it.
    } else {
      // Non-EEXIST error (disk full, permissions). The task was created
      // server-side — degrade to non-resumable mode rather than
      // abandoning a paid task. The current invocation will still poll
      // and retrieve the result; only resume-after-interrupt is lost.
      // Intentionally swallow — the run_id is valid server-side.
    }
  }
  return runId;
}

export function createParallelDescriptor(
  dependencies?: ParallelAdapterDependencies,
): ProviderDescriptor {
  const transport = dependencies?.transport;
  const researchStateDir = dependencies?.researchStateDir ?? asyncJobStateDir("research");
  const researchStateFile =
    dependencies?.researchStateFile ?? createProductionAsyncJobStateFile(researchStateDir);
  return {
    id: "parallel",
    credentialEnvVars: ["PARALLEL_API_KEY"],
    isConfigured: isParallelConfigured,
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set(["search", "research", "reader", "diagnostics"]);
    },
    create: (context: ProviderContext) =>
      new ParallelAdapter(context, { transport, researchStateFile, researchStateDir }),
  };
}
