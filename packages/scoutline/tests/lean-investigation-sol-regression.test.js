import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

// Independent offline normalized fixtures, not TypeSafe/Jev wire responses.
const SHARED = "Assess ExampleApp 2.4.0 CSV export.";
const QUESTION = "Does ExampleApp 2.4.0 support CSV export?";
const SUPPORT = "ExampleApp 2.4.0 supports CSV export.";
const REFUTE = "ExampleApp 2.4.0 does not support CSV export.";
const url = (name) => `https://fixture.invalid/${name}`;
const hits = (...names) => names.map((name) => ({ url: url(name) }));
const field = (question = QUESTION, extra = {}) => ({
  question,
  schema: { enum: ["supported", "refuted", "disputed"] },
  required: true,
  ...extra,
});
const contract = (requirements = { csv: field() }) => ({
  schemaVersion: 1,
  question: SHARED,
  scope: { entity: "ExampleApp", release: "2.4.0" },
  requirements,
  evidence: {
    criteria: [
      "Retain and assess contrary evidence; inconsistent assessments do not establish source disagreement.",
    ],
  },
});
const verdict = (doc, relevant, supportsClaim, refutesClaim) => ({
  evidenceId: doc.evidenceId,
  relevant,
  supportsClaim,
  refutesClaim,
});
const supportJudge = async ({ documents }) => ({
  documents: documents.map((doc) => verdict(doc, true, true, false)),
});
const run = (input, search, judge = supportJudge, read = async () => SUPPORT) =>
  runLeanInvestigation(input, { now: () => 0, search, judge, read });
function notAccepted(result, id = "csv") {
  assert.equal(
    result.requirements[id].status,
    "unresolved",
    `rejected historical verdict accepted as ${result.data[id]}`,
  );
  assert.equal(Object.hasOwn(result.data, id), false);
  assert.notEqual(result.status, "complete");
}

test("third context repeating a rejected old-source tuple cannot fabricate dispute", async () => {
  const inputs = [];
  const result = await run(
    contract(),
    async (query) => hits(query === SHARED ? "old" : query === QUESTION ? "new1" : "new2"),
    async (input) => {
      inputs.push(structuredClone(input));
      return {
        documents: input.documents.map((doc) => {
          const flipped = doc.evidenceId === "e1" && inputs.length > 1;
          return verdict(doc, true, !flipped, flipped);
        }),
      };
    },
  );
  assert.deepEqual(
    inputs.map((input) => input.documents.length),
    [1, 2, 3],
  );
  assert.deepEqual(inputs[0].documents[0], inputs[1].documents[0]);
  assert.deepEqual(inputs[1].documents[0], inputs[2].documents[0]);
  assert.ok(result.evidence.every((doc) => doc.content === SUPPORT));
  assert.ok(result.requirements.csv.inconsistentJudgments > 0);
  notAccepted(result);
});

test("real scalar conflict survives repeated rejected relevance after unrelated support", async () => {
  const inputs = [];
  const result = await run(
    contract({ csv: field(QUESTION, { schema: { enum: ["supported", "refuted"] } }) }),
    async (query) =>
      query === SHARED ? hits("support", "refute") : hits(query === QUESTION ? "new1" : "new2"),
    async (input) => {
      inputs.push(structuredClone(input));
      return {
        documents: input.documents.map((doc) => {
          const refuting = doc.url === url("refute");
          return verdict(doc, !(refuting && inputs.length > 1), !refuting, refuting);
        }),
      };
    },
    async (sourceUrl) => (sourceUrl === url("refute") ? REFUTE : SUPPORT),
  );
  assert.deepEqual(
    inputs.map((input) => input.documents.length),
    [2, 3, 4],
  );
  assert.deepEqual(inputs[0].documents[1], inputs[1].documents[1]);
  assert.deepEqual(inputs[1].documents[1], inputs[2].documents[1]);
  assert.equal(result.evidence[1].content, REFUTE);
  assert.ok(result.requirements.csv.inconsistentJudgments > 0);
  notAccepted(result);
});

for (const [name, extra] of [
  ["contradictory schema type", { schema: { type: "number", enum: ["supported"] } }],
  ["contradictory schema not", { schema: { enum: ["supported"], not: { const: "supported" } } }],
  ["unsupported per-field scope override", { scope: { release: "1.0" } }],
]) {
  test(`${name} is rejected before any acquisition`, async () => {
    const calls = { search: 0, read: 0, judge: 0 };
    let error;
    try {
      await runLeanInvestigation(contract({ csv: field(QUESTION, extra) }), {
        now: () => 0,
        search: async () => {
          calls.search++;
          return hits("guide");
        },
        read: async () => {
          calls.read++;
          return SUPPORT;
        },
        judge: async (input) => {
          calls.judge++;
          return supportJudge(input);
        },
      });
    } catch (caught) {
      error = caught;
    }
    assert.deepEqual(
      calls,
      { search: 0, read: 0, judge: 0 },
      "unsupported load-bearing caller constraints must not reach acquisition",
    );
    assert.ok(error, "unsupported caller constraint was silently compiled away");
    assert.equal(error.code, "VALIDATION_ERROR");
  });
}

test("dependant activated at last search assesses retained content without new acquisition", async () => {
  const judgedFields = [];
  const input = contract({
    parent: field("Is ExampleApp release 2.4.0 confirmed?"),
    child: field(QUESTION, { dependsOn: ["parent"] }),
  });
  // Fixture pin: the engine's default search ceiling is plan-aware (7)
  // now; this regression specifically tests LAST-SEARCH activation, so
  // the old boundary is passed explicitly (4th query activates the
  // dependant) rather than following the new default.
  input.limits = { maxSearchAttempts: 4 };
  const content = `Release 2.4.0 is confirmed. ${SUPPORT} ${REFUTE}`;
  const result = await run(
    input,
    async (query) => (query === SHARED ? hits("shared") : []),
    async ({ fieldId, documents }) => {
      judgedFields.push(fieldId);
      assert.equal(documents.length, 1);
      assert.equal(documents[0].content, content);
      return { documents: documents.map((doc) => verdict(doc, true, true, fieldId === "child")) };
    },
    async () => content,
  );
  assert.equal(result.usage.searches, 4);
  assert.equal(result.usage.readAttempts, 1);
  assert.equal(result.data.parent, "supported");
  assert.deepEqual(
    judgedFields,
    ["parent", "child"],
    "new eligibility must trigger judgment of available retained context before exhaustion",
  );
  assert.equal(result.usage.judgeCalls, 2);
  assert.equal(result.data.child, "disputed");
  assert.equal(result.status, "complete");
});

test("parsed JSON __proto__ field is rejected preflight or preserved as own output keys", async () => {
  const input = contract(JSON.parse(`{"__proto__":${JSON.stringify(field())}}`));
  assert.equal(Object.hasOwn(input.requirements, "__proto__"), true);
  const calls = { search: 0, read: 0, judge: 0 };
  let result;
  let error;
  try {
    result = await runLeanInvestigation(input, {
      now: () => 0,
      search: async () => {
        calls.search++;
        return hits("guide");
      },
      read: async () => {
        calls.read++;
        return SUPPORT;
      },
      judge: async (judgeInput) => {
        calls.judge++;
        return supportJudge(judgeInput);
      },
    });
  } catch (caught) {
    error = caught;
  }
  if (error) {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.deepEqual(calls, { search: 0, read: 0, judge: 0 });
    return;
  }
  const wire = JSON.parse(JSON.stringify(result));
  assert.equal(
    Object.hasOwn(wire.requirements, "__proto__"),
    true,
    "every accepted field must have a serialized own coverage row",
  );
  assert.equal(wire.requirements.__proto__.status, "satisfied");
  assert.equal(Object.hasOwn(wire.data, "__proto__"), true);
  assert.equal(wire.data.__proto__, "supported");
  assert.equal(wire.status, "complete");
});

test("control: stable old tuples plus genuinely new contrary content fulfill dispute", async () => {
  const inputs = [];
  const result = await run(
    contract(),
    async (query) =>
      hits(query === SHARED ? "support" : query === QUESTION ? "additional-support" : "refute"),
    async (input) => {
      inputs.push(structuredClone(input));
      return {
        documents: input.documents.map((doc) => {
          const refuting = doc.url === url("refute");
          return verdict(doc, true, !refuting, refuting);
        }),
      };
    },
    async (sourceUrl) => (sourceUrl === url("refute") ? REFUTE : SUPPORT),
  );
  assert.deepEqual(
    inputs.map((input) => input.documents.length),
    [1, 2, 3],
  );
  assert.deepEqual(inputs[0].documents[0], inputs[2].documents[0]);
  assert.equal(result.data.csv, "disputed");
  assert.equal(result.status, "complete");
  assert.equal(result.requirements.csv.inconsistentJudgments, 0);
  assert.deepEqual(
    result.requirements.csv.evidenceIds,
    result.evidence.map((doc) => doc.evidenceId),
  );
});

test("control: valid finite enum accepts support after successful contrary search", async () => {
  const queries = [];
  const result = await run(
    contract({ csv: field(QUESTION, { schema: { enum: ["supported"] } }) }),
    async (query) => {
      queries.push(query);
      return query === SHARED ? hits("guide") : [];
    },
  );
  assert.ok(queries.includes(`${QUESTION} contrary evidence refuted`));
  assert.equal(result.data.csv, "supported");
  assert.equal(result.requirements.csv.status, "satisfied");
  assert.equal(result.status, "complete");
});

test("control: unresolved prerequisite blocks dependant while independent field continues", async () => {
  const judgedFields = [];
  const input = contract({
    parent: field("Is ExampleApp release 2.4.0 confirmed?"),
    child: field(QUESTION, { dependsOn: ["parent"] }),
    independent: field("Is offline export disputed?"),
  });
  const result = await run(
    input,
    async (query) => (query === SHARED ? hits("shared") : []),
    async ({ fieldId, documents }) => {
      judgedFields.push(fieldId);
      return {
        documents: documents.map((doc) =>
          verdict(
            doc,
            fieldId === "independent",
            fieldId === "independent",
            fieldId === "independent",
          ),
        ),
      };
    },
    async () =>
      "Offline export is supported in the guide and refuted in limitations; release unconfirmed.",
  );
  assert.equal(result.requirements.parent.status, "unresolved");
  assert.equal(result.requirements.child.reason, "prerequisite_unresolved:parent");
  assert.equal(result.requirements.child.judgmentCount, 0);
  assert.equal(judgedFields.includes("child"), false);
  assert.equal(Object.hasOwn(result.data, "child"), false);
  assert.equal(result.data.independent, "disputed");
  assert.equal(result.status, "partial");
});
