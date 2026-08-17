/**
 * Research `--context` organize — Ticket 2 (local-context plan,
 * docs/plans/local-context TASKS.md / DESIGN.md D1, D3, D4, D5).
 *
 * Handler-level tests driving `main(deps)` with injected
 * MainDependencies (fake invocation adapter + provider doubles; the
 * `tests/bin.test.js` / `tests/async-fallback.test.js` precedent —
 * `handleResearch` is module-private and not importable).
 *
 * Coverage:
 *   - Flag surface: the `--context` value-shape check runs BEFORE the
 *     positional help-gate (VALIDATION_ERROR, never HELP + exit 0);
 *     `--context-mode` post-gate enum validation (validateModel shape).
 *   - Cache-key golden: organize leaves the request object deep-equal
 *     to the no-context request and the cache key identical (D5).
 *   - D4 re-mapping: exact slug matches, unmatched in both directions,
 *     multi-section slug concatenation in provider order, the
 *     sources-heading filter still applied upstream, and the
 *     presentation rebuild (markdown mode).
 *   - Envelope `context` field shape (D5): source / path / sha256 /
 *     mode / derived counts — never content.
 *   - Empty context file: organize is a structural no-op with the
 *     envelope field still present.
 *   - Stdin + provider fallback: the source is read exactly ONCE in
 *     the handler (the fake adapter drains after the first readStdin,
 *     mirroring the Node adapter), so the fallback retry builds the
 *     SAME request as the first attempt (D5 second-paid-job trap).
 *
 * 100% offline: provider doubles, in-memory caches, tmpdir-only fs.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { TimeoutError } from "../dist/lib/errors.js";
import { withTempDir } from "./helpers/temp-dir.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Provider descriptor whose Adapter exposes a fake research Capability
 * (`tests/async-fallback.test.js` shape): a `run` slot wrapping
 * validate / cacheIdentity / invoke. `invokes` records every request
 * that crossed the wire so the cache-identity golden can compare the
 * exact request objects. `error` makes every invoke throw (drives the
 * fallback executor to the next candidate).
 */
function makeResearchProvider({ id, envVar, ok, error }) {
  const invokes = [];
  const identity = {
    provider: id,
    capability: "research",
    credentialFingerprint: `fp-${id}`,
    request: undefined,
    legacyCandidates: [],
  };
  const operation = {
    kind: "research-run",
    validate() {},
    cacheIdentity(request) {
      return { ...identity, request };
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
 * Fake invocation adapter. The readStdin double mirrors the Node
 * adapter's drain semantics: process.stdin is consumed by the first
 * read, so every later read yields "". If any code path re-read the
 * stdin context source (e.g. per fallback attempt), the second read
 * would silently return "" — exactly the D5 trap this suite pins.
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

/** In-memory ResponseCache that records every written cache key. */
function makeRecordingCache() {
  const store = new Map();
  const writtenKeys = [];
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      writtenKeys.push(key);
      store.set(key, value);
    },
    writtenKeys,
  };
}

/** Research result double for a fixed provider report. */
function researchOk(report) {
  return (request) => ({
    schemaVersion: 1,
    query: request.query,
    model: request.model ?? "auto",
    report,
    sources: [{ title: "Provider source", url: "https://example.com/s" }],
  });
}

/** Drive `main()` with fresh doubles; returns captures for assertions. */
async function runResearch(argv, { providers, stdin, env } = {}) {
  const cache = makeRecordingCache();
  const io = makeAdapter({ stdin });
  const status = await main(argv, {
    invocation: io.adapter,
    env: env ?? { TAVILY_API_KEY: "tv", EXA_API_KEY: "exa" },
    providerDescriptors: providers.map((p) => p.descriptor),
    researchCache: cache,
  });
  return {
    status,
    stdout: io.stdout,
    stderr: io.stderr,
    cache,
    stdinCalls: io.stdinCalls,
  };
}

const sha256of = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// Keep injected env credentials from leaking into process.env-driven
// selections (same hygiene as tests/async-fallback.test.js).
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
// Flag surface (DESIGN D1)
// ---------------------------------------------------------------------------

describe("research --context — flag surface (Ticket 2)", () => {
  it("--context without a value is VALIDATION_ERROR before the help gate", async () => {
    // parseArgs records `true` for a valueless flag and leaves
    // positional empty; without the pre-gate check the help gate would
    // short-circuit to HELP + exit 0 and silently swallow the flag.
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: researchOk("## A\n\nbody"),
    });
    const r = await runResearch(["--provider", "tavily", "research", "--context"], {
      providers: [tavily],
    });
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

  it("invalid --context-mode value is VALIDATION_ERROR (validateModel shape)", async () => {
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: researchOk("## A\n\nbody"),
    });
    const r = await runResearch(
      ["--provider", "tavily", "research", "q", "--context-mode", "zoom"],
      { providers: [tavily] },
    );
    assert.strictEqual(r.status, 1);
    const err = JSON.parse(r.stderr[0]);
    assert.strictEqual(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /Invalid --context-mode value "zoom"/);
    assert.match(err.error, /organize, bias, both/);
    assert.strictEqual(tavily.invokes.length, 0, "no provider may be invoked");
  });
});

// ---------------------------------------------------------------------------
// Cache-identity golden (DESIGN D5)
// ---------------------------------------------------------------------------

describe("research --context organize — cache-identity golden (Ticket 2)", () => {
  it("organize leaves the request deep-equal to the no-context request", async (t) => {
    await withTempDir(t, async (dir) => {
      const report = "## Alpha\n\nAlpha body.\n\n## Beta\n\nBeta body.";
      const notesPath = path.join(dir, "notes.md");
      const notesText = "# Notes Heading\nSome question?\n";
      await fs.writeFile(notesPath, notesText, "utf8");

      const plain = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rA = await runResearch(["--provider", "tavily", "research", "cache identity"], {
        providers: [plain],
      });

      const withCtx = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rB = await runResearch(
        ["--provider", "tavily", "research", "cache identity", "--context", notesPath],
        { providers: [withCtx] },
      );

      assert.strictEqual(rA.status, 0);
      assert.strictEqual(rB.status, 0);
      assert.strictEqual(plain.invokes.length, 1);
      assert.strictEqual(withCtx.invokes.length, 1);
      // The exact request object crossing the wire is unchanged.
      assert.deepStrictEqual(withCtx.invokes[0], plain.invokes[0]);
      assert.deepStrictEqual(withCtx.invokes[0], { query: "cache identity" });
      // ... and so is the partitioned cache key it hashes to.
      assert.strictEqual(rA.cache.writtenKeys.length, 1);
      assert.strictEqual(rB.cache.writtenKeys.length, 1);
      assert.strictEqual(rB.cache.writtenKeys[0], rA.cache.writtenKeys[0]);

      const envelopeA = JSON.parse(rA.stdout[0]);
      assert.ok(!("context" in envelopeA), "no-context envelope must not carry a context field");
    });
  });
});

// ---------------------------------------------------------------------------
// D4 section re-mapping + envelope field
// ---------------------------------------------------------------------------

describe("research --context organize — D4 re-mapping (Ticket 2)", () => {
  it("re-maps provider sections onto context headings by exact slug", async (t) => {
    await withTempDir(t, async (dir) => {
      // Provider report: two sections slug-matching one context heading
      // (multi-section concatenation), one context heading with no
      // match (placeholder body), two provider sections no context
      // heading claims (appended in original order), and a Sources
      // heading that parseReportSections must filter upstream.
      const report = [
        "## Overview",
        "",
        "Provider overview body.",
        "",
        "## DEPLOYMENT GUIDE",
        "",
        "Deploy part one.",
        "",
        "## deployment guide",
        "",
        "Deploy part two.",
        "",
        "## Extra Provider Section",
        "",
        "Not in context.",
        "",
        "## Sources",
        "",
        "1. [S](https://s.example.com/x)",
      ].join("\n");
      const notesPath = path.join(dir, "notes.md");
      const notesText = "# Deployment Guide\nHow do we deploy?\n\n## Risks\n";
      await fs.writeFile(notesPath, notesText, "utf8");

      const tavily = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const r = await runResearch(
        ["--provider", "tavily", "research", "re-map query", "--context", notesPath],
        { providers: [tavily] },
      );

      assert.strictEqual(r.status, 0);
      const parsed = JSON.parse(r.stdout[0]);
      assert.deepStrictEqual(parsed.sections, [
        {
          heading: "Deployment Guide",
          body: "Deploy part one.\n\nDeploy part two.",
        },
        { heading: "Risks", body: "(no matching section in the provider report)" },
        { heading: "Overview", body: "Provider overview body." },
        { heading: "Extra Provider Section", body: "Not in context." },
      ]);
      // The sources/references filter stays upstream of the re-map.
      assert.ok(
        !parsed.sections.some((s) => /^(sources?|references?|citations?)$/i.test(s.heading)),
        `sources heading must be filtered upstream, got ${JSON.stringify(parsed.sections)}`,
      );
      // Envelope field shape (D5) — counts only, never content.
      assert.deepStrictEqual(parsed.context, {
        source: "file",
        path: notesPath,
        sha256: sha256of(notesText),
        mode: "organize",
        derived: { headings: 2, questions: 1, terms: 4 },
      });
    });
  });

  it("rebuilds presentations on the re-mapped sections (markdown mode)", async (t) => {
    await withTempDir(t, async (dir) => {
      const report = "## deployment guide\n\nDeploy body.\n\n## Other\n\nOther body.";
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Deployment Guide\n", "utf8");

      const tavily = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const r = await runResearch(
        [
          "--provider",
          "tavily",
          "-O",
          "markdown",
          "research",
          "presentation query",
          "--context",
          notesPath,
        ],
        { providers: [tavily] },
      );

      assert.strictEqual(r.status, 0);
      const md = r.stdout[0];
      assert.match(md, /## Deployment Guide\n\nDeploy body\./);
      assert.match(md, /## Other\n\nOther body\./);
    });
  });

  it("empty context file: organize is a no-op but the envelope field is present", async (t) => {
    await withTempDir(t, async (dir) => {
      const report = "## Alpha\n\nAlpha body.\n\n## Beta\n\nBeta body.";
      const emptyPath = path.join(dir, "empty.md");
      await fs.writeFile(emptyPath, "", "utf8");

      const plain = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rA = await runResearch(["--provider", "tavily", "research", "empty ctx"], {
        providers: [plain],
      });

      const withCtx = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rB = await runResearch(
        [
          "--provider",
          "tavily",
          "research",
          "empty ctx",
          "--context",
          emptyPath,
          "--context-mode",
          "organize",
        ],
        { providers: [withCtx] },
      );

      assert.strictEqual(rA.status, 0);
      assert.strictEqual(rB.status, 0);
      const parsedA = JSON.parse(rA.stdout[0]);
      const parsedB = JSON.parse(rB.stdout[0]);
      // Zero context headings: every provider section is unmatched and
      // appended in original order — structurally identical output.
      assert.deepStrictEqual(parsedB.sections, parsedA.sections);
      // The field is still present with zeroed counts.
      assert.deepStrictEqual(parsedB.context, {
        source: "file",
        path: emptyPath,
        sha256: sha256of(""),
        mode: "organize",
        derived: { headings: 0, questions: 0, terms: 0 },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Stdin source + provider fallback (DESIGN D3/D5)
// ---------------------------------------------------------------------------

describe("research --context-stdin — read once across fallback (Ticket 2)", () => {
  it("stdin source is read exactly once; the retry builds the SAME request", async () => {
    const stdinText = "# Notes\nWhat is this?\n";
    // First candidate rejects at runtime -> executor falls back to exa.
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      error: new TimeoutError(300_000),
    });
    const exa = makeResearchProvider({
      id: "exa",
      envVar: "EXA_API_KEY",
      ok: researchOk("## Notes\n\nExa body."),
    });
    const r = await runResearch(
      ["--provider", "tavily", "research", "fallback query", "--context-stdin"],
      {
        providers: [tavily, exa],
        stdin: stdinText,
        env: { TAVILY_API_KEY: "tv", EXA_API_KEY: "exa" },
      },
    );

    assert.strictEqual(r.status, 0);
    assert.strictEqual(tavily.invokes.length, 1, "first attempt ran");
    assert.strictEqual(exa.invokes.length, 1, "fallback attempt ran");
    // The retry attempt builds the SAME request as the first attempt:
    // the source was read once in the handler, not per-attempt inside
    // research() (a per-attempt read would drain to "" and diverge).
    assert.deepStrictEqual(exa.invokes[0], tavily.invokes[0]);
    assert.deepStrictEqual(exa.invokes[0], { query: "fallback query" });
    // Direct proof: the adapter's stdin was read exactly once (the
    // double returns "" on every later read, Node adapter semantics).
    assert.strictEqual(r.stdinCalls(), 1);

    const parsed = JSON.parse(r.stdout[0]);
    assert.deepStrictEqual(parsed.context, {
      source: "stdin",
      sha256: sha256of(stdinText),
      mode: "organize",
      derived: { headings: 1, questions: 1, terms: 1 },
    });
  });
});
