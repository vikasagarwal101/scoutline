import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createTypesafeJudge } from "../dist/lib/lean-typesafe-judge.js";
// Official adapter over a fake fetch: an admission refusal carrying a
// composed-stop root must surface as the run's stop reason with ZERO
// physical judge dispatch — the same classification-composition
// invariant the development adapter carried.
for (const root of ["global_judgment_cap", "global_deadline"])
  test(`actual classification composition preserves ${root}`, async () => {
    let physical = 0;
    const profile = createTypesafeJudge({
      apiKey: "fake-only",
      reserveAttempt: () => {
        throw Object.assign(Error("refused before network"), { code: "EVAL_STOPPED", reason: root });
      },
      fetchLike: async () => {
        physical++;
        throw new Error("must not dispatch");
      },
    });
    const r = await runLeanInvestigation(
      {
        schemaVersion: 1,
        question: "CSV?",
        requirements: { csv: { question: "CSV?", schema: { enum: ["supported"] } } },
      },
      {
        now: () => 0,
        search: async () => [{ url: "https://fixture.invalid/doc" }],
        read: async () => "CSV works.",
        judge: profile.judge,
      },
    );
    assert.equal(physical, 0);
    assert.equal(r.requirements.csv.reason, root);
    assert.deepEqual(r.data, {});
  });
