/**
 * Unit tests for the local context parser module (Ticket 1,
 * docs/plans/local-context DESIGN.md D2/D3).
 *
 * Covers:
 *   - heading extraction (ATX levels 1-6, setext ignored, mixed case,
 *     exact dedupe, empty-after-trim drop)
 *   - question extraction (200-char boundary, non-`?` lines ignored,
 *     whitespace/`?` stripping, exact dedupe)
 *   - term pipeline (stopwords, 4-40 char bounds, order preservation,
 *     dedupe, cap MAX_TERMS)
 *   - sub-query derivation (60-char heading drop, document-order
 *     interleave, cap MAX_SUBQUERIES, trailing-backslash trim)
 *   - bias append (240-char fit rule, empty-terms no-op)
 *   - readContextSource caps matrix (0 bytes .. one byte over),
 *     ENOENT/EACCES/EISDIR -> FILE_ERROR, NUL-in-first-8KiB binary
 *     heuristic, sha256 of decoded text
 *   - determinism: every parse run twice asserts deep-equal
 *
 * 100% offline: real fs touches stay inside withTempDir (tmpdir only);
 * everything else drives readContextSource through injected io doubles.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { withTempDir } from "./helpers/temp-dir.js";
import { FileError, ValidationError } from "../dist/lib/errors.js";
import {
  MAX_CONTEXT_BYTES,
  MAX_SUBQUERIES,
  MAX_TERMS,
  STOPWORDS,
  parseContextText,
  deriveSubQueries,
  buildBiasAppend,
  slug,
  readContextSource,
} from "../dist/lib/context-file.js";

const skipPermissionTest =
  process.platform === "win32" ||
  (typeof process.getuid === "function" && process.getuid() === 0);

function sha256of(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fakeFileIo(buffer) {
  return {
    readFile: async () => buffer,
    readStdin: async () => buffer.toString("utf8"),
  };
}

function fakeStdinIo(text) {
  return {
    readFile: async () => {
      throw new Error("readFile must not be called for stdin sources");
    },
    readStdin: async () => text,
  };
}

const realFileIo = {
  readFile: (filePath) => fs.readFile(filePath),
  readStdin: async () => "",
};

describe("parseContextText headings", () => {
  it("extracts ATX headings at levels 1-6 in document order", () => {
    const text = "# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six";
    assert.deepEqual(parseContextText(text).headings, [
      "One",
      "Two",
      "Three",
      "Four",
      "Five",
      "Six",
    ]);
  });

  it("ignores setext-style headings, 7-hash lines, and plain text", () => {
    const text = "Setext Title\n======\nAnother Setext\n---\n####### Seven\nplain line";
    assert.deepEqual(parseContextText(text), {
      headings: [],
      questions: [],
      terms: [],
      subQueries: [],
    });
  });

  it("trims heading text and drops headings that are empty after trim", () => {
    const text = "##   Spaced Heading   \n##   \n#";
    assert.deepEqual(parseContextText(text).headings, ["Spaced Heading"]);
  });

  it("dedupes exact headings case-sensitively preserving first occurrence", () => {
    const text = "## Alpha\nintro\n## alpha\n## Alpha\nmore";
    const parsed = parseContextText(text);
    assert.deepEqual(parsed.headings, ["Alpha", "alpha"]);
  });
});

describe("parseContextText questions", () => {
  it("extracts question lines without the trailing question mark", () => {
    const text = "What is scoutline?\nThis is a statement.\nHow does caching work?";
    assert.deepEqual(parseContextText(text).questions, [
      "What is scoutline",
      "How does caching work",
    ]);
  });

  it("treats heading lines ending in ? as headings, not questions", () => {
    const text = "## Is this a heading?\nWhy?";
    const parsed = parseContextText(text);
    assert.deepEqual(parsed.headings, ["Is this a heading?"]);
    assert.deepEqual(parsed.questions, ["Why"]);
  });

  it("strips surrounding whitespace and trailing ? runs, dropping empties", () => {
    const text = "  Why now?\nReally??\nTrailing space? \n???";
    assert.deepEqual(parseContextText(text).questions, ["Why now", "Really"]);
  });

  it("extracts questions at exactly 200 chars and ignores 201", () => {
    const q200 = "x".repeat(199) + "?";
    const q201 = "y".repeat(200) + "?";
    assert.strictEqual(q200.length, 200);
    assert.strictEqual(q201.length, 201);
    assert.deepEqual(parseContextText(`${q200}\n${q201}`).questions, ["x".repeat(199)]);
  });

  it("dedupes exact questions preserving first occurrence", () => {
    assert.deepEqual(parseContextText("What?\nWhat?\nAgain?").questions, ["What", "Again"]);
  });
});

describe("parseContextText terms", () => {
  it("derives lowercase terms from headings and questions in document order, dropping stopwords", () => {
    const text = "## Architecture Overview\nWhat about caching behavior?";
    assert.deepEqual(parseContextText(text).terms, [
      "architecture",
      "overview",
      "caching",
      "behavior",
    ]);
  });

  it("drops tokens shorter than 4 chars or longer than 40 chars", () => {
    const text = `## abc abcd ${"b".repeat(41)} ${"c".repeat(40)}`;
    assert.deepEqual(parseContextText(text).terms, ["abcd", "c".repeat(40)]);
  });

  it("splits on non-alphanumeric separators and keeps digit-bearing tokens", () => {
    assert.deepEqual(parseContextText("## OAuth2-backed state-machine 4k").terms, [
      "oauth2",
      "backed",
      "state",
      "machine",
    ]);
  });

  it("dedupes tokens across headings and questions preserving first occurrence", () => {
    assert.deepEqual(parseContextText("## Caching\nHow does caching work?").terms, [
      "caching",
      "work",
    ]);
  });

  it("caps terms at MAX_TERMS preserving document order", () => {
    assert.strictEqual(MAX_TERMS, 12);
    const headings = [];
    for (let i = 1; i <= 15; i++) {
      headings.push(`## topic${String(i).padStart(2, "0")} notes`);
    }
    const terms = parseContextText(headings.join("\n")).terms;
    assert.strictEqual(terms.length, MAX_TERMS);
    assert.strictEqual(terms[0], "topic01");
    assert.strictEqual(terms[terms.length - 1], "topic11");
    assert.ok(!terms.includes("topic12"));
  });
});

describe("parseContextText subQueries and deriveSubQueries", () => {
  it("interleaves headings and questions in document order", () => {
    const text = "What is the plan?\n## Alpha\nWhy now?\n## Beta";
    const parsed = parseContextText(text);
    assert.deepEqual(parsed.headings, ["Alpha", "Beta"]);
    assert.deepEqual(parsed.questions, ["What is the plan", "Why now"]);
    // The sub-query stream is the interleaved document-order stream, not
    // a projection concatenation (DESIGN D2 implementation note).
    assert.deepEqual(parsed.subQueries, ["What is the plan", "Alpha", "Why now", "Beta"]);
    assert.deepEqual(deriveSubQueries(text), parsed.subQueries);
  });

  it("drops headings longer than 60 chars without truncating them", () => {
    const h60 = "a".repeat(60);
    const h61 = "b".repeat(61);
    const parsed = parseContextText(`# ${h60}\n# ${h61}`);
    assert.deepEqual(parsed.headings, [h60, h61]);
    assert.deepEqual(parsed.subQueries, [h60]);
  });

  it("caps sub-queries at MAX_SUBQUERIES in document order", () => {
    assert.strictEqual(MAX_SUBQUERIES, 8);
    const questions = [];
    for (let i = 1; i <= 10; i++) {
      questions.push(`q${String(i).padStart(2, "0")}?`);
    }
    const subQueries = parseContextText(questions.join("\n")).subQueries;
    assert.deepEqual(subQueries, ["q01", "q02", "q03", "q04", "q05", "q06", "q07", "q08"]);
  });

  it("trims trailing backslashes from derived sub-queries and drops empties", () => {
    // Literal lines: "## Alpha\", "## Beta\\", "# \"
    const text = ["## Alpha\\", "## Beta\\\\", "# \\"].join("\n");
    const parsed = parseContextText(text);
    assert.deepEqual(parsed.headings, ["Alpha\\", "Beta\\\\", "\\"]);
    assert.deepEqual(parsed.subQueries, ["Alpha", "Beta"]);
    assert.deepEqual(deriveSubQueries(text), ["Alpha", "Beta"]);
  });
});

describe("slug", () => {
  it("lowercases, collapses non-alphanumerics to single hyphens, and strips edges", () => {
    assert.strictEqual(slug("Architecture Overview!"), "architecture-overview");
    assert.strictEqual(slug("  --Weird__stuff--  "), "weird-stuff");
    assert.strictEqual(slug("C++ and C#"), "c-and-c");
    assert.strictEqual(slug("Ünïcode?"), "n-code");
    assert.strictEqual(slug(""), "");
  });
});

describe("buildBiasAppend", () => {
  it("returns the query unchanged when there are no terms", () => {
    assert.strictEqual(buildBiasAppend("original query", []), "original query");
  });

  it("appends the focus segment with comma-joined terms", () => {
    assert.strictEqual(buildBiasAppend("q", ["alpha", "beta"]), "q (focus: alpha, beta)");
  });

  it("caps the appended segment at 240 chars by dropping trailing terms", () => {
    // Uniform 40-char terms: segment(k) = 8 + 42k chars, so k=6 exceeds
    // 240 (260) and k=5 fits (218). With 12 terms only the first 5 fit.
    const terms = [];
    for (let i = 0; i < 12; i++) {
      const letter = String.fromCharCode("a".charCodeAt(0) + i);
      terms.push(letter.repeat(40));
    }
    const result = buildBiasAppend("q", terms);
    assert.ok(result.startsWith("q (focus: "));
    assert.ok(result.includes(terms[0]));
    assert.ok(result.includes(terms[4]));
    assert.ok(!result.includes(terms[5]));
    assert.strictEqual(result.length - "q".length, 218);
  });

  it("retains at least one term even when the segment exceeds the cap", () => {
    const big = "z".repeat(300);
    assert.strictEqual(buildBiasAppend("q", [big]), `q (focus: ${big})`);
  });
});

describe("readContextSource size cap", () => {
  it("pins the byte cap constant", () => {
    assert.strictEqual(MAX_CONTEXT_BYTES, 262144);
  });

  it("accepts a 0-byte source", async () => {
    const result = await readContextSource({ file: "/tmp/notes.md" }, fakeFileIo(Buffer.alloc(0)));
    assert.deepEqual(result, {
      text: "",
      path: "/tmp/notes.md",
      sha256: sha256of(""),
      source: "file",
    });
  });

  it("accepts a file source at exactly MAX_CONTEXT_BYTES", async () => {
    const buffer = Buffer.alloc(MAX_CONTEXT_BYTES, 0x61);
    const result = await readContextSource({ file: "/tmp/notes.md" }, fakeFileIo(buffer));
    assert.strictEqual(result.text.length, MAX_CONTEXT_BYTES);
    assert.strictEqual(result.sha256, sha256of(buffer.toString("utf8")));
  });

  it("rejects a file source one byte over the cap with the numeric limit", async () => {
    const buffer = Buffer.alloc(MAX_CONTEXT_BYTES + 1, 0x61);
    await assert.rejects(
      readContextSource({ file: "/tmp/notes.md" }, fakeFileIo(buffer)),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.strictEqual(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /262144/);
        assert.match(error.message, /262145/);
        return true;
      },
    );
  });

  it("accepts stdin at exactly the cap and rejects one byte over", async () => {
    const atCap = await readContextSource(
      { stdin: true },
      fakeStdinIo("a".repeat(MAX_CONTEXT_BYTES)),
    );
    assert.strictEqual(atCap.text.length, MAX_CONTEXT_BYTES);
    assert.strictEqual(atCap.source, "stdin");

    await assert.rejects(
      readContextSource({ stdin: true }, fakeStdinIo("a".repeat(MAX_CONTEXT_BYTES + 1))),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.strictEqual(error.code, "VALIDATION_ERROR");
        return true;
      },
    );
  });
});

describe("readContextSource binary heuristic", () => {
  it("rejects a NUL byte within the first 8192 bytes as binary", async () => {
    const buffer = Buffer.alloc(64, 0x61);
    buffer[8] = 0;
    await assert.rejects(
      readContextSource({ file: "/tmp/notes.md" }, fakeFileIo(buffer)),
      (error) => {
        assert.ok(error instanceof FileError);
        assert.strictEqual(error.code, "FILE_ERROR");
        assert.match(error.message, /binary/);
        return true;
      },
    );
  });

  it("allows a NUL byte past the first 8192 bytes", async () => {
    const buffer = Buffer.alloc(8300, 0x61);
    buffer[8250] = 0;
    const result = await readContextSource({ file: "/tmp/notes.md" }, fakeFileIo(buffer));
    assert.strictEqual(result.text.length, 8300);
    assert.ok(result.text.includes("\u0000"));
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  });

  it("rejects binary stdin input", async () => {
    await assert.rejects(
      readContextSource({ stdin: true }, fakeStdinIo("abc\u0000def")),
      (error) => {
        assert.ok(error instanceof FileError);
        assert.strictEqual(error.code, "FILE_ERROR");
        assert.match(error.message, /binary/);
        return true;
      },
    );
  });
});

describe("readContextSource content and shape", () => {
  it("returns the decoded text, its sha256, and the file path for file sources", async () => {
    const text = "# Hello\nWhat is this?\n";
    const result = await readContextSource(
      { file: "/tmp/notes.md" },
      fakeFileIo(Buffer.from(text, "utf8")),
    );
    assert.strictEqual(result.text, text);
    assert.strictEqual(result.path, "/tmp/notes.md");
    assert.strictEqual(result.source, "file");
    assert.strictEqual(result.sha256, sha256of(text));
  });

  it("returns source stdin with no path for stdin sources", async () => {
    const result = await readContextSource({ stdin: true }, fakeStdinIo("# Hi\nQuestion?"));
    assert.strictEqual(result.text, "# Hi\nQuestion?");
    assert.strictEqual(result.source, "stdin");
    assert.strictEqual(result.path, undefined);
    assert.strictEqual(result.sha256, sha256of("# Hi\nQuestion?"));
  });
});

describe("readContextSource file errors (real fs, tmpdir only)", () => {
  it("maps ENOENT to FILE_ERROR naming the operation and path", async (t) => {
    await withTempDir(t, async (dir) => {
      const missing = path.join(dir, "missing.md");
      await assert.rejects(readContextSource({ file: missing }, realFileIo), (error) => {
        assert.ok(error instanceof FileError);
        assert.strictEqual(error.code, "FILE_ERROR");
        assert.ok(error.message.includes(missing));
        return true;
      });
    });
  });

  it("maps EISDIR to FILE_ERROR", async (t) => {
    await withTempDir(t, async (dir) => {
      await assert.rejects(readContextSource({ file: dir }, realFileIo), (error) => {
        assert.ok(error instanceof FileError);
        assert.strictEqual(error.code, "FILE_ERROR");
        return true;
      });
    });
  });

  it("maps EACCES to FILE_ERROR", { skip: skipPermissionTest }, async (t) => {
    await withTempDir(t, async (dir) => {
      const locked = path.join(dir, "noperm.md");
      await fs.writeFile(locked, "contents", "utf8");
      await fs.chmod(locked, 0o000);
      await assert.rejects(readContextSource({ file: locked }, realFileIo), (error) => {
        assert.ok(error instanceof FileError);
        assert.strictEqual(error.code, "FILE_ERROR");
        return true;
      });
    });
  });
});

describe("determinism", () => {
  const fixture = [
    "# Planning Notes",
    "What is the roadmap?",
    "## Architecture",
    "architecture again?",
    "### architecture",
    "## Caching & Rate Limits",
    "## Trailing backslash\\",
    `## ${"l".repeat(70)}`,
    "How does OAuth2 token refresh work?",
    "x".repeat(199) + "?",
    "duplicate?",
    "duplicate?",
    "setext below",
    "===",
  ].join("\n");

  it("produces deep-equal output across repeated parses", () => {
    const first = parseContextText(fixture);
    const second = parseContextText(fixture);
    assert.deepEqual(first, second);
    assert.deepEqual(deriveSubQueries(fixture), deriveSubQueries(fixture));
    assert.deepEqual(buildBiasAppend("q", first.terms), buildBiasAppend("q", second.terms));
  });

  it("ships the stopword list as a frozen const", () => {
    assert.ok(Object.isFrozen(STOPWORDS));
    assert.strictEqual(STOPWORDS.length, 57);
    for (const word of ["the", "about", "where", "without", "through"]) {
      assert.ok(STOPWORDS.includes(word), `stopword list must include ${word}`);
    }
    assert.ok(!STOPWORDS.includes("notes"));
  });
});
