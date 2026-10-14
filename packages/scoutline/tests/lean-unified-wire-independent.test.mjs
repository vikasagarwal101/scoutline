import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const root =
  new URL("..", import.meta.url).pathname;
import { buildCandidateJudgeRequest } from "../dist/lib/lean-candidates.js";
const digest = createHash("sha256").update("accepted version evidence").digest("hex");
const depBindings = {
  version: { value: "2.4", evidenceId: "version-evidence", sourceDigest: digest },
};
const source = {
  evidenceId: "license-evidence",
  url: "https://fixture.invalid/license",
  title: "license",
  content: "License for release 2.4: MIT.",
  byteLength: 28,
  origins: [],
};
const candidate = {
  fieldId: "license",
  value: "MIT",
  quote: source.content,
  charRange: [0, source.content.length],
};
const judgeInput = {
  source,
  fieldMeanings: { license: "License of the accepted version; ignore other releases." },
  scope: { entity: "Test" },
  candidates: [candidate],
  opposingContext: [],
  depBindings,
};
test("native candidate judgment state includes accepted dependency value and exact revision", () => {
  const request = JSON.parse(buildCandidateJudgeRequest(judgeInput, "offline-fixture"));
  assert.deepEqual(request.state.depBindings, depBindings);
});
test("native judgment request identity changes with dependency revision alone", () => {
  const before = buildCandidateJudgeRequest(judgeInput, "offline-fixture");
  const after = buildCandidateJudgeRequest(
    {
      ...judgeInput,
      depBindings: { version: { ...depBindings.version, sourceDigest: "b".repeat(64) } },
    },
    "offline-fixture",
  );
  assert.notEqual(before, after);
});
test("official candidate judgment state includes explicit dependency binding", () => {
  const request = JSON.parse(buildCandidateJudgeRequest(judgeInput, "offline-fixture"));
  assert.deepEqual(request.state.depBindings, depBindings);
});
