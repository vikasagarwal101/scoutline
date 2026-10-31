/**
 * Durable native-admission regressions for requirements mode
 * (compatibility/measurement/durable-purpose closure).
 *
 * These drive the REAL seams: the actual compiled handler through
 * main(), the actual direct-TypeSafe judge lifecycle, an injected deterministic
 * extractor seam and a fake Tavily descriptor — no
 * counter-callback collaborator layer. Every row asserts an exact
 * physical outcome (dispatch sequence, refusal before the next
 * request, or a delivered unknown marker), never an acceptable-exit
 * disjunction or a published total alone.
 *
 * The fake protocol mirrors the reviewer's independently-owned fixtures
 * (`requirements-final-reserve-proof.mjs`), ported package-relative so
 * the purposes stay runnable in-tree.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { main } from "../dist/index.js";
import { createTypesafeJudge } from "../dist/lib/lean-typesafe-judge.js";
import { nativeRuntime } from "./helpers/requirements-native-world.mjs";
import { createInMemoryQuotaStore } from "../dist/lib/quota-store.js";

const SCRATCH = await mkdtemp(join(tmpdir(), "req-native-"));
after(async()=>{await rm(SCRATCH,{recursive:true,force:true});});
const BASE_ENV = {
  SCOUTLINE_CONFIG_DIR: join(SCRATCH, "config"),
  SCOUTLINE_CACHE_DIR: join(SCRATCH, "cache"),
  SCOUTLINE_ARTIFACTS_DIR: join(SCRATCH, "artifacts"),
  SCOUTLINE_WATCH_DIR: join(SCRATCH, "watch"),
  TAVILY_API_KEY: "synthetic-acquisition-key",
  TYPESAFE_API_KEY: "synthetic-judge-key",
  SCOUTLINE_JUDGE_TRANSMIT: "1",
};

const CONTRACT = {
  schemaVersion: 1,
  question: "CSV export?",
  requirements: {
    csv: { question: "CSV export?", schema: { enum: ["supported", "refuted", "disputed"] } },
  },
  limits: { maxSearchAttempts: 3, deadlineMs: 5000 },
};

async function runMain(contract, factory, cap) {
  const stdout = [];
  const stderr = [];
  const exit = await main(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(contract), "--no-cache"],
    {
      env: {
        ...BASE_ENV,
        ...(cap !== undefined ? { SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: String(cap) } : {}),
      },
      loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
      agentRegistrationCheck: async () => ({ refreshed: false }),
      consume: { record: async () => {} },
      searchCache: { get: async () => null, set: async () => {} },
      searchSleep: async () => {},
      searchRandom: () => 0.5,
      ...(factory ? { requirementsRuntime: factory } : {}),
      invocation: {
        stdoutIsTTY: false,
        stdinIsTTY: false,
        environmentOutputMode: "data",
        readStdin: async () => "",
        writeStdout: (s) => stdout.push(s),
        writeStderr: (s) => stderr.push(s),
        runQuietly: async (fn) => fn(),
        setExitCode: () => {},
      },
    },
  );
  const text = stdout.join("\n");
  return { exit, stderr: stderr.join("\n"), data: text ? JSON.parse(text) : null };
}

/**
 * The world mirrors the reviewer's proven fixture: the shared
 * nativeRuntime base (fake Tavily transport + injected deterministic extractor),
 * wrapped with a call-recording transport and a REAL direct-TypeSafe
 * judge lifecycle bound to the run-owned pre-dispatch closure.
 */
function world({ retry = false, opaqueJudge = false, producer = false } = {}) {
  const runtime = nativeRuntime({ producer });
  const calls = [];
  const events = [];
  const extractRequests = [];
  const factory = (context) => {
    const v = runtime.factory(context);
    const transport = v.acquisitionOptions.transports.tavily;
    const baseFetch = transport.fetch;
    v.acquisitionOptions.transports = {
      tavily: {
        ...transport,
        fetch: async (...a) => {
          calls.push("acquisition");
          return baseFetch(...a);
        },
      },
    };
    let judgeN = 0;
    const profile = createTypesafeJudge({
      apiKey: "synthetic-judge-key",
      reserveAttempt: opaqueJudge ? () => {} : context.reserveAttempt,
      maxAttempts: retry ? 2 : 1,
      retrySettings: retry ? { maxTransientRetries: 1, baseDelayMs: 1, maxDelayMs: 1 } : undefined,
      onAttempt: (e) => events.push(e),
      fetchLike: async (url, init) => {
        calls.push("judge");
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (retry && judgeN++ === 0) return Response.json({}, { status: 429, headers: { "retry-after": "0" } });
        return Response.json({
          model: "jev-1.13.0",
          answers: Object.fromEntries(
            Object.keys(body.questions ?? {}).map((k) => [k, { type: "noul", noul: /[fc]$/.test(k) ? 0.05 : 0.95 }]),
          ),
          usage: { input_tokens: 2, output_tokens: 1 },
        });
      },
    });
    v.engineDeps.judge = profile.judge;
    v.engineDeps.candidateJudge = profile.candidateJudge;
    if (producer) {
      const extract = v.engineDeps.extract;
      v.engineDeps.extract = async (...args) => {
        context.observeProducerDispatch();
        calls.push("producer");
        extractRequests.push(structuredClone(args[0]));
        return extract(...args);
      };
      v.producerPhysical = { reserve: context.observeProducerDispatch };
    }
    if (opaqueJudge) {
      // Opaque: valid verdicts, no telemetry, no shared admission.
      v.engineDeps.judge = async (input) => ({
        documents: input.documents.map((d) => ({
          evidenceId: d.evidenceId,
          relevant: true,
          supportsClaim: true,
          refutesClaim: false,
        })),
      });
    }
    return v;
  };
  return { calls, events, factory, extractRequests };
}

test("native admission: cap2 refuses the judge's first request before dispatch", async () => {
  const w = world();
  const r = await runMain(CONTRACT, w.factory, 2);
  assert.deepEqual(w.calls, ["acquisition", "acquisition"], "no third request");
  assert.equal(r.exit, 1);
  assert.equal(r.data.usage.physicalHttpAttempts, 2);
});

test("native admission: cap3 refuses the 429 retry before the fourth request", async () => {
  // The retry option ACTUALLY arms the 429 first response; the row
  // proves the retry's reservation was refused pre-dispatch.
  const w = world({ retry: true });
  const r = await runMain(CONTRACT, w.factory, 3);
  assert.equal(w.events.filter((e) => e.outcome === "TYPESAFE_RATE_LIMIT").length, 1, "429 emitted exactly once");
  assert.deepEqual(w.calls, ["acquisition", "acquisition", "judge"], "no fourth request");
  assert.equal(r.exit, 1);
  assert.equal(r.data.status, "partial");
  assert.equal(r.data.usage.physicalHttpAttempts, 3);
});

test("native admission: full run reports the exact measured dispatch count", async () => {
  const w = world();
  const r = await runMain(CONTRACT, w.factory, 48);
  assert.equal(r.exit, 0);
  assert.equal(r.data.usage.physicalHttpAttempts, w.calls.length);
});

test("native admission: opaque judge discloses unknown enforcement AND unknown measurement", async () => {
  // TWO distinct delivered axes, asserted separately so removing either
  // field independently reddens its own assertion.
  const w = world({ opaqueJudge: true });
  const r = await runMain(CONTRACT, w.factory, 48);
  assert.equal(r.exit, 0);
  assert.ok(
    typeof r.data.judgeAdmissionUnknown === "string" && r.data.judgeAdmissionUnknown.length > 0,
    "admission unknown must be a delivered field",
  );
  assert.ok(
    typeof r.data.usage.judgeTelemetryUnknown === "string" && r.data.usage.judgeTelemetryUnknown.length > 0,
    "measurement unknown must be a delivered usage field",
  );
});

test("durable stdin: a stalled quota snapshot settles 130 with zero runtime dispatch", async () => {
  const stdout = [];
  const stderr = [];
  let runtimeConstructed = false;
  const deps = {
    env: { ...BASE_ENV },
    loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
    agentRegistrationCheck: async () => ({ refreshed: false }),
    consume: { record: async () => {} },
    searchCache: { get: async () => null, set: async () => {} },
    searchSleep: async () => {},
    searchRandom: () => 0.5,
    requirementsRuntime: () => {
      runtimeConstructed = true;
      throw new Error("runtime must not be constructed after cancellation");
    },
    readRequirementsQuotaSnapshot: () => new Promise(() => {}), // never resolves
    invocation: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (s) => stdout.push(s),
      writeStderr: (s) => stderr.push(s),
      runQuietly: async (fn) => fn(),
      setExitCode: () => {},
    },
  };
  let fire = null;
  deps.requirementsUserInterrupt = (onInterrupt) => {
    fire = onInterrupt;
    return () => {
      fire = null;
    };
  };
  const runPromise = main(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT), "--no-cache"],
    deps,
  );
  // Wait until the run is parked on the stalled snapshot read, then
  // fire the owned interrupt.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(typeof fire, "function", "registrar must be live during the stalled wait");
  fire();
  const exit = await runPromise;
  assert.equal(exit, 130, `stalled quota must settle 130, got ${exit}`);
  assert.equal(runtimeConstructed, false, "no runtime construction after cancellation");
  assert.equal(stdout.join(""), "", "no result envelope after cancellation");
});


const MIXED = {
  ...CONTRACT,
  requirements: {
    version: { question: "What exact release?", schema: { type: "string" } },
    csv: CONTRACT.requirements.csv,
  },
  limits: { ...CONTRACT.limits, maxSearchAttempts: 5, maxJudgeAttempts: 12 },
};

test("native admission: mixed producer/candidate share cap3 with no fourth HTTP", async () => {
  // Actual native extractor (pre-dispatch observer) + actual native
  // candidate judge on the same run closure: cap3 admits Search+Reader+
  // Extractor and REFUSES the candidate request pre-dispatch.
  const w = world({ producer: true });
  const r = await runMain(MIXED, w.factory, 3);
  assert.deepEqual(w.calls, ["acquisition", "acquisition", "producer"], "candidate refused before a fourth HTTP");
  assert.equal(r.exit, 1);
  assert.equal(r.data.usage.physicalHttpAttempts, 3);
});

test("native admission: mixed full run reports the exact observed total", async () => {
  const w = world({ producer: true });
  const r = await runMain(MIXED, w.factory, 48);
  assert.equal(r.exit, 0, JSON.stringify(r.data ?? null));
  assert.equal(r.data.usage.physicalHttpAttempts, w.calls.length);
  assert.deepEqual(r.data.data, { version: "2.4.0", csv: "supported" });
});


// Exact fixture metadata, checked on the delivered native envelope rather than
// on a parser-only return. These elapsed values describe synthetic work only.
async function deliveredExtractorAudit() {
  const w = world({ producer: true });
  const r = await runMain(MIXED, w.factory, 48);
  assert.equal(r.exit, 0, JSON.stringify(r.data ?? null));
  assert.equal(r.data.usage.physicalHttpAttempts, w.calls.length);
  assert.deepEqual(r.data.data, { version: "2.4.0", csv: "supported" });
  const audits = r.data.requirements.version.attemptedRecords;
  const records = audits.filter((record) => record.metadata?.kind === "extraction");
  assert.equal(w.extractRequests.length, 1, "one actual complete extraction request");
  assert.equal(records.length, 1, `one delivered extraction audit record: ${JSON.stringify(audits)}`);
  assert.equal(records[0].trusted, true, `trusted extraction audit: ${JSON.stringify(audits)}`);
  return { record: records[0].metadata, request: w.extractRequests[0] };
}

test("extractor audit: delivered synthetic elapsedMs is exactly zero", async () => {
  const { record } = await deliveredExtractorAudit();
  assert.equal(record.elapsedMs, 0, "delivered extraction elapsedMs");
});

test("extractor audit: delivered request digest binds the complete actual request", async () => {
  const { record, request } = await deliveredExtractorAudit();
  const expected = createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
  assert.equal(record.requestSha256, expected, "delivered complete-request SHA256");
});


test("extractor request binding: scope and dependency snapshots change the exact digest", async () => {
  const extract = nativeRuntime({ producer: true }).factory({ noCache: true }).engineDeps.extract;
  const base = {
    sourceId: "synthetic-source",
    sourceText: "Its exact release is 2.4.0.",
    fields: [{ id: "version", description: "Exact release", depBindings: { product: "A" } }],
    scope: { product: "A" },
    depBindings: { product: "A" },
  };
  const requests = [base, { ...base, scope: { product: "B" } }, { ...base, depBindings: { product: "B" } }];
  const digests = [];
  for (const req of requests) {
    const result = await extract(req);
    const expected = createHash("sha256").update(JSON.stringify(req), "utf8").digest("hex");
    assert.equal(result.requestSha256, expected, "fixture digest must include complete scope/dependency request");
    digests.push(result.requestSha256);
  }
  assert.equal(new Set(digests).size, requests.length, "scope-only and dependency-only changes must each alter digest");
});

let callerFetch;
async function callerFixtureFetch() {
  if (!callerFetch) {
    const previous = globalThis.fetch;
    try {
      await import("./helpers/caller-native-preload.mjs");
      callerFetch = globalThis.fetch;
    } finally {
      globalThis.fetch = previous;
    }
  }
  return callerFetch;
}

test("caller fake route: wrong same-origin path and query refuse", async () => {
  const fetch = await callerFixtureFetch();
  for (const url of ["https://api.typesafe.ai/v1/wrong", "https://api.typesafe.ai/v1/systemone?wrong=1"])
    await assert.rejects(fetch(url, { method: "POST", body: "{}" }), /Unexpected synthetic HTTP route:/);
});

test("caller fake route: wrong method refuses", async () => {
  const fetch = await callerFixtureFetch();
  await assert.rejects(fetch("https://api.typesafe.ai/v1/systemone", { method: "GET", body: "{}" }), /Unexpected synthetic HTTP route:/);
});

test("caller fake route: exact POST works and unrelated origin refuses", async () => {
  const fetch = await callerFixtureFetch();
  const response = await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", body: JSON.stringify({ questions: { supported: {} } }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "jev-1.13.0");
  await assert.rejects(fetch("https://elsewhere.test/v1/systemone", { method: "POST", body: "{}" }), /Unexpected synthetic HTTP route:/);
});


// ---------------------------------------------------------------------------
// Compiled-bin OS guards: hermetic children, scrubbed env, fake-only HTTP
// via the same --import preload the reviewer guards use (ported local).
// ---------------------------------------------------------------------------

const ROOT = new URL("..", import.meta.url).pathname;
const FAKE_HTTP = `${SCRATCH}/fake-http.mjs`;
import { writeFileSync, appendFileSync } from "node:fs";
writeFileSync(
  FAKE_HTTP,
  `import { appendFileSync } from "node:fs";
// Deliberate private startup stimulus; readiness must still come from next().
if (process.env.COLD_STARTUP_DELAY_MS)
  await new Promise(resolve => setTimeout(resolve, Number(process.env.COLD_STARTUP_DELAY_MS)));
// Transparently delegate the real stdin iterator. The marker is emitted only
// after an actual first next() remains pending through a microtask checkpoint.
const originalIterator = process.stdin[Symbol.asyncIterator];
process.stdin[Symbol.asyncIterator] = function (...args) {
  const iterator = Reflect.apply(originalIterator, this, args);
  let first = true;
  return new Proxy(iterator, {
    get(target, key) {
      if (key === "next") return (...nextArgs) => {
        const pending = Reflect.apply(target.next, target, nextArgs);
        if (first) {
          first = false;
          let settled = false;
          Promise.resolve(pending).then(step => {
            settled = true;
            if (step.done) appendFileSync(process.env.COLD_TRACE, JSON.stringify({ event: "stdin-eof" }) + "\\n");
          }, () => { settled = true; });
          queueMicrotask(() => {
            if (!settled && process.env.COLD_SUPPRESS_PENDING_MARKER !== "1")
              appendFileSync(process.env.COLD_TRACE, JSON.stringify({ event: "stdin-next-pending" }) + "\\n");
          });
        }
        return pending;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
if (process.env.COLD_OBSERVE_SIGINT === "1")
  process.on("SIGINT", () =>
    appendFileSync(process.env.COLD_TRACE, JSON.stringify({ event: "sigint-observed" }) + "\\n"),
  );
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  appendFileSync(process.env.COLD_TRACE, JSON.stringify({ url: target, method: init.method ?? "GET" }) + "\\n");
  if (target === "https://api.typesafe.ai/v1/systemone") {
    if (process.env.COLD_HANG_JUDGE === "1") {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          appendFileSync(process.env.COLD_TRACE, JSON.stringify({ event: "native-abort" }) + "\\n");
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    }
    const body = JSON.parse(init.body);
    return Response.json({
      model: "jev-1.13.0",
      answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: /[fc]$/.test(k) ? 0.05 : 0.95 }])),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  if (target === "https://api.tavily.com/search")
    return Response.json({ results: [{ title: "T", url: "https://example.test/a", content: "ExampleApp supports CSV export." }] });
  if (target === "https://api.tavily.com/extract")
    return Response.json({ results: [{ url: "https://example.test/a", raw_content: "ExampleApp supports CSV export. 2.4.0" }] });
  throw new Error("refused external HTTP");
};
`,
);

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

function childEnv(extra) {
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: SCRATCH,
    NODE_OPTIONS:process.env.NODE_OPTIONS,
    TMPDIR:process.env.TMPDIR,
    COLD_OBSERVE_SIGINT: "1",
    SCOUTLINE_CONFIG_DIR: join(SCRATCH, "bin-config"),
    SCOUTLINE_CACHE_DIR: join(SCRATCH, "bin-cache"),
    SCOUTLINE_ARTIFACTS_DIR: join(SCRATCH, "bin-artifacts"),
    TAVILY_API_KEY: "synthetic-key",
    COLD_TRACE: join(SCRATCH, "trace.jsonl"),
    ...extra,
  };
  // Preserve the released parent network refusal and exact-root observer.
  // The synthetic preload below overrides only fetch responses.
  return env;
}

function runBin(args, extraEnv, { killSignal, afterDispatch, stdinChunk, waitForPendingStdin = false, lifetimeMs = 15000, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const env = childEnv(extraEnv);
    let child;
    try {
      child = spawn(process.execPath, ["--import", FAKE_HTTP, join(ROOT, "bin", "scoutline.js"), ...args], {
        cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"], execArgv: [],
      });
    } catch {
      reject(Object.assign(new Error("native fixture spawn failed"), { code: "NATIVE_FIXTURE_SPAWN" }));
      return;
    }
    let out = "", err = "", failure, closed = false, settled = false, pollTimer;
    let polling = Promise.resolve();
    const fail = (code) => {
      if (closed || failure) return;
      failure = Object.assign(new Error(`native fixture failure: ${code}`), { code, childPid: child.pid });
      child.kill("SIGKILL");
    };
    // This lifetime owner is independent of readiness/dispatch polls.
    const watchdog = setTimeout(() => fail("NATIVE_FIXTURE_WATCHDOG"), lifetimeMs);
    child.stdout.on("data", data => { out += data; });
    child.stderr.on("data", data => { err += data; });
    child.on("error", () => fail("NATIVE_FIXTURE_SPAWN"));
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.on("error", () => fail("NATIVE_FIXTURE_STREAM"));
    child.once("close", async (code, signal) => {
      closed = true;
      clearTimeout(watchdog);
      clearTimeout(pollTimer);
      // Join every in-flight poll/write continuation before settlement.
      await polling;
      if (settled) return;
      settled = true;
      if (failure) reject(failure);
      else resolve({ code, signal, out, err, child });
    });
    const mark = event => appendFileSync(env.COLD_TRACE, JSON.stringify({ event }) + "\n");
    const act = async () => {
      if (closed || failure) return;
      if (stdinChunk !== undefined) {
        mark("parent-stdin-write");
        await new Promise((done, failed) => child.stdin.write(stdinChunk, error => error ? failed(error) : done()));
        // Never end(): the partial JSON leaves the real read pending.
      }
      if (closed || failure) return;
      if (killSignal !== undefined) {
        mark("parent-signal");
        if (!child.kill(killSignal)) fail("NATIVE_FIXTURE_SIGNAL");
      }
    };
    const poll = async () => {
      if (closed || failure) return;
      let text;
      try { text = await readFile(env.COLD_TRACE, "utf8"); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        text = ""; // Only initial trace creation is allowed to wait.
      }
      if (closed || failure) return;
      const trace = text.trim().split("\n").filter(Boolean).map(JSON.parse);
      const ready = waitForPendingStdin
        ? trace.some(event => event.event === "stdin-next-pending")
        : trace.some(event => typeof event.url === "string" && event.url.includes(afterDispatch));
      if (ready) await act();
      else if (!closed && !failure) pollTimer = setTimeout(startPoll, 15);
    };
    const startPoll = () => {
      if (closed || failure) return;
      polling = poll().catch(() => fail("NATIVE_FIXTURE_TRACE_OR_WRITE"));
    };
    try { onChild?.(child); }
    catch { fail("NATIVE_FIXTURE_OUTER_HOOK"); }
    if (waitForPendingStdin || afterDispatch !== undefined) startPoll();
    else polling = act().catch(() => fail("NATIVE_FIXTURE_WRITE"));
  });
}

// The outer owner stays active even when a counterfactual disables the helper
// watchdog. It always joins the exact child and helper outcome before returning.
async function runBinWithOuter(args, extraEnv, options, outerMs = 2000) {
  let child, closed, outerExpired = false;
  const timer = setTimeout(() => {
    outerExpired = true;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, outerMs);
  let observed;
  try {
    observed = runBin(args, extraEnv, { ...options, onChild: (owned) => {
      child = owned;
      closed = new Promise((resolve) => owned.once("close", (code, signal) => resolve({ code, signal })));
    } }).then(result => ({ result }), error => ({ error }));
    const outcome = await observed;
    const close = await closed;
    return { ...outcome, outerExpired, close, pid: child.pid };
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await observed;
  }
}

test("compiled helper watchdog: missing dispatch fails boundedly and joins its exact child", async () => {
  await writeFile(childEnv({}).COLD_TRACE, "");
  const r = await runBinWithOuter(
    ["investigate", "--provider", "tavily", "--requirements", "-"], {},
    { afterDispatch: "deliberately-impossible-dispatch", killSignal: "SIGINT", lifetimeMs: 200 },
  );
  assert.equal(r.error?.code, "NATIVE_FIXTURE_WATCHDOG", "helper must own the bounded failure diagnostic before outer cleanup");
  assert.equal(r.outerExpired, false, "helper reaps before independent outer deadline");
  assert.equal(r.error.childPid, r.pid, "diagnostic identifies exact owned child");
  assert.deepEqual(r.close, { code: null, signal: "SIGKILL" }, "forced cleanup is joined and cannot qualify as natural130");
});


test("compiled helper watchdog: missing pending marker is a fixed bounded fixture failure", async () => {
  await writeFile(childEnv({}).COLD_TRACE, "");
  const r = await runBinWithOuter(
    ["investigate", "--provider", "tavily", "--requirements", "-"],
    { COLD_SUPPRESS_PENDING_MARKER: "1" },
    { waitForPendingStdin: true, stdinChunk: '{"schemaVersion":1,', killSignal: "SIGINT", lifetimeMs: 300 },
  );
  assert.equal(r.error?.code, "NATIVE_FIXTURE_WATCHDOG", "missing marker must be bounded by the helper owner");
  assert.equal(r.error.childPid, r.pid);
  assert.equal(r.outerExpired, false);
  assert.deepEqual(r.close, { code: null, signal: "SIGKILL" });
});

test("compiled bin: SIGINT on an open stdin pipe (no EOF) settles 130 without forced kill", async () => {
  await writeFile(childEnv({}).COLD_TRACE, "");
  const owned = await runBinWithOuter(
    ["investigate", "--provider", "tavily", "--requirements", "-"],
    { COLD_STARTUP_DELAY_MS: "3500" },
    { killSignal: "SIGINT", stdinChunk: '{"schemaVersion":1,', waitForPendingStdin: true },
    12000,
  );
  assert.equal(owned.outerExpired, false, "independent outer cleanup must not be needed");
  if (owned.error) throw owned.error;
  const r = owned.result;
  const trace = (await readFile(childEnv({}).COLD_TRACE, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const pending = trace.findIndex(e => e.event === "stdin-next-pending");
  const write = trace.findIndex(e => e.event === "parent-stdin-write");
  const signal = trace.findIndex(e => e.event === "parent-signal");
  assert.ok(pending >= 0 && write > pending && signal > write, `actual pending-next must precede partial input and SIGINT: ${JSON.stringify(trace)}`);
  assert.equal(trace.some(e => e.event === "stdin-eof"), false, "no EOF was delivered");
  assert.equal(r.signal, null, "no raw signal death");
  assert.equal(r.code, 130, `expected owned 130, got ${r.code}`);
});


test("compiled bin: SIGINT during an in-flight native judge request aborts and settles 130 with no later HTTP", async () => {
  // The judge hangs until abort (COLD_HANG_JUDGE); SIGINT mid-flight
  // must fire the run's owned signal, the native fetch rejects with
  // AbortError, and the trace shows NO dispatch after the abort.
  await writeFile(childEnv({}).COLD_TRACE, "");
  const r = await runBin(
    [
      "investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT), "--no-cache",
    ],
    { TYPESAFE_API_KEY: "synthetic-judge-key", SCOUTLINE_JUDGE_TRANSMIT: "1", COLD_HANG_JUDGE: "1" },
    { killSignal: "SIGINT", afterDispatch: "api.typesafe.ai" },
  );
  assert.equal(r.signal, null, "no raw signal death");
  assert.equal(r.code, 130, `expected owned 130, got ${r.code}`);
  const trace = (await readFile(childEnv({}).COLD_TRACE, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const abortIndex = trace.findIndex((e) => e.event === "native-abort");
  assert.ok(abortIndex >= 0, "native abort must be observed");
  const after = trace.slice(abortIndex + 1).filter((e) => e.url !== undefined);
  assert.equal(after.length, 0, "no HTTP after the abort");
});


// ---------------------------------------------------------------------------
// Shared reader durable rows (signalled ownership + absent-signal
// compatibility), mirroring the reviewer's edge guards in-tree.
// ---------------------------------------------------------------------------

test("reader: signalled byte-cap crossing closes the iterator exactly once", async () => {
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  const controller = new AbortController();
  let returns = 0;
  const iter = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: Buffer.from("toolarge") }),
        return: async () => {
          returns += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const out = await readBytesBounded(iter, 1, controller.signal);
  assert.equal(out.length, 8, "crossing chunk retained");
  assert.equal(returns, 1, "iterator closed exactly once on cap crossing");
});

test("reader: signalled conversion failure closes the iterator and preserves the primary error", async () => {
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  const controller = new AbortController();
  let returns = 0;
  const iter = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: { bogus: true } }),
        return: async () => {
          returns += 1;
          throw new Error("distinct synthetic cleanup failure");
        },
      };
    },
  };
  try {
    await assert.rejects(readBytesBounded(iter, 1024, controller.signal), (error) => {
      assert.ok(error instanceof TypeError, "conversion TypeError must remain primary over cleanup rejection");
      assert.equal(error.code, "ERR_INVALID_ARG_TYPE", "exact primary conversion error code");
      return true;
    });
  } finally {
    assert.equal(returns, 1, "iterator closed exactly once on conversion failure");
  }
});

test("reader: signalled PassThrough cap crossing returns the bytes AND destroys the stream", async () => {
  const { PassThrough } = await import("node:stream");
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  const controller = new AbortController();
  const stream = new PassThrough();
  const read = readBytesBounded(stream, 1, controller.signal);
  stream.write(Buffer.from("12345"));
  const out = await read;
  assert.equal(out.length, 5, "all five crossing bytes returned");
  assert.equal(stream.destroyed, true, "the stream is destroyed after the cap exit");
});

test("reader: absent-signal async close is awaited before resolution", async () => {
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  let released = false;
  const iter = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: Buffer.from("ab") }),
        return: async () => {
          await new Promise((r) => setTimeout(r, 30));
          released = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const out = await readBytesBounded(iter, 1);
  assert.equal(out.length, 2);
  assert.equal(released, true, "async return() completed before the read resolved");
});

test("reader: absent-signal cleanup rejection remains an outward failure", async () => {
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  const iter = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: Buffer.from("ab") }),
        return: async () => {
          throw new Error("release failed");
        },
      };
    },
  };
  await assert.rejects(readBytesBounded(iter, 1), /release failed/);
});

test("reader: pre-aborted synchronous throwing return is contained as AbortError", async () => {
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  let nextCalls = 0;
  const iter = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          nextCalls += 1;
          return { done: true, value: undefined };
        },
        return: () => {
          throw new Error("private cleanup failure");
        },
      };
    },
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readBytesBounded(iter, 1024, controller.signal),
    (e) => e.name === "AbortError",
  );
  assert.equal(nextCalls, 0, "no read started");
});


test("reader: signalled success-path close rejection propagates (not swallowed)", async () => {
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  const controller = new AbortController();
  const iter = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined }), // clean exhaustion: no primary error
        return: async () => {
          throw new Error("close failed on success");
        },
      };
    },
  };
  await assert.rejects(
    readBytesBounded(iter, 1024, controller.signal),
    /close failed on success/,
    "with no primary read/abort error, a close rejection is the outward failure",
  );
});

// Review P3: actual compiled reader, explicit disposal barriers, no elapsed-time oracle.
test('review P3 abort remains effective during held iterator disposal with one owner',async()=>{
  const {readBytesBounded}=await import('../dist/node-command-invocation-adapter.js');
  const drain=()=>new Promise(resolve=>setImmediate(resolve)),unhandled=[];
  const onUnhandled=error=>unhandled.push(error);process.on('unhandledRejection',onUnhandled);
  try{
    for(const ending of ['cap','exhaustion'])for(const late of ['resolve','reject']){
      const controller=new AbortController();let enter,release,rejectClose,returns=0,outcome;
      const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise((resolve,reject)=>{release=resolve;rejectClose=reject;});
      const input={[Symbol.asyncIterator](){return {next:async()=>ending==='cap'?{done:false,value:Buffer.from('crossing')}:{done:true,value:undefined},return(){returns++;enter();return held;}};}};
      const observed=readBytesBounded(input,1,controller.signal).then(value=>{outcome={kind:'success',value};},error=>{outcome={kind:'error',error};});
      try{
        await entered;controller.abort();await drain();
        const actual={outcome:outcome?.kind==='error'?outcome.error.name:outcome?.kind??'pending',returns};console.log(JSON.stringify({case:'P3 held close',ending,late,...actual}));
        assert.deepEqual(actual,{outcome:'AbortError',returns:1},'abort must settle the held close and never invoke return twice');
      }finally{
        if(late==='reject')rejectClose(new Error('late held-close failure'));else release({done:true,value:undefined});
        await observed;await drain();
      }
      assert.equal(outcome.kind,'error');assert.equal(outcome.error.name,'AbortError');assert.equal(returns,1);
    }
    // Earlier read failure stays primary, while abort unblocks its pending cleanup.
    {
      const controller=new AbortController(),primary=new Error('earlier read failure');let enter,rejectClose,returns=0,outcome;
      const entered=new Promise(resolve=>{enter=resolve;}),held=new Promise((_resolve,reject)=>{rejectClose=reject;});
      const input={[Symbol.asyncIterator](){return {next:async()=>{throw primary;},return(){returns++;enter();return held;}};}};
      const observed=readBytesBounded(input,1,controller.signal).then(value=>{outcome={value};},error=>{outcome={error};});
      try{await entered;controller.abort();await drain();assert.equal(outcome?.error,primary);assert.equal(returns,1);}finally{rejectClose(new Error('late cleanup after primary'));await observed;await drain();}
    }
    for(const trigger of ['getter','call']){
      const controller=new AbortController();let getters=0,returns=0;
      const iterator={next:async()=>({done:true,value:undefined}),get return(){getters++;if(trigger==='getter')controller.abort();return ()=>{returns++;if(trigger==='call')controller.abort();return Promise.resolve({done:true,value:undefined});};}};
      await assert.rejects(readBytesBounded({[Symbol.asyncIterator]:()=>iterator},1,controller.signal),e=>e.name==='AbortError');await drain();assert.equal(getters,1,'close state precedes arbitrary getter/reentrant abort');assert.equal(returns,1);
    }
    for(const throwing of ['getter','call']){
      const controller=new AbortController(),failure=new Error('synchronous close failure');let getters=0,returns=0;
      const iterator={next:async()=>({done:true,value:undefined}),get return(){getters++;if(throwing==='getter')throw failure;return ()=>{returns++;throw failure;};}};
      await assert.rejects(readBytesBounded({[Symbol.asyncIterator]:()=>iterator},1,controller.signal),e=>e===failure);assert.equal(getters,1);assert.equal(returns,throwing==='getter'?0:1);
    }
    {
      const controller=new AbortController();controller.abort();let next=0,getters=0;
      const iterator={next:async()=>{next++;return {done:true};},get return(){getters++;throw new Error('pre-abort cleanup failure');}};
      await assert.rejects(readBytesBounded({[Symbol.asyncIterator]:()=>iterator},1,controller.signal),e=>e.name==='AbortError');await drain();assert.equal(next,0);assert.equal(getters,1);
    }
    {
      const {PassThrough}=await import('node:stream'),stream=new PassThrough(),controller=new AbortController();
      const observed=readBytesBounded(stream,1024,controller.signal);controller.abort();await assert.rejects(observed,e=>e.name==='AbortError');assert.equal(stream.destroyed,true);
    }
    await drain();assert.deepEqual(unhandled,[],'late close failures must be observed');
  }finally{process.removeListener('unhandledRejection',onUnhandled);}
});
