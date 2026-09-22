/**
 * Unit tests for deterministic passage extraction (T3,
 * docs/plans/investigate-pipeline — PRD AC-5, DESIGN D4).
 *
 * Covers:
 *   - hand-marked fixture: sentence windows containing >= 1 term
 *     (whole-word, case-folded) become passages in document order;
 *     newline boundaries split windows too
 *   - word-boundary negative: a term inside a larger word ("rust" in
 *     "frustrating"/"trust"/"rustic") never matches
 *   - case-folded positive: "RUST" in content matches term "rust";
 *     the quote stays verbatim (original casing preserved)
 *   - adjacency: two consecutive matching windows stay SEPARATE
 *     passages (never merged)
 *   - cap: 6 matching windows yield exactly the FIRST five in
 *     document order
 *   - quote dedupe: identical quotes collapse to the first encounter
 *   - empty term set -> [] (valid, not an error)
 *   - round-trip pin: content.slice(...charRange) === quote for EVERY
 *     passage across every fixture
 *   - determinism: two runs deep-equal
 *
 * Boundary-char ownership (D4 decision): the terminator that ended a
 * window (`.`/`!`/`?`/`\n`) BELONGS to the window; the run of spaces
 * after it belongs to neither window (the next window starts at the
 * first non-space character). The exact-quote assertions below pin
 * this choice.
 *
 * 100% offline: no filesystem, no providers; fixture-only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPassages } from "../dist/lib/investigate-extract.js";

// ---------------------------------------------------------------------------
// Hand-marked fixture. Every segment ends in a window terminator
// (". " or "\n"), so each segment IS exactly one window. Expected
// windows are computed by cursor math over these literal segments
// (hand-marked boundaries), with two raw-number spot checks below.
// Segments marked true contain a whole-word term; false rows are
// near-miss negatives ("frustrating" embeds "rust" mid-word).
// ---------------------------------------------------------------------------
const SEGMENTS = [
  ["Rust ships fearless concurrency. ", true], // window [0, 33)
  ["The frustrating delay annoyed everyone. ", false], // [33, 73) — substring, not whole word
  ["Rust and Go differ here.\n", true], // [73, 98) — newline-terminated window
  ["Go compiles fast. ", false], // [98, 116)
  ["Rust compiles slowly but surely. ", true], // [116, 149)
  ["Rust compiles slowly but surely.", true], // [149, 181) — duplicate quote -> deduped
];
const CONTENT = SEGMENTS.map(([seg]) => seg).join("");

function expectedWindows() {
  const windows = [];
  let cursor = 0;
  for (const [seg, matches] of SEGMENTS) {
    // The terminator char ends the window; a trailing space run after
    // it is separator (belongs to neither window).
    let end = cursor + seg.length;
    while (end > cursor && (seg[end - cursor - 1] === " " || seg[end - cursor - 1] === "\t")) {
      end -= 1;
    }
    if (matches) {
      windows.push({ quote: seg.slice(0, end - cursor), charRange: [cursor, end] });
    }
    cursor += seg.length;
  }
  return windows;
}

describe("extractPassages", () => {
  it("hand-marked fixture: matched sentence windows become passages in document order", () => {
    // 4 matching windows, but the last two share a quote -> 3 passages
    // after dedupe (dedupe row below asserts that independently).
    const passages = extractPassages({ content: CONTENT, terms: ["rust"] });
    // Dedupe collapses the twin "Rust compiles..." windows.
    const expected = expectedWindows().slice(0, 3);
    assert.deepEqual(passages, expected);
    // Raw-number spot checks (hand-computed offsets, not cursor math):
    // first window [0, 32) — terminator `.` owned, trailing space not;
    // the newline-terminated window [73, 98) — `\n` owned.
    assert.deepEqual(passages[0].charRange, [0, 32]);
    assert.equal(passages[0].quote, "Rust ships fearless concurrency.");
    assert.deepEqual(passages[1].charRange, [73, 98]);
    assert.equal(passages[1].quote, "Rust and Go differ here.\n");
  });

  it("word-boundary negative: term inside a larger word never matches", () => {
    // "trust", "rustiness", "frustrating", "rustic" all embed "rust"
    // without a word boundary -> no passages.
    const passages = extractPassages({
      content: "This trust in rustiness was frustrating and rustic. Truly.",
      terms: ["rust"],
    });
    assert.deepEqual(passages, []);
  });

  it("case-folded positive: term matches any casing, quote stays verbatim", () => {
    const content = "Crab diets delight RUST enthusiasts.";
    const passages = extractPassages({ content, terms: ["rust"] });
    assert.equal(passages.length, 1);
    assert.equal(passages[0].quote, "Crab diets delight RUST enthusiasts.");
    assert.deepEqual(passages[0].charRange, [0, content.length]);
  });

  it("adjacent matching windows do NOT merge into one passage", () => {
    const content = "Alpha rust here. Beta rust there. Gamma quiet.";
    const passages = extractPassages({ content, terms: ["rust"] });
    assert.equal(passages.length, 2);
    assert.deepEqual(
      passages.map((p) => p.quote),
      ["Alpha rust here.", "Beta rust there."],
    );
    assert.deepEqual(passages[0].charRange, [0, 16]);
    assert.deepEqual(passages[1].charRange, [17, 33]);
  });

  it("cap: 6 matching windows yield exactly the first five in document order", () => {
    const content =
      "Rust one. Rust two. Rust three. Rust four. Rust five. Rust six.";
    const passages = extractPassages({ content, terms: ["rust"] });
    assert.equal(passages.length, 5);
    assert.deepEqual(
      passages.map((p) => p.quote),
      [
        "Rust one.",
        "Rust two.",
        "Rust three.",
        "Rust four.",
        "Rust five.",
      ],
    );
  });

  it("duplicate quotes dedupe to the first encounter (first charRange wins)", () => {
    const content = "Rust again. More text. Rust again.";
    const passages = extractPassages({ content, terms: ["rust"] });
    assert.equal(passages.length, 1);
    assert.equal(passages[0].quote, "Rust again.");
    assert.deepEqual(passages[0].charRange, [0, 11]);
  });

  it("empty term set yields [] (valid, not an error); empty content too", () => {
    assert.deepEqual(extractPassages({ content: "Rust here.", terms: [] }), []);
    assert.deepEqual(
      extractPassages({ content: "Rust here.", terms: ["  ", ""] }),
      [],
    );
    assert.deepEqual(extractPassages({ content: "", terms: ["rust"] }), []);
  });

  it("terms are normalized: duplicates, casing and surrounding spaces collapse", () => {
    const passages = extractPassages({
      content: "Rust one. Quiet. rust two.",
      terms: ["RUST", " rust ", "Rust"],
    });
    assert.equal(passages.length, 2);
    assert.deepEqual(
      passages.map((p) => p.quote),
      ["Rust one.", "rust two."],
    );
  });

  it("round-trip pin: content.slice(...charRange) === quote for every passage", () => {
    const fixtures = [
      { content: CONTENT, terms: ["rust"] },
      { content: "Alpha rust here. Beta rust there. Gamma quiet.", terms: ["rust"] },
      { content: "Rust one. Rust two. Rust three. Rust four. Rust five. Rust six.", terms: ["rust"] },
      { content: "Rust again. More text. Rust again.", terms: ["rust"] },
      { content: "Wow! Really? Yes.\nNext line mentions RUST here. Tail", terms: ["rust"] },
    ];
    for (const { content, terms } of fixtures) {
      for (const passage of extractPassages({ content, terms })) {
        assert.equal(
          content.slice(passage.charRange[0], passage.charRange[1]),
          passage.quote,
        );
      }
    }
  });

  it("determinism: two runs deep-equal", () => {
    const a = extractPassages({ content: CONTENT, terms: ["rust", "go"] });
    const b = extractPassages({ content: CONTENT, terms: ["rust", "go"] });
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Issue #271 — CJK terms match inside unspaced CJK content. The ASCII
// whole-word boundary ([^\p{L}\p{N}_]) can never fire between CJK
// chars, so non-ASCII terms match as substrings; ASCII terms keep the
// boundary guard even inside CJK content.
// ---------------------------------------------------------------------------
describe("extractPassages (Unicode/CJK, issue #271)", () => {
  it("a CJK term matches inside unspaced CJK content", () => {
    // Window terminators stay ASCII (.`!?`/newline) — ideographic 。
    // is not a terminator, so segments here use ". " separators.
    const passages = extractPassages({ content: "東京は人口が多い. 東京は速い.", terms: ["東京"] });
    assert.deepEqual(passages.map((p) => p.quote), ["東京は人口が多い.", "東京は速い."]);
  });

  it("an ASCII term inside CJK text still needs word boundaries (no mid-run match)", () => {
    // "ai" is not a standalone word here — 境界 chars are CJK letters.
    const passages = extractPassages({ content: "aiによる分析.", terms: ["ai"] });
    assert.deepEqual(passages, []);
  });

  it("round-trip pin holds for CJK passages (slice === quote)", () => {
    const content = "東京は速い. 関連記事.";
    for (const p of extractPassages({ content, terms: ["速い"] })) {
      assert.strictEqual(content.slice(p.charRange[0], p.charRange[1]), p.quote);
    }
  });
});
