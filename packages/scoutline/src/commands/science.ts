/**
 * Science command layer (DESIGN D6/D6b; PRD AC-4b, AC-5d, AC-7, AC-7b).
 *
 *   - `scoutline science search <query> [--author --year --venue
 *     --type --provider]` — data CommandResult with ScienceWork[].
 *   - `scoutline science get <identifier>` — data CommandResult with
 *     one ScienceWork.
 *
 * Handlers RETURN CommandResult through the invocation seam
 * (`invokeCommand`) — the removed global command-output API was
 * retired in 22337a1 and is test-forbidden (tests/output.test.js; the
 * D6 envelope correction). The command is dispatched credential-free
 * by the `if (command === "science") {` arm in src/index.ts (the
 * `archive` precedent): the science suppliers are keyless, so a
 * corrupt or missing ~/.scoutline/config.json never blocks a run.
 *
 * Parse-level rejections (PRD AC-7/AC-7b/AC-4b) fire BEFORE any
 * supplier access:
 *   - `--type` accepts exactly the union vocabulary; `component` (and
 *     any non-union value) is rejected — never surfaced, never
 *     requestable.
 *   - `--year` accepts only "2020" | "2018:2022"; empty, malformed,
 *     and reversed ranges throw.
 *   - a missing query / identifier, a `doi:`-prefixed identifier, and
 *     free-text identifiers throw ValidationError.
 *
 * Selection (T10, the full D5 grammar): no pin or `--provider all` →
 * fan-out across every enabled science supplier in the D5
 * openalex-first arm order, merged with DOI-first dedup identity
 * (exact-url fallback) and D12 field-wise union enrichment;
 * `--provider <id>` pins one arm. Control-rejecting arms are EXCLUDED
 * at validation with a per-arm stderr notice (never a silent drop);
 * all enabled arms rejecting fails UNSUPPORTED_OPTION. `science get`
 * reroutes along the id-type-filtered arm order on supplier failure
 * with a stderr note; `--no-fallback` fails strict.
 */

import type { CommandResult, SaveHook, TextOutputMode } from "../command-invocation.js";
import { invokeCommand } from "../command-invocation.js";
import type {
  ScienceControls,
  ScienceGetRequest,
  ScienceSearchRequest,
  ScienceWork,
} from "../capabilities/science.js";
import { parseScienceIdentifier } from "../capabilities/science.js";
import { applyBudget, type BudgetLadder, type LadderRule } from "../lib/output-budget.js";
import { persistCompaction } from "../lib/output-budget-persistence.js";
import { redactSecrets } from "../lib/redact.js";
import { UnsupportedOptionError, ValidationError } from "../lib/errors.js";
import type { OutputMode } from "../lib/output.js";
import type { HandlerDependencies } from "../index.js";
import { parseBriefMaxChars } from "./repo.js";
import { resolveArtifactsDir } from "../lib/artifacts.js";
import { buildProviderCacheKey } from "../lib/cache.js";
import type { ProviderId } from "../providers/types.js";
import {
  appendJournalEntry,
  buildJournalEntry,
  buildSearchSkeleton,
  type JournalSkeleton,
} from "../lib/journal.js";

// ---------------------------------------------------------------------------
// D5 arm order (executor-side rule, NOT the registry listing order)
// ---------------------------------------------------------------------------

/**
 * The D5 openalex-first arm order. Governs the interim single-supplier
 * walk and, later, the T10 fan-out merge preference. Deliberately
 * distinct from `SCIENCE_SUPPLIER_IDS` (the D2 registry listing
 * order).
 */
const D5_ARM_ORDER = ["openalex", "arxiv", "crossref", "pubmed", "europepmc"] as const;

/**
 * id-type → supplier membership (D6/D10 Q3, probe-verified 2026-09-08):
 * DOI → all but arxiv; PMID → openalex/europepmc/pubmed; arXiv → arxiv
 * only. `science get` routes by identifier kind through this table
 * over the D5 arm order.
 */
const ID_TYPE_SUPPLIERS: Readonly<Record<"doi" | "pmid" | "arxiv", readonly string[]>> = {
  doi: ["openalex", "crossref", "pubmed", "europepmc"],
  pmid: ["openalex", "europepmc", "pubmed"],
  arxiv: ["arxiv"],
};

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const SCIENCE_HELP = `
scoutline science — scholarly literature search and retrieval

Keyless by default: the five scholarly suppliers (openalex, arxiv,
crossref, pubmed, europepmc) serve without any API key.

Usage:
  scoutline science search <query> [options]
  scoutline science get <identifier>

Subcommands:
  search <query>   Search scholarly works across suppliers
  get <identifier> Fetch one work by bare DOI, numeric PMID, or arXiv id

Search options:
  --author <name>    Filter by author name
  --year <y|y:y>     Filter by publication year ("2020" or "2018:2022")
  --venue <name>     Filter by venue (journal/proceedings name)
  --type <type>      Filter by work type: article, preprint,
                     conference-paper, chapter, dataset, review, other
  --provider <id>    Pin one supplier (${D5_ARM_ORDER.join(", ")}); "all" is the default fan-out

Identifier grammar (get):
  DOI    10.1038/nature12373      (bare — no "doi:" prefix)
  PMID   31672840                  (numeric)
  arXiv  2401.12345 | cs/0501001  (modern | legacy)

Examples:
  scoutline science search "graph transformers" --year 2020:2024
  scoutline science search "attention" --author Vaswani --provider crossref
  scoutline science get 10.1038/nature12373
`.trim();

// ---------------------------------------------------------------------------
// --type union vocabulary (PRD AC-7)
// ---------------------------------------------------------------------------

/**
 * The exact `--type` vocabulary. `component` is NOT a member — the
 * junk filter is supplier-output side (Crossref adapter), never a
 * requestable flag value.
 */
const SCIENCE_TYPE_UNION: ReadonlySet<string> = new Set([
  "article",
  "preprint",
  "conference-paper",
  "chapter",
  "dataset",
  "review",
  "other",
]);

// ---------------------------------------------------------------------------
// Output Budget ladder (DESIGN D6b, PRD AC-5d)
// ---------------------------------------------------------------------------

/**
 * Apply `fn` to every ScienceWork in a bare-array, `{results}`-wrapped,
 * or single-work envelope. The wrapper variants exist because the
 * budget walk hands rules the MEASURED envelope (the search seam wraps
 * the bare array in `{results}`), while deep importers may hand the
 * raw shapes.
 */
function mapWorks(
  envelope: unknown,
  fn: (row: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (Array.isArray(envelope)) return envelope.map(fn);
  if (envelope !== null && typeof envelope === "object") {
    const wrapped = (envelope as { results?: unknown }).results;
    if (Array.isArray(wrapped)) return { ...envelope, results: wrapped.map(fn) };
    return fn(envelope as Record<string, unknown>);
  }
  return envelope;
}

/**
 * SCIENCE_LADDER (D6b): cheapest losses first — `summary` trims, then
 * the `authors` tail halves, then `venue` drops, then trailing rows
 * drop. `title`/`url`/`identifiers` are never cut: expressed by
 * omission (no rule ever touches them). The search envelope is the
 * bare works array (measured `{results}`-wrapped); the get envelope is
 * one work object — the same ladder serves both verbs (get budgets
 * the single-work envelope).
 */
const trimSummaryRule: LadderRule = {
  name: "trim-summaries",
  apply: (envelope) =>
    mapWorks(envelope, (row) => {
      const work = row as { summary?: string };
      if (!work.summary) return row;
      const clean = work.summary.replace(/^…+/, "").replace(/…$/, "");
      const half = Math.floor(clean.length / 2);
      return { ...row, summary: half > 0 ? `…${clean.slice(0, half)}` : "" };
    }),
};

const dropAuthorsTailRule: LadderRule = {
  name: "drop-authors-tail",
  apply: (envelope) =>
    mapWorks(envelope, (row) => {
      const work = row as { authors?: string[] };
      if (!Array.isArray(work.authors) || work.authors.length === 0) return row;
      return { ...row, authors: work.authors.slice(0, Math.ceil(work.authors.length / 2)) };
    }),
};

const dropVenueRule: LadderRule = {
  name: "drop-venue",
  apply: (envelope) =>
    mapWorks(envelope, (row) => {
      const { venue: _venue, ...rest } = row as Record<string, unknown>;
      void _venue;
      return rest;
    }),
};

const dropLastWorkRule: LadderRule = {
  name: "drop-last-work",
  apply: (envelope) => {
    const rows = Array.isArray(envelope)
      ? envelope
      : envelope !== null &&
          typeof envelope === "object" &&
          Array.isArray((envelope as { results?: unknown[] }).results)
        ? (envelope as { results: unknown[] }).results
        : undefined;
    if (rows === undefined || rows.length <= 1) return envelope;
    return Array.isArray(envelope)
      ? envelope.slice(0, -1)
      : { ...(envelope as Record<string, unknown>), results: rows.slice(0, -1) };
  },
};

/** The science Output Budget ladder (D6b; single ladder, both verbs). */
export const SCIENCE_LADDER: BudgetLadder = [
  trimSummaryRule,
  dropAuthorsTailRule,
  dropVenueRule,
  dropLastWorkRule,
];

/**
 * Output Budget (ADR-0007) at the science handler seam (D6b): applied
 * AFTER the capability returns its works, before the CommandResult is
 * emitted. `--max-chars` parses with the brief surface's strict
 * positive-integer gate (parseMaxCharsFlag wording for a valueless
 * flag). The search envelope is the bare works array (measured wrapped
 * in `{results}` — the search seam's precedent); the get envelope is
 * the single work object. When compaction fires, the FULL untrimmed
 * envelope is persisted through persistCompaction and a notice names
 * the artifact ref. Without the flag (or when the envelope already
 * fits) this is the identity function — the zero-diff invariant.
 */
async function applyScienceOutputBudget(
  result: CommandResult,
  maxChars: number | undefined,
  options: {
    readonly subcommand: "search" | "get";
    readonly context: { notice(message: string): void };
    readonly deps: HandlerDependencies;
    readonly outputMode: OutputMode;
    readonly explicitProvider?: string;
  },
): Promise<CommandResult> {
  if (maxChars === undefined || result.kind !== "data") return result;
  const isSearch = options.subcommand === "search";
  const data = result.data;
  if (isSearch && !Array.isArray(data)) return result;
  if (!isSearch && (data === null || typeof data !== "object")) return result;
  const measured = isSearch ? { results: data } : data;
  const outcome = applyBudget(measured, maxChars, SCIENCE_LADDER);
  if (outcome.compaction === undefined) return result;
  const redactedEnvelope = redactSecrets(data, options.deps.secrets);
  const compaction = await persistCompaction(
    redactedEnvelope,
    outcome.compaction,
    {
      command: "science",
      args: {
        ...(options.explicitProvider !== undefined ? { provider: options.explicitProvider } : {}),
      },
      provider: {
        mode: "single",
        ...(options.explicitProvider !== undefined ? { requested: options.explicitProvider } : {}),
        effective: "science",
      },
      outputFormat: options.outputMode,
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
  const projected = outcome.projection as { results: unknown };
  const projection: unknown = isSearch ? projected.results : outcome.projection;
  // Rebuild the text presentations from the projection (review, R5
  // search.ts precedent): without this, a text output mode prints the
  // ORIGINAL unbudgeted render while the data envelope carries the
  // projected one. Field defaults keep the renderers from printing
  // `undefined` under an aggressive ladder step.
  const projectedText = isSearch
    ? renderWorksText(
        (projection as readonly Partial<ScienceWork>[]).map((w) => ({
          title: "",
          url: "",
          ...w,
        })) as readonly ScienceWork[],
      )
    : renderWorkText({
        title: "",
        url: "",
        ...(projection as Partial<ScienceWork>),
      } as ScienceWork);
  return {
    ...result,
    data: isSearch
      ? { results: projection, compaction }
      : { ...(projection as Record<string, unknown>), compaction },
    presentations: sciencePresentations(projectedText),
  };
}

// ---------------------------------------------------------------------------
// Arg parsing (parseArchiveArgs shape: --help-aware, leading flags
// never displace the subcommand)
// ---------------------------------------------------------------------------

export function parseScienceArgs(args: readonly string[]): {
  readonly subcommand?: string;
  readonly positional: readonly string[];
  readonly flags: Record<string, string | boolean>;
  readonly showHelp: boolean;
} {
  let showHelp = false;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
      i++;
    } else {
      i++;
    }
  }
  return { subcommand: positional[0], positional: positional.slice(1), flags, showHelp };
}

// ---------------------------------------------------------------------------
// Parse-level validation
// ---------------------------------------------------------------------------

function parseScienceType(raw: string | boolean | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ValidationError(
      "--type requires a value.",
      `Use one of: ${[...SCIENCE_TYPE_UNION].join(", ")}.`,
    );
  }
  if (!SCIENCE_TYPE_UNION.has(raw)) {
    throw new ValidationError(
      `Invalid --type value "${raw}": must be one of ${[...SCIENCE_TYPE_UNION].join(", ")}`,
      `Use one of: ${[...SCIENCE_TYPE_UNION].join(", ")}.`,
    );
  }
  return raw;
}

function validateYearGrammar(year: string): void {
  const match = /^(\d{4})(?::(\d{4}))?$/.exec(year);
  if (!match) {
    throw new ValidationError(
      `Invalid --year value "${year}": expected a year "2020" or closed range "2018:2022"`,
      'Use "2020" or "2018:2022".',
    );
  }
  if (match[2] !== undefined && Number(match[1]) > Number(match[2])) {
    throw new ValidationError(
      `Invalid --year range "${year}": the start year must not exceed the end year`,
      'Use "2020" or "2018:2022".',
    );
  }
}

function buildScienceControls(
  flags: Record<string, string | boolean>,
): ScienceControls | undefined {
  const type = parseScienceType(flags.type);
  const controls: ScienceControls = {};
  // Value-required gates (review): a valueless `--author`/`--venue`
  // parses as boolean `true` — silently omitting it broadens the
  // search instead of erroring. Reject like `--year`/`--type` do.
  if (flags.author !== undefined) {
    if (typeof flags.author !== "string") {
      throw new ValidationError("--author requires a value.");
    }
    controls.author = flags.author;
  }
  if (flags.venue !== undefined) {
    if (typeof flags.venue !== "string") {
      throw new ValidationError("--venue requires a value.");
    }
    controls.venue = flags.venue;
  }
  if (type !== undefined) controls.type = type;
  if (flags.year !== undefined) {
    if (typeof flags.year !== "string") {
      throw new ValidationError("--year requires a value.", 'Use "2020" or "2018:2022".');
    }
    // Year grammar (PRD AC-7b) validated here so the rejection is
    // parse-time — zero supplier invokes.
    validateYearGrammar(flags.year);
    controls.year = flags.year;
  }
  return Object.keys(controls).length > 0 ? controls : undefined;
}

// ---------------------------------------------------------------------------
// Supplier selection (T10: the full D5 fan-out grammar)
// ---------------------------------------------------------------------------

interface ScienceDescriptorLike {
  readonly id: string;
  isConfigured(env: NodeJS.ProcessEnv, capabilityId?: string): boolean;
  capabilities(): ReadonlySet<string>;
  create(context: { env: NodeJS.ProcessEnv }): {
    science?: {
      search?: {
        validate(request: ScienceSearchRequest): void;
        /** Present on every real supplier adapter; test doubles may omit it. */
        cacheIdentity?(request: ScienceSearchRequest): unknown;
        invoke(request: ScienceSearchRequest): Promise<readonly ScienceWork[]>;
      };
      get?: {
        validate(request: ScienceGetRequest): void;
        /** Present on every real supplier adapter; test doubles may omit it. */
        cacheIdentity?(request: ScienceGetRequest): unknown;
        invoke(request: ScienceGetRequest): Promise<ScienceWork>;
      };
    };
  };
}

interface SupplierSelection {
  readonly explicitProvider?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly descriptors: readonly unknown[];
}

function scienceDescriptorIndex(
  descriptors: readonly unknown[],
): Map<string, ScienceDescriptorLike> {
  return new Map(
    descriptors
      .filter(
        (d): d is ScienceDescriptorLike =>
          d !== null && typeof d === "object" && "id" in d && "create" in d,
      )
      .map((d) => [d.id, d]),
  );
}

/**
 * Resolve the D5 arm set for a science capability (T10): an explicit
 * `--provider <id>` pin narrows the set to that ONE supplier (eligible
 * checks still apply); no pin or `--provider all` selects EVERY
 * configured+capable supplier in the D5 arm order. `notice` receives
 * one line per EXCLUDED control-rejecting arm (D5 ruling: visible
 * narrowing, never a silent drop) — the caller runs inside the
 * invokeCommand behavior so notices flush on both the success and
 * failure paths.
 */
function resolveScienceArms(
  capabilityId: "science.search" | "science.get",
  opts: SupplierSelection,
  request: { controls?: ScienceControls } | { identifier: string },
  notice: (message: string) => void,
): readonly ScienceDescriptorLike[] {
  const byId = scienceDescriptorIndex(opts.descriptors);
  const pinned =
    opts.explicitProvider !== undefined && opts.explicitProvider !== "all"
      ? byId.get(opts.explicitProvider)
      : undefined;
  if (
    opts.explicitProvider !== undefined &&
    opts.explicitProvider !== "all" &&
    pinned === undefined
  ) {
    throw new ValidationError(
      `Unknown provider "${opts.explicitProvider}".`,
      `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
    );
  }
  const candidates: readonly string[] = pinned !== undefined ? [pinned.id] : D5_ARM_ORDER;
  const arms: ScienceDescriptorLike[] = [];
  for (const id of candidates) {
    const descriptor = pinned ?? byId.get(id);
    if (descriptor === undefined) continue;
    if (!descriptor.isConfigured(opts.env, capabilityId)) continue;
    if (!descriptor.capabilities().has(capabilityId)) continue;
    arms.push(descriptor);
  }
  // Controls vs fan-out (D5 audit-round-2 ruling): validate EVERY arm
  // up front; a rejecting arm is excluded with a per-arm notice naming
  // supplier + control. Never the house classifyError silent-skip path.
  const controls =
    "controls" in request && request.controls !== undefined ? request.controls : undefined;
  const accepting: ScienceDescriptorLike[] = [];
  for (const arm of arms) {
    const capability = arm.create({ env: opts.env }).science?.[
      capabilityId === "science.search" ? "search" : "get"
    ];
    if (capability === undefined) {
      throw new ValidationError(
        `Provider "${arm.id}" does not provide science ${
          capabilityId === "science.search" ? "search" : "get"
        }.`,
        `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
      );
    }
    if (controls === undefined) {
      accepting.push(arm);
      continue;
    }
    try {
      if (capabilityId === "science.search") {
        (capability as { validate(r: ScienceSearchRequest): void }).validate(
          request as ScienceSearchRequest,
        );
      } else {
        (capability as { validate(r: ScienceGetRequest): void }).validate(
          request as ScienceGetRequest,
        );
      }
    } catch (error) {
      if (!(error instanceof UnsupportedOptionError)) throw error;
      // The notice names the control the arm's error actually carried
      // (PRD AC-1/AC-3: supplier+control) — never the full requested
      // set, which would misattribute controls the arm accepts.
      // ponytail: one notice per caught error; adapters throw the
      // first rejected control per validate() pass. A future
      // aggregate multi-reject validate would collect here.
      notice(
        `scoutline: ${arm.id} does not support ${error.option} — excluded from this science fan-out.`,
      );
      continue;
    }
    accepting.push(arm);
  }
  if (accepting.length === 0) {
    if (arms.length === 1 && arms[0] !== undefined && capabilityId === "science.search") {
      // The pin (or a narrowed set) is the whole arm set: exclusion
      // empties it — fail loud with the rejecting arm's own error by
      // re-validating the single arm so its UnsupportedOptionError
      // surfaces verbatim (AC-5b: control rejection is NOT fallback).
      const capability = arms[0].create({ env: opts.env }).science?.search;
      if (capability !== undefined && controls !== undefined) {
        (capability as { validate(r: ScienceSearchRequest): void }).validate(
          request as ScienceSearchRequest,
        );
      }
    }
    if (controls === undefined) {
      // No controls to reject: this is an AVAILABILITY failure (a pin
      // to an unconfigured/incapable supplier, or every supplier
      // disabled) — the stderr JSON contract demands the error class
      // describe the actual failure, not a nonsense
      // "does not support option request" sentence.
      throw new ValidationError(
        `Provider "${arms[0]?.id ?? opts.explicitProvider ?? "science"}" is not configured/capable for ${capabilityId}.`,
        `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
      );
    }
    throw new UnsupportedOptionError("science", capabilityId, Object.keys(controls).join(", "));
  }
  return accepting;
}

// ---------------------------------------------------------------------------
// T10 fan-out merge (DESIGN D5 audit round 2 correction + D12 union)
// ---------------------------------------------------------------------------

/**
 * Dedup identity (D5): identifiers.doi FIRST; exact normalized-url
 * fallback for DOI-less works. Normalization is the exact-twin floor
 * (trim + lowercase); further trimming is deliberate latitude.
 */
function scienceMergeKey(work: ScienceWork): string | undefined {
  const doi = work.identifiers?.doi;
  if (doi !== undefined && doi.trim() !== "") return `doi:${doi.trim().toLowerCase()}`;
  const url = work.url?.trim().toLowerCase();
  return url !== undefined && url !== "" ? `url:${url}` : undefined;
}

/**
 * D12 field-wise union enrichment: fill fields the first arm's body
 * lacks from a duplicate later arm's body (nothing hidden), merge
 * `identifiers` subfield-wise, and KEEP the first arm's value on any
 * conflicting scalar (D5 first-supplier-wins preference). Returns a
 * NEW row; both inputs stay untouched.
 */
function unionScienceWorks(first: ScienceWork, later: ScienceWork): ScienceWork {
  const merged: Record<string, unknown> = { ...first };
  for (const [key, value] of Object.entries(later)) {
    if (key === "identifiers") continue;
    if (merged[key] === undefined) merged[key] = value;
  }
  const ids = { ...(later.identifiers ?? {}), ...(first.identifiers ?? {}) };
  if (Object.keys(ids).length > 0) merged.identifiers = ids;
  return merged as unknown as ScienceWork;
}

/**
 * Merge multi-arm result sets (T10): concatenate, then collapse
 * duplicates in FIRST-OCCURRENCE order — the D5 arm order of the
 * caller's `works` (openalex first) governs which body survives;
 * union enrichment fills the survivor. Distinct works keep their
 * relative order.
 */
function mergeScienceWorks(works: readonly ScienceWork[]): ScienceWork[] {
  const byKey = new Map<string, ScienceWork>();
  const order: string[] = [];
  const keyless: ScienceWork[] = [];
  for (const work of works) {
    const key = scienceMergeKey(work);
    if (key === undefined) {
      keyless.push(work);
      continue;
    }
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, work);
      order.push(key);
    } else {
      byKey.set(key, unionScienceWorks(prior, work));
    }
  }
  return [...order.map((key) => byKey.get(key) as ScienceWork), ...keyless];
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function sciencePresentations(text: string): Partial<Record<TextOutputMode, string>> {
  return { tty: text, compact: text, markdown: text, refs: text };
}

function renderWorksText(works: readonly ScienceWork[]): string {
  if (works.length === 0) return "science: 0 works";
  const lines = [`science: ${works.length} work(s)`];
  for (const work of works) {
    const year = work.year !== undefined ? ` (${work.year})` : "";
    lines.push(`- ${work.title}${year}\n  ${work.url}`);
  }
  return lines.join("\n");
}

function renderWorkText(work: ScienceWork): string {
  const year = work.year !== undefined ? ` (${work.year})` : "";
  return `- ${work.title}${year}\n  ${work.url}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface HandleScienceOptions {
  /** Pin from the global `--provider` flag (command-local wins). */
  readonly explicitProvider?: string;
}

/**
 * T7: derive the journal entry's cacheKey from a supplier science
 * cache identity. Science identities are `{supplier, capability:
 * "science.search"|"science.get", credentialFingerprint, request}` —
 * the `supplier`/`capability` naming differs from the
 * provider-capability identities the capture wrapper keys off, so the
 * journal derives the SAME partitioned-key shape the supplier's
 * response cache will use once the executor consults it (T10):
 * `buildProviderCacheKey` over the identity, namespace verbatim.
 */
function scienceCacheKey(identity: unknown): string | undefined {
  if (identity === null || typeof identity !== "object") return undefined;
  const record = identity as {
    supplier?: unknown;
    capability?: unknown;
    credentialFingerprint?: unknown;
    request?: unknown;
  };
  if (
    typeof record.supplier !== "string" ||
    typeof record.capability !== "string" ||
    typeof record.credentialFingerprint !== "string"
  ) {
    return undefined;
  }
  return buildProviderCacheKey({
    provider: record.supplier as ProviderId,
    capability: record.capability,
    credentialFingerprint: record.credentialFingerprint,
    request: record.request,
  });
}

/**
 * T7 journal hook — the science twin of main's `createJournalHook`,
 * scoped to the interim direct-invoke executor: the supplier
 * capability is invoked directly (no response-cache consult yet —
 * T10's executor adds that seam), so every completed run served LIVE
 * and journals ONE full entry. Facts, all read AFTER dispatch
 * resolves (thunks, matching the search precedent):
 *   - query: what the USER passed verbatim — the search query or the
 *     get identifier (AC-12: journaled identity = user-visible
 *     identity, never a supplier-munged form).
 *   - provider: the interim single-arm pin
 *     {mode:"single", effective:<served supplier>, servedFrom:"live"}
 *     from the capture cell; once T10 fans out, the arm routing takes
 *     over per the fan-out journal rules.
 *   - cacheKey/skeleton: the supplier's own science cacheIdentity
 *     recomputed through the capture wrapper's key derivation, and the
 *     url+title skeleton — the merged result-set list (search) or the
 *     single-work row (get).
 * Runs where no supplier resolved (pre-dispatch failures threw before
 * this hook could exist) journal nothing; a capture without a
 * cacheKey skips rather than poisons the log (validator NIT 1).
 */
function createScienceJournalHook(
  deps: HandlerDependencies,
  meta: {
    readonly journal: NonNullable<HandlerDependencies["journal"]>;
    readonly query: string;
    readonly resultRows: () => readonly ScienceWork[] | undefined;
    /** The science cache key, derived from the supplier identity (thunk — resolved post-dispatch). */
    readonly cacheKey: () => string | undefined;
    /** T10: the resolved fan-out arm ids (thunk — multi-arm runs journal the ordered arm set). */
    readonly arms?: () => readonly string[] | undefined;
  },
): SaveHook {
  const { capability, capture } = meta.journal;
  return async ({ resolvedSecrets, now }) => {
    const servedProvider = capture.servedProvider;
    if (servedProvider === undefined) return;
    const cacheKey = meta.cacheKey() ?? capture.cacheKey;
    if (cacheKey === undefined) return;
    const works = meta.resultRows();
    if (works === undefined) return;
    const skeleton = buildSearchSkeleton(works);
    // T10 fan-out routing (AC-12c): a multi-arm search run records the
    // ordered arm set ({mode:"fanout", arms}); a single-arm run (pin,
    // or `science get`'s single-serving walk) keeps the single shape.
    const arms = meta.arms?.();
    const entry = buildJournalEntry({
      capability,
      provider:
        arms !== undefined && arms.length > 1
          ? { mode: "fanout", arms }
          : {
              mode: "single",
              effective: servedProvider,
              servedFrom: "live",
            },
      query: meta.query,
      cacheKey,
      skeleton,
      now,
      secrets: resolvedSecrets,
      ...(capture.savedRequestId !== undefined ? { saveRef: capture.savedRequestId } : {}),
    });
    await appendJournalEntry(resolveArtifactsDir(deps.env), entry);
  };
}

export async function handleScience(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
  options: HandleScienceOptions = {},
): Promise<number> {
  const { subcommand, positional, flags, showHelp } = parseScienceArgs(args);

  if (showHelp || subcommand === undefined) {
    deps.invocation.writeStdout(SCIENCE_HELP);
    return 0;
  }

  if (subcommand !== "search" && subcommand !== "get") {
    throw new ValidationError(
      `Unknown science subcommand "${subcommand}". Valid subcommands: search, get.`,
      "Run `scoutline science search <query>` or `scoutline science get <identifier>`.",
    );
  }

  // `--provider` pin for this run: the global flag was extracted by
  // extractGlobalOptions, but it also parses command-locally — accept
  // both spellings (command-local overrides when both appear).
  const flagProvider = typeof flags.provider === "string" ? flags.provider : undefined;
  const explicitProvider = flagProvider ?? options.explicitProvider;

  const selectionOpts: SupplierSelection = {
    ...(explicitProvider !== undefined ? { explicitProvider } : {}),
    env: deps.env,
    descriptors: deps.providerDescriptors,
  };

  if (subcommand === "search") {
    const query = positional[0];
    if (query === undefined || query.trim() === "") {
      throw new ValidationError(
        "Query is required for science search.",
        'Example: scoutline science search "graph transformers" --year 2020:2024.',
      );
    }
    const controls = buildScienceControls(flags);
    const request: ScienceSearchRequest = controls !== undefined ? { query, controls } : { query };

    // Output Budget parse (strict positive-integer gate; valueless
    // flag wording per the T4 surfaces).
    const rawMaxChars = flags["max-chars"];
    if (rawMaxChars === true) {
      throw new ValidationError("--max-chars requires a value.");
    }
    const maxChars = rawMaxChars === undefined ? undefined : parseBriefMaxChars(rawMaxChars);
    let journalRows: readonly ScienceWork[] | undefined;
    let journalIdentity: unknown;
    let journalArms: readonly string[] | undefined;
    return invokeCommand(
      deps.invocation,
      async (context) => {
        // T10 fan-out: resolve the arm set INSIDE the behavior so the
        // per-arm exclusion notices ride the invokeCommand notice
        // channel (flushed on both success and failure). Controls vs
        // fan-out (D5 ruling): rejecting arms are excluded at
        // validation with one notice each — never the silent
        // classifyError continue path.
        const arms = resolveScienceArms("science.search", selectionOpts, request, context.notice);
        journalArms = arms.map((arm) => arm.id);
        // Parallel arms, one client per arm (the search fan-out
        // orchestration shape). allSettled: a later arm's failure must
        // not discard an earlier arm's already-merged works.
        const armIdentities: unknown[] = [];
        const settled = await Promise.allSettled(
          arms.map(async (arm, index) => {
            const capability = arm.create({ env: deps.env }).science?.search;
            if (capability === undefined) {
              throw new ValidationError(
                `Provider "${arm.id}" does not provide science search.`,
                `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
              );
            }
            capability.validate(request);
            // T7: the direct-invoke executor bypasses the shared
            // execution layer, so the supplier's (capture-wrapped)
            // cacheIdentity is consulted HERE — pre-invoke, matching
            // execution.ts step 2. Science identities use `supplier`
            // (not `provider`); per-arm identities are captured here
            // and the journal cacheKey is derived from the FIRST
            // FULFILLED arm below (review: a failed first arm must
            // not stamp the journal's provider partition).
            if (deps.journal !== undefined) {
              armIdentities[index] = capability.cacheIdentity?.(request);
            }
            return await capability.invoke(request);
          }),
        );
        // Deterministic failure: if every arm rejected, surface the
        // FIRST arm's (D5 order) error — never a silent all-fail.
        const firstRejected = settled.find((outcome) => outcome.status === "rejected") as
          | PromiseRejectedResult
          | undefined;
        const works = settled.flatMap((outcome) =>
          outcome.status === "fulfilled" ? outcome.value : [],
        );
        // Journal partition follows the FIRST FULFILLED arm in D5
        // order (review) — the identity of an arm that failed must
        // not produce a cache key for the wrong provider partition.
        if (deps.journal !== undefined) {
          for (let i = 0; i < settled.length; i += 1) {
            if (settled[i]?.status === "fulfilled") {
              journalIdentity = armIdentities[i];
              break;
            }
          }
        }
        // Fail only when EVERY arm rejected (review): a fulfilled arm
        // may validly return an empty result set — an empty-but-
        // successful fan-out with one failed sibling still succeeds,
        // with the sibling's failure disclosed per-arm on stderr.
        if (
          firstRejected !== undefined &&
          settled.every((outcome) => outcome.status === "rejected")
        ) {
          throw firstRejected.reason;
        }
        // D5 visible narrowing — never a silent drop: an arm that
        // failed at INVOKE time (ApiError/network) while other arms
        // serve is disclosed per-arm on stderr (search-command
        // armNotice precedent), then the partial set merges. settled
        // order equals arms order, so the index recovers the arm id.
        settled.forEach((outcome, index) => {
          if (outcome.status !== "rejected") return;
          const message =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          context.notice(
            `scoutline: ${arms[index]?.id ?? "unknown"} arm failed (${message}) — dropped from this fan-out.`,
          );
        });
        // D5 visible narrowing — never a silent drop: an arm that
        // failed at INVOKE time (ApiError/network) while other arms
        // serve is disclosed per-arm on stderr (search-command
        // armNotice precedent), then the partial set merges. settled
        // order equals arms order, so the index recovers the arm id.

        // T10 merge: DOI-first dedup identity (exact-url fallback) +
        // D12 field-wise union enrichment, first-arm (D5 order)
        // preference — mergeScienceWorks below.
        const merged = mergeScienceWorks(works);
        journalRows = merged;
        const result: CommandResult = {
          kind: "data",
          data: merged,
          presentations: sciencePresentations(renderWorksText(merged)),
        };
        return applyScienceOutputBudget(result, maxChars, {
          subcommand: "search",
          context,
          deps,
          outputMode,
          ...(explicitProvider !== undefined ? { explicitProvider } : {}),
        });
      },
      outputMode,
      deps.now,
      deps.secrets,
      undefined,
      deps.journal === undefined
        ? undefined
        : createScienceJournalHook(deps, {
            journal: deps.journal,
            query,
            resultRows: () => journalRows,
            cacheKey: () => scienceCacheKey(journalIdentity),
            arms: () => journalArms,
          }),
    );
  }

  // get
  const identifier = positional[0];
  if (identifier === undefined) {
    throw new ValidationError(
      "Identifier is required for science get.",
      "Bare forms only: 10.1038/nature12373, 31672840, 2401.12345, cs/0501001.",
    );
  }
  if (parseScienceIdentifier(identifier) === null) {
    throw new ValidationError(
      `Invalid identifier "${identifier}": expected a bare DOI, numeric PMID, or arXiv id`,
      'Bare forms only: 10.1038/nature12373, 31672840, 2401.12345, cs/0501001 (no "doi:" prefix).',
    );
  }
  const request: ScienceGetRequest = { identifier };
  // Output Budget parse (strict positive-integer gate; valueless
  // flag wording per the T4 surfaces).
  const rawMaxChars = flags["max-chars"];
  if (rawMaxChars === true) {
    throw new ValidationError("--max-chars requires a value.");
  }
  const maxChars = rawMaxChars === undefined ? undefined : parseBriefMaxChars(rawMaxChars);
  let journalWork: ScienceWork | undefined;
  let journalIdentity: unknown;
  return invokeCommand(
    deps.invocation,
    async (context) => {
      // T10 get fallback (AC-5b): walk the id-type-filtered D5 arm
      // order; a supplier ApiError reroutes to the next configured arm
      // with a stderr note naming the failed supplier AND the reroute
      // target. `--no-fallback` (fallbackEnabled === false) fails
      // strict — the effective arm's own error surfaces, no reroute.
      const kind = parseScienceIdentifier(identifier);
      const byId = scienceDescriptorIndex(deps.providerDescriptors);
      const pinnedId =
        explicitProvider !== undefined && explicitProvider !== "all" ? explicitProvider : undefined;
      if (pinnedId !== undefined && !byId.has(pinnedId)) {
        throw new ValidationError(
          `Unknown provider "${pinnedId}".`,
          `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
        );
      }
      const ordered =
        pinnedId !== undefined
          ? [pinnedId]
          : kind !== null
            ? D5_ARM_ORDER.filter((id) => ID_TYPE_SUPPLIERS[kind].includes(id))
            : [];
      const arms: ScienceDescriptorLike[] = [];
      for (const id of ordered) {
        const descriptor = byId.get(id);
        if (descriptor === undefined) continue;
        if (!descriptor.isConfigured(deps.env, "science.get")) continue;
        if (!descriptor.capabilities().has("science.get")) continue;
        arms.push(descriptor);
      }
      if (arms.length === 0) {
        throw new ValidationError(
          pinnedId !== undefined
            ? `Provider "${pinnedId}" is not available for science get.`
            : "No configured science supplier serves that identifier type.",
          `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
        );
      }
      let work: ScienceWork | undefined;
      for (let attempt = 0; attempt < arms.length; attempt += 1) {
        const arm: ScienceDescriptorLike = arms[attempt] as ScienceDescriptorLike;
        const capability = arm.create({ env: deps.env }).science?.get;
        if (capability === undefined) {
          throw new ValidationError(
            `Provider "${arm.id}" does not provide science get.`,
            `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
          );
        }
        capability.validate(request);
        // T7: the direct-invoke executor bypasses the shared execution
        // layer, so the supplier's (capture-wrapped) cacheIdentity is
        // consulted HERE — pre-invoke, matching execution.ts step 2.
        // REPLACED per attempt (review): retaining the first supplier's
        // identity would journal the fingerprint of a supplier that
        // failed and rerouted; the loop breaks on success, so the last
        // assignment is always the arm that actually served.
        if (deps.journal !== undefined) {
          journalIdentity = capability.cacheIdentity?.(request);
        }
        try {
          work = await capability.invoke(request);
          break;
        } catch (error) {
          const next: ScienceDescriptorLike | undefined = arms[attempt + 1];
          if (next === undefined || deps.fallbackEnabled === false) throw error;
          // AC-5b reroute note: failed supplier AND reroute target.
          context.notice(
            `scoutline: ${arm.id} get failed (${
              error instanceof Error ? error.message : String(error)
            }) — rerouting to ${next.id}.`,
          );
        }
      }
      if (work === undefined) {
        throw new ValidationError(
          "science get did not resolve a work.",
          "This is an internal error.",
        );
      }
      journalWork = work;
      const result: CommandResult = {
        kind: "data",
        data: work,
        presentations: sciencePresentations(renderWorkText(work)),
      };
      return applyScienceOutputBudget(result, maxChars, {
        subcommand: "get",
        context,
        deps,
        outputMode,
        ...(explicitProvider !== undefined ? { explicitProvider } : {}),
      });
    },
    outputMode,
    deps.now,
    deps.secrets,
    undefined,
    deps.journal === undefined
      ? undefined
      : createScienceJournalHook(deps, {
          journal: deps.journal,
          query: identifier,
          // Single-work identity (AC-11 amendment 2): exactly one row.
          resultRows: () => (journalWork === undefined ? undefined : [journalWork]),
          cacheKey: () => scienceCacheKey(journalIdentity),
        }),
  );
}
