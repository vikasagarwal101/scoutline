/**
 * Developer live Provider Search tests (P2-06).
 *
 * Gated by:
 *   - SCOUTLINE_LIVE_TESTS=1      — required for any live test to run.
 *   - Z_AI_API_KEY                 — required for the Z.AI Search case.
 *   - MINIMAX_API_KEY              — required for the MiniMax Search case.
 *
 * Modes:
 *   - `npm run test:live`         — runs both Providers; an unconfigured
 *                                   Provider is skipped (no failure).
 *   - `npm run test:live:release` — preflight requires BOTH credentials;
 *                                   the suite fails on ANY skip. At GATE-2
 *                                   the release-live preflight requires
 *                                   Search for both Providers; Phase 3
 *                                   extends it with general Vision.
 *
 * Semantic shape only:
 *   - The assertion NEVER snapshots a full live Provider response.
 *   - The assertion NEVER logs response titles, snippets, links, or
 *     other live content.
 *   - The assertion checks: a nonempty ordered list, valid HTTP(S) URL,
 *     nonempty title, and nonempty summary. That shape is the contract
 *     the production Search Capability promises callers; the live call
 *     is the developer-facing smoke for it.
 *
 * Raw Z.AI MCP live coverage lives in mcp-live.test.js and remains
 * intentionally separate from Normal Search conformance here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import {
  deriveSharedCapabilities,
  deriveZaiOnlyCapabilities,
} from "../dist/capabilities/diagnostics.js";
import { main } from "../dist/index.js";
import { createNodeCommandInvocationAdapter } from "../dist/node-command-invocation-adapter.js";

// ---------------------------------------------------------------------------
// Live gating + test mode
// ---------------------------------------------------------------------------

const SCOUTLINE_LIVE = process.env.SCOUTLINE_LIVE_TESTS === "1";
const RELEASE = process.env.SCOUTLINE_LIVE_MODE === "release";
const ZAI_KEY = process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY || "";
const MINIMAX_KEY = process.env.MINIMAX_API_KEY || "";

const zaiConfigured = Boolean(ZAI_KEY);
const minimaxConfigured = Boolean(MINIMAX_KEY);

// In offline/non-live runs, skip everything silently.
const describeIfLive = SCOUTLINE_LIVE ? describe : describe.skip;
// In release mode, fail the suite if a Provider is not configured.
// The runner enforces this preflight; tests here still skip cleanly if
// the env gate is unset, but the runner's preflight will already have
// exited before this file runs.
const requireConfigured = RELEASE ? Boolean : () => true;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A unique, deterministic per-run live query. Time-based ensures a fresh
 * request hits the live Provider (no on-disk cache serves the answer).
 * The query string itself is also low-signal so it is safe to log in a
 * failure message without disclosing user content.
 */
function liveQuery(label) {
  return `scoutline-p2-06-${label}-${Date.now()}`;
}

/**
 * Invoke an adapter capability with a small retry for transient API errors.
 * Adapters perform one attempt by design; shared execution owns retry policy.
 * Direct adapter tests bypass executeSearch, so we add a minimal retry here
 * to handle live API transient 500/502/503/504 responses.
 */
async function retryAdapterInvoke(invoke, request, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await invoke(request);
    } catch (err) {
      lastError = err;
      const retryable = err?.code === "API_ERROR" && [500, 502, 503, 504].includes(err?.statusCode);
      if (!retryable || attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Invoke `scoutline search <query>` end-to-end through the production
 * `main` dispatch. Returns the parsed JSON data array, or rejects with
 * an AssertionError containing the redacted stderr envelope. We never
 * log the live response content; if it fails, only the structured error
 * envelope is surfaced.
 */
async function runLiveSearch(args, env) {
  const writes = [];
  const adapter = {
    ...createNodeCommandInvocationAdapter(),
    writeStdout(value) {
      writes.push({ stream: "stdout", value });
    },
    writeStderr(value) {
      writes.push({ stream: "stderr", value });
    },
  };
  const code = await main(args, { invocation: adapter, env });
  const stdout = writes
    .filter((w) => w.stream === "stdout")
    .map((w) => w.value)
    .join("\n")
    .trim();
  const stderr = writes
    .filter((w) => w.stream === "stderr")
    .map((w) => w.value)
    .join("\n")
    .trim();
  if (code !== 0) {
    let envelope;
    try {
      envelope = JSON.parse(stderr || stdout);
    } catch {
      envelope = { success: false, error: stderr || stdout, code: "UNKNOWN_ERROR" };
    }
    throw new Error(
      `live search failed (exit ${code}): ${envelope.code || "UNKNOWN_ERROR"}: ${envelope.error || ""}`.trim(),
    );
  }
  return JSON.parse(stdout);
}

function assertSearchShape(results) {
  assert.ok(
    Array.isArray(results) && results.length > 0,
    "live search must return a nonempty ordered list",
  );
  // Order: the first entry is the highest-ranked live result.
  for (const [i, r] of results.entries()) {
    assert.ok(r && typeof r === "object", `result ${i} must be an object`);
    assert.strictEqual(typeof r.title, "string", `result ${i} title must be a string`);
    assert.ok(r.title.length > 0, `result ${i} title must be nonempty`);
    assert.strictEqual(typeof r.url, "string", `result ${i} url must be a string`);
    assert.ok(
      /^https?:\/\//i.test(r.url),
      `result ${i} url must be a valid HTTP(S) URL (got "${typeof r.url === "string" ? r.url.slice(0, 16) + "…" : r.url}")`,
    );
    assert.strictEqual(typeof r.summary, "string", `result ${i} summary must be a string`);
    assert.ok(r.summary.length > 0, `result ${i} summary must be nonempty`);
  }
}

// ---------------------------------------------------------------------------
// Z.AI live Search case
// ---------------------------------------------------------------------------

describeIfLive("Provider live Search — Z.AI", () => {
  it("Normal Search through the public scoutline command returns the documented shape", async () => {
    if (!requireConfigured(zaiConfigured)) {
      // Release mode requires the credential; the runner preflight should
      // have already failed. Defensive guard.
      assert.fail("Z_AI_API_KEY is required for live-release mode but was not provided");
      return;
    }
    if (!zaiConfigured) {
      // test:live mode allows an unconfigured Provider to skip silently.
      return;
    }
    const query = liveQuery("zai");
    const data = await runLiveSearch(["search", query, "--count", "3", "--no-cache"], {
      ...process.env,
      Z_AI_API_KEY: ZAI_KEY,
    });
    assertSearchShape(data);
  });

  it("Z.AI Adapter invoked directly (no cache) returns the documented shape", async () => {
    if (!zaiConfigured) return;
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: ZAI_KEY } });
    assert.strictEqual(
      typeof adapter.search,
      "object",
      "Z.AI descriptor must expose a Search capability",
    );
    const query = liveQuery("zai-adapter");
    const sources = await retryAdapterInvoke(adapter.search.invoke.bind(adapter.search), { query });
    assertSearchShape(sources);
    await adapter.search.invoke({ query: "noop" }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// MiniMax live Search case
// ---------------------------------------------------------------------------

describeIfLive("Provider live Search — MiniMax", () => {
  it("Normal Search through the public scoutline command returns the documented shape", async () => {
    if (!requireConfigured(minimaxConfigured)) {
      assert.fail("MINIMAX_API_KEY is required for live-release mode but was not provided");
      return;
    }
    if (!minimaxConfigured) {
      return;
    }
    const query = liveQuery("minimax");
    const data = await runLiveSearch(
      ["--provider", "minimax", "search", query, "--count", "3", "--no-cache"],
      { ...process.env, MINIMAX_API_KEY: MINIMAX_KEY },
    );
    assertSearchShape(data);
  });

  it("MiniMax Adapter invoked directly returns the documented shape", async () => {
    if (!minimaxConfigured) return;
    const descriptor = createMiniMaxDescriptor();
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: MINIMAX_KEY } });
    assert.strictEqual(
      typeof adapter.search,
      "object",
      "MiniMax descriptor must expose a Search capability",
    );
    const query = liveQuery("minimax-adapter");
    const sources = await retryAdapterInvoke(adapter.search.invoke.bind(adapter.search), { query });
    assertSearchShape(sources);
  });
});

// ---------------------------------------------------------------------------
// Live general Vision conformance (P3-04, FR-026)
//
// One repository-owned fixture (tests/fixtures/vision/general.png) plus a
// versioned instruction with semantic predicates (general.json) is run
// through BOTH Provider Adapters when explicitly opted in. An unconfigured
// Provider is skipped under `test:live`; `test:live:release` requires both.
//
// Semantic shape only:
//   - The assertion NEVER stores, logs, or snapshots a live response, key,
//     authorization value, or raw Provider body.
//   - It checks nonempty text and a conservative set of required concept
//     groups derived from the fixture's observable content. Prose is never
//     compared word-for-word.
// ---------------------------------------------------------------------------

const visionFixtureDir = fileURLToPath(new URL("../tests/fixtures/vision/", import.meta.url));
const visionSpec = JSON.parse(readFileSync(path.join(visionFixtureDir, "general.json"), "utf8"));
const visionImagePath = path.join(visionFixtureDir, visionSpec.image);

/**
 * Invoke `scoutline vision analyze <fixture> <instruction>` end-to-end
 * through `main`. Returns the normalized text. On failure, surfaces only
 * the structured error code (never the response body).
 */
async function runLiveVision(args, env) {
  const writes = [];
  const adapter = {
    ...createNodeCommandInvocationAdapter(),
    writeStdout(value) {
      writes.push(["out", value]);
    },
    writeStderr(value) {
      writes.push(["err", value]);
    },
  };
  const code = await main(args, { invocation: adapter, env });
  const stdout = writes
    .filter((w) => w[0] === "out")
    .map((w) => w[1])
    .join("\n")
    .trim();
  const stderr = writes
    .filter((w) => w[0] === "err")
    .map((w) => w[1])
    .join("\n")
    .trim();
  if (code !== 0) {
    let envelope;
    try {
      envelope = JSON.parse(stderr || stdout);
    } catch {
      envelope = { code: "UNKNOWN_ERROR", error: stderr || stdout };
    }
    throw new Error(
      `live vision failed (exit ${code}): ${envelope.code || "UNKNOWN_ERROR"}`.trim(),
    );
  }
  // `vision analyze` in data mode writes the normalized text as a JSON string.
  return JSON.parse(stdout);
}

/**
 * Assert the live Vision text satisfies the fixture's semantic predicates.
 * Never logs the response text; failure messages name only the missing
 * concept group, not the prose.
 */
function assertVisionConformance(text) {
  assert.ok(typeof text === "string", "vision result must be a string");
  assert.ok(text.trim().length > 0, "vision result must be nonempty (forbiddenEmpty)");
  const lower = text.toLowerCase();
  for (const group of visionSpec.predicates.requiredAnyOfGroups) {
    const hit = group.some((term) => lower.includes(term));
    assert.ok(hit, `vision result must mention one of: ${group.join(", ")} (content redacted)`);
  }
}

describeIfLive("Provider live Vision — Z.AI", () => {
  it("general single-image interpretation returns conformant nonempty text", async () => {
    if (!requireConfigured(zaiConfigured)) {
      assert.fail("Z_AI_API_KEY is required for live-release mode but was not provided");
      return;
    }
    if (!zaiConfigured) return;
    const text = await runLiveVision(
      ["vision", "analyze", visionImagePath, visionSpec.instruction],
      { ...process.env, Z_AI_API_KEY: ZAI_KEY },
    );
    assertVisionConformance(text);
  });
});

describeIfLive("Provider live Vision — MiniMax", () => {
  it("general single-image interpretation returns conformant nonempty text", async () => {
    if (!requireConfigured(minimaxConfigured)) {
      assert.fail("MINIMAX_API_KEY is required for live-release mode but was not provided");
      return;
    }
    if (!minimaxConfigured) return;
    const text = await runLiveVision(
      ["--provider", "minimax", "vision", "analyze", visionImagePath, visionSpec.instruction],
      { ...process.env, MINIMAX_API_KEY: MINIMAX_KEY },
    );
    assertVisionConformance(text);
  });
});

// ---------------------------------------------------------------------------
// Live Quota conformance (P4-02/P4-03, DESIGN.md §13, ADR-0001)
//
// Exercises the real Provider quota endpoints (Z.AI monitor API, MiniMax
// direct remains endpoint) through BOTH end-to-end `main` dispatch AND
// direct Adapter invocation. The assertion NEVER snapshots specific
// counts or percentages (they change over time); it checks the normalized
// dashboard shape only.
// ---------------------------------------------------------------------------

/**
 * Capture a `main` dispatch: returns the exit code plus redacted
 * stdout/stderr envelopes. Used by quota tests where all-provider mode
 * may legitimately yield a non-zero exit (any provider failure -> 1).
 */
async function captureMain(args, env) {
  const writes = [];
  const adapter = {
    ...createNodeCommandInvocationAdapter(),
    writeStdout(value) {
      writes.push(["out", value]);
    },
    writeStderr(value) {
      writes.push(["err", value]);
    },
  };
  const code = await main(args, { invocation: adapter, env });
  const stdout = writes
    .filter((w) => w[0] === "out")
    .map((w) => w[1])
    .join("\n")
    .trim();
  const stderr = writes
    .filter((w) => w[0] === "err")
    .map((w) => w[1])
    .join("\n")
    .trim();
  return { code, stdout, stderr };
}

function parseEnvelope(stderr, stdout) {
  try {
    return JSON.parse(stderr || stdout);
  } catch {
    return { success: false, error: stderr || stdout, code: "UNKNOWN_ERROR" };
  }
}

/**
 * Invoke `scoutline quota` end-to-end through `main`. Returns the parsed
 * `QuotaDashboard`. Rejects with a redacted envelope on non-zero exit.
 */
async function runLiveQuota(args, env) {
  const { code, stdout, stderr } = await captureMain(args, env);
  if (code !== 0) {
    const envelope = parseEnvelope(stderr, stdout);
    throw new Error(
      `live quota failed (exit ${code}): ${envelope.code || "UNKNOWN_ERROR"}: ${envelope.error || ""}`.trim(),
    );
  }
  return JSON.parse(stdout);
}

/**
 * Assert a normalized `QuotaDashboard` shape without snapshotting values.
 * Percentages are finite numbers clamped to 0..100; categories carry the
 * required name/unit/current window.
 */
function assertQuotaDashboardShape(dashboard, expectedProvider) {
  assert.ok(dashboard && typeof dashboard === "object", "dashboard must be an object");
  assert.strictEqual(dashboard.schemaVersion, 1, "schemaVersion must be 1");
  assert.strictEqual(
    dashboard.effectiveProvider,
    expectedProvider,
    `effectiveProvider must be ${expectedProvider}`,
  );
  assert.ok(Array.isArray(dashboard.providers), "providers must be an array");
  return dashboard.providers;
}

/**
 * Assert a single successful `ProviderQuotaSuccess` entry. Used for both
 * default-mode dashboard entries and direct Adapter invocation results.
 */
function assertQuotaSuccessShape(entry, expectedProvider) {
  assert.ok(entry && typeof entry === "object", "quota entry must be an object");
  assert.strictEqual(entry.provider, expectedProvider, `provider must be ${expectedProvider}`);
  assert.strictEqual(entry.status, "ok", "status must be ok");
  assert.ok(Array.isArray(entry.categories), "categories must be an array");
  assert.ok(entry.categories.length > 0, "categories must be nonempty");
  for (const [i, cat] of entry.categories.entries()) {
    assert.ok(typeof cat.name === "string" && cat.name.length > 0, `category ${i} name nonempty`);
    assert.ok(cat.unit === "requests" || cat.unit === "tokens", `category ${i} unit valid`);
    assert.ok(cat.current && typeof cat.current === "object", `category ${i} current window`);
    const pct = cat.current.remainingPercent;
    assert.ok(
      typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100,
      `category ${i} remainingPercent in 0..100`,
    );
  }
}

describeIfLive("Provider live Quota — Z.AI", () => {
  it("Normal quota through the public scoutline command returns a schema-version-1 dashboard", async () => {
    if (!requireConfigured(zaiConfigured)) {
      assert.fail("Z_AI_API_KEY is required for live-release mode but was not provided");
      return;
    }
    if (!zaiConfigured) return;
    const dashboard = await runLiveQuota(["quota"], {
      ...process.env,
      Z_AI_API_KEY: ZAI_KEY,
    });
    const providers = assertQuotaDashboardShape(dashboard, "zai");
    assert.strictEqual(providers.length, 1, "default mode lists exactly one provider");
    assertQuotaSuccessShape(providers[0], "zai");
  });

  it("Z.AI Adapter quota invoked directly returns a conformant ProviderQuotaSuccess", async () => {
    if (!zaiConfigured) return;
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: ZAI_KEY } });
    assert.strictEqual(
      typeof adapter.quota,
      "object",
      "Z.AI descriptor must expose a Quota capability",
    );
    const result = await adapter.quota.invoke();
    assertQuotaSuccessShape(result, "zai");
  });
});

describeIfLive("Provider live Quota — MiniMax", () => {
  it("Normal quota through the public scoutline command returns a schema-version-1 dashboard", async () => {
    if (!requireConfigured(minimaxConfigured)) {
      assert.fail("MINIMAX_API_KEY is required for live-release mode but was not provided");
      return;
    }
    if (!minimaxConfigured) return;
    const dashboard = await runLiveQuota(["--provider", "minimax", "quota"], {
      ...process.env,
      MINIMAX_API_KEY: MINIMAX_KEY,
    });
    const providers = assertQuotaDashboardShape(dashboard, "minimax");
    assert.strictEqual(providers.length, 1, "default mode lists exactly one provider");
    assertQuotaSuccessShape(providers[0], "minimax");
    // MiniMax categories are named by model.
    for (const cat of providers[0].categories) {
      assert.ok(cat.unit === "requests", "MiniMax category unit is requests");
    }
  });

  it("MiniMax Adapter quota invoked directly returns a conformant ProviderQuotaSuccess", async () => {
    if (!minimaxConfigured) return;
    const descriptor = createMiniMaxDescriptor();
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: MINIMAX_KEY } });
    assert.strictEqual(
      typeof adapter.quota,
      "object",
      "MiniMax descriptor must expose a Quota capability",
    );
    const result = await adapter.quota.invoke();
    assertQuotaSuccessShape(result, "minimax");
  });
});

describeIfLive("Provider live Quota — all providers", () => {
  it("quota --all-providers lists every configured provider in registry order", async () => {
    if (!requireConfigured(zaiConfigured && minimaxConfigured)) {
      assert.fail("Both Z_AI_API_KEY and MINIMAX_API_KEY are required for live-release mode");
      return;
    }
    if (!zaiConfigured || !minimaxConfigured) return;
    const { code, stdout } = await captureMain(["quota", "--all-providers"], {
      ...process.env,
      Z_AI_API_KEY: ZAI_KEY,
      MINIMAX_API_KEY: MINIMAX_KEY,
    });
    const dashboard = JSON.parse(stdout);
    assertQuotaDashboardShape(dashboard, "zai");
    // Registry order is zai, then minimax.
    assert.deepStrictEqual(
      dashboard.providers.map((p) => p.provider),
      ["zai", "minimax"],
      "registry order preserved",
    );
    // Each entry is either success or failure; both are valid live.
    const allOk = dashboard.providers.every((p) => p.status === "ok");
    const anyError = dashboard.providers.some((p) => p.status === "error");
    if (allOk) {
      assert.strictEqual(code, 0, "exit 0 when every configured provider succeeds");
      for (const entry of dashboard.providers) {
        assertQuotaSuccessShape(entry, entry.provider);
      }
    } else {
      assert.ok(anyError, "at least one error entry present");
      assert.strictEqual(code, 1, "exit 1 when any configured provider fails");
      for (const entry of dashboard.providers) {
        assert.ok(entry.status === "ok" || entry.status === "error", "entry status is ok or error");
        if (entry.status === "ok") assertQuotaSuccessShape(entry, entry.provider);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Live Doctor conformance (P4-04, DESIGN.md §14)
//
// Exercises the real Provider connectivity probes (Z.AI tool discovery,
// MiniMax raw quota probe) through end-to-end `main` dispatch. Under
// --no-tools no transport is constructed and configured providers are
// reported as skipped (tools-disabled).
// ---------------------------------------------------------------------------

/**
 * Invoke `scoutline doctor` end-to-end through `main`. Returns the parsed
 * `DiagnosticsReport`. Rejects with a redacted envelope on non-zero exit.
 */
async function runLiveDoctor(args, env) {
  const { code, stdout, stderr } = await captureMain(args, env);
  if (code !== 0) {
    const envelope = parseEnvelope(stderr, stdout);
    throw new Error(
      `live doctor failed (exit ${code}): ${envelope.code || "UNKNOWN_ERROR"}: ${envelope.error || ""}`.trim(),
    );
  }
  return JSON.parse(stdout);
}

describeIfLive("Provider live Doctor — full probes", () => {
  it("doctor returns a schema-version-1 report with both providers probed", async () => {
    if (!requireConfigured(zaiConfigured && minimaxConfigured)) {
      assert.fail("Both Z_AI_API_KEY and MINIMAX_API_KEY are required for live-release mode");
      return;
    }
    if (!zaiConfigured || !minimaxConfigured) return;
    const report = await runLiveDoctor(["doctor"], {
      ...process.env,
      Z_AI_API_KEY: ZAI_KEY,
      MINIMAX_API_KEY: MINIMAX_KEY,
    });
    assert.strictEqual(report.schemaVersion, 1, "schemaVersion must be 1");
    // Exactly two entries in registry order.
    assert.deepStrictEqual(
      report.providers.map((p) => p.provider),
      ["zai", "minimax"],
      "both built-in providers listed in registry order",
    );
    // Each configured provider probe succeeds against the live endpoint.
    for (const entry of report.providers) {
      assert.strictEqual(entry.configured, true, `${entry.provider} is configured`);
      assert.strictEqual(entry.status, "ok", `${entry.provider} probe succeeded`);
    }
    // Shared capabilities include the base four (attested specialized ops
    // extend this list, so a subset check tracks attestation state).
    const shared = [...report.sharedCapabilities];
    for (const cap of ["search", "vision.interpret-image", "quota", "diagnostics"]) {
      assert.ok(shared.includes(cap), `sharedCapabilities includes ${cap}`);
    }
    // P6-06: Doctor derives sharedCapabilities and zaiOnlyCapabilities
    // from the built-in descriptors (intersection across both for
    // shared, Z.AI-minus-union-of-others for Z.AI-only). The live
    // report MUST match the exact descriptor-derived expectations —
    // no hand-maintained alias list, no parallel base-release set.
    const expectedShared = [
      ...deriveSharedCapabilities([createZaiDescriptor(), createMiniMaxDescriptor()]),
    ];
    const expectedZaiOnly = [
      ...deriveZaiOnlyCapabilities([createZaiDescriptor(), createMiniMaxDescriptor()]),
    ];
    assert.deepStrictEqual(
      shared,
      expectedShared,
      "live sharedCapabilities matches descriptor-derived intersection",
    );
    assert.deepStrictEqual(
      [...report.zaiOnlyCapabilities],
      expectedZaiOnly,
      "live zaiOnlyCapabilities matches descriptor-derived Z.AI-minus-others set",
    );
    // P6-06 invariant: repository-exploration lands in Z.AI-only
    // (Z.AI advertises it, MiniMax does not).
    assert.ok(
      report.zaiOnlyCapabilities.includes("repository-exploration"),
      "repository-exploration is Z.AI-only while MiniMax lacks it",
    );
    assert.ok(
      !report.sharedCapabilities.includes("repository-exploration"),
      "repository-exploration is NOT shared while MiniMax lacks it",
    );
  });
});

describeIfLive("Provider live Doctor — no-tools", () => {
  it("doctor --no-tools skips every configured provider (tools-disabled) and exits 0", async () => {
    if (!requireConfigured(zaiConfigured && minimaxConfigured)) {
      assert.fail("Both Z_AI_API_KEY and MINIMAX_API_KEY are required for live-release mode");
      return;
    }
    if (!zaiConfigured || !minimaxConfigured) return;
    const { code, stdout } = await captureMain(["doctor", "--no-tools"], {
      ...process.env,
      Z_AI_API_KEY: ZAI_KEY,
      MINIMAX_API_KEY: MINIMAX_KEY,
    });
    assert.strictEqual(code, 0, "tools-disabled does not fail the report");
    const report = JSON.parse(stdout);
    assert.strictEqual(report.schemaVersion, 1);
    assert.deepStrictEqual(
      report.providers.map((p) => p.provider),
      ["zai", "minimax"],
      "both built-in providers listed",
    );
    for (const entry of report.providers) {
      assert.strictEqual(entry.configured, true, `${entry.provider} is configured`);
      assert.strictEqual(entry.status, "skipped", `${entry.provider} is skipped`);
      assert.strictEqual(
        entry.reason,
        "tools-disabled",
        `${entry.provider} reason is tools-disabled`,
      );
    }
  });
});
