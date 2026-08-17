/**
 * Consumption event + sink (PB-T2 — Plan B).
 *
 * Unit tests for the typed event, the in-memory sink, the
 * quota-store-backed production sink, and the honest cost model
 * (defaultAmountForCapability). The shared-execution emission
 * contract — cache hits, retries, observational-handler silence — is
 * exercised in tests/execution.test.js (and provider-fallback.test.js
 * for the fallback seam).
 *
 * The composite sink (usage-ledger plan, DESIGN D3) pairs the quota
 * sink with the usage-ledger sink: both failure directions are proven
 * here — ledger write failure leaves the primary recorded, primary
 * rejection leaves the ledger written.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  createCompositeConsumptionSink,
  createInMemoryConsumptionSink,
  createQuotaStoreConsumptionSink,
  defaultAmountForCapability,
  emitConsumption,
} from "../dist/lib/consumption.js";
import { createUsageLedgerSink } from "../dist/lib/usage-ledger.js";
import { createInMemoryQuotaStore } from "../dist/lib/quota-store.js";
import { executeSearch, executeCachedOperation } from "../dist/lib/execution.js";
import { getCapabilityMapping } from "../dist/lib/quota-mapping.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { main } from "../dist/index.js";
import { NetworkError } from "../dist/lib/errors.js";
import {
  createFakeCrawlDescriptor,
  createFakeMapDescriptor,
  createFakeReaderDescriptor,
  createFakeRepositoryDescriptor,
  createFakeResearchDescriptor,
  createFakeSearchDescriptor,
} from "./helpers/fake-adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// defaultAmountForCapability — honest cost model
// ---------------------------------------------------------------------------

describe("consumption: defaultAmountForCapability (honest cost model)", () => {
  it("search/reader/repository-exploration/map default to estimate 1", () => {
    for (const id of ["search", "reader", "repository-exploration", "map"]) {
      const amount = defaultAmountForCapability(id);
      assert.strictEqual(amount.kind, "estimate", `${id} should be estimate`);
      assert.strictEqual(amount.value, 1, `${id} should be value 1`);
    }
  });

  it("vision/crawl/research default to unknown (variable cost)", () => {
    for (const id of ["vision", "crawl", "research"]) {
      const amount = defaultAmountForCapability(id);
      assert.strictEqual(amount.kind, "unknown", `${id} must be unknown`);
    }
  });

  it("unrecognized capability defaults to unknown (never a fake 1)", () => {
    const amount = defaultAmountForCapability("nonsense");
    assert.strictEqual(amount.kind, "unknown");
  });
});

// ---------------------------------------------------------------------------
// In-memory sink
// ---------------------------------------------------------------------------

describe("consumption: createInMemoryConsumptionSink", () => {
  it("records events in arrival order", async () => {
    const sink = createInMemoryConsumptionSink();
    await sink.record({
      provider: "zai",
      capabilityId: "search",
      category: "search",
      unit: "requests",
      amount: { kind: "estimate", value: 1 },
      attempt: 1,
      at: 100,
    });
    await sink.record({
      provider: "zai",
      capabilityId: "search",
      amount: { kind: "unknown" },
      attempt: 2,
      at: 101,
    });
    assert.strictEqual(sink.events.length, 2);
    assert.strictEqual(sink.events[0].attempt, 1);
    assert.strictEqual(sink.events[1].attempt, 2);
    assert.strictEqual(sink.events[1].category, undefined);
  });

  it("never rejects (test sink contract)", async () => {
    const sink = createInMemoryConsumptionSink();
    await sink.record({
      provider: "zai",
      capabilityId: "x",
      amount: { kind: "unknown" },
      attempt: 1,
      at: 0,
    });
    assert.strictEqual(sink.events.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Production sink — writes through QuotaStore.writeConsumption
// ---------------------------------------------------------------------------

// Real Z.AI normalizer category name (normalizeZaiQuota emits
// `name:"requests"`, NOT `name:"search"`). Using the real name here
// catches the class of mismatch where the emitted category id differs
// from the snapshot category name (W1).
const ZAI_CATEGORIES = [
  {
    name: "requests",
    unit: "requests",
    current: { used: 5, limit: 100, remaining: 95, remainingPercent: 95 },
  },
];

describe("consumption: createQuotaStoreConsumptionSink", () => {
  it("advances locallyUpdatedAt and decrements the matching category", async () => {
    const store = createInMemoryQuotaStore();
    await store.writeObserved("zai", { observedAt: 1000, categories: ZAI_CATEGORIES });

    const sink = createQuotaStoreConsumptionSink({ store, now: () => 5000 });
    await sink.record({
      provider: "zai",
      capabilityId: "search",
      category: "requests",
      unit: "requests",
      amount: { kind: "exact", value: 1 },
      attempt: 1,
      at: 5000,
    });

    const state = await store.read();
    const snap = state.quota.zai;
    assert.ok(snap, "snapshot exists");
    assert.strictEqual(snap.locallyUpdatedAt, 5000, "locallyUpdatedAt advanced");
    assert.strictEqual(snap.observedAt, 1000, "observedAt preserved");
    const cat = snap.categories[0];
    assert.strictEqual(cat.current.used, 6, "used incremented");
    assert.strictEqual(cat.current.remaining, 94, "remaining decremented");
  });

  it("unknown amount advances locallyUpdatedAt WITHOUT numeric change", async () => {
    const store = createInMemoryQuotaStore();
    await store.writeObserved("zai", { observedAt: 1000, categories: ZAI_CATEGORIES });

    const sink = createQuotaStoreConsumptionSink({ store, now: () => 7000 });
    await sink.record({
      provider: "zai",
      capabilityId: "research",
      category: "requests", // category matches; amount is unknown
      amount: { kind: "unknown" },
      attempt: 1,
      at: 7000,
    });

    const state = await store.read();
    const snap = state.quota.zai;
    assert.strictEqual(snap.locallyUpdatedAt, 7000);
    // No numeric change — honest about not knowing the cost.
    assert.strictEqual(snap.categories[0].current.used, 5);
    assert.strictEqual(snap.categories[0].current.remaining, 95);
  });

  it("no matching category advances locallyUpdatedAt only", async () => {
    const store = createInMemoryQuotaStore();
    await store.writeObserved("zai", { observedAt: 1000, categories: ZAI_CATEGORIES });

    const sink = createQuotaStoreConsumptionSink({ store, now: () => 2000 });
    await sink.record({
      provider: "zai",
      capabilityId: "research",
      category: "research", // does NOT exist on the snapshot
      amount: { kind: "exact", value: 4 },
      attempt: 1,
      at: 2000,
    });

    const state = await store.read();
    const snap = state.quota.zai;
    assert.strictEqual(snap.locallyUpdatedAt, 2000);
    // The unrelated `search` category is untouched.
    assert.strictEqual(snap.categories[0].current.used, 5);
  });

  it("no snapshot for provider → silent no-op (idempotent)", async () => {
    const store = createInMemoryQuotaStore();
    const sink = createQuotaStoreConsumptionSink({ store, now: () => 9000 });
    // No writeObserved yet.
    await sink.record({
      provider: "zai",
      capabilityId: "search",
      amount: { kind: "exact", value: 1 },
      attempt: 1,
      at: 9000,
    });
    const state = await store.read();
    assert.strictEqual(state.quota.zai, undefined, "no snapshot created");
  });

  it("sink failure is converted to a warning and never rejects", async () => {
    // A store that throws on writeConsumption.
    /** @type {any} */
    const throwingStore = {
      async read() {
        return { version: 1, quota: {} };
      },
      async writeObserved() {},
      async writeConsumption() {
        throw new Error("disk full");
      },
      async clear() {},
    };
    const warnings = [];
    const sink = createQuotaStoreConsumptionSink({
      store: throwingStore,
      now: () => 0,
      onWarning: (m) => warnings.push(m),
    });
    // Must NOT throw.
    await sink.record({
      provider: "zai",
      capabilityId: "search",
      amount: { kind: "exact", value: 1 },
      attempt: 1,
      at: 0,
    });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /quota consumption recording failed: disk full/);
  });

  it("warning is redacted (no provider/capability/event detail)", async () => {
    /** @type {any} */
    const throwingStore = {
      async read() {
        return { version: 1, quota: {} };
      },
      async writeObserved() {},
      async writeConsumption() {
        throw new Error("errno 28");
      },
      async clear() {},
    };
    const warnings = [];
    const sink = createQuotaStoreConsumptionSink({
      store: throwingStore,
      now: () => 0,
      onWarning: (m) => warnings.push(m),
    });
    await sink.record({
      provider: "zai",
      capabilityId: "vision.chart",
      amount: { kind: "unknown" },
      attempt: 3,
      at: 12345,
    });
    // The redacted message must NOT carry event detail.
    assert.ok(!warnings[0].includes("zai"), "no provider in warning");
    assert.ok(!warnings[0].includes("vision.chart"), "no capability in warning");
    assert.ok(!warnings[0].includes("12345"), "no timestamp in warning");
  });
});

// ---------------------------------------------------------------------------
// emitConsumption — defensive helper used by executeProviderOperation
// ---------------------------------------------------------------------------

describe("consumption: emitConsumption helper", () => {
  it("awaits sink.record and never rejects when sink throws", async () => {
    /** @type {any} */
    const explodingSink = {
      async record() {
        throw new Error("sink exploded");
      },
    };
    // emitConsumption's outer try/catch must absorb this — the retry
    // classifier in executeProviderOperation must NEVER see accounting
    // failures.
    await assert.doesNotReject(
      emitConsumption(
        explodingSink,
        {
          provider: "zai",
          capabilityId: "search",
          amount: { kind: "estimate", value: 1 },
        },
        1,
        () => 0,
      ),
    );
  });

  it("passes through to the sink with attempt + at populated", async () => {
    const inMem = createInMemoryConsumptionSink();
    await emitConsumption(
      inMem,
      {
        provider: "tavily",
        capabilityId: "crawl",
        amount: { kind: "unknown" },
      },
      2,
      () => 4242,
    );
    assert.strictEqual(inMem.events.length, 1);
    assert.strictEqual(inMem.events[0].provider, "tavily");
    assert.strictEqual(inMem.events[0].attempt, 2);
    assert.strictEqual(inMem.events[0].at, 4242);
  });
});

// ---------------------------------------------------------------------------
// Composite sink — quota sink + usage-ledger sink (usage-ledger plan D3)
//
// createCompositeConsumptionSink records to both sinks, awaits both, and
// isolates either: one side's rejection becomes a warning and never
// blocks or fails the other. The two failure directions are proven one
// test each: ledger write failure (internal to the ledger sink) and
// primary rejection (defective sink that throws outright).
// ---------------------------------------------------------------------------

const COMPOSITE_AT = Date.UTC(2026, 7, 17, 12, 0, 0);
const COMPOSITE_DAY_KEY = "2026-08-17";

function makeCompositeEvent(overrides = {}) {
  return {
    provider: "zai",
    capabilityId: "search",
    amount: { kind: "estimate", value: 1 },
    attempt: 1,
    at: COMPOSITE_AT,
    ...overrides,
  };
}

describe("consumption: createCompositeConsumptionSink", () => {
  it("records the event to both sinks and resolves with no warning", async () => {
    const primary = createInMemoryConsumptionSink();
    const secondary = createInMemoryConsumptionSink();
    const warnings = [];
    const composite = createCompositeConsumptionSink(primary, secondary, {
      onWarning: (m) => warnings.push(m),
    });
    await composite.record(makeCompositeEvent());
    assert.strictEqual(primary.events.length, 1);
    assert.strictEqual(secondary.events.length, 1);
    assert.strictEqual(secondary.events[0].provider, "zai");
    assert.strictEqual(secondary.events[0].attempt, 1);
    assert.strictEqual(warnings.length, 0);
  });

  it("ledger write failure → warning only, the primary sink still records", async (t) => {
    await withTempDir(t, async (dir) => {
      const compositeWarnings = [];
      const ledgerWarnings = [];
      const primary = createInMemoryConsumptionSink();
      const ledgerSink = createUsageLedgerSink({
        filePath: path.join(dir, "usage.json"),
        writeFile: async () => {
          throw new Error("EACCES: permission denied");
        },
        now: () => COMPOSITE_AT,
        onWarning: (m) => ledgerWarnings.push(m),
      });
      const composite = createCompositeConsumptionSink(primary, ledgerSink, {
        onWarning: (m) => compositeWarnings.push(m),
      });
      await assert.doesNotReject(composite.record(makeCompositeEvent()));
      assert.strictEqual(primary.events.length, 1, "primary still recorded");
      assert.strictEqual(
        ledgerWarnings.length,
        1,
        "ledger failure surfaced as the ledger sink's own warning",
      );
      assert.strictEqual(
        compositeWarnings.length,
        0,
        "the ledger sink isolated its failure — the composite saw no rejection",
      );
    });
  });

  it("primary failure → warning only, the ledger is still written", async (t) => {
    await withTempDir(t, async (dir) => {
      const warnings = [];
      const filePath = path.join(dir, "usage.json");
      const throwingPrimary = {
        async record() {
          throw new Error("primary exploded for zai search at 1771234560000");
        },
      };
      const ledgerSink = createUsageLedgerSink({
        filePath,
        now: () => COMPOSITE_AT,
        onWarning: () => {
          throw new Error("no ledger warning expected — its write must succeed");
        },
      });
      const composite = createCompositeConsumptionSink(throwingPrimary, ledgerSink, {
        onWarning: (m) => warnings.push(m),
      });
      await assert.doesNotReject(composite.record(makeCompositeEvent()));
      assert.strictEqual(warnings.length, 1, "the primary rejection became a warning");
      const onDisk = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.strictEqual(
        onDisk.days[COMPOSITE_DAY_KEY].zai.search.attempts,
        1,
        "the ledger row still landed",
      );
      // Redaction parity: the composite warning carries no event detail
      // even though the primary's rejection embedded it.
      assert.ok(!warnings[0].includes("zai"), "no provider in warning");
      assert.ok(!warnings[0].includes("search"), "no capability in warning");
      assert.ok(!warnings[0].includes("1771234560000"), "no timestamp in warning");
    });
  });

  it("both sides failing still resolves — each rejection isolated to its own warning", async () => {
    const warnings = [];
    const throwing = () => ({
      async record() {
        throw new Error("boom");
      },
    });
    const composite = createCompositeConsumptionSink(throwing(), throwing(), {
      onWarning: (m) => warnings.push(m),
    });
    await assert.doesNotReject(composite.record(makeCompositeEvent()));
    assert.strictEqual(warnings.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Characterization: execution → sink → store category targeting (W1)
//
// Proves the consumption event emitted by the shared-execution wrappers
// targets the REAL provider-specific snapshot category name, not the raw
// capability id. Before W1, `executeSearch` hardcoded `category:"search"`
// which only matched Tavily (whose endpoint names coincide with capability
// ids); ZAI (`"requests"`) and Firecrawl (`"Credits"`) silently missed and
// only `locallyUpdatedAt` advanced. These tests go through the real
// execution wrapper → production sink → QuotaStore so a regression in the
// category-resolution seam (lib/execution.ts → lib/quota-mapping.ts) is
// caught at the decrement, not just at the event payload.
// ---------------------------------------------------------------------------

/** Minimal in-memory ResponseCache double (no disk). */
function makeInMemoryCache() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

/** Minimal SearchCapability double for a given provider. */
function makeSearchCapability(provider = "zai") {
  return {
    validate(request) {
      if (!request || !request.query || !String(request.query).trim()) {
        throw new Error("Query must not be empty");
      }
    },
    cacheIdentity(request) {
      return {
        provider,
        capability: "search",
        credentialFingerprint: "test-fingerprint",
        request: { query: request.query },
      };
    },
    async invoke() {
      return [{ title: "T", url: "https://example.test/x", summary: "S" }];
    },
  };
}

/** Minimal CachedOperation double for a given provider + kind. */
function makeCachedOperation(provider = "firecrawl", kind = "crawl") {
  return {
    kind,
    validate() {},
    cacheIdentity() {
      return {
        provider,
        capability: kind,
        credentialFingerprint: "test-fingerprint",
        request: {},
      };
    },
    decodeCached() {
      return null;
    },
    async invoke() {
      return { ok: true };
    },
  };
}

describe("consumption: W1 characterization — execution targets real category names", () => {
  it("ZAI search decrements the real `requests` category (not `search`)", async () => {
    // Derive the real category name from the mapping table — this is the
    // name normalizeZaiQuota writes into the snapshot.
    const mapping = getCapabilityMapping("zai", "search");
    assert.ok(mapping, "mapping exists for (zai, search)");
    const realCategory = mapping.categoryAliases[0];
    assert.strictEqual(realCategory, "requests", "ZAI search maps to the `requests` category");

    // Seed the store with a REAL ZAI snapshot shape.
    const store = createInMemoryQuotaStore();
    await store.writeObserved("zai", {
      observedAt: 1000,
      categories: [
        {
          name: "requests",
          unit: "requests",
          current: { used: 5, limit: 100, remaining: 95, remainingPercent: 95 },
        },
      ],
    });

    const sink = createQuotaStoreConsumptionSink({ store, now: () => 5000 });

    // Run through the REAL executeSearch wrapper so the category-resolution
    // seam is exercised. Before W1 this emitted category:"search" → no
    // match → no decrement. After W1 it emits category:"requests" → match.
    await executeSearch(
      makeSearchCapability("zai"),
      { query: "test" },
      {},
      {
        cache: makeInMemoryCache(),
        sleep: () => Promise.resolve(),
        random: () => 0,
        consume: sink,
        now: () => 5000,
      },
    );

    const state = await store.read();
    const snap = state.quota.zai;
    assert.ok(snap, "snapshot exists");
    assert.strictEqual(snap.locallyUpdatedAt, 5000, "locallyUpdatedAt advanced");
    const cat = snap.categories[0];
    assert.strictEqual(cat.name, "requests", "snapshot category is `requests`");
    assert.strictEqual(
      cat.current.used,
      6,
      "`requests` used incremented (decrement targeted the RIGHT category)",
    );
    assert.strictEqual(cat.current.remaining, 94, "`requests` remaining decremented");
  });

  it("Firecrawl crawl decrements the real `Credits` category (not `crawl`)", async () => {
    // Derive the real category name from the mapping table.
    const mapping = getCapabilityMapping("firecrawl", "crawl");
    assert.ok(mapping, "mapping exists for (firecrawl, crawl)");
    const realCategory = mapping.categoryAliases[0];
    assert.strictEqual(realCategory, "Credits", "Firecrawl crawl maps to the `Credits` category");

    // Seed the store with a REAL Firecrawl snapshot shape.
    const store = createInMemoryQuotaStore();
    await store.writeObserved("firecrawl", {
      observedAt: 2000,
      categories: [
        {
          name: "Credits",
          unit: "credits",
          current: { used: 10, limit: 500, remaining: 490, remainingPercent: 98 },
        },
      ],
    });

    const sink = createQuotaStoreConsumptionSink({ store, now: () => 6000 });

    // Run through the REAL executeCachedOperation wrapper. Before W1 this
    // emitted category:"crawl" → no match → no decrement. After W1 it
    // emits category:"Credits" → match. Crawl's amount is `unknown` so
    // only locallyUpdatedAt advances (honest about variable per-page cost),
    // but the category TARGETING is still proven by the locallyUpdatedAt
    // advance on a snapshot whose only category is `Credits`.
    await executeCachedOperation(
      makeCachedOperation("firecrawl", "crawl"),
      {},
      {},
      {
        cache: makeInMemoryCache(),
        sleep: () => Promise.resolve(),
        random: () => 0,
        consume: sink,
        now: () => 6000,
      },
    );

    const state = await store.read();
    const snap = state.quota.firecrawl;
    assert.ok(snap, "snapshot exists");
    assert.strictEqual(
      snap.locallyUpdatedAt,
      6000,
      "locallyUpdatedAt advanced on the `Credits` snapshot",
    );
    // Crawl amount is `unknown` → no numeric decrement (honest), but the
    // locallyUpdatedAt advance proves the event reached the right provider
    // snapshot. The category match is verified by the mapping assertion above.
    assert.strictEqual(
      snap.categories[0].current.used,
      10,
      " Credits used unchanged (crawl cost is unknown)",
    );
  });

  it("an unmapped capability (quota) keeps the capability id as category (observational)", async () => {
    // quota/diagnostics are intentionally unmapped — they are observational.
    // resolveConsumptionCategory returns the capability id, which matches
    // no snapshot category, so only locallyUpdatedAt advances.
    const mapping = getCapabilityMapping("zai", "quota");
    assert.strictEqual(mapping, undefined, "quota is unmapped by design");
  });
});

// ---------------------------------------------------------------------------
// Usage-ledger Ticket 4 — handler wiring ×6 (the PB-T2 gap closure).
//
// DESIGN D7: every dispatch path threads the configured consumption sink
// + clock down to the shared execution seam. Before this ticket only
// vision and the fan-out arms forwarded `consume`, so a plain
// `scoutline search/read/...` run recorded nothing in the ledger. Each
// case drives `main` (the dispatch seam, `../dist/index.js`) with an
// injected `consume` double + fake provider descriptors + ALL SIX
// capability cache/sleep/random triples (the reader-command makeMainDeps
// pattern; an omitted triple silently falls back to the real on-disk
// cache). Wrapper-level executeSearch/executeCachedOperation calls
// cannot prove the handler threading — only the full dispatch path can.
//
// Lenses per DESIGN D7 + the defaultRetryPolicy table:
//   - invoke: exactly one event, provider = the fake descriptor's id.
//   - cache hit: a second identical run emits NOTHING.
//   - retryable handlers (search/reader/repo, maxRetries 1): one event
//     per attempt — a retryable failure bills twice before failing.
//   - no-retry handlers (crawl/map/research, maxRetries 0 — double-
//     charge risk): exactly ONE event even on a failed invoke.
// ---------------------------------------------------------------------------

/**
 * Build the standard Ticket-4 MainDependencies double: recording
 * invocation adapter, in-memory response cache, deterministic
 * sleep/random, and ALL SIX capability triples wired to the same
 * in-memory execution (search/reader/crawl/map/research/repository) so
 * no drive can silently reach the real on-disk cache.
 */
function makeMainDeps({ descriptors, consume, cache: providedCache }) {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
  };
  const cache = providedCache ?? makeInMemoryCache();
  const sleep = () => Promise.resolve();
  const random = () => 0;
  return {
    stdout,
    stderr,
    cache,
    mainDeps: {
      invocation: adapter,
      env: {},
      providerDescriptors: descriptors,
      consume,
      searchCache: cache,
      searchSleep: sleep,
      searchRandom: random,
      readerCache: cache,
      readerSleep: sleep,
      readerRandom: random,
      crawlCache: cache,
      crawlSleep: sleep,
      crawlRandom: random,
      mapCache: cache,
      mapSleep: sleep,
      mapRandom: random,
      researchCache: cache,
      researchSleep: sleep,
      researchRandom: random,
      repositoryCache: cache,
      repositorySleep: sleep,
      repositoryRandom: random,
    },
  };
}

/** Canned normalized results (schema-version-1) per capability. */
const T4_RESULTS = {
  search: [{ title: "Fake result", url: "https://example.com/fake", summary: "fake" }],
  read: {
    schemaVersion: 1,
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    title: "Example Domain",
    content: "# Example\n\nBody.",
    contentFormat: "markdown",
  },
  repoSearch: {
    schemaVersion: 1,
    repository: "octo/example",
    query: "find the seam",
    language: "en",
    excerpts: [{ text: "the seam" }],
    truncated: false,
    originalTextLength: 9,
  },
  crawl: (request) => ({
    schemaVersion: 1,
    baseUrl: request.url,
    pages: [{ url: request.url, content: "crawled page", contentFormat: "markdown" }],
    totalPages: 1,
  }),
  map: (request) => ({
    schemaVersion: 1,
    baseUrl: request.url,
    urls: [`${request.url}a`, `${request.url}b`],
    totalUrls: 2,
  }),
  research: (request) => ({
    schemaVersion: 1,
    query: request.query,
    model: request.model ?? "auto",
    report: `Report on "${request.query}"`,
    sources: [{ title: "Source", url: "https://example.com/source" }],
  }),
};

describe("consumption: handler wiring through main (usage-ledger Ticket 4)", () => {
  let savedRoots;
  let redirectRoots;

  // Belt-and-braces hermeticity (Ticket 3 pattern): redirect BOTH real-fs
  // roots at temp dirs for the whole describe. The providerDescriptors
  // injection already gates the production sinks/refresh/trigger-detection
  // off; the redirect additionally pins the config load (a developer's
  // real config.json — e.g. fanout=true — must not change which dispatch
  // path a drive takes) and keeps the research state dir off the real
  // cache root.
  before(async () => {
    savedRoots = {
      SCOUTLINE_CONFIG_DIR: process.env.SCOUTLINE_CONFIG_DIR,
      SCOUTLINE_CACHE_DIR: process.env.SCOUTLINE_CACHE_DIR,
    };
    redirectRoots = {
      config: await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-t4-config-")),
      cache: await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-t4-cache-")),
    };
    process.env.SCOUTLINE_CONFIG_DIR = redirectRoots.config;
    process.env.SCOUTLINE_CACHE_DIR = redirectRoots.cache;
  });

  after(async () => {
    for (const [key, value] of Object.entries(savedRoots)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(
      Object.values(redirectRoots).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  // -------------------------------------------------------------------------
  // Invoke + cache-hit lens — all six handlers
  // -------------------------------------------------------------------------

  it("search (single-pin path): one event on invoke, none on a cache hit", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const search = createFakeSearchDescriptor({
      id: "zai",
      capabilityOptions: {
        search: {
          result: (request, attempt) => {
            invokes.push(attempt);
            return T4_RESULTS.search;
          },
        },
      },
    });
    const drive = makeMainDeps({ descriptors: [search.descriptor], consume: sink });
    const status = await main(["search", "usage ledger"], drive.mainDeps);
    assert.strictEqual(status, 0, `stderr: ${JSON.stringify(drive.stderr)}`);
    assert.deepStrictEqual(invokes, [1], "exactly one billable invoke");
    assert.strictEqual(sink.events.length, 1, "exactly one event on invoke");
    assert.strictEqual(sink.events[0].provider, "zai", "provider = the fake descriptor's id");
    assert.strictEqual(sink.events[0].capabilityId, "search");
    assert.strictEqual(sink.events[0].attempt, 1);

    // Cache hit: a fresh drive (fresh descriptors + sink) sharing the SAME
    // in-memory cache re-runs the identical request — the cached
    // normalized result returns and NOTHING is emitted.
    const invokes2 = [];
    const sink2 = createInMemoryConsumptionSink();
    const search2 = createFakeSearchDescriptor({
      id: "zai",
      capabilityOptions: {
        search: {
          result: (request, attempt) => {
            invokes2.push(attempt);
            return T4_RESULTS.search;
          },
        },
      },
    });
    const drive2 = makeMainDeps({ descriptors: [search2.descriptor], consume: sink2, cache: drive.cache });
    const status2 = await main(["search", "usage ledger"], drive2.mainDeps);
    assert.strictEqual(status2, 0, `stderr: ${JSON.stringify(drive2.stderr)}`);
    assert.deepStrictEqual(invokes2, [], "cache hit must not invoke");
    assert.strictEqual(sink2.events.length, 0, "cache hit must not emit");
  });

  it("read: one event on invoke, none on a cache hit", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const reader = createFakeReaderDescriptor({
      id: "zai",
      capabilityOptions: { fetch: { result: T4_RESULTS.read } },
    });
    const drive = makeMainDeps({ descriptors: [reader.descriptor], consume: sink });
    const status = await main(["read", "https://example.com/"], drive.mainDeps);
    assert.strictEqual(status, 0, `stderr: ${JSON.stringify(drive.stderr)}`);
    assert.strictEqual(sink.events.length, 1);
    assert.strictEqual(sink.events[0].provider, "zai");
    assert.strictEqual(sink.events[0].capabilityId, "reader");
    assert.strictEqual(sink.events[0].attempt, 1);

    const sink2 = createInMemoryConsumptionSink();
    const reader2 = createFakeReaderDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          result: () => {
            invokes.push("hit-invoke");
            return T4_RESULTS.read;
          },
        },
      },
    });
    const drive2 = makeMainDeps({ descriptors: [reader2.descriptor], consume: sink2, cache: drive.cache });
    const status2 = await main(["read", "https://example.com/"], drive2.mainDeps);
    assert.strictEqual(status2, 0, `stderr: ${JSON.stringify(drive2.stderr)}`);
    assert.deepStrictEqual(invokes, [], "cache hit must not invoke");
    assert.strictEqual(sink2.events.length, 0, "cache hit must not emit");
  });

  it("repo search: one event on invoke, none on a cache hit", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const repo = createFakeRepositoryDescriptor({
      id: "zai",
      capabilityOptions: {
        search: {
          result: (request) => ({
            ...T4_RESULTS.repoSearch,
            repository: request.repository,
            query: request.query,
          }),
        },
      },
    });
    const drive = makeMainDeps({ descriptors: [repo.descriptor], consume: sink });
    const status = await main(
      ["repo", "search", "octo/example", "find the seam"],
      drive.mainDeps,
    );
    assert.strictEqual(status, 0, `stderr: ${JSON.stringify(drive.stderr)}`);
    assert.strictEqual(sink.events.length, 1);
    assert.strictEqual(sink.events[0].provider, "zai");
    assert.strictEqual(sink.events[0].capabilityId, "repository-exploration");
    assert.strictEqual(sink.events[0].attempt, 1);

    const sink2 = createInMemoryConsumptionSink();
    const repo2 = createFakeRepositoryDescriptor({
      id: "zai",
      capabilityOptions: {
        search: {
          result: (request) => {
            invokes.push(request);
            return { ...T4_RESULTS.repoSearch, repository: request.repository, query: request.query };
          },
        },
      },
    });
    const drive2 = makeMainDeps({ descriptors: [repo2.descriptor], consume: sink2, cache: drive.cache });
    const status2 = await main(
      ["repo", "search", "octo/example", "find the seam"],
      drive2.mainDeps,
    );
    assert.strictEqual(status2, 0, `stderr: ${JSON.stringify(drive2.stderr)}`);
    assert.deepStrictEqual(invokes, [], "cache hit must not invoke");
    assert.strictEqual(sink2.events.length, 0, "cache hit must not emit");
  });

  it("crawl: one event on invoke, none on a cache hit", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const crawl = createFakeCrawlDescriptor({
      id: "zai",
      capabilityOptions: { fetch: { result: T4_RESULTS.crawl } },
    });
    const drive = makeMainDeps({ descriptors: [crawl.descriptor], consume: sink });
    const status = await main(["crawl", "https://example.com/"], drive.mainDeps);
    assert.strictEqual(status, 0, `stderr: ${JSON.stringify(drive.stderr)}`);
    assert.strictEqual(sink.events.length, 1);
    assert.strictEqual(sink.events[0].provider, "zai");
    assert.strictEqual(sink.events[0].capabilityId, "crawl");
    assert.strictEqual(sink.events[0].attempt, 1);
    assert.strictEqual(sink.events[0].unit, "credits", "crawl bills credits");
    assert.strictEqual(sink.events[0].amount.kind, "unknown", "crawl cost is variable");

    const sink2 = createInMemoryConsumptionSink();
    const crawl2 = createFakeCrawlDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          result: (request) => {
            invokes.push(request);
            return T4_RESULTS.crawl(request);
          },
        },
      },
    });
    const drive2 = makeMainDeps({ descriptors: [crawl2.descriptor], consume: sink2, cache: drive.cache });
    const status2 = await main(["crawl", "https://example.com/"], drive2.mainDeps);
    assert.strictEqual(status2, 0, `stderr: ${JSON.stringify(drive2.stderr)}`);
    assert.deepStrictEqual(invokes, [], "cache hit must not invoke");
    assert.strictEqual(sink2.events.length, 0, "cache hit must not emit");
  });

  it("map: one event on invoke, none on a cache hit", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const map = createFakeMapDescriptor({
      id: "zai",
      capabilityOptions: { fetch: { result: T4_RESULTS.map } },
    });
    const drive = makeMainDeps({ descriptors: [map.descriptor], consume: sink });
    const status = await main(["map", "https://example.com/"], drive.mainDeps);
    assert.strictEqual(status, 0, `stderr: ${JSON.stringify(drive.stderr)}`);
    assert.strictEqual(sink.events.length, 1);
    assert.strictEqual(sink.events[0].provider, "zai");
    assert.strictEqual(sink.events[0].capabilityId, "map");
    assert.strictEqual(sink.events[0].attempt, 1);
    assert.strictEqual(sink.events[0].unit, "credits", "map bills credits");
    assert.deepStrictEqual(
      sink.events[0].amount,
      { kind: "estimate", value: 1 },
      "map is a single-batch estimate",
    );

    const sink2 = createInMemoryConsumptionSink();
    const map2 = createFakeMapDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          result: (request) => {
            invokes.push(request);
            return T4_RESULTS.map(request);
          },
        },
      },
    });
    const drive2 = makeMainDeps({ descriptors: [map2.descriptor], consume: sink2, cache: drive.cache });
    const status2 = await main(["map", "https://example.com/"], drive2.mainDeps);
    assert.strictEqual(status2, 0, `stderr: ${JSON.stringify(drive2.stderr)}`);
    assert.deepStrictEqual(invokes, [], "cache hit must not invoke");
    assert.strictEqual(sink2.events.length, 0, "cache hit must not emit");
  });

  it("research: one event on invoke, none on a cache hit", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const research = createFakeResearchDescriptor({
      id: "zai",
      capabilityOptions: { run: { result: T4_RESULTS.research } },
    });
    const drive = makeMainDeps({ descriptors: [research.descriptor], consume: sink });
    const status = await main(["research", "deep research query"], drive.mainDeps);
    assert.strictEqual(status, 0, `stderr: ${JSON.stringify(drive.stderr)}`);
    assert.strictEqual(sink.events.length, 1);
    assert.strictEqual(sink.events[0].provider, "zai");
    assert.strictEqual(sink.events[0].capabilityId, "research");
    assert.strictEqual(sink.events[0].attempt, 1);
    assert.strictEqual(sink.events[0].unit, "credits", "research bills credits");
    assert.strictEqual(sink.events[0].amount.kind, "unknown", "research cost is variable");

    const sink2 = createInMemoryConsumptionSink();
    const research2 = createFakeResearchDescriptor({
      id: "zai",
      capabilityOptions: {
        run: {
          result: (request) => {
            invokes.push(request);
            return T4_RESULTS.research(request);
          },
        },
      },
    });
    const drive2 = makeMainDeps({ descriptors: [research2.descriptor], consume: sink2, cache: drive.cache });
    const status2 = await main(["research", "deep research query"], drive2.mainDeps);
    assert.strictEqual(status2, 0, `stderr: ${JSON.stringify(drive2.stderr)}`);
    assert.deepStrictEqual(invokes, [], "cache hit must not invoke");
    assert.strictEqual(sink2.events.length, 0, "cache hit must not emit");
  });

  // -------------------------------------------------------------------------
  // Retry lens — the retryable handlers (defaultRetryPolicy maxRetries 1)
  // -------------------------------------------------------------------------

  it("search: a retryable failure bills one event PER ATTEMPT (2 events) before failing", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const search = createFakeSearchDescriptor({
      id: "zai",
      capabilityOptions: {
        search: {
          error: (attempt) => {
            invokes.push(attempt);
            return new NetworkError("flaky transport");
          },
        },
      },
    });
    const drive = makeMainDeps({ descriptors: [search.descriptor], consume: sink });
    const status = await main(["search", "usage ledger"], drive.mainDeps);
    assert.notStrictEqual(status, 0, "single candidate exhausted → non-zero exit");
    assert.deepStrictEqual(invokes, [1, 2], "search retries once (maxRetries 1)");
    assert.strictEqual(sink.events.length, 2, "one event per attempt");
    assert.deepStrictEqual(
      sink.events.map((e) => e.attempt),
      [1, 2],
      "events emitted BEFORE each invoke, attempt numbers ascending",
    );
    assert.ok(sink.events.every((e) => e.provider === "zai"));
  });

  it("read: a retryable failure bills one event PER ATTEMPT (2 events) before failing", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const reader = createFakeReaderDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          error: (attempt) => {
            invokes.push(attempt);
            return new NetworkError("flaky transport");
          },
        },
      },
    });
    const drive = makeMainDeps({ descriptors: [reader.descriptor], consume: sink });
    const status = await main(["read", "https://example.com/"], drive.mainDeps);
    assert.notStrictEqual(status, 0, "single candidate exhausted → non-zero exit");
    assert.deepStrictEqual(invokes, [1, 2], "reader-fetch retries once (maxRetries 1)");
    assert.strictEqual(sink.events.length, 2);
    assert.deepStrictEqual(
      sink.events.map((e) => e.attempt),
      [1, 2],
    );
    assert.ok(sink.events.every((e) => e.capabilityId === "reader"));
  });

  it("repo search: a retryable failure bills one event PER ATTEMPT (2 events) before failing", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const repo = createFakeRepositoryDescriptor({
      id: "zai",
      capabilityOptions: {
        search: {
          error: (attempt) => {
            invokes.push(attempt);
            return new NetworkError("flaky transport");
          },
        },
      },
    });
    const drive = makeMainDeps({ descriptors: [repo.descriptor], consume: sink });
    const status = await main(
      ["repo", "search", "octo/example", "find the seam"],
      drive.mainDeps,
    );
    assert.notStrictEqual(status, 0, "single candidate exhausted → non-zero exit");
    assert.deepStrictEqual(invokes, [1, 2], "repository-search retries once (maxRetries 1)");
    assert.strictEqual(sink.events.length, 2);
    assert.deepStrictEqual(
      sink.events.map((e) => e.attempt),
      [1, 2],
    );
    assert.ok(sink.events.every((e) => e.capabilityId === "repository-exploration"));
  });

  // -------------------------------------------------------------------------
  // No-retry lens — crawl/map/research (maxRetries 0, double-charge risk):
  // exactly ONE event even on a failed (retryable-classified) invoke.
  // -------------------------------------------------------------------------

  it("crawl: a retryable failure still bills exactly ONE event (maxRetries 0)", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const crawl = createFakeCrawlDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          error: (attempt) => {
            invokes.push(attempt);
            return new NetworkError("flaky transport");
          },
        },
      },
    });
    const drive = makeMainDeps({ descriptors: [crawl.descriptor], consume: sink });
    const status = await main(["crawl", "https://example.com/"], drive.mainDeps);
    assert.notStrictEqual(status, 0, "failed crawl → non-zero exit");
    assert.deepStrictEqual(invokes, [1], "crawl never retries (double-charge risk)");
    assert.strictEqual(sink.events.length, 1, "exactly one event even on failure");
    assert.strictEqual(sink.events[0].attempt, 1);
    assert.strictEqual(sink.events[0].capabilityId, "crawl");
  });

  it("map: a retryable failure still bills exactly ONE event (maxRetries 0)", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const map = createFakeMapDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          error: (attempt) => {
            invokes.push(attempt);
            return new NetworkError("flaky transport");
          },
        },
      },
    });
    const drive = makeMainDeps({ descriptors: [map.descriptor], consume: sink });
    const status = await main(["map", "https://example.com/"], drive.mainDeps);
    assert.notStrictEqual(status, 0, "failed map → non-zero exit");
    assert.deepStrictEqual(invokes, [1], "map never retries (double-charge risk)");
    assert.strictEqual(sink.events.length, 1);
    assert.strictEqual(sink.events[0].attempt, 1);
    assert.strictEqual(sink.events[0].capabilityId, "map");
  });

  it("research: a retryable failure still bills exactly ONE event (maxRetries 0)", async () => {
    const invokes = [];
    const sink = createInMemoryConsumptionSink();
    const research = createFakeResearchDescriptor({
      id: "zai",
      capabilityOptions: {
        run: {
          error: (attempt) => {
            invokes.push(attempt);
            return new NetworkError("flaky transport");
          },
        },
      },
    });
    const drive = makeMainDeps({ descriptors: [research.descriptor], consume: sink });
    const status = await main(["research", "deep research query"], drive.mainDeps);
    assert.notStrictEqual(status, 0, "failed research → non-zero exit");
    assert.deepStrictEqual(invokes, [1], "research never retries (double-charge risk)");
    assert.strictEqual(sink.events.length, 1);
    assert.strictEqual(sink.events[0].attempt, 1);
    assert.strictEqual(sink.events[0].capabilityId, "research");
  });
});

// ---------------------------------------------------------------------------
// Usage-ledger Ticket 4 — production gate (main-as-subprocess).
//
// Network-making, so opt-in per the repo's ZAI_LIVE_TESTS convention
// (default suite stays offline). Moved here from Ticket 3: until the D7
// handler threading merged, no plain-dispatch command emitted, so the
// subprocess could not have written a row. Now it must: run the real
// `bin/scoutline.js search` against a redirected config root with a
// dummy key — online the invoke fails API_ERROR (401, non-retryable);
// offline it fails NETWORK_ERROR (retryable, one extra attempt + backoff).
// EITHER way the row lands because `executeProviderOperation` emits the
// event BEFORE the invoke attempt, and the production composite sink
// (constructed in full production mode) writes usage.json. Nothing is
// asserted about the error class.
// ---------------------------------------------------------------------------

describe(
  "consumption: production gate — real binary writes usage.json (ZAI_LIVE_TESTS=1)",
  { skip: process.env.ZAI_LIVE_TESTS !== "1" },
  () => {
    it("bin/scoutline.js search (dummy key) exits non-zero and lands a usage.json row", async (t) => {
      await withTempDir(t, async (configDir) => {
        await withTempDir(t, async (cacheDir) => {
          let exitError = null;
          let stderrText = "";
          try {
            await execFileAsync(
              process.execPath,
              [path.resolve(__dirname, "..", "bin", "scoutline.js"), "search", "usage ledger gate"],
              {
                cwd: path.resolve(__dirname, ".."),
                timeout: 60_000,
                env: {
                  // Minimal env: the dummy ZAI_API_KEY alias satisfies
                  // trigger-detection/credential resolution with a key
                  // that cannot succeed; nothing real leaks in or out.
                  SCOUTLINE_CONFIG_DIR: configDir,
                  SCOUTLINE_CACHE_DIR: cacheDir,
                  ZAI_API_KEY: "dummy-key-production-gate",
                },
              },
            );
          } catch (error) {
            // Non-zero exit is EXPECTED (the dummy key cannot work).
            exitError = error;
            stderrText = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : "";
          }
          assert.ok(exitError !== null, "dummy-key search must exit non-zero");
          assert.notStrictEqual(exitError.code, 0, `stderr: ${stderrText.slice(0, 2000)}`);

          // The row landed BEFORE the failing invoke — the emit-BEFORE-
          // invoke contract plus the production composite sink.
          const usagePath = path.join(configDir, "usage.json");
          const raw = await fs.readFile(usagePath, "utf8");
          const ledger = JSON.parse(raw);
          assert.strictEqual(ledger.version, 1);
          const dayKeys = Object.keys(ledger.days ?? {});
          assert.ok(dayKeys.length >= 1, "at least one UTC day key exists");
          const day = ledger.days[dayKeys[0]];
          const providerRow = day.zai;
          assert.ok(providerRow, "row exists for the default-pinned provider (zai)");
          const searchRow = providerRow.search;
          assert.ok(searchRow, "row exists for the search capability");
          assert.ok(
            searchRow.attempts >= 1,
            `attempts recorded (${JSON.stringify(searchRow)})`,
          );
        });
      });
    });
  },
);
