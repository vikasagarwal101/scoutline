/**
 * Unit tests for the EvidencePack schema decoder (T1,
 * docs/plans/investigate-pipeline — PRD AC-6, ADR-0013 §7).
 *
 * Covers:
 *   - round-trip: a hand-built valid pack decodes deep-equal to itself
 *   - fail-closed rows: wrong schemaVersion / non-string contentSha256 /
 *     charRange not [number, number] each decode to null (never garbage,
 *     never a throw)
 *   - hash recomputation pin: every fixture contentSha256 equals a
 *     freshly computed SHA-256 of its paired content string, and the
 *     decoder accepts that shape; malformed hash shapes (uppercase hex,
 *     short, non-hex chars) are rejected (hex-shape ruling: enforced at
 *     decode — the pin's strength comes from recompute-in-fixture +
 *     shape gate, full recomputation-vs-content binding lands with
 *     assembly in T5)
 *   - determinism: decode run twice deep-equal
 *
 * 100% offline: no filesystem, no providers; fixture-only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decodeInvestigationPack,
  isValidContentSha256,
} from "../dist/capabilities/investigation.js";

function sha256of(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Paired content strings: fixture hashes are recomputed from these.
const SOURCE_A_CONTENT =
  "The fusion merge ranks candidates by reciprocal rank. " +
  "Clusters collapse near-duplicate stories into one representative.";
const SOURCE_B_CONTENT = "Reader cache entries decode through a total function.";

/**
 * Build a minimal valid EvidencePack. contentSha256 values are freshly
 * computed over the paired content constants (recomputation pin).
 */
function buildValidPack() {
  return {
    schemaVersion: 1,
    question: "How does the investigate pipeline merge evidence?",
    subQueries: [
      "How does the investigate pipeline merge evidence?",
      "investigate pipeline merge evidence overview",
    ],
    sources: [
      {
        url: "https://example.com/fusion",
        finalUrl: "https://example.com/fusion",
        title: "Fusion merge notes",
        fetchedAt: "2026-09-20T00:00:00.000Z",
        provider: "tavily",
        contentFormat: "markdown",
        contentSha256: sha256of(SOURCE_A_CONTENT),
        passages: [
          {
            quote: "The fusion merge ranks candidates by reciprocal rank.",
            charRange: [0, 54],
          },
        ],
      },
      {
        url: "https://example.com/reader",
        finalUrl: "https://example.com/reader",
        title: null,
        fetchedAt: "2026-09-20T00:01:00.000Z",
        provider: "zai",
        contentFormat: "text",
        contentSha256: sha256of(SOURCE_B_CONTENT),
        passages: [],
      },
    ],
    coverage: {
      subQueries: 2,
      armsUsed: 2,
      sourcesConsidered: 7,
      sourcesRead: 2,
      cacheHits: 1,
      unread: [{ url: "https://example.com/nosupplier", reason: "no-reader-supplier" }],
    },
  };
}

describe("decodeInvestigationPack — round-trip", () => {
  it("decodes a hand-built valid pack deep-equal to the input", () => {
    const pack = buildValidPack();
    assert.deepEqual(decodeInvestigationPack(pack), pack);
  });

  it("decodes deterministically — two runs deep-equal", () => {
    const pack = buildValidPack();
    assert.deepEqual(decodeInvestigationPack(pack), decodeInvestigationPack(pack));
  });
});

describe("decodeInvestigationPack — hash recomputation pin", () => {
  it("every fixture contentSha256 equals freshly computed SHA-256 of paired content", () => {
    const pack = buildValidPack();
    assert.equal(pack.sources[0].contentSha256, sha256of(SOURCE_A_CONTENT));
    assert.equal(pack.sources[1].contentSha256, sha256of(SOURCE_B_CONTENT));
    assert.notEqual(decodeInvestigationPack(pack), null);
  });

  it("rejects uppercase hex", () => {
    const pack = buildValidPack();
    pack.sources[0].contentSha256 = sha256of(SOURCE_A_CONTENT).toUpperCase();
    assert.equal(decodeInvestigationPack(pack), null);
  });

  it("rejects a 63-char hash", () => {
    const pack = buildValidPack();
    pack.sources[0].contentSha256 = sha256of(SOURCE_A_CONTENT).slice(0, 63);
    assert.equal(decodeInvestigationPack(pack), null);
  });

  it("rejects non-hex characters", () => {
    const pack = buildValidPack();
    pack.sources[0].contentSha256 = "z".repeat(64);
    assert.equal(decodeInvestigationPack(pack), null);
  });
});

describe("decodeInvestigationPack — fail closed", () => {
  it("rejects non-object values", () => {
    for (const bad of [null, undefined, 1, "pack", [], true]) {
      assert.equal(decodeInvestigationPack(bad), null);
    }
  });

  it("rejects schemaVersion !== literal 1", () => {
    for (const version of [2, 0, "1", null, 1.5]) {
      const pack = buildValidPack();
      pack.schemaVersion = version;
      assert.equal(decodeInvestigationPack(pack), null, `schemaVersion=${String(version)}`);
    }
    const missing = buildValidPack();
    delete missing.schemaVersion;
    assert.equal(decodeInvestigationPack(missing), null);
  });

  it("rejects non-string contentSha256", () => {
    for (const hash of [42, null, { hex: "ab" }, [], true, undefined]) {
      const pack = buildValidPack();
      pack.sources[0].contentSha256 = hash;
      assert.equal(decodeInvestigationPack(pack), null, `hash=${JSON.stringify(hash)}`);
    }
  });

  it("rejects charRange not [number, number]", () => {
    for (const range of [
      [0, 54, 99],
      [0],
      ["0", 54],
      [0, "54"],
      [Number.NaN, 54],
      [0, Number.POSITIVE_INFINITY],
      "0-54",
      null,
    ]) {
      const pack = buildValidPack();
      pack.sources[0].passages[0].charRange = range;
      assert.equal(decodeInvestigationPack(pack), null, `charRange=${JSON.stringify(range)}`);
    }
    const noRange = buildValidPack();
    delete noRange.sources[0].passages[0].charRange;
    assert.equal(decodeInvestigationPack(noRange), null);
  });

  it("rejects structural gaps — missing question/subQueries/sources/coverage", () => {
    for (const key of ["question", "subQueries", "sources", "coverage"]) {
      const pack = buildValidPack();
      delete pack[key];
      assert.equal(decodeInvestigationPack(pack), null, `missing ${key}`);
    }
  });

  it("rejects malformed nested rows", () => {
    const noQuote = buildValidPack();
    delete noQuote.sources[0].passages[0].quote;
    assert.equal(decodeInvestigationPack(noQuote), null);

    const badSubQuery = buildValidPack();
    badSubQuery.subQueries = ["ok", 42];
    assert.equal(decodeInvestigationPack(badSubQuery), null);

    const badCoverage = buildValidPack();
    badCoverage.coverage.sourcesRead = "2";
    assert.equal(decodeInvestigationPack(badCoverage), null);

    const badUnread = buildValidPack();
    badUnread.coverage.unread = [{ url: 1, reason: "x" }];
    assert.equal(decodeInvestigationPack(badUnread), null);

    const badTitle = buildValidPack();
    badTitle.sources[0].title = 7;
    assert.equal(decodeInvestigationPack(badTitle), null);

    const badFormat = buildValidPack();
    badFormat.sources[0].contentFormat = "html";
    assert.equal(decodeInvestigationPack(badFormat), null);

    const badFetchedAt = buildValidPack();
    badFetchedAt.sources[0].fetchedAt = 0;
    assert.equal(decodeInvestigationPack(badFetchedAt), null);
  });

  it("never throws on adversarial input", () => {
    const weird = buildValidPack();
    weird.sources[0].passages[0].charRange = [0, 54];
    weird.coverage = new Proxy({}, { get: () => 1 });
    assert.equal(decodeInvestigationPack(weird), null);
  });

  it("never throws on a THROWING getter — total decode returns null (PR #264 F1)", () => {
    const boom = buildValidPack();
    Object.defineProperty(boom, "subQueries", {
      get() {
        throw new Error("getter boom");
      },
    });
    assert.equal(decodeInvestigationPack(boom), null);
  });

  it("never throws on a throwing Proxy get trap — total decode returns null (PR #264 F1)", () => {
    const inner = buildValidPack();
    const trapped = new Proxy(inner, {
      get(target, prop) {
        if (prop === "sources") throw new Error("proxy trap boom");
        return target[prop];
      },
    });
    assert.equal(decodeInvestigationPack(trapped), null);
  });

  it("rejects charRange invariant violations — negative, fractional, reversed, empty (PR #264 F2)", () => {
    for (const bad of [
      [-1, 5], // negative start
      [1.5, 5], // fractional
      [5, 3], // reversed (end < start)
      [3, 3], // empty range (start === end)
    ]) {
      const pack = buildValidPack();
      pack.sources[0].passages[0].charRange = bad;
      assert.equal(
        decodeInvestigationPack(pack),
        null,
        `charRange ${JSON.stringify(bad)} must fail closed`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// investigate-verify lane T2 — additive `verify` block decode branch
// (DESIGN D4, PRD AC-6). Present → validated row-by-row, malformed rows
// fail closed (null). Absent → the canonical subset unchanged (the
// question-mode byte-identity precondition). schemaVersion stays 1.
// ---------------------------------------------------------------------------

function buildValidVerifyBlock() {
  return {
    statement: "Alpha reactors process data quietly. Beta turbines never finish work.",
    claims: [
      {
        text: "Alpha reactors process data quietly.",
        verdict: "corroborated",
        negationCues: 0,
        evidence: [{ sourceIndex: 0, passageIndex: 0 }],
      },
      {
        text: "Beta turbines never finish work.",
        verdict: "contradicted",
        negationCues: 1,
        evidence: [
          { sourceIndex: 0, passageIndex: 1 },
          { sourceIndex: 1, passageIndex: 0 },
        ],
      },
    ],
  };
}

describe("decodeInvestigationPack — verify block (additive, schemaVersion 1)", () => {
  it("absent verify → decoded pack carries NO verify key (question-mode canonical subset)", () => {
    const pack = buildValidPack();
    const decoded = decodeInvestigationPack(pack);
    assert.notEqual(decoded, null);
    assert.ok(!("verify" in decoded), "no verify key on a question-mode pack");
    // Deep-equal the pre-feature shape exactly (canonical subset).
    assert.deepEqual(decoded, {
      schemaVersion: 1,
      question: pack.question,
      subQueries: pack.subQueries,
      sources: decoded.sources,
      coverage: pack.coverage,
    });
  });

  it("present + valid → round-trips verbatim", () => {
    const pack = { ...buildValidPack(), verify: buildValidVerifyBlock() };
    const decoded = decodeInvestigationPack(pack);
    assert.notEqual(decoded, null);
    assert.deepEqual(decoded.verify, buildValidVerifyBlock());
  });

  it("schemaVersion stays 1 — a verify-bearing pack is NOT a version bump", () => {
    const pack = { ...buildValidPack(), verify: buildValidVerifyBlock() };
    assert.strictEqual(decodeInvestigationPack(pack).schemaVersion, 1);
  });

  it("unresolved verdict with empty evidence decodes (a sad claim is valid)", () => {
    const pack = { ...buildValidPack() };
    pack.verify = buildValidVerifyBlock();
    pack.verify.claims[0].verdict = "unresolved";
    pack.verify.claims[0].evidence = [];
    const decoded = decodeInvestigationPack(pack);
    assert.notEqual(decoded, null);
    assert.strictEqual(decoded.verify.claims[0].verdict, "unresolved");
  });

  it("bogus verdict enum → null (fail closed)", () => {
    for (const bogus of ["BUSTED", "supported", "", "CORROBORATED", null, 1]) {
      const pack = { ...buildValidPack(), verify: buildValidVerifyBlock() };
      pack.verify.claims[0].verdict = bogus;
      assert.equal(
        decodeInvestigationPack(pack),
        null,
        `verdict=${JSON.stringify(bogus)} must fail closed`,
      );
    }
  });

  it("missing verdict / text / negationCues / evidence → null", () => {
    for (const key of ["text", "verdict", "negationCues", "evidence"]) {
      const pack = { ...buildValidPack(), verify: buildValidVerifyBlock() };
      delete pack.verify.claims[0][key];
      assert.equal(decodeInvestigationPack(pack), null, `missing ${key}`);
    }
  });

  it("negationCues negative / fractional / non-number → null", () => {
    for (const bad of [-1, 1.5, "1", null, true, Number.POSITIVE_INFINITY]) {
      const pack = { ...buildValidPack(), verify: buildValidVerifyBlock() };
      pack.verify.claims[0].negationCues = bad;
      assert.equal(
        decodeInvestigationPack(pack),
        null,
        `negationCues=${JSON.stringify(bad)} must fail closed`,
      );
    }
  });

  it("evidence pointer shape guards: negative / fractional / string / extra keys → null", () => {
    for (const bad of [
      { sourceIndex: -1, passageIndex: 0 },
      { sourceIndex: 0, passageIndex: -1 },
      { sourceIndex: 0.5, passageIndex: 0 },
      { sourceIndex: 0, passageIndex: 1.5 },
      { sourceIndex: "0", passageIndex: 0 },
      { sourceIndex: 0 },
      { passageIndex: 0 },
      { sourceIndex: Number.NaN, passageIndex: 0 },
      [0, 0],
    ]) {
      const pack = { ...buildValidPack(), verify: buildValidVerifyBlock() };
      pack.verify.claims[0].evidence = [bad];
      assert.equal(
        decodeInvestigationPack(pack),
        null,
        `evidence=${JSON.stringify(bad)} must fail closed`,
      );
    }
  });

  it("empty claims array is valid (a statement that split to nothing)", () => {
    const pack = { ...buildValidPack() };
    pack.verify = { statement: "…", claims: [] };
    const decoded = decodeInvestigationPack(pack);
    assert.notEqual(decoded, null);
    assert.deepEqual(decoded.verify.claims, []);
  });

  it("verify present but malformed at the BLOCK level → null", () => {
    for (const bad of [null, 1, "block", [], { statement: "s" }, { claims: [] }]) {
      const pack = { ...buildValidPack(), verify: bad };
      assert.equal(
        decodeInvestigationPack(pack),
        null,
        `verify=${JSON.stringify(bad)} must fail closed`,
      );
    }
  });

  it("claim text must be a non-empty string; claims must be an array", () => {
    const emptyText = { ...buildValidPack(), verify: buildValidVerifyBlock() };
    emptyText.verify.claims[0].text = "";
    assert.equal(decodeInvestigationPack(emptyText), null);

    const notArray = { ...buildValidPack(), verify: buildValidVerifyBlock() };
    notArray.verify.claims = {};
    assert.equal(decodeInvestigationPack(notArray), null);
  });

  it("deterministic: verify-bearing decode run twice deep-equal", () => {
    const pack = { ...buildValidPack(), verify: buildValidVerifyBlock() };
    assert.deepEqual(decodeInvestigationPack(pack), decodeInvestigationPack(pack));
  });
});

describe("isValidContentSha256", () => {
  it("accepts 64-char lowercase hex", () => {
    assert.equal(isValidContentSha256(sha256of("x")), true);
    assert.equal(isValidContentSha256("0".repeat(64)), true);
  });

  it("rejects everything else", () => {
    for (const bad of [
      "",
      "ABC".repeat(22).slice(0, 64),
      "g".repeat(64),
      "a".repeat(63),
      42,
      null,
    ]) {
      assert.equal(isValidContentSha256(bad), false);
    }
  });
});
