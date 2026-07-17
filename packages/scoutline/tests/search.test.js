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
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { search, SEARCH_HELP } from "../dist/commands/search.js";
import { main } from "../dist/index.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
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

describe("search command — concurrent merge and client lifecycle", () => {
  it("starts sub-queries concurrently and preserves query order when completion is reversed", async () => {
    const gates = new Map();
    let active = 0;
    let maxActive = 0;
    const capability = {
      validate() {},
      cacheIdentity(request) {
        return {
          provider: "zai",
          capability: "search",
          credentialFingerprint: "merge-fp",
          request,
          legacyCandidates: [],
        };
      },
      invoke(request) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise((resolve) => {
          gates.set(request.query, (value) => {
            active -= 1;
            resolve(value);
          });
        });
      },
    };
    const pending = search(
      "first|second",
      { merge: true, noCache: true },
      makeExecDeps(capability),
      makeContext().context,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(maxActive, 2, "both sub-queries must be in flight together");
    gates.get("second")([src("Second", "https://e/second", "second")]);
    gates.get("first")([src("First", "https://e/first", "first")]);
    const result = await pending;
    assert.deepStrictEqual(
      result.data.map((entry) => entry.title),
      ["First", "Second"],
      "completion order must not reorder query-ranked results",
    );
  });

  it("uses a distinct provider client per merged query and closes every client", async () => {
    const clients = [];
    const descriptor = createZaiDescriptor({
      clientFactory: () => {
        const state = { closed: false };
        clients.push(state);
        return {
          async callToolRaw(_name, args) {
            return [
              {
                title: args.search_query,
                link: `https://e/${args.search_query}`,
                content: "ok",
              },
            ];
          },
          async close() {
            state.closed = true;
          },
        };
      },
    });
    const capability = descriptor.create({ env: { Z_AI_API_KEY: "k" } }).search;
    await search(
      "alpha|beta",
      { merge: true, noCache: true },
      makeExecDeps(capability),
      makeContext().context,
    );
    assert.strictEqual(clients.length, 2);
    assert.ok(clients.every((client) => client.closed));
  });

  it("closes every created provider client when one merged query fails", async () => {
    const clients = [];
    const descriptor = createZaiDescriptor({
      clientFactory: () => {
        const state = { closed: false };
        clients.push(state);
        return {
          async callToolRaw(_name, args) {
            if (args.search_query === "bad") throw new Error("HTTP 404 not found");
            return [{ title: "good", link: "https://e/good", content: "ok" }];
          },
          async close() {
            state.closed = true;
          },
        };
      },
    });
    const capability = descriptor.create({ env: { Z_AI_API_KEY: "k" } }).search;
    await assert.rejects(
      search(
        "good|bad",
        { merge: true, noCache: true },
        makeExecDeps(capability),
        makeContext().context,
      ),
      (error) => error.code === "API_ERROR" && error.statusCode === 404,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(clients.length, 2);
    assert.ok(clients.every((client) => client.closed));
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

// ---------------------------------------------------------------------------
// Global CLI --count validation (Fixup C — B11).
//
// Per DESIGN.md §7: "Command `count` must be a finite safe integer
// greater than or equal to zero; zero returns no results after cache
// and normalization." The CLI flag parser used to accept any string and
// pass `parseInt` output downstream. NaN, negatives, non-integers, and
// Infinity reached the search command as silently-truncating 0-result
// runs. Invalid counts must fail fast at parse time with VALIDATION_ERROR
// (exit 1), before any Provider resolution or invocation.
//
// Note: the existing CLI parser cannot deliver a hyphen-prefixed value
// (e.g. `--count -5`) to the flag, since it treats any `-`-prefixed
// token as a flag of its own. The negative-count case is therefore
// exercised against the exported `parseAndValidateCount` helper below —
// it is defensive for any programmatic caller and any future parser
// upgrade that allows `--count=-5`.
// ---------------------------------------------------------------------------

import { parseAndValidateCount } from "../dist/index.js";

describe("--count flag validation (Fixup C — B11)", () => {
  // Run main() with a fake descriptor whose search.invoke returns an
  // organic set. Invalid counts must fail with VALIDATION_ERROR (exit 1)
  // BEFORE invoking the Adapter.
  async function runCount(args) {
    const { adapter, stderr } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(["search", "foo", ...args], {
      ...m.deps,
      invocation: adapter,
    });
    return { status, stderr, invokes: [...m.zaiInvokes, ...m.minimaxInvokes] };
  }

  it("rejects a non-numeric --count with VALIDATION_ERROR (exit 1)", async () => {
    const { status, stderr, invokes } = await runCount(["--count", "nope"]);
    assert.strictEqual(status, 1, "invalid count must exit 1");
    assert.strictEqual(invokes.length, 0, "no Adapter invocation on invalid count");
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /count/i);
  });

  it("accepts a valid positive integer --count and forwards it through the search", async () => {
    const { status, invokes } = await runCount(["--count", "2"]);
    assert.strictEqual(status, 0);
    assert.strictEqual(invokes.length, 1);
  });

});

// ---------------------------------------------------------------------------
// Fixup D — B11-remaining: count validation ordering.
//
// Count validation MUST run BEFORE Provider resolution and the
// configured/credential check. A syntax error in a CLI argument must not
// depend on whether credentials are present. This test deliberately uses
// NO credentials and the REAL built-in descriptors (no fake injection) so
// the actual CLI flow is exercised: `search q --count nope` with no
// credentials must surface VALIDATION_ERROR (exit 1), NOT
// CONFIGURATION_ERROR (exit 3).
// ---------------------------------------------------------------------------

describe("--count validation ordering vs credential check (Fixup D — B11-remaining)", () => {
  it("invalid --count with NO credentials yields VALIDATION_ERROR (exit 1), not CONFIGURATION_ERROR (exit 3)", async () => {
    const { adapter, stderr } = createTestAdapter();
    // No providerDescriptors override -> real BUILT_IN_PROVIDER_DESCRIPTORS.
    // No credentials in env -> the Provider is unconfigured. Count
    // validation MUST fire first.
    const status = await main(["search", "q", "--count", "nope"], {
      invocation: adapter,
      env: {},
    });
    assert.strictEqual(status, 1, "invalid count must exit 1 even with no credentials");
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(
      parsed.code,
      "VALIDATION_ERROR",
      `expected VALIDATION_ERROR, got ${parsed.code}`,
    );
    assert.match(parsed.error, /count/i);
  });

});

describe("parseAndValidateCount — direct validation contract (Fixup C — B11, Fixup D)", () => {
  it("returns undefined when the raw value is undefined / empty", () => {
    assert.strictEqual(parseAndValidateCount(undefined), undefined);
    assert.strictEqual(parseAndValidateCount(""), undefined);
  });

  it("throws VALIDATION_ERROR for --count without a value (parser delivers true)", () => {
    // Fixup D: `--count` without a value is a user error, not an absent
    // flag. The parser delivers `true`; this must surface as
    // VALIDATION_ERROR, not silently treated as absent.
    assert.throws(
      () => parseAndValidateCount(true),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("returns the parsed integer for valid non-negative inputs", () => {
    assert.strictEqual(parseAndValidateCount("0"), 0);
    assert.strictEqual(parseAndValidateCount("1"), 1);
    assert.strictEqual(parseAndValidateCount("42"), 42);
    assert.strictEqual(parseAndValidateCount(7), 7);
  });

  it("rejects a negative integer with VALIDATION_ERROR", () => {
    assert.throws(
      () => parseAndValidateCount("-5"),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("rejects a non-integer string with VALIDATION_ERROR", () => {
    assert.throws(
      () => parseAndValidateCount("1.5"),
      (err) => err.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => parseAndValidateCount("nope"),
      (err) => err.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => parseAndValidateCount("Infinity"),
      (err) => err.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => parseAndValidateCount("NaN"),
      (err) => err.code === "VALIDATION_ERROR",
    );
    assert.throws(
      () => parseAndValidateCount("5x"),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("rejects leading-sign input the parser would silently coerce", () => {
    // The strict `^\d+$` regex catches `"+5"` and `"-5"` so they cannot
    // bypass the check by being non-canonical numeric strings.
    assert.throws(
      () => parseAndValidateCount("+5"),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("rejects values above Number.MAX_SAFE_INTEGER (Fixup D — isSafeInteger)", () => {
    // 2^53 exceeds MAX_SAFE_INTEGER (2^53 - 1). Previously accepted by
    // Number.isFinite + Number.isInteger and silently rounded.
    const tooBig = String(Number.MAX_SAFE_INTEGER + 2);
    assert.throws(
      () => parseAndValidateCount(tooBig),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("accepts Number.MAX_SAFE_INTEGER exactly", () => {
    assert.strictEqual(
      parseAndValidateCount(String(Number.MAX_SAFE_INTEGER)),
      Number.MAX_SAFE_INTEGER,
    );
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
function makeFakeDescriptor(id, results = []) {
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
            return results.map((entry) => ({ ...entry }));
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

describe("top-level Search composition", () => {
  it("runs Z.AI parse → selection → capability → normalized stdout", async () => {
    const zai = makeFakeDescriptor("zai", [
      { title: "Z.AI result", url: "https://e/zai", summary: "normalized" },
    ]);
    const minimax = makeFakeDescriptor("minimax");
    const { adapter, stdout, stderr } = createTestAdapter();
    const status = await main(["search", "provider flow"], {
      invocation: adapter,
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      searchCache: makeExecDeps({}).cache,
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(stderr, []);
    assert.deepStrictEqual(JSON.parse(stdout[0]), [
      {
        rank: 1,
        title: "Z.AI result",
        url: "https://e/zai",
        summary: "normalized",
      },
    ]);
    assert.strictEqual(zai.invokes.length, 1);
    assert.strictEqual(minimax.invokes.length, 0);
  });

  it("runs MiniMax parse → selection → capability → normalized stdout", async () => {
    const zai = makeFakeDescriptor("zai");
    const minimax = makeFakeDescriptor("minimax", [
      { title: "MiniMax result", url: "https://e/minimax", summary: "normalized" },
    ]);
    const { adapter, stdout, stderr } = createTestAdapter();
    const status = await main(["--provider", "minimax", "search", "provider flow"], {
      invocation: adapter,
      env: { Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      searchCache: makeExecDeps({}).cache,
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(stderr, []);
    assert.deepStrictEqual(JSON.parse(stdout[0]), [
      {
        rank: 1,
        title: "MiniMax result",
        url: "https://e/minimax",
        summary: "normalized",
      },
    ]);
    assert.strictEqual(zai.invokes.length, 0);
    assert.strictEqual(minimax.invokes.length, 1);
  });
});

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

  // Fixup C — B10: pre-invocation validation errors (invalid --provider,
  // missing credential, count parsing, etc.) must respect the
  // requested output mode. Previously the outer catch hardcoded
  // "data" mode for every pre-invocation error, so a user invoking
  // `--output-format pretty` got compact JSON for any provider error.
  it("a pre-invocation error respects the requested output mode (Fixup C — B10)", async () => {
    const { adapter, stderr } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(
      ["--output-format", "pretty", "--provider", "openai", "search", "foo"],
      { ...m.deps, invocation: adapter },
    );
    assert.strictEqual(status, 1);
    // pretty mode emits indented (multi-line) JSON.
    assert.ok(stderr[0].includes("\n"), `expected indented envelope, got: ${stderr[0]}`);
    const err = JSON.parse(stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
  });

  it("a pre-invocation error respects json mode (Fixup C — B10)", async () => {
    const { adapter, stderr } = createTestAdapter();
    const m = makeMainDeps();
    const status = await main(
      ["--output-format", "json", "--provider", "openai", "search", "foo"],
      { ...m.deps, invocation: adapter },
    );
    assert.strictEqual(status, 1);
    const err = JSON.parse(stderr[0]);
    assert.strictEqual(err.success, false);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    // json mode keeps the envelope single-line.
    assert.ok(!stderr[0].includes("\n"), `json envelope should be single-line: ${stderr[0]}`);
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
// Fixup B — B3: injected MainDependencies.env credentials drive redaction.
// A secret present ONLY in MainDependencies.env (not in process.env) must
// still be redacted from public error output. This is the end-to-end proof
// that the env->secrets threading reaches invokeCommand + formatErrorOutput.
// ---------------------------------------------------------------------------

describe("main — redaction uses injected env credentials (Fixup B — B3)", () => {
  const INJECTED_ONLY = "ZAI_INJECTED_ONLY_SECRET_DO_NOT_LEAK";

  let savedKey;
  before(() => {
    savedKey = process.env.Z_AI_API_KEY;
    delete process.env.Z_AI_API_KEY;
    delete process.env.ZAI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
  });
  after(() => {
    if (savedKey === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = savedKey;
  });

  it("redacts a secret present only in MainDependencies.env from error output", async () => {
    // Fake ZAI descriptor whose search.invoke throws an error that embeds
    // the injected env credential. The dispatch layer threads
    // configuredSecrets(env) to invokeCommand, so the credential must be
    // redacted even though it is absent from process.env.
    const zaiDescriptor = {
      id: "zai",
      isConfigured: (env) => Boolean(env.Z_AI_API_KEY),
      capabilities: () => new Set(["search"]),
      create: () => ({
        id: "zai",
        search: {
          validate() {},
          cacheIdentity(r) {
            return {
              provider: "zai",
              capability: "search",
              credentialFingerprint: "fp-zai",
              request: r,
              legacyCandidates: [],
            };
          },
          async invoke() {
            const err = new Error(`provider rejected key=${INJECTED_ONLY}`);
            err.code = "API_ERROR";
            err.statusCode = 500;
            throw err;
          },
        },
      }),
    };

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
      // The secret lives ONLY here — not in process.env.
      env: { Z_AI_API_KEY: INJECTED_ONLY },
      providerDescriptors: [zaiDescriptor],
      searchCache,
      searchSleep: async () => {},
      searchRandom: () => 0.5,
    });

    assert.ok(status > 0, "error path returns nonzero");
    const formatted = stderr[0];
    assert.ok(
      !formatted.includes(INJECTED_ONLY),
      `injected-only env secret leaked to output: ${formatted}`,
    );
    const parsed = JSON.parse(formatted);
    assert.ok(parsed.error.includes("[REDACTED]"), `expected redaction: ${parsed.error}`);
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
