import test from "node:test";
import assert from "node:assert/strict";
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
  assert.throws(() => compileLeanContract(input({ enum: ["supported", "supported"] })));
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
