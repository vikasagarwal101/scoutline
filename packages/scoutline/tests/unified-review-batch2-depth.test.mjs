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
test("actual native classification wrapper consumes remaining run timeout and disposes delayed body", async (t) => {
  const { getEventListeners } = await import("node:events");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const mockSetTimeout = globalThis.setTimeout;
  const mockClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  globalThis.setTimeout = (callback, ms, ...args) => {
    let timer;
    timer = mockSetTimeout(() => {
      timers.delete(timer);
      callback(...args);
    }, ms);
    timers.set(timer, ms);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    timers.delete(timer);
    return mockClearTimeout(timer);
  };
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { csv: c.contract.requirements.csv };
  c.contract.limits = { deadlineMs: 10 };
  const { deps } = offlineDeps(c);
  deps.now = Date.now;
  let nativeCalls = 0;
  let profileCalls = 0;
  let reservations = 0;
  let bodiesCreated = 0;
  let cancelRequests = 0;
  let underlyingCancels = 0;
  let fulfilledCancels = 0;
  let runSignal;
  let nativeSignal;
  let lateBody;
  let pendingHeaders;
  let rejectHeaders;
  let producerTimer;
  let entered;
  const nativeStarted = new Promise((resolve) => { entered = resolve; });
  const attemptEvents = [];
  const profileErrors = [];
  const profile = createTypesafeJudge({
    apiKey: "obviously-fake",
    reserveAttempt: () => { reservations++; },
    onAttempt: (event) => attemptEvents.push(event),
    fetchLike: (_url, init) => {
      nativeCalls++;
      nativeSignal = init.signal;
      pendingHeaders = new Promise((resolve, reject) => {
        rejectHeaders = reject;
        producerTimer = setTimeout(() => {
          const req = JSON.parse(init.body);
          const answers = Object.fromEntries(
            Object.keys(req.questions).map((k) => [
              k,
              { type: "noul", noul: k.endsWith("f") ? 0.01 : 0.97 },
            ]),
          );
          bodiesCreated++;
          lateBody = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({
                model: "fixture",
                answers,
                usage: { input_tokens: 1, output_tokens: 1 },
              })));
              controller.close();
            },
            cancel() { underlyingCancels++; },
          });
          const cancel = lateBody.cancel.bind(lateBody);
          lateBody.cancel = (reason) => {
            cancelRequests++;
            return cancel(reason).then((value) => {
              fulfilledCancels++;
              return value;
            });
          };
          resolve({
            status: 200,
            ok: true,
            headers: { get: () => "application/json" },
            body: lateBody,
          });
        }, 100);
      });
      entered();
      return pendingHeaders;
    },
  });
  deps.judge = async (input, dispatch) => {
    profileCalls++;
    runSignal = dispatch.signal;
    assert.equal(dispatch.timeoutMs, 10);
    try {
      return await profile.judge(input, dispatch);
    } catch (error) {
      profileErrors.push(error);
      throw error;
    }
  };
  let pendingRun;
  try {
    pendingRun = runLeanInvestigation(c.contract, deps);
    // Establish actual owned native work before consuming its allowance.
    await nativeStarted;
    assert.equal(Date.now(), 1000);
    assert.equal(profileCalls, 1);
    assert.equal(reservations, 1);
    assert.equal(nativeCalls, 1);
    assert.equal(nativeSignal.aborted, false);
    assert.equal(bodiesCreated, 0);
    t.mock.timers.tick(10);
    const result = await pendingRun;
    assert.equal(Date.now(), 1010, "the original 10ms deadline settles logical work");
    assert.equal(result.status, "partial");
    assert.deepEqual(result.data, {}, "expired native work cannot publish an answer");
    assert.equal(result.requirements.csv.status, "unresolved");
    assert.equal(result.requirements.csv.reason, "judge_unavailable");
    assert.equal(result.usage.judgeCalls, 1);
    assert.equal(profileErrors.length, 1);
    assert.equal(profileErrors[0].code, "TYPESAFE_CANCELLED");
    assert.equal(profileErrors[0].attempts, 1);
    assert.equal(profileErrors[0].remoteWorkUncertain, true);
    assert.equal(attemptEvents.length, 1);
    assert.equal(attemptEvents[0].outcome, "TYPESAFE_CANCELLED");
    assert.equal(attemptEvents[0].remoteWorkUncertain, true);
    assert.equal(nativeSignal.aborted, true);
    assert.equal(bodiesCreated, 0, "the late body must not hold logical settlement");
    assert.equal(cancelRequests, 0, "no body exists to cancel before late headers");
    assert.deepEqual([...timers.values()], [100], "only the uncooperative fake producer remains");
    // Settle the SAME 100ms producer; do not replace the cancellation obligation.
    t.mock.timers.tick(90);
    await pendingHeaders;
    await new Promise(setImmediate);
    assert.equal(Date.now(), 1100);
    assert.equal(nativeCalls, 1);
    assert.equal(reservations, 1);
    assert.equal(bodiesCreated, 1);
    assert.equal(cancelRequests, 1, "late unread body was not disposed");
    assert.equal(underlyingCancels, 1, "the actual native stream must be cancelled");
    assert.equal(fulfilledCancels, 1);
    assert.equal(lateBody.locked, false);
    assert.equal(getEventListeners(runSignal, "abort").length, 0);
    assert.equal(getEventListeners(nativeSignal, "abort").length, 0);
    assert.equal(timers.size, 0);
  } finally {
    // Cleanup also joins the controlled producer if an assertion fails.
    clearTimeout(producerTimer);
    rejectHeaders?.(new Error("owned late-body test cleanup"));
    await pendingHeaders?.catch(() => {});
    await pendingRun?.catch(() => {});
    for (const timer of timers.keys()) mockClearTimeout(timer);
    globalThis.setTimeout = mockSetTimeout;
    globalThis.clearTimeout = mockClearTimeout;
  }
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
  const failed = result.requirements.version.attemptedRecords.find((record) =>
    record.trusted === false && record.metadata?.kind === "extraction");
  assert(failed, "the failed extraction must have an actual untrusted audit record");
  const observed = failed.metadata.observed;
  assert(observed && typeof observed === "object", "the supplied measured observation must survive");
  assert.equal(observed.requestSha256, "a".repeat(64));
  assert.deepEqual(observed.usage, { inputTokens: 1, outputTokens: 1 });
  for (const key of ["apiKey", "headers"])
    assert.equal(Object.hasOwn(observed, key), false, `unvalidated ${key} key survived sanitization`);
});
