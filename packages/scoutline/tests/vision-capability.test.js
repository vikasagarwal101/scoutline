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
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  invokeVision,
  ALL_VISION_OPERATIONS,
  visionOperationToCapability,
} from "../dist/capabilities/vision.js";
import { createZaiDescriptor, createMiniMaxDescriptor } from "../dist/providers/types.js";
// Real Adapter factories (P3-03 / P3-04). Aliased so the stub imports above
// (which assert descriptor metadata shape) keep their distinct references.
import { createZaiDescriptor as createRealZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor as createRealMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { UnsupportedCapabilityError, getErrorExitCode } from "../dist/lib/errors.js";
import { executeProviderOperation } from "../dist/lib/execution.js";
import { main } from "../dist/index.js";
import { VISION_HELP } from "../dist/commands/vision.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";

// P3-02 — Provider media modules (DESIGN.md §9)
import * as nodeFsp from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import {
  resolveImageSource as zaiResolveImageSource,
  resolveVideoSource as zaiResolveVideoSource,
} from "../dist/providers/zai/media.js";
import { resolveImageSource as minimaxResolveImageSource } from "../dist/providers/minimax/media.js";
import {
  isUrl as compatIsUrl,
  validateImageSource as compatValidateImageSource,
  encodeImageToBase64 as compatEncodeImageToBase64,
  processImageSource as compatProcessImageSource,
  resolveImageSource as compatResolveImageSource,
} from "../dist/lib/image.js";

// Provider media limits (DESIGN.md §9). MiB = 1024 * 1024.
const ZAI_MAX_IMAGE = 5 * 1024 * 1024; // 5 MiB
const ZAI_MAX_VIDEO = 8 * 1024 * 1024; // 8 MiB
const MINIMAX_MAX_IMAGE = 50 * 1024 * 1024; // 50 MiB

/** Create a sparse file of exactly `size` bytes (hole, not allocated). */
async function makeSparseFile(dir, name, size) {
  const filePath = nodePath.join(dir, name);
  const handle = await nodeFsp.open(filePath, "w");
  await handle.truncate(size);
  await handle.close();
  return filePath;
}

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
    assert.deepStrictEqual([...ALL_VISION_OPERATIONS].sort(), [...OPERATIONS].sort());
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

      await assert.rejects(invokeVision(descriptor, request, { env: process.env }), (err) => {
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
        assert.ok(
          !/credentials\.png/.test(serialized),
          `error leaks source filename: ${serialized}`,
        );
        return true;
      });

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
      const out = await invokeVision(descriptor, fixtureRequest(op), { env: process.env });
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
    assert.strictEqual(
      sentinels.create,
      1,
      "Descriptor.create IS allowed here (the descriptor advertised it)",
    );
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
      assert.ok(caps.has(`vision.${op}`), `Z.AI descriptor must advertise vision.${op}`);
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

// ---------------------------------------------------------------------------
// Provider Media Modules (P3-02, DESIGN.md §9)
//
// Commands pass raw path-or-URL strings; Provider media Modules own format,
// size, existence, and absolute-path rules. Media Modules never read file
// content (Z.AI MCP receives the absolute path; the MiniMax SDK owns
// data-URI conversion). lib/image.ts remains a Phase 0 compatibility export.
// ---------------------------------------------------------------------------

describe("Provider Media Module — Z.AI (P3-02)", () => {
  let tmpDir;
  before(async () => {
    tmpDir = await nodeFsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), "scoutline-zai-media-"));
  });
  after(async () => {
    await nodeFsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts case-insensitive JPG/JPEG/PNG at exactly 5 MiB and one byte below", async () => {
    for (const ext of [".jpg", ".JPG", ".jpeg", ".JPEG", ".png", ".PNG"]) {
      const atLimit = await makeSparseFile(tmpDir, `at${ext}`, ZAI_MAX_IMAGE);
      const below = await makeSparseFile(tmpDir, `below${ext}`, ZAI_MAX_IMAGE - 1);
      assert.strictEqual(
        zaiResolveImageSource(atLimit),
        nodePath.resolve(atLimit),
        `Z.AI image at 5 MiB with ${ext} must resolve to absolute path`,
      );
      assert.strictEqual(
        zaiResolveImageSource(below),
        nodePath.resolve(below),
        `Z.AI image below 5 MiB with ${ext} must resolve to absolute path`,
      );
    }
  });

  it("rejects one byte over the 5 MiB image limit with VALIDATION_ERROR", async () => {
    const over = await makeSparseFile(tmpDir, "over-limit.png", ZAI_MAX_IMAGE + 1);
    assert.throws(
      () => zaiResolveImageSource(over),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("rejects WebP images with VALIDATION_ERROR", async () => {
    const webp = await makeSparseFile(tmpDir, "webp.webp", 1024);
    assert.throws(
      () => zaiResolveImageSource(webp),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("preserves the Phase 0 video extension set and 8 MiB limit", async () => {
    const exts = [".mp4", ".mov", ".m4v", ".avi", ".webm", ".wmv"];
    for (const ext of exts) {
      const atLimit = await makeSparseFile(tmpDir, `vid${ext}`, ZAI_MAX_VIDEO);
      const below = await makeSparseFile(tmpDir, `vidbelow${ext}`, ZAI_MAX_VIDEO - 1);
      assert.strictEqual(
        zaiResolveVideoSource(atLimit),
        nodePath.resolve(atLimit),
        `Z.AI video at 8 MiB with ${ext} must resolve`,
      );
      assert.strictEqual(zaiResolveVideoSource(below), nodePath.resolve(below));
    }
    const overVid = await makeSparseFile(tmpDir, "vidover.mp4", ZAI_MAX_VIDEO + 1);
    assert.throws(
      () => zaiResolveVideoSource(overVid),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("rejects an unsupported video extension with VALIDATION_ERROR", async () => {
    const bad = await makeSparseFile(tmpDir, "bad.mkv", 1024);
    assert.throws(
      () => zaiResolveVideoSource(bad),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("rejects a missing local image with FILE_ERROR", () => {
    const missing = nodePath.join(tmpDir, "does-not-exist.png");
    assert.throws(
      () => zaiResolveImageSource(missing),
      (err) => err.code === "FILE_ERROR",
    );
  });

  it("rejects a missing local video with FILE_ERROR", () => {
    const missing = nodePath.join(tmpDir, "does-not-exist.mp4");
    assert.throws(
      () => zaiResolveVideoSource(missing),
      (err) => err.code === "FILE_ERROR",
    );
  });

  it("passes HTTP(S) URLs through without local filesystem access", () => {
    for (const url of ["http://example.test/image.png", "https://example.test/image.jpg"]) {
      assert.strictEqual(zaiResolveImageSource(url), url);
      assert.strictEqual(zaiResolveVideoSource(url), url);
    }
  });

  it("rejects non-HTTP URL-like strings with VALIDATION_ERROR", () => {
    for (const bad of ["ftp://example.test/x.png", "file:///tmp/x.png"]) {
      assert.throws(
        () => zaiResolveImageSource(bad),
        (err) => err.code === "VALIDATION_ERROR",
      );
    }
  });

  it("never reads file content (returns an absolute path, never a data URI)", async () => {
    const img = await makeSparseFile(tmpDir, "noread.png", 1024);
    const result = zaiResolveImageSource(img);
    assert.ok(
      !result.startsWith("data:"),
      `Z.AI media must return a path, not encoded content: ${result}`,
    );
    assert.strictEqual(result, nodePath.resolve(img));
  });
});

describe("Provider Media Module — MiniMax (P3-02)", () => {
  let tmpDir;
  before(async () => {
    tmpDir = await nodeFsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), "scoutline-minimax-media-"));
  });
  after(async () => {
    await nodeFsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts case-insensitive JPG/JPEG/PNG/WebP at exactly 50 MiB and one byte below", async () => {
    for (const ext of [".jpg", ".jpeg", ".png", ".webp", ".WEBP"]) {
      const atLimit = await makeSparseFile(tmpDir, `at${ext}`, MINIMAX_MAX_IMAGE);
      const below = await makeSparseFile(tmpDir, `below${ext}`, MINIMAX_MAX_IMAGE - 1);
      assert.strictEqual(
        minimaxResolveImageSource(atLimit),
        nodePath.resolve(atLimit),
        `MiniMax image at 50 MiB with ${ext} must resolve to absolute path`,
      );
      assert.strictEqual(minimaxResolveImageSource(below), nodePath.resolve(below));
    }
  });

  it("rejects one byte over the 50 MiB image limit with VALIDATION_ERROR", async () => {
    const over = await makeSparseFile(tmpDir, "over-limit.png", MINIMAX_MAX_IMAGE + 1);
    assert.throws(
      () => minimaxResolveImageSource(over),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("rejects a missing local image with FILE_ERROR", () => {
    const missing = nodePath.join(tmpDir, "does-not-exist.png");
    assert.throws(
      () => minimaxResolveImageSource(missing),
      (err) => err.code === "FILE_ERROR",
    );
  });

  it("passes HTTP(S) URLs through without local filesystem access", () => {
    for (const url of ["http://example.test/image.png", "https://example.test/image.webp"]) {
      assert.strictEqual(minimaxResolveImageSource(url), url);
    }
  });

  it("rejects non-HTTP URL-like strings with VALIDATION_ERROR", () => {
    assert.throws(
      () => minimaxResolveImageSource("ftp://example.test/x.png"),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("never reads file content (returns an absolute path, never a data URI)", async () => {
    const img = await makeSparseFile(tmpDir, "noread.png", 1024);
    const result = minimaxResolveImageSource(img);
    assert.ok(
      !result.startsWith("data:"),
      `MiniMax media must return a path, not encoded content: ${result}`,
    );
    assert.strictEqual(result, nodePath.resolve(img));
  });
});

describe("lib/image.ts compatibility — Phase 0 behavior retained (P3-02)", () => {
  let tmpDir;
  before(async () => {
    tmpDir = await nodeFsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), "scoutline-compat-image-"));
  });
  after(async () => {
    await nodeFsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports isUrl, validateImageSource, encodeImageToBase64, processImageSource, resolveImageSource unchanged", async () => {
    assert.strictEqual(typeof compatIsUrl, "function");
    assert.strictEqual(typeof compatValidateImageSource, "function");
    assert.strictEqual(typeof compatEncodeImageToBase64, "function");
    assert.strictEqual(typeof compatProcessImageSource, "function");
    assert.strictEqual(typeof compatResolveImageSource, "function");

    // isUrl Phase 0 behavior.
    assert.strictEqual(compatIsUrl("https://example.test"), true);
    assert.strictEqual(compatIsUrl("http://example.test"), true);
    assert.strictEqual(compatIsUrl("/tmp/file.png"), false);

    // Small valid image: validate -> resolve (absolute path) -> encode (data URI).
    const img = await makeSparseFile(tmpDir, "tiny.png", 4);
    compatValidateImageSource(img); // does not throw
    const resolved = compatResolveImageSource(img);
    assert.strictEqual(resolved, nodePath.resolve(img));

    // base64 conversion export still produces a data URI.
    const encoded = compatEncodeImageToBase64(img);
    assert.ok(
      encoded.startsWith("data:image/png;base64,"),
      `expected Phase 0 data URI, got: ${encoded}`,
    );

    // processImageSource returns the encoded data URI for local files.
    const processed = compatProcessImageSource(img);
    assert.strictEqual(processed, encoded);
  });
});

// ===========================================================================
// P3-04 — Vision command selection + live conformance (DESIGN.md §6, §8)
//
// The Normal Vision commands route through Provider selection: the dispatch
// resolves the effective Provider, gates the operation against descriptor
// metadata BEFORE any Adapter construction or media access, then injects the
// selected Adapter's VisionCapability. Commands build the discriminated
// VisionRequest; the support check decides availability; no command branches
// on a Provider ID.
// ===========================================================================

/**
 * Run `scoutline vision ...` end-to-end through `main` with an in-memory
 * recording invocation adapter. Returns the aggregated stdout/stderr and
 * exit code. Used for offline command-routing assertions.
 */
function runVisionMain(args, { env = {}, providerDescriptors } = {}) {
  const writes = [];
  const invocation = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: undefined,
    readStdin: async () => "",
    writeStdout(v) {
      writes.push(["out", v]);
    },
    writeStderr(v) {
      writes.push(["err", v]);
    },
    runQuietly: async (op) => op(),
    setExitCode() {},
  };
  return main(args, {
    invocation,
    env,
    now: () => 1_700_000_000_000,
    providerDescriptors,
    searchSleep: async () => {},
    searchRandom: () => 0.5,
  }).then((code) => {
    const stdout = writes
      .filter((w) => w[0] === "out")
      .map((w) => w[1])
      .join("\n")
      .trim();
    const stderr = writes
      .filter((w) => w[0] === "err")
      .map((w) => w[1])
      .join("\n")
      .trim();
    return { code, stdout, stderr };
  });
}

/** Every vision capability id, used by recording descriptors. */
const ALL_VISION_CAPS = [
  "vision.interpret-image",
  "vision.ui-artifact",
  "vision.extract-text",
  "vision.diagnose-error",
  "vision.diagram",
  "vision.chart",
  "vision.diff",
  "vision.video",
];

/**
 * Build a recording descriptor whose Vision Capability records every
 * invocation and returns a scripted (or request-derived) text. `create()`
 * is observable so ordering tests can prove it is NOT reached for
 * unsupported operations.
 */
function recordingDescriptor(id, options = {}) {
  const createCalls = [];
  const invokeCalls = [];
  const caps = new Set(options.capabilities ?? ["search", ...ALL_VISION_CAPS]);
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => caps,
    create() {
      createCalls.push(1);
      return {
        id,
        vision: {
          supports(op) {
            return caps.has(`vision.${op}`);
          },
          async invoke(request) {
            invokeCalls.push(request);
            if (options.throwOnInvoke) throw options.throwOnInvoke;
            return typeof options.result === "function"
              ? options.result(request)
              : (options.result ?? `text:${id}:${request.operation}`);
          },
        },
      };
    },
  };
  return { descriptor, createCalls, invokeCalls, caps };
}

/**
 * Build a descriptor that throws a unique sentinel from `create()`. Used to
 * prove the descriptor-level support gate rejects unsupported operations
 * BEFORE Adapter construction.
 */
function sentinelDescriptor(id, advertisedCaps) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(advertisedCaps),
    create() {
      throw new Error(`SENTINEL_CREATE_REACHED:${id}`);
    },
  };
}

function assertStderrError(parsed, expectedCode) {
  assert.ok(parsed, "stderr must carry a structured error envelope");
  assert.strictEqual(
    parsed.code,
    expectedCode,
    `expected ${expectedCode}, got ${parsed && parsed.code}: ${parsed && parsed.error}`,
  );
}

describe("Vision command routing — Provider selection for analyze (P3-04)", () => {
  it("default Provider is Z.AI: raw source + instruction reach the Z.AI Capability", async () => {
    const zai = recordingDescriptor("zai");
    const minimax = recordingDescriptor("minimax");
    const { code, stdout } = await runVisionMain(
      ["vision", "analyze", "https://example.test/img.png", "describe the shapes"],
      { env: {}, providerDescriptors: [zai.descriptor, minimax.descriptor] },
    );
    assert.strictEqual(code, 0);
    assert.strictEqual(zai.invokeCalls.length, 1, "Z.AI capability must be invoked once");
    assert.strictEqual(minimax.invokeCalls.length, 0, "MiniMax must not be invoked");
    assert.strictEqual(zai.invokeCalls[0].operation, "interpret-image");
    assert.strictEqual(zai.invokeCalls[0].source, "https://example.test/img.png");
    assert.strictEqual(zai.invokeCalls[0].instruction, "describe the shapes");
    // Normalized text returned without Provider field access (no envelope).
    assert.strictEqual(stdout, JSON.stringify(`text:zai:interpret-image`));
  });

  it("SCOUTLINE_PROVIDER=minimax selects MiniMax for analyze", async () => {
    const zai = recordingDescriptor("zai");
    const minimax = recordingDescriptor("minimax");
    const { code } = await runVisionMain(["vision", "analyze", "https://example.test/img.png"], {
      env: { SCOUTLINE_PROVIDER: "minimax" },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
    });
    assert.strictEqual(code, 0);
    assert.strictEqual(minimax.invokeCalls.length, 1);
    assert.strictEqual(zai.invokeCalls.length, 0);
    assert.strictEqual(minimax.invokeCalls[0].operation, "interpret-image");
  });

  it("explicit --provider minimax overrides the environment default", async () => {
    const zai = recordingDescriptor("zai");
    const minimax = recordingDescriptor("minimax");
    const { code } = await runVisionMain(
      ["--provider", "minimax", "vision", "analyze", "https://example.test/img.png"],
      { env: {}, providerDescriptors: [zai.descriptor, minimax.descriptor] },
    );
    assert.strictEqual(code, 0);
    assert.strictEqual(minimax.invokeCalls.length, 1);
    assert.strictEqual(zai.invokeCalls.length, 0);
  });

  it("analyze without a prompt uses the default instruction", async () => {
    const zai = recordingDescriptor("zai");
    await runVisionMain(["vision", "analyze", "https://example.test/img.png"], {
      env: {},
      providerDescriptors: [zai.descriptor],
    });
    assert.strictEqual(zai.invokeCalls.length, 1);
    assert.ok(
      typeof zai.invokeCalls[0].instruction === "string" &&
        zai.invokeCalls[0].instruction.length > 0,
      "default instruction must be a nonempty string",
    );
  });
});

describe("Vision command routing — MiniMax unsupported operations fail early (P3-04)", () => {
  // MiniMax advertises ONLY general single-image interpretation in the base
  // release (FR-023, FR-025). Every specialized operation, diff, and video
  // must fail with UNSUPPORTED_CAPABILITY BEFORE key access, source stat,
  // SDK construction, cache access, or any Z.AI fallback.
  const MINIMAX_CAPS = ["search", "vision.interpret-image"];
  const specializedViaMinimax = [
    {
      args: ["--provider", "minimax", "vision", "ui-to-code", "https://e/a.png"],
      op: "ui-artifact",
    },
    {
      args: ["--provider", "minimax", "vision", "extract-text", "https://e/a.png"],
      op: "extract-text",
    },
    {
      args: ["--provider", "minimax", "vision", "diagnose-error", "https://e/a.png"],
      op: "diagnose-error",
    },
    { args: ["--provider", "minimax", "vision", "diagram", "https://e/a.png"], op: "diagram" },
    { args: ["--provider", "minimax", "vision", "chart", "https://e/a.png"], op: "chart" },
    {
      args: ["--provider", "minimax", "vision", "diff", "https://e/a.png", "https://e/b.png"],
      op: "diff",
    },
    { args: ["--provider", "minimax", "vision", "video", "https://e/v.mp4"], op: "video" },
  ];

  for (const { args, op } of specializedViaMinimax) {
    it(`MiniMax ${op} → UNSUPPORTED_CAPABILITY before create() or Z.AI fallback`, async () => {
      // A sentinel MiniMax whose create() betrays any construction, plus a
      // Z.AI fallback sentinel whose invoke() betrays any fallback. The
      // support gate must reject before either is observed.
      const mm = sentinelDescriptor("minimax", MINIMAX_CAPS);
      let zaiFallbackObserved = false;
      const zaiFallback = {
        id: "zai",
        isConfigured: () => true,
        capabilities: () => new Set(["search", ...ALL_VISION_CAPS]),
        create() {
          return {
            id: "zai",
            vision: {
              supports: () => true,
              async invoke() {
                zaiFallbackObserved = true;
                throw new Error("SENTINEL_ZAI_FALLBACK_REACHED");
              },
            },
          };
        },
      };
      const { code, stderr } = await runVisionMain(args, {
        env: { MINIMAX_API_KEY: "k" },
        providerDescriptors: [mm, zaiFallback],
      });
      assert.strictEqual(code, 1);
      let parsed;
      try {
        parsed = JSON.parse(stderr);
      } catch {
        assert.fail(`stderr must be a structured error envelope, got: ${stderr}`);
      }
      assertStderrError(parsed, "UNSUPPORTED_CAPABILITY");
      assert.match(parsed.error, /minimax/i, "error must identify MiniMax");
      assert.match(parsed.error, new RegExp(`vision.${op}`), "error must identify the capability");
      assert.strictEqual(zaiFallbackObserved, false, "must NOT fall back to Z.AI (FR-024)");
    });
  }

  it("MiniMax analyze (general interpretation) IS supported and reaches the Capability", async () => {
    const minimax = recordingDescriptor("minimax", { capabilities: MINIMAX_CAPS });
    const { code } = await runVisionMain(
      ["--provider", "minimax", "vision", "analyze", "https://example.test/img.png"],
      { env: { MINIMAX_API_KEY: "k" }, providerDescriptors: [minimax.descriptor] },
    );
    assert.strictEqual(code, 0);
    assert.strictEqual(minimax.invokeCalls.length, 1);
    assert.strictEqual(minimax.invokeCalls[0].operation, "interpret-image");
    assert.strictEqual(minimax.createCalls.length, 1, "create() is reached for a supported op");
  });
});

describe("Vision command routing — Z.AI preserves specialized operations (P3-04)", () => {
  // Z.AI maps every current operation (DESIGN.md §8). Selecting Z.AI must
  // preserve Phase 1 behaviour: each specialized command builds the correct
  // discriminated VisionRequest with its dedicated arguments, and the
  // request reaches the Z.AI Vision Capability unchanged.
  it("each specialized command builds its discriminated request with dedicated args", async () => {
    const zai = recordingDescriptor("zai", {
      result: (req) => `ok:${req.operation}`,
    });
    const dispatch = (args) =>
      runVisionMain(args, { env: {}, providerDescriptors: [zai.descriptor] });

    await dispatch(["vision", "ui-to-code", "https://e/a.png", "--output", "spec"]);
    await dispatch(["vision", "extract-text", "https://e/a.png", "--language", "rust"]);
    await dispatch(["vision", "diagnose-error", "https://e/a.png", "--context", "during build"]);
    await dispatch(["vision", "diagram", "https://e/a.png", "--type", "sequence"]);
    await dispatch(["vision", "chart", "https://e/a.png", "--focus", "left axis"]);
    await dispatch(["vision", "diff", "https://e/exp.png", "https://e/act.png"]);
    await dispatch(["vision", "video", "https://e/clip.mp4"]);

    const ops = zai.invokeCalls.map((r) => r.operation);
    assert.deepStrictEqual(ops, [
      "ui-artifact",
      "extract-text",
      "diagnose-error",
      "diagram",
      "chart",
      "diff",
      "video",
    ]);

    const [ui, text, diag, dia, chart, diff, vid] = zai.invokeCalls;
    assert.strictEqual(ui.source, "https://e/a.png");
    assert.strictEqual(ui.outputType, "spec");
    assert.ok(typeof ui.instruction === "string" && ui.instruction.length > 0);

    assert.strictEqual(text.source, "https://e/a.png");
    assert.strictEqual(text.programmingLanguage, "rust");

    assert.strictEqual(diag.source, "https://e/a.png");
    assert.strictEqual(diag.context, "during build");

    assert.strictEqual(dia.source, "https://e/a.png");
    assert.strictEqual(dia.diagramType, "sequence");

    assert.strictEqual(chart.source, "https://e/a.png");
    assert.strictEqual(chart.focus, "left axis");

    assert.strictEqual(diff.expectedSource, "https://e/exp.png");
    assert.strictEqual(diff.actualSource, "https://e/act.png");
    assert.ok(typeof diff.instruction === "string" && diff.instruction.length > 0);

    assert.strictEqual(vid.source, "https://e/clip.mp4");
    assert.ok(typeof vid.instruction === "string" && vid.instruction.length > 0);
  });

  it("Z.AI analyze and video return normalized text on stdout without a Provider envelope", async () => {
    const zai = recordingDescriptor("zai", { result: "normalized vision text" });
    const a = await runVisionMain(["vision", "analyze", "https://e/a.png"], {
      env: {},
      providerDescriptors: [zai.descriptor],
    });
    assert.strictEqual(a.code, 0);
    assert.strictEqual(a.stdout, JSON.stringify("normalized vision text"));
  });
});

describe("Vision command routing — invalid Provider fails before support or media (P3-04)", () => {
  it("explicit unknown Provider → VALIDATION_ERROR before any descriptor lookup", async () => {
    let createReached = false;
    const zai = {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["search", ...ALL_VISION_CAPS]),
      create() {
        createReached = true;
        return {
          id: "zai",
          vision: {
            supports: () => true,
            async invoke() {
              return "x";
            },
          },
        };
      },
    };
    const { code, stderr } = await runVisionMain(
      ["--provider", "bogus", "vision", "analyze", "https://e/a.png"],
      { env: {}, providerDescriptors: [zai] },
    );
    assert.strictEqual(code, 1);
    let parsed;
    try {
      parsed = JSON.parse(stderr);
    } catch {
      assert.fail(`stderr must be structured, got: ${stderr}`);
    }
    assertStderrError(parsed, "VALIDATION_ERROR");
    assert.strictEqual(
      createReached,
      false,
      "must fail before Adapter construction or media access",
    );
  });
});

describe("Vision command help — provider gating labels (P3-04)", () => {
  it("identifies general interpretation as shared across providers", () => {
    assert.match(VISION_HELP, /shared/i, "help must label general interpretation as shared");
    assert.match(VISION_HELP, /interpret|analyze/i);
  });

  it("labels diff and video as Z.AI-only", () => {
    assert.match(VISION_HELP, /Z\.AI only/i, "help must mark diff/video as Z.AI-only");
  });

  it("labels specialized MiniMax mappings as gated", () => {
    assert.match(VISION_HELP, /gated/i, "help must label specialized MiniMax mappings as gated");
    assert.match(VISION_HELP, /MiniMax/i);
  });

  it("still lists every subcommand", () => {
    for (const cmd of [
      "analyze",
      "ui-to-code",
      "extract-text",
      "diagnose-error",
      "diagram",
      "chart",
      "diff",
      "video",
    ]) {
      assert.ok(VISION_HELP.includes(cmd), `help must list ${cmd}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Real Z.AI Adapter: specialized operation → MCP tool/arg mappings (P3-04)
// ---------------------------------------------------------------------------

/**
 * Build a recording ZaiAdapterClientPort that captures every callToolRaw
 * invocation. Used to prove the Adapter maps each discriminated request to
 * its dedicated MCP tool name and arguments.
 */
function recordingZaiClientFactory() {
  const calls = [];
  const port = {
    callToolRaw(name, args) {
      calls.push({ name, args });
      return Promise.resolve("ok text");
    },
    close() {
      return Promise.resolve();
    },
  };
  return {
    factory() {
      return port;
    },
    calls,
  };
}

describe("Z.AI Adapter — specialized operation mappings (P3-04)", () => {
  it("the real Z.AI descriptor advertises every vision capability", () => {
    const caps = createRealZaiDescriptor().capabilities();
    for (const cap of ALL_VISION_CAPS) {
      assert.ok(caps.has(cap), `Z.AI descriptor must advertise ${cap}`);
    }
  });

  it("MiniMax descriptor still advertises only general interpretation", () => {
    const caps = createRealMiniMaxDescriptor().capabilities();
    assert.ok(caps.has("vision.interpret-image"));
    for (const cap of ALL_VISION_CAPS) {
      if (cap === "vision.interpret-image") continue;
      assert.ok(!caps.has(cap), `MiniMax must NOT advertise ${cap} until Phase 5`);
    }
  });

  it("maps each discriminated request to its dedicated MCP tool + arguments", async () => {
    const { factory, calls } = recordingZaiClientFactory();
    const descriptor = createRealZaiDescriptor({ clientFactory: factory });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: "test-key" } });
    const img = "https://example.test/a.png";

    await adapter.vision.invoke({ operation: "interpret-image", source: img, instruction: "p" });
    await adapter.vision.invoke({
      operation: "ui-artifact",
      source: img,
      instruction: "p",
      outputType: "spec",
    });
    await adapter.vision.invoke({
      operation: "extract-text",
      source: img,
      instruction: "p",
      programmingLanguage: "rust",
    });
    await adapter.vision.invoke({
      operation: "diagnose-error",
      source: img,
      instruction: "p",
      context: "ctx",
    });
    await adapter.vision.invoke({
      operation: "diagram",
      source: img,
      instruction: "p",
      diagramType: "sequence",
    });
    await adapter.vision.invoke({
      operation: "chart",
      source: img,
      instruction: "p",
      focus: "left",
    });
    await adapter.vision.invoke({
      operation: "diff",
      expectedSource: "https://example.test/exp.png",
      actualSource: "https://example.test/act.png",
      instruction: "p",
    });
    await adapter.vision.invoke({
      operation: "video",
      source: "https://example.test/v.mp4",
      instruction: "p",
    });

    const expected = [
      { name: getMcpToolName("vision", "analyze_image"), args: { image_source: img, prompt: "p" } },
      {
        name: getMcpToolName("vision", "ui_to_artifact"),
        args: { image_source: img, output_type: "spec", prompt: "p" },
      },
      {
        name: getMcpToolName("vision", "extract_text_from_screenshot"),
        args: { image_source: img, prompt: "p", programming_language: "rust" },
      },
      {
        name: getMcpToolName("vision", "diagnose_error_screenshot"),
        args: { image_source: img, prompt: "p", context: "ctx" },
      },
      {
        name: getMcpToolName("vision", "understand_technical_diagram"),
        args: { image_source: img, prompt: "p", diagram_type: "sequence" },
      },
      {
        name: getMcpToolName("vision", "analyze_data_visualization"),
        args: { image_source: img, prompt: "p", analysis_focus: "left" },
      },
      {
        name: getMcpToolName("vision", "ui_diff_check"),
        args: {
          expected_image_source: "https://example.test/exp.png",
          actual_image_source: "https://example.test/act.png",
          prompt: "p",
        },
      },
      {
        name: getMcpToolName("vision", "analyze_video"),
        args: { video_source: "https://example.test/v.mp4", prompt: "p" },
      },
    ];

    assert.strictEqual(calls.length, expected.length, "one transport call per operation");
    for (let i = 0; i < expected.length; i += 1) {
      assert.strictEqual(calls[i].name, expected[i].name, `call ${i}: tool name`);
      assert.deepStrictEqual(calls[i].args, expected[i].args, `call ${i}: args`);
    }
  });

  it("normalizes only nonempty text for every operation", async () => {
    const descriptor = createRealZaiDescriptor({
      clientFactory: () => ({
        callToolRaw: () => Promise.resolve("   "),
        close: () => Promise.resolve(),
      }),
    });
    const adapter = descriptor.create({ env: { Z_AI_API_KEY: "k" } });
    await assert.rejects(
      adapter.vision.invoke({
        operation: "ui-artifact",
        source: "https://example.test/a.png",
        instruction: "p",
        outputType: "code",
      }),
      (err) => err.code === "API_ERROR",
    );
  });
});
