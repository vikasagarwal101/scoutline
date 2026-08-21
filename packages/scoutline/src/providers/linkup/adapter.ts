/**
 * Linkup Provider Adapter.
 *
 * Implements the Linkup Provider Descriptor with the Search capability
 * on top of the direct-HTTP transport (`./client.ts`). The Adapter owns
 * credentials, transport lifecycle, Provider field mapping, and failure
 * normalization; shared execution owns cache and retry policy.
 *
 * Structurally cloned from `providers/tavily/adapter.ts` (Tavily/Parallel
 * research-poll analog, IMPLEMENTATION-CONTRACT analog-adapter table).
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import capability types, normalized errors, Provider identity
 *     types, and the Adapter-local credential and transport Modules.
 *   - Must NOT import command presentation, output mode, or another
 *     Provider's Adapter.
 *
 * Field mapping (Linkup wire → normalized):
 *   Search results[].name    -> title
 *   Search results[].url     -> url
 *   Search results[].content -> summary (falls back to snippet)
 *   Search results[].favicon -> (dropped)
 *   Search results[].type    -> (dropped)
 *
 * Control mapping (SearchControls → Linkup-native API params):
 *   domain      -> includeDomains: [domain]
 *   recency     -> fromDate/toDate ISO date window (oneDay/oneWeek/
 *                  oneMonth/oneYear; noLimit omits dates)
 *   contentSize -> depth (high→"deep", medium/absent→"standard")
 *   topic       -> keyword appended to q
 *   location    -> locale keyword appended to q
 *   type        -> REJECTED (UnsupportedOptionError)
 *
 * Field mapping (Linkup wire → normalized, reader /fetch):
 *   url      -> finalUrl (falls back to the requested url)
 *   markdown -> content (empty → ApiError; never cache an empty fetch)
 *   rawHtml / images -> (dropped)
 *   renderJs is always requested true (SPA compatibility)
 *
 * Research lifecycle (mirrors createExaDescriptor, Linkup SPEC §Research):
 *   POST /research              — submit task once (no retry, double-charge
 *                                 prevention on a usage-based endpoint)
 *   GET  /research/:id          — poll every LINKUP_RESEARCH_POLL_INTERVAL_MS
 *                                 (default 5000) until completed/failed/not_found
 *   updatedAt / output.answer   -> report (canonical object output)
 *   output (string)             -> report (flat output fallback)
 *   markdown                    -> report (flat markdown fallback)
 *   output.sources[].name       -> sources[].title (fallback url)
 *   output.sources[].url        -> sources[].url
 *   `model` mapping: mini→"S", auto→"L", pro→"XL" (reasoningDepth)
 *   transient poll errors (429/5xx/network/timeout) are retried up to
 *   MAX_POLL_RETRIES=3 before propagating; failed poll -> ApiError 500
 *   with no raw body in the message.
 *   `not_found` triggers at most ONE recreation (Tavily/Parallel guard).
 *   State-file persistence via createAsyncJobStateFile + computeAsyncJobStateHash
 *   double-charge prevention; resume on Ctrl-C / crash.
 */

import type {
  ProviderAdapter,
  ProviderCapability,
  ProviderContext,
  ProviderDescriptor,
} from "../types.js";
import type {
  SearchCacheIdentity,
  SearchCapability,
  SearchControls,
  SearchRecency,
  SearchRequest,
  SearchSource,
} from "../../capabilities/search.js";
import type {
  ReaderCacheIdentity,
  ReaderCapability,
  ReaderFetchRequest,
  ReaderFetchResult,
  ReaderOperation,
} from "../../capabilities/reader.js";
import { decodeReaderFetchResult } from "../../capabilities/reader.js";
import type {
  ResearchCapability,
  ResearchOperation,
  ResearchRequest,
  ResearchResult,
  ResearchSource,
} from "../../capabilities/research.js";
import { decodeResearchResult } from "../../capabilities/research.js";
import type { AsyncJobState, AsyncJobStateFile } from "../../lib/async-job-state.js";
import {
  computeAsyncJobStateHash,
  createProductionAsyncJobStateFile,
} from "../../lib/async-job-state.js";
import { asyncJobStateDir } from "../../lib/cache.js";
import type { CacheIdentity } from "../../lib/execution.js";
import { ApiError, NetworkError, TimeoutError, UnsupportedOptionError, ValidationError } from "../../lib/errors.js";
import { hashLinkupApiKey, isLinkupConfigured, requireLinkupApiKey } from "./credentials.js";
import {
  createLinkupResearch,
  fetchLinkupFetch,
  fetchLinkupSearch,
  pollLinkupResearch,
  type LinkupFetchWireRequest,
  type LinkupResearchPollResult,
  type LinkupResearchWireRequest,
  type LinkupSearchWireRequest,
  type LinkupTransportDeps,
} from "./client.js";

/**
 * Dependencies the Linkup Adapter accepts. The unified `transport`
 * seam carries `fetch` and timer injection; `now` makes the
 * recency→date window deterministic in tests.
 */
export interface LinkupAdapterDependencies {
  /** Optional transport injection (fetch, timers, env). */
  readonly transport?: LinkupTransportDeps;
  /**
   * Injectable clock for the recency→fromDate window. Defaults to
   * `Date.now`; tests pass a fixed epoch.
   */
  readonly now?: () => number;
  /** Optional Research state-file port (double-charge prevention). */
  readonly researchStateFile?: AsyncJobStateFile;
}

// ---------------------------------------------------------------------------
// Provider-owned credential fingerprint
// ---------------------------------------------------------------------------

function credentialFingerprint(apiKey: string): string {
  return hashLinkupApiKey(apiKey);
}

function resolveApiKey(env: NodeJS.ProcessEnv): string {
  return requireLinkupApiKey(env);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Control mapping (SearchControls → Linkup-native API params)
// ---------------------------------------------------------------------------

/**
 * Map a `SearchRecency` to a `fromDate`/`toDate` ISO 8601 date window
 * (YYYY-MM-DD). `noLimit` (and unknown values) return `undefined` so
 * no date fields are sent.
 */
function mapRecencyToDateWindow(
  recency: SearchRecency,
  now: () => number,
): { fromDate: string; toDate: string } | undefined {
  const current = new Date(now());
  const from = new Date(now());
  switch (recency) {
    case "oneDay":
      from.setDate(from.getDate() - 1);
      break;
    case "oneWeek":
      from.setDate(from.getDate() - 7);
      break;
    case "oneMonth":
      from.setMonth(from.getMonth() - 1);
      break;
    case "oneYear":
      from.setFullYear(from.getFullYear() - 1);
      break;
    default:
      return undefined;
  }
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: current.toISOString().slice(0, 10),
  };
}

/**
 * Map a Provider-neutral `SearchRequest` into a Linkup-native wire
 * request body.
 *
 *   q             -> q (with topic/location keywords appended)
 *   domain        -> includeDomains: [domain]
 *   recency       -> fromDate/toDate date window
 *   contentSize   -> depth (high→"deep", else "standard")
 */
function mapSearchControls(request: SearchRequest, now: () => number): LinkupSearchWireRequest {
  const controls: Readonly<SearchControls> | undefined = request.controls;
  const payload: {
    q: string;
    depth: "standard" | "deep";
    includeDomains?: readonly string[];
    fromDate?: string;
    toDate?: string;
  } = {
    q: request.query,
    depth: controls?.contentSize === "high" ? "deep" : "standard",
  };
  if (controls?.domain) {
    payload.includeDomains = [controls.domain];
  }
  if (controls?.recency) {
    const window = mapRecencyToDateWindow(controls.recency, now);
    if (window) {
      payload.fromDate = window.fromDate;
      payload.toDate = window.toDate;
    }
  }
  // Topic and location have no native Linkup field; they are injected
  // as keyword terms into the query (same pattern as Z.AI/MiniMax
  // topic handling).
  if (controls?.topic) {
    payload.q = `${payload.q} ${controls.topic}`;
  }
  if (controls?.location) {
    payload.q = `${payload.q} ${controls.location}`;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Linkup search response into `SearchSource[]`.
 *
 *   results[].name    -> title (missing → "")
 *   results[].url     -> url
 *   results[].content -> summary (falls back to snippet, then "")
 *   results[].favicon -> (dropped)
 *   results[].type    -> (dropped)
 *
 * Any malformed shape is a retryable `ApiError` 500.
 */
function normalizeLinkupSearchResults(raw: unknown): readonly SearchSource[] {
  if (!isPlainObject(raw)) {
    throw new ApiError("Linkup search returned a malformed response", 500);
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw new ApiError("Linkup search returned a malformed response", 500);
  }
  const out: SearchSource[] = [];
  for (const entry of results) {
    if (!isPlainObject(entry)) {
      throw new ApiError("Linkup search returned a malformed response", 500);
    }
    const url = entry.url;
    if (typeof url !== "string") {
      throw new ApiError("Linkup search returned a malformed response", 500);
    }
    const title = typeof entry.name === "string" ? entry.name : "";
    const summary =
      typeof entry.content === "string"
        ? entry.content
        : typeof entry.snippet === "string"
          ? entry.snippet
          : "";
    out.push({ title, url, summary, source: "linkup" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search Capability
// ---------------------------------------------------------------------------

interface LinkupSearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: LinkupTransportDeps;
  readonly now: () => number;
}

function createLinkupSearchCapability(
  options: LinkupSearchCapabilityOptions,
): SearchCapability {
  const { env, transport, now } = options;

  const capability: SearchCapability = {
    validate(request: SearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Search query must contain at least one non-whitespace character",
        );
      }
      // Linkup supports domain, recency, contentSize, topic, and
      // location (as query keywords). type (video content axis) is not
      // supported by Linkup (Brave supplies video), so it is rejected
      // before any credential resolution or transport call.
      if (request.controls?.type !== undefined) {
        throw new UnsupportedOptionError("linkup", "search", "type");
      }
    },

    cacheIdentity(request: SearchRequest): SearchCacheIdentity {
      const apiKey = resolveApiKey(env);
      const identityRequest: { query: string; controls?: SearchControls } = {
        query: request.query,
      };
      if (request.controls) {
        identityRequest.controls = request.controls;
      }
      return {
        provider: "linkup",
        capability: "search",
        credentialFingerprint: credentialFingerprint(apiKey),
        request: identityRequest,
        // Linkup never probes legacy keys — no legacyCandidates.
      };
    },

    async invoke(request: SearchRequest): Promise<readonly SearchSource[]> {
      capability.validate(request);

      const apiKey = resolveApiKey(env);
      const wireRequest = mapSearchControls(request, now);
      const raw = await fetchLinkupSearch(apiKey, wireRequest, transport);
      return normalizeLinkupSearchResults(raw);
    },
  };

  return capability;
}

// ---------------------------------------------------------------------------
// Reader Capability
// ---------------------------------------------------------------------------

/**
 * Reader URL guard (Linkup SPEC: invalid URL → `ValidationError` before
 * any credential resolution or transport call). Mirrors the Tavily
 * reader guard.
 */
function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0) {
    throw new ValidationError("Linkup reader URL must be a non-empty string");
  }
  if (!/^https?:\/\//.test(url)) {
    throw new ValidationError("URL must start with http:// or https://");
  }
}

/**
 * Normalize a raw Linkup /fetch response into a `ReaderFetchResult`.
 *
 *   url      -> finalUrl (falls back to the requested url)
 *   markdown -> content (non-string or empty → ApiError; the Reader
 *               contract requires non-empty content — never cache an
 *               empty fetch)
 *   rawHtml  -> (dropped)
 *   images   -> (dropped)
 *
 * Linkup's wire shape carries no page title, so `title` is `null`.
 */
function normalizeLinkupFetchResult(url: string, raw: unknown): ReaderFetchResult {
  if (!isPlainObject(raw)) {
    throw new ApiError("Linkup fetch returned a malformed response", 500);
  }
  const markdown = raw.markdown;
  if (typeof markdown !== "string" || markdown.length === 0) {
    throw new ApiError("Linkup fetch returned a malformed response", 500);
  }
  const finalUrl = typeof raw.url === "string" && raw.url.length > 0 ? raw.url : url;
  return {
    schemaVersion: 1,
    url,
    finalUrl,
    title: null,
    content: markdown,
    contentFormat: "markdown",
  };
}

interface LinkupReaderCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: LinkupTransportDeps;
}

function createLinkupReaderCapability(
  options: LinkupReaderCapabilityOptions,
): ReaderCapability {
  const { env, transport } = options;

  const fetch: ReaderOperation<ReaderFetchRequest, ReaderFetchResult> = {
    kind: "reader-fetch",

    validate(request: ReaderFetchRequest): void {
      assertHttpUrl(request.url);
    },

    cacheIdentity(
      request: ReaderFetchRequest,
    ): ReaderCacheIdentity<ReaderFetchRequest, ReaderFetchResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "linkup",
        capability: "reader",
        operation: "reader-fetch",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
        // Linkup never probes legacy keys — no legacyCandidates.
        legacyCandidates: [],
      };
    },

    decodeCached(value: unknown): ReaderFetchResult | null {
      return decodeReaderFetchResult(value);
    },

    async invoke(request: ReaderFetchRequest): Promise<ReaderFetchResult> {
      fetch.validate(request);

      const apiKey = resolveApiKey(env);
      // renderJs is always true (Linkup SPEC): headless-browser render so
      // dynamic SPAs extract like static pages.
      const wireRequest: LinkupFetchWireRequest = {
        url: request.url,
        renderJs: true,
      };
      const raw = await fetchLinkupFetch(apiKey, wireRequest, transport);
      return normalizeLinkupFetchResult(request.url, raw);
    },
  };

  return { fetch };
}


// ---------------------------------------------------------------------------
// Research Capability (async submit/poll lifecycle — Linkup SPEC §Research)
// ---------------------------------------------------------------------------

/**
 * Default polling interval between `GET /research/:id` calls. Overridable
 * via `LINKUP_RESEARCH_POLL_INTERVAL_MS` in the transport env so tests
 * can poll instantly.
 */
const DEFAULT_RESEARCH_POLL_INTERVAL_MS = 5000;

function resolvePollIntervalMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.LINKUP_RESEARCH_POLL_INTERVAL_MS;
  const parsed = parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RESEARCH_POLL_INTERVAL_MS;
}

/**
 * Build an abortable `sleep(ms)` from the injected timers. Cloned from
 * the Tavily/Exa adapters — same mechanism, different transport type.
 * A non-positive interval resolves via `setImmediate`; an aborted
 * signal rejects with `TimeoutError` so the poll loop unwinds promptly.
 */
function makeSleep(
  deps: LinkupTransportDeps | undefined,
  signal?: AbortSignal,
): (ms: number) => Promise<void> {
  const setT = deps?.setTimeout ?? setTimeout;
  const clearT = deps?.clearTimeout ?? clearTimeout;
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new TimeoutError(0, "Research polling aborted"));
        return;
      }
      if (ms <= 0) {
        setImmediate(() => {
          if (signal?.aborted) {
            reject(new TimeoutError(0, "Research polling aborted"));
            return;
          }
          resolve();
        });
        return;
      }
      const onAbort = (): void => {
        clearT(id);
        reject(new TimeoutError(0, "Research polling aborted"));
      };
      const id = setT(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort);
    });
}

function isEexistError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

/**
 * Map `ResearchRequest.model` -> Linkup `reasoningDepth` (SPEC §Research):
 *   mini -> "S"
 *   auto -> "L" (default)
 *   pro  -> "XL"
 */
function mapModelToReasoningDepth(
  model: ResearchRequest["model"],
): LinkupResearchWireRequest["reasoningDepth"] {
  switch (model) {
    case "mini":
      return "S";
    case "pro":
      return "XL";
    case "auto":
    default:
      return "L";
  }
}

/**
 * Normalize a completed Linkup research poll into a `ResearchResult`.
 *
 *   output.answer     -> report (canonical object output)
 *   output (string)   -> report (flat output fallback)
 *   markdown          -> report (flat markdown fallback)
 *   output.sources[]  -> sources[] ({name, url, snippet} -> {title, url})
 *   sources[]         -> sources[] (top-level fallback)
 *   model             -> echoed from the request (default "auto")
 */
function normalizeLinkupResearchResult(
  poll: LinkupResearchPollResult,
  request: ResearchRequest,
): ResearchResult {
  let report: string | undefined;
  if (isPlainObject(poll.output)) {
    const answer = poll.output.answer;
    if (typeof answer === "string") report = answer;
  } else if (typeof poll.output === "string") {
    report = poll.output;
  }
  if (report === undefined && typeof poll.markdown === "string") {
    report = poll.markdown;
  }
  if (report === undefined) {
    throw new ApiError("Linkup research returned a malformed response", 500);
  }

  let rawSources: unknown = undefined;
  if (isPlainObject(poll.output) && poll.output.sources !== undefined) {
    rawSources = poll.output.sources;
  } else if (poll.sources !== undefined) {
    rawSources = poll.sources;
  }
  const sources: ResearchSource[] = [];
  if (Array.isArray(rawSources)) {
    for (const entry of rawSources) {
      if (!isPlainObject(entry)) continue;
      const url = entry.url;
      if (typeof url !== "string" || url.length === 0) continue;
      const title =
        typeof entry.name === "string" && entry.name.length > 0 ? entry.name : url;
      sources.push({ title, url });
    }
  }

  return {
    schemaVersion: 1,
    query: request.query,
    model: request.model ?? "auto",
    report,
    sources,
  };
}

/**
 * True when a poll GET error is safe to retry. The poll is idempotent
 * — retrying never creates a new run or charges the account. Only
 * transient failures (429, 5xx, network, timeout) qualify; auth/quota/
 * validation errors are terminal and propagate immediately.
 */
function isTransientPollError(err: unknown): boolean {
  if (err instanceof ApiError && typeof err.statusCode === "number") {
    return err.statusCode === 429 || (err.statusCode >= 500 && err.statusCode <= 599);
  }
  if (err instanceof NetworkError || err instanceof TimeoutError) return true;
  return false;
}

/**
 * POST /research to create a task, then persist its task id in the
 * state file atomically. On EEXIST (a concurrent invocation already
 * created a task for this request), read the existing state file and
 * return its task id instead — the concurrent task is polled, not
 * duplicated.
 */
async function createResearchTask(
  apiKey: string,
  request: ResearchRequest,
  identityHash: string,
  stateFile: AsyncJobStateFile,
  transport: LinkupTransportDeps | undefined,
): Promise<string> {
  const wireRequest: LinkupResearchWireRequest = {
    q: request.query,
    mode: "research",
    reasoningDepth: mapModelToReasoningDepth(request.model),
  };
  const created = await createLinkupResearch(apiKey, wireRequest, transport);
  const taskId = created.id;

  const state: AsyncJobState = {
    requestId: taskId,
    identityHash,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  try {
    await stateFile.write(identityHash, state);
  } catch (err) {
    if (isEexistError(err)) {
      const existing = await stateFile.read(identityHash);
      if (existing !== null) {
        return existing.requestId;
      }
    } else {
      throw err;
    }
  }
  return taskId;
}

interface LinkupResearchCapabilityOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly transport?: LinkupTransportDeps;
  readonly researchStateFile: AsyncJobStateFile;
}

function createLinkupResearchCapability(
  options: LinkupResearchCapabilityOptions,
): ResearchCapability {
  const { env, transport, researchStateFile } = options;

  const run: ResearchOperation = {
    kind: "research-fetch",

    validate(request: ResearchRequest): void {
      if (!request || typeof request.query !== "string" || request.query.trim() === "") {
        throw new ValidationError(
          "Research query must contain at least one non-whitespace character",
        );
      }
    },

    cacheIdentity(request: ResearchRequest): CacheIdentity<ResearchRequest, ResearchResult> {
      const apiKey = resolveApiKey(env);
      return {
        provider: "linkup",
        capability: "research",
        credentialFingerprint: credentialFingerprint(apiKey),
        request,
      };
    },

    decodeCached(value: unknown): ResearchResult | null {
      return decodeResearchResult(value);
    },

    async invoke(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchResult> {
      run.validate(request);

      const apiKey = resolveApiKey(env);
      const credFingerprint = credentialFingerprint(apiKey);
      const identityHash = computeAsyncJobStateHash({
        provider: "linkup",
        capability: "research",
        credentialFingerprint: credFingerprint,
        request,
      });

      const pollIntervalMs = resolvePollIntervalMs(transport?.env);
      const sleep = makeSleep(transport, signal);

      // 1. Check for an in-flight task (resume after Ctrl-C / crash).
      //    A valid state file with a pending/in_progress status means a
      //    task was already created server-side — poll it instead of
      //    creating a second one (double-charge prevention).
      const existingState = await researchStateFile.read(identityHash);
      let taskId: string;

      if (existingState !== null) {
        taskId = existingState.requestId;
      } else {
        // 2. No in-flight task: POST to create one. NO retry — a
        //    transient POST failure is terminal (double-charge
        //    prevention on a usage-based endpoint).
        taskId = await createResearchTask(
          apiKey,
          request,
          identityHash,
          researchStateFile,
          transport,
        );
      }

      // 3. Poll loop until terminal status. The GET (poll) is
      //    idempotent and safe to retry — transient 429/5xx/network
      //    errors on poll MUST NOT terminate a paid research run that
      //    is still active server-side. Transient poll failures are
      //    retried (bounded by MAX_POLL_RETRIES) before propagating.
      const MAX_POLL_RETRIES = 3;
      let consecutivePollFailures = 0;
      let recreatedAfterNotFound = false;
      for (;;) {
        if (signal?.aborted) {
          throw new TimeoutError(0, "Research polling aborted");
        }
        let poll: LinkupResearchPollResult;
        try {
          poll = await pollLinkupResearch(apiKey, taskId, transport);
          consecutivePollFailures = 0;
        } catch (pollErr) {
          if (isTransientPollError(pollErr) && consecutivePollFailures < MAX_POLL_RETRIES) {
            consecutivePollFailures++;
            await sleep(pollIntervalMs);
            continue;
          }
          throw pollErr;
        }

        if (poll.status === "completed") {
          await researchStateFile.remove(identityHash);
          return normalizeLinkupResearchResult(poll, request);
        }

        if (poll.status === "failed") {
          await researchStateFile.remove(identityHash);
          throw new ApiError("Linkup research task failed", 500);
        }

        if (poll.status === "not_found") {
          // 404 — server-side task expired/disappeared. Allow at most ONE
          // recreation; a second 404 terminates rather than risk unbounded
          // paid creations (Tavily/Parallel guard).
          if (recreatedAfterNotFound) {
            await researchStateFile.remove(identityHash);
            throw new ApiError(
              "Linkup research task not found after recreation",
              500,
            );
          }
          recreatedAfterNotFound = true;
          await researchStateFile.remove(identityHash);
          taskId = await createResearchTask(
            apiKey,
            request,
            identityHash,
            researchStateFile,
            transport,
          );
          continue;
        }

        // pending or processing: sleep and poll again.
        await sleep(pollIntervalMs);
      }
    },
  };

  return { run };
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build the Linkup Provider Descriptor. The descriptor advertises the
 * capabilities the constructed Adapter supplies and constructs an
 * Adapter whose Search and Reader Capabilities own credentials, transport,
 * Provider field mapping, and failure normalization. Construction is
 * side-effect-free; the transport is invoked per Capability call.
 * Tests pass `transport` (typically a fake-fetch wrapper); production
 * uses the no-argument factory which resolves to the global `fetch`
 * and timers inside the transport Module.
 */
export function createLinkupDescriptor(
  dependencies?: LinkupAdapterDependencies,
): ProviderDescriptor {
  const transport = dependencies?.transport;
  const now = dependencies?.now ?? (() => Date.now());
  const researchStateFile =
    dependencies?.researchStateFile ??
    createProductionAsyncJobStateFile(asyncJobStateDir("research"));

  return {
    id: "linkup",
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return isLinkupConfigured(env);
    },
    capabilities(): ReadonlySet<ProviderCapability> {
      return new Set<ProviderCapability>(["search", "reader", "research"]);
    },
    create(context: ProviderContext): ProviderAdapter {
      const search = createLinkupSearchCapability({
        env: context.env,
        transport,
        now,
      });
      const reader = createLinkupReaderCapability({
        env: context.env,
        transport,
      });
      const research = createLinkupResearchCapability({
        env: context.env,
        transport,
        researchStateFile,
      });
      return { id: "linkup", search, reader, research };
    },
    credentialEnvVars: ["LINKUP_API_KEY"],
  };
}
