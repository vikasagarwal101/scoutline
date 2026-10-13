import test from "node:test";
import assert from "node:assert/strict";
import { runLunaExtraction } from "../dist/lib/lean-candidate-transport.js";
const config = {
  endpoint: "https://fixture.invalid/no-network",
  model: "fixture",
  apiKey: "obviously-fake",
  timeoutMs: 10,
  maxRequestBytes: 65536,
  maxResponseBytes: 65536,
};
const req = {
  sourceId: "e",
  sourceText: "Release 2.4.",
  fields: [{ id: "version", description: "Version?" }],
};
test("only declared finite typed stop roots survive transport sanitization", async () => {
  const sentinel = "global_PRIVATE_FIXTURE_SECRET_NEVER_REPORT";
  const r = await runLunaExtraction(req, config, async () => {
    throw Object.assign(Error("fake"), { code: "UNRELATED_NETWORK", reason: sentinel });
  });
  assert(!JSON.stringify(r).includes(sentinel));
});
test("ordinary network error without typed stop remains network only", async () => {
  const r = await runLunaExtraction(req, config, async () => {
    throw Error("fake network");
  });
  assert.equal(r.code, "CAND_NETWORK");
  assert.equal(r.stopReason, undefined);
});
