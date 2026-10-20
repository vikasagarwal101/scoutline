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
  return { calls, events, factory };
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


// ---------------------------------------------------------------------------
// Compiled-bin OS guards: hermetic children, scrubbed env, fake-only HTTP
// via the same --import preload the reviewer guards use (ported local).
// ---------------------------------------------------------------------------

const ROOT = new URL("..", import.meta.url).pathname;
const FAKE_HTTP = `${SCRATCH}/fake-http.mjs`;
import { writeFileSync } from "node:fs";
writeFileSync(
  FAKE_HTTP,
  `import { appendFileSync } from "node:fs";
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

function runBin(args, extraEnv, { killSignal, afterDispatch, stdinChunk, stdinDelayMs = 2000, afterMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", FAKE_HTTP, join(ROOT, "bin", "scoutline.js"), ...args],
      {
        cwd: ROOT,
        env: childEnv(extraEnv),
        stdio: ["pipe", "pipe", "pipe"],
        // Strip inherited inspector/debug execArgv: under the full-glob
        // runner each test file gets its own inspected process, and a
        // child inheriting the same debug port hangs at startup.
        execArgv: [],
      },
    );
    // A pending stdin READ proves both interrupt registrars are armed
    // (the lane one at dispatch; the handler's immediately before its
    // read) — but the read only becomes pending once bytes arrive. The
    // write is DELAYED so module load + preflight finish first even
    // under runner contention; writing earlier would let a fast SIGINT
    // land before arming.
    if (stdinChunk !== undefined) {
      setTimeout(() => {
        child.stdin.write(stdinChunk); // never end(): the read stays pending
      }, stdinDelayMs);
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (s) => (out += s));
    child.stderr.on("data", (s) => (err += s));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, out, err, child }));
    if (afterDispatch !== undefined) {
      const poll = setInterval(async () => {
        try {
          const trace = await readFile(childEnv(extraEnv).COLD_TRACE, "utf8").catch(() => "");
          if (trace.includes(afterDispatch)) {
            clearInterval(poll);
            if (killSignal !== undefined) child.kill(killSignal);
          }
        } catch {
          /* keep polling */
        }
      }, 15);
      child.on("exit", () => clearInterval(poll));
    }
    if (afterMs !== undefined) {
      const timer = setTimeout(() => {
        if (killSignal !== undefined) child.kill(killSignal);
      }, afterMs);
      child.on("exit", () => clearTimeout(timer));
    }
  });
}

test("compiled bin: SIGINT on an open stdin pipe (no EOF) settles 130 without forced kill", async () => {

  await writeFile(childEnv({}).COLD_TRACE, "");
  const childPromise = runBin(
    ["investigate", "--provider", "tavily", "--requirements", "-"],
    {},
    // stdin written at 2s (arming guaranteed under glob contention),
    // SIGINT 500ms later with the read provably pending.
    { killSignal: "SIGINT", stdinChunk: '{"schemaVersion":1,', stdinDelayMs: 2000, afterMs: 2500 },
  );
  // Feed a partial line and NEVER close stdin: the read stays pending.
  const r = await childPromise;
  if (r.code !== 130) console.error("CHILD STDERR:", r.err.slice(0, 300));
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
          return { done: true, value: undefined };
        },
      };
    },
  };
  await assert.rejects(readBytesBounded(iter, 1024, controller.signal), /bogus|Cannot|invalid/i);
  assert.equal(returns, 1, "iterator closed exactly once on conversion failure");
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
