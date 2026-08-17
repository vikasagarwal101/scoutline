/**
 * Stdin context variants + cross-cutting privacy suite — Ticket 5
 * (local-context plan, TASKS.md / DESIGN.md D1, D3, D6).
 *
 * Handler-level tests driving `main(deps)` with injected
 * MainDependencies and a fake invocation adapter whose `readStdin`
 * returns the fixture (the adapter's readStdin is what
 * `context.readStdin()` delegates to — `tests/invocation.test.js`
 * "delegates readStdin" documents the seam; full-handler precedent
 * `tests/bin.test.js`).
 *
 * Coverage:
 *   - Flag surface (D1): the `--context-stdin` value-shape check
 *     (string vs no-value) runs BEFORE the positional help-gate in BOTH
 *     handlers — `search|research --context-stdin "<q>"` exits
 *     VALIDATION_ERROR, never HELP + 0. The `--context` /
 *     `--context-stdin` mutual-exclusion error (D1) in both handlers.
 *   - Search `--context-stdin` (D7 through the piped source): the
 *     joined stream derives from the piped text (user query first,
 *     document order, one executeSearch each), the D7 wrapper records
 *     `source: "stdin"` with no path, and the D7 `--merge` mutex
 *     extends to the stdin spelling.
 *   - Oversize stdin (D3): one byte over MAX_CONTEXT_BYTES fails the
 *     handler run with VALIDATION_ERROR naming the numeric limit —
 *     for BOTH commands, with the adapter's stdin read exactly once.
 *   - D6 privacy snapshot suite (AC4, consolidated here so it survives
 *     refactors of Tickets 2–4): under organize the research request
 *     object is deep-equal to the no-context request; no
 *     heading/question/term/file-byte marker appears in any request,
 *     envelope field, notice, or log line. For search, the derived
 *     sub-query strings are the one permitted content-carrying wire
 *     shape (D6); requests carry the query only, and the wrapper +
 *     notices stay content-free.
 *
 * 100% offline: provider doubles, in-memory caches, tmpdir-only fs.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { MAX_CONTEXT_BYTES } from "../dist/lib/context-file.js";
import { withTempDir } from "./helpers/temp-dir.js";

// ---------------------------------------------------------------------------
// Test doubles (tests/search-context.test.js / research-context.test.js
// patterns)
// ---------------------------------------------------------------------------

/** Search provider double capturing every wire request (Ticket 4 shape). */
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

/** Research provider double capturing every wire request (Ticket 2 shape). */
function makeResearchProvider({ id, envVar, ok, error }) {
  const invokes = [];
  const operation = {
    kind: "research-run",
    validate() {},
    cacheIdentity(request) {
      return {
        provider: id,
        capability: "research",
        credentialFingerprint: `fp-${id}`,
        request,
        legacyCandidates: [],
      };
    },
    async invoke(request) {
      invokes.push(request);
      if (error) throw error;
      return ok(request);
    },
  };
  const descriptor = {
    id,
    isConfigured: (env) => typeof env[envVar] === "string" && env[envVar].length > 0,
    capabilities: () => new Set(["research"]),
    create: () => ({ id, research: { run: operation } }),
  };
  return { descriptor, invokes };
}

/**
 * Fake invocation adapter whose readStdin mirrors the Node adapter's
 * drain semantics: the first read returns the piped fixture, every
 * later read yields "" (so a re-read anywhere would visibly diverge).
 */
function makeAdapter({ stdin = "" } = {}) {
  const stdout = [];
  const stderr = [];
  let stdinCalls = 0;
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => {
      stdinCalls += 1;
      return stdinCalls === 1 ? stdin : "";
    },
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
  };
  return { adapter, stdout, stderr, stdinCalls: () => stdinCalls };
}

const freshCache = () => {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
};

const researchOk = (report) => (request) => ({
  schemaVersion: 1,
  query: request.query,
  model: request.model ?? "auto",
  report,
  sources: [{ title: "Provider source", url: "https://example.com/s" }],
});

const SRC = (title, url) => ({ title, url, summary: `about ${title}` });

async function runSearch(argv, { providers, stdin = "" } = {}) {
  const io = makeAdapter({ stdin });
  const status = await main(argv, {
    invocation: io.adapter,
    env: {},
    providerDescriptors: providers.map((p) => p.descriptor),
    loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
    searchCache: freshCache(),
    searchSleep: async () => {},
    searchRandom: () => 0.5,
  });
  return { status, stdout: io.stdout, stderr: io.stderr, stdinCalls: io.stdinCalls };
}

async function runResearch(argv, { providers, stdin = "" } = {}) {
  const io = makeAdapter({ stdin });
  const status = await main(argv, {
    invocation: io.adapter,
    env: { TAVILY_API_KEY: "tv", EXA_API_KEY: "exa" },
    providerDescriptors: providers.map((p) => p.descriptor),
    researchCache: freshCache(),
  });
  return { status, stdout: io.stdout, stderr: io.stderr, stdinCalls: io.stdinCalls };
}

const sha256of = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// Keep ambient credentials out of provider selection (sibling hygiene).
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
// D6 privacy fixture: distinctive markers that cannot appear in provider
// fixtures, hashes (hex cannot contain "quokka"), or count-only notices.
// Terms derived from the stream: quokka, habitat, overview, quokkas,
// smile — the prose line yields nothing (not a heading, not a question).
// ---------------------------------------------------------------------------

const PRIVACY_TEXT = [
  "# Quokka Habitat Overview",
  "How do quokkas smile?",
  "plain prose xylophone checkpoint line",
  "",
].join("\n");
const PRIVACY_MARKERS = ["Quokka Habitat Overview", "quokkas smile", "xylophone", "checkpoint"];

const assertNoMarkerIn = (label, values) => {
  for (const value of values) {
    for (const marker of PRIVACY_MARKERS) {
      assert.ok(
        !value.includes(marker),
        `${label} must not contain the context marker "${marker}": ${JSON.stringify(value)}`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// --context-stdin value-shape pre-gate (DESIGN D1 placement pin)
// ---------------------------------------------------------------------------

describe("--context-stdin value shape — pre-gate in BOTH handlers (Ticket 5)", () => {
  it("search --context-stdin \"<q>\" is VALIDATION_ERROR before the help gate, never HELP + 0", async () => {
    // parseArgs greedily consumes the next non-dash token as the flag's
    // value, so `--context-stdin "<q>"` yields a string flag value and
    // an empty positional — without the pre-gate the help gate would
    // short-circuit to HELP + exit 0 with the query silently swallowed.
    const tavily = makeSearchProvider({ id: "tavily", results: [] });
    const r = await runSearch(
      ["--provider", "tavily", "search", "--context-stdin", "swallowed query"],
      { providers: [tavily] },
    );
    assert.strictEqual(r.status, 1);
    assert.strictEqual(
      r.stdout.length,
      0,
      `help must not print on a valued --context-stdin, got ${JSON.stringify(r.stdout)}`,
    );
    const err = JSON.parse(r.stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /--context-stdin does not take a value/);
    assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
  });

  it("research --context-stdin \"<q>\" is VALIDATION_ERROR before the help gate, never HELP + 0", async () => {
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: researchOk("## A\n\nbody"),
    });
    const r = await runResearch(
      ["--provider", "tavily", "research", "--context-stdin", "swallowed query"],
      { providers: [tavily] },
    );
    assert.strictEqual(r.status, 1);
    assert.strictEqual(
      r.stdout.length,
      0,
      `help must not print on a valued --context-stdin, got ${JSON.stringify(r.stdout)}`,
    );
    const err = JSON.parse(r.stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /--context-stdin does not take a value/);
    assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
  });
});

// ---------------------------------------------------------------------------
// --context / --context-stdin mutual exclusion (DESIGN D1)
// ---------------------------------------------------------------------------

describe("--context and --context-stdin are mutually exclusive (Ticket 5, D1)", () => {
  it("search with both context sources is a VALIDATION_ERROR", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Alpha Topic\n", "utf8");
      const tavily = makeSearchProvider({ id: "tavily", results: [] });
      const r = await runSearch(
        ["--provider", "tavily", "search", "mutex query", "--context", notesPath, "--context-stdin"],
        { providers: [tavily] },
      );
      assert.strictEqual(r.status, 1);
      const err = JSON.parse(r.stderr[0]);
      assert.strictEqual(err.code, "VALIDATION_ERROR");
      assert.match(err.error, /--context and --context-stdin are mutually exclusive/);
      assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
      assert.strictEqual(r.stdinCalls(), 0, "stdin must not be drained on a mutex error");
    });
  });

  it("research with both context sources is a VALIDATION_ERROR", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Alpha Topic\n", "utf8");
      const tavily = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk("## A\n\nbody"),
      });
      const r = await runResearch(
        ["--provider", "tavily", "research", "mutex query", "--context", notesPath, "--context-stdin"],
        { providers: [tavily] },
      );
      assert.strictEqual(r.status, 1);
      const err = JSON.parse(r.stderr[0]);
      assert.strictEqual(err.code, "VALIDATION_ERROR");
      assert.match(err.error, /--context and --context-stdin are mutually exclusive/);
      assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
      assert.strictEqual(r.stdinCalls(), 0, "stdin must not be drained on a mutex error");
    });
  });
});

// ---------------------------------------------------------------------------
// search --context-stdin — D7 derivation through the piped source
// ---------------------------------------------------------------------------

describe("search --context-stdin — D7 derivation via the piped source (Ticket 5)", () => {
  it("piped text derives the joined stream; wrapper records source stdin with no path", async () => {
    const stdinText = "# Alpha Topic\nWhat is beta deployment?\n";
    const tavily = makeSearchProvider({
      id: "tavily",
      resultsByQuery: {
        "stdin derived query": [SRC("User Hit", "https://e/user")],
        "Alpha Topic": [SRC("Alpha Hit", "https://e/alpha")],
        "What is beta deployment": [SRC("Beta Hit", "https://e/beta")],
      },
    });
    const r = await runSearch(
      ["--provider", "tavily", "search", "stdin derived query", "--context-stdin"],
      { providers: [tavily], stdin: stdinText },
    );
    assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
    // One executeSearch per stream member — user query first, derived in
    // document order — and the adapter's stdin was read exactly once.
    assert.strictEqual(tavily.invokes.length, 3);
    assert.deepStrictEqual(
      tavily.invokes.map((req) => req.query),
      ["stdin derived query", "Alpha Topic", "What is beta deployment"],
    );
    assert.strictEqual(r.stdinCalls(), 1);
    // The joined stream engaged merge (single merged notice, 3 queries).
    assert.ok(
      r.stderr.some((n) => /merged 3 queries/.test(n)),
      `expected merged notice, got ${JSON.stringify(r.stderr)}`,
    );
    // Wrapper shape (D7): stdin source, sha256 of the piped text, no
    // path key, numeric counts (terms: alpha, topic, beta, deployment).
    const parsed = JSON.parse(r.stdout[0]);
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ["context", "results"],
      "exactly two top-level keys under the wrapper",
    );
    assert.deepStrictEqual(parsed.context, {
      source: "stdin",
      sha256: sha256of(stdinText),
      derived: { headings: 1, questions: 1, terms: 4, subQueries: 2 },
    });
    assert.ok(Array.isArray(parsed.results) && parsed.results.length > 0);
  });

  it("--merge together with --context-stdin is the D7 mutex VALIDATION_ERROR", async () => {
    const tavily = makeSearchProvider({ id: "tavily", results: [] });
    const r = await runSearch(
      ["--provider", "tavily", "search", "merge mutex query", "--merge", "--context-stdin"],
      { providers: [tavily], stdin: "# Notes\n" },
    );
    assert.strictEqual(r.status, 1);
    const err = JSON.parse(r.stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /--merge and --context are mutually exclusive/);
    assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
  });

  it("oversize piped context is VALIDATION_ERROR naming the numeric limit; stdin read once", async () => {
    const tavily = makeSearchProvider({ id: "tavily", results: [] });
    const r = await runSearch(
      ["--provider", "tavily", "search", "oversize query", "--context-stdin"],
      { providers: [tavily], stdin: "a".repeat(MAX_CONTEXT_BYTES + 1) },
    );
    assert.strictEqual(r.status, 1);
    const err = JSON.parse(r.stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /exceeds the 262144-byte limit/);
    assert.match(err.error, /262145 bytes/);
    assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
    assert.strictEqual(r.stdinCalls(), 1, "the oversized pipe is read exactly once");
  });
});

// ---------------------------------------------------------------------------
// research --context-stdin — oversize (D3)
// ---------------------------------------------------------------------------

describe("research --context-stdin — oversize piped context (Ticket 5)", () => {
  it("oversize piped context is VALIDATION_ERROR naming the numeric limit; stdin read once", async () => {
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: researchOk("## A\n\nbody"),
    });
    const r = await runResearch(
      ["--provider", "tavily", "research", "oversize query", "--context-stdin"],
      { providers: [tavily], stdin: "a".repeat(MAX_CONTEXT_BYTES + 1) },
    );
    assert.strictEqual(r.status, 1);
    const err = JSON.parse(r.stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /exceeds the 262144-byte limit/);
    assert.match(err.error, /262145 bytes/);
    assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
    assert.strictEqual(r.stdinCalls(), 1, "the oversized pipe is read exactly once");
  });
});

// ---------------------------------------------------------------------------
// D6 privacy snapshot suite (AC4 consolidated — survives refactors of
// Tickets 2–4)
// ---------------------------------------------------------------------------

describe("D6 privacy snapshot suite (Ticket 5, AC4 consolidated)", () => {
  it("research organize via --context-stdin: wire request deep-equals the no-context request; no content in envelope/notices", async () => {
    const query = "privacy stdin query";
    const report = "## Provider Only Section\n\nProvider body.";

    const plain = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: researchOk(report),
    });
    const rA = await runResearch(["--provider", "tavily", "research", query], {
      providers: [plain],
    });

    const withCtx = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: researchOk(report),
    });
    const rB = await runResearch(["--provider", "tavily", "research", query, "--context-stdin"], {
      providers: [withCtx],
      stdin: PRIVACY_TEXT,
    });

    assert.strictEqual(rA.status, 0);
    assert.strictEqual(rB.status, 0, `stderr: ${JSON.stringify(rB.stderr)}`);
    // AC4 wire isolation: the exact request object is unchanged — no
    // heading, question, term, or file byte crosses the wire.
    assert.strictEqual(withCtx.invokes.length, 1);
    assert.deepStrictEqual(withCtx.invokes[0], plain.invokes[0]);
    assert.deepStrictEqual(withCtx.invokes[0], { query });
    // The envelope records counts and the hash only (source stdin, no
    // path): terms = quokka, habitat, overview, quokkas, smile.
    const parsed = JSON.parse(rB.stdout[0]);
    assert.deepStrictEqual(parsed.context, {
      source: "stdin",
      sha256: sha256of(PRIVACY_TEXT),
      mode: "organize",
      derived: { headings: 1, questions: 1, terms: 5 },
    });
    // No envelope context field, notice, or log line carries content.
    assertNoMarkerIn("the envelope context field", [JSON.stringify(parsed.context)]);
    assertNoMarkerIn("stderr", rB.stderr);
    assert.strictEqual(rB.stdinCalls(), 1);
  });

  it("research organize via --context <file>: wire request deep-equals the no-context request; no content in envelope/notices", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "privacy.md");
      await fs.writeFile(notesPath, PRIVACY_TEXT, "utf8");
      const query = "privacy file query";
      const report = "## Provider Only Section\n\nProvider body.";

      const plain = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rA = await runResearch(["--provider", "tavily", "research", query], {
        providers: [plain],
      });

      const withCtx = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rB = await runResearch(
        ["--provider", "tavily", "research", query, "--context", notesPath],
        { providers: [withCtx] },
      );

      assert.strictEqual(rA.status, 0);
      assert.strictEqual(rB.status, 0, `stderr: ${JSON.stringify(rB.stderr)}`);
      assert.strictEqual(withCtx.invokes.length, 1);
      assert.deepStrictEqual(withCtx.invokes[0], plain.invokes[0]);
      assert.deepStrictEqual(withCtx.invokes[0], { query });
      const parsed = JSON.parse(rB.stdout[0]);
      assert.deepStrictEqual(parsed.context, {
        source: "file",
        path: notesPath,
        sha256: sha256of(PRIVACY_TEXT),
        mode: "organize",
        derived: { headings: 1, questions: 1, terms: 5 },
      });
      assertNoMarkerIn("the envelope context field", [JSON.stringify(parsed.context)]);
      assertNoMarkerIn("stderr", rB.stderr);
    });
  });

  it("search --context-stdin: requests carry the query only (derived strings are the one permitted wire shape); envelope/notices stay content-free", async () => {
    const tavily = makeSearchProvider({ id: "tavily", results: [] });
    const r = await runSearch(
      ["--provider", "tavily", "search", "privacy search query", "--context-stdin"],
      { providers: [tavily], stdin: PRIVACY_TEXT },
    );
    assert.strictEqual(r.status, 0, `stderr: ${JSON.stringify(r.stderr)}`);
    // D6: the derived sub-query strings ARE the queries — the single
    // permitted content-carrying wire shape for search. Nothing else
    // rides along: request objects carry the query key only.
    assert.deepStrictEqual(
      tavily.invokes.map((req) => req.query),
      ["privacy search query", "Quokka Habitat Overview", "How do quokkas smile"],
    );
    for (const req of tavily.invokes) {
      assert.deepStrictEqual(Object.keys(req), ["query"], "requests carry the query only");
    }
    // The wrapper's context field: counts + hash, no path under stdin.
    const parsed = JSON.parse(r.stdout[0]);
    assert.deepStrictEqual(parsed.context, {
      source: "stdin",
      sha256: sha256of(PRIVACY_TEXT),
      derived: { headings: 1, questions: 1, terms: 5, subQueries: 2 },
    });
    // No envelope context field, notice, or log line carries content —
    // in particular the prose file bytes ("xylophone"/"checkpoint"),
    // which are never derived into any constructed wire shape.
    assertNoMarkerIn("the envelope context field", [JSON.stringify(parsed.context)]);
    assertNoMarkerIn("stderr", r.stderr);
  });
});
