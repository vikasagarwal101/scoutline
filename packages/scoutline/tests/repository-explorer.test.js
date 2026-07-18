/**
 * P6-05 — Provider-neutral Repository Explorer (DESIGN.md §18, §11).
 *
 * Drives the Explorer with a deterministic fake RepositoryCapability
 * so canonical path handling, request defaults, BFS depth/order/
 * deduplication, Provider-derived child safety, mid-BFS failure,
 * Search/File `--max-chars` projection, and the source-boundary
 * contract can all be asserted without touching a concrete Adapter,
 * MCP/UTCP transport, or process globals.
 *
 * Scope:
 *   - canonicalizeRepositoryPath matrix (root aliases, leading/trailing/
 *     repeated `/`, File leading `./` and `/`, dot segments, backslashes,
 *     ASCII controls, literal percent escapes);
 *   - explorerSearch / explorerReadFile / explorerTree defaults
 *     (`language = "en"`, `depth = 1`, at-least-one-slash repository,
 *     non-whitespace query, exact case/text preservation);
 *   - BFS preserves Provider sibling order, snapshots breadth-first,
 *     requests each canonical directory at most once, expands only
 *     directories while `level < depth`, and never returns partial
 *     success after a mid-BFS failure;
 *   - Search total-budget and File content-budget projection with the
 *     exact ellipsis rule and pre-projection original-length metadata;
 *   - explicit empty Search excerpts and empty directory entries are
 *     valid with the fake capability;
 *   - a static source-boundary assertion proving the Explorer imports
 *     no concrete Provider, MCP/UTCP, raw tool name, or Provider
 *     response type.
 *
 * The fake RepositoryCapability records every `invoke` call. The fake
 * in-memory `ResponseCache`, `sleep`, and `random` make the shared
 * execution pipeline deterministic. Every assertion is data-only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalizeRepositoryPath,
  explorerSearch,
  explorerReadFile,
  explorerTree,
} from "../dist/commands/repository-explorer.js";
import { ValidationError } from "../dist/lib/errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const EXPLORER_SOURCE_REL = path.join("src", "commands", "repository-explorer.ts");
const EXPLORER_SOURCE_ABS = path.join(PACKAGE_ROOT, EXPLORER_SOURCE_REL);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Build a deterministic fake RepositoryCapability. Each operation
 * records every `invoke` call (with the canonical request) and
 * dispatches through the supplied `impl`. The fake's `validate` is
 * permissive so tests focus on Explorer behavior; the Explorer's
 * own pre-validation runs before the fake sees the request, and the
 * Adapter's defensive re-validation is covered separately by the
 * Adapter tests. `cacheIdentity` returns the canonical request
 * verbatim with a fixed fake fingerprint so the in-memory cache
 * behaves deterministically. `decodeCached` is permissive but
 * rejects primitives so a structured value is required for a hit.
 */
function makeFakeCapability({ search, readFile, listDirectory } = {}) {
  function makeOp(kind, impl, label) {
    const calls = [];
    const op = {
      kind,
      calls,
      validate() {
        // Permissive: Explorer pre-validation has already run.
      },
      cacheIdentity(request) {
        return {
          provider: "zai",
          capability: "repository-exploration",
          operation: kind,
          credentialFingerprint: "fake-fingerprint-fixed",
          request,
          legacyCandidates: [],
        };
      },
      decodeCached(value) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return value;
        }
        return null;
      },
      async invoke(request) {
        calls.push(request);
        if (typeof impl !== "function") {
          throw new Error(
            `fake ${label} invoke not configured for request ${JSON.stringify(request)}`,
          );
        }
        return impl(request, calls.length);
      },
    };
    return op;
  }

  return {
    search: makeOp("repository-search", search, "search"),
    readFile: makeOp("repository-read-file", readFile, "readFile"),
    listDirectory: makeOp("repository-list-directory", listDirectory, "listDirectory"),
  };
}

/** In-memory ResponseCache + deterministic sleep/random. */
function makeFakeDeps() {
  const store = new Map();
  const cache = {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
  const sleepCalls = [];
  const sleep = (ms) => {
    sleepCalls.push(ms);
    return Promise.resolve();
  };
  sleep.calls = sleepCalls;
  const random = () => 0;
  return { cache, sleep, random };
}

// Deep clone helper so the fake can return canned results without
// the test mutating them later (or vice versa).
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Path canonicalization matrix
// ---------------------------------------------------------------------------

describe("canonicalizeRepositoryPath — directory / tree root aliases", () => {
  for (const [input, label] of [
    [undefined, "undefined"],
    ["", "empty"],
    ["/", "single slash"],
    [".", "single dot"],
  ]) {
    it(`directory: ${label} maps to root ""`, () => {
      assert.strictEqual(canonicalizeRepositoryPath(input, "directory"), "");
    });
  }

  it('directory: "///" collapses to root ""', () => {
    assert.strictEqual(canonicalizeRepositoryPath("///", "directory"), "");
  });
});

describe("canonicalizeRepositoryPath — File rejects root in every form", () => {
  for (const [input, label] of [
    [undefined, "undefined"],
    ["", "empty"],
    ["/", "single slash"],
    [".", "single dot"],
    ["./", "dot slash"],
    ["///", "repeated slashes"],
  ]) {
    it(`file: ${label} throws ValidationError`, () => {
      assert.throws(() => canonicalizeRepositoryPath(input, "file"), ValidationError);
    });
  }
});

describe("canonicalizeRepositoryPath — leading/trailing/repeated '/' normalize", () => {
  for (const [input, expected, label] of [
    ["foo", "foo", "bare segment"],
    ["/foo", "foo", "leading slash"],
    ["foo/", "foo", "trailing slash"],
    ["foo//bar", "foo/bar", "repeated middle slash"],
    ["//foo//bar//", "foo/bar", "surrounding slashes"],
    ["/a/b/c/", "a/b/c", "leading + trailing"],
    ["foo/bar/baz", "foo/bar/baz", "multi-segment unchanged"],
  ]) {
    it(`directory: ${label} -> "${expected}"`, () => {
      assert.strictEqual(canonicalizeRepositoryPath(input, "directory"), expected);
    });
    it(`file: ${label} -> "${expected}"`, () => {
      assert.strictEqual(canonicalizeRepositoryPath(input, "file"), expected);
    });
  }
});

describe("canonicalizeRepositoryPath — File leading './' convenience", () => {
  for (const [input, expected, label] of [
    ["./foo", "foo", "leading dot slash"],
    ["./foo/bar", "foo/bar", "leading dot slash multi"],
    ["/foo", "foo", "leading slash (shared)"],
    ["./a/b/c", "a/b/c", "leading dot slash deep"],
  ]) {
    it(`file: ${label} -> "${expected}"`, () => {
      assert.strictEqual(canonicalizeRepositoryPath(input, "file"), expected);
    });
  }

  it('directory: "./foo" rejects the leading dot segment (not a File convenience)', () => {
    assert.throws(() => canonicalizeRepositoryPath("./foo", "directory"), ValidationError);
  });
});

describe("canonicalizeRepositoryPath — dot and dot-dot segments reject", () => {
  const rejectsBothKinds = [
    ["..", "bare dot-dot"],
    ["./..", "dot-slash dot-dot (file strips leading ./)"],
    ["../foo", "leading dot-dot"],
    ["foo/..", "trailing dot-dot"],
    ["foo/.", "trailing dot"],
    ["foo/./bar", "mid dot"],
    ["foo/../bar", "mid dot-dot"],
    ["a/./b/../c", "mixed dot/dot-dot"],
  ];
  for (const [input, label] of rejectsBothKinds) {
    it(`file: ${label} ("${input}") throws`, () => {
      assert.throws(() => canonicalizeRepositoryPath(input, "file"), ValidationError);
    });
    it(`directory: ${label} ("${input}") throws`, () => {
      assert.throws(() => canonicalizeRepositoryPath(input, "directory"), ValidationError);
    });
  }
});

describe("canonicalizeRepositoryPath — backslashes and ASCII controls reject", () => {
  const rejects = [
    ["foo\\bar", "backslash"],
    ["foo\0bar", "NUL"],
    ["foo\x01bar", "SOH"],
    ["foo\x1fbar", "US (0x1f)"],
    ["foo\x7fbar", "DEL"],
    ["foo\tbar", "tab"],
    ["foo\nbar", "LF"],
    ["foo\rbar", "CR"],
  ];
  for (const [input, label] of rejects) {
    it(`file: ${label} throws`, () => {
      assert.throws(() => canonicalizeRepositoryPath(input, "file"), ValidationError);
    });
    it(`directory: ${label} throws`, () => {
      assert.throws(() => canonicalizeRepositoryPath(input, "directory"), ValidationError);
    });
  }
});

describe("canonicalizeRepositoryPath — percent escapes stay literal", () => {
  // Never percent-decode: %2e, %2E, %2F, %25 are all literal text.
  for (const [input, expected, label] of [
    ["foo%2ebar", "foo%2ebar", "lowercase percent-2e"],
    ["foo%2Ebar", "foo%2Ebar", "uppercase percent-2E"],
    ["foo%2Fbar", "foo%2Fbar", "encoded slash"],
    ["foo%252fbar", "foo%252fbar", "doubly encoded"],
    ["%2e", "%2e", "bare percent-2e (NOT treated as .)"],
    ["%2E", "%2E", "bare uppercase percent-2E"],
  ]) {
    it(`directory: ${label} -> "${expected}"`, () => {
      assert.strictEqual(canonicalizeRepositoryPath(input, "directory"), expected);
    });
    it(`file: ${label} -> "${expected}"`, () => {
      assert.strictEqual(canonicalizeRepositoryPath(input, "file"), expected);
    });
  }

  it('directory: bare "%2f" is not decoded to "/" (no root alias)', () => {
    assert.strictEqual(canonicalizeRepositoryPath("%2f", "directory"), "%2f");
  });
});

describe("canonicalizeRepositoryPath — non-ASCII and case preserved", () => {
  it("directory: Unicode letters are accepted unchanged", () => {
    assert.strictEqual(canonicalizeRepositoryPath("café/résumé", "directory"), "café/résumé");
  });
  it("file: case is preserved verbatim", () => {
    assert.strictEqual(canonicalizeRepositoryPath("README.md", "file"), "README.md");
  });
  it("directory: non-ASCII whitespace (U+00A0) is accepted (only ASCII controls reject)", () => {
    assert.strictEqual(canonicalizeRepositoryPath("foo\u00a0bar", "directory"), "foo\u00a0bar");
  });
});

// ---------------------------------------------------------------------------
// explorerSearch — defaults and validation
// ---------------------------------------------------------------------------

describe("explorerSearch — defaults and validation", () => {
  it("applies the `language = 'en'` default before invoking", async () => {
    const cap = makeFakeCapability({
      search: () => ({
        schemaVersion: 1,
        repository: "owner/repo",
        query: "auth",
        language: "en",
        excerpts: [],
        truncated: false,
        originalTextLength: 0,
      }),
    });
    const deps = makeFakeDeps();
    await explorerSearch(cap, { repository: "owner/repo", query: "auth" }, {}, deps);
    assert.strictEqual(cap.search.calls.length, 1);
    assert.deepStrictEqual(cap.search.calls[0], {
      repository: "owner/repo",
      query: "auth",
      language: "en",
    });
  });

  it("preserves an explicit 'zh' language", async () => {
    const cap = makeFakeCapability({
      search: () => ({
        schemaVersion: 1,
        repository: "owner/repo",
        query: "认证",
        language: "zh",
        excerpts: [],
        truncated: false,
        originalTextLength: 0,
      }),
    });
    await explorerSearch(
      cap,
      { repository: "owner/repo", query: "认证", language: "zh" },
      {},
      makeFakeDeps(),
    );
    assert.strictEqual(cap.search.calls[0].language, "zh");
    assert.strictEqual(cap.search.calls[0].query, "认证");
  });

  it("preserves exact repository case and query text (including internal whitespace)", async () => {
    const cap = makeFakeCapability({
      search: (req) => ({
        schemaVersion: 1,
        repository: req.repository,
        query: req.query,
        language: req.language,
        excerpts: [],
        truncated: false,
        originalTextLength: 0,
      }),
    });
    await explorerSearch(
      cap,
      { repository: "Owner/Repo", query: "  hello   world  " },
      {},
      makeFakeDeps(),
    );
    assert.strictEqual(cap.search.calls[0].repository, "Owner/Repo");
    assert.strictEqual(cap.search.calls[0].query, "  hello   world  ");
  });

  for (const [repository, label] of [
    ["noslash", "missing slash"],
    ["", "empty"],
  ]) {
    it(`repository without slash (${label}) throws ValidationError before any invoke`, async () => {
      const cap = makeFakeCapability({ search: () => null });
      await assert.rejects(
        explorerSearch(cap, { repository, query: "q" }, {}, makeFakeDeps()),
        ValidationError,
      );
      assert.strictEqual(cap.search.calls.length, 0);
    });
  }

  for (const [query, label] of [
    ["", "empty"],
    ["   ", "only whitespace"],
    ["\t\n", "tab and newline"],
  ]) {
    it(`whitespace-only query (${label}) throws before any invoke`, async () => {
      const cap = makeFakeCapability({ search: () => null });
      await assert.rejects(
        explorerSearch(cap, { repository: "owner/repo", query }, {}, makeFakeDeps()),
        ValidationError,
      );
      assert.strictEqual(cap.search.calls.length, 0);
    });
  }

  it("invalid language throws before any invoke", async () => {
    const cap = makeFakeCapability({ search: () => null });
    await assert.rejects(
      explorerSearch(
        cap,
        { repository: "owner/repo", query: "q", language: "fr" },
        {},
        makeFakeDeps(),
      ),
      ValidationError,
    );
    assert.strictEqual(cap.search.calls.length, 0);
  });

  it("explicit empty excerpts are returned unchanged", async () => {
    const cap = makeFakeCapability({
      search: () => ({
        schemaVersion: 1,
        repository: "owner/repo",
        query: "q",
        language: "en",
        excerpts: [],
        truncated: false,
        originalTextLength: 0,
      }),
    });
    const out = await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      {},
      makeFakeDeps(),
    );
    assert.deepStrictEqual(out.excerpts, []);
    assert.strictEqual(out.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// explorerReadFile — defaults and validation
// ---------------------------------------------------------------------------

describe("explorerReadFile — defaults and validation", () => {
  it("canonicalizes a File path and forwards the canonical request", async () => {
    const cap = makeFakeCapability({
      readFile: (req) => ({
        schemaVersion: 1,
        repository: req.repository,
        path: req.path,
        content: "body",
        truncated: false,
        originalContentLength: 4,
      }),
    });
    await explorerReadFile(
      cap,
      { repository: "owner/repo", path: "./src/index.ts" },
      {},
      makeFakeDeps(),
    );
    assert.strictEqual(cap.readFile.calls[0].path, "src/index.ts");
  });

  for (const [p, label] of [
    [undefined, "undefined"],
    ["", "empty"],
    [".", "single dot"],
    ["/", "single slash"],
    ["./", "dot slash"],
    ["foo/..", "dot-dot segment"],
    ["foo\\bar", "backslash"],
  ]) {
    it(`invalid File path (${label}) throws before any invoke`, async () => {
      const cap = makeFakeCapability({ readFile: () => null });
      await assert.rejects(
        explorerReadFile(cap, { repository: "owner/repo", path: p }, {}, makeFakeDeps()),
        ValidationError,
      );
      assert.strictEqual(cap.readFile.calls.length, 0);
    });
  }

  it("repository without slash throws before any invoke", async () => {
    const cap = makeFakeCapability({ readFile: () => null });
    await assert.rejects(
      explorerReadFile(cap, { repository: "noslash", path: "foo" }, {}, makeFakeDeps()),
      ValidationError,
    );
    assert.strictEqual(cap.readFile.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// explorerTree — depth projection and validation
// ---------------------------------------------------------------------------

describe("explorerTree — depth projection", () => {
  it("default depth is 1 (single snapshot of the starting directory)", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: req.repository,
        path: req.path,
        entries: [{ name: "sub", path: "sub", kind: "directory" }],
      }),
    });
    const out = await explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps());
    assert.strictEqual(out.depth, 1);
    assert.strictEqual(cap.listDirectory.calls.length, 1);
    assert.strictEqual(out.snapshots.length, 1);
  });

  it("depth 2.5 projects to integer 2", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: req.repository,
        path: req.path,
        entries: [],
      }),
    });
    const out = await explorerTree(
      cap,
      { repository: "owner/repo", depth: 2.5 },
      {},
      makeFakeDeps(),
    );
    assert.strictEqual(out.depth, 2);
  });

  for (const [d, label] of [
    [0, "zero"],
    [-1, "negative"],
    [NaN, "NaN"],
    [Infinity, "Infinity"],
    [-Infinity, "negative Infinity"],
  ]) {
    it(`depth ${label} throws ValidationError`, async () => {
      const cap = makeFakeCapability({ listDirectory: () => null });
      await assert.rejects(
        explorerTree(cap, { repository: "owner/repo", depth: d }, {}, makeFakeDeps()),
        ValidationError,
      );
    });
  }

  it("Tree path aliases map to root", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: req.repository,
        path: req.path,
        entries: [],
      }),
    });
    for (const p of [undefined, "", "/", "."]) {
      const out = await explorerTree(
        cap,
        { repository: "owner/repo", path: p },
        {},
        makeFakeDeps(),
      );
      assert.strictEqual(out.path, "");
    }
  });
});

// ---------------------------------------------------------------------------
// BFS — depth, sibling order, snapshot order, dedup, mid-BFS failure
// ---------------------------------------------------------------------------

describe("explorerTree — BFS depth and snapshot order", () => {
  it("depth 1 snapshots only the starting directory even when it has directory children", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => {
        if (req.path === "") {
          return {
            repository: "owner/repo",
            path: "",
            entries: [
              { name: "a", path: "a", kind: "directory" },
              { name: "b", path: "b", kind: "directory" },
            ],
          };
        }
        throw new Error(`unexpected listDirectory for path "${req.path}"`);
      },
    });
    const out = await explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps());
    assert.strictEqual(out.snapshots.length, 1);
    assert.strictEqual(out.snapshots[0].path, "");
    assert.strictEqual(cap.listDirectory.calls.length, 1);
  });

  it("depth 2 snapshots root then expands immediate directory children in Provider order", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => {
        const byPath = {
          "": {
            repository: "owner/repo",
            path: "",
            entries: [
              { name: "z", path: "z", kind: "directory" },
              { name: "a", path: "a", kind: "directory" },
              { name: "m", path: "m", kind: "file" },
            ],
          },
          z: {
            repository: "owner/repo",
            path: "z",
            entries: [{ name: "z1", path: "z/z1", kind: "file" }],
          },
          a: {
            repository: "owner/repo",
            path: "a",
            entries: [{ name: "a1", path: "a/a1", kind: "directory" }],
          },
        };
        const v = byPath[req.path];
        if (!v) throw new Error(`unexpected path ${req.path}`);
        return v;
      },
    });
    const out = await explorerTree(cap, { repository: "owner/repo", depth: 2 }, {}, makeFakeDeps());
    // BFS: root, then z (level 2, snapshot but no expand at depth 2),
    // then a. m is a file and not enqueued. The depth-2 children of
    // z and a are not expanded (level === depth stops expansion).
    assert.deepStrictEqual(
      out.snapshots.map((s) => s.path),
      ["", "z", "a"],
    );
    assert.strictEqual(cap.listDirectory.calls.length, 3);
  });

  it("depth 3 expands while level < depth", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => {
        const byPath = {
          "": {
            repository: "owner/repo",
            path: "",
            entries: [{ name: "a", path: "a", kind: "directory" }],
          },
          a: {
            repository: "owner/repo",
            path: "a",
            entries: [{ name: "b", path: "a/b", kind: "directory" }],
          },
          "a/b": {
            repository: "owner/repo",
            path: "a/b",
            entries: [{ name: "c", path: "a/b/c", kind: "directory" }],
          },
          "a/b/c": {
            repository: "owner/repo",
            path: "a/b/c",
            entries: [],
          },
        };
        const v = byPath[req.path];
        if (!v) throw new Error(`unexpected path ${req.path}`);
        return v;
      },
    });
    const out = await explorerTree(cap, { repository: "owner/repo", depth: 3 }, {}, makeFakeDeps());
    // depth=3: root (L1) expands, a (L2) expands, a/b (L3) does NOT expand.
    assert.deepStrictEqual(
      out.snapshots.map((s) => s.path),
      ["", "a", "a/b"],
    );
    assert.strictEqual(cap.listDirectory.calls.length, 3);
  });

  it("BFS preserves Provider sibling order (not alphabetical)", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => {
        if (req.path === "") {
          return {
            repository: "owner/repo",
            path: "",
            entries: [
              { name: "zebra", path: "zebra", kind: "directory" },
              { name: "alpha", path: "alpha", kind: "directory" },
              { name: "mango", path: "mango", kind: "directory" },
            ],
          };
        }
        return {
          repository: "owner/repo",
          path: req.path,
          entries: [],
        };
      },
    });
    const out = await explorerTree(cap, { repository: "owner/repo", depth: 2 }, {}, makeFakeDeps());
    assert.deepStrictEqual(
      out.snapshots.map((s) => s.path),
      ["", "zebra", "alpha", "mango"],
    );
  });
});

describe("explorerTree — duplicate directories are requested once, first-encounter order", () => {
  it("duplicate IDENTICAL directory entries within one listing invoke the child exactly once", async () => {
    // Under the immediate-child rule (see the binding block below),
    // the SAME canonical path can only appear as a child of its
    // unique parent, so cross-listing dedup is structurally
    // impossible. Deduplication is observable only when one
    // listing returns the same entry twice — both pass entry
    // validation (same name, same path), but the BFS visited set
    // enqueues the directory exactly once.
    const cap = makeFakeCapability({
      listDirectory: (req) => {
        const byPath = {
          "": {
            repository: "owner/repo",
            path: "",
            entries: [
              { name: "shared", path: "shared", kind: "directory" },
              { name: "shared", path: "shared", kind: "directory" },
            ],
          },
          shared: {
            repository: "owner/repo",
            path: "shared",
            entries: [],
          },
        };
        const v = byPath[req.path];
        if (!v) throw new Error(`unexpected path ${req.path}`);
        return v;
      },
    });
    const out = await explorerTree(cap, { repository: "owner/repo", depth: 3 }, {}, makeFakeDeps());
    // Root, then "shared" once — the second identical entry in the
    // root listing is dropped by the visited set, never enqueued.
    assert.deepStrictEqual(
      out.snapshots.map((s) => s.path),
      ["", "shared"],
    );
    assert.strictEqual(cap.listDirectory.calls.length, 2);
    // The root listing still surfaces both entries in its snapshot;
    // only the BFS enqueue deduplicates.
    assert.strictEqual(out.snapshots[0].entries.length, 2);
  });

  it("BFS visits nested directories breadth-first without relying on cross-parent dedup", async () => {
    // Root -> a -> b -> c -> d. Each level lists exactly one
    // immediate-child directory whose path is parent + "/" + name.
    // BFS visits root, a, a/b, a/b/c, a/b/c/d in order.
    const cap = makeFakeCapability({
      listDirectory: (req) => {
        const byPath = {
          "": {
            repository: "owner/repo",
            path: "",
            entries: [{ name: "a", path: "a", kind: "directory" }],
          },
          a: {
            repository: "owner/repo",
            path: "a",
            entries: [{ name: "b", path: "a/b", kind: "directory" }],
          },
          "a/b": {
            repository: "owner/repo",
            path: "a/b",
            entries: [{ name: "c", path: "a/b/c", kind: "directory" }],
          },
          "a/b/c": {
            repository: "owner/repo",
            path: "a/b/c",
            entries: [{ name: "d", path: "a/b/c/d", kind: "directory" }],
          },
          "a/b/c/d": {
            repository: "owner/repo",
            path: "a/b/c/d",
            entries: [],
          },
        };
        const v = byPath[req.path];
        if (!v) throw new Error(`unexpected path ${req.path}`);
        return v;
      },
    });
    const out = await explorerTree(cap, { repository: "owner/repo", depth: 5 }, {}, makeFakeDeps());
    assert.deepStrictEqual(
      out.snapshots.map((s) => s.path),
      ["", "a", "a/b", "a/b/c", "a/b/c/d"],
    );
    assert.strictEqual(cap.listDirectory.calls.length, 5);
  });
});

// ---------------------------------------------------------------------------
// Explorer — listing-request binding and immediate-child relation.
//
// The Explorer MUST bind every Provider-derived listing to the exact
// canonical request and require every entry to be the immediate child
// of the listing's path. Otherwise a fake Adapter could return a
// mismatched repository, a mismatched path, a name that does not match
// the final path segment, or a canonical-but-non-immediate child path,
// and the BFS would snapshot or enqueue the wrong subtree.
//
// These cases were RED before the fix (the old validator only checked
// structural shape and self-canonicalization). They are GREEN after
// binding the validator to the request and enforcing the immediate-
// child relation.
// ---------------------------------------------------------------------------

describe("explorerTree — listing-request binding and immediate-child relation", () => {
  it("listing.repository different from the request repository fails the whole tree", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: "other/repo",
        path: req.path,
        entries: [],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("listing.path different from the request path fails the whole tree", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: req.repository,
        path: "different/path",
        entries: [],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("entry.name not matching the final segment of entry.path fails (root listing)", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "",
        entries: [{ name: "foo", path: "bar", kind: "file" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("entry.name not matching the final segment of entry.path fails (nested listing)", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "src",
        entries: [{ name: "index.ts", path: "src/other.ts", kind: "file" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo", path: "src" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("a canonical-but-non-immediate child path fails (sibling-of-parent shape)", async () => {
    // Entry has name "x" and a path "y/x" that is perfectly canonical
    // but is NOT the immediate child of the root listing (which would
    // be just "x"). The validator must reject this even though the
    // path canonicalizes to itself.
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "",
        entries: [{ name: "x", path: "y/x", kind: "directory" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("a canonical-but-outside-the-subtree child path fails", async () => {
    // Listing at "src/lib"; entry name "util.ts" but path
    // "test/util.ts" (canonical, sibling of the listing path). The
    // immediate-child path "src/lib/util.ts" is the only acceptable
    // shape.
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "src/lib",
        entries: [{ name: "util.ts", path: "test/util.ts", kind: "file" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo", path: "src/lib" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("entry name containing '/' fails (name is a single segment)", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "",
        entries: [{ name: "a/b", path: "a/b", kind: "file" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("entry name '.' fails (single segment is unsafe)", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "",
        entries: [{ name: ".", path: ".", kind: "file" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("entry name '..' fails", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "",
        entries: [{ name: "..", path: "..", kind: "file" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("entry name containing backslash fails", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "",
        entries: [{ name: "a\\b", path: "a\\b", kind: "file" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("entry name containing an ASCII control character fails", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "",
        entries: [{ name: "a\nb", path: "a\nb", kind: "file" }],
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("a well-formed immediate-child listing at the repository root passes", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: req.repository,
        path: req.path,
        entries: [
          { name: "README.md", path: "README.md", kind: "file" },
          { name: "src", path: "src", kind: "directory" },
        ],
      }),
    });
    const out = await explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps());
    assert.strictEqual(out.snapshots.length, 1);
    assert.deepStrictEqual(out.snapshots[0].entries, [
      { name: "README.md", path: "README.md", kind: "file" },
      { name: "src", path: "src", kind: "directory" },
    ]);
  });

  it("a well-formed immediate-child listing at a nested path passes", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: req.repository,
        path: req.path,
        entries: [
          { name: "index.ts", path: "src/index.ts", kind: "file" },
          { name: "util", path: "src/util", kind: "directory" },
        ],
      }),
    });
    const out = await explorerTree(
      cap,
      { repository: "owner/repo", path: "src" },
      {},
      makeFakeDeps(),
    );
    assert.strictEqual(out.snapshots.length, 1);
    assert.deepStrictEqual(out.snapshots[0].entries, [
      { name: "index.ts", path: "src/index.ts", kind: "file" },
      { name: "util", path: "src/util", kind: "directory" },
    ]);
  });
});

describe("explorerTree — unsafe Provider children fail the whole tree", () => {
  for (const [badEntry, label] of [
    // Dot/dot-dot child paths.
    [{ name: "x", path: "x/..", kind: "directory" }, "dot-dot in child path"],
    [{ name: "x", path: "x/.", kind: "file" }, "trailing dot in child path"],
    // Non-canonical trailing slash.
    [{ name: "x", path: "x/", kind: "directory" }, "trailing slash in child path"],
    // Backslash.
    [{ name: "x", path: "x\\y", kind: "file" }, "backslash in child path"],
    // Control char.
    [{ name: "x", path: "x\ny", kind: "file" }, "control char in child path"],
    // Empty name.
    [{ name: "", path: "x", kind: "file" }, "empty name"],
    // Empty path.
    [{ name: "x", path: "", kind: "file" }, "empty path"],
    // Unknown kind.
    [{ name: "x", path: "x", kind: "symlink" }, "unknown kind"],
    // Non-object entry.
    ["not-an-object", "non-object entry"],
  ]) {
    it(`mid-tree unsafe child (${label}) fails the whole tree with no partial success`, async () => {
      const cap = makeFakeCapability({
        listDirectory: (req) => {
          if (req.path === "") {
            return {
              repository: "owner/repo",
              path: "",
              entries: [badEntry],
            };
          }
          return { repository: "owner/repo", path: req.path, entries: [] };
        },
      });
      await assert.rejects(
        explorerTree(cap, { repository: "owner/repo", depth: 3 }, {}, makeFakeDeps()),
        ValidationError,
      );
    });
  }

  it("mid-tree non-array entries fails the whole tree", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => ({
        repository: "owner/repo",
        path: "",
        entries: "not-an-array",
      }),
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("mid-tree non-object listing fails the whole tree", async () => {
    const cap = makeFakeCapability({
      listDirectory: () => "not-an-object",
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps()),
      ValidationError,
    );
  });

  it("a failing directory after a successful one fails the whole tree (no partial return)", async () => {
    // Root succeeds with [a/]. a/ then throws. The Explorer must
    // propagate the failure rather than returning [root] partial.
    let count = 0;
    const cap = makeFakeCapability({
      listDirectory: (req) => {
        count += 1;
        if (req.path === "") {
          return {
            repository: "owner/repo",
            path: "",
            entries: [{ name: "a", path: "a", kind: "directory" }],
          };
        }
        if (req.path === "a") {
          throw new Error("synthetic mid-BFS failure");
        }
        throw new Error(`unexpected path ${req.path}`);
      },
    });
    await assert.rejects(
      explorerTree(cap, { repository: "owner/repo", depth: 3 }, {}, makeFakeDeps()),
      /synthetic mid-BFS failure/,
    );
    // Root was requested, then a failed.
    assert.strictEqual(count, 2);
    // The Explorer never returns a partial result, so we cannot
    // assert on snapshots here — the call rejected.
  });

  it("explicit empty directory entries are valid (a fake Adapter contract)", async () => {
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: "owner/repo",
        path: req.path,
        entries: [],
      }),
    });
    const out = await explorerTree(cap, { repository: "owner/repo" }, {}, makeFakeDeps());
    assert.strictEqual(out.snapshots.length, 1);
    assert.deepStrictEqual(out.snapshots[0].entries, []);
  });
});

// ---------------------------------------------------------------------------
// `--max-chars` projection — Search total budget
// ---------------------------------------------------------------------------

describe("explorerSearch — total-budget projection over excerpts[].text", () => {
  function buildResult(excerpts) {
    const originalTextLength = excerpts.reduce((n, e) => n + e.text.length, 0);
    return {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "q",
      language: "en",
      excerpts,
      truncated: false,
      originalTextLength,
    };
  }

  for (const [label, maxChars] of [
    ["absent", undefined],
    ["zero", 0],
    ["negative", -1],
  ]) {
    it(`${label}: no truncation; original result returned`, async () => {
      const original = buildResult([{ text: "aaaa" }, { text: "bbbb" }]);
      const cap = makeFakeCapability({ search: () => clone(original) });
      const out = await explorerSearch(
        cap,
        { repository: "owner/repo", query: "q" },
        { maxChars },
        makeFakeDeps(),
      );
      assert.deepStrictEqual(out, original);
      assert.strictEqual(out.truncated, false);
    });
  }

  it("budget larger than total: no truncation", async () => {
    const original = buildResult([{ text: "aaaa" }, { text: "bbbb" }]);
    const cap = makeFakeCapability({ search: () => clone(original) });
    const out = await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      { maxChars: 1000 },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(out.excerpts, [{ text: "aaaa" }, { text: "bbbb" }]);
    assert.strictEqual(out.truncated, false);
  });

  it("budget exactly fits all excerpts: no truncation", async () => {
    const original = buildResult([{ text: "aaaa" }, { text: "bbbb" }]); // total 8
    const cap = makeFakeCapability({ search: () => clone(original) });
    const out = await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      { maxChars: 8 },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(out.excerpts, [{ text: "aaaa" }, { text: "bbbb" }]);
    assert.strictEqual(out.truncated, false);
  });

  it("budget truncates only the final retained excerpt; later excerpts omitted", async () => {
    // Total 4 + 8 + 8 = 20. Budget 10. First fits (4), second truncated.
    const original = buildResult([{ text: "aaaa" }, { text: "bbbbbbbb" }, { text: "cccccccc" }]);
    const cap = makeFakeCapability({ search: () => clone(original) });
    const out = await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      { maxChars: 10 },
      makeFakeDeps(),
    );
    // First kept whole, second truncated to remaining=6:
    //   "bbbbbbbb".slice(0, 5).trimEnd() + "…" = "bbbbb…"
    // Third omitted.
    assert.deepStrictEqual(out.excerpts, [{ text: "aaaa" }, { text: "bbbbb…" }]);
    assert.strictEqual(out.truncated, true);
    // originalTextLength reports the FULL pre-projection value
    // (4 + 8 + 8 = 20), not just the retained excerpts.
    assert.strictEqual(out.originalTextLength, 20);
  });

  it("budget = 1 truncates the first excerpt to a single ellipsis", async () => {
    const original = buildResult([{ text: "aaaa" }]);
    const cap = makeFakeCapability({ search: () => clone(original) });
    const out = await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      { maxChars: 1 },
      makeFakeDeps(),
    );
    // text.slice(0, 1-1).trimEnd() + "…" = "" + "…" = "…"
    assert.deepStrictEqual(out.excerpts, [{ text: "…" }]);
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.originalTextLength, 4);
  });

  it("budget exactly fits the first excerpt; the second is omitted (truncated=true)", async () => {
    // Total 4 + 4 = 8. Budget 4. First fits exactly; second is
    // omitted because remaining == 0.
    const original = buildResult([{ text: "aaaa" }, { text: "bbbb" }]);
    const cap = makeFakeCapability({ search: () => clone(original) });
    const out = await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      { maxChars: 4 },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(out.excerpts, [{ text: "aaaa" }]);
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.originalTextLength, 8);
  });

  it("metadata outside the budget is preserved verbatim", async () => {
    const original = {
      schemaVersion: 1,
      repository: "Owner/Repo",
      query: "Auth Flow",
      language: "zh",
      excerpts: [{ text: "abcdefgh" }],
      truncated: false,
      originalTextLength: 8,
    };
    const cap = makeFakeCapability({ search: () => clone(original) });
    const out = await explorerSearch(
      cap,
      { repository: "Owner/Repo", query: "Auth Flow", language: "zh" },
      { maxChars: 3 },
      makeFakeDeps(),
    );
    assert.strictEqual(out.repository, "Owner/Repo");
    assert.strictEqual(out.query, "Auth Flow");
    assert.strictEqual(out.language, "zh");
    assert.strictEqual(out.schemaVersion, 1);
    // original length is the FULL pre-projection value.
    assert.strictEqual(out.originalTextLength, 8);
  });

  it("does not mutate the Adapter result object", async () => {
    const original = buildResult([{ text: "aaaa" }, { text: "bbbbbbbb" }, { text: "cccccccc" }]);
    const snapshot = clone(original);
    const cap = makeFakeCapability({ search: () => original });
    await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      { maxChars: 10 },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(original, snapshot);
  });

  it("maxChars = NaN preserves the shipped !max no-limit behavior (no truncation)", async () => {
    // The shipped `truncateText` rule uses `!max || max <= 0` to
    // mean "no limit". `!NaN` is true, so NaN is treated as no
    // limit. The Explorer's projection guard must match.
    const original = buildResult([{ text: "aaaa" }, { text: "bbbbbbbb" }]);
    const cap = makeFakeCapability({ search: () => clone(original) });
    const out = await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      { maxChars: NaN },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(out, original);
    assert.strictEqual(out.truncated, false);
    assert.deepStrictEqual(
      out.excerpts.map((e) => e.text),
      ["aaaa", "bbbbbbbb"],
    );
  });

  it("maxChars = Infinity is naturally unlimited (loop fits every excerpt)", async () => {
    const original = buildResult([{ text: "aaaa" }, { text: "bbbbbbbb" }]);
    const cap = makeFakeCapability({ search: () => clone(original) });
    const out = await explorerSearch(
      cap,
      { repository: "owner/repo", query: "q" },
      { maxChars: Infinity },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(out, original);
    assert.strictEqual(out.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// `--max-chars` projection — File content budget
// ---------------------------------------------------------------------------

describe("explorerReadFile — content-budget projection", () => {
  for (const [label, maxChars] of [
    ["absent", undefined],
    ["zero", 0],
    ["negative", -1],
  ]) {
    it(`${label}: no truncation; original result returned`, async () => {
      const original = {
        schemaVersion: 1,
        repository: "owner/repo",
        path: "src/index.ts",
        content: "export const x = 1;\n",
        truncated: false,
        originalContentLength: 20,
      };
      const cap = makeFakeCapability({ readFile: () => clone(original) });
      const out = await explorerReadFile(
        cap,
        { repository: "owner/repo", path: "src/index.ts" },
        { maxChars },
        makeFakeDeps(),
      );
      assert.deepStrictEqual(out, original);
    });
  }

  it("content shorter than budget: no truncation", async () => {
    const original = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "src/index.ts",
      content: "short",
      truncated: false,
      originalContentLength: 5,
    };
    const cap = makeFakeCapability({ readFile: () => clone(original) });
    const out = await explorerReadFile(
      cap,
      { repository: "owner/repo", path: "src/index.ts" },
      { maxChars: 100 },
      makeFakeDeps(),
    );
    assert.strictEqual(out.content, "short");
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.originalContentLength, 5);
  });

  it("content exactly equal to budget: no truncation", async () => {
    const original = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "src/index.ts",
      content: "abcdef",
      truncated: false,
      originalContentLength: 6,
    };
    const cap = makeFakeCapability({ readFile: () => clone(original) });
    const out = await explorerReadFile(
      cap,
      { repository: "owner/repo", path: "src/index.ts" },
      { maxChars: 6 },
      makeFakeDeps(),
    );
    assert.strictEqual(out.content, "abcdef");
    assert.strictEqual(out.truncated, false);
  });

  it("content longer than budget: existing ellipsis rule", async () => {
    const original = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "src/index.ts",
      content: "abcdefghij",
      truncated: false,
      originalContentLength: 10,
    };
    const cap = makeFakeCapability({ readFile: () => clone(original) });
    const out = await explorerReadFile(
      cap,
      { repository: "owner/repo", path: "src/index.ts" },
      { maxChars: 5 },
      makeFakeDeps(),
    );
    // content.slice(0, 5-1).trimEnd() + "…" = "abcd…"
    assert.strictEqual(out.content, "abcd…");
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.originalContentLength, 10);
  });

  it("budget = 1 yields a single ellipsis", async () => {
    const original = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "src/index.ts",
      content: "abcdefghij",
      truncated: false,
      originalContentLength: 10,
    };
    const cap = makeFakeCapability({ readFile: () => clone(original) });
    const out = await explorerReadFile(
      cap,
      { repository: "owner/repo", path: "src/index.ts" },
      { maxChars: 1 },
      makeFakeDeps(),
    );
    assert.strictEqual(out.content, "…");
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.originalContentLength, 10);
  });

  it("does not mutate the Adapter result object", async () => {
    const original = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "src/index.ts",
      content: "abcdefghij",
      truncated: false,
      originalContentLength: 10,
    };
    const snapshot = clone(original);
    const cap = makeFakeCapability({ readFile: () => original });
    await explorerReadFile(
      cap,
      { repository: "owner/repo", path: "src/index.ts" },
      { maxChars: 5 },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(original, snapshot);
  });

  it("maxChars = NaN preserves the shipped !max no-limit behavior (no truncation)", async () => {
    const original = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "src/index.ts",
      content: "abcdefghij",
      truncated: false,
      originalContentLength: 10,
    };
    const cap = makeFakeCapability({ readFile: () => clone(original) });
    const out = await explorerReadFile(
      cap,
      { repository: "owner/repo", path: "src/index.ts" },
      { maxChars: NaN },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(out, original);
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.content, "abcdefghij");
  });

  it("maxChars = Infinity is naturally unlimited", async () => {
    const original = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "src/index.ts",
      content: "abcdefghij",
      truncated: false,
      originalContentLength: 10,
    };
    const cap = makeFakeCapability({ readFile: () => clone(original) });
    const out = await explorerReadFile(
      cap,
      { repository: "owner/repo", path: "src/index.ts" },
      { maxChars: Infinity },
      makeFakeDeps(),
    );
    assert.deepStrictEqual(out, original);
    assert.strictEqual(out.truncated, false);
  });
});

// ---------------------------------------------------------------------------
// explorerTree is never character-limited
// ---------------------------------------------------------------------------

describe("explorerTree — never character-limited", () => {
  it("smuggling { maxChars: 1 } at runtime has no effect: long names and paths are preserved verbatim", async () => {
    // Tree options type intentionally omits maxChars. A caller could
    // still smuggle one in at runtime (TS does not enforce at runtime).
    // The Explorer never reads maxChars for Tree, so a tiny smuggled
    // budget must NOT truncate entry names, entry paths, or any other
    // Tree field. The long strings below would survive only if the
    // projection never runs.
    const longName = "x".repeat(500);
    const longPath = longName; // root listing: path === name
    const cap = makeFakeCapability({
      listDirectory: (req) => ({
        repository: req.repository,
        path: req.path,
        entries: [{ name: longName, path: longPath, kind: "file" }],
      }),
    });
    const out = await explorerTree(
      cap,
      { repository: "owner/repo" },
      /** @type {any} */ ({ maxChars: 1 }),
      makeFakeDeps(),
    );
    assert.strictEqual(out.snapshots.length, 1);
    assert.strictEqual(out.snapshots[0].entries.length, 1);
    assert.strictEqual(out.snapshots[0].entries[0].name, longName);
    assert.strictEqual(out.snapshots[0].entries[0].path, longPath);
    // And the top-level envelope is unchanged.
    assert.strictEqual(out.path, "");
    assert.strictEqual(out.depth, 1);
  });
});

// ---------------------------------------------------------------------------
// Source-boundary assertion: the Explorer imports no Provider-specific
// symbols. This is a static source scan, complementing the existing
// tests/provider-boundary.test.js seam.
// ---------------------------------------------------------------------------

describe("Repository Explorer source boundary (NFR-004, ARCHITECTURE.md §2)", () => {
  /**
   * The Explorer may import ONLY:
   *   - the provider-neutral Repository Capability contract,
   *   - shared execution (`executeRepositoryOperation` and types),
   *   - the normalized `ValidationError`.
   * Anything else — a concrete Provider Adapter, an MCP/UTCP client,
   * a raw tool name, or a Provider response type — is a seam
   * violation.
   */
  const ALLOWED_IMPORT_SPECIFIERS = new Set([
    "../capabilities/repository.js",
    "../lib/execution.js",
    "../lib/errors.js",
  ]);

  const FORBIDDEN_IMPORT_SUBSTRINGS = [
    "../providers/",
    "../lib/mcp-client.js",
    "../lib/mcp-config.js",
    "mmx-cli",
    "@utcp/",
  ];

  const FORBIDDEN_SYMBOL_REFERENCES = [
    "ZaiMcpClient",
    "ZReadMcpClient",
    "ZaiAdapterClientPort",
    "createZaiRepositoryCapability",
    "createMiniMaxDescriptor",
    "createZaiDescriptor",
    "getMcpToolName",
    "search_doc",
    "read_file",
    "get_repo_structure",
  ];

  function extractImports(source) {
    const results = [];
    const importRegex = /import\s+(?:[\s\S]*?from\s+)?["']([^"']+)["'];?/g;
    for (const match of source.matchAll(importRegex)) {
      const specifier = match[1];
      if (specifier) results.push(specifier);
    }
    return results;
  }

  it("Explorer source file exists", async () => {
    const stat = await fs.stat(EXPLORER_SOURCE_ABS);
    assert.ok(stat.isFile(), `${EXPLORER_SOURCE_REL} must exist`);
  });

  it("every static import is on the allow-list", async () => {
    const source = await fs.readFile(EXPLORER_SOURCE_ABS, "utf8");
    const imports = extractImports(source);
    assert.deepStrictEqual(
      imports,
      [...ALLOWED_IMPORT_SPECIFIERS],
      "Explorer must import only the provider-neutral Repository Capability contract, shared execution, and ValidationError",
    );
  });

  it("Explorer source contains no forbidden import substring", async () => {
    const source = await fs.readFile(EXPLORER_SOURCE_ABS, "utf8");
    const imports = extractImports(source);
    const violations = imports.filter((spec) =>
      FORBIDDEN_IMPORT_SUBSTRINGS.some((bad) => spec.includes(bad)),
    );
    assert.deepStrictEqual(
      violations,
      [],
      `${EXPLORER_SOURCE_REL} imports forbidden Provider/transport modules: ${violations.join(", ")}`,
    );
  });

  it("Explorer source references no Provider-only symbol or raw tool name", async () => {
    const source = await fs.readFile(EXPLORER_SOURCE_ABS, "utf8");
    const hits = FORBIDDEN_SYMBOL_REFERENCES.filter((sym) =>
      new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(source),
    );
    assert.deepStrictEqual(
      hits,
      [],
      `${EXPLORER_SOURCE_REL} references Provider-only symbols: ${hits.join(", ")}`,
    );
  });
});
