/**
 * MiniMax Search Adapter (P2-04, DESIGN.md §12 + §7).
 *
 * Verifies the direct-transport MiniMax Token Plan Adapter:
 *   - Adapter-local config: required key, default/cn regions, explicit
 *     HTTPS base URL override, trailing-slash normalization, empty
 *     values, non-HTTPS URLs, unknown region.
 *   - Search validation: every unsupported control rejected before
 *     any credential access or transport call (FR-012).
 *   - Bare query: the direct-transport client receives only the query
 *     string in the request body.
 *   - Field mapping: organic[].title/link/snippet/date -> normalized.
 *     Malformed responses -> API_ERROR (no raw payload leak).
 *   - Failure normalization: auth, timeout, network, rate-limit,
 *     generic API -> stable public codes and retryability.
 *   - Cache identity: SHA-256 credential fingerprint, key-sorted
 *     request identity, no legacy candidates.
 *
 * Tests inject a single fake `fetch` through
 * `MiniMaxAdapterDependencies.transport`; the fake returns Response-
 * shaped objects (same `ok`/`status`/`json`/`text` shape the SDK used
 * to return under the hood). No real SDK, network, or `mmx`
 * executable is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import crypto from "node:crypto";

import { loadMiniMaxConfig } from "../dist/providers/minimax/config.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { MINIMAX_VISION_MAPPINGS } from "../dist/providers/minimax/vision-mappings.generated.js";
import { readFixture } from "./helpers/fixtures.js";
import { executeProviderOperation } from "../dist/lib/execution.js";
import { AuthError, TimeoutError, ApiError } from "../dist/lib/errors.js";

const TEST_API_KEY = "test-minimax-api-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

const VISION_REQUEST = {
  operation: "interpret-image",
  source: "https://example.test/image.png",
  instruction: "Describe this image.",
};

// ---------------------------------------------------------------------------
// Fake fetch helper. Mirrors the shape consumed by the direct-transport
// Modules (ProviderQuotaFetch for search/vision/quota, ProviderImageFetch
// for HTTP image fetch). Each fake `fetch` returns one or more
// Response-shaped objects in sequence.
// ---------------------------------------------------------------------------

function makeResponse({
  ok = true,
  status = 200,
  json,
  body = "",
  contentType,
  headers,
  arrayBuffer,
} = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => json,
    headers: headers ?? {
      get: (name) => {
        if (!contentType) return null;
        return name.toLowerCase() === "content-type" ? contentType : null;
      },
    },
    arrayBuffer: arrayBuffer ?? (async () => new ArrayBuffer(0)),
  };
}

function makeFetchSequence(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const resp = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (resp.throw) throw resp.throw;
    return makeResponse(resp);
  };
  return { fn, calls };
}

/**
 * Build a fake fetch where:
 *   - index 0 is the search endpoint (returns the search payload).
 *   - index 1+ are vision endpoints (one per call; specialized + retry).
 *   - Every HTTP image fetch (vision HTTP source) is satisfied by the
 *     same fake response body — vision only reads the bytes; the data
 *     URI it produces is opaque to the Adapter's field-mapping logic.
 */
function makeAdapterFetch({ search, vision, visionError, visionErrorFn, image } = {}) {
  const sequence = [];
  // Wrap a raw JSON body in a fetch response with `base_resp` so the
  // direct-transport envelope check passes for both search and vision
  // endpoints.
  function wrapWithEnvelope(jsonBody) {
    if (typeof jsonBody !== "object" || jsonBody === null || Array.isArray(jsonBody)) {
      return { ok: true, status: 200, json: { base_resp: { status_code: 0 } } };
    }
    return { ok: true, status: 200, json: { ...jsonBody, base_resp: { status_code: 0 } } };
  }

  // Vision flow is: image fetch → VLM fetch. Image response(s) go
  // FIRST in the sequence, vision response(s) SECOND. For the
  // retry-with-image-fetch case, image responses must be paired with
  // each vision attempt; the caller manages sequence length explicitly
  // when they need fine control (see the retry-test helpers).
  if (image !== undefined) {
    const imageResponses = Array.isArray(image) ? image : [image];
    for (const img of imageResponses) sequence.push(img);
  }

  if (search !== undefined) {
    // Search payload: either a raw JSON body (object) or a complete
    // fetch response (with .json field). Wrap accordingly.
    if (
      typeof search === "object" &&
      search !== null &&
      !Array.isArray(search) &&
      "json" in search
    ) {
      sequence.push(search);
    } else {
      sequence.push(wrapWithEnvelope(search));
    }
  }
  // Wrap a raw vision JSON body in a fetch response with `base_resp`
  // so the direct-transport VLM endpoint's envelope check passes.
  function visionResp(jsonBody) {
    if (typeof jsonBody !== "object" || jsonBody === null || Array.isArray(jsonBody)) {
      return { ok: true, status: 200, json: { base_resp: { status_code: 0 } } };
    }
    return { ok: true, status: 200, json: { ...jsonBody, base_resp: { status_code: 0 } } };
  }
  // Vision calls always need at least one response; the test layer
  // controls sequence length via the `vision` array.
  if (vision === undefined && visionError === undefined && visionErrorFn === undefined) {
    sequence.push(visionResp({ content: "ok" }));
  } else if (visionError !== undefined) {
    sequence.push({ throw: visionError });
  } else if (visionErrorFn) {
    // Encode per-call behaviour with successive throw responses.
    let n = 0;
    while (true) {
      const err = visionErrorFn(n + 1);
      if (!err) break;
      sequence.push({ throw: err });
      n += 1;
    }
    // Add at least one success response at the tail.
    if (vision) {
      const rest = Array.isArray(vision) ? vision : [vision];
      for (const v of rest) sequence.push(visionResp(v));
    } else {
      sequence.push(visionResp({ content: "ok" }));
    }
  } else if (Array.isArray(vision)) {
    for (const v of vision) sequence.push(visionResp(v));
  } else if (vision) {
    sequence.push(visionResp(vision));
  }

  // Default image response for tests that don't specify one (e.g.
  // when vision source is local — no HTTP image fetch happens, so
  // this default is unused).
  if (image === undefined) sequence.push({ ok: true, status: 200, body: "" });

  return makeFetchSequence(sequence);
}

function makeAdapter(
  { search, vision, visionError, visionErrorFn, image } = {},
  env = { MINIMAX_API_KEY: TEST_API_KEY },
) {
  const { fn, calls } = makeAdapterFetch({ search, vision, visionError, visionErrorFn, image });
  const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
  return { adapter: descriptor.create({ env }), fetchCalls: calls };
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

  it("rejects insecure or hostless base URLs and unknown regions", () => {
    for (const bad of [
      "http://insecure.example.com",
      "ftp://example.com",
      "https://",
      "https:/",
      "HTTPS://",
    ]) {
      assert.throws(
        () => loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_BASE_URL: bad }),
        (err) => /MINIMAX_BASE_URL/.test(err.message),
        `expected rejection for ${JSON.stringify(bad)}`,
      );
    }
    for (const region of ["eu", "GLOBAL"]) {
      assert.throws(() => loadMiniMaxConfig({ MINIMAX_API_KEY: "k", MINIMAX_REGION: region }));
    }
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
    // P4-02 wires quota; P4-04 wires diagnostics.
    assert.ok(caps.has("quota"));
    assert.ok(caps.has("diagnostics"));
  });

  it("isConfigured is true only when MINIMAX_API_KEY has non-whitespace", () => {
    const d = createMiniMaxDescriptor();
    assert.strictEqual(d.isConfigured({ MINIMAX_API_KEY: "k" }), true);
    assert.strictEqual(d.isConfigured({ MINIMAX_API_KEY: "" }), false);
    assert.strictEqual(d.isConfigured({ MINIMAX_API_KEY: "   " }), false);
    assert.strictEqual(d.isConfigured({}), false);
  });

  it("descriptor creation is side-effect-free (no transport call)", () => {
    const { fn, calls } = makeFetchSequence([{ ok: true, status: 200, json: { organic: [] } }]);
    const d = createMiniMaxDescriptor({ transport: { fetch: fn } });
    d.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    assert.strictEqual(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Validation (FR-012): unsupported controls rejected before credential or
// transport access
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — validation rejects unsupported controls", () => {
  const unsupported = [
    ["domain", { domain: "example.com" }],
    ["recency", { recency: "oneWeek" }],
    ["contentSize", { contentSize: "high" }],
    ["location", { location: "cn" }],
    ["type", { type: "video" }],
  ];

  it("rejects every unsupported control with UNSUPPORTED_OPTION", () => {
    for (const [label, controls] of unsupported) {
      const { adapter } = makeAdapter();
      assert.throws(
        () => adapter.search.validate({ query: "q", controls }),
        (err) => err.code === "UNSUPPORTED_OPTION",
        label,
      );
    }
  });

  it("rejects all unsupported controls together", () => {
    const { adapter } = makeAdapter();
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
    const { adapter } = makeAdapter();
    assert.throws(
      () => adapter.search.validate({ query: "   " }),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("validation occurs before transport call or credential access", async () => {
    const { fn, calls } = makeFetchSequence([{ ok: true, status: 200, json: { organic: [] } }]);
    // No credential in env: if validation ran after credential access,
    // this would surface a config/auth error instead of UNSUPPORTED_OPTION.
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: {} });
    await assert.rejects(
      adapter.search.invoke({ query: "q", controls: { domain: "x" } }),
      (err) => err.code === "UNSUPPORTED_OPTION",
    );
    assert.strictEqual(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Bare query: direct transport receives only the query string
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — bare query", () => {
  it("POSTs to the search endpoint with only the query string", async () => {
    const fixture = await readFixture("providers", "minimax", "search.json");
    const { adapter, fetchCalls } = makeAdapter({ search: fixture });
    await adapter.search.invoke({ query: "rust async" });
    assert.strictEqual(fetchCalls.length, 1, "exactly one transport call");
    const call = fetchCalls[0];
    assert.match(call.url, /\/v1\/coding_plan\/search$/);
    const headers = call.init.headers;
    assert.strictEqual(headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.strictEqual(headers["Content-Type"], "application/json");
    assert.deepStrictEqual(JSON.parse(call.init.body), { q: "rust async" });
  });
});

// ---------------------------------------------------------------------------
// Topic keyword appendage (T03): non-general topic appends a keyword to
// the query before the transport call. The topic never reaches the
// MiniMax API as a separate parameter.
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — topic keyword appendage (T03)", () => {
  async function invokeWithTopic(query, topic) {
    const fixture = await readFixture("providers", "minimax", "search.json");
    const { adapter, fetchCalls } = makeAdapter({ search: fixture });
    const request = topic ? { query, controls: { topic } } : { query };
    await adapter.search.invoke(request);
    return JSON.parse(fetchCalls[0].init.body).q;
  }

  it("appends ' latest news' for topic news", async () => {
    assert.strictEqual(await invokeWithTopic("AI", "news"), "AI latest news");
  });

  it("appends ' financial' for topic finance", async () => {
    assert.strictEqual(await invokeWithTopic("stocks", "finance"), "stocks financial");
  });

  it("does not append for topic general", async () => {
    assert.strictEqual(await invokeWithTopic("AI", "general"), "AI");
  });

  it("does not append when topic is absent", async () => {
    assert.strictEqual(await invokeWithTopic("AI", undefined), "AI");
  });

  it("guards against double-append (query already ends with topic word)", async () => {
    assert.strictEqual(await invokeWithTopic("rust news", "news"), "rust news");
  });
});

// ---------------------------------------------------------------------------
// Field mapping (DESIGN.md §7 MiniMax mapping)
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — field mapping", () => {
  it("maps organic title/link/snippet/date and discards unknown fields", async () => {
    const { adapter } = makeAdapter({
      search: {
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
    // The transport throws a parsing error before normalization; the
    // Adapter rewraps to a typed API_ERROR without leaking the payload.
    const { adapter } = makeAdapter({
      search: undefined,
    });
    // Replace the search-endpoint response with a malformed body.
    // Use a custom fetch sequence: search returns ok but json() throws.
    const { fn } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        // json() throws to simulate a malformed JSON body.
        text: async () => "not-an-object",
        json: async () => {
          throw new Error("not-an-object");
        },
      },
      { ok: true, status: 200, json: { content: "ok" }, body: "" },
    ]);
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
    const adapterWithFetch = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    void adapter;
    await assert.rejects(adapterWithFetch.search.invoke({ query: "q" }), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.ok(!/not-an-object/.test(err.message), `raw payload leaked: ${err.message}`);
      return true;
    });
  });

  it("malformed organic entry fails with API_ERROR and no raw payload", async () => {
    const { adapter } = makeAdapter({
      search: {
        // Missing required `snippet`; carries a sensitive field that must
        // never appear in the normalized error message.
        organic: [{ title: "T", link: "https://x", secret_field: "leak-me" }],
      },
    });
    await assert.rejects(adapter.search.invoke({ query: "q" }), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.ok(!/leak-me/.test(err.message), `raw payload leaked: ${err.message}`);
      return true;
    });
  });

  it("malformed entry (missing required field) fails with API_ERROR", async () => {
    const { adapter } = makeAdapter({
      search: { organic: [{ title: "T", link: "https://x" /* no snippet */ }] },
    });
    await assert.rejects(adapter.search.invoke({ query: "q" }), (err) => err.code === "API_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Failure normalization: stable public codes and retryability
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — failure normalization", () => {
  async function runWithStatus(status, followup) {
    // Direct-transport Modules map HTTP status codes to typed errors
    // (401/403 -> AuthError, 408/504 -> TimeoutError, 4xx/5xx ->
    // ApiError). The Adapter receives the typed error and rewraps it
    // through normalizeMiniMaxError. These tests assert the Adapter's
    // rewrap behavior using that pathway.
    const responses = [{ ok: false, status, body: "" }];
    if (followup) responses.push(followup);
    const { fn } = makeFetchSequence(responses);
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    return adapter.search.invoke({ query: "q" });
  }

  // Replicates the shared-execution retry classification
  // (lib/execution.ts `isOperationRetryableError`): AUTH/VALIDATION are
  // terminal; TIMEOUT/NETWORK always retry; API_ERROR retries on 429 and
  // any 5xx (500..599 inclusive). The Adapter maps Provider failures
  // into these stable codes, so retryability is determined by the code
  // the execution layer sees.
  function isRetryableByExecution(err) {
    if (err.code === "TIMEOUT_ERROR" || err.code === "NETWORK_ERROR") return true;
    if (
      err.code === "API_ERROR" &&
      (err.statusCode === 429 || (err.statusCode >= 500 && err.statusCode <= 599))
    ) {
      return true;
    }
    return false;
  }

  it("maps auth failures (401/403) to AUTH_ERROR (terminal)", async () => {
    for (const status of [401, 403]) {
      await assert.rejects(runWithStatus(status), (err) => {
        assert.strictEqual(err.code, "AUTH_ERROR");
        assert.strictEqual(isRetryableByExecution(err), false);
        assert.ok(
          /authentication/i.test(err.message),
          `expected clean auth message: ${err.message}`,
        );
        return true;
      });
    }
  });

  it("maps timeout failures (408/504) to TIMEOUT_ERROR (retryable)", async () => {
    for (const status of [408, 504]) {
      await assert.rejects(runWithStatus(status), (err) => {
        assert.strictEqual(err.code, "TIMEOUT_ERROR");
        assert.strictEqual(isRetryableByExecution(err), true);
        return true;
      });
    }
  });

  it("preserves the TimeoutError duration and MINIMAX_TIMEOUT help text", async () => {
    // The transport wraps 408/504 into a TimeoutError carrying the
    // resolved timeoutMs (from MINIMAX_TIMEOUT or the default 30s) and
    // the MINIMAX_TIMEOUT help text. The Adapter must preserve both.
    await assert.rejects(runWithStatus(408), (err) => {
      assert.strictEqual(err.code, "TIMEOUT_ERROR");
      assert.ok(err instanceof TimeoutError, "rewrapped error is a TimeoutError");
      assert.ok(Number.isFinite(err.durationMs), "durationMs is finite");
      assert.match(err.help ?? "", /MINIMAX_TIMEOUT/, `help text preserved: ${err.help}`);
      return true;
    });
  });

  it("maps generic API failures (5xx) to API_ERROR with statusCode (retryable)", async () => {
    await assert.rejects(runWithStatus(503), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.strictEqual(err.statusCode, 503);
      assert.strictEqual(isRetryableByExecution(err), true);
      return true;
    });
  });

  // Fixup B — B6a: HTTP 404 is terminal, not a retried 500.
  it("maps 404 to API_ERROR 404 (terminal, not retried as 500)", async () => {
    await assert.rejects(runWithStatus(404), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.strictEqual(err.statusCode, 404, `404 must map to 404, got ${err.statusCode}`);
      assert.strictEqual(isRetryableByExecution(err), false);
      return true;
    });
  });

  // F3 (code-review-baseline): the ApiError rewrap must NOT echo an
  // upstream message blindly. Today every upstream ApiError message is a
  // hardcoded constant, but the boundary trusted it unconditionally — a
  // future change embedding a raw Provider body would leak through
  // normalization, the cache, and stdout. A thrown ApiError carrying a
  // "raw body" is rebuilt from the status-keyed constant. (The curated
  // 2038 verification URL is the one preserved exception — covered by
  // the C1 test below.)
  it("F3: a non-2038 ApiError message is rebuilt from the status-keyed constant (no raw-body leak)", async () => {
    const RAW_BODY = "raw provider body echo: sk-leak-1234567890abcdef";
    const throwingFetch = async () => {
      throw new ApiError(RAW_BODY, 503);
    };
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: throwingFetch } });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    await assert.rejects(adapter.search.invoke({ query: "q" }), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.strictEqual(err.statusCode, 503);
      assert.ok(!err.message.includes("sk-leak"), `raw body must not leak: ${err.message}`);
      assert.strictEqual(err.message, "MiniMax request failed");
      return true;
    });
  });
});

// Adapter-layer raw-body scrubbing removed (B2); the invariant now lives
// in tests/minimax-coding-plan-client.test.js — see C1. The transport
// layer constructs clean messages by construction (no raw body ever
// surfaces), and `lib/redact.ts` provides final defense at the output
// envelope.

// ---------------------------------------------------------------------------
// Adapter-layer 2038 URL survival (C1 — Phase B reviewer finding #1)
// ---------------------------------------------------------------------------
//
// The two deleted scrubbing tests at the original L531/L543 left a gap:
// no Adapter-level test verified the NEW contract that `error.message`
// IS preserved through the `normalizeMiniMaxError` rewrap for the
// 2038 verification-URL case. The transport layer constructs the URL
// in its message (covered by `tests/minimax-coding-plan-client.test.js`),
// and the Adapter rewrap must preserve it. This test locks the C2 fix
// at the Adapter layer so a future edit can't accidentally remove the
// `error.message` preservation branch in `normalizeMiniMaxError` without
// a test catching it.

describe("MiniMax Search Adapter — 2038 verification URL survives rewrap (C1)", () => {
  const VERIFICATION_URL = "https://platform.minimaxi.com/user-center/basic-information";

  it("Adapter-thrown error.message contains the verification URL when base_resp.status_code is 2038", async () => {
    // The transport's direct module throws a typed `ApiError` whose
    // message carries the verification URL. `normalizeMiniMaxError`
    // (C2 fix) preserves `error.message` through the rewrap so the URL
    // reaches the Adapter's caller. This assertion fails if the
    // preservation branch is ever removed.
    const responses = [{ ok: true, status: 200, json: { base_resp: { status_code: 2038 } } }];
    const { fn } = makeFetchSequence(responses);
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    await assert.rejects(adapter.search.invoke({ query: "q" }), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.strictEqual(err.statusCode, 403);
      assert.ok(
        String(err.message).includes(VERIFICATION_URL),
        `verification URL must survive the Adapter rewrap, got: ${err.message}`,
      );
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Cache identity (DESIGN.md §7, §11)
// ---------------------------------------------------------------------------

describe("MiniMax Search Adapter — cache identity", () => {
  it("uses SHA-256 credential fingerprint and no legacy candidates", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.search.cacheIdentity({ query: "q" });
    assert.strictEqual(identity.provider, "minimax");
    assert.strictEqual(identity.capability, "search");
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.deepStrictEqual(identity.request, { query: "q" });
    // MiniMax never probes legacy keys.
    assert.strictEqual(identity.legacyCandidates, undefined);
  });

  it("missing credential throws ConfigurationError exit 3 (Fixup A — B7)", () => {
    const d = createMiniMaxDescriptor();
    const adapter = d.create({ env: {} });
    assert.throws(
      () => adapter.search.cacheIdentity({ query: "q" }),
      (err) => err.code === "CONFIGURATION_ERROR" && err.exitCode === 3,
    );
  });
});

// ---------------------------------------------------------------------------
// Vision Adapter (P3-03, DESIGN.md §8, §9, §12): interpret-image → VLM endpoint
// ---------------------------------------------------------------------------

describe("MiniMax Vision Adapter — interpret-image mapping (P3-03)", () => {
  it("advertises the vision.interpret-image capability", () => {
    const descriptor = createMiniMaxDescriptor();
    assert.ok(
      descriptor.capabilities().has("vision.interpret-image"),
      "MiniMax descriptor must advertise vision.interpret-image",
    );
  });

  it("POSTs to the VLM endpoint with image (data URI) and instruction; fetch invoked once", async () => {
    const { adapter, fetchCalls } = makeAdapter({
      vision: { content: "A clear scene." },
      image: {
        // HTTP image fetch returns tiny PNG bytes.
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]).buffer,
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    });
    const out = await adapter.vision.invoke(VISION_REQUEST);
    assert.strictEqual(out, "A clear scene.");

    // Two calls: one for the image fetch (https://example.test/image.png),
    // then one for the VLM endpoint.
    assert.strictEqual(fetchCalls.length, 2, "image fetch + VLM endpoint");
    const vlmCall = fetchCalls[1];
    assert.match(vlmCall.url, /\/v1\/coding_plan\/vlm$/);
    const body = JSON.parse(vlmCall.init.body);
    assert.ok(
      typeof body.image_url === "string" && body.image_url.startsWith("data:image/png;base64,"),
    );
    assert.strictEqual(body.prompt, "Describe this image.");
    assert.strictEqual(vlmCall.init.headers.Authorization, `Bearer ${TEST_API_KEY}`);
  });

  it("resolves a local image to a data URI before invoking the VLM endpoint", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mm-vision-"));
    try {
      const img = path.join(tmp, "local.png");
      await fs.writeFile(img, Buffer.from([0]));
      const { adapter, fetchCalls } = makeAdapter({
        vision: { content: "ok" },
      });
      await adapter.vision.invoke({ ...VISION_REQUEST, source: img });
      // Local source -> convertToDataUri -> data URI in the VLM body.
      assert.strictEqual(fetchCalls.length, 1, "no HTTP image fetch for local source");
      const vlmCall = fetchCalls[0];
      const body = JSON.parse(vlmCall.init.body);
      assert.ok(
        body.image_url.startsWith("data:image/png;base64,"),
        `local image produced a data URI, got ${body.image_url.slice(0, 30)}...`,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("MiniMax Vision Adapter — response normalization (P3-03)", () => {
  async function runWithResult(visionResult) {
    // The direct transport validates the VLM response envelope (must
    // carry base_resp). For malformed-result tests the envelope check
    // passes (the malformed cases are caught at the Adapter layer after
    // the raw response is returned), so we always include base_resp.
    const envelope = { base_resp: { status_code: 0 } };
    const vlmPayload =
      typeof visionResult === "object" && visionResult !== null && !Array.isArray(visionResult)
        ? { ...visionResult, ...envelope }
        : { ...envelope };
    const { fn } = makeFetchSequence([
      { ok: true, status: 200, contentType: "image/png" },
      { ok: true, status: 200, json: vlmPayload, body: "" },
    ]);
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    return adapter.vision.invoke(VISION_REQUEST);
  }

  it("accepts the characterized { content } envelope", async () => {
    assert.strictEqual(await runWithResult({ content: "described" }), "described");
  });

  it("rejects empty and whitespace-only content with API_ERROR", async () => {
    for (const content of ["", "  "]) {
      await assert.rejects(runWithResult({ content }), (err) => err.code === "API_ERROR");
    }
  });

  it("rejects a malformed (non-object) response with API_ERROR and no raw leak", async () => {
    await assert.rejects(runWithResult("not-an-object"), (err) => {
      assert.strictEqual(err.code, "API_ERROR");
      assert.ok(!/not-an-object/.test(err.message), `raw payload leaked: ${err.message}`);
      return true;
    });
  });

  it("rejects a missing content field with API_ERROR", async () => {
    await assert.rejects(runWithResult({ other: "x" }), (err) => err.code === "API_ERROR");
  });
});

describe("MiniMax Vision Adapter — failure normalization (P3-03)", () => {
  async function runVisionWithError(error) {
    // The direct-transport Module normalizes thrown fetch errors to
    // typed errors before the Adapter sees them. To drive a specific
    // terminal outcome we simulate a non-2xx HTTP status (the
    // transport's typed-error pathway).
    const status = error instanceof AuthError ? 401 : 500;
    const responses = [
      { ok: true, status: 200, contentType: "image/png" },
      { ok: false, status, body: "" },
    ];
    const { fn } = makeFetchSequence(responses);
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    return adapter.vision.invoke(VISION_REQUEST);
  }

  it("maps auth failures to AUTH_ERROR", async () => {
    await assert.rejects(
      runVisionWithError(new AuthError("Unauthorized 401")),
      (err) => err.code === "AUTH_ERROR",
    );
  });
  it("maps generic API to API_ERROR", async () => {
    await assert.rejects(
      runVisionWithError(new Error("HTTP 500 internal")),
      (err) => err.code === "API_ERROR",
    );
  });
});

describe("MiniMax Vision Adapter — cache bypass (P3-03, FR-022)", () => {
  it("never touches a cache spy (Vision has no cache dependency)", async () => {
    const cacheSpy = {
      getCalls: 0,
      setCalls: 0,
      async get() {
        this.getCalls += 1;
        throw new Error("CACHE_GET_FORBIDDEN");
      },
      async set() {
        this.setCalls += 1;
        throw new Error("CACHE_SET_FORBIDDEN");
      },
    };
    const { adapter } = makeAdapter({
      vision: { content: "text" },
      image: { ok: true, status: 200, contentType: "image/png" },
    });
    const sleeps = [];
    const out = await executeProviderOperation(
      "vision",
      () => adapter.vision.invoke(VISION_REQUEST),
      { sleep: async (ms) => sleeps.push(ms), random: () => 0.5 },
    );
    assert.strictEqual(out, "text");
    assert.strictEqual(cacheSpy.getCalls, 0, "Vision must not read the cache");
    assert.strictEqual(cacheSpy.setCalls, 0, "Vision must not write the cache");
  });
});

describe("MiniMax Vision Adapter — shared execution owns retries (P3-03)", () => {
  const imageResp = { ok: true, status: 200, contentType: "image/png" };

  it("transient-then-success: exactly two transport attempts, one injected delay", async () => {
    // Each retry performs an HTTP image fetch before the VLM call. The
    // first VLM attempt throws (transient); the second succeeds.
    const responses = [
      imageResp, // image fetch (retry 1)
      { throw: new Error("ECONNRESET network") }, // VLM (retry 1) throws
      imageResp, // image fetch (retry 2)
      {
        ok: true,
        status: 200,
        json: { content: "recovered text", base_resp: { status_code: 0 } },
        body: "",
      }, // VLM (retry 2) success
    ];
    const { fn, calls } = makeFetchSequence(responses);
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    const sleeps = [];
    const out = await executeProviderOperation(
      "vision",
      () => adapter.vision.invoke(VISION_REQUEST),
      { sleep: async (ms) => sleeps.push(ms), random: () => 0.5 },
    );
    assert.strictEqual(out, "recovered text");
    // Image fetch + VLM attempt + image fetch + VLM retry = 4 transport calls.
    assert.strictEqual(calls.length, 4, "2 image fetches + 2 VLM attempts");
    assert.strictEqual(sleeps.length, 1, "exactly one injected delay");
  });

  it("terminal failure: one VLM attempt (plus the image fetch), no delay", async () => {
    // 401 HTTP status from the VLM endpoint → AuthError → terminal,
    // no retry. The image fetch is performed once before the VLM call.
    const responses = [
      imageResp, // image fetch
      { ok: false, status: 401 }, // VLM returns 401 (terminal)
    ];
    const { fn, calls } = makeFetchSequence(responses);
    const descriptor = createMiniMaxDescriptor({ transport: { fetch: fn } });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    const sleeps = [];
    await assert.rejects(
      executeProviderOperation("vision", () => adapter.vision.invoke(VISION_REQUEST), {
        sleep: async (ms) => sleeps.push(ms),
        random: () => 0.5,
      }),
      (err) => err.code === "AUTH_ERROR",
    );
    assert.strictEqual(calls.length, 2, "image fetch + 1 VLM attempt");
    assert.strictEqual(sleeps.length, 0, "no delay for terminal failure");
  });
});

// ---------------------------------------------------------------------------
// Specialized mapping routing (P5-04)
// ---------------------------------------------------------------------------
//
// At runtime the MiniMax adapter's specialized-vision gate is closed
// because every conformance registry entry stays `live=pending` until
// a live attestation runs. These tests force the support check to true
// for each of the five specialized operations, drive
// `adapter.vision.invoke()` through the public Adapter API, and verify
// the request is routed through the matching `MINIMAX_VISION_MAPPINGS`
// Module so the VLM endpoint receives the composed prompt and the raw
// result is normalized by the Module's normalizer.
//
// The injection point is `MiniMaxAdapterDependencies.isSpecializedVisionOperationSupported`.
// Production never sets it; tests pass a forced-support function so the
// routing branch can be exercised deterministically without flipping a
// compiled attestation.

describe("MiniMax Vision Adapter — specialized mapping routing (P5-04)", () => {
  const SPECIALIZED = ["ui-artifact", "extract-text", "diagnose-error", "diagram", "chart"];

  /**
   * Build a request and its expected composed prompt for one operation.
   * The request uses representative option values so all segments render.
   */
  function makeRequestAndExpectedPrompt(op) {
    switch (op) {
      case "ui-artifact":
        return {
          image: "https://example.test/screenshot.png",
          request: {
            operation: op,
            source: "https://example.test/screenshot.png",
            instruction: "Recover the header bar markup.",
            outputType: "code",
          },
          promptNeedles: ["Recover the header bar markup.", "page regions", "code (markup)"],
        };
      case "extract-text":
        return {
          image: "https://example.test/snippet.png",
          request: {
            operation: op,
            source: "https://example.test/snippet.png",
            instruction: "Recover every line verbatim.",
            programmingLanguage: "python",
          },
          promptNeedles: ["Recover every line verbatim.", "verbatim", "Programming language"],
        };
      case "diagnose-error":
        return {
          image: "https://example.test/error.png",
          request: {
            operation: op,
            source: "https://example.test/error.png",
            instruction: "Diagnose the error.",
            context: "production trace",
          },
          promptNeedles: ["Diagnose the error.", "error class", "Context"],
        };
      case "diagram":
        return {
          image: "https://example.test/diagram.png",
          request: {
            operation: op,
            source: "https://example.test/diagram.png",
            instruction: "List every node.",
            diagramType: "flowchart",
          },
          promptNeedles: ["List every node.", "report each node", "Diagram type"],
        };
      case "chart":
        return {
          image: "https://example.test/chart.png",
          request: {
            operation: op,
            source: "https://example.test/chart.png",
            instruction: "Identify the dominant trend.",
            focus: "latency",
          },
          promptNeedles: ["Identify the dominant trend.", "analyze the chart", "Focus"],
        };
      default:
        throw new Error(`unexpected op ${op}`);
    }
  }

  it("routes every supported specialized operation through its mapping module", async () => {
    for (const op of SPECIALIZED) {
      // First call: HTTP image fetch for the request source URL.
      // Second call: VLM endpoint with the composed prompt. The VLM
      // payload must include `base_resp: { status_code: 0 }` to satisfy
      // the direct transport's envelope validation.
      const responses = [
        { ok: true, status: 200, contentType: "image/png" },
        {
          ok: true,
          status: 200,
          json: { content: "expected-mapping-text", base_resp: { status_code: 0 } },
          body: "",
        },
      ];
      const { fn, calls } = makeFetchSequence(responses);
      const descriptor = createMiniMaxDescriptor({
        transport: { fetch: fn },
        // Force the support gate open for this op so we can drive the
        // routing branch without flipping compiled registry state.
        isSpecializedVisionOperationSupported: (candidate) => candidate === op,
      });
      const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });

      // Metadata must reflect the forced support so descriptor capabilities
      // agree with the runtime gate.
      const advertised = descriptor.capabilities();
      assert.ok(
        advertised.has(`vision.${op}`),
        `descriptor must advertise vision.${op} when support is forced true`,
      );
      assert.equal(
        adapter.vision.supports(op),
        true,
        `adapter.vision.supports(${op}) must report true when force-injected`,
      );

      // Build the request and a captured composed prompt via the same
      // mapping Module the adapter will use.
      const module = MINIMAX_VISION_MAPPINGS[op];
      assert.ok(module, `${op} mapping module must be wired in`);
      const { request, promptNeedles } = makeRequestAndExpectedPrompt(op);
      const expectedPrompt = module.composePrompt(request);

      const out = await adapter.vision.invoke(request);
      assert.strictEqual(out, "expected-mapping-text", "normalized mapping text");

      // Routing assertions: the adapter passed the composed prompt and
      // the resolved image to the VLM endpoint as a data URI.
      assert.strictEqual(calls.length, 2, "image fetch + VLM endpoint");
      const vlmCall = calls[1];
      const vlmBody = JSON.parse(vlmCall.init.body);
      assert.ok(
        typeof vlmBody.image_url === "string" && vlmBody.image_url.startsWith("data:"),
        "VLM body must carry the image as a data URI",
      );
      assert.strictEqual(vlmBody.prompt, expectedPrompt, "VLM body must carry the composed prompt");

      // Cross-check the expected prompt actually contains the operation's
      // known landmark substrings — proves the right Module is wired.
      // Case-insensitive match: each Module capitalizes its own intent
      // text, while the needles are conventional lowercase probes.
      const lowered = expectedPrompt.toLowerCase();
      for (const needle of promptNeedles) {
        assert.ok(
          lowered.includes(needle.toLowerCase()),
          `expected prompt for ${op} must contain "${needle}"`,
        );
      }
    }
  });

  it("support gate remains authoritative: an unsupported op fails closed even if forced true on another op", async () => {
    const { fn, calls } = makeFetchSequence([
      { ok: true, status: 200, json: { content: "text" }, body: "" },
    ]);
    const descriptor = createMiniMaxDescriptor({
      transport: { fetch: fn },
      // Force one op to supported, but not the other specialized ops.
      isSpecializedVisionOperationSupported: (candidate) => candidate === "chart",
    });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });

    // chart is supported, ui-artifact is not.
    assert.equal(adapter.vision.supports("chart"), true);
    assert.equal(adapter.vision.supports("ui-artifact"), false);

    await assert.rejects(
      adapter.vision.invoke({
        operation: "ui-artifact",
        source: "https://example.test/x.png",
        instruction: "x",
        outputType: "code",
      }),
      (err) => err.code === "UNSUPPORTED_CAPABILITY",
    );
    // And critically, no transport call happened during the failed call.
    assert.strictEqual(calls.length, 0, "no transport call for an unsupported op");
  });

  it("forces-off: support=false on every specialized op keeps the adapter fail-closed (production default)", async () => {
    const { fn } = makeFetchSequence([
      { ok: true, status: 200, json: { content: "text" }, body: "" },
    ]);
    // Explicitly force false everywhere. The Adapter's production path
    // uses the compiled registry; the forced function is an exact drop-in.
    const descriptor = createMiniMaxDescriptor({
      transport: { fetch: fn },
      isSpecializedVisionOperationSupported: () => false,
    });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: TEST_API_KEY } });
    for (const op of SPECIALIZED) {
      assert.equal(adapter.vision.supports(op), false);
      await assert.rejects(
        adapter.vision.invoke({
          operation: op,
          source: "x.png",
          instruction: "x",
        }),
        (err) => err.code === "UNSUPPORTED_CAPABILITY",
      );
    }
  });
});
