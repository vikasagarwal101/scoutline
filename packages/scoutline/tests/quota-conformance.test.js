/**
 * Quota Conformance (P4-02, DESIGN.md §13, ADR-0001).
 *
 * Verifies the normalized Provider-quota Interface shared by Z.AI and
 * MiniMax:
 *   - Contract types exist and normalize both Provider response shapes.
 *   - Remaining percentages are finite numbers clamped to 0..100.
 *   - Z.AI: rolling time limit -> requests category; token percentage ->
 *     tokens category; per-tool usage carried as the additive optional
 *     `toolUsage` field (GitHub #191). An internally inconsistent
 *     TIME_LIMIT counter (GitHub #191) still emits the requests
 *     category, but with an EMPTY window.
 *   - MiniMax: each model_remains -> category named by model_name, sorted
 *     ascending; epoch-ms timestamps -> ISO.
 *   - Invalid optional count sets are omitted together.
 *   - A required category with neither valid percentage nor valid counts
 *     throws QUOTA_ERROR — in the shared builder and in MiniMax. Z.AI
 *     converts that case into the empty-window emission above (#191).
 *   - No raw Provider field crosses the Interface.
 *   - Z.AI monitor auth fallback (raw key then Bearer on 401); raw
 *     response text never enters public errors.
 *   - Transient-then-success quota: exactly 2 transport attempts, 1
 *     injected delay; terminal failure: 1 attempt, 0 delay.
 *   - Recursive redaction strips both Provider credentials from quota
 *     failures.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFixture } from "./helpers/fixtures.js";
// #134 fixture-secret classification: BENIGN. The main()-driven quota
// dispatch tests use short "k" credentials, but their rendered envelopes
// are quota dashboards (numbers, statuses, provider ids) with no
// mkdtemp-randomized path anywhere near a literal pin — no #120 collision
// space (the suite never mkdtemps at all).


// Modules under test (built to dist/).
import { buildQuotaWindow, quotaFailureFromError } from "../dist/capabilities/quota.js";
import { normalizeZaiQuota, createZaiQuotaCapability } from "../dist/providers/zai/quota.js";
import { fetchZaiQuotaLimit } from "../dist/providers/zai/monitor-client.js";
import {
  normalizeMiniMaxQuota,
  createMiniMaxQuotaCapability,
} from "../dist/providers/minimax/quota.js";
import { fetchMiniMaxQuota } from "../dist/providers/minimax/quota-client.js";
import { executeProviderOperation } from "../dist/lib/execution.js";
import { redactSecrets } from "../dist/lib/redact.js";
import { ScoutlineError, ConfigurationError } from "../dist/lib/errors.js";
import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { createBraveDescriptor } from "../dist/providers/brave/adapter.js";
import { createJinaDescriptor } from "../dist/providers/jina/adapter.js";
import { normalizeBraveQuota, BRAVE_QUOTA_CAVEAT } from "../dist/providers/brave/quota.js";
import { buildQuotaDashboard, quota } from "../dist/commands/quota.js";

const ZAI_KEY = "zai-secret-key-DO-NOT-LEAK";
const MINIMAX_KEY = "minimax-secret-key-DO-NOT-LEAK";

// Provider field names that must NOT appear as keys in normalized output.
const ZAI_RAW_DENY = [
  "level",
  "limits",
  "TIME_LIMIT",
  "TOKENS_LIMIT",
  "usageDetails",
  "currentValue",
  "nextResetTime",
  "modelCode",
  // `usage` is the normalized toolUsage count key (Q2/#191); the raw
  // TIME_LIMIT `usage` (the cap) crosses as `limit`, pinned by the
  // golden shape. `usageDetails`/`modelCode` stay denied — the raw
  // container and its field name must never cross.
];
const MINIMAX_RAW_DENY = [
  "model_remains",
  "model_name",
  "end_time",
  "weekly_end_time",
  "current_interval_remaining_percent",
  "current_interval_usage_count",
  "current_interval_total_count",
  "current_weekly_usage_count",
  "current_weekly_total_count",
  "current_weekly_remaining_percent",
];

// ---------------------------------------------------------------------------
// Shared conformance helper
// ---------------------------------------------------------------------------

function collectKeys(value, into) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      into.add(key);
      collectKeys(value[key], into);
    }
  }
}

/**
 * Validate the normalized shape for both Adapters and assert no raw
 * Provider field crosses the Interface.
 */
function assertQuotaSuccessConformance(success, denyKeys) {
  assert.strictEqual(success.status, "ok");
  assert.ok(Array.isArray(success.categories), "categories must be an array");
  assert.ok(success.categories.length > 0, "at least one category required");
  for (const category of success.categories) {
    assert.ok(typeof category.name === "string" && category.name.length > 0, "nonempty name");
    assert.ok(category.unit === "requests" || category.unit === "tokens", "valid unit");
    const current = category.current;
    assert.ok(current && typeof current === "object", "current window present");
    assert.ok(Number.isFinite(current.remainingPercent), "remainingPercent finite");
    assert.ok(
      current.remainingPercent >= 0 && current.remainingPercent <= 100,
      "remainingPercent clamped 0..100",
    );
    if (category.weekly !== undefined) {
      const w = category.weekly;
      assert.ok(Number.isFinite(w.remainingPercent), "weekly remainingPercent finite");
      assert.ok(w.remainingPercent >= 0 && w.remainingPercent <= 100, "weekly clamped");
    }
  }
  const keys = new Set();
  collectKeys(success, keys);
  for (const denied of denyKeys) {
    assert.ok(!keys.has(denied), `raw Provider field "${denied}" crossed the Interface`);
  }
}

// ---------------------------------------------------------------------------
// Fake fetch builder
// ---------------------------------------------------------------------------

function makeFetchSequence(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const resp = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (resp.throw) throw resp.throw;
    return {
      ok: resp.ok ?? (resp.status !== undefined && resp.status < 400),
      status: resp.status ?? 200,
      text: async () => (typeof resp.body === "string" ? resp.body : ""),
      json: async () => resp.json,
    };
  };
  return { fn, calls };
}

function noOpTimer() {
  const ids = [];
  return {
    setTimeout: (cb) => {
      ids.push(cb);
      return ids.length;
    },
    clearTimeout: () => {},
    count: () => ids.length,
  };
}

// ===========================================================================
// 1. Contract: remaining percentages finite, clamped 0..100 (window builder)
// ===========================================================================

describe("quota window builder — remainingPercent rules", () => {
  it("clamps an explicit remaining percentage above 100 down to 100", () => {
    const w = buildQuotaWindow({ explicitRemainingPercent: 150 });
    assert.strictEqual(w.remainingPercent, 100);
  });

  it("clamps an explicit remaining percentage below 0 up to 0", () => {
    const w = buildQuotaWindow({ explicitRemainingPercent: -10 });
    assert.strictEqual(w.remainingPercent, 0);
  });

  it("derives remainingPercent from finite counts when no explicit percent", () => {
    const w = buildQuotaWindow({ used: 25, limit: 100 });
    assert.strictEqual(w.remainingPercent, 75);
    assert.strictEqual(w.used, 25);
    assert.strictEqual(w.limit, 100);
    assert.strictEqual(w.remaining, 75);
  });

  it("omits an invalid optional count set together but keeps explicit percent", () => {
    const w = buildQuotaWindow({ explicitRemainingPercent: 50, used: NaN, limit: 100 });
    assert.strictEqual(w.remainingPercent, 50);
    assert.ok(!("used" in w), "invalid used omitted");
    assert.ok(!("limit" in w), "invalid count set omitted together");
    assert.ok(!("remaining" in w), "remaining omitted with the set");
  });

  it("keeps a valid used count with an explicit percent when no limit exists (used-only window, #99)", () => {
    const w = buildQuotaWindow({ used: 100, explicitRemainingPercent: 100 });
    assert.strictEqual(w.remainingPercent, 100);
    assert.strictEqual(w.used, 100);
    assert.ok(!("limit" in w), "no limit exists to report");
    assert.ok(!("remaining" in w), "remaining is omitted, not fabricated");
  });

  it("used-only window keeps used only when limit is fully absent, not when the set is invalid", () => {
    // Invalid count set (used invalid, limit present) keeps the
    // omitted-together discipline: explicit percent survives, counts do not.
    const invalid = buildQuotaWindow({ explicitRemainingPercent: 50, used: NaN, limit: 100 });
    assert.strictEqual(invalid.remainingPercent, 50);
    assert.ok(!("used" in invalid), "invalid used still omitted together");
    // Unknown-limit remaining-only window (#49 discipline): `remaining` is
    // published verbatim and `used` stays omitted.
    const remainingOnly = buildQuotaWindow({ used: 100, remaining: 12 });
    assert.strictEqual(remainingOnly.remaining, 12);
    assert.strictEqual(remainingOnly.remainingPercent, undefined);
    assert.ok(!("used" in remainingOnly), "#49 path keeps omitting used");
  });

  it("publishes an explicit remaining next to a finite percent when the count set is invalid (#109)", () => {
    // Z.AI cumulative currentValue past the cap: counts invalid, but the
    // Provider publishes both an exact remaining and a used percentage.
    const w = buildQuotaWindow({
      explicitRemainingPercent: 1.2,
      remaining: 88,
    });
    assert.strictEqual(w.remainingPercent, 1.2);
    assert.strictEqual(w.remaining, 88);
    assert.ok(!("used" in w), "invalid counts stay omitted");
    assert.ok(!("limit" in w), "invalid counts stay omitted");
  });

  it("keeps the #99 used-only shape for a used+percent+remaining input (ordering pin)", () => {
    // Strict additivity: the remaining-verbatim branch sits AFTER the
    // #99 used-only path, so this hypothetical input keeps its exact
    // pre-fix shape — the new branch must not shadow it.
    const w = buildQuotaWindow({ used: 40, explicitRemainingPercent: 50, remaining: 88 });
    assert.strictEqual(w.remainingPercent, 50);
    assert.strictEqual(w.used, 40);
    assert.ok(!("remaining" in w), "#99 path omits remaining, never fabricates");
    assert.ok(!("limit" in w), "no limit exists to report");
  });

  it("still throws when invalid counts come with no percent and no remaining", () => {
    assert.throws(
      () => buildQuotaWindow({ used: 4912, limit: 1000 }),
      (err) => err instanceof ScoutlineError && err.code === "QUOTA_ERROR",
    );
  });

  it("throws QUOTA_ERROR when a category has neither valid percent nor valid counts", () => {
    assert.throws(
      () => buildQuotaWindow({ used: 150, limit: 100 }),
      (err) => err instanceof ScoutlineError && err.code === "QUOTA_ERROR",
    );
    assert.throws(
      () => buildQuotaWindow({}),
      (err) => err instanceof ScoutlineError && err.code === "QUOTA_ERROR",
    );
  });

  it("converts epoch-ms resetsAt to ISO and omits invalid resets", () => {
    const w = buildQuotaWindow({ explicitRemainingPercent: 10, resetsAtEpochMs: 1700000000000 });
    assert.strictEqual(w.resetsAt, "2023-11-14T22:13:20.000Z");
    const w2 = buildQuotaWindow({ explicitRemainingPercent: 10, resetsAtEpochMs: "bad" });
    assert.ok(!("resetsAt" in w2), "invalid resetsAt omitted");
  });
});

// ===========================================================================
// 2. Z.AI normalization
// ===========================================================================

describe("Z.AI quota normalization", () => {
  it("maps the fixture to the normalized golden shape", async () => {
    const raw = await readFixture("providers", "zai", "quota.json");
    const expected = await readFixture("normalized", "quota-zai.json");
    const normalized = normalizeZaiQuota(raw);
    assert.deepStrictEqual(normalized, expected);
  });

  it("names categories requests then tokens", () => {
    const normalized = normalizeZaiQuota({
      level: "lite",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 1,
          number: 1,
          percentage: 30,
          nextResetTime: 1700000000000,
        },
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 10,
          remaining: 90,
          percentage: 10,
          nextResetTime: 1700000000000,
          usageDetails: [{ modelCode: "x", usage: 1 }],
        },
      ],
    });
    // requests comes before tokens regardless of input order.
    assert.deepStrictEqual(
      normalized.categories.map((c) => c.name),
      ["requests", "tokens"],
    );
  });

  it("converts token used percentage to remaining percentage", () => {
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [{ type: "TOKENS_LIMIT", unit: 1, number: 1, percentage: 60 }],
    });
    assert.strictEqual(normalized.categories[0].current.remainingPercent, 40);
  });

  it("carries the per-tool breakdown as additive toolUsage (#191/Q2)", () => {
    // Q2 supersedes the former "per-tool breakdown is omitted" pin: the
    // raw `usageDetails` list must not cross, but its per-tool content
    // DOES — normalized onto the additive `toolUsage` field, modelCode
    // as `tool` and usage as `usage`. The raw container name and its
    // raw field name stay inside the Adapter.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 10,
          remaining: 90,
          percentage: 10,
          nextResetTime: 1700000000000,
          usageDetails: [
            { modelCode: "search-prime", usage: 5 },
            { modelCode: "web-reader", usage: 3 },
          ],
        },
      ],
    });
    const category = normalized.categories.find((c) => c.name === "requests");
    assert.deepStrictEqual(category.toolUsage, [
      { tool: "search-prime", usage: 5 },
      { tool: "web-reader", usage: 3 },
    ]);
    const keys = new Set();
    collectKeys(normalized, keys);
    assert.ok(!keys.has("usageDetails"), "raw container never crosses");
    assert.ok(!keys.has("modelCode"), "raw per-tool field name never crosses");
    assert.ok(!keys.has("byTool"));
  });

  it("drops usage entries with a zero, negative, or absent usage count (#191/Q2)", () => {
    // A non-positive count is not a usage observation; an absent one is
    // not a number at all. Both are dropped rather than published as 0 —
    // a zero row would read as "this tool was available and unused",
    // which the Provider never said.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 10,
          remaining: 90,
          percentage: 10,
          nextResetTime: 1700000000000,
          usageDetails: [
            { modelCode: "search-prime", usage: 7 },
            { modelCode: "zero", usage: 0 },
            { modelCode: "negative", usage: -3 },
            { modelCode: "absent" },
            { modelCode: "not-a-number", usage: "12" },
          ],
        },
      ],
    });
    assert.deepStrictEqual(
      normalized.categories.find((c) => c.name === "requests").toolUsage,
      [{ tool: "search-prime", usage: 7 }],
    );
  });

  it("drops a usage entry with an absent or non-string tool id (#191/Q2)", () => {
    // The tool id IS the normalized row's label; an entry without one
    // has nothing to name.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 10,
          remaining: 90,
          percentage: 10,
          nextResetTime: 1700000000000,
          usageDetails: [
            { modelCode: "search-prime", usage: 7 },
            { usage: 4 },
            { modelCode: "", usage: 4 },
            { modelCode: 42, usage: 4 },
          ],
        },
      ],
    });
    assert.deepStrictEqual(
      normalized.categories.find((c) => c.name === "requests").toolUsage,
      [{ tool: "search-prime", usage: 7 }],
    );
  });

  it("omits toolUsage entirely when no entry survives the filter (no empty array)", () => {
    // Two distinct absent cases, one rule: an absent `usageDetails`, and
    // one whose every entry is filtered out. Neither may publish
    // `toolUsage: []` — an empty array is a claim ("this window has
    // tools, and none used any"), which a silent Provider never made.
    const absentList = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 10,
          remaining: 90,
          percentage: 10,
          nextResetTime: 1700000000000,
        },
      ],
    });
    const requests = absentList.categories.find((c) => c.name === "requests");
    assert.ok(!("toolUsage" in requests), "absent usageDetails omits the field");
    assert.strictEqual(JSON.stringify(requests).includes("toolUsage"), false);

    const allFiltered = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 10,
          remaining: 90,
          percentage: 10,
          nextResetTime: 1700000000000,
          usageDetails: [{ modelCode: "zero", usage: 0 }, { usage: 0 }],
        },
      ],
    });
    assert.ok(
      !("toolUsage" in allFiltered.categories.find((c) => c.name === "requests")),
      "an all-filtered list omits the field rather than publishing []",
    );
  });

  it("carries toolUsage even when the TIME_LIMIT window is corrupt (#191/Q2 independence)", () => {
    // The per-tool rows are informational; they are NOT gated on the
    // Q1 consistency guard. A window whose counts contradict each other
    // suppresses the WINDOW, never the per-tool observations — those
    // stand on their own filter.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 5067,
          remaining: 0,
          percentage: 100,
          nextResetTime: 1791411480983,
          usageDetails: [{ modelCode: "search-prime", usage: 97 }],
        },
      ],
    });
    const category = normalized.categories.find((c) => c.name === "requests");
    assert.strictEqual(JSON.stringify(category.current), "{}", "window still suppressed");
    assert.deepStrictEqual(category.toolUsage, [{ tool: "search-prime", usage: 97 }]);
  });

  it("never attaches toolUsage to a non-requests category (#191/Q2)", () => {
    // `usageDetails` lives only on TIME_LIMIT. TOKENS_LIMIT maps to
    // `tokens`, which has no per-tool breakdown to carry.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 1,
          number: 1,
          percentage: 60,
          nextResetTime: 1700000000000,
        },
      ],
    });
    assert.ok(
      !("toolUsage" in normalized.categories.find((c) => c.name === "tokens")),
      "tokens category carries no toolUsage",
    );
  });

  it("passes conformance and leaks no raw Z.AI field", async () => {
    const raw = await readFixture("providers", "zai", "quota.json");
    const normalized = normalizeZaiQuota(raw);
    assertQuotaSuccessConformance(normalized, ZAI_RAW_DENY);
  });

  it("emits an empty current window when a TIME_LIMIT entry is wholly unusable", () => {
    // #191: a TIME_LIMIT entry missing every field the consistency
    // predicate needs is corrupt, not fatal — the category must still
    // reach doctor/ranking (which treat an absent window as unknown)
    // rather than aborting the whole provider's quota probe.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [{ type: "TIME_LIMIT", unit: 5, number: 1 }],
    });
    const category = normalized.categories.find((c) => c.name === "requests");
    assert.ok(category);
    assert.strictEqual(JSON.stringify(category.current), "{}");
  });

  it("rejects the whole TIME_LIMIT window when currentValue exceeds the cap (#191)", () => {
    // #191 supersedes #109: this entry is self-contradictory — 4912 used
    // against a 1000 cap with 88 remaining means |1000 - 4912 - 88| =
    // 4000 > 1 — so the raw counts, the raw remaining, AND the raw
    // percentage are all distrusted together. #109's partial rescue
    // (publish `remaining` verbatim off unverifiable counts) was the
    // fabrication channel that produced a false 0%-remaining.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 4912,
          remaining: 88,
          percentage: 98.8,
          nextResetTime: 1791411480983,
        },
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: 4,
          nextResetTime: 1788850059317,
        },
      ],
    });
    assert.strictEqual(
      JSON.stringify(normalized.categories.find((c) => c.name === "requests").current),
      "{}",
    );
    // The sibling TOKENS_LIMIT entry is untouched: one corrupt window
    // must not suppress a healthy category.
    assert.strictEqual(
      normalized.categories.find((c) => c.name === "tokens").current.remainingPercent,
      96,
    );
  });

  it("rejects negative currentValue and zero cap as corrupt windows (#191)", () => {
    // #191: a negative count and a zero cap each fail the consistency
    // predicate, so the entry emits an empty window instead of falling
    // back to the same entry's `remaining`/`percentage` — the fields the
    // predicate just proved untrustworthy.
    const negativeUsed = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: -1,
          remaining: 95,
          percentage: 5,
          nextResetTime: 1791411480983,
        },
      ],
    });
    assert.strictEqual(JSON.stringify(negativeUsed.categories[0].current), "{}");

    const zeroCap = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 0,
          currentValue: 0,
          remaining: 100,
          percentage: 0,
          nextResetTime: 1791411480983,
        },
      ],
    });
    assert.strictEqual(JSON.stringify(zeroCap.categories[0].current), "{}");
  });

  it("keeps the count fields on a sane TIME_LIMIT payload while preferring the raw percentage (#191)", () => {
    // #191 raw-preference: the Provider's own percentage (1 used -> 99
    // remaining) wins over the counts-derived 98.5, which differs inside
    // the rounding tolerance. The counts themselves are still published —
    // only the percentage's PROVENANCE changes.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 15,
          remaining: 985,
          percentage: 1,
          nextResetTime: 1791411480983,
        },
      ],
    });
    const w = normalized.categories[0].current;
    assert.strictEqual(w.remainingPercent, 99);
    assert.strictEqual(w.used, 15);
    assert.strictEqual(w.limit, 1000);
    assert.strictEqual(w.remaining, 985);
  });

  it("maps plan from level, defaulting when absent", () => {
    const a = normalizeZaiQuota({
      level: "max",
      limits: [{ type: "TOKENS_LIMIT", unit: 1, number: 1, percentage: 40 }],
    });
    assert.strictEqual(a.plan, "max");
  });

  it("drops the current window when TIME_LIMIT counts contradict the published remaining (#191)", () => {
    // Pathological upstream counter observed live: currentValue 5067 past
    // a 1000 cap while `remaining` reads 0 — the entry fails the internal
    // consistency predicate, so no field of it may reach a window.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 5067,
          remaining: 0,
          percentage: 100,
          nextResetTime: 1791411480983,
          usageDetails: [{ modelCode: "search-prime", usage: 97 }],
        },
      ],
    });
    const category = normalized.categories.find((c) => c.name === "requests");
    assert.ok(category, "category is still emitted (doctor/ranking must see the row)");
    assert.strictEqual(JSON.stringify(category.current), "{}");
  });

  it("emits an empty window when a consistent sum hides a single guard-term violation (#191)", () => {
    // Teeth pins for guard terms the older corruption tests do not
    // isolate: each entry below PASSES the |usage-used-remaining|<=1 sum
    // check and every positivity check, so exactly ONE term of the
    // consistency predicate is what rejects it. The normalizer keeps only
    // the FIRST TIME_LIMIT entry, so each term gets its own payload.
    const cases = [
      // remaining (1001) above the cap (1000): only "remaining <= usage"
      // rejects — currentValue 0 keeps the sum consistent.
      { marker: "remaining-over-cap", usage: 1000, currentValue: 0, remaining: 1001, percentage: 0 },
      // percentage 150 over 100: counts are perfectly consistent.
      { marker: "percent-over-100", usage: 1000, currentValue: 100, remaining: 900, percentage: 150 },
      // percentage -5 under 0: counts are perfectly consistent.
      { marker: "percent-negative", usage: 1000, currentValue: 100, remaining: 900, percentage: -5 },
    ];
    const failures = [];
    for (const { marker, ...fields } of cases) {
      const normalized = normalizeZaiQuota({
        level: "pro",
        limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, nextResetTime: 1791411480983, ...fields }],
      });
      const current = normalized.categories.find((c) => c.name === "requests").current;
      if (JSON.stringify(current) !== "{}") failures.push(marker);
    }
    assert.deepStrictEqual(failures, [], "each single-term violation must suppress the window");
  });

  it("prefers the raw percentage over counts derivation when TIME_LIMIT is consistent (#191)", () => {
    // 100 - percentage(11) = 89 remaining, NOT the counts-derived 88.7
    // ((1000 - 113) / 1000 * 100). Raw-field trust is the ruling.
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 113,
          remaining: 887,
          percentage: 11,
          nextResetTime: 1791411480983,
        },
      ],
    });
    const w = normalized.categories.find((c) => c.name === "requests").current;
    assert.strictEqual(w.remainingPercent, 89);
    assert.strictEqual(w.used, 113);
    assert.strictEqual(w.limit, 1000);
    assert.strictEqual(w.remaining, 887);
  });

  it("keeps exhaustion detectable on a consistent TIME_LIMIT at zero remaining (#191)", () => {
    const normalized = normalizeZaiQuota({
      level: "pro",
      limits: [
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 1000,
          remaining: 0,
          percentage: 100,
          nextResetTime: 1791411480983,
        },
      ],
    });
    const w = normalized.categories.find((c) => c.name === "requests").current;
    assert.strictEqual(w.remainingPercent, 0);
    assert.strictEqual(w.remaining, 0);
  });
});

// ===========================================================================
// 3. MiniMax normalization
// ===========================================================================

describe("MiniMax quota normalization", () => {
  it("maps the fixture to the normalized golden shape", async () => {
    const raw = await readFixture("providers", "minimax", "quota.json");
    const expected = await readFixture("normalized", "quota-minimax.json");
    const normalized = normalizeMiniMaxQuota(raw);
    assert.deepStrictEqual(normalized, expected);
  });

  it("sorts categories ascending by model name", () => {
    const normalized = normalizeMiniMaxQuota({
      model_remains: [
        {
          model_name: "zeta",
          current_interval_usage_count: 1,
          current_interval_total_count: 10,
          current_interval_remaining_percent: 90,
          end_time: 1700000000000,
        },
        {
          model_name: "alpha",
          current_interval_usage_count: 1,
          current_interval_total_count: 10,
          current_interval_remaining_percent: 90,
          end_time: 1700000000000,
        },
      ],
    });
    assert.deepStrictEqual(
      normalized.categories.map((c) => c.name),
      ["alpha", "zeta"],
    );
  });

  it("converts epoch-ms end_time and weekly_end_time to ISO", async () => {
    const raw = await readFixture("providers", "minimax", "quota.json");
    const normalized = normalizeMiniMaxQuota(raw);
    const zorla = normalized.categories.find((c) => c.name === "zorla-x");
    assert.strictEqual(zorla.current.resetsAt, "2023-11-14T22:13:20.000Z");
    assert.strictEqual(zorla.weekly.resetsAt, "2023-11-20T17:06:40.000Z");
  });

  it("passes conformance and leaks no raw MiniMax field", async () => {
    const raw = await readFixture("providers", "minimax", "quota.json");
    const normalized = normalizeMiniMaxQuota(raw);
    assertQuotaSuccessConformance(normalized, MINIMAX_RAW_DENY);
  });

  it("throws QUOTA_ERROR when an entry has neither valid percent nor counts", () => {
    assert.throws(
      () => normalizeMiniMaxQuota({ model_remains: [{ model_name: "x" }] }),
      (err) => err instanceof ScoutlineError && err.code === "QUOTA_ERROR",
    );
  });

  it("rejects a non-array model_remains as a malformed (API_ERROR) response", () => {
    assert.throws(
      () => normalizeMiniMaxQuota({ model_remains: "nope" }),
      (err) => err instanceof ScoutlineError && err.code === "API_ERROR",
    );
  });
});

// ===========================================================================
// 4. Z.AI monitor client — auth fallback and error hygiene
// ===========================================================================

describe("Z.AI monitor client — auth fallback", () => {
  it("tries raw key first then Bearer on 401", async () => {
    const { fn, calls } = makeFetchSequence([
      { status: 401, body: "" },
      { ok: true, json: { data: { level: "pro", limits: [] } } },
    ]);
    const result = await fetchZaiQuotaLimit(ZAI_KEY, {
      fetch: fn,
      ...noOpTimer(),
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].init.headers.Authorization, ZAI_KEY);
    assert.strictEqual(calls[1].init.headers.Authorization, `Bearer ${ZAI_KEY}`);
    assert.strictEqual(result.level, "pro");
  });

  it("does not retry with Bearer on a non-401 failure", async () => {
    const { fn, calls } = makeFetchSequence([{ status: 503, body: "" }]);
    await assert.rejects(
      () => fetchZaiQuotaLimit(ZAI_KEY, { fetch: fn, ...noOpTimer() }),
      (err) => err instanceof ScoutlineError,
    );
    assert.strictEqual(calls.length, 1, "one attempt for non-401 failure");
  });

  it("never lets raw response text enter public errors", async () => {
    const sentinel = "SECRET-LEAK-BODY-DO-NOT-LEAK";
    const { fn } = makeFetchSequence([{ status: 503, body: sentinel }]);
    await assert.rejects(
      () => fetchZaiQuotaLimit(ZAI_KEY, { fetch: fn, ...noOpTimer() }),
      (err) =>
        !String(err.message).includes(sentinel) && !String(err.help || "").includes(sentinel),
    );
  });

  it("throws AuthError when both auth schemes are rejected", async () => {
    const { fn } = makeFetchSequence([
      { status: 401, body: "" },
      { status: 403, body: "" },
    ]);
    await assert.rejects(
      () => fetchZaiQuotaLimit(ZAI_KEY, { fetch: fn, ...noOpTimer() }),
      (err) => err instanceof ScoutlineError && err.code === "AUTH_ERROR",
    );
  });
});

// ===========================================================================
// 5. MiniMax quota-client — single attempt, exact URL/header
// ===========================================================================

describe("MiniMax quota-client", () => {
  it("performs one GET to the exact remains endpoint with Bearer header", async () => {
    const { fn, calls } = makeFetchSequence([{ ok: true, json: { model_remains: [] } }]);
    const result = await fetchMiniMaxQuota(
      { apiKey: MINIMAX_KEY, region: "global", baseUrl: "https://api.minimax.io" },
      { fetch: fn, ...noOpTimer() },
    );
    assert.deepStrictEqual(result, { model_remains: [] });
    assert.strictEqual(calls.length, 1, "single attempt, no internal retry");
    assert.strictEqual(
      calls[0].url,
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    );
    assert.strictEqual(calls[0].init.headers.Authorization, `Bearer ${MINIMAX_KEY}`);
  });

  it("does not retry on failure", async () => {
    const { fn, calls } = makeFetchSequence([{ status: 500, body: "" }]);
    await assert.rejects(
      () =>
        fetchMiniMaxQuota(
          { apiKey: MINIMAX_KEY, region: "global", baseUrl: "https://api.minimax.io" },
          { fetch: fn, ...noOpTimer() },
        ),
      (err) => err instanceof ScoutlineError,
    );
    assert.strictEqual(calls.length, 1);
  });
});

// ===========================================================================
// 6. Retry behaviour through executeProviderOperation
// ===========================================================================

describe("quota retry behaviour", () => {
  it("transient-then-success: exactly 2 attempts and 1 injected delay", async () => {
    const { fn, calls } = makeFetchSequence([
      { status: 503, body: "" },
      { ok: true, json: { data: { level: "pro", limits: [] } } },
    ]);
    let delays = 0;
    const capability = createZaiQuotaCapability({
      env: { Z_AI_API_KEY: ZAI_KEY },
      fetch: fn,
      ...noOpTimer(),
    });
    const result = await executeProviderOperation("quota", () => capability.invoke(), {
      sleep: async () => {
        delays += 1;
      },
      random: () => 0,
    });
    assert.strictEqual(calls.length, 2, "two transport attempts");
    assert.strictEqual(delays, 1, "one injected delay");
    assert.strictEqual(result.status, "ok");
  });

  it("terminal auth failure: exactly 1 attempt and 0 delays", async () => {
    const { fn, calls } = makeFetchSequence([
      { status: 401, body: "" },
      { status: 403, body: "" },
    ]);
    let delays = 0;
    const capability = createZaiQuotaCapability({
      env: { Z_AI_API_KEY: ZAI_KEY },
      fetch: fn,
      ...noOpTimer(),
    });
    await assert.rejects(
      () =>
        executeProviderOperation("quota", () => capability.invoke(), {
          sleep: async () => {
            delays += 1;
          },
          random: () => 0,
        }),
      (err) => err instanceof ScoutlineError && err.code === "AUTH_ERROR",
    );
    assert.strictEqual(calls.length, 2, "auth fallback still runs within the single attempt");
    assert.strictEqual(delays, 0, "no retry delay for terminal failure");
  });
});

// ===========================================================================
// 7. Recursive redaction of quota failures
// ===========================================================================

describe("quota failure redaction", () => {
  it("quotaFailureFromError maps an error to a normalized failure shape", () => {
    const failure = quotaFailureFromError("zai", new ScoutlineError("boom", "QUOTA_ERROR"));
    assert.strictEqual(failure.provider, "zai");
    assert.strictEqual(failure.status, "error");
    assert.strictEqual(failure.error.code, "QUOTA_ERROR");
    assert.strictEqual(failure.error.message, "boom");
  });

  it("recursive redaction strips both Provider credentials from a failure", () => {
    const failure = quotaFailureFromError(
      "minimax",
      new ScoutlineError(`quota failed for ${ZAI_KEY} and ${MINIMAX_KEY}`, "API_ERROR"),
    );
    const redacted = redactSecrets(failure, [ZAI_KEY, MINIMAX_KEY]);
    const serialized = JSON.stringify(redacted);
    assert.ok(!serialized.includes(ZAI_KEY), "Z.AI credential absent");
    assert.ok(!serialized.includes(MINIMAX_KEY), "MiniMax credential absent");
  });
});

// ===========================================================================
// 8. Adapter wiring — both Adapters expose a QuotaCapability
// ===========================================================================

describe("adapter quota capability wiring", () => {
  it("both descriptors advertise and expose quota", () => {
    const cases = [
      [createZaiDescriptor(), { Z_AI_API_KEY: ZAI_KEY }],
      [createMiniMaxDescriptor(), { MINIMAX_API_KEY: MINIMAX_KEY }],
    ];
    for (const [descriptor, env] of cases) {
      assert.ok(descriptor.capabilities().has("quota"));
      assert.equal(typeof descriptor.create({ env }).quota?.invoke, "function");
    }
  });

  it("MiniMax quota capability fetches through the direct client and normalizes", async () => {
    const raw = await readFixture("providers", "minimax", "quota.json");
    const { fn, calls } = makeFetchSequence([{ ok: true, json: raw }]);
    const expected = await readFixture("normalized", "quota-minimax.json");
    const capability = createMiniMaxQuotaCapability({
      env: { MINIMAX_API_KEY: MINIMAX_KEY },
      fetch: fn,
      ...noOpTimer(),
    });
    const result = await capability.invoke();
    assert.deepStrictEqual(result, expected);
    assert.strictEqual(calls.length, 1);
  });

  it("Z.AI quota capability fetches through the monitor client and normalizes", async () => {
    const raw = await readFixture("providers", "zai", "quota.json");
    const expected = await readFixture("normalized", "quota-zai.json");
    const { fn } = makeFetchSequence([{ ok: true, json: { data: raw } }]);
    const capability = createZaiQuotaCapability({
      env: { Z_AI_API_KEY: ZAI_KEY },
      fetch: fn,
      ...noOpTimer(),
    });
    const result = await capability.invoke();
    assert.deepStrictEqual(result, expected);
  });
});

// ===========================================================================
// 9. Quota dashboard — default and all-provider (P4-03)
// ===========================================================================

/**
 * Build a fake descriptor whose Adapter exposes a QuotaCapability that
 * either resolves `result` or throws `error`. `configured` toggles
 * `isConfigured`.
 */
function makeQuotaDescriptor(id, { result, error, configured = true }) {
  let invokes = 0;
  return {
    id,
    isConfigured: () => configured,
    capabilities: () => new Set(["quota"]),
    create: () => ({
      id,
      quota: {
        async invoke() {
          invokes += 1;
          if (error) throw error;
          return result;
        },
      },
    }),
    invokeCount: () => invokes,
  };
}

const ZAI_SUCCESS = {
  provider: "zai",
  status: "ok",
  plan: "pro",
  categories: [
    {
      name: "requests",
      unit: "requests",
      current: { remainingPercent: 25 },
      // Additive optional field (#191/Q2): the shape a real Adapter emits
      // for a live zai probe. Existing dashboard pins that only read
      // `current` are unaffected.
      toolUsage: [
        { tool: "search-prime", usage: 700 },
        { tool: "web-reader", usage: 250 },
      ],
    },
  ],
};
const MINIMAX_SUCCESS = {
  provider: "minimax",
  status: "ok",
  categories: [{ name: "abab6.5s", unit: "requests", current: { remainingPercent: 70 } }],
};

const sleep = async () => {};
const random = () => 0;

describe("quota dashboard — default mode (effective provider)", () => {
  it("returns the effective provider's normalized success in a schema-version-1 dashboard", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
    });
    assert.strictEqual(dashboard.schemaVersion, 1);
    assert.strictEqual(dashboard.effectiveProvider, "zai");
    assert.strictEqual(dashboard.providers.length, 1);
    assert.strictEqual(dashboard.providers[0].status, "ok");
    assert.strictEqual(dashboard.providers[0].provider, "zai");
  });

  it("works for each effective Provider", async () => {
    const mm = makeQuotaDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "minimax",
      descriptors: [mm],
      env: { MINIMAX_API_KEY: "k" },
      sleep,
      random,
    });
    assert.strictEqual(dashboard.providers[0].provider, "minimax");
  });

  it("fails with a configuration error before transport when the effective provider is unconfigured", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS, configured: false });
    await assert.rejects(
      () =>
        buildQuotaDashboard({
          allProviders: false,
          effectiveProvider: "zai",
          descriptors: [zai],
          env: {},
          sleep,
          random,
        }),
      (err) => err instanceof ConfigurationError,
    );
    assert.strictEqual(zai.invokeCount(), 0, "transport never constructed");
  });

  it("default-mode quota failure propagates through the ordinary error path", async () => {
    const zai = makeQuotaDescriptor("zai", {
      error: new ScoutlineError("nope", "AUTH_ERROR"),
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
        }),
      (err) => err instanceof ScoutlineError && err.code === "AUTH_ERROR",
    );
  });
});

describe("quota dashboard — all-provider mode", () => {
  it("queries every configured descriptor in registry order and no unconfigured one", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaDescriptor("minimax", {
      result: MINIMAX_SUCCESS,
      configured: false,
    });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
    });
    assert.strictEqual(dashboard.providers.length, 1, "unconfigured not invoked");
    assert.strictEqual(dashboard.providers[0].provider, "zai");
    assert.strictEqual(minimax.invokeCount(), 0);
  });

  it("keeps both a success and a failure, redacts the failure, exit-relevant", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaDescriptor("minimax", {
      error: new ScoutlineError(`fail ${ZAI_KEY} ${MINIMAX_KEY}`, "API_ERROR"),
    });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: ZAI_KEY, MINIMAX_API_KEY: MINIMAX_KEY },
      sleep,
      random,
    });
    assert.strictEqual(dashboard.providers.length, 2);
    assert.strictEqual(dashboard.providers[0].provider, "zai");
    assert.strictEqual(dashboard.providers[0].status, "ok");
    assert.strictEqual(dashboard.providers[1].provider, "minimax");
    assert.strictEqual(dashboard.providers[1].status, "error");
    const serialized = JSON.stringify(dashboard);
    assert.ok(!serialized.includes(ZAI_KEY), "Z.AI credential redacted");
    assert.ok(!serialized.includes(MINIMAX_KEY), "MiniMax credential redacted");
  });

  it("returns a configuration failure when no provider is configured", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS, configured: false });
    const minimax = makeQuotaDescriptor("minimax", {
      result: MINIMAX_SUCCESS,
      configured: false,
    });
    await assert.rejects(
      () =>
        buildQuotaDashboard({
          allProviders: true,
          effectiveProvider: "zai",
          descriptors: [zai, minimax],
          env: {},
          sleep,
          random,
        }),
      (err) => err instanceof ConfigurationError,
    );
  });

  it("effectiveProvider is metadata only and an unconfigured effective is not invoked", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS, configured: false });
    const minimax = makeQuotaDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { MINIMAX_API_KEY: "k" },
      sleep,
      random,
    });
    assert.strictEqual(dashboard.effectiveProvider, "zai");
    assert.strictEqual(zai.invokeCount(), 0, "unconfigured effective not invoked");
    assert.strictEqual(dashboard.providers.length, 1);
    assert.strictEqual(dashboard.providers[0].provider, "minimax");
  });

  it("preserves registry order for same-class (all ok) rows", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      sleep,
      random,
    });
    assert.deepStrictEqual(
      dashboard.providers.map((p) => p.provider),
      ["zai", "minimax"],
    );
  });

  it("sorts rows healthy-first: an erroring zai yields to a healthy minimax (#96)", async () => {
    const zai = makeQuotaDescriptor("zai", {
      error: new ScoutlineError("fail", "API_ERROR"),
    });
    const minimax = makeQuotaDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, minimax],
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      sleep,
      random,
    });
    assert.deepStrictEqual(
      dashboard.providers.map((p) => p.provider),
      ["minimax", "zai"],
      "healthy (ok) rows sort before error rows regardless of registry order",
    );
  });

  it("carries toolUsage rows through the dashboard for zai verbatim (#191/Q2)", async () => {
    // The dashboard is a pass-through: the Adapter's normalized categories
    // (including the additive toolUsage field) reach `data` untouched. This
    // pins the surfacing contract at the dashboard boundary — the renderer
    // (tty.ts) and the JSON envelope both read this same object.
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zai],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
    });
    const row = dashboard.providers[0];
    assert.strictEqual(row.status, "ok");
    assert.deepStrictEqual(row.categories[0].toolUsage, [
      { tool: "search-prime", usage: 700 },
      { tool: "web-reader", usage: 250 },
    ]);
  });

  it("keyless Jina is excluded by the quota-capability filter instead of yielding a ConfigurationError row (#49)", async () => {
    const zai = makeQuotaDescriptor("zai", { result: ZAI_SUCCESS });
    const dashboard = await buildQuotaDashboard({
      allProviders: true,
      effectiveProvider: "zai",
      descriptors: [zai, createJinaDescriptor()],
      env: { Z_AI_API_KEY: "k" },
      sleep,
      random,
    });
    assert.strictEqual(
      dashboard.providers.filter((p) => p.provider === "jina").length,
      0,
      "keyless Jina must not be probed for quota",
    );
  });
});

describe("quota dashboard — no raw provider field leaks", () => {
  it("real adapters produce dashboards free of raw Z.AI/MiniMax field names", async () => {
    const zaiRaw = await readFixture("providers", "zai", "quota.json");
    const zaiDescriptor = createZaiDescriptor({
      quotaFetch: makeFetchSequence([{ ok: true, json: { data: zaiRaw } }]).fn,
      ...noOpTimer(),
    });
    const dashboard = await buildQuotaDashboard({
      allProviders: false,
      effectiveProvider: "zai",
      descriptors: [zaiDescriptor],
      env: { Z_AI_API_KEY: ZAI_KEY },
      sleep,
      random,
    });
    const keys = new Set();
    collectKeys(dashboard, keys);
    for (const denied of [...ZAI_RAW_DENY, ...MINIMAX_RAW_DENY]) {
      assert.ok(!keys.has(denied), `raw field "${denied}" leaked into dashboard`);
    }
  });
});

// ===========================================================================
// 10. Brave quota normalization (T6) — optional `warnings` stays conformant
// ===========================================================================

const BRAVE_RAW_DENY = [
  "X-RateLimit-Policy",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
];

describe("Brave quota normalization", () => {
  it("normalizes the largest window into a conformant monthly category", () => {
    const normalized = normalizeBraveQuota({
      policy: "1;w=1, 15000;w=2592000",
      limit: "1, 15000",
      remaining: "0, 14523",
      reset: "1, 1419704",
    });
    assertQuotaSuccessConformance(normalized, BRAVE_RAW_DENY);
    assert.strictEqual(normalized.categories.length, 1);
    assert.strictEqual(normalized.categories[0].name, "monthly");
    assert.strictEqual(normalized.categories[0].current.remainingPercent, 96.8);
    assert.ok(normalized.warnings.includes(BRAVE_QUOTA_CAVEAT));
  });

  it("throws QUOTA_ERROR on malformed headers (never guesses)", () => {
    assert.throws(
      () => normalizeBraveQuota({ policy: null, limit: "1", remaining: "0", reset: "1" }),
      (err) => err instanceof ScoutlineError && err.code === "QUOTA_ERROR",
    );
  });
});

// ===========================================================================
// 11. Quota command — provider-neutral warnings → stderr (T6)
// ===========================================================================

describe("quota command — toolUsage reaches the envelope verbatim (#191/Q2)", () => {
  it("carries toolUsage on the result data (the json/pretty payload)", async () => {
    // `pretty` mode is JSON-indent-2 of this same `data` object and `json`
    // is JSON of it — so pinning the data object pins both envelope
    // shapes. The field must arrive byte-for-byte as the Adapter emitted
    // it: the command is presentation-only and never rewrites a category.
    const category = {
      name: "requests",
      unit: "requests",
      current: { remainingPercent: 25 },
      toolUsage: [
        { tool: "search-prime", usage: 700 },
        { tool: "web-reader", usage: 250 },
      ],
    };
    const result = await quota({
      buildDashboard: async () => ({
        schemaVersion: 1,
        effectiveProvider: "zai",
        providers: [{ provider: "zai", status: "ok", categories: [category] }],
      }),
    });
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(result.data.providers[0].categories[0], category);
    assert.ok(
      JSON.stringify(result.data).includes('"toolUsage":[{"tool":"search-prime","usage":700}'),
      "json envelope carries toolUsage verbatim",
    );
  });

  it("omits toolUsage from the envelope when the Adapter omitted it (no fabricated [])", async () => {
    const result = await quota({
      buildDashboard: async () => ({
        schemaVersion: 1,
        effectiveProvider: "minimax",
        providers: [
          {
            provider: "minimax",
            status: "ok",
            categories: [{ name: "abab6.5s", unit: "requests", current: { remainingPercent: 70 } }],
          },
        ],
      }),
    });
    assert.ok(!JSON.stringify(result.data).includes("toolUsage"));
  });
});

describe("quota command — warnings rendered to stderr", () => {
  it("writes each warning from a successful entry to writeStderr (generic, no provider branch)", async () => {
    const stderr = [];
    const result = await quota({
      buildDashboard: async () => ({
        schemaVersion: 1,
        effectiveProvider: "brave",
        providers: [
          {
            provider: "brave",
            status: "ok",
            categories: [
              { name: "monthly", unit: "requests", current: { remainingPercent: 96.8 } },
            ],
            warnings: [BRAVE_QUOTA_CAVEAT],
          },
        ],
      }),
      writeStderr: (s) => {
        stderr.push(s);
      },
    });
    assert.strictEqual(result.exitCode, 0);
    const combined = stderr.join("");
    assert.ok(combined.includes(BRAVE_QUOTA_CAVEAT), "caveat text reaches stderr");
    assert.ok(/brave/i.test(combined), "provider name rendered generically");
  });

  it("redacts configured secret values embedded in warnings before writing to stderr", async () => {
    // `warnings` is provider-authored; a future Provider could put
    // value-derived text there. The command must run each warning through
    // redaction so a credential value never reaches stderr.
    const SECRET = "leak-marker-secret-value-XYZ";
    const stderr = [];
    await quota({
      buildDashboard: async () => ({
        schemaVersion: 1,
        effectiveProvider: "zai",
        providers: [
          {
            provider: "zai",
            status: "ok",
            categories: [{ name: "requests", unit: "requests", current: { remainingPercent: 50 } }],
            warnings: [`plan note references ${SECRET} inline`],
          },
        ],
      }),
      writeStderr: (s) => {
        stderr.push(s);
      },
      secrets: [SECRET],
    });
    const combined = stderr.join("");
    assert.ok(!combined.includes(SECRET), `stderr must not contain the secret: ${combined}`);
    assert.ok(combined.includes("[REDACTED]"), `secret must be redacted: ${combined}`);
  });

  it("does NOT call writeStderr when no successful entry carries warnings", async () => {
    let calls = 0;
    await quota({
      buildDashboard: async () => ({
        schemaVersion: 1,
        effectiveProvider: "zai",
        providers: [
          {
            provider: "zai",
            status: "ok",
            categories: [{ name: "requests", unit: "requests", current: { remainingPercent: 25 } }],
          },
        ],
      }),
      writeStderr: () => {
        calls += 1;
      },
    });
    assert.strictEqual(calls, 0, "no stderr write when warnings absent");
  });

  it("writeStderr is optional — command still returns the dashboard without it", async () => {
    const result = await quota({
      buildDashboard: async () => ({
        schemaVersion: 1,
        effectiveProvider: "brave",
        providers: [
          {
            provider: "brave",
            status: "ok",
            categories: [{ name: "monthly", unit: "requests", current: { remainingPercent: 96 } }],
            warnings: [BRAVE_QUOTA_CAVEAT],
          },
        ],
      }),
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.data.providers.length, 1);
  });

  it("keeps exit code 1 on failure even when a co-listed provider has warnings", async () => {
    const stderr = [];
    const result = await quota({
      buildDashboard: async () => ({
        schemaVersion: 1,
        effectiveProvider: "zai",
        providers: [
          {
            provider: "brave",
            status: "ok",
            categories: [{ name: "monthly", unit: "requests", current: { remainingPercent: 96 } }],
            warnings: [BRAVE_QUOTA_CAVEAT],
          },
          { provider: "zai", status: "error", error: { code: "AUTH_ERROR", message: "nope" } },
        ],
      }),
      writeStderr: (s) => {
        stderr.push(s);
      },
    });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(stderr.join("").includes(BRAVE_QUOTA_CAVEAT), "caveat still emitted");
  });
});

// ===========================================================================
// 10. Quota default mode through main() — multi-Provider is the default;
// an explicit --provider pin (or SCOUTLINE_PROVIDER) selects single mode.
// ===========================================================================

import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { main } from "../dist/index.js";

function makeMainAdapter() {
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
  return { adapter, stdout, stderr };
}

function makeQuotaProviderDescriptor(id, { result, configured = true }) {
  let invokes = 0;
  return {
    id,
    isConfigured: () => configured,
    capabilities: () => new Set(["quota"]),
    create: () => ({
      id,
      quota: {
        async invoke() {
          invokes += 1;
          return result;
        },
      },
    }),
    invokeCount: () => invokes,
  };
}

describe("quota dispatch through main() — multi-Provider default", () => {
  it("plain `quota` queries every configured Provider (the default)", async () => {
    const zai = makeQuotaProviderDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaProviderDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const { adapter, stdout } = makeMainAdapter();
    // #73: hermetic config
    const code = await main(["quota"], hermeticMainDeps({
      invocation: adapter,
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      providerDescriptors: [zai, minimax],
    }));
    assert.strictEqual(code, 0);
    const dashboard = JSON.parse(stdout.join(""));
    assert.deepStrictEqual(
      dashboard.providers.map((p) => p.provider),
      ["zai", "minimax"],
      "default shows every configured Provider",
    );
    assert.strictEqual(zai.invokeCount(), 1);
    assert.strictEqual(minimax.invokeCount(), 1);
  });

  it("--provider <id> pins single-Provider mode", async () => {
    const zai = makeQuotaProviderDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaProviderDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const { adapter, stdout } = makeMainAdapter();
    const code = await main(["--provider", "zai", "quota"], hermeticMainDeps({
      invocation: adapter,
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      providerDescriptors: [zai, minimax],
    }));
    assert.strictEqual(code, 0);
    const dashboard = JSON.parse(stdout.join(""));
    assert.deepStrictEqual(
      dashboard.providers.map((p) => p.provider),
      ["zai"],
    );
    assert.strictEqual(minimax.invokeCount(), 0, "pinned-out Provider never invoked");
  });

  it("SCOUTLINE_PROVIDER env pins single-Provider mode", async () => {
    const zai = makeQuotaProviderDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaProviderDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const { adapter, stdout } = makeMainAdapter();
    const code = await main(["quota"], hermeticMainDeps({
      invocation: adapter,
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k", SCOUTLINE_PROVIDER: "minimax" },
      providerDescriptors: [zai, minimax],
    }));
    assert.strictEqual(code, 0);
    const dashboard = JSON.parse(stdout.join(""));
    assert.deepStrictEqual(
      dashboard.providers.map((p) => p.provider),
      ["minimax"],
    );
    assert.strictEqual(zai.invokeCount(), 0);
  });

  it("--all-providers forces multi-Provider even under a --provider pin", async () => {
    const zai = makeQuotaProviderDescriptor("zai", { result: ZAI_SUCCESS });
    const minimax = makeQuotaProviderDescriptor("minimax", { result: MINIMAX_SUCCESS });
    const { adapter, stdout } = makeMainAdapter();
    const code = await main(["--provider", "zai", "quota", "--all-providers"], hermeticMainDeps({
      invocation: adapter,
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      providerDescriptors: [zai, minimax],
    }));
    assert.strictEqual(code, 0);
    const dashboard = JSON.parse(stdout.join(""));
    assert.deepStrictEqual(
      dashboard.providers.map((p) => p.provider),
      ["zai", "minimax"],
      "--all-providers overrides the pin",
    );
  });
});
