/**
 * Investigation orchestrator (investigate-pipeline lane, Ticket T4;
 * docs/plans/investigate-pipeline DESIGN.md D3, PRD AC-3/AC-4/AC-9/
 * AC-10; ADR-0013).
 *
 * Thin, data-returning composition of the seams `search` and `read`
 * already export — no bespoke merge fork, no local fan-out copy, no
 * transport of its own:
 *
 *   1. planSubQueries (T2, injected loadContextText — no filesystem).
 *   2. resolveFanoutPlan over the resolved provider pin (AC-1 tiers,
 *      the same inputs handleSearch passes).
 *   3. Grid execution through the exported seams: fan-out mode runs
 *      executeFanoutPlan; single mode runs the exported search() with
 *      {merge: N > 1} over the escaped-pipe join of the sub-queries
 *      (the exact context-mode join precedent, index.ts handleSearch).
 *   4. Top --sources distinct sources = the first K rows of the merged
 *      FormattedResult[] (mergeResults already collapsed near-dup
 *      clusters to representatives — a near-dup pair IS one row).
 *   5. Reads: bounded-concurrency pool (default 4) over the reader
 *      capability seam via executeReaderOperation, one client per
 *      read (descriptor.create per read), closed in `finally`.
 *   6. extractPassages (T3) per read result.
 *   7. EvidencePack assembly per the T1 types.
 *
 * `--synthesize` (T7, PRD AC-7, DESIGN D6, ADR-0013 §2) is the explicit
 * Z.AI-only escape hatch and is ADDITIVE-ONLY BY CONSTRUCTION: the pack
 * is fully assembled (searches, reads, extraction, coverage) BEFORE the
 * synthesis dep is ever called, so the brief can only ever be ADDED as
 * the LAST key — a failed synthesis is the invocation's terminal error
 * and never degrades, shrinks, or reorders the pack. The command holds
 * no transport: construction is handler-seam wiring, exactly like every
 * other capability, and the dep is injected.
 *
 * Reader supplier selection mirrors handleRead: the FIRST descriptor
 * in registry order whose injected `readerCapabilityFor` resolves a
 * ReaderCapability serves every read (the same first-configured-capable
 * order read uses; cross-provider fallback per failed read is the
 * index.ts handler seam's business, T6). A supplier that rejects a
 * source terminally classifies as `reader-failed:<code>`; a supplier
 * that cannot serve the capability at all classifies as
 * `no-reader-supplier`. Unread rows carry reason codes only
 * (redacted, house rule); the pool continues past them;
 * `sourcesRead` counts successes only.
 *
 * Consumption linearity: every billable arm and read attempt records
 * exactly one event (N×M + K) because the shared executors emit per
 * invoke and the orchestrator never double-reads a URL.
 *
 * `--isolated` is ACCEPTED, never rejected: the pid-segment cache
 * behavior is the main() handler seam's job (T6) — the command has no
 * cache-directory logic of its own; the injected cache IS the
 * (possibly isolated) production cache. Journal entry/marker WRITING
 * lives at the index.ts descriptor seam (journalingDescriptors /
 * captureServingDescriptors): this command consumes the injected
 * descriptor list verbatim, so capture-wrapped descriptors keep
 * stamping servedFrom/cacheKey cells the journal hook consumes — the
 * T4-level guarantee (asserted by the seam-passthrough test); journal
 * wiring itself is deferred to T6 (journal.ts / index.ts untouched).
 */

import { createHash } from "node:crypto";

import type { CommandContext, CommandResult } from "../command-invocation.js";
import type { ReaderCapability, ReaderFetchResult } from "../capabilities/reader.js";
import type { EvidencePack, EvidenceSource } from "../capabilities/investigation.js";
import type { FusionMode } from "../lib/config-store.js";
import { buildProviderCacheKey, type ResponseCache } from "../lib/cache.js";
import type { RetryPolicy } from "../lib/execution.js";
import { executeReaderOperation } from "../lib/execution.js";
import type { ConsumptionSink } from "../lib/consumption.js";
import type { ProviderDescriptor, ProviderId } from "../providers/types.js";
import { UnsupportedCapabilityError, ValidationError } from "../lib/errors.js";
import { redactSecrets } from "../lib/redact.js";
import { applyBudget, type BudgetCompaction, type LadderRule } from "../lib/output-budget.js";
import { persistCompaction } from "../lib/output-budget-persistence.js";
import {
  executeFanoutPlan,
  resolveFanoutPlan,
  search,
  type FanoutPlan,
  type FormattedResult,
} from "./search.js";
import { deriveTemplateTopic, planSubQueries } from "../lib/investigate-planner.js";
import { extractPassages } from "../lib/investigate-extract.js";
import { SHARED_PROVIDER_FLAG_IDS } from "../providers/catalog.js";

// ---------------------------------------------------------------------------
// Help (T6; mirrors SEARCH_HELP's shape: usage, controls, tier notes, cost)
// ---------------------------------------------------------------------------

/**
 * `--synthesize` escape hatch (T7). The deterministic brief prompt: the
 * bare question, the planned sub-query grid, and the extracted passage
 * quotes (bounded). No clock, no randomness — identical fixtures produce
 * a byte-identical prompt.
 */
export interface SynthesisPrompt {
  readonly question: string;
  readonly subQueries: readonly string[];
  /** Extracted passage quotes, in pack order, capped at
   * {@link SYNTHESIS_QUOTE_CAP}. */
  readonly quotes: readonly string[];
}

/**
 * Passage-quote cap for the brief prompt. Bounded so the prompt cannot
 * grow with the read pool: 20 quotes ≈ the first few sources' passages,
 * well inside the Z.AI chat context even at the passage cap (5 per
 * source). Deterministic (first N in pack order), never sampled.
 */
export const SYNTHESIS_QUOTE_CAP = 20;

/**
 * The synthesis dep shape. `synthesize?` is threaded from the handler
 * seam (index.ts), which owns the transport — the command never
 * constructs one. Production passes a Z.AI chat-completions caller;
 * tests pass a fixture.
 */
export type SynthesizeBrief = (prompt: SynthesisPrompt) => Promise<string>;

/**
 * `investigate --help` (T6/T7). The command's rejected-flag contract is
 * part of the surface: --depth/--arms/--budget-tokens DO NOT EXIST (PRD
 * AC-1 — the rejection is the feature), and --context-stdin is
 * deliberately not investigate's (search-only spelling; pipes and
 * --context cover the sub-query sources).
 */
export const INVESTIGATE_HELP = `
Investigate Command - Local investigation pipeline (EvidencePack)

Usage: scoutline investigate <question> [options]

Plans sub-queries, fans out search, merges by fusion, reads the top
sources, and extracts deterministic passages into an EvidencePack
(schemaVersion 1). The pack is data, not prose: agents consume it
directly; text output modes fall back to JSON. Warm re-runs replay the
response cache (coverage.cacheHits reflects it).

Provider selection (precedence: explicit flag, then SCOUTLINE_PROVIDER, then zai):
  --provider <${SHARED_PROVIDER_FLAG_IDS}>   Select the search provider. A
        comma-list or \`all\` fans out over every listed arm (search's
        activation tiers, verbatim); a single id runs one arm;
        \`scoutline config set fanout true\` (no pin) is a standing fan-out.

Cost: the run bills N sub-queries × M arms searches + up to K sources
(per-source reader supplier attempts can bill more than one read) —
one stderr notice states the exact arithmetic before any billable work.

Sub-query planning (precedence: pipes > --context > template):
  Pipes   An unescaped \`|\` in the question splits it into explicit
          sub-queries (the --merge grammar; escape with \\| for a
          literal pipe). Capped at 8 — a longer split fails loud
          with VALIDATION_ERROR (never silently truncated). Wins over
          --context with a stderr notice.
  --context <path>  Read a local notes file and derive up to 8
          sub-queries (headings/questions), exactly like search.
  Template  Deterministic transforms of the bare question (original,
          key terms, overview/evidence/criticism), deduped, capped at 5.

Options:
  --provider <ids>    Comma-list, \`all\`, or a single id (fan-out tiers
                      above).
  --context <path>    Local notes file deriving sub-queries (max 256 KiB;
                      never leaves the machine — only the derived
                      sub-query strings are searched).
  --sources <n>       How many distinct post-cluster sources to read
                      (positive integer; default 5).
  --max-chars <n>     Fit the pack in ~<n> chars (passages trim first —
                      quotes truncate, charRange adjusts — then late
                      sources drop; question/subQueries/coverage are
                      never cut; the full untrimmed pack is saved to the
                      artifacts store — recover with
                      "scoutline history show").
  --synthesize        Attach an ADDITIVE \`brief\` (Z.AI chat) to the pack.
                      Absent by default. Z.AI-only: it ignores --provider
                      (a stderr notice fires when another provider is
                      pinned) and always synthesizes through Z.AI. The
                      pack is assembled first, so the brief only ever
                      ADDS a key — a synthesis failure is this run's
                      terminal error, never a degraded pack.
  --no-cache          Skip the response cache for this run's searches
                      and reads.
  --no-journal        Skip the research journal entries for this run's
                      underlying search/read ops.
  --save [<path>]     Save the pack as a clean report (global flag;
                      master copy + optional export; refuses an
                      existing target without --save-force).
  --isolated          Process-isolated state (accepted; no stateful
                      directory exists — pure cache replay on re-run).

Not investigate's flags (rejected with VALIDATION_ERROR — by design):
  --depth             There is no depth axis; planning is deterministic
                      (pipes > context > template).
  --arms              The arm set IS the provider pin (--provider
                      comma-list / all); there is no separate control.
  --budget-tokens    --max-chars is the budget (chars, not tokens).
  --context-stdin    Search-only spelling; use --context <path> (or
                      pipes in the question) instead.

Standard global options apply (--output-format/-O, --save-format,
--save-force, --provider before the command, --no-fallback,
--isolated).

Output formats (--output-format / -O):
  data       Raw EvidencePack JSON (default)
  json       Envelope-wrapped {success, data, timestamp}
  pretty     Pretty-printed json
  compact / markdown / refs / tty   Fall back to JSON — the pack is
                      data, not prose.

Examples:
  scoutline investigate "rust async runtime benchmarks"
  scoutline investigate "rust async | rust tokio"          # explicit pipes
  scoutline --provider tavily,exa investigate "alpha | beta"
  scoutline investigate "vector dbs" --context notes.md --sources 3
  scoutline investigate "k8s cost" --max-chars 4000        # budgeted pack
  scoutline investigate "wasm runtimes" --synthesize       # + Z.AI brief

Default JSON shape (EvidencePack, schemaVersion 1):
  {
    "schemaVersion": 1,
    "question": "...",
    "subQueries": ["..."],
    "sources": [
      {
        "url": "https://...",
        "finalUrl": "https://...",
        "title": "Page title",
        "fetchedAt": "2026-09-20T00:00:00.000Z",
        "provider": "tavily",
        "contentFormat": "markdown",
        "contentSha256": "<sha256 of the utf-8 content>",
        "passages": [{ "quote": "...", "charRange": [0, 42] }]
      }
    ],
    "coverage": {
      "subQueries": 2,
      "armsUsed": 2,
      "sourcesConsidered": 5,
      "sourcesRead": 5,
      "cacheHits": 0,
      "unread": [{ "url": "https://...", "reason": "reader-failed:API_ERROR" }]
    }
  }
`.trim();

// ---------------------------------------------------------------------------
// Options + dependencies
// ---------------------------------------------------------------------------

export interface InvestigateOptions {
  /**
   * Raw `--provider` value (comma-list / "all" / single id), threaded
   * to resolveFanoutPlan verbatim — the same tier grammar search uses.
   */
  readonly provider?: string;
  /** `--context` file path; selects the planner's context tier. */
  readonly contextFile?: string;
  /**
   * `--sources`: how many distinct post-cluster sources to read.
   * Positive integer; default 5. 0/negative/non-integers are
   * VALIDATION_ERROR (validation at the trust boundary).
   */
  readonly sources?: number;
  /**
   * ACCEPTED, never rejected (PRD AC-9: no ISOLATED_REJECTED path).
   * The pid-segment cache behavior belongs to the main() handler seam
   * (T6) — this command has no cache-directory logic of its own; the
   * injected cache IS the (possibly isolated) production cache.
   */
  readonly isolated?: boolean;
  /** `--no-cache`: threaded to every underlying search + read. */
  readonly noCache?: boolean;
  /**
   * `--no-journal`: threaded through ONLY as far as the command seam
   * allows (the underlying ops take no such option — journaling is
   * wired at the index.ts descriptor/hook seam). T6 owns the real
   * suppression; recorded here so the option never fails the parse.
   */
  readonly noJournal?: boolean;
  /**
   * `--max-chars` (T5, D7): whole-envelope Output Budget over the
   * EvidencePack via INVESTIGATE_LADDER. Strict positive integer
   * (parseBriefMaxChars class); 0/negative/fractional values are
   * VALIDATION_ERROR at the trust boundary.
   */
  readonly maxChars?: number;
  /**
   * `--synthesize` (T7, PRD AC-7): attach an additive `brief` to the
   * pack via the injected {@link InvestigateExecutionDependencies.
   * synthesize} dep. Z.AI-only (the notice lives at the handler seam,
   * where the raw provider pin is visible). Set without a dep is a
   * wiring bug — the command throws rather than silently skipping.
   */
  readonly synthesize?: boolean;
}

// ---------------------------------------------------------------------------
// Output Budget ladder (T5, DESIGN D7, PRD AC-8)
// ---------------------------------------------------------------------------

/**
 * One passage-trim step: truncate every quote FROM THE END to half
 * its length and ADJUST charRange to the truncated slice so the
 * round-trip pin `content.slice(...charRange) === quote` survives
 * every pass. NO omission marker is appended: the pin demands quote
 * be an exact slice of the paired content, so any added `…` would
 * break it (the read ladder's marker idiom does not apply here).
 * A quote too short to halve stays unchanged (rule exhausts; the
 * source-drop rule takes over) — and empty quotes never exist, so a
 * budgeted pack still decodes. url/title/fetchedAt/provider/hashes
 * are never touched. `ponytail:` marker-less trim is the pin-driven
 * minimum; a marker would need pinless budgeted quotes (schema
 * change) — revisit only if budgeted-quote readability ever matters.
 */
const trimPassagesRule: LadderRule = {
  name: "trim-passages",
  apply: (envelope) => {
    const pack = envelope as EvidencePack;
    return {
      ...pack,
      sources: pack.sources.map((source) => ({
        ...source,
        passages: source.passages.map((passage) => {
          const half = Math.floor(passage.quote.length / 2);
          if (half <= 0) return passage;
          return {
            quote: passage.quote.slice(0, half),
            // charRange adjusts to the truncated slice — the pin holds.
            charRange: [passage.charRange[0], passage.charRange[0] + half] as [number, number],
          };
        }),
      })),
    };
  },
};

/** One late-source drop step: the LAST source drops whole (search's drop-lowest-rank analog). */
const dropLastSourceRule: LadderRule = {
  name: "drop-late-source",
  apply: (envelope) => {
    const pack = envelope as EvidencePack;
    if (pack.sources.length <= 0) return pack;
    return { ...pack, sources: pack.sources.slice(0, -1) };
  },
};

/**
 * INVESTIGATE_LADDER (D7 budget order): passages trim FIRST (quote
 * truncate, charRange adjusts — the round-trip pin survives), then
 * LATE sources drop whole. question/subQueries/coverage are never
 * cut — expressed by omission (no rule touches them).
 */
export const INVESTIGATE_LADDER = [trimPassagesRule, dropLastSourceRule] as const;

export interface InvestigateExecutionDependencies {
  /**
   * Live provider registry — the same `HandlerDependencies.
   * providerDescriptors` list handleSearch consumes (possibly the
   * capture-wrapped journalingDescriptors list; this command never
   * unwraps it, so journal servedFrom/cacheKey stamping survives).
   */
  readonly descriptors: readonly ProviderDescriptor[];
  /** The resolved env (env + file-configured keys). Input only. */
  readonly env: NodeJS.ProcessEnv;
  /** Whether `fanout` is enabled in the active config. */
  readonly configFanout: boolean;
  /** Resolved per-capability routing table. */
  readonly routing?: Readonly<Record<string, readonly ProviderId[]>>;
  /** Shared response cache for search arms AND reads. */
  readonly cache: ResponseCache;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly retryPolicy?: RetryPolicy;
  /** Usage-ledger sink — N×M + K linearity pins on it. */
  readonly consume?: ConsumptionSink;
  /** Clock for consumption events. */
  readonly now?: () => number;
  /**
   * Fusion ranking mode — resolved ONCE at the handler seam (env >
   * config > "rrf"), exactly how handleSearch threads it. Omitted
   * (direct tests) → "rrf".
   */
  readonly fusionMode?: FusionMode;
  /**
   * Wall clock for `fetchedAt` (ISO-8601 UTC-Z, D5). Injected for
   * byte-identical determinism pins; defaults to `() => new Date()`.
   */
  nowWall?: () => Date;
  /**
   * Read-pool concurrency bound (default 4). Overridable in deps so
   * tests can pin the pool shape without timers.
   */
  readConcurrency?: number;
  /** Injected context reader (production: readContextSource-shaped). */
  loadContextText(filePath: string): Promise<string>;
  /**
   * Reader supplier seam: resolve the ReaderCapability a provider
   * descriptor serves, or `undefined` when it has none. Production
   * mirrors handleRead's shape — `descriptor.create({ env }).reader` —
   * so selection follows the same first-configured-capable order read
   * uses (the registry order the descriptor list already carries).
   */
  readerCapabilityFor(descriptor: ProviderDescriptor): ReaderCapability | undefined;
  /**
   * T5: resolved secrets for the compaction artifact's redaction (the
   * save seam's contract — the caller redacts before persisting).
   * Omitted (direct tests, no secrets) → no-op redaction.
   */
  readonly secrets?: string[];
  /**
   * T7: the synthesis transport (handler-seam wiring — this command
   * never constructs one). Consulted ONLY when `--synthesize` is set,
   * and only AFTER the pack is fully assembled.
   */
  synthesize?: SynthesizeBrief;
}

const DEFAULT_SOURCES = 5;
const DEFAULT_READ_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Option validation (trust boundary)
// ---------------------------------------------------------------------------

function validateOptions(options: InvestigateOptions): number {
  // Review fix #4: every provided field validates UNCONDITIONALLY —
  // no early return may shield a later field's check.
  if (typeof options.sources === "number") {
    if (!Number.isInteger(options.sources) || options.sources <= 0) {
      throw new ValidationError(`--sources must be a positive integer (got ${options.sources}).`);
    }
  }
  // T5 (D7): strict positive-integer --max-chars (parseBriefMaxChars
  // class) — validated at the boundary so a bad value is
  // VALIDATION_ERROR regardless of provider state.
  if (options.maxChars !== undefined) {
    const value = options.maxChars;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new ValidationError("--max-chars must be a positive integer");
    }
  }
  return typeof options.sources === "number" ? options.sources : DEFAULT_SOURCES;
}

/**
 * Output Budget seam (T5, D7): walk INVESTIGATE_LADDER over the pack;
 * on a fired budget persist the FULL untrimmed pack through
 * persistCompaction (mirrored save shape — post-redaction,
 * pre-compaction `result`, MANDATORY log entry with
 * presentation-flag-free args) and stamp `compaction {budget, ref}`
 * into the returned payload. No flag → identity (the zero-diff
 * invariant). Returns a NEW CommandResult; never mutates the input.
 */
async function applyInvestigateOutputBudget(
  result: CommandResult<EvidencePack>,
  maxChars: number | undefined,
  options: {
    readonly context: { notice(message: string): void };
    readonly deps: InvestigateExecutionDependencies;
    readonly args: Readonly<Record<string, unknown>>;
    readonly providerRouting: {
      mode: "single" | "fanout";
      effective?: string;
      arms?: readonly string[];
    };
  },
): Promise<CommandResult> {
  if (maxChars === undefined || result.kind !== "data") return result;
  const outcome = applyBudget(result.data, maxChars, INVESTIGATE_LADDER);
  if (outcome.compaction === undefined) return result;
  const redactedEnvelope = redactSecrets(result.data, options.deps.secrets);
  const compaction: BudgetCompaction = await persistCompaction(
    redactedEnvelope,
    outcome.compaction,
    {
      command: "investigate",
      args: options.args,
      provider: options.providerRouting as Parameters<typeof persistCompaction>[2]["provider"],
      outputFormat: "data",
    },
    {
      env: options.deps.env,
      now: options.deps.now ?? Date.now,
      onNotice: options.context.notice,
    },
  );
  options.context.notice(
    `output budget: ${maxChars} chars — full untrimmed envelope saved (${compaction.ref})`,
  );
  return {
    kind: "data",
    data: {
      ...(outcome.projection as EvidencePack & Record<string, unknown>),
      compaction,
    },
  };
}

// ---------------------------------------------------------------------------
// Read pool (bounded concurrency, one client per read, terminal-failure
// isolation — D3 #5)
// ---------------------------------------------------------------------------

interface ReadOutcome {
  readonly url: string;
  readonly result?: ReaderFetchResult;
  readonly reason?: string;
  readonly warm: boolean;
}

/**
 * Serve one read through the shared cache, trying suppliers in
 * registry order (review fix #2 — AC-4 "provider fallback"). One
 * client per ATTEMPT: `deps.readerCapabilityFor` resolves the
 * supplier's capability per call (`descriptor.create` per attempt —
 * `create` is side-effect-free metadata capture; the operation's
 * invoke owns and closes its transport inside executeReaderOperation,
 * so no transport outlives the call).
 *
 * Advance-to-next-supplier on ANY thrown error — an
 * UnsupportedCapabilityError (supplier cannot serve the capability)
 * and terminal failures alike (executeReaderOperation has already
 * exhausted its internal retry for transient classes by the time the
 * error escapes, so every escape is supplier-exhausted). ALL suppliers
 * exhausted → the LAST supplier's reason code surfaces (most
 * informative: the deepest attempt). Every attempt bills exactly one
 * consumption event (executor behavior — fallback attempts are
 * billable reads, consistent with the usage-ledger "retries count as
 * attempts" doctrine; K in the N×M+K notice counts attempts).
 *
 * cacheHits instrumentation: a warm serve is a read-only cache `get()`
 * on the FIRST supplier's partition key that decodes non-null through
 * the operation's own decoder. ponytail: conservative undercount when
 * a fallback supplier serves warm (first-supplier probe only); widen
 * to per-attempt probes if a fallback-heavy workload needs exact hits.
 * Boundary: legacy read-through candidates are miss-then-set serves
 * and count as misses (honest warm-serve count only).
 */
async function serveRead(
  url: string,
  suppliers: readonly ProviderDescriptor[],
  deps: InvestigateExecutionDependencies,
  noCache: boolean,
  cacheHits: { count: number },
): Promise<ReadOutcome> {
  if (suppliers.length === 0) {
    return { url, reason: "no-reader-supplier", warm: false };
  }
  let lastReason = "no-reader-supplier";
  for (const descriptor of suppliers) {
    const capability = deps.readerCapabilityFor(descriptor);
    if (capability === undefined) {
      // Not a reader supplier at all — selection pre-filters these;
      // kept as a guard for hand-built descriptor lists.
      lastReason = "no-reader-supplier";
      continue;
    }
    const wasWarm = await readerCacheWasWarm(capability, url, deps, noCache);
    try {
      const result = await executeReaderOperation(
        capability.fetch,
        { url },
        { noCache, ...(deps.retryPolicy !== undefined ? { retryPolicy: deps.retryPolicy } : {}) },
        {
          cache: deps.cache,
          sleep: deps.sleep,
          random: deps.random,
          ...(deps.consume !== undefined ? { consume: deps.consume } : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        },
      );
      if (wasWarm) cacheHits.count += 1;
      return { url, result, warm: wasWarm };
    } catch (error) {
      // Reason CODE only, redacted — no error prose crossing the
      // interface (house rule, D5). Advances to the next supplier;
      // this code surfaces only if every later supplier also fails.
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "UNKNOWN_ERROR";
      lastReason =
        error instanceof UnsupportedCapabilityError
          ? "no-reader-supplier"
          : `reader-failed:${code}`;
    }
  }
  return { url, reason: lastReason, warm: false };
}

/**
 * Read-only warm probe on the reader partition key the executor will
 * use — the operation's own cacheIdentity + decoder, never a
 * fabricated key. Never seeds an entry; shared execution remains the
 * sole read/write authority.
 */
async function readerCacheWasWarm(
  capability: ReaderCapability,
  url: string,
  deps: InvestigateExecutionDependencies,
  noCache: boolean,
): Promise<boolean> {
  if (noCache) return false;
  try {
    const identity = capability.fetch.cacheIdentity({ url });
    const key = buildProviderCacheKey({
      provider: identity.provider,
      capability: `${identity.capability}-${identity.operation}`,
      credentialFingerprint: identity.credentialFingerprint,
      request: identity.request,
    });
    const raw = await deps.cache.get(key);
    if (raw === null) return false;
    return capability.fetch.decodeCached(raw) !== null;
  } catch {
    return false;
  }
}

/**
 * Bounded-concurrency map over the selected sources (D3 #5). A read
 * slot is reused as soon as its previous read settles (start-aligned
 * workers over a shared index — no per-chunk scheduling, no timers).
 * `suppliers` is the run's ordered reader supplier list (review fix
 * #2); serveRead falls through it per source.
 */
async function readPool(
  rows: readonly FormattedResult[],
  suppliers: readonly ProviderDescriptor[],
  deps: InvestigateExecutionDependencies,
  noCache: boolean,
  cacheHits: { count: number },
): Promise<ReadOutcome[]> {
  const limit = Math.max(1, deps.readConcurrency ?? DEFAULT_READ_CONCURRENCY);
  const outcomes: ReadOutcome[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const row = rows[index];
      if (row === undefined) return;
      outcomes.push(await serveRead(row.url, suppliers, deps, noCache, cacheHits));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, worker));
  return outcomes;
}

/**
 * The run's reader supplier LIST (review fix #2): every descriptor in
 * registry order whose injected `readerCapabilityFor` resolves a
 * capability — the same first-configured-capable order handleRead's
 * provider selection walks. serveRead falls through the list per
 * source; an empty list keeps the legacy all-unread
 * `no-reader-supplier` behavior.
 */
function selectReaderSuppliers(
  deps: InvestigateExecutionDependencies,
): readonly ProviderDescriptor[] {
  return deps.descriptors.filter(
    (descriptor) => deps.readerCapabilityFor(descriptor) !== undefined,
  );
}

// ---------------------------------------------------------------------------
// Escaped-pipe join (the handleSearch context-mode precedent verbatim:
// trim trailing backslashes, then escape pipes, join on "|")
// ---------------------------------------------------------------------------

function joinSubQueries(subQueries: readonly string[]): string {
  return subQueries.map((s) => s.replace(/\\+$/, "").replace(/\|/g, "\\|")).join("|");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function investigate(
  question: string,
  options: InvestigateOptions = {},
  deps: InvestigateExecutionDependencies,
  context?: CommandContext,
): Promise<CommandResult> {
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new ValidationError("investigate requires a question.");
  }
  const sourcesCap = validateOptions(options);
  const noCache = options.noCache === true;

  // 1. Plan (T2) — injected loadContextText; no filesystem here.
  const plan = await planSubQueries(
    {
      query: question,
      ...(options.contextFile !== undefined ? { contextFile: options.contextFile } : {}),
    },
    { loadContextText: deps.loadContextText },
  );
  const subQueries = [...plan.subQueries];
  // The planner's explicit-tier notice ("--context ignored") only
  // means something when a context file was actually in play; without
  // --context it would be a misleading stderr line on every pipe
  // question.
  if (plan.notice !== undefined && options.contextFile !== undefined) {
    context?.notice(plan.notice);
  }
  const N = subQueries.length;

  // 2. resolveFanoutPlan over the resolved provider pin (AC-1 tiers,
  //    the same inputs handleSearch passes).
  const fanoutPlan = resolveFanoutPlan({
    explicitProviderRaw: options.provider,
    env: deps.env,
    configFanout: deps.configFanout,
    ...(deps.routing !== undefined ? { routing: deps.routing } : {}),
    descriptors: deps.descriptors,
  });
  const M = fanoutPlan.arms.length;

  // Cost notice (AC-3; PR #264 F3 wording): the arithmetic stated
  // literally, N/M/K spelled out, BEFORE any billable work runs. K
  // counts SOURCES — the per-read supplier fallthrough can bill more
  // than one reader attempt per source, so the notice names sources
  // and discloses the attempt semantics instead of understating.
  context?.notice(
    `investigate: ${N} sub-queries × ${M} arms = ${N * M} billable searches + up to ${sourcesCap} sources (per-source supplier attempts apply)`,
  );
  if (fanoutPlan.suppress) context?.notice(fanoutPlan.suppress);

  const searchDepsBase = {
    cache: deps.cache,
    sleep: deps.sleep,
    random: deps.random,
    ...(deps.retryPolicy !== undefined ? { retryPolicy: deps.retryPolicy } : {}),
    ...(deps.consume !== undefined ? { consume: deps.consume } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };

  // Search-stage warm-serve count. MUST run BEFORE the grid executes:
  // the grid seeds exactly these keys on a cold run, so a post-grid
  // probe would count its own writes (the recorded trap this ordering
  // exists to avoid). Read and search partitions are disjoint
  // (`reader-reader-fetch` vs `search`), so later reads cannot pollute
  // these probes either.
  const searchHits = await countSearchCacheHits(fanoutPlan, subQueries, deps, noCache);

  // 3. Grid execution through the exported seams only. Both paths emit
  //    FormattedResult[] (rank-merged rows); the fan-out path carries
  //    mergedFrom provenance, the single path carries rows verbatim.
  let merged: FormattedResult[];
  let armsUsed: number;
  let singleArmProviderId: string | undefined;
  if (fanoutPlan.mode === "fanout") {
    const fanoutResult = await executeFanoutPlan(
      fanoutPlan,
      {
        descriptors: deps.descriptors,
        env: deps.env,
        query: joinSubQueries(subQueries),
        searchOptions: {
          // The (arm × sub-query) merge grid: merge=true makes every
          // arm run every sub-query — the search seam's own grammar.
          merge: N > 1,
          ...(noCache ? { noCache: true } : {}),
        },
        fusionMode: deps.fusionMode ?? "rrf",
        dependencies: searchDepsBase,
      },
      context,
    );
    if (fanoutResult.kind !== "data" || !Array.isArray(fanoutResult.data)) {
      throw new Error("investigate: fan-out returned a non-grid result");
    }
    merged = fanoutResult.data as FormattedResult[];
    armsUsed = M;
  } else {
    singleArmProviderId = fanoutPlan.arms[0];
    // Single mode: the exported search() with the escaped-pipe join —
    // the exact context-mode join precedent (index.ts handleSearch).
    // One arm executes every sub-query (search --merge semantics);
    // count stays undefined (search default 10 per AC-3, applied after
    // normalization by shared execution).
    const singleResult = await search(
      joinSubQueries(subQueries),
      { merge: N > 1, ...(noCache ? { noCache: true } : {}) },
      {
        capability: singleArmCapability(fanoutPlan, deps),
        ...searchDepsBase,
        fusionMode: deps.fusionMode ?? "rrf",
      },
      context,
    );
    if (singleResult.kind !== "data" || !Array.isArray(singleResult.data)) {
      throw new Error("investigate: single-arm search returned a non-grid result");
    }
    merged = singleResult.data as FormattedResult[];
    armsUsed = 1;
  }

  // 4. Top --sources distinct sources (post-cluster representatives —
  //    mergeResults already collapsed near-dups; a pair IS one row).
  const sourcesConsidered = merged.length;
  const selected = merged.slice(0, sourcesCap);

  // 5. Reads — bounded-concurrency pool over the reader capability
  //    seam; per-source terminal failures continue the pool; suppliers
  //    fall through in registry order (review fix #2).
  const suppliers = selectReaderSuppliers(deps);
  const readerHits = { count: 0 };
  const outcomes = await readPool(selected, suppliers, deps, noCache, readerHits);
  const byUrl = new Map(outcomes.map((o) => [o.url, o]));

  // 6 + 7. Extraction (T3) + pack assembly (T1 types). Terms = union of
  // the question + sub-queries key-term derivations (deriveTemplateTopic
  // per member — the T2-exposed term shape), case-folded and
  // stopword-filtered by normalizeTerms inside extractPassages.
  const terms = [
    ...new Set([question, ...subQueries].flatMap((q) => deriveTemplateTopic(q).split(" "))),
  ].filter((t) => t.length > 0);
  const nowWall = deps.nowWall ?? (() => new Date());
  const sources: EvidenceSource[] = [];
  const unread: { url: string; reason: string }[] = [];
  for (const row of selected) {
    const outcome = byUrl.get(row.url);
    if (outcome === undefined || outcome.result === undefined) {
      unread.push({ url: row.url, reason: outcome?.reason ?? "no-reader-supplier" });
      continue;
    }
    const result = outcome.result;
    // Provider provenance: the merged row's surfaced provider — first
    // mergedFrom (fan-out) or the resolved arm (single mode). NOT the
    // reader supplier: the row says who FOUND it, not who read it.
    const surfacedProvider = row.mergedFrom?.[0] ?? singleArmProviderId ?? suppliers[0]?.id ?? "";
    sources.push({
      url: row.url,
      finalUrl: result.finalUrl,
      title: result.title,
      fetchedAt: nowWall().toISOString(),
      provider: surfacedProvider,
      contentFormat: result.contentFormat,
      contentSha256: createHash("sha256").update(result.content, "utf8").digest("hex"),
      passages: extractPassages({ content: result.content, terms }),
    });
  }

  const pack: EvidencePack = {
    schemaVersion: 1,
    question,
    subQueries,
    sources,
    coverage: {
      subQueries: N,
      armsUsed,
      sourcesConsidered,
      sourcesRead: sources.length,
      cacheHits: searchHits + readerHits.count,
      unread,
    },
  };
  // 8. `--synthesize` (T7): the pack is COMPLETE above — every search,
  //    every read, every passage — so the brief is attached here by
  //    construction and can only ever ADD a trailing key. A throwing
  //    dep propagates as this invocation's terminal error (house error
  //    contract) and the assembled pack is NOT emitted: a flag-bearing
  //    failure is loud, never a silent degradation to agent-synthesis.
  let payload: EvidencePack & { brief?: string } = pack;
  if (options.synthesize === true) {
    if (deps.synthesize === undefined) {
      // Wiring bug, not a user error: the flag is documented and
      // parsed, so a missing dep means the handler seam forgot to
      // inject the transport. Fail loud — never silently skip.
      throw new Error("investigate: --synthesize was requested but no synthesis dep is wired");
    }
    const quotes: string[] = [];
    for (const source of sources) {
      for (const passage of source.passages) {
        if (quotes.length >= SYNTHESIS_QUOTE_CAP) break;
        quotes.push(passage.quote);
      }
      if (quotes.length >= SYNTHESIS_QUOTE_CAP) break;
    }
    const brief = await deps.synthesize({ question, subQueries, quotes });
    payload = { ...pack, brief };
  }
  // 9. Output Budget (T5, D7): the pack is fully assembled first — the
  // compaction artifact is the FULL untrimmed pack, so the budget
  // rides AFTER assembly by construction.
  const investigateArgs: Readonly<Record<string, unknown>> = {
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.sources !== undefined ? { sources: options.sources } : {}),
    ...(noCache ? { "no-cache": true } : {}),
    ...(options.isolated ? { isolated: true } : {}),
  };
  return applyInvestigateOutputBudget({ kind: "data", data: payload }, options.maxChars, {
    context: context ?? { stdinIsTTY: false, readStdin: async () => "", notice: () => {} },
    deps,
    args: investigateArgs,
    providerRouting: {
      mode: fanoutPlan.mode,
      ...(fanoutPlan.mode === "fanout"
        ? { arms: fanoutPlan.arms }
        : { effective: singleArmProviderId ?? "" }),
      ...(options.provider !== undefined ? { requested: options.provider } : {}),
    } as { mode: "single" | "fanout"; effective?: string; arms?: readonly string[] },
  });
}

/**
 * Resolve the single-arm search capability. The resolver's single mode
 * always names the arm (`arms[0]`); a descriptor MUST exist for it —
 * an unknown id means the pin never matched the registry, which is
 * the capability seam's typed error to raise.
 */
function singleArmCapability(
  fanoutPlan: FanoutPlan,
  deps: InvestigateExecutionDependencies,
): Parameters<typeof search>[2]["capability"] {
  const armId = fanoutPlan.arms[0];
  const descriptor = deps.descriptors.find((d) => d.id === armId);
  if (descriptor === undefined) {
    throw new UnsupportedCapabilityError(String(armId ?? "(none)"), "search");
  }
  const adapter = descriptor.create({ env: deps.env });
  const capability = adapter.search;
  if (capability === undefined) {
    throw new UnsupportedCapabilityError(descriptor.id, "search");
  }
  return capability;
}

/**
 * Search-stage warm-serve count. Mirrors the read-stage boundary: a
 * warm serve is a cache get() on the arm's exact partition key —
 * resolved through the injected descriptors' own cacheIdentity, never
 * a fabricated key — consulted once per (arm × sub-query) BEFORE the
 * grid runs (see the ordering note at the call site). executeSearch
 * treats any non-null raw value on this key as a hit (no decoder), so
 * the probe matches: non-null = warm.
 */
async function countSearchCacheHits(
  fanoutPlan: FanoutPlan,
  subQueries: readonly string[],
  deps: InvestigateExecutionDependencies,
  noCache: boolean,
): Promise<number> {
  if (noCache) return 0;
  const arms = fanoutPlan.mode === "fanout" ? fanoutPlan.arms : fanoutPlan.arms.slice(0, 1);
  let hits = 0;
  for (const armId of arms) {
    const descriptor = deps.descriptors.find((d) => d.id === armId);
    if (descriptor === undefined) continue;
    const capability = descriptor.create({ env: deps.env }).search;
    if (capability === undefined) continue;
    for (const query of subQueries) {
      try {
        const identity = capability.cacheIdentity({ query });
        const key = buildProviderCacheKey({
          provider: identity.provider,
          capability: identity.capability,
          credentialFingerprint: identity.credentialFingerprint,
          request: identity.request,
        });
        if ((await deps.cache.get(key)) !== null) hits += 1;
      } catch {
        // A capability whose cacheIdentity cannot be probed counts
        // nothing — never guess a hit.
      }
    }
  }
  return hits;
}
