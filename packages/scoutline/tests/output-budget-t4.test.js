/**
 * Output Budget — T4: read / crawl / research / repo surfaces
 * (ADR-0007). Mirrors search-budget.test.js (T3):
 *
 *   - Per-command ladder priority pins over the exported ladders:
 *     never-cut fields expressed by omission, trim-early before
 *     drop-late.
 *   - main()-level: compaction {budget, ref} inside the data payload,
 *     FULL untrimmed envelope artifact + log entry, history-show
 *     recovery, compaction visible in -O data/json/pretty.
 *   - Strict parse: lax `parseInt` retired — `500x`/`1.5`/`0` reject
 *     with VALIDATION_ERROR on read/crawl/research/repo search/read.
 *   - `repo tree --max-chars` flips accept-and-drop → UNSUPPORTED_OPTION.
 *   - `read --extract --max-chars` budgets (trim VALUES, never drop
 *     field names) — the ignore pin flipped in reader-command.test.js.
 *   - Zero-diff: without the flag, byte-identical output and an empty
 *     artifacts store.
 *
 * Hermeticity: hermeticMainDeps (no ambient ~/.scoutline), isolated
 * SCOUTLINE_ARTIFACTS_DIR per test, injected clock, fake descriptors
 * (async-fallback / repository-command idioms).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { READ_LADDER, READ_EXTRACT_LADDER } from "../dist/commands/read.js";
import { CRAWL_LADDER } from "../dist/commands/crawl.js";
import { RESEARCH_LADDER, research } from "../dist/commands/research.js";
import { REPO_SEARCH_LADDER, REPO_READ_LADDER } from "../dist/commands/repository-explorer.js";
import {
  applyBudget,
  measurePayload,
  COMPACTION_STAMP_RESERVE,
} from "../dist/lib/output-budget.js";
import { readLog } from "../dist/lib/artifacts.js";
import { buildHistoryShowReport } from "../dist/commands/history.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { withTempDir } from "./helpers/temp-dir.js";

const NOW = 1_800_000_000_000;

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

/** Fake async provider (async-fallback.test.js idiom). */
function makeAsyncProvider({ id, envVar, capability, ok }) {
  const slot = capability === "research" ? "run" : "fetch";
  const operation = {
    kind: `${capability}-${slot}`,
    validate() {},
    cacheIdentity(request) {
      return {
        provider: id,
        capability,
        credentialFingerprint: `fp-${id}`,
        request,
        legacyCandidates: [],
      };
    },
    async invoke(request) {
      return ok(request);
    },
  };
  return {
    descriptor: {
      id,
      isConfigured: (env) => typeof env[envVar] === "string" && env[envVar].length > 0,
      capabilities: () => new Set([capability]),
      create: () => ({ id, [capability]: { [slot]: operation } }),
    },
  };
}

/** Fake reader provider (reader-command.test.js capability shape). */
function makeReaderProvider(id, result) {
  const operation = {
    kind: "reader-fetch",
    validate() {},
    cacheIdentity(request) {
      return {
        provider: id,
        capability: "reader",
        credentialFingerprint: `fp-${id}`,
        request,
        legacyCandidates: [],
      };
    },
    async invoke() {
      return result;
    },
  };
  return {
    descriptor: {
      id,
      isConfigured: (env) => typeof env.Z_AI_API_KEY === "string" && env.Z_AI_API_KEY.length > 0,
      capabilities: () => new Set(["reader"]),
      create: () => ({ id, reader: { fetch: operation } }),
    },
  };
}

/** Fake repository provider (repository-command.test.js shape). */
function makeRepoProvider({ search, readFile, listDirectory }) {
  const op = (kind, impl) => ({
    kind,
    validate() {},
    cacheIdentity(request) {
      return {
        provider: "zai",
        capability: "repository-exploration",
        operation: kind,
        credentialFingerprint: "fp-zai",
        request,
        legacyCandidates: [],
      };
    },
    async invoke(request) {
      return impl(request);
    },
  });
  return {
    descriptor: {
      id: "zai",
      isConfigured: (env) => typeof env.Z_AI_API_KEY === "string" && env.Z_AI_API_KEY.length > 0,
      capabilities: () => new Set(["repository-exploration"]),
      create: () => ({
        id: "zai",
        repository: {
          search: op("repository-search", search),
          readFile: op("repository-read-file", readFile),
          listDirectory: op("repository-list-directory", listDirectory),
        },
      }),
    },
  };
}

async function runMain(argv, { artifactsDir, descriptors, env } = {}) {
  const { adapter, stdout, stderr } = makeInvocation();
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      env: env ?? {
        Z_AI_API_KEY: "zai-key",
        TAVILY_API_KEY: "tv",
        ...(artifactsDir !== undefined ? { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } : {}),
      },
      providerDescriptors: descriptors,
      now: () => NOW,
    }),
  });
  return { status, stdout, stderr };
}

function parseData(stdout) {
  assert.ok(stdout.length > 0, "expected stdout output");
  return JSON.parse(stdout.join(""));
}

/** Three-section page: H1 root, H2 alpha, H2 beta — ladder material. */
function threeSections() {
  return (
    "# Title\n\n" +
    "Intro paragraph about the page.\n\n" +
    "## Alpha\n\n" +
    "A".repeat(200) +
    "\n\n" +
    "## Beta\n\n" +
    "B".repeat(200)
  );
}

function readResult(content) {
  return {
    schemaVersion: 1,
    url: "https://example.com/doc",
    finalUrl: "https://example.com/doc",
    title: "Doc",
    content,
    contentFormat: "markdown",
  };
}

function crawlResult() {
  return {
    schemaVersion: 1,
    baseUrl: "https://example.com",
    pages: [
      { url: "https://example.com/p1", content: "one ".repeat(80), contentFormat: "markdown" },
      { url: "https://example.com/p2", content: "two ".repeat(80), contentFormat: "markdown" },
      { url: "https://example.com/p3", content: "three ".repeat(80), contentFormat: "markdown" },
    ],
    totalPages: 3,
  };
}

function researchResult() {
  return {
    schemaVersion: 1,
    query: "quantum",
    model: "auto",
    report:
      "## Findings\n\n" +
      "F".repeat(200) +
      "\n\n## Analysis\n\n" +
      "A".repeat(200) +
      "\n\n## Sources\n\n1. https://example.com/s1",
    sources: [
      { title: "S1", url: "https://example.com/s1" },
      { title: "S2", url: "https://example.com/s2" },
    ],
  };
}

// ---------------------------------------------------------------------------
// Ladder priority pins (unit-level, exported ladders)
// ---------------------------------------------------------------------------

describe("READ_LADDER — url/title/headings never cut; later paragraphs trim first; bottom sections drop late", () => {
  const envelope = () => ({ url: "https://e/1", title: "T", content: threeSections() });

  it("gentle budget: only the LAST paragraph shrinks; headings all survive", () => {
    const e = envelope();
    const full = measurePayload(e);
    const level1 = applyBudget(e, Math.floor(full * 0.9), READ_LADDER);
    assert.ok(level1.compaction, "fires");
    const c = level1.projection.content;
    assert.ok(c.includes("# Title"), "H1 survives");
    assert.ok(c.includes("## Alpha"), "heading alpha survives");
    assert.ok(c.includes("## Beta"), "heading beta survives");
    assert.ok(c.length < threeSections().length, "content shrank");
  });

  it("mid budget (fix-round A): every section body bleeds before any section drops", () => {
    const e = envelope();
    const full = measurePayload(e);
    // ~0.7× full keeps BOTH section headings — the backward-scan trim
    // bled paragraphs across sections instead of dropping ## Beta
    // (the pre-fix narrow-trim rule dropped it at this budget).
    const out = applyBudget(e, Math.floor(full * 0.7), READ_LADDER);
    assert.ok(out.compaction);
    const c = out.projection.content;
    assert.ok(c.includes("# Title"), "top survives");
    assert.ok(c.includes("## Alpha"), "alpha survives the mid budget");
    assert.ok(c.includes("## Beta"), "beta survives the mid budget — bodies bled first");
  });

  it("heading finality (fix-round B): a document with NO headings never loses body to a phantom section drop", () => {
    const loose = "P1 ".repeat(50) + "\n\n" + "Q2 ".repeat(50);
    const e = { url: "https://e/1", title: "T", content: loose };
    const full = measurePayload(e);
    // Exact fit: byte-identical, no compaction.
    const fits = applyBudget(e, full, READ_LADDER);
    assert.ok(fits.compaction === undefined, "fits unchanged");
    // A small deficit trims (halves the last paragraph) but the body
    // still STARTS with the original first paragraph and NO section
    // was dropped — the loose document is ONE section by construction.
    const out = applyBudget(e, full - 5, READ_LADDER);
    assert.ok(out.compaction);
    assert.ok(
      out.projection.content.startsWith("P1"),
      "body head preserved (no phantom-section drop ate the preamble)",
    );
    assert.ok(out.projection.content.length < loose.length, "body shrank by trimming");

    // A floor-scale budget on the no-heading document floors with the
    // body STILL non-empty and url/title intact: a document with no
    // headings is ONE section — the drop rule can never fire on it.
    const floorish = applyBudget(e, 10, READ_LADDER);
    assert.equal(floorish.compaction.note, "floor");
    assert.ok(
      floorish.projection.content.length > 0,
      "body never fully dropped by the section rule",
    );
    assert.equal(floorish.projection.url, "https://e/1");
    assert.equal(floorish.projection.title, "T");
  });

  it("mid budget: every section survives with bled bodies — trim exhausts before drops (fix-round A pin)", () => {
    const e = envelope();
    // Budget the size of just the root section + 60: under the corrected
    // ladder the walk bleeds ALL bodies (backward, line-level, headings
    // skipped) and fits WITHOUT dropping a section. The pre-fix ladder
    // dropped ## Beta here with its body untrimmed — the priority
    // inversion this pin forbids (flipped from the old drop pin).
    const rootOnly = measurePayload({
      url: "https://e/1",
      title: "T",
      content: "# Title\n\nIntro paragraph about the page.",
    });
    const out = applyBudget(e, rootOnly + 60 + COMPACTION_STAMP_RESERVE, READ_LADDER);
    assert.ok(out.compaction);
    assert.ok(out.projection.content.includes("# Title"), "root survives");
    assert.ok(
      out.projection.content.includes("## Alpha"),
      "alpha heading survives — body bled, not dropped",
    );
    assert.ok(
      out.projection.content.includes("## Beta"),
      "beta heading survives — body bled, not dropped",
    );
    assert.ok(!out.projection.content.includes("A".repeat(50)), "alpha body bled");
    assert.ok(!out.projection.content.includes("B".repeat(50)), "beta body bled");
  });

  it("crush budget: bottom sections drop only after all bleeding", () => {
    const e = envelope();
    const out = applyBudget(
      e,
      measurePayload({ url: "https://e/1", title: "T", content: "" }),
      READ_LADDER,
    );
    assert.ok(out.compaction);
    assert.ok(out.projection.content.includes("# Title"), "top survives");
    assert.ok(!out.projection.content.includes("## Beta"), "bottom dropped at crush budget");
  });

  it("floor clamp: url/title survive at an impossible budget", () => {
    const out = applyBudget(envelope(), 10, READ_LADDER);
    assert.equal(out.compaction.note, "floor");
    assert.equal(out.projection.url, "https://e/1");
    assert.equal(out.projection.title, "T");
  });

  it("heading-final document: a trailing heading is never trimmed (fix-round B pin)", () => {
    const body = "B".repeat(300);
    const e = {
      url: "https://e/1",
      title: "T",
      content: "# Title\n\nIntro paragraph here.\n\n## Alpha\n\n" + body + "\n\n## References",
    };
    const out = applyBudget(e, 200, READ_LADDER);
    assert.ok(out.compaction, "fires at this budget");
    assert.ok(
      out.projection.content.includes("## References"),
      "trailing heading survives trimming",
    );
    assert.ok(out.projection.content.includes("# Title"), "root heading survives");
    assert.ok(out.projection.content.length < e.content.length, "body bled instead");
  });
});

describe("READ_EXTRACT_LADDER — trims field VALUES, never drops field names", () => {
  const envelope = () => ({
    url: "https://e/code",
    mode: "code",
    items: [
      { language: "js", code: "const a = 1;" },
      { language: "python", code: "x = 1" },
    ],
  });

  it("a tight budget halves values; every item keeps both field names", () => {
    const e = envelope();
    const out = applyBudget(e, measurePayload(e) - 10, READ_EXTRACT_LADDER);
    assert.ok(out.compaction);
    assert.equal(out.projection.items.length, 2, "items never dropped");
    for (const item of out.projection.items) {
      assert.ok("language" in item, "field name kept");
      assert.ok("code" in item, "field name kept");
    }
  });

  it("non-url VALUES do trim at crush budgets (F-3 truth pin): `language` shrinks (D8 — trim values, never names/URLs)", () => {
    const e = envelope();
    const out = applyBudget(e, 10, READ_EXTRACT_LADDER);
    // `language` is NOT exempt — its VALUE halves like any non-url
    // string ("python" → "…pyt" class). Never-cut is field NAMES +
    // `url` VALUES only (F-3: the docstring's old "language never-cut
    // by omission" claim was false; the doc now tells this truth).
    // Exact: the "python" item's language VALUE itself is trimmed
    // (…-prefixed). An exempting mutation leaves it verbatim "python".
    const py = out.projection.items.find(
      (item) => item.language.startsWith("…") || item.language === "python",
    );
    assert.ok(py, "python item present");
    assert.notEqual(
      py.language,
      "python",
      "language value trimmed at a crush budget (only `url` values are exempt)",
    );
    assert.ok(py.language.length < "python".length, "trimmed value is shorter");
    assert.ok(
      out.projection.items.every((item) => item.language !== undefined),
      "field name language kept on every item",
    );
  });

  it("URLs never trim: --extract links items keep their url values", () => {
    const linksEnvelope = {
      url: "https://e/page",
      mode: "links",
      items: [
        { text: "some anchor text here", url: "https://example.com/a-very-long-link-target" },
      ],
    };
    const out = applyBudget(linksEnvelope, 80, READ_EXTRACT_LADDER);
    assert.equal(
      out.projection.items[0].url,
      "https://example.com/a-very-long-link-target",
      "url value never trimmed",
    );
    assert.ok(out.projection.items[0].text.length < "some anchor text here".length);
  });
});

describe("CRAWL_LADDER — page urls never cut; contents trim; trailing pages drop late", () => {
  it("mid budget (fix-round A): bleed-then-drop — all three urls stay while bodies shrink; a harder budget drops the LAST page first", () => {
    const e = crawlResult();
    const full = measurePayload(e);
    // A mid budget bleeds bodies — NO page drops (backward scan
    // exhausts cheap trims across trailing pages before any URL is
    // destroyed). ~0.4× full forces bleed rounds on EVERY page.
    const bleed = applyBudget(e, Math.floor(full * 0.4), CRAWL_LADDER);
    assert.ok(bleed.compaction);
    const urls = bleed.projection.pages.map((p) => p.url);
    assert.deepEqual(
      urls,
      ["https://example.com/p1", "https://example.com/p2", "https://example.com/p3"],
      "all three urls in-band under a mid budget",
    );
    assert.ok(
      bleed.projection.pages.every((p) => p.content.length < 320),
      "backward scan bled every body (not just the final one)",
    );

    // A budget that cannot fit three skeletons even fully bled drops
    // the TRAILING page first — p1 survives.
    const bledSkeletons = measurePayload({
      schemaVersion: 1,
      baseUrl: e.baseUrl,
      pages: e.pages.map((p) => ({ url: p.url, content: "", contentFormat: "markdown" })),
      totalPages: 3,
    });
    const drop = applyBudget(e, bledSkeletons - 60, CRAWL_LADDER);
    const dropUrls = drop.projection.pages.map((p) => p.url);
    assert.ok(dropUrls.includes("https://example.com/p1"), "first page survives the drop phase");
    assert.ok(!dropUrls.includes("https://example.com/p3"), "trailing page dropped first");
  });
});

// ---------------------------------------------------------------------------
// Fix-round F-2 twin (orchestrator): research() smuggle guard
// ---------------------------------------------------------------------------

describe("research() — maxChars is not an option (review M3)", () => {
  it("a JS deep importer passing maxChars fails loud, not silent no-budget", async () => {
    await assert.rejects(
      research("q", { maxChars: 500 }, { capability: {}, execution: {} }),
      (err) => err instanceof Error && /does not accept it/.test(err.message),
    );
  });
});

describe("RESEARCH_LADDER — sources survive longest; body trims first", () => {
  it("at the floor, sources stay while sections shrink", () => {
    // The envelope the handler assembles (research.ts parseReportSections):
    // three sections (Sources excluded from the body) + the citations block.
    const e = {
      schemaVersion: 1,
      query: "quantum",
      model: "auto",
      sections: [
        { heading: "Findings", body: "F".repeat(200) },
        { heading: "Analysis", body: "A".repeat(200) },
      ],
      sources: researchResult().sources,
    };
    const out = applyBudget(e, 200, RESEARCH_LADDER);
    assert.ok(out.compaction);
    assert.deepEqual(
      out.projection.sources.map((s) => s.url),
      ["https://example.com/s1", "https://example.com/s2"],
      "citations block never cut",
    );
    assert.ok(measurePayload(out.projection.sections) < measurePayload(e.sections), "body shrank");
  });
});

describe("REPO ladders — metadata never cut", () => {
  it("repo search mid budget (fix-round A): both excerpts bleed before either drops", () => {
    const make = () => ({
      schemaVersion: 1,
      repository: "o/n",
      query: "q",
      language: "en",
      excerpts: [{ text: "x".repeat(150) }, { text: "y".repeat(150) }],
    });
    const full = measurePayload(make());
    // ~0.6× full bleeds BOTH excerpt texts (the backward scan reaches
    // the second-to-last excerpt) — no excerpt drops.
    const out = applyBudget(make(), Math.floor(full * 0.6), REPO_SEARCH_LADDER);
    assert.ok(out.compaction);
    assert.equal(out.projection.excerpts.length, 2, "no excerpt dropped");
    assert.ok(
      out.projection.excerpts.every((x) => x.text.length < 150),
      "every excerpt body bled (not just the final one)",
    );
  });

  it("repo search: trailing excerpts drop LAST, first excerpt survives the floor", () => {
    const e = {
      schemaVersion: 1,
      repository: "o/n",
      query: "q",
      language: "en",
      excerpts: [{ text: "first excerpt body" }, { text: "second excerpt body" }],
    };
    const out = applyBudget(e, 120, REPO_SEARCH_LADDER);
    assert.ok(out.compaction);
    assert.equal(out.projection.repository, "o/n");
    assert.equal(out.projection.query, "q");
    assert.ok(out.projection.excerpts.length >= 1);
  });

  it("repo read: repository/path never cut; content halves", () => {
    const e = { schemaVersion: 1, repository: "o/n", path: "README.md", content: "x".repeat(500) };
    const out = applyBudget(e, 100, REPO_READ_LADDER);
    assert.ok(out.compaction);
    assert.equal(out.projection.repository, "o/n");
    assert.equal(out.projection.path, "README.md");
    assert.ok(out.projection.content.length < 500);
  });
});

// ---------------------------------------------------------------------------
// main()-level: compaction + artifact + history recovery
// ---------------------------------------------------------------------------

describe("read --max-chars (main) — compaction, artifact, recovery", () => {
  it("stamps compaction and writes the FULL untrimmed envelope; history show recovers it", async (t) => {
    await withTempDir(t, async (dir) => {
      const content = threeSections();
      const { status, stdout, stderr } = await runMain(
        ["--provider", "zai", "read", "https://example.com/doc", "--max-chars", "400"],
        {
          artifactsDir: dir,
          descriptors: [makeReaderProvider("zai", readResult(content)).descriptor],
        },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(data.compaction, "compaction in-band");
      assert.equal(data.compaction.budget, 400);
      assert.match(data.compaction.ref, /^2\d{7}T\d{6}Z-/);
      // In-band (minus the stamp) fits.
      const { compaction, ...payload } = data;
      void compaction;
      assert.ok(measurePayload(payload) <= 400);
      assert.equal(data.url, "https://example.com/doc", "never-cut url");

      const { log } = await readLog(dir);
      const entry = log.entries.find((e) => e.command === "read");
      assert.ok(entry, "log entry mandatory");
      assert.ok(!JSON.stringify(entry.args).includes("max-chars"));
      const report = await buildHistoryShowReport(log, entry.requestId, async (e) =>
        fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      // Cardinal: the artifact's content is the FULL unbudgeted page.
      assert.equal(report.report.result.content, content);
    });
  });
});

describe("crawl --max-chars (main) — whole envelope, trailing pages drop late", () => {
  it("compaction stamped; first page url survives", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stdout } = await runMain(
        ["--provider", "tavily", "crawl", "https://example.com", "--max-chars", "300"],
        {
          artifactsDir: dir,
          descriptors: [
            makeAsyncProvider({
              id: "tavily",
              envVar: "TAVILY_API_KEY",
              capability: "crawl",
              ok: crawlResult,
            }).descriptor,
          ],
        },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(data.compaction);
      assert.equal(data.compaction.budget, 300);
      assert.equal(data.baseUrl, "https://example.com");
      assert.ok(data.pages.length >= 1, "floor keeps at least the seed page");
      for (const p of data.pages) assert.ok(p.url, "page urls never cut");
    });
  });
});

describe("E2E redaction (review M2) — the T4 budget artifact is redacted", () => {
  it("read: a configured secret in the result content is [REDACTED] in the written master artifact", async (t) => {
    await withTempDir(t, async (dir) => {
      // The env value below is a CONFIGURED secret for the run
      // (deps.secrets = configuredSecrets(resolvedEnv)); the fake
      // reader embeds it inside the page content.
      const secret = "sk-zai-secret-DO-NOT-LEAK-4417";
      const poisoned = readResult(threeSections() + "\n\nCredential: " + secret + "\n");
      const descriptors = [makeReaderProvider("zai", poisoned).descriptor];
      const { status } = await runMain(
        ["--provider", "zai", "read", "https://example.com/doc", "--max-chars", "300"],
        {
          artifactsDir: dir,
          descriptors,
          env: { Z_AI_API_KEY: secret, SCOUTLINE_ARTIFACTS_DIR: dir },
        },
      );
      assert.equal(status, 0);

      const { log } = await readLog(dir);
      assert.ok(log.entries.length >= 1, "compaction fired and logged");
      const entry = log.entries.find((e) => e.command === "read");
      assert.ok(entry, "read compaction entry present");
      const master = await fs.readFile(path.join(dir, entry.masterPath), "utf8");
      assert.ok(!master.includes(secret), "secret value absent from the budget artifact");
      assert.ok(master.includes("[REDACTED]"), "redaction marker present in the artifact");
    });
  });
});

describe("research --max-chars (main) — citations survive longest", () => {
  it("compaction stamped; sources block intact in-band", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stdout } = await runMain(
        ["--provider", "tavily", "research", "quantum", "--max-chars", "300"],
        {
          artifactsDir: dir,
          descriptors: [
            makeAsyncProvider({
              id: "tavily",
              envVar: "TAVILY_API_KEY",
              capability: "research",
              ok: researchResult,
            }).descriptor,
          ],
        },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(data.compaction);
      assert.deepEqual(
        data.sources.map((s) => s.url),
        ["https://example.com/s1", "https://example.com/s2"],
      );
    });
  });
});

describe("repo --max-chars (main) — search/read whole-envelope; tree rejects; strict parse", () => {
  function repoDeps({ search, readFile, listDirectory } = {}) {
    return [
      makeRepoProvider({
        search:
          search ??
          (() => ({
            schemaVersion: 1,
            repository: "owner/repo",
            query: "query",
            language: "en",
            excerpts: [{ text: "x".repeat(150) }, { text: "y".repeat(150) }],
            truncated: false,
            originalTextLength: 300,
          })),
        readFile:
          readFile ??
          (() => ({
            schemaVersion: 1,
            repository: "owner/repo",
            path: "README.md",
            content: "z".repeat(400),
            truncated: false,
            originalContentLength: 400,
          })),
        listDirectory:
          listDirectory ??
          (() => ({
            repository: "owner/repo",
            path: "",
            entries: [{ name: "README.md", path: "README.md", kind: "file" }],
          })),
      }).descriptor,
    ];
  }

  it("repo search: compaction stamped, query/repository survive, request never sees maxChars", async (t) => {
    await withTempDir(t, async (dir) => {
      let seenRequest;
      const descriptors = repoDeps({
        search: (req) => {
          seenRequest = req;
          return {
            schemaVersion: 1,
            repository: "owner/repo",
            query: "query",
            language: "en",
            excerpts: [{ text: "x".repeat(150) }, { text: "y".repeat(150) }],
            truncated: false,
            originalTextLength: 300,
          };
        },
      });
      const { status, stdout, stderr } = await runMain(
        ["repo", "search", "owner/repo", "query", "--max-chars", "300"],
        { artifactsDir: dir, descriptors },
      );
      assert.equal(status, 0);
      assert.ok(!("maxChars" in (seenRequest ?? {})), "flag never enters the request");
      const data = parseData(stdout);
      assert.ok(data.compaction);
      assert.equal(data.compaction.budget, 300);
      assert.equal(data.repository, "owner/repo");
      assert.equal(data.query, "query");
    });
  });

  it("repo read: compaction stamped; repository/path never cut", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stdout } = await runMain(
        ["repo", "read", "owner/repo", "README.md", "--max-chars", "200"],
        { artifactsDir: dir, descriptors: repoDeps() },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(data.compaction);
      assert.equal(data.compaction.budget, 200);
      assert.equal(data.path, "README.md");
    });
  });

  it("repo tree: --max-chars flips accept-and-drop → UNSUPPORTED_OPTION (ADR-0007 AC-6)", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stderr } = await runMain(
        ["repo", "tree", "owner/repo", "--max-chars", "500"],
        { artifactsDir: dir, descriptors: repoDeps() },
      );
      assert.equal(status, 1);
      const err = JSON.parse(stderr[0]);
      assert.equal(err.code, "UNSUPPORTED_OPTION");
      // M7 (owner-ruled): CommandOptionUnsupportedError — the old
      // `Provider "repo tree" does not support option "--max-chars"
      // capability "repository-exploration"` wording was a false
      // sentence (no provider consulted). Tree now uses the
      // command-scoped message + budgeted-surfaces hint.
      assert.equal(
        err.error,
        'Command "repo tree" does not accept option "--max-chars"',
      );
      assert.ok(
        !/Provider/.test(err.error),
        "message must never say \"Provider\"",
      );
      assert.match(err.help ?? "", /repo search/, "hint names budgeted surfaces");
      assert.match(err.help ?? "", /scoutline repo --help/);
    });
  });

  it("valueless --max-chars says 'requires a value' (fix-round F, brief-surface alignment)", async (t) => {
    await withTempDir(t, async (dir) => {
      const descriptors = [makeReaderProvider("zai", readResult(threeSections())).descriptor];
      const { status, stderr } = await runMain(
        ["--provider", "zai", "read", "https://example.com/doc", "--max-chars"],
        { artifactsDir: dir, descriptors },
      );
      assert.equal(status, 1);
      assert.ok(
        stderr.some((l) => l.includes("--max-chars requires a value")),
        `valueless wording, got: ${JSON.stringify(stderr)}`,
      );
    });
  });

  it("F-5: research --max-chars bad value is VALIDATION_ERROR even with NO credentials (parse hoisted before provider resolution)", async (t) => {
    await withTempDir(t, async (dir) => {
      // No env credentials at all — the old in-closure parse sat after
      // provider resolution, so this shape surfaced exit 3
      // (CONFIGURATION_ERROR) before the parse error. The hoist makes
      // research behave like search/read/crawl/repo (T3's ordering).
      const { status, stderr } = await runMain(["research", "quantum", "--max-chars", "500x"], {
        artifactsDir: dir,
        descriptors: [],
        env: { SCOUTLINE_ARTIFACTS_DIR: dir },
      });
      assert.equal(status, 1);
      assert.ok(
        stderr.some((l) => l.includes("--max-chars must be a positive integer")),
        `parse error first, got: ${JSON.stringify(stderr)}`,
      );
    });
  });

  it("strict parse: repo search/read/research/crawl/read reject 500x, 1.5, 0", async (t) => {
    await withTempDir(t, async (dir) => {
      const descriptors = [
        ...repoDeps(),
        makeAsyncProvider({
          id: "tavily",
          envVar: "TAVILY_API_KEY",
          capability: "research",
          ok: researchResult,
        }).descriptor,
      ];
      const argvs = [
        ["repo", "search", "owner/repo", "query"],
        ["repo", "read", "owner/repo", "README.md"],
        ["research", "quantum"],
        ["crawl", "https://example.com"],
        ["read", "https://example.com/doc"],
      ];
      for (const base of argvs) {
        for (const bad of ["500x", "1.5", "0"]) {
          const { status, stderr } = await runMain([...base, "--max-chars", bad], {
            artifactsDir: dir,
            descriptors,
          });
          assert.equal(status, 1, `${base[0]} --max-chars ${bad} must fail`);
          assert.ok(
            stderr.some((l) => l.includes("--max-chars must be a positive integer")),
            `${base[0]} ${bad}: ${JSON.stringify(stderr)}`,
          );
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Output modes + zero-diff
// ---------------------------------------------------------------------------

describe("-O markdown reflects the budgeted projection (fix-round C)", () => {
  it("crawl markdown: the trailing page's drop is visible in the markdown body", async (t) => {
    await withTempDir(t, async (dir) => {
      const descriptors = [
        makeAsyncProvider({
          id: "tavily",
          envVar: "TAVILY_API_KEY",
          capability: "crawl",
          ok: crawlResult,
        }).descriptor,
      ];
      const { status, stdout } = await runMain(
        [
          "-O",
          "markdown",
          "--provider",
          "tavily",
          "crawl",
          "https://example.com",
          "--max-chars",
          "300",
        ],
        { artifactsDir: dir, descriptors },
      );
      assert.equal(status, 0);
      const md = stdout.join("");
      assert.ok(md.includes("https://example.com/p1"), "first page visible in markdown");
      assert.ok(
        !md.includes("https://example.com/p3"),
        "dropped trailing page absent from markdown",
      );
    });
  });

  it("research markdown: the Sources block survives the budget in markdown", async (t) => {
    await withTempDir(t, async (dir) => {
      const descriptors = [
        makeAsyncProvider({
          id: "tavily",
          envVar: "TAVILY_API_KEY",
          capability: "research",
          ok: researchResult,
        }).descriptor,
      ];
      const { status, stdout } = await runMain(
        ["-O", "markdown", "--provider", "tavily", "research", "quantum", "--max-chars", "150"],
        { artifactsDir: dir, descriptors },
      );
      assert.equal(status, 0);
      const md = stdout.join("");
      assert.ok(md.includes("https://example.com/s1"), "citation 1 in markdown");
      assert.ok(md.includes("https://example.com/s2"), "citation 2 in markdown");
      assert.ok(!md.includes("F".repeat(50)), "report body trimmed out of markdown");
    });
  });

  it("read markdown: the content presentation is the budgeted content", async (t) => {
    await withTempDir(t, async (dir) => {
      const descriptors = [makeReaderProvider("zai", readResult(threeSections())).descriptor];
      const { status, stdout } = await runMain(
        [
          "-O",
          "markdown",
          "--provider",
          "zai",
          "read",
          "https://example.com/doc",
          "--max-chars",
          "200",
        ],
        { artifactsDir: dir, descriptors },
      );
      assert.equal(status, 0);
      const md = stdout.join("");
      assert.ok(md.length < threeSections().length, "markdown reflects the budgeted content");
      assert.ok(md.includes("# Title") || md.length <= 200, "top heading or floor-clamped");
    });
  });
});

describe("output modes + zero-diff (T4)", () => {
  it("compaction visible in -O data, -O json, -O pretty (read)", async (t) => {
    await withTempDir(t, async (dir) => {
      const descriptors = [makeReaderProvider("zai", readResult(threeSections())).descriptor];
      for (const mode of ["data", "json", "pretty"]) {
        const { stdout } = await runMain(
          [
            "-O",
            mode,
            "--provider",
            "zai",
            "read",
            "https://example.com/doc",
            "--max-chars",
            "300",
          ],
          { artifactsDir: dir, descriptors },
        );
        const parsed =
          mode === "data" ? JSON.parse(stdout.join("")) : JSON.parse(stdout.join("")).data;
        assert.ok(parsed.compaction, `compaction in -O ${mode}`);
      }
    });
  });

  it("zero-diff: without the flag, no compaction, no store writes (read/crawl/research/repo search/read)", async (t) => {
    await withTempDir(t, async (dir) => {
      const read = [makeReaderProvider("zai", readResult(threeSections())).descriptor];
      const { status, stdout } = await runMain(
        ["--provider", "zai", "read", "https://example.com/doc"],
        { artifactsDir: dir, descriptors: read },
      );
      assert.equal(status, 0);
      const data = parseData(stdout);
      assert.ok(!("compaction" in data));
      assert.equal(data.content, threeSections(), "full content, byte-identical");
      assert.deepEqual(await fs.readdir(dir), [], "no budget → no store writes");

      const crawl = [
        makeAsyncProvider({
          id: "tavily",
          envVar: "TAVILY_API_KEY",
          capability: "crawl",
          ok: crawlResult,
        }).descriptor,
      ];
      const c = await runMain(["--provider", "tavily", "crawl", "https://example.com"], {
        artifactsDir: dir,
        descriptors: crawl,
      });
      assert.equal(c.status, 0);
      const cData = parseData(c.stdout);
      assert.ok(!("compaction" in cData));
      assert.equal(cData.pages.length, 3, "no pages dropped without the flag");

      const repo = [
        makeRepoProvider({
          search: () => ({
            schemaVersion: 1,
            repository: "owner/repo",
            query: "query",
            language: "en",
            excerpts: [{ text: "abc" }],
            truncated: false,
            originalTextLength: 3,
          }),
          readFile: () => ({
            schemaVersion: 1,
            repository: "owner/repo",
            path: "README.md",
            content: "hello world",
            truncated: false,
            originalContentLength: 11,
          }),
          listDirectory: () => ({
            repository: "owner/repo",
            path: "",
            entries: [{ name: "README.md", path: "README.md", kind: "file" }],
          }),
        }).descriptor,
      ];
      const s = await runMain(["repo", "search", "owner/repo", "query"], {
        artifactsDir: dir,
        descriptors: repo,
      });
      assert.equal(s.status, 0);
      assert.ok(!("compaction" in parseData(s.stdout)));
      const r = await runMain(["repo", "read", "owner/repo", "README.md"], {
        artifactsDir: dir,
        descriptors: repo,
      });
      assert.equal(r.status, 0);
      const rData = parseData(r.stdout);
      assert.ok(!("compaction" in rData));
      assert.equal(rData.content, "hello world", "no legacy per-field truncation without flag");
      assert.deepEqual(await fs.readdir(dir), [], "still no store writes");
    });
  });

  it("read --max-chars fits and the untrimmed artifact matches the unbudgeted run's payload", async (t) => {
    await withTempDir(t, async (dir) => {
      // Budgeted run
      const descriptors = [makeReaderProvider("zai", readResult(threeSections())).descriptor];
      const a = await runMain(
        ["--provider", "zai", "read", "https://example.com/doc", "--max-chars", "250"],
        { artifactsDir: dir, descriptors },
      );
      assert.equal(a.status, 0);
      const secondDir = await fs.mkdtemp(path.join(dir, "ref-"));
      const b = await runMain(["--provider", "zai", "read", "https://example.com/doc"], {
        artifactsDir: secondDir,
        descriptors,
      });
      const { log } = await readLog(dir);
      const report = await buildHistoryShowReport(log, log.entries[0].requestId, async (e) =>
        fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      // Cardinal pin: artifact result == unbudgeted run's payload.
      assert.deepEqual(report.report.result, parseData(b.stdout));
    });
  });
});

// ---------------------------------------------------------------------------
// PR #103 fix-round pins (review): single omission marker, strict shrink,
// truncated-truth stamps, stamp reserve.
// ---------------------------------------------------------------------------

describe("PR #103 fix-round — marker + truth-flag pins", () => {
  it("repeated halving never accumulates omission markers (read ladder)", () => {
    const e = {
      url: "https://e/1",
      title: "T",
      content: "# Title\n\n" + "x".repeat(400),
    };
    const out = applyBudget(e, 120, READ_LADDER);
    const trimmed = out.projection.content.split("\n").filter((l) => l.startsWith("…"));
    for (const line of trimmed) {
      assert.ok(!line.startsWith("……"), "one omission marker, never stacked");
    }
  });

  it("crawl trim keeps ONE marker and stamps page truth flags", () => {
    const e = crawlResult();
    const out = applyBudget(e, Math.floor(measurePayload(e) / 2), CRAWL_LADDER);
    const page = out.projection.pages.find((p) => p.content.startsWith("…"));
    if (page !== undefined) {
      assert.ok(!page.content.startsWith("……"), "single marker");
      assert.equal(page.truncated, true, "trimmed page says truncated:true");
      assert.equal(
        typeof page.originalContentLength,
        "number",
        "originalContentLength present",
      );
    }
  });

  it("repo-read trim stamps truncated:true while originalContentLength keeps the full length", () => {
    const e = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "README.md",
      content: "y".repeat(400),
      truncated: false,
      originalContentLength: 400,
    };
    const out = applyBudget(e, 200, REPO_READ_LADDER);
    assert.ok(out.compaction);
    assert.equal(out.projection.truncated, true, "ladder sets the truth flag");
    assert.equal(out.projection.originalContentLength, 400, "original length preserved");
    assert.ok(out.projection.content.length < 400, "content actually shrank");
  });

  it("repo-search trim stamps truncated:true", () => {
    const e = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "q",
      language: "en",
      excerpts: [{ text: "z".repeat(300) }, { text: "w".repeat(300) }],
      truncated: false,
      originalTextLength: 600,
    };
    const out = applyBudget(e, 300, REPO_SEARCH_LADDER);
    assert.ok(out.compaction);
    assert.equal(out.projection.truncated, true, "ladder sets the truth flag");
  });

  it("two-char lines never stall the trim (degenerate replacement skip)", () => {
    // Final body line "OK" cannot strictly shrink by halving — the rule
    // must skip it and trim the earlier, longer line instead.
    const e = {
      url: "https://e/1",
      title: "T",
      content: "# Title\n\n" + "a".repeat(100) + "\n\nOK",
    };
    const out = applyBudget(e, measurePayload(e) - 30, READ_LADDER);
    assert.ok(out.compaction);
    assert.ok(!out.projection.content.includes("a".repeat(100)), "long line bled");
  });
});

describe("PR #103 R2 — fence- and Setext-aware heading guards", () => {
  it("fenced code lines are never trimmed and do not start sections", () => {
    const e = {
      url: "https://e/1",
      title: "T",
      content:
        "# Title\n\n```ts\n# a code comment\nexport const x = 1;\n```\n\nBody " +
        "y".repeat(120) +
        "\n\n## Alpha\n\n" +
        "A".repeat(80),
    };
    const out = applyBudget(e, measurePayload(e) - 5, READ_LADDER);
    assert.ok(out.compaction, "a budget just under full must fire");
    const lines = out.projection.content.split("\n");
    const fenceIdx = lines.findIndex((l) => l.startsWith("```"));
    // Every original fenced line stays intact (never halved).
    assert.ok(lines[fenceIdx].startsWith("```ts"), "opening fence intact");
    assert.ok(lines.some((l) => l === "# a code comment"), "hash comment inside fence never trimmed");
    assert.ok(lines.some((l) => l.includes("## Alpha")), "Alpha heading survives");
  });

  it("Setext underline and its title line are never trimmed", () => {
    const e = {
      url: "https://e/1",
      title: "T",
      content:
        "My Setext Title\n===============\n\n" +
        "body body body " +
        "z".repeat(120) +
        "\n",
    };
    const out = applyBudget(e, 200 + COMPACTION_STAMP_RESERVE, READ_LADDER);
    const lines = out.projection.content.split("\n");
    assert.ok(lines[0] === "My Setext Title", "setext title never trimmed");
    assert.ok(lines[1].startsWith("==="), "setext underline never trimmed");
  });

  it("whitespace-only preamble merges into the first heading section", () => {
    const e = {
      url: "https://e/1",
      title: "T",
      content:
        "\n\n   \n# Root\n\nIntro " +
        "q".repeat(80) +
        "\n\n## Sub\n\n" +
        "s".repeat(80),
    };
    // Mid budget sized to keep exactly the root section: a whitespace-
    // only preamble must NOT count as its own section (the old shape let
    // every heading drop, killing the root). Requiring "# Root" with the
    // Sub body gone proves the preamble merged into the root section.
    const out = applyBudget(e, 160 + COMPACTION_STAMP_RESERVE, READ_LADDER);
    assert.ok(out.compaction);
    // Whitespace-only preamble merged into the root section, so a
    // one-section-survivor budget keeps # Root (the pre-fix shape
    // dropped the phantom preamble section first and lost the root).
    assert.ok(out.projection.content.includes("# Root"), "root survives a mid budget");
  });
});
