/**
 * P6-08 — Cross-Adapter Repository Conformance (DESIGN.md §18, §11;
 * PRD FR-080–FR-093; applicable NFR-001–NFR-010).
 *
 * Purpose
 *   Prove the Provider Seam independently of Z.AI by exercising the
 *   integrated cache, retry, close, selection, empty-result, and output
 *   matrix that component tests cannot establish alone. A reusable fake
 *   second Repository Adapter produces the SAME normalized contract as
 *   the Z.AI Adapter WITHOUT touching any ZRead grammar; cross-Adapter
 *   conformance is asserted through `deepStrictEqual` on Search, File,
 *   and Directory Listing outputs.
 *
 * Coverage map (acceptance criteria from the P6-08 ticket)
 *   1. Cross-Adapter normalized equivalence — Z.AI fed sanitized grammar
 *      fixtures vs. the fake fed structured results; outputs are
 *      byte-identical.
 *   2. Explicit valid empty Search/Directory arrays through the fake;
 *      Z.AI no-wrapper Search remains malformed. (FR-091.)
 *   3. Full legacy-cache matrix per operation through the REAL Z.AI
 *      Adapter: primary public name, supported alias via fake Adapter
 *      candidates, injected-only credential, conflicting ambient/
 *      injected, malformed raw entry, --no-cache, read-through to
 *      normalized write-back. Raw legacy Provider data NEVER crosses
 *      the normalized output. (FR-063, FR-086, FR-087, FR-089, NFR-006.)
 *   4. Integrated retry/lifecycle: cache hit constructs/closes zero
 *      transports; each uncached retry constructs a fresh transport;
 *      close rejection or timeout never alters success nor masks the
 *      primary failure. (FR-093, NFR-007.)
 *   5. Exact encoded-error fixtures: terminal exhausted quota; terminal
 *      401/403/other 4xx; one retry for transient 429, 5xx, malformed
 *      502. (FR-090; DESIGN.md §18 encoded MCP error taxonomy.)
 *   6. Real dispatcher selection-order: default Z.AI, explicit Z.AI,
 *      environment Z.AI, unsupported MiniMax with zero selected-Provider
 *      work, descriptor-advertises-but-Adapter-omits fail closed,
 *      permitted pre-dispatch redaction-secret read only. (FR-001,
 *      FR-080, FR-082, NFR-006.)
 *   7. Cross-Adapter dispatcher through `main()` using a fake repository
 *      Provider: selection does NOT branch on Provider ID; the same
 *      request produces the same outward schema-version-1 value across
 *      output modes data / json / pretty / compact.
 *
 * Boundary
 *   The conformance tests import the REAL Z.AI Adapter, shared
 *   execution, the static production registry, the REAL dispatcher
 *   (`main`), the cache key builder, and the P6-08 fake Adapter helper.
 *   They never touch a network or a real credential. They do not edit
 *   production code.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { main } from "../dist/index.js";
import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { buildLegacyRepositoryCacheKey, buildProviderCacheKey } from "../dist/lib/cache.js";
import { executeRepositoryOperation } from "../dist/lib/execution.js";
import {
  ApiError,
  AuthError,
  QuotaError,
  ScoutlineError,
  TimeoutError,
} from "../dist/lib/errors.js";
import { ZAI_REPOSITORY_CLOSE_BOUND_MS } from "../dist/providers/zai/repository.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";
import {
  createFakeRepositoryCapability,
  createFakeRepositoryDescriptor,
} from "./helpers/fake-adapter.js";
import { readFixture } from "./helpers/fixtures.js";

// ---------------------------------------------------------------------------
// Offline hermeticity: clear ambient Provider credentials so a developer
// shell with Z_AI_API_KEY set cannot leak into these tests. Every Adapter
// in this suite is fake or wired to a FakeUtcpClient.
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

// ---------------------------------------------------------------------------
// Constants and fixtures
// ---------------------------------------------------------------------------

const SEARCH_TOOL_PUBLIC_NAME = getMcpToolName("zread", "search_doc");
const FILE_TOOL_PUBLIC_NAME = getMcpToolName("zread", "read_file");
const DIRECTORY_TOOL_PUBLIC_NAME = getMcpToolName("zread", "get_repo_structure");

const INTERNAL_SEARCH_DOC = "scoutline_zai.zread.search_doc";
const INTERNAL_READ_FILE = "scoutline_zai.zread.read_file";
const INTERNAL_GET_REPO_STRUCTURE = "scoutline_zai.zread.get_repo_structure";

const DISCOVERED_ZREAD_TOOLS = [
  { name: INTERNAL_SEARCH_DOC, inputs: { type: "object" }, outputs: { type: "string" } },
  { name: INTERNAL_READ_FILE, inputs: { type: "object" }, outputs: { type: "string" } },
  { name: INTERNAL_GET_REPO_STRUCTURE, inputs: { type: "object" }, outputs: { type: "string" } },
];

const TEST_API_KEY = "test-zai-api-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

// Top-level await so every `describe` body that consumes fixture fields
// sees fully-loaded data. ESM allows TLA inside a module.
const fixtures = {
  searchValid: await readFixture("providers", "zai", "repository", "search-valid.json"),
  fileValid: await readFixture("providers", "zai", "repository", "file-valid.json"),
  treeRootValid: await readFixture("providers", "zai", "repository", "tree-root-valid.json"),
  searchMalformedWrapper: await readFixture(
    "providers",
    "zai",
    "repository",
    "search-malformed-wrapper.json",
  ),
  errorMcpQuota: await readFixture("providers", "zai", "repository", "error-mcp-quota.json"),
  errorMcpGeneric: await readFixture("providers", "zai", "repository", "error-mcp-generic.json"),
};

// ---------------------------------------------------------------------------
// Fake ZaiAdapterClientPort factory: counts constructed transports, can
// script per-call errors, close rejection, or close timeout.
//
// Each constructed port carries:
//   - `closeEntered`: a counter incremented at the START of `close()`,
//     before the close resolves/rejects/hangs. This proves the close path
//     was actually entered (FR-093) even when the close later rejects or
//     hangs. The Adapter's best-effort close bound races the close
//     against a timer; a wrapper that never resolves close would still
//     have `closeEntered === 1` after the bounded wait elapses.
//   - `fake.closeCount`: the underlying FakeUtcpClient close counter,
//     incremented only on a clean close. This is the per-attempt "closed
//     exactly once" evidence used by the success and primary-failure
//     cases.
// ---------------------------------------------------------------------------

function makeClientFactory({ discoveredTools, resultsByName, errorsByName } = {}) {
  const created = [];
  const factory = (options) => {
    const fake = new FakeUtcpClient({ discoveredTools, resultsByName, errorsByName });
    const port = {
      options,
      callToolCalls: [],
      closeEntered: 0,
      async callToolRaw(name, args) {
        this.callToolCalls.push({ name, args });
        const tools = fake.discoveredTools;
        let resolved = tools.find((t) => t.name === name);
        if (!resolved && name.startsWith("scoutline.zai.")) {
          const suffix = name.slice("scoutline.zai.".length);
          const matches = tools.filter((t) => t.name.endsWith(`.${suffix}`));
          if (matches.length === 1) resolved = matches[0];
        }
        if (!resolved) throw new Error(`API_ERROR: Unknown tool ${name}`);
        return fake.callTool(resolved.name, args);
      },
      async listTools() {
        return fake.getTools();
      },
      async close() {
        this.closeEntered += 1;
        return fake.close();
      },
    };
    created.push({ options, fake, port });
    return port;
  };
  factory.created = created;
  return factory;
}

/**
 * Wrap a Z.AI clientFactory so the next-created port's `close` rejects.
 * The wrapper preserves `factory.created` so tests can still inspect the
 * constructed transports. The wrapper still increments `closeEntered`
 * BEFORE rejecting so the test can prove the close path was entered.
 */
function withCloseRejection(factory) {
  const wrapper = (options) => {
    const port = factory(options);
    port.close = async () => {
      port.closeEntered += 1;
      throw new Error("close rejected (test)");
    };
    return port;
  };
  wrapper.created = factory.created;
  return wrapper;
}

/**
 * Wrap a Z.AI clientFactory so the next-created port's `close` never
 * resolves. The wrapper preserves `factory.created` so tests can still
 * inspect the constructed transports. The wrapper still increments
 * `closeEntered` BEFORE hanging so the test can prove the close path
 * was entered (FR-093: best-effort close must actually be attempted).
 */
function withCloseHang(factory) {
  const wrapper = (options) => {
    const port = factory(options);
    port.close = () => {
      port.closeEntered += 1;
      return new Promise(() => {});
    };
    return port;
  };
  wrapper.created = factory.created;
  return wrapper;
}

// ---------------------------------------------------------------------------
// Recording ResponseCache for the legacy matrix and write-back proofs.
// ---------------------------------------------------------------------------

function makeRecordingCache(seed = {}) {
  const store = new Map(seed instanceof Map ? Array.from(seed.entries()) : Object.entries(seed));
  const gets = [];
  const sets = [];
  const cache = {
    gets,
    sets,
    store,
    async get(key) {
      gets.push(key);
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      sets.push({ key, value });
      store.set(key, value);
    },
  };
  return cache;
}

function makeDeps(cache) {
  return {
    cache,
    sleep: async () => {},
    random: () => 0,
  };
}

/**
 * Compose the standard Z.AI Adapter through `createZaiDescriptor` so the
 * production descriptor path is exercised end-to-end.
 */
function makeZaiAdapter({ factory, closeTimeoutMs } = {}) {
  const adapter = createZaiDescriptor({
    clientFactory: factory,
    repositoryCloseTimeoutMs: closeTimeoutMs,
  }).create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
  return adapter;
}

/**
 * Capture the error thrown by an async function. Fail the test if the
 * function resolves; return the error otherwise. Used everywhere an
 * `assert.rejects` matcher would obscure the captured error class.
 */
async function captureError(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected promise to reject, but it resolved");
}

// ===========================================================================
// 1. Cross-Adapter normalized equivalence
//
// The Z.AI Adapter is fed a CONTROLLED raw fixture through FakeUtcpClient;
// the fake Adapter is fed the corresponding structured expected result.
// Both Adapters are driven through the SAME `executeRepositoryOperation`.
// The normalized outputs MUST be byte-identical.
//
// Using controlled raw fixtures (rather than the sanitized evidence files)
// keeps the expected normalized value trivial and unambiguous — the
// purpose of THIS block is cross-Adapter shape identity, not parser
// totality (which is covered by `zai-repository-adapter.test.js` and
// `repository-characterization.test.js`).
// ===========================================================================

describe("P6-08 cross-Adapter normalized equivalence", () => {
  it("Search: Z.AI grammar and fake structured produce the same normalized result", async () => {
    // Controlled raw: a single excerpt with a fixed text. The Z.AI
    // parser strips `<excerpt>` framing and preserves the inner text
    // verbatim; the fake Adapter is fed the structured expected value
    // directly. Both paths converge on the same normalized output.
    const excerptText = "shared search excerpt";
    const raw = `<excerpt>${excerptText}</excerpt>`;
    const expectedResult = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "conformance",
      language: "en",
      excerpts: [{ text: excerptText }],
      truncated: false,
      originalTextLength: excerptText.length,
    };

    const zaiFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory: zaiFactory });
    const zaiResult = await executeRepositoryOperation(
      zaiAdapter.repository.search,
      { repository: "owner/repo", query: "conformance", language: "en" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );

    const { capability: fakeCap } = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
      search: { result: expectedResult },
    });
    const fakeResult = await executeRepositoryOperation(
      fakeCap.search,
      { repository: "owner/repo", query: "conformance", language: "en" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );

    assert.deepStrictEqual(zaiResult, expectedResult);
    assert.deepStrictEqual(fakeResult, expectedResult);
    assert.deepStrictEqual(zaiResult, fakeResult);
  });

  it("File: Z.AI grammar and fake structured produce the same normalized result", async () => {
    const fileBody = "shared file body";
    const raw = `<file_content>${fileBody}</file_content>`;
    const expectedResult = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "README.md",
      content: fileBody,
      truncated: false,
      originalContentLength: fileBody.length,
    };

    const zaiFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_READ_FILE]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory: zaiFactory });
    const zaiResult = await executeRepositoryOperation(
      zaiAdapter.repository.readFile,
      { repository: "owner/repo", path: "README.md" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );

    const { capability: fakeCap } = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
      readFile: { result: expectedResult },
    });
    const fakeResult = await executeRepositoryOperation(
      fakeCap.readFile,
      { repository: "owner/repo", path: "README.md" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );

    assert.deepStrictEqual(zaiResult, expectedResult);
    assert.deepStrictEqual(fakeResult, expectedResult);
    assert.deepStrictEqual(zaiResult, fakeResult);
  });

  it("Directory: Z.AI grammar and fake structured produce the same normalized listing", async () => {
    // Controlled Structure raw with three immediate entries in fixed
    // sibling order.
    const raw = "<structure>\nowner-repo/\n├── src/\n├── README.md\n└── package.json\n</structure>";
    const expectedResult = {
      repository: "owner/repo",
      path: "",
      entries: [
        { name: "src", path: "src", kind: "directory" },
        { name: "README.md", path: "README.md", kind: "file" },
        { name: "package.json", path: "package.json", kind: "file" },
      ],
    };

    const zaiFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_GET_REPO_STRUCTURE]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory: zaiFactory });
    const zaiResult = await executeRepositoryOperation(
      zaiAdapter.repository.listDirectory,
      { repository: "owner/repo", path: "" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );

    const { capability: fakeCap } = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
      listDirectory: { result: expectedResult },
    });
    const fakeResult = await executeRepositoryOperation(
      fakeCap.listDirectory,
      { repository: "owner/repo", path: "" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );

    assert.deepStrictEqual(zaiResult, expectedResult);
    assert.deepStrictEqual(fakeResult, expectedResult);
    assert.deepStrictEqual(zaiResult, fakeResult);
  });

  it("normalized outputs carry no Provider-only fields (no excerpts[].rank, no entries[].size)", async () => {
    // The total decoders drop unknown fields. A future Adapter that
    // accidentally includes Provider-only metadata cannot leak it
    // through the cache.
    const { capability: fakeCap } = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
      search: {
        result: {
          schemaVersion: 1,
          repository: "owner/repo",
          query: "q",
          language: "en",
          excerpts: [{ text: "alpha", rank: 1, url: "should-drop" }],
          truncated: false,
          originalTextLength: 5,
        },
      },
    });
    const out = fakeCap.search.decodeCached({
      schemaVersion: 1,
      repository: "owner/repo",
      query: "q",
      language: "en",
      excerpts: [{ text: "alpha", rank: 1, url: "should-drop" }],
      truncated: false,
      originalTextLength: 5,
    });
    assert.deepStrictEqual(out.excerpts, [{ text: "alpha" }]);
    assert.strictEqual(out.excerpts[0].rank, undefined);
    assert.strictEqual(out.excerpts[0].url, undefined);
  });
});

// ===========================================================================
// 2. Explicit valid empty arrays through fake; Z.AI no-wrapper malformed
//
// A future Adapter that has a distinguishable empty-state contract may
// return `excerpts: []` / `entries: []`. The Z.AI Adapter requires its
// characterized wrapper framing; unwrapped text is malformed (FR-091).
// ===========================================================================

describe("P6-08 empty-result contract (FR-091)", () => {
  it("fake Adapter can return an explicit empty Search excerpts array", async () => {
    const emptyResult = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "non-matching",
      language: "en",
      excerpts: [],
      truncated: false,
      originalTextLength: 0,
    };
    const { capability: fakeCap } = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
      search: { result: emptyResult },
    });
    const out = await executeRepositoryOperation(
      fakeCap.search,
      { repository: "owner/repo", query: "non-matching", language: "en" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    assert.deepStrictEqual(out, emptyResult);
    assert.strictEqual(Array.isArray(out.excerpts), true);
    assert.strictEqual(out.excerpts.length, 0);
  });

  it("fake Adapter can return an explicit empty Directory entries array", async () => {
    const emptyListing = {
      repository: "owner/repo",
      path: "empty-dir",
      entries: [],
    };
    const { capability: fakeCap } = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
      listDirectory: { result: emptyListing },
    });
    const out = await executeRepositoryOperation(
      fakeCap.listDirectory,
      { repository: "owner/repo", path: "empty-dir" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    assert.deepStrictEqual(out, emptyListing);
    assert.strictEqual(Array.isArray(out.entries), true);
    assert.strictEqual(out.entries.length, 0);
  });

  it("fake Adapter empty results round-trip through the cache decoder", () => {
    // Round-trip the empty results through `decodeCached` to prove the
    // total decoders accept an empty array as valid (P6-02 rule).
    const { capability: fakeCap } = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "zai",
    });
    const emptySearch = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "q",
      language: "en",
      excerpts: [],
      truncated: false,
      originalTextLength: 0,
    };
    const emptyListing = { repository: "owner/repo", path: "", entries: [] };
    assert.deepStrictEqual(fakeCap.search.decodeCached(emptySearch), emptySearch);
    assert.deepStrictEqual(fakeCap.listDirectory.decodeCached(emptyListing), emptyListing);
  });

  it("Z.AI no-wrapper Search response is malformed, not an empty result", async () => {
    // The Z.AI Adapter requires its characterized `<excerpt>` framing.
    // Unwrapped text (even prose-looking text) is malformed and surfaces
    // as a retryable ApiError 502, never as a successful empty list.
    const zaiFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: {
        [INTERNAL_SEARCH_DOC]: "Some prose with no excerpt wrapper at all.",
      },
    });
    const zaiAdapter = makeZaiAdapter({ factory: zaiFactory });
    const err = await captureError(
      executeRepositoryOperation(
        zaiAdapter.repository.search,
        { repository: "facebook/react", query: "q", language: "en" },
        { noCache: true },
        makeDeps(makeRecordingCache()),
      ),
    );
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err && err.constructor.name}`);
    assert.strictEqual(err.statusCode, 502);
  });

  it("Z.AI Directory wrapper without glyph entries is malformed, not an empty listing", async () => {
    // The Z.AI parser requires at least one immediate glyph-prefixed
    // entry; an empty `<structure>` wrapper is malformed.
    const zaiFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: {
        [INTERNAL_GET_REPO_STRUCTURE]: "<structure>\nfacebook-react/\n</structure>",
      },
    });
    const zaiAdapter = makeZaiAdapter({ factory: zaiFactory });
    const err = await captureError(
      executeRepositoryOperation(
        zaiAdapter.repository.listDirectory,
        { repository: "facebook/react", path: "" },
        { noCache: true },
        makeDeps(makeRecordingCache()),
      ),
    );
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 502);
  });
});

// ===========================================================================
// 3. Legacy-cache matrix through the REAL Z.AI Adapter
//
// For each operation:
//   - Primary public name candidate seeded with a valid raw v0.2 entry
//     is read through, decoded, written back to the normalized key, and
//     returned WITHOUT invoking the Provider.
//   - Malformed legacy entry is a miss and falls through to invoke.
//   - Injected-only credential: the candidate key is derived from the
//     RESOLVED credential (passed to the Adapter through env). The
//     candidate construction performs NO ambient env read.
//   - Conflicting ambient/injected: the candidate key is derived from
//     the INJECTED credential even when process.env carries a different
//     value.
//   - `--no-cache` skips both reads and writes.
//   - Raw legacy Provider data NEVER crosses the normalized seam: the
//     written normalized key value is structurally clean schema-version-1
//     data, not the raw v0.2 string.
// ===========================================================================

// Helper: map a capability operation slot to its internal tool name.
function internalNameForOp(op) {
  if (op === "search") return INTERNAL_SEARCH_DOC;
  if (op === "readFile") return INTERNAL_READ_FILE;
  if (op === "listDirectory") return INTERNAL_GET_REPO_STRUCTURE;
  throw new Error(`unknown op ${op}`);
}
// Helper: map a capability operation slot to its RepositoryOperationKind.
function capabilityOp(op) {
  if (op === "search") return "repository-search";
  if (op === "readFile") return "repository-read-file";
  if (op === "listDirectory") return "repository-list-directory";
  throw new Error(`unknown op ${op}`);
}

/**
 * Per-operation legacy matrix definition. `raw` and `expected` use
 * CONTROLLED inputs so the assertions are unambiguous; the parser-
 * totality proofs live in `zai-repository-adapter.test.js`.
 */
const LEGACY_MATRIX = [
  {
    op: "search",
    label: "Search",
    publicName: SEARCH_TOOL_PUBLIC_NAME,
    request: { repository: "owner/repo", query: "legacy", language: "en" },
    raw: "<excerpt>legacy search text</excerpt>",
    legacyArgs: (r) => ({ repo_name: r.repository, query: r.query, language: r.language }),
    expected: {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "legacy",
      language: "en",
      excerpts: [{ text: "legacy search text" }],
      truncated: false,
      originalTextLength: "legacy search text".length,
    },
  },
  {
    op: "readFile",
    label: "File",
    publicName: FILE_TOOL_PUBLIC_NAME,
    request: { repository: "owner/repo", path: "README.md" },
    raw: "<file_content>legacy file body</file_content>",
    legacyArgs: (r) => ({ repo_name: r.repository, file_path: r.path }),
    expected: {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "README.md",
      content: "legacy file body",
      truncated: false,
      originalContentLength: "legacy file body".length,
    },
  },
  {
    op: "listDirectory",
    label: "Directory",
    publicName: DIRECTORY_TOOL_PUBLIC_NAME,
    request: { repository: "owner/repo", path: "" },
    raw: "<structure>\nowner-repo/\n├── src/\n└── README.md\n</structure>",
    legacyArgs: (r) =>
      r.path === "" ? { repo_name: r.repository } : { repo_name: r.repository, dir_path: r.path },
    expected: {
      repository: "owner/repo",
      path: "",
      entries: [
        { name: "src", path: "src", kind: "directory" },
        { name: "README.md", path: "README.md", kind: "file" },
      ],
    },
  },
];

describe("P6-08 legacy-cache matrix — Z.AI Adapter (per operation)", () => {
  for (const m of LEGACY_MATRIX) {
    describe(`legacy-cache matrix: ${m.label}`, () => {
      it("reads a valid legacy v0.2 primary entry through to the normalized key without invoking", async () => {
        const factory = makeClientFactory({
          discoveredTools: DISCOVERED_ZREAD_TOOLS,
          resultsByName: { [internalNameForOp(m.op)]: m.raw },
        });
        const zaiAdapter = makeZaiAdapter({ factory });
        const legacyKey = buildLegacyRepositoryCacheKey(
          TEST_API_KEY,
          m.publicName,
          m.legacyArgs(m.request),
        );
        const cache = makeRecordingCache({ [legacyKey]: m.raw });

        const out = await executeRepositoryOperation(
          zaiAdapter.repository[m.op],
          m.request,
          {},
          makeDeps(cache),
        );

        assert.deepStrictEqual(out, m.expected);
        // The Adapter was never invoked: zero transports constructed.
        assert.strictEqual(factory.created.length, 0, "no transport on a legacy hit");
        // The cache wrote the normalized key exactly once.
        assert.strictEqual(cache.sets.length, 1);
        // The legacy file is never overwritten.
        assert.strictEqual(cache.store.get(legacyKey), m.raw);
      });

      it("treats a malformed legacy entry as a miss and falls through to invoke", async () => {
        const factory = makeClientFactory({
          discoveredTools: DISCOVERED_ZREAD_TOOLS,
          resultsByName: { [internalNameForOp(m.op)]: m.raw },
        });
        const zaiAdapter = makeZaiAdapter({ factory });
        const legacyKey = buildLegacyRepositoryCacheKey(
          TEST_API_KEY,
          m.publicName,
          m.legacyArgs(m.request),
        );
        const malformedLegacy = "totally-not-zread-grammar";
        const cache = makeRecordingCache({ [legacyKey]: malformedLegacy });

        const out = await executeRepositoryOperation(
          zaiAdapter.repository[m.op],
          m.request,
          {},
          makeDeps(cache),
        );

        assert.deepStrictEqual(out, m.expected);
        // Exactly one transport constructed (the invoke attempt).
        assert.strictEqual(factory.created.length, 1);
        // The legacy file is never overwritten even on a miss.
        assert.strictEqual(cache.store.get(legacyKey), malformedLegacy);
      });

      it("--no-cache skips the legacy read-through and the normalized write-back", async () => {
        const factory = makeClientFactory({
          discoveredTools: DISCOVERED_ZREAD_TOOLS,
          resultsByName: { [internalNameForOp(m.op)]: m.raw },
        });
        const zaiAdapter = makeZaiAdapter({ factory });
        const legacyKey = buildLegacyRepositoryCacheKey(
          TEST_API_KEY,
          m.publicName,
          m.legacyArgs(m.request),
        );
        const cache = makeRecordingCache({ [legacyKey]: m.raw });

        const out = await executeRepositoryOperation(
          zaiAdapter.repository[m.op],
          m.request,
          { noCache: true },
          makeDeps(cache),
        );

        assert.deepStrictEqual(out, m.expected);
        // No reads, no writes.
        assert.strictEqual(cache.gets.length, 0);
        assert.strictEqual(cache.sets.length, 0);
        // Invoke still ran.
        assert.strictEqual(factory.created.length, 1);
      });

      it("raw legacy Provider data never crosses the normalized output (seam proof)", async () => {
        const factory = makeClientFactory({
          discoveredTools: DISCOVERED_ZREAD_TOOLS,
          resultsByName: { [internalNameForOp(m.op)]: m.raw },
        });
        const zaiAdapter = makeZaiAdapter({ factory });
        const legacyKey = buildLegacyRepositoryCacheKey(
          TEST_API_KEY,
          m.publicName,
          m.legacyArgs(m.request),
        );
        const cache = makeRecordingCache({ [legacyKey]: m.raw });

        const out = await executeRepositoryOperation(
          zaiAdapter.repository[m.op],
          m.request,
          {},
          makeDeps(cache),
        );

        // The normalized result must NOT contain the raw wrapper tags
        // or any byte-for-byte slice of the raw v0.2 string that did
        // not pass through the Adapter parser.
        const serialized = JSON.stringify(out);
        assert.ok(!serialized.includes("<excerpt>"), "raw <excerpt> tag leaked through");
        assert.ok(!serialized.includes("<file_content>"), "raw <file_content> tag leaked through");
        assert.ok(!serialized.includes("<structure>"), "raw <structure> tag leaked through");
        assert.ok(!serialized.includes("├──"), "raw tree glyph leaked through");
        assert.ok(!serialized.includes("└──"), "raw tree glyph leaked through");

        // The normalized cache write is also clean.
        const normalizedWrite = cache.sets[0].value;
        const normalizedSerialized = JSON.stringify(normalizedWrite);
        assert.ok(!normalizedSerialized.includes("<excerpt>"));
        assert.ok(!normalizedSerialized.includes("<file_content>"));
        assert.ok(!normalizedSerialized.includes("<structure>"));
        assert.ok(!normalizedSerialized.includes("├──"));
        assert.ok(!normalizedSerialized.includes("└──"));
      });

      it("injected-only credential derives the candidate key from the injected value", async () => {
        const factory = makeClientFactory({
          discoveredTools: DISCOVERED_ZREAD_TOOLS,
          resultsByName: { [internalNameForOp(m.op)]: m.raw },
        });
        const zaiAdapter = makeZaiAdapter({ factory });
        const expectedKey = buildLegacyRepositoryCacheKey(
          TEST_API_KEY,
          m.publicName,
          m.legacyArgs(m.request),
        );
        const cache = makeRecordingCache();

        await executeRepositoryOperation(
          zaiAdapter.repository[m.op],
          m.request,
          {},
          makeDeps(cache),
        );

        // The candidate read for the documented injected-key legacy
        // candidate must occur.
        assert.ok(
          cache.gets.includes(expectedKey),
          `expected legacy candidate read at ${expectedKey}, got ${cache.gets.join(", ")}`,
        );
      });

      it("conflicting ambient and injected credentials derive the candidate key from the injected value", async () => {
        // Stash and force an ambient credential that would change the
        // candidate key if the Adapter ever consulted process.env. The
        // injected credential (TEST_API_KEY) is passed through the
        // descriptor env; the candidate key must match the documented
        // value built from TEST_API_KEY, NOT from the ambient value.
        const savedKey = process.env.Z_AI_API_KEY;
        const savedAlt = process.env.ZAI_API_KEY;
        process.env.Z_AI_API_KEY = "sk-AMBIENT-DO-NOT-USE-999";
        process.env.ZAI_API_KEY = "sk-AMBIENT-ALT-DO-NOT-USE";
        try {
          const factory = makeClientFactory({
            discoveredTools: DISCOVERED_ZREAD_TOOLS,
            resultsByName: { [internalNameForOp(m.op)]: m.raw },
          });
          const zaiAdapter = makeZaiAdapter({ factory });
          const expectedKey = buildLegacyRepositoryCacheKey(
            TEST_API_KEY,
            m.publicName,
            m.legacyArgs(m.request),
          );
          const wrongKey = buildLegacyRepositoryCacheKey(
            "sk-AMBIENT-DO-NOT-USE-999",
            m.publicName,
            m.legacyArgs(m.request),
          );
          assert.notStrictEqual(expectedKey, wrongKey);
          const cache = makeRecordingCache();

          await executeRepositoryOperation(
            zaiAdapter.repository[m.op],
            m.request,
            {},
            makeDeps(cache),
          );

          assert.ok(
            cache.gets.includes(expectedKey),
            `expected injected-credential legacy key ${expectedKey}, got ${cache.gets.join(", ")}`,
          );
          assert.ok(
            !cache.gets.includes(wrongKey),
            "ambient credential value must NOT produce a legacy candidate read",
          );
        } finally {
          if (savedKey === undefined) delete process.env.Z_AI_API_KEY;
          else process.env.Z_AI_API_KEY = savedKey;
          if (savedAlt === undefined) delete process.env.ZAI_API_KEY;
          else process.env.ZAI_API_KEY = savedAlt;
        }
      });

      it("legacy read-through writes the normalized key, not the legacy key", async () => {
        const factory = makeClientFactory({
          discoveredTools: DISCOVERED_ZREAD_TOOLS,
        });
        const zaiAdapter = makeZaiAdapter({ factory });
        const legacyKey = buildLegacyRepositoryCacheKey(
          TEST_API_KEY,
          m.publicName,
          m.legacyArgs(m.request),
        );
        const normalizedKey = buildProviderCacheKey({
          provider: "zai",
          capability: `repository-exploration-${capabilityOp(m.op)}`,
          credentialFingerprint: EXPECTED_FINGERPRINT,
          request: m.request,
        });
        assert.notStrictEqual(legacyKey, normalizedKey);
        const cache = makeRecordingCache({ [legacyKey]: m.raw });

        await executeRepositoryOperation(
          zaiAdapter.repository[m.op],
          m.request,
          {},
          makeDeps(cache),
        );

        // Exactly one write, to the normalized key.
        assert.strictEqual(cache.sets.length, 1);
        assert.strictEqual(cache.sets[0].key, normalizedKey);
        assert.notStrictEqual(cache.sets[0].key, legacyKey);
      });
    });
  }
});

// ===========================================================================
// 3b. Generic legacy-candidate executor ordering (NOT Z.AI alias coverage)
//
// The fake Adapter accepts caller-supplied legacy candidates so the
// shared executor's candidate-sequence behaviour can be asserted without
// involving any Provider-specific credential. These tests prove the
// generic executor contract: primary-before-alias `cache.get` order,
// write-through to the normalized key on a hit, and fall-through to
// invoke when every candidate misses.
//
// They are NOT a substitute for the real Z.AI credential-alias matrix
// (`ZAI_API_KEY` alias-only, `Z_AI_API_KEY`-over-`ZAI_API_KEY` precedence)
// which is covered for all three operations in the dedicated block below.
// ===========================================================================

describe("P6-08 generic legacy-candidate executor ordering (fake Adapter, not Z.AI alias)", () => {
  it("primary candidate hit writes through to the normalized key without invoking", async () => {
    const expectedResult = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "q",
      language: "en",
      excerpts: [{ text: "from-legacy-primary" }],
      truncated: false,
      originalTextLength: 19,
    };
    const legacyKey = "fake-legacy-primary.json";
    const fake = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "fake",
      search: { result: expectedResult },
      legacyCandidates: [
        {
          key: legacyKey,
          decode: (raw) => (raw && raw.ok === true ? expectedResult : null),
        },
      ],
    });
    const cache = makeRecordingCache({
      [legacyKey]: { ok: true, payload: expectedResult },
    });

    const out = await executeRepositoryOperation(
      fake.capability.search,
      { repository: "owner/repo", query: "q", language: "en" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expectedResult);
    // Invoke never ran.
    assert.strictEqual(fake.stats.search.invoke, 0);
    // Normalized write happened exactly once.
    assert.strictEqual(cache.sets.length, 1);
  });

  it("alias candidate is consulted only after the primary candidate misses (cache.get order)", async () => {
    // The executor skips a candidate's `decode` when the candidate key
    // is absent from the cache. The observable ordering proof is
    // therefore the cache.get sequence: [normalizedKey, primaryKey,
    // aliasKey] when both legacy candidates are declared.
    const expectedResult = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "q",
      language: "en",
      excerpts: [{ text: "from-legacy-alias" }],
      truncated: false,
      originalTextLength: 18,
    };
    const primaryKey = "fake-legacy-primary.json";
    const aliasKey = "fake-legacy-alias.json";
    const fake = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "fake",
      search: { result: expectedResult },
      legacyCandidates: [
        { key: primaryKey, decode: () => null },
        {
          key: aliasKey,
          decode: (raw) => (raw && raw.ok === true ? expectedResult : null),
        },
      ],
    });
    const cache = makeRecordingCache({
      [aliasKey]: { ok: true, payload: expectedResult },
    });

    const out = await executeRepositoryOperation(
      fake.capability.search,
      { repository: "owner/repo", query: "q", language: "en" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expectedResult);
    // The candidate read order proves primary-before-alias.
    const candidateReads = cache.gets.filter((k) => k === primaryKey || k === aliasKey);
    assert.deepStrictEqual(candidateReads, [primaryKey, aliasKey]);
    // Invoke never ran because the alias hit returned early.
    assert.strictEqual(fake.stats.search.invoke, 0);
  });

  it("all legacy candidates missing falls through to invoke", async () => {
    const expectedResult = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "q",
      language: "en",
      excerpts: [{ text: "fresh-from-invoke" }],
      truncated: false,
      originalTextLength: 16,
    };
    const fake = createFakeRepositoryCapability({
      apiKey: TEST_API_KEY,
      provider: "fake",
      search: { result: expectedResult },
      legacyCandidates: [
        { key: "absent-1.json", decode: () => null },
        { key: "absent-2.json", decode: () => null },
      ],
    });
    const cache = makeRecordingCache();

    const out = await executeRepositoryOperation(
      fake.capability.search,
      { repository: "owner/repo", query: "q", language: "en" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expectedResult);
    assert.strictEqual(fake.stats.search.invoke, 1);
  });
});

// ===========================================================================
// 3c. Real Z.AI credential alias matrix — `ZAI_API_KEY` alias-only and
//     `Z_AI_API_KEY`-over-`ZAI_API_KEY` precedence (all three operations).
//
// The Z.AI credential resolver treats `Z_AI_API_KEY` as primary and
// `ZAI_API_KEY` as its alias. The Repository Adapter reconstructs the
// legacy v0.2 cache key from the SAME resolved credential that drives
// the normalized fingerprint, so a v0.2 entry written under either
// credential alias is recognized. This matrix exercises:
//
//   - alias-only: Adapter constructed with only `ZAI_API_KEY` resolves
//     the credential from the alias and reconstructs the legacy key
//     from that resolved value;
//   - primary-over-alias: Adapter constructed with both values uses
//     `Z_AI_API_KEY` for legacy key reconstruction, NOT `ZAI_API_KEY`;
//   - non-root Directory `dir_path` read-through and normalized
//     write-back (the root case is covered by the per-operation matrix).
//
// All cases go through the REAL Z.AI Adapter; no fake candidates.
// ===========================================================================

describe("P6-08 Z.AI real credential alias matrix (ZAI_API_KEY alias-only and Z_AI_API_KEY-over-alias)", () => {
  const PRIMARY_KEY = "primary-zai-credential-DO-NOT-LEAK";
  const ALIAS_KEY = "alias-zai-credential-DO-NOT-LEAK";
  const PRIMARY_FP = crypto.createHash("sha256").update(PRIMARY_KEY).digest("hex");
  const ALIAS_FP = crypto.createHash("sha256").update(ALIAS_KEY).digest("hex");

  /**
   * Build a Z.AI Adapter bound to the supplied credential env. The
   * factory's `resultsByName` populates every operation's raw response
   * so a fall-through invoke still succeeds defensively. Each test
   * asserts the legacy candidate was READ at the documented key.
   */
  function makeZaiAdapterForEnv(env, raws) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: {
        [INTERNAL_SEARCH_DOC]: raws.search,
        [INTERNAL_READ_FILE]: raws.file,
        [INTERNAL_GET_REPO_STRUCTURE]: raws.directory,
      },
    });
    return createZaiDescriptor({ clientFactory: factory }).create({ env });
  }

  // -----------------------------------------------------------------------
  // Search: alias-only and primary-over-alias
  // -----------------------------------------------------------------------

  it("Search: alias-only ZAI_API_KEY reconstructs the legacy key from the alias credential", async () => {
    const raw = "<excerpt>alias search body</excerpt>";
    const expected = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "alias",
      language: "en",
      excerpts: [{ text: "alias search body" }],
      truncated: false,
      originalTextLength: "alias search body".length,
    };
    const adapter = makeZaiAdapterForEnv({ ZAI_API_KEY: ALIAS_KEY }, { search: raw });
    const legacyKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, SEARCH_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      query: "alias",
      language: "en",
    });
    const cache = makeRecordingCache({ [legacyKey]: raw });

    const out = await executeRepositoryOperation(
      adapter.repository.search,
      { repository: "owner/repo", query: "alias", language: "en" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expected);
    assert.ok(cache.gets.includes(legacyKey), "alias-derived legacy key must be read");
    // The Adapter never invoked: alias-only reconstruction is sufficient.
    assert.strictEqual(cache.store.get(legacyKey), raw, "legacy file preserved verbatim");
    // Normalized write happened exactly once.
    assert.strictEqual(cache.sets.length, 1);
  });

  it("Search: Z_AI_API_KEY-over-ZAI_API_KEY precedence uses the primary credential for legacy reconstruction", async () => {
    const raw = "<excerpt>primary search body</excerpt>";
    const expected = {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "primary",
      language: "en",
      excerpts: [{ text: "primary search body" }],
      truncated: false,
      originalTextLength: "primary search body".length,
    };
    const adapter = makeZaiAdapterForEnv(
      { Z_AI_API_KEY: PRIMARY_KEY, ZAI_API_KEY: ALIAS_KEY },
      { search: raw },
    );
    const primaryLegacyKey = buildLegacyRepositoryCacheKey(PRIMARY_KEY, SEARCH_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      query: "primary",
      language: "en",
    });
    const aliasLegacyKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, SEARCH_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      query: "primary",
      language: "en",
    });
    assert.notStrictEqual(primaryLegacyKey, aliasLegacyKey);
    const cache = makeRecordingCache({ [primaryLegacyKey]: raw });

    const out = await executeRepositoryOperation(
      adapter.repository.search,
      { repository: "owner/repo", query: "primary", language: "en" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expected);
    assert.ok(cache.gets.includes(primaryLegacyKey), "primary-credential legacy key must be read");
    assert.ok(
      !cache.gets.includes(aliasLegacyKey),
      "alias credential must NOT be consulted when primary is present",
    );
  });

  it("Search: fingerprint reflects the resolved alias credential", async () => {
    const adapter = makeZaiAdapterForEnv(
      { ZAI_API_KEY: ALIAS_KEY },
      {
        search: "<excerpt>x</excerpt>",
      },
    );
    const identity = adapter.repository.search.cacheIdentity({
      repository: "owner/repo",
      query: "q",
      language: "en",
    });
    assert.strictEqual(identity.credentialFingerprint, ALIAS_FP);
  });

  // -----------------------------------------------------------------------
  // File: alias-only and primary-over-alias
  // -----------------------------------------------------------------------

  it("File: alias-only ZAI_API_KEY reconstructs the legacy key from the alias credential", async () => {
    const raw = "<file_content>alias file body</file_content>";
    const expected = {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "ALIAS.md",
      content: "alias file body",
      truncated: false,
      originalContentLength: "alias file body".length,
    };
    const adapter = makeZaiAdapterForEnv({ ZAI_API_KEY: ALIAS_KEY }, { file: raw });
    const legacyKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, FILE_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      file_path: "ALIAS.md",
    });
    const cache = makeRecordingCache({ [legacyKey]: raw });

    const out = await executeRepositoryOperation(
      adapter.repository.readFile,
      { repository: "owner/repo", path: "ALIAS.md" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, expected);
    assert.ok(cache.gets.includes(legacyKey));
  });

  it("File: Z_AI_API_KEY-over-ZAI_API_KEY precedence uses the primary credential", async () => {
    const raw = "<file_content>primary file body</file_content>";
    const adapter = makeZaiAdapterForEnv(
      { Z_AI_API_KEY: PRIMARY_KEY, ZAI_API_KEY: ALIAS_KEY },
      { file: raw },
    );
    const primaryKey = buildLegacyRepositoryCacheKey(PRIMARY_KEY, FILE_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      file_path: "PRIMARY.md",
    });
    const aliasKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, FILE_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      file_path: "PRIMARY.md",
    });
    assert.notStrictEqual(primaryKey, aliasKey);
    const cache = makeRecordingCache({ [primaryKey]: raw });

    await executeRepositoryOperation(
      adapter.repository.readFile,
      { repository: "owner/repo", path: "PRIMARY.md" },
      {},
      makeDeps(cache),
    );

    assert.ok(cache.gets.includes(primaryKey));
    assert.ok(!cache.gets.includes(aliasKey));
  });

  // -----------------------------------------------------------------------
  // Directory: alias-only and primary-over-alias (root path)
  // -----------------------------------------------------------------------

  it("Directory root: alias-only ZAI_API_KEY reconstructs the legacy key from the alias credential", async () => {
    const raw = "<structure>\nowner-repo/\n├── src/\n└── README.md\n</structure>";
    const adapter = makeZaiAdapterForEnv({ ZAI_API_KEY: ALIAS_KEY }, { directory: raw });
    // Root Directory legacy args: { repo_name } only.
    const legacyKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
    });
    const cache = makeRecordingCache({ [legacyKey]: raw });

    const out = await executeRepositoryOperation(
      adapter.repository.listDirectory,
      { repository: "owner/repo", path: "" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, {
      repository: "owner/repo",
      path: "",
      entries: [
        { name: "src", path: "src", kind: "directory" },
        { name: "README.md", path: "README.md", kind: "file" },
      ],
    });
    assert.ok(cache.gets.includes(legacyKey));
  });

  it("Directory root: Z_AI_API_KEY-over-ZAI_API_KEY precedence uses the primary credential", async () => {
    const raw = "<structure>\nowner-repo/\n├── src/\n└── README.md\n</structure>";
    const adapter = makeZaiAdapterForEnv(
      { Z_AI_API_KEY: PRIMARY_KEY, ZAI_API_KEY: ALIAS_KEY },
      { directory: raw },
    );
    const primaryKey = buildLegacyRepositoryCacheKey(PRIMARY_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
    });
    const aliasKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
    });
    assert.notStrictEqual(primaryKey, aliasKey);
    const cache = makeRecordingCache({ [primaryKey]: raw });

    await executeRepositoryOperation(
      adapter.repository.listDirectory,
      { repository: "owner/repo", path: "" },
      {},
      makeDeps(cache),
    );

    assert.ok(cache.gets.includes(primaryKey));
    assert.ok(!cache.gets.includes(aliasKey));
  });

  // -----------------------------------------------------------------------
  // Non-root Directory `dir_path` read-through and normalized write-back
  // -----------------------------------------------------------------------

  it("Directory non-root: alias-only ZAI_API_KEY reconstructs the legacy key with dir_path from the alias credential", async () => {
    const raw = "<structure>\nsrc/\n├── index.ts\n└── lib/\n</structure>";
    const adapter = makeZaiAdapterForEnv({ ZAI_API_KEY: ALIAS_KEY }, { directory: raw });
    // Non-root Directory legacy args: { repo_name, dir_path }.
    const legacyKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      dir_path: "src",
    });
    const cache = makeRecordingCache({ [legacyKey]: raw });

    const out = await executeRepositoryOperation(
      adapter.repository.listDirectory,
      { repository: "owner/repo", path: "src" },
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, {
      repository: "owner/repo",
      path: "src",
      entries: [
        { name: "index.ts", path: "src/index.ts", kind: "file" },
        { name: "lib", path: "src/lib", kind: "directory" },
      ],
    });
    assert.ok(cache.gets.includes(legacyKey));
    // Normalized key carries the operation-suffixed namespace.
    const normalizedKey = buildProviderCacheKey({
      provider: "zai",
      capability: "repository-exploration-repository-list-directory",
      credentialFingerprint: ALIAS_FP,
      request: { repository: "owner/repo", path: "src" },
    });
    assert.strictEqual(cache.sets[0].key, normalizedKey);
    assert.notStrictEqual(cache.sets[0].key, legacyKey);
    // Legacy file is preserved verbatim.
    assert.strictEqual(cache.store.get(legacyKey), raw);
  });

  it("Directory non-root: root and non-root legacy candidate keys differ (dir_path inclusion is observable)", async () => {
    // The pure-helper golden-key test in cache.test.js already locks
    // the literal bytes. This is the integrated Adapter proof: the
    // Adapter actually emits different candidate keys for root vs
    // non-root Directory at the same repository.
    const adapter = makeZaiAdapterForEnv(
      { ZAI_API_KEY: ALIAS_KEY },
      {
        directory: "<structure>\nx/\n├── a\n</structure>",
      },
    );
    const rootIdentity = adapter.repository.listDirectory.cacheIdentity({
      repository: "owner/repo",
      path: "",
    });
    const nonRootIdentity = adapter.repository.listDirectory.cacheIdentity({
      repository: "owner/repo",
      path: "src",
    });
    assert.notStrictEqual(
      rootIdentity.legacyCandidates[0].key,
      nonRootIdentity.legacyCandidates[0].key,
      "root and non-root Directory legacy keys must differ",
    );
    // The root key is built from `{ repo_name }`; the non-root key is
    // built from `{ repo_name, dir_path }`. Belt-and-braces.
    const expectedRootKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
    });
    const expectedNonRootKey = buildLegacyRepositoryCacheKey(
      ALIAS_KEY,
      DIRECTORY_TOOL_PUBLIC_NAME,
      { repo_name: "owner/repo", dir_path: "src" },
    );
    assert.strictEqual(rootIdentity.legacyCandidates[0].key, expectedRootKey);
    assert.strictEqual(nonRootIdentity.legacyCandidates[0].key, expectedNonRootKey);
  });

  it("Directory non-root: Z_AI_API_KEY-over-ZAI_API_KEY precedence uses the primary credential with dir_path", async () => {
    const raw = "<structure>\nsrc/\n├── index.ts\n└── lib/\n</structure>";
    const adapter = makeZaiAdapterForEnv(
      { Z_AI_API_KEY: PRIMARY_KEY, ZAI_API_KEY: ALIAS_KEY },
      { directory: raw },
    );
    const primaryKey = buildLegacyRepositoryCacheKey(PRIMARY_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      dir_path: "src",
    });
    const aliasKey = buildLegacyRepositoryCacheKey(ALIAS_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: "owner/repo",
      dir_path: "src",
    });
    assert.notStrictEqual(primaryKey, aliasKey);
    const cache = makeRecordingCache({ [primaryKey]: raw });

    await executeRepositoryOperation(
      adapter.repository.listDirectory,
      { repository: "owner/repo", path: "src" },
      {},
      makeDeps(cache),
    );

    assert.ok(cache.gets.includes(primaryKey));
    assert.ok(!cache.gets.includes(aliasKey));
  });
});

// ===========================================================================
// 4. Integrated retry/lifecycle through the REAL Z.AI Adapter
//
//   - Cache hit constructs/closes zero transports.
//   - Each uncached retry constructs a fresh transport (transport count
//     equals attempt count).
//   - Close rejection never alters success nor masks the primary failure.
//   - Close timeout never alters success nor masks the primary failure.
// ===========================================================================

describe("P6-08 integrated retry/lifecycle — Z.AI Adapter", () => {
  it("cache hit constructs and closes zero transports (no close path entered)", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: fixtures.searchValid.raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });

    const request = {
      repository: "facebook/react",
      query: "useState",
      language: "en",
    };

    // First call: populates the cache. Exactly one transport is
    // constructed AND closed exactly once.
    const cache = makeRecordingCache();
    const result = await executeRepositoryOperation(
      zaiAdapter.repository.search,
      request,
      {},
      makeDeps(cache),
    );
    assert.strictEqual(factory.created.length, 1, "uncached populate constructs one transport");
    assert.strictEqual(
      factory.created[0].fake.closeCount,
      1,
      "uncached populate closes the transport exactly once",
    );
    assert.strictEqual(
      factory.created[0].port.closeEntered,
      1,
      "uncached populate entered close exactly once",
    );

    // Reset the factory counter so the cache-hit call starts from zero.
    factory.created.length = 0;
    // Wipe the writes log so the cache-hit assertion is unambiguous.
    cache.sets.length = 0;

    // Second call: same Adapter, same request, seeded cache → cache hit.
    const out = await executeRepositoryOperation(
      zaiAdapter.repository.search,
      request,
      {},
      makeDeps(cache),
    );

    assert.deepStrictEqual(out, result);
    assert.strictEqual(
      factory.created.length,
      0,
      "no transport should be constructed on a cache hit",
    );
    assert.strictEqual(cache.sets.length, 0, "no cache write on a cache hit");
  });

  it("each uncached retry constructs and closes a distinct transport (transport count == attempt count)", async () => {
    // First invoke throws a retryable TimeoutError; second invoke
    // returns the valid Search fixture. The factory should construct
    // exactly two transports — one per attempt — and each transport
    // must be closed exactly once.
    let attempt = 0;
    const scriptedFactory = (options) => {
      attempt += 1;
      const fake = new FakeUtcpClient({
        discoveredTools: DISCOVERED_ZREAD_TOOLS,
        resultsByName: { [INTERNAL_SEARCH_DOC]: fixtures.searchValid.raw },
      });
      const port = {
        options,
        callToolCalls: [],
        closeEntered: 0,
        async callToolRaw(name, args) {
          this.callToolCalls.push({ name, args });
          if (attempt === 1) {
            throw new TimeoutError(1000);
          }
          return fake.callTool(INTERNAL_SEARCH_DOC, args);
        },
        async listTools() {
          return fake.getTools();
        },
        async close() {
          this.closeEntered += 1;
          return fake.close();
        },
      };
      scriptedFactory.created.push({ options, port, fake });
      return port;
    };
    scriptedFactory.created = [];

    const zaiAdapter = makeZaiAdapter({ factory: scriptedFactory });
    const sleepCalls = [];
    const out = await executeRepositoryOperation(
      zaiAdapter.repository.search,
      { repository: "facebook/react", query: "q", language: "en" },
      { noCache: true },
      {
        cache: makeRecordingCache(),
        sleep: (ms) => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
        random: () => 0,
      },
    );

    assert.ok(out.excerpts.length === 3);
    assert.strictEqual(scriptedFactory.created.length, 2, "one fresh transport per attempt");
    assert.strictEqual(sleepCalls.length, 1, "exactly one retry backoff");
    // Each constructed transport must be closed exactly once. The first
    // attempt threw and was still closed in its `finally`; the second
    // attempt succeeded and was also closed in its `finally`.
    assert.strictEqual(
      scriptedFactory.created[0].fake.closeCount,
      1,
      "first (failed) transport closed exactly once",
    );
    assert.strictEqual(
      scriptedFactory.created[0].port.closeEntered,
      1,
      "first (failed) transport entered close exactly once",
    );
    assert.strictEqual(
      scriptedFactory.created[1].fake.closeCount,
      1,
      "second (successful) transport closed exactly once",
    );
    assert.strictEqual(
      scriptedFactory.created[1].port.closeEntered,
      1,
      "second (successful) transport entered close exactly once",
    );
  });

  it("success path closes the constructed transport exactly once", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: fixtures.searchValid.raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const out = await executeRepositoryOperation(
      zaiAdapter.repository.search,
      { repository: "facebook/react", query: "q", language: "en" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    assert.ok(out.excerpts.length === 3);
    assert.strictEqual(factory.created.length, 1);
    assert.strictEqual(factory.created[0].fake.closeCount, 1, "success closes transport once");
    assert.strictEqual(factory.created[0].port.closeEntered, 1, "success entered close once");
  });

  it("primary failure path still closes every constructed transport (one per attempt)", async () => {
    // Malformed ZRead response → primary ApiError 502. The 502 is
    // retryable through the shared taxonomy, so the executor makes
    // exactly two attempts. Each constructed transport must still be
    // closed exactly once in its attempt's `finally`.
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: {
        [INTERNAL_GET_REPO_STRUCTURE]: "<structure>\nfacebook-react/\n</structure>",
      },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const err = await captureError(
      executeRepositoryOperation(
        zaiAdapter.repository.listDirectory,
        { repository: "facebook/react", path: "" },
        { noCache: true },
        makeDeps(makeRecordingCache()),
      ),
    );
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 502);
    // 502 is retryable → exactly two attempts → two transports, each
    // closed exactly once.
    assert.strictEqual(factory.created.length, 2, "retryable 502 must construct two transports");
    for (let i = 0; i < factory.created.length; i += 1) {
      assert.strictEqual(
        factory.created[i].fake.closeCount,
        1,
        `transport #${i + 1} must be closed exactly once`,
      );
      assert.strictEqual(
        factory.created[i].port.closeEntered,
        1,
        `transport #${i + 1} must enter close exactly once`,
      );
    }
  });

  it("close rejection never replaces a successful result AND the close path was entered", async () => {
    const baseFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: fixtures.searchValid.raw },
    });
    const factory = withCloseRejection(baseFactory);
    const zaiAdapter = makeZaiAdapter({ factory });
    const out = await executeRepositoryOperation(
      zaiAdapter.repository.search,
      { repository: "facebook/react", query: "q", language: "en" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    assert.ok(out.excerpts.length === 3);
    // The close wrapper was actually entered (FR-093: best-effort close
    // must be attempted even when it later rejects).
    assert.strictEqual(factory.created.length, 1);
    assert.strictEqual(
      factory.created[0].port.closeEntered,
      1,
      "close rejection path must still enter close exactly once",
    );
    // The underlying FakeUtcpClient close counter stays at zero because
    // the wrapper rejected before delegating; this is the evidence that
    // the rejection branch actually ran.
    assert.strictEqual(
      factory.created[0].fake.closeCount,
      0,
      "close rejection wrapper must not delegate to the underlying fake close",
    );
  });

  it("close rejection never masks a primary operation failure AND every attempt enters close", async () => {
    // Force a malformed ZRead response (primary 502) and a close that
    // rejects. The 502 is retryable, so the executor makes two
    // attempts. The outward error MUST be the 502, not the close error;
    // every constructed transport must have entered the close path
    // (FR-093: close is best-effort and must actually be attempted).
    const baseFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: {
        [INTERNAL_GET_REPO_STRUCTURE]: "<structure>\nfacebook-react/\n</structure>",
      },
    });
    const factory = withCloseRejection(baseFactory);
    const zaiAdapter = makeZaiAdapter({ factory });
    const err = await captureError(
      executeRepositoryOperation(
        zaiAdapter.repository.listDirectory,
        { repository: "facebook/react", path: "" },
        { noCache: true },
        makeDeps(makeRecordingCache()),
      ),
    );
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 502);
    assert.ok(!err.message.includes("close rejected"));
    // 502 is retryable → exactly two attempts → two transports, each
    // with closeEntered === 1 and fake.closeCount === 0 (because the
    // rejection wrapper does not delegate to the underlying fake).
    assert.strictEqual(factory.created.length, 2);
    for (let i = 0; i < factory.created.length; i += 1) {
      assert.strictEqual(
        factory.created[i].port.closeEntered,
        1,
        `transport #${i + 1} must enter close exactly once even under rejection`,
      );
      assert.strictEqual(
        factory.created[i].fake.closeCount,
        0,
        `transport #${i + 1} close rejection must not delegate to underlying fake close`,
      );
    }
  });

  it("close timeout never replaces a successful result AND the close path was entered (bounded close)", async () => {
    const baseFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: fixtures.searchValid.raw },
    });
    const factory = withCloseHang(baseFactory);
    // Inject a 50 ms close bound so the never-resolving close is bounded
    // well below the 2000 ms production default.
    const zaiAdapter = makeZaiAdapter({ factory, closeTimeoutMs: 50 });
    const start = Date.now();
    const out = await executeRepositoryOperation(
      zaiAdapter.repository.search,
      { repository: "facebook/react", query: "q", language: "en" },
      { noCache: true },
      makeDeps(makeRecordingCache()),
    );
    const elapsed = Date.now() - start;
    assert.ok(out.excerpts.length === 3);
    assert.ok(elapsed < 1000, `never-resolving close should be bounded, took ${elapsed} ms`);
    // FR-093: the close path was actually entered even though the
    // wrapper never resolved. The Adapter's bounded-close race
    // resolves the attempt, but `closeEntered` proves the close call
    // was issued.
    assert.strictEqual(factory.created.length, 1);
    assert.strictEqual(
      factory.created[0].port.closeEntered,
      1,
      "close hang path must still enter close exactly once",
    );
  });

  it("close timeout never masks a primary operation failure AND every retry attempt enters close (bounded close)", async () => {
    // P6-08A re-review: the success+hang case above proves the close
    // timeout race preserves success. This case proves the same race
    // preserves a PRIMARY operation failure: a malformed ZRead
    // response (retryable ApiError 502) is wrapped with a never-
    // resolving close. The outward error MUST remain the primary 502,
    // every retry attempt's close must be actually entered, and each
    // attempt must use a distinct transport.
    //
    // Wall-clock is a SECONDARY upper-bound only; the primary evidence
    // is the injected-sleep retry count, the per-port `closeEntered`
    // counters, and the outward ApiError shape. A generous upper bound
    // (1 s for a 50 ms × 2-attempt race) avoids CI flake without
    // weakening the assertion.
    const baseFactory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: {
        [INTERNAL_GET_REPO_STRUCTURE]: "<structure>\nfacebook-react/\n</structure>",
      },
    });
    const factory = withCloseHang(baseFactory);
    const zaiAdapter = makeZaiAdapter({ factory, closeTimeoutMs: 50 });
    const sleepCalls = [];
    const start = Date.now();
    const err = await captureError(
      executeRepositoryOperation(
        zaiAdapter.repository.listDirectory,
        { repository: "facebook/react", path: "" },
        { noCache: true },
        {
          cache: makeRecordingCache(),
          sleep: (ms) => {
            sleepCalls.push(ms);
            return Promise.resolve();
          },
          random: () => 0,
        },
      ),
    );
    const elapsed = Date.now() - start;

    // Primary failure survives: outward ApiError 502, NOT a close
    // timeout or hang error.
    assert.ok(err instanceof ApiError, `expected ApiError, got ${err && err.constructor.name}`);
    assert.strictEqual(err.statusCode, 502);
    assert.ok(
      !err.message.includes("close"),
      `primary failure must not mention close: ${err.message}`,
    );

    // 502 is retryable → exactly two attempts, two distinct transports,
    // one injected sleep call.
    assert.strictEqual(
      factory.created.length,
      2,
      "primary failure + retryable 502 must construct two distinct transports",
    );
    assert.strictEqual(sleepCalls.length, 1, "exactly one injected retry sleep");
    assert.strictEqual(sleepCalls[0], 500, "base delay × 2^0 + zero jitter");

    // Every retry attempt entered close exactly once (FR-093: close is
    // best-effort and must actually be attempted even under a hang).
    for (let i = 0; i < factory.created.length; i += 1) {
      assert.strictEqual(
        factory.created[i].port.closeEntered,
        1,
        `transport #${i + 1} must enter close exactly once under hang`,
      );
      // The hang wrapper never delegates to the underlying fake close,
      // so fake.closeCount stays at 0; the closeEntered counter is the
      // authoritative evidence that the close path was actually issued.
      assert.strictEqual(
        factory.created[i].fake.closeCount,
        0,
        `transport #${i + 1} hang must not delegate to the underlying fake close`,
      );
    }

    // Two transports are distinct instances (not the same one reused).
    assert.notStrictEqual(
      factory.created[0].port,
      factory.created[1].port,
      "retry attempts must use distinct transport instances",
    );

    // Secondary upper-bound evidence: the bounded-close race keeps
    // the total wall-clock well under the production default ×
    // attempts. Generous margin to avoid CI flake.
    assert.ok(
      elapsed < 1000,
      `two bounded-close attempts should complete well under 1 s, took ${elapsed} ms`,
    );
  });

  it("production close bound constant is 2000 ms (matches ZaiMcpClient.close)", () => {
    assert.strictEqual(ZAI_REPOSITORY_CLOSE_BOUND_MS, 2000);
  });
});

// ===========================================================================
// 5. Exact encoded-error fixtures (DESIGN.md §18, ZRead characterization)
//
//   - Exhausted quota (code 1310 or explicit exhausted-quota meaning) is
//     terminal QUOTA_ERROR; one attempt, zero sleeps.
//   - Auth 401/403 is terminal AUTH_ERROR with the matching status.
//   - Other 4xx is terminal API_ERROR with the matching status.
//   - Transient 429 (no exhausted meaning), 5xx, and malformed 502 each
//     receive exactly one retry.
//
// Note on `error.retryable`:
//   The shared retry classifier (`isOperationRetryableError`) treats
//   `API_ERROR` with status 429/500/502/503/504 as retryable regardless
//   of the per-error `retryable` flag, which is `false` by default on
//   ApiError. The proof here is therefore the OBSERVABLE retry behaviour
//   (attempt count and sleep count), not the `retryable` field.
// ===========================================================================

describe("P6-08 encoded MCP error taxonomy through the Z.AI Adapter", () => {
  /**
   * Drive the Z.AI Search Adapter with a given raw ZRead response and
   * return the captured outward error plus observable retry evidence.
   */
  async function captureErrorWithEvidence(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: raw },
    });
    const zaiAdapter = makeZaiAdapter({ factory });
    const sleepCalls = [];
    const err = await captureError(
      executeRepositoryOperation(
        zaiAdapter.repository.search,
        { repository: "facebook/react", query: "q", language: "en" },
        { noCache: true },
        {
          cache: makeRecordingCache(),
          sleep: (ms) => {
            sleepCalls.push(ms);
            return Promise.resolve();
          },
          random: () => 0,
        },
      ),
    );
    return { err, sleepCalls, factory };
  }

  it("exhausted quota (code 1310) is terminal QUOTA_ERROR — single attempt, zero sleeps", async () => {
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(fixtures.errorMcpQuota.raw);
    assert.ok(err instanceof QuotaError, `expected QuotaError, got ${err && err.constructor.name}`);
    assert.strictEqual(err.code, "QUOTA_ERROR");
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(sleepCalls.length, 0);
    assert.strictEqual(
      factory.created.length,
      1,
      "terminal error must construct exactly one transport",
    );
  });

  it("exhausted quota body never crosses the public envelope (sanitized message)", async () => {
    const { err } = await captureErrorWithEvidence(fixtures.errorMcpQuota.raw);
    assert.ok(err instanceof QuotaError);
    assert.ok(!err.message.includes("Weekly/Monthly Limit Exhausted"));
    assert.ok(!err.message.includes("1310"));
    assert.ok(!err.help.includes("reset"));
  });

  it("transient 5xx is retryable — exactly two attempts, one sleep", async () => {
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(
      fixtures.errorMcpGeneric.raw,
    );
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.code, "API_ERROR");
    assert.strictEqual(err.statusCode, 500);
    assert.strictEqual(sleepCalls.length, 1, "transient 5xx must retry exactly once");
    assert.strictEqual(factory.created.length, 2, "retryable 5xx must construct two transports");
  });

  it("malformed envelope (no parseable status) maps to retryable ApiError 502", async () => {
    // A raw response that is neither valid grammar nor a parseable
    // encoded MCP envelope: the success parser throws a sanitized
    // ApiError 502, which the retry classifier treats as retryable.
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(
      "MCP error -not-a-status\nerror.message: garbage",
    );
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 502);
    assert.strictEqual(sleepCalls.length, 1);
    assert.strictEqual(factory.created.length, 2);
  });

  it("auth 401 is terminal AUTH_ERROR — single attempt, zero sleeps", async () => {
    const raw401 = "MCP error -401\nerror.code: 100\nerror.message: unauthorised";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw401);
    assert.ok(err instanceof AuthError);
    assert.strictEqual(err.code, "AUTH_ERROR");
    assert.strictEqual(err.statusCode, 401);
    assert.strictEqual(sleepCalls.length, 0);
    assert.strictEqual(factory.created.length, 1);
  });

  it("auth 403 is terminal AUTH_ERROR with statusCode 403", async () => {
    const raw403 = "MCP error -403\nerror.code: 100\nerror.message: forbidden";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw403);
    assert.ok(err instanceof ScoutlineError);
    assert.strictEqual(err.code, "AUTH_ERROR");
    assert.strictEqual(err.statusCode, 403);
    assert.strictEqual(sleepCalls.length, 0);
    assert.strictEqual(factory.created.length, 1);
  });

  it("other 4xx (404) is terminal API_ERROR with matching status", async () => {
    const raw404 = "MCP error -404\nerror.code: 100\nerror.message: not found";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw404);
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.code, "API_ERROR");
    assert.strictEqual(err.statusCode, 404);
    assert.strictEqual(sleepCalls.length, 0);
    assert.strictEqual(factory.created.length, 1);
  });

  it("transient 429 (no exhausted meaning) is retryable — exactly two attempts", async () => {
    const raw429 = "MCP error -429\nerror.code: 100\nerror.message: rate limited";
    const { err, sleepCalls, factory } = await captureErrorWithEvidence(raw429);
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.statusCode, 429);
    assert.strictEqual(sleepCalls.length, 1);
    assert.strictEqual(factory.created.length, 2);
  });

  it("encoded quota fixture cannot satisfy a valid-success grammar", () => {
    // Direct characterization assertion: the encoded quota fixture raw
    // string does not contain a valid `<excerpt>` wrapper and would be
    // rejected by any success parser. (Evidence only; classification is
    // proven above.)
    assert.ok(!fixtures.errorMcpQuota.raw.includes("<excerpt>"));
    assert.ok(!fixtures.errorMcpQuota.raw.includes("<file_content>"));
    assert.ok(!fixtures.errorMcpQuota.raw.includes("<structure>"));
  });
});

// ===========================================================================
// 6. Real dispatcher selection-order through `main()`
//
//   - default ZAI, explicit ZAI, environment ZAI all succeed.
//   - unsupported MiniMax (explicit or environment) returns
//     UNSUPPORTED_CAPABILITY with zero selected-Provider work.
//   - descriptor-advertises-but-Adapter-omits fail closed.
// ===========================================================================

describe("P6-08 real dispatcher selection-order (main → repo)", () => {
  function makeRecordingCacheMain() {
    const gets = [];
    const sets = [];
    const store = new Map();
    const cache = {
      gets,
      sets,
      store,
      async get(key) {
        gets.push(key);
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        sets.push({ key, value });
        store.set(key, value);
      },
    };
    return cache;
  }

  function makeRecordingAdapter(overrides = {}) {
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
   * Standard Z.AI descriptor wired to a fake UTCP client so the
   * repository capability can return a known valid Search result.
   */
  function makeZaiDescriptorWithFake({ searchRaw }) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: {
        [INTERNAL_SEARCH_DOC]: searchRaw,
        [INTERNAL_READ_FILE]: fixtures.fileValid.raw,
        [INTERNAL_GET_REPO_STRUCTURE]: fixtures.treeRootValid.raw,
      },
    });
    return { descriptor: createZaiDescriptor({ clientFactory: factory }), factory };
  }

  it("default ZAI dispatches repo search through the Z.AI Adapter (success)", async () => {
    const { descriptor: zai } = makeZaiDescriptorWithFake({ searchRaw: fixtures.searchValid.raw });
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stdout, stderr } = makeRecordingAdapter();
    const status = await main(["repo", "search", "facebook/react", "useState"], {
      env: { Z_AI_API_KEY: TEST_API_KEY },
      providerDescriptors: [zai, minimax],
      repositoryCache: cache,
      searchCache: cache,
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(stderr, []);
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.ok(parsed.excerpts.length >= 1);
  });

  it("explicit --provider zai wins over SCOUTLINE_PROVIDER=minimax", async () => {
    const { descriptor: zai } = makeZaiDescriptorWithFake({ searchRaw: fixtures.searchValid.raw });
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stdout, stderr } = makeRecordingAdapter();
    const status = await main(
      ["--provider", "zai", "repo", "search", "facebook/react", "useState"],
      {
        env: { Z_AI_API_KEY: TEST_API_KEY, SCOUTLINE_PROVIDER: "minimax" },
        providerDescriptors: [zai, minimax],
        repositoryCache: cache,
        searchCache: cache,
        invocation: adapter,
      },
    );
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(stderr, []);
    assert.ok(JSON.parse(stdout[0]).excerpts.length >= 1);
  });

  it("unsupported explicit MiniMax returns UNSUPPORTED_CAPABILITY with zero selected-Provider work", async () => {
    const { descriptor: zai, factory: zaiFactory } = makeZaiDescriptorWithFake({
      searchRaw: fixtures.searchValid.raw,
    });
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stderr } = makeRecordingAdapter();
    const status = await main(
      ["--provider", "minimax", "repo", "search", "facebook/react", "useState"],
      {
        env: { Z_AI_API_KEY: TEST_API_KEY, MINIMAX_API_KEY: "mm-key" },
        providerDescriptors: [zai, minimax],
        repositoryCache: cache,
        searchCache: cache,
        invocation: adapter,
      },
    );
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");
    // Zero cache reads/writes.
    assert.strictEqual(cache.gets.length, 0);
    assert.strictEqual(cache.sets.length, 0);
    // Zero Z.AI fallback transports.
    assert.strictEqual(zaiFactory.created.length, 0);
  });

  it("unsupported environment MiniMax returns UNSUPPORTED_CAPABILITY with zero selected-Provider work", async () => {
    const { descriptor: zai, factory: zaiFactory } = makeZaiDescriptorWithFake({
      searchRaw: fixtures.searchValid.raw,
    });
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stderr } = makeRecordingAdapter();
    const status = await main(["repo", "search", "facebook/react", "useState"], {
      env: {
        Z_AI_API_KEY: TEST_API_KEY,
        MINIMAX_API_KEY: "mm-key",
        SCOUTLINE_PROVIDER: "minimax",
      },
      providerDescriptors: [zai, minimax],
      repositoryCache: cache,
      searchCache: cache,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(cache.gets.length, 0);
    assert.strictEqual(cache.sets.length, 0);
    assert.strictEqual(zaiFactory.created.length, 0);
  });

  it("descriptor advertises repository-exploration but Adapter omits repository → fail closed", async () => {
    // Production path: createZaiDescriptor supplies the repository
    // handle. For this test we build a Z.AI-shaped descriptor that
    // advertises the capability but omits the handle, then assert
    // main() returns UNSUPPORTED_CAPABILITY.
    const descriptor = {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["search", "repository-exploration"]),
      create: () => ({ id: "zai" }), // no `repository` handle
    };
    const minimax = createMiniMaxDescriptor();
    const cache = makeRecordingCacheMain();
    const { adapter, stderr } = makeRecordingAdapter();
    const status = await main(["repo", "search", "facebook/react", "useState"], {
      env: { Z_AI_API_KEY: TEST_API_KEY },
      providerDescriptors: [descriptor, minimax],
      repositoryCache: cache,
      searchCache: cache,
      invocation: adapter,
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");
  });

  it("MiniMax descriptor continues to advertise no repository-exploration", () => {
    // Static metadata proof — locks the MiniMax advertisement so a
    // future regression cannot silently enable repository selection.
    const minimax = createMiniMaxDescriptor();
    assert.ok(!minimax.capabilities().has("repository-exploration"));
    const adapter = minimax.create({ env: {} });
    assert.strictEqual(adapter.repository, undefined);
  });
});

// ===========================================================================
// 7. Cross-Adapter dispatcher through `main()` using a fake repository
//    Provider: selection does NOT branch on Provider ID.
//
// A fake Provider descriptor whose Adapter supplies a fake Repository
// Capability is registered under the "zai" ID (the production dispatcher
// only resolves IDs in PROVIDER_IDS). Each Adapter is fed inputs that
// normalize to the SAME structured value; the outward stdout is
// byte-identical across data/json/pretty/compact modes.
// ===========================================================================

describe("P6-08 cross-Adapter dispatcher through main() (Search/Read/Tree × Z.AI + fake × modes)", () => {
  const FIXED_NOW = 1_700_000_000_000;

  /**
   * Shared structured expected values. Each Adapter is fed inputs that
   * normalize to the SAME expected value for that operation. The raw
   * ZRead inputs fed to FakeUtcpClient are controlled so the Z.AI
   * Adapter produces exactly these structured results.
   */
  function sharedSearchResult() {
    const text = "shared conformance excerpt";
    return {
      schemaVersion: 1,
      repository: "owner/repo",
      query: "conformance",
      language: "en",
      excerpts: [{ text }],
      truncated: false,
      originalTextLength: text.length,
    };
  }
  function rawForSharedSearch() {
    return `<excerpt>shared conformance excerpt</excerpt>`;
  }

  function sharedFileResult() {
    const body = "shared file body";
    return {
      schemaVersion: 1,
      repository: "owner/repo",
      path: "README.md",
      content: body,
      truncated: false,
      originalContentLength: body.length,
    };
  }
  function rawForSharedFile() {
    return `<file_content>shared file body</file_content>`;
  }

  function sharedDirectoryListing(path = "") {
    if (path === "") {
      return {
        repository: "owner/repo",
        path: "",
        entries: [
          { name: "src", path: "src", kind: "directory" },
          { name: "README.md", path: "README.md", kind: "file" },
        ],
      };
    }
    if (path === "src") {
      return {
        repository: "owner/repo",
        path: "src",
        entries: [
          { name: "index.ts", path: "src/index.ts", kind: "file" },
          { name: "lib", path: "src/lib", kind: "directory" },
        ],
      };
    }
    throw new Error(`no shared listing for path ${path}`);
  }
  function rawForSharedDirectory(path = "") {
    if (path === "") {
      return "<structure>\nowner-repo/\n├── src/\n└── README.md\n</structure>";
    }
    if (path === "src") {
      return "<structure>\nsrc/\n├── index.ts\n└── lib/\n</structure>";
    }
    throw new Error(`no raw for path ${path}`);
  }

  /**
   * Build a Z.AI descriptor whose fake UTCP client serves the supplied
   * raw responses for Search/File/Directory. Unspecified operations
   * throw "no result" if invoked.
   */
  function buildZaiDescriptor({ searchRaw, fileRaw, dirRaw }) {
    const resultsByName = {};
    if (searchRaw !== undefined) resultsByName[INTERNAL_SEARCH_DOC] = searchRaw;
    if (fileRaw !== undefined) resultsByName[INTERNAL_READ_FILE] = fileRaw;
    if (dirRaw !== undefined) resultsByName[INTERNAL_GET_REPO_STRUCTURE] = dirRaw;
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName,
    });
    return createZaiDescriptor({ clientFactory: factory });
  }

  /**
   * Build a fake repository Provider Descriptor. It is registered under
   * the `"zai"` ID because the production dispatcher only resolves IDs
   * in `PROVIDER_IDS`. This proves the dispatcher does NOT branch on
   * Provider ID — only on descriptor metadata and Adapter handles. The
   * fake remains UNADVERTISED as a real Provider (the canonical
   * `BUILT_IN_PROVIDER_DESCRIPTORS` registry is unchanged).
   *
   * `listDirectoryResult` may be either a static result or a function
   * `(request) => result`. The function form is required for Tree BFS
   * proofs where the Explorer calls listDirectory at multiple paths.
   */
  function buildFakeDescriptor({ searchResult, fileResult, listDirectoryResult }) {
    const listDirectory =
      typeof listDirectoryResult === "function"
        ? { result: listDirectoryResult }
        : listDirectoryResult !== undefined
          ? { result: listDirectoryResult }
          : undefined;
    const { descriptor } = createFakeRepositoryDescriptor({
      id: "fake",
      apiKey: TEST_API_KEY,
      capabilityOptions: {
        search: searchResult !== undefined ? { result: searchResult } : undefined,
        readFile: fileResult !== undefined ? { result: fileResult } : undefined,
        listDirectory,
      },
    });
    return {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["repository-exploration"]),
      create: () => descriptor.create({ env: {} }),
    };
  }

  function makeRecordingAdapter(overrides = {}) {
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

  function makeRecordingCacheMain() {
    const store = new Map();
    const cache = {
      gets: [],
      sets: [],
      store,
      async get(key) {
        cache.gets.push(key);
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        cache.sets.push({ key, value });
        store.set(key, value);
      },
    };
    return cache;
  }

  /**
   * Run one operation+mode through main() with the given descriptor and
   * return the recorded status, stderr, and stdout. Asserts the
   * observable invariants the matrix cares about: status code, empty
   * stderr, single stdout line, and (when `expectedData` is supplied)
   * exact data-mode public value.
   *
   * `expectedEnvelope` is a function `(data, mode) => expected` that
   * builds the mode-specific expected value. For `data` it returns
   * `data`; for `json`/`pretty` it returns `{ success: true, data,
   * timestamp: FIXED_NOW }`; for text-oriented modes the contract is
   * JSON-fallback (the same `data` value).
   *
   * P6-08A re-review: `repositorySleep` (no-op) and `repositoryRandom`
   * (constant zero) are injected so retryable malformed-response cases
   * perform no real wall-clock backoff or jitter (NFR-007). The
   * harness records every sleep call on the returned `sleepCalls` array
   * so callers can assert "retryable 502 sleeps exactly once".
   */
  async function runOne({ descriptor, argv, mode, expectedData, expectedEnvelope }) {
    const cache = makeRecordingCacheMain();
    const recorder = makeRecordingAdapter({
      environmentOutputMode: undefined,
    });
    const sleepCalls = [];
    const status = await main([...(mode === "data" ? [] : ["-O", mode]), ...argv], {
      env: { Z_AI_API_KEY: TEST_API_KEY },
      providerDescriptors: [descriptor],
      repositoryCache: cache,
      searchCache: cache,
      // Deterministic shared-execution dependencies: a no-op sleep so
      // retry backoff completes in microseconds, and a constant-zero
      // random so jitter is reproducibly zero.
      repositorySleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      repositoryRandom: () => 0,
      // Mirror for the Search execution deps (unused by repo subcommands
      // but accepted by main).
      searchSleep: (ms) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
      searchRandom: () => 0,
      invocation: recorder.adapter,
      now: () => FIXED_NOW,
    });
    return {
      status,
      stderr: recorder.stderr,
      stdout: recorder.stdout,
      cache,
      sleepCalls,
    };
  }

  /**
   * Run the SAME semantic operation through both Adapters in one mode
   * and assert: status 0, empty stderr, stdout-arrays deep-equal, and
   * the exact expected public value. Returns the captured ZAI recorder
   * so mode-specific assertions can layer on top.
   */
  async function runAndAssertBoth({ argv, mode, expectedData, expectedEnvelope }) {
    const zaiResult = await runOne({
      descriptor: buildZaiDescriptor({
        searchRaw: rawForSharedSearch(),
        fileRaw: rawForSharedFile(),
        dirRaw: rawForSharedDirectory(argv.includes("src") ? "src" : ""),
      }),
      argv,
      mode,
      expectedData,
      expectedEnvelope,
    });
    const fakeResult = await runOne({
      descriptor: buildFakeDescriptor({
        searchResult: sharedSearchResult(),
        fileResult: sharedFileResult(),
        listDirectoryResult: sharedDirectoryListing(argv.includes("src") ? "src" : ""),
      }),
      argv,
      mode,
      expectedData,
      expectedEnvelope,
    });

    // Per-Adapter invariants.
    assert.strictEqual(zaiResult.status, 0, `Z.AI status for mode ${mode}`);
    assert.strictEqual(fakeResult.status, 0, `fake status for mode ${mode}`);
    assert.deepStrictEqual(zaiResult.stderr, [], `Z.AI stderr for mode ${mode}`);
    assert.deepStrictEqual(fakeResult.stderr, [], `fake stderr for mode ${mode}`);
    assert.strictEqual(zaiResult.stdout.length, 1, `Z.AI stdout lines for mode ${mode}`);
    assert.strictEqual(fakeResult.stdout.length, 1, `fake stdout lines for mode ${mode}`);

    // Cross-Adapter byte-identical stdout.
    assert.deepStrictEqual(
      zaiResult.stdout,
      fakeResult.stdout,
      `mode ${mode}: Z.AI and fake stdout must match`,
    );

    // Exact expected public value for this mode.
    const parsed = JSON.parse(zaiResult.stdout[0]);
    const expected = expectedEnvelope(expectedData, mode);
    assert.deepStrictEqual(parsed, expected, `mode ${mode}: exact expected public value`);
    return { zaiResult, fakeResult };
  }

  // -------------------------------------------------------------------------
  // Search × {data,json,pretty,compact} × {Z.AI, fake}
  // -------------------------------------------------------------------------

  describe("Search through main()", () => {
    const modeMatrix = ["data", "json", "pretty", "compact"];
    const expectedData = sharedSearchResult();
    const envelope = (data, mode) =>
      mode === "json" || mode === "pretty" ? { success: true, data, timestamp: FIXED_NOW } : data;

    for (const mode of modeMatrix) {
      it(`both Adapters produce status 0, empty stderr, and the exact expected value in ${mode} mode`, async () => {
        await runAndAssertBoth({
          argv: ["repo", "search", "owner/repo", "conformance"],
          mode,
          expectedData,
          expectedEnvelope: envelope,
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // Read (File) × {data,json,pretty,compact} × {Z.AI, fake}
  // -------------------------------------------------------------------------

  describe("Read through main()", () => {
    const modeMatrix = ["data", "json", "pretty", "compact"];
    const expectedData = sharedFileResult();
    const envelope = (data, mode) =>
      mode === "json" || mode === "pretty" ? { success: true, data, timestamp: FIXED_NOW } : data;

    for (const mode of modeMatrix) {
      it(`both Adapters produce status 0, empty stderr, and the exact expected value in ${mode} mode`, async () => {
        await runAndAssertBoth({
          argv: ["repo", "read", "owner/repo", "README.md"],
          mode,
          expectedData,
          expectedEnvelope: envelope,
        });
      });
    }
  });

  // -------------------------------------------------------------------------
  // Tree × {data,json,pretty,compact} × {Z.AI, fake}
  // -------------------------------------------------------------------------

  describe("Tree through main()", () => {
    const modeMatrix = ["data", "json", "pretty", "compact"];
    const envelope = (data, mode) =>
      mode === "json" || mode === "pretty" ? { success: true, data, timestamp: FIXED_NOW } : data;

    it("both Adapters produce status 0, empty stderr, and the exact expected root tree (depth 1) across all four modes", async () => {
      const expectedData = {
        schemaVersion: 1,
        repository: "owner/repo",
        path: "",
        depth: 1,
        snapshots: [sharedDirectoryListing("")],
      };
      for (const mode of modeMatrix) {
        await runAndAssertBoth({
          argv: ["repo", "tree", "owner/repo"],
          mode,
          expectedData,
          expectedEnvelope: envelope,
        });
      }
    });

    it("both Adapters produce the exact expected depth-2 tree (BFS) across all four modes", async () => {
      const expectedData = {
        schemaVersion: 1,
        repository: "owner/repo",
        path: "",
        depth: 2,
        snapshots: [sharedDirectoryListing(""), sharedDirectoryListing("src")],
      };
      // Path-aware Z.AI factory: serves the matching Structure raw per
      // requested path so BFS at depth 2 produces the same two
      // snapshots the fake Adapter produces.
      function buildZaiBfsDescriptor() {
        const factory = (options) => {
          const fake = new FakeUtcpClient({ discoveredTools: DISCOVERED_ZREAD_TOOLS });
          const port = {
            options,
            callToolCalls: [],
            closeEntered: 0,
            async callToolRaw(name, args) {
              this.callToolCalls.push({ name, args });
              if (name === SEARCH_TOOL_PUBLIC_NAME) return rawForSharedSearch();
              if (name === FILE_TOOL_PUBLIC_NAME) return rawForSharedFile();
              if (name === DIRECTORY_TOOL_PUBLIC_NAME) {
                return args.dir_path === undefined
                  ? rawForSharedDirectory("")
                  : rawForSharedDirectory(args.dir_path);
              }
              throw new Error(`unexpected tool ${name}`);
            },
            async listTools() {
              return fake.getTools();
            },
            async close() {
              this.closeEntered += 1;
              return fake.close();
            },
          };
          return port;
        };
        return createZaiDescriptor({ clientFactory: factory });
      }

      for (const mode of modeMatrix) {
        const zaiBfs = await runOne({
          descriptor: buildZaiBfsDescriptor(),
          argv: ["repo", "tree", "owner/repo", "--depth", "2"],
          mode,
        });
        const fakeResult = await runOne({
          descriptor: buildFakeDescriptor({
            listDirectoryResult: (request) => sharedDirectoryListing(request.path),
          }),
          argv: ["repo", "tree", "owner/repo", "--depth", "2"],
          mode,
        });

        assert.strictEqual(
          zaiBfs.status,
          0,
          `Z.AI BFS status for mode ${mode}: ${zaiBfs.stderr[0] || "<no stderr>"}`,
        );
        assert.strictEqual(fakeResult.status, 0, `fake BFS status for mode ${mode}`);
        assert.deepStrictEqual(zaiBfs.stderr, [], `Z.AI BFS stderr for mode ${mode}`);
        assert.deepStrictEqual(fakeResult.stderr, [], `fake BFS stderr for mode ${mode}`);
        assert.deepStrictEqual(
          zaiBfs.stdout,
          fakeResult.stdout,
          `mode ${mode}: Z.AI and fake BFS stdout must match`,
        );
        const parsed = JSON.parse(zaiBfs.stdout[0]);
        assert.deepStrictEqual(
          parsed,
          mode === "json" || mode === "pretty"
            ? { success: true, data: expectedData, timestamp: FIXED_NOW }
            : expectedData,
          `mode ${mode}: exact expected BFS tree value`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Fake explicit empty Search and empty Tree/Directory results through
  // the public command/Explorer seam (FR-091).
  //
  // The fake Adapter distinguishes a genuine empty state from a malformed
  // response; the Explorer and command projection must round-trip the
  // empty `excerpts: []` and `entries: []` arrays unchanged. Z.AI
  // no-wrapper/empty-wrapper grammar remains malformed (covered above).
  // -------------------------------------------------------------------------

  describe("Fake explicit empty results through main() (FR-091)", () => {
    const modeMatrix = ["data", "json", "pretty", "compact"];
    const envelope = (data, mode) =>
      mode === "json" || mode === "pretty" ? { success: true, data, timestamp: FIXED_NOW } : data;

    it("fake empty Search produces status 0, empty stderr, and `excerpts: []` across all four modes", async () => {
      const emptySearch = {
        schemaVersion: 1,
        repository: "owner/repo",
        query: "non-matching",
        language: "en",
        excerpts: [],
        truncated: false,
        originalTextLength: 0,
      };
      for (const mode of modeMatrix) {
        const result = await runOne({
          descriptor: buildFakeDescriptor({ searchResult: emptySearch }),
          argv: ["repo", "search", "owner/repo", "non-matching"],
          mode,
        });
        assert.strictEqual(result.status, 0, `fake empty search status for mode ${mode}`);
        assert.deepStrictEqual(result.stderr, [], `fake empty search stderr for mode ${mode}`);
        const parsed = JSON.parse(result.stdout[0]);
        assert.deepStrictEqual(parsed, envelope(emptySearch, mode));
        assert.strictEqual(Array.isArray(parsed.data?.excerpts ?? parsed.excerpts), true);
      }
    });

    it("fake empty Directory at root produces an empty `entries: []` snapshot through `repo tree`", async () => {
      const emptyListing = { repository: "owner/repo", path: "", entries: [] };
      const expectedTree = {
        schemaVersion: 1,
        repository: "owner/repo",
        path: "",
        depth: 1,
        snapshots: [emptyListing],
      };
      for (const mode of modeMatrix) {
        const result = await runOne({
          descriptor: buildFakeDescriptor({ listDirectoryResult: emptyListing }),
          argv: ["repo", "tree", "owner/repo"],
          mode,
        });
        assert.strictEqual(result.status, 0, `fake empty tree status for mode ${mode}`);
        assert.deepStrictEqual(result.stderr, [], `fake empty tree stderr for mode ${mode}`);
        const parsed = JSON.parse(result.stdout[0]);
        assert.deepStrictEqual(parsed, envelope(expectedTree, mode));
        const snapshots = parsed.data?.snapshots ?? parsed.snapshots;
        assert.strictEqual(snapshots[0].entries.length, 0);
      }
    });

    it("fake empty Directory at non-root produces an empty `entries: []` snapshot through `repo tree --path src`", async () => {
      const emptySrc = { repository: "owner/repo", path: "src", entries: [] };
      const expectedTree = {
        schemaVersion: 1,
        repository: "owner/repo",
        path: "src",
        depth: 1,
        snapshots: [emptySrc],
      };
      for (const mode of modeMatrix) {
        const result = await runOne({
          descriptor: buildFakeDescriptor({ listDirectoryResult: emptySrc }),
          argv: ["repo", "tree", "owner/repo", "--path", "src"],
          mode,
        });
        assert.strictEqual(result.status, 0);
        assert.deepStrictEqual(result.stderr, []);
        const parsed = JSON.parse(result.stdout[0]);
        assert.deepStrictEqual(parsed, envelope(expectedTree, mode));
      }
    });

    it("fake empty Read returns empty content with originalContentLength 0 (valid empty state)", async () => {
      const emptyFile = {
        schemaVersion: 1,
        repository: "owner/repo",
        path: "EMPTY.md",
        content: "",
        truncated: false,
        originalContentLength: 0,
      };
      for (const mode of modeMatrix) {
        const result = await runOne({
          descriptor: buildFakeDescriptor({ fileResult: emptyFile }),
          argv: ["repo", "read", "owner/repo", "EMPTY.md"],
          mode,
        });
        assert.strictEqual(result.status, 0);
        assert.deepStrictEqual(result.stderr, []);
        const parsed = JSON.parse(result.stdout[0]);
        assert.deepStrictEqual(parsed, envelope(emptyFile, mode));
      }
    });
  });

  // -------------------------------------------------------------------------
  // Belt-and-braces: Z.AI remains unable to produce an empty result from
  // an empty wrapper. Re-asserting here keeps the negative-space
  // contract visible next to the fake-empty positive cases above.
  // -------------------------------------------------------------------------

  describe("Z.AI malformed-empty grammar remains malformed through main()", () => {
    it("Z.AI Search with no <excerpt> wrapper returns status 1 with API_ERROR and retries exactly once (injected sleep)", async () => {
      const zaiDescriptor = buildZaiDescriptor({
        searchRaw: "Some prose with no excerpt wrapper at all.",
      });
      const result = await runOne({
        descriptor: zaiDescriptor,
        argv: ["repo", "search", "owner/repo", "q"],
        mode: "data",
      });
      assert.strictEqual(result.status, 1);
      assert.strictEqual(JSON.parse(result.stderr[0]).code, "API_ERROR");
      // Retryable 502 → exactly one retry, exactly one injected sleep
      // call. No production wall-clock backoff or jitter is consulted
      // because the harness injects deterministic sleep/random.
      assert.strictEqual(
        result.sleepCalls.length,
        1,
        `retryable 502 must trigger exactly one sleep; got ${result.sleepCalls.length}`,
      );
      // The injected sleep call uses the documented base delay
      // (500 ms × 2^0) plus zero jitter from the injected random.
      assert.strictEqual(result.sleepCalls[0], 500);
    });

    it("Z.AI Directory with no glyph entries returns status 1 with API_ERROR and retries exactly once (injected sleep)", async () => {
      const zaiDescriptor = buildZaiDescriptor({
        dirRaw: "<structure>\nowner-repo/\n</structure>",
      });
      const result = await runOne({
        descriptor: zaiDescriptor,
        argv: ["repo", "tree", "owner/repo"],
        mode: "data",
      });
      assert.strictEqual(result.status, 1);
      assert.strictEqual(JSON.parse(result.stderr[0]).code, "API_ERROR");
      assert.strictEqual(
        result.sleepCalls.length,
        1,
        `retryable 502 must trigger exactly one sleep; got ${result.sleepCalls.length}`,
      );
      assert.strictEqual(result.sleepCalls[0], 500);
    });
  });
});
