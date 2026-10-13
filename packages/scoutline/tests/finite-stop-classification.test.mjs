import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createLeanJevJudge } from "../dev-dist/lean-jev-adapter.js";
const config = {
  endpoint: "https://fixture.invalid/no-network",
  model: "fixture",
  apiKey: "fake-only",
  timeoutMs: 20,
};
for (const root of ["global_judgment_cap", "global_deadline"])
  test(`actual classification composition preserves ${root}`, async () => {
    let physical = 0;
    const native = createLeanJevJudge(config, async () => {
      throw Object.assign(Error("refused before network"), { code: "EVAL_STOPPED", reason: root });
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
        judge: native,
      },
    );
    assert.equal(physical, 0);
    assert.equal(r.requirements.csv.reason, root);
    assert.deepEqual(r.data, {});
  });
