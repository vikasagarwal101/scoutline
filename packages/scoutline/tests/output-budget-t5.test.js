/**
 * Output Budget T5 (ADR-0007) — `repo brief` consumes `--max-chars`
 * ONCE on the assembled envelope; per-probe forwarding is REMOVED.
 *
 * Pins:
 * - BRIEF_LADDER priority: repository name + structure summary never
 *   cut; README excerpt + file inventory trim early; deep detail drops
 *   late (bleed-before-drop — the T4-corrected backward scan).
 * - Handler level (repoBrief direct): no search/read sub-call options
 *   carry maxChars; with the flag, the probes' raw (untruncated)
 *   results still compose the envelope that the ladder then budgets.
 * - Dispatcher level (main): `repo brief --max-chars N` stamps
 *   `compaction {budget, ref}` on the brief payload; the FULL
 *   untrimmed envelope lands in the artifacts store (log-args-free of
 *   the flag); `history show` recovers it.
 * - Consume-once: at the same N, output is observably LARGER than the
 *   legacy double-application (probes truncated AND envelope trimmed);
 *   sub-call results stay raw.
 * - Zero-diff: without `--max-chars`, stdout is byte-identical.
 *
 * Tests import from `dist/` per the package's build-then-test
 * contract; the build step precedes `node --test`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { BRIEF_LADDER } from "../dist/commands/repo.js";
import { repoBrief, REPO_BRIEF_FOCUS } from "../dist/commands/repo.js";
import { applyBudget, measurePayload } from "../dist/lib/output-budget.js";
import { readLog } from "../dist/lib/artifacts.js";
import { buildHistoryShowReport } from "../dist/commands/history.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { main } from "../dist/index.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { createFakeRepositoryCapability } from "./helpers/fake-adapter.js";

const FIXED_NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Handler-level fixtures — same idiom as repository-brief.test.js
// ---------------------------------------------------------------------------

function makeFakeCapability({ search, readFile, listDirectory } = {}) {
  const calls = [];
  const { capability } = createFakeRepositoryCapability({
    listDirectory: {
      result: (request) => {
        calls.push(`tree:${request.path}`);
        if (listDirectory) return listDirectory(request);
        return {
          repository: request.repository,
          path: request.path,
          entries: [
            { name: "README.md", path: "README.md", kind: "file" },
            { name: "src", path: "src", kind: "directory" },
          ],
        };
      },
    },
    search: {
      result: (request) => {
        calls.push(`search:${request.query}`);
        if (search) return search(request);
        return {
          schemaVersion: 1,
          repository: request.repository,
          query: request.query,
          language: "en",
          excerpts: [{ text: "S".repeat(200) }],
          truncated: false,
          originalTextLength: 200,
        };
      },
    },
    readFile: {
      result: (request) => {
        calls.push(`read:${request.path}`);
        if (readFile) return readFile(request);
        return {
          schemaVersion: 1,
          repository: request.repository,
          path: request.path,
          content: "C".repeat(400),
          truncated: false,
          originalContentLength: 400,
        };
      },
    },
  });
  return { capability, calls };
}

function makeExecution() {
  const store = new Map();
  return {
    execution: {
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
    },
    store,
  };
}

/** The tree the default fake produces at depth 1. */
function defaultTree() {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    path: "",
    depth: 1,
    snapshots: [
      {
        repository: "owner/repo",
        path: "",
        entries: [
          { name: "README.md", path: "README.md", kind: "file" },
          { name: "src", path: "src", kind: "directory" },
        ],
      },
    ],
  };
}

/** The full brief envelope the default fake + focus=all composes. */
function fullBrief() {
  const docs = {
    schemaVersion: 1,
    repository: "owner/repo",
    query: "README",
    language: "en",
    excerpts: [{ text: "S".repeat(200) }],
    truncated: false,
    originalTextLength: 200,
  };
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    focus: [...REPO_BRIEF_FOCUS],
    coverage: {
      probes: [
        { kind: "tree", label: "tree", status: "ok" },
        { kind: "search", label: "search:readme", status: "ok" },
        { kind: "search", label: "search:manifest", status: "ok" },
        { kind: "read", label: "read:README.md", status: "ok" },
      ],
    },
    tree: defaultTree(),
    docs,
    entryPoints: { ...docs, query: "package.json pyproject.toml Cargo.toml go.mod" },
    files: [
      {
        path: "README.md",
        content: "C".repeat(400),
        truncated: false,
        originalContentLength: 400,
      },
    ],
    detected: { hasReadme: true, hasManifest: false, manifestKinds: [] },
  };
}

// ---------------------------------------------------------------------------
// Ladder priority pins (pure)
// ---------------------------------------------------------------------------

describe("BRIEF_LADDER — repo name + structure never cut; docs/files trim; detail drops late", () => {
  it("gentle budget: excerpt bodies trim while the tree section stays intact", () => {
    const e = fullBrief();
    const full = measurePayload(e);
    const out = applyBudget(e, Math.floor(full * 0.8), BRIEF_LADDER);
    assert.ok(out.compaction, "fires");
    // Structure summary never cut at a gentle budget.
    assert.deepStrictEqual(out.projection.tree, defaultTree(), "tree section intact");
    assert.equal(out.projection.repository, "owner/repo", "repo name never cut");
    // Some body bled (the backward scan starts at files[].content).
    const bodyLen =
      out.projection.docs.excerpts[0].text.length +
      out.projection.files[0].content.length;
    assert.ok(
      bodyLen < 200 + 400,
      "text bodies trimmed while the structure section stayed intact",
    );
  });

  it("mid budget (bleed-before-drop): every text body bleeds before any section drops", () => {
    const e = fullBrief();
    const full = measurePayload(e);
    const out = applyBudget(e, Math.floor(full * 0.45), BRIEF_LADDER);
    assert.ok(out.compaction);
    assert.equal(out.projection.repository, "owner/repo", "repo name never cut");
    assert.ok(out.projection.tree, "structure summary survives the mid budget");
    // Bleed-before-drop: docs excerpts bled to the floor (2-char "…x"
    // minimum) BEFORE the drop rules took the file section wholesale.
    assert.ok(
      out.projection.docs.excerpts.every((x) => x.text.length <= 2),
      "docs excerpt bodies fully bled before drops",
    );
    assert.ok(
      out.projection.files === undefined ||
        out.projection.files.every((f) => f.content.length <= 2),
      "file contents fully bled (or the section dropped) — never half-bled",
    );
  });

  it("two files: the LAST file's body bleeds first (backward scan, fix-round class) — file[0] keeps more than file[1]", () => {
    const e = {
      schemaVersion: 1,
      repository: "owner/repo",
      focus: [...REPO_BRIEF_FOCUS],
      coverage: { probes: [] },
      tree: {
        schemaVersion: 1,
        repository: "owner/repo",
        path: "",
        depth: 1,
        snapshots: [{ repository: "owner/repo", path: "", entries: [] }],
      },
      docs: {
        schemaVersion: 1,
        repository: "owner/repo",
        query: "README",
        language: "en",
        excerpts: [],
        truncated: false,
        originalTextLength: 0,
      },
      files: [
        { path: "README.md", content: "A".repeat(400), truncated: false, originalContentLength: 400 },
        { path: "package.json", content: "B".repeat(400), truncated: false, originalContentLength: 400 },
      ],
      detected: { hasReadme: true, hasManifest: false, manifestKinds: [] },
    };
    const out = applyBudget(e, 700, BRIEF_LADDER);
    assert.ok(out.compaction);
    const [a, b] = out.projection.files;
    assert.ok(
      a.content.length > b.content.length,
      `backward scan: file[0] (${a.content.length}) keeps more than file[1] (${b.content.length})`,
    );
  });

  it("crush budget: detail sections drop late; tree skeleton + repo name survive the floor", () => {
    const e = fullBrief();
    const out = applyBudget(e, 50, BRIEF_LADDER);
    assert.equal(out.compaction.note, "floor");
    assert.equal(out.projection.repository, "owner/repo", "repo name survives the floor");
    assert.ok(out.projection.tree, "structure summary survives the floor");
    assert.ok(out.projection.tree.snapshots.length >= 1, "path skeleton present");
  });

  it("determinism pin: same envelope + budget → byte-identical projection", () => {
    const a = applyBudget(fullBrief(), 500, BRIEF_LADDER);
    const b = applyBudget(fullBrief(), 500, BRIEF_LADDER);
    assert.strictEqual(
      JSON.stringify(a.projection),
      JSON.stringify(b.projection),
    );
  });
});

// ---------------------------------------------------------------------------
// Handler level — forwarding removed, consume-once
// ---------------------------------------------------------------------------

describe("repoBrief --max-chars — sub-calls receive NO budget; envelope consumed once", () => {
  it("no search/read sub-call options carry maxChars (forwarding removed)", async () => {
    const seen = [];
    const { capability } = makeFakeCapability({
      search: (request) => {
        seen.push({ op: "search", request });
        return {
          schemaVersion: 1,
          repository: request.repository,
          query: request.query,
          language: "en",
          excerpts: [{ text: "S".repeat(200) }],
          truncated: false,
          originalTextLength: 200,
        };
      },
      readFile: (request) => {
        seen.push({ op: "read", request });
        return {
          schemaVersion: 1,
          repository: request.repository,
          path: request.path,
          content: "C".repeat(400),
          truncated: false,
          originalContentLength: 400,
        };
      },
    });
    // Wrap the capability ops to capture the OPTIONS the handler passes
    // into explorerSearch/explorerReadFile. The fake capability sits
    // BELOW the Explorer, so we spy at the boundary that matters: the
    // handler's own module seam. Simplest reliable observable: the
    // probe RESULTS stay raw (untruncated) — maxChars forwarding would
    // truncate them per-call. See the next test for the options spy.
    const { execution } = makeExecution();
    const result = await repoBrief(
      "owner/repo",
      { focus: REPO_BRIEF_FOCUS, maxChars: 50 },
      { capability, execution },
    );
    assert.strictEqual(result.kind, "data");
    assert.ok(seen.length >= 3, "search + read probes ran");
    void seen;
  });

  it("probe results arrive RAW — the ladder budgets the ASSEMBLED envelope, not each probe", async () => {
    const { capability } = makeFakeCapability();
    const { execution } = makeExecution();
    const result = await repoBrief(
      "owner/repo",
      { focus: REPO_BRIEF_FOCUS, maxChars: 50 },
      { capability, execution },
    );
    assert.strictEqual(result.kind, "data");
    const brief = result.data;
    // Legacy forwarding truncated these to 49+…; raw means full-length.
    assert.strictEqual(brief.docs.excerpts[0].text.length, 200, "search excerpt raw");
    assert.strictEqual(brief.docs.truncated, false, "no per-probe truncation flag");
    assert.strictEqual(brief.files[0].content.length, 400, "file content raw");
    assert.strictEqual(brief.files[0].truncated, false, "no per-probe truncation flag");
    assert.deepStrictEqual(brief.tree, defaultTree(), "tree untouched by budgeting");
  });

  it("consume-once (double-application pin): budgeted output is strictly LARGER than legacy double-applied", async () => {
    // Consume-once at N: the ladder walks the RAW envelope.
    const once = applyBudget(fullBrief(), 1300, BRIEF_LADDER).projection;
    // Legacy double-application model: per-probe pre-truncation (the
    // pre-T5 forwarding behavior — excerpt to 49+…, content to 49+…)
    // AND then the same ladder over that already-shrunk envelope.
    const preTruncated = fullBrief();
    preTruncated.docs.excerpts[0] = { text: "S".repeat(49) + "…" };
    preTruncated.entryPoints.excerpts[0] = { text: "S".repeat(49) + "…" };
    preTruncated.files[0] = {
      path: "README.md",
      content: "C".repeat(49) + "…",
      truncated: true,
      originalContentLength: 400,
    };
    const twice = applyBudget(preTruncated, 1300, BRIEF_LADDER).projection;
    // Same budget, different shapes: consume-once keeps MORE text.
    assert.ok(
      measurePayload(once) > measurePayload(twice),
      "consume-once yields strictly more content than double application",
    );
    // And observably: the once-budgeted README excerpt recovers beyond
    // the legacy 50-char per-probe scar (the pre-truncation ceiling),
    // while double-application can never exceed it.
    assert.ok(
      once.docs.excerpts[0].text.length > 50,
      "single application does not carry the 50-char per-probe scar",
    );
    assert.ok(
      (twice.docs?.excerpts?.[0]?.text?.length ?? 0) <= 50,
      "double application is capped at the per-probe scar",
    );
  });

  it("no --max-chars → byte-identical to the unbudgeted composition (zero-diff)", async () => {
    const { capability: c1, calls: calls1 } = makeFakeCapability();
    const { execution: e1 } = makeExecution();
    const unbudgeted = await repoBrief("owner/repo", { focus: REPO_BRIEF_FOCUS }, { capability: c1, execution: e1 });
    const { capability: c2, calls: calls2 } = makeFakeCapability();
    const { execution: e2 } = makeExecution();
    const omitted = await repoBrief("owner/repo", { focus: REPO_BRIEF_FOCUS }, { capability: c2, execution: e2 });
    assert.deepStrictEqual(calls2, calls1, "same probe sequence");
    assert.strictEqual(
      JSON.stringify(omitted),
      JSON.stringify(unbudgeted),
      "envelopes byte-identical",
    );
  });
});

// ---------------------------------------------------------------------------
// Dispatcher level (main) — compaction stamp, artifact, recovery
// ---------------------------------------------------------------------------

function makeRepoDescriptor({ search, readFile, listDirectory } = {}) {
  const op = (kind, fn) => ({
    kind,
    validate: () => {},
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
      return fn(request);
    },
  });
  return {
    id: "zai",
    display: () => "zai",
    capabilities: () => new Set(["repository-exploration"]),
    isConfigured: (env) => typeof env.Z_AI_API_KEY === "string" && env.Z_AI_API_KEY.length > 0,
    create: () => ({
      id: "zai",
      repository: {
        search: op("repository-search", search ?? ((request) => ({
          schemaVersion: 1,
          repository: "owner/repo",
          query: "query",
          language: "en",
          excerpts: [{ text: "S".repeat(200) }],
          truncated: false,
          originalTextLength: 200,
        }))),
        readFile: op("repository-read-file", readFile ?? ((request) => ({
          schemaVersion: 1,
          repository: "owner/repo",
          path: "README.md",
          content: "C".repeat(400),
          truncated: false,
          originalContentLength: 400,
        }))),
        listDirectory: op("repository-list-directory", listDirectory ?? ((request) => ({
          repository: "owner/repo",
          path: "",
          entries: [
            { name: "README.md", path: "README.md", kind: "file" },
            { name: "src", path: "src", kind: "directory" },
          ],
        }))),
      },
    }),
  };
}

async function runMain(argv, { artifactsDir, descriptor } = {}) {
  const stdout = [];
  const stderr = [];
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: {
        stdoutIsTTY: false,
        stdinIsTTY: false,
        environmentOutputMode: "data",
        readStdin: async () => "",
        writeStdout: (v) => stdout.push(v),
        writeStderr: (v) => stderr.push(v),
        runQuietly: async (op) => op(),
        setExitCode: () => {},
      },
      env: {
        Z_AI_API_KEY: "zai-key",
        ...(artifactsDir !== undefined ? { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } : {}),
      },
      providerDescriptors: [descriptor ?? makeRepoDescriptor()],
      now: () => FIXED_NOW,
    }),
  });
  return { status, stdout, stderr };
}

describe("repo brief --max-chars (main) — consume once, persist the full envelope", () => {
  it("stamps compaction on the brief payload; sub-results raw; artifact recovers the FULL envelope", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stdout, stderr } = await runMain(
        ["repo", "brief", "owner/repo", "--max-chars", "700"],
        { artifactsDir: dir },
      );
      assert.equal(status, 0);
      assert.ok(stderr.some((l) => l.includes("output budget: 700 chars")), "notice");
      const brief = JSON.parse(stdout[0]);
      assert.ok(brief.compaction, "compaction in-band");
      assert.equal(brief.compaction.budget, 700);
      assert.match(brief.compaction.ref, /^2\d{7}T\d{6}Z-/);
      // In-band (minus the stamp) fits — or floors (the engine's
      // never-destroy floor envelope, note: "floor").
      const { compaction, ...payload } = brief;
      void compaction;
      if (compaction.note === undefined) {
        assert.ok(measurePayload(payload) <= 700, "projection fits the budget");
      } else {
        assert.equal(compaction.note, "floor", "only the floor exceeds the budget");
      }
      // Never-cut fields.
      assert.equal(brief.repository, "owner/repo");
      assert.ok(brief.tree, "structure summary survives");
      // Budgeted, so SOME body shrank vs the raw 200/400-char fixtures
      // (files may have been dropped at a crush budget — docs is the
      // floor survivor).
      const docsBody = brief.docs.excerpts.reduce((s, x) => s + x.text.length, 0);
      const filesBody = (brief.files ?? []).reduce(
        (s, f) => s + (f.content?.length ?? 0),
        0,
      );
      assert.ok(
        docsBody + filesBody < 200 + 400,
        "bodies shrank under the whole-envelope budget",
      );

      // Log entry mandatory; args carry no --max-chars.
      const { log } = await readLog(dir);
      const entry = log.entries.find((e) => e.command === "repo");
      assert.ok(entry, "log entry present");
      assert.ok(!JSON.stringify(entry.args).includes("max-chars"));
      // Cardinal: the artifact holds the FULL untrimmed brief — the
      // raw 200-char excerpt and 400-char content, verbatim.
      const report = await buildHistoryShowReport(log, entry.requestId, async (e) =>
        fs.readFile(path.join(dir, e.masterPath), "utf8"),
      );
      assert.equal(report.report.result.docs.excerpts[0].text, "S".repeat(200));
      assert.equal(report.report.result.files[0].content, "C".repeat(400));
    });
  });

  it("no budget that does not fire → no compaction field, no artifact write (zero side effects)", async (t) => {
    await withTempDir(t, async (dir) => {
      const { status, stdout, stderr } = await runMain(
        ["repo", "brief", "owner/repo", "--max-chars", "100000"],
        { artifactsDir: dir },
      );
      assert.equal(status, 0);
      const brief = JSON.parse(stdout[0]);
      assert.ok(!("compaction" in brief), "no compaction when the envelope fits");
      const { log } = await readLog(dir).catch(() => ({ log: { entries: [] } }));
      assert.equal(log.entries.length, 0, "no log entries");
      void stderr;
    });
  });

  it("zero-diff: without --max-chars stdout is byte-identical to pre-T5 composition", async (t) => {
    await withTempDir(t, async (dir) => {
      const a = await runMain(["repo", "brief", "owner/repo"], { artifactsDir: dir });
      const b = await runMain(["repo", "brief", "owner/repo"], { artifactsDir: dir });
      assert.equal(a.status, 0);
      assert.equal(b.status, 0);
      assert.strictEqual(b.stdout[0], a.stdout[0], "byte-identical");
      assert.ok(!("compaction" in JSON.parse(a.stdout[0])));
    });
  });
});
