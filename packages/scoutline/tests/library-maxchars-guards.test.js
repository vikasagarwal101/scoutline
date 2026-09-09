/**
 * Library maxChars smuggle guards (issue #105, ADR-0007 follow-up).
 *
 * The dispatcher seam owns `--max-chars` on EVERY surface (seven ladder
 * surfaces + parse-time rejection elsewhere). Before #105, deep-import
 * callers got three different undeclared semantics:
 *   - read/crawl/repo search/repo read: retired per-field truncation
 *     still silently applied (library-level, dead from the dispatcher);
 *   - repoBrief/research: loud ValidationError (M3/F-2 guards);
 *   - search/map/fetch/archive/watch/explorerTree: silent no-op.
 *
 * This file pins the UNIFIED contract: every library entry point a deep
 * importer can reach rejects a smuggled `maxChars` with the same
 * ValidationError shape, absence stays byte-identical, and the CLI
 * ladder path (the sanctioned budget consumer) keeps working.
 *
 * Red-first: every guard pin below failed before the helper existed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../dist/index.js";
import { read } from "../dist/commands/read.js";
import { crawl } from "../dist/commands/crawl.js";
import { search } from "../dist/commands/search.js";
import { map } from "../dist/commands/map.js";
import { research } from "../dist/commands/research.js";
import { repoSearch, repoRead, repoBrief } from "../dist/commands/repo.js";
import {
  explorerSearch,
  explorerReadFile,
  explorerTree,
} from "../dist/commands/repository-explorer.js";
import { executeFetch } from "../dist/commands/fetch.js";
import {
  executeArchiveCdx,
  executeArchiveGet,
  executeArchiveDiff,
} from "../dist/commands/archive.js";
import { handleWatch } from "../dist/commands/watch.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { withTempDir } from "./helpers/temp-dir.js";

const GUARD_MESSAGE = /^maxChars is not an? \S+ option — the dispatcher seam owns --max-chars/;

function isValidationError(err) {
  return err instanceof Error && err.name === "ValidationError";
}

/** Minimal fake op: validate/cacheIdentity/invoke (reader-command shape). */
function fakeOp(kind, result) {
  return {
    kind,
    validate() {},
    cacheIdentity(request) {
      return {
        provider: "zai",
        capability: "capability",
        operation: kind,
        credentialFingerprint: "fp-zai",
        request,
        legacyCandidates: [],
      };
    },
    async invoke() {
      return result;
    },
  };
}

const inMemoryCache = () => {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
};
const execution = () => ({ cache: inMemoryCache(), sleep: async () => {}, random: () => 0.5 });

const READ_RESULT = {
  schemaVersion: 1,
  url: "https://example.com/doc",
  finalUrl: "https://example.com/doc",
  title: "Doc",
  content: "# Title\n\nFull body, never truncated at the library seam.",
  contentFormat: "markdown",
};

const CRAWL_RESULT = {
  schemaVersion: 1,
  baseUrl: "https://example.com",
  pages: [
    { url: "https://example.com/p1", content: "one", contentFormat: "markdown" },
    { url: "https://example.com/p2", content: "two", contentFormat: "markdown" },
  ],
  totalPages: 2,
};

/**
 * Every deep-import-reachable library entry point, called with a
 * smuggled maxChars and otherwise-valid minimal arguments.
 */
const SMUGGLE_CALLS = [
  ["search", () => search("q", { maxChars: 500 }, {})],
  [
    "read",
    () =>
      read(
        "https://example.com/",
        { maxChars: 500 },
        { capability: { fetch: fakeOp("reader-fetch", READ_RESULT) }, execution: execution() },
      ),
  ],
  [
    "crawl",
    () =>
      crawl(
        "https://example.com/",
        { maxChars: 500 },
        { capability: { fetch: fakeOp("crawl-fetch", CRAWL_RESULT) }, execution: execution() },
      ),
  ],
  [
    "map",
    () =>
      map(
        "https://example.com/",
        { maxChars: 500 },
        {
          capability: {
            fetch: fakeOp("map-fetch", {
              schemaVersion: 1,
              baseUrl: "https://example.com",
              urls: [],
            }),
          },
          execution: execution(),
        },
      ),
  ],
  ["research", () => research("q", { maxChars: 500 }, { capability: {}, execution: {} })],
  [
    "repoSearch",
    () => repoSearch("owner/repo", "q", { maxChars: 500 }, { capability: {}, execution: {} }),
  ],
  [
    "repoRead",
    () => repoRead("owner/repo", "README.md", { maxChars: 500 }, { capability: {}, execution: {} }),
  ],
  [
    "repoBrief",
    () =>
      repoBrief(
        "owner/repo",
        { focus: ["structure"], maxChars: 500 },
        { capability: {}, execution: {} },
      ),
  ],
  [
    "explorerSearch",
    () =>
      explorerSearch(
        { search: fakeOp("repository-search", {}) },
        { repository: "owner/repo", query: "q" },
        { maxChars: 500 },
        execution(),
      ),
  ],
  [
    "explorerReadFile",
    () =>
      explorerReadFile(
        { readFile: fakeOp("repository-read-file", {}) },
        { repository: "owner/repo", path: "README.md" },
        { maxChars: 500 },
        execution(),
      ),
  ],
  [
    "explorerTree",
    () =>
      explorerTree(
        { listDirectory: fakeOp("repository-list-directory", {}) },
        { repository: "owner/repo" },
        { maxChars: 500 },
        execution(),
      ),
  ],
  ["executeFetch", () => executeFetch("https://example.com/", { maxChars: 500 })],
  ["executeArchiveCdx", () => executeArchiveCdx("https://example.com/", { maxChars: 500 })],
  ["executeArchiveGet", () => executeArchiveGet("https://example.com/", { maxChars: 500 })],
  ["executeArchiveDiff", () => executeArchiveDiff("https://example.com/", { maxChars: 500 })],
  ["handleWatch", () => handleWatch(["run", "target", "--max-chars", "500"], "data", {})],
];

describe("library maxChars smuggle guards (issue #105)", () => {
  it("every deep-import-reachable entry point rejects a smuggled maxChars loud", async () => {
    for (const [name, call] of SMUGGLE_CALLS) {
      await assert.rejects(
        call(),
        (err) => isValidationError(err) && GUARD_MESSAGE.test(err.message),
        `${name} must throw a unified ValidationError on smuggled maxChars`,
      );
    }
  });

  it("presence throws, value does not matter: 0, -1, NaN, Infinity all reject (read + explorerSearch)", async () => {
    const readDeps = {
      capability: { fetch: fakeOp("reader-fetch", READ_RESULT) },
      execution: execution(),
    };
    for (const maxChars of [0, -1, NaN, Infinity]) {
      await assert.rejects(read("https://example.com/", { maxChars }, readDeps), isValidationError);
      await assert.rejects(
        explorerSearch(
          { search: fakeOp("repository-search", {}) },
          { repository: "owner/repo", query: "q" },
          { maxChars },
          execution(),
        ),
        isValidationError,
      );
    }
  });

  it("absence stays byte-identical: read()/crawl() without maxChars return the full envelope", async () => {
    const readOut = await read(
      "https://example.com/",
      {},
      { capability: { fetch: fakeOp("reader-fetch", READ_RESULT) }, execution: execution() },
    );
    assert.equal(readOut.kind, "data");
    assert.equal(readOut.data.content, READ_RESULT.content);
    assert.equal(readOut.data.truncated, false);
    assert.equal(readOut.data.originalContentLength, READ_RESULT.content.length);

    const crawlOut = await crawl(
      "https://example.com/",
      {},
      { capability: { fetch: fakeOp("crawl-fetch", CRAWL_RESULT) }, execution: execution() },
    );
    assert.equal(crawlOut.kind, "data");
    assert.deepEqual(
      crawlOut.data.pages.map((p) => p.content),
      ["one", "two"],
    );
    assert.equal(crawlOut.data.totalPages, 2);
  });

  it("the CLI ladder path (the sanctioned consumer) still works: read --max-chars budgets and stamps compaction", async (t) => {
    await withTempDir(t, async (dir) => {
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
      const content = "# Title\n\n" + "A".repeat(2000);
      const result = { ...READ_RESULT, content };
      const status = await main(
        ["--provider", "zai", "read", "https://example.com/doc", "--max-chars", "400"],
        hermeticMainDeps({
          invocation: adapter,
          env: {
            Z_AI_API_KEY: "zai-key",
            SCOUTLINE_ARTIFACTS_DIR: dir,
          },
          providerDescriptors: [
            {
              id: "zai",
              isConfigured: (env) =>
                typeof env.Z_AI_API_KEY === "string" && env.Z_AI_API_KEY.length > 0,
              capabilities: () => new Set(["reader"]),
              create: () => ({ id: "zai", reader: { fetch: fakeOp("reader-fetch", result) } }),
            },
          ],
          now: () => 1_800_000_000_000,
        }),
      );
      assert.equal(status, 0, `read --max-chars must exit 0; stderr: ${stderr.join("")}`);
      const data = JSON.parse(stdout.join(""));
      assert.ok(data.compaction, "compaction stamped in-band");
      assert.equal(data.compaction.budget, 400);
      assert.ok(data.content.length < content.length, "content actually budgeted");
      assert.equal(data.url, "https://example.com/doc", "never-cut url survives");
    });
  });
});
