/**
 * Parallel client transport — issue #56 (drain + dedupe findings).
 *
 * Surgical, atomic cases — one observable behavior per test. Pins assert
 * the existing error mapping is preserved through the dedupe refactor
 * (fail only if behavior is wrong at HEAD); drain cases assert the new
 * body-drain contract imposed by finding (a).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  fetchParallelSearch,
  fetchParallelExtract,
} from "../dist/providers/parallel/client.js";
import {
  ApiError,
  AuthError,
  NetworkError,
  QuotaError,
  TimeoutError,
  ValidationError,
} from "../dist/lib/errors.js";

const TEST_KEY = "parallel-test-api-key";

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

function makeErrorResponse({ status, body = "" } = {}) {
  const counters = { text: 0, json: 0 };
  return {
    counters,
    response: {
      ok: status >= 200 && status < 300,
      status,
      text: async () => {
        counters.text++;
        return typeof body === "string" ? body : JSON.stringify(body);
      },
      json: async () => {
        counters.json++;
        return typeof body === "string" ? JSON.parse(body) : body;
      },
    },
  };
}

function makeOkResponse(body) {
  return makeErrorResponse({ status: 200, body });
}

const TIMER_DEPS = captureOnlyTimer();
const BASE_DEPS = { setTimeout: TIMER_DEPS.setTimeout, clearTimeout: TIMER_DEPS.clearTimeout };

describe("fetchParallelSearch — transport error mapping (pins)", () => {
  it("rethrows AuthError on 401", async () => {
    const { response } = makeErrorResponse({ status: 401 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelSearch(TEST_KEY, "q", {}, { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof AuthError,
    );
  });

  it("rethrows QuotaError on 402", async () => {
    const { response } = makeErrorResponse({ status: 402 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelSearch(TEST_KEY, "q", {}, { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof QuotaError,
    );
  });

  it("rethrows TimeoutError on 408", async () => {
    const { response } = makeErrorResponse({ status: 408 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelSearch(TEST_KEY, "q", {}, { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof TimeoutError,
    );
  });

  it("rethrows ValidationError on 422", async () => {
    const { response } = makeErrorResponse({ status: 422 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelSearch(TEST_KEY, "q", {}, { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof ValidationError,
    );
  });

  it("rethrows ApiError on 429", async () => {
    const { response } = makeErrorResponse({ status: 429 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelSearch(TEST_KEY, "q", {}, { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof ApiError && err.statusCode === 429,
    );
  });

  it("maps SyntaxError from invalid JSON body to ApiError(500)", async () => {
    const { response } = makeOkResponse("{ not json");
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelSearch(TEST_KEY, "q", {}, { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof ApiError && err.statusCode === 500,
    );
  });

  it("wraps an unrelated fetch rejection into NetworkError", async () => {
    const fn = async () => { throw new TypeError("socket hang up"); };
    await assert.rejects(
      () => fetchParallelSearch(TEST_KEY, "q", {}, { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof NetworkError && /socket hang up/.test(err.message),
    );
  });
});

describe("fetchParallelSearch — drains body on !response.ok (finding a)", () => {
  it("drains the response body before throwing on 401", async () => {
    const { response, counters } = makeErrorResponse({ status: 401, body: "auth body" });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelSearch(TEST_KEY, "q", {}, { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof AuthError,
    );
    assert.ok(
      counters.text + counters.json >= 1,
      "expected the !response.ok path to drain the response body before throwing",
    );
  });
});

describe("fetchParallelExtract — transport error mapping (pins)", () => {
  it("rethrows AuthError on 401", async () => {
    const { response } = makeErrorResponse({ status: 401 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelExtract(TEST_KEY, "https://x", { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof AuthError,
    );
  });

  it("rethrows QuotaError on 402", async () => {
    const { response } = makeErrorResponse({ status: 402 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelExtract(TEST_KEY, "https://x", { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof QuotaError,
    );
  });

  it("rethrows TimeoutError on 408", async () => {
    const { response } = makeErrorResponse({ status: 408 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelExtract(TEST_KEY, "https://x", { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof TimeoutError,
    );
  });

  it("rethrows ValidationError on 422", async () => {
    const { response } = makeErrorResponse({ status: 422 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelExtract(TEST_KEY, "https://x", { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof ValidationError,
    );
  });

  it("rethrows ApiError on 429", async () => {
    const { response } = makeErrorResponse({ status: 429 });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelExtract(TEST_KEY, "https://x", { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof ApiError && err.statusCode === 429,
    );
  });

  it("maps SyntaxError from invalid JSON body to ApiError(500)", async () => {
    const { response } = makeOkResponse("{ not json");
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelExtract(TEST_KEY, "https://x", { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof ApiError && err.statusCode === 500,
    );
  });

  it("wraps an unrelated fetch rejection into NetworkError", async () => {
    const fn = async () => { throw new TypeError("socket hang up"); };
    await assert.rejects(
      () => fetchParallelExtract(TEST_KEY, "https://x", { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof NetworkError && /socket hang up/.test(err.message),
    );
  });
});

describe("fetchParallelExtract — drains body on !response.ok (finding a)", () => {
  it("drains the response body before throwing on 401", async () => {
    const { response, counters } = makeErrorResponse({ status: 401, body: "auth body" });
    const fn = async () => response;
    await assert.rejects(
      () => fetchParallelExtract(TEST_KEY, "https://x", { ...BASE_DEPS, fetch: fn }),
      (err) => err instanceof AuthError,
    );
    assert.ok(
      counters.text + counters.json >= 1,
      "expected the !response.ok path to drain the response body before throwing",
    );
  });
});
