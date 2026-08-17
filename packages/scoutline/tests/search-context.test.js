/**
 * Search `--context` — Ticket 4 (local-context plan, TASKS.md /
 * DESIGN.md D7).
 *
 * Handler-level tests driving `main(deps)` with injected
 * MainDependencies (fake invocation adapter + provider doubles; the
 * `tests/search-fanout.test.js` / `tests/research-context.test.js`
 * precedent — `handleSearch` is module-private and not importable).
 *
 * Coverage:
 *   - Flag surface: the `--context` value-shape check runs BEFORE the
 *     positional help-gate (VALIDATION_ERROR, never HELP + exit 0);
 *     `--merge` + `--context` is a mutex VALIDATION_ERROR (D7).
 *   - D7 join: user query kept FIRST (trailing-backslash trim at the
 *     join site), derived sub-queries in document order, pipe-only
 *     escaping that survives the `splitMergeSubQueries` round-trip
 *     exactly — a member containing `|` or a non-trailing `\` comes
 *     back verbatim, and a user query ending in `\` does not fuse
 *     with the join separator.
 *   - Wire isolation (AC4 sibling): one `executeSearch` per stream
 *     member, request objects carrying ONLY the query string — no
 *     heading/question/term/sha256/path content anywhere else.
 *   - Zero-derivation fallback: the original query runs alone (merge
 *     NOT engaged — a literal `|` in the user query does not split),
 *     exactly one stderr notice, wrapper still applies.
 *   - Cap/drop notice: > MAX_SUBQUERIES derived → one notice with the
 *     pre-cap count and the drop, post-cap stream still joined.
 *   - Fan-out cost notice (D7): `N sub-queries × M arms = K billable
 *     searches` where N counts the whole joined stream (user query
 *     included), emitted once, before the fan-out summary.
 *   - No-flags byte-identity: without `--context` the data payload
 *     stays the bare array (0.16.0 behavior) and stderr stays empty.
 *   - Flags-gated wrapper (D7): data modes emit `{context: {source,
 *     path, sha256, derived}, results}` with numeric post-cap
 *     `derived.subQueries`; text modes render the unwrapped results
 *     byte-identically to the equivalent `--merge` run.
 *
 * 100% offline: provider doubles, in-memory caches, tmpdir-only fs.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

// ---------------------------------------------------------------------------
// Test doubles (tests/search-fanout.test.js patterns)
// ---------------------------------------------------------------------------

/**
 * Provider descriptor whose Adapter exposes a fake search Capability
 * capturing every request that crossed the wire. `resultsByQuery`
 * scripts per-query fixtures; a plain `results` array answers every
 * query identically (merge/fan-out grids then collapse by canonical
 * URL).
 */
function makeSearchProvider({ id, resultsByQuery, results }) {
  const invokes = [];
  const answer = (request) =>
    resultsByQuery !== undefined ? (resultsByQuery[request.query] ?? []) : (results ?? []);
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(request) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: `fp-${id}`,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          invokes.push(request);
          return answer(request).map((entry) => ({ ...entry }));
        },
      },
    }),
  };
  return { descriptor, invokes };
}

function makeAdapter() {
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
  };
  return { adapter, stdout, stderr };
}

/** Drive `main()` with fresh doubles; returns captures for assertions. */
async function runSearch(argv, providers) {
  const io = makeAdapter();
  const status = await main(
    argv,
    hermeticMainDeps({
      invocation: io.adapter,
      env: {},
      providerDescriptors: providers.map((p) => p.descriptor),
      loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
    }),
  );
  return { status, stdout: io.stdout, stderr: io.stderr };
}

const sha256of = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const SRC = (title, url) => ({ title, url, summary: `about ${title}` });

// Keep ambient credentials out of provider selection (same hygiene as
// tests/research-context.test.js).
let savedProcessEnv;
before(() => {
  savedProcessEnv = { ...process.env };
  for (const key of [
    "TAVILY_API_KEY",
    "EXA_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "FIRECRAWL_API_KEY",
    "Z_AI_API_KEY",
    "ZAI_API_KEY",
    "MINIMAX_API_KEY",
  ]) {
    delete process.env[key];
  }
});
after(() => {
  for (const [k, v] of Object.entries(savedProcessEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Flag surface (DESIGN D1 placement pin + D7 mutex)
// ---------------------------------------------------------------------------

describe("search --context — flag surface (Ticket 4)", () => {
  it("--context without a value is VALIDATION_ERROR before the help gate", async () => {
    // parseArgs records `true` for a valueless flag and leaves
    // positional empty; without the pre-gate check the help gate would
    // short-circuit to HELP + exit 0 and silently swallow the flag.
    const tavily = makeSearchProvider({ id: "tavily", results: [] });
    const r = await runSearch(["--provider", "tavily", "search", "--context"], [tavily]);
    assert.strictEqual(r.status, 1);
    assert.strictEqual(
      r.stdout.length,
      0,
      `help must not print on a malformed --context, got ${JSON.stringify(r.stdout)}`,
    );
    const err = JSON.parse(r.stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /--context requires a value/);
    assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
  });

  it("--merge together with --context is a VALIDATION_ERROR mutex", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Alpha Topic\n", "utf8");
      const tavily = makeSearchProvider({ id: "tavily", results: [] });
      const r = await runSearch(
        ["--provider", "tavily", "search", "mutex query", "--merge", "--context", notesPath],
        [tavily],
      );
      assert.strictEqual(r.status, 1);
      const err = JSON.parse(r.stderr[0]);
      assert.strictEqual(err.code, "VALIDATION_ERROR");
      assert.match(err.error, /--merge and --context are mutually exclusive/);
      assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
    });
  });
});

// ---------------------------------------------------------------------------
// D7 join + escaping round-trip
// ---------------------------------------------------------------------------

describe("search --context — D7 join + escaping round-trip (Ticket 4)", () => {
  it("members with | and \\ and a user query ending in \\ survive the join/split round-trip; user query first", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "escape.md");
      const notesText = [
        "# Pipes | Ampersands",
        "What about C:\\Windows paths?",
        "## Trailing Slash\\",
        "",
      ].join("\n");
      await fs.writeFile(notesPath, notesText, "utf8");

      const tavily = makeSearchProvider({ id: "tavily", results: [] });
      // The user query ends in a literal backslash: the join-site trim
      // keeps it from fusing with the `|` separator.
      const r = await runSearch(
        ["--provider", "tavily", "search", "rust async runtime\\", "--context", notesPath],
        [tavily],
      );
      assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
      // One executeSearch per stream member — user query first, derived
      // in document order, each string back EXACTLY as written (the
      // pipe-only escape round-trips both `|` and non-trailing `\`).
      assert.deepStrictEqual(
        tavily.invokes.map((req) => req.query),
        [
          "rust async runtime",
          "Pipes | Ampersands",
          "What about C:\\Windows paths",
          "Trailing Slash",
        ],
      );
      // AC4 wire isolation: the request object carries ONLY the query.
      assert.deepStrictEqual(tavily.invokes[0], { query: "rust async runtime" });
      assert.deepStrictEqual(tavily.invokes[1], { query: "Pipes | Ampersands" });
      // The joined stream engaged merge (one merged notice, 4 queries).
      assert.ok(
        r.stderr.some((n) => /merged 4 queries/.test(n)),
        `expected merged notice, got ${JSON.stringify(r.stderr)}`,
      );
    });
  });

  it("joined stream: user query first, derived in document order, one executeSearch each", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "order.md");
      await fs.writeFile(notesPath, "# Alpha Topic\nWhat is beta deployment?\n", "utf8");

      const tavily = makeSearchProvider({ id: "tavily", results: [] });
      const r = await runSearch(
        ["--provider", "tavily", "search", "user query", "--context", notesPath],
        [tavily],
      );
      assert.strictEqual(r.status, 0);
      assert.strictEqual(tavily.invokes.length, 3);
      assert.deepStrictEqual(
        tavily.invokes.map((req) => req.query),
        ["user query", "Alpha Topic", "What is beta deployment"],
      );
      for (const req of tavily.invokes) {
        assert.deepStrictEqual(Object.keys(req), ["query"], "requests carry the query only");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Zero-derivation fallback (D7)
// ---------------------------------------------------------------------------

describe("search --context — zero-derivation fallback (Ticket 4)", () => {
  it("0 derived → original query runs alone (merge not engaged), one notice, wrapper still applies", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "prose.md");
      const notesText = "no structure here at all\njust prose, no headings or questions\n";
      await fs.writeFile(notesPath, notesText, "utf8");

      const tavily = makeSearchProvider({
        id: "tavily",
        results: [SRC("Only", "https://e/only")],
      });
      // A literal `|` in the user query: merge is NOT engaged under a
      // zero-derivation fallback, so the pipe must NOT split.
      const r = await runSearch(
        ["--provider", "tavily", "search", "alpha | beta", "--context", notesPath],
        [tavily],
      );
      assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
      assert.strictEqual(tavily.invokes.length, 1);
      assert.deepStrictEqual(tavily.invokes[0], { query: "alpha | beta" });
      // Exactly one notice, verbatim.
      assert.deepStrictEqual(r.stderr, ["context: derived 0 sub-queries; using original query"]);
      // The wrapper still applies (D7: zero-derivation keeps it).
      const parsed = JSON.parse(r.stdout[0]);
      assert.ok(Array.isArray(parsed.results), "results stay an array under the wrapper");
      assert.deepStrictEqual(parsed.context, {
        source: "file",
        path: notesPath,
        sha256: sha256of(notesText),
        derived: { headings: 0, questions: 0, terms: 0, subQueries: 0 },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Cap / drop notice (D2.4 + D7)
// ---------------------------------------------------------------------------

describe("search --context — cap/drop notice (Ticket 4)", () => {
  it("10 derivable → 8 kept, 2 dropped, one notice; 9 joined queries (user + 8)", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "many.md");
      const notesText = Array.from({ length: 10 }, (_, i) => `# Topic ${String(i + 1).padStart(2, "0")}`).join("\n") + "\n";
      await fs.writeFile(notesPath, notesText, "utf8");

      const tavily = makeSearchProvider({ id: "tavily", results: [] });
      const r = await runSearch(
        ["--provider", "tavily", "search", "cap query", "--context", notesPath],
        [tavily],
      );
      assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
      // User query + the first 8 derived sub-queries (cap 8).
      assert.strictEqual(tavily.invokes.length, 9);
      assert.deepStrictEqual(
        tavily.invokes.map((req) => req.query),
        [
          "cap query",
          "Topic 01",
          "Topic 02",
          "Topic 03",
          "Topic 04",
          "Topic 05",
          "Topic 06",
          "Topic 07",
          "Topic 08",
        ],
      );
      const drop = r.stderr.filter((n) => /dropped/.test(n));
      assert.strictEqual(drop.length, 1, `one drop notice, got ${JSON.stringify(r.stderr)}`);
      assert.strictEqual(drop[0], "context: derived 10 sub-queries; dropped 2 (cap 8)");
      // The wrapper count is the POST-cap stream length.
      assert.strictEqual(JSON.parse(r.stdout[0]).context.derived.subQueries, 8);
    });
  });
});

// ---------------------------------------------------------------------------
// Fan-out cost notice (D7)
// ---------------------------------------------------------------------------

describe("search --context — fan-out cost notice (Ticket 4)", () => {
  it("fan-out + 2 derived → 3 sub-queries × 2 arms = 6 billable searches, once; every arm runs every sub-query", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "fanout.md");
      await fs.writeFile(notesPath, "# Alpha Topic\nWhat is beta deployment?\n", "utf8");

      const tavily = makeSearchProvider({
        id: "tavily",
        results: [SRC("Tav", "https://e/tav")],
      });
      const exa = makeSearchProvider({
        id: "exa",
        results: [SRC("Exa", "https://e/exa")],
      });
      const r = await runSearch(
        ["--provider", "tavily,exa", "search", "fanout query", "--context", notesPath],
        [tavily, exa],
      );
      assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);

      // The cost notice fires exactly once, with N counting the WHOLE
      // joined stream (user query included): 3 × 2 = 6.
      const cost = r.stderr.filter((n) => /billable searches/.test(n));
      assert.strictEqual(cost.length, 1, `one cost notice, got ${JSON.stringify(r.stderr)}`);
      assert.strictEqual(cost[0], "context: 3 sub-queries × 2 arms = 6 billable searches");
      // It precedes the fan-out summary notice.
      const summary = r.stderr.findIndex((n) => /fanned out to 2 providers/.test(n));
      assert.ok(summary > r.stderr.indexOf(cost[0]), "cost notice precedes the fan-out summary");
      // The grid rule holds: every arm ran every sub-query.
      assert.deepStrictEqual(
        tavily.invokes.map((req) => req.query),
        ["fanout query", "Alpha Topic", "What is beta deployment"],
      );
      assert.deepStrictEqual(
        exa.invokes.map((req) => req.query),
        ["fanout query", "Alpha Topic", "What is beta deployment"],
      );
      // The wrapper applies on the fan-out path too.
      const parsed = JSON.parse(r.stdout[0]);
      assert.strictEqual(parsed.context.derived.subQueries, 2);
      assert.ok(Array.isArray(parsed.results), "results array under the wrapper");
    });
  });

  it("fan-out with 0 derived → no cost notice (single-sub-query stream)", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "prose.md");
      await fs.writeFile(notesPath, "just prose, nothing derivable\n", "utf8");

      const tavily = makeSearchProvider({ id: "tavily", results: [SRC("T", "https://e/t")] });
      const exa = makeSearchProvider({ id: "exa", results: [SRC("E", "https://e/e")] });
      const r = await runSearch(
        ["--provider", "tavily,exa", "search", "solo query", "--context", notesPath],
        [tavily, exa],
      );
      assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
      assert.ok(
        !r.stderr.some((n) => /billable searches/.test(n)),
        `no cost notice for a 1-sub-query stream, got ${JSON.stringify(r.stderr)}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// No-flags byte-identity (0.16.0 golden sibling)
// ---------------------------------------------------------------------------

describe("search — no-flags byte-identity (Ticket 4)", () => {
  it("without --context the data payload stays the bare array and stderr stays empty", async () => {
    const tavily = makeSearchProvider({
      id: "tavily",
      results: [SRC("First", "https://e/first"), SRC("Second", "https://e/second")],
    });
    const r = await runSearch(["--provider", "tavily", "search", "plain query"], [tavily]);
    assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
    assert.deepStrictEqual(r.stderr, [], "no context notices without the flag");
    const data = JSON.parse(r.stdout[0]);
    assert.ok(Array.isArray(data), "bare array, no wrapper");
    assert.deepStrictEqual(data, [
      { rank: 1, title: "First", url: "https://e/first", summary: "about First" },
      { rank: 2, title: "Second", url: "https://e/second", summary: "about Second" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Flags-gated context wrapper (D7)
// ---------------------------------------------------------------------------

describe("search --context — flags-gated wrapper (Ticket 4)", () => {
  it("data mode wraps: {context: {source, path, sha256, derived}, results} with numeric counts", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "shape.md");
      const notesText = "# Alpha Topic\nWhat is beta deployment?\n";
      await fs.writeFile(notesPath, notesText, "utf8");

      const tavily = makeSearchProvider({ id: "tavily", results: [SRC("R", "https://e/r")] });
      const r = await runSearch(
        ["--provider", "tavily", "search", "shape query", "--context", notesPath],
        [tavily],
      );
      assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
      const parsed = JSON.parse(r.stdout[0]);
      assert.deepStrictEqual(
        Object.keys(parsed).sort(),
        ["context", "results"],
        "exactly two top-level keys under the wrapper",
      );
      assert.ok(Array.isArray(parsed.results));
      // terms: alpha, topic (heading) + beta, deployment (question;
      // what/is are stopword/sub-min) — all counts numeric, post-cap.
      assert.deepStrictEqual(parsed.context, {
        source: "file",
        path: notesPath,
        sha256: sha256of(notesText),
        derived: { headings: 1, questions: 1, terms: 4, subQueries: 2 },
      });
    });
  });

  it("zero-derivation wrapper: results deep-equal the no-flag data payload", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "prose.md");
      await fs.writeFile(notesPath, "unstructured prose only\n", "utf8");

      const mk = () =>
        makeSearchProvider({
          id: "tavily",
          results: [SRC("First", "https://e/first"), SRC("Second", "https://e/second")],
        });
      const plain = mk();
      const rA = await runSearch(["--provider", "tavily", "search", "wrapped query"], [plain]);
      const wrapped = mk();
      const rB = await runSearch(
        ["--provider", "tavily", "search", "wrapped query", "--context", notesPath],
        [wrapped],
      );
      assert.strictEqual(rA.status, 0);
      assert.strictEqual(rB.status, 0, `stderr: ${JSON.stringify(rB.stderr)}`);
      const parsedA = JSON.parse(rA.stdout[0]);
      const parsedB = JSON.parse(rB.stdout[0]);
      assert.ok(Array.isArray(parsedA), "no-flag payload stays the bare array");
      assert.deepStrictEqual(parsedB.results, parsedA, "results byte-identical to no-flag data");
    });
  });

  it("json output mode carries the wrapper inside the success envelope's data", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "prose.md");
      await fs.writeFile(notesPath, "unstructured prose only\n", "utf8");
      const tavily = makeSearchProvider({ id: "tavily", results: [SRC("R", "https://e/r")] });
      const r = await runSearch(
        ["--provider", "tavily", "-O", "json", "search", "json mode query", "--context", notesPath],
        [tavily],
      );
      assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
      const envelope = JSON.parse(r.stdout[0]);
      assert.strictEqual(envelope.success, true);
      assert.ok(Array.isArray(envelope.data.results), "wrapped results inside the json envelope");
      assert.strictEqual(envelope.data.context.derived.subQueries, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Text modes render the unwrapped results (D7)
// ---------------------------------------------------------------------------

describe("search --context — text modes stay unwrapped (Ticket 4)", () => {
  it("-O compact output is byte-identical to the equivalent explicit --merge run", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "order.md");
      await fs.writeFile(notesPath, "# Alpha Topic\nWhat is beta deployment?\n", "utf8");
      // Same fixtures per query on both runs so only the presentation
      // path (not the data) can differ.
      const mk = () =>
        makeSearchProvider({
          id: "tavily",
          resultsByQuery: {
            "text mode query": [SRC("User Hit", "https://e/user")],
            "Alpha Topic": [SRC("Alpha Hit", "https://e/alpha")],
            "What is beta deployment": [SRC("Beta Hit", "https://e/beta")],
          },
        });

      const withCtx = mk();
      const rC = await runSearch(
        ["--provider", "tavily", "-O", "compact", "search", "text mode query", "--context", notesPath],
        [withCtx],
      );
      assert.strictEqual(rC.status, 0, `stderr: ${JSON.stringify(rC.stderr)}`);
      // The derived stream joined identically to the manual merge form.
      assert.strictEqual(withCtx.invokes.length, 3);

      const manual = mk();
      const rD = await runSearch(
        [
          "--provider",
          "tavily",
          "-O",
          "compact",
          "search",
          "text mode query|Alpha Topic|What is beta deployment",
          "--merge",
        ],
        [manual],
      );
      assert.strictEqual(rD.status, 0, `stderr: ${JSON.stringify(rD.stderr)}`);
      assert.strictEqual(manual.invokes.length, 3);

      // Text mode renders the unwrapped results: byte-identical stdout
      // between the derived join and the explicit merge form.
      assert.deepStrictEqual(rC.stdout, rD.stdout);
      assert.ok(
        !rC.stdout[0].includes("sha256") && !rC.stdout[0].includes('"context"'),
        "the wrapper never leaks into a text-mode presentation",
      );
    });
  });
});
