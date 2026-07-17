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

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
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
      assert.fail(
        "Z_AI_API_KEY is required for live-release mode but was not provided",
      );
      return;
    }
    if (!zaiConfigured) {
      // test:live mode allows an unconfigured Provider to skip silently.
      return;
    }
    const query = liveQuery("zai");
    const data = await runLiveSearch(
      ["search", query, "--count", "3", "--no-cache"],
      { ...process.env, Z_AI_API_KEY: ZAI_KEY },
    );
    assertSearchShape(data);
  });

  it("Z.AI Adapter invoked directly (no cache) returns the documented shape", async () => {
    if (!zaiConfigured) return;
    const descriptor = createZaiDescriptor();
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: ZAI_KEY } });
    assert.strictEqual(typeof adapter.search, "object", "Z.AI descriptor must expose a Search capability");
    const query = liveQuery("zai-adapter");
    const sources = await adapter.search.invoke({ query });
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
      assert.fail(
        "MINIMAX_API_KEY is required for live-release mode but was not provided",
      );
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
    assert.strictEqual(typeof adapter.search, "object", "MiniMax descriptor must expose a Search capability");
    const query = liveQuery("minimax-adapter");
    const sources = await adapter.search.invoke({ query });
    assertSearchShape(sources);
  });
});