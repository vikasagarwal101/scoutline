/**
 * arXiv Provider Adapter — science search + get via the Atom API.
 *
 * Keyless supplier (DESIGN D2 supplier table: no credential model
 * exists for arXiv at all) — hence no credentials.ts in this
 * directory: `credentialEnvVars` is pinned `[]` and the cache
 * fingerprint is always `""` (D4b note: keyless `""` partition, the
 * seed-18 Q4 ruling).
 *
 * Controls (DESIGN D7 table + D7 amendment): arXiv rejects ALL FOUR
 * science controls (`author`, `year`, `venue`, `type`) at validate,
 * before any transport call — honest UNSUPPORTED_OPTION, never
 * accept-and-drop and never post-filter. The year rejection is
 * meaning-based: `submittedDate` filters submission date, not
 * publication year, so a same-meaning wire mapping does not exist.
 *
 * Parsing (DESIGN D3): a deterministic hand Atom parser — no XML
 * dependency. The tokenizer is `<entry>`-block scoped: feed-level
 * `<title>`/`<id>`/`<updated>`/`opensearch:*` elements outside any
 * entry never surface as a phantom work. CDATA sections, unicode text,
 * and per-element xmlns redeclaration (`arxiv:doi`) are handled.
 * ponytail: swap for `fast-xml-parser` if fields ever go missing.
 *
 * Mapping pins (PRD AC-7d): `url` = the `rel="alternate"` link href;
 * `pdfUrl` = the `rel="related"` pdf link; `type` = the
 * `arxiv:primary_category` term (NOT the plain categories); `year`
 * from `<published>`; `summary` trimmed; `arxivId` version-stripped;
 * `citationCount` stays absent (the Atom feed carries none — absent,
 * never fabricated, AC-7c honesty).
 */
import type {
  ScienceCapability,
  ScienceCacheIdentity,
  ScienceSearchRequest,
  ScienceGetRequest,
  ScienceWork,
} from "../../capabilities/science.js";
import {
  parseScienceIdentifier,
  validateScienceGetRequest,
  validateScienceSearchRequest,
} from "../../capabilities/science.js";
import { ApiError, UnsupportedOptionError } from "../../lib/errors.js";
import type { ProviderCapability, ProviderContext } from "../types.js";
import { fetchArxivQuery, type ArxivTransportDeps } from "./client.js";
import { createArxivDiagnosticsCapability } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Atom hand parser (D3)
// ---------------------------------------------------------------------------

/**
 * Extract the inner text of the FIRST element with the given tag name
 * inside `block`, accepting a CDATA wrapper (`<![CDATA[...]]>`).
 * `tag` may be prefixed (`arxiv:doi`). Returns undefined when absent.
 */
function elementText(block: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  if (!m || m[1] === undefined) return undefined;
  return stripCdata(m[1]);
}

/** Strip a CDATA wrapper when present, returning plain text. */
function stripCdata(text: string): string {
  const m = /^<!\[CDATA\[([\s\S]*)\]\]>$/s.exec(text.trim());
  if (!m || m[1] === undefined) return text;
  return m[1];
}

/** Attribute value of the first `<tag ...>` in `block`; undefined when absent. */
function elementAttribute(block: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "i");
  const open = re.exec(block);
  if (!open) return undefined;
  const attrMatch = new RegExp(`${attr}="([^"]*)"`).exec(open[0]);
  return attrMatch ? attrMatch[1] : undefined;
}

/** All inner texts of a repeated element (e.g. every `<author><name>…`). */
function elementTextAll(block: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (m[1] !== undefined) out.push(stripCdata(m[1]).trim());
  }
  return out;
}

/**
 * Every `<link .../>` element's attribute map, in document order.
 * Self-closing form only — the arXiv feed emits void link elements.
 */
function linkElements(block: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const re = /<link(?:\s[^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const link: Record<string, string> = {};
    const attrs = /(\w+)="([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrs.exec(m[0])) !== null) {
      if (a[1] !== undefined && a[2] !== undefined) link[a[1]] = a[2];
    }
    out.push(link);
  }
  return out;
}

/** `<entry>...</entry>` blocks, in document order. Feed-level elements never enter. */
function entryBlocks(feed: string): string[] {
  const out: string[] = [];
  const re = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(feed)) !== null) {
    if (m[0] !== undefined) out.push(m[0]);
  }
  return out;
}

/**
 * Version-stripped arXiv id from an entry `<id>` URL (`1706.03762v7` →
 * `1706.03762`). The capture excludes only `?`/`#` — the legacy
 * `archive/number` form (PRD AC-4b, e.g. `cs/0501001v2`) keeps its `/`;
 * the version strip below handles the trailing `vN`.
 */
function arxivIdFromEntryId(idText: string | undefined): string | undefined {
  if (idText === undefined) return undefined;
  const m = /(?:\/abs\/)([^?#]+)$/.exec(idText.trim());
  if (!m || m[1] === undefined) return undefined;
  return m[1].replace(/v\d+$/, "");
}

/** Year from an Atom timestamp (`2017-06-12T17:57:34Z` → 2017). */
function yearFromTimestamp(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^(\d{4})/.exec(text.trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * Parse one `<entry>` block into a `ScienceWork`. `url` is the
 * `rel="alternate"` landing page; `pdfUrl` the `rel="related"` pdf
 * link; `type` the `arxiv:primary_category` term. Absent supplier
 * fields stay absent (never null, never fabricated).
 */
function parseEntry(block: string): ScienceWork {
  const title = stripCdata(elementText(block, "title") ?? "").trim();
  const idText = elementText(block, "id");
  const links = linkElements(block);
  const alternate = links.find((l) => l.rel === undefined || l.rel === "alternate");
  const pdf = links.find((l) => l.rel === "related" && l.href?.includes("/pdf/"));
  const summary = elementText(block, "summary");
  const authors = elementTextAll(block, "name");
  const primaryCategory = elementAttribute(block, "arxiv:primary_category", "term");
  const doi = elementText(block, "arxiv:doi");

  const identifiers: { doi?: string; arxivId?: string } = {};
  const arxivId = arxivIdFromEntryId(idText);
  if (arxivId !== undefined) identifiers.arxivId = arxivId;
  if (doi !== undefined) identifiers.doi = doi.trim();

  const work: ScienceWork = {
    title,
    url: alternate?.href ?? idText?.trim() ?? "",
    identifiers,
    authors,
    year: yearFromTimestamp(elementText(block, "published")),
    summary: summary !== undefined ? stripCdata(summary).trim() : undefined,
    updated: elementText(block, "updated")?.trim(),
    ...(pdf?.href !== undefined ? { pdfUrl: pdf.href } : {}),
    ...(primaryCategory !== undefined ? { type: primaryCategory } : {}),
  };
  // Normalize absent-optional fields to undefined keys absent from the
  // wire shape: ScienceWork consumers treat undefined as absent, but
  // explicit undefined properties would survive deepEqual pins.
  return JSON.parse(JSON.stringify(work)) as ScienceWork;
}

/**
 * Parse a full arXiv Atom feed into normalized works. Entry-block
 * scoped by construction: a feed with no `<entry>` maps to `[]` and
 * feed-level `<title>`/`<id>`/`<updated>` can never surface.
 */
export function parseArxivFeed(feed: string): readonly ScienceWork[] {
  return entryBlocks(feed).map(parseEntry);
}

// ---------------------------------------------------------------------------
// Science capability
// ---------------------------------------------------------------------------

/**
 * arXiv accepts NO science controls (DESIGN D7 table + amendment):
 * every control is rejected at validate, before any transport call.
 * Accept-and-drop is banned (controls-conformance guard class).
 */
const UNSUPPORTED_SCIENCE_CONTROLS = ["author", "year", "venue", "type"] as const;

function validateArxivSearchRequest(request: ScienceSearchRequest): void {
  validateScienceSearchRequest(request);
  for (const option of UNSUPPORTED_SCIENCE_CONTROLS) {
    if (request.controls?.[option] !== undefined) {
      throw new UnsupportedOptionError("arxiv", "science.search", option);
    }
  }
}

function validateArxivGetRequest(request: ScienceGetRequest): void {
  // arXiv get serves arXiv ids only (D10 ruling 3): identifiers outside
  // the bare arXiv grammar (modern + legacy) are rejected here.
  if (
    typeof request.identifier !== "string" ||
    parseScienceIdentifier(request.identifier) !== "arxiv"
  ) {
    // Delegate to the shared validator for the uniform message/shape.
    validateScienceGetRequest(request);
    // A bare DOI/PMID passes the shared grammar but is not servable by
    // arXiv — reject with the same option-error class used for wire
    // grammar mismatches downstream.
    throw new UnsupportedOptionError("arxiv", "science.get", "identifier");
  }
}

/**
 * Keyless identity: `credentialFingerprint` is always `""` (D4b note —
 * no key model exists; keyless responses are user-independent).
 */
function arxivCacheIdentity(
  capability: "science.search" | "science.get",
  request: Readonly<ScienceSearchRequest | ScienceGetRequest>,
): ScienceCacheIdentity {
  return {
    supplier: "arxiv",
    capability,
    credentialFingerprint: "",
    request,
  };
}

/** Local science search contract — see the module header. */
interface ArxivScienceSearchCapability {
  validate(request: ScienceSearchRequest): void;
  cacheIdentity(request: ScienceSearchRequest): ScienceCacheIdentity;
  invoke(
    request: ScienceSearchRequest,
    signal?: AbortSignal,
  ): Promise<readonly ScienceWork[]>;
}

/** Local science get contract — see the module header. */
interface ArxivScienceGetCapability {
  validate(request: ScienceGetRequest): void;
  cacheIdentity(request: ScienceGetRequest): ScienceCacheIdentity;
  invoke(request: ScienceGetRequest, signal?: AbortSignal): Promise<ScienceWork>;
}

/** Local ScienceCapability surface. */
interface ArxivScienceCapability {
  readonly search: ArxivScienceSearchCapability;
  readonly get: ArxivScienceGetCapability;
}

function createArxivScienceCapability(options: {
  readonly transport?: ArxivTransportDeps;
}): ArxivScienceCapability {
  const { transport } = options;

  const search: ArxivScienceSearchCapability = {
    validate: validateArxivSearchRequest,
    cacheIdentity(request) {
      return arxivCacheIdentity("science.search", request);
    },
    async invoke(request, signal) {
      search.validate(request);
      const xml = await fetchArxivQuery(
        { search_query: `all:${request.query.trim()}`, start: 0, max_results: 25 },
        transport,
        signal,
      );
      return parseArxivFeed(xml);
    },
  };

  const get: ArxivScienceGetCapability = {
    validate: validateArxivGetRequest,
    cacheIdentity(request) {
      return arxivCacheIdentity("science.get", request);
    },
    async invoke(request, signal) {
      get.validate(request);
      const xml = await fetchArxivQuery({ id_list: request.identifier }, transport, signal);
      const works = parseArxivFeed(xml);
      if (works.length === 0) {
        throw new ApiError(`arXiv returned no work for ${request.identifier}`, 404);
      }
      const work = works[0];
      if (work === undefined) {
        throw new ApiError(`arXiv returned no work for ${request.identifier}`, 404);
      }
      return work;
    },
  };

  return { search, get };
}

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

/**
 * Dependencies the arXiv Adapter accepts. The unified `transport` seam
 * carries `fetch` and timer injection (house spider/linkup pattern).
 */
export interface ArxivAdapterDependencies {
  readonly transport?: ArxivTransportDeps;
}

/** Local Adapter contract — see the module header. */
interface ArxivAdapter {
  readonly id: "arxiv";
  readonly science: ArxivScienceCapability;
  readonly diagnostics: ReturnType<typeof createArxivDiagnosticsCapability>;
}

/** Local Descriptor contract — see the module header. */
interface ArxivDescriptor {
  readonly id: "arxiv";
  isConfigured(env: NodeJS.ProcessEnv, capabilityId?: ProviderCapability): boolean;
  capabilities(): ReadonlySet<ProviderCapability>;
  create(context: ProviderContext): ArxivAdapter;
  readonly credentialEnvVars: readonly string[];
}

/**
 * arXiv capability set — the science trio plus diagnostics (D2
 * round-3). `quota` never appears (quota dashboard filter exclusion).
 */
const ARXIV_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set([
  "science.search",
  "science.get",
  "diagnostics",
]);

/**
 * Build the arXiv Provider Descriptor. Keyless and always configured:
 * `isConfigured` is true only for the no-capability form (doctor) and
 * the science trio + diagnostics — never `quota` or non-science
 * capabilities (D2 ruling, inverting the Jina keyless pattern).
 * `create()` is side-effect-free; transport runs per capability call.
 */
export function createArxivDescriptor(
  dependencies?: ArxivAdapterDependencies,
): ArxivDescriptor {
  const transport = dependencies?.transport;
  return {
    id: "arxiv",
    isConfigured(_env, capabilityId) {
      if (capabilityId === undefined) return true;
      return ARXIV_CAPABILITIES.has(capabilityId);
    },
    capabilities() {
      return ARXIV_CAPABILITIES;
    },
    create(context: ProviderContext): ArxivAdapter {
      return {
        id: "arxiv",
        science: createArxivScienceCapability({ transport }),
        diagnostics: createArxivDiagnosticsCapability({
          env: context.env,
          transport,
        }),
      };
    },
    credentialEnvVars: [],
  };
}
