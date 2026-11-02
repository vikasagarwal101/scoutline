import test from "node:test";
import assert from "node:assert/strict";
import { createOpenRouterJudge } from "../dist/lib/lean-openrouter-judge.js";

const input = {
  fieldId: "f0", fieldQuestion: "Which version?", criteria: ["Explicit"], scope: { domain: "docs" }, candidates: [],
  documents: [{ evidenceId: "e0", url: "https://example.test/a", title: "A", content: "Evidence" }],
};

function response(model, answers, extra = {}) {
  const data = JSON.stringify({ model, answers, usage: { input_tokens: 10, output_tokens: 2 }, ...extra });
  return { status: 200, ok: true, headers: { get: () => null }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(data)); c.close(); } }) };
}

test("OpenRouter dispatches native classification without fallback", async () => {
  const calls = [];
  const profile = createOpenRouterJudge({ apiKey: "or-synthetic", reserveAttempt: () => {}, fetchLike: async (url, init) => {
    calls.push({ url, init });
    return response("typesafe/jev-1.14-20261014", { q0r: { type: "noul", noul: 0.95 }, q0s: { type: "noul", noul: 0.95 }, q0f: { type: "noul", noul: 0.05 } });
  } });
  const result = await profile.judge(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/systemone");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, "Bearer or-synthetic");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "typesafe/jev-1.14");
  assert.deepEqual(body.provider, { allow_fallbacks: false });
  assert.equal(body.state.sources[0].text, "Evidence");
  assert.deepEqual(result.documents, [{ evidenceId: "e0", relevant: true, supportsClaim: true, refutesClaim: false }]);
  assert.equal(profile.descriptor.expectedResolvedModel, "typesafe/jev-1.14-20261014");
});


test("successful envelopes containing errors are rejected without leaking upstream data", async () => {
  const events = [];
  let calls = 0;
  const profile = createOpenRouterJudge({ apiKey: "or-synthetic", reserveAttempt: () => {}, onAttempt: e => events.push(e), fetchLike: async () => {
    calls++;
    return response("typesafe/jev-1.14-20261014", { q0r: { type: "noul", noul: 0.95 }, q0s: { type: "noul", noul: 0.95 }, q0f: { type: "noul", noul: 0.05 } }, { error: { message: "private-upstream-message" } });
  } });
  await assert.rejects(() => profile.judge(input), error => {
    assert.equal(error.code, "TYPESAFE_PROTOCOL");
    assert.ok(!JSON.stringify(error).includes("private-upstream-message"));
    assert.deepEqual(error.observed.usage, { inputTokens: 10, outputTokens: 2 });
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(events[0].outcome, "TYPESAFE_PROTOCOL");
});


test("route-specific transient statuses are terminal even with retry options", async () => {
  for (const [status, code] of [[400, "TYPESAFE_REQUEST"], [408, "TYPESAFE_TIMEOUT"], [429, "TYPESAFE_RATE_LIMIT"], [502, "TYPESAFE_OVERLOADED"], [503, "TYPESAFE_OVERLOADED"]]) {
    let calls = 0;
    const judge = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => {}, maxAttempts: 4, retrySettings: { maxTransientRetries: 3 }, fetchLike: async () => {
      calls++;
      return { status, ok: false, headers: { get: () => "0" }, body: { cancel: async () => {} } };
    } });
    await assert.rejects(() => judge.judge(input), error => {
      assert.equal(error.code, code);
      assert.match(error.message, /OpenRouter/);
      assert.equal(error.observed.status, status);
      return true;
    });
    assert.equal(calls, 1);
  }
});


test("OpenRouter maps every documented error status to its exact static code", async () => {
  const expected = [
    [400, "TYPESAFE_REQUEST"], [401, "TYPESAFE_AUTH"], [402, "TYPESAFE_AUTH"], [403, "TYPESAFE_AUTH"],
    [404, "TYPESAFE_REQUEST"], [408, "TYPESAFE_TIMEOUT"], [413, "TYPESAFE_REQUEST"], [422, "TYPESAFE_REQUEST"],
    [429, "TYPESAFE_RATE_LIMIT"], [500, "TYPESAFE_PROTOCOL"], [502, "TYPESAFE_OVERLOADED"], [503, "TYPESAFE_OVERLOADED"],
    [524, "TYPESAFE_PROTOCOL"], [529, "TYPESAFE_OVERLOADED"],
  ];
  for (const [status, code] of expected) {
    let calls = 0;
    const judge = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => {}, fetchLike: async () => {
      calls++;
      return { status, ok: false, headers: { get: () => null }, body: { cancel: async () => {} } };
    } });
    await assert.rejects(() => judge.judge(input), error => {
      assert.equal(error.code, code);
      assert.equal(error.observed.status, status);
      assert.match(error.message, /OpenRouter/);
      return true;
    });
    assert.equal(calls, 1, `status ${status} must dispatch exactly once`);
  }
});

test("selected direct request carries no provider field", async () => {
  const { createSelectedNativeJudge } = await import("../dist/lib/lean-typesafe-judge.js");
  let wire;
  const profile = createSelectedNativeJudge("typesafe", { apiKey: "direct-key", reserveAttempt: () => {}, fetchLike: async (url, init) => {
    wire = { url, init };
    return response("jev-1.13.0", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } });
  } });
  await profile.judge(input);
  const body = JSON.parse(wire.init.body);
  assert.equal(Object.hasOwn(body, "provider"), false);
});

test("omitted model sends each route's shipped default and accepts its identity", async () => {
  const orWire = [];
  const or = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => {}, fetchLike: async (url, init) => {
    orWire.push(JSON.parse(init.body));
    return response("typesafe/jev-1.14-20261014", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } });
  } });
  await or.judge(input);
  assert.equal(orWire[0].model, "typesafe/jev-1.14");

  const { createSelectedNativeJudge } = await import("../dist/lib/lean-typesafe-judge.js");
  const directWire = [];
  const direct = createSelectedNativeJudge("typesafe", { apiKey: "key", reserveAttempt: () => {}, fetchLike: async (url, init) => {
    directWire.push(JSON.parse(init.body));
    return response("jev-1.13.0", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } });
  } });
  await direct.judge(input);
  assert.equal(directWire[0].model, "jev-1.13.0");
});

test("direct usage cost stays unobserved", async () => {
  const { createSelectedNativeJudge } = await import("../dist/lib/lean-typesafe-judge.js");
  const profile = createSelectedNativeJudge("typesafe", { apiKey: "key", reserveAttempt: () => {}, fetchLike: async () =>
    response("jev-1.13.0", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } }, { usage: { input_tokens: 10, output_tokens: 2, cost: 0.25 } }) });
  const result = await profile.judge(input);
  assert.equal(result[Symbol.for("leanJevAttemptMeta")].observedCost, null);
});

test("wrong resolved model with otherwise valid answers and usage is rejected", async () => {
  let calls = 0;
  const profile = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => {}, fetchLike: async () => {
    calls++;
    return response("typesafe/jev-1.13-20260917", { q0r: { type: "noul", noul: 0.95 }, q0s: { type: "noul", noul: 0.95 }, q0f: { type: "noul", noul: 0.05 } });
  } });
  await assert.rejects(() => profile.judge(input), error => {
    assert.equal(error.code, "TYPESAFE_MODEL");
    assert.equal(error.observed.resolvedModel, null);
    return true;
  });
  assert.equal(calls, 1);
});

test("candidate call uses the same fixed native route and opposing context", async () => {
  const calls = [];
  const profile = createOpenRouterJudge({ apiKey: "candidate-key", reserveAttempt: () => {}, fetchLike: async (url, init) => {
    calls.push({ url, init });
    return response("typesafe/jev-1.13-20260917", { q0s: { type: "noul", noul: 0.95 }, q0c: { type: "noul", noul: 0.02 } });
  } }, "typesafe/jev-1.13");
  const candidate = {
    source: { evidenceId: "e0", url: "https://example.test/a", content: "text", fetchedAt: "2026-10-04", digest: "d" },
    fieldMeanings: { f0: "the version" }, scope: { domain: "docs" },
    candidates: [{ fieldId: "f0", value: "1.13.0", quote: "jev-1.13.0", charRange: [0, 10] }],
    opposingContext: [], depBindings: {},
  };
  const result = await profile.candidateJudge(candidate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/systemone");
  assert.equal(calls[0].init.headers.authorization, "Bearer candidate-key");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "typesafe/jev-1.13");
  assert.deepEqual(body.provider, { allow_fallbacks: false });
  assert.equal(body.state.fields[0].value, "1.13.0");
  assert.equal(result.model, "typesafe/jev-1.13-20260917");
  assert.equal(result.answers.q0s.noul, 0.95);
});

test("model mismatch rejects with only trusted facts and does not retry", async () => {
  let calls = 0;
  const profile = createOpenRouterJudge({ apiKey: "secret", reserveAttempt: () => {}, fetchLike: async () => {
    calls++;
    return response("private-unknown-model", {});
  } });
  await assert.rejects(() => profile.judge(input), error => {
    assert.equal(error.code, "TYPESAFE_MODEL");
    assert.equal(error.observed.resolvedModel, null);
    assert.deepEqual(error.observed.usage, { inputTokens: 10, outputTokens: 2 });
    assert.ok(!JSON.stringify(error).includes("private-unknown-model"));
    return true;
  });
  assert.equal(calls, 1);
});

test("selected direct profile is independently pinned and single-attempt", async () => {
  const { createSelectedNativeJudge } = await import("../dist/lib/lean-typesafe-judge.js");
  let calls = 0;
  let wire;
  const profile = createSelectedNativeJudge("typesafe", { apiKey: "direct-key", reserveAttempt: () => {}, fetchLike: async (url, init) => {
    calls++;
    wire = { url, init };
    return response("jev-1.14.0", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } });
  } }, "jev-1.14.0");
  await profile.judge(input);
  assert.equal(calls, 1);
  assert.equal(wire.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(wire.init.headers.authorization, "Bearer direct-key");
  assert.equal(JSON.parse(wire.init.body).model, "jev-1.14.0");
  assert.equal(profile.descriptor.expectedResolvedModel, "jev-1.14.0");
});


test("classification captures evidence IDs before pending dispatch", async () => {
  let finish;
  let sent;
  const pending = new Promise(resolve => { finish = resolve; });
  const profile = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => {}, fetchLike: async (_url, init) => { sent = JSON.parse(init.body); return pending; } });
  const mutable = structuredClone(input);
  const result = profile.judge(mutable);
  mutable.documents[0].evidenceId = "mutated";
  mutable.documents[0].content = "changed";
  finish(response("typesafe/jev-1.14-20261014", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } }));
  assert.equal((await result).documents[0].evidenceId, "e0");
  assert.equal(sent.state.sources[0].text, "Evidence");
});

test("shared last-slot admission and post-admission abort never dispatch rejected work", async () => {
  let calls = 0;
  let slots = 1;
  const profile = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => { if (slots-- <= 0) throw Error("private budget"); }, fetchLike: async () => {
    calls++;
    return response("typesafe/jev-1.14-20261014", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } });
  } });
  await profile.judge(input);
  const candidate = { source: { evidenceId: "e0", url: "https://example.test/a", content: "text", fetchedAt: "2026-10-04", digest: "d" }, fieldMeanings: { f0: "version" }, scope: {}, candidates: [{ fieldId: "f0", value: "v", quote: "v", charRange: [0, 1] }], opposingContext: [], depBindings: {} };
  await assert.rejects(() => profile.candidateJudge(candidate), e => e.code === "TYPESAFE_ATTEMPT_REFUSED");
  assert.equal(calls, 1);
  const controller = new AbortController();
  const aborted = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => controller.abort(), fetchLike: async () => { calls++; throw Error("must not dispatch"); } });
  await assert.rejects(() => aborted.judge(input, { signal: controller.signal }), e => e.code === "TYPESAFE_CANCELLED" && e.attempts === 0);
  assert.equal(calls, 1);
});

test("noncooperative header timeout is one dispatch with uncertain remote work", async () => {
  let calls = 0;
  const profile = createOpenRouterJudge({ apiKey: "key", timeoutMs: 5, reserveAttempt: () => {}, fetchLike: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(() => profile.judge(input), e => e.code === "TYPESAFE_TIMEOUT" && e.remoteWorkUncertain === true && e.attempts === 1);
  assert.equal(calls, 1);
});


test("route errors name the selected destination and descriptor cannot be replaced", async () => {
  const profile = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => {}, fetchLike: async () => { throw Error("private transport"); } });
  assert.throws(() => { profile.descriptor = {}; }, TypeError);
  await assert.rejects(() => profile.judge(input), e => {
    assert.equal(e.code, "TYPESAFE_REMOTE_UNCERTAIN");
    assert.match(e.message, /OpenRouter/);
    assert.doesNotMatch(e.message, /private transport|TypeSafe/);
    return true;
  });
});

test("blank selected credential refuses before admission", () => {
  let admissions = 0;
  assert.throws(() => createOpenRouterJudge({ apiKey: "  ", reserveAttempt: () => admissions++ }));
  assert.equal(admissions, 0);
});


test("candidate context remains owned and policy differs by route", async () => {
  const { createSelectedNativeJudge } = await import("../dist/lib/lean-typesafe-judge.js");
  const calls = [];
  const events = [];
  const fetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const model = url.includes("openrouter") ? "typesafe/jev-1.14-20261014" : "jev-1.14.0";
    return response(model, { q0s: { type: "noul", noul: 0.95 }, q0c: { type: "noul", noul: 0.05 } });
  };
  const candidate = { source: { evidenceId: "e0", url: "https://example.test/a", content: "support", fetchedAt: "2026-10-04", digest: "d" }, fieldMeanings: { f0: "version" }, scope: {}, candidates: [{ fieldId: "f0", value: "v", quote: "v", charRange: [0, 1] }], opposingContext: [{ evidenceId: "e1", url: "https://example.test/b", content: "opposing" }], depBindings: {} };
  const or = createOpenRouterJudge({ apiKey: "or", fetchLike, onAttempt: e => events.push(e), reserveAttempt: () => {} });
  const direct = createSelectedNativeJudge("typesafe", { apiKey: "direct", fetchLike, onAttempt: e => events.push(e), reserveAttempt: () => {} }, "jev-1.14.0");
  await or.candidateJudge(candidate);
  await direct.candidateJudge(candidate);
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[0].body.state), /opposing/);
  assert.notEqual(events[0].policySha256, events[1].policySha256);
  assert.equal(events[0].contextSha256, events[1].contextSha256);
});


test("selected policy snapshots request dependencies before caller mutation", async () => {
  const calls = [];
  const deps = { apiKey: "original", reserveAttempt: () => {}, fetchLike: async (url, init) => {
    calls.push({ url, init });
    return response("typesafe/jev-1.14-20261014", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } });
  } };
  const profile = createOpenRouterJudge(deps);
  deps.apiKey = "mutated";
  await profile.judge(input);
  assert.equal(calls[0].init.headers.authorization, "Bearer original");
});


test("OpenRouter reports only finite nonnegative observed classification cost", async () => {
  for (const [cost, expected] of [[0.25, 0.25], [0, 0], [-1, null], ["1", null], [null, null]]) {
    const profile = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => {}, fetchLike: async () => response("typesafe/jev-1.14-20261014", { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 } }, { usage: { input_tokens: 10, output_tokens: 2, cost } }) });
    const result = await profile.judge(input);
    assert.equal(result[Symbol.for("leanJevAttemptMeta")].observedCost, expected);
  }
});

test("unknown and missing answer keys cannot authorize a judgment", async () => {
  for (const answers of [
    { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 } },
    { q0r: { type: "noul", noul: 1 }, q0s: { type: "noul", noul: 1 }, q0f: { type: "noul", noul: 0 }, extra: { type: "noul", noul: 1 } },
  ]) {
    const profile = createOpenRouterJudge({ apiKey: "key", reserveAttempt: () => {}, fetchLike: async () => response("typesafe/jev-1.14-20261014", answers) });
    await assert.rejects(() => profile.judge(input), e => e.code === "TYPESAFE_PROTOCOL");
  }
});
