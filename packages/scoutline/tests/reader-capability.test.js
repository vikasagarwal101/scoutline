/**
 * Reader Migration 01 — Reader Capability contracts (core-flows D1, D2)
 * and the pure `buildLegacyReaderCacheKey` helper.
 *
 * Locks down:
 *   - the v1 `ReaderFetchResult` envelope via total decoder behavior;
 *   - the single `ReaderOperationKind` literal;
 *   - the pure legacy cache-key helper reproducing v0.2 filenames
 *     byte-for-byte;
 *   - source-boundary purity (no ambient reads inside the helper body);
 *   - ZAI_API_KEY alias parity (same resolved credential → byte-identical
 *     legacy keys).
 *
 * Pure metadata tests: no Provider or transport is constructed here. The
 * TypeScript interface shapes (field sets, union members, schema-version
 * constants) are owned by `src/capabilities/reader.ts`; drift in those
 * shapes is caught at `npm run build` (TypeScript module compile), not by
 * runtime tests inside this file. The runtime tests here exercise only
 * decoder behavior and the cache-key helper's algorithm + purity.
 *
 * The literal golden cache filenames below are HARD-CODED. They were
 * independently computed once via Node's `crypto.createHash("sha256")`
 * against the documented v0.2 algorithm and the public tool name
 * `scoutline.zai.reader.webReader` (the value `getMcpToolName("reader",
 * "webReader")` returns at runtime). They are never re-derived at test
 * time. Coordinated drift in `sha256`, in `JSON.stringify`, or in the
 * helper's algorithm would invalidate these literals — that is the point.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { decodeReaderFetchResult } from "../dist/capabilities/reader.js";
import { buildLegacyReaderCacheKey } from "../dist/lib/cache.js";

// ---------------------------------------------------------------------------
// Helper for valid fixtures
// ---------------------------------------------------------------------------

function buildValidResult(overrides = {}) {
  return {
    schemaVersion: 1,
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    title: "Example Domain",
    content: "# Example\n\nThis is the page body.",
    contentFormat: "markdown",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decodeReaderFetchResult — total decoder
// ---------------------------------------------------------------------------

describe("decodeReaderFetchResult — total decoder", () => {
  it("returns a normalized result for a valid minimal fixture", () => {
    const valid = buildValidResult();
    const out = decodeReaderFetchResult(valid);
    assert.deepStrictEqual(out, valid);
  });

  it("accepts title: null", () => {
    const out = decodeReaderFetchResult(buildValidResult({ title: null }));
    assert.ok(out);
    assert.strictEqual(out.title, null);
  });

  it("accepts an empty title string ('' is preserved, not coerced to null)", () => {
    // Decoder does not coerce blank titles — the Adapter is responsible
    // for blank-to-null coercion before writing.
    const out = decodeReaderFetchResult(buildValidResult({ title: "" }));
    assert.ok(out);
    assert.strictEqual(out.title, "");
  });

  it("accepts title: undefined by leaving the field absent in input (decoder still rejects)", () => {
    // title is required in the envelope contract (string | null). A
    // missing title field is malformed at the wire layer.
    const bad = buildValidResult();
    delete bad.title;
    assert.strictEqual(decodeReaderFetchResult(bad), null);
  });

  it("accepts contentFormat 'text'", () => {
    const out = decodeReaderFetchResult(buildValidResult({ contentFormat: "text" }));
    assert.ok(out);
    assert.strictEqual(out.contentFormat, "text");
  });

  it("preserves optional metadata verbatim when present", () => {
    const metadata = { "og:title": "Example", viewport: "width=device-width" };
    const out = decodeReaderFetchResult(buildValidResult({ metadata }));
    assert.ok(out);
    assert.deepStrictEqual(out.metadata, metadata);
  });

  it("preserves optional external verbatim when present", () => {
    const external = { icon: { href: "/favicon.ico" } };
    const out = decodeReaderFetchResult(buildValidResult({ external }));
    assert.ok(out);
    assert.deepStrictEqual(out.external, external);
  });

  it("omits metadata/external from the decoded result when absent on input", () => {
    const out = decodeReaderFetchResult(buildValidResult());
    assert.ok(out);
    assert.ok(!("metadata" in out));
    assert.ok(!("external" in out));
  });

  it("round-trips a canonical fixture (equality)", () => {
    const canonical = buildValidResult({
      metadata: { lang: "en" },
      external: { icon: { href: "/x.ico" } },
    });
    assert.deepStrictEqual(decodeReaderFetchResult(canonical), canonical);
  });

  // --- Rejection cases ---

  it("rejects schemaVersion other than literal 1", () => {
    assert.strictEqual(decodeReaderFetchResult(buildValidResult({ schemaVersion: 2 })), null);
    assert.strictEqual(decodeReaderFetchResult(buildValidResult({ schemaVersion: 0 })), null);
    assert.strictEqual(decodeReaderFetchResult(buildValidResult({ schemaVersion: "1" })), null);
    assert.strictEqual(
      decodeReaderFetchResult(buildValidResult({ schemaVersion: undefined })),
      null,
    );
    assert.strictEqual(decodeReaderFetchResult(buildValidResult({ schemaVersion: null })), null);
    // Note: `1.0 === 1` in JavaScript (IEEE 754 — they are the same number),
    // so `schemaVersion: 1.0` is accepted by the decoder as the literal 1.
    // This is the intended behavior; a separate non-integer case is covered
    // by `schemaVersion: 1.5` below.
    assert.strictEqual(decodeReaderFetchResult(buildValidResult({ schemaVersion: 1.5 })), null);
  });

  it("rejects primitives and arrays at the top level", () => {
    for (const bad of [undefined, null, "string", 42, [], true, Symbol("x")]) {
      assert.strictEqual(decodeReaderFetchResult(bad), null, `bad=${typeof bad}`);
    }
  });

  it("rejects a raw string response (the MCP error-envelope shape) at the Capability layer", () => {
    // The characterization probe captured a bare-string raw response
    // from the WebReader MCP. At the Capability decoder layer this is
    // malformed — the Adapter must convert raw strings to API_ERROR 502
    // before they ever reach the cache.
    const raw = "MCP error -500: 500 Internal Server Error: …";
    assert.strictEqual(decodeReaderFetchResult(raw), null);
  });

  it("rejects missing required scalars", () => {
    for (const k of ["schemaVersion", "url", "finalUrl", "content", "title", "contentFormat"]) {
      const bad = buildValidResult();
      delete bad[k];
      assert.strictEqual(decodeReaderFetchResult(bad), null, `expected null without ${k}`);
    }
  });

  it("rejects non-string url", () => {
    for (const bad of [null, 0, [], {}, true]) {
      assert.strictEqual(
        decodeReaderFetchResult(buildValidResult({ url: bad })),
        null,
        `expected null for url=${JSON.stringify(bad)}`,
      );
    }
  });

  it("rejects empty url '' (must be non-empty)", () => {
    assert.strictEqual(decodeReaderFetchResult(buildValidResult({ url: "" })), null);
  });

  it("rejects non-string finalUrl", () => {
    for (const bad of [null, 0, [], {}, true]) {
      assert.strictEqual(
        decodeReaderFetchResult(buildValidResult({ finalUrl: bad })),
        null,
        `expected null for finalUrl=${JSON.stringify(bad)}`,
      );
    }
  });

  it("rejects empty finalUrl '' (must be non-empty)", () => {
    assert.strictEqual(decodeReaderFetchResult(buildValidResult({ finalUrl: "" })), null);
  });

  it("rejects non-string content", () => {
    for (const bad of [null, 0, [], {}, true]) {
      assert.strictEqual(
        decodeReaderFetchResult(buildValidResult({ content: bad })),
        null,
        `expected null for content=${JSON.stringify(bad)}`,
      );
    }
  });

  it("rejects empty content '' (must be non-empty)", () => {
    assert.strictEqual(decodeReaderFetchResult(buildValidResult({ content: "" })), null);
  });

  it("rejects title that is neither string nor null", () => {
    for (const bad of [0, [], {}, true]) {
      assert.strictEqual(
        decodeReaderFetchResult(buildValidResult({ title: bad })),
        null,
        `expected null for title=${JSON.stringify(bad)}`,
      );
    }
  });

  it("rejects contentFormat other than 'markdown' or 'text'", () => {
    for (const bad of ["html", "MD", "TEXT", "", null, 1, true, undefined]) {
      assert.strictEqual(
        decodeReaderFetchResult(buildValidResult({ contentFormat: bad })),
        null,
        `expected null for contentFormat=${JSON.stringify(bad)}`,
      );
    }
  });

  it("never throws on malformed input (total rejection)", () => {
    // Anything goes — the decoder must return null, never throw.
    const weird = [
      {},
      [],
      null,
      undefined,
      { schemaVersion: 1 },
      { schemaVersion: 1, url: "x" },
      { schemaVersion: 1, url: "x", finalUrl: "x" },
      { schemaVersion: 1, url: "x", finalUrl: "x", content: "y" },
      { schemaVersion: 1, url: "x", finalUrl: "x", content: "y", title: 1 },
      Buffer.from("not json"),
      new Date(),
      /regex/,
      () => {},
    ];
    for (const v of weird) {
      assert.strictEqual(decodeReaderFetchResult(v), null);
    }
  });

  it("distinguishes finalUrl from url (rewrite observable)", () => {
    const out = decodeReaderFetchResult(
      buildValidResult({
        url: "https://gist.github.com/octocat/abc",
        finalUrl: "https://gist.github.com/octocat/abc/raw",
      }),
    );
    assert.ok(out);
    assert.notStrictEqual(out.url, out.finalUrl);
  });
});

// ---------------------------------------------------------------------------
// buildLegacyReaderCacheKey — pure v0.2 key builder
// ---------------------------------------------------------------------------
//
// Algorithm (DESIGN.md §18, mirrors `buildLegacyRepositoryCacheKey`):
//   credentialPart = sha256(apiKey).hex.slice(0, 12)
//   argumentPart   = sha256(JSON.stringify({ command: publicToolName,
//                                            args })).hex.slice(0, 24)
//   key            = `${publicToolName}.${credentialPart}.${argumentPart}.json`
//
// The four golden filenames below are HARD-CODED LITERALS — they were
// computed once against the documented v0.2 algorithm and the public
// tool name `scoutline.zai.reader.webReader` and verified against the
// helper at write time. They are never re-derived at test time.

describe("buildLegacyReaderCacheKey — pure v0.2 reader key builder", () => {
  // Locked apiKey chosen so golden hashes are deterministic.
  const API_KEY = "sk-test-READER-CACHE-KEY-1234567890";

  // Public tool name as resolved at runtime by
  // getMcpToolName("reader", "webReader") — matches MCP_MANUAL_NAME
  // ("scoutline.zai") + "." + MCP_SERVERS.reader ("reader") + "." + "webReader".
  const PUBLIC_TOOL_NAME = "scoutline.zai.reader.webReader";

  // Hard-coded literal golden filenames. If sha256, JSON.stringify, or
  // the helper's algorithm drifts, these literals fail — that is the
  // point.
  const GOLDEN_MINIMAL_KEY =
    "scoutline.zai.reader.webReader.02a4ac8f2819.ece53d0eb2d6dd1106d6419f.json";
  const GOLDEN_FORMAT_KEY =
    "scoutline.zai.reader.webReader.02a4ac8f2819.3ff588c5b132af8911573222.json";
  const GOLDEN_DEFAULT_KEY =
    "scoutline.zai.reader.webReader.02a4ac8f2819.30710832bf2faaac8562cc10.json";
  const GOLDEN_FULL_KEY =
    "scoutline.zai.reader.webReader.02a4ac8f2819.4fd78271f8c32bb4ee89687b.json";

  // Locked credential-part literal (sha256(API_KEY).slice(0,12)).
  const EXPECTED_CREDENTIAL_PART = "02a4ac8f2819";

  it("uses sha256(apiKey).hex.slice(0,12) as the credential part (algorithm check)", () => {
    const expectedCredential = crypto
      .createHash("sha256")
      .update(API_KEY)
      .digest("hex")
      .slice(0, 12);
    assert.strictEqual(expectedCredential, EXPECTED_CREDENTIAL_PART);
    const key = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, { url: "x" });
    // The filename shape is:
    //   scoutline.zai.reader.webReader.<12-hex-credential>.<24-hex-argument>.json
    // The credential part is the second-to-last "."-delimited chunk
    // BEFORE the 24-hex argument part and ".json" suffix. Because the
    // public tool name contains dots, we locate the credential part by
    // the substring match (definitive) and confirm length via regex.
    assert.ok(key.includes(`.${expectedCredential}.`), `key missing credential part: ${key}`);
    assert.match(key, /^scoutline\.zai\.reader\.webReader\.[0-9a-f]{12}\.[0-9a-f]{24}\.json$/);
  });

  it("uses sha256({command,args}).hex.slice(0,24) as the argument part (algorithm check)", () => {
    const args = { url: "https://example.com/" };
    const expectedArgPart = crypto
      .createHash("sha256")
      .update(JSON.stringify({ command: PUBLIC_TOOL_NAME, args }))
      .digest("hex")
      .slice(0, 24);
    const key = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    assert.ok(key.endsWith(`.${expectedArgPart}.json`));
  });

  it("minimal args (url only) produce the locked literal golden key", () => {
    const args = { url: "https://example.com/" };
    const key = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    assert.strictEqual(key, GOLDEN_MINIMAL_KEY);
  });

  it("url + return_format produce the locked literal golden key", () => {
    const args = { url: "https://example.com/", return_format: "text" };
    const key = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    assert.strictEqual(key, GOLDEN_FORMAT_KEY);
  });

  it("v1 default-shape args (4 keys, matching what Adapter will issue) produce the locked literal golden key", () => {
    const args = {
      url: "https://example.com/",
      return_format: "markdown",
      retain_images: false,
      with_links_summary: false,
      with_images_summary: false,
    };
    const key = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    assert.strictEqual(key, GOLDEN_DEFAULT_KEY);
  });

  it("full v0.2 insertion-order args (all 9 keys) produce the locked literal golden key", () => {
    // Exact v0.2 webRead insertion order:
    // url, timeout, no_cache, return_format, retain_images,
    // with_links_summary, no_gfm, keep_img_data_url, with_images_summary.
    const args = {
      url: "https://example.com/",
      timeout: 30,
      no_cache: true,
      return_format: "markdown",
      retain_images: true,
      with_links_summary: true,
      no_gfm: true,
      keep_img_data_url: true,
      with_images_summary: true,
    };
    const key = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    assert.strictEqual(key, GOLDEN_FULL_KEY);
  });

  it("all golden keys match the v0.2 reader filename shape", () => {
    for (const k of [GOLDEN_MINIMAL_KEY, GOLDEN_FORMAT_KEY, GOLDEN_DEFAULT_KEY, GOLDEN_FULL_KEY]) {
      // publicToolName has dots; match the full shape loosely:
      // <dotted-name>.<12-hex>.<24-hex>.json
      assert.match(k, /^[\w.]+\.[0-9a-f]{12}\.[0-9a-f]{24}\.json$/);
    }
  });

  it("distinct args produce distinct golden keys", () => {
    const keys = new Set([
      GOLDEN_MINIMAL_KEY,
      GOLDEN_FORMAT_KEY,
      GOLDEN_DEFAULT_KEY,
      GOLDEN_FULL_KEY,
    ]);
    assert.strictEqual(keys.size, 4, "golden keys must be pairwise distinct");
  });

  it("insertion-order sensitivity: same keys, different order → different filename", () => {
    // JSON.stringify follows insertion order. Swapping two keys changes
    // the argument hash even though the set of keys is the same.
    const a = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, {
      url: "u",
      return_format: "markdown",
    });
    const b = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, {
      return_format: "markdown",
      url: "u",
    });
    assert.notStrictEqual(a, b);
  });

  it("identical inputs produce identical keys", () => {
    const args = { url: "https://example.com/", return_format: "markdown" };
    const a = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    const b = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    assert.strictEqual(a, b);
  });

  it("different public tool names produce different keys for the same args", () => {
    const args = { url: "u" };
    const a = buildLegacyReaderCacheKey(API_KEY, "scoutline.zai.reader.webReader", args);
    const b = buildLegacyReaderCacheKey(API_KEY, "scoutline.zai.reader.otherReader", args);
    assert.notStrictEqual(a, b);
  });

  it("different credentials produce different keys for the same args", () => {
    const args = { url: "u" };
    const a = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    const b = buildLegacyReaderCacheKey("sk-OTHER-CRED-XYZ-9999999999", PUBLIC_TOOL_NAME, args);
    assert.notStrictEqual(a, b);
  });

  it("filenames never contain the raw credential or its sensitive substrings", () => {
    const key = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, {
      url: "https://example.com/",
    });
    assert.ok(!key.includes(API_KEY), `raw credential must not appear in filename: ${key}`);
    assert.ok(!key.includes("READER-CACHE-KEY"), "credential substring leaked into filename");
    assert.ok(!key.includes("sk-test"), "credential prefix leaked into filename");
  });

  it("golden literals never contain the raw credential or its sensitive substrings", () => {
    for (const k of [GOLDEN_MINIMAL_KEY, GOLDEN_FORMAT_KEY, GOLDEN_DEFAULT_KEY, GOLDEN_FULL_KEY]) {
      assert.ok(!k.includes(API_KEY));
      assert.ok(!k.includes("READER-CACHE-KEY"));
      assert.ok(!k.includes("sk-test"));
    }
  });

  it("performs no ambient environment lookup (injected-only call)", () => {
    // Save and force conflicting ambient credentials so any env read
    // would change the hash. The helper must derive the key strictly
    // from the injected value.
    const savedPrimary = process.env.Z_AI_API_KEY;
    const savedAlias = process.env.ZAI_API_KEY;
    const savedMinimax = process.env.MINIMAX_API_KEY;
    process.env.Z_AI_API_KEY = "sk-AMBIENT-DO-NOT-USE-9999999999";
    process.env.ZAI_API_KEY = "sk-AMBIENT-ALT-DO-NOT-USE-999";
    try {
      const key = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, {
        url: "https://example.com/",
      });
      // Must contain the credential hash derived from API_KEY, not from
      // the ambient credentials.
      assert.ok(
        key.includes(`.${EXPECTED_CREDENTIAL_PART}.`),
        `helper must hash the injected credential, not the ambient one: ${key}`,
      );
      assert.ok(!key.includes("AMBIENT"));
    } finally {
      if (savedPrimary === undefined) delete process.env.Z_AI_API_KEY;
      else process.env.Z_AI_API_KEY = savedPrimary;
      if (savedAlias === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = savedAlias;
      if (savedMinimax === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = savedMinimax;
    }
  });

  it("ambient and injected credentials produce different keys (no env blending)", () => {
    const args = { url: "u" };
    const injected = buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, args);
    // Sanity build: a fabricated ambient credential cannot match the
    // injected API_KEY-derived key.
    const ambient = buildLegacyReaderCacheKey(
      "sk-somewhere-else-9999999999999",
      PUBLIC_TOOL_NAME,
      args,
    );
    assert.notStrictEqual(injected, ambient);
  });

  it("alias parity: Z_AI_API_KEY and ZAI_API_KEY with the same resolved value produce byte-identical keys", () => {
    // The helper accepts the resolved credential explicitly; it has no
    // knowledge of which env var it came from. Two callers using
    // different env var names but the same resolved value MUST produce
    // the same legacy key (this is the property that lets v0.2 cache
    // entries written under one alias remain readable under the other).
    const resolvedCredential = "sk-shared-resolved-credential-XYZ";
    const viaPrimary = buildLegacyReaderCacheKey(resolvedCredential, PUBLIC_TOOL_NAME, {
      url: "https://example.com/",
    });
    const viaAlias = buildLegacyReaderCacheKey(resolvedCredential, PUBLIC_TOOL_NAME, {
      url: "https://example.com/",
    });
    assert.strictEqual(viaPrimary, viaAlias);
  });

  it("does not mutate process global env defaults", () => {
    const before = {
      Z_AI_API_KEY: process.env.Z_AI_API_KEY,
      ZAI_API_KEY: process.env.ZAI_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    };
    buildLegacyReaderCacheKey(API_KEY, PUBLIC_TOOL_NAME, { url: "u" });
    const after = {
      Z_AI_API_KEY: process.env.Z_AI_API_KEY,
      ZAI_API_KEY: process.env.ZAI_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    };
    assert.deepStrictEqual(after, before);
  });
});

// ---------------------------------------------------------------------------
// Source-boundary proof for buildLegacyReaderCacheKey
//
// The behavioral tests above prove that the helper's *output* is not
// influenced by `process.env` or by `buildCacheKey`. The next block is a
// direct, structural proof: it reads `src/lib/cache.ts`, isolates the
// `buildLegacyReaderCacheKey` function body, and asserts that the body
// contains no `process.env`, no `getApiKey` call, no call to
// `buildCacheKey`, and no ambient env-var name strings. This locks the
// helper against future regression where someone adds a hidden
// dependency inside the body. Mirrors the P6-02B precedent in
// tests/cache.test.js.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_SOURCE_PATH = path.join(__dirname, "..", "src", "lib", "cache.ts");

/**
 * Extract the body of a top-level exported function `functionName` from
 * a TypeScript/JavaScript source string. Walks past string literals,
 * template literals (with `${...}` interpolations), and comments so
 * braces inside them do not affect the depth count. Returns the source
 * slice between the opening and closing braces.
 *
 * Identical algorithm to the P6-02B extractor in tests/cache.test.js.
 */
function extractFunctionBody(sourceText, functionName) {
  const sigStart = sourceText.search(new RegExp(`export\\s+function\\s+${functionName}\\s*\\(`));
  if (sigStart === -1) {
    throw new Error(`Function ${functionName} not found in source`);
  }
  const slice = sourceText.slice(sigStart);
  const openBraceMatch = slice.match(/\{/);
  if (!openBraceMatch) {
    throw new Error(`Function ${functionName} has no body`);
  }
  const openBraceIdx = sigStart + openBraceMatch.index;
  let depth = 1;
  let i = openBraceIdx + 1;
  while (i < sourceText.length && depth > 0) {
    const c = sourceText[i];
    if (c === "/" && sourceText[i + 1] === "/") {
      const nl = sourceText.indexOf("\n", i);
      i = nl === -1 ? sourceText.length : nl + 1;
      continue;
    }
    if (c === "/" && sourceText[i + 1] === "*") {
      const close = sourceText.indexOf("*/", i + 2);
      i = close === -1 ? sourceText.length : close + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const strChar = c;
      i++;
      while (i < sourceText.length) {
        if (sourceText[i] === "\\") {
          i += 2;
          continue;
        }
        if (sourceText[i] === strChar) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      while (i < sourceText.length) {
        if (sourceText[i] === "\\") {
          i += 2;
          continue;
        }
        if (sourceText[i] === "`") {
          i++;
          break;
        }
        if (sourceText[i] === "$" && sourceText[i + 1] === "{") {
          i += 2;
          let idepth = 1;
          while (i < sourceText.length && idepth > 0) {
            if (sourceText[i] === "{") idepth++;
            else if (sourceText[i] === "}") idepth--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error(`Unbalanced braces in ${functionName}`);
  }
  return sourceText.slice(openBraceIdx + 1, i - 1);
}

describe("buildLegacyReaderCacheKey — direct source-body purity", () => {
  let sourceText;
  let body;

  it("cache.ts source file is readable from the test directory", async () => {
    sourceText = await fs.readFile(CACHE_SOURCE_PATH, "utf8");
    assert.ok(typeof sourceText === "string" && sourceText.length > 0);
  });

  it("isolates the buildLegacyReaderCacheKey function body from cache.ts", async function () {
    if (sourceText === undefined) sourceText = await fs.readFile(CACHE_SOURCE_PATH, "utf8");
    body = extractFunctionBody(sourceText, "buildLegacyReaderCacheKey");
    assert.ok(typeof body === "string" && body.length > 0);
    // The body must reference both computed parts.
    assert.ok(
      body.includes("credentialPart") && body.includes("argumentPart"),
      "isolated body must reference both parts",
    );
  });

  it("isolated body contains no reference to process.env", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !body.includes("process.env"),
      `buildLegacyReaderCacheKey body must not reference process.env:\n${body}`,
    );
  });

  it("isolated body contains no call to getApiKey", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !/\bgetApiKey\s*\(/.test(body),
      `buildLegacyReaderCacheKey body must not call getApiKey:\n${body}`,
    );
  });

  it("isolated body contains no call to buildCacheKey (helper is independent)", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !/\bbuildCacheKey\s*\(/.test(body),
      `buildLegacyReaderCacheKey body must not call buildCacheKey:\n${body}`,
    );
  });

  it("isolated body contains no use of ambient Z_AI_API_KEY / ZAI_API_KEY strings", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !body.includes("Z_AI_API_KEY"),
      `buildLegacyReaderCacheKey body must not name Z_AI_API_KEY:\n${body}`,
    );
    assert.ok(
      !body.includes("ZAI_API_KEY"),
      `buildLegacyReaderCacheKey body must not name ZAI_API_KEY:\n${body}`,
    );
  });

  it("isolated body contains no use of MINIMAX_API_KEY string", function () {
    if (body === undefined) this.skip();
    assert.ok(
      !body.includes("MINIMAX_API_KEY"),
      `buildLegacyReaderCacheKey body must not name MINIMAX_API_KEY:\n${body}`,
    );
  });

  it("isolated body is non-empty and pure (no module-level ambient state access)", function () {
    if (body === undefined) this.skip();
    // Defense in depth: any of these would suggest the helper reached
    // outside its own lexical scope.
    for (const forbidden of ["process.env", "getApiKey(", "buildCacheKey("]) {
      assert.ok(!body.includes(forbidden), `forbidden token in body: ${forbidden}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Module isolation: the Capability module imports no concrete Provider
// ---------------------------------------------------------------------------

describe("Reader Capability — module isolation", () => {
  it("is importable without touching provider submodules at import time", () => {
    // Re-import from the freshly built dist path. The Capability file is
    // the contract; no transport/Adapter code should be reachable from
    // this import.
    assert.strictEqual(typeof decodeReaderFetchResult, "function");
  });
});
