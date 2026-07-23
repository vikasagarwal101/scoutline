/**
 * T3a — shared `SearchControls.type` ("video") contract.
 *
 * Covers the cross-cutting concerns that live OUTSIDE any single adapter:
 *   - `parseAndValidateType` direct contract (mirrors `parseAndValidateTopic`)
 *   - mutual exclusivity of `--type` and `--topic` enforced at parse time,
 *     BEFORE provider resolution / credential check
 *   - `type` flowing through `search()` options into the cache identity
 *
 * Per-adapter rejection of `type` (`UNSUPPORTED_OPTION`) is asserted in
 * each adapter's own suite:
 *   - tests/zai-adapter.test.js
 *   - tests/minimax-adapter.test.js
 *   - tests/tavily-adapter.test.js
 *   - tests/brave-adapter.test.js
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { main, parseAndValidateType } from "../dist/index.js";
import { search } from "../dist/commands/search.js";

// --- fake capability + execution deps (mirror search.test.js helpers) ---

function makeFakeCapability(resultsByQuery = {}) {
  const identities = [];
  const capability = {
    validate() {},
    cacheIdentity(request) {
      const identity = {
        provider: "zai",
        capability: "search",
        credentialFingerprint: "fake-fingerprint",
        request: {
          query: request.query,
          ...(request.controls ? { controls: request.controls } : {}),
        },
        legacyCandidates: [],
      };
      identities.push({ request, identity });
      return identity;
    },
    async invoke(request) {
      return resultsByQuery[request.query] ?? [];
    },
  };
  return { capability, identities };
}

function makeExecDeps(capability) {
  const store = new Map();
  return {
    capability,
    cache: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    sleep: async () => {},
    random: () => 0.5,
  };
}

function makeContext() {
  const notices = [];
  return {
    context: {
      stdinIsTTY: false,
      readStdin: async () => "",
      notice: (msg) => notices.push(msg),
    },
    notices,
  };
}

function createTestAdapter(overrides = {}) {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
      ...overrides,
    },
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// parseAndValidateType — direct validation contract
// ---------------------------------------------------------------------------

describe("parseAndValidateType — direct validation contract (T3a)", () => {
  it("returns undefined when the raw value is undefined / empty", () => {
    assert.strictEqual(parseAndValidateType(undefined), undefined);
    assert.strictEqual(parseAndValidateType(""), undefined);
  });

  it("throws VALIDATION_ERROR for --type without a value (parser delivers true)", () => {
    assert.throws(
      () => parseAndValidateType(true),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("returns the value for valid types", () => {
    assert.strictEqual(parseAndValidateType("video"), "video");
  });

  it("rejects an invalid type with VALIDATION_ERROR", () => {
    assert.throws(
      () => parseAndValidateType("image"),
      (err) => err.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => parseAndValidateType("VIDEO"),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });
});

// ---------------------------------------------------------------------------
// Mutual exclusivity: --type and --topic are rejected at parse time,
// before provider resolution / credential check.
// ---------------------------------------------------------------------------

describe("--type / --topic mutual exclusivity (parse-time, T3a)", () => {
  it("--type video --topic news with NO credentials yields VALIDATION_ERROR, not CONFIGURATION_ERROR", async () => {
    const { adapter, stderr } = createTestAdapter();
    // No providerDescriptors override -> real built-in descriptors. No
    // credentials in env -> the provider is unconfigured. Mutual-
    // exclusivity validation MUST fire first (before the configuration
    // gate), mirroring the --count ordering test.
    const status = await main(["search", "q", "--type", "video", "--topic", "news"], {
      invocation: adapter,
      env: {},
    });
    assert.strictEqual(status, 1, "invalid combo must exit 1 even with no credentials");
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(
      parsed.code,
      "VALIDATION_ERROR",
      `expected VALIDATION_ERROR, got ${parsed.code}`,
    );
    assert.match(parsed.error, /mutually exclusive/i);
  });

  it("--type video alone with NO credentials yields CONFIGURATION_ERROR (parse passes, config gate fires)", async () => {
    // Sanity: --type video by itself is a VALID parse. With no credentials
    // it must reach the configuration gate (CONFIGURATION_ERROR), proving
    // the parse-time gate only rejects the COMBO, not --type alone.
    const { adapter, stderr } = createTestAdapter();
    const status = await main(["search", "q", "--type", "video"], {
      invocation: adapter,
      env: {},
    });
    assert.strictEqual(status, 3, "valid --type with no credentials must exit 3");
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "CONFIGURATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Cache identity: `type` enters the request identity generically.
// ---------------------------------------------------------------------------

describe("search command — type in cache identity (T3a)", () => {
  it("two requests differing only in type produce different cache identities", async () => {
    const fake = makeFakeCapability({ q: [] });
    const { context } = makeContext();
    await search("q", { type: "video" }, makeExecDeps(fake.capability), context);
    await search("q", {}, makeExecDeps(fake.capability), context);
    assert.strictEqual(fake.identities.length, 2);
    const withType = JSON.stringify(fake.identities[0].identity.request.controls);
    const withoutType = JSON.stringify(fake.identities[1].identity.request.controls);
    assert.notStrictEqual(withType, withoutType);
    assert.match(withType, /"type":"video"/);
  });
});
