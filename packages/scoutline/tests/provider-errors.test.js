/**
 * Provider Errors — retry classification and code/exit mapping (P2-02).
 *
 * Asserts the normalized error contract from DESIGN.md §4 + §10:
 * validation, authentication, unsupported Capability, and unsupported
 * option errors are terminal (zero retries); normalized timeout,
 * network, HTTP 429, 500, 502, 503, and 504 equivalents are retryable;
 * all other API status codes are terminal. Drives the behaviour through
 * `executeProviderOperation` so the classification remains an internal
 * contract of the shared execution layer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeProviderOperation } from "../dist/lib/execution.js";
import {
  AuthError,
  ApiError,
  NetworkError,
  TimeoutError,
  ValidationError,
  UnsupportedCapabilityError,
  UnsupportedOptionError,
  ScoutlineError,
  getErrorExitCode,
} from "../dist/lib/errors.js";

function makeDeps() {
  const sleeps = [];
  const randoms = [];
  return {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => {
      const v = 0.5;
      randoms.push(v);
      return v;
    },
    sleeps,
    randoms,
  };
}

function expectImmediateReject(ErrorFactory) {
  return async () => {
    const deps = makeDeps();
    let calls = 0;
    await assert.rejects(
      executeProviderOperation(
        "search",
        async () => {
          calls += 1;
          throw ErrorFactory();
        },
        deps,
        { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 1, jitterMs: 0 },
      ),
    );
    assert.strictEqual(calls, 1, `${ErrorFactory.name} must not retry`);
    assert.strictEqual(deps.sleeps.length, 0, `${ErrorFactory.name} must not sleep`);
  };
}

function expectRetryable(ErrorFactory) {
  return async () => {
    const deps = makeDeps();
    let calls = 0;
    const out = await executeProviderOperation(
      "search",
      async () => {
        calls += 1;
        if (calls === 1) throw ErrorFactory();
        return "ok";
      },
      deps,
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, jitterMs: 0 },
    );
    assert.strictEqual(out, "ok", `${ErrorFactory.name} should be retryable`);
    assert.strictEqual(calls, 2);
    assert.strictEqual(deps.sleeps.length, 1);
  };
}

describe("provider errors — terminal classification (no retries)", () => {
  it("validation, auth, unsupported, and non-retryable API errors are terminal", async () => {
    const cases = [
      ["validation", () => new ValidationError("bad")],
      ["auth", () => new AuthError("nope")],
      ["unsupported capability", () => new UnsupportedCapabilityError("minimax", "vision.video")],
      ["unsupported option", () => new UnsupportedOptionError("minimax", "search", "recency")],
      ...[400, 401, 403, 404, 422].map((code) => [
        `API ${code}`,
        () => new ApiError(`http ${code}`, code),
      ]),
    ];
    for (const [label, factory] of cases) {
      await expectImmediateReject(factory)().catch((error) => {
        error.message = `${label}: ${error.message}`;
        throw error;
      });
    }
  });
});

describe("provider errors — retryable classification", () => {
  it(
    "TimeoutError is retryable",
    expectRetryable(() => new TimeoutError(1000)),
  );
  it(
    "NetworkError is retryable",
    expectRetryable(() => new NetworkError("down")),
  );
  it("API 429 and retryable 5xx statuses are retryable", async () => {
    for (const code of [429, 500, 502, 503, 504]) {
      await expectRetryable(() => new ApiError(`http ${code}`, code))();
    }
  });
});

describe("provider errors — explicit retryable flag is honoured as a safety hatch", () => {
  it("ScoutlineError with retryable=true is retried regardless of code", async () => {
    const deps = makeDeps();
    let calls = 0;
    const out = await executeProviderOperation(
      "search",
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new ScoutlineError("custom", "UNKNOWN_ERROR", { retryable: true });
        }
        return "ok";
      },
      deps,
      { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitterMs: 0 },
    );
    assert.strictEqual(out, "ok");
    assert.strictEqual(calls, 2);
  });

  it("retry classification is driven by code + statusCode, not the default retryable field", async () => {
    // NetworkError sets retryable=false (legacy default). Execution still
    // retries because the code is NETWORK_ERROR. This documents that the
    // execution layer is the single owner of retry policy and does not
    // blindly trust the legacy `retryable` field default.
    const deps = makeDeps();
    let calls = 0;
    const out = await executeProviderOperation(
      "search",
      async () => {
        calls += 1;
        if (calls === 1) throw new NetworkError("down");
        return "ok";
      },
      deps,
      { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitterMs: 0 },
    );
    assert.strictEqual(out, "ok");
    assert.strictEqual(calls, 2);
  });
});

describe("provider errors — non-ScoutlineError never retries", () => {
  it("a plain Error is terminal (Adapters must normalize)", async () => {
    const deps = makeDeps();
    let calls = 0;
    await assert.rejects(
      executeProviderOperation(
        "search",
        async () => {
          calls += 1;
          throw new Error("plain");
        },
        deps,
        { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1, jitterMs: 0 },
      ),
    );
    assert.strictEqual(calls, 1);
    assert.strictEqual(deps.sleeps.length, 0);
  });
});

describe("provider errors — exit codes", () => {
  it("normalized and unknown terminal errors exit 1", () => {
    assert.strictEqual(getErrorExitCode(new ValidationError("x")), 1);
    assert.strictEqual(getErrorExitCode(new UnsupportedCapabilityError("minimax", "search")), 1);
    assert.strictEqual(getErrorExitCode(new Error("x")), 1);
  });
});

// ---------------------------------------------------------------------------
// P3-01 — Vision capability error shape
//
// Unsupported Vision capabilities identify Provider AND Capability, use
// exit 1, are non-retryable, and contain no source path or credential.
// The shared `isRetryableError` (used by the retry layer) returns false.
// ---------------------------------------------------------------------------

describe("provider errors — Vision capability error shape (P3-01)", () => {
  it("UnsupportedCapabilityError for vision identifies provider and capability", () => {
    const err = new UnsupportedCapabilityError("minimax", "vision.diff");
    assert.strictEqual(err.code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(err.name, "UnsupportedCapabilityError");
    assert.match(err.message, /minimax/);
    assert.match(err.message, /vision\.diff/);
    assert.strictEqual(err.retryable, false);
    assert.strictEqual(getErrorExitCode(err), 1);
  });

  it("error does not leak source paths or credentials in its message", () => {
    const err = new UnsupportedCapabilityError("minimax", "vision.video");
    // The constructor only takes provider + capability; if either used
    // untrusted input here the leak test below would catch it. We guard
    // against future maintainers expanding the signature.
    assert.ok(!/\/secrets\//.test(err.message));
    assert.ok(!/credential/i.test(err.message));
  });
});
