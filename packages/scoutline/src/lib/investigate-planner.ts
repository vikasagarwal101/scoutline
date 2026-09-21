/**
 * Three-tier deterministic sub-query planner for `investigate`
 * (investigate-pipeline lane, Ticket T2; DESIGN.md D2, ADR-0013).
 *
 * Tier resolution order:
 *   1. explicit — the query contains an unescaped `|`: split on the
 *      SAME grammar `search --merge` uses; wins over `--context` with
 *      a notice stating the override.
 *   2. context — a `--context` file is present: `deriveSubQueries`
 *      over the parsed text, verbatim (no original prepend — context
 *      mode owns the grid, mirroring `search --context`). An empty
 *      derivation degrades to the original query.
 *   3. template — transforms of the bare question (see TEMPLATE
 *      order below).
 *
 * Byte-stable everywhere: no clocks, no randomness, no
 * locale-dependent casing beyond `toLowerCase`. The unit has no
 * filesystem access — `loadContextText` is dependency-injected;
 * production wiring lives in the orchestrator command.
 */

import { ValidationError } from "./errors.js";
import { STOPWORDS, deriveSubQueries, parseContextText } from "./context-file.js";

/**
 * PR #264 R1 (owner-approved): explicit pipe plans are capped at 8
 * sub-queries — the context tier's MAX_SUBQUERIES precedent. Exceeding
 * the cap fails loud with VALIDATION_ERROR (silent truncation rejected:
 * a truncated plan would silently under-bill the user's intent).
 */
export const MAX_EXPLICIT_SUBQUERIES = 8;

/**
 * Pinned to `src/commands/search.ts` `splitMergeSubQueries` — the
 * same split grammar the `--merge` flag defines: split on unescaped
 * `|` (a literal pipe is escaped as `\|`), unescape, trim, drop
 * empty fragments. Deliberately duplicated as a local constant: the
 * original is module-private there and this lane's file allowlist
 * keeps `search.ts` read-only (orchestrator ruling, T2 pickup).
 */
const MERGE_SPLIT_PATTERN = /(?<!\\)\|/;
const MERGE_UNESCAPE = /\\\|/g;

/**
 * Pinned to `src/lib/context-file.ts` `MIN_TERM_CHARS`/`MAX_TERM_CHARS`
 * (module-private there; allowlist keeps the file read-only — same
 * ruling as the splitter). Keep in sync with that module's D2.3 bounds.
 */
const MIN_TERM_CHARS = 4;
const MAX_TERM_CHARS = 40;

const STOPWORD_SET: ReadonlySet<string> = new Set(STOPWORDS);

const TEMPLATE_SUFFIXES = ["overview", "evidence", "criticism"] as const;

export type PlannerTier = "explicit" | "context" | "template";

export interface PlanSubQueriesOptions {
  readonly query: string;
  /** `--context` file path; presence selects the context tier. */
  readonly contextFile?: string;
}

export interface PlanSubQueriesDeps {
  /**
   * Injected context reader (production: the context-file io
   * adapter). The unit never touches the filesystem itself.
   */
  loadContextText(filePath: string): Promise<string>;
}

export interface SubQueryPlan {
  readonly subQueries: readonly string[];
  readonly tier: PlannerTier;
  readonly notice?: string;
}

/**
 * Key-terms join for the template tier: lowercase the question,
 * tokenize on non-alphanumerics, drop stopwords and tokens outside the
 * context-file term bounds, preserve order, dedupe, join with spaces.
 * Only `toLowerCase` is applied (byte-stable, no locale).
 */
export function deriveTemplateTopic(query: string): string {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < MIN_TERM_CHARS || token.length > MAX_TERM_CHARS) {
      continue;
    }
    if (STOPWORD_SET.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    terms.push(token);
  }
  return terms.join(" ");
}

/**
 * Explicit tier split — see the grammar pin above. Same fail-loud
 * contract as `search --merge`: no non-empty fragments is an error.
 * R1: > 8 fragments is VALIDATION_ERROR (never silent truncation).
 */
function splitExplicit(query: string): string[] {
  const subQueries = query
    .split(MERGE_SPLIT_PATTERN)
    .map((q) => q.replace(MERGE_UNESCAPE, "|").trim())
    .filter((q) => q.length > 0);
  if (subQueries.length === 0) {
    throw new Error("--merge requires at least one non-empty query (split with '|')");
  }
  if (subQueries.length > MAX_EXPLICIT_SUBQUERIES) {
    throw new ValidationError(
      `Explicit pipe plan exceeds the ${MAX_EXPLICIT_SUBQUERIES}-sub-query cap (${subQueries.length} fragments).`,
      "Split fewer sub-queries with '|', or move the investigation into a --context file (the context tier derives up to 8).",
    );
  }
  return subQueries;
}

/**
 * Resolve the sub-query plan for an investigation. Throws only on the
 * explicit-tier fail-loud cases (all fragments empty; > 8 fragments).
 */
export async function planSubQueries(
  options: PlanSubQueriesOptions,
  deps: PlanSubQueriesDeps,
): Promise<SubQueryPlan> {
  const hasPipes = MERGE_SPLIT_PATTERN.test(options.query);
  if (hasPipes) {
    return {
      subQueries: splitExplicit(options.query),
      tier: "explicit",
      notice: "--context ignored: explicit pipe split takes precedence over the context file",
    };
  }

  if (options.contextFile !== undefined) {
    const text = await deps.loadContextText(options.contextFile);
    const derived = [...parseContextText(text).subQueries];
    // Orchestrator ruling (T2 pickup): search's zero-derivation
    // fallback precedent — an empty derivation degrades to the
    // original query rather than an empty grid.
    const subQueries = derived.length > 0 ? derived : [options.query];
    return { subQueries, tier: "context" };
  }

  const topic = deriveTemplateTopic(options.query);
  const subQueries: string[] = [options.query];
  if (topic.length > 0) {
    subQueries.push(topic);
    for (const suffix of TEMPLATE_SUFFIXES) {
      subQueries.push(`${topic} ${suffix}`);
    }
  }
  return { subQueries: dedupe(subQueries), tier: "template" };
}

/**
 * Exact-equal dedupe on trimmed, case-sensitive members, preserving
 * first-occurrence order, capped at 5 (the template tier emits at
 * most 5 candidates, so the cap is a hard upper bound).
 */
function dedupe(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const key = candidate.trim();
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
    if (result.length === 5) {
      break;
    }
  }
  return result;
}
