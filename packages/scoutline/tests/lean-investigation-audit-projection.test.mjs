import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createTypesafeJudge } from "../dist/lib/lean-typesafe-judge.js";

for (const malformed of [null, undefined]) {
  test(`${String(malformed)} normalized response remains inspectable without raw crash`, async () => {
    let result;
    let error;
    try {
      result = await runLeanInvestigation(
        {
          schemaVersion: 1,
          question: "Assess",
          requirements: {
            csv: { question: "CSV?", required: true, schema: { enum: ["supported"] } },
          },
        },
        {
          now: () => 0,
          search: async () => [{ url: "https://fixture.invalid/guide" }],
          read: async () => "Supports CSV",
          judge: async () => malformed,
        },
      );
    } catch (caught) {
      error = caught;
    }
    if (error) {
      assert.equal(
        typeof error.code,
        "string",
        "raw TypeError is not an inspectable malformed outcome",
      );
      return;
    }
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.evidence[0].content, "Supports CSV");
    assert.equal(result.usage.judgeCalls, 1);
    assert.equal(Object.hasOwn(result.data, "csv"), false);
    assert.ok(result.requirements.csv.attemptedRecords.some((record) => record.trusted === false));
  });
}

// Actual engine + official adapter over fixture native probabilities.
// The audit projection under test lives in the ENGINE result, so the
// development report runner is no longer part of this assertion.
async function reportFor(mode) {
  const profile = createTypesafeJudge({
    apiKey: "fixture-key",
    reserveAttempt: () => {},
    fetchLike: async (_url, init) => {
      const request = JSON.parse(init.body);
      const hasGuide = request.state.sources.some((doc) => doc.url.includes("guide"));
      const answers = Object.fromEntries(
        request.state.sources.flatMap((doc, i) =>
          ["r", "s", "f"].map((axis) => {
            let probability = 0.01;
            if (doc.url.includes("guide"))
              probability = axis === "f" && mode !== "both" ? 0.01 : 0.97;
            else if (doc.url.includes("keywords")) {
              if (mode === "persistent") probability = axis === "s" ? 0.01 : 0.25;
              else if (mode === "resolve" && !hasGuide)
                probability = axis === "f" ? 0.01 : 0.25;
            } else if (doc.url.includes("limitations"))
              probability = axis === "s" ? 0.01 : 0.97;
            return [`q${i}${axis}`, { type: "noul", noul: probability }];
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
  const SUPPORT = "ExampleApp 2.4.0 supports CSV export from the reports screen.";
  const contract = {
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
  };
  const result = await runLeanInvestigation(contract, {
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
        ? SUPPORT
        : url.includes("keywords")
          ? "csv export exampleapp 2.4.0 csv export exampleapp 2.4.0 csv export"
          : "Quarterly industry results announced today.",
    judge: profile.judge,
  });
  // Projected exactly as the removed report runner exposed it: current
  // state derives from the latest TRUSTED round, while every attempted
  // round stays inspectable in attemptedRecords.
  const row = result.requirements.csv;
  // Engine-derived readers (same as the answer-projection suite): the
  // assertions stay anchored on the ENGINE's own latest accepted round,
  // never on a locally rebuilt report object.
  return {
    clearContributions: clearContributions(row),
    pendingPossibleOpposite: pendingPossibleOpposite(row),
    attemptedRecords: row.attemptedRecords ?? [],
    result,
  };
}

// Engine-derived readers: assertions below read the engine's own
// assessments/attemptedRecords output; the two axis questions are
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

test("resolved old null remains audit history but is not current pending opposite", async () => {
  const r = await reportFor("resolve");
  assert.equal(r.result.data.csv, "supported");
  assert.equal(r.result.requirements.csv.assessments[0][0].relevant, null);
  const row = r;
  assert.ok(
    row.attemptedRecords.some((record) =>
      record.assessments.some((doc) => doc.evidenceId === "e1" && doc.relevant === null),
    ),
    "old unknown must not be deleted to clean projection",
  );
  assert.deepEqual(
    row.pendingPossibleOpposite,
    [],
    "historical unknowns and known nonrefutations cannot be current blockers",
  );
});

test("known refutation-false supporting source is not pending opposite", async () => {
  const r = await reportFor("resolve");
  assert.equal(r.result.data.csv, "supported");
  const row = r;
  assert.equal(
    row.pendingPossibleOpposite.some((doc) => doc.refutesClaim === false),
    false,
  );
  assert.deepEqual(row.clearContributions, [{ evidenceId: "e3", side: "support" }]);
});

test("one clear true-both source reports both contribution sides", async () => {
  const r = await reportFor("both");
  assert.equal(r.result.data.csv, "disputed");
  const row = r;
  assert.ok(
    row.clearContributions.some((doc) => doc.evidenceId === "e3" && doc.side === "support"),
  );
  assert.ok(
    row.clearContributions.some((doc) => doc.evidenceId === "e3" && doc.side === "refute"),
    "single-doc refutation side cannot disappear behind support ternary",
  );
});

test("control: persistent potential refutation remains pending with trusted history visible", async () => {
  const r = await reportFor("persistent");
  assert.equal(r.result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(r.result.data, "csv"), false);
  const row = r;
  assert.ok(
    row.pendingPossibleOpposite.some(
      (doc) => doc.evidenceId === "e1" && doc.relevant === null && doc.refutesClaim === null,
    ),
  );
  assert.ok(
    row.clearContributions.some((doc) => doc.evidenceId === "e3" && doc.side === "support"),
  );
  assert.equal(row.attemptedRecords.length, 2);
});
