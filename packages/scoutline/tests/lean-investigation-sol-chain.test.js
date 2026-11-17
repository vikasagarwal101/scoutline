import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

// Offline normalized proof fixture. No native judge protocol or network.
const IDS = ["parent", "child", "grandchild"];
const SOURCE = "https://fixture.invalid/shared-chain";
const CONTENT =
  "The guide supports all three ExampleApp 2.4.0 claims; limitations refute all three claims.";
const makeContract = (maxJudgeAttempts = 8) => ({
  schemaVersion: 1,
  question: "Classify three dependent ExampleApp 2.4.0 claims.",
  scope: { entity: "ExampleApp", release: "2.4.0" },
  requirements: Object.fromEntries(
    IDS.map((id, index) => [
      id,
      {
        question: `Is ${id} supported in ExampleApp 2.4.0?`,
        schema: { enum: ["supported", "refuted", "disputed"] },
        required: true,
        dependsOn: index === 0 ? [] : [IDS[index - 1]],
      },
    ]),
  ),
  limits: { maxSearchAttempts: 1, maxJudgeAttempts },
});

async function run({ maxJudgeAttempts = 8, noEvidence = false, blocked = false } = {}) {
  let clockChecks = 0;
  const calls = { search: 0, read: 0, judged: [] };
  const result = await runLeanInvestigation(makeContract(maxJudgeAttempts), {
    // A frozen clock prevents deadline escape from hiding nonprogress.
    now: () => {
      assert.ok(++clockChecks < 100, "unchanged-context exhaustion must terminate");
      return 0;
    },
    search: async () => {
      calls.search++;
      return noEvidence ? [] : [{ url: SOURCE }];
    },
    read: async (sourceUrl) => {
      calls.read++;
      assert.equal(sourceUrl, SOURCE);
      return CONTENT;
    },
    judge: async ({ fieldId, documents }) => {
      calls.judged.push(fieldId);
      assert.equal(documents.length, 1);
      assert.equal(documents[0].content, CONTENT);
      return {
        documents: documents.map((doc) => ({
          evidenceId: doc.evidenceId,
          relevant: !blocked,
          supportsClaim: !blocked,
          refutesClaim: !blocked,
        })),
      };
    },
  });
  assert.equal(calls.search, 1);
  assert.equal(result.usage.searches, calls.search);
  assert.equal(result.usage.readAttempts, calls.read);
  assert.equal(result.usage.judgeCalls, calls.judged.length);
  assert.ok(result.usage.judgeCalls <= maxJudgeAttempts);
  return { result, calls };
}

test("three-level dependency chain judges each newly eligible field on retained context", async () => {
  const { result, calls } = await run();
  assert.equal(calls.read, 1, "dependency progression needs no new acquisition");
  assert.equal(result.data.parent, "disputed");
  assert.equal(result.data.child, "disputed");
  assert.deepEqual(
    calls.judged,
    IDS,
    "same evidence key must not suppress a new field after prerequisite progress",
  );
  for (const id of IDS) {
    assert.equal(result.requirements[id].status, "satisfied");
    assert.equal(result.requirements[id].judgmentCount, 1);
    assert.equal(result.data[id], "disputed");
  }
  assert.equal(result.usage.judgeCalls, 3);
  assert.equal(result.status, "complete");
});

test("control: exhausted judge budget leaves remaining dependency unresolved", async () => {
  const { result, calls } = await run({ maxJudgeAttempts: 2 });
  assert.deepEqual(calls.judged, ["parent", "child"]);
  assert.equal(result.data.parent, "disputed");
  assert.equal(result.data.child, "disputed");
  assert.equal(result.requirements.grandchild.status, "unresolved");
  assert.equal(result.requirements.grandchild.judgmentCount, 0);
  assert.equal(Object.hasOwn(result.data, "grandchild"), false);
  assert.equal(result.status, "partial");
});

test("control: genuinely unresolved prerequisite keeps descendants unjudged", async () => {
  const { result, calls } = await run({ blocked: true });
  assert.deepEqual(calls.judged, ["parent"]);
  assert.equal(result.requirements.parent.status, "unresolved");
  assert.equal(result.requirements.child.reason, "prerequisite_unresolved:parent");
  assert.equal(result.requirements.grandchild.reason, "prerequisite_unresolved:child");
  for (const id of ["child", "grandchild"]) {
    assert.equal(result.requirements[id].judgmentCount, 0);
    assert.equal(Object.hasOwn(result.data, id), false);
  }
  assert.equal(result.status, "partial");
});

test("control: no evidence and acquisition exhaustion terminate without judging", async () => {
  const { result, calls } = await run({ noEvidence: true });
  assert.equal(calls.read, 0);
  assert.deepEqual(calls.judged, []);
  assert.equal(result.evidence.length, 0);
  for (const id of IDS) {
    assert.equal(result.requirements[id].status, "unresolved");
    assert.equal(result.requirements[id].judgmentCount, 0);
  }
  assert.equal(result.requirements.parent.reason, "exhausted");
  assert.deepEqual(result.data, {});
  assert.equal(result.status, "partial");
});
