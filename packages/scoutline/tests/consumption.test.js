/**
 * Consumption event + sink (PB-T2 — Plan B).
 *
 * Unit tests for the typed event, the in-memory sink, the
 * quota-store-backed production sink, and the honest cost model
 * (defaultAmountForCapability). The shared-execution emission
 * contract — cache hits, retries, observational-handler silence — is
 * exercised in tests/execution.test.js (and provider-fallback.test.js
 * for the fallback seam).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createInMemoryConsumptionSink,
  createQuotaStoreConsumptionSink,
  defaultAmountForCapability,
  emitConsumption,
} from "../dist/lib/consumption.js";
import { createInMemoryQuotaStore } from "../dist/lib/quota-store.js";

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

const ZAI_CATEGORIES = [
  {
    name: "search",
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
      category: "search",
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
      category: "search", // even if category matches
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
