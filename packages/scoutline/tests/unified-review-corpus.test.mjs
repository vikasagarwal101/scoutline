import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { labels } from "./unified-review-labels.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
for (const c of inputs)
  test(`independent corpus ${c.id}`, async () => {
    // Engine inputs exclude gold. Only the assertion side imports labels.
    const { deps, calls } = offlineDeps(c);
    const result = await runLeanInvestigation(structuredClone(c.contract), deps);
    const label = labels.find((x) => x.id === c.id);
    for (const [id, value] of Object.entries(label.fields)) {
      if (value === null) assert(!(id in result.data), `${c.id}.${id}: must abstain`);
      else assert.equal(result.data[id], value, `${c.id}.${id}: eligible exact value`);
      assert(result.requirements[id], `${id}: field outcome omitted`);
    }
    const expected = Object.values(label.fields).some((v) => v === null) ? "partial" : "complete";
    assert.equal(result.status, expected);
    const successfulReads = calls.read.filter(
      (url) => !c.sources.find((s) => s.url === url)?.readError,
    );
    assert.equal(
      new Set(successfulReads).size,
      successfulReads.length,
      "no duplicate successful source reads",
    );
    if (label.fields.license !== null) {
      const inputs = calls.candidateJudge.filter((x) =>
        x.candidates.some((c) => c.fieldId === "license"),
      );
      assert(inputs.length > 0, "license semantically assessed");
      assert(inputs.every((x) => x.depBindings?.version?.value === label.fields.version));
    }
  });
