import test from "node:test";
import assert from "node:assert/strict";
import { createTypesafeJudge } from "../dist/lib/lean-typesafe-judge.js";
import { COMPOSED_STOP_ROOTS } from "../dist/lib/lean-composed-stop.js";
// Ported from the development candidate transport: the same
// sanitization invariant now stated at the production judge boundary —
// only composed-stop roots survive error normalization; nothing else
// from a thrown dependency crosses the typed rejection envelope.
const INPUT = {
  fieldId: "f0",
  fieldQuestion: "Version?",
  criteria: [],
  scope: {},
  candidates: [],
  documents: [
    { evidenceId: "e0", url: "https://fixture.invalid/a", title: "A", content: "Release 2.4." },
  ],
};
test("only declared finite typed stop roots survive judge sanitization", async () => {
  const sentinel = "global_PRIVATE_FIXTURE_SECRET_NEVER_REPORT";
  let fetchCalls = 0;
  const profile = createTypesafeJudge({
    apiKey: "synthetic-key",
    reserveAttempt: () => {},
    fetchLike: async () => {
      fetchCalls += 1;
      throw Object.assign(Error("fake"), { code: "UNRELATED_NETWORK", reason: sentinel });
    },
  });
  let rejection;
  try {
    await profile.judge(INPUT);
  } catch (error) {
    rejection = error;
  }
  assert(rejection);
  assert.equal(fetchCalls, 1);
  assert.equal(rejection.code, "TYPESAFE_REMOTE_UNCERTAIN");
  assert.equal(rejection.stopReason, undefined);
  assert(!JSON.stringify(rejection).includes(sentinel));
  assert(![...COMPOSED_STOP_ROOTS].includes("unrelated_root"));
});
test("ordinary network error without typed stop remains transport failure only", async () => {
  const profile = createTypesafeJudge({
    apiKey: "synthetic-key",
    reserveAttempt: () => {},
    fetchLike: async () => {
      throw Error("fake network");
    },
  });
  let rejection;
  try {
    await profile.judge(INPUT);
  } catch (error) {
    rejection = error;
  }
  assert.equal(rejection.code, "TYPESAFE_REMOTE_UNCERTAIN");
  assert.equal(rejection.stopReason, undefined);
});
