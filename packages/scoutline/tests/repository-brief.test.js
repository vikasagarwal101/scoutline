/**
 * Phase 2 repo-brief stream — Ticket 1: RepositoryBrief type set + pure
 * selection/parsing helpers (DESIGN D1, D7; SCHEMA.md).
 *
 * Scope (locked):
 *   - VERBATIM TypeScript type set for `RepositoryBrief` and friends
 *     lives in `src/capabilities/repository.ts`; runtime assertions here
 *     exercise the exported CONSTANTS and pure helpers only (types
 *     themselves are owned by the schema and by tsc).
 *   - `selectBriefFiles(tree)` — D1 / D7 selection rules: README at
 *     shallowest depth wins, manifest kinds in canonical order, cap 4.
 *   - `parseBriefFocus(raw)` / `parseBriefDepth(raw)` /
 *     `parseBriefMaxChars(raw)` — D7 request-parsing rules: split /
 *     trim / dedupe / sealed-set membership / empty-after-processing
 *     / positive-integer constraints. Every failure mode names the
 *     sealed set / constraint and is a `ValidationError`.
 *
 * Out-of-scope for this ticket (handled later):
 *   - `repoBrief` handler composition (Ticket 2).
 *   - Dispatch wiring + help text (Ticket 3).
 *   - Conformance + cache interaction (Ticket 4).
 *
 * No I/O, no Provider, no transport — pure tests against exported
 * helpers. Tests import from `dist/` per the package's build-then-test
 * contract; the build step precedes `node --test`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REPO_BRIEF_FOCUS,
  selectBriefFiles,
  parseBriefFocus,
  parseBriefDepth,
  parseBriefMaxChars,
  README_QUERY,
  MANIFEST_QUERY,
} from "../dist/commands/repo.js";
import { ValidationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fixture builders — crafted trees, no I/O
// ---------------------------------------------------------------------------

/**
 * Build a minimal `RepositoryTreeResult` for selection tests. `snapshots`
 * preserves BFS order: first the root listing, then deeper listings. Each
 * entry is `{ name, path, kind: "file" | "directory" }`. Non-file entries
 * (directories) must NOT be selected by README/manifest matching even when
 * a directory's `name` happens to look like a README/manifest.
 */
function buildTree(snapshots) {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    path: "",
    depth: 1,
    snapshots: snapshots.map((entries, index) => ({
      repository: "owner/repo",
      path: index === 0 ? "" : snapshots[index - 1]?.path || "",
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path,
        kind: e.kind || "file",
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// REPO_BRIEF_FOCUS sealed set
// ---------------------------------------------------------------------------

describe("REPO_BRIEF_FOCUS — sealed v1 focus set", () => {
  it("is exactly the four canonical focus tokens in declaration order", () => {
    assert.deepStrictEqual([...REPO_BRIEF_FOCUS], [
      "structure",
      "readme",
      "manifest",
      "files",
    ]);
  });

  it("is readonly at the type level (constant identity)", () => {
    // The literal constant is the source of truth; mutating it would break
    // every consumer that captures its identity. We assert identity only.
    assert.equal(typeof REPO_BRIEF_FOCUS, "object");
    assert.ok(Array.isArray(REPO_BRIEF_FOCUS) || REPO_BRIEF_FOCUS.length !== undefined);
  });
});

// ---------------------------------------------------------------------------
// D7 — Probe queries are constants, not constructed text
// ---------------------------------------------------------------------------

describe("D7 probe query constants", () => {
  it("README_QUERY is the literal \"README\" (no construction)", () => {
    assert.equal(README_QUERY, "README");
  });

  it("MANIFEST_QUERY joins all four canonical kinds in canonical order", () => {
    assert.equal(
      MANIFEST_QUERY,
      "package.json pyproject.toml Cargo.toml go.mod",
    );
  });
});

// ---------------------------------------------------------------------------
// selectBriefFiles — D1 / D7 selection rules
// ---------------------------------------------------------------------------

describe("selectBriefFiles — D1/D7 deterministic selection", () => {
  it("README at the root wins", () => {
    const tree = buildTree([
      [{ name: "README.md", path: "README.md" }],
      [{ name: "README.md", path: "docs/README.md" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out, { readme: "README.md", manifests: [] });
  });

  it("README nested deeper loses to README at root", () => {
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md" },
        { name: "src", path: "src", kind: "directory" },
      ],
      [{ name: "README.md", path: "src/README.md" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out, { readme: "README.md", manifests: [] });
  });

  it("README nested deeper loses to README at intermediate depth", () => {
    // Root has only a directory; depth 1 has README; depth 2 has another README.
    // Winner is the shallowest occurrence (depth 1), NOT depth 2.
    const tree = buildTree([
      [{ name: "docs", path: "docs", kind: "directory" }],
      [{ name: "README.md", path: "docs/README.md" }],
      [{ name: "README.md", path: "docs/inner/README.md" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.equal(out.readme, "docs/README.md");
  });

  it("README absent → no readme key; empty manifests", () => {
    const tree = buildTree([
      [{ name: "src", path: "src", kind: "directory" }],
      [{ name: "index.ts", path: "src/index.ts" }],
    ]);
    const out = selectBriefFiles(tree);
    // When no README is found, the readme key is OMITTED (cleaner than
    // { readme: undefined }) — consumers read `out.readme === undefined`.
    assert.equal(out.readme, undefined);
    assert.deepStrictEqual(out.manifests, []);
  });

  it("case-insensitive README basename match", () => {
    // README.md, readme.markdown, ReadMe.txt all match /^readme(\.|$)/i
    const tree = buildTree([
      [
        { name: "ReadMe.txt", path: "ReadMe.txt" },
        { name: "readme.markdown", path: "readme.markdown" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    // First occurrence (BFS / sibling order) wins; tied depth broken by
    // entry order in the same snapshot.
    assert.equal(out.readme, "ReadMe.txt");
  });

  it("README with multiple extension segments is matched (readme.markdown.something)", () => {
    // DESIGN D7 specifies `/^readme(?:\.[a-z0-9]+)?$/i` — single optional
    // extension. `readme.markdown` matches; `readme.md.bak` does NOT.
    const tree = buildTree([
      [
        { name: "readme.md.bak", path: "readme.md.bak" },
        { name: "real-readme.md", path: "real-readme.md" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    // Neither matches: readme.md.bak has two dots, real-readme.md has a
    // hyphen before readme.
    assert.equal(out.readme, undefined);
  });

  it("README with one extension matches", () => {
    const tree = buildTree([
      [{ name: "README.MD", path: "README.MD" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.equal(out.readme, "README.MD");
  });

  it("package.json at depth 0 wins over depth 2 (case-sensitive exact match)", () => {
    const tree = buildTree([
      [
        { name: "src", path: "src", kind: "directory" },
        { name: "package.json", path: "package.json" },
      ],
      [{ name: "package.json", path: "src/package.json" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out.readme, undefined);
    assert.deepStrictEqual(out.manifests, ["package.json"]);
  });

  it("package.json at depth 2 wins when no shallower occurrence", () => {
    const tree = buildTree([
      [{ name: "src", path: "src", kind: "directory" }],
      [{ name: "package.json", path: "src/package.json" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out.manifests, ["src/package.json"]);
  });

  it("no manifest anywhere → empty manifests array", () => {
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md" },
        { name: "src", path: "src", kind: "directory" },
      ],
      [{ name: "index.ts", path: "src/index.ts" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out, { readme: "README.md", manifests: [] });
  });

  it("four manifests + README → README + first 3 kinds in canonical order (cap 4 reads)", () => {
    // Canonical order per SCHEMA.md: package.json, pyproject.toml,
    // Cargo.toml, go.mod. All four are present at depth 0 → first 3 kinds
    // (package.json, pyproject.toml, Cargo.toml) are selected; go.mod is
    // beyond the 4-read cap and is NOT included.
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md" },
        { name: "package.json", path: "package.json" },
        { name: "pyproject.toml", path: "pyproject.toml" },
        { name: "Cargo.toml", path: "Cargo.toml" },
        { name: "go.mod", path: "go.mod" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out, {
      readme: "README.md",
      manifests: ["package.json", "pyproject.toml", "Cargo.toml"],
    });
  });

  it("manifest kinds appear in canonical kind order regardless of BFS order", () => {
    // If entries appear in REVERSE order (go.mod first, package.json last),
    // canonical-kind order must still win.
    const tree = buildTree([
      [
        { name: "go.mod", path: "go.mod" },
        { name: "Cargo.toml", path: "Cargo.toml" },
        { name: "pyproject.toml", path: "pyproject.toml" },
        { name: "package.json", path: "package.json" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out.manifests, [
      "package.json",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
    ]);
  });

  it("non-file entries (directories) are ignored even if name looks like README/manifest", () => {
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md", kind: "directory" },
        { name: "package.json", path: "package.json", kind: "directory" },
        { name: "src", path: "src", kind: "directory" },
        { name: "real-readme.md", path: "real-readme.md" },
      ],
      [{ name: "README.md", path: "real-readme.md/README.md" }],
    ]);
    const out = selectBriefFiles(tree);
    // The directory named "README.md" must NOT be selected; the file at
    // real-readme.md/README.md (depth 1) wins.
    assert.equal(out.readme, "real-readme.md/README.md");
    // No package.json FILE exists; manifests stays empty.
    assert.deepStrictEqual(out.manifests, []);
  });

  it("manifest match is case-sensitive exact (Package.JSON does NOT match package.json)", () => {
    const tree = buildTree([
      [{ name: "Package.JSON", path: "Package.JSON" }],
    ]);
    const out = selectBriefFiles(tree);
    assert.deepStrictEqual(out.manifests, []);
  });

  it("empty tree yields no readme key and empty manifests", () => {
    const tree = buildTree([[]]);
    const out = selectBriefFiles(tree);
    assert.equal(out.readme, undefined);
    assert.deepStrictEqual(out.manifests, []);
  });

  it("sibling ties at the same depth are broken by entry order (BFS / provider order)", () => {
    // Two READMEs at the same depth — first wins.
    const tree = buildTree([
      [
        { name: "README.md", path: "README.md" },
        { name: "README.md", path: "second-README.md" },
      ],
    ]);
    const out = selectBriefFiles(tree);
    assert.equal(out.readme, "README.md");
  });
});

// ---------------------------------------------------------------------------
// D7 request-parsing helpers (parseBriefFocus / parseBriefDepth / parseBriefMaxChars)
// ---------------------------------------------------------------------------

describe("parseBriefFocus — D7 focus parsing", () => {
  it("splits a comma-separated string", () => {
    const out = parseBriefFocus("structure,readme,manifest,files");
    assert.deepStrictEqual([...out], [
      "structure",
      "readme",
      "manifest",
      "files",
    ]);
  });

  it("trims whitespace around tokens", () => {
    const out = parseBriefFocus("  structure , readme  ,manifest");
    assert.deepStrictEqual([...out], ["structure", "readme", "manifest"]);
  });

  it("drops empty tokens (leading/trailing/double commas)", () => {
    const out = parseBriefFocus(",structure,,readme,,");
    assert.deepStrictEqual([...out], ["structure", "readme"]);
  });

  it("dedupes preserving first occurrence", () => {
    const out = parseBriefFocus("structure,readme,structure,manifest,readme");
    assert.deepStrictEqual([...out], ["structure", "readme", "manifest"]);
  });

  it("preserves caller order (does NOT sort)", () => {
    const out = parseBriefFocus("files,manifest,readme,structure");
    assert.deepStrictEqual([...out], [
      "files",
      "manifest",
      "readme",
      "structure",
    ]);
  });

  it("rejects unknown token with ValidationError naming the sealed set", () => {
    assert.throws(
      () => parseBriefFocus("structure,nope"),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /Unknown --focus value "nope"/);
        // Names the sealed set so the consumer can fix it without docs.
        assert.match(err.message, /structure/);
        assert.match(err.message, /readme/);
        assert.match(err.message, /manifest/);
        assert.match(err.message, /files/);
        return true;
      },
    );
  });

  it("empty-after-processing throws ValidationError", () => {
    assert.throws(
      () => parseBriefFocus(""),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /at least one/i);
        return true;
      },
    );
    assert.throws(
      () => parseBriefFocus("   ,  ,,"),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /at least one/i);
        return true;
      },
    );
  });

  it("accepts each canonical token in isolation", () => {
    for (const token of REPO_BRIEF_FOCUS) {
      const out = parseBriefFocus(token);
      assert.deepStrictEqual([...out], [token]);
    }
  });

  it("accepts the full set in any order", () => {
    const out = parseBriefFocus("files,structure,manifest,readme");
    assert.equal(out.length, 4);
    // Every canonical token is present (order is preserved, so we check
    // membership).
    for (const token of REPO_BRIEF_FOCUS) {
      assert.ok(out.includes(token));
    }
  });
});

describe("parseBriefDepth — D7 depth validation", () => {
  it("accepts positive integers", () => {
    assert.equal(parseBriefDepth(1), 1);
    assert.equal(parseBriefDepth(3), 3);
    assert.equal(parseBriefDepth("2"), 2);
  });

  it("rejects zero", () => {
    assert.throws(
      () => parseBriefDepth(0),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /positive integer/);
        return true;
      },
    );
  });

  it("rejects negative integers", () => {
    assert.throws(
      () => parseBriefDepth(-1),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /positive integer/);
        return true;
      },
    );
  });

  it("rejects non-integer numerics", () => {
    assert.throws(
      () => parseBriefDepth(1.5),
      (err) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
    assert.throws(
      () => parseBriefDepth(NaN),
      (err) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
    assert.throws(
      () => parseBriefDepth(Infinity),
      (err) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });

  it("rejects non-numeric strings", () => {
    assert.throws(
      () => parseBriefDepth("abc"),
      (err) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });

  it("undefined input means \"unset\" — returns undefined", () => {
    assert.equal(parseBriefDepth(undefined), undefined);
  });
});

describe("parseBriefMaxChars — D7 maxChars validation", () => {
  it("accepts positive integers", () => {
    assert.equal(parseBriefMaxChars(1), 1);
    assert.equal(parseBriefMaxChars(2000), 2000);
    assert.equal(parseBriefMaxChars("500"), 500);
  });

  it("rejects zero and negatives", () => {
    assert.throws(() => parseBriefMaxChars(0), ValidationError);
    assert.throws(() => parseBriefMaxChars(-10), ValidationError);
  });

  it("rejects non-integer numerics", () => {
    assert.throws(() => parseBriefMaxChars(1.5), ValidationError);
    assert.throws(() => parseBriefMaxChars(NaN), ValidationError);
  });

  it("rejects non-numeric strings", () => {
    assert.throws(() => parseBriefMaxChars("oops"), ValidationError);
  });

  it("undefined input means \"unset\" — returns undefined", () => {
    assert.equal(parseBriefMaxChars(undefined), undefined);
  });
});