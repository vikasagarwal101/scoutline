import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
const hash = (x) => createHash("sha256").update(x).digest("hex");
test("later field evidence revokes already satisfied earlier enum and dependent value", async () => {
  const contract = {
    schemaVersion: 1,
    question: "Investigate Test 2.4.",
    scope: { entity: "Test", release: "2.4" },
    requirements: {
      csv: { question: "Does CSV work?", schema: { enum: ["supported", "refuted", "disputed"] } },
      version: { question: "Version?", schema: { type: "string" }, dependsOn: ["csv"] },
      license: { question: "License?", schema: { type: "string" }, dependsOn: ["version"] },
    },
  };
  const docs = {
    guide: "Test release 2.4. License MIT. CSV works.",
    review: "Test 2.4 verification: CSV works. License MIT.",
    adverse: "Test 2.4 limitations: CSV does not work. License GPL.",
  };
  const calls = { judge: [], candidate: [] };
  const result = await runLeanInvestigation(contract, {
    now: () => 0,
    search: async (q) => [
      {
        url: `https://fixture.invalid/${q.includes("License? contrary") ? "adverse" : q.includes("contrary") ? "review" : "guide"}`,
      },
    ],
    read: async (url) => docs[url.split("/").at(-1)],
    judge: async (input) => {
      calls.judge.push(structuredClone(input));
      return {
        documents: input.documents.map((d) => ({
          evidenceId: d.evidenceId,
          relevant: true,
          supportsClaim: d.content.includes("CSV works"),
          refutesClaim: d.content.includes("CSV does not work"),
        })),
      };
    },
    extract: async (input) => ({
      finishReason: "stop",
      rawOutput: JSON.stringify(
        Object.fromEntries(
          input.fields.map((f) => [
            f.id,
            {
              value: f.id === "version" ? "2.4" : input.sourceText.includes("GPL") ? "GPL" : "MIT",
              quote: input.sourceText,
            },
          ]),
        ),
      ),
      usage: { inputTokens: 1, outputTokens: 1 },
      observedCost: null,
      elapsedMs: 1,
      requestSha256: hash(JSON.stringify(input)),
    }),
    candidateJudge: async (input) => {
      calls.candidate.push(structuredClone(input));
      const answers = {};
      const adverse = [input.source, ...input.opposingContext].some((s) =>
        s.content.includes("GPL"),
      );
      input.candidates.forEach((c, i) => {
        answers[`q${i}s`] = { type: "noul", noul: 0.97 };
        answers[`q${i}c`] = {
          type: "noul",
          noul: c.fieldId === "license" && adverse ? 0.97 : 0.01,
        };
      });
      return {
        model: "offline-fixture",
        answers,
        usage: { inputTokens: 1, outputTokens: 1 },
        elapsedMs: 1,
        requestSha256: hash(JSON.stringify(input)),
      };
    },
  });
  assert(
    result.evidence.some((s) => s.content.includes("GPL")),
    "late adverse source really retained",
  );
  assert.equal(
    result.data.csv,
    "disputed",
    "earlier satisfied supported cannot survive final opposition",
  );
  assert(
    calls.judge.some((x) => x.documents.some((s) => s.content.includes("GPL"))),
    "earlier enum actually reassessed",
  );
  for (const input of calls.candidate.filter(
    (x) =>
      x.opposingContext.some((s) => s.content.includes("GPL")) &&
      x.candidates.some((c) => c.fieldId === "version"),
  ))
    assert.equal(input.depBindings.csv.value, "disputed");
  assert(!("license" in result.data));
});
test("shared maxJudgeAttempts caps enum plus candidate physical judgments together", async () => {
  const contract = {
    schemaVersion: 1,
    question: "Investigate Test.",
    requirements: {
      version: { question: "Version?", schema: { type: "string" } },
      csv: { question: "CSV?", schema: { enum: ["supported"] } },
    },
    limits: { maxJudgeAttempts: 1 },
  };
  let physical = 0;
  const result = await runLeanInvestigation(contract, {
    now: () => 0,
    search: async () => [{ url: "https://fixture.invalid/guide" }],
    read: async () => "Test 2.4 supports CSV export.",
    judge: async (input) => {
      physical++;
      return {
        documents: input.documents.map((d) => ({
          evidenceId: d.evidenceId,
          relevant: true,
          supportsClaim: true,
          refutesClaim: false,
        })),
      };
    },
    extract: async (input) => ({
      finishReason: "stop",
      rawOutput: '{"version":{"value":"2.4","quote":"Test 2.4 supports CSV export."}}',
      usage: null,
      observedCost: null,
      elapsedMs: 1,
      requestSha256: hash(JSON.stringify(input)),
    }),
    candidateJudge: async (input) => {
      physical++;
      return {
        model: "offline-fixture",
        answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        elapsedMs: 1,
        requestSha256: hash(JSON.stringify(input)),
      };
    },
  });
  assert.equal(result.usage.judgeCalls + result.usage.candidateJudgeCalls, physical);
  assert(physical <= 1, `one shared ceiling allowed ${physical} physical judgments`);
});
