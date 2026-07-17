/**
 * MiniMax Search Adapter (P2-04, DESIGN.md §12 + §7).
 *
 * Verifies the transitional MiniMax Token Plan Adapter:
 *   - Adapter-local config: required key, default/cn regions, explicit
 *     HTTPS base URL override, trailing-slash normalization, empty
 *     values, non-HTTPS URLs, unknown region.
 *   - SDK construction isolation: sentinel MMX_CONFIG_DIR, unique
 *     nonexistent path observed during construction, restored on
 *     success and throw, path never created.
 *   - Search validation: every unsupported control rejected before
 *     SDK construction or credential access (FR-012).
 *   - Bare query: sdk.search.query receives only the query string.
 *   - Field mapping: organic[].title/link/snippet/date -> normalized.
 *     Malformed responses -> API_ERROR (no raw payload leak).
 *   - Failure normalization: auth, timeout, network, rate-limit,
 *     generic API -> stable public codes and retryability.
 *   - Cache identity: SHA-256 credential fingerprint, key-sorted
 *     request identity, no legacy candidates.
 *
 * Tests pass a fake MiniMaxSdkConstructor explicitly; no real SDK,
 * network, or `mmx` executable is touched.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import crypto from "node:crypto";

import { loadMiniMaxConfig } from "../dist/providers/minimax/config.js";
import { createMiniMaxSdk } from "../dist/providers/minimax/sdk-client.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { readFixture } from "./helpers/fixtures.js";

const TEST_API_KEY = "test-minimax-api-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

// ---------------------------------------------------------------------------
// Fake MiniMax SDK constructor. Captures construction options and the
// argument passed to search.query(). The fake is synchronous in
// construction so the env-override window is observable.
// ---------------------------------------------------------------------------

function makeFakeSdk({ result, error } = {}) {
  const constructed = [];
  const observedEnvAtConstruction = [];
  const queryCalls = [];
  const Constructor = function MockMiniMaxSdk(options) {
    constructed.push(options);
    // Capture the env state the SDK would see during construction.
    observedEnvAtConstruction.push(process.env.MMX_CONFIG_DIR);
    return {
      search: {
        async query(q) {
          queryCalls.push(q);
          if (error) throw error;
          return result;
        },
      },
      vision: {
        async describe() {
          throw new Error("vision not used in Phase 2");
        },
      },
    };
  };
  return { Constructor, constructed, observedEnvAtConstruction, queryCalls };
}

function makeAdapter({ sdk } = {}, env = { MINIMAX_API_KEY: TEST_API_KEY }) {
  const descriptor = createMiniMaxDescriptor({ sdkConstructor: sdk?.Constructor });
  return descriptor.create({ env });
}

// ---------------------------------------------------------------------------
// Adapter-local configuration (DESIGN.md §12)
// ---------------------------------------------------------------------------

describe("MiniMax config — loadMiniMaxConfig", () => {
  it("requires MINIMAX_API_KEY with non-whitespace", () => {
    assert.throws(
      () => loadMiniMaxConfig({}),
      (err) => /MINIMAX_API_KEY/i.test(err.message),
    );
    assert.throws(
      () => loadMiniMaxConfig({ MINIMAX_API_KEY: "" }),
      (err) => /MINIMAX_API_KEY/i.test(err.message),
    );
    assert.throws(
      () => loadMiniMaxConfig({ MINIMAX_API_KEY: "   " }),
      (err) => /MINIMAX_API_KEY/i.test(err.message),
    );
  });

  it("defaults region to global with the official global base URL", () => {
    const cfg = loadMiniMaxConfig({ MINIMAX_API_KEY: "k" });
    assert.strictEqual(cfg.region, "global");
    assert.strictEqual(cfg.baseUrl, "https://api.minimax.io");
    assert.strictEqual(cfg.apiKey, "k");
  });

  it("respects cn region with the official cn base URL", () => {
    const cfg = loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_REGION: "cn" });
    assert.strictEqual(cfg.region, "cn");
    assert.strictEqual(cfg.baseUrl, "https://api.minimaxi.com");
  });

  it("an explicit HTTPS MINIMAX_BASE_URL overrides either region", () => {
    const g = loadMiniMaxConfig({
      MINIMAX_API_KEY: "k",
      MINIMAX_BASE_URL: "https://custom.example.com",
    });
    assert.strictEqual(g.baseUrl, "https://custom.example.com");
    const cn = loadMiniMaxConfig({
      MINIMAX_API_KEY: "k",
      MINIMAX_REGION: "cn",
      MINIMAX_BASE_URL: "https://custom.example.com",
    });
    assert.strictEqual(cn.baseUrl, "https://custom.example.com");
  });

  it("removes exactly one trailing slash from an explicit base URL", () => {
    const cfg = loadMiniMaxConfig({
      MINIMAX_API_KEY: "k",
      MINIMAX_BASE_URL: "https://custom.example.com/",
    });
    assert.strictEqual(cfg.baseUrl, "https://custom.example.com");
  });

  it("treats empty region or base URL values as invalid, not absent", () => {
    assert.throws(() => loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_REGION: "" }));
    assert.throws(() => loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_BASE_URL: "" }));
  });

  it("rejects non-HTTPS base URLs", () => {
    assert.throws(() =>
      loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_BASE_URL: "http://insecure.example.com" }),
    );
    assert.throws(() =>
      loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_BASE_URL: "ftp://example.com" }),
    );
  });

  it("rejects an unknown region", () => {
    assert.throws(() => loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_REGION: "eu" }));
    assert.throws(() => loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_REGION: "GLOBAL" }));
  });
});

// ---------------------------------------------------------------------------
// SDK construction isolation (DESIGN.md §12)
// ---------------------------------------------------------------------------

describe("MiniMax sdk-client — createMiniMaxSdk env isolation", () => {
  const ENV_VAR = "MMX_CONFIG_DIR";

  afterEach(() => {
    // Defensive: never leak a sentinel between tests.
    delete process.env[ENV_VAR];
  });

  it("sets a unique nonexistent MMX_CONFIG_DIR during construction and restores after", async () => {
    const sentinel = "/tmp/scoutline-mmx-prior-sentinel";
    process.env[ENV_VAR] = sentinel;
    const { Constructor, observedEnvAtConstruction } = makeFakeSdk({ result: { organic: [] } });

    createMiniMaxSdk(
      { apiKey: "k", region: "global", baseUrl: "https://api.minimax.io" },
      Constructor,
    );

    // Env observed during construction is neither the sentinel nor undefined.
    assert.strictEqual(observedEnvAtConstruction.length, 1);
    const observed = observedEnvAtConstruction[0];
    assert.ok(typeof observed === "string" && observed.length > 0);
    assert.notStrictEqual(observed, sentinel);
    // The temporary path must never be created on disk.
    await assert.rejects(
      () => fs.stat(observed),
      (err) => err.code === "ENOENT",
    );
    // Original value restored after construction.
    assert.strictEqual(process.env[ENV_VAR], sentinel);
  });

  it("restores the original value (and deletes when previously unset) on throw", () => {
    // Case 1: previously set.
    process.env[ENV_VAR] = "/tmp/scoutline-prior";
    const throwing = function ThrowingSdk() {
      throw new Error("construction boom");
    };
    assert.throws(
      () =>
        createMiniMaxSdk(
          { apiKey: "k", region: "global", baseUrl: "https://api.minimax.io" },
          throwing,
        ),
      /construction boom/,
    );
    assert.strictEqual(process.env[ENV_VAR], "/tmp/scoutline-prior");

    // Case 2: previously unset -> deleted after.
    delete process.env[ENV_VAR];
    assert.throws(
      () =>
        createMiniMaxSdk(
          { apiKey: "k", region: "global", baseUrl: "https://api.minimax.io" },
          throwing,
        ),
      /construction boom/,
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(process.env, ENV_VAR));
  });

  it("produces a unique temporary path per construction", () => {
    const { Constructor, observedEnvAtConstruction } = makeFakeSdk({ result: { organic: [] } });
    createMiniMaxSdk(
      { apiKey: "k", region: "global", baseUrl: "https://api.minimax.io" },
      Constructor,
    );
    createMiniMaxSdk(
      { apiKey: "k", region: "global", baseUrl: "https://api.minimax.io" },
      Constructor,
    );
    assert.strictEqual(observedEnvAtConstruction.length, 2);
    assert.notStrictEqual(observedEnvAtConstruction[0], observedEnvAtConstruction[1]);
  });
});

// ---------------------------------------------------------------------------
// Descriptor metadata
// ---------------------------------------------------------------------------

describe("MiniMax descriptor — metadata", () => {
  it("advertises id 'minimax' and the search capability only", () => {
    const d = createMiniMaxDescriptor();
    assert.strictEqual(d.id, "minimax");
    const caps = d.capabilities();
    assert.ok(caps.has("search"));
    assert.ok(!caps.has("quota"));
    assert.ok(!caps.has("diagnostics"));
  });

  it("isConfigured is true only when MINIMAX_API_KEY has non-whitespace", () => {
    const d = createMiniMaxDescriptor();
    assert.strictEqual(d.isConfigured({ MINIMAX_API_KEY: "k" }), true);
    assert.strictEqual(d.isConfigured({ MINIMAX_API_KEY: "" }), false);
    assert.strictEqual(d.isConfigured({ MINIMAX_API_KEY: "   " }), false);
    assert.strictEqual(d.isConfigured({}), false);
  });

  it("descriptor creation is side-effect-free (no SDK construction)", () => {
    const { Constructor, constructed } = makeFakeSdk({ result: { organic: [] } });
    const d = createMiniMaxDescriptor({ sdkConstructor: Constructor });
    d.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    assert.strictEqual(constructed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Validation (FR-012): unsupported controls rejected before SDK/credential
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — validation rejects unsupported controls", () => {
  const unsupported = [
    ["domain", { domain: "example.com" }],
    ["recency", { recency: "oneWeek" }],
    ["contentSize", { contentSize: "high" }],
    ["location", { location: "cn" }],
  ];

  for (const [label, controls] of unsupported) {
    it(`rejects ${label} with UNSUPPORTED_OPTION`, () => {
      const adapter = makeAdapter();
      assert.throws(
        () => adapter.search.validate({ query: "q", controls }),
        (err) => err.code === "UNSUPPORTED_OPTION",
      );
    });
  }

  it("rejects all unsupported controls together", () => {
    const adapter = makeAdapter();
    assert.throws(
      () =>
        adapter.search.validate({
          query: "q",
          controls: { domain: "x", recency: "oneDay", contentSize: "high", location: "us" },
        }),
      (err) => err.code === "UNSUPPORTED_OPTION",
    );
  });

  it("rejects an empty query with VALIDATION_ERROR", () => {
    const adapter = makeAdapter();
    assert.throws(
      () => adapter.search.validate({ query: "   " }),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("validation occurs before SDK construction or credential access", async () => {
    const sdk = makeFakeSdk({ result: { organic: [] } });
    // No credential in env: if validation ran after credential access,
    // this would surface a config/auth error instead of UNSUPPORTED_OPTION.
    const descriptor = createMiniMaxDescriptor({ sdkConstructor: sdk.Constructor });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      adapter.search.invoke({ query: "q", controls: { domain: "x" } }),
      (err) => err.code === "UNSUPPORTED_OPTION",
    );
    assert.strictEqual(sdk.constructed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Bare query: SDK receives only the query string
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — bare query", () => {
  it("calls sdk.search.query with only the query string", async () => {
    const fixture = await readFixture("providers", "minimax", "search.json");
    const sdk = makeFakeSdk({ result: fixture });
    const adapter = makeAdapter({ sdk });
    await adapter.search.invoke({ query: "rust async" });
    assert.deepStrictEqual(sdk.queryCalls, ["rust async"]);
    // Construction received the resolved config, not the query.
    assert.strictEqual(sdk.constructed.length, 1);
    assert.strictEqual(sdk.constructed[0].apiKey, TEST_API_KEY);
    assert.strictEqual(sdk.constructed[0].region, "global");
    assert.strictEqual(sdk.constructed[0].baseUrl, "https://api.minimax.io");
  });
});

// ---------------------------------------------------------------------------
// Field mapping (DESIGN.md §7 MiniMax mapping)
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — field mapping", () => {
  it("maps organic title/link/snippet/date and discards unknown fields", async () => {
    const sdk = makeFakeSdk({
      result: {
        organic: [
          {
            title: "T1",
            link: "https://example.test/one",
            snippet: "summary one",
            date: "2024-05-06",
            unknown_extra: "discarded",
          },
          {
            title: "T2",
            link: "https://example.test/two",
            snippet: "summary two",
          },
        ],
      },
    });
    const adapter = makeAdapter({ sdk });
    const out = await adapter.search.invoke({ query: "q" });
    assert.deepStrictEqual(
      [...out],
      [
        {
          title: "T1",
          url: "https://example.test/one",
          summary: "summary one",
          date: "2024-05-06",
        },
        {
          title: "T2",
          url: "https://example.test/two",
          summary: "summary two",
        },
      ],
    );
  });

  it("malformed response (non-object) fails with API_ERROR and no raw payload", async () => {
    const sdk = makeFakeSdk({ result: "not-an-object" });
    const adapter = makeAdapter({ sdk });
    await assert.rejects(adapter.search.invoke({ query: "q" }), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.ok(!/not-an-object/.test(err.message), `raw payload leaked: ${err.message}`);
      return true;
    });
  });

  it("malformed organic entry fails with API_ERROR and no raw payload", async () => {
    const sdk = makeFakeSdk({
      result: {
        // Missing required `snippet`; carries a sensitive field that must
        // never appear in the normalized error message.
        organic: [{ title: "T", link: "https://x", secret_field: "leak-me" }],
      },
    });
    const adapter = makeAdapter({ sdk });
    await assert.rejects(adapter.search.invoke({ query: "q" }), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.ok(!/leak-me/.test(err.message), `raw payload leaked: ${err.message}`);
      return true;
    });
  });

  it("malformed entry (missing required field) fails with API_ERROR", async () => {
    const sdk = makeFakeSdk({
      result: { organic: [{ title: "T", link: "https://x" /* no snippet */ }] },
    });
    const adapter = makeAdapter({ sdk });
    await assert.rejects(adapter.search.invoke({ query: "q" }), (err) => err.code === "API_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Failure normalization: stable public codes and retryability
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — failure normalization", () => {
  async function runWithError(error) {
    const sdk = makeFakeSdk({ error });
    const adapter = makeAdapter({ sdk });
    return adapter.search.invoke({ query: "q" });
  }

  // Replicates the shared-execution retry classification
  // (lib/execution.ts `isOperationRetryableError`): AUTH/VALIDATION are
  // terminal; TIMEOUT/NETWORK always retry; API_ERROR retries on 429 and
  // 5xx. The Adapter maps Provider failures into these stable codes, so
  // retryability is determined by the code the execution layer sees.
  function isRetryableByExecution(err) {
    if (err.code === "TIMEOUT_ERROR" || err.code === "NETWORK_ERROR") return true;
    if (err.code === "API_ERROR" && [429, 500, 502, 503, 504].includes(err.statusCode)) {
      return true;
    }
    return false;
  }

  it("maps auth failures to AUTH_ERROR (terminal)", async () => {
    for (const msg of ["Unauthorized 401", "Forbidden 403"]) {
      await assert.rejects(runWithError(new Error(msg)), (err) => {
        assert.strictEqual(err.code, "AUTH_ERROR");
        assert.strictEqual(isRetryableByExecution(err), false);
        assert.ok(!/Unauthorized|Forbidden/.test(err.message), `raw leaked: ${err.message}`);
        return true;
      });
    }
  });

  it("maps timeout failures to TIMEOUT_ERROR (retryable)", async () => {
    await assert.rejects(runWithError(new Error("operation timed out after 30s")), (err) => {
      assert.strictEqual(err.code, "TIMEOUT_ERROR");
      assert.strictEqual(isRetryableByExecution(err), true);
      return true;
    });
  });

  it("maps network failures to NETWORK_ERROR (retryable)", async () => {
    await assert.rejects(runWithError(new Error("ECONNREFUSED")), (err) => {
      assert.strictEqual(err.code, "NETWORK_ERROR");
      assert.strictEqual(isRetryableByExecution(err), true);
      return true;
    });
  });

  it("maps rate-limit failures to API_ERROR 429 (retryable)", async () => {
    await assert.rejects(runWithError(new Error("HTTP 429 rate limit exceeded")), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.strictEqual(err.statusCode, 429);
      assert.strictEqual(isRetryableByExecution(err), true);
      return true;
    });
  });

  it("maps generic API failures to API_ERROR 500 (retryable)", async () => {
    await assert.rejects(runWithError(new Error("HTTP 500 internal server error")), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.strictEqual(err.statusCode, 500);
      assert.strictEqual(isRetryableByExecution(err), true);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Cache identity (DESIGN.md §7, §11)
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — cache identity", () => {
  it("uses SHA-256 credential fingerprint and no legacy candidates", () => {
    const adapter = makeAdapter();
    const identity = adapter.search.cacheIdentity({ query: "q" });
    assert.strictEqual(identity.provider, "minimax");
    assert.strictEqual(identity.capability, "search");
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.deepStrictEqual(identity.request, { query: "q" });
    // MiniMax never probes legacy keys.
    assert.strictEqual(identity.legacyCandidates, undefined);
  });

  it("count never enters identity.request", () => {
    const adapter = makeAdapter();
    const identity = adapter.search.cacheIdentity({ query: "q" }, { legacyCount: 5 });
    assert.strictEqual(identity.request.count, undefined);
    assert.strictEqual(identity.legacyCandidates, undefined);
  });
});
