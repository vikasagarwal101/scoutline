/**
 * Unit tests for the investigate planner (investigate-pipeline lane,
 * Ticket T2; docs/plans/investigate-pipeline DESIGN.md D2).
 *
 * Covers:
 *   - template tier determinism table: fixed questions → exact
 *     sub-query arrays (original first, key-terms join, three aspect
 *     templates, dedupe, cap 5, empty-terms degradation)
 *   - explicit pipe tier: --merge grammar rows incl. escaped `\|`,
 *     pipes beating --context with the override notice
 *   - context tier: deriveSubQueries output verbatim (no original
 *     prepend), zero-derivation degradation to [original]
 *   - byte-stable determinism (run twice, deep-equal)
 *
 * 100% offline: loadContextText is injected — no filesystem anywhere.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planSubQueries } from "../dist/lib/investigate-planner.js";
import { deriveSubQueries } from "../dist/lib/context-file.js";

function templateDeps() {
  return {
    loadContextText: async () => {
      throw new Error("loadContextText must not be called without --context");
    },
  };
}

function contextDeps(text) {
  const calls = [];
  return {
    deps: {
      loadContextText: async (filePath) => {
        calls.push(filePath);
        return text;
      },
    },
    calls,
  };
}

describe("planSubQueries template tier", () => {
  it("multi-word question with stopwords → exact 5-row array", async () => {
    const result = await planSubQueries(
      { query: "How does the caching layer work in scoutline?" },
      templateDeps(),
    );
    assert.deepEqual(result.subQueries, [
      "How does the caching layer work in scoutline?",
      "caching layer work scoutline",
      "caching layer work scoutline overview",
      "caching layer work scoutline evidence",
      "caching layer work scoutline criticism",
    ]);
    assert.equal(result.tier, "template");
    assert.equal(result.notice, undefined);
  });

  it("key-terms join equal to the original dedupes to one copy", async () => {
    const result = await planSubQueries(
      { query: "rust async runtime" },
      templateDeps(),
    );
    assert.deepEqual(result.subQueries, [
      "rust async runtime",
      "rust async runtime overview",
      "rust async runtime evidence",
      "rust async runtime criticism",
    ]);
  });

  it("five-candidate question hits the cap exactly", async () => {
    const result = await planSubQueries(
      { query: "What is the QUIC handshake migration protocol?" },
      templateDeps(),
    );
    // tokens: what(stop) the(stop) quic(4) handshake(9) migration(9)
    // protocol(8) is(2, short) → join "quic handshake migration protocol"
    assert.deepEqual(result.subQueries, [
      "What is the QUIC handshake migration protocol?",
      "quic handshake migration protocol",
      "quic handshake migration protocol overview",
      "quic handshake migration protocol evidence",
      "quic handshake migration protocol criticism",
    ]);
    assert.equal(result.subQueries.length, 5);
  });

  it("all-stopword/short-token question degrades to original only", async () => {
    const result = await planSubQueries(
      { query: "What is it?" },
      templateDeps(),
    );
    assert.deepEqual(result.subQueries, ["What is it?"]);
    assert.equal(result.tier, "template");
  });

  it("is byte-stable across runs", async () => {
    const query = "How does the caching layer work in scoutline?";
    const first = await planSubQueries({ query }, templateDeps());
    const second = await planSubQueries({ query }, templateDeps());
    assert.deepEqual(first, second);
  });
});

describe("planSubQueries explicit pipe tier", () => {
  it("splits on unescaped pipes, trimming and dropping empties", async () => {
    const result = await planSubQueries(
      { query: "alpha | beta || gamma " },
      templateDeps(),
    );
    assert.deepEqual(result.subQueries, ["alpha", "beta", "gamma"]);
    assert.equal(result.tier, "explicit");
  });

  it("respects the escaped literal pipe (\\| does not split)", async () => {
    const result = await planSubQueries(
      { query: "rust\\|async | news" },
      templateDeps(),
    );
    assert.deepEqual(result.subQueries, ["rust|async", "news"]);
    assert.equal(result.tier, "explicit");
  });

  it("splits every unescaped pipe in a multi-pipe query", async () => {
    const result = await planSubQueries(
      { query: "alpha|beta|gamma|delta" },
      templateDeps(),
    );
    assert.deepEqual(result.subQueries, ["alpha", "beta", "gamma", "delta"]);
  });

  it("all-fragments-empty is the --merge grammar fail-loud case", async () => {
    await assert.rejects(
      planSubQueries({ query: " | | " }, templateDeps()),
      /at least one non-empty/,
    );
  });

  it("pipes beat --context with the override notice and no context read", async () => {
    const { deps, calls } = contextDeps("# Notes\n## Alpha");
    const result = await planSubQueries(
      { query: "one|two", contextFile: "/tmp/notes.md" },
      deps,
    );
    assert.equal(result.tier, "explicit");
    assert.deepEqual(result.subQueries, ["one", "two"]);
    assert.match(result.notice ?? "", /--context/);
    assert.deepEqual(calls, []);
  });
});

describe("planSubQueries context tier", () => {
  const fixture = [
    "# Context Notes",
    "Some prose line.",
    "## How does the cache work?",
    "What is the retry policy?",
    "",
    "## Sources",
  ].join("\n");

  it("returns deriveSubQueries output verbatim, no original prepend", async () => {
    const { deps, calls } = contextDeps(fixture);
    const result = await planSubQueries(
      { query: "the original question", contextFile: "ctx.md" },
      deps,
    );
    assert.equal(result.tier, "context");
    assert.equal(result.notice, undefined);
    assert.deepEqual(result.subQueries, [...deriveSubQueries(fixture)]);
    assert.ok(!result.subQueries.includes("the original question"));
    assert.deepEqual(calls, ["ctx.md"]);
  });

  it("zero derivation degrades to [original] (tier stays context)", async () => {
    const { deps } = contextDeps("plain prose, no headings or questions");
    const result = await planSubQueries(
      { query: "the original question", contextFile: "ctx.md" },
      deps,
    );
    assert.equal(result.tier, "context");
    assert.deepEqual(result.subQueries, ["the original question"]);
  });
});
