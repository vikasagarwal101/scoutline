import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createTypesafeJudge } from "../dist/lib/lean-typesafe-judge.js";
// Actual engine + official adapter over fixture native probabilities.
async function evaluate(mode) {
  const profile = createTypesafeJudge({
    apiKey: "fixture-key",
    reserveAttempt: () => {},
    fetchLike: async (_url, init) => {
      const request = JSON.parse(init.body);
      const probabilities = request.state.sources.map((doc) => {
        if (doc.url.includes("guide"))
          return mode === "refuted"
            ? [0.97, 0.01, 0.97]
            : mode === "disputed"
              ? [0.97, 0.97, 0.97]
              : [0.97, 0.97, 0.01];
        if (doc.url.includes("keywords"))
          return mode === "refuted"
            ? [0.25, 0.01, 0.25]
            : mode === "blocked" || mode === "disputed"
              ? [0.25, 0.25, 0.25]
              : [0.25, 0.25, 0.01];
        return [0.01, 0.01, 0.01];
      });
      const answers = Object.fromEntries(
        probabilities.flatMap((p, i) =>
          ["r", "s", "f"].map((axis, j) => [`q${i}${axis}`, { type: "noul", noul: p[j] }]),
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
  return { result };
}

// Engine-derived readers: the deleted dev report recomputed these from
// the engine's own assessments; the assertions below therefore stay
// anchored on the ENGINE result rows, with the two axis questions
// derived from the engine's latest accepted round only.
const latestRound = (row) => (row.assessments ?? []).at(-1) ?? [];
const clearContributions = (row) =>
  latestRound(row).flatMap((d) => {
    if (d.relevant !== true) return [];
    const sides = [];
    if (d.supportsClaim === true) sides.push({ evidenceId: d.evidenceId, side: "support" });
    if (d.refutesClaim === true) sides.push({ evidenceId: d.evidenceId, side: "refute" });
    return sides;
  });
const pendingPossibleOpposite = (row) => {
  const latest = latestRound(row);
  const hasClearSupport = latest.some((d) => d.relevant === true && d.supportsClaim === true);
  const hasClearRefute = latest.some((d) => d.relevant === true && d.refutesClaim === true);
  const answer =
    row.value === "supported" || row.value === "refuted" || row.value === "disputed"
      ? row.value
      : hasClearSupport && hasClearRefute
        ? "disputed"
        : hasClearSupport
          ? "supported"
          : hasClearRefute
            ? "refuted"
            : "none";
  return latest.flatMap((d) => {
    if (d.relevant === false) return [];
    if (answer === "disputed" || answer === "none") return [];
    const refuteBlocks = answer !== "supported" ? false : d.refutesClaim !== false;
    const supportBlocks = answer !== "refuted" ? false : d.supportsClaim !== false;
    if (!refuteBlocks && !supportBlocks) return [];
    return [{ evidenceId: d.evidenceId, relevant: d.relevant, supportsClaim: d.supportsClaim, refutesClaim: d.refutesClaim }];
  });
};

test("accepted support ignores unknown support when opposite refutation is false", async () => {
  const { result } = await evaluate("supported");
  assert.equal(result.data.csv, "supported");
  assert.deepEqual(
    pendingPossibleOpposite(result.requirements.csv),
    [],
    "own-axis uncertainty is not pending opposition to accepted support",
  );
  assert.ok(
    result.requirements.csv.attemptedRecords.some((record) =>
      record.assessments.some(
        (d) => d.evidenceId === "e1" && d.supportsClaim === null && d.refutesClaim === false,
      ),
    ),
  );
});
test("accepted refutation ignores unknown refutation when opposite support is false", async () => {
  const { result } = await evaluate("refuted");
  assert.equal(result.data.csv, "refuted");
  assert.deepEqual(
    pendingPossibleOpposite(result.requirements.csv),
    [],
    "own-axis uncertainty is not pending opposition to accepted refutation",
  );
  assert.ok(
    result.requirements.csv.attemptedRecords.some((record) =>
      record.assessments.some(
        (d) => d.evidenceId === "e1" && d.refutesClaim === null && d.supportsClaim === false,
      ),
    ),
  );
});
test("clear established dispute has both sides and no pending acceptance blocker", async () => {
  const { result } = await evaluate("disputed");
  assert.equal(result.data.csv, "disputed");
  const row = result.requirements.csv;
  assert.ok(clearContributions(row).some((d) => d.evidenceId === "e3" && d.side === "support"));
  assert.ok(clearContributions(row).some((d) => d.evidenceId === "e3" && d.side === "refute"));
  assert.deepEqual(
    pendingPossibleOpposite(row),
    [],
    "source uncertainty cannot be labeled an acceptance blocker for fulfilled scoped disagreement",
  );
  assert.ok(
    row.attemptedRecords.some((record) =>
      record.assessments.some((d) => d.evidenceId === "e1" && d.relevant === null),
    ),
    "unknown coverage remains visible in audit",
  );
});
test("control: genuinely unknown refutation remains pending against clear support", async () => {
  const { result } = await evaluate("blocked");
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
  assert.ok(
    pendingPossibleOpposite(result.requirements.csv).some(
      (d) => d.evidenceId === "e1" && d.refutesClaim === null,
    ),
  );
  assert.ok(
    clearContributions(result.requirements.csv).some(
      (d) => d.evidenceId === "e3" && d.side === "support",
    ),
  );
});
