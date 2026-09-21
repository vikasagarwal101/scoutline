/**
 * GLM-OCR layout-parsing REST client (glm-ocr lane T1, ADR-0014 D2).
 *
 * Hermetic fetch doubles — no network. Pins the wire contract of
 * `POST <base>/paas/v4/layout_parsing`:
 *   - request shape: exactly `{model:"glm-ocr", file}`, Bearer auth,
 *     JSON content type, correct base path, injectable fetch;
 *   - decode: `md_results` string required (fail closed otherwise);
 *   - 1113 detection across every wrapper shape the wire can produce;
 *   - non-1113 errors map through the existing zai error classes
 *     (no bespoke types).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseLayout, isInsufficientBalance } from "../dist/providers/zai/layout-parsing.js";
import {
  ApiError,
  AuthError,
  NetworkError,
  QuotaError,
  ScoutlineError,
  TimeoutError,
} from "../dist/lib/errors.js";

const API_KEY = "test-zai-api-key-DO-NOT-LEAK";
const NO_OP_TIMERS = { setTimeout: () => 0, clearTimeout: () => {} };

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function makeFetch(responder) {
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return responder(calls.length, input, init);
  };
  return { fetch, calls };
}

/** A fetch that aborts immediately once the timer fires synchronously. */
function makeAbortingFetch() {
  return async (input, init) => {
    if (init?.signal?.aborted) {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    }
    throw new Error("unreachable: timer should abort before respond");
  };
}

function baseRequest(overrides = {}) {
  return {
    apiKey: API_KEY,
    file: "https://example.test/doc.png",
    baseUrl: "https://api.test/api",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Decode — md_results string required, fail closed otherwise
// ---------------------------------------------------------------------------

describe("glm-ocr layout-parsing — decode", () => {
  it("a valid envelope returns md_results verbatim (everything else ignored)", async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse({
        id: "resp-1",
        created: 1770000000,
        model: "glm-ocr",
        md_results: "# Hello\n\nworld",
        layout_details: [{ index: 0, label: "text", bbox_2d: [0, 0, 1, 1], content: "x" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const text = await parseLayout(baseRequest({ fetch }), NO_OP_TIMERS);
    assert.strictEqual(text, "# Hello\n\nworld");
  });

  it("missing md_results fails closed (ApiError)", async () => {
    const { fetch } = makeFetch(() => jsonResponse({ id: "resp-1", model: "glm-ocr" }));
    await assert.rejects(parseLayout(baseRequest({ fetch }), NO_OP_TIMERS), ApiError);
  });

  it("non-string md_results fails closed (ApiError)", async () => {
    const { fetch } = makeFetch(() => jsonResponse({ md_results: 12345 }));
    await assert.rejects(parseLayout(baseRequest({ fetch }), NO_OP_TIMERS), ApiError);
  });

  it("empty / whitespace-only md_results fails closed (ApiError)", async () => {
    for (const md_results of ["", "   \n  "]) {
      const { fetch } = makeFetch(() => jsonResponse({ md_results }));
      await assert.rejects(parseLayout(baseRequest({ fetch }), NO_OP_TIMERS), ApiError);
    }
  });

  it("a 200 with a non-JSON body fails closed (ApiError)", async () => {
    const { fetch } = makeFetch(() => ({
      ok: true,
      status: 200,
      text: async () => "<html>gateway error</html>",
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    await assert.rejects(parseLayout(baseRequest({ fetch }), NO_OP_TIMERS), ApiError);
  });
});

// ---------------------------------------------------------------------------
// 1113 detection — every wrapper shape the wire can produce
// ---------------------------------------------------------------------------

describe("glm-ocr layout-parsing — isInsufficientBalance", () => {
  const TRUE_SHAPES = [
    { error: { code: 1113, message: "Insufficient balance" } },
    { error: { code: "1113", message: "Insufficient balance" } },
    { data: { error: { code: 1113 } } },
    { data: { error: { code: "1113" } } },
  ];
  const FALSE_SHAPES = [
    { error: { code: 1310, message: "quota exhausted" } },
    { error: { code: "1310" } },
    { error: { code: 1210 } },
    { error: { code: "1112" } },
    { error: { message: "Insufficient balance or no resource package" } },
    { error: {} },
    {},
    { data: "opaque" },
    null,
    "1113",
    1113,
    undefined,
  ];

  it("detects code 1113 in every wrapper shape", () => {
    for (const shape of TRUE_SHAPES) {
      assert.equal(isInsufficientBalance(shape), true, `shape ${JSON.stringify(shape)}`);
    }
  });

  it("other codes / message-only / absent shapes are NOT insufficient balance", () => {
    for (const shape of FALSE_SHAPES) {
      assert.equal(isInsufficientBalance(shape), false, `shape ${JSON.stringify(shape)}`);
    }
  });

  it("an HTTP response body carrying 1113 maps to QuotaError (any status)", async () => {
    for (const status of [200, 400, 402, 429]) {
      const { fetch } = makeFetch(() =>
        jsonResponse({ error: { code: "1113", message: "Insufficient balance" } }, status),
      );
      await assert.rejects(
        parseLayout(baseRequest({ fetch }), NO_OP_TIMERS),
        (error) => error instanceof QuotaError,
        `status ${status}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Request shape — exactly {model, file}; Bearer; base path; injectable fetch
// ---------------------------------------------------------------------------

describe("glm-ocr layout-parsing — request shape", () => {
  it("sends POST <base>/paas/v4/layout_parsing with Bearer auth and exactly {model, file}", async () => {
    const file = "https://example.test/doc.png";
    const { fetch, calls } = makeFetch(() => jsonResponse({ md_results: "ok" }));
    await parseLayout(baseRequest({ file, fetch }), NO_OP_TIMERS);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://api.test/api/paas/v4/layout_parsing");
    assert.strictEqual(calls[0].init.method, "POST");
    assert.strictEqual(calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.strictEqual(
      calls[0].init.headers["Content-Type"],
      "application/json",
      "JSON content type required",
    );
    const body = JSON.parse(calls[0].init.body);
    assert.deepStrictEqual(
      Object.keys(body).sort(),
      ["file", "model"],
      "the wire body carries exactly {model, file}",
    );
    assert.strictEqual(body.model, "glm-ocr");
    assert.strictEqual(body.file, file);
  });

  it("base64 file values pass through verbatim", async () => {
    const file = "data:application/pdf;base64,JVBERi0=";
    const { fetch, calls } = makeFetch(() => jsonResponse({ md_results: "ok" }));
    await parseLayout(baseRequest({ file, fetch }), NO_OP_TIMERS);
    assert.strictEqual(JSON.parse(calls[0].init.body).file, file);
  });

  it("default base is the plain (non-coding) api.z.ai path", async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ md_results: "ok" }));
    await parseLayout(baseRequest({ fetch, baseUrl: undefined }), NO_OP_TIMERS);
    assert.strictEqual(
      calls[0].url,
      "https://api.z.ai/api/paas/v4/layout_parsing",
      "default base must be https://api.z.ai/api (ADR-0014 D2)",
    );
  });
});

// ---------------------------------------------------------------------------
// Error taxonomy pass-through — existing zai classes, no bespoke types
// ---------------------------------------------------------------------------

describe("glm-ocr layout-parsing — error taxonomy", () => {
  const KNOWN = new Set(["ScoutlineError", "ZaiError", "QuotaError", "AuthError", "ApiError", "NetworkError", "TimeoutError"]);

  async function classify(responder) {
    const { fetch } = makeFetch(responder);
    try {
      await parseLayout(baseRequest({ fetch }), NO_OP_TIMERS);
      assert.fail("expected a rejection");
    } catch (error) {
      return error;
    }
  }

  it("401 / 403 map to AuthError", async () => {
    for (const status of [401, 403]) {
      const error = await classify(() => jsonResponse({ error: { code: "1001" } }, status));
      assert.ok(error instanceof AuthError, `status ${status}`);
    }
  });

  it("other non-2xx statuses map to ApiError carrying the status", async () => {
    for (const status of [400, 404, 422, 429, 500, 503]) {
      const error = await classify(() => jsonResponse({ error: { code: "9999" } }, status));
      assert.ok(error instanceof ApiError, `status ${status}`);
      assert.strictEqual(error.statusCode, status, `status ${status}`);
    }
  });

  it("transport failure maps to NetworkError", async () => {
    const error = await classify(() => {
      throw new TypeError("fetch failed");
    });
    assert.ok(error instanceof NetworkError);
  });

  it("timer abort maps to TimeoutError", async () => {
    const request = baseRequest({ fetch: makeAbortingFetch() });
    const error = await parseLayout(request, {
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
    }).then(
      () => assert.fail("expected a rejection"),
      (e) => e,
    );
    assert.ok(error instanceof TimeoutError);
  });

  it("every surfaced error is a known normalized class (no bespoke types)", async () => {
    const responders = [
      () => jsonResponse({ error: { code: "1113" } }, 429),
      () => jsonResponse({ error: { code: "1001" } }, 401),
      () => jsonResponse({ error: { code: "9999" } }, 500),
      () => jsonResponse({ id: "x" }),
    ];
    for (const responder of responders) {
      const error = await classify(responder);
      assert.ok(
        error instanceof ScoutlineError && KNOWN.has(error.constructor.name),
        `unexpected error class ${error.constructor?.name}`,
      );
    }
  });
});
