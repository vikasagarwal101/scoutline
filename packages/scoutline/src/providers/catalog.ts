/**
 * Provider catalog — derived presentation values (#209).
 *
 * Every enum/count/label surface that hand-mirrored PROVIDER_IDS (the
 * `--provider` enumerations in command help, the doctor comma list, the
 * "all 15 Providers" counts, the capability-matrix column labels)
 * derives from this module. Derivations are byte-identical to the
 * literals they replace:
 * tests/provider-enum-help.test.js passes UNEDITED and proves agreement
 * by construction.
 */
import { PROVIDER_IDS, type ProviderId } from "./types.js";
import { SCIENCE_SUPPLIER_IDS } from "../capabilities/science.js";

const SCIENCE_SEATS: ReadonlySet<string> = new Set(SCIENCE_SUPPLIER_IDS);

/**
 * Shared-capability suppliers: the registry minus the five science
 * seats (which advertise science.* + diagnostics only and pin
 * `--provider` solely inside `scoutline science ...`).
 */
export const SHARED_PROVIDER_IDS: readonly ProviderId[] = PROVIDER_IDS.filter(
  (id) => !SCIENCE_SEATS.has(id),
);

/** Full registry, pipe-separated in parens: `(zai | minimax | … | europepmc)`. */
export const PROVIDER_PIPE_ENUM = `(${PROVIDER_IDS.join(" | ")})`;

/** Shared 15-id subset, pipe-separated in parens. */
export const SHARED_PROVIDER_PIPE_ENUM = `(${SHARED_PROVIDER_IDS.join(" | ")})`;

/** Full registry, comma-separated in parens (doctor style). */
export const PROVIDER_COMMA_ENUM = `(${PROVIDER_IDS.join(", ")})`;

/** Compact `<…>`-fill form for `--provider`: ids joined by `|`, no parens. */
export const SHARED_PROVIDER_FLAG_IDS = SHARED_PROVIDER_IDS.join("|");

/**
 * Canonical capability-matrix column labels (registry order). These are
 * the architecture.md/SKILL.md matrix labels, distinct from the init.ts
 * wizard labels ("Brave Search", "Perplexity Sonar", …) — init.ts is
 * not a consumer of this catalog.
 */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  zai: "Z.AI",
  minimax: "MiniMax",
  tavily: "Tavily",
  exa: "Exa",
  brave: "Brave",
  firecrawl: "Firecrawl",
  parallel: "Parallel",
  perplexity: "Perplexity",
  jina: "Jina AI",
  you: "You.com",
  linkup: "Linkup",
  spider: "Spider.cloud",
  bocha: "Bocha AI",
  searchapi: "SearchApi",
  kagi: "Kagi",
  arxiv: "arXiv",
  openalex: "OpenAlex",
  crossref: "Crossref",
  pubmed: "PubMed",
  europepmc: "Europe PMC",
};
