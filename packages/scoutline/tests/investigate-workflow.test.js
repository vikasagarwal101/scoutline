/**
 * Public CLI guards for `investigate --workflow <file|->` (v3 consumer
 * public integration, EXPERIMENTAL) through the REAL main() dispatcher.
 *
 * Hermetic: runtimes are injected through the MainDependencies.
 * requirementsRuntime seam with fake-fetch HTTP and fake judges; zero
 * network, zero ambient credentials. The audit kind reads the pinned
 * local Git checkout itself (read-only object reads, no fetch).
 *
 * Covers: cold help (documentation, never input parsing), strict envelope
 * and mode-conflict validation with ZERO runtime construction, the five
 * kind dispatches through their reviewed lane callables, exit-code
 * mapping (0 complete / 1 honest partial / 2 monitor late commit / 130
 * interrupted), the one-basis redaction contract (display digests bind
 * the delivered bytes; no credential leakage), and plain-mode help
 * compatibility.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { main } from "../dist/index.js";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const execFileP = promisify(execFile);
const sha256 = (v) => createHash("sha256").update(v, "utf8").digest("hex");
const ENV = { TAVILY_API_KEY: "guard-synthetic-key", TAVILY_TIMEOUT: "2000" };
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeAdapter({ stdin = "" } = {}) {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      readStdin: async () => stdin,
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

/** Fake world over the tavily descriptor shape: search returns every doc,
 *  reads serve doc content by URL. Judges are per-test. */
function makeWorkflowRuntime(docs, { judge, candidateJudge, extract } = {}) {
  const transport = {
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init.body ?? "{}"));
      if (path === "/search") {
        return Response.json({ results: docs.map((d) => ({ url: d.url, title: d.title, content: d.content.slice(0, 40) })) });
      }
      const target = String(body.urls?.[0] ?? "");
      const doc = docs.find((d) => d.url === target);
      if (doc === undefined) return Response.json({ results: [] });
      return Response.json({ results: [{ url: target, title: doc.title, raw_content: doc.content }] });
    },
    env: ENV,
  };
  const pickExtract = async (request) => {
    const text = request.sourceText ?? "";
    const payload = {};
    for (const field of request.fields) {
      for (const needle of field.needles ?? []) void needle;
    }
    // generic: each field id maps to a needle via request.fields[].id
    const NEEDLES = { version: "2.4.0", license: "MIT", csv: "supports CSV export" };
    for (const field of request.fields) {
      const needle = NEEDLES[field.id];
      if (needle === undefined) continue;
      const i = text.indexOf(needle);
      if (i >= 0) payload[field.id] = { value: needle, quote: needle, charRange: [i, i + needle.length] };
    }
    return { finishReason: "stop", rawOutput: JSON.stringify(payload), usage: { inputTokens: 10, outputTokens: 10 }, observedCost: null, elapsedMs: 1, requestSha256: "workflow-fake-extract", attempts: 1 };
  };
  const defaultCandidateJudge = async (input) => {
    const answers = {};
    input.candidates.forEach((c, i) => {
      const supported = input.source.content.includes(c.quote);
      answers[`q${i}s`] = { type: "noul", noul: supported ? 0.97 : 0.05 };
      answers[`q${i}c`] = { type: "noul", noul: 0.03 };
    });
    return { model: "workflow-fake-judge", answers, usage: { inputTokens: 20, outputTokens: 5 }, requestSha256: "workflow-fake-judge", elapsedMs: 1, attempts: 1 };
  };
  const calls = { runtime: 0 };
  return {
    calls,
    factory: (context) => {
      calls.runtime += 1;
      return {
        acquisitionOptions: {
          transports: { tavily: transport },
          descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
          searchDescriptor: createTavilyDescriptor({ transport }),
          readerDescriptor: createTavilyDescriptor({ transport }),
          env: ENV,
          cache: { get: async () => null, set: async () => {} },
          sleep: async () => {},
          random: () => 0,
          retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
          reservePhysicalAttempt: context?.reserveAttempt ?? (() => {}),
        },
        engineDeps: {
          judge: judge ?? null,
          extract: extract ?? pickExtract,
          candidateJudge: candidateJudge ?? defaultCandidateJudge,
          extractorRevision: "workflow-fake",
          now: () => 0,
        },
        secrets: [],
        judgeAdmission: "shared",
      };
    },
  };
}

async function runMain(argv, { runtime, env = { ...ENV }, stdin = "", file, now } = {}) {
  const { adapter, stdout, stderr } = makeAdapter({ stdin });
  const deps = hermeticMainDeps({ invocation: adapter, env, ...(now === undefined ? {} : { now }) });
  if (runtime !== undefined) deps.requirementsRuntime = runtime;
  const argvFinal = file !== undefined ? [...argv, file] : argv;
  const code = await main(argvFinal, deps);
  const text = stdout.join("");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { code, stdout: text, stderr: stderr.join(""), parsed };
}

async function withWorkflowFile(document, run) {
  const dir = await mkdtemp(join(tmpdir(), "scoutline-workflow-"));
  const file = join(dir, "workflow.json");
  await writeFile(file, typeof document === "string" ? document : `${JSON.stringify(document)}\n`);
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cold help
// ---------------------------------------------------------------------------

test("investigate --workflow --help renders the workflow help cold (no config, input or runtime)", async () => {
  const touched = [];
  const { adapter } = makeAdapter();
  const stdout = [], stderr = [];
  const code = await main(["investigate", "--workflow", "--help"], {
    env: { SCOUTLINE_PROVIDER: "not-a-provider", SCOUTLINE_JUDGE: "not-a-route" },
    loadScoutlineConfig: async () => { touched.push("config"); throw new Error("help must not load config"); },
    agentRegistrationCheck: async () => { touched.push("registration"); return { refreshed: false }; },
    requirementsUserInterrupt: () => { touched.push("interrupt"); return () => {}; },
    requirementsRuntime: () => { touched.push("runtime"); throw new Error("help must not create a runtime"); },
    invocation: {
      stdoutIsTTY: false, stdinIsTTY: false, readStdin: async () => { touched.push("stdin"); throw new Error("help must not read input"); },
      writeStdout: (v) => stdout.push(v), writeStderr: (v) => stderr.push(v),
      runQuietly: (fn) => fn(), setExitCode: () => {},
    },
  });
  assert.equal(code, 0, stderr.join(""));
  const help = stdout.join("");
  assert.match(help, /Workflow Mode/);
  for (const kind of ["comparison", "monitor", "extraction", "audit", "resolution"]) {
    assert.match(help, new RegExp(`\\b${kind}\\b`));
  }
  assert.deepEqual(touched, []);
});

test("plain investigate --help keeps its own help (workflow section only joins with a lane flag)", async () => {
  const { code, stdout } = await runMain(["investigate", "--help"]);
  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /Workflow Mode/);
  assert.match(stdout, /Investigation orchestrator|Investigate Command/);
});

// ---------------------------------------------------------------------------
// Envelope + mode validation with ZERO runtime construction
// ---------------------------------------------------------------------------

const BAD_DOCS = [
  ["not json", "{not-json"],
  ["wrong schemaVersion", { schemaVersion: 2, kind: "monitor", request: {} }],
  ["unknown kind", { schemaVersion: 1, kind: "mutation", request: {} }],
  ["extra top-level key", { schemaVersion: 1, kind: "monitor", request: {}, aliases: [] }],
  ["missing request", { schemaVersion: 1, kind: "monitor" }],
  ["request not object", { schemaVersion: 1, kind: "monitor", request: [] }],
];

for (const [label, doc] of BAD_DOCS) {
  test(`workflow validation rejects up front (${label}) with no runtime`, async () => {
    const runtime = makeWorkflowRuntime([]);
    await withWorkflowFile(doc, async (file) => {
      const { code, stderr, parsed } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
      assert.notEqual(code, 0);
      assert.match(stderr, /VALIDATION_ERROR/);
      // The ENVELOPE contract rejects (not some later per-kind check):
      // a discriminating message for the envelope-shaped cases.
      if (label === "extra top-level key") assert.match(stderr, /unsupported keys/);
      if (label === "unknown kind") assert.match(stderr, /kind must be one of/);
      assert.equal(parsed, null, "no success payload for a rejected envelope");
      assert.equal(runtime.calls.runtime, 0, "invalid input must construct no runtime");
    });
  });
}

test("mode conflicts reject before any input read", async () => {
  const runtime = makeWorkflowRuntime([]);
  for (const argv of [
    ["investigate", "--workflow", "/dev/null", "--requirements", "/dev/null"],
    ["investigate", "--workflow", "/dev/null", "--caller-request", "/dev/null"],
    ["investigate", "--workflow", "/dev/null", "--verify"],
    ["investigate", "--workflow", "/dev/null", "a positional question"],
  ]) {
    const { code, stderr } = await runMain(argv, { runtime: runtime.factory });
    assert.notEqual(code, 0, argv.join(" "));
    assert.match(stderr, /VALIDATION_ERROR/);
  }
  assert.equal(runtime.calls.runtime, 0);
});

test("monitor without a stateRoot and extraction with a caller judge reject with no runtime", async () => {
  const runtime = makeWorkflowRuntime([]);
  await withWorkflowFile({ schemaVersion: 1, kind: "monitor", request: { monitorId: "csv", definition: {} } }, async (f1) => {
    await withWorkflowFile(
      { schemaVersion: 1, kind: "extraction", request: { manifestText: "x", admission: { materialClass: "public", claimedUrl: "https://x/", title: "t" }, judgeTransmission: { capability: "offline-test-seam", dispatch: async () => {} } } },
      async (f2) => {
        for (const file of [f1, f2]) {
          const { code, stderr } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
          assert.notEqual(code, 0);
          assert.match(stderr, /VALIDATION_ERROR/);
        }
        assert.equal(runtime.calls.runtime, 0);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Comparison kind
// ---------------------------------------------------------------------------

const COMPARISON_REQUEST = {
  schemaVersion: 1,
  question: "Compare CSV export support across one ExampleApp release.",
  entities: ["2.4.0"],
  dimensions: {
    csv_export: {
      question: "Does ExampleApp Community {entity} for Linux explicitly support CSV export?",
      criteria: ["Same edition, release and platform as the requested scope."],
    },
  },
  frame: { entity: "ExampleApp", edition: "Community", platform: "Linux" },
};

test("comparison kind: complete matrix through the public dispatcher", async () => {
  const docs = [{ url: "https://offline.test/exampleapp-2.4.0", title: "ExampleApp 2.4.0 notes", content: "ExampleApp Community 2.4.0 on Linux supports CSV export." }];
  const judge = async (input) => ({
    documents: input.documents.map((d) => ({
      evidenceId: d.evidenceId,
      relevant: d.content.includes("2.4.0"),
      supportsClaim: d.content.includes("supports CSV export"),
      refutesClaim: d.content.includes("does not support"),
    })),
  });
  const runtime = makeWorkflowRuntime(docs, { judge });
  await withWorkflowFile({ schemaVersion: 1, kind: "comparison", request: COMPARISON_REQUEST }, async (file) => {
    const { code, parsed, stderr } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
    assert.equal(code, 0, stderr);
    assert.equal(parsed.kind, "evidence-comparison");
    assert.equal(parsed.status, "complete");
    assert.match(parsed.resultSha256, /^[0-9a-f]{64}$/);
    const cellKey = Object.keys(parsed.cells)[0];
    assert.equal(parsed.cells[cellKey].value, "supported");
    // Hash binds the exact delivered envelope (resultSha256 appended last).
    const { resultSha256, ...envelope } = parsed;
    assert.equal(resultSha256, sha256(JSON.stringify(envelope)));
  });
});

// ---------------------------------------------------------------------------
// Monitor kind
// ---------------------------------------------------------------------------

const MONITOR_DEFINITION = {
  schemaVersion: 1,
  question: "Monitor CSV export support for the specified release.",
  scope: { entity: "ExampleApp", release: "2.4.0", edition: "Community", platform: "Linux" },
  requirements: {
    csv: {
      question: "Does ExampleApp Community 2.4.0 for Linux explicitly support CSV export?",
      schema: { enum: ["supported", "refuted", "disputed"] },
      required: true,
    },
  },
};

test("monitor kind: one explicit tick commits against a caller-owned state root", async () => {
  const docs = [{ url: "https://offline.test/exampleapp-2.4.0", title: "notes", content: "ExampleApp Community 2.4.0 on Linux supports CSV export." }];
  const judge = async (input) => ({
    documents: input.documents.map((d) => ({
      evidenceId: d.evidenceId,
      relevant: true,
      supportsClaim: d.content.includes("supports CSV export"),
      refutesClaim: false,
    })),
  });
  const runtime = makeWorkflowRuntime(docs, { judge });
  const stateRoot = await mkdtemp(join(tmpdir(), "scoutline-monitor-state-"));
  const now = new Date("2025-01-02T03:04:05.000Z");
  try {
    await withWorkflowFile(
      { schemaVersion: 1, kind: "monitor", request: { monitorId: "csv-monitor", stateRoot, definition: MONITOR_DEFINITION } },
      async (file) => {
        const { code, parsed, stderr } = await runMain(["investigate", "--workflow", file], {
          runtime: runtime.factory,
          now: () => now.getTime(),
        });
        assert.equal(code, 0, stderr);
        assert.equal(parsed.kind, "fact-monitor-tick");
        assert.equal(parsed.report.monitorId, "csv-monitor");
        const at = now.toISOString();
        assert.ok(parsed.report.events.length > 0);
        assert.ok(parsed.report.events.every((event) => event.at === at));
        const tickDir = join(stateRoot, "csv-monitor", "ticks");
        const [fileName] = await readdir(tickDir);
        const record = JSON.parse(await readFile(join(tickDir, fileName), "utf8"));
        assert.equal(record.at, at);
        assert.equal(parsed.report.rejection, undefined);
        assert.match(parsed.resultSha256, /^[0-9a-f]{64}$/);
      },
    );
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Extraction kind
// ---------------------------------------------------------------------------

const MANIFEST_TEXT = "Version: 2.4.0\nLicense: MIT\n";

test("extraction kind without judge consent is an honest partial (no fake success)", async () => {
  await withWorkflowFile(
    { schemaVersion: 1, kind: "extraction", request: { manifestText: MANIFEST_TEXT, admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/manifest", title: "Release manifest" } } },
    async (file) => {
      // No injected runtime and no judge consent: no runtime composition,
      // no judge — the closed set still parses and proposes nothing accepted.
      const { code, parsed, stderr } = await runMain(["investigate", "--workflow", file], { env: { ...ENV } });
      assert.equal(code, 1, stderr);
      assert.equal(parsed.kind, "manifest-extraction");
      assert.equal(parsed.result.requirements.version.status, "unresolved");
      assert.equal(parsed.claimedUrlVerification, "unverified");
      assert.match(parsed.resultSha256, /^[0-9a-f]{64}$/);
    },
  );
});

test("extraction kind with the authorized runtime judge accepts the closed set", async () => {
  const runtime = makeWorkflowRuntime([]);
  await withWorkflowFile(
    { schemaVersion: 1, kind: "extraction", request: { manifestText: MANIFEST_TEXT, admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/manifest", title: "Release manifest" } } },
    async (file) => {
      const { code, parsed, stderr } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
      assert.equal(code, 0, stderr);
      assert.equal(parsed.kind, "manifest-extraction");
      assert.equal(parsed.result.status, "complete");
      assert.equal(parsed.result.data.version, "2.4.0");
      assert.equal(parsed.result.data.license, "MIT");
      // Display facts bind the delivered bytes (single-basis projector).
      for (const row of parsed.evidence) {
        assert.equal(row.displayContentSha256, sha256(row.content));
        assert.equal(row.displayByteLength, Buffer.byteLength(row.content, "utf8"));
        assert.equal(row.contentSha256, sha256(MANIFEST_TEXT), "original digest binds the admitted bytes");
      }
      // Usable reference joins: redaction preserves the identity keys the
      // outcome rows cite.
      const delivered = new Set(parsed.evidence.map((row) => row.evidenceId));
      for (const row of Object.values(parsed.result.requirements)) {
        for (const id of row.evidenceIds ?? []) assert.ok(delivered.has(id), `evidence reference ${id} must join a delivered row`);
      }
    },
  );
});

test("extraction kind never leaks credential-shaped manifest content", async () => {
  const runtime = makeWorkflowRuntime([]);
  const leaky = "Version: 2.4.0\nLicense: MIT\nNote: Token Abcdef12345 end\n";
  await withWorkflowFile(
    { schemaVersion: 1, kind: "extraction", request: { manifestText: leaky, admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/manifest", title: "Release manifest" } } },
    async (file) => {
      const { stdout, parsed } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
      assert.ok(!stdout.includes("Abcdef12345"), "the raw credential-shaped token must not appear in stdout");
      const row = parsed.evidence[0];
      assert.equal(row.displayRedacted, true);
      assert.equal(row.displayContentSha256, sha256(row.content), "display digest binds the delivered redacted bytes");
    },
  );
});

// ---------------------------------------------------------------------------
// Audit kind (pinned local Git reads; no runtime, no fetch)
// ---------------------------------------------------------------------------

async function headRevision() {
  const { stdout } = await execFileP("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"]);
  return stdout.trim();
}

test("audit kind: literal claim over the pinned local checkout accepts", async () => {
  const revision = await headRevision();
  const runtime = makeWorkflowRuntime([]);
  await withWorkflowFile(
    {
      schemaVersion: 1,
      kind: "audit",
      request: {
        repository: "scoutline",
        revision,
        localRepositoryPath: REPO_ROOT,
        claims: [
          {
            id: "errors-exported",
            text: "The errors module exports the ValidationError class.",
            proofClass: "literal",
            checks: [{ path: "packages/scoutline/src/lib/errors.ts", allOf: ["ValidationError"] }],
          },
        ],
      },
    },
    async (file) => {
      const { code, parsed, stderr } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
      assert.equal(code, 0, stderr);
      assert.equal(parsed.kind, "implementation-audit");
      assert.equal(parsed.report.claims[0].status, "supported");
      assert.equal(parsed.report.revision, revision);
      assert.ok(parsed.report.coverageNotes.some((note) => note.includes("exact pinned local Git commit")));
      assert.equal(runtime.calls.runtime, 0, "audit never constructs a provider runtime");
    },
  );
});

test("audit kind: absent path leaves only its own claim unresolved; nonexistent commits refuse", async () => {
  const revision = await headRevision();
  const runtime = makeWorkflowRuntime([]);
  await withWorkflowFile(
    {
      schemaVersion: 1,
      kind: "audit",
      request: {
        repository: "scoutline",
        revision,
        localRepositoryPath: REPO_ROOT,
        claims: [
          { id: "absent", text: "Missing file claim.", proofClass: "literal", checks: [{ path: "no/such/file.ts", allOf: ["x"] }] },
          { id: "present", text: "Known local package.", proofClass: "literal", checks: [{ path: "packages/scoutline/package.json", allOf: ["scoutline"] }] },
        ],
      },
    },
    async (file) => {
      const { code, parsed, stderr } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
      assert.equal(code, 1, stderr);
      assert.equal(parsed.report.claims.find((row) => row.id === "absent").status, "unresolved");
      assert.equal(parsed.report.claims.find((row) => row.id === "present").status, "supported");
      assert.equal(runtime.calls.runtime, 0);
    },
  );
  await withWorkflowFile(
    { schemaVersion: 1, kind: "audit", request: { repository: "scoutline", revision: "0".repeat(40), localRepositoryPath: REPO_ROOT, claims: [{ id: "x", text: "t", proofClass: "literal", checks: [{ path: "package.json", allOf: ["x"] }] }] } },
    async (file) => {
      const { code, stderr } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
      assert.notEqual(code, 0);
      assert.match(stderr, /not present as a commit/);
    },
  );
});

// ---------------------------------------------------------------------------
// Resolution kind
// ---------------------------------------------------------------------------

const URL_GPL = "https://releases.example.test/exampleapp/2.4.0/notice";
const URL_CORRECTION = "https://releases.example.test/exampleapp/2.4.0/notice-correction";
const URL_APACHE = "https://releases.example.test/exampleapp/2.3.0/notice";
const NOTICE_GPL = "ExampleApp 2.4.0 original release notice. License: GPL-3.0 applies to ExampleApp 2.4.0.";
const NOTICE_CORRECTION =
  "Correction to the ExampleApp 2.4.0 release notice. This correction explicitly supersedes the original ExampleApp 2.4.0 licensing notice. License: MIT applies to ExampleApp 2.4.0.";
const NOTICE_APACHE = "ExampleApp 2.3.0 release notice. License: Apache-2.0 applies to ExampleApp 2.3.0.";
const SCOPE_240 = /applies to ExampleApp 2\.4\.0\./;
const LICENSE_OF = (text) => /License: (\S+) applies/.exec(text)?.[1];

test("resolution kind: explicit correction selects MIT through the shared runtime", async () => {
  const docs = [
    { url: URL_GPL, title: "gpl page", content: NOTICE_GPL },
    { url: URL_CORRECTION, title: "correction page", content: NOTICE_CORRECTION },
    { url: URL_APACHE, title: "apache page", content: NOTICE_APACHE },
  ];
  const judge = async (input) => ({
    documents: input.documents.map((d) => {
      if (input.fieldId === "applicability") {
        const applies = SCOPE_240.test(d.content);
        if (d.url === URL_APACHE) return { evidenceId: d.evidenceId, relevant: true, supportsClaim: applies, refutesClaim: !applies };
        return { evidenceId: d.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      }
      if (input.fieldId === "correction") {
        if (d.url === URL_CORRECTION) return { evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false };
        return { evidenceId: d.evidenceId, relevant: d.url === URL_GPL, supportsClaim: false, refutesClaim: false };
      }
      return { evidenceId: d.evidenceId, relevant: SCOPE_240.test(d.content), supportsClaim: false, refutesClaim: false };
    }),
  });
  const extract = async (request) => {
    const text = request.sourceText ?? "";
    const payload = {};
    for (const field of request.fields) {
      const match = /License: (\S+) applies to (ExampleApp|OtherApp) [0-9.]+\./.exec(text);
      payload[field.id] = match ? { value: match[1], quote: match[0] } : { value: null, quote: null };
    }
    return { finishReason: "stop", rawOutput: JSON.stringify(payload), usage: { inputTokens: 1, outputTokens: 1 }, observedCost: null, elapsedMs: 0, requestSha256: "0".repeat(64) };
  };
  const candidateJudge = async (input) => {
    const opposing = input.opposingContext.filter((e) => e.url !== input.source.url && SCOPE_240.test(e.content));
    const shield =
      input.source.url === URL_CORRECTION && opposing.some((e) => e.url === URL_GPL);
    const materialOpposing = shield ? opposing.filter((e) => e.url !== URL_GPL) : opposing;
    const answers = {};
    input.candidates.forEach((c, i) => {
      const support = SCOPE_240.test(c.quote ?? "") ? 0.97 : 0.05;
      const conflict = materialOpposing.some((e) => LICENSE_OF(e.content) !== c.value) ? 0.97 : 0.02;
      answers[`q${i}s`] = { type: "noul", noul: support };
      answers[`q${i}c`] = { type: "noul", noul: conflict };
    });
    return { model: "offline-conflict-judge-v1", answers, usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: "0".repeat(64), elapsedMs: 0 };
  };
  const runtime = makeWorkflowRuntime(docs, { judge, extract, candidateJudge });
  await withWorkflowFile(
    {
      schemaVersion: 1,
      kind: "resolution",
      request: {
        schemaVersion: 1,
        scope: { entity: "ExampleApp", release: "2.4.0" },
        alternatives: [
          { id: "gpl", value: "GPL-3.0", source: { url: URL_GPL, title: "gpl page" }, scope: { entity: "ExampleApp", release: "2.4.0" } },
          { id: "mit-correction", value: "MIT", source: { url: URL_CORRECTION, title: "correction page" }, scope: { entity: "ExampleApp", release: "2.4.0" }, correctionOf: "gpl" },
          { id: "apache", value: "Apache-2.0", source: { url: URL_APACHE, title: "apache page" }, scope: { entity: "ExampleApp", release: "2.3.0" } },
        ],
      },
    },
    async (file) => {
      const { code, parsed, stderr } = await runMain(["investigate", "--workflow", file], { runtime: runtime.factory });
      assert.equal(code, 0, stderr);
      assert.equal(parsed.kind, "conflict-resolution");
      assert.equal(parsed.resolution.status, "resolved");
      assert.equal(parsed.resolution.selected.value, "MIT");
      for (const row of parsed.evidence) {
        assert.equal(row.displayContentSha256, sha256(row.content));
      }
      assert.match(parsed.resultSha256, /^[0-9a-f]{64}$/);
    },
  );
});

// ---------------------------------------------------------------------------
// Cancellation (blocked stdin settles 130)
// ---------------------------------------------------------------------------

test("blocked stdin with a user interrupt settles exit 130", async () => {
  const stdout = [], stderr = [];
  let fire;
  const invocation = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    readStdin: (_max, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("stdin aborted"), { name: "AbortError" })));
      }),
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
  };
  const deps = hermeticMainDeps({
    invocation,
    env: { ...ENV },
    requirementsUserInterrupt: (onInterrupt) => {
      fire = onInterrupt;
      return () => {};
    },
  });
  const pending = main(["investigate", "--workflow", "-"], deps);
  await new Promise((resolve) => setImmediate(resolve));
  fire();
  const code = await pending;
  assert.equal(code, 130, stderr.join(""));
});

test("local audit cannot inherit a repository from GIT_DIR", async () => {
  const revision = await headRevision();
  const { stdout } = await execFileP("git", ["-C", REPO_ROOT, "rev-parse", "--absolute-git-dir"]);
  const directory = await mkdtemp(join(tmpdir(), "scoutline-audit-nonrepo-"));
  try {
    await withWorkflowFile({
      schemaVersion: 1, kind: "audit",
      request: {
        repository: "local", revision, localRepositoryPath: directory,
        claims: [{
          id: "literal", text: "The package names Scoutline.", proofClass: "literal",
          checks: [{ path: "packages/scoutline/package.json", allOf: ["scoutline"] }],
        }],
      },
    }, async (file) => {
      await assert.rejects(execFileP(process.execPath, [
        join(REPO_ROOT, "packages/scoutline/bin/scoutline.js"), "investigate", "--workflow", file,
      ], {
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
          SCOUTLINE_CONFIG_DIR: join(directory, "config"), GIT_DIR: stdout.trim(),
          NODE_OPTIONS: process.env.NODE_OPTIONS },
      }), (error) => error.code === 1 && /VALIDATION_ERROR/.test(error.stderr));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow stdout digests bind the final redacted evidence", async () => {
  const document = {
    schemaVersion: 1, kind: "extraction",
    request: {
      manifestText: MANIFEST_TEXT + "Note: REDACTED\n",
      admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/manifest", title: "Manifest" },
    },
  };
  const result = await runMain(["investigate", "--workflow", "-"], {
    env: { Z_AI_API_KEY: "REDACTED" },
    stdin: JSON.stringify(document),
  });
  assert.equal(result.code, 1, result.stderr);
  const { resultSha256, ...body } = result.parsed;
  assert.equal(resultSha256, sha256(JSON.stringify(body)));
  for (const evidence of body.evidence) {
    assert.equal(evidence.displayContentSha256, sha256(evidence.content));
    assert.equal(evidence.displayByteLength, Buffer.byteLength(evidence.content, "utf8"));
  }
});

test("workflow interrupt callback settles even a blocked stdin adapter", { timeout: 2000 }, async () => {
  const { adapter, stderr } = makeAdapter();
  let interrupt;
  const deps = hermeticMainDeps({ invocation: {
    ...adapter,
    readStdin: () => {
      queueMicrotask(() => interrupt());
      return new Promise(() => {});
    },
  }, env: {} });
  deps.requirementsUserInterrupt = (cancel) => {
    interrupt = cancel;
    return () => {};
  };
  const watchdog = AbortSignal.timeout(500);
  const result = await Promise.race([
    main(["investigate", "--workflow", "-"], deps),
    new Promise((resolve) => watchdog.addEventListener("abort", () => resolve("blocked"), { once: true })),
  ]);
  assert.equal(result, 130, stderr.join(""));
});

test("monitor rejects credential-named field identities before runtime or publication", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "scoutline-monitor-identity-"));
  try {
    const runtime = makeWorkflowRuntime([]);
    const { code, stderr } = await runMain(["investigate", "--workflow", "-"], {
      runtime: runtime.factory,
      stdin: JSON.stringify({
        schemaVersion: 1, kind: "monitor",
        request: {
          monitorId: "my-monitor", stateRoot,
          definition: { ...MONITOR_DEFINITION, requirements: { token: MONITOR_DEFINITION.requirements.csv } },
        },
      }),
    });
    assert.equal(code, 1);
    assert.match(stderr, /VALIDATION_ERROR/);
    assert.equal(runtime.calls.runtime, 0);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("workflow saves the same hash-bound redacted data it emits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scoutline-workflow-save-"));
  try {
    const target = join(directory, "saved.json");
    const { code, parsed, stderr } = await runMain(
      ["investigate", "--workflow", "-", "--save", target], {
        env: { Z_AI_API_KEY: "REDACTED", SCOUTLINE_ARTIFACTS_DIR: join(directory, "artifacts") },
        stdin: JSON.stringify({
          schemaVersion: 1, kind: "extraction",
          request: { manifestText: MANIFEST_TEXT + "Note: REDACTED\n",
            admission: { materialClass: "public", claimedUrl: "https://offline.test/note", title: "Release note" } },
        }),
      },
    );
    assert.equal(code, 1, stderr);
    const saved = JSON.parse(await readFile(target, "utf8")).result;
    assert.deepEqual(saved, parsed);
    const { resultSha256, ...body } = saved;
    assert.equal(resultSha256, sha256(JSON.stringify(body)));
    assert.equal(body.evidence[0].displayContentSha256, sha256(body.evidence[0].content));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bad runtime telemetry refuses a monitor tick before publication", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "scoutline-monitor-accounting-"));
  try {
    const runtime = makeWorkflowRuntime(
      [{ url: "https://offline.test/release", title: "Release", content: "ExampleApp 2.4.0 supports CSV export." }],
      { judge: async (input) => ({
        documents: input.documents.map((doc) => ({
          evidenceId: doc.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false,
        })),
        attempts: "malformed",
      }) },
    );
    const { code, parsed, stderr } = await runMain(["investigate", "--workflow", "-"], {
      runtime: runtime.factory,
      stdin: JSON.stringify({
        schemaVersion: 1, kind: "monitor",
        request: { monitorId: "my-monitor", stateRoot, definition: MONITOR_DEFINITION },
      }),
    });
    assert.equal(code, 1);
    assert.equal(parsed, null);
    assert.match(stderr, /physical|attempt/i);
    assert.deepEqual(await readdir(stateRoot), []);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("domain preflight rejects before the runtime factory", async () => {
  const runtime = makeWorkflowRuntime([]);
  const rejects = [
    ["monitor", { monitorId: "valid", stateRoot: "/unused", definition: {} }],
    ["resolution", { schemaVersion: 1, scope: { entity: "ExampleApp", release: "2.4.0" }, alternatives: [] }],
    ["extraction", { manifestText: "x".repeat(16_385),
      admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/note", title: "Release note" } }],
  ];
  for (const [kind, request] of rejects) {
    const { code, stderr } = await runMain(["investigate", "--workflow", "-"], {
      runtime: runtime.factory, stdin: JSON.stringify({ schemaVersion: 1, kind, request }),
    });
    assert.equal(code, 1);
    assert.match(stderr, /VALIDATION_ERROR/);
  }
  assert.equal(runtime.calls.runtime, 0);
});

test("invalid and local-only workflows do not refresh provider quotas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scoutline-workflow-local-only-"));
  try {
    const log = join(directory, "traffic.log");
    const preload = join(directory, "observe-traffic.mjs");
    await writeFile(log, "");
    await writeFile(preload, [
      'import { appendFileSync } from "node:fs";',
      'globalThis.fetch = () => {',
      '  appendFileSync(process.env.SCOUTLINE_TEST_TRAFFIC, "fetch\\n");',
      '  throw new Error("Synthetic test refused a provider request");',
      '};',
    ].join("\n"));
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      TMPDIR: directory,
      SCOUTLINE_CONFIG_DIR: join(directory, "config"),
      SCOUTLINE_TEST_TRAFFIC: log,
      JINA_API_KEY: "synthetic-jina-quota-key",
      NODE_OPTIONS: "--import=" + preload,
    };
    const bin = join(REPO_ROOT, "packages/scoutline/bin/scoutline.js");
    const run = (file) => execFileP(process.execPath, [bin, "investigate", "--workflow", file], { env });
    await withWorkflowFile("{invalid", async (file) => {
      await assert.rejects(run(file), (error) => error.code === 1 && /VALIDATION_ERROR/.test(error.stderr));
    });
    await withWorkflowFile({
      schemaVersion: 1, kind: "extraction",
      request: { manifestText: MANIFEST_TEXT,
        admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/manifest", title: "Manifest" } },
    }, async (file) => {
      await assert.rejects(run(file), (error) =>
        error.code === 1 && JSON.parse(error.stdout).result.status === "partial");
    });
    assert.equal(await readFile(log, "utf8"), "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Git audit reports a deadline cutoff and preserves completed claims", {
  skip: process.platform === "win32",
  timeout: 8000,
}, async (t) => {
  const revision = await headRevision();
  const { stdout } = await execFileP("which", ["git"]);
  const git = stdout.trim();
  const directory = await mkdtemp(join(tmpdir(), "scoutline-audit-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const firstPath = "packages/scoutline/package.json";
  const secondPath = "packages/scoutline/src/lib/errors.ts";
  const envelope = {
    schemaVersion: 1,
    kind: "audit",
    request: {
      repository: "scoutline", revision, localRepositoryPath: REPO_ROOT,
      claims: [
        { id: "package", text: "Package name", proofClass: "literal", checks: [{ path: firstPath, allOf: ["scoutline"] }] },
        { id: "errors", text: "Error declaration", proofClass: "literal", checks: [{ path: secondPath, allOf: ["ValidationError"] }] },
      ],
    },
  };
  const run = () => runMain(["investigate", "--workflow", "-"], { stdin: JSON.stringify(envelope) });
  const control = await run();
  assert.equal(control.code, 0, control.stderr);

  const entered = join(directory, "entered");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(join(directory, "git"), [
    "#!/bin/sh",
    'for arg; do',
    `  if [ "$arg" = ${quote(secondPath)} ]; then`,
    `    : > ${quote(entered)}`,
    "    exec sleep 30",
    "  fi",
    "done",
    `exec ${quote(git)} "$@"`,
  ].join("\n") + "\n", { mode: 0o700 });
  const oldPath = process.env.PATH;
  const deadline = new AbortController();
  const actualTimeout = AbortSignal.timeout;
  const timeout = t.mock.method(AbortSignal, "timeout", (ms) => ms === 10000 ? deadline.signal : actualTimeout(ms));
  const bound = setTimeout(() => deadline.abort(), 3500);
  let task;
  try {
    process.env.PATH = directory + ":" + oldPath;
    task = run();
    for (;;) {
      const reached = await stat(entered).then(() => true, () => false);
      if (reached) break;
      assert.equal(deadline.signal.aborted, false, "Git must enter the second path before the synthetic timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    deadline.abort(new DOMException("Synthetic audit deadline", "TimeoutError"));
    const { code, parsed, stderr } = await task;
    assert.equal(code, 1, stderr);
    assert.deepEqual(parsed.report.claims.map(({ status }) => status), ["supported", "unresolved"]);
    const cutoff = parsed.report.coverageNotes.find((note) => /reached its read deadline/.test(note));
    assert.ok(cutoff.includes(secondPath));
    assert.ok(!cutoff.includes(firstPath));
  } finally {
    clearTimeout(bound);
    deadline.abort();
    if (task !== undefined) await task.catch(() => undefined);
    process.env.PATH = oldPath;
    timeout.mock.restore();
  }
});

test("compiled workflow quota cadence requires successful provider acquisition", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scoutline-workflow-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preload = join(directory, "quota-fixture.mjs");
  await writeFile(preload, [
    'import { appendFileSync } from "node:fs";',
    'const log = (stage) => appendFileSync(process.env.TEST_WORKFLOW_TRAFFIC, stage + "\\n");',
    'const url = "https://fixture.example.com/releases/2.4.0";',
    'const text = "ExampleApp Community 2.4.0 on Linux supports CSV export.";',
    'globalThis.fetch = async (raw, init) => {',
    '  const target = String(raw);',
    '  if (target === "https://api.tavily.com/usage") { log("quota"); throw Error("synthetic quota refusal"); }',
    '  if (target === "https://api.tavily.com/search") {',
    '    log("search"); return Response.json({ results: [{ url, title: "Notes", content: text }] });',
    '  }',
    '  if (target === "https://api.tavily.com/extract") {',
    '    log("read");',
    '    if (process.env.TEST_WORKFLOW_ABORT === "1") process.emit("SIGINT");',
    '    return Response.json({ results: [{ url, title: "Notes", raw_content: text }] });',
    '  }',
    '  if (target === "https://api.typesafe.ai/v1/systemone") {',
    '    log("judge");',
    '    const ids = Object.keys(JSON.parse(init.body).questions);',
    '    return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 },',
    '      answers: Object.fromEntries(ids.map((id) => [id, { type: "noul", noul: /[cf]$/.test(id) ? 0.02 : 0.98 }])) });',
    '  }',
    '  log("unexpected"); throw Error("unexpected synthetic transport");',
    '};',
  ].join("\n"));

  const revision = await headRevision();
  const comparison = { schemaVersion: 1, kind: "comparison", request: COMPARISON_REQUEST };
  const run = async (name, profile, request, { consent = "1", exit = 0, abort = false } = {}) => {
    const log = join(directory, name + ".log");
    const envelope = join(directory, name + ".json");
    const home = join(directory, profile);
    await writeFile(log, "");
    await writeFile(envelope, JSON.stringify(request));
    const env = {
      PATH: process.env.PATH, HOME: home, TMPDIR: directory,
      SCOUTLINE_CONFIG_DIR: join(home, "config"),
      SCOUTLINE_CACHE_DIR: join(home, "cache"),
      SCOUTLINE_ARTIFACTS_DIR: join(home, "artifacts"),
      SCOUTLINE_PROVIDER: "tavily", TAVILY_API_KEY: "test-workflow-tavily",
      SCOUTLINE_JUDGE: "typesafe", TYPESAFE_API_KEY: "test-workflow-typesafe",
      SCOUTLINE_JUDGE_TRANSMIT: consent, TEST_WORKFLOW_TRAFFIC: log, TEST_WORKFLOW_ABORT: abort ? "1" : "0",
    };
    const code = await execFileP(process.execPath, [
      "--import", preload, join(REPO_ROOT, "packages/scoutline/bin/scoutline.js"),
      "investigate", "--workflow", envelope,
    ], { env }).then(() => 0, (error) => error.code);
    assert.equal(code, exit, name);
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
    assert.ok(!calls.includes("unexpected"), name);
    return calls;
  };

  const provider = await run("with-acquisition", "cache", comparison);
  assert.ok(provider.includes("search") && provider.includes("read") && provider.includes("judge"));
  assert.equal(provider.filter((call) => call === "quota").length, 1);
  const cached = await run("cache-only", "cache", comparison);
  assert.ok(cached.includes("judge"));
  assert.ok(cached.every((call) => call === "judge"));
  const partial = await run("partial-acquisition", "partial", comparison, { consent: "0", exit: 1 });
  assert.ok(partial.includes("search") && partial.includes("read"));
  assert.ok(!partial.includes("quota"));
  const interrupted = await run("interrupted", "interrupted", comparison, { abort: true, exit: 130 });
  assert.ok(interrupted.includes("read"));
  assert.ok(!interrupted.includes("quota"));
  const judgeOnly = await run("judge-only", "extraction", extractionDocument());
  assert.deepEqual(judgeOnly, ["judge", "judge"]);
  const audit = await run("local-audit", "audit", {
    schemaVersion: 1, kind: "audit", request: {
      repository: "scoutline", revision, localRepositoryPath: REPO_ROOT,
      claims: [{ id: "package", text: "The manifest names Scoutline", proofClass: "literal",
        checks: [{ path: "packages/scoutline/package.json", allOf: ["scoutline"] }] }],
    },
  });
  assert.deepEqual(audit, []);
});

test("interrupting an entered extraction judge returns 130 and stops new dispatches", async () => {
  let interrupt;
  const signals = [];
  const runtime = makeWorkflowRuntime([], {
    candidateJudge: async (input, options) => {
      signals.push(options.signal);
      interrupt();
      return {
        model: "workflow-fake-judge", attempts: 1, elapsedMs: 1,
        usage: { inputTokens: 2, outputTokens: 2 },
        requestSha256: "interrupted-workflow-fixture",
        answers: Object.fromEntries(input.candidates.flatMap((_candidate, i) => [
          [`q${i}s`, { type: "noul", noul: 0.97 }],
          [`q${i}c`, { type: "noul", noul: 0.03 }],
        ])),
      };
    },
  });
  const { adapter, stdout, stderr } = makeAdapter({ stdin: JSON.stringify({
    schemaVersion: 1, kind: "extraction",
    request: {
      manifestText: MANIFEST_TEXT,
      admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/manifest", title: "Manifest" },
    },
  }) });
  const deps = hermeticMainDeps({ invocation: adapter, env: { ...ENV } });
  deps.requirementsRuntime = runtime.factory;
  deps.requirementsUserInterrupt = (cancel) => {
    interrupt = cancel;
    return () => {};
  };
  assert.equal(await main(["investigate", "--workflow", "-"], deps), 130, stderr.join(""));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  const { measurement, evidence } = JSON.parse(stdout.join(""));
  assert.equal(measurement.physical.stages.judge, 1);
  assert.equal(evidence.length, 1);
});

test("resolution refuses IDs that would collapse to the same redaction marker", async () => {
  const runtime = makeWorkflowRuntime([]);
  const scope = { entity: "ExampleApp", release: "2.4.0" };
  const { code, stderr, parsed } = await runMain(["investigate", "--workflow", "-"], {
    env: { ...ENV, Z_AI_API_KEY: "first-synthetic-id", EXA_API_KEY: "second-synthetic-id" },
    runtime: runtime.factory,
    stdin: JSON.stringify({
      schemaVersion: 1, kind: "resolution",
      request: { schemaVersion: 1, scope, alternatives: [
        { id: "first-synthetic-id", scope, value: "GPL-3.0", source: { url: URL_GPL } },
        { id: "second-synthetic-id", scope, value: "MIT", source: { url: URL_CORRECTION }, correctionOf: "first-synthetic-id" },
      ] },
    }),
  });
  assert.equal(code, 1);
  assert.match(stderr, /VALIDATION_ERROR/);
  assert.doesNotMatch(stderr, /first-synthetic-id|second-synthetic-id/);
  assert.equal(parsed, null);
  assert.equal(runtime.calls.runtime, 0);
});

test("workflow forwards --no-cache and rejects missing or duplicate sources", async () => {
  const runtime = makeWorkflowRuntime([]);
  const noCache = [];
  const factory = (context) => {
    noCache.push(context.noCache);
    return runtime.factory(context);
  };
  const stdin = JSON.stringify({ schemaVersion: 1, kind: "comparison", request: COMPARISON_REQUEST });
  const { parsed, stderr } = await runMain(["investigate", "--workflow", "-", "--no-cache"], { stdin, runtime: factory });
  assert.equal(parsed?.kind, "evidence-comparison", stderr);
  assert.deepEqual(noCache, [true]);

  for (const [flags, message] of [
    [["--workflow"], /requires a file path/],
    [["--workflow", "first.json", "--workflow", "second.json"], /exactly one --workflow/],
    [["--workflow", "-", "--cache", "--no-cache"], /Unsupported workflow flag/],
  ]) {
    const result = await runMain(["investigate", ...flags], { stdin, runtime: factory });
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
  }
  assert.deepEqual(noCache, [true]);
});

test("production extraction accounts for actual native judge attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scoutline-workflow-native-count-"));
  try {
    const log = join(directory, "judge.log");
    const preload = join(directory, "judge.mjs");
    await writeFile(log, "");
    await writeFile(preload, [
      'import { appendFileSync } from "node:fs";',
      'globalThis.fetch = async (url, init) => {',
      '  if (String(url) !== "https://api.typesafe.ai/v1/systemone" || init.method !== "POST") throw new Error("Unexpected traffic");',
      '  appendFileSync(process.env.TEST_NATIVE_COUNT, "judge\\n");',
      '  const questions = JSON.parse(init.body).questions;',
      '  return Response.json({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 1 },',
      '    answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: id.endsWith("c") ? 0.02 : 0.98 }])) });',
      '};',
    ].join("\n"));
    await withWorkflowFile({
      schemaVersion: 1, kind: "extraction",
      request: { manifestText: MANIFEST_TEXT,
        admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/manifest", title: "Manifest" } },
    }, async (file) => {
      const { stdout } = await execFileP(process.execPath, [
        "--import", preload, join(REPO_ROOT, "packages/scoutline/bin/scoutline.js"),
        "investigate", "--workflow", file,
      ], {
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
          SCOUTLINE_CONFIG_DIR: join(directory, "config"), TEST_NATIVE_COUNT: log,
          SCOUTLINE_JUDGE: "typesafe", SCOUTLINE_JUDGE_TRANSMIT: "1", TYPESAFE_API_KEY: "synthetic-judge-key" },
      });
      const { measurement, result } = JSON.parse(stdout);
      const dispatched = (await readFile(log, "utf8")).trim().split("\n").length;
      assert.equal(dispatched, 2);
      assert.equal(result.status, "complete");
      assert.deepEqual(measurement.physical.stages, { acquisition: 0, judge: dispatched, producer: 0 });
      assert.equal(measurement.physical.total, dispatched);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Typed cancellation settlement (USER_CANCELLED, exit 130, no HTTP status)
// through the REAL main() dispatcher. The legacy owned.settle() classified
// extraction interrupts as ValidationError/400 with exit 130 and replaced
// the manifest seam's typed cancellation in the catch; these pins hold the
// typed settlement, the measurement-fault precedence, and the earned
// partial-data path.
// ---------------------------------------------------------------------------

function parseStderrEnvelope(stderrText) {
  const line = stderrText.trim().split("\n").filter(Boolean).pop();
  return line === undefined ? null : JSON.parse(line);
}

function extractionDocument() {
  return {
    schemaVersion: 1, kind: "extraction",
    request: {
      manifestText: MANIFEST_TEXT,
      admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/manifest", title: "Manifest" },
    },
  };
}

test("interrupt during asynchronous composition settles USER_CANCELLED/130 with no HTTP status", async () => {
  let interrupt;
  let composedEntered = false;
  const runtime = {
    factory: () => {
      composedEntered = true;
      interrupt();
      // Composition resolves normally; the typed checkpoint AFTER
      // composition is what must observe the interrupt.
      return makeWorkflowRuntime([]).factory();
    },
  };
  const { adapter, stderr } = makeAdapter({ stdin: JSON.stringify(extractionDocument()) });
  const deps = hermeticMainDeps({ invocation: adapter, env: { ...ENV } });
  deps.requirementsRuntime = runtime.factory;
  deps.requirementsUserInterrupt = (cancel) => { interrupt = cancel; return () => {}; };
  const code = await main(["investigate", "--workflow", "-"], deps);
  assert.equal(code, 130, stderr.join(""));
  assert.ok(composedEntered, "composition must have begun (post-kind checkpoint under test)");
  const envelope = parseStderrEnvelope(stderr.join(""));
  assert.ok(envelope, "an error envelope must be serialized to stderr");
  assert.equal(envelope.success, false);
  assert.equal(envelope.code, "USER_CANCELLED");
  assert.equal("statusCode" in envelope, false, "a user interrupt carries no HTTP status");
  assert.match(envelope.error, /interrupted by user/);
});

// Direct typed manifest throw, public reachability (analysis, no seam
// created for coverage): between the post-composition checkpoint and
// investigateReleaseManifest's synchronous abort checks there is NO
// await, so no event-loop turn can interleave an interrupt there — the
// callable's CancellationError is not publicly reachable through main()
// without a new async seam. The catch's preservation branch is
// defense-in-depth; its observable siblings (typed checkpoint, fault
// precedence, interrupt settlement) are all proven through main below,
// and the callable's typed throw is pinned in document-manifest.test.js.

test("interrupt during the awaited quota-snapshot composition settles typed 130, no dispatch, drained late settlement", { timeout: 4000 }, async () => {
  let interrupt;
  let unregisterCount = 0;
  let releaseSnapshot;
  // Late REJECTION is the stronger drain witness: the race-lost snapshot
  // work must be OBSERVED by raceWithInterrupt (void work.catch) so its
  // eventual rejection never escapes as an unhandled rejection.
  const snapshotGate = new Promise((_resolve, reject) => {
    releaseSnapshot = () => reject(new Error("snapshot settled late after the interrupt"));
  });
  let markEntered;
  const snapshotEntered = new Promise((resolve) => { markEntered = resolve; });
  const runtime = makeWorkflowRuntime([]);
  let factoryEntered = 0;
  const { adapter, stderr } = makeAdapter({ stdin: JSON.stringify(extractionDocument()) });
  const deps = hermeticMainDeps({ invocation: adapter, env: { ...ENV } });
  deps.requirementsRuntime = () => { factoryEntered += 1; return runtime.factory(); };
  // No already-populated quotaState: composition MUST await the injected
  // snapshot read. The read itself marks the ENTRY — resolved the moment
  // the await is entered, no timer guessing.
  deps.readRequirementsQuotaSnapshot = () => {
    markEntered();
    return snapshotGate;
  };
  deps.requirementsUserInterrupt = (cancel) => {
    interrupt = cancel;
    return () => { unregisterCount += 1; };
  };
  const pending = main(["investigate", "--workflow", "-"], deps);
  try {
    // Bounded entry: if main settles before composition ever entered the
    // snapshot await, that is a routing regression — fail loudly.
    const entryRace = await Promise.race([
      snapshotEntered.then(() => "entered"),
      pending.then((code) => `main-settled-before-entry(${code})`),
    ]);
    assert.equal(entryRace, "entered");
    // Fire the owned interrupt while the snapshot await is pending.
    interrupt();
    // Bounded post-interrupt settlement (test-level timeout above).
    const code = await pending;
    assert.equal(code, 130, stderr.join(""));
    assert.equal(factoryEntered, 0, "no runtime factory may run after the interrupt (cleanup without dispatch)");
    const envelope = parseStderrEnvelope(stderr.join(""));
    assert.ok(envelope, "an error envelope must be serialized to stderr");
    assert.equal(envelope.success, false);
    assert.equal(envelope.code, "USER_CANCELLED");
    assert.equal("statusCode" in envelope, false, "a user interrupt carries no HTTP status");
    assert.match(envelope.error, /interrupted by user/);
    assert.equal(unregisterCount, 1, "the external interrupt unregister ran exactly once");
  } finally {
    // Drain in finally: a regression that fails an assertion above must
    // not hang or leak the gated snapshot — release it and let the
    // observed-late-settlement path complete.
    releaseSnapshot();
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  }
});

test("mid-run interrupt with a completing engine settles earned partial data at 130", async () => {
  let interrupt;
  const seen = [];
  const world = makeWorkflowRuntime([]);
  const runtime = {
    factory: () => ({
      ...world.factory(),
      engineDeps: {
        ...world.factory().engineDeps,
        candidateJudge: async (input, options) => {
          interrupt();
          seen.push(options?.signal?.aborted === true);
          return world.factory().engineDeps.candidateJudge(input);
        },
      },
    }),
  };
  const { adapter, stdout, stderr } = makeAdapter({ stdin: JSON.stringify(extractionDocument()) });
  const deps = hermeticMainDeps({ invocation: adapter, env: { ...ENV } });
  deps.requirementsRuntime = runtime.factory;
  deps.requirementsUserInterrupt = (cancel) => { interrupt = cancel; return () => {}; };
  const code = await main(["investigate", "--workflow", "-"], deps);
  assert.equal(code, 130, stderr.join(""));
  assert.deepEqual(seen, [true], "the dispatch observed the aborted owned signal");
  const body = JSON.parse(stdout.join(""));
  assert.equal(body.kind, "manifest-extraction");
  assert.ok(body.evidence.length >= 1, "earned evidence is preserved");
  assert.ok(body.measurement !== undefined, "earned measurement is preserved");
  // Earned audit rows as exposed by the projection: the dispatched judge
  // is accounted in the composed physical observation.
  assert.equal(body.measurement.physical.stages.judge, 1,
    "the dispatched judge work is accounted");
  assert.ok(Array.isArray(body.measurement.physical.attempts), "attempt audit rows are exposed");
});

test("genuine extraction validation failures keep VALIDATION_ERROR/400/exit 1", async () => {
  const bad = {
    schemaVersion: 1, kind: "extraction",
    request: { admission: { materialClass: "synthetic", claimedUrl: "https://offline.test/m", title: "m" } },
  };
  const { adapter, stderr } = makeAdapter({ stdin: JSON.stringify(bad) });
  const deps = hermeticMainDeps({ invocation: adapter, env: { ...ENV } });
  const code = await main(["investigate", "--workflow", "-"], deps);
  assert.equal(code, 1);
  const envelope = parseStderrEnvelope(stderr.join(""));
  assert.equal(envelope.code, "VALIDATION_ERROR");
  assert.equal(envelope.statusCode, 400);
});

test("a measurement fault outranks the simultaneous interrupt", async () => {
  let interrupt;
  // The composed countingSeam records a measurement fault when the judge's
  // declared attempt count is malformed (attempts: 1.5 is not a safe
  // integer). The judge ALSO fires the user interrupt on the same
  // dispatch: the run completes with the judge error audited, then
  // workflowMeasurement -> composed.finalCheck() throws the recorded
  // fault — visible as VALIDATION_ERROR/exit 1, never reclassified as
  // USER_CANCELLED, and never masked by the interrupt's 130 settlement.
  const world = makeWorkflowRuntime([]);
  const runtime = {
    factory: (context) => {
      const built = world.factory(context);
      return {
        ...built,
        engineDeps: {
          ...built.engineDeps,
          candidateJudge: async (input, options) => {
            interrupt();
            void options;
            const answers = {};
            input.candidates.forEach((_c, i) => {
              answers[`q${i}s`] = { type: "noul", noul: 0.97 };
              answers[`q${i}c`] = { type: "noul", noul: 0.03 };
            });
            return {
              model: "workflow-fake-judge",
              answers,
              usage: { inputTokens: 20, outputTokens: 5 },
              requestSha256: "malformed-telemetry-judge",
              elapsedMs: 1,
              attempts: 1.5,
            };
          },
        },
      };
    },
  };
  const { adapter, stderr } = makeAdapter({ stdin: JSON.stringify(extractionDocument()) });
  const deps = hermeticMainDeps({ invocation: adapter, env: { ...ENV } });
  deps.requirementsRuntime = runtime.factory;
  deps.requirementsUserInterrupt = (cancel) => { interrupt = cancel; return () => {}; };
  const code = await main(["investigate", "--workflow", "-"], deps);
  assert.equal(code, 1, "a measurement fault settles exit 1 even while interrupted");
  const envelope = parseStderrEnvelope(stderr.join(""));
  assert.equal(envelope.code, "VALIDATION_ERROR");
  assert.match(envelope.error, /measurement/i);
  assert.equal(envelope.code === "USER_CANCELLED", false, "the fault must not be reclassified as cancellation");
});
