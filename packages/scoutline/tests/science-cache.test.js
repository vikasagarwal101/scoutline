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
import { handleScience, scienceCacheKey } from "../dist/commands/science.js";
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
              if (opts.searchThrows !== undefined) throw opts.searchThrows;
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
              if (opts.getThrows !== undefined) throw opts.getThrows;
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

// ---------------------------------------------------------------------------
// T2 — search fan-out per-arm consult + --no-cache
// ---------------------------------------------------------------------------

describe("T2: fan-out per-arm cache consult", () => {
  it("identical second search serves from cache — ZERO supplier invokes", async () => {
    const cache = createDecodingCache();
    const { descriptors, byId } = scienceFive();
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t2-warm-"));
    try {
      const r1 = await runMain(["science", "search", "warm query"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r1.status, 0, `run 1 stderr=${JSON.stringify(r1.stderr)}`);
      for (const id of D5_ARM_ORDER) {
        assert.equal(byId[id].calls.search.length, 1, `run 1: ${id} invoked once`);
      }
      const r2 = await runMain(["science", "search", "warm query"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r2.status, 0, `run 2 stderr=${JSON.stringify(r2.stderr)}`);
      for (const id of D5_ARM_ORDER) {
        assert.equal(byId[id].calls.search.length, 1, `run 2: ${id} NOT re-invoked (cache hit)`);
      }
      assert.equal(
        JSON.parse(r2.stdout.join("")).length,
        JSON.parse(r1.stdout.join("")).length,
        "run 2 output equals run 1 (merged cache hits)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--no-cache re-invokes every arm and skips BOTH read and write", async () => {
    const cache = createDecodingCache();
    const { descriptors, byId } = scienceFive();
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t2-nocache-"));
    try {
      const r1 = await runMain(["science", "search", "nocache query"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r1.status, 0);
      assert.equal(cache.store.size, 5, "run 1 seeded five per-arm entries");
      const r2 = await runMain(["science", "search", "nocache query", "--no-cache"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r2.status, 0, `--no-cache run stderr=${JSON.stringify(r2.stderr)}`);
      for (const id of D5_ARM_ORDER) {
        assert.equal(byId[id].calls.search.length, 2, `--no-cache: ${id} re-invoked`);
      }
      assert.equal(cache.store.size, 5, "--no-cache wrote nothing (five run-1 keys only)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hit arm + live sibling merge: dedup still works across cache/live arms", async () => {
    const cache = createDecodingCache();
    let arxivEnabled = false;
    const { descriptors, byId } = scienceFive({
      arxiv: { configured: () => arxivEnabled },
    });
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t2-mixed-"));
    try {
      const r1 = await runMain(["science", "search", "mixed query"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r1.status, 0);
      assert.equal(byId.arxiv.calls.search.length, 0, "run 1: arxiv not an arm");
      arxivEnabled = true;
      const r2 = await runMain(["science", "search", "mixed query"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r2.status, 0, `stderr=${JSON.stringify(r2.stderr)}`);
      assert.equal(byId.arxiv.calls.search.length, 1, "run 2: arxiv ran LIVE");
      for (const id of ["openalex", "crossref", "pubmed", "europepmc"]) {
        assert.equal(byId[id].calls.search.length, 1, `run 2: ${id} served from cache`);
      }
      const rows = JSON.parse(r2.stdout.join(""));
      assert.equal(rows.length, 5, "live arxiv row + four cached rows merge to five");
      const urls = rows.map((w) => w.url).sort();
      assert.deepEqual(urls, D5_ARM_ORDER.map((id) => `https://example.org/${id}`).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("malformed cached entry = miss + re-set (decoder null → invoke → overwrite)", async () => {
    const cache = createDecodingCache();
    const key = scienceCacheKey({
      supplier: "openalex",
      capability: "science.search",
      credentialFingerprint: "",
      request: { query: "malformed test" },
    });
    cache.store.set(key, { not: "an array" });
    const { descriptors, byId } = scienceFive();
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t2-malformed-"));
    try {
      const r = await runMain(["science", "search", "malformed test"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r.status, 0, `stderr=${JSON.stringify(r.stderr)}`);
      assert.equal(
        byId.openalex.calls.search.length,
        1,
        "malformed entry → miss → openalex invoked",
      );
      assert.notStrictEqual(
        decodeScienceWorks(cache.store.get(key)),
        null,
        "the key was overwritten with good works",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--no-cache parses on get too (accepted, invokes live)", async () => {
    const cache = createDecodingCache();
    const { descriptors, byId } = scienceFive();
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t2-getnc-"));
    try {
      const r1 = await runMain(["science", "get", "10.1038/nature12373"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      const r2 = await runMain(["science", "get", "10.1038/nature12373", "--no-cache"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r1.status, 0);
      assert.equal(r2.status, 0, "--no-cache accepted on get");
      assert.equal(byId.openalex.calls.get.length, 2, "--no-cache re-invoked openalex get");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T3 — reroute walk + get walk consult
// ---------------------------------------------------------------------------

describe("T3: pinned-search reroute walk consult", () => {
  it("pinned cache hit serves with ZERO supplier invokes and no stderr noise", async () => {
    const cache = createDecodingCache();
    const { descriptors, byId } = scienceFive();
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t3-pinhit-"));
    try {
      const r1 = await runMain(["science", "search", "pinned q", "--provider", "openalex"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r1.status, 0, `run 1 stderr=${JSON.stringify(r1.stderr)}`);
      assert.equal(byId.openalex.calls.search.length, 1);
      const r2 = await runMain(["science", "search", "pinned q", "--provider", "openalex"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r2.status, 0, `run 2 stderr=${JSON.stringify(r2.stderr)}`);
      assert.equal(byId.openalex.calls.search.length, 1, "run 2 served from cache — no re-invoke");
      assert.deepEqual(JSON.parse(r2.stdout.join("")), JSON.parse(r1.stdout.join("")));
      assert.equal(r2.stderr.length, 0, "a cache hit never failed — no reroute notice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("miss + arm failure still reroutes with the stderr notice (cache consult must not swallow reroute)", async () => {
    const cache = createDecodingCache();
    const { descriptors, byId } = scienceFive({
      openalex: { searchThrows: new ApiError("openalex down", 503) },
    });
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t3-reroute-"));
    try {
      const r = await runMain(["science", "search", "reroute q", "--provider", "openalex"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r.status, 0, `stderr=${JSON.stringify(r.stderr)}`);
      assert.equal(
        byId.openalex.calls.search.length,
        2,
        "pinned arm attempted (initial + 1 retry) and failed",
      );
      assert.equal(byId.arxiv.calls.search.length, 1, "rerouted to arxiv (D5 next)");
      assert.match(r.stderr.join(""), /rerouting to arxiv/, "reroute notice fires");
      // arxiv served live → its entry is cached for the next ask
      const arxivKey = scienceCacheKey({
        supplier: "arxiv",
        capability: "science.search",
        credentialFingerprint: "",
        request: { query: "reroute q" },
      });
      assert.ok(cache.store.has(arxivKey), "reroute-arm result was cached");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reroute-arm cache hit serves without re-invoking (pinned failure still disclosed)", async () => {
    const cache = createDecodingCache();
    // run 1: pinned arxiv (arxiv seeds its entry)
    const { descriptors, byId } = scienceFive();
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t3-rerhit-"));
    try {
      const r1 = await runMain(["science", "search", "rh q", "--provider", "arxiv"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r1.status, 0);
      assert.equal(byId.arxiv.calls.search.length, 1);
      // run 2: pinned openalex fails → reroute walk reaches arxiv → HIT
      const { descriptors: d2, byId: b2 } = scienceFive({
        openalex: { searchThrows: new ApiError("openalex down", 503) },
      });
      // reuse run 1's arxiv cache entry by sharing the cache, fresh descriptors
      const r2 = await runMain(["science", "search", "rh q", "--provider", "openalex"], {
        descriptors: d2,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r2.status, 0, `stderr=${JSON.stringify(r2.stderr)}`);
      assert.equal(b2.arxiv.calls.search.length, 0, "arxiv served from cache in the reroute walk");
      assert.match(
        r2.stderr.join(""),
        /rerouting to arxiv/,
        "the pinned failure is still disclosed",
      );
      assert.deepEqual(JSON.parse(r2.stdout.join(""))[0], {
        title: "search-from-arxiv",
        url: "https://example.org/arxiv",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T3: get walk consult", () => {
  it("get hit short-circuits the walk before later arms (failed-first-arm reroute → cached crossref)", async () => {
    const cache = createDecodingCache();
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t3-gethit-"));
    try {
      // run 1: openalex fails → crossref serves → crossref entry cached
      const { descriptors: d1, byId: b1 } = scienceFive({
        openalex: { getThrows: new ApiError("openalex down", 503) },
      });
      const r1 = await runMain(["science", "get", "10.1038/nature12373"], {
        descriptors: d1,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r1.status, 0, `run 1 stderr=${JSON.stringify(r1.stderr)}`);
      assert.equal(b1.crossref.calls.get.length, 1);
      // run 2: openalex fails again → reroute → crossref consult HIT → no invoke
      const { descriptors: d2, byId: b2 } = scienceFive({
        openalex: { getThrows: new ApiError("openalex down", 503) },
      });
      const r2 = await runMain(["science", "get", "10.1038/nature12373"], {
        descriptors: d2,
        artifactsDir: dir,
        scienceCache: cache,
      });
      assert.equal(r2.status, 0, `run 2 stderr=${JSON.stringify(r2.stderr)}`);
      assert.equal(
        b2.openalex.calls.get.length,
        2,
        "failed first arm still attempted (initial + 1 retry: miss → invoke → fail)",
      );
      assert.equal(
        b2.crossref.calls.get.length,
        0,
        "crossref served from cache — walk short-circuited",
      );
      assert.deepEqual(JSON.parse(r2.stdout.join("")), {
        title: "work-from-crossref",
        url: "https://example.org/crossref/work",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — retry via executeProviderOperation
// ---------------------------------------------------------------------------

describe("T4: retry via executeProviderOperation", () => {
  it("transient 503 → one retry, success, no stderr noise", async () => {
    const cache = createDecodingCache();
    let sleepCalls = 0;
    const { descriptors, byId } = scienceFive({
      openalex: {
        search: (_req, _signal, callNumber) => {
          if (callNumber === 1) {
            throw new ApiError("transient boom", 503);
          }
          return [{ title: "openalex-retry-success", url: "https://example.org/oa" }];
        },
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t4-retry-"));
    try {
      const r = await runMain(["science", "search", "retry test"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
        scienceSleep: async () => {
          sleepCalls += 1;
        },
        scienceRandom: () => 0.5,
      });
      assert.equal(r.status, 0, `stderr=${JSON.stringify(r.stderr)}`);
      assert.equal(
        byId.openalex.calls.search.length,
        2,
        "openalex invoked twice (initial + 1 retry)",
      );
      assert.equal(sleepCalls, 1, "sleep called once during backoff");
      assert.equal(r.stderr.length, 0, "retry is silent — no stderr notices");
      const parsed = JSON.parse(r.stdout.join(""));
      assert.ok(
        parsed.some((w) => w.title === "openalex-retry-success"),
        "openalex output merged",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("QuotaError terminal", async () => {
    const cache = createDecodingCache();
    let sleepCalls = 0;
    const { descriptors, byId } = scienceFive({
      openalex: {
        search: () => {
          throw new QuotaError("OpenAlex rate limit exceeded");
        },
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t4-quota-"));
    try {
      const r = await runMain(
        ["science", "search", "quota test", "--provider", "openalex", "--no-fallback"],
        {
          descriptors,
          artifactsDir: dir,
          scienceCache: cache,
          scienceSleep: async () => {
            sleepCalls += 1;
          },
          scienceRandom: () => 0.5,
        },
      );
      assert.notEqual(r.status, 0, "command fails on terminal QuotaError");
      assert.equal(
        byId.openalex.calls.search.length,
        1,
        "openalex invoked exactly once — no retry",
      );
      assert.equal(sleepCalls, 0, "never slept for retry backoff");
      const stderr = r.stderr.join("");
      assert.match(stderr, /QUOTA_ERROR/, "stderr envelope carries QUOTA_ERROR code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abort during backoff → immediate abort (499-class)", async () => {
    let captured = null;
    let resolveBackoff;
    const backoffGate = new Promise((resolve) => {
      resolveBackoff = resolve;
    });
    const d = makeScienceDescriptor("openalex", {
      search: () => {
        throw new ApiError("openalex 503", 503);
      },
    });
    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [d.descriptor],
      fallbackEnabled: true,
      scienceCache: createDecodingCache(),
      scienceSleep: async () => {
        resolveBackoff();
        await new Promise(() => {}); // never resolves
      },
      scienceRandom: () => 0.5,
    };

    const p = handleScience(["search", "q", "--provider", "openalex"], "data", deps, {
      registerInterrupt: (h) => {
        captured = h;
        return () => {};
      },
    });

    await backoffGate;
    assert.ok(typeof captured === "function", "registerInterrupt captured handler");
    captured();
    const status = await p;
    assert.equal(status, 1, "aborted command returns exitCode 1");
    const stderrText = inv.stderr.join("");
    // 499-class abort (plan T4): the executor's abortableSleep rejects
    // mid-backoff (TimeoutError), and the reroute walk's signal.aborted
    // catch converts it to the honest ApiError 499 cancellation — the
    // same envelope every #151 abort path surfaces.
    assert.match(stderrText, /API_ERROR/, "stderr envelope code is API_ERROR");
    assert.match(stderrText, /aborted by the caller/i, "honest cancellation wording");
    assert.match(stderrText, /499/, "499-class abort");
    assert.doesNotMatch(stderrText, /timed out/i, "never reads as a timeout");
  });

  it("cache hit NEVER retries", async () => {
    const cache = createDecodingCache();
    let sleepCalls = 0;
    let shouldThrow = false;
    const { descriptors, byId } = scienceFive({
      openalex: {
        search: () => {
          if (shouldThrow) {
            throw new ApiError("openalex down", 503);
          }
          return [{ title: "cached-work", url: "https://example.org/oa" }];
        },
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "scoutline-sci-t4-hithold-"));
    try {
      // run 1: seeds cache
      const r1 = await runMain(["science", "search", "cache q", "--provider", "openalex"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
        scienceSleep: async () => {
          sleepCalls += 1;
        },
        scienceRandom: () => 0.5,
      });
      assert.equal(r1.status, 0);
      assert.equal(byId.openalex.calls.search.length, 1);

      // run 2: warm cache, supplier would throw 503 if invoked
      shouldThrow = true;
      const r2 = await runMain(["science", "search", "cache q", "--provider", "openalex"], {
        descriptors,
        artifactsDir: dir,
        scienceCache: cache,
        scienceSleep: async () => {
          sleepCalls += 1;
        },
        scienceRandom: () => 0.5,
      });
      assert.equal(r2.status, 0, `run 2 stderr=${JSON.stringify(r2.stderr)}`);
      assert.equal(
        byId.openalex.calls.search.length,
        1,
        "no second invoke — cache hit short-circuits",
      );
      assert.equal(sleepCalls, 0, "no retry backoff sleep occurred");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
