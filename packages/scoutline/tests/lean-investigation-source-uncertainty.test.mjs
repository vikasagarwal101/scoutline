import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import * as tsr from "../dist/lib/lean-typesafe-judge.js";

// Approved boolean|null policy; actual engine and native adapter, offline only.
const SHARED = "Assess ExampleApp 2.4.0 CSV export.";
const QUESTION = "Does ExampleApp 2.4.0 support CSV export?";
const url = (id) => `https://fixture.invalid/${id}`;
const hits = (...ids) => ids.map((id) => ({ url: url(id) }));
const config = {
  endpoint: "https://fixture.invalid/native",
  model: "fixture-model",
  apiKey: "fixture-key",
  timeoutMs: 50,
};
const makeContract = (limits = {}, labels = ["supported", "refuted", "disputed"]) => ({
  schemaVersion: 1,
  question: SHARED,
  scope: { entity: "ExampleApp", release: "2.4.0" },
  requirements: { csv: { question: QUESTION, required: true, schema: { enum: labels } } },
  evidence: { criteria: ["Check relevant contrary evidence before acceptance."] },
  limits,
});
const verdict = (doc, flags) => ({
  evidenceId: doc.evidenceId,
  relevant: flags[0],
  supportsClaim: flags[1],
  refutesClaim: flags[2],
});
const content = (sourceUrl) =>
  sourceUrl.endsWith("refute")
    ? "ExampleApp 2.4.0 does not support CSV export."
    : sourceUrl.endsWith("junk")
      ? "CSV export keywords only."
      : "ExampleApp 2.4.0 supports CSV export.";
async function run({
  policy,
  initial = ["guide", "junk"],
  next = [],
  contrary = [],
  limits = {},
  labels,
  read = async (sourceUrl) => content(sourceUrl),
  judge,
} = {}) {
  const seen = [];
  const result = await runLeanInvestigation(makeContract(limits, labels), {
    now: () => 0,
    search: async (q) => hits(...(q === SHARED ? initial : q === QUESTION ? next : contrary)),
    read,
    judge:
      judge ??
      (async (input) => {
        seen.push(structuredClone(input));
        return { documents: input.documents.map((doc) => verdict(doc, policy(doc, input))) };
      }),
  });
  return { result, seen };
}
function unresolved(result) {
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.notEqual(result.status, "complete");
}
// Diagnostics naming is engineering-owned. Require inspectable per-source
// normalized records somewhere in the result, without prescribing a new API key.
function assessments(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (
    Object.hasOwn(value, "evidenceId") &&
    Object.hasOwn(value, "relevant") &&
    Object.hasOwn(value, "supportsClaim") &&
    Object.hasOwn(value, "refutesClaim")
  )
    out.push(value);
  for (const child of Object.values(value)) assessments(child, out);
  return out;
}

test("clear guide plus unknown keyword relevance/support and false refutation fulfills support", async () => {
  const { result } = await run({
    policy: (doc) => (doc.url.endsWith("junk") ? [null, null, false] : [true, true, false]),
  });
  assert.equal(result.data.csv, "supported");
  assert.equal(result.status, "complete");
  const unknown = assessments(result).find(
    (row) =>
      row.evidenceId === "e2" &&
      row.relevant === null &&
      row.supportsClaim === null &&
      row.refutesClaim === false,
  );
  assert.ok(unknown, "unknown source assessments must remain visible, not coerced or dropped");
});

test("unknown potential refutation blocks support and preserves clear contribution", async () => {
  const { result, seen } = await run({
    next: ["new"],
    policy: (doc) => (doc.url.endsWith("junk") ? [null, false, null] : [true, true, false]),
  });
  assert.equal(seen.length, 2, "blocked uncertainty must seek and assess fresh content");
  unresolved(result);
  assert.ok(
    result.requirements.csv.evidenceIds.includes("e1"),
    "clear guide contribution lost behind unknown counterevidence",
  );
  assert.match(result.requirements.csv.reason, /uncertain|indeterminate/);
});

test("unknown relevance with true refutation blocks supported even without null refutation", async () => {
  const { result } = await run({
    policy: (doc) => (doc.url.endsWith("junk") ? [null, false, true] : [true, true, false]),
  });
  unresolved(result);
  assert.ok(result.requirements.csv.evidenceIds.includes("e1"));
  assert.match(result.requirements.csv.reason, /uncertain|indeterminate/);
});

test("unknown becomes known only with new context and allows support completion", async () => {
  const { result, seen } = await run({
    next: ["new"],
    policy: (doc, input) =>
      doc.url.endsWith("junk")
        ? [true, false, input.documents.length === 2 ? null : false]
        : [true, true, false],
  });
  assert.deepEqual(
    seen.map((i) => i.documents.length),
    [2, 3],
  );
  assert.equal(result.data.csv, "supported");
  assert.equal(result.status, "complete");
  assert.equal(result.requirements.csv.inconsistentJudgments, 0);
  assert.ok(
    assessments(result).some((row) => row.evidenceId === "e2" && row.refutesClaim === null),
    "initial unknown assessment must survive later resolution in diagnostics",
  );
});

test("symmetric clear refutation plus possible unknown support stays unresolved", async () => {
  const { result } = await run({
    initial: ["refute", "junk"],
    policy: (doc) => (doc.url.endsWith("junk") ? [null, null, false] : [true, false, true]),
  });
  unresolved(result);
  assert.ok(result.requirements.csv.evidenceIds.includes("e1"));
  assert.match(result.requirements.csv.reason, /uncertain|indeterminate/);
});

test("symmetric unknown relevance/refutation with false support does not veto refuted", async () => {
  const { result } = await run({
    initial: ["refute", "junk"],
    policy: (doc) => (doc.url.endsWith("junk") ? [null, false, null] : [true, false, true]),
  });
  assert.equal(result.data.csv, "refuted");
  assert.equal(result.status, "complete");
});

test("symmetric unknown relevance with true support blocks refuted", async () => {
  const { result } = await run({
    initial: ["refute", "junk"],
    policy: (doc) => (doc.url.endsWith("junk") ? [null, true, false] : [true, false, true]),
  });
  unresolved(result);
  assert.ok(result.requirements.csv.evidenceIds.includes("e1"));
  assert.match(result.requirements.csv.reason, /uncertain|indeterminate/);
});

test("clearly irrelevant source with unknown sides does not veto support but stays recorded", async () => {
  const { result } = await run({
    policy: (doc) => (doc.url.endsWith("junk") ? [false, null, null] : [true, true, false]),
  });
  assert.equal(result.data.csv, "supported");
  assert.ok(
    assessments(result).some(
      (row) =>
        row.evidenceId === "e2" &&
        row.relevant === false &&
        row.supportsClaim === null &&
        row.refutesClaim === null,
    ),
  );
});

test("clear two-sided dispute survives another unknown source without invented side", async () => {
  const { result } = await run({
    initial: ["guide", "junk"],
    next: ["refute"],
    policy: (doc) =>
      doc.url.endsWith("junk")
        ? [null, null, null]
        : doc.url.endsWith("refute")
          ? [true, false, true]
          : [true, true, false],
  });
  assert.equal(result.data.csv, "disputed");
  assert.equal(result.status, "complete");
});

test("unknown alone cannot manufacture disputed and is recorded explicitly", async () => {
  const { result, seen } = await run({ initial: ["junk"], policy: () => [true, null, null] });
  unresolved(result);
  assert.equal(seen.length, 1, "same context must not be rejudged");
  assert.match(result.requirements.csv.reason, /uncertain|indeterminate/);
  assert.ok(
    assessments(result).some(
      (row) => row.evidenceId === "e1" && row.supportsClaim === null && row.refutesClaim === null,
    ),
  );
});

test("known conflict cannot be erased by unknown relevance then laundered opposite verdict", async () => {
  const { result, seen } = await run({
    initial: ["guide", "refute"],
    next: ["new"],
    contrary: ["extra"],
    labels: ["supported", "refuted"],
    policy: (doc, input) => {
      if (!doc.url.endsWith("refute")) return [true, true, false];
      return input.documents.length === 2
        ? [true, false, true]
        : input.documents.length === 3
          ? [null, false, true]
          : [true, true, false];
    },
  });
  assert.deepEqual(
    seen.map((i) => i.documents.length),
    [2, 3, 4],
  );
  unresolved(result);
  assert.ok(
    result.requirements.csv.inconsistentJudgments >= 2,
    "known->unknown rejection must not become trusted history",
  );
  assert.ok(
    result.requirements.csv.evidenceIds.includes("e2"),
    "prior clear refutation must survive rejected history",
  );
});

test("support->unknown on unchanged old source is inconsistent, not erased", async () => {
  const { result } = await run({
    initial: ["guide"],
    next: ["new"],
    policy: (doc, input) =>
      doc.evidenceId === "e1" && input.documents.length > 1
        ? [true, null, false]
        : [true, true, false],
  });
  unresolved(result);
  assert.ok(result.requirements.csv.inconsistentJudgments > 0);
});

test("adapter returns complete boolean|null records and exact per-question probabilities", async () => {
  const input = {
    fieldId: "csv",
    fieldQuestion: QUESTION,
    scope: {},
    criteria: [],
    candidates: ["supported"],
    documents: ["guide", "junk"].map((id, i) => ({
      evidenceId: `e${i + 1}`,
      url: url(id),
      title: id,
      content: content(url(id)),
    })),
  };
  const probabilities = { q0r: 0.97, q0s: 0.97, q0f: 0.01, q1r: 0.28, q1s: 0.25, q1f: 0.02 };
  const profile = tsr.createTypesafeJudge({
    apiKey: config.apiKey,
    reserveAttempt: () => {},
    fetchLike: async () =>
      new Response(
        JSON.stringify({
          model: tsr.TYPESAFE_PINNED_MODEL,
          usage: { input_tokens: 1, output_tokens: 1 },
          answers: Object.fromEntries(
            Object.entries(probabilities).map(([id, noul]) => [id, { type: "noul", noul }]),
          ),
        }),
      ),
  });
  const response = await profile.judge(input);
  const metadata = response[Symbol.for("leanJevAttemptMeta")];
  assert.ok(
    response.documents,
    "middle bands must return complete source assessments instead of discard-all response",
  );
  assert.deepEqual(response.documents, [
    { evidenceId: "e1", relevant: true, supportsClaim: true, refutesClaim: false },
    { evidenceId: "e2", relevant: null, supportsClaim: null, refutesClaim: false },
  ]);
  assert.deepEqual(metadata.probabilities, probabilities);
});

test("actual official judge and engine complete mixed clear guide/unknown junk", async () => {
  const profile = tsr.createTypesafeJudge({
    apiKey: config.apiKey,
    reserveAttempt: () => {},
    timeoutMs: config.timeoutMs,
    fetchLike: async (_endpoint, init) => {
    const request = JSON.parse(init.body);
    const answers = Object.fromEntries(
      request.state.sources.flatMap((doc, i) =>
        ["r", "s", "f"].map((kind) => [
          `q${i}${kind}`,
          { type: "noul", noul: kind === "f" ? 0.01 : doc.url.endsWith("junk") ? 0.25 : 0.97 },
        ]),
      ),
    );
      return new Response(
        JSON.stringify({
          model: tsr.TYPESAFE_PINNED_MODEL,
          usage: { input_tokens: 1, output_tokens: 1 },
          answers,
        }),
      );
    },
  });
  const { result } = await run({ judge: profile.judge });
  assert.equal(result.data.csv, "supported");
  assert.equal(result.status, "complete");
  assert.ok(
    JSON.stringify(result).includes("0.25"),
    "engine diagnostics must preserve raw middle-band probability, not only normalized unknown",
  );
});

for (const bad of ["false", 0, undefined]) {
  test(`control: normalized ${String(bad)} flag remains invalid, never unknown`, async () => {
    const { result } = await run({ initial: ["guide"], policy: () => [true, true, bad] });
    unresolved(result);
    assert.ok(result.acquisitionLog.some((row) => row.kind === "judge-invalid"));
  });
}

test("control: native missing IDs/wrong types/nonfinite values stay rejected", async () => {
  const input = {
    fieldId: "csv",
    fieldQuestion: QUESTION,
    scope: {},
    criteria: [],
    candidates: ["supported"],
    documents: [{ evidenceId: "e1", url: url("guide"), title: "Guide", content: "Support" }],
  };
  const base = {
    q0r: { type: "noul", noul: 1 },
    q0s: { type: "noul", noul: 1 },
    q0f: { type: "noul", noul: 0 },
  };
  for (const answers of [
    { q0r: base.q0r },
    { ...base, q0s: { type: "choice", noul: 0.5 } },
    { ...base, q0f: { type: "noul", noul: null } },
  ]) {
    const profile = tsr.createTypesafeJudge({
      apiKey: config.apiKey,
      reserveAttempt: () => {},
      fetchLike: async () =>
        new Response(
          JSON.stringify({
            model: tsr.TYPESAFE_PINNED_MODEL,
            usage: { input_tokens: 1, output_tokens: 1 },
            answers,
          }),
        ),
    });
    let rejection;
    try {
      await profile.judge(input);
    } catch (error) {
      rejection = error;
    }
    assert(rejection, "protocol-invalid answers must reject at the official boundary");
    assert.match(rejection.code, /^TYPESAFE_(PROTOCOL|MALFORMED)$/);
  }
});

test("control: required contrary read failure cannot be waived by unknown semantics", async () => {
  const { result } = await run({
    initial: ["guide"],
    contrary: ["failed"],
    policy: () => [true, true, false],
    read: async (sourceUrl) => {
      if (sourceUrl.endsWith("failed")) throw Error("fixture failure");
      return content(sourceUrl);
    },
  });
  unresolved(result);
  assert.equal(result.requirements.csv.reason, "counterevidence_not_acquired");
});

test("control: no judge still retains evidence and no semantic values", async () => {
  const result = await runLeanInvestigation(makeContract(), {
    now: () => 0,
    search: async () => hits("guide"),
    read: async () => "Support",
    judge: null,
  });
  assert.equal(result.assessment, "deterministic-only");
  assert.equal(result.usage.judgeCalls, 0);
  assert.ok(result.evidence.length > 0);
  unresolved(result);
});

test("control: unjudged fresh contrary content under judge cap cannot finalize support", async () => {
  const { result } = await run({
    initial: ["guide"],
    contrary: ["refute"],
    limits: { maxJudgeAttempts: 1 },
    policy: (doc) => (doc.url.endsWith("refute") ? [true, false, true] : [true, true, false]),
  });
  assert.equal(result.evidence.length, 2);
  assert.equal(result.usage.judgeCalls, 1);
  unresolved(result);
});

test("control: malformed fresh context cannot finalize older pending support", async () => {
  const { result } = await run({
    initial: ["guide"],
    contrary: ["refute"],
    judge: async ({ documents }) => ({
      documents: documents.slice(0, 1).map((doc) => verdict(doc, [true, true, false])),
    }),
  });
  assert.equal(result.evidence.length, 2);
  unresolved(result);
  assert.ok(result.acquisitionLog.some((row) => row.kind === "judge-invalid"));
});
