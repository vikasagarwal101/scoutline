import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import * as tsr from "../dist/lib/lean-typesafe-judge.js";
const { createTypesafeJudge } = tsr;
const CONFIG = {
  endpoint: "https://fixture.invalid/private-endpoint-marker",
  model: "fixture-request",
  apiKey: "private-credential-marker",
  timeoutMs: 50,
};
const CONTRACT = {
  schemaVersion: 1,
  question: "Assess",
  requirements: {
    csv: {
      question: "CSV?",
      required: true,
      schema: { enum: ["supported", "refuted", "disputed"] },
    },
  },
};
function objects(value, predicate, out = []) {
  if (!value || typeof value !== "object") return out;
  if (predicate(value)) out.push(value);
  for (const child of Object.values(value)) objects(child, predicate, out);
  return out;
}
const isAssessment = (v) =>
  Object.hasOwn(v, "evidenceId") &&
  Object.hasOwn(v, "relevant") &&
  Object.hasOwn(v, "supportsClaim") &&
  Object.hasOwn(v, "refutesClaim");
const isMeta = (v) =>
  Object.hasOwn(v, "probabilities") &&
  Object.hasOwn(v, "usage") &&
  Object.hasOwn(v, "attemptSha256");
const hasUntrustedMarker = (v) =>
  v.trusted === false ||
  v.accepted === false ||
  Object.values(v).some(
    (x) => typeof x === "string" && /reject|untrust|inconsisten|invalid/.test(x),
  );

test("all native attempts survive rejected known-to-unknown history with explicit untrusted records", async () => {
  let calls = 0;
  const judge = createTypesafeJudge({
    apiKey: CONFIG.apiKey,
    reserveAttempt: () => {},
    fetchLike: async (_endpoint, init) => {
    calls++;
    const request = JSON.parse(init.body);
    const answers = Object.fromEntries(
      request.state.sources.flatMap((_, i) =>
        ["r", "s", "f"].map((kind) => [
          `q${i}${kind}`,
          {
            type: "noul",
            noul: kind === "f" ? 0.01 : kind === "s" && i === 0 && calls > 1 ? 0.25 : 0.97,
          },
        ]),
      ),
    );
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        usage: { input_tokens: calls, output_tokens: 1 },
        answers,
      }),
    );
    },
  });
  const result = await runLeanInvestigation(CONTRACT, {
    now: () => 0,
    search: async (query) => [
      {
        url: `https://fixture.invalid/${query === "Assess" ? "one" : query === "CSV?" ? "two" : "three"}`,
      },
    ],
    read: async () => "Supports CSV",
    judge: judge.judge,
  });
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(result.requirements.csv.inconsistentJudgments, 2);
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.equal(calls, 3);
  const metas = objects(result, isMeta);
  assert.equal(
    new Set(metas.map((m) => m.attemptSha256)).size,
    3,
    "rejected rounds must preserve distinct native attempt probabilities and identity",
  );
  assert.ok(metas.filter((m) => m.probabilities.q0s === 0.25).length >= 2);
  const rejectedRecords = objects(
    result,
    (v) =>
      hasUntrustedMarker(v) &&
      objects(v, isAssessment).some((a) => a.evidenceId === "e1" && a.supportsClaim === null),
  );
  assert.ok(
    rejectedRecords.length >= 2,
    "rejected null records must be inspectable and explicitly untrusted",
  );
});

test("malformed new assessment is audited as invalid without contribution", async () => {
  let calls = 0;
  const result = await runLeanInvestigation(CONTRACT, {
    now: () => 0,
    search: async (query) =>
      query === "Assess"
        ? [{ url: "https://fixture.invalid/one" }]
        : query === "CSV?"
          ? [{ url: "https://fixture.invalid/two" }]
          : [],
    read: async () => "Supports CSV",
    judge: async ({ documents }) => {
      calls++;
      const response = {
        documents: documents.slice(0, 1).map((doc) => ({
          evidenceId: doc.evidenceId,
          relevant: true,
          supportsClaim: true,
          refutesClaim: false,
        })),
      };
      response[Symbol.for("leanJevAttemptMeta")] = {
        attemptSha256: String(calls).repeat(64),
        usage: { inputTokens: 1, outputTokens: 1 },
        probabilities: { q0s: calls === 1 ? 0.97 : 0.25 },
      };
      return response;
    },
  });
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.equal(calls, 2);
  assert.equal(
    new Set(objects(result, isMeta).map((m) => m.attemptSha256)).size,
    2,
    "malformed attempts cannot vanish from audit trail",
  );
  assert.ok(
    objects(result, (v) => hasUntrustedMarker(v) && JSON.stringify(v).includes("0.25")).length > 0,
  );
});

// Actual engine + official adapter with fixture native probabilities.
// The uncertainty-revision audit lives in the ENGINE's attempt metadata
// and per-source projections, so no report runner is involved.
async function runnerReport() {
  const attempts = [];
  const profile = createTypesafeJudge({
    apiKey: CONFIG.apiKey,
    reserveAttempt: () => {},
    onAttempt: (event) => attempts.push(event),
    fetchLike: async (_endpoint, init) => {
      const request = JSON.parse(init.body);
      const answers = Object.fromEntries(
        request.state.sources.flatMap((doc, i) =>
          ["r", "s", "f"].map((kind) => {
            let p;
            if (doc.url.includes("keywords")) p = kind === "f" ? 0.25 : 0.5;
            else if (doc.url.includes("guide")) p = kind === "f" ? 0.01 : 0.97;
            else p = 0.01;
            return [`q${i}${kind}`, { type: "noul", noul: p }];
          }),
        ),
      );
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          usage: { input_tokens: 1, output_tokens: 1 },
          answers,
        }),
      );
    },
  });
  const SHARED = "Assess CSV export support in ExampleApp 2.4.0.";
  const CSV = "Does ExampleApp 2.4.0 support CSV export?";
  const result = await runLeanInvestigation(
    {
      schemaVersion: 1,
      question: SHARED,
      scope: { entity: "ExampleApp", release: "2.4.0" },
      requirements: {
        csv: {
          question: CSV,
          schema: { enum: ["supported", "refuted", "disputed"] },
          criteria: ["Use statements about this exact product and release."],
          required: true,
        },
      },
      evidence: { criteria: ["Check relevant contrary evidence before accepting a result."] },
    },
    {
      now: () => 0,
      search: async (q) =>
        q === SHARED
          ? [
              { url: "https://spam.example/keywords" },
              { url: "https://news.example/unrelated" },
            ]
          : q === CSV
            ? [{ url: "https://docs.example/guide" }]
            : [],
      read: async (url) =>
        url.includes("guide")
          ? "ExampleApp 2.4.0 supports CSV export from the reports screen."
          : url.includes("keywords")
            ? "csv export exampleapp 2.4.0 csv export exampleapp 2.4.0 csv export"
            : "Quarterly industry results announced today.",
      judge: profile.judge,
    },
  );
  return {
    attempts: attempts.map((a) => ({ kind: a.outcome === "ok" ? "ok" : a.outcome, ...a })),
    // The engine preserves per-attempt judge metadata (including the
    // uncertainty revision) inside its audit trail.
    judgeAttemptMeta: (result.requirements.csv.attemptedRecords ?? [])
      .map((record) => record.metadata)
      .filter((m) => m !== null && m !== undefined),
    cases: [{ id: "progression", actual: { data: result.data, csv: result.requirements.csv.status, requirements: result.requirements } }],
    result,
  };
}

test("actual judge identifies uncertainty revision in every completed native attempt", async () => {
  const { attempts, judgeAttemptMeta } = await runnerReport();
  assert.ok(attempts.length > 0);
  assert.ok(judgeAttemptMeta.length > 0);
  assert.ok(
    judgeAttemptMeta.every((m) => m.uncertaintyRevision === tsr.TYPESAFE_UNCERTAINTY_REVISION),
    "every accepted attempt must name the answer-specific uncertainty policy",
  );
  assert.equal(tsr.TYPESAFE_UNCERTAINTY_REVISION, "per-source-null-v1");
  const serialized = JSON.stringify({ attempts, judgeAttemptMeta });
  assert.equal(serialized.includes(tsr.TYPESAFE_SYSTEMONE_ENDPOINT), false);
  assert.equal(serialized.includes(CONFIG.apiKey), false);
});

test("actual run preserves source assessments and clear support plus pending opposite uncertainty", async () => {
  const report = await runnerReport();
  const progression = report.cases.find((row) => row.id === "progression");
  assert.equal(progression.actual.data.csv, undefined);
  assert.match(progression.actual.csv, /unresolved/);
  const rows = objects(progression, isAssessment);
  assert.ok(
    rows.some((row) => row.evidenceId === "e1" && row.refutesClaim === null),
    "possible counterevidence must be inspectable in report",
  );
  assert.ok(
    rows.some(
      (row) => row.evidenceId === "e3" && row.relevant === true && row.supportsClaim === true,
    ),
    "clear support must survive compact report projection",
  );
  assert.ok(JSON.stringify(progression).includes("uncertain"));
});

test("control: actual engine remains blocked by possible opposite evidence", async () => {
  const result = await runLeanInvestigation(CONTRACT, {
    now: () => 0,
    search: async (query) =>
      query === "Assess"
        ? [{ url: "https://fixture.invalid/guide" }, { url: "https://fixture.invalid/junk" }]
        : [],
    read: async () => "Fixture",
    judge: async ({ documents }) => ({
      documents: documents.map((doc, i) => ({
        evidenceId: doc.evidenceId,
        relevant: i ? null : true,
        supportsClaim: i ? false : true,
        refutesClaim: i ? null : false,
      })),
    }),
  });
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.ok(result.requirements.csv.evidenceIds.includes("e1"));
  assert.equal(Object.hasOwn(result.data, "csv"), false);
});
