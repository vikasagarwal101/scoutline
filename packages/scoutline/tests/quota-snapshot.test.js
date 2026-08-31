/**
 * Quota Snapshot Integration (PB-T5 — Plan B).
 *
 * Verifies the snapshot-aware quota + doctor dashboard behavior added
 * by PB-T5:
 *   - `quota` reads the snapshot first; fresh → source:"snapshot" +
 *     authoritative:true; stale/missing/corrupt → live-probe fallback
 *     with source:"live" + awaited write-through.
 *   - Exa (no quota Capability) emits a `ProviderQuotaNone` row with
 *     ZERO adapter/transport calls in all-provider mode; pinning Exa
 *     still throws `UnsupportedCapabilityError`.
 *   - `observedAt` is the sole freshness clock — `locallyUpdatedAt`
 *     never resets staleness.
 *   - Pinned vs all-provider mode + registry order are preserved.
 *   - Doctor reads the snapshot per-Provider (source:"snapshot" or
 *     "none"); never live-probes quota; `--no-tools` still embeds the
 *     quota summary; failed probes still surface the snapshot summary.
 *   - Doctor embeds Plan A verification records per-Provider.
 *   - TTY rendering of the source label + no-signal row.
 *   - Pre-PB-T5 callers (no snapshot injected) see byte-for-byte the
 *     previous behavior — no `quotaSource` field attached.
 *   - No live-probe fallback for providers without quota (Exa).
 *   - Awaited write-through: a successful live-probe fallback persists
 *     before the dashboard returns.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildQuotaDashboard, quota } from "../dist/commands/quota.js";
import { buildDiagnosticsReport, doctorExitCode } from "../dist/commands/doctor.js";
import { formatQuotaDashboard } from "../dist/lib/tty.js";
import { createInMemoryQuotaStore } from "../dist/lib/quota-store.js";
import { DEFAULT_QUOTA_STALE_THRESHOLD_MS } from "../dist/lib/quota-store.js";
import { UnsupportedCapabilityError, ScoutlineError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const FRESH_MS = 60_000; // 1 min ago — well within the 10-min threshold
const STALE_MS = DEFAULT_QUOTA_STALE_THRESHOLD_MS + 60_000; // 11 min — over

const fixedNow = () => NOW;

/**
 * Build a descriptor whose `quota.invoke()` either resolves `result`
 * or throws `error`. `capabilities` lets a test advertise `quota` (or
 * NOT, for the Exa no-signal case). `invokeCount()` exposes transport
 * usage so tests can assert zero calls.
 */
function makeQuotaDescriptor(
  id,
  { result, error, configured = true, capabilities = ["quota"], warnings } = {},
) {
  let invokes = 0;
  return {
    id,
    isConfigured: () => configured,
    capabilities: () => new Set(capabilities),
    create: () => ({
      id,
      quota: capabilities.includes("quota")
        ? {
            async invoke() {
              invokes += 1;
              if (error) throw error;
              return warnings ? { ...result, warnings } : result;
            },
          }
        : undefined,
    }),
    invokeCount: () => invokes,
  };
}

/**
 * Build a descriptor whose `diagnostics.invoke()` resolves (a
 * successful probe). Used for Doctor tests; the descriptor advertises
 * `quota` and `diagnostics` so the snapshot summary can be exercised
 * alongside a successful probe.
 */
function makeDiagnosticDescriptor(
  id,
  { configured = true, capabilities = ["quota", "diagnostics"] } = {},
) {
  return {
    id,
    isConfigured: () => configured,
    capabilities: () => new Set(capabilities),
    create: () => ({
      id,
      diagnostics: {
        async invoke() {},
      },
    }),
  };
}

const ZAI_SUCCESS = {
  provider: "zai",
  status: "ok",
  plan: "pro",
  categories: [{ name: "requests", unit: "requests", current: { remainingPercent: 42 } }],
};

const MINIMAX_SUCCESS = {
  provider: "minimax",
  status: "ok",
  categories: [{ name: "abab6.5s", unit: "requests", current: { remainingPercent: 70 } }],
};

/** Build a snapshot entry at `observedAt = NOW - ageMs`. */
function snapshotAt(ageMs, categories, { locallyUpdatedAt } = {}) {
  const entry = {
    observedAt: NOW - ageMs,
    categories,
  };
  if (locallyUpdatedAt !== undefined) entry.locallyUpdatedAt = locallyUpdatedAt;
  return entry;
}

/** Build a QuotaState from a record of per-provider snapshots. */
function stateFrom(record) {
  return { version: 1, quota: record };
}

const sleep = async () => {};
const random = () => 0;

// ---------------------------------------------------------------------------
// 1. Snapshot path — fresh snapshot short-circuits the transport
// ---------------------------------------------------------------------------

describe("PB-T5 quota — fresh snapshot short-circuits the transport", () => {
  it("default-mode: reads the snapshot, labels source:'snapshot', and never invokes the adapter", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    assert.strictEqual(dashboard.schemaVersion, 1, "schema unchanged (additive)");
    assert.strictEqual(dashboard.providers.length, 1);
    const row = dashboard.providers[0];
    assert.strictEqual(row.status, "ok");
    assert.strictEqual(row.provider, "zai");
    assert.strictEqual(zai.invokeCount(), 0, "transport never constructed");
    assert.ok(row.quotaSource, "quotaSource attached");
    assert.strictEqual(row.quotaSource.source, "snapshot");
    assert.strictEqual(row.quotaSource.authoritative, true);
    assert.strictEqual(row.quotaSource.observedAt, NOW - FRESH_MS);
    // Categories carried verbatim.
    assert.deepStrictEqual(
      row.categories,
      ZAI_SUCCESS.categories,
      "snapshot categories carried verbatim",
    );
  });

  it("all-provider mode: reads every configured provider's snapshot in registry order", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
        minimax: snapshotAt(FRESH_MS, MINIMAX_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    assert.deepStrictEqual(
      dashboard.providers.map((p) => p.provider),
      ["zai", "minimax"],
      "registry order preserved",
    );
    assert.strictEqual(zai.invokeCount(), 0);
    assert.strictEqual(minimax.invokeCount(), 0);
    for (const row of dashboard.providers) {
      assert.strictEqual(row.quotaSource.source, "snapshot");
      assert.strictEqual(row.quotaSource.authoritative, true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Stale / missing / corrupt → live-probe fallback
// ---------------------------------------------------------------------------

describe("PB-T5 quota — stale/missing snapshot falls back to live probe", () => {
  it("stale observedAt falls back to live probe with source:'live' + authoritative:true", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(STALE_MS, ZAI_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    const row = dashboard.providers[0];
    assert.strictEqual(row.status, "ok");
    assert.strictEqual(zai.invokeCount(), 1, "live probe ran");
    assert.strictEqual(row.quotaSource.source, "live");
    assert.strictEqual(row.quotaSource.authoritative, true, "just observed");
    assert.strictEqual(row.quotaSource.observedAt, NOW, "observedAt = now");
  });

  it("missing snapshot entry falls back to live probe", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({}), // no zai entry
      now: fixedNow,
    });
    assert.strictEqual(dashboard.providers[0].quotaSource.source, "live");
    assert.strictEqual(zai.invokeCount(), 1);
  });

  it("observedAt is the sole freshness clock — a recent locallyUpdatedAt does NOT reset staleness", async () => {
    // observedAt stale, locallyUpdatedAt fresh: the row MUST still
    // fall back to a live probe (PB-T1 contract: local consumption
    // never advances the ground-truth clock).
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(STALE_MS, ZAI_SUCCESS.categories, {
          locallyUpdatedAt: NOW - 1000, // 1s ago — fresh
        }),
      }),
      now: fixedNow,
    });
    assert.strictEqual(zai.invokeCount(), 1, "live probe ran despite fresh locallyUpdatedAt");
    assert.strictEqual(dashboard.providers[0].quotaSource.source, "live");
  });

  it("all-provider mode: partial stale (one fresh, one stale) — fresh short-circuits, stale probes", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
        minimax: snapshotAt(STALE_MS, MINIMAX_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    assert.strictEqual(zai.invokeCount(), 0, "fresh snapshot short-circuits");
    assert.strictEqual(minimax.invokeCount(), 1, "stale falls back");
    assert.strictEqual(dashboard.providers[0].quotaSource.source, "snapshot");
    assert.strictEqual(dashboard.providers[1].quotaSource.source, "live");
  });
});

// ---------------------------------------------------------------------------
// 3. Awaited live-probe write-through
// ---------------------------------------------------------------------------

describe("PB-T5 quota — live-probe write-through is awaited", () => {
  it("a successful live-probe fallback persists the snapshot via quotaStore.writeObserved before the dashboard returns", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const store = createInMemoryQuotaStore();
    const writeSpy = [];
    const trackingStore = {
      async read() {
        return store.read();
      },
      async writeObserved(providerId, snapshot) {
        writeSpy.push({ providerId, snapshot });
        return store.writeObserved(providerId, snapshot);
      },
      async writeConsumption(providerId, adj, at) {
        return store.writeConsumption(providerId, adj, at);
      },
      async clear(providerId) {
        return store.clear(providerId);
      },
    };
    await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({}), // missing → live probe
      quotaStore: trackingStore,
      now: fixedNow,
    });
    assert.deepStrictEqual(writeSpy, [
      {
        providerId: "zai",
        snapshot: { observedAt: NOW, categories: ZAI_SUCCESS.categories },
      },
    ]);
    // Persisted: the next read sees the fresh snapshot.
    const persisted = await store.read();
    assert.strictEqual(persisted.quota.zai.observedAt, NOW);
  });

  it("a store write failure is isolated — the live-probe row is still returned with source:'live'", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const failingStore = {
      async read() {
        return { version: 1, quota: {} };
      },
      async writeObserved() {
        throw new Error("disk full");
      },
      async writeConsumption() {},
      async clear() {},
    };
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({}),
      quotaStore: failingStore,
      now: fixedNow,
    });
    assert.strictEqual(dashboard.providers[0].status, "ok");
    assert.strictEqual(dashboard.providers[0].quotaSource.source, "live");
  });

  it("write-through is NOT attempted when quotaStore is omitted (test path)", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({}),
      // No quotaStore — write-through must be skipped.
      now: fixedNow,
    });
    assert.strictEqual(dashboard.providers[0].quotaSource.source, "live");
  });
});

// ---------------------------------------------------------------------------
// 4. Exa no-signal row (no quota capability)
// ---------------------------------------------------------------------------

describe("PB-T5 quota — Exa no-signal row (no quota capability)", () => {
  it("all-provider mode: configured Exa emits a 'none' row with zero transport calls", async () => {
    const exa = makeQuotaDescriptor("exa", {
      configured: true,
      capabilities: ["search"], // no quota
    });
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, exa],
      env: { Z_AI_API_KEY: "k", EXA_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    const exaRow = dashboard.providers.find((p) => p.provider === "exa");
    assert.ok(exaRow, "exa row present");
    assert.strictEqual(exaRow.status, "none");
    assert.strictEqual(exaRow.reason, "no-capability");
    assert.strictEqual(exa.invokeCount(), 0, "Exa adapter never constructed");
    // No live-probe fallback attempted for Exa — the snapshot lookup
    // is irrelevant; the no-capability branch returns first.
  });

  it("all-provider mode: Exa-only configured does NOT throw ConfigurationError — emits a single none row, exit 0", async () => {
    // Pre-PB-T5 this threw ConfigurationError (filter excluded Exa).
    // PB-T5 emits the no-signal row because Exa is configured
    // inventory. This is the documented behavior change.
    const exa = makeQuotaDescriptor("exa", {
      configured: true,
      capabilities: ["search"],
    });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [exa],
      env: { EXA_API_KEY: "k" },
      sleep,
      random,
      now: fixedNow,
    });
    assert.strictEqual(dashboard.providers.length, 1);
    assert.strictEqual(dashboard.providers[0].status, "none");
    assert.strictEqual(exa.invokeCount(), 0);
  });

  it("single-provider pin to Exa throws UnsupportedCapabilityError (user-error path preserved)", async () => {
    const exa = makeQuotaDescriptor("exa", {
      configured: true,
      capabilities: ["search"],
    });
    await assert.rejects(
      () =>
        buildQuotaDashboard({
          allProviders: false,
          effectiveProvider: "exa",
          descriptors: [exa],
          env: { EXA_API_KEY: "k" },
          sleep,
          random,
          now: fixedNow,
        }),
      (err) => err instanceof UnsupportedCapabilityError,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Pre-PB-T5 caller (no snapshot injected) — byte-for-byte unchanged
// ---------------------------------------------------------------------------

describe("PB-T5 quota — pre-PB-T5 caller path (no snapshot injected)", () => {
  it("quotaSource is omitted and every configured provider is live-probed", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      // quotaSnapshot omitted — pre-PB-T5 caller.
    });
    assert.strictEqual(dashboard.providers[0].status, "ok");
    assert.strictEqual(dashboard.providers[0].quotaSource, undefined, "no label attached");
    assert.strictEqual(zai.invokeCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// 6. Failure isolation under snapshot path
// ---------------------------------------------------------------------------

describe("PB-T5 quota — failure isolation under snapshot path", () => {
  it("all-provider mode: a live-probe failure is normalized + redacted; sibling rows still appear", async () => {
    const SECRET = "secret-key-DO-NOT-LEAK";
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaDescriptor("minimax", {
      error: new ScoutlineError(`fail with ${SECRET}`, "API_ERROR"),
    });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: SECRET },
      sleep,
      random,
      quotaSnapshot: stateFrom({}), // both missing → both probe
      now: fixedNow,
    });
    assert.strictEqual(dashboard.providers[0].status, "ok");
    assert.strictEqual(dashboard.providers[1].status, "error");
    const serialized = JSON.stringify(dashboard);
    assert.ok(!serialized.includes(SECRET), "credential redacted");
  });

  it("default-mode: a live-probe failure still propagates through the ordinary error path", async () => {
    const zai = makeQuotaDescriptor("zai", {
      error: new ScoutlineError("boom", "AUTH_ERROR"),
    });
    await assert.rejects(
      () =>
        buildQuotaDashboard({
          allProviders: false,
          effectiveProvider: "zai",
          descriptors: [zai],
          env: { Z_AI_API_KEY: "k" },
          sleep,
          random,
          quotaSnapshot: stateFrom({}),
          now: fixedNow,
        }),
      (err) => err instanceof ScoutlineError && err.code === "AUTH_ERROR",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Brave rate-limit caveat — warning + non-authoritative label
// ---------------------------------------------------------------------------

describe("PB-T5 quota — Brave rate-limit caveat", () => {
  // The PB-T1 snapshot stores categories only — provider-authored
  // warnings (e.g. Brave's rate-limit caveat) are NOT carried through
  // the snapshot. They surface only on a live probe. Extending the
  // snapshot schema to carry warnings is out of scope for PB-T5
  // (PB-T1 owns the schema). The two tests below pin both paths so
  // the contract is explicit.

  it("live probe (stale snapshot) surfaces Brave's rate-limit caveat via warnings → stderr", async () => {
    const braveSuccess = {
      provider: "brave",
      status: "ok",
      categories: [{ name: "monthly", unit: "requests", current: { remainingPercent: 96.8 } }],
    };
    const brave = makeQuotaDescriptor("brave", {
      result: braveSuccess,
      capabilities: ["search", "quota"],
      warnings: [
        "Brave reports a rate-limit window, NOT spend or credits consumed under metered billing.",
      ],
    });
    const stderr = [];
    const result = await quota({
      buildDashboard: async () =>
        buildQuotaDashboard({
          allProviders: false,
          effectiveProvider: "brave",
          descriptors: [brave],
          env: { BRAVE_SEARCH_API_KEY: "k" },
          sleep,
          random,
          // Stale snapshot → live probe → warnings surface.
          quotaSnapshot: stateFrom({
            brave: snapshotAt(STALE_MS, braveSuccess.categories),
          }),
          now: fixedNow,
        }),
      writeStderr: (s) => stderr.push(s),
      secrets: [],
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(brave.invokeCount(), 1, "live probe ran (stale)");
    assert.ok(
      stderr.some((s) => s.includes("rate-limit")),
      "caveat rendered to stderr",
    );
    const row = result.data.providers[0];
    assert.strictEqual(row.quotaSource.source, "live");
    assert.strictEqual(row.quotaSource.authoritative, true);
  });

  it("fresh snapshot carries the categories + source label but NOT the warnings (out of scope for PB-T5)", async () => {
    // The snapshot does not store warnings. A user who needs the
    // caveat can wait for staleness (the live probe brings it back),
    // or PB-T1's schema could be extended in a future ticket.
    const braveSuccess = {
      provider: "brave",
      status: "ok",
      categories: [{ name: "monthly", unit: "requests", current: { remainingPercent: 96.8 } }],
    };
    const brave = makeQuotaDescriptor("brave", {
      result: braveSuccess,
      capabilities: ["search", "quota"],
      warnings: ["Brave rate-limit caveat."],
    });
    const stderr = [];
    const result = await quota({
      buildDashboard: async () =>
        buildQuotaDashboard({
          allProviders: false,
          effectiveProvider: "brave",
          descriptors: [brave],
          env: { BRAVE_SEARCH_API_KEY: "k" },
          sleep,
          random,
          quotaSnapshot: stateFrom({
            brave: snapshotAt(FRESH_MS, braveSuccess.categories),
          }),
          now: fixedNow,
        }),
      writeStderr: (s) => stderr.push(s),
      secrets: [],
    });
    assert.strictEqual(brave.invokeCount(), 0, "snapshot short-circuits the probe");
    assert.strictEqual(
      stderr.length,
      0,
      "snapshot path does not surface provider-authored warnings",
    );
    const row = result.data.providers[0];
    assert.strictEqual(row.quotaSource.source, "snapshot");
    assert.strictEqual(row.quotaSource.authoritative, true);
    // Categories carried verbatim — the user still sees the numbers.
    assert.deepStrictEqual(row.categories, braveSuccess.categories);
  });
});

// ---------------------------------------------------------------------------
// 8. Doctor — snapshot reads + verification records
// ---------------------------------------------------------------------------

describe("PB-T5 doctor — quota snapshot + verification summaries", () => {
  it("threads a quota summary per Provider derived from the snapshot", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    const minimax = makeDiagnosticDescriptor("minimax");
    const report = await buildDiagnosticsReport({
      noTools: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      sleep,
      random: () => 0,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
        // minimax missing → source:"none"
      }),
      now: fixedNow,
    });
    assert.strictEqual(report.schemaVersion, 2, "schema unchanged (additive)");
    const zaiEntry = report.providers.find((p) => p.provider === "zai");
    const minimaxEntry = report.providers.find((p) => p.provider === "minimax");
    assert.ok(zaiEntry.quota, "zai quota summary present");
    assert.strictEqual(zaiEntry.quota.source, "snapshot");
    assert.strictEqual(zaiEntry.quota.authoritative, true);
    assert.strictEqual(zaiEntry.quota.observedAt, NOW - FRESH_MS);
    assert.ok(minimaxEntry.quota, "minimax quota summary present (source:none)");
    assert.strictEqual(minimaxEntry.quota.source, "none");
    assert.strictEqual(minimaxEntry.quota.authoritative, false);
    assert.strictEqual(minimaxEntry.quota.observedAt, undefined);
  });

  it("a Provider without the quota capability reports source:'none' even with a snapshot entry", async () => {
    const exa = makeDiagnosticDescriptor("exa", { capabilities: ["diagnostics"] });
    const report = await buildDiagnosticsReport({
      noTools: true,
      effectiveProvider: "exa",
      descriptors: [exa],
      env: { EXA_API_KEY: "k" },
      sleep,
      random: () => 0,
      quotaSnapshot: stateFrom({
        exa: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories), // entry exists — but exa has no quota capability
      }),
      now: fixedNow,
    });
    const row = report.providers[0];
    assert.ok(row.quota, "quota block present");
    assert.strictEqual(row.quota.source, "none", "no quota capability → never a snapshot source");
    assert.strictEqual(row.quota.authoritative, false);
    assert.strictEqual(row.quota.observedAt, undefined);
  });

  it("a scaffold snapshot entry (observedAt: 0) reports source:'none' — not a fabricated snapshot", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    const report = await buildDiagnosticsReport({
      noTools: true,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random: () => 0,
      quotaSnapshot: stateFrom({
        zai: { observedAt: 0, categories: [] }, // bare scaffold — never observed
      }),
      now: fixedNow,
    });
    const row = report.providers[0];
    assert.ok(row.quota, "quota block present");
    assert.strictEqual(row.quota.source, "none", "scaffold entry → none");
    assert.strictEqual(row.quota.authoritative, false);
    assert.strictEqual(row.quota.observedAt, undefined);
  });

  it("stale snapshot → source:'snapshot' but authoritative:false", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    const report = await buildDiagnosticsReport({
      noTools: true,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random: () => 0,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(STALE_MS, ZAI_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    const zaiEntry = report.providers[0];
    assert.strictEqual(zaiEntry.quota.source, "snapshot");
    assert.strictEqual(zaiEntry.quota.authoritative, false, "stale → non-authoritative");
  });

  it("Doctor NEVER live-probes quota — a missing snapshot stays 'none' even under tools-on", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    const report = await buildDiagnosticsReport({
      noTools: false, // tools ON — probes run
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random: () => 0,
      quotaSnapshot: stateFrom({}), // zai missing
      now: fixedNow,
    });
    assert.strictEqual(report.providers[0].status, "ok", "diagnostics probe ran");
    assert.strictEqual(report.providers[0].quota.source, "none", "no live quota probe");
  });

  it("under --no-tools the quota summary still appears (snapshot read is local state, not transport)", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    const report = await buildDiagnosticsReport({
      noTools: true,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random: () => 0,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    assert.strictEqual(report.providers[0].status, "skipped");
    assert.strictEqual(report.providers[0].quota.source, "snapshot");
    assert.strictEqual(report.providers[0].quota.authoritative, true);
  });

  it("a failed probe still surfaces the snapshot summary (the snapshot is independent of the probe)", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    // Override diagnostics to throw.
    zai.create = () => ({
      id: "zai",
      diagnostics: {
        async invoke() {
          throw new ScoutlineError("probe failed", "AUTH_ERROR");
        },
      },
    });
    const report = await buildDiagnosticsReport({
      noTools: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random: () => 0,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    assert.strictEqual(report.providers[0].status, "error");
    assert.strictEqual(report.providers[0].quota.source, "snapshot");
    assert.strictEqual(report.providers[0].quota.authoritative, true);
  });

  it("verification records are embedded per Provider (Plan A)", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    const minimax = makeDiagnosticDescriptor("minimax");
    const report = await buildDiagnosticsReport({
      noTools: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      sleep,
      random: () => 0,
      verificationRecords: {
        zai: { status: "verified", checkedAt: NOW - 1000 },
        minimax: {
          status: "unverified",
          checkedAt: NOW - 2000,
          reason: "network-deferred",
        },
      },
      now: fixedNow,
    });
    const zaiEntry = report.providers.find((p) => p.provider === "zai");
    const minimaxEntry = report.providers.find((p) => p.provider === "minimax");
    assert.strictEqual(zaiEntry.verification.status, "verified");
    assert.strictEqual(zaiEntry.verification.checkedAt, NOW - 1000);
    assert.strictEqual(minimaxEntry.verification.status, "unverified");
    assert.strictEqual(minimaxEntry.verification.reason, "network-deferred");
  });

  it("omits quota + verification fields when their dependencies are absent (backward compatible)", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    const report = await buildDiagnosticsReport({
      noTools: true,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random: () => 0,
      // quotaSnapshot + verificationRecords omitted.
    });
    assert.strictEqual("quota" in report.providers[0], false, "quota field absent");
    assert.strictEqual("verification" in report.providers[0], false, "verification field absent");
    // Exit code unaffected.
    assert.strictEqual(doctorExitCode(report), 0);
  });
});

// ---------------------------------------------------------------------------
// 9. TTY rendering of source label + none row
// ---------------------------------------------------------------------------

describe("PB-T5 quota — TTY rendering of source label + none row", () => {
  it("renders the source label line under a successful row's categories", () => {
    const dashboard = {
      schemaVersion: 1,
      effectiveProvider: "zai",
      providers: [
        {
          provider: "zai",
          status: "ok",
          categories: [{ name: "requests", unit: "requests", current: { remainingPercent: 42 } }],
          quotaSource: {
            source: "snapshot",
            observedAt: NOW - 60_000,
            authoritative: true,
          },
        },
      ],
    };
    const out = formatQuotaDashboard(dashboard, NOW);
    assert.ok(out.includes("source"), "source line present");
    assert.ok(out.includes("snapshot"), "snapshot source rendered");
    assert.ok(out.includes("fresh"), "fresh authority rendered");
    assert.ok(out.includes("1m ago"), "relative age rendered");
  });

  it("flags a stale row as non-authoritative in the TTY output", () => {
    const dashboard = {
      schemaVersion: 1,
      effectiveProvider: "zai",
      providers: [
        {
          provider: "zai",
          status: "ok",
          categories: [{ name: "requests", unit: "requests", current: { remainingPercent: 42 } }],
          quotaSource: {
            source: "snapshot",
            observedAt: NOW - STALE_MS,
            authoritative: false,
          },
        },
      ],
    };
    const out = formatQuotaDashboard(dashboard, NOW);
    assert.ok(out.includes("stale"), "stale flag rendered");
    assert.ok(out.includes("non-authoritative"), "non-authoritative rendered");
  });

  it("renders a 'none' row as a single dim line (no transport)", () => {
    const dashboard = {
      schemaVersion: 1,
      effectiveProvider: "zai",
      providers: [{ provider: "exa", status: "none", reason: "no-capability" }],
    };
    const out = formatQuotaDashboard(dashboard, NOW);
    assert.ok(out.includes("exa"), "exa row present");
    assert.ok(out.includes("no quota"), "no-quota label rendered");
    assert.ok(out.includes("no quota capability"), "reason text rendered");
  });

  it("renders a 'live' source label for a freshly-probed row", () => {
    const dashboard = {
      schemaVersion: 1,
      effectiveProvider: "zai",
      providers: [
        {
          provider: "zai",
          status: "ok",
          categories: [{ name: "requests", unit: "requests", current: { remainingPercent: 42 } }],
          quotaSource: {
            source: "live",
            observedAt: NOW,
            authoritative: true,
          },
        },
      ],
    };
    const out = formatQuotaDashboard(dashboard, NOW);
    assert.ok(out.includes("live"), "live source rendered");
    assert.ok(out.includes("fresh"), "fresh authority rendered");
  });
});

// ---------------------------------------------------------------------------
// 10. Schema decision — additive under existing versions
// ---------------------------------------------------------------------------

describe("PB-T5 schema decision — additive under existing versions", () => {
  it("QuotaDashboard.schemaVersion stays at 1 (no version bump)", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
      }),
      now: fixedNow,
    });
    assert.strictEqual(dashboard.schemaVersion, 1);
  });

  it("DiagnosticsReport.schemaVersion stays at 2 (no version bump)", async () => {
    const zai = makeDiagnosticDescriptor("zai");
    const report = await buildDiagnosticsReport({
      noTools: true,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random: () => 0,
      quotaSnapshot: stateFrom({
        zai: snapshotAt(FRESH_MS, ZAI_SUCCESS.categories),
      }),
      verificationRecords: {
        zai: { status: "verified", checkedAt: NOW },
      },
      now: fixedNow,
    });
    assert.strictEqual(report.schemaVersion, 2);
  });
});
