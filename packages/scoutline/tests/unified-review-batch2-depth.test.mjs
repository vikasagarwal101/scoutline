import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { runLeanInvestigation } = await import(`${root}/dist/lib/lean-investigation.js`);
const { createTypesafeJudge } = await import(`${root}/dist/lib/lean-typesafe-judge.js`);
// Ported: official direct-TypeSafe judge over a fake fetch — the same
// late-body disposal and remaining-run-time consumption invariant the
// development adapter carried.
test("actual native classification wrapper consumes remaining run timeout and disposes delayed body", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { csv: c.contract.requirements.csv };
  c.contract.limits = { deadlineMs: 10 };
  const { deps } = offlineDeps(c);
  deps.now = Date.now;
  let cancelled = false;
  const profile = createTypesafeJudge({
    apiKey: "obviously-fake",
    reserveAttempt: () => {},
    fetchLike: async (_url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const req = JSON.parse(init.body);
      const answers = Object.fromEntries(
        Object.keys(req.questions).map((k) => [
          k,
          { type: "noul", noul: k.endsWith("f") ? 0.01 : 0.97 },
        ]),
      );
      return {
        status: 200,
        ok: true,
        headers: { get: () => "application/json" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  model: "fixture",
                  answers,
                  usage: { input_tokens: 1, output_tokens: 1 },
                }),
              ),
            );
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      };
    },
  });
  deps.judge = profile.judge;
  const started = performance.now();
  await runLeanInvestigation(c.contract, deps);
  const elapsed = performance.now() - started;
  assert(
    elapsed < 60,
    `actual native wrapper ignored remaining 10ms run bound; elapsed ${elapsed.toFixed(1)}ms`,
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert(cancelled, "late unread body was not disposed");
});
test("provisional prerequisite failing mandatory challenge cannot authorize final dependent data", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = {
    version: c.contract.requirements.version,
    csv: { ...c.contract.requirements.csv, dependsOn: ["version"] },
  };
  const { deps, calls } = offlineDeps(c);
  deps.search = async (query) => {
    if (query.includes("release identifier") && query.includes("contrary"))
      throw new Error("required prerequisite challenge unavailable");
    if (query.includes("contrary")) return [];
    return [{ url: c.sources[0].url, title: c.sources[0].title }];
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.requirements.version.status, "unresolved");
  assert(!("version" in result.data));
  assert(
    !("csv" in result.data),
    "dependent value published from unfulfilled provisional prerequisite",
  );
  assert.equal(result.requirements.csv.status, "unresolved");
});
test("failed extraction audit does not persist raw error message or unvalidated secret-bearing observation keys", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  const { deps } = offlineDeps(c);
  const marker = "PRIVATE_FIXTURE_MARKER_NEVER_PERSIST";
  deps.extract = async () => {
    throw Object.assign(new Error(`Authorization: Bearer ${marker}`), {
      code: "CAND_NETWORK",
      observed: {
        requestSha256: "a".repeat(64),
        usage: { inputTokens: 1, outputTokens: 1 },
        apiKey: marker,
        headers: { Authorization: marker },
      },
    });
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(
    !JSON.stringify(result).includes(marker),
    "raw secret-bearing dependency error crossed sanitized result boundary",
  );
  assert(result.requirements.version.attemptedRecords.some((x) => x.trusted === false));
});
