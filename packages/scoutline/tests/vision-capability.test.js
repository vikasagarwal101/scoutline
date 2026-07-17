/**
 * Provider Vision Capability — contract + early support checks (P3-01,
 * DESIGN.md §8).
 *
 * Asserts the normalized Vision Capability contract: a single
 * discriminated `VisionRequest` union, a `VisionCapability` interface
 * that owns `supports` (pure metadata) and `invoke`, and a shared
 * invocation helper that fails EARLY — before any credential or media
 * access, transport construction, response cache lookup, or fallback
 * Adapter — when a Provider does not advertise the requested operation.
 *
 * Tests cover:
 *   - Every `VisionRequest` operation is recognized by the shared
 *     `invokeVision` map.
 *   - A fake MiniMax descriptor that throws a unique sentinel on every
 *     observation point (create, credential read, media stat, SDK
 *     factory, cache get, fallback Adapter) still produces an
 *     `UNSUPPORTED_CAPABILITY` failure for every operation MiniMax does
 *     not advertise, without any sentinel being observed.
 *   - Z.AI declares and supports every current operation.
 *   - Error shape: identifies Provider and Capability, exit 1,
 *     non-retryable, no source path or credential leak.
 *   - `descriptor.capabilities()` is a pure metadata check.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  invokeVision,
  ALL_VISION_OPERATIONS,
  visionOperationToCapability,
} from "../dist/capabilities/vision.js";
import {
  createZaiDescriptor,
  createMiniMaxDescriptor,
} from "../dist/providers/types.js";
import {
  UnsupportedCapabilityError,
  getErrorExitCode,
} from "../dist/lib/errors.js";
import { executeProviderOperation } from "../dist/lib/execution.js";

// ---------------------------------------------------------------------------
// Every operation in the discriminated union
// ---------------------------------------------------------------------------

const OPERATIONS = [
  "interpret-image",
  "ui-artifact",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
  "diff",
  "video",
];

describe("Vision Capability — discriminated union coverage", () => {
  it("exports every operation as part of the public set", () => {
    assert.deepStrictEqual(
      [...ALL_VISION_OPERATIONS].sort(),
      [...OPERATIONS].sort(),
    );
  });

  it("maps each operation to a stable vision.<operation> capability id", () => {
    for (const op of OPERATIONS) {
      assert.strictEqual(
        visionOperationToCapability(op),
        `vision.${op}`,
        `operation "${op}" must map to "vision.${op}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Typed-request fixtures: one sample per operation
// ---------------------------------------------------------------------------

function fixtureRequest(operation) {
  switch (operation) {
    case "interpret-image":
      return { operation, source: "/secrets/credentials.png", instruction: "describe" };
    case "ui-artifact":
      return {
        operation,
        source: "/secrets/credentials.png",
        instruction: "build it",
        outputType: "code",
      };
    case "extract-text":
      return {
        operation,
        source: "/secrets/credentials.png",
        instruction: "all text",
        programmingLanguage: "rust",
      };
    case "diagnose-error":
      return {
        operation,
        source: "/secrets/credentials.png",
        instruction: "what broke",
        context: "while deploying",
      };
    case "diagram":
      return {
        operation,
        source: "/secrets/credentials.png",
        instruction: "the data flow",
        diagramType: "sequence",
      };
    case "chart":
      return {
        operation,
        source: "/secrets/credentials.png",
        instruction: "summarize the bars",
        focus: "left half",
      };
    case "diff":
      return {
        operation,
        expectedSource: "/secrets/expected.png",
        actualSource: "/secrets/actual.png",
        instruction: "what changed",
      };
    case "video":
      return { operation, source: "/secrets/clip.mp4", instruction: "summarize" };
  }
  throw new Error(`unknown operation: ${operation}`);
}

// ---------------------------------------------------------------------------
// Fake descriptor with a unique sentinel on every observation point
// ---------------------------------------------------------------------------

function makeFailingDescriptor(id, sentinels) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => {
      sentinels.capabilities += 1;
      return new Set();
    },
    create(context) {
      // The shared helper must reject unsupported operations BEFORE this
      // method is observed. Capture the call so a regression that reaches
      // here can be detected.
      sentinels.create += 1;
      throw sentinels.make("create");
    },
    credentialAccessor: {
      get() {
        sentinels.credentials += 1;
        throw sentinels.make("credentials");
      },
    },
    mediaResolver: {
      stat() {
        sentinels.media += 1;
        throw sentinels.make("media");
      },
    },
    sdkFactory: {
      construct() {
        sentinels.sdkFactory += 1;
        throw sentinels.make("sdkFactory");
      },
    },
    cache: {
      async get() {
        sentinels.cacheGet += 1;
        throw sentinels.make("cacheGet");
      },
      async set() {
        sentinels.cacheSet += 1;
        throw sentinels.make("cacheSet");
      },
    },
    fallback: {
      async invoke() {
        sentinels.fallback += 1;
        throw sentinels.make("fallback");
      },
    },
  };
}

function freshSentinels() {
  return {
    capabilities: 0,
    create: 0,
    credentials: 0,
    media: 0,
    sdkFactory: 0,
    cacheGet: 0,
    cacheSet: 0,
    fallback: 0,
    make(where) {
      return new Error(`SENTINEL_OBSERVED_AT:${where}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter ordering proof: support check precedes everything
// ---------------------------------------------------------------------------

const UNSUPPORTED_ON_MINIMAX = [
  "ui-artifact",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
  "diff",
  "video",
];

describe("Vision Capability — early support check ordering", () => {
  for (const op of UNSUPPORTED_ON_MINIMAX) {
    it(`fails ${op} on MiniMax before any credential, media, transport, cache, or fallback observation`, async () => {
      const sentinels = freshSentinels();
      const descriptor = makeFailingDescriptor("minimax", sentinels);
      const request = fixtureRequest(op);

      await assert.rejects(
        invokeVision(descriptor, request, { env: process.env }),
        (err) => {
          assert.ok(
            err instanceof UnsupportedCapabilityError,
            `expected UnsupportedCapabilityError, got ${err && err.constructor && err.constructor.name}`,
          );
          assert.strictEqual(err.code, "UNSUPPORTED_CAPABILITY");
          // The error identifies Provider AND Capability in its message
          // (DESIGN.md §4; the existing class stores them only in the
          // message, not as public fields).
          assert.match(err.message, /minimax/, `message must identify provider: ${err.message}`);
          assert.match(err.message, /vision\./, `message must identify capability: ${err.message}`);
          // Exit 1 and non-retryable.
          assert.strictEqual(getErrorExitCode(err), 1);
          assert.strictEqual(err.retryable, false);
          // The error carries no source path or credential value.
          const serialized = JSON.stringify({
            message: err.message,
            help: err.help,
          });
          assert.ok(!/\/secrets\//.test(serialized), `error leaks source path: ${serialized}`);
          assert.ok(!/credentials\.png/.test(serialized), `error leaks source filename: ${serialized}`);
          return true;
        },
      );

      // The support check MUST NOT have called create() or any other
      // observation point. capabilities() is the only allowed pre-create
      // call (it is pure metadata). No transport, no credentials, no media,
      // no SDK, no cache, no fallback.
      assert.strictEqual(sentinels.create, 0, `${op}: descriptor.create() must not be called`);
      assert.strictEqual(sentinels.credentials, 0, `${op}: credential accessor must not be called`);
      assert.strictEqual(sentinels.media, 0, `${op}: media resolver must not be called`);
      assert.strictEqual(sentinels.sdkFactory, 0, `${op}: SDK factory must not be called`);
      assert.strictEqual(sentinels.cacheGet, 0, `${op}: cache.get must not be called`);
      assert.strictEqual(sentinels.cacheSet, 0, `${op}: cache.set must not be called`);
      assert.strictEqual(sentinels.fallback, 0, `${op}: fallback adapter must not be called`);
      // capabilities() MAY be observed — it is pure metadata. We do not
      // enforce 0; we only forbid post-creation sentinels.
    });
  }

  it("the rejection is terminal (does not retry) inside executeProviderOperation", async () => {
    const sentinels = freshSentinels();
    const descriptor = makeFailingDescriptor("minimax", sentinels);

    const sleeps = [];
    const deps = {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    };
    let calls = 0;
    await assert.rejects(
      executeProviderOperation(
        "vision",
        async () => {
          calls += 1;
          await invokeVision(descriptor, fixtureRequest("video"), { env: process.env });
          return "never";
        },
        deps,
        { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 1000, jitterMs: 50 },
      ),
    );

    assert.strictEqual(calls, 1, "execution must not retry an unsupported capability");
    assert.strictEqual(
      sleeps.length,
      0,
      "execution must not sleep before an unsupported capability rejection",
    );
    // No sentinel was observed.
    assert.strictEqual(sentinels.create, 0);
    assert.strictEqual(sentinels.fallback, 0);
  });
});

// ---------------------------------------------------------------------------
// Per-operation invocation through a Capability that IS supported: rejects
// sentinel falls through to no-cache / no-fallback invocation.
// ---------------------------------------------------------------------------

describe("Vision Capability — supported operations go through create-then-invoke", () => {
  it("interpret-image on MiniMax reaches the Capability and returns the Adapter's normalized text", async () => {
    const descriptor = {
      id: "minimax",
      isConfigured: () => true,
      capabilities: () => new Set(["vision.interpret-image"]),
      create(context) {
        return {
          id: "minimax",
          search: undefined,
          vision: {
            supports(op) {
              return op === "interpret-image";
            },
            async invoke(request) {
              // Record the request reaching the Adapter.
              assert.strictEqual(request.operation, "interpret-image");
              assert.strictEqual(request.source, "/tmp/safe.png");
              return "normalized text";
            },
          },
        };
      },
    };
    const out = await invokeVision(
      descriptor,
      { operation: "interpret-image", source: "/tmp/safe.png", instruction: "describe" },
      { env: process.env },
    );
    assert.strictEqual(out, "normalized text");
  });

  it("diff and video reach Z.AI via supports()==true and produce normalized text", async () => {
    for (const op of ["diff", "video"]) {
      const descriptor = {
        id: "zai",
        isConfigured: () => true,
        capabilities: () => new Set([`vision.${op}`]),
        create() {
          return {
            id: "zai",
            search: undefined,
            vision: {
              supports(o) {
                return o === op;
              },
              async invoke(request) {
                return `zai:${request.operation}`;
              },
            },
          };
        },
      };
      const out = await invokeVision(
        descriptor,
        fixtureRequest(op),
        { env: process.env },
      );
      assert.strictEqual(out, `zai:${op}`);
    }
  });

  it("Adapter's `supports()` says no AFTER create: defensive double-check fails closed", async () => {
    // The descriptor advertises the capability in metadata but its
    // Adapter-level `supports()` returns false. The helper must NOT call
    // invoke; it must raise UNSUPPORTED_CAPABILITY. Sentinel-based cache
    // and fallback are untouched.
    const sentinels = freshSentinels();
    let invokeCalls = 0;
    const descriptor = {
      id: "minimax",
      isConfigured: () => true,
      capabilities: () => new Set(["vision.interpret-image"]),
      create() {
        sentinels.create += 1;
        return {
          id: "minimax",
          search: undefined,
          vision: {
            supports() {
              return false;
            },
            async invoke() {
              invokeCalls += 1;
              throw new Error("SENTINEL_OBSERVED_AT:invoke");
            },
          },
        };
      },
    };
    await assert.rejects(
      invokeVision(descriptor, fixtureRequest("interpret-image"), { env: process.env }),
      (err) => err instanceof UnsupportedCapabilityError,
    );
    assert.strictEqual(invokeCalls, 0, "Adapter.invoke must not be called when supports()==false");
    assert.strictEqual(sentinels.create, 1, "Descriptor.create IS allowed here (the descriptor advertised it)");
  });
});

// ---------------------------------------------------------------------------
// Built-in descriptors: Z.AI declares every operation, MiniMax declares only
// interpret-image in the base release.
// ---------------------------------------------------------------------------

describe("Vision Capability — built-in descriptor capabilities metadata", () => {
  it("Z.AI declares every current Vision operation", () => {
    const caps = createZaiDescriptor().capabilities();
    for (const op of OPERATIONS) {
      assert.ok(
        caps.has(`vision.${op}`),
        `Z.AI descriptor must advertise vision.${op}`,
      );
    }
  });

  it("MiniMax declares only interpret-image until Phase 5 attestations", () => {
    const caps = createMiniMaxDescriptor().capabilities();
    assert.ok(caps.has("vision.interpret-image"));
    for (const op of OPERATIONS) {
      if (op === "interpret-image") continue;
      assert.ok(
        !caps.has(`vision.${op}`),
        `MiniMax descriptor must not advertise vision.${op} until attested`,
      );
    }
  });

  it("descriptor.capabilities() is a pure metadata check (no Adapter construction)", () => {
    for (const d of [createZaiDescriptor(), createMiniMaxDescriptor()]) {
      d.capabilities();
      // No way to observe construction from outside without a spy; assert
      // that calling again yields the same observable shape.
      assert.strictEqual(typeof d.capabilities(), "object");
      assert.ok(d.capabilities() instanceof Set);
    }
  });
});
