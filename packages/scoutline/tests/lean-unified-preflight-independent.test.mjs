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
