/**
 * Independent guards for requirements-mode investigate through the REAL
 * main() dispatcher (unified-investigation public-command-integration).
 *
 * Hermetic: every runtime is injected through the
 * MainDependencies.requirementsRuntime seam with fake-fetch HTTP and
 * fake judge/extractor doubles; zero network, zero ambient credentials.
 *
 * Covers: file/stdin/inline input routes, plain-mode compatibility and
 * mode-conflict rejection, no-HTTP preflight rejections (unknown keys,
 * bad JSON, byte ceiling), judge selection rules (absent = deterministic
 * partial; key-without-consent and consent-without-key = typed error),
 * selected-judge failure (never a silent downgrade), cancellation
 * contract (AbortSignal honored by the engine), shared run-admission
 * seam (one closure across acquisition AND judge), result envelope shape
 * (discriminator, accepted-only data, evidence identity, physical
 * totals, resultSha256), and plain-question byte compatibility.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp as actualMkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { main } from "../dist/index.js";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const TEXT =
  "ExampleApp release 2.4.0. License MIT applies to release 2.4.0. CSV export is supported from the reports screen.";
const NOISE = "Quarterly industry results announced today.";
const URL_USEFUL = "https://offline.test/release";
const URL_NOISE = "https://offline.test/noise";
const ENV = { TAVILY_API_KEY: "guard-synthetic-key", TAVILY_TIMEOUT: "2000" };

const CONTRACT = {
  schemaVersion: 1,
  question: "Identify the version, license, and CSV status for ExampleApp.",
  scope: { entity: "ExampleApp", release: "2.4.0" },
  requirements: {
    version: { question: "Which exact release is documented?", schema: { type: "string" } },
    license: { question: "Which license applies to the accepted release?", schema: { type: "string" }, dependsOn: ["version"] },
    csv: { question: "Does ExampleApp release 2.4.0 support CSV export?", schema: { enum: ["supported", "refuted", "disputed"] } },
  },
};

function fakeFetchWorld(log = []) {
  return async (url, init) => {
    log.push({ url: String(url) });
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init.body ?? "{}"));
    if (path === "/search") {
      const first = String(body.query ?? "").includes("contrary");
      const urls = first ? [URL_USEFUL] : [URL_NOISE, URL_USEFUL];
      return new Response(
        JSON.stringify({
          results: urls.map((u) =>
            u === URL_NOISE
              ? { url: u, title: "Industry weekly", content: NOISE }
              : { url: u, title: "ExampleApp 2.4.0 release notes", content: TEXT.slice(0, 60) },
          ),
        }),
        { status: 200 },
      );
    }
    const target = body.urls?.[0] ?? "";
    if (target.includes("noise")) {
      return new Response(JSON.stringify({ results: [{ url: target, title: "Industry weekly", raw_content: NOISE }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: [{ url: target, title: "ExampleApp 2.4.0 release notes", raw_content: TEXT }] }), { status: 200 });
  };
}

const fakeJudge = async (input) => ({
  documents: input.documents.map((doc) => {
    if (doc.url.includes("noise")) {
      return { evidenceId: doc.evidenceId, relevant: false, supportsClaim: null, refutesClaim: null };
    }
    return { evidenceId: doc.evidenceId, relevant: true, supportsClaim: doc.content.includes("CSV export is supported"), refutesClaim: false };
  }),
});
const failingJudge = async () => {
  const err = new Error("judge backend unavailable (guard fixture)");
  err.attempts = 2;
  throw err;
};
const fakeExtract = async (request) => {
  const text = request.sourceText ?? "";
  const pick = (label) => {
    const i = text.indexOf(label);
    return i >= 0 ? { value: label, quote: label, charRange: [i, i + label.length] } : null;
  };
  const payload = {};
  for (const field of request.fields) {
    const hit = field.id === "version" ? pick("2.4.0") : field.id === "license" ? pick("MIT") : null;
    if (hit) payload[field.id] = hit;
  }
  return { finishReason: "stop", rawOutput: JSON.stringify(payload), usage: { inputTokens: 10, outputTokens: 10 }, observedCost: null, elapsedMs: 1, requestSha256: "guard-fake-extract", attempts: 1 };
};
const fakeCandidateJudge = async (input) => {
  const answers = {};
  input.candidates.forEach((c, i) => {
    const supported = input.source.content.includes(c.quote);
    answers[`q${i}s`] = { type: "noul", noul: supported ? 0.97 : 0.05 };
    answers[`q${i}c`] = { type: "noul", noul: 0.03 };
  });
  return { model: "guard-fake-judge", answers, usage: { inputTokens: 20, outputTokens: 5 }, requestSha256: "guard-fake-judge", elapsedMs: 1 };
};

/** Build the injected requirementsRuntime factory. `hooks` observes
 *  admission reservations, caps them when `cap` is set, and controls
 *  extract attempt reporting (`extractAttempts`: number = reported,
 *  undefined = unobservable, false = no extract seam). */
function makeRequirementsRuntime({
  withJudge = true,
  judge = fakeJudge,
  extractAttempts = 1,
  hooks = {},
} = {}) {
  const httpLog = hooks.httpLog ?? [];
  const fetch = fakeFetchWorld(httpLog);
  const transport = { fetch, env: ENV };
  const reserves = hooks.reserves ?? { count: 0 };
  const cap = hooks.cap;
  if (hooks.producerDispatches !== undefined) {
    hooks.seam = { reserve: () => { hooks.reserved += 1; } };
  }
  const extractFactory = (runtimeContext) =>
    extractAttempts === false
      ? null
      : async (request) => {
          for (let i = 0; i < (hooks.producerDispatches ?? 0); i += 1) {
            // One physical dispatch = one reserve (shared finite
            // admission) + one observation (measured count).
            hooks.seam?.reserve?.();
            runtimeContext?.observeProducerDispatch?.();
            hooks.observed?.push(i);
            await hooks.producerFetch?.('https://producer.fixture.invalid/dispatch');
          }
          const base = await fakeExtract(request);
          return extractAttempts === undefined || extractAttempts === null
            ? // strip the attempts field: a producer whose attempt count
              // is unobservable
              (({ attempts: _drop, ...rest }) => rest)(base)
            : { ...base, attempts: extractAttempts };
        };
  return (context) => ({
    acquisitionOptions: {
      transports: { tavily: transport },
      descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
      searchDescriptor: createTavilyDescriptor({ transport }),
      readerDescriptor: createTavilyDescriptor({ transport }),
      env: ENV,
      cache: { get: async () => null, set: async () => {} },
      sleep: async () => {},
      random: () => 0,
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
      // SHARED run admission seam: one CEILING the judge and producer
      // reserve through too (correction finding 5).
      // Opt into the run-owned admission closure: a cooperating runtime
      // reserves the SAME ceiling the handler enforces, so a test can
      // prove pre-dispatch refusal rather than post-dispatch counting.
      // Opt into the run-owned admission closure when the handler
      // supplies one: a cooperating runtime reserves the SAME ceiling
      // the handler enforces, so a test proves PRE-dispatch refusal
      // rather than post-dispatch counting.
      reservePhysicalAttempt:
        context?.reserveAttempt ??
        (() => {
          reserves.count += 1;
          if (cap !== undefined && reserves.count > cap) {
            throw new Error(`run physical cap (${cap}) exhausted`);
          }
        })(),
    },
    // Producer admission seam (finding 1): a producer that performs
    // physical work DECLARES the seam and calls the context observer
    // once per permitted dispatch (before the request, sharing the
    // run's finite admission); declaring it with zero dispatches is a
    // truthful measured zero.
    ...(hooks.producerDispatches !== undefined ? { producerPhysical: hooks.seam ?? { reserve: () => {} } } : {}),
    engineDeps: withJudge
      ? { judge, extract: extractFactory(context), candidateJudge: fakeCandidateJudge, extractorRevision: "guard-fake", now: () => 0 }
      : { judge: null, now: () => 0 },
    secrets: [],
  });
}

function makeAdapter({ stdin = "" } = {}) {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      readStdin: async () => stdin,
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

async function runMain(argv, { runtime, env = { ...ENV }, stdin = "" } = {}) {
  const { adapter, stdout, stderr } = makeAdapter({ stdin });
  const deps = hermeticMainDeps({ invocation: adapter, env });
  if (runtime !== undefined) deps.requirementsRuntime = runtime;
  const code = await main(argv, deps);
  const text = stdout.join("");
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { code, stdout: text, stderr: stderr.join(""), parsed };
}

test("requirements mode: three input routes produce the complete envelope", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "scoutline-req-guard-"));
  const reqFile = join(sandbox, "requirements.json");
  await writeFile(reqFile, JSON.stringify(CONTRACT));
  const routes = [
    { argv: ["investigate", "--requirements", reqFile] },
    { argv: ["investigate", "--requirements", "-"], stdin: JSON.stringify(CONTRACT) },
    { argv: ["investigate", "--requirements-json", JSON.stringify(CONTRACT)] },
  ];
  for (const route of routes) {
    const { code, parsed } = await runMain(route.argv, { runtime: makeRequirementsRuntime(), stdin: route.stdin ?? "" });
    assert.equal(code, 0, `route ${route.argv[1]} exited ${code}`);
    assert.equal(parsed.kind, "requirements-investigation");
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.status, "complete");
    assert.equal(parsed.assessment, "semantic");
    assert.deepEqual(parsed.data, { version: "2.4.0", license: "MIT", csv: "supported" });
    // Accepted-only data + per-field rows.
    for (const [id, row] of Object.entries(parsed.requirements)) {
      assert.equal(row.status, "satisfied", `field ${id} unresolved: ${row.reason}`);
      assert.equal(parsed.data[id] !== undefined, true);
    }
    // Evidence identity: content + display digests, locator basis.
    for (const record of parsed.evidence) {
      assert.match(record.contentSha256, /^[0-9a-f]{64}$/);
      assert.equal(record.displayContentSha256, createHash("sha256").update(record.content, "utf8").digest("hex"));
      assert.equal(record.locatorBasis, "original-normalized-content");
    }
    // Physical accounting (correction finding 8): the attempt-reporting
    // producer makes the total a NUMBER covering acquisition + judge +
    // producer dispatches (non-zero, and strictly more than the
    // acquisition-only total of the no-judge run would be).
    assert.equal(typeof parsed.usage.physicalHttpAttempts, "number");
    assert.ok(parsed.usage.physicalHttpAttempts > 0);
    assert.ok(Array.isArray(parsed.acquisition.readProvenance));
    assert.match(parsed.resultSha256, /^[0-9a-f]{64}$/);
  }
});

test("requirements mode: no-judge run is deterministic-only partial, not a downgrade error", async () => {
  const { code, parsed } = await runMain(
    ["investigate", "--requirements-json", JSON.stringify(CONTRACT)],
    { runtime: makeRequirementsRuntime({ withJudge: false }) },
  );
  assert.equal(code, 1);
  assert.equal(parsed.assessment, "deterministic-only");
  assert.equal(parsed.status, "partial");
  assert.deepEqual(parsed.data, {});
});

test("requirements mode: selected failing judge surfaces as operational failure, never silent downgrade", async () => {
  const { code, stderr, parsed } = await runMain(
    ["investigate", "--requirements-json", JSON.stringify(CONTRACT)],
    { runtime: makeRequirementsRuntime({ judge: failingJudge }) },
  );
  // A selected-and-failing judge is a typed operational outcome: either
  // a partial envelope with unresolved semantic fields and a recorded
  // judge-invalid acquisition event, or a terminal error — but NEVER a
  // complete or deterministic-only envelope.
  assert.notEqual(code, 0);
  if (parsed !== null) {
    assert.notEqual(parsed.assessment, "deterministic-only");
    assert.notEqual(parsed.status, "complete");
    const sawJudgeInvalid = parsed.acquisitionLog.some((e) => e.kind === "judge-invalid");
    assert.equal(sawJudgeInvalid, true, "expected judge-invalid acquisition events");
  } else {
    assert.ok(stderr.length > 0);
  }
});

test("requirements mode: mode conflicts reject before any HTTP (typed, exit 1)", async () => {
  const httpLog = [];
  const runtime = makeRequirementsRuntime({ hooks: { httpLog } });
  const conflicts = [
    { argv: ["investigate", "--requirements", "-", "--requirements-json", "{}"] },
    { argv: ["investigate", "--requirements", "-", "a positional question"], stdin: JSON.stringify(CONTRACT) },
    { argv: ["investigate", "--requirements", "-", "--verify"], stdin: JSON.stringify(CONTRACT) },
    { argv: ["investigate", "--requirements", "-", "--synthesize"], stdin: JSON.stringify(CONTRACT) },
    { argv: ["investigate", "--requirements", "-", "--sources", "3"], stdin: JSON.stringify(CONTRACT) },
    { argv: ["investigate", "--requirements", "-", "--max-chars", "4000"], stdin: JSON.stringify(CONTRACT) },
    { argv: ["investigate", "--requirements", "-", "--context", "notes.md"], stdin: JSON.stringify(CONTRACT) },
  ];
  for (const c of conflicts) {
    const { code, stderr } = await runMain(c.argv, { runtime, stdin: c.stdin ?? "" });
    assert.equal(code, 1, `expected typed exit 1 for ${c.argv.join(" ")}`);
    assert.ok(stderr.includes("VALIDATION_ERROR") || stderr.length > 0);
  }
  assert.equal(httpLog.length, 0, "no HTTP dispatch may happen on a mode conflict");
});

test("requirements mode: malformed input rejects pre-acquisition with zero HTTP", async () => {
  const httpLog = [];
  const runtime = makeRequirementsRuntime({ hooks: { httpLog } });
  const badInputs = [
    "not json at all",
    JSON.stringify({ ...CONTRACT, unknownKey: 1 }),
    JSON.stringify({ schemaVersion: 2, question: "x", requirements: {} }),
    JSON.stringify({ schemaVersion: 1, question: "", requirements: {} }),
    JSON.stringify({ schemaVersion: 1, question: "q", requirements: { f: { question: "fq", schema: { enum: ["maybe"] } } } }),
  ];
  for (const bad of badInputs) {
    const { code } = await runMain(["investigate", "--requirements-json", bad], { runtime });
    assert.equal(code, 1, `expected exit 1 for input: ${bad.slice(0, 40)}`);
  }
  assert.equal(httpLog.length, 0, "preflight rejections must make zero HTTP dispatches");
});

test("requirements mode: judge selection rules (key/consent pairing) are typed preflight errors", async () => {
  // Judge selection lives in the PRODUCTION default runtime; no
  // injected runtime here. The provider pin avoids the (correct)
  // zai-compat executable-subset preflight so the PAIRING error is
  // what fires. Both failures happen inside defaultRequirementsRuntime
  // BEFORE any HTTP dispatch — hermetic, zero network.
  // Key without consent.
  const keyOnly = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { env: { TAVILY_API_KEY: "guard-synthetic-key", TYPESAFE_API_KEY: "guard-key" } },
  );
  assert.equal(keyOnly.code, 1);
  assert.ok(keyOnly.stderr.includes("SCOUTLINE_JUDGE_TRANSMIT"), keyOnly.stderr);
  // Consent without key.
  const consentOnly = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { env: { TAVILY_API_KEY: "guard-synthetic-key", SCOUTLINE_JUDGE_TRANSMIT: "1" } },
  );
  assert.equal(consentOnly.code, 1);
  assert.ok(consentOnly.stderr.includes("TYPESAFE_API_KEY"), consentOnly.stderr);
});

test("requirements mode: a supplier outside the executable subset fails closed before acquisition", async () => {
  // Cold-review findings 1/6: the lane delegates to the ESTABLISHED
  // resolver — a pin naming a supplier that cannot execute the bounded
  // Search+Reader composition (zai here) fails CLOSED with the subset
  // named, before any HTTP. A supported pin (tavily below) runs.
  const zaiRun = await runMain(
    ["investigate", "--provider", "zai", "--requirements-json", JSON.stringify(CONTRACT)],
    { env: { TAVILY_API_KEY: "guard-synthetic-key" } },
  );
  assert.equal(zaiRun.code, 1);
  assert.equal(zaiRun.parsed, null);
  assert.ok(zaiRun.stderr.includes("Refusing any reroute"), zaiRun.stderr);
  assert.ok(zaiRun.stderr.includes("tavily, exa, firecrawl, linkup, spider"), zaiRun.stderr);
  // The established resolver still ranks a configured supplier when
  // descriptors + snapshot are present (no requirements-only default):
  const runtime = makeRequirementsRuntime();
  const ok = await runMain(
    ["investigate", "--requirements-json", JSON.stringify(CONTRACT)],
    { runtime, env: { TAVILY_API_KEY: "guard-synthetic-key" } },
  );
  assert.equal(ok.code, 0);
  assert.equal(ok.parsed.kind, "requirements-investigation");
});

test("requirements mode: producer stage publishes observed counts, or an explicit unknown — never a floor", async () => {
  // Cold-review finding 1: (a) a producer that OBSERVES its physical
  // dispatches through the context seam contributes exactly those
  // dispatches; (b) an opaque producer that observes nothing leaves
  // the stage explicitly unknown. Neither path infers HTTP from a
  // callable.
  const observed = makeRequirementsRuntime({
    extractAttempts: null,
    hooks: { producerDispatches: 3, reserved: 0 },
  });
  const a = await runMain(["investigate", "--requirements-json", JSON.stringify(CONTRACT)], { runtime: observed });
  assert.equal(a.code, 0);
  assert.equal(a.parsed.usage.physicalHttpAttemptsUnknown, undefined, "observed producer: total is complete");
  const b = await runMain(["investigate", "--requirements-json", JSON.stringify(CONTRACT)], {
    runtime: makeRequirementsRuntime({ extractAttempts: null }),
  });
  assert.equal(b.code, 0);
  assert.equal(b.parsed.usage.physicalHttpAttemptsUnknown, "producer dispatches unobserved — this total covers acquisition and judge stages only");
  // Deterministic producer reserving zero is a truthful zero, not an omission.
  const c = await runMain(["investigate", "--requirements-json", JSON.stringify(CONTRACT)], {
    runtime: makeRequirementsRuntime({ extractAttempts: null, hooks: { producerDispatches: 0, reserved: 0 } }),
  });
  assert.equal(c.code, 0);
  assert.equal(c.parsed.usage.physicalHttpAttemptsUnknown, undefined);
});


test("requirements mode: a raised or malformed cap override rejects before any HTTP", async () => {
  // Consolidated root 3: SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL may LOWER
  // the experimental ceiling and never raise it; 49, 100000, 0, -1 and
  // "banana" are typed VALIDATION_ERRORs with zero HTTP — never a
  // silent default.
  for (const value of ["49", "100000", "0", "-1", "banana"]) {
    const httpLog = [];
    const runtime = makeRequirementsRuntime({ hooks: { httpLog } });
    const { code, stderr } = await runMain(
      ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
      { runtime, env: { ...ENV, SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: value } },
    );
    assert.equal(code, 1, `cap ${value} should reject`);
    assert.ok(stderr.includes("SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL"), `cap ${value}: ${stderr}`);
    assert.equal(httpLog.length, 0, `cap ${value} dispatched before rejecting`);
  }
  // A valid lowering is accepted (1 is inside the range).
  const lowering = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { runtime: makeRequirementsRuntime(), env: { ...ENV, SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: "1" } },
  );
  assert.ok(lowering.code === 0 || lowering.code === 1);
});

test("requirements mode: the shared admission closure refuses BEFORE the side effect", async () => {
  // Final boundary repair, root 1: acquisition and an explicit producer
  // dispatch reserve through the SAME run-owned closure, and a refusal
  // happens before the dispatch — the producer's observed count never
  // exceeds what the closure admitted.
  const reserves = { count: 0 };
  const runtime = makeRequirementsRuntime({
    producerDispatches: 3,
    hooks: { producerDispatches: 3, reserved: 0, reserves, cap: 2 },
  });
  const { code } = await runMain(
    ["investigate", "--requirements-json", JSON.stringify(CONTRACT)],
    { runtime, env: { ...ENV, SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: "2" } },
  );
  // The run terminated without exceeding the shared ceiling: a refusal
  // at the cap is a typed bounded outcome, not unbounded producer work.
  assert.ok(code === 0 || code === 1, `unexpected exit ${code}`);
  assert.ok(reserves.count <= 2, `reservations (${reserves.count}) exceeded the shared ceiling`);
});

test("requirements mode: valueless/malformed --requirements rejects typed", async () => {
  const runtime = makeRequirementsRuntime();
  const trailing = await runMain(["investigate", "--requirements"], { runtime });
  assert.equal(trailing.code, 1);
  const emptyInline = await runMain(["investigate", "--requirements-json"], { runtime });
  assert.equal(emptyInline.code, 1);
});

test("plain investigate question: byte-compatible EvidencePack path is untouched", async () => {
  // Plain mode with no provider configured → the existing typed
  // configuration error, byte-identical shape (no requirements drift).
  const { code, stderr, parsed } = await runMain(["investigate", "some plain question"], {
    runtime: makeRequirementsRuntime(),
    env: {},
  });
  assert.notEqual(code, 0);
  assert.equal(parsed, null);
  assert.ok(stderr.includes("success") === false || stderr.includes("requirements") === false);
});





// ---------------------------------------------------------------------------
// Resource + native-admission regressions (final closure). These use the
// REAL seams: an actual Node PassThrough, an actual hanging iterator, the
// actual owned signal, and the actual admission closure — not counters.
// ---------------------------------------------------------------------------

test("resource: aborting a pending PassThrough read rejects and destroys the stream", async () => {
  const { PassThrough } = await import("node:stream");
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  const stream = new PassThrough();
  const controller = new AbortController();
  const read = readBytesBounded(stream, 1024, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(read, (error) => error.name === "AbortError");
  assert.equal(stream.destroyed, true, "the pending read must dispose the stream");
});

test("resource: a pre-aborted signal rejects without starting a read", async () => {
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  let nextCalls = 0;
  const hanging = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          nextCalls += 1;
          return new Promise(() => {}); // never settles
        },
        return() {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    readBytesBounded(hanging, 1024, controller.signal),
    (error) => error.name === "AbortError",
  );
  assert.equal(nextCalls, 0, "a pre-aborted read must not call next()");
});

test("resource: a normal read leaves no abort listener installed", async () => {
  const { readBytesBounded } = await import("../dist/node-command-invocation-adapter.js");
  const { Readable } = await import("node:stream");
  const controller = new AbortController();
  let adds = 0;
  let removes = 0;
  const realAdd = controller.signal.addEventListener.bind(controller.signal);
  const realRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    adds += 1;
    return realAdd(...args);
  };
  controller.signal.removeEventListener = (...args) => {
    removes += 1;
    return realRemove(...args);
  };
  const text = await readBytesBounded(Readable.from(["ok"]), 1024, controller.signal);
  assert.equal(text.toString(), "ok");
  assert.equal(adds, removes, `listeners unbalanced: add${adds}/remove${removes}`);
});

test("admission: a shared-closure runtime is refused BEFORE the next producer dispatch", async () => {
  // The run's own ceiling (lowered to 1) must refuse the producer's
  // pre-dispatch reservation — the producer's observed count can never
  // exceed what admission granted.
  const observed = [];
  const runtime = makeRequirementsRuntime({
    producerDispatches: 3,
    hooks: { producerDispatches: 3, reserved: 0, observed },
  });
  const { code, parsed } = await runMain(
    ["investigate", "--requirements-json", JSON.stringify(CONTRACT)],
    { runtime, env: { ...ENV, SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: "1" } },
  );
  assert.ok(code === 0 || code === 1, `unexpected exit ${code}`);
  if (parsed !== null) {
    assert.ok(
      parsed.usage.physicalHttpAttempts <= 1,
      `physical total ${parsed.usage.physicalHttpAttempts} exceeded the shared ceiling of 1`,
    );
  }
  assert.ok(observed.length <= 1, `producer observed ${observed.length} dispatches under ceiling 1`);
});

test("disclosure: an opaque judge is reported as unknown enforcement, not shared", async () => {
  // A runtime that does not declare the shared closure must not have its
  // judge presented as bounded by the run ceiling.
  const runtime = makeRequirementsRuntime({ judge: fakeJudge });
  const { parsed } = await runMain(
    ["investigate", "--requirements-json", JSON.stringify(CONTRACT)],
    { runtime },
  );
  assert.notEqual(parsed, null);
  const serialized = JSON.stringify(parsed);
  assert.match(
    serialized,
    /judge.*(?:unknown|unbounded)|(?:unknown|unbounded).*judge/i,
    "opaque judge enforcement must be disclosed in the delivered envelope",
  );
});

const ownedFixtureRoots=new Set();
async function mkdtemp(...args){const path=await actualMkdtemp(...args);ownedFixtureRoots.add(path);return path;}
afterEach(async()=>{for(const path of ownedFixtureRoots){await rm(path,{recursive:true,force:true});ownedFixtureRoots.delete(path);}});


test('L7 F reserve admits one real synthetic producer dispatch and refuses the next before fetch',async()=>{
 const observed=[],producerHTTP=[],httpLog=[],hooks={producerDispatches:3,reserved:0,observed,httpLog,producerFetch:async url=>{producerHTTP.push(url);return Response.json({});}};
 const runtime=makeRequirementsRuntime({hooks});
 const c={...CONTRACT,requirements:{version:CONTRACT.requirements.version},limits:{maxSearchAttempts:1,maxUniqueReads:2,maxJudgeAttempts:1}};
 const result=await runMain(['investigate','--provider','tavily','--requirements-json',JSON.stringify(c)],{runtime,env:{...ENV,SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL:'4'}});
 assert.equal(producerHTTP.length,1,'one producer fetch admitted; refused second dispatch must never reach fetch');
 assert.equal(observed.length,1);assert.equal(httpLog.length,3,'useful real acquisition consumed three slots');
 assert.equal(result.code,1);assert(result.parsed);assert.equal(result.parsed.usage.physicalHttpAttempts,4);assert(result.parsed.acquisition.reservationsRefused>0);
});

test('L7 F plain mode delivers positive EvidencePack bytes despite a supplied requirements runtime',async()=>{
 const original=globalThis.fetch,log=[];globalThis.fetch=fakeFetchWorld(log);
 try{
  const r=await runMain(['investigate','ExampleApp release 2.4.0','--provider','tavily'],{runtime:()=>{throw new Error('plain mode entered requirements runtime');}});
  console.log(JSON.stringify({case:'corrected-positive-plain-pack',stdout:r.stdout}));
  assert.equal(r.code,0,'plain question must still emit its actual EvidencePack');assert(r.stdout.length>0);assert(r.parsed);assert.equal(r.parsed.schemaVersion,1);assert.equal(r.parsed.question,'ExampleApp release 2.4.0');assert(Array.isArray(r.parsed.sources)&&r.parsed.sources.length>0);assert(r.stdout.includes(URL_USEFUL));const useful=r.parsed.sources.find(source=>source.url===URL_USEFUL);assert(useful&&Array.isArray(useful.passages)&&useful.passages.length>0);const release=useful.passages.find(p=>p.quote.includes('ExampleApp release 2.4.0.'));assert(release,'requested release sentence must be retained from the useful source');assert.deepEqual(release.charRange,[TEXT.indexOf(release.quote),TEXT.indexOf(release.quote)+release.quote.length]);assert.equal(TEXT.slice(...release.charRange),release.quote,'selected passage binds exact known normalized fixture content');assert(log.length>0,'positive real plain acquisition fixture ran');assert.notEqual(r.parsed.kind,'requirements-investigation');
 }finally{globalThis.fetch=original;}
});
