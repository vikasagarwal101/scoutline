/**
 * MiniMax Coding Plan direct transport — Layer T1 contract tests (C1).
 *
 * Exercises `fetchMiniMaxSearch`, `fetchMiniMaxVlm`, and
 * `convertToDataUri` directly with injected fake `fetch` (and injected
 * `setTimeout`/`clearTimeout` for the abort path). No real network, no
 * `MINIMAX_API_KEY` — pure offline, fully deterministic.
 *
 * Coverage matrix mirrors `docs/plans/minimax-direct-transport-plan.md`
 * §"Failure-Handling Layers" and the C1 ticket's "In" list. Every
 * documented Layer 1 (HTTP status) and Layer 2 (`base_resp.status_code`)
 * error code is asserted for both endpoints.
 *
 * Sentinel message-integrity invariant (relocated from B2 — the
 * Adapter-layer scrubbing tests at L531/L543 of `minimax-adapter.test.js`
 * were deleted in Phase B; their coverage moved here): the transport
 * constructs clean error messages by construction, so no raw Provider
 * body content ever reaches the thrown error's `message` or `help`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  fetchMiniMaxSearch,
  fetchMiniMaxVlm,
} from "../dist/providers/minimax/coding-plan-client.js";
import { convertToDataUri } from "../dist/providers/minimax/media.js";
import {
  ApiError,
  AuthError,
  QuotaError,
  TimeoutError,
  ValidationError,
} from "../dist/lib/errors.js";

const TEST_API_KEY = "test-minimax-api-key-DO-NOT-LEAK";
const TEST_BASE_URL = "https://api.minimax.io";
const SENTINELS = ["RAW_PROVIDER_BODY", "<html>secret</html>"];

const TEST_CONFIG = { apiKey: TEST_API_KEY, region: "global", baseUrl: TEST_BASE_URL };

// ---------------------------------------------------------------------------
// Fake fetch + timer plumbing (mirrors the pattern from
// minimax-adapter.test.js — `makeFetchSequence`/`makeResponse`).
// ---------------------------------------------------------------------------

function makeResponse({ ok = true, status = 200, json, body = "", contentType, arrayBuffer } = {}) {
  return {
    ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => json,
    headers: {
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
 * Capture the controller's `abort` callback without firing it. Lets
 * tests assert that `setTimeout` was actually used and the controller
 * was wired to it without forcing an early abort.
 */
function captureOnlyTimer() {
  const timers = [];
  return {
    setTimeout: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length;
    },
    clearTimeout: () => {},
    timers,
  };
}

/**
 * A timer that fires the first scheduled callback synchronously —
 * used to simulate `AbortController.abort()` firing before the fake
 * `fetch` resolves.
 */
function eagerAbortTimer() {
  return {
    setTimeout: (cb) => {
      // Fire immediately so the AbortController signals before fetch
      // is even awaited. The fake fetch (or its caller) is responsible
      // for observing the abort signal — see `throwAbortOnCall`.
      queueMicrotask(() => cb());
      return 1;
    },
    clearTimeout: () => {},
  };
}

// ---------------------------------------------------------------------------
// fetchMiniMaxSearch — success paths
// ---------------------------------------------------------------------------

describe("fetchMiniMaxSearch — success paths", () => {
  it("returns the raw parsed body unchanged when base_resp.status_code is 0", async () => {
    const body = {
      organic: [{ title: "T", link: "https://x", snippet: "s" }],
      base_resp: { status_code: 0 },
    };
    const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
    const out = await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn });
    assert.deepStrictEqual(out, body);
  });

  it("preserves related_searches in the raw response (search-specific field)", async () => {
    const body = {
      organic: [{ title: "T", link: "https://x", snippet: "s" }],
      related_searches: ["alpha", "beta"],
      base_resp: { status_code: 0 },
    };
    const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
    const out = await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn });
    assert.deepStrictEqual(out.related_searches, ["alpha", "beta"]);
  });

  it("treats a missing base_resp.status_code as success (envelope present, no status_code field)", async () => {
    const body = { organic: [], base_resp: {} };
    const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
    const out = await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn });
    assert.deepStrictEqual(out, body);
  });
});

// ---------------------------------------------------------------------------
// fetchMiniMaxSearch — Layer 1 HTTP status errors
// ---------------------------------------------------------------------------

describe("fetchMiniMaxSearch — Layer 1 HTTP status errors", () => {
  const AUTH_CASES = [401, 403];
  const TIMEOUT_CASES = [408, 504];
  const RATE_LIMIT_CASES = [429];
  const CLIENT_ERROR_CASES = [400, 404, 410, 422];
  const SERVER_ERROR_CASES = [500, 502, 503];

  for (const status of AUTH_CASES) {
    it(`HTTP ${status} → AuthError with MINIMAX_API_KEY help`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "SENTINEL_IGNORE" }]);
      await assert.rejects(
        fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof AuthError, `expected AuthError, got ${err.name}`);
          assert.match(err.message, /MiniMax authentication failed/i);
          assert.match(err.help ?? "", /MINIMAX_API_KEY/, `help must mention MINIMAX_API_KEY`);
          assert.strictEqual(err.code, "AUTH_ERROR");
          assert.strictEqual(err.statusCode, 401);
          return true;
        },
      );
    });
  }

  for (const status of TIMEOUT_CASES) {
    it(`HTTP ${status} → TimeoutError with MINIMAX_TIMEOUT help`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "SENTINEL_IGNORE" }]);
      await assert.rejects(
        fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${err.name}`);
          assert.strictEqual(err.code, "TIMEOUT_ERROR");
          assert.match(err.help ?? "", /MINIMAX_TIMEOUT/);
          return true;
        },
      );
    });
  }

  for (const status of RATE_LIMIT_CASES) {
    it(`HTTP ${status} → ApiError status ${status}`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "SENTINEL_IGNORE" }]);
      await assert.rejects(
        fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.strictEqual(err.code, "API_ERROR");
          assert.strictEqual(err.statusCode, status);
          assert.match(err.message, /MiniMax rate limit exceeded/);
          return true;
        },
      );
    });
  }

  for (const status of CLIENT_ERROR_CASES) {
    it(`HTTP ${status} → ApiError status ${status}`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "SENTINEL_IGNORE" }]);
      await assert.rejects(
        fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.strictEqual(err.statusCode, status);
          assert.match(err.message, /MiniMax request failed/);
          return true;
        },
      );
    });
  }

  for (const status of SERVER_ERROR_CASES) {
    it(`HTTP ${status} → ApiError status ${status}`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "SENTINEL_IGNORE" }]);
      await assert.rejects(
        fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.strictEqual(err.statusCode, status);
          assert.match(err.message, /MiniMax request failed/);
          return true;
        },
      );
    });
  }

  it("no MINIMAX_API_KEY value appears in any thrown error message or help text (Layer 1)", async () => {
    for (const status of [...AUTH_CASES, ...TIMEOUT_CASES, ...RATE_LIMIT_CASES, ...CLIENT_ERROR_CASES, ...SERVER_ERROR_CASES]) {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "" }]);
      try {
        await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn });
      } catch (err) {
        assert.ok(
          !String(err.message).includes(TEST_API_KEY),
          `status ${status}: API key leaked in message: ${err.message}`,
        );
        if (err.help) {
          assert.ok(
            !String(err.help).includes(TEST_API_KEY),
            `status ${status}: API key leaked in help: ${err.help}`,
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// fetchMiniMaxSearch — Layer 2 base_resp.status_code errors
// ---------------------------------------------------------------------------

describe("fetchMiniMaxSearch — Layer 2 base_resp.status_code errors", () => {
  // status_code → expected error class/code/statusCode/message-snippet
  const MATRIX = [
    { code: 1002, kind: "ApiError", status: 400, msg: /content filter/i },
    { code: 1004, kind: "AuthError", status: 401, msg: /MiniMax authentication failed/i, help: /MINIMAX_API_KEY/ },
    { code: 1028, kind: "QuotaError", status: 429 },
    { code: 1030, kind: "QuotaError", status: 429 },
    { code: 1039, kind: "ApiError", status: 400, msg: /content filter/i },
    {
      code: 2038,
      kind: "ApiError",
      status: 403,
      msg: /https:\/\/platform\.minimaxi\.com\/user-center\/basic-information/,
    },
    { code: 2061, kind: "ApiError", status: 403, msg: /Token Plan/i },
    { code: 9999, kind: "ApiError", status: 500, msg: /MiniMax request failed/i },
  ];

  for (const { code, kind, status, msg, help } of MATRIX) {
    it(`base_resp.status_code ${code} → ${kind} (status ${status})`, async () => {
      const body = { base_resp: { status_code: code, msg: "RAW_PROVIDER_BODY" } };
      const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
      await assert.rejects(
        fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
        (err) => {
          const expected =
            kind === "AuthError" ? AuthError : kind === "QuotaError" ? QuotaError : ApiError;
          assert.ok(err instanceof expected, `${code}: expected ${kind}, got ${err.constructor.name}`);
          assert.strictEqual(err.statusCode, status, `${code}: statusCode mismatch`);
          if (msg) assert.match(err.message, msg, `${code}: message did not match`);
          if (help) assert.match(err.help ?? "", help, `${code}: help did not match`);
          // Sentinel must NOT survive.
          assert.ok(!String(err.message).includes("RAW_PROVIDER_BODY"), `${code}: sentinel leaked`);
          return true;
        },
      );
    });
  }

  it("QuotaError (1028/1030) is terminal: retryable === false (critique C1)", async () => {
    for (const code of [1028, 1030]) {
      const body = { base_resp: { status_code: code } };
      const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
      await assert.rejects(fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }), (err) => {
        assert.ok(err instanceof QuotaError);
        assert.strictEqual(err.retryable, false, `${code}: QuotaError must be terminal`);
        return true;
      });
    }
  });

  it("no MINIMAX_API_KEY value appears in any thrown error (Layer 2)", async () => {
    for (const { code } of MATRIX) {
      const body = { base_resp: { status_code: code } };
      const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
      try {
        await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn });
      } catch (err) {
        assert.ok(
          !String(err.message).includes(TEST_API_KEY),
          `code ${code}: API key leaked in message`,
        );
        if (err.help) {
          assert.ok(
            !String(err.help).includes(TEST_API_KEY),
            `code ${code}: API key leaked in help`,
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// fetchMiniMaxSearch — malformed body paths
// ---------------------------------------------------------------------------

describe("fetchMiniMaxSearch — malformed body paths", () => {
  it("body missing base_resp entirely on HTTP 200 → ApiError status 500 (malformed)", async () => {
    const { fn } = makeFetchSequence([{ ok: true, status: 200, json: { organic: [] } }]);
    await assert.rejects(
      fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.statusCode, 500);
        assert.match(err.message, /malformed/i);
        return true;
      },
    );
  });

  it("base_resp present but not an object → ApiError status 500 (malformed)", async () => {
    const { fn } = makeFetchSequence([
      { ok: true, status: 200, json: { organic: [], base_resp: "not-an-object" } },
    ]);
    await assert.rejects(
      fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.statusCode, 500);
        return true;
      },
    );
  });

  it("body not JSON (json() throws) → ApiError status 500 (malformed)", async () => {
    const { fn } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not-json");
        },
      },
    ]);
    await assert.rejects(
      fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.statusCode, 500);
        assert.match(err.message, /malformed/i);
        assert.ok(!/not-json/.test(err.message), `raw parse error leaked: ${err.message}`);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// fetchMiniMaxSearch — abort / timeout / injected-timer
// ---------------------------------------------------------------------------

describe("fetchMiniMaxSearch — abort and timer injection", () => {
  it("AbortController fires before response → TimeoutError", async () => {
    const fetchCall = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    await assert.rejects(
      fetchMiniMaxSearch(TEST_CONFIG, "q", {
        fetch: fetchCall,
        ...eagerAbortTimer(),
      }),
      (err) => {
        assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${err.name}`);
        assert.match(err.help ?? "", /MINIMAX_TIMEOUT/);
        return true;
      },
    );
  });

  it("injected setTimeout is used (not global): controller wired to injected timer", async () => {
    const { fn, calls } = makeFetchSequence([
      { ok: true, status: 200, json: { organic: [], base_resp: { status_code: 0 } } },
    ]);
    const timer = captureOnlyTimer();
    await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn, ...timer });
    assert.strictEqual(timer.timers.length, 1, "setTimeout called exactly once");
    assert.strictEqual(timer.timers[0].ms, 30000, "default timeout is 30000ms");
    assert.strictEqual(calls.length, 1, "fetch invoked once");
  });

  it("respects MINIMAX_TIMEOUT env override for the injected setTimeout", async () => {
    const { fn } = makeFetchSequence([
      { ok: true, status: 200, json: { organic: [], base_resp: { status_code: 0 } } },
    ]);
    const timer = captureOnlyTimer();
    await fetchMiniMaxSearch(TEST_CONFIG, "q", {
      fetch: fn,
      ...timer,
      env: { MINIMAX_TIMEOUT: "5000" },
    });
    assert.strictEqual(timer.timers[0].ms, 5000);
  });

  it("maps ECONNREFUSED-class fetch error → NetworkError", async () => {
    const fetchCall = async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    };
    await assert.rejects(
      fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fetchCall }),
      (err) => {
        assert.strictEqual(err.code, "NETWORK_ERROR");
        assert.match(err.message, /MiniMax network error/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// fetchMiniMaxSearch — header surface (Authorization, MM-API-Source, etc.)
// ---------------------------------------------------------------------------

describe("fetchMiniMaxSearch — request headers", () => {
  it("sends Authorization: Bearer <key>, Content-Type, MM-API-Source, User-Agent", async () => {
    const { fn, calls } = makeFetchSequence([
      { ok: true, status: 200, json: { organic: [], base_resp: { status_code: 0 } } },
    ]);
    await fetchMiniMaxSearch(TEST_CONFIG, "rust async", { fetch: fn });
    assert.strictEqual(calls.length, 1);
    const init = calls[0].init;
    assert.strictEqual(init.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.strictEqual(init.headers["Content-Type"], "application/json");
    assert.strictEqual(init.headers["MM-API-Source"], "Scoutline");
    assert.match(init.headers["User-Agent"], /^scoutline\//);
    assert.strictEqual(init.method, "POST");
    assert.deepStrictEqual(JSON.parse(init.body), { q: "rust async" });
    assert.match(calls[0].url, /\/v1\/coding_plan\/search$/);
  });
});

// ---------------------------------------------------------------------------
// fetchMiniMaxSearch — message integrity (sentinel) across ALL error paths.
// Relocated from B2 — Adapter-layer scrubbing tests deleted; the
// invariant now lives at the transport layer.
// ---------------------------------------------------------------------------

describe("fetchMiniMaxSearch — message integrity (sentinels never leak)", () => {
  const LAYER1 = [
    400, 401, 403, 404, 408, 410, 422, 429, 500, 502, 503, 504,
  ];
  const LAYER2 = [1002, 1004, 1028, 1030, 1039, 2038, 2061, 9999];

  for (const status of LAYER1) {
    it(`Layer 1 HTTP ${status}: body sentinels do not appear in the thrown error`, async () => {
      const body = "RAW_PROVIDER_BODY <html>secret</html>";
      const { fn } = makeFetchSequence([{ ok: false, status, body }]);
      const err = await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }).then(
        () => {
          throw new Error("expected throw");
        },
        (e) => e,
      );
      for (const sentinel of SENTINELS) {
        assert.ok(
          !String(err.message).includes(sentinel),
          `HTTP ${status}: sentinel "${sentinel}" leaked into message: ${err.message}`,
        );
        if (err.help) {
          assert.ok(
            !String(err.help).includes(sentinel),
            `HTTP ${status}: sentinel "${sentinel}" leaked into help: ${err.help}`,
          );
        }
      }
    });
  }

  for (const code of LAYER2) {
    it(`Layer 2 base_resp ${code}: payload sentinels do not appear in the thrown error`, async () => {
      // Embed the sentinels in every plausible field — base_resp msg,
      // root-level msg, organic title — so we cover any field the
      // transport might have considered embedding.
      const body = {
        organic: [{ title: "RAW_PROVIDER_BODY", link: "<html>secret</html>", snippet: "s" }],
        related_searches: ["<html>secret</html>"],
        msg: "RAW_PROVIDER_BODY",
        base_resp: { status_code: code, msg: "RAW_PROVIDER_BODY", hint: "<html>secret</html>" },
      };
      const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
      const err = await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }).then(
        () => {
          throw new Error("expected throw");
        },
        (e) => e,
      );
      for (const sentinel of SENTINELS) {
        assert.ok(
          !String(err.message).includes(sentinel),
          `base_resp ${code}: sentinel "${sentinel}" leaked into message: ${err.message}`,
        );
        if (err.help) {
          assert.ok(
            !String(err.help).includes(sentinel),
            `base_resp ${code}: sentinel "${sentinel}" leaked into help: ${err.help}`,
          );
        }
      }
    });
  }

  it("malformed body: raw text does not leak into the thrown error message", async () => {
    const rawText = "RAW_PROVIDER_BODY <html>secret</html>";
    const { fn } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error(rawText);
        },
      },
    ]);
    const err = await fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn }).then(
      () => {
        throw new Error("expected throw");
      },
      (e) => e,
    );
    for (const sentinel of SENTINELS) {
      assert.ok(!String(err.message).includes(sentinel), `malformed: sentinel "${sentinel}" leaked`);
    }
  });
});

// ===========================================================================
// fetchMiniMaxVlm — mirror coverage of fetchMiniMaxSearch above. The
// transport's VLM pathway shares the same `postCodingPlanJson`
// implementation; the matrix exercises both endpoints end-to-end as the
// ticket requires.
// ===========================================================================

describe("fetchMiniMaxVlm — success paths", () => {
  it("returns the raw parsed body unchanged when base_resp.status_code is 0", async () => {
    const body = { content: "described scene", base_resp: { status_code: 0 } };
    const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
    const out = await fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn });
    assert.deepStrictEqual(out, body);
  });

  it("POSTs to /v1/coding_plan/vlm with prompt and image_url in the body", async () => {
    const body = { content: "ok", base_resp: { status_code: 0 } };
    const { fn, calls } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
    await fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "describe", { fetch: fn });
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/coding_plan\/vlm$/);
    const sent = JSON.parse(calls[0].init.body);
    assert.strictEqual(sent.prompt, "describe");
    assert.strictEqual(sent.image_url, "data:image/png;base64,AAAA");
  });
});

describe("fetchMiniMaxVlm — Layer 1 HTTP status errors", () => {
  const AUTH_CASES = [401, 403];
  const TIMEOUT_CASES = [408, 504];
  const RATE_LIMIT_CASES = [429];
  const CLIENT_ERROR_CASES = [400, 404, 410, 422];
  const SERVER_ERROR_CASES = [500, 502, 503];

  for (const status of AUTH_CASES) {
    it(`HTTP ${status} → AuthError with MINIMAX_API_KEY help`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "" }]);
      await assert.rejects(
        fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof AuthError);
          assert.match(err.message, /MiniMax authentication failed/i);
          assert.match(err.help ?? "", /MINIMAX_API_KEY/);
          return true;
        },
      );
    });
  }

  for (const status of TIMEOUT_CASES) {
    it(`HTTP ${status} → TimeoutError with MINIMAX_TIMEOUT help`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "" }]);
      await assert.rejects(
        fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof TimeoutError);
          assert.match(err.help ?? "", /MINIMAX_TIMEOUT/);
          return true;
        },
      );
    });
  }

  for (const status of RATE_LIMIT_CASES) {
    it(`HTTP ${status} → ApiError status ${status}`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "" }]);
      await assert.rejects(
        fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.strictEqual(err.statusCode, status);
          return true;
        },
      );
    });
  }

  for (const status of CLIENT_ERROR_CASES) {
    it(`HTTP ${status} → ApiError status ${status}`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "" }]);
      await assert.rejects(
        fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.strictEqual(err.statusCode, status);
          return true;
        },
      );
    });
  }

  for (const status of SERVER_ERROR_CASES) {
    it(`HTTP ${status} → ApiError status ${status}`, async () => {
      const { fn } = makeFetchSequence([{ ok: false, status, body: "" }]);
      await assert.rejects(
        fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof ApiError);
          assert.strictEqual(err.statusCode, status);
          return true;
        },
      );
    });
  }
});

describe("fetchMiniMaxVlm — Layer 2 base_resp.status_code errors", () => {
  const MATRIX = [
    { code: 1002, kind: "ApiError", status: 400, msg: /content filter/i },
    { code: 1004, kind: "AuthError", status: 401, msg: /MiniMax authentication failed/i, help: /MINIMAX_API_KEY/ },
    { code: 1028, kind: "QuotaError", status: 429 },
    { code: 1030, kind: "QuotaError", status: 429 },
    { code: 1039, kind: "ApiError", status: 400, msg: /content filter/i },
    {
      code: 2038,
      kind: "ApiError",
      status: 403,
      msg: /https:\/\/platform\.minimaxi\.com\/user-center\/basic-information/,
    },
    { code: 2061, kind: "ApiError", status: 403, msg: /Token Plan/i },
    { code: 9999, kind: "ApiError", status: 500, msg: /MiniMax request failed/i },
  ];

  for (const { code, kind, status, msg, help } of MATRIX) {
    it(`base_resp.status_code ${code} → ${kind} (status ${status})`, async () => {
      const body = { base_resp: { status_code: code } };
      const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
      await assert.rejects(
        fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
        (err) => {
          const expected =
            kind === "AuthError" ? AuthError : kind === "QuotaError" ? QuotaError : ApiError;
          assert.ok(err instanceof expected, `${code}: expected ${kind}, got ${err.constructor.name}`);
          assert.strictEqual(err.statusCode, status);
          if (msg) assert.match(err.message, msg);
          if (help) assert.match(err.help ?? "", help);
          return true;
        },
      );
    });
  }

  it("QuotaError (1028/1030) is terminal: retryable === false (critique C1)", async () => {
    for (const code of [1028, 1030]) {
      const body = { base_resp: { status_code: code } };
      const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
      await assert.rejects(
        fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
        (err) => {
          assert.ok(err instanceof QuotaError);
          assert.strictEqual(err.retryable, false);
          return true;
        },
      );
    }
  });
});

describe("fetchMiniMaxVlm — malformed body paths", () => {
  it("body missing base_resp on HTTP 200 → ApiError status 500", async () => {
    const { fn } = makeFetchSequence([{ ok: true, status: 200, json: { content: "x" } }]);
    await assert.rejects(
      fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.statusCode, 500);
        return true;
      },
    );
  });

  it("body not JSON → ApiError status 500", async () => {
    const { fn } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("not-json");
        },
      },
    ]);
    await assert.rejects(
      fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.statusCode, 500);
        return true;
      },
    );
  });
});

describe("fetchMiniMaxVlm — abort and timer injection", () => {
  it("AbortController fires before response → TimeoutError", async () => {
    const fetchCall = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    await assert.rejects(
      fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", {
        fetch: fetchCall,
        ...eagerAbortTimer(),
      }),
      (err) => {
        assert.ok(err instanceof TimeoutError);
        return true;
      },
    );
  });

  it("injected setTimeout is used (not global)", async () => {
    const { fn } = makeFetchSequence([
      { ok: true, status: 200, json: { content: "ok", base_resp: { status_code: 0 } } },
    ]);
    const timer = captureOnlyTimer();
    await fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn, ...timer });
    assert.strictEqual(timer.timers.length, 1);
    assert.strictEqual(timer.timers[0].ms, 30000);
  });
});

describe("fetchMiniMaxVlm — request headers", () => {
  it("sends Authorization: Bearer <key>, Content-Type, MM-API-Source, User-Agent", async () => {
    const { fn, calls } = makeFetchSequence([
      { ok: true, status: 200, json: { content: "ok", base_resp: { status_code: 0 } } },
    ]);
    await fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "describe", { fetch: fn });
    const init = calls[0].init;
    assert.strictEqual(init.headers.Authorization, `Bearer ${TEST_API_KEY}`);
    assert.strictEqual(init.headers["Content-Type"], "application/json");
    assert.strictEqual(init.headers["MM-API-Source"], "Scoutline");
    assert.match(init.headers["User-Agent"], /^scoutline\//);
  });
});

describe("fetchMiniMaxVlm — message integrity (sentinels never leak)", () => {
  const LAYER1 = [400, 401, 403, 404, 408, 410, 422, 429, 500, 502, 503, 504];
  const LAYER2 = [1002, 1004, 1028, 1030, 1039, 2038, 2061, 9999];

  for (const status of LAYER1) {
    it(`Layer 1 HTTP ${status}: sentinels do not appear in thrown error`, async () => {
      const body = "RAW_PROVIDER_BODY <html>secret</html>";
      const { fn } = makeFetchSequence([{ ok: false, status, body }]);
      const err = await fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", {
        fetch: fn,
      }).then(
        () => {
          throw new Error("expected throw");
        },
        (e) => e,
      );
      for (const sentinel of SENTINELS) {
        assert.ok(
          !String(err.message).includes(sentinel),
          `HTTP ${status}: sentinel "${sentinel}" leaked`,
        );
      }
    });
  }

  for (const code of LAYER2) {
    it(`Layer 2 base_resp ${code}: sentinels do not appear in thrown error`, async () => {
      const body = {
        content: "RAW_PROVIDER_BODY",
        extra: "<html>secret</html>",
        base_resp: { status_code: code, msg: "RAW_PROVIDER_BODY" },
      };
      const { fn } = makeFetchSequence([{ ok: true, status: 200, json: body }]);
      const err = await fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", {
        fetch: fn,
      }).then(
        () => {
          throw new Error("expected throw");
        },
        (e) => e,
      );
      for (const sentinel of SENTINELS) {
        assert.ok(
          !String(err.message).includes(sentinel),
          `base_resp ${code}: sentinel "${sentinel}" leaked`,
        );
      }
    });
  }
});

// ===========================================================================
// convertToDataUri — passthrough, HTTP, local file, MIME detection
// ===========================================================================

describe("convertToDataUri — passthrough", () => {
  it("returns a data: URI unchanged", async () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    const out = await convertToDataUri(dataUri);
    assert.strictEqual(out, dataUri);
  });
});

describe("convertToDataUri — HTTP source", () => {
  it("fetches bytes, detects MIME from Content-Type (image/png)", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { fn, calls } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        contentType: "image/png",
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      },
    ]);
    const out = await convertToDataUri("https://example.test/img.png", { fetch: fn });
    assert.match(out, /^data:image\/png;base64,/);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://example.test/img.png");
    assert.strictEqual(calls[0].init.method, "GET");
  });

  it("strips ; parameters from Content-Type (image/png; charset=utf-8)", async () => {
    const bytes = Buffer.from([0]);
    const { fn } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        contentType: "image/png; charset=utf-8",
        arrayBuffer: async () => bytes.buffer,
      },
    ]);
    const out = await convertToDataUri("https://example.test/img.png", { fetch: fn });
    assert.match(out, /^data:image\/png;base64,/);
  });

  it("missing Content-Type falls back to image/jpeg", async () => {
    const bytes = Buffer.from([0]);
    const { fn } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        contentType: undefined,
        arrayBuffer: async () => bytes.buffer,
      },
    ]);
    const out = await convertToDataUri("https://example.test/img", { fetch: fn });
    assert.match(out, /^data:image\/jpeg;base64,/);
  });

  it("application/octet-stream falls back to image/jpeg", async () => {
    const bytes = Buffer.from([0]);
    const { fn } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        contentType: "application/octet-stream",
        arrayBuffer: async () => bytes.buffer,
      },
    ]);
    const out = await convertToDataUri("https://example.test/img", { fetch: fn });
    assert.match(out, /^data:image\/jpeg;base64,/);
  });

  it("uppercase MIME variants (Image/JPEG, IMAGE/PNG, image/WEBP) matched case-insensitively", async () => {
    const cases = [
      ["image/jpeg", "image/jpeg"],
      ["image/png", "image/png"],
      ["image/webp", "image/webp"],
      ["Image/JPEG", "image/jpeg"],
      ["IMAGE/PNG", "image/png"],
      ["image/JPG", "image/jpeg"],
      ["image/WebP", "image/webp"],
    ];
    for (const [sent, expected] of cases) {
      const bytes = Buffer.from([0]);
      const { fn } = makeFetchSequence([
        {
          ok: true,
          status: 200,
          contentType: sent,
          arrayBuffer: async () => bytes.buffer,
        },
      ]);
      const out = await convertToDataUri("https://example.test/img", { fetch: fn });
      assert.ok(
        out.startsWith(`data:${expected};base64,`),
        `Content-Type ${sent} → ${out.slice(0, 30)}`,
      );
    }
  });

  it("HTTP source larger than 50 MiB → ValidationError with format help", async () => {
    // 50 MiB + 1 byte. We don't materialize the full buffer — fake
    // fetch returns an ArrayBuffer that reports its byteLength.
    const oversized = new ArrayBuffer(50 * 1024 * 1024 + 1);
    const { fn } = makeFetchSequence([
      {
        ok: true,
        status: 200,
        contentType: "image/png",
        arrayBuffer: async () => oversized,
      },
    ]);
    await assert.rejects(
      convertToDataUri("https://example.test/img", { fetch: fn }),
      (err) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err.name}`);
        assert.match(err.message, /too large/i);
        assert.match(err.help ?? "", /50 MiB/);
        return true;
      },
    );
  });

  it("HTTP source fetch non-2xx → ApiError with status code", async () => {
    const { fn } = makeFetchSequence([{ ok: false, status: 404, body: "" }]);
    await assert.rejects(
      convertToDataUri("https://example.test/img", { fetch: fn }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.statusCode, 404);
        assert.match(err.message, /Failed to download image/i);
        return true;
      },
    );
  });

  it("HTTP source fetch timeout (injected setTimeout fires abort) → TimeoutError", async () => {
    const fetchCall = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    await assert.rejects(
      convertToDataUri("https://example.test/img", { fetch: fetchCall, ...eagerAbortTimer() }),
      (err) => {
        assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${err.name}`);
        return true;
      },
    );
  });
});

describe("convertToDataUri — local file", () => {
  let tmp;
  async function setup() {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mm-ctd-"));
  }
  async function teardown() {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  // Per-extension MIME coverage. Each test sets up its own tmpdir and
  // cleans up in a finally block.

  it("local .jpg → image/jpeg", async () => {
    await setup();
    try {
      const f = path.join(tmp, "img.jpg");
      await fs.writeFile(f, Buffer.from([0xff, 0xd8]));
      const out = await convertToDataUri(f);
      assert.match(out, /^data:image\/jpeg;base64,/);
    } finally {
      await teardown();
    }
  });

  it("local .jpeg → image/jpeg", async () => {
    await setup();
    try {
      const f = path.join(tmp, "img.jpeg");
      await fs.writeFile(f, Buffer.from([0xff, 0xd8]));
      const out = await convertToDataUri(f);
      assert.match(out, /^data:image\/jpeg;base64,/);
    } finally {
      await teardown();
    }
  });

  it("local .png → image/png", async () => {
    await setup();
    try {
      const f = path.join(tmp, "img.png");
      await fs.writeFile(f, Buffer.from([0x89, 0x50]));
      const out = await convertToDataUri(f);
      assert.match(out, /^data:image\/png;base64,/);
    } finally {
      await teardown();
    }
  });

  it("local .webp → image/webp", async () => {
    await setup();
    try {
      const f = path.join(tmp, "img.webp");
      await fs.writeFile(f, Buffer.from([0x52, 0x49]));
      const out = await convertToDataUri(f);
      assert.match(out, /^data:image\/webp;base64,/);
    } finally {
      await teardown();
    }
  });

  it("local .JPG (uppercase extension) → image/jpeg", async () => {
    await setup();
    try {
      const f = path.join(tmp, "img.JPG");
      await fs.writeFile(f, Buffer.from([0xff, 0xd8]));
      const out = await convertToDataUri(f);
      assert.match(out, /^data:image\/jpeg;base64,/);
    } finally {
      await teardown();
    }
  });

  it("smoke-test: convertToDataUri reads the path returned by resolveImageSource", async () => {
    // Resolves to absolute path; convertToDataUri reads it.
    await setup();
    try {
      const f = path.join(tmp, "abs.png");
      await fs.writeFile(f, Buffer.from([0]));
      // Use the local resolution helper from media.ts. Imported here
      // for the smoke test only — the focused size check lives in the
      // existing resolveImageSource suite.
      const { resolveImageSource } = await import("../dist/providers/minimax/media.js");
      const resolved = resolveImageSource(f);
      assert.strictEqual(resolved, f);
      const out = await convertToDataUri(resolved);
      assert.match(out, /^data:image\/png;base64,/);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// QuotaError retryability invariant (cross-cutting; mirrored from the
// ticket's "Cross-cutting assertions" list).
// ---------------------------------------------------------------------------

describe("QuotaError — terminal retry guarantee (cross-cutting)", () => {
  it("every QuotaError thrown by either endpoint has retryable === false", async () => {
    for (const endpoint of [
      ["search", (fn) => fetchMiniMaxSearch(TEST_CONFIG, "q", { fetch: fn })],
      ["vlm", (fn) => fetchMiniMaxVlm(TEST_CONFIG, "data:image/png;base64,AAAA", "p", { fetch: fn })],
    ]) {
      for (const code of [1028, 1030]) {
        const { fn } = makeFetchSequence([{ ok: true, status: 200, json: { base_resp: { status_code: code } } }]);
        await assert.rejects(endpoint[1](fn), (err) => {
          assert.ok(err instanceof QuotaError, `${endpoint[0]} ${code}: expected QuotaError`);
          assert.strictEqual(err.retryable, false, `${endpoint[0]} ${code}: must be terminal`);
          return true;
        });
      }
    }
  });
});