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
 * Interim selection (T6; T10 owns the full D5 grammar): no pin → the
 * FIRST configured+capable science supplier in the D5 openalex-first
 * arm order; `--provider <id>` pins; `--provider all` is treated as
 * the no-pin default for now. TODO(T10): the default becomes fan-out
 * across all enabled science suppliers with DOI-dedup merge.
 */

import type {
  CommandResult,
  TextOutputMode,
} from "../command-invocation.js";
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
import { ValidationError } from "../lib/errors.js";
import type { OutputMode } from "../lib/output.js";
import type { HandlerDependencies } from "../index.js";
import { parseBriefMaxChars } from "./repo.js";

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
const ID_TYPE_SUPPLIERS: Readonly<
  Record<"doi" | "pmid" | "arxiv", readonly string[]>
> = {
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
  --provider <id>    Pin one supplier (${D5_ARM_ORDER.join(
    ", ",
  )}); "all" is the default fan-out

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
      : envelope !== null && typeof envelope === "object" &&
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
        ...(options.explicitProvider !== undefined
          ? { provider: options.explicitProvider }
          : {}),
      },
      provider: {
        mode: "single",
        ...(options.explicitProvider !== undefined
          ? { requested: options.explicitProvider }
          : {}),
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
  return {
    ...result,
    data: isSearch
      ? { results: projection, compaction }
      : { ...(projection as Record<string, unknown>), compaction },
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
  if (typeof flags.author === "string") controls.author = flags.author;
  if (typeof flags.venue === "string") controls.venue = flags.venue;
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
// Interim supplier selection (T6; TODO(T10): fan-out)
// ---------------------------------------------------------------------------

interface ScienceDescriptorLike {
  readonly id: string;
  isConfigured(env: NodeJS.ProcessEnv, capabilityId?: string): boolean;
  capabilities(): ReadonlySet<string>;
  create(context: { env: NodeJS.ProcessEnv }): {
    science?: {
      search?: {
        validate(request: ScienceSearchRequest): void;
        invoke(request: ScienceSearchRequest): Promise<readonly ScienceWork[]>;
      };
      get?: {
        validate(request: ScienceGetRequest): void;
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

function assertEligible(
  descriptor: ScienceDescriptorLike,
  capabilityId: "science.search" | "science.get",
  env: NodeJS.ProcessEnv,
): void {
  if (!descriptor.isConfigured(env, capabilityId)) {
    throw new ValidationError(
      `Provider "${descriptor.id}" is not configured for ${capabilityId}.`,
      `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
    );
  }
  if (!descriptor.capabilities().has(capabilityId)) {
    throw new ValidationError(
      `Provider "${descriptor.id}" does not advertise ${capabilityId}.`,
      `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
    );
  }
}

/**
 * Resolve the interim supplier for a science capability: explicit
 * `--provider <id>` pin first; otherwise walk the D5 arm order for the
 * FIRST configured+capable supplier (TODO(T10): the no-pin default
 * becomes fan-out across all enabled arms). `--provider all` is
 * treated as the no-pin default for now.
 */
function resolveInterimScienceSupplier(
  capabilityId: "science.search" | "science.get",
  opts: SupplierSelection,
): ScienceDescriptorLike {
  const byId = scienceDescriptorIndex(opts.descriptors);
  if (opts.explicitProvider !== undefined && opts.explicitProvider !== "all") {
    const pinned = byId.get(opts.explicitProvider);
    if (pinned === undefined) {
      throw new ValidationError(
        `Unknown provider "${opts.explicitProvider}".`,
        `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
      );
    }
    assertEligible(pinned, capabilityId, opts.env);
    return pinned;
  }
  for (const id of D5_ARM_ORDER) {
    const descriptor = byId.get(id);
    if (descriptor === undefined) continue;
    if (!descriptor.isConfigured(opts.env, capabilityId)) continue;
    if (!descriptor.capabilities().has(capabilityId)) continue;
    return descriptor;
  }
  throw new ValidationError(
    "No configured science supplier is available.",
    `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
  );
}

/**
 * Route `science get` by identifier type (D6/D10 Q3): the D5 arm
 * order filtered to suppliers that serve the parsed id kind. TODO(T10):
 * gains fallback reroute on failure; T6 interim is single-attempt.
 * Routing is command-layer by design — suppliers' `validate` is not
 * consulted for routing (the probes closed the membership table).
 */
function resolveGetSupplier(
  identifier: string,
  opts: SupplierSelection,
): ScienceDescriptorLike {
  if (opts.explicitProvider !== undefined && opts.explicitProvider !== "all") {
    return resolveInterimScienceSupplier("science.get", opts);
  }
  const kind = parseScienceIdentifier(identifier);
  if (kind === null) {
    throw new ValidationError(
      `Invalid identifier "${identifier}": expected a bare DOI, numeric PMID, or arXiv id`,
      'Bare forms only: 10.1038/nature12373, 31672840, 2401.12345, cs/0501001 (no "doi:" prefix).',
    );
  }
  const byId = scienceDescriptorIndex(opts.descriptors);
  // D5 arm order filtered by the id-type membership table.
  const ordered = D5_ARM_ORDER.filter((id) => ID_TYPE_SUPPLIERS[kind].includes(id));
  for (const id of ordered) {
    const descriptor = byId.get(id);
    if (descriptor === undefined) continue;
    if (!descriptor.isConfigured(opts.env, "science.get")) continue;
    if (!descriptor.capabilities().has("science.get")) continue;
    return descriptor;
  }
  throw new ValidationError(
    "No configured science supplier serves that identifier type.",
    `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
  );
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
  /** Interim pin from the global `--provider` flag (command-local wins). */
  readonly explicitProvider?: string;
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
    const request: ScienceSearchRequest =
      controls !== undefined ? { query, controls } : { query };

    const descriptor = resolveInterimScienceSupplier("science.search", selectionOpts);
    const adapter = descriptor.create({ env: deps.env });
    const capability = adapter.science?.search;
    if (capability === undefined) {
      throw new ValidationError(
        `Provider "${descriptor.id}" does not provide science search.`,
        `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
      );
    }
    capability.validate(request);
    // Output Budget parse (strict positive-integer gate; valueless
    // flag wording per the T4 surfaces).
    const rawMaxChars = flags["max-chars"];
    if (rawMaxChars === true) {
      throw new ValidationError("--max-chars requires a value.");
    }
    const maxChars = rawMaxChars === undefined ? undefined : parseBriefMaxChars(rawMaxChars);
    return invokeCommand(
      deps.invocation,
      async (context) => {
        const works = await capability.invoke(request);
        const result: CommandResult = {
          kind: "data",
          data: works,
          presentations: sciencePresentations(renderWorksText(works)),
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
  const descriptor = resolveGetSupplier(identifier, selectionOpts);
  const adapter = descriptor.create({ env: deps.env });
  const capability = adapter.science?.get;
  if (capability === undefined) {
    throw new ValidationError(
      `Provider "${descriptor.id}" does not provide science get.`,
      `Science suppliers: ${D5_ARM_ORDER.join(", ")}.`,
    );
  }
  capability.validate(request);
  const rawMaxChars = flags["max-chars"];
  if (rawMaxChars === true) {
    throw new ValidationError("--max-chars requires a value.");
  }
  const maxChars = rawMaxChars === undefined ? undefined : parseBriefMaxChars(rawMaxChars);
  return invokeCommand(
    deps.invocation,
    async (context) => {
      const work = await capability.invoke(request);
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
  );
}
