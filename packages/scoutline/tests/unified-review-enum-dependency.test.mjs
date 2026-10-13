import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
const { buildLeanJevRequest } = await import(`${root}/dist/lib/lean-jev-adapter.js`);
test("dependent classification receives accepted dependency value and evidence revision", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "grove-transitive-chain"));
  const { deps, calls } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.data.license, "Apache-2.0");
  const judged = calls.judge.filter((x) => x.fieldId === "csv");
  assert(judged.length > 0);
  for (const input of judged) {
    assert.equal(input.depBindings?.license?.value, "Apache-2.0");
    assert.match(input.depBindings.license.sourceDigest, /^[a-f0-9]{64}$/);
  }
});
test("native classification wire encodes dependency context and revision", () => {
  const depBindings = {
    license: { value: "Apache-2.0", evidenceId: "e2", sourceDigest: "a".repeat(64) },
  };
  const input = {
    fieldId: "csv",
    fieldQuestion: "CSV under accepted license?",
    criteria: [],
    scope: {},
    candidates: ["supported"],
    documents: [
      {
        evidenceId: "e1",
        url: "https://fixture.invalid/guide",
        title: "guide",
        content: "CSV supports export.",
      },
    ],
    depBindings,
  };
  const before = buildLeanJevRequest(input, "offline-fixture");
  assert.deepEqual(JSON.parse(before).state.depBindings, depBindings);
  const after = buildLeanJevRequest(
    {
      ...input,
      depBindings: { license: { ...depBindings.license, sourceDigest: "b".repeat(64) } },
    },
    "offline-fixture",
  );
  assert.notEqual(before, after);
});
