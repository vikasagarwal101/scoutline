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
 * bad JSON, byte ceiling), judge selection rules (absent consent =
 * deterministic-only; consent without the selected key = typed error),
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
import "./helpers/caller-review-harness.mjs";

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


// Capture actual return values before any assertion can discard a counterfactual witness.
const assertionErrorDocument = text => { try { return JSON.parse(text.trim().split('\n').at(-1)); } catch { return null; } };
const assertionStdout = text => { try { return {envelope: JSON.parse(text), parseError: null}; } catch(error) { return {envelope: null, parseError: error.message}; } };
const assertionSnapshot = (purpose, observed) => console.log(JSON.stringify({assertionEvidence: 1, purpose, ...observed}));

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
  return { code, stdout: text, stderr: stderr.join(""), stderrChunks: [...stderr], parsed };
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
  const failures=[];
  for (const [row,c] of conflicts.entries()) {
    const result = await runMain(c.argv, { runtime, stdin: c.stdin ?? "" });
    const error=assertionErrorDocument(result.stderr);
    assertionSnapshot('conflict',{row,argv:c.argv,...result,error,httpLog:[...httpLog],httpCount:httpLog.length});
    try {
      assert.equal(result.code, 1, `expected typed exit 1 for ${c.argv.join(" ")}`);
      assert.equal(result.stdout,'');assert.equal(error?.success,false);assert.equal(error?.code,'VALIDATION_ERROR');
      const reason=row===0?'--requirements and --requirements-json are mutually exclusive.':row===1?"investigate --requirements does not accept a positional question; the requirements document's question is authoritative.":`--${['verify','synthesize','sources','max-chars','context'][row-2]} is a plain-mode (EvidencePack) control and cannot combine with --requirements.`;
      assert.equal(error.error,reason);assert.equal(httpLog.length,0,'no HTTP on row '+row);
    } catch(error) { failures.push(new Error(c.argv.join(' '),{cause:error})); }
  }
  if(failures.length) throw new AggregateError(failures,'mode conflict rows failed');
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

test("requirements mode: judge selection rules refuse typed, and a bare credential stays inert", async () => {
  // Judge selection lives in the PRODUCTION default runtime; no
  // injected runtime here. The provider pin avoids the (correct)
  // zai-compat executable-subset preflight so the SELECTION error is
  // what fires. Every refusal happens inside defaultRequirementsRuntime
  // BEFORE any HTTP dispatch — hermetic, zero network.
  //
  // MIGRATION (dual-route Jev): a credential ALONE no longer refuses —
  // credentials are not consent, so they stay inert and the run is
  // deterministic-only. Consent without the SELECTED route's
  // credential refuses, and the legacy direct-TypeSafe pair without an
  // explicit route no longer selects the direct route (OpenRouter is
  // the public default, so the direct key cannot authenticate it).
  const consentOnly = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { env: { TAVILY_API_KEY: "guard-synthetic-key", SCOUTLINE_JUDGE_TRANSMIT: "1" } },
  );
  assert.equal(consentOnly.code, 1);
  assert.ok(consentOnly.stderr.includes("SCOUTLINE_JUDGE"), consentOnly.stderr);
  // Legacy direct pair without an explicit route: no silent route
  // guess by credential presence.
  const legacyPair = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { env: { TAVILY_API_KEY: "guard-synthetic-key", TYPESAFE_API_KEY: "guard-key", SCOUTLINE_JUDGE_TRANSMIT: "1" } },
  );
  assert.equal(legacyPair.code, 1);
  assert.ok(legacyPair.stderr.includes("SCOUTLINE_JUDGE"), legacyPair.stderr);
  // An unsupported own judge control is REFUSED, never accepted and
  // dropped.
  const unsupported = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { env: { TAVILY_API_KEY: "guard-synthetic-key", SCOUTLINE_JUDGE_ENDPOINT: "https://elsewhere.test/v1" } },
  );
  assert.equal(unsupported.code, 1);
  assert.ok(unsupported.stderr.includes("SCOUTLINE_JUDGE_ENDPOINT"), unsupported.stderr);
  // The legacy direct override pair is refused as well.
  const legacyOverride = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { env: { TAVILY_API_KEY: "guard-synthetic-key", TYPESAFE_MODEL: "jev-1.13.0" } },
  );
  assert.equal(legacyOverride.code, 1);
  assert.ok(legacyOverride.stderr.includes("TYPESAFE_MODEL"), legacyOverride.stderr);
  // A credential WITHOUT consent is inert: no refusal, no judge work.
  const keyOnly = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { env: { TAVILY_API_KEY: "guard-synthetic-key", TYPESAFE_API_KEY: "guard-key" } },
  );
  assert.equal(keyOnly.code, 1);
  assert.ok(keyOnly.parsed, `expected the deterministic envelope: ${keyOnly.stderr}`);
  assert.equal(keyOnly.parsed.assessment, "deterministic-only");
  assert.equal(keyOnly.parsed.usage.judgeCalls, 0);
  assert.equal(keyOnly.parsed.usage.candidateJudgeCalls, 0);
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
  const loweringHTTP=[];
  const lowering = await runMain(
    ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(CONTRACT)],
    { runtime: makeRequirementsRuntime({hooks:{httpLog:loweringHTTP}}), env: { ...ENV, SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: "1" } },
  );
  assertionSnapshot('cap',{...lowering,httpLog:loweringHTTP,httpCount:loweringHTTP.length,ledgerLength:lowering.parsed?.acquisition?.physicalAttempts?.length??null,physicalTotal:lowering.parsed?.usage?.physicalHttpAttempts??null,judgeTelemetryUnknown:lowering.parsed?.usage?.judgeTelemetryUnknown??null,physicalHttpAttemptsUnknown:lowering.parsed?.usage?.physicalHttpAttemptsUnknown??null,parseError:assertionStdout(lowering.stdout).parseError});
  const n=loweringHTTP.length;assert.ok(n>0&&n<=1,'actual acquisition dispatches must be positive and <=1');
  assert.ok(lowering.parsed);assert.equal(lowering.parsed.kind,'requirements-investigation');assert.equal(lowering.parsed.schemaVersion,1);assert.equal(lowering.parsed.question,CONTRACT.question);
  assert.ok(Array.isArray(lowering.parsed.acquisition.physicalAttempts));// Refused/not-started audit rows did not dispatch.
  assert.equal(lowering.parsed.acquisition.physicalAttempts.filter(row=>row.outcome!=="refused"&&row.outcome!=="not-started").length,n);
  const usage=lowering.parsed.usage;assert.ok(Number.isSafeInteger(usage.physicalHttpAttempts)&&usage.physicalHttpAttempts>=n);
  if(usage.judgeTelemetryUnknown===undefined&&usage.physicalHttpAttemptsUnknown===undefined)assert.ok(usage.physicalHttpAttempts<=1);
  assert.doesNotMatch(lowering.stderr,/SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL/);
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

test("plain investigate question: no-provider error preserves the plain route", async () => {
  const factory=makeRequirementsRuntime();let factoryCalls=0;
  const result=await runMain(["investigate", "some plain question"],{
    runtime:context=>{factoryCalls++;return factory(context);},env:{},
  });
  const error=assertionErrorDocument(result.stderrChunks.at(-1)??'');
  assertionSnapshot('plain',{...result,error,factoryCalls});
  assert.equal(factoryCalls,0,'plain route must not construct a requirements runtime');
  assert.equal(result.stdout,'');assert.notEqual(result.code,0);assert.equal(result.parsed,null);
  assert.equal(result.code,1);assert.equal(error?.success,false);assert.equal(error?.code,'UNSUPPORTED_CAPABILITY');
  assert.equal(error.error,'Provider "(none)" does not support capability "search"');
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

test('PR291 G present empty physical cap refuses before runtime composition', async () => {
  let composed = 0;
  const r = await runMain(['investigate', '--requirements-json', JSON.stringify(CONTRACT)], {
    env: { ...ENV, SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL: '' },
    runtime: context => { composed++; return makeRequirementsRuntime({withJudge:false})(context); },
  });
  assert.equal(r.stdout, '');
  assert.equal(JSON.parse(r.stderr).code, 'VALIDATION_ERROR');
  assert.match(JSON.parse(r.stderr).error, /SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL must be a base-10 integer/);
  assert.equal(composed, 0);
});

test('PR291 G caller rejects positive cache and output tokens before input', async () => {
  for (const flags of [['--cache'], ['--cache','--no-cache'], ['--output','result.json'], ['--no-output']]) {
    const {adapter, stdout, stderr} = makeAdapter(); let reads = 0, config = 0, runtime = 0;
    adapter.readStdin = async () => { reads++; return '{}'; };
    const code = await main(['investigate','--caller-request','-',...flags], hermeticMainDeps({
      invocation:adapter, env:{}, loadScoutlineConfig:async()=>{config++;return {version:1,providers:{}};},
      requirementsRuntime:()=>{runtime++;throw new Error('unexpected runtime');},
    }));
    assert.equal(code, 1); assert.equal(stdout.join(''), '');
    assert.equal(reads, 0, 'unsupported '+flags.join(' ')+' must refuse before input');
    assert.equal(config, 0); assert.equal(runtime, 0);
    assert.equal(JSON.parse(stderr.join('')).code, 'VALIDATION_ERROR');
    assert.match(JSON.parse(stderr.join('')).error, /cannot combine with caller-assisted operations/);
  }
});

test('PR291 G requirements main forwards its injected clock', async () => {
  const {adapter} = makeAdapter(); let calls = 0;
  const code = await main(['investigate','--requirements-json',JSON.stringify(CONTRACT)],hermeticMainDeps({
    invocation:adapter, env:{...ENV}, now:()=>{calls++;return 12345;},
    requirementsRuntime:makeRequirementsRuntime({withJudge:false}),
  }));
  assert.ok([0,1].includes(code));
  assert.ok(calls > 0, 'requirements engine must receive the main invocation clock');
});

// Exercise the real public runtime wrapper; injected opaque collaborators are
// system boundaries. The final result still comes from the actual engine.
async function pr291Telemetry({extractRows=[],declared,observer=false,judgeRows=[],candidateRows=[],native=true,afterCalls,executeError,emptyAcquisition=false}={}) {
  const {withRequirementsRuntime}=await import('../dist/commands/investigate-requirements.js');
  const {runLeanInvestigation}=await import('../dist/lib/lean-investigation.js');
  let extracts=0,judges=0,candidates=0,entered=0,releases=0,interrupt;const caught=[];
  const settle=row=>{if(row?.reject)throw row.value;return row?.value;};
  const base=makeRequirementsRuntime({withJudge:false});
  const runtime=context=>({...base(context),...(observer?{producerPhysical:{reserve:()=>{}}}:{}),engineDeps:{
    judge:judgeRows.length?async()=>settle(judgeRows[judges++]):null,
    candidateJudge:candidateRows.length?async()=>settle(candidateRows[candidates++]):null,
    extract:async()=>settle(extractRows[extracts++]),
    ...(declared!==undefined?{declaredProducerAttempts:declared}:{}),
  }});
  const result=await withRequirementsRuntime(CONTRACT,{readFile:async()=>{throw new Error('no input');},readStdin:async()=>{throw new Error('no input');},now:()=>0,requirementsRuntime:runtime,registerUserInterrupt:fn=>{interrupt=fn;return()=>{releases++;};}},
    {env:{...ENV},provider:'tavily',noCache:true,cache:{get:async()=>null,set:async()=>{}},sleep:async()=>{},random:()=>0},
    async(input,unified,observation)=>{entered++;for(const [rows,fn] of [[extractRows,unified.extract],[judgeRows,unified.judge],[candidateRows,unified.candidateJudge]])for(const _row of rows){try{await fn({fields:[]});}catch(e){caught.push(e);}}
      await afterCalls?.({interrupt,caught,unified,observation});if(executeError!==undefined)throw executeError;
      const result=await runLeanInvestigation(input,{...unified,extract:undefined,judge:null,candidateJudge:null,...(emptyAcquisition?{search:async()=>[]}: {})});
      return {result,value:{snapshot:native?observation():null,caught,extracts,judges,candidates,entered}};
    });
  return {...result,releases};
}
for(const [name,extractRows] of [
  ['reported then missing',[{value:{attempts:3}},{value:{}}]],
  ['missing then reported',[{value:{}},{value:{attempts:3}}]],
  ['reported then missing rejection',[{value:{attempts:3}},{reject:true,value:new Error('opaque rejection')}]],
])test('PR291 B producer unknown is monotonic: '+name,async()=>{
  const r=await pr291Telemetry({extractRows}),snapshot=r.value.snapshot,usage=r.projected.data.usage;
  assert.equal(r.value.extracts,2);assert.match(usage.physicalHttpAttemptsUnknown,/producer/);
  assert.equal(snapshot.stages.producer,null);assert.equal(snapshot.total,null);
  assert.equal(snapshot.knownSubtotal,snapshot.stages.acquisition,'caller subset excludes unknown-stage prefix');
  assert.equal(usage.physicalHttpAttempts,snapshot.stages.acquisition+3,'requirements retains measured prefix');assert.equal(r.releases,1);
});

const pr291Malformed=e=>e?.code==='VALIDATION_ERROR'&&e.message==='Invalid physical-attempt measurement; counts must be nonnegative safe integers.';
test('PR291 C declaration counts each actual producer settlement',async()=>{
  const r=await pr291Telemetry({declared:2,extractRows:[{value:{}},{reject:true,value:new Error('opaque producer failure')}]});
  assert.equal(r.value.extracts,2);assert.equal(r.value.snapshot.stages.producer,4);assert.equal(r.value.snapshot.total,r.value.snapshot.stages.acquisition+4);assert.equal(r.projected.data.usage.physicalHttpAttemptsUnknown,undefined);
});
for(const stage of ['judgeRows','candidateRows'])test('PR291 C rejected malformed '+stage+' remains typed after absorption',async()=>{
  await assert.rejects(pr291Telemetry({[stage]:[{reject:true,value:Object.assign(new Error('untrusted payload'),{attempts:1.5})}]}),pr291Malformed);
});
test('PR291 C native unrepresentable measurement is typed before observation',async()=>{
  await assert.rejects(pr291Telemetry({extractRows:[{value:{attempts:100001}}],emptyAcquisition:true}),e=>e?.code==='VALIDATION_ERROR'&&e.message==='Physical-attempt measurement exceeds the caller native bound of 100000.');
});

function pr291EngineFault(stage,{malformed=true,cancel=true}={}) {
  let delivered=false,interrupted=false,interrupt,calls=0,releases=0;
  const now=()=>{if(delivered&&cancel&&!interrupted){interrupted=true;interrupt();}return 0;};
  const base=makeRequirementsRuntime(),runtime=context=>{
    const composed=base(context),key=stage==='classification'?'judge':'candidateJudge',original=composed.engineDeps[key];
    return {...composed,engineDeps:{...composed.engineDeps,[key]:async input=>{calls++;const response=await original(input);delivered=true;return {...response,attempts:malformed?1.5:1};}}};
  };
  const requirements={schemaVersion:1,question:'ExampleApp release?',requirements:stage==='classification'?{csv:CONTRACT.requirements.csv}:{version:CONTRACT.requirements.version},limits:{maxSearchAttempts:1,maxUniqueReads:2,maxJudgeAttempts:2}};
  return {requirements,runtime,now,register:fn=>{interrupt=fn;return()=>{releases++;};},counts:()=>({calls,releases,interrupted})};
}
for(const stage of ['classification','candidate'])for(const malformed of [true,false])test('PR291 D actual requirements settlement '+stage+' malformed='+malformed,async()=>{
  const x=pr291EngineFault(stage,{malformed}),{adapter,stdout,stderr}=makeAdapter();
  const code=await main(['investigate','--requirements-json',JSON.stringify(x.requirements)],hermeticMainDeps({env:{...ENV},invocation:adapter,requirementsRuntime:x.runtime,now:x.now,requirementsUserInterrupt:x.register}));
  assert.equal(stdout.join(''),'');const error=JSON.parse(stderr.join(''));
  assert.ok(x.counts().calls>0);assert.equal(x.counts().interrupted,true,'actual engine consulted clock after collaborator settled');assert.equal(x.counts().releases,1);
  if(malformed){assert.equal(code,1);assert.equal(error.code,'VALIDATION_ERROR');assert.equal(error.error,'Invalid physical-attempt measurement; counts must be nonnegative safe integers.');}
  else {assert.equal(code,130);assert.match(error.error,/interrupted/);}
});
for(const stage of ['classification','candidate'])for(const cancel of [false,true])test('PR291 D actual native continuation fences '+stage+' cancel='+cancel,async()=>{
  const {sandbox}=await import('./helpers/caller-review-harness.mjs'),{executeCallerInvestigation}=await import('../dist/lib/caller-investigation.js'),{handleInvestigateCaller}=await import('../dist/commands/investigate-caller.js'),{readCallerRecord}=await import('../dist/lib/lean-caller-rounds.js'),{openStore}=await import('../dist/lib/retained-record-store.js');
  const s=await sandbox(),x=pr291EngineFault(stage,{cancel}),storeRoot=s.env.SCOUTLINE_INVESTIGATIONS_DIR;
  const made=await executeCallerInvestigation({schemaVersion:1,operation:'start',requirements:x.requirements,dataScope:'synthetic',representations:[{format:'text',content:TEXT,label:'D retained native source'}]},{storeRoot,deps:{search:async()=>[],read:async()=>{throw new Error('no setup read');},judge:null,now:()=>0}});
  const before=await readCallerRecord(storeRoot,made.investigationRef);
  await assert.rejects(handleInvestigateCaller({schemaVersion:1,operation:'continue',investigationRef:made.investigationRef,expectedRevision:made.revision,dataScope:'synthetic'},storeRoot,{readFile:async()=>{throw new Error('no file');},readStdin:async()=>{throw new Error('no stdin');},now:x.now,requirementsRuntime:x.runtime,registerUserInterrupt:x.register},{env:{...ENV},provider:'tavily',noCache:true,cache:{get:async()=>null,set:async()=>{}},sleep:async()=>{},random:()=>0}),pr291Malformed);
  const after=await readCallerRecord(storeRoot,made.investigationRef);assert.equal(after.revision,before.revision);assert.deepEqual(after.payload,before.payload,'failed publication must retain the complete prior result view');assert.ok(x.counts().calls>0);assert.equal(x.counts().interrupted,cancel);assert.equal(x.counts().releases,1);
  const handle=await openStore({root:storeRoot}).acknowledgeInterrupted(made.investigationRef);let records=[];
  try {let cursor;do{const page=await handle.readRecoveryPage(cursor?{cursor}:{});records.push(...page.records);cursor=page.cursor;}while(cursor);}finally{await handle.release();}
  assert(records.some(r=>r.publicationState==='unpublished'&&r.work.status==='failed'&&r.work.measured?.judgments>0),'actual failed native settlement retains paid logical judge work and releases ownership');
});

test('PR291 compatibility C selected telemetry table on all success and rejection seams',async()=>{
  const symbol=Symbol.for('leanJevAttemptMeta');
  const rows=[
    ['direct zero',{attempts:0},0],['direct count',{attempts:2},2],['absent',{},null],['direct null',{attempts:null},null],['direct undefined',{attempts:undefined},null],
    ['symbol authoritative',{[symbol]:{attempts:3},attempts:9},3],['symbol null suppresses direct',{[symbol]:{attempts:null},attempts:9},null],['symbol undefined suppresses direct',{[symbol]:{attempts:undefined},attempts:9},null],['symbol empty falls back',{[symbol]:{},attempts:2},2],
  ];
  for(const [label,value,count] of rows)for(const stage of ['extractRows','judgeRows','candidateRows'])for(const reject of [false,true]){
    const r=await pr291Telemetry({[stage]:[{value,reject}],emptyAcquisition:true}),snap=r.value.snapshot,key=stage==='extractRows'?'producer':'judge';
    assert.equal(snap.stages[key],count,label+' '+stage+' reject='+reject);
    assert.equal(r.projected.data.usage.physicalHttpAttempts,count??0,'each selected count joins once');
    if(reject)assert.equal(r.value.caught[0],value,'original rejected carrier identity');
  }
  const bad=[-1,0.5,'2',NaN,Infinity,Number.MAX_SAFE_INTEGER+1,true,{},Symbol('opaque')].map(attempts=>({attempts}));
  for(const meta of [null,1,'opaque',[],()=>{}])bad.push({[symbol]:meta});
  bad.push(Object.defineProperty({},'attempts',{get(){throw new Error('untrusted getter payload');}}));
  bad.push(Object.defineProperty({},symbol,{get(){throw new Error('untrusted symbol getter payload');}}));
  bad.push({[symbol]:Object.defineProperty({},'attempts',{get(){throw new Error('untrusted nested getter payload');}})});
  for(const value of bad)for(const stage of ['extractRows','judgeRows','candidateRows'])for(const reject of [false,true])await assert.rejects(pr291Telemetry({[stage]:[{value,reject}],emptyAcquisition:true}),pr291Malformed,stage+' reject='+reject);
  for(const value of ['original primitive rejection',null,undefined,17]){
    const r=await pr291Telemetry({judgeRows:[{value,reject:true}],emptyAcquisition:true});assert.equal(r.value.caught[0],value);assert.equal(r.value.snapshot.stages.judge,null);
  }
});
test('PR291 compatibility C declarations, observers and no-call accounting',async()=>{
  for(const declared of [0,3])for(const calls of [0,1,2]){
    const r=await pr291Telemetry({declared,extractRows:Array.from({length:calls},(_,i)=>i%2?{value:new Error('original failure'),reject:true}:{value:{attempts:declared}}),emptyAcquisition:true});
    assert.equal(r.value.snapshot.stages.producer,declared*calls);assert.equal(r.projected.data.usage.physicalHttpAttempts,declared*calls);assert.equal(r.projected.data.admission.producer,'unknown','measurement is not admission');
  }
  for(const declared of [-1,0.5,'2',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(pr291Telemetry({declared}),pr291Malformed);
  await assert.rejects(pr291Telemetry({declared:2,extractRows:[{value:{attempts:3}}]}),e=>e.code==='VALIDATION_ERROR'&&e.message==='Conflicting producer physical-attempt measurements.');
  await assert.rejects(pr291Telemetry({declared:2,extractRows:[{value:{attempts:NaN}}]}),pr291Malformed);
  let entered=false;await assert.rejects(pr291Telemetry({declared:0,observer:true,afterCalls:()=>{entered=true;}}),e=>e.code==='VALIDATION_ERROR'&&e.message==='Declared producer measurement cannot combine with a configured producer observer.');assert.equal(entered,false,'configured observer-zero conflict refuses before engine callback');
  const zero=await pr291Telemetry({observer:true,extractRows:[{value:{}}],emptyAcquisition:true});assert.equal(zero.value.snapshot.stages.producer,0);assert.equal(zero.value.snapshot.total,0);assert.equal(zero.projected.data.admission.producer,'shared');
  const measured=await pr291Telemetry({extractRows:[{value:{attempts:2}},{value:{attempts:3},reject:true}],emptyAcquisition:true});assert.equal(measured.value.snapshot.stages.producer,5);assert.equal(measured.value.snapshot.total,5);
});
test('PR291 compatibility C safe sums, native limit and first-fault precedence',async()=>{
  const overflow=e=>e?.code==='VALIDATION_ERROR'&&e.message==='Physical-attempt measurement exceeds the safe-integer bound.';
  const representable=e=>e?.code==='VALIDATION_ERROR'&&e.message==='Physical-attempt measurement exceeds the caller native bound of 100000.';
  const exact=await pr291Telemetry({extractRows:[{value:{attempts:100000}}],emptyAcquisition:true});assert.equal(exact.value.snapshot.total,100000);
  const large=await pr291Telemetry({extractRows:[{value:{attempts:100001}}],native:false,emptyAcquisition:true});assert.equal(large.projected.data.usage.physicalHttpAttempts,100001);
  const max=await pr291Telemetry({extractRows:[{value:{attempts:Number.MAX_SAFE_INTEGER}}],native:false,emptyAcquisition:true});assert.equal(max.projected.data.usage.physicalHttpAttempts,Number.MAX_SAFE_INTEGER);
  for(const stage of ['extractRows','judgeRows','candidateRows'])await assert.rejects(pr291Telemetry({[stage]:[{value:{attempts:Number.MAX_SAFE_INTEGER}},{value:{attempts:1}}],native:false,emptyAcquisition:true}),overflow);
  await assert.rejects(pr291Telemetry({extractRows:[{value:{attempts:Number.MAX_SAFE_INTEGER}}],judgeRows:[{value:{attempts:1}}],native:false,emptyAcquisition:true}),overflow);
  await assert.rejects(pr291Telemetry({judgeRows:[{value:{attempts:NaN}}],executeError:new Error('later execute failure')}),pr291Malformed);
  await assert.rejects(pr291Telemetry({extractRows:[{value:{attempts:100001}}],judgeRows:[{value:{attempts:NaN}}],emptyAcquisition:true}),pr291Malformed);
  const judgeRows=[{value:{attempts:0}}];await assert.rejects(pr291Telemetry({extractRows:[{value:{attempts:100001}}],judgeRows,emptyAcquisition:true,afterCalls:async({unified,observation})=>{assert.throws(observation,representable);judgeRows.push({value:{attempts:NaN}});try{await unified.judge({});}catch{}throw new Error('later execute failure');}}),representable);
});
test('PR291 compatibility G cap table, no-cache/global flags and clocks',async()=>{
  for(const raw of ['0','49','1.5','banana','-1']){
    let runtime=0;const r=await runMain(['investigate','--requirements-json',JSON.stringify(CONTRACT)],{env:{...ENV,SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL:raw},runtime:()=>{runtime++;throw new Error('no runtime');}});assert.equal(r.stdout,'');assert.equal(JSON.parse(r.stderr).code,'VALIDATION_ERROR');assert.equal(runtime,0);
  }
  for(const cap of [undefined,'1','48']){const r=await runMain(['investigate','--requirements-json',JSON.stringify(CONTRACT)],{env:{...ENV,...(cap===undefined?{}:{SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL:cap})},runtime:makeRequirementsRuntime({withJudge:false})});assert(r.parsed);assert(r.parsed.usage.physicalHttpAttempts<=(cap===undefined?48:Number(cap)));}
  for(const flags of [['--cache=true','--no-cache'],['--output=ignored'],['--no-output']]){
    let reads=0;const {adapter,stderr}=makeAdapter();adapter.readStdin=async()=>{reads++;return '{}';};await main(['investigate','--caller-request','-',...flags],hermeticMainDeps({env:{},invocation:adapter}));assert.equal(reads,0);assert.match(JSON.parse(stderr.join('')).error,/cannot combine with caller-assisted operations/);
  }
  for(const clock of [()=>9000,(()=>{let n=0;return()=>++n;})()]){let calls=0;const {adapter,stdout}=makeAdapter();await main(['investigate','--requirements-json',JSON.stringify(CONTRACT),'--no-cache','--provider','tavily','--output-format','data'],hermeticMainDeps({env:{...ENV},invocation:adapter,requirementsRuntime:makeRequirementsRuntime({withJudge:false}),now:()=>{calls++;return clock();}}));assert(calls>0);assert.equal(JSON.parse(stdout.join('')).kind,'requirements-investigation');}
});
