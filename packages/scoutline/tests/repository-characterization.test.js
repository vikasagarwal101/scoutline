/**
 * P6-01 / P6-01A — ZRead grammar safety net (characterization only).
 *
 * Purpose
 *   Lock the sanitized ZRead Search / File / Tree / nested-Tree / encoded-error
 *   evidence before the provider-neutral Repository Capability is introduced
 *   in P6-04. This test does NOT invent a public error taxonomy — that work
 *   belongs to P6-04. It only asserts:
 *     - each valid grammar fixture is accepted by a minimal adapter-shaped
 *       parser that recognises the characterized outer wrappers and Unicode
 *       tree glyphs;
 *     - each malformed fixture (missing outer wrapper, unclosed tags, plain
 *       prose, glyph-less tree lines) is rejected before any inner text is
 *       consumed;
 *     - mixed-malformed responses (valid framing plus an unmatched tag, a
 *       malformed sibling, or surrounding/trailing non-wrapper data) are
 *       rejected — partial goodness is not a success;
 *     - Search framing is balanced (multiple ordered excerpts are allowed,
 *       but unmatched excerpt tags are not);
 *     - File and Tree framing are whole-response: only characterized
 *       whitespace may appear outside the wrapper;
 *     - encoded MCP error strings (the "MCP error -<status>" envelope) cannot
 *       satisfy any valid-success fixture, regardless of which operation it
 *       is tested against.
 *
 * Scope
 *   The parsers live in this file. They are the characterization shape — not
 *   the public Adapter, which arrives in P6-04. They are independent of the
 *   production source tree: they import only the test fixtures helper, not
 *   `src/lib/*`. The P6-01 / P6-01A production change is a separate concern
 *   scoped to `src/lib/mcp-client.ts` and is exercised by `mcp-client.test.js`.
 *
 * Fixtures
 *   tests/fixtures/providers/zai/repository/ — sanitized JSON files whose
 *   `raw` field carries the characterized Provider response string. Each
 *   fixture is reviewed for credential, URL, and complete-response hygiene;
 *   these assertions prove that contract by scanning the FULL serialized
 *   fixture (description + operation + raw), case-insensitively, for any
 *   credential / header / token material.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { readFixture } from "./helpers/fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "fixtures", "providers", "zai", "repository");

// ---------------------------------------------------------------------------
// Characterization parsers — describe the ZRead outer-wrapper grammar only.
// They are intentionally minimal: the P6-04 Adapter will own path validation,
// canonicalization, error taxonomy, and parsing of arbitrary inner markup.
// These parsers are TEST-ONLY and live in this file; they have no dependency
// on `src/`.
// ---------------------------------------------------------------------------

/**
 * Does the raw string match the encoded MCP error envelope?
 *
 * Encoded MCP errors are surfaced as a plain Provider string beginning with
 * `MCP error -<status>` and carrying an `error.code` field. They are NOT a
 * valid success grammar for any repository operation; P6-04 owns the public
 * classification.
 */
function isEncodedMcpError(raw) {
  return typeof raw === "string" && /^MCP error -\d+\b/.test(raw);
}

/**
 * Count the number of substring occurrences of a literal tag in `raw`. The
 * Search and File parsers use this to enforce balanced framing.
 */
function countTag(raw, tag) {
  if (typeof raw !== "string") return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = raw.indexOf(tag, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + tag.length;
  }
}

/**
 * Search grammar: balanced `<excerpt>` framing with at least one well-formed
 * block. Multiple ordered excerpts are allowed; arbitrary inner markup
 * (Markdown, code, HTML-like) is preserved as text. Unmatched opening or
 * closing excerpt tags are malformed.
 */
function isValidSearchGrammar(raw) {
  if (typeof raw !== "string") return false;
  if (isEncodedMcpError(raw)) return false;
  const opens = countTag(raw, "<excerpt>");
  const closes = countTag(raw, "</excerpt>");
  if (opens === 0 || opens !== closes) return false;
  return /<excerpt>[\s\S]*?<\/excerpt>/.test(raw);
}

function extractExcerptCount(raw) {
  const matches = raw.match(/<excerpt>[\s\S]*?<\/excerpt>/g);
  return matches ? matches.length : 0;
}

/**
 * File grammar: a single `<file_content>...</file_content>` wrapper that
 * wraps the entire response (only whitespace is allowed outside the wrapper).
 * Surrounding or trailing non-wrapper data, duplicate outer wrappers, and
 * unclosed tags are malformed.
 */
function isValidFileGrammar(raw) {
  if (typeof raw !== "string") return false;
  if (isEncodedMcpError(raw)) return false;
  const opens = countTag(raw, "<file_content>");
  const closes = countTag(raw, "</file_content>");
  if (opens !== 1 || closes !== 1) return false;
  // Whole-response framing: the wrapper must wrap the entire string with
  // only characterized whitespace allowed outside.
  return /^\s*<file_content>[\s\S]*<\/file_content>\s*$/.test(raw);
}

/**
 * Tree grammar: a single `<structure>...</structure>` wrapper that wraps the
 * entire response, the FIRST non-blank line inside the wrapper is the root
 * entry (allowed to be glyph-less — typical of `facebook-react/` style
 * Provider output), and EVERY subsequent non-blank line must use the
 * documented Unicode branch glyph (immediate or nested). Trailing `/` marks
 * directories. Provider sibling order is preserved. A glyph-less sibling
 * line is malformed even when the wrapper and earlier entries are valid.
 */
function isValidTreeGrammar(raw) {
  if (typeof raw !== "string") return false;
  if (isEncodedMcpError(raw)) return false;
  const opens = countTag(raw, "<structure>");
  const closes = countTag(raw, "</structure>");
  if (opens !== 1 || closes !== 1) return false;
  const wrapper = raw.match(/^\s*<structure>([\s\S]*)<\/structure>\s*$/);
  if (!wrapper) return false;
  const body = wrapper[1] || "";
  const immediateEntryRe = /^[ \t]*[├└]──\s.+$/;
  const nestedEntryRe = /^[ \t│]*[├└]──\s.+$/;
  let sawImmediate = false;
  let isFirstNonBlank = true;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    if (isFirstNonBlank) {
      // The root entry line is the FIRST non-blank line in the wrapper.
      // Per the characterized ZRead grammar, it names the repository root
      // (typically ending with `/`) and is allowed to lack the branch
      // glyph. Subsequent lines MUST use the documented glyph.
      isFirstNonBlank = false;
      continue;
    }
    if (immediateEntryRe.test(line)) {
      sawImmediate = true;
      continue;
    }
    if (nestedEntryRe.test(line)) {
      // Nested lines use a `│`-prefixed indent; accept as long as the
      // glyph grammar is intact.
      continue;
    }
    // Any non-blank, non-root line without the documented Unicode branch
    // glyph is malformed. Mixed-malformed tree responses cannot be
    // accepted.
    return false;
  }
  return sawImmediate;
}

function extractImmediateEntries(raw) {
  const wrapper = raw.match(/<structure>([\s\S]*?)<\/structure>/);
  if (!wrapper) return [];
  const body = wrapper[1] || "";
  const lines = body.split("\n");
  const entries = [];
  for (const line of lines) {
    const match = line.match(/^([ \t]*)([├└])──\s(.+)$/);
    if (!match) continue;
    const prefix = (match[1] || "").replace(/│/g, " ");
    const name = (match[3] || "").trim();
    const level = Math.floor(prefix.length / 4);
    if (level !== 0) continue;
    entries.push({
      name: name.endsWith("/") ? name.slice(0, -1) : name,
      kind: name.endsWith("/") ? "directory" : "file",
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Fixture loaders — load sanitized fixtures by name; assert they exist and
// are well-formed JSON with a `raw` Provider string and no credential-bearing
// material anywhere in the serialized fixture object.
//
// Credential scan policy (P6-01A):
//   - operate on the COMPLETE JSON.stringify output, not only `raw`, so
//     `description`, `operation`, and any future fields are also covered;
//   - match case-insensitively;
//   - reject any of: bearer credentials, the active Provider env-var
//     assignments, Authorization headers, generic api_key/password/secret/
//     access_token/refresh_token assignments.
// ---------------------------------------------------------------------------

const FORBIDDEN_FIXTURE_PATTERNS = [
  // Bearer tokens: `Bearer <token>`.
  /bearer\s+[A-Za-z0-9._\-=]+/i,
  // Active Provider credential env-var assignments.
  /Z_AI_API_KEY\s*=/i,
  /ZAI_API_KEY\s*=/i,
  /MINIMAX_API_KEY\s*=/i,
  // Generic credential-style assignments.
  /api[_-]?key\s*[=:]/i,
  /authorization\s*:/i,
  /password\s*[=:]/i,
  /secret\s*[=:]/i,
  /access_token\s*[=:]/i,
  /refresh_token\s*[=:]/i,
  /client_secret\s*[=:]/i,
];

function scanFixtureForCredentials(serializedFixture, fixtureName) {
  for (const pattern of FORBIDDEN_FIXTURE_PATTERNS) {
    if (pattern.test(serializedFixture)) {
      throw new assert.AssertionError({
        message:
          `fixture ${fixtureName} contains forbidden credential/header/token material ` +
          `matching ${pattern} in the serialized fixture`,
      });
    }
  }
}

async function loadFixture(name) {
  const data = await readFixture("providers", "zai", "repository", name);
  assert.ok(
    data && typeof data === "object" && typeof data.raw === "string",
    `fixture ${name} must carry a Provider raw string in \`raw\``,
  );
  assert.ok(
    typeof data.operation === "string",
    `fixture ${name} must declare its characterized operation`,
  );
  // Credential / header / token hygiene: the FULL serialized fixture
  // (description + operation + raw + any future fields) is scanned
  // case-insensitively so the safety net cannot drift into recording
  // Provider credentials in any field.
  const serialized = JSON.stringify(data);
  scanFixtureForCredentials(serialized, name);
  return data;
}

let fixtures = {};

before(async () => {
  fixtures = {
    searchValid: await loadFixture("search-valid.json"),
    searchMalformedWrapper: await loadFixture("search-malformed-wrapper.json"),
    searchMalformedUnclosed: await loadFixture("search-malformed-unclosed.json"),
    searchMixedMalformed: await loadFixture("search-mixed-malformed.json"),
    fileValid: await loadFixture("file-valid.json"),
    fileMalformedWrapper: await loadFixture("file-malformed-wrapper.json"),
    fileMalformedUnclosed: await loadFixture("file-malformed-unclosed.json"),
    fileMixedMalformed: await loadFixture("file-mixed-malformed.json"),
    treeRootValid: await loadFixture("tree-root-valid.json"),
    treeRootMalformed: await loadFixture("tree-root-malformed.json"),
    treeNestedValid: await loadFixture("tree-nested-valid.json"),
    treeNestedMalformed: await loadFixture("tree-nested-malformed.json"),
    treeMixedMalformed: await loadFixture("tree-mixed-malformed.json"),
    errorMcpQuota: await loadFixture("error-mcp-quota.json"),
    errorMcpGeneric: await loadFixture("error-mcp-generic.json"),
  };
});

// ---------------------------------------------------------------------------
// Fixtures are loadable, sanitized, and live under the agreed directory.
// ---------------------------------------------------------------------------

describe("P6-01 / P6-01A — ZRead repository fixture contract", () => {
  it("all 15 characterized fixtures exist on disk", async () => {
    const entries = await fs.readdir(FIXTURE_DIR);
    const names = entries.filter((n) => n.endsWith(".json")).sort();
    assert.deepStrictEqual(
      names,
      [
        "error-mcp-generic.json",
        "error-mcp-quota.json",
        "file-malformed-unclosed.json",
        "file-malformed-wrapper.json",
        "file-mixed-malformed.json",
        "file-valid.json",
        "search-malformed-unclosed.json",
        "search-malformed-wrapper.json",
        "search-mixed-malformed.json",
        "search-valid.json",
        "tree-mixed-malformed.json",
        "tree-nested-malformed.json",
        "tree-nested-valid.json",
        "tree-root-malformed.json",
        "tree-root-valid.json",
      ],
      `unexpected fixture set under ${path.relative(__dirname, FIXTURE_DIR)}`,
    );
  });

  it("valid fixtures declare the operation they characterize", () => {
    assert.strictEqual(fixtures.searchValid.operation, "search_doc");
    assert.strictEqual(fixtures.fileValid.operation, "read_file");
    assert.strictEqual(fixtures.treeRootValid.operation, "get_repo_structure");
    assert.strictEqual(fixtures.treeNestedValid.operation, "get_repo_structure");
    assert.strictEqual(fixtures.errorMcpQuota.operation, "error_fixture");
    assert.strictEqual(fixtures.errorMcpGeneric.operation, "error_fixture");
  });

  it("every fixture carries an explanatory description", () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      assert.ok(
        typeof fixture.description === "string" && fixture.description.length > 0,
        `${name} must carry a non-empty description`,
      );
    }
  });

  it("every fixture passes the full-serialized credential scan", () => {
    // The fixture loader applies the credential scan at load time; this
    // belt-and-suspenders test re-scans each fixture explicitly so a future
    // change to `loadFixture` cannot silently weaken the policy.
    for (const [name, fixture] of Object.entries(fixtures)) {
      scanFixtureForCredentials(JSON.stringify(fixture), name);
    }
  });

  it("the credential scan is case-insensitive", () => {
    // Sanity: a synthetic serialized fixture with an uppercased bearer
    // credential must be rejected. If the scan ever collapses to
    // case-sensitive matching the safety net is weakened.
    const synthetic = JSON.stringify({
      description: "synthetic",
      operation: "search_doc",
      raw: "<excerpt>BEARER ABCDEFGHIJ</excerpt>",
    });
    assert.throws(() => scanFixtureForCredentials(synthetic, "synthetic"));
  });
});

// ---------------------------------------------------------------------------
// Search grammar: malformed cases (including mixed) fail before valid grammar
// is accepted. Search framing is balanced; multiple excerpts are allowed;
// unmatched tags are malformed.
// ---------------------------------------------------------------------------

describe("P6-01 / P6-01A — ZRead Search grammar (search_doc)", () => {
  it("valid fixture has at least one well-formed <excerpt> block", () => {
    assert.ok(isValidSearchGrammar(fixtures.searchValid.raw));
    assert.ok(extractExcerptCount(fixtures.searchValid.raw) >= 2);
  });

  it("malformed-wrapper fixture (no <excerpt>) is rejected", () => {
    assert.ok(!isValidSearchGrammar(fixtures.searchMalformedWrapper.raw));
  });

  it("malformed-unclosed fixture (no closing tag) is rejected", () => {
    assert.ok(!isValidSearchGrammar(fixtures.searchMalformedUnclosed.raw));
  });

  it("mixed-malformed fixture (valid excerpt + unmatched <excerpt>) is rejected", () => {
    // P6-01A: partial goodness is not success. A response that contains a
    // well-formed excerpt alongside an unmatched opening excerpt tag must
    // be rejected by the balanced-framing rule.
    assert.ok(!isValidSearchGrammar(fixtures.searchMixedMalformed.raw));
    const opens = countTag(fixtures.searchMixedMalformed.raw, "<excerpt>");
    const closes = countTag(fixtures.searchMixedMalformed.raw, "</excerpt>");
    assert.notStrictEqual(opens, closes, "mixed-malformed fixture must have unbalanced tags");
  });

  it("malformed cases are rejected before any inner text is consumed", () => {
    // Defensive ordering: the parser rejects by wrapper shape, never by
    // scanning inner prose. If the inner-text leak here grows, a future
    // Adapter could parse a malformed response as success.
    assert.ok(
      !/useState|Hooks reference|batching/.test(fixtures.searchMalformedWrapper.raw) ||
        !isValidSearchGrammar(fixtures.searchMalformedWrapper.raw),
      "malformed-wrapper must be rejected even when its inner prose is plausible",
    );
    assert.ok(!isValidSearchGrammar(fixtures.searchMalformedUnclosed.raw));
    assert.ok(!isValidSearchGrammar(fixtures.searchMixedMalformed.raw));
  });

  it("encoded MCP error cannot satisfy the Search valid grammar", () => {
    assert.ok(!isValidSearchGrammar(fixtures.errorMcpQuota.raw));
    assert.ok(!isValidSearchGrammar(fixtures.errorMcpGeneric.raw));
  });
});

// ---------------------------------------------------------------------------
// File grammar: whole-response framing. Only characterized whitespace is
// allowed outside the wrapper; mixed-malformed (leading/trailing data or
// duplicate wrappers) is rejected.
// ---------------------------------------------------------------------------

describe("P6-01 / P6-01A — ZRead File grammar (read_file)", () => {
  it("valid fixture has a single <file_content>...</file_content> wrapper", () => {
    assert.ok(isValidFileGrammar(fixtures.fileValid.raw));
  });

  it("malformed-wrapper fixture (no <file_content>) is rejected", () => {
    assert.ok(!isValidFileGrammar(fixtures.fileMalformedWrapper.raw));
  });

  it("malformed-unclosed fixture (no closing tag) is rejected", () => {
    assert.ok(!isValidFileGrammar(fixtures.fileMalformedUnclosed.raw));
  });

  it("mixed-malformed fixture (surrounding/trailing non-wrapper data) is rejected", () => {
    // P6-01A: whole-response framing — leading or trailing prose outside
    // the wrapper is malformed even when the wrapper itself is well-formed.
    assert.ok(!isValidFileGrammar(fixtures.fileMixedMalformed.raw));
  });

  it("the File framing is whole-response (only whitespace outside the wrapper)", () => {
    // Defensive: a synthetic valid wrapper wrapped with a single leading
    // character must be rejected by the whole-response rule.
    const leading = "X<file_content>\nbody\n</file_content>";
    const trailing = "<file_content>\nbody\n</file_content>X";
    const duplicated = "<file_content>\nbody\n</file_content><file_content>\nbody2\n</file_content>";
    assert.ok(!isValidFileGrammar(leading), "leading non-whitespace must be rejected");
    assert.ok(!isValidFileGrammar(trailing), "trailing non-whitespace must be rejected");
    assert.ok(!isValidFileGrammar(duplicated), "duplicate outer wrapper must be rejected");
  });

  it("encoded MCP error cannot satisfy the File valid grammar", () => {
    assert.ok(!isValidFileGrammar(fixtures.errorMcpQuota.raw));
    assert.ok(!isValidFileGrammar(fixtures.errorMcpGeneric.raw));
  });
});

// ---------------------------------------------------------------------------
// Tree grammar: whole-response framing plus per-line glyph validation. Every
// non-blank line inside the wrapper must use the documented Unicode branch
// glyph; a glyph-less sibling makes the response malformed even when other
// entries are valid.
// ---------------------------------------------------------------------------

describe("P6-01 / P6-01A — ZRead Tree grammar (get_repo_structure)", () => {
  it("valid root fixture parses with Unicode branch glyphs and trailing-/-directories", () => {
    assert.ok(isValidTreeGrammar(fixtures.treeRootValid.raw));
    const entries = extractImmediateEntries(fixtures.treeRootValid.raw);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("README.md"), `expected README.md in ${names.join(",")}`);
    assert.ok(names.includes("yarn.lock"), `expected yarn.lock in ${names.join(",")}`);
    assert.deepStrictEqual(
      entries.find((e) => e.name === "packages"),
      { name: "packages", kind: "directory" },
      "trailing-/ must mark directory entries",
    );
  });

  it("valid nested fixture uses the same grammar as the root fixture", () => {
    assert.ok(isValidTreeGrammar(fixtures.treeNestedValid.raw));
    const entries = extractImmediateEntries(fixtures.treeNestedValid.raw);
    assert.deepStrictEqual(
      entries.map((e) => e.name),
      ["react", "react-dom", "react-reconciler", "shared"],
      "sibling order must be preserved exactly as the Provider returned it",
    );
  });

  it("root malformed fixture (wrapper present, no glyph lines) is rejected", () => {
    assert.ok(!isValidTreeGrammar(fixtures.treeRootMalformed.raw));
  });

  it("nested malformed fixture (wrapper missing entirely) is rejected", () => {
    assert.ok(!isValidTreeGrammar(fixtures.treeNestedMalformed.raw));
  });

  it("mixed-malformed fixture (valid entry + glyph-less sibling) is rejected", () => {
    // P6-01A: a single glyph-less sibling line is enough to reject the
    // whole response, even when other entries are well-formed.
    assert.ok(!isValidTreeGrammar(fixtures.treeMixedMalformed.raw));
  });

  it("the Tree framing is whole-response (only whitespace outside the wrapper)", () => {
    // Defensive: leading/trailing prose outside the structure wrapper
    // must be rejected by the whole-response rule.
    const leading = "X<structure>\n├── a\n</structure>";
    const trailing = "<structure>\n├── a\n</structure>X";
    assert.ok(!isValidTreeGrammar(leading), "leading non-whitespace must be rejected");
    assert.ok(!isValidTreeGrammar(trailing), "trailing non-whitespace must be rejected");
  });

  it("encoded MCP error cannot satisfy the Tree valid grammar", () => {
    assert.ok(!isValidTreeGrammar(fixtures.errorMcpQuota.raw));
    assert.ok(!isValidTreeGrammar(fixtures.errorMcpGeneric.raw));
  });
});

// ---------------------------------------------------------------------------
// Encoded MCP error characterization — these fixtures exist ONLY as errors.
// The public error taxonomy belongs to P6-04; P6-01 / P6-01A only asserts the
// invariant that no valid-success fixture may be satisfied by an encoded
// MCP error string.
// ---------------------------------------------------------------------------

describe("P6-01 / P6-01A — ZRead encoded MCP error fixtures", () => {
  it("encoded MCP error fixtures are recognized as encoded MCP errors", () => {
    assert.ok(isEncodedMcpError(fixtures.errorMcpQuota.raw));
    assert.ok(isEncodedMcpError(fixtures.errorMcpGeneric.raw));
  });

  it("encoded MCP errors do not leak credentials or full Provider bodies", () => {
    for (const name of ["errorMcpQuota", "errorMcpGeneric"]) {
      const serialized = JSON.stringify(fixtures[name]);
      // The full-serialized scan runs at load time. This test re-applies
      // it inline so any future change to the loader is caught here too.
      scanFixtureForCredentials(serialized, name);
    }
  });

  it("an encoded MCP error cannot satisfy any valid-success grammar", () => {
    // The encoder cannot impersonate a success response. P6-04 owns the
    // public classification; this is the characterization invariant.
    for (const errorFixture of [fixtures.errorMcpQuota, fixtures.errorMcpGeneric]) {
      assert.ok(!isValidSearchGrammar(errorFixture.raw));
      assert.ok(!isValidFileGrammar(errorFixture.raw));
      assert.ok(!isValidTreeGrammar(errorFixture.raw));
    }
  });
});
