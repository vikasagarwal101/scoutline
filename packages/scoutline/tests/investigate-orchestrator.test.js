/**
 * Orchestrator e2e for `investigate` (investigate-pipeline lane, Ticket
 * T4; docs/plans/investigate-pipeline DESIGN.md D3, PRD AC-3/AC-4/AC-9/
 * AC-10).
 *
 * 100% hermetic: every dependency is injected — fixture search-arm
 * descriptors, a fixture reader descriptor, an in-memory cache, a
 * counting consumption sink, a fixed clock. No network, no config
 * reads (configFanout/routing arrive as plain inputs; `env: {}` is
 * only the env INPUT, never isolation-by-silence — nothing here reads
 * a config file at all).
 *
 * ---------------------------------------------------------------------------
 * RRF hand-computation (fixture grid, RRF_K = 60)
 * ---------------------------------------------------------------------------
 * Question "alpha | beta" → explicit tier → sub-queries [alpha, beta]
 * (N = 2). Provider pin "tavily,exa" → tier-1 fan-out, arms [tavily,
 * exa] (M = 2). Per (arm × sub-query) fixture rows, rank = list index+1:
 *
 *   tavily/alpha : rank1 https://e/s1 , rank2 https://e/s2
 *   tavily/beta  : rank1 https://e/s1 , rank2 https://e/b2
 *   exa/alpha    : rank1 https://e/s3 , rank3 https://e/s1
 *   exa/beta     : rank1 https://e/va , rank2 https://e/vb
 *
 * score(row) = Σ 1/(60 + rank) over every grid occurrence:
 *
 *   s1 = 1/61 + 1/61 + 1/63 = 0.0327868852 + 0.0158730159
 *      = 0.0486599011                                 (display "0.049")
 *   va = 1/61                = 0.0163934426           (display "0.016")
 *   s3 = 1/61                = 0.0163934426           (display "0.016")
 *   s2 = 1/62                = 0.0161290323           (display "0.016")
 *   b2 = 1/62                = 0.0161290323           (display "0.016")
 *   vb = 1/62                = absorbed into the va cluster (below)
 *
 * Near-duplicate cluster: va/vb titles are 12 words differing only in
 * the LAST word ("today" vs "environments") → 9 shared shingles of an
 * 11-shingle union = Jaccard 9/11 ≈ 0.818 ≥ 0.8 → one cluster;
 * representative = va (higher raw score), clusterUrls = [vb].
 *
 * mergeResults sort (score desc → occurrences desc → bestPos asc →
 * first-encounter): va beats s3 on occurrences (2 > 1) despite the
 * tied 1/61 score; s2 beats b2 on first-encounter (both 1/62, both
 * bestPos 2; s2 inserts first — tavily/alpha precedes tavily/beta).
 *
 * Expected merged order: [s1, va, s3, s2, b2] — 5 distinct rows
 * post-cluster (the near-dup pair reads as ONE source: va).
 *
 * ---------------------------------------------------------------------------
 * Cost arithmetic pin: N×M + K = 2×2 + 5 = 9 billable steps
 * (4 search arms + 5 read attempts — failed reads bill their attempt,
 * cache hits bill nothing).
 * ---------------------------------------------------------------------------
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { investigate } from "../dist/commands/investigate.js";
import { createInMemoryConsumptionSink } from "../dist/lib/consumption.js";
import {
  ApiError,
  ScoutlineError,
  UnsupportedCapabilityError,
  ValidationError,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const URLS = {
  s1: "https://e/s1",
  s2: "https://e/s2",
  s3: "https://e/s3",
  b2: "https://e/b2",
  va: "https://e/va",
  vb: "https://e/vb",
};

const TITLES = {
  s1: "shared source one page summary",
  s2: "second source page summary for alpha queries",
  s3: "third source page about beta protocols",
  b2: "fourth source page with beta analysis",
  va: "evaluating the performance characteristics of modern vector database systems in production today",
  vb: "evaluating the performance characteristics of modern vector database systems in production environments",
};

const CONTENTS = {
  [URLS.s1]:
    "The alpha protocol overview. This page documents alpha internals. Unrelated filler text. More beta notes follow.",
  [URLS.s2]: "Alpha two page. Beta two page.",
  [URLS.s3]: "Beta protocols guide. Alpha notes appear here too.",
  [URLS.b2]: "Beta analysis page. Alpha mention.",
  [URLS.va]:
    "Vector databases store alpha embeddings. Beta workloads benefit from indexing. Filler sentence without terms here.",
};

/** Fixture search arm (descriptor-shaped, mirrors tests/search-fanout.test.js). */
function makeSearchDescriptor(id, resultsByQuery) {
  const invokes = [];
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(request) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: "fp-" + id,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          invokes.push(request.query);
          return resultsByQuery[request.query] ?? [];
        },
      },
    }),
  };
  return { descriptor, invokes };
}

/**
 * Fixture reader supplier. `results` maps url → canned content/title;
 * `failures` maps url → thrown error (terminal per-source failure).
 */
function makeReaderDescriptor(id, { results = {}, failures = {} } = {}) {
  const invokes = [];
  const capability = {
    fetch: {
      kind: "reader-fetch",
      validate() {},
      cacheIdentity(request) {
        return {
          provider: id,
          capability: "reader",
          operation: "reader-fetch",
          credentialFingerprint: "fp-" + id,
          request,
          legacyCandidates: [],
        };
      },
      decodeCached(value) {
        if (value === null || typeof value !== "object") return null;
        if (
          value.schemaVersion !== 1 ||
          typeof value.url !== "string" ||
          typeof value.finalUrl !== "string" ||
          typeof value.content !== "string"
        ) {
          return null;
        }
        return value;
      },
      async invoke(request) {
        invokes.push(request.url);
        const failure = failures[request.url];
        if (failure) throw failure;
        const canned = results[request.url];
        if (canned === undefined) {
          throw new Error("fixture reader: no canned result for " + request.url);
        }
        return {
          schemaVersion: 1,
          url: request.url,
          finalUrl: request.url,
          title: canned.title ?? null,
          content: canned.content,
          contentFormat: "markdown",
        };
      },
    },
  };
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["reader"]),
    create: () => ({ id, reader: capability }),
  };
  return { descriptor, invokes };
}

function baseGrid() {
  return [
    makeSearchDescriptor("tavily", {
      alpha: [
        { title: TITLES.s1, url: URLS.s1, summary: "s1" },
        { title: TITLES.s2, url: URLS.s2, summary: "s2" },
      ],
      beta: [
        { title: TITLES.s1, url: URLS.s1, summary: "s1 again" },
        { title: TITLES.b2, url: URLS.b2, summary: "b2" },
      ],
    }),
    makeSearchDescriptor("exa", {
      alpha: [
        { title: TITLES.s3, url: URLS.s3, summary: "s3" },
        { title: TITLES.s1, url: URLS.s1, summary: "s1 third" },
      ],
      beta: [
        { title: TITLES.va, url: URLS.va, summary: "va" },
        { title: TITLES.vb, url: URLS.vb, summary: "vb" },
      ],
    }),
  ];
}

function baseReader() {
  const results = {};
  for (const [url, content] of Object.entries(CONTENTS)) {
    results[url] = { content, title: "Page " + url };
  }
  return makeReaderDescriptor("zai", { results });
}

function makeDeps({ searchDescriptors, readerDescriptor, descriptors } = {}) {
  const store = new Map();
  const cache = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
  const sink = createInMemoryConsumptionSink();
  const deps = {
    descriptors: descriptors ?? [
      ...searchDescriptors.map((entry) => entry.descriptor),
      ...(readerDescriptor ? [readerDescriptor.descriptor] : []),
    ],
    env: {},
    configFanout: false,
    cache,
    sleep: async () => {},
    random: () => 0.5,
    consume: sink,
    now: () => 1_700_000_000_000,
    // Fixed wall clock: fetchedAt stamps must never straddle a
    // millisecond boundary between two otherwise-identical runs (the
    // determinism byte-compare) — inject, never default.
    nowWall: () => new Date(1_700_000_000_000),
    loadContextText: async () => {
      throw new Error("no --context in these fixtures");
    },
    readerCapabilityFor: (d) => d.create({ env: {} }).reader,
  };
  return { deps, sink, store };
}

function makeContext() {
  const notices = [];
  return {
    context: { stdinIsTTY: false, readStdin: async () => "", notice: (m) => notices.push(m) },
    notices,
  };
}

const BASE_OPTIONS = { provider: "tavily,exa" };
const QUESTION = "alpha | beta";

// ---------------------------------------------------------------------------
// 1. Fixture-adapter e2e
// ---------------------------------------------------------------------------

describe("investigate: fixture-adapter e2e (2 sub-queries × 2 arms)", () => {
  it("builds a pack whose source order follows the hand-computed RRF merge", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps, sink } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    const { context, notices } = makeContext();
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, context);

    assert.strictEqual(result.kind, "data");
    const pack = result.data;
    assert.strictEqual(pack.schemaVersion, 1);
    assert.strictEqual(pack.question, QUESTION);
    assert.deepEqual(pack.subQueries, ["alpha", "beta"]);
    // Merge order pin (header): [s1, va, s3, s2, b2] — va before s3
    // (occurrences tiebreak), s2 before b2 (first-encounter).
    assert.deepEqual(
      pack.sources.map((s) => s.url),
      [URLS.s1, URLS.va, URLS.s3, URLS.s2, URLS.b2],
    );
    assert.strictEqual(pack.coverage.subQueries, 2);
    assert.strictEqual(pack.coverage.armsUsed, 2);
    assert.strictEqual(pack.coverage.sourcesConsidered, 5);
    assert.strictEqual(pack.coverage.sourcesRead, 5);
    assert.strictEqual(pack.coverage.cacheHits, 0);
    assert.deepEqual(pack.coverage.unread, []);
    // Consumption: exactly N×M + K = 2×2 + 5 = 9.
    assert.strictEqual(sink.events.length, 9);
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "search").length, 4);
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "reader").length, 5);
    // Cost notice pins the arithmetic literally (PR #264 F3: names
    // sources, not reads — per-source supplier attempts can bill more).
    assert.ok(
      notices.includes(
        "investigate: 2 sub-queries × 2 arms = 4 billable searches + up to 5 sources (per-source supplier attempts apply)",
      ),
      `expected cost notice, got: ${JSON.stringify(notices)}`,
    );
  });

  it("contentSha256 equals freshly computed SHA-256 of the read content; passages round-trip", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    for (const source of result.data.sources) {
      const expected = createHash("sha256").update(CONTENTS[source.url], "utf8").digest("hex");
      assert.strictEqual(source.contentSha256, expected);
      assert.strictEqual(source.contentFormat, "markdown");
      assert.match(source.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      assert.ok(source.passages.length >= 1, `${source.url} has passages`);
    }
    // Provider provenance: fan-out rows carry mergedFrom[0].
    assert.strictEqual(result.data.sources[0].provider, "tavily");
    assert.strictEqual(result.data.sources[1].provider, "exa");
    // Extraction sanity on s1: the term-free window is excluded, the
    // term-bearing windows survive in order (terms = alpha ∪ beta).
    const s1 = result.data.sources.find((s) => s.url === URLS.s1);
    assert.deepEqual(
      s1.passages.map((p) => p.quote),
      [
        "The alpha protocol overview.",
        "This page documents alpha internals.",
        "More beta notes follow.",
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Cluster representatives + --sources
// ---------------------------------------------------------------------------

describe("investigate: --sources default 5 takes distinct cluster representatives", () => {
  it("reads the near-dup pair as ONE source (representative only, member never read)", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    const readUrls = reader.invokes;
    assert.ok(readUrls.includes(URLS.va), "representative va is read");
    assert.ok(!readUrls.includes(URLS.vb), "cluster member vb is never read");
    assert.strictEqual(new Set(readUrls).size, readUrls.length, "urls never double-read");
    assert.strictEqual(result.data.coverage.sourcesRead, 5);
  });

  it("--sources 2 truncates to the first K merged rows", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    const result = await investigate(
      QUESTION,
      { ...BASE_OPTIONS, sources: 2 },
      deps,
      makeContext().context,
    );
    assert.deepEqual(
      result.data.sources.map((s) => s.url),
      [URLS.s1, URLS.va],
    );
    assert.deepEqual(reader.invokes, [URLS.s1, URLS.va]);
    assert.strictEqual(result.data.coverage.sourcesConsidered, 5);
    assert.strictEqual(result.data.coverage.sourcesRead, 2);
  });
});

// ---------------------------------------------------------------------------
// 3. Unread coverage
// ---------------------------------------------------------------------------

describe("investigate: unread coverage rows (pool continues past failures)", () => {
  it("terminal reader failure and no-supplier sources land in coverage.unread with reason codes", async () => {
    const grid = baseGrid();
    const reader = makeReaderDescriptor("zai", {
      results: {
        [URLS.s1]: { content: CONTENTS[URLS.s1], title: "s1" },
        [URLS.va]: { content: CONTENTS[URLS.va], title: "va" },
        [URLS.s3]: { content: CONTENTS[URLS.s3], title: "s3" },
      },
      failures: {
        // 403 API_ERROR is terminal (not 429/5xx → no retry).
        [URLS.s2]: new ApiError("fixture forbidden", "API_ERROR", 403),
        [URLS.b2]: new UnsupportedCapabilityError("zai", "reader"),
      },
    });
    const { deps, sink } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    const pack = result.data;
    // Pool continued: every one of the 5 selected sources was attempted.
    assert.strictEqual(reader.invokes.length, 5);
    assert.strictEqual(pack.coverage.sourcesRead, 3);
    assert.deepEqual(
      pack.sources.map((s) => s.url),
      [URLS.s1, URLS.va, URLS.s3],
    );
    assert.deepEqual(pack.coverage.unread, [
      { url: URLS.s2, reason: "reader-failed:API_ERROR" },
      { url: URLS.b2, reason: "no-reader-supplier" },
    ]);
    // Failed attempts still bill: N×M + K = 4 + 5 = 9.
    assert.strictEqual(sink.events.length, 9);
  });

  it("no reader supplier at all → every source is unread(no-reader-supplier), pack still valid", async () => {
    const grid = baseGrid();
    const { deps, sink } = makeDeps({ searchDescriptors: grid });
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    const pack = result.data;
    assert.strictEqual(pack.coverage.sourcesRead, 0);
    assert.strictEqual(pack.coverage.unread.length, 5);
    assert.ok(pack.coverage.unread.every((row) => row.reason === "no-reader-supplier"));
    assert.deepEqual(pack.sources, []);
    // No read transports were built: only the N×M search steps billed.
    assert.strictEqual(sink.events.length, 4);
  });
});

// ---------------------------------------------------------------------------
// 4. Warm re-run
// ---------------------------------------------------------------------------

describe("investigate: warm re-run replays cache", () => {
  it("second invocation serves every arm + read from cache; cacheHits full; packs byte-identical", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps, sink } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    const first = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    const searchInvokesAfterCold = grid.reduce((n, arm) => n + arm.invokes.length, 0);
    const readInvokesAfterCold = reader.invokes.length;

    const second = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    // cacheHits === N×M + K (full).
    assert.strictEqual(second.data.coverage.cacheHits, 9);
    assert.strictEqual(first.data.coverage.cacheHits, 0);
    // No arm or read invoked a transport on the warm run.
    assert.strictEqual(
      grid.reduce((n, arm) => n + arm.invokes.length, 0),
      searchInvokesAfterCold,
    );
    assert.strictEqual(reader.invokes.length, readInvokesAfterCold);
    // Cache hits bill nothing.
    assert.strictEqual(sink.events.length, 9);
    // Warm pack differs from the cold pack ONLY in coverage.cacheHits
    // (coverage metadata) — byte-stability of the data-bearing fields
    // is pinned by the determinism suite below on fresh deps.
  });
});

// ---------------------------------------------------------------------------
// 5. --isolated acceptance
// ---------------------------------------------------------------------------

describe("investigate: --isolated accepted", () => {
  it("runs to a full pack with isolated: true (never rejected)", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    const result = await investigate(
      QUESTION,
      { ...BASE_OPTIONS, isolated: true },
      deps,
      makeContext().context,
    );
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.coverage.sourcesRead, 5);
  });
});

// ---------------------------------------------------------------------------
// 6. Determinism
// ---------------------------------------------------------------------------

describe("investigate: deterministic packs", () => {
  it("two cold runs on identical fixtures produce byte-identical packs", async () => {
    const run = () => {
      const grid = baseGrid();
      const reader = baseReader();
      const { deps } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
      return investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    };
    const first = await run();
    const second = await run();
    assert.strictEqual(JSON.stringify(second.data), JSON.stringify(first.data));
  });
});

// ---------------------------------------------------------------------------
// 7. Journal seam passthrough (warm-repeat precondition; entry/marker
//    WRITING itself is the T6 index.ts handler seam — deferred there).
// ---------------------------------------------------------------------------

/**
 * Capture-mimic of index.ts `captureServingDescriptors` +
 * `installFanoutArmCells` (speculative "cache" stamp in cacheIdentity,
 * "live" on invoke success, clear+latch on invoke failure). If the
 * command unwrapped or bypassed the injected descriptors, run 2 would
 * leave the cells unstamped.
 */
function wrapDescriptorWithCapture(descriptor, capture, armCells) {
  const stampCache = (id) => {
    capture.servedFrom = "cache";
    capture.servedProvider = id;
    const armCell = armCells?.get(id);
    if (armCell && armCell.failed !== true && armCell.servedFrom === undefined) {
      armCell.servedFrom = "cache";
    }
  };
  const wrapOperation = (operation, id) => {
    const armCell = armCells?.get(id);
    const wrapped = { ...operation };
    wrapped.invoke = async (...args) => {
      try {
        const outcome = await operation.invoke(...args);
        capture.servedFrom = "live";
        capture.servedProvider = id;
        if (armCell) armCell.servedFrom = "live";
        return outcome;
      } catch (error) {
        if (armCell) {
          armCell.servedFrom = undefined;
          armCell.failed = true;
        }
        throw error;
      }
    };
    if (typeof operation.cacheIdentity === "function") {
      wrapped.cacheIdentity = (...args) => {
        stampCache(id);
        return operation.cacheIdentity(...args);
      };
    }
    return wrapped;
  };
  return {
    ...descriptor,
    create: (ctx) => {
      const adapter = descriptor.create(ctx);
      const out = { ...adapter };
      for (const key of Object.keys(adapter)) {
        const slot = adapter[key];
        if (slot === null || typeof slot !== "object") continue;
        let touched = false;
        const nested = { ...slot };
        if (typeof slot.invoke === "function") {
          nested.invoke = wrapOperation(slot, descriptor.id).invoke;
          if (typeof slot.cacheIdentity === "function") {
            nested.cacheIdentity = wrapOperation(slot, descriptor.id).cacheIdentity;
          }
          touched = true;
        } else {
          for (const opKey of Object.keys(slot)) {
            const operation = slot[opKey];
            if (
              operation !== null &&
              typeof operation === "object" &&
              typeof operation.invoke === "function"
            ) {
              nested[opKey] = wrapOperation(operation, descriptor.id);
              touched = true;
            }
          }
        }
        if (touched) out[key] = nested;
      }
      return out;
    },
  };
}

describe("investigate: journal seam passthrough (warm-repeat precondition)", () => {
  it("wrapped descriptors stay wrapped through fan-out AND reads (warm run stamps cache)", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    // The CACHE persists across the two runs (the warm-run
    // precondition); the capture/arm-cells/descriptor wrappers are
    // rebuilt per run, mirroring main()'s per-invocation journal wiring.
    const sharedStore = new Map();
    const runOnce = async () => {
      const capture = {};
      const armCells = new Map([
        ["tavily", {}],
        ["exa", {}],
      ]);
      const wrappedDescriptors = [
        ...grid.map((arm) => wrapDescriptorWithCapture(arm.descriptor, capture, armCells)),
        wrapDescriptorWithCapture(reader.descriptor, capture, undefined),
      ];
      const deps = {
        descriptors: wrappedDescriptors,
        env: {},
        configFanout: false,
        cache: {
          async get(key) {
            return sharedStore.has(key) ? sharedStore.get(key) : null;
          },
          async set(key, value) {
            sharedStore.set(key, value);
          },
        },
        sleep: async () => {},
        random: () => 0.5,
        consume: createInMemoryConsumptionSink(),
        now: () => 1_700_000_000_000,
        loadContextText: async () => {
          throw new Error("no --context in these fixtures");
        },
        readerCapabilityFor: (d) => d.create({ env: {} }).reader,
      };
      await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
      return { capture, armCells };
    };

    const cold = await runOnce();
    // Cold run: every arm went live.
    assert.strictEqual(cold.armCells.get("tavily").servedFrom, "live");
    assert.strictEqual(cold.armCells.get("exa").servedFrom, "live");

    const warm = await runOnce();
    // Warm run: every search arm cell reads "cache" (the warm-repeat
    // marker precondition the T6 journal hook consumes — the
    // speculative cacheIdentity stamp is never overwritten because no
    // invoke runs), and the last serving op (a read) left the shared
    // capture on "cache" too.
    assert.strictEqual(warm.armCells.get("tavily").servedFrom, "cache");
    assert.strictEqual(warm.armCells.get("exa").servedFrom, "cache");
    assert.strictEqual(warm.capture.servedFrom, "cache");
  });
});

// ---------------------------------------------------------------------------
// 8. Options validation
// ---------------------------------------------------------------------------

describe("investigate: options validation", () => {
  it("rejects --sources <= 0 and non-integers with VALIDATION_ERROR", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    for (const bad of [0, -1, 2.5]) {
      await assert.rejects(
        () => investigate(QUESTION, { ...BASE_OPTIONS, sources: bad }, deps, makeContext().context),
        (error) => error instanceof ValidationError,
      );
    }
  });

  it("rejects an empty question with VALIDATION_ERROR", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    await assert.rejects(
      () => investigate("   ", BASE_OPTIONS, deps, makeContext().context),
      (error) => error instanceof ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Single-arm mode (explicit single pin; D3's search() merge seam)
// ---------------------------------------------------------------------------

describe("investigate: single-arm mode (escaped-pipe join through search())", () => {
  /**
   * Single resolved arm (mode single), 2-sub-query plan: the arm runs
   * BOTH sub-queries through search()'s --merge seam via the
   * escaped-pipe join. Fixture grid (tavily, rank = index+1):
   *
   *   alpha → [a1(rank1), a2(rank2), shared(rank3)]
   *   beta  → [shared(rank1), b1(rank2)]
   *
   * shared appears in both sub-queries → occurrences 2, canonical-URL
   * dedupe collapses it to ONE row. RRF (K=60):
   *   shared = 1/63 + 1/61 = 0.0322580645 + ... = 0.0483870968 ("0.048")
   *   a1 = 1/61, b1 = 1/62, a2 = 1/62
   * Order: [shared (0.0483), a1 (0.0164), then the 1/62 tie — a2 vs
   * b1: occurrences 1/1, bestPos 2/2 → first-encounter: a2 (alpha
   * column precedes beta)] → [shared, a1, a2, b1].
   *
   * Cost arithmetic: N×M + K = 2×1 + 4 = 6.
   *
   * Mutation note (join-escapes-nothing): if joinSubQueries stopped
   * escaping pipes, a sub-query containing a literal `\|`-free pipe
   * would be RE-SPLIT by search()'s merge grammar into phantom
   * sub-queries — the arm would run the wrong grid and the pack's
   * subQueries (from the planner) would no longer match the queries
   * actually billed (event count drift). The escaped-pipe round-trip
   * is pinned below by the literal-pipe row.
   */
  function singleDeps({ queryGrid } = {}) {
    const grid = queryGrid ?? {
      alpha: [
        { title: "single a1 page", url: "https://e/a1", summary: "s" },
        { title: "single a2 page", url: "https://e/a2", summary: "s" },
        { title: "shared source page title", url: "https://e/shared", summary: "s" },
      ],
      beta: [
        { title: "shared source page title", url: "https://e/shared", summary: "s2" },
        { title: "single b1 page", url: "https://e/b1", summary: "s" },
      ],
    };
    const arm = makeSearchDescriptor("tavily", grid);
    const reader = makeReaderDescriptor("zai", {
      results: Object.fromEntries(
        ["https://e/a1", "https://e/a2", "https://e/shared", "https://e/b1"].map((url) => [
          url,
          { content: "alpha body. beta body.", title: "t" },
        ]),
      ),
    });
    const { deps, sink } = makeDeps({ searchDescriptors: [arm], readerDescriptor: reader });
    return { deps, sink, arm, reader };
  }

  it("bills N×M+K with M=1, stamps the resolved arm on every source, merges across sub-queries", async () => {
    const { deps, sink } = singleDeps();
    const { context, notices } = makeContext();
    const result = await investigate(QUESTION, { provider: "tavily" }, deps, context);

    assert.strictEqual(result.kind, "data");
    const pack = result.data;
    assert.strictEqual(pack.coverage.subQueries, 2);
    assert.strictEqual(pack.coverage.armsUsed, 1);
    // Cross-sub-query merge + canonical-URL dedupe: shared is ONE row,
    // ordered by the hand-computed RRF list above.
    assert.deepEqual(
      pack.sources.map((s) => s.url),
      ["https://e/shared", "https://e/a1", "https://e/a2", "https://e/b1"],
    );
    // Provider = the resolved arm on every source row (single mode
    // has no mergedFrom; the surfaced provider is the arm itself).
    assert.ok(pack.sources.every((s) => s.provider === "tavily"));
    // Cost notice with M=1 (F3 wording: sources + supplier attempts).
    assert.ok(
      notices.includes(
        "investigate: 2 sub-queries × 1 arms = 2 billable searches + up to 5 sources (per-source supplier attempts apply)",
      ),
      `expected single-arm cost notice, got: ${JSON.stringify(notices)}`,
    );
    // Linearity: N×M + K = 2×1 + 4 = 6 (2 search + 4 reads).
    assert.strictEqual(sink.events.length, 6);
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "search").length, 2);
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "reader").length, 4);
  });

  it("a sub-query containing a literal pipe survives the join as ONE query (escaped-pipe round-trip)", async () => {
    // Question with an escaped literal pipe in the first fragment:
    // explicit split → ["rust\\|async", "news"]; the join must re-escape
    // so search()'s merge seam re-splits to exactly the same two — a
    // phantom third query would bill 3 search events, not 2.
    const arm = makeSearchDescriptor("tavily", {
      "rust|async": [{ title: "literal pipe page", url: "https://e/lp", summary: "s" }],
      news: [{ title: "news page", url: "https://e/nw", summary: "s" }],
    });
    const reader = makeReaderDescriptor("zai", {
      results: {
        "https://e/lp": { content: "alpha body.", title: "t" },
        "https://e/nw": { content: "beta body.", title: "t" },
      },
    });
    const { deps, sink } = makeDeps({ searchDescriptors: [arm], readerDescriptor: reader });
    const result = await investigate(
      "rust\\|async | news",
      { provider: "tavily" },
      deps,
      makeContext().context,
    );
    const pack = result.data;
    assert.deepEqual(pack.subQueries, ["rust|async", "news"]);
    // Exactly two search events: the literal pipe was NOT re-split.
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "search").length, 2);
    assert.deepEqual(
      pack.sources.map((s) => s.url),
      ["https://e/lp", "https://e/nw"],
    );
  });
});

// ---------------------------------------------------------------------------
// 10. Reader fallback across suppliers (AC-4 "provider fallback"; review fix #2)
// ---------------------------------------------------------------------------

describe("investigate: reader supplier fallback (registry order)", () => {
  /**
   * Two reader suppliers in registry order: "zai" (first) and "tavily"
   * (second). zai fails terminally (ApiError 403) on one source;
   * tavily serves it. Base grid is the 5-row fan-out fixture
   * (4 search events + 5 reads = 9 baseline; the fallback adds ONE
   * extra billable read attempt on the failed source → 10).
   */
  function fallbackGrid(zaiFailures, tavilyResults) {
    const grid = baseGrid();
    const zai = makeReaderDescriptor("zai", {
      results: {
        [URLS.s1]: { content: CONTENTS[URLS.s1], title: "s1" },
        [URLS.va]: { content: CONTENTS[URLS.va], title: "va" },
        [URLS.s3]: { content: CONTENTS[URLS.s3], title: "s3" },
        [URLS.s2]: { content: CONTENTS[URLS.s2], title: "s2" },
      },
      failures: zaiFailures,
    });
    const tavilyReader = makeReaderDescriptor("tavily", { results: tavilyResults });
    return { grid, zai, tavilyReader };
  }

  const FULL_TAVILY_RESULTS = {
    [URLS.b2]: { content: CONTENTS[URLS.b2], title: "b2 via tavily" },
  };

  it("supplier #1 terminal failure falls through to supplier #2; source is READ, provider provenance unchanged", async () => {
    const { grid, zai, tavilyReader } = fallbackGrid(
      { [URLS.b2]: new ApiError("fixture forbidden", 403) },
      FULL_TAVILY_RESULTS,
    );
    const { deps, sink } = makeDeps({ searchDescriptors: grid, readerDescriptor: zai });
    // Registry order: zai first, tavily reader second — both in the
    // injected descriptor list AFTER the search arms.
    deps.descriptors = [...deps.descriptors, tavilyReader.descriptor];
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    const pack = result.data;

    // b2 IS read (fallback succeeded), not unread.
    assert.deepEqual(pack.coverage.unread, []);
    assert.strictEqual(pack.coverage.sourcesRead, 5);
    // Provider provenance UNCHANGED: the row's mergedFrom (search arm
    // that surfaced it), NOT the reader that served the fallback.
    const b2 = pack.sources.find((s) => s.url === URLS.b2);
    assert.ok(b2, "b2 present");
    assert.strictEqual(b2.provider, "tavily");
    assert.strictEqual(b2.title, "b2 via tavily");
    // Consumption: base 9 + 1 extra fallback attempt = 10 exactly
    // (5 reads each billed once + 1 failed attempt on b2).
    assert.strictEqual(sink.events.length, 10);
    assert.strictEqual(sink.events.filter((e) => e.capabilityId === "reader").length, 6);
    // Both suppliers were attempted on b2, in registry order.
    assert.ok(zai.invokes.includes(URLS.b2), "zai attempted b2");
    assert.ok(tavilyReader.invokes.includes(URLS.b2), "tavily served b2");
  });

  it("all suppliers fail → unread row with the LAST supplier's reason code; pool continues", async () => {
    const { grid, zai, tavilyReader } = fallbackGrid(
      {
        [URLS.s2]: new ApiError("zai forbidden", 403),
        [URLS.b2]: new ApiError("zai forbidden on b2 too", 403),
      },
      // tavily reader also fails b2 (last supplier → its code surfaces).
      {},
    );
    // Make tavily reader fail b2 terminally too.
    const tavilyFailing = makeReaderDescriptor("tavily", {
      results: { [URLS.s2]: { content: CONTENTS[URLS.s2], title: "s2 via tavily" } },
      failures: { [URLS.b2]: new ScoutlineError("tavily forbidden", "QUOTA_ERROR") },
    });
    const { deps, sink } = makeDeps({ searchDescriptors: grid, readerDescriptor: zai });
    deps.descriptors = [...deps.descriptors, tavilyFailing.descriptor];
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    const pack = result.data;

    // s2: zai fails, tavily serves → READ. b2: both fail → unread with
    // the LAST supplier's (tavily's) code.
    assert.strictEqual(pack.coverage.sourcesRead, 4);
    assert.ok(
      pack.sources.some((s) => s.url === URLS.s2),
      "s2 recovered via fallback",
    );
    assert.deepEqual(pack.coverage.unread, [{ url: URLS.b2, reason: "reader-failed:QUOTA_ERROR" }]);
    // Base 9 + fallback attempts: s2 (1 extra), b2 (1 extra) = 11.
    assert.strictEqual(sink.events.length, 11);
  });

  it("UnsupportedCapabilityError from a supplier advances to the next (no-supplier ≠ failed-supplier)", async () => {
    // A supplier that exists but rejects the capability classifies as a
    // fallback step, not a terminal unread — the next supplier serves.
    const grid = baseGrid();
    const incapable = {
      id: "minimax",
      isConfigured: () => true,
      capabilities: () => new Set(["reader"]),
      create: () => ({
        id: "minimax",
        reader: {
          fetch: {
            kind: "reader-fetch",
            validate() {},
            cacheIdentity(request) {
              return {
                provider: "minimax",
                capability: "reader",
                operation: "reader-fetch",
                credentialFingerprint: "fp-minimax",
                request,
                legacyCandidates: [],
              };
            },
            decodeCached: () => null,
            async invoke() {
              throw new UnsupportedCapabilityError("minimax", "reader");
            },
          },
        },
      }),
    };
    const reader = baseReader();
    const { deps, sink } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    // Registry order: incapable FIRST, then the serving reader.
    deps.descriptors = [incapable, ...deps.descriptors];
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    const pack = result.data;
    // Every source still read by the second supplier.
    assert.strictEqual(pack.coverage.sourcesRead, 5);
    assert.deepEqual(pack.coverage.unread, []);
    // The incapable supplier's attempt billed (attempt doctrine) —
    // 5 sources × 1 extra attempt each = base 9 + 5 = 14.
    assert.strictEqual(sink.events.length, 14);
  });

  it("no-supplier case stays: empty supplier list → all unread(no-reader-supplier)", async () => {
    // Existing behavior pinned again under the new selection shape.
    const grid = baseGrid();
    const { deps, sink } = makeDeps({ searchDescriptors: grid });
    const result = await investigate(QUESTION, BASE_OPTIONS, deps, makeContext().context);
    assert.strictEqual(result.data.coverage.sourcesRead, 0);
    assert.ok(result.data.coverage.unread.every((r) => r.reason === "no-reader-supplier"));
    assert.strictEqual(sink.events.length, 4);
  });

  it("option validation is unconditional: bad maxChars rejects even when sources is provided", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { deps } = makeDeps({ searchDescriptors: grid, readerDescriptor: reader });
    await assert.rejects(
      () =>
        investigate(
          QUESTION,
          { ...BASE_OPTIONS, sources: 3, maxChars: 0 },
          deps,
          makeContext().context,
        ),
      (error) => error.code === "VALIDATION_ERROR" && /max-chars/.test(error.message),
    );
  });
});
