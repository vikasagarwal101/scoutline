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
import {
  appendLogEntry,
  newRequestId,
  readLog,
  type ProviderRouting,
  type AppendLogEntryOptions,
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

/** The skeleton payload by capability (read/research bodies arrive in T3). */
export type JournalSkeleton = SearchSkeleton;

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
  if (e.capability !== "search" && e.capability !== "read" && e.capability !== "research") {
    return undefined;
  }
  if (e.requestId !== undefined) return undefined;
  if (e.query !== undefined) return undefined;
  if (e.contentHash !== undefined) return undefined;
  if (e.cacheKey !== undefined) return undefined;
  if (e.skeleton !== undefined) return undefined;
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
 */
export async function buildJournalCacheKeyMap(
  dir: string,
): Promise<Map<string, string>> {
  const { log } = await readLog(dir);
  const map = new Map<string, string>();
  for (const entry of log.entries) {
    if (entry.kind !== "journal") continue;
    const journal = entry as unknown as Partial<JournalLogEntry> & Partial<JournalRepeatMarker>;
    if (journal.repeatOf !== undefined) continue; // markers never map
    if (typeof journal.cacheKey === "string" && typeof journal.requestId === "string") {
      map.set(journal.cacheKey, journal.requestId);
    }
  }
  return map;
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
  readonly now: () => number;
}): JournalRepeatMarker {
  return {
    kind: "journal",
    timestamp: input.now(),
    capability: input.capability,
    provider: input.provider,
    repeatOf: input.repeatOf,
  };
}

export interface AppendJournalEntryOptions extends AppendLogEntryOptions {}

/**
 * Append one journal entry under the artifacts write lock — a thin
 * composition over {@link appendLogEntry} (the log IS index.json; the
 * lock, the atomic replace, and the 0600 discipline are inherited).
 * Strictly append-only: nothing here ever rewrites an existing entry.
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
  return {
    kind: "journal",
    requestId: newRequestId(input.now()),
    timestamp: input.now(),
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
