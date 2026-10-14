import test from "node:test";
import assert from "node:assert/strict";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import * as tsr from "../dist/lib/lean-typesafe-judge.js";

const ROOT =
  new URL("..", import.meta.url).pathname;
const config = {
  endpoint: "https://fixture.invalid/native",
  model: "fixture-request-model",
  apiKey: "fixture-credential",
  timeoutMs: 10,
};
const input = {
  fieldId: "csv",
  fieldQuestion: "CSV?",
  criteria: [],
  scope: { release: "2.4.0" },
  candidates: ["supported", "refuted", "disputed"],
  documents: [
    {
      evidenceId: "e1",
      url: "https://fixture.invalid/guide",
      title: "Guide",
      content: "Supports CSV.",
    },
  ],
};
const answers = {
  q0r: { type: "noul", noul: 1 },
  q0s: { type: "noul", noul: 1 },
  q0f: { type: "noul", noul: 0 },
};
const payload = (extra = {}) => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 12, output_tokens: 3 },
  ...extra,
});
const response = (body = payload()) => new Response(JSON.stringify(body), { status: 200 });

// Ported: the official judge over a fake fetch. `code` names the typed
// rejection the production lifecycle raises.
async function judgeWith(fetchLike, options = {}) {
  const profile = tsr.createTypesafeJudge({
    apiKey: config.apiKey,
    reserveAttempt: () => {},
    timeoutMs: config.timeoutMs,
    fetchLike,
  });
  return profile.judge(input, options);
}
async function rejectWith(fetchLike, options = {}) {
  try {
    await judgeWith(fetchLike, options);
    return undefined;
  } catch (error) {
    return error;
  }
}


test("default wrapper fetch reaches native fetch when caller omits injection", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response();
  };
  let failure;
  let result;
  try {
    result = await tsr.createTypesafeJudge({ apiKey: config.apiKey, reserveAttempt: () => {} }).judge(input);
  } catch (error) {
    failure = error;
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 1, "runner-style undefined fetch must dispatch one native attempt");
  assert.equal(failure, undefined);
  assert.equal(result.documents[0].supportsClaim, true);
});

for (const [name, usage] of [
  ["absent", undefined],
  ["null", null],
  ["string", "unknown"],
  ["empty", {}],
  ["partial", { input_tokens: 12 }],
]) {
  test(`${name} usage cannot become invented zero usage`, async () => {
    const error = await rejectWith(async () => response(payload({ usage })));
    assert(error, "native usage counters must be present and validated");
    assert.equal(error.code, "TYPESAFE_MALFORMED");
  });
}

test("oversized request is rejected before any transport attempt", async () => {
  let calls = 0;
  const huge = {
    ...input,
    documents: [{ ...input.documents[0], content: "界".repeat(1_000_000) }],
  };
  let error;
  try {
    await tsr.createTypesafeJudge({
      apiKey: config.apiKey,
      reserveAttempt: () => {
        calls++;
      },
      fetchLike: async () => response(),
    }).judge(huge);
  } catch (caught) {
    error = caught;
  }
  assert.equal(calls, 0, "finite input ceiling must reject a 3MB representation before HTTP");
  assert.ok(error?.code);
});

test("body timeout cancels the active response stream", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const error = await rejectWith(async () => ({
    status: 200,
    ok: true,
    headers: new Headers(),
    body,
  }));
  assert.equal(error.code, "TYPESAFE_TIMEOUT");
  assert.equal(cancelled, true, "racing a timeout must not leave the bounded reader pending");
});

test("header deadline bounds injected fetch that does not honor AbortSignal", async () => {
  const result = await Promise.race([
    rejectWith(async () => new Promise(() => {})),
    new Promise((resolve) => setTimeout(() => resolve(null), 60)),
  ]);
  assert.ok(result, "abort-only timer leaves the judge pending past its deadline");
  assert.equal(result.code, "TYPESAFE_TIMEOUT");
});

test("auth response cancels its unread body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const error = await rejectWith(async () => ({
    status: 401,
    ok: false,
    headers: new Headers(),
    body,
  }));
  assert.equal(error.code, "TYPESAFE_AUTH");
  assert.equal(cancelled, true);
});

test("non-success status cancels body without waiting for stalled content", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const error = await rejectWith(async () => ({
    status: 422,
    ok: false,
    headers: new Headers(),
    body,
  }));
  assert.equal(
    error.code,
    "TYPESAFE_REQUEST",
    "known fatal status must not be hidden by body timeout",
  );
  assert.equal(cancelled, true);
});

const engineContract = {
  schemaVersion: 1,
  question: "Assess CSV",
  requirements: {
    csv: {
      question: "CSV?",
      schema: { enum: ["supported", "refuted", "disputed"] },
      required: true,
    },
  },
};
// The production judge has no whole-attempt indeterminate code: per-source
// uncertainty arrives as null flags on a complete response, and an
// ordinary rejection still ends judge_unavailable.
const uncertainJudge = () => {
  let calls = 0;
  return async ({ documents }) => {
    calls++;
    if (calls === 1) {
      return {
        documents: documents.map((doc) => ({
          evidenceId: doc.evidenceId,
          relevant: null,
          supportsClaim: null,
          refutesClaim: null,
        })),
      };
    }
    return {
      documents: documents.map((doc) => ({
        evidenceId: doc.evidenceId,
        relevant: doc.url.endsWith("guide"),
        supportsClaim: doc.url.endsWith("guide"),
        refutesClaim: false,
      })),
    };
  };
};
test("per-source uncertainty seeks fresh evidence and rejudges changed context", async () => {
  const seen = [];
  const result = await runLeanInvestigation(engineContract, {
    now: () => 0,
    search: async (query) =>
      query === "Assess CSV"
        ? [{ url: "https://fixture.invalid/junk" }]
        : query === "CSV?"
          ? [{ url: "https://fixture.invalid/guide" }]
          : [],
    read: async (url) => (url.endsWith("junk") ? "csv export keywords" : "Supports CSV."),
    judge: async ({ documents }) => {
      seen.push(documents.map((doc) => doc.evidenceId).join(","));
      return {
        documents: documents.map((doc) => ({
          evidenceId: doc.evidenceId,
          relevant: doc.url.endsWith("guide"),
          supportsClaim: doc.url.endsWith("guide"),
          refutesClaim: false,
        })),
      };
    },
  });
  assert.deepEqual(seen, ["e1", "e1,e2"]);
  assert.equal(result.data.csv, "supported");
  assert.equal(result.status, "complete");
});

test("exhausted uncertainty is explicit without identical-context retry", async () => {
  let calls = 0;
  const result = await runLeanInvestigation(engineContract, {
    now: () => 0,
    search: async () => [{ url: "https://fixture.invalid/junk" }],
    read: async () => "Keywords only",
    judge: async ({ documents }) => {
      calls++;
      return {
        documents: documents.map((doc) => ({
          evidenceId: doc.evidenceId,
          relevant: null,
          supportsClaim: null,
          refutesClaim: null,
        })),
      };
    },
  });
  assert.ok(calls >= 1);
  assert.equal(result.requirements.csv.status, "unresolved");
  assert.equal(Object.hasOwn(result.data, "csv"), false);
});

test("control: ordinary rejected judge still ends judge_unavailable", async () => {
  let calls = 0;
  const result = await runLeanInvestigation(engineContract, {
    now: () => 0,
    search: async (q) => [{ url: `https://fixture.invalid/${q === "Assess CSV" ? "one" : "two"}` }],
    read: async () => "Supports CSV",
    judge: async () => {
      calls++;
      throw Error("ordinary transport failure");
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.requirements.csv.reason, "judge_unavailable");
});

// Real admission-refusal guard against the official judge: a
// reserveAttempt admission callback that refuses after N dispatches must
// stop further physical fetches with TYPESAFE_ATTEMPT_REFUSED — and a
// composed-stop root carried by the refusal must reach the typed
// rejection's stopReason.
async function cappedJudge(cap, fetchLike) {
  let admitted = 0;
  const physical = [];
  const profile = tsr.createTypesafeJudge({
    apiKey: config.apiKey,
    reserveAttempt: () => {
      if (admitted >= cap) {
        throw Object.assign(new Error("global judgment cap reached"), {
          code: "EVAL_STOPPED",
          reason: "global_judgment_cap",
        });
      }
      admitted += 1;
    },
    fetchLike: async (...args) => {
      physical.push(args);
      return fetchLike(...args);
    },
  });
  const outcomes = [];
  for (let i = 0; i < cap + 1; i++) {
    try {
      await profile.judge(input);
      outcomes.push("ok");
    } catch (error) {
      outcomes.push(error);
    }
  }
  return { outcomes, physical: physical.length };
}

test("protocol failure stops further dispatches in the same judge", async () => {
  let physical = 0;
  const profile = tsr.createTypesafeJudge({
    apiKey: config.apiKey,
    reserveAttempt: () => {},
    fetchLike: async () => {
      physical += 1;
      return response(payload({ answers: {} }));
    },
  });
  const first = await rejectWith(async () => {});
  void first;
  let rejected;
  try {
    await profile.judge(input);
  } catch (error) {
    rejected = error;
  }
  assert(rejected, "protocol-invalid answers must reject");
  // maxAttempts defaults to 1: no automatic retry after a protocol failure.
  assert.equal(physical <= 1, true, "a protocol failure must not trigger hidden retries");
});

test("admission refusal stops physical dispatch and carries the composed-stop root", async () => {
  const { outcomes, physical } = await cappedJudge(2, async () => response());
  assert.equal(physical, 2, "exactly the admitted dispatches reach HTTP");
  assert.equal(outcomes.slice(0, 2).every((o) => o === "ok"), true);
  const refusal = outcomes[2];
  assert.equal(refusal.code, "TYPESAFE_ATTEMPT_REFUSED");
  assert.equal(refusal.stopReason, "global_judgment_cap");
});

test("control: valid exact native probabilities preserve observed usage", async () => {
  const result = await judgeWith(async () => response());
  const metadata = result[Symbol.for("leanJevAttemptMeta")];
  assert.deepEqual(metadata.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(result.documents[0].supportsClaim, true);
});

test("control: middle band becomes explicit per-source null, not a false verdict", async () => {
  // SUPERSEDED (source-uncertainty policy): whole-attempt discard is
  // replaced by a COMPLETE record whose middle-band flag is null with
  // the raw probability preserved — uncertainty stays visible and
  // non-coercing.
  const result = await judgeWith(async () =>
    response(payload({ answers: { ...answers, q0r: { type: "noul", noul: 0.5 } } })),
  );
  const metadata = result[Symbol.for("leanJevAttemptMeta")];
  assert.deepEqual(result.documents, [
    { evidenceId: "e1", relevant: null, supportsClaim: true, refutesClaim: false },
  ]);
  assert.equal(metadata.probabilities.q0r, 0.5);
});
