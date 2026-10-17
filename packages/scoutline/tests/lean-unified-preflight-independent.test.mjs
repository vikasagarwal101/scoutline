import test from "node:test";
import assert from "node:assert/strict";
import { assertCandidateFieldSchema, validateCandidates } from "../dist/lib/lean-candidates.js";
const root =
  new URL("..", import.meta.url).pathname;
const { compileLeanContract } = await import(
  `${root}/dist/lib/lean-investigation.js`
);
const input = (schema) => ({
  schemaVersion: 1,
  question: "Read a bounded string.",
  requirements: { value: { question: "Literal value?", schema } },
});
test("classification duplicate enum values remain fail-loud compiler error", () => {
  assert.throws(
    () => compileLeanContract(input({ enum: ["supported", "supported"] })),
    (e) => e.code === "VALIDATION_ERROR" && /duplicate value "supported"/.test(e.message),
  );
});
test("minimum above the value ceiling rejects preflight even without a maximum", () => {
  const invalidMinimum = (e) => e.code === "VALIDATION_ERROR" && /minLength.*4096/.test(e.message);
  assert.throws(() => assertCandidateFieldSchema("value", { minLength: 4097 }), invalidMinimum);
  assert.throws(() => compileLeanContract(input({ type: "string", minLength: 4097 })), invalidMinimum);
  assert.doesNotThrow(() => assertCandidateFieldSchema("value", { minLength: 4096 }));
  assert.doesNotThrow(() => compileLeanContract(input({ type: "string", minLength: 4096 })));
  const value = "x".repeat(4096);
  const source = {
    evidenceId: "minimum-control", url: "https://fixture.invalid/minimum", title: "Fixture",
    content: value, byteLength: value.length, origins: [],
  };
  const validated = validateCandidates(source, {
    finishReason: "stop", rawOutput: JSON.stringify({ value: { value, quote: value } }),
  }, { value: { minLength: 4096 } });
  assert.equal(validated.fields[0].status, "candidate", "the existing ceiling is a valid minimum");
});
test("unknown own enumerable contract keys reject instead of dropping caller controls", () => {
  for (const [key, value] of [["limit", { deadlineMs: 1 }], ["require", {}], ["annotation", "BENIGN_EXTRA"]]) {
    assert.throws(
      () => compileLeanContract({ ...input({ type: "string" }), [key]: value }),
      (e) => e.code === "VALIDATION_ERROR" && /contract.*unsupported/.test(e.message) && e.message.includes(`(${key})`),
      `unsupported contract key ${key} must reject`,
    );
  }
});
test("unknown own enumerable requirement keys reject instead of dropping prerequisites or criteria", () => {
  for (const [key, value] of [
    ["depends_on", ["absent"]], ["criterion", ["Declared value"]],
    ["require", false], ["annotation", "BENIGN_EXTRA"],
  ]) {
    const contract = input({ type: "string" });
    contract.requirements.value[key] = value;
    assert.throws(
      () => compileLeanContract(contract),
      (e) => e.code === "VALIDATION_ERROR" && /requirements.value.*unsupported/.test(e.message) && e.message.includes(`(${key})`),
      `unsupported requirement key ${key} must reject`,
    );
  }
});
test("declared caller keys, open evidence extras and arbitrary maps retain their existing meaning", () => {
  const contract = {
    schemaVersion: 1, question: "Q", scope: { "arbitrary-scope-key": "public" },
    requirements: {
      "version-id": {
        question: "Version?", schema: { type: "string" }, criteria: ["Version criterion"],
        required: true, dependsOn: [],
      },
      "license-note": {
        question: "License?", schema: { type: "string", pattern: "^[A-Z]+$", minLength: 1, maxLength: 16 },
        criteria: ["License criterion"], required: false, dependsOn: ["version-id"],
      },
    },
    // Evidence-bag closure was withheld: these extras remain accepted and ignored.
    evidence: { criteria: ["Public evidence"], annotation: "BENIGN_EXTRA", criterion: ["Not consumed"] },
    limits: { readBatchSize: 1, maxUniqueReads: 1, maxSearchAttempts: 1, maxJudgeAttempts: 1, deadlineMs: 1 },
  };
  Object.defineProperty(contract, "hiddenAnnotation", { value: "BENIGN_EXTRA", enumerable: false });
  Object.defineProperty(contract.requirements["license-note"], "hiddenAnnotation", { value: "BENIGN_EXTRA", enumerable: false });
  const compiled = compileLeanContract(contract);
  assert.equal(compiled.question, contract.question);
  assert.deepEqual(compiled.scope, contract.scope);
  assert.deepEqual(compiled.fields.map((f) => f.id), ["version-id", "license-note"]);
  assert.equal(compiled.fields[0].required, true);
  assert.equal(compiled.fields[1].required, false);
  assert.deepEqual(compiled.fields.map((f) => f.criteria), [["Version criterion"], ["License criterion"]]);
  assert.deepEqual(compiled.fields[1].dependsOn, ["version-id"]);
  assert.deepEqual(compiled.fields[1].schema, { mode: "value", pattern: "^[A-Z]+$", minLength: 1, maxLength: 16 });
  assert.deepEqual(compiled.evidenceCriteria, ["Public evidence"]);
  for (const key of Object.keys(contract.limits)) assert.equal(compiled.limits[key], 1);
  const perFieldScope = structuredClone(contract);
  perFieldScope.requirements["license-note"].scope = { release: "other" };
  assert.throws(
    () => compileLeanContract(perFieldScope),
    (e) => e.code === "VALIDATION_ERROR" && e.message === "requirements.license-note.scope per-field overrides are not supported; declare scope at the contract level.",
  );
});
test("quantified-group patterns reject at compileLeanContract preflight", () => {
  for (const pattern of ["^(a{1,})+$", "^(a{1,3}){2,}$", "^(a?)+$"]) {
    assert.throws(
      () => compileLeanContract({ schemaVersion: 1, question: "Q", requirements: { v: { question: "V?", schema: { type: "string", pattern } } } }),
      (e) => e.code === "VALIDATION_ERROR",
      `braced/optional quantified group must reject at compile: ${pattern}`,
    );
  }
});
test("multiple pattern choice sites reject at compiler preflight, including safe combinations", () => {
  // Deliberate conservative compatibility policy: even disjoint choices are
  // excluded. Test preflight only; never execute these expensive near misses.
  for (const pattern of [
    "^" + "(a|aa)".repeat(40) + "b$",
    "^" + "a?".repeat(120) + "b$",
    "^a+b+$",
    "^a?b?$",
    "^(cat|dog)-(red|blue)$", // distinct group instances at the SAME depth
    "^(MIT|Apache)-[0-9]+$",
    "^(?:a|aa)(?:a|aa)b$",
    "^(?<first>a|aa)(?<second>a|aa)b$",
    "^(a|(b|c))$", // nested alternation instances also remain distinct
    "^a{1,2}a{1,}b$",
    "^a+?b??$", // lazy modifiers belong to their two quantifier sites
  ]) {
    assert.ok(pattern.length <= 256, "guard examples fit the existing source bound");
    assert.throws(
      () => compileLeanContract(input({ type: "string", pattern })),
      (e) => e.code === "VALIDATION_ERROR",
      `multiple choices must reject before acquisition: ${pattern}`,
    );
  }
});
test("a braced Unicode escape is an atom whose optional quantifier counts as a choice", () => {
  assert.throws(
    () => compileLeanContract(input({ type: "string", pattern: "^\\u{61}?a?b$" })),
    (e) => e.code === "VALIDATION_ERROR",
    "escape braces must not disguise the first atom's optional quantifier as a lazy suffix",
  );
});
test("single choice patterns retain escaped, class, group-prefix, lazy and fixed-count semantics", () => {
  for (const [pattern, value] of [
    ["^INV-[0-9]{4}-[0-9]{3}$", "INV-0042-001"],
    ["^[A-Za-z0-9.-]+$", "Apache-2.0"],
    ["^[()|?+*]+$", "()|?+*"],
    ["^[{x}]+$", "{x}"],
    ["^\\(a\\|b\\)\\?\\+\\*$", "(a|b)?+*"],
    ["^(MIT|Apache|BSD)$", "BSD"],
    ["^MIT|^Apache|^BSD$", "BSD"],
    ["^(?:MIT|Apache|BSD)$", "MIT"],
    ["^(?<license>MIT|Apache)$", "Apache"],
    ["^((MIT|Apache))$", "MIT"],
    ["^a+?b$", "aaab"],
    ["^a*?b$", "b"],
    ["^a??b$", "ab"],
    ["^a{1,3}?b$", "aab"],
    ["^a{1,}?b$", "aaab"],
    ["^a{1}?b{2,2}?$", "abb"],
    ["^\\u{61}?b{1}$", "ab"],
    ["^\\p{L}+?$", "Letters"],
  ]) {
    assert.doesNotThrow(() => compileLeanContract(input({ type: "string", pattern })), pattern);
    for (const [candidate, expected] of [[value, "candidate"], ["!", "invalid"]]) {
      const source = {
        evidenceId: "pattern-control", url: "https://fixture.invalid/pattern", title: "Pattern",
        content: candidate, byteLength: Buffer.byteLength(candidate), origins: [],
      };
      const result = validateCandidates(source, {
        finishReason: "stop", rawOutput: JSON.stringify({ value: { value: candidate, quote: candidate } }),
      }, { value: { pattern } });
      assert.equal(result.fields[0].status, expected, `${pattern}: ${candidate}`);
      if (expected === "invalid") assert.equal(result.fields[0].reason, "pattern_mismatch");
    }
  }
});
test("named references reject in compiler preflight on ordinary short syntax", () => {
  for (const pattern of [
    "^(?<letter>x)\\k<letter>$",
    "^\\k<letter>(?<letter>x)$", // forward references are excluded too
    "^(?<letter>x)\\\\\\k<letter>$", // literal backslash followed by an actual reference
  ]) {
    assert.throws(
      () => compileLeanContract(input({ type: "string", pattern })),
      (e) => e.code === "VALIDATION_ERROR" && /forbidden constructs/.test(e.message),
      `named references are outside the supported pattern subset: ${pattern}`,
    );
  }
});
test("literal reference markers and reference-free named captures remain admitted", () => {
  for (const pattern of [
    "^\\\\k<letter>$", // escaped backslash, then literal k<letter>
    "^\\\\\\\\k<letter>$", // two literal backslashes, no reference
    "^(?<letter>x)\\\\k<letter>$",
    "^[\\\\k<letter>]+$", // literal backslash and marker characters inside a class
    "^[\\\\]k<letter>$", // class closes before the ordinary marker text
    "^(?<letter>x)$",
    "^(?<letter>a|b)$",
    "^\\u005ck<letter>$", // a code-point escape is data, not reference syntax
  ]) {
    assert.doesNotThrow(() => compileLeanContract(input({ type: "string", pattern })), pattern);
  }
  assert.throws(
    () => compileLeanContract(input({ type: "string", pattern: "^(x)\\1$" })),
    (e) => e.code === "VALIDATION_ERROR" && /forbidden constructs/.test(e.message),
    "the existing numeric-reference ban remains",
  );
});
test("reserved scope keys are rejected, ordinary scope keys preserved", () => {
  const base = { schemaVersion: 1, question: "Q", requirements: { v: { question: "V?", schema: { type: "string" } } } };
  for (const key of ["__proto__", "constructor", "prototype"]) {
    // JSON.parse produces an own property; a plain literal would not for __proto__.
    const parsed = JSON.parse(`{"${key}":"Only release999"}`);
    assert.throws(
      () => compileLeanContract({ ...base, scope: parsed }),
      /reserved/,
      `${key} scope key must be rejected`,
    );
  }
  const compiled = compileLeanContract({ ...base, scope: { release: "2.4.0" } });
  assert.deepEqual(compiled.scope, { release: "2.4.0" }, "ordinary non-reserved scope preserved");
});
