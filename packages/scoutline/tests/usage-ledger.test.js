/**
 * Usage ledger (usage-ledger plan — Ticket 1).
 *
 * Unit tests for the pure ledger core: schema-v1 types, UTC day
 * bucketing (mergeEventIntoLedger), retention pruning
 * (pruneExpiredDays), the fail-open reader (readUsageLedger — corrupt
 * / wrong-version / non-object-days yield an empty ledger plus a
 * warning, never a throw), and the config-root sibling path resolver
 * (resolveUsageLedgerPath). The fs-writing sink (Ticket 2,
 * createUsageLedgerSink) extends this file with lock/atomic-write
 * coverage.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  DEFAULT_USAGE_RETENTION_DAYS,
  USAGE_LEDGER_VERSION,
  emptyUsageLedger,
  mergeEventIntoLedger,
  pruneExpiredDays,
  readUsageLedger,
  resolveUsageLedgerPath,
  usageDayKey,
} from "../dist/lib/usage-ledger.js";
import { withTempDir } from "./helpers/temp-dir.js";

// Fixed reference instants (UTC). T0 = 2026-08-17T12:00:00.000Z.
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 17, 12, 0, 0);
const T0_DAY_KEY = "2026-08-17";
// Last millisecond of 2026-08-16 and first of 2026-08-17 (UTC boundary).
const LAST_MS_OF_AUG_16 = Date.UTC(2026, 7, 16, 23, 59, 59, 999);
const FIRST_MS_OF_AUG_17 = Date.UTC(2026, 7, 17, 0, 0, 0);

const ZERO_COUNTERS = {
  attempts: 0,
  firstTries: 0,
  exactUnits: 0,
  estimateUnits: 0,
  unknownCount: 0,
};

function makeEvent(overrides = {}) {
  return {
    provider: "zai",
    capabilityId: "search",
    amount: { kind: "estimate", value: 1 },
    attempt: 1,
    at: T0,
    ...overrides,
  };
}

/** UTC day key `days` before T0's day (negative → after). */
function dayKeyOffset(days) {
  return usageDayKey(T0 - days * DAY_MS);
}

function ledgerWithDays(days) {
  return { version: USAGE_LEDGER_VERSION, days };
}

// ---------------------------------------------------------------------------
// usageDayKey — UTC calendar-date bucketing
// ---------------------------------------------------------------------------

describe("usage-ledger: usageDayKey", () => {
  it("derives the UTC calendar date from a millisecond instant", () => {
    assert.strictEqual(usageDayKey(T0), T0_DAY_KEY);
  });

  it("separates 23:59:59.999Z from 00:00:00Z the next day (UTC boundary)", () => {
    assert.strictEqual(usageDayKey(LAST_MS_OF_AUG_16), "2026-08-16");
    assert.strictEqual(usageDayKey(FIRST_MS_OF_AUG_17), "2026-08-17");
  });
});

// ---------------------------------------------------------------------------
// mergeEventIntoLedger — pure ledger × event → ledger
// ---------------------------------------------------------------------------

describe("usage-ledger: mergeEventIntoLedger", () => {
  it("increments attempts on every event and firstTries only for attempt 1", () => {
    let ledger = emptyUsageLedger();
    ledger = mergeEventIntoLedger(ledger, makeEvent({ attempt: 1 }));
    ledger = mergeEventIntoLedger(ledger, makeEvent({ attempt: 2 }));
    assert.deepStrictEqual(ledger.days[T0_DAY_KEY].zai.search, {
      attempts: 2,
      firstTries: 1,
      exactUnits: 0,
      estimateUnits: 2,
      unknownCount: 0,
    });
  });

  it("increments exactUnits from an exact amount (reserved axis — no production emitter yet)", () => {
    const ledger = mergeEventIntoLedger(
      emptyUsageLedger(),
      makeEvent({ amount: { kind: "exact", value: 7 } }),
    );
    assert.deepStrictEqual(ledger.days[T0_DAY_KEY].zai.search, {
      ...ZERO_COUNTERS,
      attempts: 1,
      firstTries: 1,
      exactUnits: 7,
    });
  });

  it("increments estimateUnits from an estimate amount", () => {
    const ledger = mergeEventIntoLedger(
      emptyUsageLedger(),
      makeEvent({ amount: { kind: "estimate", value: 3 } }),
    );
    assert.strictEqual(ledger.days[T0_DAY_KEY].zai.search.estimateUnits, 3);
    assert.strictEqual(ledger.days[T0_DAY_KEY].zai.search.exactUnits, 0);
    assert.strictEqual(ledger.days[T0_DAY_KEY].zai.search.unknownCount, 0);
  });

  it("increments unknownCount from an unknown amount", () => {
    const ledger = mergeEventIntoLedger(
      emptyUsageLedger(),
      makeEvent({ amount: { kind: "unknown" }, capabilityId: "research" }),
    );
    assert.strictEqual(ledger.days[T0_DAY_KEY].zai.research.unknownCount, 1);
    assert.strictEqual(ledger.days[T0_DAY_KEY].zai.research.estimateUnits, 0);
  });

  it("keeps providers and capabilities in separate counter records (keys verbatim)", () => {
    let ledger = emptyUsageLedger();
    ledger = mergeEventIntoLedger(ledger, makeEvent({ provider: "zai", capabilityId: "search" }));
    ledger = mergeEventIntoLedger(ledger, makeEvent({ provider: "tavily", capabilityId: "search" }));
    ledger = mergeEventIntoLedger(ledger, makeEvent({ provider: "tavily", capabilityId: "reader" }));
    assert.deepStrictEqual(Object.keys(ledger.days[T0_DAY_KEY]).sort(), ["tavily", "zai"]);
    assert.deepStrictEqual(Object.keys(ledger.days[T0_DAY_KEY].tavily).sort(), ["reader", "search"]);
    assert.strictEqual(ledger.days[T0_DAY_KEY].zai.search.attempts, 1);
    assert.strictEqual(ledger.days[T0_DAY_KEY].tavily.search.attempts, 1);
    assert.strictEqual(ledger.days[T0_DAY_KEY].tavily.reader.attempts, 1);
  });

  it("buckets 23:59:59.999Z and 00:00:00Z into different UTC days (boundary from event.at)", () => {
    let ledger = emptyUsageLedger();
    ledger = mergeEventIntoLedger(ledger, makeEvent({ at: LAST_MS_OF_AUG_16 }));
    ledger = mergeEventIntoLedger(ledger, makeEvent({ at: FIRST_MS_OF_AUG_17 }));
    assert.deepStrictEqual(Object.keys(ledger.days).sort(), ["2026-08-16", "2026-08-17"]);
    assert.strictEqual(ledger.days["2026-08-16"].zai.search.attempts, 1);
    assert.strictEqual(ledger.days["2026-08-17"].zai.search.attempts, 1);
  });

  it("is pure — the input ledger is never mutated", () => {
    const original = emptyUsageLedger();
    const merged = mergeEventIntoLedger(original, makeEvent());
    assert.deepStrictEqual(original, emptyUsageLedger());
    assert.notStrictEqual(merged, original);
    assert.strictEqual(merged.days[T0_DAY_KEY].zai.search.attempts, 1);
  });

  it("day-roll triggers one prune pass: a first write to a new UTC day drops days outside the window", () => {
    // A 120-day history whose latest day is yesterday relative to T0.
    const days = {};
    for (let i = 1; i <= 120; i++) {
      days[dayKeyOffset(i)] = { zai: { search: { ...ZERO_COUNTERS, attempts: 1 } } };
    }
    const ledger = ledgerWithDays(days);
    // T0's day key is absent from the ledger → day-roll → prune to the
    // 90-day window in the same merge (DESIGN D5).
    const merged = mergeEventIntoLedger(ledger, makeEvent(), {
      retentionDays: DEFAULT_USAGE_RETENTION_DAYS,
    });
    const keys = Object.keys(merged.days).sort();
    assert.strictEqual(keys.length, DEFAULT_USAGE_RETENTION_DAYS);
    assert.ok(keys.includes(dayKeyOffset(89)), "oldest in-window day is kept");
    assert.ok(!keys.includes(dayKeyOffset(90)), "first out-of-window day is dropped");
    assert.ok(keys.includes(T0_DAY_KEY), "the rolled-in day is present");
    assert.strictEqual(merged.days[T0_DAY_KEY].zai.search.attempts, 1);
    assert.ok(merged.days[dayKeyOffset(1)], "yesterday's history survives");
  });

  it("same-day writes do not prune (one prune pass per day-roll only)", () => {
    // Today's key already present while an ancient key lingers (e.g.
    // written before retention existed): a same-day merge must keep it.
    const days = {
      [T0_DAY_KEY]: {},
      [dayKeyOffset(365)]: { zai: { search: { ...ZERO_COUNTERS, attempts: 1 } } },
    };
    const ledger = ledgerWithDays(days);
    const merged = mergeEventIntoLedger(ledger, makeEvent(), {
      retentionDays: DEFAULT_USAGE_RETENTION_DAYS,
    });
    assert.ok(merged.days[dayKeyOffset(365)], "same-day write must not prune");
    assert.strictEqual(merged.days[T0_DAY_KEY].zai.search.attempts, 1);
  });

  it("without retentionDays the merge never prunes", () => {
    const ledger = ledgerWithDays({
      [dayKeyOffset(400)]: { zai: { search: { ...ZERO_COUNTERS, attempts: 1 } } },
    });
    const merged = mergeEventIntoLedger(ledger, makeEvent());
    assert.ok(merged.days[dayKeyOffset(400)], "no retention option → no prune");
    assert.ok(merged.days[T0_DAY_KEY], "new day still recorded");
  });
});

// ---------------------------------------------------------------------------
// pruneExpiredDays — pure retention window
// ---------------------------------------------------------------------------

describe("usage-ledger: pruneExpiredDays", () => {
  it("keeps exactly the 90-day window (reference day inclusive, 89 back)", () => {
    const days = {};
    for (let i = 0; i <= 130; i++) days[dayKeyOffset(i)] = {};
    const pruned = pruneExpiredDays(
      ledgerWithDays(days),
      DEFAULT_USAGE_RETENTION_DAYS,
      T0_DAY_KEY,
    );
    const keys = Object.keys(pruned.days).sort();
    assert.strictEqual(keys.length, DEFAULT_USAGE_RETENTION_DAYS);
    assert.strictEqual(keys[0], dayKeyOffset(89), "oldest kept day is 89 before the reference");
    assert.strictEqual(keys[keys.length - 1], dayKeyOffset(0), "reference day is kept");
    assert.strictEqual(pruned.version, USAGE_LEDGER_VERSION);
  });

  it("drops a day exactly retentionDays older than the reference (boundary)", () => {
    const days = { [dayKeyOffset(89)]: {}, [dayKeyOffset(90)]: {} };
    const pruned = pruneExpiredDays(ledgerWithDays(days), DEFAULT_USAGE_RETENTION_DAYS, T0_DAY_KEY);
    assert.deepStrictEqual(Object.keys(pruned.days), [dayKeyOffset(89)]);
  });

  it("is pure — the input ledger is never mutated", () => {
    const days = { [dayKeyOffset(400)]: {}, [dayKeyOffset(1)]: {} };
    const ledger = ledgerWithDays(days);
    pruneExpiredDays(ledger, DEFAULT_USAGE_RETENTION_DAYS, T0_DAY_KEY);
    assert.deepStrictEqual(ledger, ledgerWithDays(days));
  });

  it("returns the ledger unchanged for a non-parsable reference day key", () => {
    const ledger = ledgerWithDays({ [T0_DAY_KEY]: {} });
    const pruned = pruneExpiredDays(ledger, DEFAULT_USAGE_RETENTION_DAYS, "not-a-date");
    assert.deepStrictEqual(pruned, ledger);
  });
});

// ---------------------------------------------------------------------------
// readUsageLedger — fail-open, never throws
// ---------------------------------------------------------------------------

describe("usage-ledger: readUsageLedger (fail-open)", () => {
  it("returns an empty ledger for a missing file (ENOENT) without warning", async () => {
    const warnings = [];
    const readFile = async () => {
      const error = new Error("ENOENT: no such file or directory");
      error.code = "ENOENT";
      throw error;
    };
    const ledger = await readUsageLedger("/tmp/nowhere/usage.json", {
      readFile,
      onWarning: (message) => warnings.push(message),
    });
    assert.deepStrictEqual(ledger, emptyUsageLedger());
    assert.strictEqual(warnings.length, 0);
  });

  it("corrupt JSON → empty ledger + warning", async () => {
    const warnings = [];
    const ledger = await readUsageLedger("usage.json", {
      readFile: async () => "{ this is not json",
      onWarning: (message) => warnings.push(message),
    });
    assert.deepStrictEqual(ledger, emptyUsageLedger());
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /not valid JSON/);
  });

  it("wrong version → empty ledger + warning", async () => {
    const warnings = [];
    const ledger = await readUsageLedger("usage.json", {
      readFile: async () => JSON.stringify({ version: 2, days: {} }),
      onWarning: (message) => warnings.push(message),
    });
    assert.deepStrictEqual(ledger, emptyUsageLedger());
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /version/);
  });

  it("non-object days → empty ledger + warning", async () => {
    const warnings = [];
    const ledger = await readUsageLedger("usage.json", {
      readFile: async () => JSON.stringify({ version: 1, days: ["2026-08-17"] }),
      onWarning: (message) => warnings.push(message),
    });
    assert.deepStrictEqual(ledger, emptyUsageLedger());
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /days/);
  });

  it("non-object JSON payload → empty ledger + warning", async () => {
    const warnings = [];
    const ledger = await readUsageLedger("usage.json", {
      readFile: async () => JSON.stringify([1, 2, 3]),
      onWarning: (message) => warnings.push(message),
    });
    assert.deepStrictEqual(ledger, emptyUsageLedger());
    assert.strictEqual(warnings.length, 1);
  });

  it("reader failure (non-ENOENT) → empty ledger + warning, never throws", async () => {
    const warnings = [];
    const readFile = async () => {
      const error = new Error("EACCES: permission denied");
      error.code = "EACCES";
      throw error;
    };
    const ledger = await readUsageLedger("usage.json", {
      readFile,
      onWarning: (message) => warnings.push(message),
    });
    assert.deepStrictEqual(ledger, emptyUsageLedger());
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /Unable to read/);
  });

  it("round-trips a well-formed ledger and defaults missing counter fields to 0", async () => {
    const contents = JSON.stringify({
      version: 1,
      days: {
        "2026-08-17": {
          zai: { search: { attempts: 3, firstTries: 2, estimateUnits: 3 } },
        },
      },
    });
    const ledger = await readUsageLedger("usage.json", {
      readFile: async () => contents,
      onWarning: () => {
        throw new Error("no warning expected for a well-formed ledger");
      },
    });
    assert.deepStrictEqual(ledger.days["2026-08-17"].zai.search, {
      attempts: 3,
      firstTries: 2,
      exactUnits: 0,
      estimateUnits: 3,
      unknownCount: 0,
    });
  });

  it("default reader reads the real filesystem; default onWarning stays silent on corrupt", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "usage.json");
      await fs.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          days: { "2026-08-17": { zai: { search: { attempts: 1, firstTries: 1, estimateUnits: 1 } } } },
        }),
      );
      // Bare call — the production `usage` command shape (DESIGN D8).
      const ledger = await readUsageLedger(filePath);
      assert.strictEqual(ledger.days["2026-08-17"].zai.search.attempts, 1);

      // Bare default onWarning is a no-op: a corrupt file must resolve
      // to an empty ledger without throwing (silent-on-corrupt).
      await fs.writeFile(filePath, "{ broken");
      const corrupt = await readUsageLedger(filePath);
      assert.deepStrictEqual(corrupt, emptyUsageLedger());
    });
  });
});

// ---------------------------------------------------------------------------
// resolveUsageLedgerPath — config-root sibling (pure)
// ---------------------------------------------------------------------------

describe("usage-ledger: resolveUsageLedgerPath", () => {
  it("resolves usage.json as a sibling of config.json/state.json in the given root", () => {
    assert.strictEqual(
      resolveUsageLedgerPath("/explicit/root"),
      path.join("/explicit/root", "usage.json"),
    );
  });

  it("defaults the root to the config root (SCOUTLINE_CONFIG_DIR aware)", () => {
    const prior = process.env.SCOUTLINE_CONFIG_DIR;
    process.env.SCOUTLINE_CONFIG_DIR = "/env/override";
    try {
      assert.strictEqual(resolveUsageLedgerPath(), path.join("/env/override", "usage.json"));
    } finally {
      if (prior === undefined) delete process.env.SCOUTLINE_CONFIG_DIR;
      else process.env.SCOUTLINE_CONFIG_DIR = prior;
    }
  });
});

// ---------------------------------------------------------------------------
// emptyUsageLedger — schema v1 empty state
// ---------------------------------------------------------------------------

describe("usage-ledger: emptyUsageLedger", () => {
  it("returns a schema-v1 ledger with no days", () => {
    assert.deepStrictEqual(emptyUsageLedger(), { version: USAGE_LEDGER_VERSION, days: {} });
  });
});
