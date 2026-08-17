import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../dist/index.js";
import { ValidationError } from "../dist/lib/errors.js";

/**
 * Ticket 7 — `vision batch` wrapper (batch-runner DESIGN D10).
 *
 * Dispatch-level tests: `main(["vision", "batch", ...])` with injected
 * fake vision descriptors and a fake global invocation adapter. Pins:
 * the EARLY BRANCH in `handleVision` (before `visionOperationForCommand`
 * and before any provider resolution at the wrapper seam), single-
 * directory glob expansion (lexicographic, media-extension union filter,
 * `.webp` included per D10, non-media extensions never become ops),
 * extension-driven subcommand inference (video ext → `video`, image →
 * `analyze`), name sanitization + collision rejection, `{filename}`/
 * `{filepath}` template substitution (glob `--prompt` and manifest
 * `promptTemplate`), manifest-input mode (exactly one vision op; 2-op or
 * non-vision manifests reject at the wrapper), missing input failing
 * only that op, `--out` requirement (> 1 input), per-input files +
 * `<out>/summary.json`, concurrency default 1, distribution across
 * zai+minimax, `--dry-run` = existence + extension validation only, and
 * the wrapper seam never calling `descriptor.create()`.
 *
 * Tests import dist/ per AGENTS.md (build before test). The vision
 * descriptor double mirrors the real adapters' contract: metadata
 * capabilities gate eligibility, `create()` builds the vision capability
 * whose `invoke` performs the local-media existence check exactly like
 * `providers/zai/media.ts` does (media SIZE validation stays in real
 * adapters and is out of scope for the doubles).
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/**
 * Configured vision-capable descriptor double. `capabilities` lists the
 * per-operation capability ids the descriptor advertises (e.g.
 * "vision.interpret-image", "vision.video"); `invoke` returns
 * `${id}:${operation}:${source}` and throws ValidationError for missing
 * local files, mirroring the real adapters' media validation so a
 * missing input fails ONLY that op inside the handler.
 */
function makeVisionDescriptor(id, options = {}) {
  const capabilities = options.capabilities ?? ["vision.interpret-image"];
  const invokes = [];
  let creates = 0;
  let active = 0;
  let maxActive = 0;
  return {
    descriptor: {
      id,
      isConfigured: () => true,
      capabilities: () => new Set(capabilities),
      create() {
        creates += 1;
        return {
          id,
          vision: {
            supports: (operation) => capabilities.includes(`vision.${operation}`),
            async invoke(request) {
              invokes.push(request);
              const source = request.source;
              if (
                typeof source === "string" &&
                !source.startsWith("http://") &&
                !source.startsWith("https://") &&
                !fs.existsSync(source)
              ) {
                throw new ValidationError(`Media file not found: ${source}`);
              }
              if (options.trackActive === true) {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
              }
              return `${id}:${request.operation}:${source ?? ""}`;
            },
          },
        };
      },
    },
    invokes,
    createCount: () => creates,
    maxActive: () => maxActive,
  };
}

/**
 * Global invocation adapter double (batch-command.test.js pattern).
 * `readStdin` defaults to a throw: the vision batch wrapper must never
 * consult stdin (manifest files and globs only).
 */
function fakeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      readStdin: async () => {
        throw new Error("unexpected global readStdin call");
      },
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
      runQuietly: async (operation) => operation(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

function freshCache() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

/** Base MainDependencies for a vision batch dispatch run. */
function vbatchDeps(adapter, entries, extra = {}) {
  return {
    invocation: adapter,
    env: {},
    providerDescriptors: entries.map((entry) => entry.descriptor),
    configFanout: false,
    searchCache: freshCache(),
    searchSleep: async () => {},
    searchRandom: () => 0.5,
    now: () => 1755400000000,
    ...extra,
  };
}

/** Every mkdtempSync directory this suite creates (review fix: no leaks). */
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Tmpdir holding the named (empty-content) media files. */
function makeMediaDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-vbatch-"));
  tempDirs.push(dir);
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), "x", "utf8");
  }
  return dir;
}

function makeOutDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-vbout-"));
  tempDirs.push(dir);
  return dir;
}

function writeManifestFile(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-vbatchm-"));
  tempDirs.push(dir);
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest), "utf8");
  return file;
}

function parseEnvelope(stdout) {
  assert.strictEqual(stdout.length, 1, "exactly one stdout write (the envelope)");
  return JSON.parse(stdout[0]);
}

function parseError(stderr) {
  assert.ok(stderr.length >= 1, "whole-batch error reaches stderr");
  return JSON.parse(stderr[0]);
}

// ---------------------------------------------------------------------------
// Glob expansion: order, filter, sanitization
// ---------------------------------------------------------------------------

describe("vision batch glob expansion", () => {
  it("expands lexicographically and filters to the media union (.webp in, non-media never an op)", async () => {
    const dir = makeMediaDir(["b.png", "a.png", "c.webp", "notes.txt", "e.mp4", "old.jpg.bak"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai", {
      capabilities: ["vision.interpret-image", "vision.video"],
    });
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--out", out],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.total, 4);
    assert.deepStrictEqual(
      envelope.results.map((r) => r.name),
      ["a.png", "b.png", "c.webp", "e.mp4"],
    );
    for (const record of envelope.results) {
      assert.strictEqual(record.command, "vision");
      assert.strictEqual(record.ok, true);
    }
    // The `.webp` file ran through the union filter (an image op), and
    // the `.txt` / `.bak` files never became ops at all.
    assert.ok(zai.invokes.some((r) => r.source === path.join(dir, "c.webp")));
    assert.ok(!zai.invokes.some((r) => r.source === path.join(dir, "notes.txt")));
    assert.ok(!zai.invokes.some((r) => r.source === path.join(dir, "old.jpg.bak")));
  });

  it("infers the subcommand from the extension: video ext -> video, image ext -> analyze", async () => {
    const dir = makeMediaDir(["clip.mp4", "shot.png", "pic.webp"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai", {
      capabilities: ["vision.interpret-image", "vision.video"],
    });
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--out", out],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    parseEnvelope(stdout);
    const bySource = new Map(zai.invokes.map((r) => [r.source, r.operation]));
    assert.strictEqual(bySource.get(path.join(dir, "clip.mp4")), "video");
    assert.strictEqual(bySource.get(path.join(dir, "shot.png")), "interpret-image");
    assert.strictEqual(bySource.get(path.join(dir, "pic.webp")), "interpret-image");
  });

  it("sanitizes op names (runs of disallowed chars collapse to _) and rejects collisions naming both files", async () => {
    const clean = makeMediaDir(["my shot.png"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai");
    const ok = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(clean, "*"), "--out", out],
      vbatchDeps(ok.adapter, [zai]),
    );
    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(ok.stdout);
    assert.strictEqual(envelope.results[0].name, "my_shot.png");
    assert.ok(fs.existsSync(path.join(out, "my_shot.png.json")));

    // "a b.png" and "a_b.png" both sanitize to "a_b.png".
    const clash = makeMediaDir(["a b.png", "a_b.png"]);
    const out2 = makeOutDir();
    const bad = fakeInvocation();
    const status2 = await main(
      ["vision", "batch", path.join(clash, "*"), "--out", out2],
      vbatchDeps(bad.adapter, [makeVisionDescriptor("zai")]),
    );
    assert.strictEqual(status2, 1);
    assert.strictEqual(bad.stdout.length, 0);
    const error = parseError(bad.stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("a b.png"), "collision error names the first file");
    assert.ok(error.error.includes("a_b.png"), "collision error names the second file");
  });
});

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

describe("vision batch prompt templates", () => {
  it("substitutes {filename}/{filepath} from --prompt in glob mode; no template -> subcommand default", async () => {
    const dir = makeMediaDir(["shot.png"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai");
    const withTemplate = fakeInvocation();

    const status = await main(
      [
        "vision",
        "batch",
        path.join(dir, "*"),
        "--out",
        out,
        "--prompt",
        "Describe {filename} at {filepath}",
      ],
      vbatchDeps(withTemplate.adapter, [zai]),
    );
    assert.strictEqual(status, 0);
    assert.strictEqual(zai.invokes.length, 1);
    assert.strictEqual(
      zai.invokes[0].instruction,
      `Describe shot.png at ${path.join(dir, "shot.png")}`,
    );

    // Without a template the handler's subcommand default applies.
    const zai2 = makeVisionDescriptor("zai");
    const bare = fakeInvocation();
    const status2 = await main(
      ["vision", "batch", path.join(dir, "*")],
      vbatchDeps(bare.adapter, [zai2]),
    );
    assert.strictEqual(status2, 0);
    assert.strictEqual(zai2.invokes.length, 1);
    // The handler's analyze default (commands/vision.ts DEFAULT_PROMPTS).
    assert.strictEqual(zai2.invokes[0].instruction, "Describe this image in detail.");
  });

  it("rejects a valueless --prompt instead of silently using the default (review fix)", async () => {
    const dir = makeMediaDir(["shot.png"]);
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--prompt"],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("--prompt"));
    assert.strictEqual(zai.invokes.length, 0, "a valueless --prompt must never dispatch");
  });

  it("substitutes source text literally: `$&` in a filename is never a replacement token (review fix)", async () => {
    const dir = makeMediaDir(["weird$&name.png"]);
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--prompt", "Describe {filename}"],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    assert.strictEqual(zai.invokes.length, 1);
    // A `String.replaceAll` replacement STRING would treat `$&` as "the
    // matched substring" and corrupt the prompt; the substitution must
    // insert the basename literally.
    assert.strictEqual(zai.invokes[0].instruction, "Describe weird$&name.png");
  });
});

// ---------------------------------------------------------------------------
// Manifest input mode (exactly one vision op)
// ---------------------------------------------------------------------------

describe("vision batch manifest input mode", () => {
  it("runs a single named vision op via the shared runner; promptTemplate substitutes and overrides input.prompt; --prompt is ignored", async () => {
    const dir = makeMediaDir(["chart.png"]);
    const source = path.join(dir, "chart.png");
    const manifest = {
      schemaVersion: 1,
      promptTemplate: "Explain {filename} fully ({filepath})",
      operations: [
        {
          name: "chart-op",
          command: "vision",
          input: { subcommand: "chart", source, prompt: "overridden explicit prompt" },
        },
      ],
    };
    const file = writeManifestFile(manifest);
    const minimax = makeVisionDescriptor("minimax", { capabilities: ["vision.chart"] });
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", file, "--prompt", "IGNORED {filename}"],
      vbatchDeps(adapter, [minimax]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.total, 1);
    assert.strictEqual(envelope.results[0].name, "chart-op");
    assert.strictEqual(envelope.results[0].ok, true);
    assert.strictEqual(minimax.invokes.length, 1);
    assert.strictEqual(
      minimax.invokes[0].instruction,
      `Explain chart.png fully (${source})`,
    );
    assert.ok(!minimax.invokes[0].instruction.includes("IGNORED"));
  });

  it("rejects promptTemplate {filename}/{filepath} tokens for diff (no single source to substitute; review fix)", async () => {
    const dir = makeMediaDir(["expected.png", "actual.png"]);
    const manifest = {
      schemaVersion: 1,
      promptTemplate: "Compare {filename} and its twin",
      operations: [
        {
          name: "cmp",
          command: "vision",
          input: {
            subcommand: "diff",
            expected: path.join(dir, "expected.png"),
            actual: path.join(dir, "actual.png"),
            prompt: "template",
          },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai", { capabilities: ["vision.diff"] });
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", writeManifestFile(manifest)],
      vbatchDeps(adapter, [zai]),
    );

    // Unsubstituted {filename}/{filepath} would reach the provider
    // verbatim — reject up front instead.
    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const err = parseError(stderr);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.ok(err.error.includes("promptTemplate"));
    assert.strictEqual(zai.createCount(), 0, "template rejection never builds transport");
  });

  it("passes a token-free promptTemplate through for diff (no substitution needed)", async () => {
    const dir = makeMediaDir(["expected.png", "actual.png"]);
    const manifest = {
      schemaVersion: 1,
      promptTemplate: "Compare the two screenshots pixel by pixel",
      operations: [
        {
          name: "cmp",
          command: "vision",
          input: {
            subcommand: "diff",
            expected: path.join(dir, "expected.png"),
            actual: path.join(dir, "actual.png"),
            prompt: "overridden",
          },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai", { capabilities: ["vision.diff"] });
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", writeManifestFile(manifest)],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.results[0].ok, true);
    assert.strictEqual(zai.invokes.length, 1);
    assert.strictEqual(zai.invokes[0].instruction, "Compare the two screenshots pixel by pixel");
  });

  it("rejects a 2-op manifest and a non-vision manifest at the wrapper", async () => {
    const dir = makeMediaDir(["a.png", "b.png"]);
    const twoOps = {
      schemaVersion: 1,
      operations: [
        {
          name: "one",
          command: "vision",
          input: { subcommand: "analyze", source: path.join(dir, "a.png") },
        },
        {
          name: "two",
          command: "vision",
          input: { subcommand: "analyze", source: path.join(dir, "b.png") },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai");
    const two = fakeInvocation();
    const statusTwo = await main(
      ["vision", "batch", writeManifestFile(twoOps)],
      vbatchDeps(two.adapter, [zai]),
    );
    assert.strictEqual(statusTwo, 1);
    assert.strictEqual(two.stdout.length, 0);
    const twoError = parseError(two.stderr);
    assert.strictEqual(twoError.code, "VALIDATION_ERROR");
    assert.ok(twoError.error.includes("exactly one"));
    assert.strictEqual(zai.createCount(), 0, "wrapper rejection never builds transport");

    const nonVision = {
      schemaVersion: 1,
      operations: [{ name: "s", command: "search", input: { query: "q" } }],
    };
    const bad = fakeInvocation();
    const statusBad = await main(
      ["vision", "batch", writeManifestFile(nonVision)],
      vbatchDeps(bad.adapter, [zai]),
    );
    assert.strictEqual(statusBad, 1);
    assert.strictEqual(bad.stdout.length, 0);
    const badError = parseError(bad.stderr);
    assert.strictEqual(badError.code, "VALIDATION_ERROR");
    assert.ok(badError.error.includes("vision"));
    assert.strictEqual(zai.createCount(), 0);
  });

  it("rejects an operation named `summary` when --out is used (reserved <out>/summary.json collision, review fix)", async () => {
    const dir = makeMediaDir(["shot.png"]);
    const out = makeOutDir();
    const manifest = {
      schemaVersion: 1,
      operations: [
        {
          name: "summary",
          command: "vision",
          input: { subcommand: "analyze", source: path.join(dir, "shot.png") },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", writeManifestFile(manifest), "--out", out],
      vbatchDeps(adapter, [zai]),
    );

    // --out would route the op to <out>/summary.json, colliding with the
    // wrapper's own summary write — reject up front, never overwrite.
    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("summary"));
    assert.ok(error.error.includes("reserved"));
    assert.strictEqual(zai.invokes.length, 0);
  });

  it("a missing source fails only that op (envelope on stdout, failure inside results[])", async () => {
    const manifest = {
      schemaVersion: 1,
      operations: [
        {
          name: "ghost",
          command: "vision",
          input: { subcommand: "analyze", source: "/nonexistent/ghost.png" },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout } = fakeInvocation();

    // --no-fallback keeps the failing op on its assigned provider.
    const status = await main(
      ["--no-fallback", "vision", "batch", writeManifestFile(manifest)],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 1);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.total, 1);
    assert.strictEqual(envelope.ok, 0);
    assert.strictEqual(envelope.failed, 1);
    const record = envelope.results[0];
    assert.strictEqual(record.ok, false);
    assert.notStrictEqual(record.exitCode, 0);
    assert.ok(typeof record.stderr === "string");
    assert.ok(record.stderr.includes("Media file not found"));
  });
});

// ---------------------------------------------------------------------------
// --out contract and output files
// ---------------------------------------------------------------------------

describe("vision batch --out contract", () => {
  it("requires --out when the glob matches more than one input", async () => {
    const dir = makeMediaDir(["a.png", "b.png"]);
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*")],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("--out"));
    assert.strictEqual(zai.invokes.length, 0);
  });

  it("a single-input run writes the one summary envelope on stdout and no per-input file", async () => {
    const dir = makeMediaDir(["solo.png"]);
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*")],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.total, 1);
    assert.strictEqual(envelope.ok, 1);
    const record = envelope.results[0];
    assert.strictEqual(record.name, "solo.png");
    assert.strictEqual(record.output, undefined, "no --out -> no per-input output target");
    assert.ok(!fs.existsSync(path.join(dir, "solo.png.json")));
    // The op's stdout lives INSIDE the envelope (the double's string).
    assert.strictEqual(
      JSON.parse(record.stdout),
      `zai:interpret-image:${path.join(dir, "solo.png")}`,
    );
  });

  it("--out writes one per-input file per op plus <out>/summary.json", async () => {
    const dir = makeMediaDir(["a.png", "b.png"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--out", out],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    for (const record of envelope.results) {
      const perInput = path.join(out, `${record.name}.json`);
      assert.ok(fs.existsSync(perInput), `per-input file ${perInput} exists`);
      assert.strictEqual(fs.readFileSync(perInput, "utf8").trim(), record.stdout);
    }
    const summaryPath = path.join(out, "summary.json");
    assert.ok(fs.existsSync(summaryPath), "summary.json exists");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(summaryPath, "utf8")), envelope);
    // Atomic writes leave no temp residue (review fix: summary.json uses
    // the same write-temp-then-rename seam as per-op outputs).
    assert.deepStrictEqual(fs.readdirSync(out).sort(), ["a.png.json", "b.png.json", "summary.json"]);
  });

  it("--out creates the directory when it does not exist (review fix: no pre-existing-dir requirement)", async () => {
    const dir = makeMediaDir(["a.png", "b.png"]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-vbout-missing-"));
    tempDirs.push(root);
    const out = path.join(root, "created", "nested"); // neither exists
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--out", out],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    assert.ok(fs.existsSync(out), "--out directory is created (recursive)");
    const envelope = parseEnvelope(stdout);
    for (const record of envelope.results) {
      assert.ok(fs.existsSync(path.join(out, `${record.name}.json`)));
    }
    assert.ok(fs.existsSync(path.join(out, "summary.json")));
    // Glob op names carry their media extension (summary.png -> summary.png.json),
    // so a media file named summary.* never collides with summary.json —
    // and the summary survives alongside it untouched.
    assert.deepStrictEqual(
      fs.readdirSync(out).sort(),
      ["a.png.json", "b.png.json", "summary.json"],
    );
  });

  it("a glob input named summary.png with --out runs fine (glob op names carry the extension: no summary.json collision)", async () => {
    const dir = makeMediaDir(["summary.png", "other.png"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--out", out],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.ok, 2);
    assert.deepStrictEqual(
      fs.readdirSync(out).sort(),
      ["other.png.json", "summary.json", "summary.png.json"],
    );
    // The wrapper's summary is the envelope — not clobbered by any op.
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8")), envelope);
  });
});

// ---------------------------------------------------------------------------
// Concurrency + distribution
// ---------------------------------------------------------------------------

describe("vision batch concurrency and distribution", () => {
  it("defaults to concurrency 1 (max-active instrumentation never exceeds 1)", async () => {
    const dir = makeMediaDir(["a.png", "b.png", "c.png"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai", { trackActive: true });
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--out", out],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.concurrency, 1);
    assert.strictEqual(zai.invokes.length, 3);
    assert.strictEqual(zai.maxActive(), 1, "vision batch runs serially by default (D8)");
  });

  it("distributes ops across zai + minimax when both are configured and capable", async () => {
    const dir = makeMediaDir(["a.png", "b.png"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai");
    const minimax = makeVisionDescriptor("minimax");
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--out", out],
      vbatchDeps(adapter, [zai, minimax]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.results[0].resolvedProvider, "zai");
    assert.strictEqual(envelope.results[1].resolvedProvider, "minimax");
    assert.strictEqual(zai.invokes.length, 1);
    assert.strictEqual(minimax.invokes.length, 1);
    assert.ok(JSON.parse(envelope.results[0].stdout).startsWith("zai:"));
    assert.ok(JSON.parse(envelope.results[1].stdout).startsWith("minimax:"));
  });
});

// ---------------------------------------------------------------------------
// Dry run + wrapper seam
// ---------------------------------------------------------------------------

describe("vision batch dry run", () => {
  it("rejects a value on the boolean-only --dry-run flag (never silently runs providers)", async () => {
    const dir = makeMediaDir(["a.png"]);
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--dry-run", "false"],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("--dry-run"));
    assert.strictEqual(zai.invokes.length, 0, "a valued --dry-run must never dispatch");
  });

  it("--dry-run validates BOTH diff sources (expected + actual), not input.source (review fix)", async () => {
    const dir = makeMediaDir(["expected.png", "actual.png"]);
    const zai = makeVisionDescriptor("zai", { capabilities: ["vision.diff"] });

    // A missing `actual` must reject the dry run exactly like a missing
    // `source` does for non-diff ops.
    const missingActual = {
      schemaVersion: 1,
      operations: [
        {
          name: "diff-op",
          command: "vision",
          input: {
            subcommand: "diff",
            expected: path.join(dir, "expected.png"),
            actual: "/nonexistent/actual.png",
          },
        },
      ],
    };
    const bad = fakeInvocation();
    const statusBad = await main(
      ["vision", "batch", writeManifestFile(missingActual), "--dry-run"],
      vbatchDeps(bad.adapter, [zai]),
    );
    assert.strictEqual(statusBad, 1);
    assert.strictEqual(bad.stdout.length, 0);
    const badError = parseError(bad.stderr);
    assert.strictEqual(badError.code, "VALIDATION_ERROR");
    assert.ok(badError.error.includes("actual.png"), "the missing diff source is named");
    assert.strictEqual(zai.createCount(), 0);

    // Both sources present and readable -> the ready preview succeeds.
    const ready = {
      schemaVersion: 1,
      operations: [
        {
          name: "diff-op",
          command: "vision",
          input: {
            subcommand: "diff",
            expected: path.join(dir, "expected.png"),
            actual: path.join(dir, "actual.png"),
          },
        },
      ],
    };
    const good = fakeInvocation();
    const statusGood = await main(
      ["vision", "batch", writeManifestFile(ready), "--dry-run"],
      vbatchDeps(good.adapter, [zai]),
    );
    assert.strictEqual(statusGood, 0);
    const envelope = parseEnvelope(good.stdout);
    assert.strictEqual(envelope.dryRun, true);
    assert.strictEqual(envelope.results[0].reason, "ready");
  });

  it("--dry-run validates existence only: a missing source fails the whole batch before any transport", async () => {
    const manifest = {
      schemaVersion: 1,
      operations: [
        {
          name: "ghost",
          command: "vision",
          input: { subcommand: "analyze", source: "/nonexistent/ghost.png" },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", writeManifestFile(manifest), "--dry-run"],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0, "no summary envelope for a dry-run rejection");
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("ghost.png"));
    assert.strictEqual(zai.createCount(), 0);
    assert.strictEqual(zai.invokes.length, 0);
  });

  it("--dry-run validates extension only: a non-media source rejects without transport", async () => {
    const dir = makeMediaDir(["notes.txt"]);
    const manifest = {
      schemaVersion: 1,
      operations: [
        {
          name: "wrongext",
          command: "vision",
          input: { subcommand: "analyze", source: path.join(dir, "notes.txt") },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", writeManifestFile(manifest), "--dry-run"],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("notes.txt"));
    assert.strictEqual(zai.createCount(), 0);
  });

  it("--dry-run extension validation is per-operation: video rejects image files (review fix)", async () => {
    const dir = makeMediaDir(["clip.png"]);
    const manifest = {
      schemaVersion: 1,
      operations: [
        {
          name: "not-a-video",
          command: "vision",
          input: { subcommand: "video", source: path.join(dir, "clip.png") },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai", { capabilities: ["vision.video"] });
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", writeManifestFile(manifest), "--dry-run"],
      vbatchDeps(adapter, [zai]),
    );

    // The union check used to pass this as ready; the real handler
    // (resolveVideoSource) rejects non-video media, so dry run must too.
    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("clip.png"), "the offending source is named");
    assert.ok(error.error.includes("video"), "the error names the subcommand the extension mismatches");
    assert.strictEqual(zai.createCount(), 0);
  });

  it("--dry-run extension validation is per-operation: image ops reject video files (review fix)", async () => {
    const dir = makeMediaDir(["clip.mp4"]);
    const manifest = {
      schemaVersion: 1,
      operations: [
        {
          name: "not-an-image",
          command: "vision",
          input: { subcommand: "analyze", source: path.join(dir, "clip.mp4") },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai");
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", writeManifestFile(manifest), "--dry-run"],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("clip.mp4"), "the offending source is named");
    assert.ok(error.error.includes("analyze"), "the error names the subcommand the extension mismatches");
    assert.strictEqual(zai.createCount(), 0);
  });

  it("--dry-run extension validation is per-operation: diff (Z.AI-only) rejects .webp sources (review fix)", async () => {
    // diff is advertised only by Z.AI, whose image set is jpg/jpeg/png —
    // MiniMax's .webp never applies to it, so the pre-dispatch truth for
    // diff is Z.AI's image set.
    const dir = makeMediaDir(["expected.webp", "actual.webp"]);
    const manifest = {
      schemaVersion: 1,
      operations: [
        {
          name: "diff-op",
          command: "vision",
          input: {
            subcommand: "diff",
            expected: path.join(dir, "expected.webp"),
            actual: path.join(dir, "actual.webp"),
          },
        },
      ],
    };
    const zai = makeVisionDescriptor("zai", { capabilities: ["vision.diff"] });
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", writeManifestFile(manifest), "--dry-run"],
      vbatchDeps(adapter, [zai]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("expected.webp"), "the offending diff source is named");
    assert.strictEqual(zai.createCount(), 0);
  });

  it("--dry-run accepts the operation-correct extensions: video with .mp4 ready, analyze with .webp ready", async () => {
    const dir = makeMediaDir(["clip.mp4", "shot.webp"]);
    const zai = makeVisionDescriptor("zai", {
      capabilities: ["vision.video", "vision.interpret-image"],
    });
    const minimax = makeVisionDescriptor("minimax");

    // Manifest mode holds exactly one op, so each direction is its own
    // run. .mp4 is the video set; .webp stays valid for image ops
    // because MiniMax (an eligible analyze provider) accepts it — the
    // per-op check keeps D10's provider-union rationale at the
    // operation level.
    const videoRun = fakeInvocation();
    const videoStatus = await main(
      [
        "vision",
        "batch",
        writeManifestFile({
          schemaVersion: 1,
          operations: [
            { name: "vid", command: "vision", input: { subcommand: "video", source: path.join(dir, "clip.mp4") } },
          ],
        }),
        "--dry-run",
      ],
      vbatchDeps(videoRun.adapter, [zai, minimax]),
    );
    assert.strictEqual(videoStatus, 0);
    const videoEnvelope = parseEnvelope(videoRun.stdout);
    assert.strictEqual(videoEnvelope.ok, 1);
    assert.strictEqual(videoEnvelope.results[0].reason, "ready");

    const imageRun = fakeInvocation();
    const imageStatus = await main(
      [
        "vision",
        "batch",
        writeManifestFile({
          schemaVersion: 1,
          operations: [
            { name: "img", command: "vision", input: { subcommand: "analyze", source: path.join(dir, "shot.webp") } },
          ],
        }),
        "--dry-run",
      ],
      vbatchDeps(imageRun.adapter, [zai, minimax]),
    );
    assert.strictEqual(imageStatus, 0);
    const imageEnvelope = parseEnvelope(imageRun.stdout);
    assert.strictEqual(imageEnvelope.ok, 1);
    assert.strictEqual(imageEnvelope.results[0].reason, "ready");
  });

  it("a ready dry run previews the assignment with zero transport and zero writes", async () => {
    const dir = makeMediaDir(["a.png", "b.png"]);
    const out = makeOutDir();
    const zai = makeVisionDescriptor("zai");
    const minimax = makeVisionDescriptor("minimax");
    const { adapter, stdout } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--out", out, "--dry-run"],
      vbatchDeps(adapter, [zai, minimax]),
    );

    assert.strictEqual(status, 0);
    const envelope = parseEnvelope(stdout);
    assert.strictEqual(envelope.dryRun, true);
    assert.strictEqual(envelope.total, 2);
    assert.strictEqual(envelope.ok, 2);
    for (const record of envelope.results) {
      assert.strictEqual(record.ok, true);
      assert.strictEqual(record.reason, "ready");
      assert.strictEqual(record.stdout, undefined);
      assert.strictEqual(record.stderr, undefined);
      assert.strictEqual(record.output, undefined);
    }
    assert.strictEqual(envelope.results[0].resolvedProvider, "zai");
    assert.strictEqual(envelope.results[1].resolvedProvider, "minimax");
    // No transport, no invokes, no per-input files, no summary.json.
    assert.strictEqual(zai.createCount(), 0);
    assert.strictEqual(minimax.createCount(), 0);
    assert.strictEqual(zai.invokes.length + minimax.invokes.length, 0);
    assert.deepStrictEqual(fs.readdirSync(out), [], "dry runs write nothing to --out");
  });
});

// ---------------------------------------------------------------------------
// Wrapper seam + help
// ---------------------------------------------------------------------------

describe("vision batch wrapper seam and help", () => {
  it("real runs create transport per op inside the runner (never at the wrapper seam); direct vision still dispatches", async () => {
    const dir = makeMediaDir(["one.png"]);
    const zai = makeVisionDescriptor("zai");
    const batch = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*")],
      vbatchDeps(batch.adapter, [zai]),
    );
    assert.strictEqual(status, 0);
    // One op -> transport is built per op INSIDE the runner (the
    // fallback executor's adapter-handle preflight and the attempt each
    // construct the adapter) and the op invoked exactly once — the
    // wrapper itself resolves nothing (dry runs pin createCount 0).
    assert.strictEqual(zai.invokes.length, 1);
    assert.ok(zai.createCount() >= 1, "transport created per op inside the runner");

    // The early branch does not disturb the direct subcommand path.
    const direct = fakeInvocation();
    const statusDirect = await main(
      ["vision", "analyze", path.join(dir, "one.png")],
      vbatchDeps(direct.adapter, [zai]),
    );
    assert.strictEqual(statusDirect, 0);
    assert.strictEqual(direct.stdout.length, 1);
    assert.strictEqual(
      JSON.parse(direct.stdout[0]),
      `zai:interpret-image:${path.join(dir, "one.png")}`,
    );
  });

  it("rejects unknown vision batch flags (--fail-fast is not on the vision batch surface)", async () => {
    const dir = makeMediaDir(["a.png"]);
    const { adapter, stdout, stderr } = fakeInvocation();

    const status = await main(
      ["vision", "batch", path.join(dir, "*"), "--fail-fast"],
      vbatchDeps(adapter, [makeVisionDescriptor("zai")]),
    );

    assert.strictEqual(status, 1);
    assert.strictEqual(stdout.length, 0);
    const error = parseError(stderr);
    assert.strictEqual(error.code, "VALIDATION_ERROR");
    assert.ok(error.error.includes("--fail-fast"));
  });

  it("VISION_HELP documents the batch subcommand", async () => {
    const { adapter, stdout } = fakeInvocation();

    const status = await main(["vision", "--help"], vbatchDeps(adapter, []));

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.ok(stdout[0].includes("batch"), "help lists the batch subcommand");
    assert.ok(stdout[0].includes("--out"), "help mentions the --out flag");
    // Continuation alignment (review fix): no help line may start at
    // column zero mid-block — the batch line's last continuation is the
    // known offender ("ignored; concurrency default 1)").
    assert.ok(
      !/^ignored;/m.test(stdout[0]),
      "batch help continuation lines must be indented, not at column zero",
    );
    assert.ok(stdout[0].includes("ignored; concurrency default 1)"));
  });
});
