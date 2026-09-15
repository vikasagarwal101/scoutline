/**
 * Science response cache + shared-seam retry — issue #140 RED tests.
 *
 * GROUND map (docs/plans/lane-i-science-cache/PLAN.md):
 *   - T1: cache seam plumbing — HandlerDependencies science triple
 *     (`scienceCache`/`scienceSleep`/`scienceRandom`), hermetic fill,
 *     total decoders in capabilities/science.ts, and the cache-key
 *     derivation exported as the single shared helper (the journal
 *     cacheKey and the response-cache key are the SAME string — ruling
 *     2: capability verbatim "science.search"/"science.get", NO
 *     operation-namespace suffix).
 *   - T2: `--no-cache` + search fan-out per-arm consult.
 *   - T3: reroute walk + get walk consult.
 *   - T4: retry via executeProviderOperation ("science-search"/
 *     "science-get", maxRetries 1, 429/QuotaError terminal).
 *   - T5: journal warm-repeat markers (per-arm hit truth, not the
 *     capture cell).
 *
 * Hermeticity: main()-driven via hermeticMainDeps (shared cache doubles
 * passed explicitly per test), fake science descriptors recording every
 * capability invoke. Tests import ../dist/... — verification order is
 * build, then test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../dist/index.js";
import { ApiError, QuotaError } from "../dist/lib/errors.js";
import { buildProviderCacheKey } from "../dist/lib/cache.js";
import {
  decodeScienceWork,
  decodeScienceWorks,
  SCIENCE_SUPPLIER_IDS,
} from "../dist/capabilities/science.js";
import { scienceCacheKey } from "../dist/commands/science.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { readLog } from "../dist/lib/artifacts.js";

const D5_ARM_ORDER = ["openalex", "arxiv", "crossref", "pubmed", "europepmc"];

/**
 * Fake science supplier double (science-fanout-merge.test.js idiom,
 * extended with per-arm invoke counters and mutable works).
 */
function makeScienceDescriptor(id, opts = {}) {
  const calls = { search: [], get: [] };
  const descriptor = {
    id,
    isConfigured: () => opts.configured?.() ?? true,
    capabilities: () => new Set(opts.caps ?? ["science.search", "science.get"]),
    create() {
      return {
        id,
        science: {
          search: {
            validate() {},
            cacheIdentity: (request) => ({
              supplier: id,
              capability: "science.search",
              credentialFingerprint: "",
              request,
            }),
            async invoke(request, signal) {
              calls.search.push({ request, signal });
              if (opts.search !== undefined)
                return opts.search(request, signal, calls.search.length);
              return opts.searchWorks !== undefined
                ? opts.searchWorks(request)
                : [{ title: `search-from-${id}`, url: `https://example.org/${id}` }];
            },
          },
          get: {
            validate() {},
            cacheIdentity: (request) => ({
              supplier: id,
              capability: "science.get",
              credentialFingerprint: "",
              request,
            }),
            async invoke(request, signal) {
              calls.get.push({ request, signal });
              if (opts.get !== undefined) return opts.get(request, signal, calls.get.length);
              return (
                opts.getWork?.(request) ?? {
                  title: `work-from-${id}`,
                  url: `https://example.org/${id}/work`,
                }
              );
            },
          },
        },
      };
    },
    credentialEnvVars: [],
  };
  return { descriptor, calls };
}

function scienceFive(perIdOpts = {}) {
  const byId = {};
  const descriptors = [];
  for (const id of D5_ARM_ORDER) {
    const made = makeScienceDescriptor(id, perIdOpts[id] ?? {});
    byId[id] = made;
    descriptors.push(made.descriptor);
  }
  return { descriptors, byId };
}

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

/**
 * In-memory ResponseCache that APPLIES the decoder on read (mirrors
 * defaultResponseCache's readCache semantics: decoder null = miss).
 * The hermetic default double returns raw values; cache-decode
 * behavior needs this honest twin.
 */
function createDecodingCache() {
  const store = new Map();
  return {
    store,
    async get(key, decoder) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      return decoder ? decoder(raw) : raw;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

async function runMain(
  argv,
  {
    descriptors,
    artifactsDir,
    scienceCache,
    scienceSleep,
    scienceRandom,
    loadScoutlineConfig,
  } = {},
) {
  const { adapter, stdout, stderr } = makeInvocation();
  const dir = artifactsDir ?? mkdtempSync(join(tmpdir(), "scoutline-sci-cache-"));
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      env: { SCOUTLINE_ARTIFACTS_DIR: dir, SCOUTLINE_CONFIG_DIR: dir },
      ...(descriptors !== undefined ? { providerDescriptors: descriptors } : {}),
      ...(scienceCache !== undefined ? { scienceCache } : {}),
      ...(scienceSleep !== undefined ? { scienceSleep } : {}),
      ...(scienceRandom !== undefined ? { scienceRandom } : {}),
      ...(loadScoutlineConfig !== undefined ? { loadScoutlineConfig } : {}),
    }),
  });
  return { status, stdout, stderr, dir };
}

// ---------------------------------------------------------------------------
// T1 — decoders (total, never-throw, unknown → typed|null)
// ---------------------------------------------------------------------------

describe("T1: decodeScienceWorks — total search decoder", () => {
  it("decodes a well-formed works array, keeping unknown extra keys", () => {
    const works = [
      {
        title: "Attention Is All You Need",
        url: "https://example.org/w",
        identifiers: { doi: "10.1/x", pmid: "1", arxivId: "1706.03762" },
        authors: ["A", "B"],
        year: 2017,
        venue: "NIPS",
        summary: "s",
        citationCount: 42,
        pdfUrl: "https://example.org/w.pdf",
        openAccess: true,
        type: "article",
        language: "en",
        updated: "2024-01-01",
        extraFutureField: { nested: [1, 2] },
      },
    ];
    const decoded = decodeScienceWorks(works);
    assert.notStrictEqual(decoded, null, "well-formed array decodes");
    assert.equal(decoded.length, 1);
    assert.deepEqual(decoded[0].identifiers, { doi: "10.1/x", pmid: "1", arxivId: "1706.03762" });
    assert.equal(decoded[0].extraFutureField.nested[1], 2, "unknown extra keys survive round-trip");
  });

  it("returns null on malformed input — non-array, null, missing title/url", () => {
    assert.strictEqual(decodeScienceWorks(null), null);
    assert.strictEqual(decodeScienceWorks(undefined), null);
    assert.strictEqual(decodeScienceWorks("nope"), null);
    assert.strictEqual(decodeScienceWorks({ results: [] }), null);
    assert.strictEqual(decodeScienceWorks([{ title: "no-url" }]), null, "url is required");
    assert.strictEqual(decodeScienceWorks([{ url: "https://x" }]), null, "title is required");
    assert.strictEqual(decodeScienceWorks([{ title: 1, url: "https://x" }]), null);
  });

  it("returns null when a KNOWN optional field carries the wrong type (strict miss)", () => {
    assert.strictEqual(
      decodeScienceWorks([{ title: "t", url: "https://x", year: "2017" }]),
      null,
      "year must be a number",
    );
    assert.strictEqual(
      decodeScienceWorks([{ title: "t", url: "https://x", authors: "Alpha" }]),
      null,
      "authors must be a string array",
    );
    assert.strictEqual(
      decodeScienceWorks([{ title: "t", url: "https://x", authors: ["Alpha", 7] }]),
      null,
      "authors entries must be strings",
    );
    assert.strictEqual(
      decodeScienceWorks([{ title: "t", url: "https://x", identifiers: { doi: 10 } }]),
      null,
      "identifiers.doi must be a string",
    );
    assert.strictEqual(
      decodeScienceWorks([{ title: "t", url: "https://x", openAccess: "yes" }]),
      null,
      "openAccess must be a boolean",
    );
    assert.strictEqual(
      decodeScienceWorks([{ title: "t", url: "https://x", citationCount: "42" }]),
      null,
    );
  });

  it("optional identifiers subfields may be individually absent", () => {
    const decoded = decodeScienceWorks([
      { title: "t", url: "https://x", identifiers: { pmid: "31672840" } },
    ]);
    assert.notStrictEqual(decoded, null);
    assert.deepEqual(decoded[0].identifiers, { pmid: "31672840" });
  });
});

describe("T1: decodeScienceWork — total get decoder", () => {
  it("decodes one well-formed work, keeping unknown extra keys", () => {
    const decoded = decodeScienceWork({
      title: "t",
      url: "https://x",
      futureField: true,
    });
    assert.notStrictEqual(decoded, null);
    assert.equal(decoded.title, "t");
    assert.strictEqual(decoded.futureField, true);
  });

  it("returns null on malformed input — arrays, nulls, missing required fields", () => {
    assert.strictEqual(decodeScienceWork(null), null);
    assert.strictEqual(decodeScienceWork([]), null, "an array is not a single work");
    assert.strictEqual(decodeScienceWork({ title: "t" }), null);
    assert.strictEqual(decodeScienceWork({ url: "https://x" }), null);
    assert.strictEqual(decodeScienceWork({ title: "t", url: "https://x", year: "y" }), null);
  });
});

// ---------------------------------------------------------------------------
// T1 — cache-key derivation equals the journal derivation (ruling 2)
// ---------------------------------------------------------------------------

describe("T1: scienceCacheKey — one derivation, capability verbatim", () => {
  it("identity → key equals buildProviderCacheKey over the identity (no operation suffix)", () => {
    const identity = {
      supplier: "openalex",
      capability: "science.search",
      credentialFingerprint: "",
      request: { query: "graph transformers" },
    };
    assert.strictEqual(
      scienceCacheKey(identity),
      buildProviderCacheKey({
        provider: "openalex",
        capability: "science.search",
        credentialFingerprint: "",
        request: { query: "graph transformers" },
      }),
    );
    // The key carries the DOTTED capability verbatim — the journal
    // partition format (science.get twin below).
    assert.match(scienceCacheKey(identity), /^v2\.science\.search\.openalex\./);
    const getIdentity = {
      supplier: "crossref",
      capability: "science.get",
      credentialFingerprint: "a".repeat(64),
      request: { identifier: "10.1038/nature12373" },
    };
    assert.match(scienceCacheKey(getIdentity), /^v2\.science\.get\.crossref\./);
  });

  it("the journaled cacheKey IS the response-cache key (main-driven equality pin)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-keyeq-"));
    try {
      const { descriptors, byId } = scienceFive();
      const { status, stderr } = await runMain(["science", "search", "graph transformers"], {
        descriptors,
        artifactsDir: dir,
      });
      assert.equal(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { log } = await readLog(dir);
      const entry = log.entries.find((e) => e.kind === "journal");
      assert.ok(entry, "journaled");
      // Derive the consult-site key from the SAME identity shape the
      // descriptor returns (first fulfilled arm = openalex) — the
      // journal entry's cacheKey must equal it byte for byte.
      const identity = {
        supplier: "openalex",
        capability: "science.search",
        credentialFingerprint: "",
        request: { query: "graph transformers" },
      };
      assert.strictEqual(entry.cacheKey, scienceCacheKey(identity));
      assert.equal(byId.openalex.calls.search.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("narrowing: non-identity shapes return undefined, never a fabricated key", () => {
    assert.strictEqual(scienceCacheKey(undefined), undefined);
    assert.strictEqual(scienceCacheKey(null), undefined);
    assert.strictEqual(scienceCacheKey("openalex"), undefined);
    assert.strictEqual(scienceCacheKey({ supplier: "openalex" }), undefined);
    assert.strictEqual(
      scienceCacheKey({ supplier: 1, capability: "science.search", credentialFingerprint: "" }),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// T1 — hermetic triple fill
// ---------------------------------------------------------------------------

describe("T1: hermeticMainDeps fills the science triple", () => {
  it("omitted scienceCache/scienceSleep/scienceRandom get in-memory defaults", () => {
    const deps = hermeticMainDeps({});
    assert.ok(deps.scienceCache && typeof deps.scienceCache.get === "function");
    assert.ok(typeof deps.scienceCache.set === "function");
    assert.equal(typeof deps.scienceSleep, "function");
    assert.equal(typeof deps.scienceRandom, "function");
  });

  it("explicit scienceCache wins over the hermetic default (same as every triple)", async () => {
    const explicit = createDecodingCache();
    const deps = hermeticMainDeps({ scienceCache: explicit });
    assert.strictEqual(deps.scienceCache, explicit);
  });
});
