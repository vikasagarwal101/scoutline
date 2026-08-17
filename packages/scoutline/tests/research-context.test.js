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
 * Ticket 3 (bias/both + resume):
 *   - D2.5: bias/both mutate a LOCAL query copy before
 *     `buildResearchRequest`; the wire request differs from no-context
 *     by exactly the appended `(focus: ...)` segment (string-level).
 *   - Determinism: same file → same request twice → same async-job
 *     state hash (`computeAsyncJobStateHash`); and the identity hash
 *     FRAGMENTS vs organize mode (cache-identity fragmentation).
 *   - D5 resume command: carries the ORIGINAL un-mutated query plus
 *     `--context <path>` (shell-quoted, any mode) and `--context-mode
 *     <mode>` (only when explicitly set); stdin sources carry
 *     `--context-stdin`; RESEARCH_HELP notes the re-pipe requirement.
 *   - Resume roundtrip: re-running the tokenized resume command with
 *     an unchanged file reproduces the identity hash (no second job).
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
import { RESEARCH_HELP } from "../dist/commands/research.js";
import { computeAsyncJobStateHash } from "../dist/lib/async-job-state.js";
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
async function runResearch(argv, { providers, stdin, env, captureResume = false } = {}) {
  const cache = makeRecordingCache();
  const io = makeAdapter({ stdin });
  // Ticket 3: capture the per-attempt (stateFilePath, resumeCommand)
  // pairs through the `researchRegisterInterrupt` seam so resume-
  // command assertions run against exactly what the SIGINT handler
  // would print (the `tests/async-fallback.test.js` injection shape).
  const resumes = [];
  const deps = {
    invocation: io.adapter,
    env: env ?? { TAVILY_API_KEY: "tv", EXA_API_KEY: "exa" },
    providerDescriptors: providers.map((p) => p.descriptor),
    researchCache: cache,
  };
  if (captureResume) {
    deps.researchRegisterInterrupt = (stateFilePath, resumeCommand) => {
      resumes.push({ stateFilePath, resumeCommand });
      return () => () => {};
    };
  }
  const status = await main(argv, deps);
  return {
    status,
    stdout: io.stdout,
    stderr: io.stderr,
    cache,
    stdinCalls: io.stdinCalls,
    resumes,
  };
}

/**
 * Tokenize a resume command string the way a POSIX shell would
 * (double quotes with backslash-escaped `\ $ ` "` specials) so a
 * roundtrip test can re-run the printed command through `main()`
 * without a real shell. Mirrors `shellQuote` in commands/research.ts.
 */
function shellTokens(line) {
  const tokens = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\\") {
        current += line[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === " ") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Mirror the identity hash `research()` derives from the winning
 * capability's `cacheIdentity(request)` (see commands/research.ts) —
 * the fake provider's fingerprint shape is `fp-<id>`.
 */
function stateHashFor(providerId, request) {
  return computeAsyncJobStateHash({
    provider: providerId,
    capability: "research",
    credentialFingerprint: `fp-${providerId}`,
    request,
  });
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

describe("research --context organize — non-Latin headings (empty slug guard)", () => {
  it("does not fuse non-Latin headings with unrelated non-Latin sections", async (t) => {
    await withTempDir(t, async (dir) => {
      const report = [
        "## 概要",
        "",
        "Provider overview body.",
        "",
        "## Sources",
        "",
        "1. [S](https://s.example.com/x)",
      ].join("\n");
      const notesPath = path.join(dir, "notes.md");
      const notesText = "# デプロイ手順\n";
      await fs.writeFile(notesPath, notesText, "utf8");

      const tavily = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const r = await runResearch(
        ["--provider", "tavily", "research", "non latin query", "--context", notesPath],
        { providers: [tavily] },
      );

      assert.strictEqual(r.status, 0);
      const parsed = JSON.parse(r.stdout[0]);
      assert.deepStrictEqual(parsed.sections, [
        { heading: "デプロイ手順", body: "(no matching section in the provider report)" },
        { heading: "概要", body: "Provider overview body." },
      ]);
    });
  });
});


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

// ---------------------------------------------------------------------------
// Ticket 3 — bias/both query mutation (DESIGN D2.5 + D5)
// ---------------------------------------------------------------------------

describe("research --context bias/both — D2.5 query mutation (Ticket 3)", () => {
  it("bias request differs from no-context by exactly the appended segment", async (t) => {
    await withTempDir(t, async (dir) => {
      // Terms: "alpha", "notes" from the heading; "what"/"is" filtered
      // (stopword / <4 chars); "beta" from the question.
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Alpha Notes\nWhat is beta?\n", "utf8");
      const query = "bias segment query";
      const segment = " (focus: alpha, notes, beta)";
      const report = "## A\n\nbody";

      const plain = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rA = await runResearch(["--provider", "tavily", "research", query], {
        providers: [plain],
      });
      const biased = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rB = await runResearch(
        ["--provider", "tavily", "research", query, "--context", notesPath, "--context-mode", "bias"],
        { providers: [biased] },
      );

      assert.strictEqual(rA.status, 0);
      assert.strictEqual(rB.status, 0);
      assert.strictEqual(plain.invokes[0].query, query);
      // String-level: the ONLY difference from the no-context request
      // is the appended (focus: ...) segment (D2.5).
      assert.strictEqual(biased.invokes[0].query, query + segment);
      assert.strictEqual(biased.invokes[0].query, plain.invokes[0].query + segment);
      assert.deepStrictEqual(
        { ...biased.invokes[0], query: plain.invokes[0].query },
        plain.invokes[0],
        "no other request field may change under bias",
      );
      // The envelope still records the local parse under mode bias.
      assert.strictEqual(JSON.parse(rB.stdout[0]).context.mode, "bias");
    });
  });

  it("both mode mutates the query AND re-maps sections", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Alpha Notes\nWhat is beta?\n", "utf8");
      const report = "## ALPHA NOTES\n\nProvider body.\n\n## Other\n\nOther body.";
      const tavily = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const r = await runResearch(
        [
          "--provider",
          "tavily",
          "research",
          "both mode query",
          "--context",
          notesPath,
          "--context-mode",
          "both",
        ],
        { providers: [tavily] },
      );

      assert.strictEqual(r.status, 0);
      assert.strictEqual(
        tavily.invokes[0].query,
        "both mode query (focus: alpha, notes, beta)",
      );
      const parsed = JSON.parse(r.stdout[0]);
      assert.deepStrictEqual(parsed.sections, [
        { heading: "Alpha Notes", body: "Provider body." },
        { heading: "Other", body: "Other body." },
      ]);
      assert.strictEqual(parsed.context.mode, "both");
    });
  });
});

// ---------------------------------------------------------------------------
// Ticket 3 — determinism + cache-identity fragmentation (DESIGN D5)
// ---------------------------------------------------------------------------

describe("research --context bias — determinism + cache fragmentation (Ticket 3)", () => {
  it("same file → same request twice → same async-job state hash", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Alpha Notes\nWhat is beta?\n", "utf8");
      const argv = [
        "--provider",
        "tavily",
        "research",
        "determinism query",
        "--context",
        notesPath,
        "--context-mode",
        "bias",
      ];
      const report = "## A\n\nbody";

      const first = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const r1 = await runResearch(argv, { providers: [first], captureResume: true });
      const second = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const r2 = await runResearch(argv, { providers: [second], captureResume: true });

      assert.strictEqual(r1.status, 0);
      assert.strictEqual(r2.status, 0);
      // The hashed request is the MUTATED one (D2.5 applies before
      // buildResearchRequest) — pin it so the hash assertions below
      // cannot pass vacuously on the un-mutated query.
      assert.strictEqual(
        first.invokes[0].query,
        "determinism query (focus: alpha, notes, beta)",
      );
      assert.deepStrictEqual(second.invokes[0], first.invokes[0]);
      assert.strictEqual(stateHashFor("tavily", second.invokes[0]), stateHashFor("tavily", first.invokes[0]));
      // The handler-derived state-file path embeds the same identity
      // hash (<state-dir>/<hash>.json), so a resume finds the job.
      assert.strictEqual(r2.resumes[0].stateFilePath, r1.resumes[0].stateFilePath);
    });
  });

  it("identity hash fragments vs organize mode (cache-identity fragmentation)", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Alpha Notes\nWhat is beta?\n", "utf8");
      const report = "## A\n\nbody";

      const organizing = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rOrganize = await runResearch(
        ["--provider", "tavily", "research", "fragment query", "--context", notesPath],
        { providers: [organizing], captureResume: true },
      );
      const biasing = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const rBias = await runResearch(
        [
          "--provider",
          "tavily",
          "research",
          "fragment query",
          "--context",
          notesPath,
          "--context-mode",
          "bias",
        ],
        { providers: [biasing], captureResume: true },
      );

      assert.strictEqual(rOrganize.status, 0);
      assert.strictEqual(rBias.status, 0);
      // Organize leaves the request untouched (Ticket 2 golden); bias
      // appends the focus segment — so the partitioned identity hash
      // MUST differ (D5: the cache fragments naturally under bias).
      assert.notStrictEqual(
        stateHashFor("tavily", biasing.invokes[0]),
        stateHashFor("tavily", organizing.invokes[0]),
      );
      assert.notStrictEqual(rBias.resumes[0].stateFilePath, rOrganize.resumes[0].stateFilePath);
    });
  });
});

// ---------------------------------------------------------------------------
// Ticket 3 — resume command context flags (DESIGN D5) + re-pipe help note
// ---------------------------------------------------------------------------

describe("research resume command — context flags (Ticket 3, DESIGN D5)", () => {
  it("bias/both snapshot: original query + shell-quoted --context <path> + --context-mode", async (t) => {
    await withTempDir(t, async (dir) => {
      // Space in the path proves the shellQuote round-trip.
      const notesPath = path.join(dir, "my notes.md");
      await fs.writeFile(notesPath, "# Alpha Notes\nWhat is beta?\n", "utf8");
      for (const mode of ["bias", "both"]) {
        const tavily = makeResearchProvider({
          id: "tavily",
          envVar: "TAVILY_API_KEY",
          ok: researchOk("## A\n\nbody"),
        });
        const r = await runResearch(
          [
            "--provider",
            "tavily",
            "research",
            "resume snapshot query",
            "--model",
            "pro",
            "--context",
            notesPath,
            "--context-mode",
            mode,
          ],
          { providers: [tavily], captureResume: true },
        );

        assert.strictEqual(r.status, 0);
        assert.strictEqual(r.resumes.length, 1, `one attempt under mode ${mode}`);
        // Context flags append after the identity-bearing options; the
        // query in the command is the ORIGINAL un-mutated one (D5).
        assert.strictEqual(
          r.resumes[0].resumeCommand,
          `scoutline --no-fallback --provider tavily research "resume snapshot query" --model pro --context "${notesPath}" --context-mode ${mode}`,
        );
        assert.ok(
          !r.resumes[0].resumeCommand.includes("(focus:"),
          "the resume command must not embed the D2.5 bias append",
        );
      }
    });
  });

  it("organize resume: carries --context <path> only (defaulted mode omitted); re-run reproduces the envelope context field", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "organize notes.md");
      await fs.writeFile(notesPath, "# Alpha Notes\nWhat is beta?\n", "utf8");
      const report = "## alpha notes\n\nProvider body.\n\n## Other\n\nOther body.";

      const first = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const r1 = await runResearch(
        ["--provider", "tavily", "research", "organize resume query", "--context", notesPath],
        { providers: [first], captureResume: true },
      );
      assert.strictEqual(r1.status, 0);
      // `--context` is output-bearing under organize too (the resumed
      // run re-maps sections + re-emits the envelope field), while the
      // defaulted mode stays omitted (the function's convention).
      assert.strictEqual(
        r1.resumes[0].resumeCommand,
        `scoutline --no-fallback --provider tavily research "organize resume query" --context "${notesPath}"`,
      );

      const argv = shellTokens(r1.resumes[0].resumeCommand).slice(1);
      assert.deepStrictEqual(argv, [
        "--no-fallback",
        "--provider",
        "tavily",
        "research",
        "organize resume query",
        "--context",
        notesPath,
      ]);
      const second = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk(report),
      });
      const r2 = await runResearch(argv, { providers: [second] });
      assert.strictEqual(r2.status, 0);

      const envelope1 = JSON.parse(r1.stdout[0]);
      const envelope2 = JSON.parse(r2.stdout[0]);
      assert.deepStrictEqual(envelope2.context, envelope1.context);
      assert.deepStrictEqual(envelope2.sections, envelope1.sections);
    });
  });

  it("stdin + bias: command carries --context-stdin + --context-mode; help mandates re-piping the same content", async () => {
    const stdinText = "# Notes\nWhat is this?\n";
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: researchOk("## Notes\n\nbody"),
    });
    const r = await runResearch(
      ["--provider", "tavily", "research", "stdin bias query", "--context-stdin", "--context-mode", "bias"],
      { providers: [tavily], captureResume: true, stdin: stdinText },
    );

    assert.strictEqual(r.status, 0);
    assert.strictEqual(
      r.resumes[0].resumeCommand,
      'scoutline --no-fallback --provider tavily research "stdin bias query" --context-stdin --context-mode bias',
    );
    // The piped content still biases the wire query (terms: "notes").
    assert.strictEqual(tavily.invokes[0].query, "stdin bias query (focus: notes)");

    // Help-text test (D5): piped bytes cannot be embedded in a shell
    // command — help must tell the user to re-pipe the same content.
    assert.ok(
      RESEARCH_HELP.includes("--context-stdin"),
      "RESEARCH_HELP must mention --context-stdin",
    );
    assert.match(RESEARCH_HELP, /re-pipe the same content unchanged/);
  });

  it("resume roundtrip: re-running the printed command reproduces the identity hash (no second job)", async (t) => {
    await withTempDir(t, async (dir) => {
      const notesPath = path.join(dir, "notes.md");
      await fs.writeFile(notesPath, "# Alpha Notes\nWhat is beta?\n", "utf8");

      const first = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk("## A\n\nbody"),
      });
      const r1 = await runResearch(
        ["--provider", "tavily", "research", "roundtrip query", "--context", notesPath, "--context-mode", "both"],
        { providers: [first], captureResume: true },
      );
      assert.strictEqual(r1.status, 0);

      const argv = shellTokens(r1.resumes[0].resumeCommand).slice(1);
      assert.deepStrictEqual(argv, [
        "--no-fallback",
        "--provider",
        "tavily",
        "research",
        "roundtrip query",
        "--context",
        notesPath,
        "--context-mode",
        "both",
      ]);
      const second = makeResearchProvider({
        id: "tavily",
        envVar: "TAVILY_API_KEY",
        ok: researchOk("## A\n\nbody"),
      });
      const r2 = await runResearch(argv, { providers: [second], captureResume: true });
      assert.strictEqual(r2.status, 0);

      // Unchanged source + identical flags → identical mutation →
      // identical request → identical state hash: the resumed run
      // polls the SAME job instead of starting a second paid one.
      assert.deepStrictEqual(second.invokes[0], first.invokes[0]);
      assert.strictEqual(stateHashFor("tavily", second.invokes[0]), stateHashFor("tavily", first.invokes[0]));
      assert.strictEqual(r2.resumes[0].stateFilePath, r1.resumes[0].stateFilePath);
    });
  });
});
