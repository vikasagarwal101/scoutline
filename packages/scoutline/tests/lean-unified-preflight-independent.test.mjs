import test from "node:test";
import assert from "node:assert/strict";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation, compileLeanContract } = await import(
  `${root}/dist/lib/lean-investigation.js`
);
const input = (schema) => ({
  schemaVersion: 1,
  question: "Read a bounded string.",
  requirements: { value: { question: "Literal value?", schema } },
});
for (const schema of [
  { type: "string", minLength: 5, maxLength: 2 },
  { type: "string", maxLength: 4097 },
  { type: "string", pattern: "(a+)+" },
])
  test(`unsupported string descriptor is rejected before acquisition ${JSON.stringify(schema)}`, async () => {
    let physical = 0;
    const deps = {
      now: () => 0,
      search: async () => {
        physical++;
        return [{ url: "https://fixture.invalid/guide" }];
      },
      read: async () => {
        physical++;
        return "aaaa";
      },
      judge: null,
    };
    await assert.rejects(runLeanInvestigation(input(schema), deps));
    assert.equal(physical, 0);
  });
test("classification duplicate enum values remain fail-loud compiler error", () => {
  assert.throws(() => compileLeanContract(input({ enum: ["supported", "supported"] })));
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
