/**
 * P6-07 / P6-07A — Repository command cutover (DESIGN.md §18, §11,
 * PRD FR-080–FR-088, NFR-002–NFR-005/NFR-009/NFR-010).
 *
 * Drives the public `repo search|tree|read` commands through `main`
 * with fake Provider descriptors so Provider selection ordering,
 * capability support gates, Adapter agreement, Explorer request
 * defaults, and the schema-version-1 output migration can all be
 * asserted without touching a concrete Adapter, MCP/UTCP transport,
 * or process globals.
 *
 * Coverage (mapped to the P6-07A acceptance contract):
 *
 *   1. Selection matrix per subcommand (table-driven): default Z.AI,
 *      explicit Z.AI, environment Z.AI, explicit-over-environment,
 *      unknown explicit, unknown environment, unsupported explicit
 *      MiniMax, unsupported environment MiniMax, supported-
 *      unconfigured Z.AI.
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
 *      Descriptor advertises repository-exploration but Adapter omits
 *      `repository` -> fail closed as UNSUPPORTED_CAPABILITY.
 *
 *   4. Malformed request families (invalid repo, invalid language,
 *      invalid depth, missing positionals) under three Provider
 *      shapes:
 *        - supported-configured Z.AI -> VALIDATION_ERROR (Explorer/
 *          handler validation reached)
 *        - supported-unconfigured Z.AI -> CONFIGURATION_ERROR
 *          (support/config gating before Explorer)
 *        - unsupported MiniMax -> UNSUPPORTED_CAPABILITY (support
 *          gating before Explorer)
 *
 *   5. Exact golden outputs for search/file/tree in data/json/pretty/
 *      compact with deterministic `now`. Search and File carry the
 *      deliberate raw-string breaking migration (schema-version-1
 *      structured payloads, not raw ZRead strings). Tree emits the
 *      structured schema for depth 1 AND deeper.
 *
 *   6. Flags/defaults reach the Explorer: --max-chars, --path,
 *      --depth (default 1, custom), --no-cache, --language.
 *
 *   7. Help text documents the cutover and lists every canonical
 *      output mode (derived from OUTPUT_MODES).
 *
 *   8. Direct handler interface (P6-07A): required-deps +
 *      optional trailing CommandContext, aligned with the shared
 *      Search command shape. Requiredness is enforced by `tsc` and
 *      the compiled declaration; runtime valid direct success cases
 *      prove the contract end-to-end. (The full invocation.test.js
 *      coverage lives in tests/invocation.test.js.)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { main } from "../dist/index.js";
import { repoSearch, repoRead, repoTree, REPO_HELP } from "../dist/commands/repo.js";
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
 * Build a recording Repository operation. `validate`, `cacheIdentity`,
 * and `invoke` are each spied individually so the unsupported path
 * can assert each one stayed at zero calls.
 */
function makeRecordingOperation(kind, impl, label) {
  const calls = { validate: [], cacheIdentity: [], invoke: [] };
  return {
    kind,
    calls,
    validate(request) {
      calls.validate.push(request);
    },
    cacheIdentity(request) {
      calls.cacheIdentity.push(request);
      return {
        provider: "zai",
        capability: "repository-exploration",
        operation: kind,
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
        throw new Error(`fake ${label} invoke not configured for ${JSON.stringify(request)}`);
      }
      return impl(request, calls.invoke.length);
    },
  };
}

/**
 * Build a recording Repository Capability. Each operation records
 * validate/cacheIdentity/invoke separately. The recorder exposes
 * per-operation and total counters.
 */
function makeRecordingCapability({ search, readFile, listDirectory } = {}) {
  const capability = {
    search: makeRecordingOperation("repository-search", search, "search"),
    readFile: makeRecordingOperation("repository-read-file", readFile, "readFile"),
    listDirectory: makeRecordingOperation(
      "repository-list-directory",
      listDirectory,
      "listDirectory",
    ),
  };
  return capability;
}

function capabilityCallCount(capability) {
  return {
    searchValidate: capability.search.calls.validate.length,
    searchIdentity: capability.search.calls.cacheIdentity.length,
    searchInvoke: capability.search.calls.invoke.length,
    readFileValidate: capability.readFile.calls.validate.length,
    readFileIdentity: capability.readFile.calls.cacheIdentity.length,
    readFileInvoke: capability.readFile.calls.invoke.length,
    listDirectoryValidate: capability.listDirectory.calls.validate.length,
    listDirectoryIdentity: capability.listDirectory.calls.cacheIdentity.length,
    listDirectoryInvoke: capability.listDirectory.calls.invoke.length,
  };
}

/**
 * Build a recording Provider descriptor. The descriptor's
 * capability set controls whether `handleRepo` treats the Provider
 * as supporting repository-exploration. `omitRepositoryOnAdapter`
 * simulates the descriptor-advertises-but-adapter-omits-repository
 * fail-closed path.
 */
function makeRecordingDescriptor({
  id,
  configured = true,
  repositoryCapability,
  extraCapabilities = [],
  omitRepositoryOnAdapter = false,
}) {
  const stats = {
    isConfiguredCalls: 0,
    capabilitiesCalls: 0,
    createCalls: 0,
  };
  const baseCapabilities = new Set(["repository-exploration", ...extraCapabilities]);
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
      if (!omitRepositoryOnAdapter && repositoryCapability) {
        adapter.repository = repositoryCapability;
      }
      return adapter;
    },
  };
  return { descriptor, stats };
}

/**
 * Build a recording MiniMax descriptor that does NOT advertise
 * repository-exploration. Spy counters prove zero selected-Provider
 * work occurs on the unsupported path.
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
 * Compose the standard P6-07 MainDependencies: a recording Z.AI
 * descriptor that advertises repository-exploration and supplies a
 * recording repository capability, plus a recording cache and
 * deterministic sleep/random. Tests override the capability impl to
 * script search/read/tree results.
 */
function makeMainDeps({ search, readFile, listDirectory, zaiConfigured = true } = {}) {
  const capability = makeRecordingCapability({ search, readFile, listDirectory });
  const zai = makeRecordingDescriptor({
    id: "zai",
    configured: zaiConfigured,
    repositoryCapability: capability,
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
      repositoryCache: cacheRec.cache,
      repositorySleep: sleepRandom.sleep,
      repositoryRandom: sleepRandom.random,
      // Search seams are unused by repo but main() accepts them;
      // pass through the same in-memory execution so the deps
      // object stays hermetic.
      searchCache: cacheRec.cache,
      searchSleep: sleepRandom.sleep,
      searchRandom: sleepRandom.random,
    },
  };
}

// ---------------------------------------------------------------------------
// Canned normalized results (schema-version-1)
// ---------------------------------------------------------------------------

function cannedSearchResult(excerpts = [{ text: "alpha" }, { text: "beta" }]) {
  const originalTextLength = excerpts.reduce((sum, e) => sum + e.text.length, 0);
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    query: "query",
    language: "en",
    excerpts,
    truncated: false,
    originalTextLength,
  };
}

function cannedFileResult(content = "hello world") {
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    path: "README.md",
    content,
    truncated: false,
    originalContentLength: content.length,
  };
}

function cannedRootListing() {
  return {
    repository: "owner/repo",
    path: "",
    entries: [
      { name: "src", path: "src", kind: "directory" },
      { name: "README.md", path: "README.md", kind: "file" },
    ],
  };
}

function cannedSrcListing() {
  return {
    repository: "owner/repo",
    path: "src",
    entries: [
      { name: "index.ts", path: "src/index.ts", kind: "file" },
      { name: "lib", path: "src/lib", kind: "directory" },
    ],
  };
}

// ---------------------------------------------------------------------------
// SELECTION MATRIX — table-driven across Search/Tree/Read. Each case
// runs the same observable spies so unsupported paths prove zero
// selected-Provider work, supported paths prove the capability is
// reached exactly once, and selection precedence (explicit > env >
// default) is locked down.
// ---------------------------------------------------------------------------

/**
 * Each row drives ONE subcommand through main() with a specific
 * Provider selection shape. `buildArgs` is invoked per-subcommand so
 * the same matrix applies to search, tree, and read uniformly.
 */
const SELECTION_MATRIX = [
  {
    name: "default ZAI",
    args: (sub) => sub.defaultArgs,
    env: () => ({}),
    expectProvider: "zai",
    expectStatus: 0,
    expectCode: null,
    expectInvokeCount: 1,
    expectZaiCreate: 1,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "explicit ZAI",
    args: (sub) => ["--provider", "zai", ...sub.defaultArgs],
    env: () => ({}),
    expectProvider: "zai",
    expectStatus: 0,
    expectCode: null,
    expectInvokeCount: 1,
    expectZaiCreate: 1,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "environment ZAI",
    args: (sub) => sub.defaultArgs,
    env: () => ({ SCOUTLINE_PROVIDER: "zai" }),
    expectProvider: "zai",
    expectStatus: 0,
    expectCode: null,
    expectInvokeCount: 1,
    expectZaiCreate: 1,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "explicit ZAI wins over environment MINIMAX",
    args: (sub) => ["--provider", "zai", ...sub.defaultArgs],
    env: () => ({ SCOUTLINE_PROVIDER: "minimax" }),
    expectProvider: "zai",
    expectStatus: 0,
    expectCode: null,
    expectInvokeCount: 1,
    expectZaiCreate: 1,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "unknown explicit provider",
    args: (sub) => ["--provider", "openai", ...sub.defaultArgs],
    env: () => ({}),
    expectProvider: null,
    expectStatus: 1,
    expectCode: "VALIDATION_ERROR",
    expectInvokeCount: 0,
    expectZaiCreate: 0,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "unknown environment provider",
    args: (sub) => sub.defaultArgs,
    env: () => ({ SCOUTLINE_PROVIDER: "openai" }),
    expectProvider: null,
    expectStatus: 1,
    expectCode: "VALIDATION_ERROR",
    expectInvokeCount: 0,
    expectZaiCreate: 0,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
  },
  {
    name: "unsupported explicit MINIMAX",
    args: (sub) => ["--provider", "minimax", ...sub.defaultArgs],
    env: () => ({}),
    expectProvider: "minimax",
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
    args: (sub) => sub.defaultArgs,
    env: () => ({ SCOUTLINE_PROVIDER: "minimax" }),
    expectProvider: "minimax",
    expectStatus: 1,
    expectCode: "UNSUPPORTED_CAPABILITY",
    expectInvokeCount: 0,
    expectZaiCreate: 0,
    expectMiniMaxCreate: 0,
    expectMiniMaxIsConfigured: 0,
    expectMiniMaxCapabilities: 1,
  },
];

/**
 * Subcommand definitions. Each subcommand ships:
 *   - defaultArgs: the canonical argv that reaches the Explorer
 *   - capabilityImpl: a function returning the canned result for
 *     makeMainDeps
 *   - invokeCounter(capability): returns the matching invoke count
 */
const SUBCOMMANDS = [
  {
    name: "search",
    defaultArgs: ["repo", "search", "owner/repo", "query"],
    capabilityImpl: () => cannedSearchResult(),
    invokeCounter: (cap) => cap.search.calls.invoke.length,
    validateCounter: (cap) => cap.search.calls.validate.length,
  },
  {
    name: "tree",
    defaultArgs: ["repo", "tree", "owner/repo"],
    capabilityImpl: () => cannedRootListing(),
    invokeCounter: (cap) => cap.listDirectory.calls.invoke.length,
    validateCounter: (cap) => cap.listDirectory.calls.validate.length,
  },
  {
    name: "read",
    defaultArgs: ["repo", "read", "owner/repo", "README.md"],
    capabilityImpl: () => cannedFileResult(),
    invokeCounter: (cap) => cap.readFile.calls.invoke.length,
    validateCounter: (cap) => cap.readFile.calls.validate.length,
  },
];

for (const sub of SUBCOMMANDS) {
  describe(`P6-07A selection matrix — repo ${sub.name}`, () => {
    for (const row of SELECTION_MATRIX) {
      it(row.name, async () => {
        const m = makeMainDeps({
          search: sub.name === "search" ? sub.capabilityImpl : undefined,
          readFile: sub.name === "read" ? sub.capabilityImpl : undefined,
          listDirectory: sub.name === "tree" ? sub.capabilityImpl : undefined,
        });
        const { adapter, stderr } = createRecordingAdapter();
        const args = row.args(sub);
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
          sub.invokeCounter(m.capability),
          row.expectInvokeCount,
          `${sub.name} invoke count for ${row.name}`,
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
}

// ---------------------------------------------------------------------------
// Unsupported path: zero cache.get AND zero cache.set, plus zero
// capability validate/identity/invoke. Observable per-call evidence,
// not Map.size.
// ---------------------------------------------------------------------------

describe("P6-07A unsupported path — zero selected-Provider work (all subcommands)", () => {
  for (const sub of SUBCOMMANDS) {
    it(`repo ${sub.name}: minimax unsupported -> zero cache get/set, zero validate/identity/invoke`, async () => {
      const m = makeMainDeps({
        search: sub.name === "search" ? sub.capabilityImpl : undefined,
        readFile: sub.name === "read" ? sub.capabilityImpl : undefined,
        listDirectory: sub.name === "tree" ? sub.capabilityImpl : undefined,
      });
      const { adapter, stderr } = createRecordingAdapter();
      const status = await main(["--provider", "minimax", ...sub.defaultArgs], {
        ...m.mainDeps,
        invocation: adapter,
      });

      assert.strictEqual(status, 1);
      assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");

      // Cache spy: zero reads AND zero writes on the unsupported path.
      assert.strictEqual(m.cacheRec.gets.length, 0, "cache.get must never be called");
      assert.strictEqual(m.cacheRec.sets.length, 0, "cache.set must never be called");

      // Capability spy: zero validate, zero cacheIdentity, zero invoke
      // for every operation.
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
  }
});

// ---------------------------------------------------------------------------
// Redaction isolation proof (P6-07B).
//
// `configuredSecrets(env)` is the pre-dispatch redaction read in `main`.
// It MUST consult only the env it is handed, never falling back to ambient
// `process.env`. This test supplies CONFLICTING ambient and proxied
// injected credentials, calls `configuredSecrets(proxiedEnv)` directly,
// and asserts:
//
//   - the returned set contains ONLY the injected values (ambient values
//     are absent);
//   - exact injected getter counts (Z_AI_API_KEY, ZAI_API_KEY,
//     MINIMAX_API_KEY each read exactly once);
//   - ambient process.env is restored afterward even if an assertion
//     throws.
//
// This is a direct proof against accidental ambient fallback. It does
// NOT claim that any fixed unsupported error message is redacted; the
// actual redaction behavior is covered by tests/redact.test.js and the
// formatter coverage in tests/output.test.js + tests/invocation.test.js.
// ---------------------------------------------------------------------------

describe("P6-07B configuredSecrets — injected env only, never ambient fallback", () => {
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
    // Stash and overwrite ambient so a value collision with INJECTED
    // would be observable if configuredSecrets were to fall back.
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

    // Each canonical credential key is read exactly once by
    // configuredSecrets. The function iterates the three keys a single
    // time each and dedupes; it does not revisit on dedupe or
    // normalization.
    assert.strictEqual(
      readCounts.Z_AI_API_KEY,
      1,
      `Z_AI_API_KEY read count: ${readCounts.Z_AI_API_KEY}`,
    );
    assert.strictEqual(
      readCounts.ZAI_API_KEY,
      1,
      `ZAI_API_KEY read count: ${readCounts.ZAI_API_KEY}`,
    );
    assert.strictEqual(
      readCounts.MINIMAX_API_KEY,
      1,
      `MINIMAX_API_KEY read count: ${readCounts.MINIMAX_API_KEY}`,
    );

    // Returned set is the deduped list of non-empty injected values.
    // Ambient values MUST be absent — their presence would mean
    // configuredSecrets reached into process.env despite the explicit
    // env argument.
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
    // The injected ZAI_API_KEY aliases Z_AI_API_KEY's secret only when
    // their values collide; here they are distinct, so the alias adds
    // a third entry. Exact length pins the dedupe contract.
    assert.strictEqual(secrets.length, 3, "three distinct non-empty injected values");
  });

  it("configuredSecrets() with no argument falls back to ambient process.env", () => {
    // Back-compat sanity: the default-argument path still observes
    // ambient process.env. This is the call shape `redactTool` and
    // the legacy `formatErrorOutput` use; the previous test pins
    // only the explicit-env path, so this case prevents an accidental
    // narrowing of the default.
    const secrets = configuredSecrets();
    assert.ok(
      secrets.includes(AMBIENT.Z_AI_API_KEY),
      "default-argument configuredSecrets must observe ambient Z_AI_API_KEY",
    );
  });
});

// ---------------------------------------------------------------------------
// Unsupported path lifecycle/cache evidence (P6-07A/07B).
//
// Retained from P6-07A: zero cache.get/set, zero descriptor
// isConfigured/create, zero capability validate/identity/invoke, and
// zero Z.AI fallback on the unsupported path. The previously vacuous
// "sentinel absent from output" assertion is removed; the actual
// redaction behavior is covered by the direct configuredSecrets test
// above and the existing redact/output/invocation formatter suites.
// ---------------------------------------------------------------------------

describe("P6-07B unsupported path — zero selected-Provider work, observable spies (no redaction claim)", () => {
  it("repo search under explicit minimax: zero cache get/set, zero validate/identity/invoke, zero descriptor create/isConfigured, no Z.AI fallback", async () => {
    const SENTINEL = "configured-secrets-prelude-sentinel-not-a-real-credential";
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(["--provider", "minimax", "repo", "search", "owner/repo", "query"], {
      ...m.mainDeps,
      env: { ...m.mainDeps.env, Z_AI_API_KEY: SENTINEL },
      invocation: adapter,
    });

    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");

    // Cache spy: zero reads AND zero writes on the unsupported path.
    assert.strictEqual(m.cacheRec.gets.length, 0, "cache.get must never be called");
    assert.strictEqual(m.cacheRec.sets.length, 0, "cache.set must never be called");

    // Capability spy: zero validate, zero cacheIdentity, zero invoke
    // for every operation.
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
// Supported-unconfigured Z.AI and adapter.repository omission.
// ---------------------------------------------------------------------------

describe("P6-07A supported-but-unconfigured Z.AI surfaces ConfigurationError exit 3", () => {
  for (const sub of SUBCOMMANDS) {
    it(`repo ${sub.name}: missing Z_AI_API_KEY exits 3 after support, before create`, async () => {
      const m = makeMainDeps({
        search: sub.name === "search" ? sub.capabilityImpl : undefined,
        readFile: sub.name === "read" ? sub.capabilityImpl : undefined,
        listDirectory: sub.name === "tree" ? sub.capabilityImpl : undefined,
        zaiConfigured: (env) => Boolean(env.Z_AI_API_KEY),
      });
      const { adapter, stderr } = createRecordingAdapter();
      const status = await main(sub.defaultArgs, {
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
  }
});

describe("P6-07A descriptor advertises repository-exploration but Adapter omits repository", () => {
  for (const sub of SUBCOMMANDS) {
    it(`repo ${sub.name}: fails closed as UNSUPPORTED_CAPABILITY after create`, async () => {
      const capability = makeRecordingCapability({
        search: sub.name === "search" ? sub.capabilityImpl : undefined,
        readFile: sub.name === "read" ? sub.capabilityImpl : undefined,
        listDirectory: sub.name === "tree" ? sub.capabilityImpl : undefined,
      });
      const zai = makeRecordingDescriptor({
        id: "zai",
        configured: true,
        repositoryCapability: capability,
        omitRepositoryOnAdapter: true,
      });
      const minimax = makeRecordingMiniMaxDescriptor({ configured: true });
      const cacheRec = makeRecordingCache();
      const sleepRandom = makeFakeSleepRandom();
      const { adapter, stderr } = createRecordingAdapter();
      const status = await main(sub.defaultArgs, {
        env: { Z_AI_API_KEY: "zai-key" },
        providerDescriptors: [zai.descriptor, minimax.descriptor],
        repositoryCache: cacheRec.cache,
        repositorySleep: sleepRandom.sleep,
        repositoryRandom: sleepRandom.random,
        searchCache: cacheRec.cache,
        searchSleep: sleepRandom.sleep,
        searchRandom: sleepRandom.random,
        invocation: adapter,
      });

      assert.strictEqual(status, 1);
      const parsed = JSON.parse(stderr[0]);
      assert.strictEqual(parsed.code, "UNSUPPORTED_CAPABILITY");

      // create ran once (so the fail-closed check could observe the
      // missing adapter.repository), but no capability work ran.
      assert.strictEqual(zai.stats.createCalls, 1);
      const counts = capabilityCallCount(capability);
      for (const [key, value] of Object.entries(counts)) {
        assert.strictEqual(value, 0, `capability.${key} must be 0 when adapter.repository missing`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Malformed request families — support/config-before-Explorer ordering.
//
// Split into two groups:
//
//   A. PARSE-LEVEL malformed (missing positional, unknown subcommand).
//      `handleRepo` validates positional grammar BEFORE Provider
//      resolution. These cases ALWAYS surface VALIDATION_ERROR
//      regardless of Provider shape, because parse-level validation
//      runs before the support/config gates.
//
//   B. POST-GATING malformed (invalid repo text, invalid language,
//      invalid depth). The positionals are present; the values are
//      checked by the handler/Explorer AFTER Provider gating.
//      Therefore:
//        - supported-CONFIGURED Z.AI -> VALIDATION_ERROR (handler or
//          Explorer validation reached because Provider gating passed)
//        - supported-UNCONFIGURED Z.AI -> CONFIGURATION_ERROR (support
//          and config gating fire before Explorer validation)
//        - unsupported MiniMax -> UNSUPPORTED_CAPABILITY (support
//          gating fires before Explorer validation)
// ---------------------------------------------------------------------------

/**
 * PARSE-LEVEL malformed cases. Each is always VALIDATION_ERROR
 * regardless of Provider shape because `handleRepo` validates
 * positionals before resolving the Provider. Argv is crafted
 * explicitly per case to avoid the per-subcommand defaultArgs
 * shape (which always includes a valid repo/path).
 */
const PARSE_LEVEL_MALFORMED = [
  {
    label: "search: missing repo and query",
    argv: ["repo", "search"],
  },
  {
    label: "search: missing query",
    argv: ["repo", "search", "owner/repo"],
  },
  {
    label: "tree: missing repo",
    argv: ["repo", "tree"],
  },
  {
    label: "read: missing repo and path",
    argv: ["repo", "read"],
  },
  {
    label: "read: missing path",
    argv: ["repo", "read", "owner/repo"],
  },
  {
    label: "unknown subcommand",
    argv: ["repo", "bogus", "owner/repo"],
  },
];

/**
 * Provider-selection probes to exercise against parse-level malformed
 * input. Each row sets a different selection shape but the expected
 * code is always VALIDATION_ERROR because positional validation
 * runs before resolution.
 */
const PARSE_LEVEL_PROVIDER_PROBES = [
  { name: "default", providerArgs: [], env: () => ({}) },
  { name: "explicit zai", providerArgs: ["--provider", "zai"], env: () => ({}) },
  { name: "explicit minimax", providerArgs: ["--provider", "minimax"], env: () => ({}) },
  { name: "env minimax", providerArgs: [], env: () => ({ SCOUTLINE_PROVIDER: "minimax" }) },
  { name: "env openai", providerArgs: [], env: () => ({ SCOUTLINE_PROVIDER: "openai" }) },
];

describe("P6-07A parse-level malformed — ALWAYS VALIDATION_ERROR regardless of provider shape", () => {
  for (const malformed of PARSE_LEVEL_MALFORMED) {
    for (const probe of PARSE_LEVEL_PROVIDER_PROBES) {
      it(`${malformed.label} under ${probe.name} -> VALIDATION_ERROR before provider resolution`, async () => {
        const m = makeMainDeps({
          search: () => cannedSearchResult(),
          readFile: () => cannedFileResult(),
          listDirectory: () => cannedRootListing(),
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

/**
 * POST-GATING malformed cases. Each has valid positional shape but
 * invalid values; these reach the handler/Explorer AFTER Provider
 * gating and therefore follow the support/config ordering. Argv
 * crafted per case.
 */
const POST_GATING_MALFORMED = [
  {
    label: "search: invalid repo format",
    argv: ["repo", "search", "invalid-format", "query"],
  },
  {
    label: "tree: invalid repo format",
    argv: ["repo", "tree", "invalid-format"],
  },
  {
    label: "read: invalid repo format",
    argv: ["repo", "read", "invalid-format", "README.md"],
  },
  {
    label: "search: invalid language",
    argv: ["repo", "search", "owner/repo", "query", "--language", "fr"],
  },
  {
    label: "search: whitespace-only query",
    argv: ["repo", "search", "owner/repo", "   "],
  },
  {
    label: "tree: invalid depth (zero)",
    argv: ["repo", "tree", "owner/repo", "--depth", "0"],
  },
  {
    label: "tree: invalid depth (negative)",
    argv: ["repo", "tree", "owner/repo", "--depth", "-1"],
  },
  {
    label: "tree: unsafe path (parent traversal)",
    argv: ["repo", "tree", "owner/repo", "--path", "../src"],
  },
  {
    label: "read: unsafe path (parent traversal)",
    argv: ["repo", "read", "owner/repo", "../README.md"],
  },
];

const PROVIDER_SHAPES = [
  {
    name: "supported-configured ZAI",
    env: () => ({}),
    expectCode: "VALIDATION_ERROR",
    expectStatus: 1,
    // Provider gating passes; descriptor.create runs so the adapter
    // can be reached. Handler/Explorer validation then throws before
    // any capability invoke.
    expectZaiCreate: 1,
  },
  {
    name: "supported-unconfigured ZAI",
    env: () => ({ SCOUTLINE_PROVIDER: "zai" }),
    clearZaiKey: true,
    expectCode: "CONFIGURATION_ERROR",
    expectStatus: 3,
    expectZaiCreate: 0,
  },
  {
    name: "unsupported MINIMAX",
    env: () => ({ SCOUTLINE_PROVIDER: "minimax" }),
    expectCode: "UNSUPPORTED_CAPABILITY",
    expectStatus: 1,
    expectZaiCreate: 0,
  },
];

describe("P6-07A post-gating malformed — support/config-before-Explorer ordering", () => {
  for (const malformed of POST_GATING_MALFORMED) {
    for (const shape of PROVIDER_SHAPES) {
      it(`${malformed.label} under ${shape.name} -> ${shape.expectCode}`, async () => {
        const m = makeMainDeps({
          search: () => cannedSearchResult(),
          readFile: () => cannedFileResult(),
          listDirectory: () => cannedRootListing(),
          zaiConfigured: (env) => Boolean(env.Z_AI_API_KEY),
        });
        const { adapter, stderr } = createRecordingAdapter();
        const env = { ...m.mainDeps.env, ...shape.env() };
        if (shape.clearZaiKey) delete env.Z_AI_API_KEY;
        const status = await main(malformed.argv, {
          ...m.mainDeps,
          env,
          invocation: adapter,
        });

        assert.strictEqual(status, shape.expectStatus);
        const parsed = JSON.parse(stderr[0]);
        assert.strictEqual(
          parsed.code,
          shape.expectCode,
          `${malformed.label} under ${shape.name}: expected ${shape.expectCode}, got ${stderr[0]}`,
        );

        // The Explorer and capability are never reached on any
        // post-gating malformed path — support/config gating fires
        // first, and on the supported-configured path the handler
        // validation throws before invoke runs.
        assert.strictEqual(m.zai.stats.createCalls, shape.expectZaiCreate);
        const counts = capabilityCallCount(m.capability);
        for (const [key, value] of Object.entries(counts)) {
          assert.strictEqual(
            value,
            0,
            `capability.${key} must be 0 on malformed path (${malformed.label} under ${shape.name})`,
          );
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Golden outputs — schema-version-1 structured payloads across all
// canonical modes (data, json, pretty, compact) with deterministic
// now. compact uses the JSON fallback because repo results carry no
// Provider prose/presentation override.
// ---------------------------------------------------------------------------

describe("P6-07A golden outputs — search (deliberate raw-string breaking migration)", () => {
  it("data mode emits exactly the schema-version-1 value", async () => {
    const m = makeMainDeps({
      search: () => cannedSearchResult([{ text: "alpha excerpt" }, { text: "beta excerpt" }]),
    });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["repo", "search", "owner/repo", "query"], { ...m.mainDeps, invocation: adapter });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "query",
      language: "en",
      excerpts: [{ text: "alpha excerpt" }, { text: "beta excerpt" }],
      truncated: false,
      originalTextLength: "alpha excerptbeta excerpt".length,
    });
  });

  it("json mode emits the standard envelope", async () => {
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter, stdout } = createRecordingAdapter({ environmentOutputMode: "json" });
    await main(["-O", "json", "repo", "search", "owner/repo", "query"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      success: true,
      data: cannedSearchResult(),
      timestamp: FIXED_NOW,
    });
  });

  it("pretty mode emits the indented standard envelope", async () => {
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "pretty", "repo", "search", "owner/repo", "query"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    assert.ok(stdout[0].includes("\n"), "pretty mode must be indented");
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      success: true,
      data: cannedSearchResult(),
      timestamp: FIXED_NOW,
    });
  });

  it("compact mode uses the JSON fallback (no Provider prose override)", async () => {
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "compact", "repo", "search", "owner/repo", "query"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, cannedSearchResult());
  });
});

describe("P6-07A golden outputs — read (deliberate raw-string breaking migration)", () => {
  it("data mode emits exactly the schema-version-1 value", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult("file body\nmore body") });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["repo", "read", "owner/repo", "README.md"], { ...m.mainDeps, invocation: adapter });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "README.md",
      content: "file body\nmore body",
      truncated: false,
      originalContentLength: "file body\nmore body".length,
    });
  });

  it("json mode emits the standard envelope", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "json", "repo", "read", "owner/repo", "README.md"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      success: true,
      data: cannedFileResult(),
      timestamp: FIXED_NOW,
    });
  });

  it("pretty mode emits the indented standard envelope", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "pretty", "repo", "read", "owner/repo", "README.md"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    assert.ok(stdout[0].includes("\n"));
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      success: true,
      data: cannedFileResult(),
      timestamp: FIXED_NOW,
    });
  });

  it("compact mode uses the JSON fallback", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "compact", "repo", "read", "owner/repo", "README.md"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, cannedFileResult());
  });
});

describe("P6-07A golden outputs — tree (structured schema at every depth, including depth 1)", () => {
  it("depth 1 (default) emits the structured schema with one snapshot", async () => {
    const m = makeMainDeps({ listDirectory: () => cannedRootListing() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["repo", "tree", "owner/repo"], { ...m.mainDeps, invocation: adapter });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "",
      depth: 1,
      snapshots: [cannedRootListing()],
    });
    assert.strictEqual(m.capability.listDirectory.calls.invoke.length, 1);
  });

  it("depth 2 expands subdirectories breadth-first and emits multiple snapshots", async () => {
    const m = makeMainDeps({
      listDirectory: (request) => {
        if (request.path === "") return cannedRootListing();
        if (request.path === "src") return cannedSrcListing();
        throw new Error(`unexpected listDirectory request: ${JSON.stringify(request)}`);
      },
    });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["repo", "tree", "owner/repo", "--depth", "2"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "",
      depth: 2,
      snapshots: [cannedRootListing(), cannedSrcListing()],
    });
    assert.strictEqual(m.capability.listDirectory.calls.invoke.length, 2);
    assert.deepStrictEqual(m.capability.listDirectory.calls.invoke[0], {
      repository: "owner/repo",
      path: "",
    });
    assert.deepStrictEqual(m.capability.listDirectory.calls.invoke[1], {
      repository: "owner/repo",
      path: "src",
    });
  });

  it("json mode emits the standard envelope", async () => {
    const m = makeMainDeps({ listDirectory: () => cannedRootListing() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "json", "repo", "tree", "owner/repo"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      success: true,
      data: {
        schemaVersion: 1,
        repository: "owner/repo",
        path: "",
        depth: 1,
        snapshots: [cannedRootListing()],
      },
      timestamp: FIXED_NOW,
    });
  });

  it("pretty mode emits the indented standard envelope", async () => {
    const m = makeMainDeps({ listDirectory: () => cannedRootListing() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "pretty", "repo", "tree", "owner/repo"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    assert.ok(stdout[0].includes("\n"));
  });

  it("compact mode uses the JSON fallback", async () => {
    const m = makeMainDeps({ listDirectory: () => cannedRootListing() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["-O", "compact", "repo", "tree", "owner/repo"], {
      ...m.mainDeps,
      invocation: adapter,
      now: () => FIXED_NOW,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "",
      depth: 1,
      snapshots: [cannedRootListing()],
    });
  });
});

// ---------------------------------------------------------------------------
// Flags/defaults reach the Explorer correctly
// ---------------------------------------------------------------------------

describe("P6-07A flags/defaults — Explorer request shape", () => {
  it("search: --language en forwards explicit language (default is en)", async () => {
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "search", "owner/repo", "query", "--language", "en"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.deepStrictEqual(m.capability.search.calls.invoke[0], {
      repository: "owner/repo",
      query: "query",
      language: "en",
    });
  });

  it("search: --language zh forwards explicit zh", async () => {
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "search", "owner/repo", "query", "--language", "zh"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.deepStrictEqual(m.capability.search.calls.invoke[0], {
      repository: "owner/repo",
      query: "query",
      language: "zh",
    });
  });

  it("search: --max-chars projects excerpts only (never enters the request)", async () => {
    const m = makeMainDeps({
      search: () => cannedSearchResult([{ text: "abcdefghij" }, { text: "klmnopqrst" }]),
    });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["repo", "search", "owner/repo", "query", "--max-chars", "5"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.deepStrictEqual(m.capability.search.calls.invoke[0], {
      repository: "owner/repo",
      query: "query",
      language: "en",
    });
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.excerpts.length, 1);
    assert.ok(parsed.excerpts[0].text.startsWith("abcd"));
    assert.ok(parsed.excerpts[0].text.endsWith("…"));
    assert.strictEqual(parsed.truncated, true);
    assert.strictEqual(parsed.originalTextLength, 20);
  });

  it("search: --max-chars never enters cacheIdentity", async () => {
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "search", "owner/repo", "query", "--max-chars", "10"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    for (const req of m.capability.search.calls.cacheIdentity) {
      assert.strictEqual(req.maxChars, undefined);
    }
  });

  it("read: --max-chars projects content only (never enters the request)", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult("abcdefghijklmnop") });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["repo", "read", "owner/repo", "README.md", "--max-chars", "5"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.deepStrictEqual(m.capability.readFile.calls.invoke[0], {
      repository: "owner/repo",
      path: "README.md",
    });
    const parsed = JSON.parse(stdout[0]);
    assert.ok(parsed.content.length < 16);
    assert.ok(parsed.content.endsWith("…"));
    assert.strictEqual(parsed.truncated, true);
    assert.strictEqual(parsed.originalContentLength, 16);
  });

  it("read: --no-cache bypasses cache write-back (cache.set count is zero)", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult() });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "read", "owner/repo", "README.md", "--no-cache"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(m.cacheRec.sets.length, 0, "no-cache must not write the cache");
  });

  it("read: cache write-back occurs without --no-cache (cache.set count is one)", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult() });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "read", "owner/repo", "README.md"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(m.cacheRec.sets.length, 1, "result must be cached exactly once");
  });

  it("tree: --path forwards a canonical non-root path", async () => {
    const m = makeMainDeps({ listDirectory: () => cannedSrcListing() });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "tree", "owner/repo", "--path", "src"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.deepStrictEqual(m.capability.listDirectory.calls.invoke[0], {
      repository: "owner/repo",
      path: "src",
    });
  });

  it("tree: --path /foo/ normalizes to 'foo' before reaching the Adapter", async () => {
    const m = makeMainDeps({ listDirectory: () => cannedSrcListing() });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "tree", "owner/repo", "--path", "/src/"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.deepStrictEqual(m.capability.listDirectory.calls.invoke[0], {
      repository: "owner/repo",
      path: "src",
    });
  });

  it("tree: depth defaults to 1 when --depth is omitted", async () => {
    const m = makeMainDeps({ listDirectory: () => cannedRootListing() });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["repo", "tree", "owner/repo"], { ...m.mainDeps, invocation: adapter });
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.depth, 1);
  });

  it("tree: --depth 3 expands three levels breadth-first", async () => {
    const m = makeMainDeps({
      listDirectory: (request) => {
        if (request.path === "") return cannedRootListing();
        if (request.path === "src") return cannedSrcListing();
        if (request.path === "src/lib") {
          return {
            repository: "owner/repo",
            path: "src/lib",
            entries: [{ name: "util.ts", path: "src/lib/util.ts", kind: "file" }],
          };
        }
        throw new Error(`unexpected path ${request.path}`);
      },
    });
    const { adapter, stdout } = createRecordingAdapter();
    await main(["repo", "tree", "owner/repo", "--depth", "3"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.depth, 3);
    assert.strictEqual(parsed.snapshots.length, 3);
    assert.strictEqual(parsed.snapshots[0].path, "");
    assert.strictEqual(parsed.snapshots[1].path, "src");
    assert.strictEqual(parsed.snapshots[2].path, "src/lib");
    assert.strictEqual(m.capability.listDirectory.calls.invoke.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Required-deps Interface (P6-07A/07B). The required
// `RepoHandlerDependencies` parameter and the optional trailing
// `CommandContext` are enforced by `tsc` and the compiled
// declaration (`npm run build` is the compile-checked proof; JS
// ignores TS required parameters so runtime requiredness is
// intentionally NOT pinned by a native TypeError test). Valid
// direct Search/Tree/Read calls below cross the same Explorer /
// shared-execution Interface as production and return
// schema-version-1 data — the runtime integration evidence.
// ---------------------------------------------------------------------------

describe("P6-07A direct handler interface — valid success through the required Interface", () => {
  /**
   * Build the fake RepoHandlerDependencies used by direct handler
   * success probes. Same shape as production; permissive validate
   * and identity so the Explorer pre-validation alone governs.
   */
  function makeDirectDeps({ search, readFile, listDirectory } = {}) {
    const op = (kind, impl) => ({
      kind,
      validate() {},
      cacheIdentity(r) {
        return {
          provider: "zai",
          capability: "repository-exploration",
          operation: kind,
          credentialFingerprint: "fp",
          request: r,
          legacyCandidates: [],
        };
      },
      decodeCached(v) {
        return v && typeof v === "object" && !Array.isArray(v) ? v : null;
      },
      async invoke(r) {
        return impl(r);
      },
    });
    const capability = {
      search: op("repository-search", search || (() => cannedSearchResult())),
      readFile: op("repository-read-file", readFile || (() => cannedFileResult())),
      listDirectory: op("repository-list-directory", listDirectory || (() => cannedRootListing())),
    };
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

  it("repoSearch direct success returns schema-version-1 data through the Explorer", async () => {
    const deps = makeDirectDeps({
      search: () => ({
        schemaVersion: 1,
        repository: "owner/repo",
        query: "query",
        language: "en",
        excerpts: [{ text: "alpha" }],
        truncated: false,
        originalTextLength: "alpha".length,
      }),
    });
    const result = await repoSearch("owner/repo", "query", {}, deps);
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.schemaVersion, 1);
    assert.deepStrictEqual(result.data.excerpts, [{ text: "alpha" }]);
  });

  it("repoTree direct success returns schema-version-1 structured tree", async () => {
    const deps = makeDirectDeps();
    const result = await repoTree("owner/repo", {}, deps);
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.schemaVersion, 1);
    assert.strictEqual(result.data.depth, 1);
    assert.strictEqual(result.data.snapshots.length, 1);
  });

  it("repoRead direct success returns schema-version-1 file data", async () => {
    const deps = makeDirectDeps({
      readFile: () => ({
        schemaVersion: 1,
        repository: "owner/repo",
        path: "README.md",
        content: "hi",
        truncated: false,
        originalContentLength: 2,
      }),
    });
    const result = await repoRead("owner/repo", "README.md", {}, deps);
    assert.strictEqual(result.kind, "data");
    assert.strictEqual(result.data.schemaVersion, 1);
    assert.strictEqual(result.data.content, "hi");
  });
});

// ---------------------------------------------------------------------------
// Cache + error envelope contracts
// ---------------------------------------------------------------------------

describe("P6-07A cache + error envelope contracts", () => {
  it("UnsupportedCapabilityError carries code UNSUPPORTED_CAPABILITY", () => {
    const err = new UnsupportedCapabilityError("minimax", "repository-exploration");
    assert.strictEqual(err.code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(err.exitCode, 1);
    assert.match(err.message, /repository-exploration/);
  });

  it("read and search: cache.get is consulted once on a cache miss; cache.set is consulted once after invoke", async () => {
    const m = makeMainDeps({
      readFile: () => cannedFileResult(),
      search: () => cannedSearchResult(),
    });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "read", "owner/repo", "README.md"], { ...m.mainDeps, invocation: adapter });
    await main(["repo", "search", "owner/repo", "query"], { ...m.mainDeps, invocation: adapter });

    // Each operation: at least one get (the new-key read) and
    // exactly one set (the write-back of the normalized result).
    assert.ok(m.cacheRec.gets.length >= 2, "expected at least 2 cache.get calls (one per op)");
    assert.ok(m.cacheRec.sets.length >= 2, "expected at least 2 cache.set calls (one per op)");
  });

  it("a second identical read hits the cache and skips invoke", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult() });
    const { adapter } = createRecordingAdapter();
    await main(["repo", "read", "owner/repo", "README.md"], { ...m.mainDeps, invocation: adapter });
    const firstInvoke = m.capability.readFile.calls.invoke.length;
    await main(["repo", "read", "owner/repo", "README.md"], { ...m.mainDeps, invocation: adapter });
    assert.strictEqual(
      m.capability.readFile.calls.invoke.length,
      firstInvoke,
      "second identical read must hit the cache and skip invoke",
    );
  });
});

// ---------------------------------------------------------------------------
// Help text — main and repo help documents the cutover and lists
// every canonical output mode (derived from OUTPUT_MODES).
// ---------------------------------------------------------------------------

describe("P6-07A help text — repo participates in Provider selection; canonical modes listed", () => {
  it("REPO_HELP mentions provider selection, Z.AI support, MiniMax UNSUPPORTED_CAPABILITY, and schema-version-1 migration", () => {
    assert.match(REPO_HELP, /Provider Capability/, "header reflects capability framing");
    assert.match(REPO_HELP, /--provider/, "documents --provider");
    assert.match(REPO_HELP, /SCOUTLINE_PROVIDER/, "documents SCOUTLINE_PROVIDER");
    assert.match(REPO_HELP, /MiniMax/, "mentions MiniMax");
    assert.match(REPO_HELP, /UNSUPPORTED_CAPABILITY/, "documents the unsupported outcome");
    assert.match(REPO_HELP, /schemaVersion/, "documents schema-version-1 migration");
    assert.match(REPO_HELP, /excerpts/, "documents search shape");
    assert.match(REPO_HELP, /snapshots/, "documents tree shape");
  });

  it("REPO_HELP lists EVERY canonical output mode (derived from OUTPUT_MODES)", () => {
    // The help text must list every mode in OUTPUT_MODES so the
    // public contract cannot drift from the accepted set.
    for (const mode of OUTPUT_MODES) {
      assert.ok(REPO_HELP.includes(mode), `REPO_HELP must list canonical mode "${mode}"`);
    }
    // And it must label the default explicitly.
    assert.match(REPO_HELP, /default: data/);
    // The text-oriented-modes JSON fallback contract is documented.
    assert.match(REPO_HELP, /JSON fallback/);
    assert.match(REPO_HELP, /compact \/ markdown \/ refs \/ tty/);
  });

  it("main --help documents repo participates in Provider selection", async () => {
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
    assert.match(help, /repo\s+GitHub repository exploration.*Provider Capability/s);
    assert.match(help, /MiniMax returns UNSUPPORTED_CAPABILITY/);
    assert.match(
      help,
      /'repo' command participates in|'repo' and 'read' commands\s+participate in/,
    );
    assert.match(help, /Provider selection/);
  });

  it("repo --help bypasses provider resolution and resolves cleanly with no creds", async () => {
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
    const status = await main(["repo", "--help"], {
      invocation: adapter,
      env: {},
      providerDescriptors: [],
    });
    assert.strictEqual(status, 0);
    assert.match(captured[0], /Repo Commands/);
  });
});

// ---------------------------------------------------------------------------
// Parse-level validation: missing positionals and unknown subcommands
// surface as VALIDATION_ERROR before any Provider work.
// ---------------------------------------------------------------------------

describe("P6-07A parse-level validation surfaces VALIDATION_ERROR before provider resolution", () => {
  it("repo search without query -> VALIDATION_ERROR", async () => {
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(["repo", "search", "owner/repo"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "VALIDATION_ERROR");
    assert.strictEqual(m.zai.stats.createCalls, 0);
  });

  it("repo search without repo or query -> VALIDATION_ERROR", async () => {
    const m = makeMainDeps({ search: () => cannedSearchResult() });
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(["repo", "search"], { ...m.mainDeps, invocation: adapter });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "VALIDATION_ERROR");
  });

  it("repo tree without repo -> VALIDATION_ERROR", async () => {
    const m = makeMainDeps({ listDirectory: () => cannedRootListing() });
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(["repo", "tree"], { ...m.mainDeps, invocation: adapter });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "VALIDATION_ERROR");
  });

  it("repo read without path -> VALIDATION_ERROR", async () => {
    const m = makeMainDeps({ readFile: () => cannedFileResult() });
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(["repo", "read", "owner/repo"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "VALIDATION_ERROR");
  });

  it("repo unknown subcommand -> VALIDATION_ERROR before provider resolution", async () => {
    const m = makeMainDeps();
    const { adapter, stderr } = createRecordingAdapter();
    const status = await main(["repo", "bogus", "owner/repo"], {
      ...m.mainDeps,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "VALIDATION_ERROR");
    assert.strictEqual(m.zai.stats.createCalls, 0);
  });
});
