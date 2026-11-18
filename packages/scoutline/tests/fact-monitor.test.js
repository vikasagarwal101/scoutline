/**
 * Fact monitoring first slice — offline compiled tests (v3 seed 03).
 *
 * Covers the three FIRST-SLICE.json acceptance cases plus the review
 * repair controls: authoritative-commit durability model (orphan tick
 * records, corrupt/redirected state refusal, load parity), true command
 * contention, malformed revised definitions, cancellation (engine,
 * pre-publication, lock-acquire), definition-identity canonicalization
 * and bounded definition IO. Two seams:
 *   - state machine: prepare/commit with synthetic engine outcomes
 *     (deterministic, no engine in the loop);
 *   - complete flow: runFactMonitorTick / monitorFactMain over the real
 *     runLeanInvestigation with injected fixture deps (no network).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const {
  prepareFactMonitorTick,
  commitFactMonitorTick,
  runFactMonitorTick,
  loadFactMonitorState,
  factMonitorDefinitionDigest,
  FactMonitorCancelledError,
} = await import(`${root}/dist/lib/fact-monitor.js`);
const { monitorFactMain } = await import(`${root}/dist/commands/monitor-fact.js`);
const { LockTimeoutError } = await import(`${root}/dist/lib/async-file-lock.js`);

async function mkTmp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `scoutline-fact-monitor-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  return dir;
}

// First-slice fixture contract (FIRST-SLICE.json engineContract).
const definition = () => ({
  schemaVersion: 1,
  question: "Monitor CSV export support for the specified release.",
  scope: { entity: "ExampleApp", release: "2.4.0", edition: "Community", platform: "Linux" },
  requirements: {
    csv: {
      question: "Does ExampleApp Community 2.4.0 for Linux explicitly support CSV export?",
      schema: { enum: ["supported", "refuted", "disputed"] },
      required: true,
    },
  },
});

const T = (n) => new Date(`2026-11-0${n}T09:00:00.000Z`);
const MONITOR = "csv-monitor";

// --- synthetic engine outcomes (deterministic state-machine seam) --------

const row = (status, extra = {}) => ({
  status,
  required: true,
  evidenceIds: ["ev-a"],
  judgmentCount: 1,
  inconsistentJudgments: 0,
  ...extra,
});

const leanResult = (data, status = "partial") => ({
  schemaVersion: 1,
  status,
  assessment: "semantic",
  question: "q",
  plan: { queries: [] },
  data,
  requirements: Object.fromEntries(
    Object.entries(data).map(([id, value]) => [id, row("satisfied", { value })]),
  ),
  evidence: [],
  acquisitionLog: [],
  usage: { searches: 0, readAttempts: 0, readsRetained: 0, judgeCalls: 0, extractorCalls: 0, extractorCacheHits: 0, candidateJudgeCalls: 0 },
  coverageNotes: [],
});

const satisfied = (value, evidenceIds = ["ev-a"]) => ({
  kind: "result",
  result: {
    ...leanResult({ csv: value }),
    requirements: { csv: row("satisfied", { value, evidenceIds }) },
    // Evidence records the ids resolve to (load validates this).
    evidence: evidenceIds.map((id, i) => ({
      evidenceId: id,
      url: `https://fixture.invalid/${i}`,
      title: `ev-${i}`,
      content: "fixture evidence",
      byteLength: 16,
      origins: [`query-${i}`],
    })),
  },
});
const engineError = (reason) => ({ kind: "error", reason });

async function commit(dir, def, outcome, day, monitorId = MONITOR) {
  const prepared = await prepareFactMonitorTick(dir, monitorId, def, { now: T(day) });
  return commitFactMonitorTick(dir, prepared, outcome, { now: T(day) });
}

// --- Case 1: baseline and unchanged (through the real engine + command) ---

// Engine fixture deps: content-driven judge, per-tick mutable source mode.
function engineFixture(initialMode) {
  const sources = {
    supported: "ExampleApp Community 2.4.0 for Linux supports CSV export.",
    formatted: "# ExampleApp Community (Linux)\n\nRelease 2.4.0 **supports CSV export** in the Community edition.",
    refuted: "ExampleApp Community 2.4.0 for Linux does not support CSV export.",
  };
  const state = { mode: initialMode };
  const nowValues = [];
  const deps = {
    now: () => {
      const value = nowValues.length + 1;
      nowValues.push(value);
      return value;
    },
    search: async () => {
      if (state.mode === "unavailable") throw new Error("fixture provider unavailable");
      return [{ url: `https://fixture.invalid/${state.mode}`, title: state.mode }];
    },
    read: async (url) => sources[url.split("/").at(-1)],
    judge: async (input) => ({
      documents: input.documents.map((d) => ({
        evidenceId: d.evidenceId,
        relevant: true,
        supportsClaim: d.content.includes("supports CSV export"),
        refutesClaim: d.content.includes("does not support CSV export"),
      })),
    }),
  };
  return { deps, state, nowValues };
}

test("case baseline-and-unchanged: first tick establishes, formatting change stays unchanged", async (t) => {
  const dir = await mkTmp(t);
  const { deps, state, nowValues } = engineFixture("supported");

  // Tick 1 through the command entry point (complete first-slice flow).
  const defFile = path.join(dir, "definition.json");
  await fs.writeFile(defFile, `${JSON.stringify(definition())}\n`);
  const first = await monitorFactMain(
    ["tick", "--definition", defFile, "--monitor-id", MONITOR, "--state-root", dir],
    { ...deps, readStdin: async () => "" },
    { now: T(1), stateRoot: dir },
  );
  assert.equal(first.code, 0);
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.committed, true);
  assert.equal(firstReport.engine.status, "complete");
  assert.deepEqual(firstReport.fields.csv.events, ["baseline_established"]);
  assert.equal(firstReport.fields.csv.value, "supported");
  assert.equal(firstReport.fields.csv.lastAccepted.value, "supported");

  // Tick 2: same fact, different source formatting.
  state.mode = "formatted";
  const second = await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(2) });
  assert.equal(second.committed, true);
  assert.equal(second.fields.csv.value, "supported");
  assert.deepEqual(second.fields.csv.events, ["unchanged"], "no value_changed for formatting-only change");

  // The engine's own clock ran normally (not frozen at tick time).
  assert.ok(new Set(nowValues).size >= 2, "engine observed a running clock");

  // Last accepted state retains the ORIGINAL acceptance time, while the
  // latest attempt moves on (accepted vs latest are stored separately).
  const persisted = await loadFactMonitorState(dir, MONITOR);
  assert.equal(persisted.seq, 2);
  assert.equal(persisted.fields.csv.accepted.value, "supported");
  assert.equal(persisted.fields.csv.accepted.acceptedAt, T(1).toISOString());
  assert.equal(persisted.fields.csv.latest.at, T(2).toISOString());
  assert.equal(persisted.fields.csv.latest.seq, 2);
});

// --- Case 2: unresolved and recovery --------------------------------------

test("case unresolved-and-recovery: unresolved once, recover, then change — all visible", async (t) => {
  const dir = await mkTmp(t);
  const { deps, state } = engineFixture("supported");

  const t1 = await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(1) });
  assert.deepEqual(t1.fields.csv.events, ["baseline_established"]);

  // Provider unavailable: the engine returns a partial run with the
  // requirement unresolved (failed acquisition does not throw); the tick
  // records the unresolved transition and preserves the baseline.
  state.mode = "unavailable";
  const t2 = await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(2) });
  assert.equal(t2.engine.status, "partial");
  assert.equal(t2.fields.csv.status, "unresolved");
  assert.ok(t2.fields.csv.reason.length > 0);
  assert.deepEqual(t2.fields.csv.events, ["became_unresolved"]);
  assert.equal(t2.fields.csv.value, undefined, "failed tick exposes no current value");
  assert.equal(t2.fields.csv.lastAccepted.value, "supported", "last accepted survives, clearly separated");

  // Still unavailable: no repeated transition, diagnostics retained.
  const t3 = await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(3) });
  assert.deepEqual(t3.fields.csv.events, ["unresolved_attempt"]);

  // Accepted again with the opposite value: recovered AND value_changed.
  state.mode = "refuted";
  const t4 = await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(4) });
  assert.equal(t4.engine.status, "complete");
  assert.deepEqual(t4.fields.csv.events, ["recovered", "value_changed"], "both facts visible");
  assert.equal(t4.fields.csv.value, "refuted");

  const persisted = await loadFactMonitorState(dir, MONITOR);
  assert.equal(persisted.fields.csv.accepted.value, "refuted");
  assert.equal(persisted.fields.csv.unresolvedSince, undefined);

  // The change event binds BOTH value/evidence sides to their ticks.
  const changeEvent = t4.events.find((e) => e.kind === "value_changed");
  assert.equal(changeEvent.oldValue, "supported");
  assert.equal(changeEvent.newValue, "refuted");
  assert.equal(changeEvent.oldTickId, t1.tickId, "old evidence references name their tick");
  assert.equal(changeEvent.oldSeq, t1.seq, "old evidence references name their record sequence");
  assert.ok(changeEvent.oldEvidenceIds.length > 0);
  assert.ok(changeEvent.newEvidenceIds.length > 0);
});

test("first-ever run unresolved reports attempts without inventing a lost baseline", async (t) => {
  const dir = await mkTmp(t);
  const report = await commit(dir, definition(), engineError("provider unavailable"), 1);
  assert.equal(report.committed, true);
  assert.deepEqual(report.fields.csv.events, ["unresolved_attempt"]);
  assert.equal(report.fields.csv.lastAccepted, undefined);
  const persisted = await loadFactMonitorState(dir, MONITOR);
  assert.equal(persisted.fields.csv.accepted, undefined);
});

// --- Case 3: overlap and redefinition --------------------------------------

test("deterministic overlap: late older commit cannot regress the newer baseline", async (t) => {
  const dir = await mkTmp(t);

  // Two ticks prepared against the same base sequence; the newer settles first.
  const latePrepared = await prepareFactMonitorTick(dir, MONITOR, definition(), { now: T(1) });
  const freshPrepared = await prepareFactMonitorTick(dir, MONITOR, definition(), { now: T(2) });
  assert.equal(latePrepared.basedOnSeq, 0);
  assert.equal(freshPrepared.basedOnSeq, 0);

  const fresh = await commitFactMonitorTick(dir, freshPrepared, satisfied("supported"), { now: T(2) });
  assert.equal(fresh.committed, true);
  assert.equal(fresh.seq, 1);

  const late = await commitFactMonitorTick(dir, latePrepared, satisfied("refuted"), { now: T(1) });
  assert.equal(late.committed, false);
  assert.equal(late.rejection, "late_commit");
  assert.equal(late.seq, 1);

  const persisted = await loadFactMonitorState(dir, MONITOR);
  assert.equal(persisted.fields.csv.accepted.value, "supported", "older tick did not regress the baseline");

  // The rejected tick wrote nothing: one tick record, current at seq 1.
  const tickFiles = (await fs.readdir(path.join(dir, MONITOR, "ticks"))).sort();
  assert.deepEqual(tickFiles, ["tick-1.json"]);
  const current = JSON.parse(await fs.readFile(path.join(dir, MONITOR, "current.json"), "utf8"));
  assert.equal(current.seq, 1);
});

test("true command contention: two concurrent invocations, exactly one commits", async (t) => {
  const dir = await mkTmp(t);
  const gate = Promise.withResolvers();
  let searches = 0;
  const { deps } = engineFixture("supported");
  const gatedDeps = {
    ...deps,
    search: async () => {
      searches += 1;
      return gate.promise;
    },
  };
  const defFile = path.join(dir, "definition.json");
  await fs.writeFile(defFile, `${JSON.stringify(definition())}\n`);
  const argv = ["tick", "--definition", defFile, "--monitor-id", MONITOR, "--state-root", dir];

  // Both invocations prepare and enter the engine BEFORE either commits
  // (both searches are gated), so both base themselves on seq 0.
  const runs = [
    monitorFactMain(argv, { ...gatedDeps, readStdin: async () => "" }, { now: T(1), stateRoot: dir }),
    monitorFactMain(argv, { ...gatedDeps, readStdin: async () => "" }, { now: T(2), stateRoot: dir }),
  ];
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (searches >= 2) {
        clearInterval(poll);
        resolve();
      }
    }, 5);
  });
  gate.resolve([{ url: "https://fixture.invalid/supported", title: "supported" }]);
  const [a, b] = await Promise.all(runs);

  const codes = [a.code, b.code].sort();
  assert.deepEqual(codes, [0, 2], "one committed, one rejected late");
  const winner = a.code === 0 ? a : b;
  const loser = a.code === 0 ? b : a;
  const winnerReport = JSON.parse(winner.stdout);
  const loserReport = JSON.parse(loser.stdout);
  assert.equal(winnerReport.committed, true);
  assert.deepEqual(winnerReport.fields.csv.events, ["baseline_established"]);
  assert.equal(loserReport.committed, false);
  assert.equal(loserReport.rejection, "late_commit");

  // No loser writes: the state reflects exactly the winner's commit.
  const persisted = await loadFactMonitorState(dir, MONITOR);
  assert.equal(persisted.seq, 1);
  assert.equal(persisted.fields.csv.accepted.value, "supported");
  const tickFiles = (await fs.readdir(path.join(dir, MONITOR, "ticks"))).sort();
  assert.deepEqual(tickFiles, ["tick-1.json"]);
});

test("redefinition: incompatible definition re-baselines without comparing values", async (t) => {
  const dir = await mkTmp(t);
  const original = definition();
  await commit(dir, original, satisfied("supported"), 1);

  const revised = definition();
  revised.requirements.csv.question = "Does ExampleApp Community 2.4.0 for Linux ship CSV import?";
  assert.notEqual(factMonitorDefinitionDigest(original), factMonitorDefinitionDigest(revised));

  // First accepted value under the revision differs from the old baseline;
  // this must be baseline_established, never value_changed.
  const report = await commit(dir, revised, satisfied("refuted"), 2);
  assert.equal(report.committed, true);
  const kinds = report.events.map((e) => e.kind);
  assert.ok(kinds.includes("redefined"));
  assert.ok(kinds.includes("baseline_established"));
  assert.ok(!kinds.includes("value_changed"), "no comparison across incompatible definitions");
  assert.equal(report.definitionDigest, factMonitorDefinitionDigest(revised));

  const persisted = await loadFactMonitorState(dir, MONITOR);
  assert.equal(persisted.definitionDigest, factMonitorDefinitionDigest(revised));
  assert.equal(persisted.fields.csv.accepted.value, "refuted");
});

test("malformed revised definition is refused before any state is touched", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  const before = await loadFactMonitorState(dir, MONITOR);

  const malformed = definition();
  malformed.requirements.csv.schema.enum = ["supported", "bogus"];
  const { deps } = engineFixture("supported");
  await assert.rejects(
    () => runFactMonitorTick(dir, MONITOR, malformed, deps, { now: T(2) }),
    /proof vocabulary/,
  );

  // The valid baseline is intact — no redefined event, no cleared fields.
  const after = await loadFactMonitorState(dir, MONITOR);
  assert.deepEqual(after, before);
});

test("identity: defaults and key order canonicalize; field plan order is preserved", async (t) => {
  const twoField = () => ({
    ...definition(),
    requirements: {
      csv: definition().requirements.csv,
      docs: {
        question: "Is ExampleApp Community 2.4.0 documented for Linux?",
        schema: { enum: ["supported", "refuted", "disputed"] },
      },
    },
  });
  const explicit = twoField();
  const defaulted = twoField();
  delete defaulted.requirements.csv.required; // compile default materializes true
  const keyReordered = twoField();
  keyReordered.scope = { platform: "Linux", edition: "Community", release: "2.4.0", entity: "ExampleApp" };
  assert.equal(factMonitorDefinitionDigest(explicit), factMonitorDefinitionDigest(defaulted));
  assert.equal(factMonitorDefinitionDigest(explicit), factMonitorDefinitionDigest(keyReordered), "object key order is not identity");

  // Field PLAN order is identity: the engine executes the plan in that
  // order, so a reordered field set is a different definition.
  const planReordered = twoField();
  planReordered.requirements = { docs: planReordered.requirements.docs, csv: planReordered.requirements.csv };
  assert.notEqual(factMonitorDefinitionDigest(explicit), factMonitorDefinitionDigest(planReordered));

  // Equivalent spelling is unchanged, not redefined.
  const dir = await mkTmp(t);
  await commit(dir, explicit, satisfied("supported"), 1);
  const report = await commit(dir, defaulted, satisfied("supported"), 2);
  assert.ok(!report.events.some((e) => e.kind === "redefined"));
  assert.deepEqual(report.fields.csv.events, ["unchanged"]);
});

test("optional requiredness is preserved in reports (not relabeled required)", async (t) => {
  const dir = await mkTmp(t);
  const def = definition();
  def.requirements.docs = {
    question: "Is ExampleApp Community 2.4.0 documented for Linux?",
    schema: { enum: ["supported", "refuted", "disputed"] },
    required: false,
  };
  const report = await commit(dir, def, engineError("provider unavailable"), 1);
  assert.equal(report.fields.csv.required, true, "default required stays required");
  assert.equal(report.fields.docs.required, false, "declared optional stays optional");
  assert.deepEqual(report.fields.docs.events, ["unresolved_attempt"]);
});

// --- Authoritative-commit durability model ---------------------------------

test("load parity: current.json equals the last tick record's state after", async (t) => {
  const dir = await mkTmp(t);
  const first = await commit(dir, definition(), satisfied("supported"), 1);
  const second = await commit(dir, definition(), satisfied("refuted"), 2);

  const record = JSON.parse(await fs.readFile(second.paths.tickRecord, "utf8"));
  const loaded = await loadFactMonitorState(dir, MONITOR);
  assert.deepEqual(loaded, record.stateAfter, "hot-path state equals the committed record exactly");
  const loadedAgain = await loadFactMonitorState(dir, MONITOR);
  assert.deepEqual(loadedAgain, loaded);

  // Both tick records persist losslessly with their evidence outcomes.
  for (const report of [first, second]) {
    const persisted = JSON.parse(await fs.readFile(report.paths.tickRecord, "utf8"));
    assert.equal(persisted.tickId, report.tickId);
    assert.equal(persisted.engine.kind, "result");
    assert.equal(persisted.stateAfter.seq, report.seq);
  }
});

test("orphan tick record from a crash before the commit point is replaced, not trusted", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);

  // Simulate the crash window: a torn tick record at the next seq exists,
  // but current.json never advanced (the commit point never fired).
  const ticks = path.join(dir, MONITOR, "ticks");
  await fs.writeFile(path.join(ticks, "tick-2.json"), "{torn");
  const before = await loadFactMonitorState(dir, MONITOR);
  assert.equal(before.seq, 1, "orphan is not part of the state");

  const report = await commit(dir, definition(), satisfied("refuted"), 2);
  assert.equal(report.committed, true);
  const persisted = await loadFactMonitorState(dir, MONITOR);
  assert.equal(persisted.seq, 2);
  assert.equal(persisted.fields.csv.accepted.value, "refuted");
  const replaced = JSON.parse(await fs.readFile(path.join(ticks, "tick-2.json"), "utf8"));
  assert.equal(replaced.tickId, report.tickId, "orphan atomically replaced");
});

test("corrupt or redirected current.json is refused, never silently used", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  const current = path.join(dir, MONITOR, "current.json");

  await fs.writeFile(current, '{"schemaVersion":1,"seq":'); // torn/corrupt
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /corrupt/);

  await fs.rm(current);
  await fs.symlink(path.join(dir, "elsewhere.json"), current); // redirected
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /not a regular file/);

  // Oversized state is refused by the bounded reader before parsing.
  await fs.rm(current);
  const record = JSON.parse(await fs.readFile(path.join(dir, MONITOR, "ticks", "tick-1.json"), "utf8"));
  const padded = { ...record.stateAfter, filler: "y".repeat(3 * 1024 * 1024) };
  await fs.writeFile(current, JSON.stringify(padded));
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /record ceiling/);
});

test("history loss (missing pointer with surviving records) fails closed", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  await commit(dir, definition(), satisfied("refuted"), 2);
  await fs.rm(path.join(dir, MONITOR, "current.json"));
  await assert.rejects(
    () => loadFactMonitorState(dir, MONITOR),
    /actual orphan|manual inspection/,
    "never guessed as a fresh monitor, never overwritten",
  );
  // A genuinely fresh monitor dir (no records at all) still loads empty.
  const fresh = await loadFactMonitorState(dir, "other-monitor");
  assert.equal(fresh.seq, 0);
});

test("referenced record disagreement is corruption, not usable state", async (t) => {
  const dir = await mkTmp(t);
  const first = await commit(dir, definition(), satisfied("supported"), 1);
  const goodRecord = await fs.readFile(first.paths.tickRecord, "utf8");

  // Torn referenced record — then restore it so the chain works again.
  await fs.writeFile(first.paths.tickRecord, '{"tickId":"torn');
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /corrupt/);
  await fs.writeFile(first.paths.tickRecord, goodRecord);
  assert.equal((await loadFactMonitorState(dir, MONITOR)).seq, 1, "restored chain loads");

  // Structurally valid but DISAGREEING record (imposter tickId).
  const second = await commit(dir, definition(), satisfied("supported"), 2);
  const record = JSON.parse(await fs.readFile(second.paths.tickRecord, "utf8"));
  record.tickId = "imposter-tick";
  await fs.writeFile(second.paths.tickRecord, JSON.stringify(record));
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /disagrees/);

  // Matching identity but stateAfter mismatch is also refused.
  record.tickId = second.tickId;
  record.stateAfter.seq = 99;
  await fs.writeFile(second.paths.tickRecord, JSON.stringify(record));
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /does not match/);
});

test("a symlinked monitor directory is refused for reads and commits", async (t) => {
  const real = await mkTmp(t);
  const dir = await mkTmp(t);
  await commit(real, definition(), satisfied("supported"), 1);
  await fs.symlink(path.join(real, MONITOR), path.join(dir, MONITOR));
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /not a regular directory/);
  // Prepare itself loads state, so the redirect refusal fires there too —
  // the whole tick pipeline fails closed before any write.
  await assert.rejects(
    async () => {
      const prepared = await prepareFactMonitorTick(dir, MONITOR, definition(), { now: T(2) });
      await commitFactMonitorTick(dir, prepared, satisfied("refuted"), { now: T(2) });
    },
    /not a regular directory/,
  );
});

// --- Cancellation -----------------------------------------------------------

test("cancelling during the engine run publishes nothing", async (t) => {
  const dir = await mkTmp(t);
  const controller = new AbortController();
  let started = 0;
  const { deps } = engineFixture("supported");
  const gatedDeps = {
    ...deps,
    search: (query, options) =>
      new Promise((_, reject) => {
        started += 1;
        const onAbort = () => reject(new Error("dispatch aborted"));
        if (options?.signal?.aborted) {
          onAbort();
          return;
        }
        options?.signal?.addEventListener("abort", onAbort);
        setTimeout(onAbort, 2000); // test-safety fallback: never hang the suite
      }),
  };
  const pending = runFactMonitorTick(dir, MONITOR, definition(), gatedDeps, {
    now: T(1),
    signal: controller.signal,
  });
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (started >= 1) {
        clearInterval(poll);
        resolve();
      }
    }, 5);
  });
  controller.abort();
  await assert.rejects(() => pending, FactMonitorCancelledError);
  // Nothing was published: no state, no tick records.
  const state = await loadFactMonitorState(dir, MONITOR);
  assert.equal(state.seq, 0);
  await assert.rejects(() => fs.readdir(path.join(dir, MONITOR, "ticks")));
});

test("cancellation before publication is refused coherently (commit seam)", async (t) => {
  const dir = await mkTmp(t);
  const prepared = await prepareFactMonitorTick(dir, MONITOR, definition(), { now: T(1) });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => commitFactMonitorTick(dir, prepared, satisfied("supported"), { now: T(1), signal: controller.signal }),
    FactMonitorCancelledError,
  );
  const state = await loadFactMonitorState(dir, MONITOR);
  assert.equal(state.seq, 0, "cancelled tick wrote nothing");
});

test("aborting during the lock wait rejects promptly as cancellation", async (t) => {
  const dir = await mkTmp(t);
  const prepared = await prepareFactMonitorTick(dir, MONITOR, definition(), { now: T(1) });
  const controller = new AbortController();

  // Hold the per-monitor tick lock until released...
  const { withAsyncFileLock } = await import(`${root}/dist/lib/async-file-lock.js`);
  const release = Promise.withResolvers();
  const held = withAsyncFileLock(
    path.join(dir, MONITOR),
    "fact-monitor-" + MONITOR,
    () => release.promise,
    { timeoutMs: 5000, staleMs: 600000, timeoutLabel: "test holder" },
  );
  held.catch(() => {});

  try {
    // The commit enters the lock wait (5s deadline), then the signal fires.
    const pending = commitFactMonitorTick(dir, prepared, satisfied("supported"), {
      now: T(1),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const startedAt = Date.now();
    await assert.rejects(() => pending, FactMonitorCancelledError);
    assert.ok(Date.now() - startedAt < 2000, "rejected promptly, not at the 5s lock deadline");
    const state = await loadFactMonitorState(dir, MONITOR);
    assert.equal(state.seq, 0, "cancelled commit wrote nothing");
  } finally {
    // Always release the holder: its mtime-refresh timer would otherwise
    // keep the process alive after an assertion failure.
    release.resolve();
  }
  await held;
});

test("cancelled command exits 130 without publishing", async (t) => {
  const dir = await mkTmp(t);
  const controller = new AbortController();
  const { deps } = engineFixture("supported");
  const pending = monitorFactMain(
    ["tick", "--definition", "-", "--monitor-id", MONITOR, "--state-root", dir],
    { ...deps, readStdin: async () => JSON.stringify(definition()) },
    { now: T(1), stateRoot: dir, signal: controller.signal },
  );
  controller.abort();
  const result = await pending;
  assert.equal(result.code, 130);
  assert.equal(JSON.parse(result.stdout).cancelled, true);
  const state = await loadFactMonitorState(dir, MONITOR);
  assert.equal(state.seq, 0);
});

// --- Bounds -----------------------------------------------------------------

test("oversized definition input is rejected at the IO ceiling", async (t) => {
  const dir = await mkTmp(t);
  const big = definition();
  big.question = "x".repeat(1024 * 1024 + 4096);
  const defFile = path.join(dir, "big.json");
  await fs.writeFile(defFile, JSON.stringify(big));
  const { deps } = engineFixture("supported");
  await assert.rejects(
    () =>
      monitorFactMain(
        ["tick", "--definition", defFile, "--monitor-id", MONITOR, "--state-root", dir],
        { ...deps, readStdin: async () => "" },
        { now: T(1), stateRoot: dir },
      ),
    /ceiling/,
  );
});

test("a symlinked definition file is refused (no-follow read)", async (t) => {
  const dir = await mkTmp(t);
  const real = path.join(dir, "real.json");
  await fs.writeFile(real, JSON.stringify(definition()));
  const link = path.join(dir, "link.json");
  await fs.symlink(real, link);
  const { deps } = engineFixture("supported");
  await assert.rejects(
    () =>
      monitorFactMain(
        ["tick", "--definition", link, "--monitor-id", MONITOR, "--state-root", dir],
        { ...deps, readStdin: async () => "" },
        { now: T(1), stateRoot: dir },
      ),
    /not a regular file/,
  );
});

// --- guards -----------------------------------------------------------------

test("invalid monitor ids are rejected before any write", async (t) => {
  const dir = await mkTmp(t);
  await assert.rejects(
    () => runFactMonitorTick(dir, "../escape", definition(), engineFixture("supported").deps, { now: T(1) }),
    /monitor id/,
  );
});

// --- fix3 controls: ownership, seq-0, baseline refs, signals, publication ---

test("a symlinked ticks directory is refused for reads and commits", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  const ticks = path.join(dir, MONITOR, "ticks");
  const elsewhere = path.join(dir, "elsewhere");
  await fs.mkdir(elsewhere);
  await fs.rm(ticks, { recursive: true });
  await fs.symlink(elsewhere, ticks);
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /not a regular directory/);
  await assert.rejects(
    () => commit(dir, definition(), satisfied("refuted"), 2),
    /not a regular directory/,
  );
});

test("a persisted sequence-zero state is refused, never treated as fresh", async (t) => {
  const dir = await mkTmp(t);
  const monitorPath = path.join(dir, MONITOR);
  await fs.mkdir(path.join(monitorPath, "ticks"), { recursive: true });
  await fs.writeFile(path.join(monitorPath, "ticks", "tick-1.json"), "{}");
  await fs.writeFile(
    path.join(monitorPath, "current.json"),
    `${JSON.stringify({ schemaVersion: 1, monitorId: MONITOR, definitionDigest: "", seq: 0, fields: {} })}\n`,
  );
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /sequence 0/);
});

test("accepted-baseline records are validated exactly (old seq cited after unchanged seq)", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  const second = await commit(dir, definition(), satisfied("supported"), 2); // unchanged: baseline stays at seq 1
  const state = await loadFactMonitorState(dir, MONITOR);
  assert.equal(state.fields.csv.accepted.acceptedSeq, 1, "causal setup: seq-2 unchanged cites seq-1 baseline");
  const baselineRecord = path.join(dir, MONITOR, "ticks", "tick-1.json");
  const good = await fs.readFile(baselineRecord, "utf8");

  // Corrupt baseline record while the LATEST record stays intact.
  await fs.writeFile(baselineRecord, '{"seq":1');
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /corrupt/);

  // Deleted baseline record.
  await fs.rm(baselineRecord);
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /absent/);

  // Imposter tickId in an otherwise valid baseline record.
  const forged = JSON.parse(good);
  forged.tickId = "imposter";
  await fs.writeFile(baselineRecord, JSON.stringify(forged));
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /disagrees/);

  // Restored: the chain loads again.
  await fs.writeFile(baselineRecord, good);
  assert.equal((await loadFactMonitorState(dir, MONITOR)).seq, second.seq);
});

test("both cancellation channels are honored (AbortSignal.any merge)", async (t) => {
  const dir = await mkTmp(t);
  const optionController = new AbortController();
  const depsController = new AbortController();
  let started = 0;
  const { deps } = engineFixture("supported");
  const gatedDeps = {
    ...deps,
    externalSignal: depsController.signal,
    search: (query, options) =>
      new Promise((_, reject) => {
        started += 1;
        const onAbort = () => reject(new Error("dispatch aborted"));
        if (options?.signal?.aborted) {
          onAbort();
          return;
        }
        options?.signal?.addEventListener("abort", onAbort);
        setTimeout(onAbort, 2000);
      }),
  };
  const pending = runFactMonitorTick(dir, MONITOR, definition(), gatedDeps, {
    now: T(1),
    signal: optionController.signal, // live, never aborted
  });
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (started >= 1) {
        clearInterval(poll);
        resolve();
      }
    }, 5);
  });
  depsController.abort(); // ONLY the deps channel fires
  await assert.rejects(() => pending, FactMonitorCancelledError);
  const state = await loadFactMonitorState(dir, MONITOR);
  assert.equal(state.seq, 0);
});

test("a blocked stdin adapter still exits 130 on cancellation (bounded)", async (t) => {
  const dir = await mkTmp(t);
  const controller = new AbortController();
  const { deps } = engineFixture("supported");
  const pending = monitorFactMain(
    ["tick", "--definition", "-", "--monitor-id", MONITOR, "--state-root", dir],
    { ...deps, readStdin: () => new Promise(() => {}) }, // never resolves
    { now: T(1), stateRoot: dir, signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const result = await pending; // must settle via the abort race, not hang
  assert.equal(result.code, 130);
  assert.equal(JSON.parse(result.stdout).cancelled, true);
});

test("an abort-rejecting stdin adapter maps to exit 130, not a generic failure", async (t) => {
  const dir = await mkTmp(t);
  const controller = new AbortController();
  const { deps } = engineFixture("supported");
  const pending = monitorFactMain(
    ["tick", "--definition", "-", "--monitor-id", MONITOR, "--state-root", dir],
    {
      ...deps,
      readStdin: (signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("stdin aborted")), { once: true });
        }),
    },
    { now: T(1), stateRoot: dir, signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const result = await pending;
  assert.equal(result.code, 130);
});

test("a publication failure before the commit point leaves the tick retry-safe", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  // Block the RECORD path (atomicReplaceFile's rename onto an existing
  // directory fails; its dir-mode repair cannot clear this) — a fault
  // strictly BEFORE the commit point.
  const blocked = path.join(dir, MONITOR, "ticks", "tick-2.json");
  await fs.mkdir(blocked);
  await assert.rejects(
    () => commit(dir, definition(), satisfied("refuted"), 2),
    (error) => {
      assert.notEqual(error?.name, "FactMonitorPublicationUncertainError");
      assert.notEqual(error?.name, "FactMonitorCancelledError");
      return true;
    },
  );
  const state = await loadFactMonitorState(dir, MONITOR);
  assert.equal(state.seq, 1, "definitely uncommitted — prior state intact, retry-safe");
  // And the retry actually succeeds once the fault clears.
  await fs.rm(blocked, { recursive: true });
  const retried = await commit(dir, definition(), satisfied("refuted"), 2);
  assert.equal(retried.committed, true);
  assert.equal(retried.durability, "confirmed");
});

test("deeply nested definitions are rejected before recursive materialization", async (t) => {
  const dir = await mkTmp(t);
  const deep = definition();
  let node = (deep.requirements.csv.criteria = []);
  for (let i = 0; i < 100; i += 1) {
    const next = [];
    node.push(next);
    node = next;
  }
  const { deps } = engineFixture("supported");
  await assert.rejects(
    () => runFactMonitorTick(dir, MONITOR, deep, deps, { now: T(1) }),
    /nesting ceiling/,
  );
});

test("a pre-existing root is required — never implicitly created", async (t) => {
  const base = await mkTmp(t);
  const missing = path.join(base, "no-such-root");
  await assert.rejects(() => loadFactMonitorState(missing, MONITOR), /root does not exist/);
  const { deps } = engineFixture("supported");
  await assert.rejects(
    () => runFactMonitorTick(missing, MONITOR, definition(), deps, { now: T(1) }),
    /root does not exist/,
  );
});

// --- fix4 controls: evidence resolution, lock-aware ambiguity, shapes ---

test("accepted evidence must resolve in the cited OLD record's engine artifact", async (t) => {
  const dir = await mkTmp(t);
  const { deps, state } = engineFixture("supported");
  await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(1) });
  state.mode = "formatted";
  await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(2) }); // unchanged → baseline cites seq 1
  const baselineRecord = path.join(dir, MONITOR, "ticks", "tick-1.json");
  const good = await fs.readFile(baselineRecord, "utf8");

  // Valid JSON, but the evidence PAYLOAD is removed while the ids remain.
  const stripped = JSON.parse(good);
  stripped.engine.result.evidence = [];
  await fs.writeFile(baselineRecord, JSON.stringify(stripped));
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /does not resolve/);

  // Evidence payload intact but the accepted row's ids disagree.
  const swapped = JSON.parse(good);
  swapped.engine.result.requirements.csv.evidenceIds = ["ev-imposter"];
  await fs.writeFile(baselineRecord, JSON.stringify(swapped));
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /engine row does not match/);

  await fs.writeFile(baselineRecord, good);
  assert.equal((await loadFactMonitorState(dir, MONITOR)).seq, 2);
});

test("accepted evidence must resolve in the TIP record after a change-at-tip", async (t) => {
  const dir = await mkTmp(t);
  const { deps, state } = engineFixture("supported");
  await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(1) });
  state.mode = "refuted";
  await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(2) }); // value_changed → baseline at tip
  const tip = await loadFactMonitorState(dir, MONITOR);
  assert.equal(tip.fields.csv.accepted.acceptedSeq, 2, "causal setup: tip carries the baseline");

  const tipRecord = path.join(dir, MONITOR, "ticks", "tick-2.json");
  const good = await fs.readFile(tipRecord, "utf8");
  const stripped = JSON.parse(good);
  const cited = stripped.engine.result.requirements.csv.evidenceIds;
  stripped.engine.result.evidence = stripped.engine.result.evidence.filter(
    (entry) => !cited.includes(entry.evidenceId),
  );
  await fs.writeFile(tipRecord, JSON.stringify(stripped));
  await assert.rejects(() => loadFactMonitorState(dir, MONITOR), /does not resolve/);
  await fs.writeFile(tipRecord, good);
  assert.equal((await loadFactMonitorState(dir, MONITOR)).seq, 2);
});

test("a live first publication is not misreported: ambiguity rechecks under the lock", async (t) => {
  const dir = await mkTmp(t);
  const first = await commit(dir, definition(), satisfied("supported"), 1);
  const current = path.join(dir, MONITOR, "current.json");
  const committed = await fs.readFile(current, "utf8");

  // Simulate the mid-publication window: record visible, pointer not yet.
  await fs.rm(current);
  const { withAsyncFileLock } = await import(`${root}/dist/lib/async-file-lock.js`);
  const release = Promise.withResolvers();
  const held = withAsyncFileLock(
    path.join(dir, MONITOR),
    "fact-monitor-" + MONITOR,
    () => release.promise,
    { timeoutMs: 5000, staleMs: 600000, timeoutLabel: "first-publication holder" },
  );
  held.catch(() => {});

  // The unlocked load sees the ambiguous window and rechecks under the
  // lock; the publication "completes" (pointer restored) before release.
  const pendingLoad = loadFactMonitorState(dir, MONITOR);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await fs.writeFile(current, committed);
  release.resolve();
  const loaded = await pendingLoad;
  assert.equal(loaded.seq, 1, "live first publication resolves, no false history-loss report");
  await held;
  void first;
});

test("a still-ambiguous orphan under the lock requires manual inspection", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  await fs.rm(path.join(dir, MONITOR, "current.json"));
  await assert.rejects(
    () => loadFactMonitorState(dir, MONITOR),
    /actual orphan.*manual inspection|actual orphan/,
  );
});

test("persisted states with exact-shape violations are refused", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  const current = path.join(dir, MONITOR, "current.json");
  const good = JSON.parse(await fs.readFile(current, "utf8"));

  const variant = async (mutate, pattern) => {
    const stateJson = JSON.parse(JSON.stringify(good));
    mutate(stateJson);
    await fs.writeFile(current, JSON.stringify(stateJson));
    await assert.rejects(() => loadFactMonitorState(dir, MONITOR), pattern);
  };

  await variant((s) => { s.extraKey = 1; }, /unknown key/);
  await variant((s) => { s.definitionDigest = ""; }, /non-empty definition digest/);
  await variant((s) => { s.fields.csv.latest.seq = 99; }, /out of range/);
  await variant((s) => { s.fields.csv.accepted.evidenceIds = [42]; }, /non-empty strings/);
  await variant((s) => { delete s.commit; }, /missing|commit/);

  await fs.writeFile(current, JSON.stringify(good));
  assert.equal((await loadFactMonitorState(dir, MONITOR)).seq, 1);
});

test("an oversized array of empty strings is rejected by the preflight walk", async (t) => {
  const dir = await mkTmp(t);
  const bloated = definition();
  bloated.requirements.csv.criteria = new Array(400_000).fill("");
  const { deps } = engineFixture("supported");
  await assert.rejects(
    () => runFactMonitorTick(dir, MONITOR, bloated, deps, { now: T(1) }),
    /byte ceiling/,
  );
});

test("blocked stdin responds to a deps-only abort at command entry", async (t) => {
  const dir = await mkTmp(t);
  const depsController = new AbortController();
  const { deps } = engineFixture("supported");
  const pending = monitorFactMain(
    ["tick", "--definition", "-", "--monitor-id", MONITOR, "--state-root", dir],
    { ...deps, externalSignal: depsController.signal, readStdin: () => new Promise(() => {}) },
    { now: T(1), stateRoot: dir }, // NO options.signal
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  depsController.abort(); // only the deps channel
  const result = await pending;
  assert.equal(result.code, 130);
  assert.equal(JSON.parse(result.stdout).cancelled, true);
});

// --- fix5 controls: engine value agreement, recheck cancellation, preflight --

test("cited baselines must match the engine's accepted VALUE (data and row)", async (t) => {
  const dir = await mkTmp(t);
  const { deps, state } = engineFixture("supported");
  await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(1) });
  state.mode = "formatted";
  await runFactMonitorTick(dir, MONITOR, definition(), deps, { now: T(2) }); // unchanged → baseline cites seq 1
  const baselineRecord = path.join(dir, MONITOR, "ticks", "tick-1.json");
  const good = await fs.readFile(baselineRecord, "utf8");

  const variant = async (mutate, pattern) => {
    const record = JSON.parse(good); // intact outer state; only the named part mutates
    mutate(record);
    await fs.writeFile(baselineRecord, JSON.stringify(record));
    await assert.rejects(() => loadFactMonitorState(dir, MONITOR), pattern);
  };

  await variant((r) => { r.engine.result.data.csv = "refuted"; }, /engine value does not match/);
  await variant((r) => { r.engine.result.requirements.csv.value = "refuted"; }, /engine value does not match/);
  await variant((r) => { r.schemaVersion = 2; }, /unsupported schemaVersion/);
  await variant(
    (r) => {
      const cited = r.engine.result.requirements.csv.evidenceIds[0];
      r.engine.result.evidence = r.engine.result.evidence.map((entry) =>
        entry.evidenceId === cited ? { evidenceId: cited } : entry,
      );
    },
    /not a usable evidence record/,
  );

  await fs.writeFile(baselineRecord, good);
  assert.equal((await loadFactMonitorState(dir, MONITOR)).seq, 2);
});

test("an aborted tick exits 130 promptly while waiting in the ambiguity recheck (real command)", async (t) => {
  const dir = await mkTmp(t);
  await commit(dir, definition(), satisfied("supported"), 1);
  await fs.rm(path.join(dir, MONITOR, "current.json")); // ambiguous first-publication window

  const { withAsyncFileLock } = await import(`${root}/dist/lib/async-file-lock.js`);
  const release = Promise.withResolvers();
  const held = withAsyncFileLock(
    path.join(dir, MONITOR),
    "fact-monitor-" + MONITOR,
    () => release.promise,
    { timeoutMs: 30000, staleMs: 600000, timeoutLabel: "recheck holder" },
  );
  held.catch(() => {});

  try {
    const controller = new AbortController();
    const { deps } = engineFixture("supported");
    const defFile = path.join(dir, "definition.json");
    await fs.writeFile(defFile, `${JSON.stringify(definition())}\n`);
    const pending = monitorFactMain(
      ["tick", "--definition", defFile, "--monitor-id", MONITOR, "--state-root", dir],
      { ...deps, readStdin: async () => "" },
      { now: T(2), stateRoot: dir, signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 50)); // inside the recheck's lock wait
    controller.abort();
    const startedAt = Date.now();
    const result = await pending;
    assert.equal(result.code, 130, "typed cancellation, not a generic failure");
    assert.ok(Date.now() - startedAt < 2000, "prompt exit, not the 30s lock deadline");
    assert.equal(JSON.parse(result.stdout).cancelled, true);
  } finally {
    release.resolve();
  }
  await held;
});

test("a huge sparse array trips the preflight before any worklist allocation", async (t) => {
  const dir = await mkTmp(t);
  const sparse = definition();
  sparse.requirements.csv.criteria = new Array(50_000_000); // length precharge must reject
  sparse.requirements.csv.criteria[0] = "";
  const { deps } = engineFixture("supported");
  await assert.rejects(
    () => runFactMonitorTick(dir, MONITOR, sparse, deps, { now: T(1) }),
    /byte ceiling/,
  );
});
