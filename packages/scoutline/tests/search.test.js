/**
 * Search command + global --provider selection (P2-05).
 *
 * The search command now receives an injected SearchCapability and
 * shared execution dependencies instead of constructing ZaiMcpClient.
 * These tests:
 *   - Exercise merge, escaped-pipe, dedupe, occurrence, truncation,
 *     projection, and presentation against a fake Adapter.
 *   - Assert count is NOT forwarded to the Adapter request, NOT part of
 *     cache identity, and applied AFTER normalization (replacing the
 *     P0-02 transitional count assertion).
 *   - Assert MiniMax rejects unsupported controls before SDK access.
 *   - Cover global --provider parsing (before/after the Search token,
 *     environment fallback, explicit precedence, default Z.AI, invalid).
 *   - Assert Reader/repo/tools/code ignore an invalid SCOUTLINE_PROVIDER.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { search, SEARCH_HELP } from "../dist/commands/search.js";
import { main } from "../dist/index.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { readFixture } from "./helpers/fixtures.js";

// ---------------------------------------------------------------------------
// Fake SearchCapability + execution dependencies
// ---------------------------------------------------------------------------

/**
 * Build a fake SearchCapability that returns scripted results keyed by
 * query, so merge (parallel sub-queries) is deterministic regardless of
 * invocation order. Records every invoke request and cacheIdentity call.
 */
function makeFakeCapability(resultsByQuery = {}, { validate } = {}) {
  const invokes = [];
  const identities = [];
  const capability = {
    validate(request) {
      if (typeof validate === "function") validate(request);
    },
    cacheIdentity(request, compat) {
      const identity = {
        provider: "zai",
        capability: "search",
        credentialFingerprint: "fake-fingerprint",
        request: {
          query: request.query,
          ...(request.controls ? { controls: request.controls } : {}),
        },
        legacyCandidates: [],
      };
      identities.push({ request, compat, identity });
      return identity;
    },
    async invoke(request) {
      invokes.push(request);
      return resultsByQuery[request.query] ?? [];
    },
  };
  return { capability, invokes, identities };
}

/** In-memory ResponseCache + no-op sleep/random for deterministic execution. */
function makeExecDeps(capability) {
  const store = new Map();
  return {
    capability,
    cache: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    sleep: async () => {},
    random: () => 0.5,
  };
}

function makeContext() {
  const notices = [];
  return {
    context: {
      stdinIsTTY: false,
      readStdin: async () => "",
      notice: (msg) => notices.push(msg),
    },
    notices,
  };
}

/** Shorthand: run search with a fake capability backed by resultsByQuery. */
async function runSearch(query, options, resultsByQuery) {
  const fake = makeFakeCapability(resultsByQuery);
  const { context, notices } = makeContext();
  const result = await search(query, options, makeExecDeps(fake.capability), context);
  return { result, fake, notices };
}

/** Convert a normalized SearchSource to the command's FormattedResult shape. */
function src(title, url, summary, extra = {}) {
  return { title, url, summary, ...extra };
}

// ---------------------------------------------------------------------------
// Rank assignment and field projection
// ---------------------------------------------------------------------------

describe("search command — rank assignment and field projection", () => {
  it("assigns ranks starting at 1 and projects title/url/summary/source/date", async () => {
    const { result } = await runSearch(
      "alpha",
      {},
      {
        alpha: [
          src("Alpha", "https://example.com/a", "First summary", {
            source: "example.com",
            date: "2025-01-01",
          }),
          src("Beta", "https://example.com/b", "Second summary", {
            source: "example.com",
          }),
        ],
      },
    );
    assert.strictEqual(result.kind, "data");
    assert.deepStrictEqual(result.data, [
      {
        rank: 1,
        title: "Alpha",
        url: "https://example.com/a",
        summary: "First summary",
        source: "example.com",
        date: "2025-01-01",
      },
      {
        rank: 2,
        title: "Beta",
        url: "https://example.com/b",
        summary: "Second summary",
        source: "example.com",
      },
    ]);
  });

  it("results without source/date omit those keys", async () => {
    const { result } = await runSearch(
      "x",
      {},
      {
        x: [src("NoMedia", "https://e/x", "c")],
      },
    );
    assert.strictEqual(result.data[0].source, undefined);
    assert.strictEqual(result.data[0].date, undefined);
  });
});

// ---------------------------------------------------------------------------
// Summary truncation
// ---------------------------------------------------------------------------

describe("search command — summary truncation", () => {
  it("truncates summaries beyond max-summary with ellipsis", async () => {
    const { result } = await runSearch(
      "alpha",
      { maxSummary: 10 },
      {
        alpha: [src("T", "https://e/x", "x".repeat(200))],
      },
    );
    assert.ok(result.data[0].summary.length <= 10);
    assert.match(result.data[0].summary, /…$/);
  });

  it("does not truncate when max-summary is absent", async () => {
    const longText = "y".repeat(100);
    const { result } = await runSearch(
      "x",
      {},
      {
        x: [src("T", "https://e/x", longText)],
      },
    );
    assert.strictEqual(result.data[0].summary, longText);
  });
});

// ---------------------------------------------------------------------------
// Field projection
// ---------------------------------------------------------------------------

describe("search command — field projection", () => {
  it("--fields allowlist restricts the data payload to named keys", async () => {
    const { result } = await runSearch(
      "alpha",
      { fields: ["title", "url"] },
      {
        alpha: [
          src("Alpha", "https://example.com/a", "First summary", {
            source: "example.com",
          }),
        ],
      },
    );
    assert.deepStrictEqual(result.data, [{ title: "Alpha", url: "https://example.com/a" }]);
  });
});

// ---------------------------------------------------------------------------
// Text presentations
// ---------------------------------------------------------------------------

describe("search command — text presentation overrides", () => {
  const resultSet = {
    alpha: [
      src("Alpha", "https://example.com/a", "First summary", {
        source: "example.com",
      }),
      src("Beta", "https://example.com/b", "Second summary", {
        source: "example.com",
      }),
    ],
  };

  it("compact presentation is 'title — url' per line", async () => {
    const { result } = await runSearch("alpha", {}, resultSet);
    assert.strictEqual(
      result.presentations.compact,
      "Alpha — https://example.com/a\nBeta — https://example.com/b",
    );
  });

  it("markdown presentation is numbered links with summaries", async () => {
    const { result } = await runSearch("alpha", {}, resultSet);
    assert.ok(result.presentations.markdown.includes("1. [Alpha](https://example.com/a)"));
    assert.ok(result.presentations.markdown.includes("First summary"));
  });

  it("refs presentation is citation-style lines", async () => {
    const { result } = await runSearch("alpha", {}, resultSet);
    assert.ok(result.presentations.refs.includes("[1]"));
    assert.ok(result.presentations.refs.includes("Alpha — https://example.com/a"));
  });

  it("tty presentation is the human-friendly formatted block", async () => {
    const { result } = await runSearch("alpha", {}, resultSet);
    assert.ok(result.presentations.tty.includes("Alpha"));
    assert.ok(result.presentations.tty.includes("https://example.com/a"));
    assert.ok(result.presentations.tty.includes("Beta"));
  });

  it("empty results yield empty compact and markdown presentations", async () => {
    const { result } = await runSearch("alpha", {}, { alpha: [] });
    assert.deepStrictEqual(result.data, []);
    assert.strictEqual(result.presentations.compact, "");
    assert.strictEqual(result.presentations.markdown, "");
    assert.strictEqual(result.presentations.refs, "");
  });
});

// ---------------------------------------------------------------------------
// Merge: dedupe, occurrence ranking, escaped pipes, notices
// ---------------------------------------------------------------------------

describe("search command — merge: dedupe and occurrence ranking", () => {
  it("dedupes overlapping URLs and ranks by occurrence then best position", async () => {
    const { result } = await runSearch(
      "a|b|c",
      { merge: true },
      {
        a: [src("A1", "https://e/shared", "shared A"), src("A2", "https://e/only-a", "only A")],
        b: [src("B1", "https://e/shared", "shared B"), src("B2", "https://e/only-b", "only B")],
        c: [src("C1", "https://e/only-c", "only C")],
      },
    );
    const shared = result.data.find((r) => r.url === "https://e/shared");
    assert.strictEqual(shared.occurrences, 2);
    assert.strictEqual(shared.title, "A1");
    assert.strictEqual(shared.summary, "shared A");
    assert.strictEqual(result.data[0].url, "https://e/shared");
    const onlyA = result.data.find((r) => r.url === "https://e/only-a");
    assert.strictEqual(onlyA.occurrences, 1);
  });

  it("escaped pipes do not split, and empty fragments are dropped", async () => {
    // Escaped pipe keeps the literal in a single query.
    const fake1 = makeFakeCapability({ "a|b": [src("T", "https://e/x", "c")] });
    const { context: ctx1 } = makeContext();
    await search(String.raw`a\|b`, { merge: true }, makeExecDeps(fake1.capability), ctx1);
    assert.strictEqual(fake1.invokes.length, 1);
    assert.strictEqual(fake1.invokes[0].query, "a|b");

    // Empty fragments dropped -> two real sub-queries.
    const fake2 = makeFakeCapability({
      a: [src("T", "https://e/x", "c")],
      b: [src("T2", "https://e/y", "c")],
    });
    const { context: ctx2 } = makeContext();
    await search("a||b|", { merge: true }, makeExecDeps(fake2.capability), ctx2);
    assert.strictEqual(fake2.invokes.length, 2);
  });

  it("occurrence badge appears only when occurrences > 1", async () => {
    const { result } = await runSearch(
      "a|b",
      { merge: true },
      {
        a: [src("Shared", "https://e/s", "c")],
        b: [src("Shared2", "https://e/s", "c2"), src("Solo", "https://e/solo", "c3")],
      },
    );
    const shared = result.data.find((r) => r.url === "https://e/s");
    const solo = result.data.find((r) => r.url === "https://e/solo");
    assert.strictEqual(shared.occurrences, 2);
    assert.strictEqual(solo.occurrences, 1);
  });

  it("merge emits a context.notice summarizing the merge", async () => {
    const { notices } = await runSearch(
      "rust|rust tokio|rust runtime",
      { merge: true },
      {
        rust: [src("R1", "https://e/r1", "c")],
        "rust tokio": [src("R2", "https://e/r2", "c")],
        "rust runtime": [src("R3", "https://e/r3", "c")],
      },
    );
    assert.strictEqual(notices.length, 1);
    assert.match(notices[0], /merged 3 queries/);
    assert.match(notices[0], /3 unique results/);
  });
});

// ---------------------------------------------------------------------------
// Per-request invocation (no client-count/transport management in command)
// ---------------------------------------------------------------------------

describe("search command — invokes the capability once per sub-query", () => {
  it("merge invokes the capability once per sub-query (transport owned by Adapter)", async () => {
    const fake = makeFakeCapability({
      a: [src("A", "https://e/a", "c")],
      b: [src("B", "https://e/b", "c")],
      c: [src("C", "https://e/c", "c")],
    });
    const { context } = makeContext();
    await search("a|b|c", { merge: true }, makeExecDeps(fake.capability), context);
    assert.strictEqual(fake.invokes.length, 3);
  });

  it("single-query path invokes the capability exactly once", async () => {
    const fake = makeFakeCapability({ only: [src("T", "https://e/x", "c")] });
    const { context } = makeContext();
    await search("only", {}, makeExecDeps(fake.capability), context);
    assert.strictEqual(fake.invokes.length, 1);
  });

  it("all sub-query failures propagate (no silent swallowing)", async () => {
    const capability = {
      validate() {},
      cacheIdentity(r) {
        return {
          provider: "zai",
          capability: "search",
          credentialFingerprint: "fp",
          request: r,
          legacyCandidates: [],
        };
      },
      async invoke() {
        throw new Error("provider failure");
      },
    };
    const { context } = makeContext();
    let caught = null;
    try {
      await search("a|b", { merge: true }, makeExecDeps(capability), context);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /provider failure/);
  });
});

// ---------------------------------------------------------------------------
// Empty merge input
// ---------------------------------------------------------------------------

describe("search command — empty merge input throws", () => {
  it("--merge with only empty fragments throws without invoking the capability", async () => {
    const fake = makeFakeCapability({});
    const { context } = makeContext();
    let caught = null;
    try {
      await search("|||", { merge: true }, makeExecDeps(fake.capability), context);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof Error);
    assert.match(caught.message, /merge requires at least one non-empty query/);
    assert.strictEqual(fake.invokes.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Count handling (REPLACES the P0-02 transitional count assertion)
// ---------------------------------------------------------------------------

describe("search command — count is not forwarded and applied after normalization", () => {
  it("count is absent from the Adapter request and cache identity", async () => {
    const fake = makeFakeCapability({
      alpha: [
        src("A", "https://e/a", "c"),
        src("B", "https://e/b", "c"),
        src("C", "https://e/c", "c"),
      ],
    });
    const { context } = makeContext();
    await search("alpha", { count: 2 }, makeExecDeps(fake.capability), context);

    // Adapter received a bare request: no count field.
    assert.strictEqual(fake.invokes.length, 1);
    assert.strictEqual(fake.invokes[0].count, undefined);
    assert.deepStrictEqual(fake.invokes[0], { query: "alpha" });

    // Cache identity request has no count; count only carried as legacyCount.
    assert.strictEqual(fake.identities[0].identity.request.count, undefined);
    assert.strictEqual(fake.identities[0].compat.legacyCount, 2);
  });

  it("count is applied AFTER normalization (truncates normalized results)", async () => {
    const { result } = await runSearch(
      "alpha",
      { count: 2 },
      {
        alpha: [
          src("A", "https://e/a", "c"),
          src("B", "https://e/b", "c"),
          src("C", "https://e/c", "c"),
        ],
      },
    );
    // Adapter normalized 3; count=2 truncated to 2 locally.
    assert.strictEqual(result.data.length, 2);
  });

  it("absent count returns all normalized results", async () => {
    const { result } = await runSearch(
      "alpha",
      {},
      {
        alpha: [
          src("A", "https://e/a", "c"),
          src("B", "https://e/b", "c"),
          src("C", "https://e/c", "c"),
        ],
      },
    );
    assert.strictEqual(result.data.length, 3);
  });
});

// ---------------------------------------------------------------------------
// MiniMax rejects unsupported controls before SDK factory access
// ---------------------------------------------------------------------------

describe("search command — MiniMax rejects unsupported controls", () => {
  it("throws UNSUPPORTED_OPTION before the SDK is constructed", async () => {
    let sdkConstructed = 0;
    const Constructor = function () {
      sdkConstructed += 1;
      return {
        search: {
          async query() {
            return { organic: [] };
          },
        },
      };
    };
    const descriptor = createMiniMaxDescriptor({ sdkConstructor: Constructor });
    const adapter = descriptor.create({ env: { MINIMAX_API_KEY: "k" } });
    const { context } = makeContext();

    await assert.rejects(
      search("q", { domain: "example.com" }, makeExecDeps(adapter.search), context),
      (err) => err.code === "UNSUPPORTED_OPTION",
    );
    assert.strictEqual(sdkConstructed, 0);
  });
});

// ---------------------------------------------------------------------------
// Global --provider parsing and routing (via main())
// ---------------------------------------------------------------------------

function createTestAdapter(overrides = {}) {
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
    ...overrides,
  };
  return { adapter, stdout, stderr };
}

/** Build a fake descriptor whose adapter.search.invoke is observable. */
function makeFakeDescriptor(id) {
  const invokes = [];
  return {
    descriptor: {
      id,
      isConfigured: () => true,
      capabilities: () => new Set(["search"]),
      create: () => ({
        id,
        search: {
          validate() {},
          cacheIdentity(r) {
            return {
              provider: id,
              capability: "search",
              credentialFingerprint: "fp-" + id,
              request: r,
              legacyCandidates: [],
            };
          },
          async invoke(r) {
            invokes.push(r);
            return [];
          },
        },
      }),
    },
    invokes,
  };
}

function makeRegistryDeps() {
  const zai = makeFakeDescriptor("zai");
  const minimax = makeFakeDescriptor("minimax");
  // Fresh in-memory cache per test so adapter invocations are never
  // short-circuited by entries written by a sibling test (and never touch
  // the real on-disk cache).
  const store = new Map();
  const searchCache = {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
  return {
    descriptors: [zai.descriptor, minimax.descriptor],
    zaiInvokes: zai.invokes,
    minimaxInvokes: minimax.invokes,
    searchCache,
  };
}

/** Build a MainDependencies object wired to fake descriptors + in-memory cache. */
function makeMainDeps() {
  const reg = makeRegistryDeps();
  return {
    deps: {
      invocation: undefined,
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      providerDescriptors: reg.descriptors,
      searchCache: reg.searchCache,
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    },
    zaiInvokes: reg.zaiInvokes,
    minimaxInvokes: reg.minimaxInvokes,
  };
}

describe("global --provider parsing and routing", () => {
  it("--provider after the Search token routes to the selected Adapter", async () => {
    const { adapter } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(["search", "foo", "--provider", "minimax"], {
      ...m.deps,
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(m.zaiInvokes.length, 0);
    assert.strictEqual(m.minimaxInvokes.length, 1);
    assert.strictEqual(m.minimaxInvokes[0].query, "foo");
  });

  it("--provider before the Search token routes to the selected Adapter", async () => {
    const { adapter } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(["--provider", "minimax", "search", "foo"], {
      ...m.deps,
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(m.minimaxInvokes.length, 1);
  });

  it("environment SCOUTLINE_PROVIDER is used when no explicit flag is given", async () => {
    const { adapter } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(["search", "foo"], {
      ...m.deps,
      env: { ...m.deps.env, SCOUTLINE_PROVIDER: "minimax" },
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(m.minimaxInvokes.length, 1);
  });

  it("explicit --provider takes precedence over SCOUTLINE_PROVIDER", async () => {
    const { adapter } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(["--provider", "zai", "search", "foo"], {
      ...m.deps,
      env: { ...m.deps.env, SCOUTLINE_PROVIDER: "minimax" },
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(m.zaiInvokes.length, 1);
    assert.strictEqual(m.minimaxInvokes.length, 0);
  });

  it("defaults to the Z.AI provider", async () => {
    const { adapter } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(["search", "foo"], { ...m.deps, invocation: adapter });
    assert.strictEqual(status, 0);
    assert.strictEqual(m.zaiInvokes.length, 1);
    assert.strictEqual(m.minimaxInvokes.length, 0);
  });

  it("an invalid explicit --provider fails with VALIDATION_ERROR before invocation", async () => {
    const { adapter, stderr } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(["--provider", "openai", "search", "foo"], {
      ...m.deps,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    const err = JSON.parse(stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.ok(/provider/i.test(err.error));
    assert.strictEqual(m.zaiInvokes.length, 0);
  });

  it("an unconfigured effective provider fails with CONFIGURATION_ERROR exit 3 (Fixup A — B5)", async () => {
    // Selection MUST return the default zai even when zai is unconfigured
    // (FR-003). The dispatch layer then reports the missing credential as
    // a configuration failure (exit 3), not a validation/registry error.
    function makeConfiguredDescriptor(id) {
      const invokes = [];
      return {
        descriptor: {
          id,
          isConfigured: (env) =>
            id === "zai" ? Boolean(env.Z_AI_API_KEY) : Boolean(env.MINIMAX_API_KEY),
          capabilities: () => new Set(["search"]),
          create: () => ({
            id,
            search: {
              validate() {},
              cacheIdentity(r) {
                return {
                  provider: id,
                  capability: "search",
                  credentialFingerprint: "fp-" + id,
                  request: r,
                  legacyCandidates: [],
                };
              },
              async invoke(r) {
                invokes.push(r);
                return [];
              },
            },
          }),
        },
        invokes,
      };
    }
    const zai = makeConfiguredDescriptor("zai");
    const minimax = makeConfiguredDescriptor("minimax");
    const store = new Map();
    const searchCache = {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
    };
    const { adapter, stderr } = createTestAdapter();
    const status = await main(["search", "foo"], {
      invocation: adapter,
      // Only a minimax key is present: zai is unconfigured, but it is
      // still the effective default provider.
      env: { MINIMAX_API_KEY: "k" },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      searchCache,
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    });
    assert.strictEqual(status, 3, "missing credentials must exit 3");
    const err = JSON.parse(stderr[0]);
    assert.strictEqual(err.code, "CONFIGURATION_ERROR");
    assert.strictEqual(zai.invokes.length, 0, "no invoke when unconfigured");
  });
});

// ---------------------------------------------------------------------------
// Z.AI-only command families ignore an invalid SCOUTLINE_PROVIDER
// ---------------------------------------------------------------------------

describe("Z.AI-only commands ignore an invalid SCOUTLINE_PROVIDER", () => {
  for (const cmd of ["read", "repo", "tools", "code"]) {
    it(`${cmd} --help succeeds with an invalid SCOUTLINE_PROVIDER`, async () => {
      const { adapter, stdout, stderr } = createTestAdapter();
      const m = makeMainDeps();
      const status = await main([cmd, "--help"], {
        ...m.deps,
        env: { SCOUTLINE_PROVIDER: "openai", Z_AI_API_KEY: "k" },
        invocation: adapter,
      });
      assert.strictEqual(status, 0);
      assert.strictEqual(stderr.length, 0);
      assert.ok(stdout.length === 1);
    });
  }
});

// ---------------------------------------------------------------------------
// Help text reflects provider selection precedence
// ---------------------------------------------------------------------------

describe("search command — help documents provider selection", () => {
  it("SEARCH_HELP mentions --provider and MiniMax control restrictions", () => {
    assert.match(SEARCH_HELP, /--provider/);
    assert.match(SEARCH_HELP, /minimax/i);
  });
});
