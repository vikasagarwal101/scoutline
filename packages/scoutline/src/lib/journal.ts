/**
 * Journal writer — history-journal merge D2 (ticket T2a).
 *
 * Always-on research journaling (ADR-0008): every cache-miss
 * `search` call (read/research arrive in T3 through the same seam)
 * appends ONE self-contained `kind:"journal"` entry to the artifacts
 * log — the skeleton of the result, not the bodies. The entry never
 * references the response cache (`NO cacheRef`): skeletons are
 * permanent by ruling, so a cache clear leaves the log byte-identical.
 *
 * Composition over existing seams only: `appendLogEntry` (the locked
 * append), `newRequestId`, and `redactSecrets` at the write seam
 * (query text and skeleton URLs pass it — PRD AC9, pinned E2E).
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicReplaceFile } from "./config-store.js";
import {
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  withAsyncFileLock,
} from "./async-file-lock.js";
import {
  appendLogEntry,
  newRequestId,
  readLog,
  ARTIFACTS_LOG_FILENAME,
  ARTIFACTS_LOG_VERSION,
  ARTIFACTS_LOG_LOCK_IDENTITY,
  type ProviderRouting,
  type AppendLogEntryOptions,
  type ArtifactsLog,
  type SaveLogEntry,
} from "./artifacts.js";
import { redactSecrets } from "./redact.js";

/** Capabilities that journal (PRD AC3); the seam is capability-driven so T3 extends, not rewrites. */
export type JournalableCapability = "search" | "read" | "research";

/** One skeleton row: the identity of a result, never its content. */
export interface SkeletonItem {
  readonly url: string;
  readonly title: string;
}

/** Search skeleton (D2): url+title list of the result rows. */
export interface SearchSkeleton {
  readonly results: readonly SkeletonItem[];
}

/**
 * Read skeleton (D2, T3): the single {url,title} identity of the fetch —
 * `finalUrl` when the Provider rewrote the URL, else the requested url.
 */
export interface ReadSkeleton {
  readonly results: readonly [SkeletonItem];
}

/**
 * Research skeleton (D2, T3): the citations block — the url+title list
 * of the report's sources.
 */
export interface ResearchSkeleton {
  readonly results: readonly SkeletonItem[];
}

/** The skeleton payload by capability (T3 completes the union). */
export type JournalSkeleton = SearchSkeleton | ReadSkeleton | ResearchSkeleton;

/** The full journal entry (PRD AC2, ruling-locked field set). */
export interface JournalLogEntry {
  readonly kind: "journal";
  readonly requestId: string;
  /** ms epoch — the CALLER's injected instant; never Date.now() in here. */
  readonly timestamp: number;
  readonly capability: JournalableCapability;
  /**
   * Review must-fix 3: the ProviderRouting union — a single-provider run
   * records {mode:"single", effective, servedFrom}; a fan-out run
   * records {mode:"fanout", arms} faithfully (the same shape the save
   * hook logs). No silent skip of an always-on surface.
   */
  readonly provider: ProviderRouting;
  /** Redacted query text (search) or URL (read/research). */
  readonly query: string;
  /** sha256 hex of the normalized skeleton serialization. */
  readonly contentHash: string;
  /** The response-cache key the miss was served fresh against. */
  readonly cacheKey: string;
  readonly skeleton: JournalSkeleton;
  readonly tags?: readonly string[];
  /** Cross-link to the --save entry when the same run saved (PRD AC10). */
  readonly saveRef?: string;
}

/**
 * T2b repeat marker (PRD AC2 Variant B): the ~100B record of a
 * warm-cache re-ask. `repeatOf` is the requestId of the latest PRIOR
 * full journal entry sharing the same cacheKey (resolved through the
 * on-read map). Deliberately tiny — no query, no skeleton, no
 * contentHash, no cacheKey, no requestId of its own.
 */
export interface JournalRepeatMarker {
  readonly kind: "journal";
  readonly timestamp: number;
  readonly capability: JournalableCapability;
  /** The serving provider, cache-honestly ({servedFrom:"cache"} etc). */
  readonly provider: ProviderRouting;
  /** requestId of the referenced full journal entry. */
  readonly repeatOf: string;
  /** Cross-link to the --save entry when the same run saved (PRD AC10). */
  readonly saveRef?: string;
}

/**
 * Normalize a skeleton to the exact bytes contentHash is computed over
 * (and recall/export will compare later): recursively key-sorted JSON —
 * the buildProviderCacheKey request-hash idiom, so a differently-ordered
 * skeleton of the same rows hashes identically.
 */
export function normalizeSkeleton(skeleton: JournalSkeleton): unknown {
  const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortDeep((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return sortDeep(skeleton);
}

/** sha256 hex of the normalized skeleton serialization (the recall/export comparison anchor). */
export function skeletonContentHash(skeleton: JournalSkeleton): string {
  return createHash("sha256").update(JSON.stringify(normalizeSkeleton(skeleton))).digest("hex");
}

/**
 * Search skeleton builder: the url+title identity of each result row.
 * Accepts the normalized search result rows (`FormattedResult` shape —
 * rank/title/url/summary) and keeps only url+title, in row order.
 */
export function buildSearchSkeleton(
  results: readonly { readonly url?: string; readonly title?: string }[],
): SearchSkeleton {
  return {
    results: results.map((row) => ({
      url: typeof row.url === "string" ? row.url : "",
      title: typeof row.title === "string" ? row.title : "",
    })),
  };
}

/**
 * Read skeleton builder (T3): the single {url,title} identity of the
 * fetch. Accepts the normalized reader envelope (content shape carries
 * url/finalUrl/title; extract shape carries url/finalUrl — title null
 * there renders the url as the row's title so the skeleton stays
 * self-contained). `finalUrl` wins when the Provider rewrote the URL.
 */
export function buildReadSkeleton(result: {
  readonly url?: string;
  readonly finalUrl?: string;
  readonly title?: string | null;
}): ReadSkeleton {
  const url =
    typeof result.finalUrl === "string" && result.finalUrl.length > 0
      ? result.finalUrl
      : typeof result.url === "string"
        ? result.url
        : "";
  const title = typeof result.title === "string" && result.title.length > 0 ? result.title : url;
  return { results: [{ url, title }] };
}

/**
 * Research skeleton builder (T3): the citations block — the url+title
 * list of the report's sources, in citation order.
 */
export function buildResearchSkeleton(
  sources: readonly { readonly url?: string; readonly title?: string }[],
): ResearchSkeleton {
  return {
    results: sources.map((source) => ({
      url: typeof source.url === "string" ? source.url : "",
      title: typeof source.title === "string" ? source.title : "",
    })),
  };
}

/**
 * Structural guard for one journal record (the widened T1 body check).
 * T2b splits the dispatch: a record carrying `repeatOf` is a REPEAT
 * MARKER (the tiny shape — exactly {kind, timestamp, capability,
 * provider, repeatOf}); anything else is a FULL entry. The presence of
 * `repeatOf` is the marker-vs-full discriminator.
 */
export function asJournalEntry(value: unknown): JournalLogEntry | JournalRepeatMarker | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const e = value as Record<string, unknown>;
  if (e.kind !== "journal") return undefined;
  if (e.repeatOf !== undefined) return asJournalRepeatMarker(value);
  if (typeof e.requestId !== "string" || e.requestId.length === 0) return undefined;
  if (typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) return undefined;
  if (e.capability !== "search" && e.capability !== "read" && e.capability !== "research") {
    return undefined;
  }
  if (typeof e.query !== "string") return undefined;
  if (typeof e.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(e.contentHash)) return undefined;
  if (typeof e.cacheKey !== "string" || e.cacheKey.length === 0) return undefined;
  const provider = e.provider as Record<string, unknown> | undefined;
  if (typeof provider !== "object" || provider === null) return undefined;
  // Must-fix 3: the ProviderRouting union — single keeps the #108
  // servedFrom distinction; fanout carries {mode, arms}.
  if (provider.mode === "single") {
    if (typeof provider.effective !== "string" || provider.effective.length === 0) return undefined;
    if (provider.requested !== undefined && typeof provider.requested !== "string") return undefined;
    if (
      provider.servedFrom !== undefined &&
      provider.servedFrom !== "live" &&
      provider.servedFrom !== "cache"
    ) {
      return undefined;
    }
  } else if (provider.mode === "fanout") {
    if (
      !Array.isArray(provider.arms) ||
      provider.arms.length === 0 ||
      !provider.arms.every((arm) => typeof arm === "string" && arm.length > 0)
    ) {
      return undefined;
    }
    if (provider.requested !== undefined && typeof provider.requested !== "string") return undefined;
  } else {
    return undefined;
  }
  if (typeof e.skeleton !== "object" || e.skeleton === null || Array.isArray(e.skeleton)) {
    return undefined;
  }
  const skeleton = e.skeleton as Record<string, unknown>;
  if (!Array.isArray(skeleton.results)) return undefined;
  // T3 per-capability skeleton teeth: read is EXACTLY one row (the
  // single fetch identity); search/research carry a list. A read entry
  // with two rows is a wrong-capability write and fails validation.
  if (e.capability === "read" && skeleton.results.length !== 1) return undefined;
  for (const item of skeleton.results) {
    if (typeof item !== "object" || item === null) return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || typeof row.title !== "string") return undefined;
  }
  if (e.tags !== undefined && !Array.isArray(e.tags)) return undefined;
  if (e.tags !== undefined && !e.tags.every((t) => typeof t === "string")) return undefined;
  if (e.saveRef !== undefined && (typeof e.saveRef !== "string" || e.saveRef.length === 0)) {
    return undefined;
  }
  return value as JournalLogEntry;
}

/**
 * Structural guard for one T2b repeat marker: EXACTLY the tiny ruling
 * shape — `repeatOf` a non-empty string, capability on the enum,
 * provider the routing union, and NO full-body fields (a marker
 * carrying any of query/skeleton/contentHash/cacheKey/requestId is the
 * discriminator violated and fails validation — the fail-loud whole-log
 * path applies).
 */
function asJournalRepeatMarker(value: unknown): JournalRepeatMarker | undefined {
  const e = value as Record<string, unknown>;
  if (typeof e.repeatOf !== "string" || e.repeatOf.length === 0) return undefined;
  if (typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) return undefined;
  // T2b review F2: same Date-range guard full entries get (artifacts.ts)
  // — a finite-but-out-of-range ms value would throw RangeError in the
  // history renders (new Date(ms).toISOString()); fail validation here
  // so the whole-log fail-open path applies instead.
  if (!Number.isFinite(new Date(e.timestamp).getTime())) return undefined;
  if (e.capability !== "search" && e.capability !== "read" && e.capability !== "research") {
    return undefined;
  }
  if (e.requestId !== undefined) return undefined;
  if (e.query !== undefined) return undefined;
  if (e.contentHash !== undefined) return undefined;
  if (e.cacheKey !== undefined) return undefined;
  if (e.skeleton !== undefined) return undefined;
  // saveRef is the marker's ONE optional payload field (warm-cache save
  // cross-link, PRD AC10): same non-empty-string rule the full entry's
  // saveRef follows.
  if (e.saveRef !== undefined && (typeof e.saveRef !== "string" || e.saveRef.length === 0)) {
    return undefined;
  }
  const provider = e.provider as Record<string, unknown> | undefined;
  if (typeof provider !== "object" || provider === null) return undefined;
  if (provider.mode === "single") {
    if (typeof provider.effective !== "string" || provider.effective.length === 0) return undefined;
    if (provider.requested !== undefined && typeof provider.requested !== "string") return undefined;
    if (
      provider.servedFrom !== undefined &&
      provider.servedFrom !== "live" &&
      provider.servedFrom !== "cache"
    ) {
      return undefined;
    }
  } else if (provider.mode === "fanout") {
    if (
      !Array.isArray(provider.arms) ||
      provider.arms.length === 0 ||
      !provider.arms.every((arm) => typeof arm === "string" && arm.length > 0)
    ) {
      return undefined;
    }
    if (provider.requested !== undefined && typeof provider.requested !== "string") return undefined;
  } else {
    return undefined;
  }
  return value as JournalRepeatMarker;
}

/**
 * T2b cacheKey → latest full-entry requestId map (DESIGN D2): rebuilt
 * from the log ON READ — every full journal entry maps its cacheKey to
 * its requestId, last write wins. Markers resolve `repeatOf` through
 * it; an absent entry (cleared journal, pre-journal cache) makes the
 * hit journal-cold and the caller writes a FULL entry instead. The
 * rebuild-on-read is what keeps the map honest across processes and
 * after `history clear` (T6a).
 *
 * Sync variant takes a parsed log; async variant reads from disk.
 */
function buildJournalCacheKeyMapFromLog(log: Readonly<{ entries: readonly unknown[] }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of log.entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const journal = entry as Partial<JournalLogEntry> & Partial<JournalRepeatMarker>;
    if (journal.kind !== "journal") continue;
    if (journal.repeatOf !== undefined) continue; // markers never map
    if (typeof journal.cacheKey === "string" && typeof journal.requestId === "string") {
      map.set(journal.cacheKey, journal.requestId);
    }
  }
  return map;
}

export async function buildJournalCacheKeyMap(
  dir: string,
): Promise<Map<string, string>> {
  const { log } = await readLog(dir);
  return buildJournalCacheKeyMapFromLog(log);
}

/**
 * T2b: build the tiny repeat marker for a warm-cache re-ask. The
 * provider is the cache-honest routing (servedFrom "cache" for single,
 * or the fanout arms) — the caller passes what the capture cell holds.
 */
export function buildJournalRepeatMarker(input: {
  readonly capability: JournalableCapability;
  readonly provider: ProviderRouting;
  readonly repeatOf: string;
  readonly saveRef?: string;
  readonly now: () => number;
}): JournalRepeatMarker {
  return {
    kind: "journal",
    timestamp: input.now(),
    capability: input.capability,
    provider: input.provider,
    repeatOf: input.repeatOf,
    ...(input.saveRef !== undefined ? { saveRef: input.saveRef } : {}),
  };
}

export interface AppendJournalEntryOptions extends AppendLogEntryOptions {}

/**
 * Append one journal entry under the artifacts write lock — a thin
 * composition over {@link appendLogEntry} (the log IS index.json; the
 * lock, the atomic replace, and the 0600 discipline are inherited).
 * Strictly append-only: nothing here ever rewrites an existing entry.
 *
 * Callers that know they are in the cache-hit path should use
 * {@link appendJournalEntryMaybeRepeat} instead: its read-check-append
 * is atomic under the write lock, so two concurrent cache hits never
 * both write a full entry under the same cacheKey.
 */
export async function appendJournalEntry(
  dir: string,
  entry: JournalLogEntry | JournalRepeatMarker,
  options: AppendJournalEntryOptions = {},
): Promise<string | undefined> {
  // The union log type rides appendLogEntry's SaveLogEntry signature;
  // journal entries pass the same asLogEntry dispatch at read time.
  return appendLogEntry(dir, entry as unknown as Parameters<typeof appendLogEntry>[1], options);
}

/**
 * Append under the write lock, but ATOMICALLY decide whether to write a
 * full entry or a tiny repeat marker based on whether the current log
 * already has a full entry whose cacheKey matches.
 *
 * The read-check-append runs as one critical section under the
 * artifacts-write lock — two concurrent cache hits after `history clear`
 * never both write a full entry under the same cacheKey (the check-then-
 * act race the plan calls out).
 *
 * The pre-built full entry is the "journal-cold" default. If the
 * cacheKey map resolves to a prior full entry, the marker builder is
 * called with that requestId and the result is appended instead.
 */
export async function appendJournalEntryMaybeRepeat(
  dir: string,
  fullEntry: JournalLogEntry,
  makeMarker: (repeatOf: string) => JournalRepeatMarker,
  options: AppendJournalEntryOptions = {},
): Promise<string | undefined> {
  let notice: string | undefined;
  await withAsyncFileLock(
    dir,
    ARTIFACTS_LOG_LOCK_IDENTITY,
    async () => {
      const current = await readLog(dir);
      notice = current.notice;
      const map = buildJournalCacheKeyMapFromLog(current.log);
      const prior = fullEntry.cacheKey ? map.get(fullEntry.cacheKey) : undefined;
      const entry =
        prior !== undefined ? makeMarker(prior) : fullEntry;
      const next: ArtifactsLog = {
        version: ARTIFACTS_LOG_VERSION,
        entries: [...current.log.entries, entry as unknown as SaveLogEntry],
      };
      await atomicReplaceFile(
        join(dir, ARTIFACTS_LOG_FILENAME),
        `${JSON.stringify(next, null, 2)}\n`,
      );
    },
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      staleMs: options.staleMs ?? DEFAULT_LOCK_STALE_MS,
      setTimeout: options.setTimeout,
      timeoutLabel: "Artifacts log write",
    },
  );
  return notice;
}

export interface JournalInput {
  readonly capability: JournalableCapability;
  readonly provider: ProviderRouting;
  readonly query: string;
  readonly cacheKey: string;
  readonly skeleton: JournalSkeleton;
  readonly now: () => number;
  /** Resolved secrets for the redaction pass (the invocation seam's cell). */
  readonly secrets?: string[];
  readonly tags?: readonly string[];
  /** Set by the save hook when the same run saved (the saveRef cross-link). */
  readonly saveRef?: string;
}

/**
 * Build one full journal entry from the serving facts: redact the query
 * text and the skeleton (url+title rows) through {@link redactSecrets},
 * hash the NORMALIZED (unredacted-shape-preserving) skeleton, mint the
 * requestId from the injected clock. Redaction rewrites values only —
 * a redacted skeleton still passes the validator's shape check and
 * still serializes deterministically for the hash.
 */
export function buildJournalEntry(input: JournalInput): JournalLogEntry {
  const secrets = input.secrets;
  const redactedQuery = secrets
    ? (redactSecrets(input.query, secrets) as string)
    : input.query;
  const redactedSkeleton = secrets
    ? (redactSecrets(input.skeleton, secrets) as JournalSkeleton)
    : input.skeleton;
  // Review r3: ONE now() snapshot — requestId, timestamp, and every
  // derived field mint from the same instant (the buildNoteEntry rule);
  // a clock tick between two now() calls could otherwise embed an id
  // whose UTC stamp disagrees with the entry's own timestamp.
  const at = input.now();
  return {
    kind: "journal",
    requestId: newRequestId(at),
    timestamp: at,
    capability: input.capability,
    provider: input.provider,
    query: redactedQuery,
    contentHash: skeletonContentHash(redactedSkeleton),
    cacheKey: input.cacheKey,
    skeleton: redactedSkeleton,
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(input.saveRef !== undefined ? { saveRef: input.saveRef } : {}),
  };
}

/**
 * T4 (`history note`, DESIGN D5): the sentinel provider a hand-written
 * note carries. A note records work NO provider served, so the routing
 * must not read as a served run — `effective:"note"` is deliberately
 * outside the Provider registry ids, and `servedFrom` stays ABSENT
 * (neither "live" nor "cache": asserting a serve would claim a provider
 * call that never happened). The shape is NOT hand-choosable from the
 * CLI: the command exposes no `--provider`, and a smuggled real id is
 * mutation-pinned against.
 */
export const NOTE_PROVIDER_ROUTING: ProviderRouting = Object.freeze({
  mode: "single",
  effective: "note",
});

export interface NoteInput {
  readonly capability: JournalableCapability;
  /** Hand-written query text (search) or URL (read/research). */
  readonly query: string;
  /** Hand-supplied skeleton rows (url+title pairs, in given order). */
  readonly rows: readonly SkeletonItem[];
  readonly now: () => number;
  readonly secrets?: string[];
  readonly tags?: readonly string[];
}

/**
 * T4: build one explicit journal entry from hand-supplied note fields
 * through the SAME write-seam discipline as {@link buildJournalEntry}:
 * redaction over query + skeleton rows, contentHash over the normalized
 * skeleton, requestId minted from the injected clock. The cacheKey is
 * the note's own namespace (a note references no response-cache
 * partition — `note:` prefix keeps it out of any cache-key collision
 * with real serving keys).
 */
export function buildNoteEntry(input: NoteInput): JournalLogEntry {
  const secrets = input.secrets;
  const redactedQuery = secrets
    ? (redactSecrets(input.query, secrets) as string)
    : input.query;
  const redactedRows = secrets
    ? (redactSecrets(input.rows, secrets) as SkeletonItem[])
    : input.rows;
  const skeleton: JournalSkeleton = { results: redactedRows };
  // Review nit 2: ONE now() snapshot — requestId, timestamp, and the
  // note: cacheKey all mint from the same instant, so a clock tick
  // between calls can never split the entry's identity (a diverging
  // cacheKey would embed an id that matches nothing).
  const at = input.now();
  const requestId = newRequestId(at);
  return {
    kind: "journal",
    requestId,
    timestamp: at,
    capability: input.capability,
    provider: NOTE_PROVIDER_ROUTING,
    query: redactedQuery,
    contentHash: skeletonContentHash(skeleton),
    cacheKey: `note:${requestId}`,
    skeleton,
    ...(input.tags !== undefined && input.tags.length > 0 ? { tags: input.tags } : {}),
  };
}

// ---------------------------------------------------------------------------
// T5 — recall (the scoring engine; DESIGN D4)
// ---------------------------------------------------------------------------

/**
 * Tokenize text for recall scoring: lowercase, split on non-word runs
 * (Unicode-aware: `\p{L}`/`\p{N}` keep accented Latin, Cyrillic, CJK
 * atoms intact so recall works over non-ASCII research; underscore
 * stays a word char so snake_case identifiers keep theirs), drop
 * empties. Deterministic — no stopwords, no stemming.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0);
}

/** The recall corpus of one full journal entry: query + skeleton text tokens. */
function journalEntryTokens(entry: JournalLogEntry): string[] {
  return [
    ...tokenize(entry.query),
    ...entry.skeleton.results.flatMap((row) => [
      ...tokenize(row.url),
      ...tokenize(row.title),
    ]),
  ];
}

/** One scored recall result row (the data-envelope identity set). */
export interface JournalRecallResult {
  readonly requestId: string;
  readonly timestamp: number;
  readonly capability: JournalableCapability;
  /** Query-token overlap count against the entry's corpus. */
  readonly score: number;
  /** The newest ask: the entry timestamp, or a later repeat marker's. */
  lastAsked: number;
  readonly saveRef?: string;
  readonly query: string;
  /** The skeleton rows the entry recorded (per-result context). */
  readonly results: readonly SkeletonItem[];
}

export interface JournalRecallOptions {
  /** Upper bound on entry timestamps (INCLUSIVE: ≤, boundary-pinned). */
  readonly asOf?: number;
  readonly capability?: JournalableCapability;
  readonly limit?: number;
}

/**
 * Pure scoring over the log (DESIGN D4): tokenize the recall text,
 * score each FULL journal entry by query-token overlap against its
 * query + skeleton text, rank score DESC → recency DESC (lastAsked,
 * then requestId for full determinism). Repeat markers are NEVER
 * scored as separate results — they resolve to their referenced entry
 * and advance its `lastAsked` (only markers at/below `asOf` count).
 * Save entries are not text-searched (flags-only args); a save
 * surfaces only through its skeleton's `saveRef`. The log alone is
 * read: no master files, no cache, no network — ever.
 */
export function buildJournalRecall(
  log: readonly unknown[],
  text: string,
  options: JournalRecallOptions,
): JournalRecallResult[] {
  const querySet = new Set(tokenize(text));
  const byId = new Map<string, { row: JournalRecallResult; lastAsked: number }>();

  for (const raw of log) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (entry.kind !== "journal") continue; // saves never text-searched
    // asJournalEntry dispatches on repeatOf itself: a marker shape
    // returns a JournalRepeatMarker, everything else a full entry (or
    // undefined when the shape fails validation — skipped, never scored).
    const journal = asJournalEntry(raw);
    if (journal === undefined) continue;
    if ("repeatOf" in journal) {
      // Repeat marker: resolve, never score separately.
      const target = byId.get(journal.repeatOf);
      const markerTime = journal.timestamp;
      if (
        target !== undefined &&
        markerTime > target.lastAsked &&
        (options.asOf === undefined || markerTime <= options.asOf)
      ) {
        target.lastAsked = markerTime;
      }
      continue;
    }
    const full: JournalLogEntry = journal;
    if (options.capability !== undefined && full.capability !== options.capability) continue;
    if (options.asOf !== undefined && full.timestamp > options.asOf) continue;
    let score = 0;
    for (const token of journalEntryTokens(full)) {
      if (querySet.has(token)) score += 1;
    }
    if (score === 0) continue;
    byId.set(full.requestId, {
      row: {
        requestId: full.requestId,
        timestamp: full.timestamp,
        capability: full.capability,
        score,
        lastAsked: full.timestamp,
        ...(full.saveRef !== undefined ? { saveRef: full.saveRef } : {}),
        query: full.query,
        results: full.skeleton.results,
      },
      lastAsked: full.timestamp,
    });
  }

  return [...byId.values()]
    .map(({ row, lastAsked }) => ({ ...row, lastAsked }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.lastAsked - a.lastAsked ||
        (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0),
    )
    .slice(0, options.limit ?? Infinity);
}
