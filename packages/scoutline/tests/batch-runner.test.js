import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { ValidationError } from "../dist/lib/errors.js";
import { formatErrorOutput } from "../dist/lib/output.js";
import { invokeCommand } from "../dist/command-invocation.js";
import { resolveFanoutPlan } from "../dist/commands/search.js";
import { assignBatchProviders } from "../dist/lib/batch-assign.js";

/**
 * Ticket 3 — batch runner core (`lib/batch-runner.ts`, DESIGN D5/D6/D8).
 *
 * Pins the AC invariants against fake deps: per-op capture adapters,
 * the `{...handlerDeps, provider, invocation}` spread seam, bounded
 * worker pool (default 4 / ceiling 8), manifest-order results, fail-fast
 * drain + "not run" backfills, exactly one summary stdout write, ops
 * forced to data mode, the pre-`invokeCommand` throw safety net, fan-out
 * suppression under `fanout=true` (single mode per op), and consumption
 * inheritance through the spread. Tests import dist/ per AGENTS.md
 * (build before test); `tests/search-fanout.test.js` itself is untouched
 * (its descriptor doubles pattern is reused here).
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/**
 * Fan-out test double pattern (from tests/search-fanout.test.js): a
 * search-capable descriptor whose adapter counts `invoke()` calls so
 * arm replication is observable.
 */
function searchDescriptor(id, results) {
  const invokes = [];
  return {
    descriptor: {
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
            invokes.push(request);
            return results.map((entry) => ({ ...entry }));
          },
        },
      }),
    },
    invokes,
  };
}

/** Global (process-level) invocation adapter double that counts writes. */
function globalInvocation() {
  const stdoutWrites = [];
  const stderrWrites = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (value) => stdoutWrites.push(value),
      writeStderr: (value) => stderrWrites.push(value),
      runQuietly: async (operation) => operation(),
      setExitCode: () => {},
    },
    stdoutWrites,
    stderrWrites,
  };
}

/**
 * Minimal handler-deps base. The runner only reads `secrets` directly;
 * every other field flows to the per-op handlers through the spread, so
 * tests override just what their fake handler asserts on.
 */
function baseHandlerDeps(overrides = {}) {
  return {
    env: {},
    secrets: [],
    providerDescriptors: [],
    fallbackEnabled: true,
    ...overrides,
  };
}

function manifest(...operations) {
  return { schemaVersion: 1, operations };
}

function searchOp(name, query, output) {
  return {
    name,
    command: "search",
    input: { query: query ?? `q ${name}` },
    ...(output !== undefined ? { output } : {}),
  };
}

async function load() {
  return await import("../dist/lib/batch-runner.js");
}

/** Run a manifest through the runner with real assignment (D4 → D5 zip). */
async function runBatchUnderTest(
  { descriptors = [searchDescriptor("zai", [{ title: "T", url: "https://e/p", summary: "s" }])],
    handler,
    handlerDeps = baseHandlerDeps({ providerDescriptors: descriptors.map((h) => h.descriptor) }),
    outputMode = "data",
    now,
    writeOutputFile,
    renameOutputFile,
    removeOutputFile,
    options = {} },
  ...operations
) {
  const m = await load();
  const mfst = manifest(...operations);
  const assignments = assignBatchProviders(mfst, { descriptors: descriptors.map((h) => h.descriptor), env: handlerDeps.env ?? {} });
  const global = globalInvocation();
  const result = await m.runBatch(
    mfst,
    assignments,
    {
      handlerDeps,
      handlers: { search: handler },
      invocation: global.adapter,
      outputMode,
      ...(now !== undefined ? { now } : {}),
      ...(writeOutputFile !== undefined ? { writeOutputFile } : {}),
      ...(renameOutputFile !== undefined ? { renameOutputFile } : {}),
      ...(removeOutputFile !== undefined ? { removeOutputFile } : {}),
    },
    options,
  );
  return { ...result, global };
}

// ---------------------------------------------------------------------------
// Bounded pool (D8)
// ---------------------------------------------------------------------------

describe("batch runner pool bounds", () => {
  it("keeps max-active at or below the requested concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const handler = async (args, outputMode, deps) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
      return 0;
    };
    const { envelope, exitCode, global } = await runBatchUnderTest(
      { handler, options: { concurrency: 2 } },
      searchOp("s1"), searchOp("s2"), searchOp("s3"), searchOp("s4"), searchOp("s5"),
    );
    assert.ok(maxActive <= 2, `max-active ${maxActive} exceeded concurrency 2`);
    assert.strictEqual(maxActive, 2, "the pool must actually run two ops in parallel");
    assert.strictEqual(envelope.total, 5);
    assert.strictEqual(envelope.ok, 5);
    assert.strictEqual(envelope.failed, 0);
    assert.strictEqual(envelope.concurrency, 2);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(global.stdoutWrites.length, 1);
  });

  it("defaults concurrency to 4 (bounded ceiling 8)", async () => {
    let active = 0;
    let maxActive = 0;
    const handler = async (args, outputMode, deps) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
      return 0;
    };
    const { envelope } = await runBatchUnderTest(
      { handler, options: { failFast: true } },
      searchOp("s1"), searchOp("s2"), searchOp("s3"), searchOp("s4"), searchOp("s5"), searchOp("s6"),
    );
    assert.strictEqual(envelope.concurrency, 4);
    assert.ok(maxActive <= 4, `max-active ${maxActive} exceeded default concurrency 4`);
    // All ops succeeded: failFast was set but never triggered, so the
    // envelope must NOT carry the failFast marker (D6: present only when
    // set AND triggered).
    assert.ok(!("failFast" in envelope), "failFast marker must be absent when no op failed");
  });

  it("rejects concurrency outside 1..8 and non-integers with VALIDATION_ERROR before any stdout write", async () => {
    const m = await load();
    const handler = async (args, outputMode, deps) => {
      deps.invocation.writeStdout("{}");
      return 0;
    };
    for (const bad of [0, -1, 9, 2.5, "4", NaN, Infinity]) {
      const global = globalInvocation();
      await assert.rejects(
        () =>
          m.runBatch(
            manifest(searchOp("s1")),
            [{ name: "s1", command: "search", capabilityId: "search", provider: "zai" }],
            {
              handlerDeps: baseHandlerDeps(),
              handlers: { search: handler },
              invocation: global.adapter,
              outputMode: "data",
            },
            { concurrency: bad },
          ),
        (err) => {
          assert.ok(
            err instanceof ValidationError,
            `expected ValidationError for ${JSON.stringify(bad)}, got ${err?.name}`,
          );
          assert.strictEqual(err.code, "VALIDATION_ERROR");
          assert.strictEqual(err.message, "batch concurrency must be an integer between 1 and 8");
          return true;
        },
        `concurrency ${JSON.stringify(bad)} must reject`,
      );
      assert.strictEqual(global.stdoutWrites.length, 0, "no summary envelope on validation failure");
    }
  });
});

// ---------------------------------------------------------------------------
// Ordering + per-op capture (D5, D8)
// ---------------------------------------------------------------------------

describe("batch runner result ordering and per-op capture", () => {
  it("returns results in manifest order under reversed completions", async () => {
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const handler = async (args, outputMode, deps) => {
      if (args[0] === "first") {
        // The manifest-first op completes only AFTER the second op.
        await gate;
        deps.invocation.writeStdout(JSON.stringify({ op: "first" }));
      } else {
        deps.invocation.writeStdout(JSON.stringify({ op: "second" }));
        releaseFirst();
      }
      return 0;
    };
    const { envelope } = await runBatchUnderTest(
      { handler, options: { concurrency: 2 } },
      searchOp("s1", "first"),
      searchOp("s2", "second"),
    );
    assert.strictEqual(envelope.results.length, 2);
    assert.strictEqual(envelope.results[0].name, "s1");
    assert.strictEqual(envelope.results[1].name, "s2");
    assert.strictEqual(envelope.results[0].stdout, JSON.stringify({ op: "first" }));
    assert.strictEqual(envelope.results[1].stdout, JSON.stringify({ op: "second" }));
  });

  it("captures per-op stdout/stderr with one failing sibling (isolation)", async () => {
    const handler = (args, outputMode, deps) =>
      invokeCommand(
        deps.invocation,
        async () => {
          if (args[0] === "boom") {
            throw new ValidationError("boom");
          }
          return { kind: "data", data: { op: args[0] } };
        },
        outputMode,
        undefined,
        deps.secrets,
      );
    const { envelope, exitCode, global } = await runBatchUnderTest(
      { handler, options: { concurrency: 2 } },
      searchOp("bad", "boom"),
      searchOp("good", "fine"),
    );
    assert.strictEqual(exitCode, 1);
    assert.strictEqual(envelope.total, 2);
    assert.strictEqual(envelope.ok, 1);
    assert.strictEqual(envelope.failed, 1);
    assert.strictEqual(envelope.total, envelope.ok + envelope.failed);

    const bad = envelope.results[0];
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.exitCode, 1);
    assert.strictEqual(bad.stdout, undefined, "failing op captures no stdout");
    const badErr = JSON.parse(bad.stderr);
    assert.strictEqual(badErr.success, false);
    assert.strictEqual(badErr.code, "VALIDATION_ERROR");
    assert.strictEqual(badErr.error, "boom");

    const good = envelope.results[1];
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.exitCode, 0);
    assert.strictEqual(good.stdout, JSON.stringify({ op: "fine" }));
    assert.strictEqual(good.stderr, undefined, "sibling failure never pollutes the ok record");

    // Exactly one process-level stdout write: the summary envelope.
    assert.strictEqual(global.stdoutWrites.length, 1);
    assert.strictEqual(global.stderrWrites.length, 0, "per-op stderr is captured, never re-emitted live");
  });

  it("writes exactly one summary stdout value carrying every op record", async () => {
    const handler = async (args, outputMode, deps) => {
      if (args[0] === "notice-me") {
        deps.invocation.writeStderr("a handler notice");
      }
      deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
      return 0;
    };
    const { global } = await runBatchUnderTest(
      { handler, options: { concurrency: 3 } },
      searchOp("s1", "notice-me"),
      searchOp("s2"),
      searchOp("s3"),
    );
    assert.strictEqual(global.stdoutWrites.length, 1);
    assert.strictEqual(global.stderrWrites.length, 0);
    const envelope = JSON.parse(global.stdoutWrites[0]);
    assert.strictEqual(envelope.schemaVersion, 1);
    assert.strictEqual(envelope.total, 3);
    assert.strictEqual(envelope.results.length, 3);
    assert.strictEqual(envelope.results[0].stderr, "a handler notice");
  });

  it("throws VALIDATION_ERROR from the per-op readStdin and captures the envelope in op stderr", async () => {
    const handler = (args, outputMode, deps) =>
      invokeCommand(
        deps.invocation,
        async () => {
          const text = await deps.invocation.readStdin();
          return { kind: "data", data: { read: text } };
        },
        outputMode,
      );
    const { envelope, exitCode } = await runBatchUnderTest(
      { handler, options: { concurrency: 1 } },
      searchOp("s1"),
    );
    assert.strictEqual(exitCode, 1);
    const record = envelope.results[0];
    assert.strictEqual(record.ok, false);
    assert.strictEqual(record.exitCode, 1);
    const err = JSON.parse(record.stderr);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /cannot read stdin/);
  });

  it("gives concurrent ops distinct invocation adapters (one client per op)", async () => {
    const zai = searchDescriptor("zai", [{ title: "Z", url: "https://e/z", summary: "s" }]);
    const minimax = searchDescriptor("minimax", [{ title: "M", url: "https://e/m", summary: "s" }]);
    const seenAdapters = [];
    const seenProviders = [];
    const handler = async (args, outputMode, deps) => {
      seenAdapters.push(deps.invocation);
      seenProviders.push(deps.provider);
      await new Promise((resolve) => setImmediate(resolve));
      deps.invocation.writeStdout(JSON.stringify({ provider: deps.provider }));
      return 0;
    };
    const { envelope } = await runBatchUnderTest(
      { descriptors: [zai, minimax], handler, options: { concurrency: 2 } },
      searchOp("s1"),
      searchOp("s2"),
    );
    assert.strictEqual(seenAdapters.length, 2);
    assert.notStrictEqual(seenAdapters[0], seenAdapters[1], "each op owns its adapter");
    // Distribution across the two eligible providers, visible per-op.
    assert.deepStrictEqual(seenProviders.sort(), ["minimax", "zai"]);
    assert.deepStrictEqual(
      envelope.results.map((r) => r.resolvedProvider).sort(),
      ["minimax", "zai"],
    );
    for (const record of envelope.results) {
      assert.strictEqual(JSON.parse(record.stdout).provider, record.resolvedProvider);
    }
  });
});

// ---------------------------------------------------------------------------
// Console suppression (P1 review fix: per-op runQuietly coordinates the
// same console quieting the production Node adapter performs, so library
// console output during an op can never escape to the process streams)
// ---------------------------------------------------------------------------

describe("batch runner console suppression", () => {
  it("suppresses console.log/warn/error during operations and restores them after (single summary write intact)", async () => {
    const realLog = console.log;
    const realWarn = console.warn;
    const realError = console.error;
    const logCalls = [];
    const warnCalls = [];
    const errorCalls = [];
    // The spies play the "originals" the suppression captures: if the
    // per-op runQuietly quieted nothing, the handler's console calls
    // would land in them and the test fails.
    const logSpy = (...values) => logCalls.push(values);
    const warnSpy = (...values) => warnCalls.push(values);
    const errorSpy = (...values) => errorCalls.push(values);
    console.log = logSpy;
    console.warn = warnSpy;
    console.error = errorSpy;
    try {
      // A real handler funnels its work through invokeCommand, whose
      // runQuietly wraps the behavior — that is where a provider or
      // dependency library's console output originates and where the
      // per-op adapter's quieting must hold.
      const handler = (args, outputMode, deps) =>
        invokeCommand(
          deps.invocation,
          async () => {
            await new Promise((resolve) => setImmediate(resolve));
            console.log("library noise", args[0]);
            console.warn("dependency warning");
            console.error("dependency error");
            return { kind: "data", data: { op: args[0] } };
          },
          outputMode,
        );
      const { envelope, exitCode, global } = await runBatchUnderTest(
        { handler, options: { concurrency: 2 } },
        searchOp("s1"),
        searchOp("s2"),
      );
      assert.strictEqual(exitCode, 0);
      assert.strictEqual(envelope.ok, 2);
      assert.strictEqual(logCalls.length, 0, "console.log during ops must be suppressed");
      assert.strictEqual(warnCalls.length, 0, "console.warn during ops must be suppressed");
      assert.strictEqual(errorCalls.length, 0, "console.error during ops must be suppressed");
      // The ops still captured their own stdout; the batch still wrote
      // exactly one summary envelope.
      assert.strictEqual(global.stdoutWrites.length, 1);
      for (const record of envelope.results) {
        assert.strictEqual(record.ok, true);
        assert.strictEqual(typeof record.stdout, "string");
      }
      // Restored: the outermost quiet run put the spies back in place.
      assert.strictEqual(console.log, logSpy, "console.log restored after the batch");
      assert.strictEqual(console.warn, warnSpy, "console.warn restored after the batch");
      assert.strictEqual(console.error, errorSpy, "console.error restored after the batch");
    } finally {
      console.log = realLog;
      console.warn = realWarn;
      console.error = realError;
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-fast drain + backfill (D8)
// ---------------------------------------------------------------------------

describe("batch runner fail-fast", () => {
  it("drains in-flight ops and backfills unscheduled records as not-run", async () => {
    const handler = async (args, outputMode, deps) => {
      if (args[0] === "fail") {
        deps.invocation.writeStderr(formatErrorOutput(new ValidationError("nope"), "data"));
        return 1;
      }
      if (args[0] === "slow") {
        // A macrotask hop: guaranteed to still be in flight when the
        // failing sibling's record lands and scheduling stops, and
        // guaranteed to complete (drain, never abort).
        await new Promise((resolve) => setImmediate(resolve));
      }
      deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
      return 0;
    };
    const { envelope, exitCode, global } = await runBatchUnderTest(
      { handler, options: { concurrency: 2, failFast: true } },
      searchOp("f", "fail"),
      searchOp("s", "slow"),
      searchOp("n1"),
      searchOp("n2"),
    );
    assert.strictEqual(exitCode, 1);
    assert.strictEqual(envelope.total, 4);
    assert.strictEqual(envelope.ok, 1, "the in-flight op drains and succeeds");
    assert.strictEqual(envelope.failed, 3, "one failure + two unscheduled backfills");
    assert.strictEqual(envelope.total, envelope.ok + envelope.failed);
    assert.strictEqual(envelope.failFast, true);

    const [failed, drained, notRun1, notRun2] = envelope.results;
    assert.strictEqual(failed.name, "f");
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(JSON.parse(failed.stderr).code, "VALIDATION_ERROR");

    assert.strictEqual(drained.name, "s");
    assert.strictEqual(drained.ok, true);
    assert.strictEqual(drained.stdout, JSON.stringify({ op: "slow" }));

    for (const record of [notRun1, notRun2]) {
      assert.strictEqual(record.ok, false);
      assert.strictEqual(record.exitCode, 1);
      assert.strictEqual(record.stderr, "not run (--fail-fast)");
      assert.strictEqual(record.stdout, undefined);
      assert.ok(record.resolvedProvider !== undefined, "backfills still carry the assignment");
    }
    assert.strictEqual(global.stdoutWrites.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Pre-invokeCommand throw safety net (D5)
// ---------------------------------------------------------------------------

describe("batch runner pre-invoke safety net", () => {
  it("converts a synchronous handler ValidationError into a per-op failure with the invokeCommand stderr format", async () => {
    const boom = new ValidationError("exploded before invokeCommand");
    const handler = () => {
      // Synchronous throw BEFORE any invokeCommand — mirrors the repo/
      // search/vision parse-level pre-invoke throws.
      throw boom;
    };
    let tick = 1000;
    const now = () => tick++;
    const { envelope, exitCode } = await runBatchUnderTest(
      { handler, now, options: { concurrency: 1 } },
      searchOp("s1"),
    );
    assert.strictEqual(exitCode, 1);
    const record = envelope.results[0];
    assert.strictEqual(record.ok, false);
    assert.strictEqual(record.exitCode, 1);
    assert.strictEqual(record.name, "s1");
    // Byte-identical to what invokeCommand's own catch would have
    // produced onto the adapter (data mode JSON error envelope).
    assert.strictEqual(record.stderr, formatErrorOutput(boom, "data"));
    assert.strictEqual(JSON.parse(record.stderr).code, "VALIDATION_ERROR");
    assert.strictEqual(record.stdout, undefined);
    assert.strictEqual(typeof record.durationMs, "number");
    assert.ok(record.durationMs > 0, "durationMs recorded from the start/stop pair");
    assert.strictEqual(typeof envelope.durationMs, "number");
    assert.ok(envelope.durationMs > 0);
  });
});

// ---------------------------------------------------------------------------
// Fan-out suppression (D4/D5: assignment pins single mode)
// ---------------------------------------------------------------------------

describe("batch runner fan-out suppression", () => {
  it("fanout=true config still runs each batch search op in single mode with the suppress notice captured", async () => {
    const zai = searchDescriptor("zai", [{ title: "ZAI arm", url: "https://e/z", summary: "s" }]);
    const minimax = searchDescriptor("minimax", [
      { title: "MM arm", url: "https://e/m", summary: "s" },
    ]);
    const descriptors = [zai, minimax];
    const plans = [];
    // Mirrors handleSearch's dispatch: the per-op deps spread makes
    // `deps.provider` a single-id pin, so the REAL resolveFanoutPlan
    // resolves single mode with the suppress notice under configFanout.
    const handler = (args, outputMode, deps) => {
      const plan = resolveFanoutPlan({
        explicitProviderRaw: deps.provider,
        env: deps.env,
        configFanout: deps.configFanout === true,
        routing: deps.routing,
        descriptors: deps.providerDescriptors,
      });
      plans.push(plan);
      return invokeCommand(
        deps.invocation,
        async (context) => {
          if (plan.suppress) {
            context.notice(plan.suppress);
          }
          const descriptor = deps.providerDescriptors.find((d) => d.id === plan.arms[0]);
          const adapter = descriptor.create({ env: deps.env });
          const data = await adapter.search.invoke({ query: args[0] });
          return { kind: "data", data };
        },
        outputMode,
        undefined,
        deps.secrets,
      );
    };
    const { envelope, exitCode } = await runBatchUnderTest(
      {
        descriptors,
        handler,
        handlerDeps: baseHandlerDeps({
          providerDescriptors: descriptors.map((h) => h.descriptor),
          configFanout: true,
        }),
        options: { concurrency: 2 },
      },
      searchOp("s1", "alpha"),
      searchOp("s2", "beta"),
    );
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.failed, 0);
    // Single mode per op (never fanout), each with the suppress notice.
    assert.strictEqual(plans.length, 2);
    for (const plan of plans) {
      assert.strictEqual(plan.mode, "single", "assignment pin forces single mode");
      assert.strictEqual(plan.suppress, "explicit pin: fan-out ignored");
      assert.strictEqual(plan.arms.length, 1);
    }
    // Zero arm replication: one billable call per op, not N arms per op.
    assert.strictEqual(zai.invokes.length, 1);
    assert.strictEqual(minimax.invokes.length, 1);
    // The suppress notice is captured in the op's stderr record.
    for (const record of envelope.results) {
      assert.strictEqual(record.ok, true);
      assert.match(record.stderr, /explicit pin: fan-out ignored/);
    }
  });
});

// ---------------------------------------------------------------------------
// Consumption inheritance (D11: handler wiring flows through the spread)
// ---------------------------------------------------------------------------

describe("batch runner consumption inheritance", () => {
  it("threads the handler-deps consumption sink through to every op", async () => {
    const zai = searchDescriptor("zai", []);
    const minimax = searchDescriptor("minimax", []);
    const events = [];
    const handler = async (args, outputMode, deps) => {
      await deps.consume.record({
        provider: deps.provider,
        capabilityId: "search",
        amount: { kind: "estimate", value: 1 },
        attempt: 1,
        at: 42,
      });
      deps.invocation.writeStdout("{}");
      return 0;
    };
    const { envelope } = await runBatchUnderTest(
      {
        descriptors: [zai, minimax],
        handler,
        handlerDeps: baseHandlerDeps({
          providerDescriptors: [zai.descriptor, minimax.descriptor],
          consume: { record: async (event) => events.push(event) },
        }),
        options: { concurrency: 2 },
      },
      searchOp("s1"),
      searchOp("s2"),
    );
    assert.strictEqual(envelope.ok, 2);
    assert.strictEqual(events.length, 2);
    assert.deepStrictEqual(events.map((e) => e.attempt), [1, 1]);
    assert.deepStrictEqual(events.map((e) => e.provider).sort(), ["minimax", "zai"]);
  });
});

// ---------------------------------------------------------------------------
// Per-op output files (D9)
// ---------------------------------------------------------------------------

describe("batch runner per-op output files", () => {
  it("writes captured stdout to the declared output file (temp + rename, no residue)", async (t) => {
    const tmp = await mkdtemp(join(os.tmpdir(), "scoutline-batch-d9-"));
    // Review fix: remove the tmpdir when this test ends (it previously
    // leaked a `scoutline-batch-d9-*` dir on every run).
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const outputPath = join(tmp, "s1.json");
    const handler = async (args, outputMode, deps) => {
      deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
      return 0;
    };
    // No fs doubles: this run goes through the runner's REAL default
    // node:fs/promises write + rename seam.
    const { envelope, exitCode } = await runBatchUnderTest(
      { handler },
      searchOp("s1", "hello", outputPath),
    );
    assert.strictEqual(exitCode, 0);
    const record = envelope.results[0];
    assert.strictEqual(record.ok, true);
    assert.strictEqual(record.output, outputPath);
    assert.strictEqual(record.outputWriteError, undefined);
    const written = await readFile(outputPath, "utf8");
    assert.strictEqual(written, JSON.stringify({ op: "hello" }));
    assert.strictEqual(written, record.stdout, "the file matches the captured stdout");
    // The rename landed atomically: no temp file is left behind.
    assert.deepStrictEqual(await readdir(tmp), ["s1.json"]);
  });

  it("keeps ok true, failed at 0, and records outputWriteError when the write fails", async () => {
    for (const which of ["write", "rename"]) {
      const files = new Map();
      const writeOutputFile = async (path, data) => {
        if (which === "write") throw new Error("disk on fire");
        files.set(path, data);
      };
      const renameOutputFile = async (from, to) => {
        if (which === "rename") throw new Error("rename denied");
        files.set(to, files.get(from));
        files.delete(from);
      };
      const handler = async (args, outputMode, deps) => {
        deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
        return 0;
      };
      const { envelope, exitCode, global } = await runBatchUnderTest(
        { handler, writeOutputFile, renameOutputFile },
        searchOp("s1", "hello", "/tmp/never/s1.json"),
      );
      // D9: a write failure never flips ok or the counters —
      // total = ok + failed keeps holding.
      assert.strictEqual(exitCode, 0, `[${which}] write failure must not fail the batch`);
      assert.strictEqual(envelope.ok, 1);
      assert.strictEqual(envelope.failed, 0);
      assert.strictEqual(envelope.total, envelope.ok + envelope.failed);
      const record = envelope.results[0];
      assert.strictEqual(record.ok, true);
      assert.strictEqual(record.stdout, JSON.stringify({ op: "hello" }), "capture is unaffected");
      assert.strictEqual(record.output, "/tmp/never/s1.json");
      assert.strictEqual(record.outputWriteError, which === "write" ? "disk on fire" : "rename denied");
      // The final file never appeared behind the failed write.
      assert.strictEqual(files.has("/tmp/never/s1.json"), false);
      // The batch still produced its one summary envelope.
      assert.strictEqual(global.stdoutWrites.length, 1);
    }
  });

  it("removes the temp file when the rename fails (no residue behind a failed write)", async () => {
    const written = [];
    const removed = [];
    const writeOutputFile = async (path, data) => {
      written.push({ path, data });
    };
    const renameOutputFile = async () => {
      throw new Error("rename denied");
    };
    const removeOutputFile = async (path) => {
      removed.push(path);
    };
    const handler = async (args, outputMode, deps) => {
      deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
      return 0;
    };
    const { envelope, exitCode, global } = await runBatchUnderTest(
      { handler, writeOutputFile, renameOutputFile, removeOutputFile },
      searchOp("s1", "hello", "/tmp/never/s1.json"),
    );
    assert.strictEqual(exitCode, 0, "a rename failure must not fail the batch (D9)");
    const record = envelope.results[0];
    assert.strictEqual(record.ok, true);
    assert.strictEqual(record.outputWriteError, "rename denied");
    // The temp file the write produced was removed after the rename
    // failed — the failed write leaves nothing behind. The temp name is
    // unique per attempt (review fix): it keeps the op index prefix but
    // carries an unpredictable suffix, so cleanup can only ever remove
    // a file THIS attempt created — never a pre-existing file or a
    // concurrent run's temp at the same predictable path.
    const tempPath = written[0].path;
    assert.ok(
      /^\/tmp\/never\/s1\.json\.tmp-0-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tempPath),
      `temp path carries a unique suffix beyond the predictable index name, got ${tempPath}`,
    );
    assert.deepStrictEqual(removed, [tempPath], "cleanup removes exactly the temp this attempt created");
    assert.strictEqual(global.stdoutWrites.length, 1);
  });

  it("temp paths are unique per attempt, so two same-target ops never share one (review fix)", async () => {
    const written = [];
    const renames = [];
    const writeOutputFile = async (path, data) => {
      written.push(path);
    };
    const renameOutputFile = async (from, to) => {
      renames.push(from);
    };
    const handler = async (args, outputMode, deps) => {
      deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
      return 0;
    };
    // Two ops degenerately declaring the SAME output target: within one
    // run the index keeps them apart, but a predictable name would also
    // collide with a concurrent run holding the same index (or clobber
    // a pre-existing `<target>.tmp-<n>` file). The unique suffix makes
    // the temp exclusively owned by this attempt.
    const { envelope, exitCode } = await runBatchUnderTest(
      { handler, writeOutputFile, renameOutputFile, options: { concurrency: 2 } },
      searchOp("a", "qa", "/shared/out.json"),
      searchOp("b", "qb", "/shared/out.json"),
    );
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.ok, 2);
    assert.strictEqual(written.length, 2);
    assert.notStrictEqual(written[0], written[1], "same-target writes must not share a temp path");
    assert.deepStrictEqual(renames, written, "each rename consumes exactly the temp its write created");
  });

  it("a successful op with an output target but NO stdout writes no file and records the anomaly", async () => {
    const writeOutputFile = async () => {
      throw new Error("must not be called");
    };
    const renameOutputFile = async () => {
      throw new Error("must not be called");
    };
    // Exit 0 with zero captured stdout: a consumer must never read a
    // zero-byte output file marked ok — no write happens and the anomaly
    // is surfaced as outputWriteError (ok stays true: ok === exit 0).
    const handler = async () => 0;
    const { envelope, exitCode } = await runBatchUnderTest(
      { handler, writeOutputFile, renameOutputFile },
      searchOp("s1", "silent", "/tmp/never/s1.json"),
    );
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.ok, 1);
    const record = envelope.results[0];
    assert.strictEqual(record.ok, true);
    assert.strictEqual(record.output, "/tmp/never/s1.json", "the declared target stays visible");
    assert.strictEqual(record.stdout, undefined);
    assert.ok(
      typeof record.outputWriteError === "string" && record.outputWriteError.includes("no stdout"),
      `outputWriteError must explain the missing stdout, got ${JSON.stringify(record.outputWriteError)}`,
    );
  });

  it("fail-fast: unscheduled and failed ops write nothing; a drained success still writes", async () => {
    const files = new Map();
    const renames = [];
    const writeOutputFile = async (path, data) => {
      files.set(path, data);
    };
    const renameOutputFile = async (from, to) => {
      renames.push({ from, to });
      files.set(to, files.get(from));
      files.delete(from);
    };
    const handler = async (args, outputMode, deps) => {
      if (args[0] === "fail") {
        deps.invocation.writeStderr(formatErrorOutput(new ValidationError("nope"), "data"));
        return 1;
      }
      if (args[0] === "slow") {
        await new Promise((resolve) => setImmediate(resolve));
      }
      deps.invocation.writeStdout(JSON.stringify({ op: args[0] }));
      return 0;
    };
    const { envelope, exitCode } = await runBatchUnderTest(
      { handler, writeOutputFile, renameOutputFile, options: { concurrency: 2, failFast: true } },
      searchOp("f", "fail", "/out/f.json"),
      searchOp("s", "slow", "/out/s.json"),
      searchOp("n", "queued", "/out/n.json"),
    );
    assert.strictEqual(exitCode, 1);
    const [failedRec, drainedRec, notRunRec] = envelope.results;

    // The drained in-flight success still wrote its file during drain.
    assert.strictEqual(drainedRec.ok, true);
    assert.strictEqual(files.get("/out/s.json"), JSON.stringify({ op: "slow" }));
    assert.strictEqual(drainedRec.output, "/out/s.json");
    assert.strictEqual(drainedRec.outputWriteError, undefined);

    // The failed op is post-success-only: the declared target stays
    // visible on the record, but nothing was written or renamed.
    assert.strictEqual(failedRec.ok, false);
    assert.strictEqual(failedRec.output, "/out/f.json");
    assert.strictEqual(files.has("/out/f.json"), false);
    assert.strictEqual(renames.some((r) => r.to === "/out/f.json"), false);

    // The never-scheduled op wrote nothing and carries only stderr (D6).
    assert.strictEqual(notRunRec.stderr, "not run (--fail-fast)");
    assert.strictEqual(notRunRec.output, undefined);
    assert.strictEqual(notRunRec.outputWriteError, undefined);
    assert.strictEqual(files.has("/out/n.json"), false);
    assert.strictEqual(renames.some((r) => r.to === "/out/n.json"), false);
  });
});
