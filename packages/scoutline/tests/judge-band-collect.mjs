/**
 * Collects raw judge answers over the review corpus, for threshold band work (#307).
 *
 * BLIND BY CONSTRUCTION. This file imports the corpus and the candidate proposals.
 * It never imports judge-band-labels.mjs, so no gold value can reach a request.
 * It writes raw observations to a file; judge-band-score.mjs joins them with the
 * labels afterwards.
 *
 * What it asks, per case with the split "development" (reserved cases are skipped):
 *   - the CSV classification request at every acquisition round, that is with the
 *     documents retained so far, which is also the context comparison of #308;
 *   - one candidate request per proposal, with the whole case as opposing context.
 *
 * About 140 requests per repeat at the default settings.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node tests/judge-band-collect.mjs --out observations.json [--model id] [--repeat 3]
 *   node tests/judge-band-collect.mjs --out observations.json --dry-run
 *
 * --dry-run replaces the network with a fixture that answers from the document text
 * by simple keyword rules. That checks the plumbing without a key, a call or a
 * charge. Its numbers say nothing about any model.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { inputs } from "./unified-review-corpus.mjs";
import { candidateProposals, supplementInputs } from "./judge-band-supplement.mjs";
import { createSelectedNativeJudge } from "../dist/lib/lean-typesafe-judge.js";
import { candidateSourceDigest } from "../dist/lib/lean-candidates.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const outPath = flag("--out", undefined);
const model = flag("--model", undefined);
const repeat = Number(flag("--repeat", "1"));
const dryRun = args.includes("--dry-run");
if (!outPath) {
  console.error("Pass --out <file>.");
  process.exit(2);
}
if (!Number.isInteger(repeat) || repeat < 1) {
  console.error("--repeat must be a positive integer.");
  process.exit(2);
}
const apiKey = dryRun ? "fixture-not-a-real-key" : process.env.OPENROUTER_API_KEY;
if (!apiKey?.trim()) {
  console.error("Set OPENROUTER_API_KEY, or pass --dry-run.");
  process.exit(2);
}

const PAUSE_MS = 250;
const TRIAL_BAND = { trueBound: 0.9, falseBound: 0.1 };
const QUESTIONS = ["relevant", "supports", "refutes"];
const SUFFIX = { relevant: "r", supports: "s", refutes: "f" };
/** The reserved cases are kept out of tuning, so they are never sent. */
const cases = [...inputs, ...supplementInputs].filter((c) => c.split === "development");

/** Only documents that were read can be in a request. */
const readSources = (c) => c.sources.filter((s) => !s.readError && s.content);
const recordOf = (s, index) => ({
  evidenceId: `e${index + 1}`,
  url: s.url,
  title: s.title,
  content: s.content,
  byteLength: Buffer.byteLength(s.content),
  origins: [],
});
/** Every acquisition round: the documents retained so far. */
const roundsOf = (c) => {
  const order = [...c.acquisition.initial, ...(c.acquisition.later ?? []), ...(c.acquisition.late ?? [])];
  const byId = new Map(c.sources.map((s) => [s.id, s]));
  const rounds = [];
  let seen = new Set();
  for (const id of order) {
    const s = byId.get(id);
    seen.add(id);
    // A round that only added an unreadable source asks nothing new.
    if (s?.readError) continue;
    rounds.push({ documents: [...seen].map((x) => byId.get(x)).filter((x) => !x.readError) });
  }
  return rounds;
};
const criteriaOf = (c, fieldId) => [...c.contract.requirements[fieldId].criteria, ...(c.contract.evidence?.criteria ?? [])];

/** The engine's classification request for the CSV field over `documents`. */
const classificationInput = (c, documents) => ({
  fieldId: "csv",
  fieldQuestion: c.contract.requirements.csv.question,
  criteria: criteriaOf(c, "csv"),
  scope: c.contract.scope,
  candidates: [...c.contract.requirements.csv.schema.enum],
  documents: documents.map((s, i) => ({ evidenceId: `e${i + 1}`, url: s.url, title: s.title, content: s.content })),
  depBindings: {},
});

/** The engine's candidate request for one proposal, over the whole case. */
const candidateInput = (c, proposal) => {
  const sources = readSources(c);
  // Retained records keep one id each, in retention order, as in the engine.
  const records = sources.map((s, i) => recordOf(s, i));
  const index = sources.findIndex((s) => s.id === proposal.sourceId);
  const source = sources[index];
  // The license field depends on an accepted version. Bind the version this same
  // source proposes, when it proposes one; that is input, not gold.
  const version = candidateProposals.find(
    (p) => p.caseId === proposal.caseId && p.sourceId === proposal.sourceId && p.fieldId === "version",
  );
  const record = records[index];
  const at = source.content.indexOf(proposal.quote);
  return {
    source: record,
    fieldMeanings: { [proposal.fieldId]: [c.contract.requirements[proposal.fieldId].question, ...criteriaOf(c, proposal.fieldId)].join("\n") },
    scope: c.contract.scope,
    candidates: [{ fieldId: proposal.fieldId, value: proposal.value, quote: proposal.quote, charRange: [at, at + proposal.quote.length] }],
    opposingContext: records.filter((_, i) => i !== index),
    ...(version ? { depBindings: { version: { value: version.value, evidenceId: record.evidenceId, sourceDigest: candidateSourceDigest(record) } } } : {}),
  };
};

/** Fixture transport: keyword rules over the request text. The jitter moves from
 * call to call, so repeated requests differ a little, as real ones do. */
let fixtureCalls = 0;
const fixtureFetch = async (_input, init) => {
  const body = JSON.parse(init.body);
  fixtureCalls += 1;
  const jitter = (key) => ((parseInt(createHash("sha256").update(key).digest("hex").slice(0, 6), 16) % 7) - 3) / 100;
  const clamp = (p) => Math.min(0.99, Math.max(0.01, p));
  const answers = {};
  for (const id of Object.keys(body.questions)) {
    let p = 0.3;
    if (body.state.sources) {
      const at = Number(id[1]);
      const text = body.state.sources[at].text;
      if (id.endsWith("r")) p = text.includes(body.state.scope.entity) ? 0.9 : 0.15;
      else if (id.endsWith("s")) p = /does not support CSV export/.test(text) ? 0.05 : /supports CSV export/.test(text) ? 0.93 : 0.3;
      else p = /does not support CSV export/.test(text) ? 0.93 : 0.04;
    } else {
      const field = body.state.fields[0];
      if (id.endsWith("s")) p = body.state.source.text.includes(field.quote) && field.quote.includes(field.value) ? 0.92 : 0.2;
      else p = 0.08;
    }
    answers[id] = { type: "noul", noul: clamp(p + jitter(`${id}|${fixtureCalls}|${body.state.sources?.length ?? "c"}`)) };
  }
  const text = JSON.stringify({ model: expectedModel, answers, usage: { input_tokens: 100, output_tokens: 20 } });
  return {
    status: 200,
    ok: true,
    headers: { get: () => "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
};

/** Pinned identity the fixture must answer with; set once the profile exists. */
let expectedModel = "unset";
const fetchLike = dryRun ? fixtureFetch : (input, init) => fetch(input, init);
const profile = createSelectedNativeJudge("openrouter", { apiKey, reserveAttempt: () => {}, fetchLike, timeoutMs: 15_000 }, model);
const d = profile.descriptor;
expectedModel = d.expectedResolvedModel;
// The descriptor carries its band as an object only on the #307 proof-of-concept
// branch; on main it carries the revision alone, so the trial bounds are supplied.
const band = d.threshold ?? (d.thresholdRevision === "trial-v1-p9-p1" ? TRIAL_BAND : null);
const underBand = (p) => (band && p >= band.trueBound ? true : band && p <= band.falseBound ? false : null);
const pause = () => new Promise((resolve) => setTimeout(resolve, PAUSE_MS));

const observations = [];
let requests = 0;
let failures = 0;
const collect = async (item, run) => {
  for (let rep = 1; rep <= repeat; rep += 1) {
    requests += 1;
    try {
      await run(rep);
    } catch (error) {
      failures += 1;
      observations.push({ ...item, rep, error: `${error?.code ?? "Error"}: ${error?.message ?? String(error)}` });
    }
    if (!dryRun) await pause();
  }
};

for (const c of cases) {
  for (const [r, round] of roundsOf(c).entries()) {
    await collect({ kind: "classification", caseId: c.id, round: r + 1, documents: round.documents.length }, async (rep) => {
      const response = await profile.judge(classificationInput(c, round.documents));
      const p = response[Symbol.for("leanJevAttemptMeta")].probabilities;
      round.documents.forEach((s, i) => {
        for (const question of QUESTIONS) {
          const raw = p[`q${i}${SUFFIX[question]}`];
          observations.push({ kind: "classification", caseId: c.id, sourceId: s.id, question, round: r + 1, documents: round.documents.length, rep, raw, verdict: underBand(raw) });
        }
      });
    });
  }
}
for (const proposal of candidateProposals) {
  if (!cases.some((c) => c.id === proposal.caseId)) continue;
  const c = cases.find((x) => x.id === proposal.caseId);
  await collect({ kind: "candidate", caseId: c.id, sourceId: proposal.sourceId, fieldId: proposal.fieldId, value: proposal.value, proposalId: proposal.id }, async (rep) => {
    const response = await profile.candidateJudge(candidateInput(c, proposal));
    for (const [question, id] of [["support", "q0s"], ["conflict", "q0c"]]) {
      const raw = response.answers[id].noul;
      observations.push({ kind: "candidate", caseId: c.id, sourceId: proposal.sourceId, fieldId: proposal.fieldId, value: proposal.value, proposalId: proposal.id, question, rep, raw, verdict: underBand(raw) });
    }
  });
}

const out = {
  schemaVersion: 1,
  collectedAt: new Date().toISOString(),
  mode: dryRun ? "dry-run" : "live",
  labelBlind: true,
  inputs: ["tests/unified-review-corpus.mjs (development split)", "tests/judge-band-supplement.mjs"],
  judge: { route: d.route, requestedModel: d.requestedModel, expectedResolvedModel: d.expectedResolvedModel, thresholdRevision: d.thresholdRevision },
  repeat,
  requests,
  failures,
  observations,
};
writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
console.log(
  `${out.mode}: ${requests} requests, ${failures} failures, ${observations.length} observation rows over ${cases.length} cases -> ${outPath}`,
);
console.log(`judge: ${d.requestedModel} (resolved ${d.expectedResolvedModel}), band ${d.thresholdRevision}${band ? ` ${band.trueBound}/${band.falseBound}` : ""}`);
