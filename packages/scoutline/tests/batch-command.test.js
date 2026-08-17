import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../dist/index.js";

/**
 * Ticket 4 — `handleBatch` + dispatch + stdin manifest (DESIGN D1, D8).
 *
 * Dispatch-level tests: `main(["batch", ...])` with injected fake
 * descriptors and a fake global invocation adapter. Pins: the additive
 * `case "batch"` dispatch, provider distribution across two eligible
 * providers at dispatch level, per-op captured stdout being the
 * handler's REAL JSON output (never a HELP text — guards D2.8
 * positional composition), the failing-op envelope contract, the `-`
 * stdin manifest path (one read through the GLOBAL adapter, before the
 * pool), stdin-read failure → whole-batch VALIDATION_ERROR on stderr
 * with NO summary envelope (AC1), batch flag validation
 * (unknown-flag rejection, `--concurrency` 1..8 per D8), acceptance of
 * `--fail-fast`/`--dry-run`, and BATCH_HELP.
 *
 * Ticket 6 extension (DESIGN D7): `--dry-run` runs the assignment and
 * the resolved-provider pre-dispatch gates (configured + capability
 * advertised) without `descriptor.create()` — counting descriptors pin
 * zero transport, a counting cache pins zero reads/writes, DryRunRecords
 * carry `reason` and never stdout/stderr/output/outputWriteError, and
 * zero-eligible groups fail exactly as in a real run.
 *
 * Tests import dist/ per AGENTS.md (build before test). The descriptor
 * double pattern is reused from tests/search-fanout.test.js; that file
 * is untouched.
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** Configured, search-capable descriptor whose adapter returns results. */
function makeSearchDescriptor(id, results) {
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

/** Configured, search-capable descriptor whose transport always fails. */
function makeFailingSearchDescriptor(id, message) {
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
            throw new Error(message);
          },
        },
      }),
    },
    invokes,
  };
}

/**
 * Global invocation adapter double. `readStdin` defaults to a throw so
 * any test that does not expect a stdin read fails loudly if the
 * implementation consults stdin when it must not (the file path and the
 * pool must never touch the global stdin).
 */
function fakeInvocation(readStdin) {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin:
        readStdin ??
        (async () => {
          throw new Error("unexpected global readStdin call");
        }),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      runQuietly: async (operation) => operation(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

/** Fresh in-memory response cache (search-fanout.test.js pattern). */
function freshCache() {
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

/** Fixed clock so envelope durations are deterministic (0ms) and the
 * stdin run can be compared byte-for-byte with the file run. */
const FIXED_NOW = () => 1755400000000;

function writeManifest(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-batch-"));
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest), "utf8");
  return { dir, file, text: JSON.stringify(manifest) };
}

/** Base MainDependencies for a batch dispatch run. */
function batchDeps(adapter, descriptors, extra = {}) {
  return {
    invocation: adapter,
    env: {},
    providerDescriptors: descriptors.map((entry) => entry.descriptor),
    // Hermeticity: never let the machine's real config.json fan-out
    // switch leak into these runs (with ambient fanout=true, every
    // pinned op additionally captures the "explicit pin" suppress
    // notice — legitimate per D6, but not what these tests pin).
    configFanout: false,
    searchCache: freshCache(),
    searchSleep: async () => {},
    searchRandom: () => 0.5,
    now: FIXED_NOW,
    ...extra,
  };
}

const twoProviderManifest = {
  schemaVersion: 1,
  operations: [
    { name: "op-alpha", command: "search", input: { query: "first query" } },
    { name: "op-beta", command: "search", input: { query: "second query" } },
  ],
};

// ---------------------------------------------------------------------------
// Dispatch: distribution across providers, real per-op JSON output
// ---------------------------------------------------------------------------

describe("batch command dispatch through main()", () => {
  it("distributes a 2-op search manifest across two providers (exit 0, real handler JSON, never HELP)", async () => {
    const tav = makeSearchDescriptor("tavily", [
      { title: "Tav", url: "https://example.com/tav", summary: "tav result" },
    ]);
    const exa = makeSearchDescriptor("exa", [
      { title: "Exa", url: "https://example.com/exa", summary: "exa result" },
    ]);
    const { file } = writeManifest(twoProviderManifest);
    const { adapter, stdout } = fakeInvocation();

    const status = await main(["batch", file], batchDeps(adapter, [tav, exa]));

    assert.strictEqual(status, 0);
    // Data-only stdout: exactly ONE write — the summary envelope.
    assert.strictEqual(stdout.length, 1);
    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.schemaVersion, 1);
    assert.strictEqual(envelope.total, 2);
    assert.strictEqual(envelope.ok, 2);
    assert.strictEqual(envelope.failed, 0);
    assert.strictEqual(envelope.concurrency, 4);
    // Manifest order preserved.
    assert.strictEqual(envelope.results[0].name, "op-alpha");
    assert.strictEqual(envelope.results[1].name, "op-beta");
    // Distribution (D4): round-robin over the eligible registry order —
    // two ops land on two DISTINCT providers.
    assert.strictEqual(envelope.results[0].resolvedProvider, "tavily");
    assert.strictEqual(envelope.results[1].resolvedProvider, "exa");
    assert.notStrictEqual(
      envelope.results[0].resolvedProvider,
      envelope.results[1].resolvedProvider,
    );
    // Each op's captured stdout is the handler's REAL JSON output. A
    // HELP text (the failure mode of a wrong D2.8 positional compile)
    // is not JSON and would fail the parse; the array shape and title
    // pin the provider-attributed content.
    for (const [index, expectedTitle] of [
      [0, "Tav"],
      [1, "Exa"],
    ]) {
      const record = envelope.results[index];
      assert.strictEqual(record.ok, true);
      assert.strictEqual(record.exitCode, 0);
      assert.ok(typeof record.stdout === "string");
      const opOutput = JSON.parse(record.stdout);
      assert.ok(Array.isArray(opOutput), "op stdout must be JSON array output, not HELP text");
      assert.strictEqual(opOutput.length, 1);
      assert.strictEqual(opOutput[0].title, expectedTitle);
      assert.ok(!record.stdout.includes("Usage:"), "op stdout must never be a HELP text");
    }
    // One real invoke per provider (each op ran its assigned provider).
    assert.strictEqual(tav.invokes.length, 1);
    assert.strictEqual(exa.invokes.length, 1);
  });

  it("one failing op exits 1 with the envelope on stdout and the failure inside results[]", async () => {
    const tav = makeSearchDescriptor("tavily", [
      { title: "Tav", url: "https://example.com/tav", summary: "tav result" },
    ]);
    const bad = makeFailingSearchDescriptor("minimax", "minimax transport exploded");
    const manifest = {
      schemaVersion: 1,
      operations: [
        { name: "op-good", command: "search", input: { query: "good query" } },
        { name: "op-bad", command: "search", input: { query: "bad query" }, provider: "minimax" },
      ],
    };
    const { file } = writeManifest(manifest);
    const { adapter, stdout } = fakeInvocation();

    // --no-fallback keeps the pinned failing provider from being rescued
    // by the fallback chain (D4 resilience): the op fails on its pin.
    const status = await main(["--no-fallback", "batch", file], batchDeps(adapter, [tav, bad]));

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 1);
    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.total, 2);
    assert.strictEqual(envelope.ok, 1);
    assert.strictEqual(envelope.failed, 1);

    const good = envelope.results[0];
    assert.strictEqual(good.name, "op-good");
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.resolvedProvider, "tavily");
    assert.strictEqual(JSON.parse(good.stdout)[0].title, "Tav");

    const failedRecord = envelope.results[1];
    assert.strictEqual(failedRecord.name, "op-bad");
    assert.strictEqual(failedRecord.ok, false);
    assert.notStrictEqual(failedRecord.exitCode, 0);
    assert.strictEqual(failedRecord.resolvedProvider, "minimax");
    assert.ok(typeof failedRecord.stderr === "string");
    // Per-op stderr may legitimately carry notices before the error
    // envelope (D6: handler notices are captured per-op) — parse the
    // envelope from the first "{".
    const envelopeStart = failedRecord.stderr.indexOf("{");
    assert.ok(envelopeStart >= 0, "op stderr must carry the JSON error envelope");
    const opError = JSON.parse(failedRecord.stderr.slice(envelopeStart));
    assert.strictEqual(opError.success, false);
    assert.ok(opError.error.includes("minimax transport exploded"));
  });
});

// ---------------------------------------------------------------------------
// Stdin manifest (`batch -`)
// ---------------------------------------------------------------------------

describe("batch stdin manifest", () => {
  it("`batch -` reads the manifest from the global stdin once and equals the file run", async () => {
    const { file, text } = writeManifest(twoProviderManifest);

    // File run: the global readStdin must never be consulted.
    const fileInvocation = fakeInvocation();
    const fileStatus = await main(
      ["batch", file],
      batchDeps(fileInvocation.adapter, [
        makeSearchDescriptor("tavily", [
          { title: "Tav", url: "https://example.com/tav", summary: "s" },
        ]),
        makeSearchDescriptor("exa", [
          { title: "Exa", url: "https://example.com/exa", summary: "s" },
        ]),
      ]),
    );
    assert.strictEqual(fileStatus, 0);
    assert.strictEqual(fileInvocation.stdout.length, 1);

    // Stdin run: same manifest text through the global adapter.
    let stdinReads = 0;
    const stdinInvocation = fakeInvocation(async () => {
      stdinReads += 1;
      return text;
    });
    const stdinStatus = await main(
      ["batch", "-"],
      batchDeps(stdinInvocation.adapter, [
        makeSearchDescriptor("tavily", [
          { title: "Tav", url: "https://example.com/tav", summary: "s" },
        ]),
        makeSearchDescriptor("exa", [
          { title: "Exa", url: "https://example.com/exa", summary: "s" },
        ]),
      ]),
    );

    assert.strictEqual(stdinStatus, 0);
    assert.strictEqual(stdinReads, 1, "the manifest is read from stdin exactly once");
    // Fixed clock → byte-identical envelopes.
    assert.deepStrictEqual(stdinInvocation.stdout, fileInvocation.stdout);
  });

  it("a rejecting global readStdin fails the whole batch (VALIDATION_ERROR on stderr, no summary envelope)", async () => {
    const { adapter, stdout, stderr } = fakeInvocation(async () => {
      throw new Error("stdin pipe broken");
    });

    const status = await main(
      ["batch", "-"],
      batchDeps(adapter, [
        makeSearchDescriptor("tavily", [
          { title: "Tav", url: "https://example.com/tav", summary: "s" },
        ]),
      ]),
    );

    // AC1: whole-batch VALIDATION_ERROR before the pool starts — stderr
    // carries the structured error envelope, stdout carries NOTHING.
    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    assert.ok(stderr.length >= 1);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.ok(parsed.error.includes("stdin"));
  });
});

// ---------------------------------------------------------------------------
// Batch-level flag validation (D8 + strict flag surface)
// ---------------------------------------------------------------------------

describe("batch flag validation", () => {
  it("rejects unknown batch flags with VALIDATION_ERROR", async () => {
    const { file } = writeManifest(twoProviderManifest);
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["batch", "--frobnicate", file],
      batchDeps(adapter, [
        makeSearchDescriptor("tavily", [
          { title: "Tav", url: "https://example.com/tav", summary: "s" },
        ]),
      ]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.ok(parsed.error.includes("--frobnicate"));
  });

  it("rejects --concurrency out of range (9) with VALIDATION_ERROR and no stdout write", async () => {
    const { file } = writeManifest(twoProviderManifest);
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["batch", file, "--concurrency", "9"],
      batchDeps(adapter, [
        makeSearchDescriptor("tavily", [
          { title: "Tav", url: "https://example.com/tav", summary: "s" },
        ]),
      ]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.ok(parsed.error.includes("concurrency"));
  });

  it("rejects a non-integer --concurrency (2.5) with VALIDATION_ERROR", async () => {
    const { file } = writeManifest(twoProviderManifest);
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["batch", file, "--concurrency", "2.5"],
      batchDeps(adapter, [
        makeSearchDescriptor("tavily", [
          { title: "Tav", url: "https://example.com/tav", summary: "s" },
        ]),
      ]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.ok(parsed.error.includes("concurrency"));
  });

  it("accepts --concurrency in range, --fail-fast, and --dry-run together", async () => {
    const { file } = writeManifest(twoProviderManifest);
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["batch", file, "--concurrency", "2", "--fail-fast", "--dry-run"],
      batchDeps(adapter, [
        makeSearchDescriptor("tavily", [
          { title: "Tav", url: "https://example.com/tav", summary: "s" },
        ]),
        makeSearchDescriptor("exa", [
          { title: "Exa", url: "https://example.com/exa", summary: "s" },
        ]),
      ]),
    );

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.ok, 2);
    assert.strictEqual(envelope.concurrency, 2);
  });
});

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

describe("batch help", () => {
  it("`batch --help` renders BATCH_HELP (exit 0)", async () => {
    const { adapter, stdout } = fakeInvocation();

    const status = await main(["batch", "--help"], batchDeps(adapter, []));

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.ok(stdout[0].includes("scoutline batch"));
    assert.ok(stdout[0].includes("--concurrency"));
  });

  it("bare `batch` renders BATCH_HELP too (no manifest argument)", async () => {
    const { adapter, stdout } = fakeInvocation();

    const status = await main(["batch"], batchDeps(adapter, []));

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.ok(stdout[0].includes("scoutline batch"));
  });
});

// ---------------------------------------------------------------------------
// Ticket 6 — `--dry-run` gates + assignment preview (DESIGN D7)
// ---------------------------------------------------------------------------

/**
 * Search descriptor double with counters: `createCalls` pins the D7
 * "without descriptor.create()" boundary (dry runs never build a
 * transport), `invokes` pins that no op ever executed. `configured`
 * and `capabilities` are adjustable so the same double plays the
 * unconfigured-pin and not-advertising cases.
 */
function makeCountingSearchDescriptor(
  id,
  results,
  { configured = true, capabilities = ["search"] } = {},
) {
  const counters = { createCalls: 0, invokes: 0 };
  return {
    descriptor: {
      id,
      isConfigured: () => configured,
      capabilities: () => new Set(capabilities),
      create: () => {
        counters.createCalls += 1;
        return {
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
              counters.invokes += 1;
              return results.map((entry) => ({ ...entry }));
            },
          },
        };
      },
    },
    counters,
  };
}

/** Response cache double that counts reads and writes (D7: dry runs touch none). */
function countingCache() {
  const counters = { gets: 0, sets: 0 };
  const store = new Map();
  return {
    cache: {
      async get(key) {
        counters.gets += 1;
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        counters.sets += 1;
        store.set(key, value);
      },
    },
    counters,
  };
}

/** D7: DryRunRecords never carry these keys (no transport, no writes). */
function assertLeanDryRunRecord(record) {
  for (const key of ["stdout", "stderr", "output", "outputWriteError"]) {
    assert.ok(!(key in record), `dry-run record must not carry "${key}"`);
  }
  assert.ok(typeof record.durationMs === "number");
  assert.ok(typeof record.reason === "string");
}

describe("batch --dry-run gates and assignment preview (D7)", () => {
  it("previews a ready assignment without touching transport (dryRun envelope, zero create())", async () => {
    const tav = makeCountingSearchDescriptor("tavily", [
      { title: "Tav", url: "https://example.com/tav", summary: "s" },
    ]);
    const exa = makeCountingSearchDescriptor("exa", [
      { title: "Exa", url: "https://example.com/exa", summary: "s" },
    ]);
    const { file } = writeManifest(twoProviderManifest);
    const { adapter, stdout } = fakeInvocation();

    const status = await main(["batch", file, "--dry-run"], batchDeps(adapter, [tav, exa]));

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.schemaVersion, 1);
    assert.strictEqual(envelope.dryRun, true);
    assert.strictEqual(envelope.total, 2);
    assert.strictEqual(envelope.ok, 2);
    assert.strictEqual(envelope.failed, 0);
    assert.strictEqual(envelope.concurrency, 4);
    assert.strictEqual("failFast" in envelope, false);

    // Full assignment visible: the same round-robin distribution a real
    // run would perform, resolvedProvider on every record (D4 preview).
    assert.strictEqual(envelope.results[0].name, "op-alpha");
    assert.strictEqual(envelope.results[0].command, "search");
    assert.strictEqual(envelope.results[0].resolvedProvider, "tavily");
    assert.strictEqual(envelope.results[1].name, "op-beta");
    assert.strictEqual(envelope.results[1].resolvedProvider, "exa");

    for (const record of envelope.results) {
      assert.strictEqual(record.ok, true);
      assert.strictEqual(record.exitCode, 0);
      assert.strictEqual(record.reason, "ready");
      assertLeanDryRunRecord(record);
    }

    // D7 boundary: no transport was ever built, no op ever executed.
    assert.strictEqual(tav.counters.createCalls, 0);
    assert.strictEqual(exa.counters.createCalls, 0);
    assert.strictEqual(tav.counters.invokes, 0);
    assert.strictEqual(exa.counters.invokes, 0);
  });

  it("an unconfigured pinned provider fails its op with a reason (exit 1, envelope still on stdout)", async () => {
    const tav = makeCountingSearchDescriptor("tavily", [
      { title: "Tav", url: "https://example.com/tav", summary: "s" },
    ]);
    // In the registry, search-capable, but holds no credentials: the
    // manifest parse accepts the pin (registry + capability only), the
    // dry-run gate is what reports it.
    const brave = makeCountingSearchDescriptor(
      "brave",
      [{ title: "Brave", url: "https://example.com/brave", summary: "s" }],
      { configured: false },
    );
    const manifest = {
      schemaVersion: 1,
      operations: [
        { name: "op-ready", command: "search", input: { query: "ready query" } },
        { name: "op-pinned", command: "search", input: { query: "pinned query" }, provider: "brave" },
      ],
    };
    const { file } = writeManifest(manifest);
    const { adapter, stdout } = fakeInvocation();

    const status = await main(["batch", file, "--dry-run"], batchDeps(adapter, [tav, brave]));

    // D7 exit rule: any not-ready op -> exit 1, but the envelope still
    // carries every op's pre-dispatch truth on stdout.
    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 1);
    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.dryRun, true);
    assert.strictEqual(envelope.total, 2);
    assert.strictEqual(envelope.ok, 1);
    assert.strictEqual(envelope.failed, 1);

    const ready = envelope.results[0];
    assert.strictEqual(ready.name, "op-ready");
    assert.strictEqual(ready.ok, true);
    assert.strictEqual(ready.reason, "ready");
    assert.strictEqual(ready.resolvedProvider, "tavily");

    const notReady = envelope.results[1];
    assert.strictEqual(notReady.name, "op-pinned");
    assert.strictEqual(notReady.ok, false);
    assert.strictEqual(notReady.exitCode, 1);
    assert.strictEqual(notReady.resolvedProvider, "brave");
    assert.strictEqual(notReady.reason, "provider not configured");
    assertLeanDryRunRecord(notReady);

    assert.strictEqual(tav.counters.createCalls, 0);
    assert.strictEqual(brave.counters.createCalls, 0);
  });

  it("a configured provider that does not advertise the capability reports 'capability not advertised'", async () => {
    // Global --provider pin to a provider that is configured but only
    // advertises reader: distribution is disabled by the global pin, so
    // the resolved provider fails the capability half of the D7 gate.
    const tav = makeCountingSearchDescriptor(
      "tavily",
      [{ title: "Tav", url: "https://example.com/tav", summary: "s" }],
      { capabilities: ["reader"] },
    );
    const manifest = {
      schemaVersion: 1,
      operations: [{ name: "op-only", command: "search", input: { query: "any query" } }],
    };
    const { file } = writeManifest(manifest);
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["--provider", "tavily", "batch", file, "--dry-run"],
      batchDeps(adapter, [tav]),
    );

    assert.strictEqual(status, 1);
    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.dryRun, true);
    assert.strictEqual(envelope.failed, 1);
    const record = envelope.results[0];
    assert.strictEqual(record.resolvedProvider, "tavily");
    assert.strictEqual(record.ok, false);
    assert.strictEqual(record.reason, "capability not advertised");
    assertLeanDryRunRecord(record);
    assert.strictEqual(tav.counters.createCalls, 0);
  });

  it("a zero-eligible group fails the whole dry run (VALIDATION_ERROR on stderr, no summary envelope)", async () => {
    // Search-only registry; a read op has no eligible reader and no pin.
    const tav = makeCountingSearchDescriptor("tavily", [
      { title: "Tav", url: "https://example.com/tav", summary: "s" },
    ]);
    const manifest = {
      schemaVersion: 1,
      operations: [{ name: "op-read", command: "read", input: { url: "https://example.com/doc" } }],
    };
    const { file } = writeManifest(manifest);
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(["batch", file, "--dry-run"], batchDeps(adapter, [tav]));

    // D7: zero-eligible groups fail here exactly as in a real run —
    // whole-batch VALIDATION_ERROR before any stdout write.
    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.ok(parsed.error.includes("reader"));
    assert.ok(parsed.error.includes("eligible"));
    assert.strictEqual(tav.counters.createCalls, 0);
  });

  it("reads/writes no cache and writes no per-op output files", async () => {
    const tav = makeCountingSearchDescriptor("tavily", [
      { title: "Tav", url: "https://example.com/tav", summary: "s" },
    ]);
    const { cache, counters } = countingCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-batch-"));
    const outputPath = path.join(dir, "out.json");
    const file = path.join(dir, "manifest.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        operations: [
          {
            name: "op-with-output",
            command: "search",
            input: { query: "cached query" },
            output: outputPath,
          },
        ],
      }),
      "utf8",
    );
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["batch", file, "--dry-run"],
      batchDeps(adapter, [tav], { searchCache: cache }),
    );

    assert.strictEqual(status, 0);
    assert.strictEqual(counters.gets, 0, "dry run must not read the cache");
    assert.strictEqual(counters.sets, 0, "dry run must not write the cache");
    assert.strictEqual(tav.counters.createCalls, 0);

    const envelope = JSON.parse(stdout[0]);
    assert.strictEqual(envelope.dryRun, true);
    const record = envelope.results[0];
    assert.strictEqual(record.reason, "ready");
    assertLeanDryRunRecord(record);
    // D9 interplay: a declared output target produces NO file (and no
    // temp residue) in a dry run — only real successful runs write.
    assert.strictEqual(fs.existsSync(outputPath), false, "dry run must not write output files");
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["manifest.json"]);
  });

  it("help documents the dry-run boundary", async () => {
    const { adapter, stdout } = fakeInvocation();

    const status = await main(["batch", "--help"], batchDeps(adapter, []));

    assert.strictEqual(status, 0);
    const help = stdout[0];
    assert.ok(help.includes("--dry-run"));
    // The boundary is explicit: no transport contact, and per-handler
    // flag semantics are beyond dry-run (D7).
    assert.ok(help.includes("without contacting any provider"));
    assert.ok(help.includes("not validated in a dry run"));
  });
});

// ---------------------------------------------------------------------------
// Ticket 8 — docs pass: DESIGN D4's distribution semantics must be
// discoverable in `batch --help`: routing preferences are ignored inside
// batch (all eligible providers participate; pin to opt out) and search
// fan-out is suppressed — each op runs on exactly its assigned provider.
// ---------------------------------------------------------------------------

describe("batch help distribution semantics", () => {
  it("help documents routing-ignored and fan-out suppression", async () => {
    const { adapter, stdout } = fakeInvocation();
    const status = await main(["batch", "--help"], batchDeps(adapter, []));
    assert.strictEqual(status, 0);
    const help = stdout[0];
    assert.ok(help.includes("routing.<capability> preferences are ignored inside batch"));
    assert.ok(help.includes("(all eligible providers participate; pin to opt out)"));
    assert.ok(help.includes("fan-out is suppressed"));
  });
});
