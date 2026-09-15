/**
 * #157b (lane N4) — stateful commands refuse --isolated.
 *
 * Pins:
 *   1. research + --isolated → parse-time VALIDATION_ERROR (exit 1) in the
 *      dispatch switch, BEFORE any provider/credential work (no provider
 *      doubles needed: the throw precedes descriptor.create()).
 *   2. crawl + --isolated → same, naming the crawl async-job state store.
 *   3. map + --isolated → SUCCEEDS (map is sync/stateless; the per-pid
 *      response cache namespace is the intended isolation surface).
 *   4. batch manifest carrying a research op under --isolated → per-op
 *      manifest VALIDATION_ERROR naming `operations[N]`; a manifest with
 *      no research/crawl ops runs fine under --isolated.
 *   5. watch rejection (the wording precedent) is unchanged by this lane —
 *      pinned in watch-command.test.js, not duplicated here (r2 review).
 *
 * Exit-code pins are env-honest: these rejections fire at parse time in
 * main()'s dispatch switch / parseBatchManifest, before credential
 * resolution, so exit 1 / VALIDATION_ERROR holds in every environment.
 *
 * Tests import dist/ per AGENTS.md (build before test). Nothing reads
 * process.env; nothing touches ~/.scoutline (hermeticMainDeps defaults
 * SCOUTLINE_CACHE_DIR/ARTIFACTS_DIR into the INJECTED env — T3/T4 own the
 * ambient seam).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../dist/index.js";
import { parseBatchManifest, BATCH_ALLOWLIST_MESSAGE } from "../dist/lib/batch-manifest.js";
import { ValidationError } from "../dist/lib/errors.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import {
  createFakeMapDescriptor,
  createFakeSearchDescriptor,
} from "./helpers/fake-adapter.js";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function makeAdapter() {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
  };
  return { adapter, stdout, stderr };
}

/** hermeticMainDeps with --isolated stamped into the INJECTED env (as main() does post-N3). */
function makeDeps(descriptors) {
  const { adapter, stdout, stderr } = makeAdapter();
  return {
    stdout,
    stderr,
    mainDeps: hermeticMainDeps({
      invocation: adapter,
      env: { SCOUTLINE_ISOLATED: "1" },
      providerDescriptors: descriptors,
    }),
  };
}

function writeManifest(manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-iso-batch-"));
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest), "utf8");
  return { dir, file };
}

/** Metadata-only descriptor double for parseBatchManifest unit calls. */
const ZAI_ALL = {
  id: "zai",
  isConfigured: () => true,
  capabilities: () => new Set(["search", "research", "crawl", "map", "reader", "repository"]),
  create() {
    throw new Error("create() must not be called during manifest parse");
  },
};

const BATCH_DEPS = {
  descriptors: [ZAI_ALL],
  dirExists: (d) => d === "/out",
};

/** Search-capable fake descriptor under a builtin id (handler-side provider parsing requires one). */
function makeSearchDescriptor() {
  return createFakeSearchDescriptor({
    id: "zai",
    capabilityOptions: {
      search: {
        result: [{ title: "s", url: "https://example.com/s", summary: "s" }],
      },
    },
  }).descriptor;
}

const MAP_RESULT = (request) => ({
  schemaVersion: 1,
  baseUrl: request.url,
  urls: [`${request.url}a`],
  totalUrls: 1,
});

// ---------------------------------------------------------------------------
// Noun rejections: research / crawl refuse --isolated (map allowed)
// ---------------------------------------------------------------------------

describe("stateful commands refuse --isolated (#157b)", () => {
  it("research under --isolated is a parse-time VALIDATION_ERROR naming the store and remedy", async () => {
    const { stdout, stderr, mainDeps } = makeDeps([]);
    const code = await main(["--isolated", "research", "deep query"], mainDeps);
    assert.strictEqual(code, 1);
    assert.strictEqual(stdout.length, 0, "no stdout data before rejection");
    const envelope = JSON.parse(stderr.join("").split("\n").filter(Boolean).pop());
    assert.strictEqual(envelope.code, "VALIDATION_ERROR");
    assert.strictEqual(envelope.error, "research cannot run under --isolated.");
    assert.match(
      envelope.help,
      /SCOUTLINE_CACHE_DIR\/research \(default ~\/\.scoutline\/research\)/,
    );
    assert.match(envelope.help, /Drop --isolated to keep resume state\./);
  });

  it("crawl under --isolated is a parse-time VALIDATION_ERROR naming the store and remedy", async () => {
    const { stdout, stderr, mainDeps } = makeDeps([]);
    const code = await main(["--isolated", "crawl", "https://example.com/"], mainDeps);
    assert.strictEqual(code, 1);
    assert.strictEqual(stdout.length, 0);
    const envelope = JSON.parse(stderr.join("").split("\n").filter(Boolean).pop());
    assert.strictEqual(envelope.code, "VALIDATION_ERROR");
    assert.strictEqual(envelope.error, "crawl cannot run under --isolated.");
    assert.match(
      envelope.help,
      /SCOUTLINE_CACHE_DIR\/crawl \(default ~\/\.scoutline\/crawl\)/,
    );
    assert.match(envelope.help, /Drop --isolated to keep resume state\./);
  });

  it("rejection fires with the flag after the subcommand too", async () => {
    const { stderr, mainDeps } = makeDeps([]);
    const code = await main(["research", "q", "--isolated"], mainDeps);
    assert.strictEqual(code, 1);
    assert.match(stderr.join(""), /VALIDATION_ERROR/);
  });

  it("rejection fires even with NO provider configured (parse-time, before credential work)", async () => {
    // Empty descriptor list + hermetic env: the pre-existing baseline run
    // fell through to provider skipping; the rejection must beat it.
    const { stderr, mainDeps } = makeDeps([]);
    const code = await main(["--isolated", "research", "q"], mainDeps);
    assert.strictEqual(code, 1);
    assert.match(stderr.join(""), /research cannot run under --isolated\./);
  });

  it("map under --isolated succeeds (sync/stateless)", async () => {
    const map = createFakeMapDescriptor({
      id: "zai",
      capabilityOptions: { fetch: { result: MAP_RESULT } },
    });
    const { stdout, stderr, mainDeps } = makeDeps([map.descriptor]);
    const code = await main(["--isolated", "map", "https://example.com/"], mainDeps);
    assert.strictEqual(code, 0, `stderr: ${JSON.stringify(stderr.join(""))}`);
    const envelope = JSON.parse(stdout.join(""));
    assert.strictEqual(envelope.schemaVersion, 1);
    assert.strictEqual(envelope.baseUrl, "https://example.com/");
    assert.deepStrictEqual(envelope.urls, ["https://example.com/a"]);
  });

  it("map without --isolated is unchanged (hermetic fake run, exit 0)", async () => {
    const map = createFakeMapDescriptor({
      id: "zai",
      capabilityOptions: { fetch: { result: MAP_RESULT } },
    });
    const { adapter, stdout, stderr } = makeAdapter();
    const deps = hermeticMainDeps({
      invocation: adapter,
      env: {},
      providerDescriptors: [map.descriptor],
    });
    const code = await main(["map", "https://example.com/"], deps);
    assert.strictEqual(code, 0, `stderr: ${JSON.stringify(stderr.join(""))}`);
    assert.strictEqual(JSON.parse(stdout.join("")).schemaVersion, 1);
  });
});

// ---------------------------------------------------------------------------
// Batch: per-op manifest rejection under --isolated
// ---------------------------------------------------------------------------

describe("batch manifest rejects stateful ops under --isolated (#157b)", () => {
  // The four parseBatchManifest unit pins (operations[0]/[1] error,
  // allowlist-first, isolated-absent parses) live in
  // batch-manifest.test.js ("batch manifest isolated rejection") — the
  // manifest-parse home — not duplicated here (r2 review nit).

  it("main()-driven: batch manifest with a research op under --isolated rejects per-op before any op runs", async () => {
    const { file, dir } = writeManifest({
      schemaVersion: 1,
      operations: [{ name: "op-r", command: "research", input: { query: "q" } }],
    });
    try {
      const search = makeSearchDescriptor();
      const { stdout, stderr, mainDeps } = makeDeps([search]);
      const code = await main(["--isolated", "batch", file], mainDeps);
      assert.strictEqual(code, 1);
      assert.strictEqual(stdout.length, 0, "no summary envelope on manifest rejection");
      const envelope = JSON.parse(stderr.join("").split("\n").filter(Boolean).pop());
      assert.strictEqual(envelope.code, "VALIDATION_ERROR");
      assert.match(envelope.error, /operations\[0\]/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("main()-driven: batch manifest with NO research/crawl ops runs fine under --isolated", async () => {
    const { file, dir } = writeManifest({
      schemaVersion: 1,
      operations: [{ name: "op-s", command: "search", input: { query: "q" } }],
    });
    try {
      const search = makeSearchDescriptor();
      const { stdout, stderr, mainDeps } = makeDeps([search]);
      const code = await main(["--isolated", "batch", file], mainDeps);
      assert.strictEqual(code, 0, `stderr: ${JSON.stringify(stderr.join(""))}`);
      const envelope = JSON.parse(stdout.join(""));
      assert.strictEqual(envelope.ok, 1);
      assert.strictEqual(envelope.failed, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
