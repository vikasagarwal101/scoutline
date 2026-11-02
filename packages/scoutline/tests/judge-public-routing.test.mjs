/**
 * Public dual-route judge routing — the actual public paths.
 *
 * Every observation here comes from the COMPILED public surface: the
 * `main()` dispatcher for the requirements lane and
 * `handleInvestigateCaller` for the caller lane, both over a strict fake
 * HTTP surface. Nothing contacts a real model, a real account or a real
 * Provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { main } from "../dist/index.js";
import { handleInvestigateCaller } from "../dist/commands/investigate-caller.js";
import { selectRequirementsJudge } from "../dist/commands/investigate-requirements.js";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const OR_ENDPOINT = "https://openrouter.ai/api/v1/systemone";
const TS_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TAVILY_SEARCH = "https://api.tavily.com/search";
const TAVILY_EXTRACT = "https://api.tavily.com/extract";
/** The finite supported request ids and their metadata-backed resolved ids. */
const RESOLVED_MODELS = {
  "typesafe/jev-1.14": "typesafe/jev-1.14-20261014",
  "typesafe/jev-1.13": "typesafe/jev-1.13-20260917",
  "jev-1.13.0": "jev-1.13.0",
  "jev-1.14.0": "jev-1.14.0",
};
const SOURCE = "ExampleApp release 2.4.0 supports CSV under MIT.";

const REQUIREMENT_CONTRACT = {
  schemaVersion: 1,
  question: "Does ExampleApp support CSV export?",
  scope: { entity: "ExampleApp" },
  requirements: {
    csv: { question: "Does ExampleApp support CSV export?", schema: { enum: ["supported", "refuted", "disputed"] } },
  },
  limits: { maxSearchAttempts: 3, deadlineMs: 5000 },
};

/**
 * The known csv-only caller contract: one independently required enum field.
 * No caller-supplied representation or lead — the acquisition owns the
 * evidence, so the judged evidence set is exactly the acquired one.
 */
const CALLER_CONTRACT = {
  schemaVersion: 1,
  question: "Identify ExampleApp release, license and CSV support.",
  scope: { entity: "ExampleApp", release: "2.4.0" },
  requirements: {
    csv: { question: "Does release 2.4.0 support CSV?", schema: { enum: ["supported", "refuted", "disputed"] } },
  },
};

/**
 * Strict fake HTTP surface: only the approved routes answer, every one of
 * them by POST. An unknown route, method or judge model is REFUSED — never
 * mapped onto a default and never delegated to the real transport. The
 * attempt is recorded before the refusal so a zero-work assertion cannot
 * miss it.
 */
function installFakeFetch(record, { content = SOURCE } = {}) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    const method = init.method ?? "GET";
    const headers = init.headers ?? {};
    const raw = init.body === undefined ? undefined : String(init.body);
    let body;
    try { body = raw === undefined ? undefined : JSON.parse(raw); } catch { body = undefined; }
    const authorization = typeof headers.authorization === "string" ? headers.authorization : undefined;
    const entry = {
      url: target,
      method,
      model: body?.model,
      resolvedModel: undefined,
      authorization,
      authorizationSha256: authorization === undefined ? undefined : createHash("sha256").update(authorization).digest("hex").slice(0, 16),
      questions: body?.questions === undefined ? undefined : Object.keys(body.questions),
      allowFallbacks: body?.provider?.allow_fallbacks,
      // The exact bytes this fixture SERVED on the wire. It is the
      // delivery witness: a marker that never reached the response body
      // cannot be a redaction witness.
      served: undefined,
      refused: undefined,
    };
    record.push(entry);
    const refuse = (why) => {
      entry.refused = why;
      throw new Error(`fixture refused ${target} ${method}: ${why}`);
    };
    if (target === TAVILY_SEARCH) {
      if (method !== "POST") return refuse("Tavily search requires POST");
      entry.served = content;
      return Response.json({ results: [{ title: "ExampleApp release", url: "https://example.test/release", content }] });
    }
    if (target === TAVILY_EXTRACT) {
      if (method !== "POST") return refuse("Tavily extract requires POST");
      const urls = body?.urls ?? ["https://example.test/release"];
      entry.served = content;
      return Response.json({ results: urls.map((url) => ({ url, raw_content: content })), failed_results: [] });
    }
    if (target === OR_ENDPOINT || target === TS_ENDPOINT) {
      if (method !== "POST") return refuse("System One requires POST");
      const requested = body?.model;
      if (!Object.hasOwn(RESOLVED_MODELS, requested)) return refuse(`unknown judge model ${String(requested)}`);
      if (body?.questions === undefined) return refuse("judge request carries no questions");
      const ids = Object.keys(body.questions);
      entry.resolvedModel = RESOLVED_MODELS[requested];
      return Response.json({
        model: RESOLVED_MODELS[requested],
        answers: Object.fromEntries(ids.map((k) => [k, { type: "noul", noul: /[fc]$/.test(k) ? 0.05 : 0.95 }])),
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    }
    return refuse("unapproved route");
  };
  return () => { globalThis.fetch = previous; };
}

const judgeRequests = (record) => record.filter((e) => e.url === OR_ENDPOINT || e.url === TS_ENDPOINT);
const acquisitionRequests = (record) => record.filter((e) => e.url.startsWith("https://api.tavily.com/"));
/** Every recorded attempt that the fixture itself refused. */
const refusedAttempts = (record) => record.filter((e) => e.refused !== undefined);

/** One requirements-lane run through the real dispatcher. */
async function runRequirements({ env, config, loads }) {
  const stdout = [];
  const stderr = [];
  const record = [];
  const restore = installFakeFetch(record);
  try {
    const deps = hermeticMainDeps({
      env,
      loadScoutlineConfig: async () => {
        loads.count += 1;
        return config;
      },
      invocation: {
        stdoutIsTTY: false, stdinIsTTY: false, environmentOutputMode: "data",
        readStdin: async () => "", writeStdout: (s) => stdout.push(s), writeStderr: (s) => stderr.push(s),
        runQuietly: async (fn) => fn(), setExitCode: () => {},
      },
    });
    const code = await main(
      ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(REQUIREMENT_CONTRACT), "--no-cache", "--json"],
      deps,
    );
    const text = stdout.join("");
    // A nonempty expected-JSON stdout is parsed bare: malformed output fails
    // loudly instead of silently becoming null. Only an intentionally empty
    // stdout maps to null.
    let parsed = null;
    if (text !== "") parsed = JSON.parse(text);
    return { code, stdout: text, stderr: stderr.join(""), parsed, record };
  } finally {
    restore();
  }
}

function openRouterConfig(overrides = {}) {
  return {
    version: 1,
    providers: {},
    judge: {
      route: "openrouter",
      openrouter: { model: "typesafe/jev-1.14", transmitConsent: true, apiKey: "or-stored-key-0001", ...overrides },
    },
  };
}

/**
 * One caller-lane run over the ACTUAL DEFAULT production runtime (no
 * injected requirements runtime), so the selected native profile is the one
 * the production factory constructs.
 */
async function runCaller({ env, storeRoot, request, judgeSettings, readQuotaSnapshot }) {
  const record = [];
  const restore = installFakeFetch(record);
  try {
    const result = await handleInvestigateCaller(
      request,
      storeRoot,
      {
        readFile: async () => { throw new Error("no file input permitted"); },
        readStdin: async () => { throw new Error("no stdin permitted"); },
        now: () => Date.now(),
      },
      {
        env, secrets: [], provider: "tavily",
        ...(judgeSettings === undefined ? {} : { judgeSettings }),
        ...(readQuotaSnapshot === undefined ? {} : { readQuotaSnapshot }),
      },
    );
    return { result, record };
  } finally {
    restore();
  }
}

/** Every stored byte of the retained record, so the persisted identity is observable. */
async function storedBytes(storeRoot) {
  const chunks = [];
  for (const entry of await readdir(storeRoot, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    chunks.push(await readFile(join(entry.parentPath ?? entry.path, entry.name), "utf8"));
  }
  return chunks.join("\n");
}

/** The bounded native identity hash the retained record carries, if any. */
const nativeIdentity = (stored) => stored.match(/native-jev:[0-9a-f]{64}/)?.[0];

const callerStart = () => ({
  schemaVersion: 1, operation: "start", dataScope: "synthetic", requirements: CALLER_CONTRACT,
});

const OR_CALLER_ENV = {
  TAVILY_API_KEY: "synthetic-acquisition-key",
  SCOUTLINE_JUDGE: "openrouter",
  OPENROUTER_API_KEY: "or-caller-key-0005",
  SCOUTLINE_JUDGE_TRANSMIT: "1",
};

// ---------------------------------------------------------------------------
// Route selection over the actual public requirements path
// ---------------------------------------------------------------------------

test("the OpenRouter route is selected from the saved profile and reaches the OpenRouter endpoint", async () => {
  const loads = { count: 0 };
  const run = await runRequirements({ env: { TAVILY_API_KEY: "acquisition-key-0001" }, config: openRouterConfig(), loads });
  assert.equal(run.code, 0, run.stderr);
  const judges = judgeRequests(run.record);
  assert.equal(judges.length, 1, "exactly one native judge request reached the wire");
  assert.equal(judges[0].url, OR_ENDPOINT);
  assert.equal(judges[0].method, "POST", "the native route is a POST");
  assert.equal(judges[0].authorization, "Bearer or-stored-key-0001");
  assert.equal(judges[0].model, "typesafe/jev-1.14");
  assert.equal(judges[0].resolvedModel, "typesafe/jev-1.14-20261014", "the response carries the metadata-backed resolved model");
  assert.equal(judges[0].allowFallbacks, false, "OpenRouter provider fallback stays disabled");
  assert.equal(run.parsed.usage.judgeCalls, 1, "the run reached native work, not a deadline or setup failure");
  assert.equal(run.parsed.admission.judge, "shared");
  assert.equal(loads.count, 1, "the config loader is called exactly once");
  assert.deepEqual(refusedAttempts(run.record), [], "no fixture attempt was refused");
});

test("the selected route's environment key overrides the stored key", async () => {
  const loads = { count: 0 };
  const run = await runRequirements({
    env: { TAVILY_API_KEY: "acquisition-key-0001", OPENROUTER_API_KEY: "or-env-key-0002", SCOUTLINE_JUDGE_TRANSMIT: "1" },
    config: openRouterConfig(),
    loads,
  });
  assert.equal(run.code, 0, run.stderr);
  const judges = judgeRequests(run.record);
  assert.equal(judges.length, 1);
  assert.equal(judges[0].authorization, "Bearer or-env-key-0002");
  assert.equal(judges[0].model, "typesafe/jev-1.14", "the stored model still applies when only the key is overridden");
});

test("the explicit direct route selects the direct endpoint, key and model", async () => {
  const loads = { count: 0 };
  const run = await runRequirements({
    env: { TAVILY_API_KEY: "acquisition-key-0001", SCOUTLINE_JUDGE: "typesafe", TYPESAFE_API_KEY: "ts-env-key-0003", SCOUTLINE_JUDGE_TRANSMIT: "1" },
    config: { version: 1, providers: {} },
    loads,
  });
  assert.equal(run.code, 0, run.stderr);
  const judges = judgeRequests(run.record);
  assert.equal(judges.length, 1);
  assert.equal(judges[0].url, TS_ENDPOINT);
  assert.equal(judges[0].method, "POST");
  assert.equal(judges[0].authorization, "Bearer ts-env-key-0003");
  assert.equal(judges[0].model, "jev-1.13.0");
  assert.equal(judges[0].resolvedModel, "jev-1.13.0");
});

test("the direct 1.14 model is an explicit compatible choice", async () => {
  const loads = { count: 0 };
  const run = await runRequirements({
    env: {
      TAVILY_API_KEY: "acquisition-key-0001", SCOUTLINE_JUDGE: "typesafe",
      TYPESAFE_API_KEY: "ts-env-key-0004", SCOUTLINE_JUDGE_TRANSMIT: "1", SCOUTLINE_JUDGE_MODEL: "jev-1.14.0",
    },
    config: { version: 1, providers: {} },
    loads,
  });
  assert.equal(run.code, 0, run.stderr);
  const judges = judgeRequests(run.record);
  assert.equal(judges.length, 1);
  assert.equal(judges[0].url, TS_ENDPOINT);
  assert.equal(judges[0].model, "jev-1.14.0");
  assert.equal(judges[0].resolvedModel, "jev-1.14.0");
});

test("consent without the selected route's credential refuses before any HTTP", async () => {
  const loads = { count: 0 };
  const run = await runRequirements({
    env: { TAVILY_API_KEY: "acquisition-key-0001", SCOUTLINE_JUDGE_TRANSMIT: "1" },
    config: { version: 1, providers: {} },
    loads,
  });
  assert.equal(run.code, 1);
  assert.equal(run.stdout, "");
  assert.equal(run.record.length, 0, "a refused selection dispatches no HTTP at all");
  assert.match(run.stderr, /SCOUTLINE_JUDGE/);
});

test("an unsupported own judge control is refused, never accepted and dropped", async () => {
  const loads = { count: 0 };
  const run = await runRequirements({
    env: { TAVILY_API_KEY: "acquisition-key-0001", SCOUTLINE_JUDGE_ENDPOINT: "https://elsewhere.test/v1" },
    config: { version: 1, providers: {} },
    loads,
  });
  assert.equal(run.code, 1);
  assert.equal(run.record.length, 0);
  assert.match(run.stderr, /SCOUTLINE_JUDGE_ENDPOINT/);
});

test("the owned selection survives a mutation while the quota setup is pending", async () => {
  const loads = { count: 0 };
  const config = openRouterConfig();
  const env = { TAVILY_API_KEY: "acquisition-key-0001" };
  const stdout = [];
  const stderr = [];
  const record = [];
  const restore = installFakeFetch(record);
  try {
    const deps = hermeticMainDeps({
      env,
      loadScoutlineConfig: async () => { loads.count += 1; return config; },
      // The pending quota setup mutates BOTH the loaded config and the
      // environment after the run already captured its selection.
      readRequirementsQuotaSnapshot: async () => {
        config.judge.openrouter.model = "typesafe/jev-1.13";
        config.judge.openrouter.apiKey = "mutated-stored-key-9999";
        env.OPENROUTER_API_KEY = "mutated-env-key-9999";
        return undefined;
      },
      invocation: {
        stdoutIsTTY: false, stdinIsTTY: false, environmentOutputMode: "data",
        readStdin: async () => "", writeStdout: (s) => stdout.push(s), writeStderr: (s) => stderr.push(s),
        runQuietly: async (fn) => fn(), setExitCode: () => {},
      },
    });
    const code = await main(
      ["investigate", "--provider", "tavily", "--requirements-json", JSON.stringify(REQUIREMENT_CONTRACT), "--no-cache", "--json"],
      deps,
    );
    assert.equal(code, 0, stderr.join(""));
    const judges = judgeRequests(record);
    assert.equal(judges.length, 1);
    assert.equal(judges[0].model, "typesafe/jev-1.14", "the captured model survives the mid-run mutation");
    assert.equal(judges[0].authorization, "Bearer or-stored-key-0001", "the captured key survives the mid-run mutation");
    assert.equal(loads.count, 1, "the config loader is called exactly once");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The caller lane: route selection, identity and reuse
// ---------------------------------------------------------------------------

test("the caller lane uses the selected native profile and records a non-key-derived identity", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-caller-"));
  try {
    const run = await runCaller({ env: OR_CALLER_ENV, storeRoot, request: callerStart() });
    assert.equal(run.result.exitCode, 0, JSON.stringify(run.result.data));
    assert.equal(run.result.data.status, "complete", "the start actually completes");
    assert.equal(run.result.data.stopReason, "work-fulfilled");
    assert.equal(run.result.data.fulfillment.satisfied, 1);
    assert.equal(run.result.data.usage.judgeCalls, 1, "one native judgment was actually made");
    const judges = judgeRequests(run.record);
    assert.equal(judges.length, 1);
    assert.equal(judges[0].url, OR_ENDPOINT);
    assert.equal(judges[0].method, "POST");
    assert.equal(judges[0].authorization, "Bearer or-caller-key-0005");
    assert.equal(judges[0].model, "typesafe/jev-1.14");
    assert.equal(judges[0].resolvedModel, "typesafe/jev-1.14-20261014");
    assert.equal(judges[0].allowFallbacks, false);
    const stored = await storedBytes(storeRoot);
    assert.match(stored, /native-jev:/, "the retained identity is the bounded native hash");
    assert.doesNotMatch(stored, /direct-typesafe/, "the removed key-presence identity is never written");
    assert.doesNotMatch(stored, /or-caller-key-0005/, "a credential never reaches the retained record");
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test("the retained native identity is stable across different credentials", async () => {
  const identities = [];
  for (const key of ["or-identity-key-aaa", "or-identity-key-bbb"]) {
    const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-identity-"));
    try {
      const run = await runCaller({
        env: { ...OR_CALLER_ENV, OPENROUTER_API_KEY: key },
        storeRoot,
        request: callerStart(),
      });
      assert.equal(run.result.exitCode, 0, JSON.stringify(run.result.data));
      const stored = await storedBytes(storeRoot);
      identities.push(nativeIdentity(stored));
      assert.doesNotMatch(stored, new RegExp(key), "the credential never reaches the retained record");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  }
  assert.ok(identities[0], "the known profile records a native identity");
  assert.equal(identities[0], identities[1], "the identity does not depend on credential material");
});

test("the caller's own judge settings are owned before the quota setup mutates them", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-owned-settings-"));
  try {
    // The caller owns this object; the run must not borrow it across the
    // asynchronous quota setup.
    const settings = {
      route: "openrouter",
      openrouter: { model: "typesafe/jev-1.14", transmitConsent: true, apiKey: "or-keyA-0001" },
    };
    const run = await runCaller({
      env: { TAVILY_API_KEY: "synthetic-acquisition-key" },
      storeRoot,
      request: callerStart(),
      judgeSettings: settings,
      readQuotaSnapshot: async () => {
        settings.openrouter.model = "typesafe/jev-1.13";
        settings.openrouter.apiKey = "or-keyB-0002";
        return undefined;
      },
    });
    assert.equal(run.result.exitCode, 0, JSON.stringify(run.result.data));
    const judges = judgeRequests(run.record);
    assert.equal(judges.length, 1, "exactly one native request reached the wire");
    assert.equal(judges[0].model, "typesafe/jev-1.14", "the owned snapshot keeps the ORIGINAL model");
    assert.equal(judges[0].authorizationSha256, createHash("sha256").update("Bearer or-keyA-0001").digest("hex").slice(0, 16),
      "the owned snapshot keeps the ORIGINAL credential");
    // The caller's own object stays mutable and still shows its later mutation.
    assert.equal(Object.isFrozen(settings), false, "the caller-owned object is never frozen by the run");
    assert.equal(settings.openrouter.model, "typesafe/jev-1.13");
    assert.equal(settings.openrouter.apiKey, "or-keyB-0002");
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test("absent judge settings stay absent and dispatch no native request", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-absent-settings-"));
  try {
    const run = await runCaller({
      env: { TAVILY_API_KEY: "synthetic-acquisition-key" },
      storeRoot,
      request: callerStart(),
    });
    assert.equal(judgeRequests(run.record).length, 0, "absent settings never construct a native judge");
    const stored = await storedBytes(storeRoot);
    assert.doesNotMatch(stored, /native-jev:/, "absent settings never certify a native identity");
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
});

/**
 * A CUSTOM runtime (not the production default) that constructs a real
 * native profile but hands back NO trusted descriptor. This is an opaque
 * collaborator — never production native reuse.
 */
function customProfileRuntime({ withDescriptor = true } = {}) {
  return (context) => {
    const transport = { fetch: globalThis.fetch, env: context.env };
    const descriptor = createTavilyDescriptor({ transport });
    const native = selectRequirementsJudge(context.env, context.reserveAttempt, context.judgeSettings);
    return {
      acquisitionOptions: {
        searchDescriptor: descriptor, readerDescriptor: descriptor, env: context.env,
        transports: { tavily: transport },
        descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
        cache: { get: async () => null, set: async () => {} },
        sleep: async () => {}, random: () => 0,
        reservePhysicalAttempt: context.reserveAttempt,
        maxPhysicalAttempts: 12,
      },
      engineDeps: { judge: native.judge, candidateJudge: native.candidateJudge, now: () => Date.now() },
      secrets: [],
      judgeAdmission: "shared",
      ...(withDescriptor && native.descriptor !== undefined ? { judgeDescriptor: native.descriptor } : {}),
    };
  };
}

async function runCustomCaller({ env, storeRoot, request, withDescriptor = true }) {
  const record = [];
  const restore = installFakeFetch(record);
  try {
    const result = await handleInvestigateCaller(
      request,
      storeRoot,
      {
        readFile: async () => { throw new Error("no file input permitted"); },
        readStdin: async () => { throw new Error("no stdin permitted"); },
        now: () => Date.now(),
        requirementsRuntime: customProfileRuntime({ withDescriptor }),
      },
      { env, secrets: [], provider: "tavily" },
    );
    return { result, record };
  } finally {
    restore();
  }
}

test("a custom runtime's opaque judge without a descriptor keeps an unknown identity", async () => {
  const identities = [];
  for (const key of ["or-opaque-key-aaa", "or-opaque-key-bbb"]) {
    const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-opaque-"));
    try {
      const run = await runCustomCaller({
        env: { ...OR_CALLER_ENV, OPENROUTER_API_KEY: key },
        storeRoot,
        request: callerStart(),
        withDescriptor: false,
      });
      assert.equal(run.result.exitCode, 0, JSON.stringify(run.result.data));
      assert.equal(judgeRequests(run.record).length, 1, "the opaque collaborator still did its native work");
      const stored = await storedBytes(storeRoot);
      identities.push(nativeIdentity(stored));
      assert.doesNotMatch(stored, /native-jev:/, "an opaque collaborator is never certified as a known native profile");
      assert.doesNotMatch(stored, /direct-typesafe/, "no key-derived identity either");
      assert.doesNotMatch(stored, new RegExp(key), "the credential never reaches the retained record");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  }
  assert.equal(identities[0], identities[1], "the opaque identity is stable and independent of credential material");
});

test("a same-route model change forces an actual native rejudgment before the old acceptance is reused", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-reuse-"));
  try {
    const baseEnv = { ...OR_CALLER_ENV, OPENROUTER_API_KEY: "or-caller-key-0007" };
    const start = await runCaller({
      env: { ...baseEnv, SCOUTLINE_JUDGE_MODEL: "typesafe/jev-1.14" },
      storeRoot,
      request: callerStart(),
    });
    assert.equal(start.result.exitCode, 0, JSON.stringify(start.result.data));
    assert.equal(start.result.data.status, "complete", "the start actually completes");
    assert.equal(start.result.data.stopReason, "work-fulfilled");
    const ref = start.result.data.investigationRef;
    assert.equal(judgeRequests(start.record).length, 1);
    assert.equal(judgeRequests(start.record)[0].model, "typesafe/jev-1.14");
    const firstKeyHash = judgeRequests(start.record)[0].authorizationSha256;

    // Same profile: the retained acceptance is eligible for reuse. The
    // continuation resubmits ONLY the reference, the expected revision and
    // the data scope — no requirements and no representations.
    const reuse = await runCaller({
      env: { ...baseEnv, SCOUTLINE_JUDGE_MODEL: "typesafe/jev-1.14" },
      storeRoot,
      request: { schemaVersion: 1, operation: "continue", investigationRef: ref, expectedRevision: start.result.data.committedRevision, dataScope: "synthetic" },
    });
    assert.equal(reuse.result.exitCode, 0, JSON.stringify(reuse.result.data));
    assert.equal(reuse.result.data.status, "complete");
    assert.equal(reuse.record.length, 0, "the same eligible profile reuses the retained judgment instead of paying again");
    assert.equal(judgeRequests(reuse.record).length, 0, "no native request is made for an eligible reuse");

    // Same route, SAME key and SAME source/intent, different model: the
    // retained acceptance cannot be reused and a real native request
    // under the NEW model must happen.
    const changed = await runCaller({
      env: { ...baseEnv, SCOUTLINE_JUDGE_MODEL: "typesafe/jev-1.13" },
      storeRoot,
      request: { schemaVersion: 1, operation: "continue", investigationRef: ref, expectedRevision: reuse.result.data.committedRevision, dataScope: "synthetic" },
    });
    assert.equal(changed.result.exitCode, 0, JSON.stringify(changed.result.data));
    const underNewModel = judgeRequests(changed.record).filter((e) => e.model === "typesafe/jev-1.13");
    // ONE labeled JSON witness, emitted BEFORE the first throwing
    // assertion. It captures the same-run wire, the retained history and
    // the public status — no credential bytes.
    process.stderr.write(`${JSON.stringify({
      label: "M3-REUSE-IDENTITY-WITNESS",
      sameProfileReuse: {
        httpRequests: reuse.record.length,
        nativeRequests: judgeRequests(reuse.record).length,
        status: reuse.result.data.status,
        revision: reuse.result.data.revision,
      },
      changedModel: {
        httpRequests: changed.record.length,
        nativeRequests: judgeRequests(changed.record).length,
        nativeUnderNewModel: underNewModel.length,
        wire: judgeRequests(changed.record).map((e) => ({ url: e.url, method: e.method, model: e.model, resolvedModel: e.resolvedModel })),
        status: changed.result.data.status,
        stopReason: changed.result.data.stopReason,
        revision: changed.result.data.revision,
      },
    })}\n`);
    assert.equal(underNewModel.length, 1, "the model change forced an actual native request under the new model");
    assert.equal(underNewModel[0].url, OR_ENDPOINT, "the same route still serves");
    assert.equal(underNewModel[0].method, "POST");
    assert.equal(underNewModel[0].resolvedModel, "typesafe/jev-1.13-20260917");
    assert.equal(underNewModel[0].authorizationSha256, firstKeyHash, "the same key still authenticates");
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test("a route switch forces an actual native request on the other route", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-switch-"));
  try {
    const start = await runCaller({ env: { ...OR_CALLER_ENV, OPENROUTER_API_KEY: "or-caller-key-0008" }, storeRoot, request: callerStart() });
    assert.equal(start.result.exitCode, 0, JSON.stringify(start.result.data));
    const ref = start.result.data.investigationRef;
    const switched = await runCaller({
      env: { TAVILY_API_KEY: "synthetic-acquisition-key", SCOUTLINE_JUDGE: "typesafe", TYPESAFE_API_KEY: "ts-caller-key-0008", SCOUTLINE_JUDGE_TRANSMIT: "1" },
      storeRoot,
      request: { schemaVersion: 1, operation: "continue", investigationRef: ref, expectedRevision: start.result.data.committedRevision, dataScope: "synthetic" },
    });
    assert.equal(switched.result.exitCode, 0, JSON.stringify(switched.result.data));
    const direct = judgeRequests(switched.record).filter((e) => e.url === TS_ENDPOINT);
    assert.equal(direct.length, 1, "the route switch forced an actual native request on the direct route");
    assert.equal(direct[0].method, "POST");
    assert.equal(direct[0].model, "jev-1.13.0");
    assert.equal(direct[0].resolvedModel, "jev-1.13.0");
    assert.equal(direct[0].authorization, "Bearer ts-caller-key-0008", "only the selected route's credential authenticates");
    assert.equal(switched.record.filter((e) => e.url === OR_ENDPOINT).length, 0, "no cross-route fallback followed");
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test("the public request JSON cannot supply a runtime identity", async () => {
  const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-inject-"));
  try {
    const record = [];
    const restore = installFakeFetch(record);
    let thrown;
    try {
      await handleInvestigateCaller(
        { ...callerStart(), judgeIdentity: "native-jev:forged", policyRevision: "native-jev-policy-v1:forged" },
        storeRoot,
        {
          readFile: async () => { throw new Error("no file input permitted"); },
          readStdin: async () => { throw new Error("no stdin permitted"); },
          now: () => Date.now(),
        },
        { env: OR_CALLER_ENV, secrets: [], provider: "tavily" },
      );
    } catch (error) {
      thrown = error;
    } finally {
      restore();
    }
    // The direct handler THROWS the typed validation contract; it never
    // returns invented error data.
    assert.ok(thrown, "the injected identity is refused");
    assert.equal(thrown.code, "VALIDATION_ERROR");
    assert.match(thrown.message, /caller request/i);
    assert.equal(record.length, 0, "the refused request dispatched nothing");
  } finally {
    await rm(storeRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Secret union
// ---------------------------------------------------------------------------

test("the complete judge secret union covers selected, inactive and overridden values", async () => {
  const markerSelected = "or-selected-marker-000a";
  const markerInactive = "ts-inactive-marker-000b";
  const markerOverridden = "or-overridden-marker-000c";
  const publicFact = "ExampleApp release 2.4.0 supports CSV under MIT.";
  const servedContent = `${publicFact} ${markerSelected} ${markerInactive} ${markerOverridden}`;
  const storeRoot = await mkdtemp(join(tmpdir(), "judge-public-secrets-"));
  const record = [];
  const restore = installFakeFetch(record, { content: servedContent });
  try {
    const judgeSettings = {
      route: "openrouter",
      openrouter: { model: "typesafe/jev-1.14", transmitConsent: true, apiKey: markerSelected },
      typesafe: { model: "jev-1.13.0", transmitConsent: false, apiKey: markerInactive },
    };
    const start = await handleInvestigateCaller(
      callerStart(),
      storeRoot,
      {
        readFile: async () => { throw new Error("no file input permitted"); },
        readStdin: async () => { throw new Error("no stdin permitted"); },
        now: () => Date.now(),
      },
      {
        env: { TAVILY_API_KEY: "synthetic-acquisition-key", OPENROUTER_API_KEY: markerOverridden, SCOUTLINE_JUDGE_TRANSMIT: "1" },
        secrets: [], provider: "tavily", judgeSettings,
      },
    );
    assert.equal(start.exitCode, 0, JSON.stringify(start.data));
    assert.equal(start.data.status, "complete");
    // The markers really travelled through the acquisition.
    assert.ok(acquisitionRequests(record).length > 0, "the acquisition actually served content");
    const ref = start.data.investigationRef;

    const inspected = await handleInvestigateCaller(
      { schemaVersion: 1, operation: "inspect", investigationRef: ref, collection: "evidence" },
      storeRoot,
      { readFile: async () => { throw new Error("no file input permitted"); }, readStdin: async () => { throw new Error("no stdin permitted"); }, now: () => Date.now() },
      { env: { TAVILY_API_KEY: "synthetic-acquisition-key", OPENROUTER_API_KEY: markerOverridden, SCOUTLINE_JUDGE_TRANSMIT: "1" }, secrets: [], provider: "tavily", judgeSettings },
    );
    const evidence = JSON.parse(inspected.data.content);
    assert.ok(Array.isArray(evidence) && evidence.length > 0, "the retained evidence is inspectable");
    assert.equal(evidence[0].displayRedacted, true, "the served markers were redacted for display");

    const read = await handleInvestigateCaller(
      { schemaVersion: 1, operation: "readEvidence", investigationRef: ref, representationId: evidence[0].representationId, digest: evidence[0].digest },
      storeRoot,
      { readFile: async () => { throw new Error("no file input permitted"); }, readStdin: async () => { throw new Error("no stdin permitted"); }, now: () => Date.now() },
      { env: { TAVILY_API_KEY: "synthetic-acquisition-key", OPENROUTER_API_KEY: markerOverridden, SCOUTLINE_JUDGE_TRANSMIT: "1" }, secrets: [], provider: "tavily", judgeSettings },
    );
    const shown = read.data.content;
    assert.match(shown, new RegExp(publicFact.replace(/\./g, "\\.")), "a nonsecret source fact survives in the public evidence");
    assert.doesNotMatch(shown, new RegExp(markerSelected), "the selected stored key never reaches the public evidence");
    assert.doesNotMatch(shown, new RegExp(markerInactive), "the inactive stored key never reaches the public evidence");
    assert.doesNotMatch(shown, new RegExp(markerOverridden), "the overridden env key never reaches the public evidence");
    assert.notEqual(read.data.digest, read.data.originalDigest, "the displayed digest differs from the original because redaction changed the content");
    // Only the SELECTED route's credential authenticates the native request.
    const judges = judgeRequests(record);
    assert.equal(judges.length, 1);
    assert.equal(judges[0].authorization, `Bearer ${markerOverridden}`, "the overridden env key is the authenticating one");
  } finally {
    restore();
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test("the redactor keeps every DeepSeek hook while adding the OpenRouter ones", async () => {
  const { redactCredentialString, configuredSecrets } = await import("../dist/lib/redact.js");
  // The accepted hooks mask an ASSIGNMENT whole-match: the variable name is
  // not preserved.
  assert.equal(redactCredentialString("DEEPSEEK_API_KEY=deep-secret-value"), "[REDACTED]");
  assert.equal(redactCredentialString("DEEPSEEK_API_KEY: deep-secret-value"), "[REDACTED]");
  assert.equal(redactCredentialString("OPENROUTER_API_KEY=or-secret-value"), "[REDACTED]");
  assert.equal(redactCredentialString("TYPESAFE_API_KEY=ts-secret-value"), "[REDACTED]");
  // A name WITHOUT an assignment operator is not a form the accepted
  // redactor claims; the supplied text is returned unchanged.
  assert.equal(redactCredentialString("DEEPSEEK_API_KEY deep-secret-value"), "DEEPSEEK_API_KEY deep-secret-value");
  assert.equal(redactCredentialString("OPENROUTER_API_KEY or-secret-value"), "OPENROUTER_API_KEY or-secret-value");
  assert.equal(redactCredentialString("plain or-secret-value here"), "plain or-secret-value here");
  const secrets = configuredSecrets({ OPENROUTER_API_KEY: "or-env-value", TYPESAFE_API_KEY: "ts-env-value" });
  assert.ok(secrets.includes("or-env-value"), "the OpenRouter env key is a configured secret");
  assert.ok(secrets.includes("ts-env-value"), "the direct env key is a configured secret");
});

// ---------------------------------------------------------------------------
// F5: the GLOBAL main() wiring — the secret union must hold through the
// dispatcher, not only through a directly called handler.
//
// The existing public fixture above covers served markers through a
// DIRECT caller. These cases extend the same markers to the global
// wiring: the actual `main()` entry point, its own config loader, its own
// private paths, and its own offline views.
// ---------------------------------------------------------------------------

/** The private roots one main() invocation owns. */
async function mainSandbox() {
  const root = await mkdtemp(join(tmpdir(), "judge-public-main-"));
  return {
    root,
    env: {
      TAVILY_API_KEY: "synthetic-acquisition-key",
      SCOUTLINE_CONFIG_DIR: join(root, "config"),
      SCOUTLINE_ARTIFACTS_DIR: join(root, "artifacts"),
      SCOUTLINE_CACHE_DIR: join(root, "cache"),
      SCOUTLINE_INVESTIGATIONS_DIR: join(root, "investigations"),
    },
  };
}

/**
 * One `main()` run over the caller surface. It returns the exit code, the
 * stdout/stderr text, the fake-HTTP record and the count of real HTTP
 * requests the run made.
 */
async function runMain({ env, config, request, deps = {}, content = SOURCE }) {
  const stdout = [];
  const stderr = [];
  const record = [];
  const restore = installFakeFetch(record, { content });
  try {
    const mainDeps = hermeticMainDeps({
      env,
      loadScoutlineConfig: async () => {
        if (config === null) throw new Error("corrupt local judge/config basis");
        return config;
      },
      ...deps,
      invocation: {
        stdoutIsTTY: false, stdinIsTTY: false, environmentOutputMode: "data",
        readStdin: async () => "", writeStdout: (s) => stdout.push(s), writeStderr: (s) => stderr.push(s),
        runQuietly: async (fn) => fn(), setExitCode: () => {},
      },
    });
    const code = await main(
      ["investigate", "--caller-request-json", JSON.stringify(request), "--provider", "tavily"],
      mainDeps,
    );
    return { code, stdout: stdout.join(""), stderr: stderr.join(""), record };
  } finally {
    restore();
  }
}

test("F5 the global main() wiring redacts every judge secret marker from the current, evidence and historical views", async () => {
  const markerSelected = "or-selected-marker-000a";
  const markerInactive = "ts-inactive-marker-000b";
  const markerOverridden = "or-overridden-marker-000c";
  const publicFact = "ExampleApp release 2.4.0 supports CSV under MIT.";
  const servedContent = `${publicFact} ${markerSelected} ${markerInactive} ${markerOverridden}`;
  const { root, env } = await mainSandbox();
  const config = {
    version: 1, providers: {},
    judge: {
      route: "openrouter",
      openrouter: { model: "typesafe/jev-1.14", transmitConsent: true, apiKey: markerSelected },
      typesafe: { model: "jev-1.13.0", transmitConsent: false, apiKey: markerInactive },
    },
  };
  const runEnv = { ...env, OPENROUTER_API_KEY: markerOverridden, SCOUTLINE_JUDGE_TRANSMIT: "1" };
  try {
    const start = await runMain({
      env: runEnv, config, content: servedContent,
      request: { schemaVersion: 1, operation: "start", dataScope: "synthetic", requirements: CALLER_CONTRACT },
    });
    assert.equal(start.code, 0, start.stdout + start.stderr);
    const header = JSON.parse(start.stdout);
    assert.equal(header.status, "complete", "the run reached complete native work");
    assert.equal(header.stopReason, "work-fulfilled");
    assert.equal(header.fulfillment.satisfied, 1, "the required judgment was actually made");
    // The DELIVERY witness: the markers really travelled through the
    // acquisition. It precedes every negative output assertion.
    const acquisition = acquisitionRequests(start.record);
    assert.ok(acquisition.length > 0, "the acquisition actually served content");
    assert.ok(
      acquisition.some((e) => typeof e.served === "string" && e.served.includes(markerSelected)),
      "the selected marker really was served on the wire",
    );
    assert.ok(
      acquisition.some((e) => typeof e.served === "string" && e.served.includes(markerInactive)),
      "the inactive marker really was served on the wire",
    );
    assert.ok(
      acquisition.some((e) => typeof e.served === "string" && e.served.includes(markerOverridden)),
      "the overridden marker really was served on the wire",
    );
    // Only the selected route's credential authenticates.
    const judges = judgeRequests(start.record);
    assert.equal(judges.length, 1);
    assert.equal(judges[0].url, OR_ENDPOINT);
    assert.equal(judges[0].authorization, `Bearer ${markerOverridden}`);

    const ref = header.investigationRef;
    // A reference-only continuation: no requirements, no representations.
    const continued = await runMain({
      env: runEnv, config,
      request: { schemaVersion: 1, operation: "continue", investigationRef: ref, expectedRevision: header.committedRevision, dataScope: "synthetic" },
    });
    assert.equal(continued.code, 0, continued.stderr);
    const next = JSON.parse(continued.stdout);
    assert.equal(next.revision, header.revision + 1);

    // The CURRENT evidence view.
    const current = await runMain({
      env: runEnv, config,
      request: { schemaVersion: 1, operation: "inspect", investigationRef: ref, collection: "evidence" },
    });
    assert.equal(current.code, 0, current.stderr);
    assert.equal(current.record.filter((e) => e.url).length, 0, "the offline view dispatched no HTTP");
    const evidence = JSON.parse(JSON.parse(current.stdout).content);
    assert.ok(evidence.length > 0, "the retained evidence is inspectable");
    assert.equal(evidence[0].displayRedacted, true, "the served markers were redacted for display");
    for (const marker of [markerSelected, markerInactive, markerOverridden]) {
      assert.ok(!current.stdout.includes(marker), `the current view must not carry ${marker}`);
    }

    // The readEvidence view, with honest display/original digest semantics.
    const read = await runMain({
      env: runEnv, config,
      request: { schemaVersion: 1, operation: "readEvidence", investigationRef: ref, representationId: evidence[0].representationId, digest: evidence[0].digest },
    });
    assert.equal(read.code, 0, read.stderr);
    assert.equal(read.record.filter((e) => e.url).length, 0, "readEvidence dispatched no HTTP");
    const shown = JSON.parse(read.stdout);
    assert.match(shown.content, new RegExp(publicFact.replace(/\./g, "\\.")), "a nonsecret public fact survives");
    for (const marker of [markerSelected, markerInactive, markerOverridden]) {
      assert.ok(!shown.content.includes(marker), `the read view must not carry ${marker}`);
    }
    assert.notEqual(shown.digest, shown.originalDigest, "the displayed digest differs from the original because redaction changed the content");

    // The HISTORICAL view: the first revision's evidence must be redacted too.
    const historic = await runMain({
      env: runEnv, config,
      request: { schemaVersion: 1, operation: "inspect", investigationRef: ref, revision: header.revision, collection: "evidence" },
    });
    assert.equal(historic.code, 0, historic.stderr);
    assert.equal(historic.record.filter((e) => e.url).length, 0, "the historical view dispatched no HTTP");
    for (const marker of [markerSelected, markerInactive, markerOverridden]) {
      assert.ok(!historic.stdout.includes(marker), `the historical view must not carry ${marker}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F5 the global main() wiring keeps the offline record operations local under malformed judge controls", async () => {
  const { root, env } = await mainSandbox();
  const config = {
    version: 1, providers: {},
    judge: { route: "openrouter", openrouter: { model: "typesafe/jev-1.14", transmitConsent: true, apiKey: "or-stored-key-0001" } },
  };
  const runEnv = { ...env, OPENROUTER_API_KEY: "or-env-key-0002", SCOUTLINE_JUDGE_TRANSMIT: "1" };
  try {
    const start = await runMain({
      env: runEnv, config,
      request: { schemaVersion: 1, operation: "start", dataScope: "synthetic", requirements: CALLER_CONTRACT },
    });
    assert.equal(start.code, 0, start.stderr);
    const header = JSON.parse(start.stdout);
    const ref = header.investigationRef;

    // Malformed judge ENVIRONMENT controls must not activate a route, must
    // not construct a runtime and must not make the offline operations
    // perform any HTTP.
    const malformedEnv = { ...runEnv, SCOUTLINE_JUDGE_TRANSMIT: "yes", SCOUTLINE_JUDGE_MODEL: "not-a-supported-model" };
    let runtimeConstructions = 0;
    const spy = async () => { runtimeConstructions += 1; throw new Error("offline operations must never construct a runtime"); };
    // The evidence view first, so the readEvidence request can name the
    // exact representation and digest it returned.
    const evidenceView = await runMain({
      env: malformedEnv, config, deps: { requirementsRuntime: spy },
      request: { schemaVersion: 1, operation: "inspect", investigationRef: ref, collection: "evidence" },
    });
    assert.equal(evidenceView.code, 0, evidenceView.stderr);
    assert.equal(evidenceView.record.filter((e) => e.url).length, 0, "an offline record view dispatched no HTTP");
    assert.equal(runtimeConstructions, 0, "an offline record view constructed no runtime");
    const evidenceRow = JSON.parse(JSON.parse(evidenceView.stdout).content)[0];
    for (const request of [
      { schemaVersion: 1, operation: "inspect", investigationRef: ref },
      { schemaVersion: 1, operation: "inspect", investigationRef: ref, collection: "evidence" },
      { schemaVersion: 1, operation: "inspect", investigationRef: ref, collection: "rounds" },
    ]) {
      const offline = await runMain({ env: malformedEnv, config, request, deps: { requirementsRuntime: spy } });
      assert.equal(offline.code, 0, offline.stderr);
      assert.equal(offline.record.filter((e) => e.url).length, 0, "an offline record view dispatched no HTTP");
      assert.equal(runtimeConstructions, 0, "an offline record view constructed no runtime");
    }
    // A DISABLED selection (no consent) is equally local.
    const disabledEnv = { ...runEnv, SCOUTLINE_JUDGE_TRANSMIT: "0" };
    const disabled = await runMain({
      env: disabledEnv, config,
      request: { schemaVersion: 1, operation: "inspect", investigationRef: ref },
      deps: { requirementsRuntime: spy },
    });
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal(disabled.record.filter((e) => e.url).length, 0, "a disabled judge dispatched no HTTP");
    assert.equal(runtimeConstructions, 0, "a disabled judge constructed no runtime");

    // An ABSENT local config basis is equally local.
    const absent = await runMain({
      env: { ...runEnv, SCOUTLINE_CONFIG_DIR: join(root, "absent-config") },
      config: { version: 1, providers: {} },
      request: { schemaVersion: 1, operation: "inspect", investigationRef: ref },
      deps: { requirementsRuntime: spy },
    });
    assert.equal(absent.code, 0, absent.stderr);
    assert.equal(absent.record.filter((e) => e.url).length, 0, "an absent config dispatched no HTTP");
    assert.equal(runtimeConstructions, 0, "an absent config constructed no runtime");

    // The readEvidence and delete endpoints are local under the same
    // malformed controls.
    const read = await runMain({
      env: malformedEnv, config, deps: { requirementsRuntime: spy },
      request: { schemaVersion: 1, operation: "readEvidence", investigationRef: ref, representationId: evidenceRow.representationId, digest: evidenceRow.digest },
    });
    assert.equal(read.code, 0, read.stderr);
    assert.equal(read.record.filter((e) => e.url).length, 0, "readEvidence dispatched no HTTP");
    assert.equal(runtimeConstructions, 0, "readEvidence constructed no runtime");
    const deleted = await runMain({
      env: malformedEnv, config, deps: { requirementsRuntime: spy },
      request: { schemaVersion: 1, operation: "delete", investigationRef: ref },
    });
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.equal(deleted.record.filter((e) => e.url).length, 0, "the delete dispatched no HTTP");
    assert.equal(runtimeConstructions, 0, "the delete constructed no runtime");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F5 a corrupt local judge basis refuses the delete BEFORE any mutation and leaves the record intact", async () => {
  const { root, env } = await mainSandbox();
  const config = {
    version: 1, providers: {},
    judge: { route: "openrouter", openrouter: { model: "typesafe/jev-1.14", transmitConsent: true, apiKey: "or-stored-key-0003" } },
  };
  const runEnv = { ...env, OPENROUTER_API_KEY: "or-env-key-0003", SCOUTLINE_JUDGE_TRANSMIT: "1" };
  try {
    const start = await runMain({
      env: runEnv, config,
      request: { schemaVersion: 1, operation: "start", dataScope: "synthetic", requirements: CALLER_CONTRACT },
    });
    assert.equal(start.code, 0, start.stderr);
    const ref = JSON.parse(start.stdout).investigationRef;
    const storeRoot = join(root, "investigations");
    const before = await storeSnapshot(storeRoot);
    assert.ok(Object.keys(before).length > 0, "the record files exist before the refused delete");

    // A structurally corrupt local judge/config basis refuses with the
    // fixed safe-view refusal BEFORE the record is touched.
    const corrupt = await runMain({
      env: runEnv, config: null,
      request: { schemaVersion: 1, operation: "delete", investigationRef: ref },
    });
    assert.equal(corrupt.code, 1);
    assert.match(corrupt.stderr, /Caller view unavailable under the active redaction profile/);
    assert.equal(corrupt.record.filter((e) => e.url).length, 0, "the refused delete dispatched no HTTP");
    assert.deepEqual(await storeSnapshot(storeRoot), before, "the refused delete left every record file byte-identical");

    // A stored INACTIVE key whose value collides with the fixed caller
    // acknowledgment also refuses BEFORE the mutation.
    const colliding = await runMain({
      env: runEnv,
      config: { ...config, judge: { ...config.judge, typesafe: { model: "jev-1.13.0", transmitConsent: false, apiKey: "caller" } } },
      request: { schemaVersion: 1, operation: "delete", investigationRef: ref },
    });
    assert.equal(colliding.code, 1);
    assert.match(colliding.stderr, /Caller view unavailable under the active redaction profile/);
    assert.equal(colliding.record.filter((e) => e.url).length, 0, "the refused delete dispatched no HTTP");
    assert.deepEqual(await storeSnapshot(storeRoot), before, "the refused delete left every record file byte-identical");

    // Clearing ONLY the injected config basis lets a normal key-free
    // delete succeed — no extra credential is required.
    const cleared = await runMain({
      env: runEnv, config: { version: 1, providers: {} },
      request: { schemaVersion: 1, operation: "delete", investigationRef: ref },
    });
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal(JSON.parse(cleared.stdout).deleted, true);
    assert.deepEqual(await storeSnapshot(storeRoot), {}, "the successful delete removed the record files");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Every retained record file's membership, bytes and full mode. */
async function storeSnapshot(storeRoot) {
  const out = {};
  let entries;
  try {
    entries = await readdir(storeRoot, { recursive: true, withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const bytes = await readFile(full);
    out[full.slice(storeRoot.length)] = {
      bytes: bytes.length,
      mode: (await stat(full)).mode & 0o7777,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return out;
}


test("F5 real disk corrupt config refuses before deleting a record", async () => {
  const { root, env } = await mainSandbox();
  const runEnv = { ...env, OPENROUTER_API_KEY: "or-env-key-0003", SCOUTLINE_JUDGE_TRANSMIT: "1" };
  const config = openRouterConfig();
  try {
    const start = await runMain({ env: runEnv, config, request: callerStart() });
    assert.equal(start.code, 0, start.stderr);
    const header = JSON.parse(start.stdout);
    assert.equal(header.status, "complete");
    assert.equal(judgeRequests(start.record).length, 1);
    const ref = header.investigationRef;
    assert.ok(ref);
    const storeRoot = join(root, "investigations");
    const before = await storeSnapshot(storeRoot);
    assert.ok(Object.keys(before).length > 0);
    const configFile = join(env.SCOUTLINE_CONFIG_DIR, "config.json");
    await mkdir(env.SCOUTLINE_CONFIG_DIR, { recursive: true });
    await writeFile(configFile, "{invalid json");
    let constructions = 0;
    const deps = { loadScoutlineConfig: undefined, config: undefined, requirementsRuntime: async () => { constructions += 1; throw new Error("offline runtime construction"); } };
    const request = { schemaVersion: 1, operation: "delete", investigationRef: ref };
    const refused = await runMain({ env: runEnv, request, deps });
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    const failure = JSON.parse(refused.stderr);
    assert.equal(failure.code, "VALIDATION_ERROR");
    assert.equal(failure.error, "Caller view unavailable under the active redaction profile.");
    assert.deepEqual(refused.record, []);
    assert.equal(constructions, 0);
    assert.deepEqual(await storeSnapshot(storeRoot), before);
    await writeFile(configFile, JSON.stringify({ version: 1, providers: {} }));
    const deleted = await runMain({ env: { SCOUTLINE_CONFIG_DIR: env.SCOUTLINE_CONFIG_DIR, SCOUTLINE_INVESTIGATIONS_DIR: env.SCOUTLINE_INVESTIGATIONS_DIR, SCOUTLINE_ARTIFACTS_DIR: env.SCOUTLINE_ARTIFACTS_DIR, SCOUTLINE_CACHE_DIR: env.SCOUTLINE_CACHE_DIR }, request, deps });
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.equal(JSON.parse(deleted.stdout).deleted, true);
    assert.deepEqual(deleted.record, []);
    assert.equal(constructions, 0);
    assert.deepEqual(await storeSnapshot(storeRoot), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F5 real disk unreadable config refuses before deleting a record", async () => {
  const { root, env } = await mainSandbox();
  const runEnv = { ...env, OPENROUTER_API_KEY: "or-env-key-0003", SCOUTLINE_JUDGE_TRANSMIT: "1" };
  const config = openRouterConfig();
  const configFile = join(env.SCOUTLINE_CONFIG_DIR, "config.json");
  const useDirectory = process.platform === "win32" || process.getuid?.() === 0;
  let restricted = false;
  try {
    const start = await runMain({ env: runEnv, config, request: callerStart() });
    assert.equal(start.code, 0, start.stderr);
    const header = JSON.parse(start.stdout);
    assert.equal(header.status, "complete");
    assert.equal(judgeRequests(start.record).length, 1);
    const ref = header.investigationRef;
    assert.ok(ref);
    const storeRoot = join(root, "investigations");
    const before = await storeSnapshot(storeRoot);
    assert.ok(Object.keys(before).length > 0);
    await mkdir(env.SCOUTLINE_CONFIG_DIR, { recursive: true });
    if (useDirectory) {
      await mkdir(configFile);
      await assert.rejects(readFile(configFile), (error) => error.code === "EISDIR" || (process.platform === "win32" && error.code === "EPERM"));
      process.stderr.write("F5 unreadable config witness: directory read rejection\n");
    } else {
      await writeFile(configFile, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
      await chmod(configFile, 0o000);
      restricted = true;
      await assert.rejects(readFile(configFile), (error) => error.code === "EACCES" || error.code === "EPERM");
      process.stderr.write("F5 unreadable config witness: permission read rejection\n");
    }
    let constructions = 0;
    const deps = { loadScoutlineConfig: undefined, config: undefined, requirementsRuntime: async () => { constructions += 1; throw new Error("offline runtime construction"); } };
    const request = { schemaVersion: 1, operation: "delete", investigationRef: ref };
    const refused = await runMain({ env: runEnv, request, deps });
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, "");
    const failure = JSON.parse(refused.stderr);
    assert.equal(failure.code, "VALIDATION_ERROR");
    assert.equal(failure.error, "Caller view unavailable under the active redaction profile.");
    assert.deepEqual(refused.record, []);
    assert.equal(constructions, 0);
    assert.deepEqual(await storeSnapshot(storeRoot), before);
    if (useDirectory) await rm(configFile, { recursive: true });
    else { await chmod(configFile, 0o600); restricted = false; }
    await writeFile(configFile, JSON.stringify({ version: 1, providers: {} }));
    const deleted = await runMain({ env: { SCOUTLINE_CONFIG_DIR: env.SCOUTLINE_CONFIG_DIR, SCOUTLINE_INVESTIGATIONS_DIR: env.SCOUTLINE_INVESTIGATIONS_DIR, SCOUTLINE_ARTIFACTS_DIR: env.SCOUTLINE_ARTIFACTS_DIR, SCOUTLINE_CACHE_DIR: env.SCOUTLINE_CACHE_DIR }, request, deps });
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.equal(JSON.parse(deleted.stdout).deleted, true);
    assert.deepEqual(deleted.record, []);
    assert.equal(constructions, 0);
    assert.deepEqual(await storeSnapshot(storeRoot), {});
  } finally {
    if (restricted) await chmod(configFile, 0o600);
    await rm(root, { recursive: true, force: true });
  }
});
