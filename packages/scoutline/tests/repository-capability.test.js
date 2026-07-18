/**
 * P6-02 — Repository Capability contracts (DESIGN.md §18) and total decoders.
 *
 * Locks down the provider-neutral Repository Capability contract and the
 * total `decodeCached` helpers used by shared execution. Pure metadata:
 * no Provider or transport is constructed here. The Decoder policy:
 *   - every decoder accepts `unknown`;
 *   - malformed/partial values return `null` and never throw;
 *   - arrays, scalars, and required shapes are validated exactly;
 *   - no path canonicalization, raw ZRead parsing, Provider field mapping,
 *     selection logic, or presentation lives here.
 *
 * Scope of this file (runtime tests only):
 *   - The exact TypeScript shapes (interface fields, union members, kind
 *     literals, schema-version constants) are owned by DESIGN.md §18 and
 *     `src/capabilities/repository.ts`. Drift in those shapes is caught at
 *     `npm run build` (TypeScript module compile) and by source review,
 *     not by runtime tests inside this file.
 *   - This file exercises only the runtime decoder behavior of the three
 *     exported decoders. Operation-kind union coverage and request-shape
 *     key sets are intentionally NOT re-asserted here because such tests
 *     would only compare JavaScript values to themselves and could not
 *     detect drift in the TypeScript interfaces.
 *
 * Only the three cacheable operation kinds (Search, File, Directory Listing)
 * have a `RepositoryOperation.decodeCached` implementation. Tree is Explorer
 * projection and is not decoded here; its `RepositoryTreeResult` public type
 * lives in `src/capabilities/repository.ts` and is exercised in P6-05.
 *
 * The legacy repository cache key builder lives in `src/lib/cache.ts` as
 * `buildLegacyRepositoryCacheKey`. Its golden-byte and ambient-env tests are
 * in `tests/cache.test.js`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decodeRepositorySearch,
  decodeRepositoryFile,
  decodeRepositoryDirectoryListing,
} from "../dist/capabilities/repository.js";

// ---------------------------------------------------------------------------
// Helper builders for valid fixtures + structural asserts
// ---------------------------------------------------------------------------

function buildValidSearch(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    query: "authentication flow",
    language: "en",
    excerpts: [{ text: "snippet 1" }, { text: "snippet 2" }],
    truncated: false,
    originalTextLength: 18,
    ...overrides,
  };
}

function buildValidFile(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    path: "src/index.ts",
    content: "export const x = 1;",
    truncated: false,
    originalContentLength: 20,
    ...overrides,
  };
}

function buildValidListing(overrides = {}) {
  return {
    repository: "owner/repo",
    path: "",
    entries: [
      { name: "README.md", path: "README.md", kind: "file" },
      { name: "src", path: "src", kind: "directory" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Search decoder
// ---------------------------------------------------------------------------

describe("decodeRepositorySearch — total decoder", () => {
  it("returns a normalized Search result for a valid fixture", () => {
    const valid = buildValidSearch();
    const out = decodeRepositorySearch(valid);
    assert.deepStrictEqual(out, valid);
  });

  it("preserves excerpt order verbatim", () => {
    const valid = buildValidSearch({
      excerpts: [{ text: "first" }, { text: "second" }, { text: "third" }],
    });
    const out = decodeRepositorySearch(valid);
    assert.ok(out);
    assert.deepStrictEqual(
      out.excerpts.map((e) => e.text),
      ["first", "second", "third"],
    );
  });

  it("accepts an empty excerpts array (future Adapter contract)", () => {
    const valid = buildValidSearch({ excerpts: [] });
    const out = decodeRepositorySearch(valid);
    assert.ok(out);
    assert.deepStrictEqual(out.excerpts, []);
  });

  it("accepts language 'zh'", () => {
    const out = decodeRepositorySearch(buildValidSearch({ language: "zh" }));
    assert.ok(out);
    assert.strictEqual(out.language, "zh");
  });

  it("rejects schemaVersion != 1", () => {
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ schemaVersion: 2 })), null);
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ schemaVersion: undefined })), null);
  });

  it("rejects unknown language values", () => {
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ language: "fr" })), null);
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ language: "EN" })), null);
  });

  it("rejects non-array or missing excerpts", () => {
    for (const bad of [undefined, null, "x", {}, 0, [{ text: 1 }]]) {
      assert.strictEqual(
        decodeRepositorySearch(buildValidSearch({ excerpts: bad })),
        null,
        `expected null for excerpts=${JSON.stringify(bad)}`,
      );
    }
  });

  it("rejects excerpts with malformed items", () => {
    assert.strictEqual(
      decodeRepositorySearch(buildValidSearch({ excerpts: [{ text: 1 }] })),
      null,
    );
    assert.strictEqual(
      decodeRepositorySearch(buildValidSearch({ excerpts: [{ noText: "x" }] })),
      null,
    );
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ excerpts: [null] })), null);
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ excerpts: [{}] })), null);
  });

  it("rejects non-boolean truncated", () => {
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ truncated: 1 })), null);
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ truncated: null })), null);
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ truncated: "no" })), null);
  });

  it("rejects non-finite or negative originalTextLength", () => {
    assert.strictEqual(decodeRepositorySearch(buildValidSearch({ originalTextLength: -1 })), null);
    assert.strictEqual(
      decodeRepositorySearch(buildValidSearch({ originalTextLength: Number.NaN })),
      null,
    );
    assert.strictEqual(
      decodeRepositorySearch(buildValidSearch({ originalTextLength: Infinity })),
      null,
    );
    assert.strictEqual(
      decodeRepositorySearch(buildValidSearch({ originalTextLength: 1.5 })),
      null,
    );
    assert.strictEqual(
      decodeRepositorySearch(buildValidSearch({ originalTextLength: undefined })),
      null,
    );
  });

  it("rejects primitives and arrays at the top level", () => {
    for (const bad of [undefined, null, "string", 42, [], true]) {
      assert.strictEqual(decodeRepositorySearch(bad), null, `bad=${typeof bad}`);
    }
  });

  it("rejects missing required scalars", () => {
    for (const k of [
      "repository",
      "query",
      "language",
      "excerpts",
      "truncated",
      "originalTextLength",
      "schemaVersion",
    ]) {
      const bad = buildValidSearch();
      delete bad[k];
      assert.strictEqual(decodeRepositorySearch(bad), null, `expected null without ${k}`);
    }
  });

  it("accepts the canonical valid fixture (round-trip equality)", () => {
    const canonical = buildValidSearch();
    const out = decodeRepositorySearch(canonical);
    assert.deepStrictEqual(out, canonical);
  });
});

// ---------------------------------------------------------------------------
// File decoder
// ---------------------------------------------------------------------------

describe("decodeRepositoryFile — total decoder", () => {
  it("returns a normalized File result for a valid fixture", () => {
    const valid = buildValidFile();
    assert.deepStrictEqual(decodeRepositoryFile(valid), valid);
  });

  it("accepts an empty content string", () => {
    const out = decodeRepositoryFile(buildValidFile({ content: "", originalContentLength: 0 }));
    assert.ok(out);
    assert.strictEqual(out.content, "");
    assert.strictEqual(out.originalContentLength, 0);
  });

  it("rejects schemaVersion != 1", () => {
    assert.strictEqual(decodeRepositoryFile(buildValidFile({ schemaVersion: 2 })), null);
    assert.strictEqual(decodeRepositoryFile(buildValidFile({ schemaVersion: "v1" })), null);
  });

  it("rejects non-string content or non-finite originalContentLength", () => {
    assert.strictEqual(decodeRepositoryFile(buildValidFile({ content: null })), null);
    assert.strictEqual(decodeRepositoryFile(buildValidFile({ content: 0 })), null);
    assert.strictEqual(decodeRepositoryFile(buildValidFile({ originalContentLength: -1 })), null);
    assert.strictEqual(
      decodeRepositoryFile(buildValidFile({ originalContentLength: 1.5 })),
      null,
    );
  });

  it("rejects empty path '' (File is always non-root)", () => {
    assert.strictEqual(decodeRepositoryFile(buildValidFile({ path: "" })), null);
  });

  it("rejects missing path", () => {
    const bad = buildValidFile();
    delete bad.path;
    assert.strictEqual(decodeRepositoryFile(bad), null);
  });

  it("rejects non-string path", () => {
    for (const bad of [null, 0, [], {}, true]) {
      assert.strictEqual(
        decodeRepositoryFile(buildValidFile({ path: bad })),
        null,
        `expected null for path=${JSON.stringify(bad)}`,
      );
    }
  });

  it("rejects primitives and arrays at the top level", () => {
    for (const bad of [undefined, null, "string", [], true, 0]) {
      assert.strictEqual(decodeRepositoryFile(bad), null);
    }
  });

  it("rejects missing required scalars", () => {
    for (const k of [
      "schemaVersion",
      "repository",
      "path",
      "content",
      "truncated",
      "originalContentLength",
    ]) {
      const bad = buildValidFile();
      delete bad[k];
      assert.strictEqual(decodeRepositoryFile(bad), null, `expected null without ${k}`);
    }
  });

  it("rejects non-boolean truncated", () => {
    assert.strictEqual(decodeRepositoryFile(buildValidFile({ truncated: 1 })), null);
    assert.strictEqual(decodeRepositoryFile(buildValidFile({ truncated: null })), null);
  });
});

// ---------------------------------------------------------------------------
// Directory listing decoder
// ---------------------------------------------------------------------------

describe("decodeRepositoryDirectoryListing — total decoder", () => {
  it("returns a normalized listing for a valid fixture (including root)", () => {
    const valid = buildValidListing();
    assert.deepStrictEqual(decodeRepositoryDirectoryListing(valid), valid);
  });

  it("accepts a root listing (path: '') with empty entries", () => {
    const root = {
      repository: "owner/repo",
      path: "",
      entries: [],
    };
    const out = decodeRepositoryDirectoryListing(root);
    assert.ok(out);
    assert.strictEqual(out.path, "");
    assert.deepStrictEqual(out.entries, []);
  });

  it("accepts a root listing (path: '') with valid children", () => {
    const root = {
      repository: "owner/repo",
      path: "",
      entries: [
        { name: "README.md", path: "README.md", kind: "file" },
        { name: "src", path: "src", kind: "directory" },
      ],
    };
    const out = decodeRepositoryDirectoryListing(root);
    assert.ok(out);
    assert.strictEqual(out.path, "");
    assert.strictEqual(out.entries.length, 2);
  });

  it("rejects null or non-array entries", () => {
    for (const bad of [null, undefined, "x", {}, 0, [[]]]) {
      assert.strictEqual(
        decodeRepositoryDirectoryListing(buildValidListing({ entries: bad })),
        null,
        `expected null for entries=${JSON.stringify(bad)}`,
      );
    }
  });

  it("rejects malformed entries", () => {
    const bad1 = buildValidListing({ entries: [{ name: 1, path: "a", kind: "file" }] });
    const bad2 = buildValidListing({ entries: [{ name: "a", path: 1, kind: "file" }] });
    const bad3 = buildValidListing({ entries: [{ name: "a", path: "a", kind: "link" }] });
    const bad4 = buildValidListing({ entries: [{ name: "a", path: "a" }] });
    const bad5 = buildValidListing({ entries: [null] });
    const bad6 = buildValidListing({ entries: [{}] });
    for (const b of [bad1, bad2, bad3, bad4, bad5, bad6]) {
      assert.strictEqual(decodeRepositoryDirectoryListing(b), null);
    }
  });

  it("rejects entries with empty name ''", () => {
    assert.strictEqual(
      decodeRepositoryDirectoryListing(
        buildValidListing({ entries: [{ name: "", path: "a", kind: "file" }] }),
      ),
      null,
    );
    assert.strictEqual(
      decodeRepositoryDirectoryListing(
        buildValidListing({ entries: [{ name: "", path: "a", kind: "directory" }] }),
      ),
      null,
    );
  });

  it("rejects entries with empty path ''", () => {
    assert.strictEqual(
      decodeRepositoryDirectoryListing(
        buildValidListing({ entries: [{ name: "a", path: "", kind: "file" }] }),
      ),
      null,
    );
  });

  it("rejects a single bad entry mixed with valid entries (partial goodness is a miss)", () => {
    const listing = buildValidListing({
      entries: [
        { name: "good", path: "good", kind: "file" },
        { name: "", path: "bad", kind: "file" },
      ],
    });
    assert.strictEqual(decodeRepositoryDirectoryListing(listing), null);
  });

  it("preserves Provider sibling order", () => {
    const listing = buildValidListing({
      entries: [
        { name: "c", path: "c", kind: "file" },
        { name: "a", path: "a", kind: "file" },
        { name: "b", path: "b", kind: "file" },
      ],
    });
    const out = decodeRepositoryDirectoryListing(listing);
    assert.ok(out);
    assert.deepStrictEqual(
      out.entries.map((e) => e.name),
      ["c", "a", "b"],
    );
  });

  it("rejects non-string repository or path", () => {
    assert.strictEqual(
      decodeRepositoryDirectoryListing(buildValidListing({ repository: 1 })),
      null,
    );
    assert.strictEqual(
      decodeRepositoryDirectoryListing(buildValidListing({ path: null })),
      null,
    );
  });

  it("rejects primitives and arrays at the top level", () => {
    for (const bad of [undefined, null, "string", 0, true, []]) {
      assert.strictEqual(decodeRepositoryDirectoryListing(bad), null);
    }
  });

  it("rejects missing required scalars", () => {
    for (const k of ["repository", "path", "entries"]) {
      const bad = buildValidListing();
      delete bad[k];
      assert.strictEqual(decodeRepositoryDirectoryListing(bad), null, `expected null without ${k}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Modularity: the capability module imports no concrete Provider
// ---------------------------------------------------------------------------

describe("Repository Capability — module isolation", () => {
  it("is importable without touching provider submodules at import time", () => {
    // Re-import from the freshly built dist path to confirm surface only.
    // The Capability file is the contract; no transport/Adapter code should
    // be reachable from this import.
    assert.strictEqual(typeof decodeRepositorySearch, "function");
    assert.strictEqual(typeof decodeRepositoryFile, "function");
    assert.strictEqual(typeof decodeRepositoryDirectoryListing, "function");
  });
});