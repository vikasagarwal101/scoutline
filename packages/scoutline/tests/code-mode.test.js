/**
 * ZaiCodeModeClient — error message scrubbing (Fixup C — B-code-mode).
 *
 * Verifies the same NFR-006 raw-error-message scrubbing applied to
 * `ZaiMcpClient` (Fixup B — B2) on `ZaiCodeModeClient`. The init path
 * embeds Provider/transport error content via `error.message`; that
 * material may carry a raw Provider response body, which MUST NOT reach
 * the public error envelope.
 *
 * The production constructor accepts a `clientFactory` injection seam so
 * the test can substitute a fake without spinning up a real UTCP client.
 * Each error path is verified by injecting a factory whose `create()`
 * rejects with the same shape UTCP would reject with, then asserting
 * that the surfaced typed error's message does not contain the raw
 * Provider/transport body.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ZaiCodeModeClient } from "../dist/lib/code-mode.js";
import { formatErrorOutput } from "../dist/lib/output.js";
import { ApiError, AuthError } from "../dist/lib/errors.js";

// P6-08A: install a test-local fake credential so the init path's
// ambient `getApiKey()` lookup (reached through `buildMcpCallTemplate`)
// resolves cleanly when the offline suite runs with all Provider
// credentials stripped. Restored in `after` so no value leaks across
// suites.
const FAKE_TEST_API_KEY = "test-fake-code-mode-key-DO-NOT-USE";
const savedCreds = { Z_AI_API_KEY: undefined, ZAI_API_KEY: undefined };
let savedFetch;
before(() => {
  savedCreds.Z_AI_API_KEY = process.env.Z_AI_API_KEY;
  savedCreds.ZAI_API_KEY = process.env.ZAI_API_KEY;
  process.env.Z_AI_API_KEY = FAKE_TEST_API_KEY;
  delete process.env.ZAI_API_KEY;
  // #135: registerManual failures now trigger the failure-path auth
  // probe (issue #117 pattern). Stub fetch file-wide with an
  // inconclusive answer (200, no numeric 401/403 body code) so the
  // legacy registration-failure tests below stay offline AND keep
  // asserting the sanitized ApiError shape. Tests that assert probe
  // classification install their own fetch double via withMockFetch.
  savedFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ healthy: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
});
after(() => {
  for (const [key, value] of Object.entries(savedCreds)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedFetch !== undefined) globalThis.fetch = savedFetch;
});

const RAW_BODY = '{"error":"RAW_CODE_MODE_BODY","detail":"<html>secret</html>"}';

/** Build a ZaiCodeModeClient whose UTCP factory rejects with `error`. */
function codeModeThrowing(error) {
  return new ZaiCodeModeClient({
    clientFactory: async () => {
      throw error;
    },
  });
}

describe("ZaiCodeModeClient — raw Provider body scrubbing (Fixup C — B-code-mode, NFR-006)", () => {
  it("an auth-shaped rejection does not embed the raw Provider body", async () => {
    const client = codeModeThrowing(new Error(`401 unauthorized: ${RAW_BODY}`));
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.strictEqual(err.code, "AUTH_ERROR");
        assert.ok(!err.message.includes("RAW_CODE_MODE_BODY"), `raw body leaked: ${err.message}`);
        assert.ok(!err.message.includes("<html>"), `html leaked: ${err.message}`);
        return true;
      });
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("a timeout-shaped rejection does not embed the raw Provider body", async () => {
    const client = codeModeThrowing(new Error(`ETIMEDOUT ${RAW_BODY}`));
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.strictEqual(err.code, "TIMEOUT_ERROR");
        assert.ok(!err.message.includes("RAW_CODE_MODE_BODY"), `raw body leaked: ${err.message}`);
        return true;
      });
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("a network-shaped rejection does not embed the raw Provider body", async () => {
    const client = codeModeThrowing(new Error(`ECONNREFUSED ${RAW_BODY}`));
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.strictEqual(err.code, "NETWORK_ERROR");
        assert.ok(!err.message.includes("RAW_CODE_MODE_BODY"), `raw body leaked: ${err.message}`);
        return true;
      });
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("a generic init failure surfaces a clean typed error without the raw Provider body", async () => {
    const client = codeModeThrowing(new Error(`provider said: ${RAW_BODY}`));
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.ok(!err.message.includes("RAW_CODE_MODE_BODY"), `raw body leaked: ${err.message}`);
        assert.ok(!err.message.includes("<html>"), `html leaked: ${err.message}`);
        return true;
      });
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("raw body never reaches formatErrorOutput public envelope", async () => {
    // Generic-init path: the factory rejects with a plain Error that
    // embeds a raw Provider response body. _doInit() must wrap that into
    // a clean typed ApiError so formatErrorOutput never sees the raw
    // body.
    const client = codeModeThrowing(new Error(`upstream said: ${RAW_BODY}`));
    let captured;
    try {
      try {
        await client.callToolChain("code");
      } catch (err) {
        captured = err;
      }
    } finally {
      await client.close().catch(() => {});
    }
    const formatted = formatErrorOutput(captured, "data");
    assert.ok(!formatted.includes("RAW_CODE_MODE_BODY"), `raw body reached output: ${formatted}`);
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.code, "API_ERROR");
  });

  it("preserves an already-typed AuthError passed through the factory", async () => {
    // When the UTCP layer surfaces a typed AuthError (e.g. a 401
    // response was mapped upstream) the Code Mode client must NOT
    // re-wrap it as a generic ApiError — the retry classifier reads
    // the class. The init()-time error pattern check still applies
    // through the underlying message text.
    const client = codeModeThrowing(new AuthError(`401 ${RAW_BODY}`));
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.ok(err instanceof AuthError, "AuthError class preserved");
        assert.strictEqual(err.code, "AUTH_ERROR");
        assert.ok(!err.message.includes("RAW_CODE_MODE_BODY"), `raw body leaked: ${err.message}`);
        return true;
      });
    } finally {
      await client.close().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Fixup D — B2-remaining: INIT path raw-body scrubbing for Code Mode.
//
// registerManual() failures used to embed the raw error strings into the
// public ApiError message. If the Provider returned a raw response body in
// the registration errors, it leaked to public output. The init path must
// scrub the same way the factory-rejection path does.
// ---------------------------------------------------------------------------

describe("ZaiCodeModeClient — init registration raw-body scrubbing (Fixup D — B2-remaining)", () => {
  const INIT_RAW_BODY = '{"error":"RAW_CODE_MODE_INIT_BODY","detail":"<html>secret</html>"}';

  /** Build a client whose factory returns a fake that fails registerManual. */
  function clientWithRegistrationFailure() {
    const fakeClient = {
      registerManual() {
        return Promise.resolve({ success: false, errors: [INIT_RAW_BODY] });
      },
      callToolChain() {
        return Promise.reject(new Error("should not reach callToolChain"));
      },
      getAllToolsTypeScriptInterfaces() {
        return Promise.reject(new Error("should not reach getAllToolsTypeScriptInterfaces"));
      },
      close() {
        return Promise.resolve();
      },
    };
    return new ZaiCodeModeClient({
      clientFactory: async () => fakeClient,
    });
  }

  it("registerManual failure does not embed the raw body in the public error", async () => {
    const client = clientWithRegistrationFailure();
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.ok(
          !err.message.includes("RAW_CODE_MODE_INIT_BODY"),
          `raw body leaked into init message: ${err.message}`,
        );
        assert.ok(!err.message.includes("<html>"), `html leaked into init message: ${err.message}`);
        return true;
      });
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("registerManual failure preserves statusCode 500 for retry classification", async () => {
    const client = clientWithRegistrationFailure();
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.strictEqual(err.statusCode, 500, `expected 500, got ${err.statusCode}`);
        return true;
      });
    } finally {
      await client.close().catch(() => {});
    }
  });

  it("raw init body never reaches formatErrorOutput public envelope", async () => {
    const client = clientWithRegistrationFailure();
    let captured;
    try {
      try {
        await client.callToolChain("code");
      } catch (err) {
        captured = err;
      }
    } finally {
      await client.close().catch(() => {});
    }
    const formatted = formatErrorOutput(captured, "data");
    assert.ok(
      !formatted.includes("RAW_CODE_MODE_INIT_BODY"),
      `raw init body reached public output: ${formatted}`,
    );
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.code, "API_ERROR");
  });

  it("registerManual failure never writes the raw body directly to process stderr", async () => {
    const client = clientWithRegistrationFailure();
    const writes = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = function (chunk) {
      writes.push(String(chunk));
      return true;
    };
    try {
      await assert.rejects(client.callToolChain("code"));
    } finally {
      process.stderr.write = originalWrite;
      await client.close().catch(() => {});
    }
    const outwardText = writes.join("");
    assert.ok(
      !outwardText.includes("RAW_CODE_MODE_INIT_BODY"),
      `raw init body reached process stderr: ${outwardText}`,
    );
  });

  it("typed init ApiError is rewrapped without its raw message while preserving status", async () => {
    const client = codeModeThrowing(new ApiError(INIT_RAW_BODY, 503));
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.strictEqual(err.statusCode, 503);
        assert.ok(
          !err.message.includes("RAW_CODE_MODE_INIT_BODY"),
          `typed init ApiError leaked: ${err.message}`,
        );
        return true;
      });
    } finally {
      await client.close().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// #135 — auth classification for Code Mode init failures (the #117/#128
// pattern mirrored from ZaiMcpClient). registerManual reports failure as
// an opaque sentinel-tagged ApiError whose message never carried the
// Provider body (zod drops the values); one bounded failure-path probe
// against the MCP endpoint recovers the real status. 401/403 —
// HTTP-level or Z.AI's 200-wrapped {"code":401,...} — surfaces as
// AUTH_ERROR with credential guidance; everything else keeps the
// sanitized ApiError.
// ---------------------------------------------------------------------------

describe("ZaiCodeModeClient — failure-path auth probe (issue #135)", () => {
  /** Patch globalThis.fetch for `fn`; restore after. */
  async function withMockFetch(makeHandler, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = makeHandler(real);
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  }

  function urlOf(input) {
    return String(input instanceof URL ? input : (input?.url ?? input));
  }

  // Byte-exact Z.AI auth rejection (issue #117's curl-observed shape):
  // HTTP 200 wrapping the provider's {"code":401,...} body.
  const AUTH_REJECTION_BODY = JSON.stringify({
    code: 401,
    msg: "token expired or incorrect",
    success: false,
  });

  /** A fetch handler answering every api.z.ai request with `body` at `status`. */
  const zaiFetch = (body, status) => () => async (input, init) => {
    if (!urlOf(input).includes("api.z.ai")) {
      throw new Error(`unexpected non-probe fetch in #135 suite: ${urlOf(input)}`);
    }
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };

  const PROBE_ENV = { Z_AI_API_KEY: "expired-dummy-key" };

  /** Fake UTCP client whose registerManual always reports failure. */
  function registrationFailureFake() {
    return {
      registerManual() {
        return Promise.resolve({
          success: false,
          errors: ["Unrecognized keys: code,msg,success"],
        });
      },
      callToolChain() {
        return Promise.reject(new Error("should not reach callToolChain"));
      },
      getAllToolsTypeScriptInterfaces() {
        return Promise.reject(new Error("should not reach getAllInterfaces"));
      },
      close() {
        return Promise.resolve();
      },
    };
  }

  it("401-in-200 registration failure classifies as AUTH_ERROR with credential guidance (red pin)", async () => {
    await withMockFetch(zaiFetch(AUTH_REJECTION_BODY, 200), async () => {
      const client = new ZaiCodeModeClient({
        env: PROBE_ENV,
        clientFactory: async () => registrationFailureFake(),
      });
      try {
        await assert.rejects(client.callToolChain("code"), (err) => {
          assert.strictEqual(
            err.code,
            "AUTH_ERROR",
            `expected AUTH_ERROR, got ${err.code} (${err.message})`,
          );
          assert.strictEqual(err.statusCode, 401, `expected 401, got ${err.statusCode}`);
          assert.match(err.message, /token expired or incorrect/);
          assert.match(err.message, /Z_AI_API_KEY/);
          // Sanitization: the message is static guidance, not the body.
          assert.ok(!err.message.includes('"code"'), `raw body leaked: ${err.message}`);
          assert.ok(!err.message.includes("success"), `raw body keys leaked: ${err.message}`);
          return true;
        });
      } finally {
        await client.close().catch(() => {});
      }
    });
  });

  it("HTTP-401 registration failure classifies as AUTH_ERROR (probe reads the status)", async () => {
    await withMockFetch(zaiFetch("Unauthorized", 401), async () => {
      const client = new ZaiCodeModeClient({
        env: PROBE_ENV,
        clientFactory: async () => registrationFailureFake(),
      });
      try {
        await assert.rejects(client.callToolChain("code"), (err) => {
          assert.strictEqual(err.code, "AUTH_ERROR");
          assert.strictEqual(err.statusCode, 401);
          return true;
        });
      } finally {
        await client.close().catch(() => {});
      }
    });
  });

  it("probe inconclusive (200, no numeric code) keeps the sanitized API_ERROR envelope", async () => {
    await withMockFetch(zaiFetch(JSON.stringify({ healthy: true }), 200), async () => {
      const client = new ZaiCodeModeClient({
        env: PROBE_ENV,
        clientFactory: async () => registrationFailureFake(),
      });
      try {
        await assert.rejects(client.callToolChain("code"), (err) => {
          assert.strictEqual(err.code, "API_ERROR");
          assert.strictEqual(err.statusCode, 500);
          assert.ok(!err.message.includes("healthy"), `body text leaked: ${err.message}`);
          return true;
        });
      } finally {
        await client.close().catch(() => {});
      }
    });
  });

  it("factory-thrown ApiError NEVER probes — original status surfaces, zero network (#128 parity)", async () => {
    // A factory/transport-thrown ApiError is NOT the registerManual-failure
    // class (no sentinel): it must fail fast with its own status preserved
    // and issue zero probe network requests — a 401/403 probe answer would
    // say nothing about that failure's cause.
    const seenBodies = [];
    const client = new ZaiCodeModeClient({
      env: PROBE_ENV,
      clientFactory: async () => {
        throw new ApiError("factory transport construction failed", 503);
      },
    });
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (!urlOf(input).includes("api.z.ai")) {
        throw new Error(`unexpected fetch in #135 no-probe test: ${urlOf(input)}`);
      }
      seenBodies.push(String(init?.body ?? ""));
      return new Response(AUTH_REJECTION_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      await assert.rejects(client.callToolChain("code"), (err) => {
        assert.strictEqual(err.code, "API_ERROR");
        assert.strictEqual(err.statusCode, 503, `original status preserved, got ${err.statusCode}`);
        assert.ok(
          !err.message.includes("factory transport"),
          `original message leaked: ${err.message}`,
        );
        return true;
      });
      assert.strictEqual(
        seenBodies.length,
        0,
        "no probe request may fire for a factory-thrown ApiError",
      );
    } finally {
      globalThis.fetch = real;
      await client.close().catch(() => {});
    }
  });

  it("probe timeout bound resolves from the injected env — Z_AI_TIMEOUT honored, junk never NaN (PR #142 review)", async () => {
    // The probe's AbortSignal.timeout argument must derive from the SAME
    // resolved environment the registration template uses: an injected
    // { Z_AI_TIMEOUT: "1000" } caps the probe at 1s, and a junk value
    // falls back to the 30s default (min→5s probe cap) instead of NaN —
    // AbortSignal.timeout(NaN) throws and would silently disable the
    // probe via the catch-all null.
    const delays = [];
    const origTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => {
      delays.push(ms);
      return origTimeout(ms);
    };
    try {
      await withMockFetch(zaiFetch(AUTH_REJECTION_BODY, 200), async () => {
        const envBounded = new ZaiCodeModeClient({
          env: { Z_AI_API_KEY: "expired-dummy-key", Z_AI_TIMEOUT: "1000" },
          clientFactory: async () => registrationFailureFake(),
        });
        try {
          await assert.rejects(envBounded.callToolChain("code"), (err) => {
            assert.strictEqual(err.code, "AUTH_ERROR");
            return true;
          });
        } finally {
          await envBounded.close().catch(() => {});
        }

        const envJunk = new ZaiCodeModeClient({
          env: { Z_AI_API_KEY: "expired-dummy-key", Z_AI_TIMEOUT: "not-a-number" },
          clientFactory: async () => registrationFailureFake(),
        });
        try {
          // Must surface the sanitized error, not a TypeError from a
          // NaN probe bound.
          await assert.rejects(envJunk.callToolChain("code"), (err) => {
            assert.strictEqual(err.code, "AUTH_ERROR");
            return true;
          });
        } finally {
          await envJunk.close().catch(() => {});
        }
      });
    } finally {
      AbortSignal.timeout = origTimeout;
    }
    assert.ok(
      delays.includes(1000),
      `env-resolved Z_AI_TIMEOUT=1000 must bound the probe, got ${JSON.stringify(delays)}`,
    );
    assert.ok(
      delays.includes(5000),
      `junk Z_AI_TIMEOUT must fall back to the 30s default (5s probe cap), got ${JSON.stringify(delays)}`,
    );
  });

  it("concurrent callers share ONE in-flight failed init (single-flight holds during the probe, PR #142 round 2)", async () => {
    // The failure-path probe can take up to PROBE_TIMEOUT_MS; the
    // single-flight guard (initPromise) must stay armed for that whole
    // window so a second caller awaits the SAME failing init instead of
    // starting a fresh registration + probe (macroscope: initPromise was
    // cleared at catch-entry, before the probe await).
    let registerCalls = 0;
    const fake = {
      registerManual() {
        registerCalls += 1;
        return Promise.resolve({ success: false, errors: ["Unrecognized keys: code,msg,success"] });
      },
      callToolChain() { return Promise.reject(new Error("should not reach callToolChain")); },
      getAllToolsTypeScriptInterfaces() { return Promise.reject(new Error("should not reach getAllInterfaces")); },
      close() { return Promise.resolve(); },
    };
    let probeCalls = 0;
    let releaseProbe;
    const gate = new Promise((resolve) => { releaseProbe = resolve; });
    const real = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (!urlOf(input).includes("api.z.ai")) {
        throw new Error(`unexpected fetch in single-flight test: ${urlOf(input)}`);
      }
      probeCalls += 1;
      await gate; // hold the probe in flight while the second caller arrives
      return new Response(AUTH_REJECTION_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new ZaiCodeModeClient({
      env: PROBE_ENV,
      clientFactory: async () => fake,
    });
    try {
      const first = client.callToolChain("code").then(
        () => "ok",
        (err) => err.code,
      );
      // Let the first init reach its parked probe (registration failed,
      // probe fetch issued, gate held) BEFORE the second caller arrives.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(probeCalls, 1, "first init must be parked in its probe");
      // The second caller arrives while the probe is still in flight —
      // it must join the SAME failing init, not start a fresh one.
      const second = client.getAllInterfaces().then(
        () => "ok",
        (err) => err.code,
      );
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      releaseProbe();
      const [a, b] = await Promise.all([first, second]);
      assert.strictEqual(a, "AUTH_ERROR");
      assert.strictEqual(b, "AUTH_ERROR");
      assert.strictEqual(registerCalls, 1, `one registration, got ${registerCalls}`);
      assert.strictEqual(probeCalls, 1, `one probe, got ${probeCalls}`);
    } finally {
      globalThis.fetch = real;
      await client.close().catch(() => {});
    }
  });

  it("probe cancels the unread response body on every non-consumed exit", async () => {
    // undici retains the connection until the body is consumed or
    // cancelled; the 401/403 early return and the non-200 fallthrough
    // must release it. Record body.cancel() on the returned Response.
    async function runOnce(status) {
      const client = new ZaiCodeModeClient({
        env: PROBE_ENV,
        clientFactory: async () => registrationFailureFake(),
      });
      let cancelled = false;
      await withMockFetch(
        () => async (input) => {
          if (!urlOf(input).includes("api.z.ai")) {
            throw new Error(`unexpected fetch in #135 cancel test: ${urlOf(input)}`);
          }
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{}"));
            },
          });
          const response = new Response(stream, {
            status,
            headers: { "content-type": "application/json" },
          });
          const origCancel = response.body.cancel.bind(response.body);
          response.body.cancel = async () => {
            cancelled = true;
            return origCancel();
          };
          return response;
        },
        async () => {
          await assert.rejects(client.callToolChain("code"));
        },
      );
      await client.close().catch(() => {});
      return cancelled;
    }

    assert.ok(await runOnce(401), "401 branch must cancel the unread body");
    assert.ok(await runOnce(503), "non-200 fallthrough must cancel the unread body");
  });
});

describe("ZaiCodeModeClient.close() does not leak a referenced timer (5.2)", () => {
  it("clears the close timeout timer after the race completes", async () => {
    // Create a fake code-mode client whose close() hangs so the timeout
    // race is the resolving path — exercising the timer capture/unref/clear.
    const fakeClient = {
      registerManual: () => Promise.resolve({ success: true, errors: [] }),
      close: () => new Promise(() => {}), // never resolves
      callToolChain: () => Promise.resolve(""),
      getAllToolsTypeScriptInterfaces: () => Promise.resolve(""),
    };
    const client = new ZaiCodeModeClient({
      clientFactory: async () => fakeClient,
    });
    // Force init so this.client is set before close().
    await client.callToolChain("test").catch(() => {});

    const timeoutMs = 100;
    await client.close(timeoutMs);

    // No referenced timer with our duration should survive — the timer
    // was unref()'d and clearTimeout()'d in the finally block.
    const handles =
      typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
    const leakedTimers = handles.filter(
      (h) =>
        h &&
        typeof h === "object" &&
        "_idleTimeout" in h &&
        h._idleTimeout === timeoutMs &&
        typeof h.hasRef === "function" &&
        h.hasRef(),
    );
    assert.strictEqual(
      leakedTimers.length,
      0,
      "close timeout timer must be cleared, not left referenced",
    );
  });

  it("does not keep the event loop alive when client.close() resolves first", async () => {
    const fakeClient = {
      registerManual: () => Promise.resolve({ success: true, errors: [] }),
      close: () => Promise.resolve(),
      callToolChain: () => Promise.resolve(""),
      getAllToolsTypeScriptInterfaces: () => Promise.resolve(""),
    };
    const client = new ZaiCodeModeClient({
      clientFactory: async () => fakeClient,
    });
    await client.callToolChain("test").catch(() => {});

    const timeoutMs = 5000;
    const start = Date.now();
    await client.close(timeoutMs);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 1000, `close() took ${elapsed}ms; timer may not have been cleared`);

    const handles =
      typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
    const leakedTimers = handles.filter(
      (h) =>
        h &&
        typeof h === "object" &&
        "_idleTimeout" in h &&
        h._idleTimeout === timeoutMs &&
        typeof h.hasRef === "function" &&
        h.hasRef(),
    );
    assert.strictEqual(leakedTimers.length, 0, "5 s timer must not remain referenced after close");
  });
});
