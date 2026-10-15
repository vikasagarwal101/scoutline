import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCandidates,
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
