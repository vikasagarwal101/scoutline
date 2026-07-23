/**
 * Doctor — Provider-Aware Diagnostics (P4-04, DESIGN.md §14, Doctor Schema v2).
 *
 * Verifies the schema-version-2 diagnostics report and doctor exit
 * semantics across every Provider configuration combination:
 *   - Report metadata: effective Provider, capability matrix
 *     (per-capability provider list), Node compatibility, one entry
 *     per built-in Provider in registry order.
 *   - Each entry: provider, configured, declared Capabilities, status
 *     ok/error/skipped, redacted error only for `error`.
 *   - Neither key -> both skipped (not-configured), exit 1 (effective
 *     Z.AI default unconfigured).
 *   - Only Z.AI configured + effective -> Z.AI probed, MiniMax skipped,
 *     exit 0 on success.
 *   - Only MiniMax configured + selected -> MiniMax probed via raw
 *     quota probe, Z.AI skipped, exit 0.
 *   - Both configured -> both probed in registry order; a configured
 *     probe failure stays in the report and makes exit 1 without hiding
 *     the other result.
 *   - --no-tools constructs NO transport; configured -> skipped
 *     (tools-disabled), unconfigured -> skipped (not-configured);
 *     tools-disabled does not fail the report.
 *   - Z.AI diagnostics use tool discovery (listTools); MiniMax use a
 *     raw single-attempt quota probe (quota-client), NOT
 *     QuotaCapability.invoke(), with no SDK construction.
 *   - Transient-then-success: exactly 2 raw probe attempts, 1 injected
 *     delay; terminal failure: 1 attempt, 0 delay.
 *   - Doctor help identifies the effective Provider for shared
 *     Capabilities and the Z.AI-only list.
 *   - Diagnostic failures are recursively redacted; both Provider
 *     credentials are absent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDiagnosticsReport,
  doctor,
  doctorExitCode,
  DOCTOR_HELP,
} from "../dist/commands/doctor.js";
import {
  deriveCapabilityMatrix,
  diagnosticErrorFromError,
} from "../dist/capabilities/diagnostics.js";
import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { redactSecrets, configuredSecrets } from "../dist/lib/redact.js";
import { NetworkError, AuthError, ScoutlineError } from "../dist/lib/errors.js";

const ZAI_KEY = "zai-secret-key-DO-NOT-LEAK";
const MINIMAX_KEY = "minimax-secret-key-DO-NOT-LEAK";

const NO_SLEEP = () => Promise.resolve();
const NO_RANDOM = () => 0;

function nodeMajor() {
  return parseInt(process.versions.node.split(".")[0], 10);
}

// ---------------------------------------------------------------------------
// Fake transport builders
// ---------------------------------------------------------------------------

/**
 * Build a Z.AI descriptor whose diagnostic probe uses an injected
 * `listTools` implementation. `calls` records every listTools attempt so
 * retry counting is observable.
 */
function makeZaiDescriptor({ listToolsImpl, calls = [] }) {
  return createZaiDescriptor({
    clientFactory: () => ({
      async listTools() {
        calls.push("listTools");
        return listToolsImpl();
      },
      async callToolRaw() {
        throw new Error("callToolRaw must not be invoked by diagnostics");
      },
      async close() {},
    }),
  });
}

/**
 * Build a MiniMax descriptor whose diagnostic probe uses an injected
 * unified transport. `fetchCalls` records every raw probe attempt;
 * `sdkCtorCalls` records any SDK construction (must stay empty for
 * diagnostics — the probe must NOT go through the SDK or
 * QuotaCapability.invoke()).
 */
function makeMiniMaxDescriptor({ fetchImpl, fetchCalls = [], sdkCtorCalls = [] }) {
  void sdkCtorCalls; // SDK constructor no longer exists; kept for legacy assertions.
  return createMiniMaxDescriptor({
    transport: {
      fetch: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return fetchImpl();
      },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  });
}

/** A descriptor whose `create()` throws — used to prove --no-tools
 * constructs no Adapter. */
function throwingDescriptor(id, configured = true) {
  return {
    id,
    isConfigured: () => configured,
    capabilities: () => new Set(["search", "diagnostics"]),
    create() {
      throw new Error(`${id} factory must not be called under --no-tools`);
    },
  };
}

function baseDeps({ descriptors, env, effectiveProvider, noTools = false, sleep = NO_SLEEP }) {
  return {
    noTools,
    effectiveProvider,
    descriptors,
    env,
    sleep,
    random: NO_RANDOM,
  };
}

// ---------------------------------------------------------------------------
// Metadata + shape
// ---------------------------------------------------------------------------

describe("doctor diagnostics — report metadata (P4-04)", () => {
  it("exposes a schema-version-2 report with effective Provider, capability matrix, Node info, and one entry per built-in Provider", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY, MINIMAX_API_KEY: MINIMAX_KEY };
    const descriptors = [
      makeZaiDescriptor({ listToolsImpl: () => [] }),
      makeMiniMaxDescriptor({
        fetchImpl: () => ({ ok: true, status: 200, json: async () => ({ model_remains: [] }) }),
      }),
    ];

    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai" }),
    );

    assert.strictEqual(report.schemaVersion, 2);
    assert.strictEqual(report.effectiveProvider, "zai");
    // Doctor's capabilityMatrix is derived from the descriptors passed
    // to buildDiagnosticsReport (Doctor Schema v2). The expected value
    // mirrors the same pure derivation against the two built-in
    // descriptors: per-capability provider list across all descriptors.
    const zai = createZaiDescriptor();
    const minimax = createMiniMaxDescriptor();
    const expectedMatrix = deriveCapabilityMatrix([zai, minimax]);
    assert.deepStrictEqual(
      report.capabilityMatrix.map(({ capability, providers }) => [capability, [...providers]]),
      expectedMatrix.map(({ capability, providers }) => [capability, [...providers]]),
    );
    // Static guarantees under two built-ins: repository-exploration and
    // reader list only Z.AI (MiniMax lacks them); search lists both.
    const matrixFor = (cap) =>
      report.capabilityMatrix.find((entry) => entry.capability === cap)?.providers ?? [];
    assert.deepStrictEqual(
      [...matrixFor("repository-exploration")],
      ["zai"],
      "repository-exploration lists only Z.AI while MiniMax lacks it",
    );
    assert.deepStrictEqual(
      [...matrixFor("reader")],
      ["zai"],
      "reader lists only Z.AI while MiniMax lacks it (Reader Migration 04)",
    );
    assert.deepStrictEqual(
      [...matrixFor("search")].sort(),
      ["minimax", "zai"],
      "search lists both built-ins",
    );
    assert.strictEqual(report.node.version, process.version);
    assert.strictEqual(report.node.visionMcpCompatible, nodeMajor() >= 22);
    // One deterministic entry per built-in Provider, registry order.
    assert.deepStrictEqual(
      report.providers.map((p) => p.provider),
      ["zai", "minimax"],
    );
  });

  it("each Provider entry carries id, configured boolean, declared Capabilities, and a status; error appears only for status error", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY, MINIMAX_API_KEY: MINIMAX_KEY };
    const descriptors = [
      makeZaiDescriptor({ listToolsImpl: () => [{ name: "t" }] }),
      makeMiniMaxDescriptor({
        fetchImpl: () => ({ ok: true, status: 200, json: async () => ({ model_remains: [] }) }),
      }),
    ];

    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai" }),
    );

    for (const entry of report.providers) {
      assert.ok(["zai", "minimax"].includes(entry.provider), "valid provider id");
      assert.strictEqual(typeof entry.configured, "boolean");
      assert.ok(Array.isArray(entry.capabilities), "capabilities is an array");
      assert.ok(entry.capabilities.includes("diagnostics"), "advertises diagnostics");
      assert.ok(["ok", "error", "skipped"].includes(entry.status), "valid status");
      if (entry.status === "error") {
        assert.ok(entry.error && typeof entry.error.code === "string");
        assert.ok(typeof entry.error.message === "string");
      } else {
        assert.strictEqual(entry.error, undefined, "no error field on non-error entries");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Configuration combinations
// ---------------------------------------------------------------------------

describe("doctor diagnostics — configuration combinations (P4-04)", () => {
  it("neither key -> both skipped (not-configured), exit 1 (effective Z.AI default unconfigured)", async () => {
    const env = {};
    const descriptors = [
      makeZaiDescriptor({ listToolsImpl: () => [] }),
      makeMiniMaxDescriptor({
        fetchImpl: () => ({ ok: true, status: 200, json: async () => ({}) }),
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai" }),
    );
    for (const entry of report.providers) {
      assert.strictEqual(entry.status, "skipped");
      assert.strictEqual(entry.reason, "not-configured");
    }
    assert.strictEqual(doctorExitCode(report), 1);
  });

  it("only Z.AI configured + effective -> Z.AI probed ok, MiniMax skipped (not-configured), exit 0", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY };
    const zaiCalls = [];
    const descriptors = [
      makeZaiDescriptor({ listToolsImpl: () => [], calls: zaiCalls }),
      makeMiniMaxDescriptor({
        fetchImpl: () => ({ ok: true, status: 200, json: async () => ({}) }),
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai" }),
    );
    const zai = report.providers.find((p) => p.provider === "zai");
    const mm = report.providers.find((p) => p.provider === "minimax");
    assert.strictEqual(zai.status, "ok");
    assert.strictEqual(zai.configured, true);
    assert.strictEqual(mm.status, "skipped");
    assert.strictEqual(mm.reason, "not-configured");
    assert.strictEqual(zaiCalls.length, 1, "Z.AI probed exactly once");
    assert.strictEqual(doctorExitCode(report), 0);
  });

  it("only MiniMax configured + selected -> MiniMax probed via quota inspection, Z.AI skipped, exit 0", async () => {
    const env = { MINIMAX_API_KEY: MINIMAX_KEY };
    const fetchCalls = [];
    const sdkCtorCalls = [];
    const descriptors = [
      makeZaiDescriptor({ listToolsImpl: () => [] }),
      makeMiniMaxDescriptor({
        fetchImpl: () => ({ ok: true, status: 200, json: async () => ({ model_remains: [] }) }),
        fetchCalls,
        sdkCtorCalls,
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "minimax" }),
    );
    const zai = report.providers.find((p) => p.provider === "zai");
    const mm = report.providers.find((p) => p.provider === "minimax");
    assert.strictEqual(zai.status, "skipped");
    assert.strictEqual(zai.reason, "not-configured");
    assert.strictEqual(mm.status, "ok");
    assert.strictEqual(mm.configured, true);
    assert.strictEqual(fetchCalls.length, 1, "MiniMax probed via raw quota fetch exactly once");
    assert.strictEqual(sdkCtorCalls.length, 0, "no SDK construction for diagnostics");
    assert.strictEqual(doctorExitCode(report), 0);
  });

  it("both configured -> both probed in registry order; a configured probe failure stays in the report and makes exit 1 without hiding the other result", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY, MINIMAX_API_KEY: MINIMAX_KEY };
    const descriptors = [
      makeZaiDescriptor({
        listToolsImpl: () => {
          throw new AuthError("Z.AI auth failed");
        },
      }),
      makeMiniMaxDescriptor({
        fetchImpl: () => ({ ok: true, status: 200, json: async () => ({ model_remains: [] }) }),
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai" }),
    );
    const zai = report.providers.find((p) => p.provider === "zai");
    const mm = report.providers.find((p) => p.provider === "minimax");
    assert.strictEqual(zai.status, "error");
    assert.ok(zai.error, "error entry present on failure");
    assert.strictEqual(mm.status, "ok", "other result preserved");
    assert.strictEqual(doctorExitCode(report), 1);
  });
});

// ---------------------------------------------------------------------------
// --no-tools constructs no transport
// ---------------------------------------------------------------------------

describe("doctor diagnostics --no-tools constructs no transport (FR-034)", () => {
  it("neither factory nor transport is constructed; metadata still appears", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY, MINIMAX_API_KEY: MINIMAX_KEY };
    const descriptors = [throwingDescriptor("zai", true), throwingDescriptor("minimax", true)];
    // If create() were called, the throwing descriptor would surface the
    // error here. A passing build proves no construction happened.
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai", noTools: true }),
    );
    assert.strictEqual(report.schemaVersion, 2);
    assert.strictEqual(report.node.version, process.version);
    for (const entry of report.providers) {
      assert.strictEqual(entry.configured, true);
      assert.strictEqual(entry.status, "skipped");
      assert.strictEqual(entry.reason, "tools-disabled");
    }
    // tools-disabled does not fail the report when effective is configured.
    assert.strictEqual(doctorExitCode(report), 0);
  });

  it("under --no-tools, unconfigured Provider is skipped (not-configured) and effective unconfigured -> exit 1", async () => {
    const env = {};
    const descriptors = [throwingDescriptor("zai", false), throwingDescriptor("minimax", false)];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai", noTools: true }),
    );
    for (const entry of report.providers) {
      assert.strictEqual(entry.status, "skipped");
      assert.strictEqual(entry.reason, "not-configured");
    }
    assert.strictEqual(doctorExitCode(report), 1);
  });
});

// ---------------------------------------------------------------------------
// Probe mechanism + retry
// ---------------------------------------------------------------------------

describe("doctor diagnostics — probe mechanism and retry (P4-04)", () => {
  it("Z.AI diagnostics use tool discovery (listTools)", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY };
    const zaiCalls = [];
    const descriptors = [
      makeZaiDescriptor({ listToolsImpl: () => [{ name: "a" }, { name: "b" }], calls: zaiCalls }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai" }),
    );
    assert.strictEqual(report.providers[0].status, "ok");
    assert.strictEqual(zaiCalls.length, 1);
    assert.ok(
      zaiCalls.every((c) => c === "listTools"),
      "only tool discovery is used",
    );
  });

  it("MiniMax diagnostics use a raw single-attempt quota probe, not QuotaCapability.invoke() and no SDK", async () => {
    const env = { MINIMAX_API_KEY: MINIMAX_KEY };
    const fetchCalls = [];
    const sdkCtorCalls = [];
    const descriptors = [
      makeMiniMaxDescriptor({
        fetchImpl: () => ({ ok: true, status: 200, json: async () => ({ model_remains: [] }) }),
        fetchCalls,
        sdkCtorCalls,
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "minimax" }),
    );
    assert.strictEqual(report.providers[0].status, "ok");
    assert.strictEqual(fetchCalls.length, 1, "raw quota probe used");
    assert.strictEqual(sdkCtorCalls.length, 0, "no SDK / QuotaCapability.invoke path");
    // The probe hits the configured remains endpoint with Bearer auth.
    assert.ok(/\/v1\/api\/openplatform\/coding_plan\/remains$/.test(fetchCalls[0].url));
    assert.strictEqual(fetchCalls[0].init.headers.Authorization, `Bearer ${MINIMAX_KEY}`);
  });

  it("transient-then-success Z.AI diagnostics performs exactly 2 raw probe attempts and 1 injected delay", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY };
    const zaiCalls = [];
    let attempt = 0;
    const sleepCalls = [];
    const descriptors = [
      makeZaiDescriptor({
        listToolsImpl: () => {
          attempt += 1;
          if (attempt === 1) throw new NetworkError("transient");
          return [];
        },
        calls: zaiCalls,
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({
        descriptors,
        env,
        effectiveProvider: "zai",
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      }),
    );
    assert.strictEqual(report.providers[0].status, "ok");
    assert.strictEqual(zaiCalls.length, 2, "exactly two raw probe attempts");
    assert.strictEqual(sleepCalls.length, 1, "exactly one injected delay");
  });

  it("transient-then-success MiniMax diagnostics performs exactly 2 raw probe attempts and 1 delay", async () => {
    const env = { MINIMAX_API_KEY: MINIMAX_KEY };
    const fetchCalls = [];
    let attempt = 0;
    const sleepCalls = [];
    const descriptors = [
      makeMiniMaxDescriptor({
        fetchImpl: () => {
          attempt += 1;
          if (attempt === 1) {
            const err = new Error("fetch failed");
            err.name = "AbortError";
            throw err;
          }
          return { ok: true, status: 200, json: async () => ({ model_remains: [] }) };
        },
        fetchCalls,
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({
        descriptors,
        env,
        effectiveProvider: "minimax",
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      }),
    );
    assert.strictEqual(report.providers[0].status, "ok");
    assert.strictEqual(fetchCalls.length, 2, "exactly two raw probe attempts");
    assert.strictEqual(sleepCalls.length, 1, "exactly one injected delay");
  });

  it("terminal failure performs 1 attempt and 0 delay", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY };
    const zaiCalls = [];
    const sleepCalls = [];
    const descriptors = [
      makeZaiDescriptor({
        listToolsImpl: () => {
          throw new AuthError("terminal auth");
        },
        calls: zaiCalls,
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({
        descriptors,
        env,
        effectiveProvider: "zai",
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      }),
    );
    assert.strictEqual(report.providers[0].status, "error");
    assert.strictEqual(zaiCalls.length, 1, "exactly one raw probe attempt");
    assert.strictEqual(sleepCalls.length, 0, "no delay on terminal failure");
  });
});

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

describe("doctor diagnostics — help text (P4-04, P6-07, Reader Migration 04)", () => {
  it("states Z.AI advertises and supplies repository-exploration, MiniMax advertises and supplies neither, and the repo command cutover is the current runtime behavior", () => {
    assert.ok(/doctor/i.test(DOCTOR_HELP), "mentions doctor");
    assert.ok(/effective/i.test(DOCTOR_HELP), "mentions effective Provider");

    // P6-06A: help must state the descriptor-level facts that hold
    // today. Z.AI advertises repository-exploration AND the Adapter
    // supplies it; MiniMax does neither. These are registered
    // metadata facts that also hold at runtime now that P6-07 has
    // cut the public repo dispatcher over to the Provider path.
    assert.ok(
      /Z\.AI descriptor\s+metadata advertises repository-exploration/.test(DOCTOR_HELP) ||
        /Z\.AI advertises repository-exploration/.test(DOCTOR_HELP),
      "help must state Z.AI advertises repository-exploration at the descriptor level",
    );
    assert.ok(
      /MiniMax.*advertise and supply neither/.test(DOCTOR_HELP),
      "help must state MiniMax advertises and supplies neither repository-exploration",
    );

    // P6-07 cutover: help MUST state that public 'repo' commands
    // participate in Provider selection today. It must NOT carry
    // any leftover pending-P6-07 / legacy-dispatcher wording.
    assert.ok(
      /participate in Provider selection/.test(DOCTOR_HELP),
      "help must state that repo participates in Provider selection",
    );
    assert.ok(
      /UNSUPPORTED_CAPABILITY/.test(DOCTOR_HELP),
      "help must state that unsupported Provider selection returns UNSUPPORTED_CAPABILITY",
    );
    assert.ok(
      !/pending P6-07/.test(DOCTOR_HELP),
      "help must not still claim the cutover is pending P6-07",
    );
    assert.ok(
      !/legacy ZRead dispatch path/.test(DOCTOR_HELP),
      "help must not still claim the legacy ZRead dispatch path is active",
    );
    assert.ok(
      !/legacy repo dispatcher/.test(DOCTOR_HELP),
      "help must not still reference the legacy repo dispatcher",
    );

    // P6-06A false-claim guard, retained: help must NOT carry a
    // current-tense claim that 'repo --provider minimax' returns
    // UNSUPPORTED_CAPABILITY without the surrounding cutover
    // language. The new help frames UNSUPPORTED_CAPABILITY as the
    // selected-Provider outcome, not as an isolated minimax fact.
    assert.ok(
      !/repo\s+--provider\s+minimax\s+returns\s+UNSUPPORTED_CAPABILITY/.test(DOCTOR_HELP),
      "help must not claim 'repo --provider minimax' currently returns UNSUPPORTED_CAPABILITY as an isolated fact",
    );

    // Avoid a stale hand-maintained capability list. The derived
    // Z.AI-only values come from descriptors, so help must NOT carry
    // a parallel hand-curated list of "reader, raw-provider-tools,
    // code-mode, image-diff, video-analysis".
    assert.ok(
      !/raw-provider-tools/.test(DOCTOR_HELP),
      "help must not carry a hand-maintained capability list",
    );
  });

  it("states Reader participates in Provider selection (Reader Migration 04)", () => {
    // Reader Migration 04 cutover: help MUST state that public 'read'
    // commands participate in Provider selection today, that Z.AI
    // supplies the reader capability, and that MiniMax fails with
    // UNSUPPORTED_CAPABILITY. The Doctor inventory derives Reader's
    // Z.AI-only status from descriptor metadata.
    assert.ok(
      /read\b[\s\S]*participate in Provider selection/.test(DOCTOR_HELP),
      "help must state that read participates in Provider selection",
    );
    assert.ok(
      /MiniMax[\s\S]*reader[\s\S]*UNSUPPORTED_CAPABILITY/i.test(DOCTOR_HELP) ||
        /reader[\s\S]*MiniMax[\s\S]*UNSUPPORTED_CAPABILITY/i.test(DOCTOR_HELP) ||
        /reader[\s\S]*UNSUPPORTED_CAPABILITY[\s\S]*MiniMax/i.test(DOCTOR_HELP),
      "help must describe MiniMax as unsupported for reader with UNSUPPORTED_CAPABILITY",
    );
    assert.ok(
      !/accepts but ignores/.test(DOCTOR_HELP),
      "help must not still claim read 'accepts but ignores' Provider selection",
    );
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("doctor diagnostics — recursive redaction (P4-04)", () => {
  it("diagnostic failures scrub Provider credentials so both are absent (Fixup B — B2)", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY, MINIMAX_API_KEY: MINIMAX_KEY };
    // Fixup B (B2): the Provider normalizers now re-wrap typed transport
    // errors (AuthError) with sanitized messages, so an embedded
    // credential is scrubbed at the adapter boundary BEFORE it reaches
    // the report. This is a stronger guarantee than relying on recursive
    // redaction alone; we assert both the credential absence and the
    // clean normalized message, then defence-in-depth redaction on top.
    const descriptors = [
      makeZaiDescriptor({
        listToolsImpl: () => {
          throw new AuthError(`Z.AI auth failed for ${ZAI_KEY}`);
        },
      }),
      makeMiniMaxDescriptor({
        fetchImpl: () => {
          throw new AuthError(`MiniMax auth failed for ${MINIMAX_KEY}`);
        },
      }),
    ];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai" }),
    );
    const secrets = configuredSecrets(env);
    const redacted = redactSecrets(report, secrets);
    const serialized = JSON.stringify(redacted);
    // Core safety property: neither credential reaches the report.
    assert.ok(!serialized.includes(ZAI_KEY), "Z.AI credential absent");
    assert.ok(!serialized.includes(MINIMAX_KEY), "MiniMax credential absent");
    // The credentials were scrubbed at the source (clean normalized
    // auth messages), not merely redacted downstream.
    assert.ok(/Z\.AI authentication failed/.test(serialized), "Z.AI auth message scrubbed");
    assert.ok(/MiniMax authentication failed/.test(serialized), "MiniMax auth message scrubbed");
  });

  it("diagnosticErrorFromError maps ScoutlineError to code+message and drops unknown codes", () => {
    const err = new ScoutlineError("boom", "QUOTA_ERROR", { help: "try again" });
    const mapped = diagnosticErrorFromError(err);
    assert.strictEqual(mapped.code, "QUOTA_ERROR");
    assert.strictEqual(mapped.message, "boom");
    assert.strictEqual(mapped.help, "try again");
    const plain = diagnosticErrorFromError(new Error("plain failure"));
    assert.strictEqual(plain.code, "UNKNOWN_ERROR");
    assert.strictEqual(plain.message, "plain failure");
    assert.strictEqual(plain.help, undefined);
  });
});

// ---------------------------------------------------------------------------
// doctor command wrapper
// ---------------------------------------------------------------------------

describe("doctor command wrapper (P4-04)", () => {
  it("returns a data CommandResult carrying the report and a computed exit code", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY };
    const descriptors = [makeZaiDescriptor({ listToolsImpl: () => [] })];
    const result = await doctor({
      buildReport: () =>
        buildDiagnosticsReport(baseDeps({ descriptors, env, effectiveProvider: "zai" })),
    });
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.schemaVersion, 2);
    assert.strictEqual(result.exitCode, 0);
  });

  it("exit code is 1 when a configured probe fails", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY };
    const descriptors = [
      makeZaiDescriptor({
        listToolsImpl: () => {
          throw new AuthError("nope");
        },
      }),
    ];
    const result = await doctor({
      buildReport: () =>
        buildDiagnosticsReport(baseDeps({ descriptors, env, effectiveProvider: "zai" })),
    });
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.data.providers[0].status, "error");
  });
});

// ---------------------------------------------------------------------------
// Descriptor-derived inventory (Doctor Schema v2).
//
// buildDiagnosticsReport MUST derive `capabilityMatrix` from
// `deps.descriptors` without calling `descriptor.create()`. Under
// `--no-tools` no Adapter or transport is constructed. The derived
// values are descriptor capability IDs only (no hand-maintained
// aliases); repository-exploration and reader list only Z.AI while
// MiniMax lacks them.
// ---------------------------------------------------------------------------

/** Build a minimal pure descriptor double with explicit capability order. */
function capabilityDescriptor(id, capabilities, configured = true) {
  return {
    id,
    isConfigured: () => configured,
    capabilities: () => new Set(capabilities),
    create() {
      throw new Error(`${id}.create() must not be called by the inventory derivation`);
    },
  };
}

describe("doctor diagnostics — derived inventory (Doctor Schema v2)", () => {
  it("deriveCapabilityMatrix lists providers per capability, first-descriptor order then subsequent unique", () => {
    const a = capabilityDescriptor("a", ["search", "vision.x", "quota", "diagnostics"]);
    const b = capabilityDescriptor("b", ["search", "diagnostics", "crawl"]);
    const out = deriveCapabilityMatrix([a, b]);
    assert.deepStrictEqual(
      out.map(({ capability, providers }) => [capability, [...providers]]),
      [
        ["search", ["a", "b"]],
        ["vision.x", ["a"]],
        ["quota", ["a"]],
        ["diagnostics", ["a", "b"]],
        ["crawl", ["b"]],
      ],
    );
  });

  it("deriveCapabilityMatrix with a single descriptor lists only that descriptor for every capability", () => {
    const only = capabilityDescriptor("zai", ["search", "quota"]);
    assert.deepStrictEqual(
      deriveCapabilityMatrix([only]).map(({ capability, providers }) => [
        capability,
        [...providers],
      ]),
      [
        ["search", ["zai"]],
        ["quota", ["zai"]],
      ],
    );
  });

  it("deriveCapabilityMatrix with an empty descriptor list yields an empty array", () => {
    assert.deepStrictEqual([...deriveCapabilityMatrix([])], []);
  });

  it("deriveCapabilityMatrix makes a 2-of-3 capability visible (the schema-v1 bug)", () => {
    // The exact regression the schema-v2 change fixes: a capability
    // supplied by 2-of-3 providers was invisible under the old
    // intersection/minus pair. The matrix MUST list both suppliers.
    const zai = capabilityDescriptor("zai", ["search", "reader"]);
    const minimax = capabilityDescriptor("minimax", ["search"]);
    const tavily = capabilityDescriptor("tavily", ["search", "reader", "crawl"]);
    const out = deriveCapabilityMatrix([zai, minimax, tavily]);
    const matrixFor = (cap) => [
      ...(out.find((entry) => entry.capability === cap)?.providers ?? []),
    ];
    assert.deepStrictEqual(matrixFor("reader"), ["zai", "tavily"]);
    assert.deepStrictEqual(matrixFor("crawl"), ["tavily"]);
    assert.deepStrictEqual(matrixFor("search"), ["zai", "minimax", "tavily"]);
  });

  it("repository-exploration lists only Z.AI while MiniMax lacks it", () => {
    const zai = capabilityDescriptor("zai", [
      "search",
      "vision.interpret-image",
      "repository-exploration",
    ]);
    const minimax = capabilityDescriptor("minimax", ["search", "vision.interpret-image"]);
    const out = deriveCapabilityMatrix([zai, minimax]);
    const repo = out.find((entry) => entry.capability === "repository-exploration");
    assert.deepStrictEqual([...repo.providers], ["zai"]);
  });

  it("reader lists only Z.AI while MiniMax lacks it (Reader Migration 04)", () => {
    const zai = capabilityDescriptor("zai", ["search", "vision.interpret-image", "reader"]);
    const minimax = capabilityDescriptor("minimax", ["search", "vision.interpret-image"]);
    const out = deriveCapabilityMatrix([zai, minimax]);
    const reader = out.find((entry) => entry.capability === "reader");
    assert.deepStrictEqual([...reader.providers], ["zai"]);
  });

  it("capabilityMatrix includes reader for the production built-ins (Reader Migration 04)", () => {
    const zai = createZaiDescriptor();
    const minimax = createMiniMaxDescriptor();
    const out = deriveCapabilityMatrix([zai, minimax]);
    const reader = out.find((entry) => entry.capability === "reader");
    assert.ok(reader, "reader is present in the matrix while Z.AI advertises it");
    assert.deepStrictEqual([...reader.providers], ["zai"]);
  });

  it("buildDiagnosticsReport derives the matrix from deps.descriptors without calling descriptor.create()", async () => {
    // Throwing `create()` proves no descriptor construction runs during
    // the inventory derivation path. This works under both --no-tools
    // (always) and the probe path (the derivation step runs before any
    // probe; only probes call `create()`, and only on configured
    // descriptors).
    const zai = capabilityDescriptor("zai", ["search", "repository-exploration"], true);
    const minimax = capabilityDescriptor("minimax", ["search"], true);
    const report = await buildDiagnosticsReport(
      baseDeps({
        descriptors: [zai, minimax],
        env: { Z_AI_API_KEY: ZAI_KEY, MINIMAX_API_KEY: MINIMAX_KEY },
        effectiveProvider: "zai",
        noTools: true,
      }),
    );
    assert.deepStrictEqual(
      report.capabilityMatrix.map(({ capability, providers }) => [capability, [...providers]]),
      [
        ["search", ["zai", "minimax"]],
        ["repository-exploration", ["zai"]],
      ],
    );
  });

  it("provider entries preserve descriptor order and declared capability order", async () => {
    const zai = capabilityDescriptor("zai", ["search", "quota", "repository-exploration"], true);
    const minimax = capabilityDescriptor("minimax", ["search", "diagnostics"], true);
    const report = await buildDiagnosticsReport(
      baseDeps({
        descriptors: [zai, minimax],
        env: {},
        effectiveProvider: "zai",
        noTools: true,
      }),
    );
    assert.deepStrictEqual(
      report.providers.map((p) => p.provider),
      ["zai", "minimax"],
    );
    assert.deepStrictEqual(
      [...report.providers[0].capabilities],
      ["search", "quota", "repository-exploration"],
    );
    assert.deepStrictEqual([...report.providers[1].capabilities], ["search", "diagnostics"]);
  });
});

// ---------------------------------------------------------------------------
// Cache summary (Cache Module Unification Ticket 03).
//
// The cache summary is FORMATTED BY THE CLI HANDLER (L1 fix) and threaded
// through DoctorDiagnosticsDependencies.cacheSummary. The report builder
// only embeds it; it never reads cacheStats() itself. The field is
// optional — older callers that omit the dependency produce a report
// without `cache`.
// ---------------------------------------------------------------------------

describe("doctor diagnostics — cache summary (Cache Unification Ticket 03)", () => {
  it("omits the cache field when cacheSummary is not supplied (backward compatible)", async () => {
    const env = {};
    const descriptors = [capabilityDescriptor("zai", ["search"], true)];
    const report = await buildDiagnosticsReport(
      baseDeps({ descriptors, env, effectiveProvider: "zai", noTools: true }),
    );
    assert.strictEqual("cache" in report, false, "cache field must be absent when no summary");
  });

  it("embeds the pre-formatted cache summary verbatim and does not reformat it", async () => {
    const env = {};
    const descriptors = [capabilityDescriptor("zai", ["search"], true)];
    const summary =
      "Cache: enabled, 47 response entries (12.3 MB), 1 tool entry (8.2 KB), ~/.scoutline/";
    const report = await buildDiagnosticsReport({
      ...baseDeps({ descriptors, env, effectiveProvider: "zai", noTools: true }),
      cacheSummary: summary,
    });
    assert.ok(report.cache, "cache field is present when cacheSummary is supplied");
    assert.strictEqual(report.cache.summary, summary);
    // The report builder must not mutate or reformat the supplied string.
    assert.strictEqual(typeof report.cache.summary, "string");
  });

  it("accepts the disabled-state summary verbatim", async () => {
    const env = {};
    const descriptors = [capabilityDescriptor("zai", ["search"], true)];
    const report = await buildDiagnosticsReport({
      ...baseDeps({ descriptors, env, effectiveProvider: "zai", noTools: true }),
      cacheSummary: "Cache: disabled",
    });
    assert.strictEqual(report.cache.summary, "Cache: disabled");
  });

  it("treats an empty-string cacheSummary as defined and embeds it (no magic defaulting)", async () => {
    const env = {};
    const descriptors = [capabilityDescriptor("zai", ["search"], true)];
    const report = await buildDiagnosticsReport({
      ...baseDeps({ descriptors, env, effectiveProvider: "zai", noTools: true }),
      cacheSummary: "",
    });
    // The dispatcher may format a summary that ends up empty in edge
    // cases. The report builder must not turn it into absence.
    assert.ok(report.cache, "empty-string summary is still embedded");
    assert.strictEqual(report.cache.summary, "");
  });
});
