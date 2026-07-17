/**
 * Doctor — Provider-Aware Diagnostics (P4-04, DESIGN.md §14).
 *
 * Verifies the schema-version-1 diagnostics report and doctor exit
 * semantics across every Provider configuration combination:
 *   - Report metadata: effective Provider, shared Capabilities,
 *     Z.AI-only Capabilities, Node compatibility, one entry per
 *     built-in Provider in registry order.
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
  SHARED_CAPABILITIES,
  ZAI_ONLY_CAPABILITIES,
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
 * raw quota fetch. `fetchCalls` records every raw probe attempt;
 * `sdkCtorCalls` records any SDK construction (must stay empty for
 * diagnostics — the probe must NOT go through the SDK or
 * QuotaCapability.invoke()).
 */
function makeMiniMaxDescriptor({ fetchImpl, fetchCalls = [], sdkCtorCalls = [] }) {
  return createMiniMaxDescriptor({
    sdkConstructor: function MockSdk() {
      sdkCtorCalls.push("sdkConstructor");
      return {};
    },
    quotaFetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return fetchImpl();
    },
    quotaSetTimeout: () => 0,
    quotaClearTimeout: () => {},
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
  it("exposes a schema-version-1 report with effective Provider, shared + Z.AI-only lists, Node info, and one entry per built-in Provider", async () => {
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

    assert.strictEqual(report.schemaVersion, 1);
    assert.strictEqual(report.effectiveProvider, "zai");
    assert.deepStrictEqual(
      [...SHARED_CAPABILITIES],
      ["search", "vision.interpret-image", "quota", "diagnostics"],
    );
    assert.deepStrictEqual(
      [...ZAI_ONLY_CAPABILITIES],
      [
        "reader",
        "repository-exploration",
        "raw-provider-tools",
        "code-mode",
        "image-diff",
        "video-analysis",
      ],
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
    assert.strictEqual(report.schemaVersion, 1);
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

describe("doctor diagnostics — help text (P4-04)", () => {
  it("identifies the effective Provider for shared Capabilities and the Z.AI-only list", () => {
    assert.ok(/doctor/i.test(DOCTOR_HELP), "mentions doctor");
    assert.ok(/effective/i.test(DOCTOR_HELP), "mentions effective Provider");
    for (const cap of ZAI_ONLY_CAPABILITIES) {
      assert.ok(DOCTOR_HELP.includes(cap), `help lists Z.AI-only capability ${cap}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("doctor diagnostics — recursive redaction (P4-04)", () => {
  it("diagnostic failures are redacted so both Provider credentials are absent", async () => {
    const env = { Z_AI_API_KEY: ZAI_KEY, MINIMAX_API_KEY: MINIMAX_KEY };
    // AuthError instances pass through Provider normalizers unchanged, so
    // their messages (with embedded credentials) reach the report and
    // exercise recursive redaction as a defence-in-depth.
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
    assert.ok(!serialized.includes(ZAI_KEY), "Z.AI credential absent");
    assert.ok(!serialized.includes(MINIMAX_KEY), "MiniMax credential absent");
    assert.ok(serialized.includes("[REDACTED]"), "redaction marker present");
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
    assert.strictEqual(result.data.schemaVersion, 1);
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
