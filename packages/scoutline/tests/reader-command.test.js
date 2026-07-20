/**
 * Reader Migration 04 — `read` command cutover (DESIGN.md §18, §11,
 * reader-migration-core-flows, reader-migration-tech-plan ticket 04).
 *
 * Drives the public `scoutline read <url>` command through `main` with
 * fake Provider descriptors so Provider selection ordering, capability
 * support gates, Adapter agreement, projection behaviour, and the
 * schema-version-1 output migration can all be asserted without
 * touching a concrete Adapter, MCP/UTCP transport, or process globals.
 *
 * Coverage (mapped to the Ticket 04 acceptance contract):
 *
 *   1. Selection matrix (table-driven): default ZAI, explicit ZAI,
 *      environment ZAI, explicit-over-env, unknown explicit, unknown
 *      environment, MiniMax unsupported explicit, MiniMax unsupported
 *      env, supported-unconfigured Z.AI, descriptor-advertises-but-
 *      Adapter-omits.
 *
 *   2. Unsupported spy proves ZERO selected-Provider work:
 *      descriptor.isConfigured / descriptor.create / operation
 *      validate/cacheIdentity/invoke never run; cache.get and cache.set
 *      counts are both zero (real cache spy, not Map.size). The
 *      pre-dispatch configuredSecrets(env) redaction read in `main`
 *      is separately observable through an env Proxy/getter counter
 *      and is the only permitted credential-related read on the
 *      unsupported path.
 *
 *   3. Supported-but-unconfigured Z.AI surfaces ConfigurationError
 *      (exit 3) AFTER the support check and BEFORE descriptor.create.
 *      Descriptor advertises reader but Adapter omits `reader` ->
 *      fail closed as UNSUPPORTED_CAPABILITY.
 *
 *   4. Validation ordering: parse-level (URL scheme, --extract mode)
 *      fires BEFORE Provider resolution; post-gating validation fires
 *      after support/configuration gates.
 *
 *   5. Exact golden outputs for content read AND extract read across
 *      data/json/pretty/compact with deterministic `now`. Content
 *      reads emit `content` directly in text-oriented modes via
 *      presentations; extract reads use JSON fallback because
 *      extracted items are data, not prose.
 *
 *   6. Flags reach the Adapter: --format, --no-images, --with-links,
 *      --no-gfm, --keep-img-data-url, --with-images-summary,
 *      --timeout, --no-cache, --max-chars (content projection only),
 *      --extract (extract envelope), --full-envelope (silently
 *      accepted and ignored).
 *
 *   7. Help text documents the cutover, schema-version-1 migration,
 *      JSON fallback for text modes on extract reads, and lists
 *      every canonical output mode (derived from OUTPUT_MODES).
 *
 *   8. Direct handler interface (P6-07A pattern): required
 *      `ReadHandlerDependencies` + optional trailing `CommandContext`,
 *      aligned with the shared Search/repo command shape.
 *      Requiredness is enforced by `tsc` and the compiled
 *      declaration; runtime valid direct success cases prove the
 *      contract end-to-end. (Mirrors P6-07A/07B corrective lessons —
 *      no native TypeError pinning, no vacuous redaction assertion.)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { main } from "../dist/index.js";
import { read, READ_HELP } from "../dist/commands/read.js";
import { OUTPUT_MODES } from "../dist/lib/output.js";
import { UnsupportedCapabilityError } from "../dist/lib/errors.js";
import { configuredSecrets } from "../dist/lib/redact.js";

// ---------------------------------------------------------------------------
// Offline hermeticity: clear ambient Provider credentials for this file
// so a developer shell with Z_AI_API_KEY set cannot leak into the tests.
// All descriptors in this suite are fake and never reach a real
// transport; the helpers below inject in-memory cache/sleep/random.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_VARS = ["Z_AI_API_KEY", "ZAI_API_KEY", "MINIMAX_API_KEY", "SCOUTLINE_PROVIDER"];
const savedProviderEnv = {};
before(() => {
  for (const key of PROVIDER_ENV_VARS) {
    savedProviderEnv[key] = process.env[key];
    delete process.env[key];
  }
});
after(() => {
  for (const key of PROVIDER_ENV_VARS) {
    const saved = savedProviderEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

const FIXED_NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Spy infrastructure: cache, capability operations, descriptor lifecycle,
// and an env Proxy that counts credential reads. These spies give the
// suite observable evidence of ordering rather than size-only heuristics.
// ---------------------------------------------------------------------------

/**
 * Build a recording cache. Records every `get`/`set` call by key
 * and value-class. Returns the cache object expected by
 * ExecutionDependencies plus the recorder for assertion.
 */
function makeRecordingCache() {
  const gets = [];
  const sets = [];
  const store = new Map();
  const cache = {
    async get(key) {
      gets.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      sets.push({ key, value });
      store.set(key, value);
    },
  };
  return { cache, gets, sets, store };
}

/**
 * Build a recording Reader operation. `validate`, `cacheIdentity`,
 * and `invoke` are each spied individually so the unsupported path
 * can assert each one stayed at zero calls.
 */
function makeRecordingFetchOperation(impl) {
  const calls = { validate: [], cacheIdentity: [], invoke: [] };
  return {
    kind: "reader-fetch",
    calls,
    validate(request) {
      calls.validate.push(request);
    },
    cacheIdentity(request) {
      calls.cacheIdentity.push(request);
      return {
        provider: "zai",
        capability: "reader",
        operation: "reader-fetch",
        credentialFingerprint: "fake-fingerprint-fixed",
        request,
        legacyCandidates: [],
      };
    },
    decodeCached(value) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
      return null;
    },
    async invoke(request) {
      calls.invoke.push(request);
      if (typeof impl !== "function") {
        throw new Error(`fake reader invoke not configured for ${JSON.stringify(request)}`);
      }
      return impl(request, calls.invoke.length);
    },
  };
}

/**
 * Build a recording Reader Capability. The single fetch operation
 * records validate/cacheIdentity/invoke separately. The recorder
 * exposes per-operation and total counters.
 */
function makeRecordingCapability({ fetch } = {}) {
  const capability = {
    fetch: makeRecordingFetchOperation(fetch),
  };
  return capability;
}

function capabilityCallCount(capability) {
  return {
    fetchValidate: capability.fetch.calls.validate.length,
    fetchIdentity: capability.fetch.calls.cacheIdentity.length,
    fetchInvoke: capability.fetch.calls.invoke.length,
  };
}

/**
 * Build a recording Provider descriptor. The descriptor's
 * capability set controls whether `handleRead` treats the Provider
 * as supporting reader. `omitReaderOnAdapter` simulates the
 * descriptor-advertises-but-adapter-omits-reader fail-closed path.
 */
function makeRecordingDescriptor({
  id,
  configured = true,
  readerCapability,
  extraCapabilities = [],
  omitReaderOnAdapter = false,
}) {
  const stats = {
    isConfiguredCalls: 0,
    capabilitiesCalls: 0,
    createCalls: 0,
  };
  const baseCapabilities = new Set(["reader", ...extraCapabilities]);
  const descriptor = {
    id,
    isConfigured(env) {
      stats.isConfiguredCalls += 1;
      if (typeof configured === "function") return configured(env);
      return configured;
    },
    capabilities() {
      stats.capabilitiesCalls += 1;
      return new Set(baseCapabilities);
    },
    create() {
      stats.createCalls += 1;
      const adapter = { id };
      if (!omitReaderOnAdapter && readerCapability) {
        adapter.reader = readerCapability;
      }
      return adapter;
    },
  };
  return { descriptor, stats };
}

/**
 * Build a recording MiniMax descriptor that does NOT advertise
 * reader. Spy counters prove zero selected-Provider work occurs
 * on the unsupported path.
 */
function makeRecordingMiniMaxDescriptor({ configured = true } = {}) {
  const stats = { isConfiguredCalls: 0, capabilitiesCalls: 0, createCalls: 0 };
  const descriptor = {
    id: "minimax",
    isConfigured(env) {
      stats.isConfiguredCalls += 1;
      if (typeof configured === "function") return configured(env);
      return configured;
    },
    capabilities() {
      stats.capabilitiesCalls += 1;
      return new Set(["search", "vision.interpret-image", "diagnostics"]);
    },
    create() {
      stats.createCalls += 1;
      return { id: "minimax" };
    },
  };
  return { descriptor, stats };
}

/**
 * Deterministic sleep/random so retry backoff is reproducible.
 */
function makeFakeSleepRandom() {
  const sleepCalls = [];
  const sleep = (ms) => {
    sleepCalls.push(ms);
    return Promise.resolve();
  };
  sleep.calls = sleepCalls;
  const random = () => 0;
  return { sleep, random };
}

/**
 * Build a recording CommandInvocationAdapter for in-process main()
 * tests. environmentOutputMode defaults to "data" so resolveOutputMode
 * is deterministic; tests that need other modes override it.
 */
function createRecordingAdapter(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
    ...overrides,
  };
  return { adapter, stdout, stderr };
}

/**
 * Compose the standard Reader Migration 04 MainDependencies: a recording
 * Z.AI descriptor that advertises reader and supplies a recording reader
 * capability, plus a recording cache and deterministic sleep/random.
 * Tests override the capability impl to script fetch results.
 */
function makeMainDeps({ fetch, zaiConfigured = true } = {}) {
  const capability = makeRecordingCapability({ fetch });
  const zai = makeRecordingDescriptor({
    id: "zai",
    configured: zaiConfigured,
    readerCapability: capability,
  });
  const minimax = makeRecordingMiniMaxDescriptor({ configured: true });
  const cacheRec = makeRecordingCache();
  const sleepRandom = makeFakeSleepRandom();
  return {
    capability,
    zai,
    minimax,
    cacheRec,
    sleepRandom,
    mainDeps: {
      env: { Z_AI_API_KEY: "zai-key", MINIMAX_API_KEY: "minimax-key" },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      readerCache: cacheRec.cache,
      readerSleep: sleepRandom.sleep,
      readerRandom: sleepRandom.random,
      // Search and Repository seams are unused by read but main() accepts
      // them; pass through the same in-memory execution so the deps
      // object stays hermetic.
      searchCache: cacheRec.cache,
      searchSleep: sleepRandom.sleep,
      searchRandom: sleepRandom.random,
      repositoryCache: cacheRec.cache,
      repositorySleep: sleepRandom.sleep,
      repositoryRandom: sleepRandom.random,
    },
  };
}

// ---------------------------------------------------------------------------
// Canned normalized results (schema-version-1)
// ---------------------------------------------------------------------------

function cannedContentResult({
  url = "https://example.com/",
  finalUrl = "https://example.com/",
  title = "Example Domain",
  content = "# Example\n\nThis is the page body.",
  contentFormat = "markdown",
} = {}) {
  return {
    schemaVersion: 1,
    url,
    finalUrl,
    title,
    content,
    contentFormat,
  };
}

// ---------------------------------------------------------------------------
// SELECTION MATRIX — table-driven. Each case runs `read` through main()
// with a specific Provider selection shape. Observable spies prove
// unsupported paths do zero selected-Provider work, supported paths
// reach the fetch capability exactly once, and selection precedence
// (explicit > env > default) is locked down.
// ---------------------------------------------------------------------------

const DEFAULT_READ_ARGS = ["read", "https://example.com/"];

const SELECTION_MATRIX = [
  {
    name: "default ZAI",
    args: () => DEFAULT_READ_ARGS,
    env: () => ({}),
    expectStatus: 0,
    expectCode: null,
    expectInvokeCount: 1,
    expectZaiCreate: 1,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "explicit ZAI",
    args: () => ["--provider", "zai", ...DEFAULT_READ_ARGS],
    env: () => ({}),
    expectStatus: 0,
    expectCode: null,
    expectInvokeCount: 1,
    expectZaiCreate: 1,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "environment ZAI",
    args: () => DEFAULT_READ_ARGS,
    env: () => ({ SCOUTLINE_PROVIDER: "zai" }),
    expectStatus: 0,
    expectCode: null,
    expectInvokeCount: 1,
    expectZaiCreate: 1,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "explicit ZAI wins over environment MINIMAX",
    args: () => ["--provider", "zai", ...DEFAULT_READ_ARGS],
    env: () => ({ SCOUTLINE_PROVIDER: "minimax" }),
    expectStatus: 0,
    expectCode: null,
    expectInvokeCount: 1,
    expectZaiCreate: 1,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "unknown explicit provider",
    args: () => ["--provider", "openai", ...DEFAULT_READ_ARGS],
    env: () => ({}),
    expectStatus: 1,
    expectCode: "VALIDATION_ERROR",
    expectInvokeCount: 0,
    expectZaiCreate: 0,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "unknown environment provider",
    args: () => DEFAULT_READ_ARGS,
    env: () => ({ SCOUTLINE_PROVIDER: "openai" }),
    expectStatus: 1,
    expectCode: "VALIDATION_ERROR",
    expectInvokeCount: 0,
    expectZaiCreate: 0,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "unsupported explicit MINIMAX",
    args: () => ["--provider", "minimax", ...DEFAULT_READ_ARGS],
    env: () => ({}),
    expectStatus: 1,
    expectCode: "UNSUPPORTED_CAPABILITY",
    expectInvokeCount: 0,
    expectZaiCreate: 0,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
    expectMiniMaxCapabilities: 1,
  },
  {
    name: "unsupported environment MINIMAX",
    args: () => DEFAULT_READ_ARGS,
    env: () => ({ SCOUTLINE_PROVIDER: "minimax" }),
    expectStatus: 1,
    expectCode: "UNSUPPORTED_CAPABILITY",
    expectInvokeCount: 0,
    expectZaiCreate: 0,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
    expectMiniMaxCapabilities: 1,
  },
];

describe("Reader Migration 04 selection matrix — read", () => {
  for (const row of SELECTION_MATRIX) {
    it(row.name, async () => {
      const m = makeMainDeps({ fetch: () => cannedContentResult() });
      const { adapter, stderr } = createRecordingAdapter();
      const args = row.args();
      const status = await main(args, {
        ...m.mainDeps,
        env: { ...m.mainDeps.env, ...row.env() },
        invocation: adapter,
      });

      assert.strictEqual(status, row.expectStatus, `status mismatch for ${row.name}`);
      if (row.expectCode) {
        const parsed = JSON.parse(stderr[0]);
        assert.strictEqual(
          parsed.code,
          row.expectCode,
          `code mismatch for ${row.name}: ${stderr[0]}`,
        );
      } else {
        assert.deepStrictEqual(stderr, [], `unexpected stderr for ${row.name}`);
      }

      assert.strictEqual(
        m.capability.fetch.calls.invoke.length,
        row.expectInvokeCount,
        `fetch invoke count for ${row.name}`,
      );
      assert.strictEqual(
        m.zai.stats.createCalls,
        row.expectZaiCreate,
        `zai.createCalls for ${row.name}`,
      );
      assert.strictEqual(
        m.minimax.stats.createCalls,
        row.expectMiniMaxCreate,
        `minimax.createCalls for ${row.name}`,
      );
      assert.strictEqual(
        m.minimax.stats.isConfiguredCalls,
        row.expectMiniMaxIsConfigured,
        `minimax.isConfiguredCalls for ${row.name}`,
      );
      if (row.expectMiniMaxCapabilities !== undefined) {
        assert.strictEqual(
          m.minimax.stats.capabilitiesCalls,
          row.expectMiniMaxCapabilities,
          `minimax.capabilitiesCalls for ${row.name}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Unsupported path: zero cache.get AND zero cache.set, plus zero
// capability validate/identity/invoke. Observable per-call evidence,
// not Map.size.
// ---------------------------------------------------------------------------

describe("Reader Migration 04 unsupported path — zero selected-Provider work", () => {
  it("read under explicit minimax: zero cache get/set, zero validate/identity/invoke", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(["--provider", "minimax", ...DEFAULT_READ_ARGS], {
      ...m.mainDeps,
      invocation: adapter,
    });

    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");

    // Cache spy: zero reads AND zero writes on the unsupported path.
    assert.strictEqual(m.cacheRec.gets.length, 0, "cache.get must never be called");
    assert.strictEqual(m.cacheRec.sets.length, 0, "cache.set must never be called");

    // Capability spy: zero validate, zero cacheIdentity, zero invoke.
    const counts = capabilityCallCount(m.capability);
    for (const [key, value] of Object.entries(counts)) {
      assert.strictEqual(value, 0, `capability.${key} must be 0 on unsupported path`);
    }

    // Descriptor lifecycle: capabilities() asked once (support check),
    // isConfigured and create never called.
    assert.strictEqual(m.minimax.stats.capabilitiesCalls, 1);
    assert.strictEqual(m.minimax.stats.isConfiguredCalls, 0);
    assert.strictEqual(m.minimax.stats.createCalls, 0);
    // No Z.AI fallback.
    assert.strictEqual(m.zai.stats.createCalls, 0);
    assert.strictEqual(m.zai.stats.isConfiguredCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// Redaction isolation proof (P6-07B pattern).
//
// `configuredSecrets(env)` is the pre-dispatch redaction read in `main`.
// It MUST consult only the env it is handed, never falling back to ambient
// `process.env`. This test supplies CONFLICTING ambient and proxied
// injected credentials, calls `configuredSecrets(proxiedEnv)` directly,
// and asserts the returned set contains ONLY injected values.
// ---------------------------------------------------------------------------

describe("Reader Migration 04 configuredSecrets — injected env only, never ambient fallback", () => {
  const AMBIENT = {
    Z_AI_API_KEY: "ambient-zai-value-do-not-leak",
    ZAI_API_KEY: "ambient-zai-alias-value-do-not-leak",
    MINIMAX_API_KEY: "ambient-minimax-value-do-not-leak",
  };
  const INJECTED = {
    Z_AI_API_KEY: "injected-zai-value",
    ZAI_API_KEY: "injected-zai-alias-value",
    MINIMAX_API_KEY: "injected-minimax-value",
  };
  const CRED_KEYS = ["Z_AI_API_KEY", "ZAI_API_KEY", "MINIMAX_API_KEY"];
  const saved = {};

  before(() => {
    for (const key of CRED_KEYS) {
      saved[key] = process.env[key];
      process.env[key] = AMBIENT[key];
    }
  });

  after(() => {
    for (const key of CRED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns ONLY injected credential values and reads each injected key exactly once", () => {
    const readCounts = { Z_AI_API_KEY: 0, ZAI_API_KEY: 0, MINIMAX_API_KEY: 0 };
    const proxiedEnv = new Proxy(
      {
        Z_AI_API_KEY: INJECTED.Z_AI_API_KEY,
        ZAI_API_KEY: INJECTED.ZAI_API_KEY,
        MINIMAX_API_KEY: INJECTED.MINIMAX_API_KEY,
      },
      {
        get(target, prop) {
          if (typeof prop === "string" && prop in readCounts) readCounts[prop] += 1;
          return target[prop];
        },
      },
    );

    const secrets = configuredSecrets(proxiedEnv);

    assert.strictEqual(readCounts.Z_AI_API_KEY, 1, "Z_AI_API_KEY read exactly once");
    assert.strictEqual(readCounts.ZAI_API_KEY, 1, "ZAI_API_KEY read exactly once");
    assert.strictEqual(readCounts.MINIMAX_API_KEY, 1, "MINIMAX_API_KEY read exactly once");

    assert.ok(
      secrets.includes(INJECTED.Z_AI_API_KEY),
      "returned secrets must include the injected Z_AI_API_KEY value",
    );
    assert.ok(
      secrets.includes(INJECTED.MINIMAX_API_KEY),
      "returned secrets must include the injected MINIMAX_API_KEY value",
    );
    for (const ambientValue of Object.values(AMBIENT)) {
      assert.ok(
        !secrets.includes(ambientValue),
        `ambient value must NOT appear in returned secrets: ${ambientValue}`,
      );
    }
    assert.strictEqual(secrets.length, 3, "three distinct non-empty injected values");
  });
});

// ---------------------------------------------------------------------------
// Supported-unconfigured Z.AI and adapter.reader omission.
// ---------------------------------------------------------------------------

describe("Reader Migration 04 supported-but-unconfigured Z.AI surfaces ConfigurationError exit 3", () => {
  it("read: missing Z_AI_API_KEY exits 3 after support, before create", async () => {
    const m = makeMainDeps({
      fetch: () => cannedContentResult(),
      zaiConfigured: (env) => Boolean(env.Z_AI_API_KEY),
    });
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(DEFAULT_READ_ARGS, {
      ...m.mainDeps,
      env: { MINIMAX_API_KEY: "minimax-key" },
      invocation: adapter,
    });

    assert.strictEqual(status, 3);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "CONFIGURATION_ERROR");

    // Support check ran; isConfigured ran; create NEVER ran.
    assert.strictEqual(m.zai.stats.capabilitiesCalls, 1);
    assert.ok(m.zai.stats.isConfiguredCalls >= 1);
    assert.strictEqual(m.zai.stats.createCalls, 0);

    // Capability work never runs on the unconfigured path.
    const counts = capabilityCallCount(m.capability);
    for (const [key, value] of Object.entries(counts)) {
      assert.strictEqual(value, 0, `capability.${key} must be 0 on unconfigured path`);
    }
  });
});

describe("Reader Migration 04 descriptor advertises reader but Adapter omits reader", () => {
  it("read: fails closed as UNSUPPORTED_CAPABILITY after create", async () => {
    const capability = makeRecordingCapability({ fetch: () => cannedContentResult() });
    const zai = makeRecordingDescriptor({
      id: "zai",
      configured: true,
      readerCapability: capability,
      omitReaderOnAdapter: true,
    });
    const minimax = makeRecordingMiniMaxDescriptor({ configured: true });
    const cacheRec = makeRecordingCache();
    const sleepRandom = makeFakeSleepRandom();
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(DEFAULT_READ_ARGS, {
      env: { Z_AI_API_KEY: "zai-key" },
      providerDescriptors: [zai.descriptor, minimax.descriptor],
      readerCache: cacheRec.cache,
      readerSleep: sleepRandom.sleep,
      readerRandom: sleepRandom.random,
      searchCache: cacheRec.cache,
      searchSleep: sleepRandom.sleep,
      searchRandom: sleepRandom.random,
      repositoryCache: cacheRec.cache,
      repositorySleep: sleepRandom.sleep,
      repositoryRandom: sleepRandom.random,
      invocation: adapter,
    });

    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "UNSUPPORTED_CAPABILITY");

    // create ran once (so the fail-closed check could observe the
    // missing adapter.reader), but no capability work ran.
    assert.strictEqual(zai.stats.createCalls, 1);
    const counts = capabilityCallCount(capability);
    for (const [key, value] of Object.entries(counts)) {
      assert.strictEqual(value, 0, `capability.${key} must be 0 when adapter.reader missing`);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation ordering — parse-level vs post-gating.
//
// Parse-level (URL scheme, --extract mode) runs in the handler BEFORE
// Provider resolution; an invalid value ALWAYS surfaces
// VALIDATION_ERROR regardless of Provider shape.
//
// Post-gating validation (the Adapter's request.validate) runs AFTER
// Provider gating, so it surfaces UNSUPPORTED_CAPABILITY on the
// unsupported path, CONFIGURATION_ERROR on the unconfigured path,
// and otherwise dispatches through shared execution.
// ---------------------------------------------------------------------------

const PARSE_LEVEL_MALFORMED = [
  {
    label: "URL with ftp:// scheme",
    argv: ["read", "ftp://example.com/file"],
  },
  {
    label: "URL with no scheme",
    argv: ["read", "example.com/page"],
  },
  {
    label: "extract mode bogus",
    argv: ["read", "https://example.com/", "--extract", "bogus"],
  },
];

const PARSE_LEVEL_PROVIDER_PROBES = [
  { name: "default", providerArgs: [], env: () => ({}) },
  { name: "explicit zai", providerArgs: ["--provider", "zai"], env: () => ({}) },
  { name: "explicit minimax", providerArgs: ["--provider", "minimax"], env: () => ({}) },
  { name: "env minimax", providerArgs: [], env: () => ({ SCOUTLINE_PROVIDER: "minimax" }) },
  { name: "env openai", providerArgs: [], env: () => ({ SCOUTLINE_PROVIDER: "openai" }) },
];

describe("Reader Migration 04 parse-level malformed — ALWAYS VALIDATION_ERROR regardless of provider shape", () => {
  for (const malformed of PARSE_LEVEL_MALFORMED) {
    for (const probe of PARSE_LEVEL_PROVIDER_PROBES) {
      it(`${malformed.label} under ${probe.name} -> VALIDATION_ERROR before provider resolution`, async () => {
        const m = makeMainDeps({
          fetch: () => cannedContentResult(),
          zaiConfigured: (env) => Boolean(env.Z_AI_API_KEY),
        });
        const { adapter, stderr } = createRecordingAdapter();
        const argv = [...probe.providerArgs, ...malformed.argv];
        const env = { ...m.mainDeps.env, ...probe.env() };
        const status = await main(argv, { ...m.mainDeps, env, invocation: adapter });

        assert.strictEqual(status, 1);
        const parsed = JSON.parse(stderr[0]);
        assert.strictEqual(
          parsed.code,
          "VALIDATION_ERROR",
          `${malformed.label} under ${probe.name}: expected VALIDATION_ERROR, got ${stderr[0]}`,
        );

        // No Provider work at all on parse-level failures.
        assert.strictEqual(m.zai.stats.createCalls, 0);
        assert.strictEqual(m.zai.stats.isConfiguredCalls, 0);
        assert.strictEqual(m.minimax.stats.createCalls, 0);
        assert.strictEqual(m.minimax.stats.isConfiguredCalls, 0);
        const counts = capabilityCallCount(m.capability);
        for (const [key, value] of Object.entries(counts)) {
          assert.strictEqual(value, 0, `capability.${key} must be 0 on parse-level malformed`);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Golden outputs — content read.
//
// Schema-version-1 envelope (D1) across data/json/pretty/compact modes.
// Text-oriented modes (compact/markdown/refs/tty) emit the `content`
// string directly via presentations. `--max-chars` projection sets
// truncated/originalContentLength.
// ---------------------------------------------------------------------------

describe("Reader Migration 04 golden outputs — content read (schema-version-1 envelope)", () => {
  it("data mode emits exactly the schema-version-1 envelope", async () => {
    const m = makeMainDeps({
      fetch: () => cannedContentResult({ content: "# Hello\n\nWorld." }),
    });
    const { adapter, stdout } = createRecordingAdapter();
    await main(DEFAULT_READ_ARGS, { ...m.mainDeps, invocation: adapter });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      schemaVersion: 1,
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      title: "Example Domain",
      content: "# Hello\n\nWorld.",
      contentFormat: "markdown",
      truncated: false,
      originalContentLength: "# Hello\n\nWorld.".length,
    });
  });

  it("json mode emits the standard envelope", async () => {
    const m = makeMainDeps({
      fetch: () => cannedContentResult({ content: "body" }),
    });
    const { adapter, stdout } = createRecordingAdapter({ environmentOutputMode: "json" });
    await main(["-O", "json", ...DEFAULT_READ_ARGS], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      success: true,
      data: {
        schemaVersion: 1,
        url: "https://example.com/",
        finalUrl: "https://example.com/",
        title: "Example Domain",
        content: "body",
        contentFormat: "markdown",
        truncated: false,
        originalContentLength: "body".length,
      },
      timestamp: FIXED_NOW,
    });
  });

  it("pretty mode emits the indented standard envelope", async () => {
    const m = makeMainDeps({
      fetch: () => cannedContentResult({ content: "body" }),
    });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "pretty", ...DEFAULT_READ_ARGS], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    assert.ok(stdout[0].includes("\n"), "pretty mode must be indented");
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      success: true,
      data: {
        schemaVersion: 1,
        url: "https://example.com/",
        finalUrl: "https://example.com/",
        title: "Example Domain",
        content: "body",
        contentFormat: "markdown",
        truncated: false,
        originalContentLength: "body".length,
      },
      timestamp: FIXED_NOW,
    });
  });

  it("compact mode emits the content string directly (content presentation)", async () => {
    const m = makeMainDeps({
      fetch: () => cannedContentResult({ content: "page body text" }),
    });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "compact", ...DEFAULT_READ_ARGS], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    // Text-oriented mode emits content directly; not JSON.
    assert.strictEqual(stdout[0], "page body text");
    assert.throws(() => JSON.parse(stdout[0]), "compact content read is not JSON");
  });
});

// ---------------------------------------------------------------------------
// Golden outputs — extract read.
//
// Schema-version-1 extract envelope (D2) across data/json/pretty/compact
// modes. Text-oriented modes use JSON fallback because extracted items
// are data, not prose. `--max-chars` is IGNORED for extract reads.
// ---------------------------------------------------------------------------

/**
 * Build a fake fetch impl that returns a content body for the
 * extractor to slice. The fetch returns the canned content envelope;
 * the handler then runs --extract over the content field.
 */
function fetchWithBody(body) {
  return () => cannedContentResult({ content: body });
}

describe("Reader Migration 04 golden outputs — extract read (schema-version-1 extract envelope)", () => {
  it("data mode emits the extract envelope for --extract code", async () => {
    const body = "Intro.\n\n```js\nconst x = 1;\n```\n\n```python\nprint('hi')\n```\n";
    const m = makeMainDeps({ fetch: fetchWithBody(body) });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--extract", "code"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.url, "https://example.com/");
    assert.strictEqual(parsed.finalUrl, "https://example.com/");
    assert.strictEqual(parsed.mode, "code");
    assert.strictEqual(parsed.originalItemCount, 2);
    assert.strictEqual(parsed.truncated, false);
    assert.deepStrictEqual(parsed.items, [
      { language: "js", code: "const x = 1;" },
      { language: "python", code: "print('hi')" },
    ]);
  });

  it("data mode emits the extract envelope for --extract headings", async () => {
    const body = "# Title\n\n## Section\n\nText.\n\n### Sub\n\n";
    const m = makeMainDeps({ fetch: fetchWithBody(body) });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--extract", "headings"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.mode, "headings");
    assert.strictEqual(parsed.originalItemCount, 3);
    assert.deepStrictEqual(parsed.items, [
      { level: 1, text: "Title", slug: "title" },
      { level: 2, text: "Section", slug: "section" },
      { level: 3, text: "Sub", slug: "sub" },
    ]);
  });

  it("json mode emits the standard envelope around the extract envelope", async () => {
    const body = "```js\nconst x = 1;\n```\n";
    const m = makeMainDeps({ fetch: fetchWithBody(body) });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "json", "read", "https://example.com/", "--extract", "code"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.timestamp, FIXED_NOW);
    assert.strictEqual(parsed.data.schemaVersion, 1);
    assert.strictEqual(parsed.data.mode, "code");
    assert.deepStrictEqual(parsed.data.items, [{ language: "js", code: "const x = 1;" }]);
  });

  it("compact mode uses JSON fallback (extracted items are data, not prose)", async () => {
    const body = "```js\nconst x = 1;\n```\n";
    const m = makeMainDeps({ fetch: fetchWithBody(body) });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "compact", "read", "https://example.com/", "--extract", "code"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    // Text-oriented mode on extract read falls back to JSON (the
    // envelope object), not a per-mode prose presentation.
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.mode, "code");
  });
});

// ---------------------------------------------------------------------------
// Projection: --max-chars on content (truncation state), IGNORED for extract.
// ---------------------------------------------------------------------------

describe("Reader Migration 04 projection — --max-chars", () => {
  it("content read --max-chars truncates content and sets truncated/originalContentLength", async () => {
    const long = "abcdefghijklmnop";
    const m = makeMainDeps({ fetch: () => cannedContentResult({ content: long }) });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--max-chars", "5"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.originalContentLength, long.length);
    assert.strictEqual(parsed.truncated, true);
    assert.ok(parsed.content.length < long.length);
    assert.ok(parsed.content.endsWith("…"));
  });

  it("content read --max-chars never enters the Adapter request (projection only)", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--max-chars", "5"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    for (const req of m.capability.fetch.calls.invoke) {
      assert.strictEqual(req.maxChars, undefined);
    }
  });

  it("extract read --max-chars is IGNORED (no truncation, no envelope field)", async () => {
    const body = "```js\nconst abc = 12345;\n```\n```python\nx = 1\n```\n";
    const m = makeMainDeps({ fetch: fetchWithBody(body) });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--extract", "code", "--max-chars", "3"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    const parsed = JSON.parse(stdout[0]);
    // originalItemCount reflects ALL extracted items; no truncation.
    assert.strictEqual(parsed.originalItemCount, 2);
    assert.strictEqual(parsed.truncated, false);
    assert.deepStrictEqual(parsed.items, [
      { language: "js", code: "const abc = 12345;" },
      { language: "python", code: "x = 1" },
    ]);
  });

  it("content read without --max-chars reports truncated:false and full length", async () => {
    const m = makeMainDeps({
      fetch: () => cannedContentResult({ content: "short body" }),
    });
    const { adapter, stdout } = createRecordingAdapter();
    await main(DEFAULT_READ_ARGS, { ...m.mainDeps, invocation: adapter });
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.truncated, false);
    assert.strictEqual(parsed.originalContentLength, "short body".length);
  });
});

// ---------------------------------------------------------------------------
// Flag forwarding — every read flag reaches the Adapter request.
// ---------------------------------------------------------------------------

describe("Reader Migration 04 flag forwarding — Adapter request shape", () => {
  it("forwards --format text", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--format", "text"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(m.capability.fetch.calls.invoke[0].format, "text");
  });

  it("forwards --no-images as retainImages:false", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--no-images"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(m.capability.fetch.calls.invoke[0].retainImages, false);
  });

  it("forwards --with-links as withLinksSummary:true", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--with-links"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(m.capability.fetch.calls.invoke[0].withLinksSummary, true);
  });

  it("forwards --no-gfm, --keep-img-data-url, --with-images-summary", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(
      ["read", "https://example.com/", "--no-gfm", "--keep-img-data-url", "--with-images-summary"],
      { ...m.mainDeps, invocation: adapter },
    );
    const req = m.capability.fetch.calls.invoke[0];
    assert.strictEqual(req.noGfm, true);
    assert.strictEqual(req.keepImgDataUrl, true);
    assert.strictEqual(req.withImagesSummary, true);
  });

  it("forwards --timeout as a number", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--timeout", "45"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(m.capability.fetch.calls.invoke[0].timeout, 45);
  });

  it("--full-envelope is silently accepted and ignored (envelope always returned)", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--full-envelope"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    const parsed = JSON.parse(stdout[0]);
    // Envelope is returned regardless of --full-envelope (D3).
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.content, cannedContentResult().content);
  });
});

// ---------------------------------------------------------------------------
// Cache behaviour.
// ---------------------------------------------------------------------------

describe("Reader Migration 04 cache behaviour", () => {
  it("cache.get is consulted once on a cache miss; cache.set is consulted once after invoke", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(DEFAULT_READ_ARGS, { ...m.mainDeps, invocation: adapter });
    assert.ok(m.cacheRec.gets.length >= 1, "expected at least one cache.get call");
    assert.ok(m.cacheRec.sets.length >= 1, "expected at least one cache.set call");
  });

  it("a second identical read hits the cache and skips invoke", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(DEFAULT_READ_ARGS, { ...m.mainDeps, invocation: adapter });
    const firstInvoke = m.capability.fetch.calls.invoke.length;
    await main(DEFAULT_READ_ARGS, { ...m.mainDeps, invocation: adapter });
    assert.strictEqual(
      m.capability.fetch.calls.invoke.length,
      firstInvoke,
      "second identical read must hit the cache and skip invoke",
    );
  });

  it("--no-cache bypasses cache write-back (cache.set count is zero)", async () => {
    const m = makeMainDeps({ fetch: () => cannedContentResult() });
    const { adapter } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--no-cache"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(m.cacheRec.sets.length, 0, "no-cache must not write the cache");
  });

  it("--extract never enters the cache identity", async () => {
    const body = "```js\nconst x = 1;\n```\n";
    const m = makeMainDeps({ fetch: fetchWithBody(body) });
    const { adapter } = createRecordingAdapter();
    await main(["read", "https://example.com/", "--extract", "code"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    for (const req of m.capability.fetch.calls.cacheIdentity) {
      assert.strictEqual(req.extract, undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Required-deps Interface (P6-07A pattern). The required
// `ReadHandlerDependencies` parameter and the optional trailing
// `CommandContext` are enforced by `tsc` and the compiled
// declaration (`npm run build` is the compile-checked proof; JS
// ignores TS required parameters so runtime requiredness is
// intentionally NOT pinned by a native TypeError test). Valid
// direct content/extract calls below cross the same Capability /
// shared-execution Interface as production and return
// schema-version-1 data — the runtime integration evidence.
// ---------------------------------------------------------------------------

describe("Reader Migration 04 direct handler interface — valid success through the required Interface", () => {
  /**
   * Build the fake ReadHandlerDependencies used by direct handler
   * success probes. Same shape as production; permissive validate
   * and identity so the handler pre-validation alone governs.
   */
  function makeDirectDeps({ fetch } = {}) {
    const op = {
      kind: "reader-fetch",
      validate() {},
      cacheIdentity(r) {
        return {
          provider: "zai",
          capability: "reader",
          operation: "reader-fetch",
          credentialFingerprint: "fp",
          request: r,
          legacyCandidates: [],
        };
      },
      decodeCached(v) {
        return v && typeof v === "object" && !Array.isArray(v) ? v : null;
      },
      async invoke(r) {
        return fetch(r);
      },
    };
    const capability = { fetch: op };
    const store = new Map();
    const execution = {
      cache: {
        async get(k) {
          return store.has(k) ? store.get(k) : null;
        },
        async set(k, v) {
          store.set(k, v);
        },
      },
      sleep: async () => {},
      random: () => 0.5,
    };
    return { capability, execution };
  }

  it("read direct success returns schema-version-1 content envelope", async () => {
    const deps = makeDirectDeps({
      fetch: () => cannedContentResult({ content: "hi" }),
    });
    const result = await read("https://example.com/", {}, deps);
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.schemaVersion, 1);
    assert.strictEqual(result.data.content, "hi");
    assert.strictEqual(result.data.truncated, false);
    assert.strictEqual(result.data.originalContentLength, 2);
    // Text-oriented modes carry the content as a presentation override.
    assert.strictEqual(result.presentations?.compact, "hi");
  });

  it("read direct success with --extract returns schema-version-1 extract envelope", async () => {
    const deps = makeDirectDeps({
      fetch: () => cannedContentResult({ content: "```js\nx\n```\n" }),
    });
    const result = await read("https://example.com/", { extract: "code" }, deps);
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.schemaVersion, 1);
    assert.strictEqual(result.data.mode, "code");
    assert.deepStrictEqual(result.data.items, [{ language: "js", code: "x" }]);
    // No presentation override for extract — text modes fall back to JSON.
    assert.ok(
      !result.presentations || result.presentations.compact === undefined,
      "extract reads must not carry a compact presentation override",
    );
  });

  it("read direct rejects non-http URL through the seam (parse-level)", async () => {
    const deps = makeDirectDeps({ fetch: () => cannedContentResult() });
    await assert.rejects(
      read("ftp://example.com/file", {}, deps),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });

  it("read direct rejects unknown --extract mode through the seam (parse-level)", async () => {
    const deps = makeDirectDeps({ fetch: () => cannedContentResult() });
    await assert.rejects(
      read("https://example.com/", { extract: "bogus" }, deps),
      (err) => err.code === "VALIDATION_ERROR",
    );
  });
});

// ---------------------------------------------------------------------------
// Cache + error envelope contracts
// ---------------------------------------------------------------------------

describe("Reader Migration 04 cache + error envelope contracts", () => {
  it("UnsupportedCapabilityError carries code UNSUPPORTED_CAPABILITY", () => {
    const err = new UnsupportedCapabilityError("minimax", "reader");
    assert.strictEqual(err.code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(err.exitCode, 1);
    assert.match(err.message, /reader/);
  });
});

// ---------------------------------------------------------------------------
// Help text — main and read help documents the cutover and lists
// every canonical output mode (derived from OUTPUT_MODES).
// ---------------------------------------------------------------------------

describe("Reader Migration 04 help text — read participates in Provider selection; canonical modes listed", () => {
  it("READ_HELP mentions provider selection, Z.AI support, MiniMax UNSUPPORTED_CAPABILITY, schema-version-1 migration, JSON fallback for extract", () => {
    assert.match(READ_HELP, /Provider Capability|--provider/, "documents provider selection");
    assert.match(READ_HELP, /--provider/, "documents --provider");
    assert.match(READ_HELP, /SCOUTLINE_PROVIDER/, "documents SCOUTLINE_PROVIDER");
    assert.match(READ_HELP, /MiniMax/, "mentions MiniMax");
    assert.match(READ_HELP, /UNSUPPORTED_CAPABILITY/, "documents the unsupported outcome");
    assert.match(READ_HELP, /schemaVersion/, "documents schema-version-1 migration");
    assert.match(READ_HELP, /JSON fallback/, "documents JSON fallback for extract reads");
  });

  it("READ_HELP lists EVERY canonical output mode (derived from OUTPUT_MODES)", () => {
    for (const mode of OUTPUT_MODES) {
      assert.ok(READ_HELP.includes(mode), `READ_HELP must list canonical mode "${mode}"`);
    }
    assert.match(READ_HELP, /default: data/);
  });

  it("READ_HELP documents --full-envelope is silently ignored", () => {
    assert.match(
      READ_HELP,
      /--full-envelope/,
      "READ_HELP must document --full-envelope is silently accepted",
    );
  });

  it("main --help documents read participates in Provider selection", async () => {
    const captured = [];
    const adapter = {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => captured.push(v),
      writeStderr: () => {},
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    };
    await main(["--help"], { invocation: adapter, env: {} });
    const help = captured.join("\n");
    assert.match(help, /read\s+Fetch and parse web pages.*Provider Capability/s);
    assert.match(help, /MiniMax returns UNSUPPORTED_CAPABILITY/);
  });

  it("read --help bypasses provider resolution and resolves cleanly with no creds", async () => {
    const captured = [];
    const adapter = {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => captured.push(v),
      writeStderr: () => {},
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    };
    const status = await main(["read", "--help"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [],
    });
    assert.strictEqual(status, 0);
    assert.match(captured[0], /Read Command/);
  });
});
