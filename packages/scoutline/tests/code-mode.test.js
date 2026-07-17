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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ZaiCodeModeClient } from "../dist/lib/code-mode.js";
import { formatErrorOutput } from "../dist/lib/output.js";
import { ApiError, AuthError } from "../dist/lib/errors.js";

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
