import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCandidates,
  buildCandidateJudgeRequest,
  assessCandidates,
  acceptCandidate,
} from "../dist/lib/lean-candidates.js";
const SOURCE = {
  evidenceId: "s1",
  url: "https://fixture.invalid/doc",
  title: "Doc",
  content: "Release 1.0: License MIT.",
  byteLength: 25,
  origins: [],
};
const RAW = {
  finishReason: "stop",
  rawOutput: JSON.stringify({ license: { value: "MIT", quote: "License MIT" } }),
};
const CONTEXT = {
  fieldMeanings: { license: "License of scoped release" },
  scope: { release: "1.0" },
  opposingContext: [],
};
async function fixture(context = CONTEXT) {
  const validated = validateCandidates(SOURCE, RAW, { license: { minLength: 1, maxLength: 64 } });
  const input = { source: SOURCE, ...context, candidates: validated.fields };
  const assessed = await assessCandidates(input, {
    judge: async () => ({
      model: "fixture",
      answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
      usage: { inputTokens: 1, outputTokens: 1 },
      requestSha256: "a".repeat(64),
      elapsedMs: 1,
    }),
  });
  return { validated, judgement: assessed.judgements[0] };
}
test("control: full assessed context accepts matching finite native decision", async () => {
  const { validated, judgement } = await fixture();
  assert.equal(
    acceptCandidate(validated.fields[0], judgement, SOURCE, validated.sourceDigest, CONTEXT).status,
    "accepted",
  );
});
for (const [name, changed] of [
  ["scope", { ...CONTEXT, scope: { release: "2.4.0" } }],
  ["meaning", { ...CONTEXT, fieldMeanings: { license: "License of another product" } }],
  [
    "opposing evidence",
    {
      ...CONTEXT,
      opposingContext: [
        { ...SOURCE, evidenceId: "s2", content: "Release 1.0 license is Apache-2.0, not MIT." },
      ],
    },
  ],
]) {
  test(`control: changing ${name} cannot reuse a prior candidate assessment`, async () => {
    const { validated, judgement } = await fixture();
    const reassessed = await fixture(changed);
    assert.notEqual(judgement.candidateId, reassessed.judgement.candidateId);
    assert.notEqual(
      acceptCandidate(validated.fields[0], judgement, SOURCE, validated.sourceDigest, changed)
        .status,
      "accepted",
    );
  });
}
test("in-flight caller scope mutation cannot relabel a dispatched judgment", async () => {
  // Review F2: the judge serializes a real release-1 request, then awaits a
  // deferred transport. An ordinary caller mutates the SAME nested scope
  // object while the verdict is pending. The judgment must stay bound to
  // the dispatch-time context: acceptance under release 2 refuses, the
  // preserved release-1 context still accepts.
  const validated = validateCandidates(SOURCE, RAW, { license: { minLength: 1, maxLength: 64 } });
  const input = {
    source: SOURCE,
    fieldMeanings: CONTEXT.fieldMeanings,
    scope: { release: "1" },
    opposingContext: [],
    candidates: validated.fields,
  };
  let release;
  let wireScope;
  const pending = assessCandidates(input, {
    judge: async (judgedInput) => {
      wireScope = JSON.parse(buildCandidateJudgeRequest(judgedInput, "fixture")).state.scope;
      await new Promise((resolve) => { release = resolve; });
      return {
        model: "fixture",
        answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        requestSha256: "a".repeat(64),
        elapsedMs: 1,
      };
    },
  });
  input.scope.release = "2"; // caller mutation while verdict pending
  release();
  const assessed = await pending;
  assert.deepEqual(wireScope, { release: "1" }, "wire request saw the dispatch-time scope");
  assert.equal(
    acceptCandidate(validated.fields[0], assessed.judgements[0], SOURCE, validated.sourceDigest, input).status,
    "unresolved",
    "a release-1 judgment must not authorize a release-2 context",
  );
  assert.equal(
    acceptCandidate(validated.fields[0], assessed.judgements[0], SOURCE, validated.sourceDigest, { ...CONTEXT, scope: { release: "1" } }).status,
    "accepted",
    "the same judgment still accepts under the preserved dispatch-time scope",
  );
});
test("delayed serialization still uses the dispatch-time scope", async () => {
  // Distinguishes a true detached snapshot from an early-ID fix that still
  // reads live caller data when the judge builds its request late.
  const validated = validateCandidates(SOURCE, RAW, { license: { minLength: 1, maxLength: 64 } });
  const input = {
    source: SOURCE,
    fieldMeanings: CONTEXT.fieldMeanings,
    scope: { release: "1" },
    opposingContext: [],
    candidates: validated.fields,
  };
  let startSerialization;
  const gate = new Promise((resolve) => { startSerialization = resolve; });
  let wireScope;
  const pending = assessCandidates(input, {
    judge: async (judgedInput) => {
      await gate;
      wireScope = JSON.parse(buildCandidateJudgeRequest(judgedInput, "fixture")).state.scope;
      return {
        model: "fixture",
        answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        requestSha256: "a".repeat(64),
        elapsedMs: 1,
      };
    },
  });
  input.scope.release = "2"; // mutate BEFORE the adapter serializes
  startSerialization();
  const assessed = await pending;
  assert.deepEqual(wireScope, { release: "1" }, "late serialization must not observe the mutation");
});
// R1 correction: fresh OWNED internally-consistent fixtures per case; the
// scope is IDENTICAL before and after each mutation (release "1" everywhere)
// so the ONLY difference between old-basis and changed-basis acceptance is
// the mutated component itself. Each case mutates the actual nested value
// during a deferred judge call, then asserts BOTH directions: the preserved
// (dispatch-time) basis still accepts, and the changed basis refuses with
// the exact judgement_context_mismatch reason.
function ownedFixture(overrides = {}) {
  const validated = validateCandidates(SOURCE, RAW, { license: { minLength: 1, maxLength: 64 } });
  const input = {
    source: { ...SOURCE },
    fieldMeanings: { license: "License of scoped release" },
    scope: { release: "1" },
    opposingContext: [{ ...SOURCE, evidenceId: "s9", content: "Release 1 license is MIT, confirmed." }],
    depBindings: { version: { value: "1", evidenceId: "s3", sourceDigest: "a".repeat(64) } },
    // Keep validation independent of caller mutations, including locator arrays.
    candidates: structuredClone(validated.fields),
    ...overrides,
  };
  // The old basis mirrors the fixture exactly as dispatched (deep copy).
  const oldBasis = structuredClone({
    fieldMeanings: input.fieldMeanings, scope: input.scope,
    opposingContext: input.opposingContext, depBindings: input.depBindings,
  });
  return { validated, input, oldBasis };
}
function deferredNative() {
  let release;
  const transport = new Promise((resolve) => { release = resolve; });
  return {
    release,
    judge: async () => {
      await transport;
      return {
        model: "fixture",
        answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        requestSha256: "a".repeat(64),
        elapsedMs: 1,
      };
    },
  };
}
for (const timing of ["completed", "pending"]) {
  for (const target of ["primary", "opposing"]) {
    test(`${timing} assessment binds the ${target} source URL on the real judge wire`, async () => {
      const source = structuredClone(SOURCE);
      const validated = validateCandidates(source, RAW, { license: { minLength: 1, maxLength: 64 } });
      assert.equal(validated.fields[0].status, "candidate");
      // Golden payload ID captured from exact published L1 before this fix.
      assert.equal(validated.fields[0].candidateId, "534b638d1465b6f8d39d395d66dc1fdbe271a0f4bfd9ba83d537f18d8a71bf28");
      const opposing = {
        ...structuredClone(source), evidenceId: "s2", url: "https://fixture.invalid/opposition",
        content: "Release 1.0 license is MIT, confirmed.",
      };
      opposing.byteLength = Buffer.byteLength(opposing.content);
      const input = {
        source, fieldMeanings: { license: "License of scoped release" }, scope: { release: "1.0" },
        opposingContext: [opposing], candidates: structuredClone(validated.fields),
        depBindings: { version: { value: "1.0", evidenceId: "s3", sourceDigest: "a".repeat(64) } },
      };
      const preserved = structuredClone(input);
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let wire;
      const pending = assessCandidates(input, {
        judge: async (judged) => {
          await gate; // Serialize AFTER a pending caller mutation, when applicable.
          wire = JSON.parse(buildCandidateJudgeRequest(judged, "fixture"));
          return {
            model: "fixture",
            answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
            usage: { inputTokens: 1, outputTokens: 1 },
            requestSha256: "a".repeat(64), elapsedMs: 1,
          };
        },
      });
      let assessed;
      if (timing === "completed") {
        release();
        assessed = await pending;
      }
      // Mutate the SAME caller-owned record, not an array replacement.
      if (target === "primary") input.source.url = "https://fixture.invalid/changed-primary";
      else input.opposingContext[0].url = "https://fixture.invalid/changed-opposition";
      if (timing === "pending") {
        release();
        assessed = await pending;
      }
      assert.deepEqual(wire, JSON.parse(buildCandidateJudgeRequest(preserved, "fixture")));
      assert.equal(wire.state.source.url, preserved.source.url);
      assert.equal(wire.state.opposingContext[0].url, preserved.opposingContext[0].url);
      const changedWire = JSON.parse(buildCandidateJudgeRequest(input, "fixture"));
      assert.notDeepEqual(changedWire, wire, "URL mutation really changes the judged wire context");
      const urlOnly = structuredClone(preserved);
      if (target === "primary") urlOnly.source.url = input.source.url;
      else urlOnly.opposingContext[0].url = input.opposingContext[0].url;
      assert.deepEqual(input, urlOnly, "scope/meaning/deps/content/id/value/quote/range are unchanged");
      const revalidated = validateCandidates(input.source, RAW, { license: { minLength: 1, maxLength: 64 } });
      assert.deepEqual(revalidated, validated, "URL changes preserve the validation/payload identity");
      assert.equal(
        acceptCandidate(validated.fields[0], assessed.judgements[0], preserved.source, validated.sourceDigest, preserved).status,
        "accepted", "the original dispatch-time basis still accepts",
      );
      const refused = acceptCandidate(validated.fields[0], assessed.judgements[0], input.source, validated.sourceDigest, input);
      assert.equal(refused.status, "unresolved", "a changed wire URL requires reassessment");
      assert.equal(refused.reason, "judgement_context_mismatch");
    });
  }
}
test("titles remain outside the judged wire context and its assessment identity", async () => {
  const { validated, input } = ownedFixture();
  const preserved = structuredClone(input);
  const native = deferredNative();
  const pending = assessCandidates(input, { judge: native.judge });
  native.release();
  const assessed = await pending;
  input.source.title = "Changed primary title";
  input.opposingContext[0].title = "Changed opposing title";
  assert.deepEqual(
    JSON.parse(buildCandidateJudgeRequest(input, "fixture")),
    JSON.parse(buildCandidateJudgeRequest(preserved, "fixture")),
    "neither title travels on the wire",
  );
  assert.equal(
    acceptCandidate(validated.fields[0], assessed.judgements[0], input.source, validated.sourceDigest, input).status,
    "accepted", "metadata absent from the judge wire does not invalidate its assessment",
  );
});
for (const [name, mutateInput, changedBasis] of [
  ["nested field meaning",
    (i) => { i.fieldMeanings.license = "License of OTHER release"; },
    (b) => ({ ...b, fieldMeanings: { ...b.fieldMeanings, license: "License of OTHER release" } })],
  ["opposing source content",
    (i) => { i.opposingContext[0].content = "Release 1 license is Apache-2.0, contrary."; },
    (b) => ({ ...b, opposingContext: b.opposingContext.map((o, k) => k === 0 ? { ...o, content: "Release 1 license is Apache-2.0, contrary." } : o) })],
  ["nested dependency digest",
    (i) => { i.depBindings.version.sourceDigest = "e".repeat(64); },
    (b) => ({ ...b, depBindings: { ...b.depBindings, version: { ...b.depBindings.version, sourceDigest: "e".repeat(64) } } })],
]) {
  test(`in-flight ${name} mutation cannot relabel the judgment`, async () => {
    const { validated, input, oldBasis } = ownedFixture();
    const deferred = deferredNative();
    const pending = assessCandidates(input, { judge: deferred.judge });
    mutateInput(input); // caller mutation while the verdict is pending
    deferred.release();
    const assessed = await pending;
    // Preserved dispatch-time basis still accepts.
    assert.equal(
      acceptCandidate(validated.fields[0], assessed.judgements[0], input.source, validated.sourceDigest, oldBasis).status,
      "accepted",
      `preserved basis must still accept after in-flight ${name} mutation`,
    );
    // The changed basis refuses with the exact mismatch reason.
    const refused = acceptCandidate(validated.fields[0], assessed.judgements[0], input.source, validated.sourceDigest, changedBasis(oldBasis));
    assert.equal(refused.status, "unresolved", `changed ${name} must require reassessment`);
    assert.equal(refused.reason, "judgement_context_mismatch", `changed ${name} refuses for the exact context mismatch`);
  });
}
for (const [name, mutateInput] of [
  ["source content", (i) => { i.source.content = "MUTATED SOURCE CONTENT"; }],
  ["candidate value", (i) => { i.candidates[0].value = "MUTATED"; }],
  ["candidate quote", (i) => { i.candidates[0].quote = "MUTATED QUOTE"; }],
  ["locator element", (i) => { i.candidates[0].charRange[0] = 0; }],
]) {
  test(`in-place ${name} mutation after dispatch keeps the real wire and identity`, async () => {
    // Delay REAL serialization until AFTER one in-place mutation per case.
    // Never replace the dispatched candidate array, row or locator: an alias
    // must observe the mutation. Separate cases prevent a source failure from
    // masking candidate/locator aliasing; other context stays unchanged.
    const { validated, input } = ownedFixture();
    input.opposingContext = []; // keep the wire fixture minimal
    const preserved = structuredClone(input);
    let serialized = null;
    let release;
    const pending = assessCandidates(input, {
      judge: async (judgedInput) => {
        await new Promise((resolve) => { release = resolve; });
        serialized = JSON.parse(buildCandidateJudgeRequest(judgedInput, "fixture"));
        return {
          model: "fixture",
          answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.01 } },
          usage: { inputTokens: 1, outputTokens: 1 },
          requestSha256: "a".repeat(64),
          elapsedMs: 1,
        };
      },
    });
    mutateInput(input); // SAME caller-owned objects, AFTER dispatch, BEFORE serialization
    release();
    const assessed = await pending;
    assert.ok(serialized, "real request serialized after mutation");
    assert.equal(serialized.state.source.text, SOURCE.content, "wire source is the dispatch-time content");
    assert.equal(serialized.state.fields[0].value, "MIT", "wire candidate value is dispatch-time");
    assert.equal(serialized.state.fields[0].quote, "License MIT", "wire candidate quote is dispatch-time");
    assert.deepEqual(serialized.state.fields[0].charRange, validated.fields[0].charRange, "wire locator range is dispatch-time");
    const control = deferredNative();
    const originalPending = assessCandidates(preserved, { judge: control.judge });
    control.release();
    const original = await originalPending;
    assert.equal(
      assessed.judgements[0].candidateId, original.judgements[0].candidateId,
      "returned identity equals a real assessment of the preserved dispatch-time input",
    );
    // Returned identity binds the dispatch-time candidate: acceptance under the
    // ORIGINAL candidate row accepts; the mutated row (different value) refuses.
    const basis = { fieldMeanings: input.fieldMeanings, scope: input.scope, opposingContext: [], depBindings: input.depBindings };
    assert.equal(
      acceptCandidate(validated.fields[0], assessed.judgements[0], SOURCE, validated.sourceDigest, basis).status,
      "accepted",
      "returned identity binds the dispatch-time candidate/source, accepted under preserved basis",
    );
    const mutatedRow = { ...validated.fields[0], value: "MUTATED", quote: "MUTATED QUOTE", charRange: [9, 9] };
    assert.notEqual(
      acceptCandidate(mutatedRow, assessed.judgements[0], SOURCE, validated.sourceDigest, basis).status,
      "accepted",
      "identity does not transfer to the mutated candidate row",
    );
  });
}
test("missing acceptance context cannot fall back to caller payload identity", async () => {
  const { validated, judgement } = await fixture();
  const detached = { ...judgement, candidateId: validated.fields[0].candidateId };
  assert.notEqual(
    acceptCandidate(validated.fields[0], detached, SOURCE, validated.sourceDigest).status,
    "accepted",
    "contextless payload fallback loses field meaning/scope/opposition authority",
  );
});
for (const [name, rawSupport, rawConflict] of [
  ["infinite", Infinity, -Infinity],
  ["numeric strings", "0.97", "0.01"],
  ["out of range", 2, -1],
]) {
  test(`${name} raw probabilities cannot authorize normalized flags`, async () => {
    const { validated, judgement } = await fixture();
    assert.notEqual(
      acceptCandidate(
        validated.fields[0],
        { ...judgement, rawSupport, rawConflict },
        SOURCE,
        validated.sourceDigest,
        CONTEXT,
      ).status,
      "accepted",
    );
  });
}
for (const key of ["toString", "constructor", "__proto__"]) {
  test(`own extra output property ${key} is unknown despite inherited schema member`, () => {
    const parsed = JSON.parse(RAW.rawOutput);
    Object.defineProperty(parsed, key, { value: "extra", enumerable: true });
    const result = validateCandidates(
      SOURCE,
      { ...RAW, rawOutput: JSON.stringify(parsed) },
      { license: {} },
    );
    assert.notEqual(result.fields[0].status, "candidate");
  });
}
for (const descriptor of [
  { minLength: NaN },
  { maxLength: Infinity },
  { minLength: -1 },
  { maxLength: -1 },
  { minLength: 1.5 },
  { minLength: 5, maxLength: 2 },
]) {
  test(`unsupported length descriptor ${String(Object.entries(descriptor))} rejects preflight`, () => {
    // null extraction cannot hide an invalid caller descriptor.
    let result;
    let error;
    try {
      result = validateCandidates(
        SOURCE,
        { ...RAW, rawOutput: '{"license":{"value":null,"quote":null}}' },
        { license: descriptor },
      );
    } catch (caught) {
      error = caught;
    }
    assert.ok(
      error?.code || result.fields[0].status === "invalid",
      "invalid descriptor silently bypassed when source abstains",
    );
  });
}
test("unsupported ambiguous alternation quantifier is rejected without timing probe", () => {
  const source = { ...SOURCE, content: "a" };
  let result;
  let error;
  try {
    result = validateCandidates(
      source,
      { finishReason: "stop", rawOutput: '{"license":{"value":"a","quote":"a"}}' },
      { license: { pattern: "(a|aa)+$" } },
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error?.code || result.fields[0].status === "invalid");
});

const cappedInvalid = (source, raw, descriptor = {}) => {
  let result;
  let error;
  try {
    result = validateCandidates(source, raw, { license: descriptor });
  } catch (caught) {
    error = caught;
  }
  assert.ok(
    error?.code || result.fields[0].status === "invalid",
    "independent proof ceiling silently bypassed",
  );
};
test("source UTF8 bytes above approved64KiB ceiling reject independently of schemas", () => {
  cappedInvalid({ ...SOURCE, content: "x".repeat(65_536) + " License MIT" }, RAW);
});
test("raw extraction JSON above approved64KiB ceiling rejects even if abstaining", () => {
  cappedInvalid(SOURCE, {
    finishReason: "stop",
    rawOutput: " ".repeat(65_536) + '{"license":{"value":null,"quote":null}}',
  });
});
test("value above4096UTF16 ceiling rejects even without maxLength descriptor", () => {
  const value = "x".repeat(4097);
  cappedInvalid(
    { ...SOURCE, content: value },
    { finishReason: "stop", rawOutput: JSON.stringify({ license: { value, quote: value } }) },
  );
});
test("quote above16KiBUTF8 ceiling rejects independently of source cap", () => {
  const quote = "界".repeat(5500) + " MIT";
  cappedInvalid(
    { ...SOURCE, content: quote },
    { finishReason: "stop", rawOutput: JSON.stringify({ license: { value: "MIT", quote } }) },
  );
});
test("caller descriptor cannot raise hard value ceiling", () => {
  cappedInvalid(SOURCE, RAW, { maxLength: 4097 });
});
test("control: modest source/raw/value/quote with lower valid descriptor remains candidate", () => {
  assert.equal(
    validateCandidates(SOURCE, RAW, { license: { minLength: 0, maxLength: 3 } }).fields[0].status,
    "candidate",
  );
});
