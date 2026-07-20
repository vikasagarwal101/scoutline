/**
 * Z.AI Repository Adapter (P6-04, DESIGN.md §18).
 *
 * Verifies the production Adapter contract for the three ZRead operations:
 * Search (`search_doc`), Read File (`read_file`), and List Directory
 * (`get_repo_structure`).
 *
 * Scope:
 *   - total parsers for the characterized `<excerpt>`, `<file_content>`,
 *     and `<structure>` wrappers, plus all malformed / mixed / encoded
 *     error branches;
 *   - encoded MCP error classification BEFORE success parsing
 *     (exhausted quota is terminal `QUOTA_ERROR`; the rest of the
 *     taxonomy uses the shared retry/terminal classification);
 *   - one credential resolution per cache identity; full SHA-256
 *     fingerprint; exact per-operation legacy candidates with the
 *     documented insertion order; legacy decoders use the production
 *     parsers;
 *   - raw invocation through public dotted tool names — the fake
 *     transport resolves each public name to the discovered internal
 *     identity;
 *   - a fresh transport per uncached attempt and exactly one
 *     best-effort close in `finally`; close failure never replaces
 *     success nor masks the primary operation failure;
 *   - no raw ZRead response types leak outside the Adapter;
 *   - descriptor metadata is unchanged — Repository is NOT advertised.
 *
 * Tests use `createZaiDescriptor` with an injected `clientFactory` so no
 * real UTCP or network is touched. Each Adapter capability is reached
 * through `adapter.repository.{search|readFile|listDirectory}`.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { buildLegacyRepositoryCacheKey } from "../dist/lib/cache.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  ScoutlineError,
  TimeoutError,
  ValidationError,
} from "../dist/lib/errors.js";
import { ZAI_REPOSITORY_CLOSE_BOUND_MS } from "../dist/providers/zai/repository.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";
import { readFixture } from "./helpers/fixtures.js";

const SEARCH_TOOL_PUBLIC_NAME = getMcpToolName("zread", "search_doc");
const FILE_TOOL_PUBLIC_NAME = getMcpToolName("zread", "read_file");
const DIRECTORY_TOOL_PUBLIC_NAME = getMcpToolName("zread", "get_repo_structure");

const INTERNAL_SEARCH_DOC = "scoutline_zai.zread.search_doc";
const INTERNAL_READ_FILE = "scoutline_zai.zread.read_file";
const INTERNAL_GET_REPO_STRUCTURE = "scoutline_zai.zread.get_repo_structure";

// ---------------------------------------------------------------------------
// Fake ZaiAdapterClientPort built on top of FakeUtcpClient so the Adapter
// exercises the same discovered-name raw invocation path the production
// ZaiMcpClient exposes (P2-03 / P6-01A fix).
// ---------------------------------------------------------------------------

function makeClientFactory({ discoveredTools, resultsByName, errorsByName } = {}) {
  const created = [];
  const factory = (options) => {
    const fake = new FakeUtcpClient({
      discoveredTools,
      resultsByName,
      errorsByName,
    });
    const port = {
      options,
      callToolCalls: [],
      async callToolRaw(name, args) {
        this.callToolCalls.push({ name, args });
        // Mirror the production ZaiMcpClient resolution path: exact
        // internal name first, then public-prefix → exactly-one
        // discovered name ending in `.<suffix>`. This isolates Adapter
        // tests from the resolution defect coverage in mcp-client tests.
        const tools = fake.discoveredTools;
        let resolved = tools.find((t) => t.name === name);
        if (!resolved && name.startsWith("scoutline.zai.")) {
          const suffix = name.slice("scoutline.zai.".length);
          const matches = tools.filter((t) => t.name.endsWith(`.${suffix}`));
          if (matches.length === 1) resolved = matches[0];
        }
        if (!resolved) {
          throw new Error(`API_ERROR: Unknown tool ${name}`);
        }
        return fake.callTool(resolved.name, args);
      },
      async listTools() {
        return fake.getTools();
      },
      async close() {
        return fake.close();
      },
    };
    created.push({ options, fake, port });
    return port;
  };
  factory.created = created;
  return factory;
}

// ---------------------------------------------------------------------------
// Discovered tool fixtures: the FakeUtcpClient only knows the internal
// sanitized identity (matching what production UTCP registers). The
// Adapter passes public dotted names; the fake resolves them through
// the public-prefix → exactly-one-internal-suffix rule.
// ---------------------------------------------------------------------------

const DISCOVERED_ZREAD_TOOLS = [
  {
    name: INTERNAL_SEARCH_DOC,
    inputs: {
      type: "object",
      properties: {
        repo_name: { type: "string" },
        query: { type: "string" },
        language: { type: "string", enum: ["zh", "en"] },
      },
      required: ["repo_name", "query"],
    },
    outputs: { type: "string" },
  },
  {
    name: INTERNAL_READ_FILE,
    inputs: {
      type: "object",
      properties: {
        repo_name: { type: "string" },
        file_path: { type: "string" },
      },
      required: ["repo_name", "file_path"],
    },
    outputs: { type: "string" },
  },
  {
    name: INTERNAL_GET_REPO_STRUCTURE,
    inputs: {
      type: "object",
      properties: {
        repo_name: { type: "string" },
        dir_path: { type: "string" },
      },
      required: ["repo_name"],
    },
    outputs: { type: "string" },
  },
];

const TEST_API_KEY = "test-zai-api-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

function withEnv(env, fn) {
  return async () => {
    const saved = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Lazy-loaded fixtures from the P6-01 directory. Each is sanitized,
// ordered, and its `raw` field carries the Provider response grammar.
// ---------------------------------------------------------------------------

let fixtures = {};

before(async () => {
  fixtures = {
    searchValid: await readFixture("providers", "zai", "repository", "search-valid.json"),
    searchMalformedWrapper: await readFixture(
      "providers",
      "zai",
      "repository",
      "search-malformed-wrapper.json",
    ),
    searchMalformedUnclosed: await readFixture(
      "providers",
      "zai",
      "repository",
      "search-malformed-unclosed.json",
    ),
    searchMixedMalformed: await readFixture(
      "providers",
      "zai",
      "repository",
      "search-mixed-malformed.json",
    ),
    fileValid: await readFixture("providers", "zai", "repository", "file-valid.json"),
    fileMalformedWrapper: await readFixture(
      "providers",
      "zai",
      "repository",
      "file-malformed-wrapper.json",
    ),
    fileMalformedUnclosed: await readFixture(
      "providers",
      "zai",
      "repository",
      "file-malformed-unclosed.json",
    ),
    fileMixedMalformed: await readFixture(
      "providers",
      "zai",
      "repository",
      "file-mixed-malformed.json",
    ),
    treeRootValid: await readFixture("providers", "zai", "repository", "tree-root-valid.json"),
    treeRootMalformed: await readFixture(
      "providers",
      "zai",
      "repository",
      "tree-root-malformed.json",
    ),
    treeNestedValid: await readFixture("providers", "zai", "repository", "tree-nested-valid.json"),
    treeNestedMalformed: await readFixture(
      "providers",
      "zai",
      "repository",
      "tree-nested-malformed.json",
    ),
    treeMixedMalformed: await readFixture(
      "providers",
      "zai",
      "repository",
      "tree-mixed-malformed.json",
    ),
    errorMcpQuota: await readFixture("providers", "zai", "repository", "error-mcp-quota.json"),
    errorMcpGeneric: await readFixture("providers", "zai", "repository", "error-mcp-generic.json"),
  };
});

// ===========================================================================
// Descriptor metadata advertises repository support (P6-06 ticket:
// register repository capability metadata). P6-04 introduced the
// Adapter handle; P6-06 flips descriptor capabilities() so Provider
// selection and Doctor inventory derive from a single source of truth.
// ===========================================================================

describe("Z.AI Repository Adapter — descriptor metadata (P6-06)", () => {
  it("capabilities() advertises 'repository-exploration'", () => {
    const descriptor = createZaiDescriptor();
    const caps = descriptor.capabilities();
    assert.ok(caps.has("repository-exploration"), "Repository must be advertised after P6-06");
  });

  it("descriptor creation is side-effect-free (no transport, no I/O)", async () => {
    const factory = makeClientFactory();
    const d = createZaiDescriptor({ clientFactory: factory });
    d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    assert.strictEqual(factory.created.length, 0);
  });

  it("create() constructs and attaches a Repository Capability handle", () => {
    const factory = makeClientFactory();
    const d = createZaiDescriptor({ clientFactory: factory });
    const adapter = d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    assert.ok(adapter.repository, "Adapter must expose a repository handle");
    assert.ok(adapter.repository.search);
    assert.ok(adapter.repository.readFile);
    assert.ok(adapter.repository.listDirectory);
  });
});

// ===========================================================================
// Search — total parser over `<excerpt>` blocks.
// ===========================================================================

describe("Z.AI Repository Adapter — Search parser", () => {
  function makeAdapter(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, capability: adapter.repository.search };
  }

  it("preserves ordered excerpt inner text verbatim for a valid fixture", async () => {
    const { capability } = makeAdapter(fixtures.searchValid.raw);
    const out = await capability.invoke({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    });
    assert.strictEqual(out.schemaVersion, 1);
    assert.strictEqual(out.repository, "facebook/react");
    assert.strictEqual(out.query, "useState");
    assert.strictEqual(out.language, "en");
    assert.strictEqual(out.excerpts.length, 3, "fixture has exactly three excerpts");
    // Inner text including Markdown/code/HTML-like markup is preserved.
    assert.match(out.excerpts[0].text, /useState/);
    assert.match(out.excerpts[0].text, /Hooks reference/);
    assert.match(out.excerpts[1].text, /batching/);
    assert.match(out.excerpts[2].text, /Plain prose excerpt/);
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(typeof out.originalTextLength, "number");
  });

  it("requires at least one well-formed <excerpt> wrapper; no-wrapper is malformed", async () => {
    const { capability } = makeAdapter(fixtures.searchMalformedWrapper.raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects an unbalanced <excerpt> framing", async () => {
    const { capability } = makeAdapter(fixtures.searchMalformedUnclosed.raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a mixed response (valid excerpt + unmatched opening tag)", async () => {
    const { capability } = makeAdapter(fixtures.searchMixedMalformed.raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a non-string Provider response", async () => {
    const { capability } = makeAdapter({ not: "a string" });
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  // P6-04A framing hardening: equal tag counts must not admit nested,
  // reversed, or stray `<excerpt>` framing. The state-machine parser
  // walks tokens in source order with depth tracking.

  it("rejects nested <excerpt> framing (equal tag counts, but depth>1)", async () => {
    const raw = "<excerpt>outer<excerpt>inner</excerpt>still-outer</excerpt>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects reversed framing (stray closing before any opening)", async () => {
    const raw = "</excerpt>prefix<excerpt>body</excerpt>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a stray closing tag after a balanced block", async () => {
    const raw = "<excerpt>body</excerpt></excerpt>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects an opening followed by another opening without a close", async () => {
    const raw = "<excerpt>outer<excerpt>inner</excerpt>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a closing-only envelope with no opening", async () => {
    const raw = "trailing </excerpt>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });
});

// ===========================================================================
// File — strip the whole-response `<file_content>` wrapper.
// ===========================================================================

describe("Z.AI Repository Adapter — File parser", () => {
  function makeAdapter(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_READ_FILE]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, capability: adapter.repository.readFile };
  }

  it("strips the outer wrapper and returns the body for a valid fixture", async () => {
    const { capability } = makeAdapter(fixtures.fileValid.raw);
    const out = await capability.invoke({
      repository: "facebook/react",
      path: "README.md",
    });
    assert.strictEqual(out.schemaVersion, 1);
    assert.strictEqual(out.repository, "facebook/react");
    assert.strictEqual(out.path, "README.md");
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(typeof out.originalContentLength, "number");
    // Wrapper is discarded; body content is preserved.
    assert.ok(!out.content.includes("<file_content>"));
    assert.ok(!out.content.includes("</file_content>"));
    assert.match(out.content, /Project README/);
    assert.match(out.content, /Installation/);
    assert.match(out.content, /LICENSE/);
  });

  it("rejects a missing wrapper", async () => {
    const { capability } = makeAdapter(fixtures.fileMalformedWrapper.raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "README.md" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects an unclosed wrapper", async () => {
    const { capability } = makeAdapter(fixtures.fileMalformedUnclosed.raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "README.md" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a mixed response (surrounding/trailing prose)", async () => {
    const { capability } = makeAdapter(fixtures.fileMixedMalformed.raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "README.md" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a non-string Provider response", async () => {
    const { capability } = makeAdapter({ content: "x" });
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "README.md" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  // P6-04B: exactly one outer wrapper pair. Duplicate or nested
  // `<file_content>` framing is malformed, not content data.

  it("rejects a duplicate <file_content> wrapper (P6-04B)", async () => {
    const raw = "<file_content>hello</file_content><file_content>world</file_content>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "README.md" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a nested <file_content> wrapper (P6-04B)", async () => {
    const raw = "<file_content>outer<file_content>inner</file_content></file_content>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "README.md" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a stray closing </file_content> tag (P6-04B)", async () => {
    const raw = "<file_content>hello</file_content></file_content>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "README.md" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });
});

// ===========================================================================
// Directory — strip `<structure>` framing; emit immediate entries;
// trailing '/' marks a directory.
// ===========================================================================

describe("Z.AI Repository Adapter — Directory parser", () => {
  function makeAdapter(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_GET_REPO_STRUCTURE]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, capability: adapter.repository.listDirectory };
  }

  it("parses a root listing into immediate entries with sibling order", async () => {
    const { capability } = makeAdapter(fixtures.treeRootValid.raw);
    const out = await capability.invoke({ repository: "facebook/react", path: "" });
    assert.strictEqual(out.repository, "facebook/react");
    assert.strictEqual(out.path, "");
    assert.strictEqual(out.entries.length, 7, "fixture has 7 immediate entries");
    // Sibling order is preserved verbatim.
    assert.deepStrictEqual(
      out.entries.map((e) => e.name),
      ["LICENSE", "README.md", "packages", "public", "src", "tests", "yarn.lock"],
    );
    assert.deepStrictEqual(
      out.entries.map((e) => e.kind),
      ["file", "file", "directory", "directory", "directory", "directory", "file"],
    );
    // Root listings project the entry name unchanged as the path.
    assert.deepStrictEqual(
      out.entries.map((e) => e.path),
      ["LICENSE", "README.md", "packages", "public", "src", "tests", "yarn.lock"],
    );
  });

  it("parses a nested listing into repository-relative child paths (P6-04A)", async () => {
    const { capability } = makeAdapter(fixtures.treeNestedValid.raw);
    const out = await capability.invoke({
      repository: "facebook/react",
      path: "packages",
    });
    assert.strictEqual(out.path, "packages");
    assert.strictEqual(out.entries.length, 4);
    assert.deepStrictEqual(
      out.entries.map((e) => e.name),
      ["react", "react-dom", "react-reconciler", "shared"],
    );
    // Per P6-04A: child path is `<listing.path>/<entry.name>`.
    assert.deepStrictEqual(
      out.entries.map((e) => e.path),
      ["packages/react", "packages/react-dom", "packages/react-reconciler", "packages/shared"],
    );
    assert.ok(out.entries.every((e) => e.kind === "directory"));
  });

  it("deeply nested listings project each child as <listing.path>/<name>", async () => {
    // Synthetic fixture: a listing at packages/react with two children.
    const raw = "<structure>\nfacebook-react/\n├── src/\n└── tests/\n</structure>";
    const { capability } = makeAdapter(raw);
    const out = await capability.invoke({
      repository: "facebook/react",
      path: "packages/react",
    });
    assert.strictEqual(out.entries.length, 2);
    assert.deepStrictEqual(
      out.entries.map((e) => e.name),
      ["src", "tests"],
    );
    assert.deepStrictEqual(
      out.entries.map((e) => e.path),
      ["packages/react/src", "packages/react/tests"],
    );
  });

  it("rejects a malformed root listing (no glyphs inside the wrapper)", async () => {
    const { capability } = makeAdapter(fixtures.treeRootMalformed.raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a malformed nested listing (wrapper missing)", async () => {
    const { capability } = makeAdapter(fixtures.treeNestedMalformed.raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "packages" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a mixed listing (valid entry + glyph-less sibling)", async () => {
    const { capability } = makeAdapter(fixtures.treeMixedMalformed.raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a non-string Provider response", async () => {
    const { capability } = makeAdapter([{ name: "x" }]);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  // P6-04B: well-formed nested Unicode tree lines (descendants with
  // `│`/space indentation + branch glyph) are accepted and silently
  // ignored — only level-0 immediate entries are emitted, in Provider
  // order.

  it("accepts nested descendants and emits only level-0 immediate entries (P6-04B)", async () => {
    const raw = [
      "<structure>",
      "facebook-react/",
      "├── packages/",
      "│   ├── react/",
      "│   └── react-dom/",
      "├── src/",
      "│   ├── index.js",
      "│   └── utils.js",
      "└── README.md",
      "</structure>",
    ].join("\n");
    const { capability } = makeAdapter(raw);
    const out = await capability.invoke({ repository: "facebook/react", path: "" });
    // Only the three level-0 immediate entries are emitted.
    assert.deepStrictEqual(
      out.entries.map((e) => e.name),
      ["packages", "src", "README.md"],
    );
    assert.deepStrictEqual(
      out.entries.map((e) => e.kind),
      ["directory", "directory", "file"],
    );
    // Root listing projects names unchanged as paths.
    assert.deepStrictEqual(
      out.entries.map((e) => e.path),
      ["packages", "src", "README.md"],
    );
  });

  it("accepts descendants under a last-child blank-column ancestor (P6-04B)", async () => {
    // When the parent is the last child (└──), its descendants use
    // space-only indentation (no `│`). These must still be skipped.
    const raw = [
      "<structure>",
      "facebook-react/",
      "├── packages/",
      "│   └── shared/",
      "│       ├── constants.js",
      "│       └── types.ts",
      "└── src/",
      "    ├── index.js",
      "    └── utils.js",
      "</structure>",
    ].join("\n");
    const { capability } = makeAdapter(raw);
    const out = await capability.invoke({ repository: "facebook/react", path: "" });
    assert.deepStrictEqual(
      out.entries.map((e) => e.name),
      ["packages", "src"],
    );
    assert.ok(out.entries.every((e) => e.kind === "directory"));
  });

  it("rejects a glyph-less descendant line among valid nested entries (P6-04B)", async () => {
    // A line with `│` indentation but no branch glyph is malformed.
    const raw = [
      "<structure>",
      "facebook-react/",
      "├── packages/",
      "│   react-without-glyph/",
      "│   ├── react/",
      "└── README.md",
      "</structure>",
    ].join("\n");
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a duplicate <structure> wrapper (P6-04B)", async () => {
    const raw =
      "<structure>\nfacebook-react/\n├── src/\n</structure>\n<structure>\n├── x/\n</structure>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a nested <structure> wrapper (P6-04B)", async () => {
    const raw = "<structure>\nfacebook-react/\n<structure>\n├── src/\n</structure>\n</structure>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  // P6-04C: strict descendant indentation validation. A valid
  // descendant requires exact four-column indentation groups
  // (`│   ` pipe+3spaces or `    ` 4 spaces), then glyph + separator
  // + non-empty name. Arbitrary prefixes, misaligned indentation,
  // and empty descendant names are rejected. The first non-blank
  // line must be a glyph-less root label.

  it("rejects a glyph-bearing first line (missing root label) (P6-04C)", async () => {
    // No root label — the first non-blank line is a glyph-bearing
    // entry, which is not a valid root label.
    const raw = "<structure>\n├── src/\n├── tests/\n</structure>";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects an arbitrary-prefix glyph-bearing line (P6-04C)", async () => {
    // `garbage├── child` contains a glyph but the prefix is not a
    // valid indentation group.
    const raw = [
      "<structure>",
      "facebook-react/",
      "├── src/",
      "garbage├── child",
      "└── README.md",
      "</structure>",
    ].join("\n");
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a misaligned pipe prefix (2 spaces instead of 3) (P6-04C)", async () => {
    // `│  ├──` uses pipe + 2 spaces (3 chars), not the required
    // `│   ` (pipe + 3 spaces = 4 chars).
    const raw = [
      "<structure>",
      "facebook-react/",
      "├── src/",
      "│  ├── misaligned.js",
      "└── README.md",
      "</structure>",
    ].join("\n");
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a single-space prefix before glyph (P6-04C)", async () => {
    // ` ├──` has only 1 space — not a valid 4-column group.
    const raw = [
      "<structure>",
      "facebook-react/",
      "├── src/",
      " ├── bad.js",
      "└── README.md",
      "</structure>",
    ].join("\n");
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a descendant with an empty name (P6-04C)", async () => {
    // Valid indentation `│   ├── ` but no name after the separator.
    const raw = [
      "<structure>",
      "facebook-react/",
      "├── src/",
      "│   ├── ",
      "└── README.md",
      "</structure>",
    ].join("\n");
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ repository: "facebook/react", path: "" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("retains valid pipe-indented and blank-column descendants after strict validation (P6-04C regression)", async () => {
    // Ensures the stricter descendantRe does not reject previously
    // valid descendants. Deep nesting with mixed pipe/space groups.
    const raw = [
      "<structure>",
      "facebook-react/",
      "├── packages/",
      "│   ├── react/",
      "│   │   ├── src/",
      "│   │   └── tests/",
      "│   └── shared/",
      "│       ├── constants.js",
      "│       └── types.ts",
      "└── src/",
      "    ├── index.js",
      "    └── utils.js",
      "</structure>",
    ].join("\n");
    const { capability } = makeAdapter(raw);
    const out = await capability.invoke({ repository: "facebook/react", path: "" });
    assert.deepStrictEqual(
      out.entries.map((e) => e.name),
      ["packages", "src"],
    );
    assert.ok(out.entries.every((e) => e.kind === "directory"));
  });
});

// ===========================================================================
// Encoded MCP error classification BEFORE success parsing.
// ===========================================================================

describe("Z.AI Repository Adapter — encoded MCP error classification", () => {
  function makeAdapter(toolName, internalName, raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [internalName]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    let capability;
    if (toolName === SEARCH_TOOL_PUBLIC_NAME) capability = adapter.repository.search;
    else if (toolName === FILE_TOOL_PUBLIC_NAME) capability = adapter.repository.readFile;
    else capability = adapter.repository.listDirectory;
    return { factory, capability };
  }

  it("1310/exhausted quota becomes terminal QuotaError with status 429", async () => {
    const { capability } = makeAdapter(
      SEARCH_TOOL_PUBLIC_NAME,
      INTERNAL_SEARCH_DOC,
      fixtures.errorMcpQuota.raw,
    );
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof QuotaError, `expected QuotaError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, "QUOTA_ERROR");
        assert.strictEqual(err.statusCode, 429);
        assert.strictEqual(err.retryable, false, "QuotaError is terminal");
        // Sanitized message — no raw Provider body, no envelope text.
        assert.ok(!err.message.includes("1310"));
        assert.ok(!err.message.includes("Weekly/Monthly Limit Exhausted"));
        assert.ok(!err.message.includes("reset"));
        return true;
      },
    );
  });

  it("encoded quota error is normalized for File and Directory too", async () => {
    // File branch
    {
      const fileAdapter = makeAdapter(
        FILE_TOOL_PUBLIC_NAME,
        INTERNAL_READ_FILE,
        fixtures.errorMcpQuota.raw,
      );
      await assert.rejects(
        fileAdapter.capability.invoke({
          repository: "facebook/react",
          path: "README.md",
        }),
        (err) => err instanceof QuotaError,
      );
    }
    // Directory branch
    {
      const dirAdapter = makeAdapter(
        DIRECTORY_TOOL_PUBLIC_NAME,
        INTERNAL_GET_REPO_STRUCTURE,
        fixtures.errorMcpQuota.raw,
      );
      await assert.rejects(
        dirAdapter.capability.invoke({
          repository: "facebook/react",
          path: "",
        }),
        (err) => err instanceof QuotaError,
      );
    }
  });

  it("generic 5xx encoded error is retryable ApiError 500", async () => {
    const { capability } = makeAdapter(
      SEARCH_TOOL_PUBLIC_NAME,
      INTERNAL_SEARCH_DOC,
      fixtures.errorMcpGeneric.raw,
    );
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.strictEqual(err.statusCode, 500);
        assert.ok(err.message !== fixtures.errorMcpGeneric.raw);
        return true;
      },
    );
  });

  it("401 encoded error maps to terminal AuthError with exact status 401", async () => {
    const raw = "MCP error -401\nerror.code: 401\nerror.message: unauthorized\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof AuthError, `expected AuthError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, "AUTH_ERROR");
        assert.strictEqual(err.statusCode, 401, "exact 401 status preserved");
        assert.strictEqual(err.retryable, false);
        // No raw Provider body / message / help leaks.
        assert.ok(!err.message.includes("unauthorized"));
        return true;
      },
    );
  });

  it("403 encoded error maps to terminal AUTH_ERROR with exact status 403 (P6-04A)", async () => {
    const raw = "MCP error -403\nerror.code: 403\nerror.message: forbidden\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.strictEqual(err.code, "AUTH_ERROR");
        assert.strictEqual(
          err.statusCode,
          403,
          "exact 403 status preserved (must NOT collapse to 401)",
        );
        assert.strictEqual(err.retryable, false, "AUTH_ERROR is terminal");
        // Sanitized: no raw Provider body, message, or help text leaks.
        assert.ok(!err.message.includes("forbidden"));
        return true;
      },
    );
  });

  it("encoded errors are normalized for all three operations", async () => {
    const raw401 = "MCP error -401\nerror.code: 401\nerror.message: unauthorized\n";
    const scenarios = [
      [
        SEARCH_TOOL_PUBLIC_NAME,
        INTERNAL_SEARCH_DOC,
        () =>
          makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw401).capability.invoke({
            repository: "facebook/react",
            query: "x",
            language: "en",
          }),
      ],
      [
        FILE_TOOL_PUBLIC_NAME,
        INTERNAL_READ_FILE,
        () =>
          makeAdapter(FILE_TOOL_PUBLIC_NAME, INTERNAL_READ_FILE, raw401).capability.invoke({
            repository: "facebook/react",
            path: "README.md",
          }),
      ],
      [
        DIRECTORY_TOOL_PUBLIC_NAME,
        INTERNAL_GET_REPO_STRUCTURE,
        () =>
          makeAdapter(
            DIRECTORY_TOOL_PUBLIC_NAME,
            INTERNAL_GET_REPO_STRUCTURE,
            raw401,
          ).capability.invoke({ repository: "facebook/react", path: "" }),
      ],
    ];
    for (const [, , invoke] of scenarios) {
      await assert.rejects(invoke(), (err) => err instanceof AuthError);
    }
  });

  it("encoded error message is sanitized (raw text never reaches outward field)", async () => {
    const raw = fixtures.errorMcpQuota.raw;
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    let captured;
    try {
      await capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      });
    } catch (err) {
      captured = err;
    }
    const serialized = `${captured.message} ${captured.help ?? ""}`;
    assert.ok(!serialized.includes("1310"), `code leaked: ${serialized}`);
    assert.ok(!serialized.includes("Weekly/Monthly Limit Exhausted"));
    assert.ok(!serialized.includes("reset:"));
  });

  // P6-04A: QuotaError must trigger on code 1310 OR explicit exhausted
  // message regardless of the encoded status line.

  it("code 1310 under a non-429 status still becomes terminal QuotaError", async () => {
    const raw = "MCP error -500\nerror.code: 1310\nerror.message: weekly limit exhausted\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof QuotaError, `expected QuotaError, got ${err.constructor.name}`);
        assert.strictEqual(err.statusCode, 429);
        assert.strictEqual(err.code, "QUOTA_ERROR");
        assert.strictEqual(err.retryable, false, "QuotaError is terminal");
        return true;
      },
    );
  });

  it("explicit exhausted message under a non-429 status becomes terminal QuotaError", async () => {
    const raw = "MCP error -503\nerror.code: 9999\nerror.message: Quota has been exhausted\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof QuotaError,
    );
  });

  it("a 4xx other than 401/403 without quota signal is terminal ApiError", async () => {
    const raw = "MCP error -404\nerror.code: 404\nerror.message: not found\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof ApiError, `expected ApiError, got ${err.constructor.name}`);
        assert.strictEqual(err.statusCode, 404);
        assert.ok(!err.message.includes("not found"));
        return true;
      },
    );
  });

  it("a 429 without quota signal is retryable ApiError 429", async () => {
    const raw = "MCP error -429\nerror.code: 9998\nerror.message: rate limited\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof ApiError, `expected ApiError, got ${err.constructor.name}`);
        assert.strictEqual(err.statusCode, 429);
        assert.strictEqual(err.code, "API_ERROR");
        // 429 is in the shared retry taxonomy (429 plus any 5xx).
        assert.ok(
          err.statusCode === 429 || (err.statusCode >= 500 && err.statusCode <= 599),
          `${err.statusCode} must fall in the retryable set`,
        );
        return true;
      },
    );
  });

  // P6-04B: explicit exhausted-limit phrases ("limit reached",
  // "limit exceeded") map to terminal QuotaError even without the
  // word "quota" or code 1310. A transient "rate limited" 429 must
  // remain retryable ApiError 429 (retained above).

  it("'Monthly limit reached' becomes terminal QuotaError regardless of status (P6-04B)", async () => {
    const raw = "MCP error -503\nerror.code: 9999\nerror.message: Monthly limit reached\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof QuotaError, `expected QuotaError, got ${err.constructor.name}`);
        assert.strictEqual(err.statusCode, 429);
        assert.strictEqual(err.code, "QUOTA_ERROR");
        assert.strictEqual(err.retryable, false);
        return true;
      },
    );
  });

  it("'usage limit exceeded' becomes terminal QuotaError regardless of status (P6-04B)", async () => {
    const raw = "MCP error -500\nerror.code: 8888\nerror.message: usage limit exceeded\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof QuotaError, `expected QuotaError, got ${err.constructor.name}`);
        assert.strictEqual(err.statusCode, 429);
        assert.strictEqual(err.retryable, false);
        return true;
      },
    );
  });

  it("'rate limited' 429 stays retryable ApiError 429 (P6-04B regression)", async () => {
    // Bare "limit" in "rate limited" must NOT trigger QuotaError.
    // This is the regression guard for the P6-04B phrase refinement.
    const raw =
      "MCP error -429\nerror.code: 9998\nerror.message: too many requests, rate limited\n";
    const { capability } = makeAdapter(SEARCH_TOOL_PUBLIC_NAME, INTERNAL_SEARCH_DOC, raw);
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(err instanceof ApiError, `expected ApiError, got ${err.constructor.name}`);
        assert.strictEqual(err.statusCode, 429);
        assert.ok(!(err instanceof QuotaError), "rate limited must NOT be QuotaError");
        return true;
      },
    );
  });
});

// ===========================================================================
// Typed transport error preservation (P6-04A). `callToolRaw` already
// normalizes NetworkError/TimeoutError/AuthError at the lower client
// layer; the Adapter MUST pass them through unchanged so the retry
// classifier sees the original `code` and `statusCode`.
// ===========================================================================

describe("Z.AI Repository Adapter — typed transport error preservation", () => {
  function makeAdapter(toolName, internalName, error) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      errorsByName: { [internalName]: error },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    let capability;
    if (toolName === SEARCH_TOOL_PUBLIC_NAME) capability = adapter.repository.search;
    else if (toolName === FILE_TOOL_PUBLIC_NAME) capability = adapter.repository.readFile;
    else capability = adapter.repository.listDirectory;
    return { factory, capability };
  }

  it("NetworkError surfaces unchanged (code NETWORK_ERROR, retryable)", async () => {
    const { capability } = makeAdapter(
      SEARCH_TOOL_PUBLIC_NAME,
      INTERNAL_SEARCH_DOC,
      new NetworkError("ECONNRESET"),
    );
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(
          err instanceof NetworkError,
          `expected NetworkError, got ${err.constructor.name}`,
        );
        assert.strictEqual(err.code, "NETWORK_ERROR");
        return true;
      },
    );
  });

  it("TimeoutError surfaces with original duration preserved", async () => {
    const originalDuration = 12345;
    const { capability } = makeAdapter(
      SEARCH_TOOL_PUBLIC_NAME,
      INTERNAL_SEARCH_DOC,
      new TimeoutError(originalDuration),
    );
    await assert.rejects(
      capability.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
      (err) => {
        assert.ok(
          err instanceof TimeoutError,
          `expected TimeoutError, got ${err.constructor.name}`,
        );
        assert.strictEqual(err.code, "TIMEOUT_ERROR");
        assert.strictEqual(err.durationMs, originalDuration);
        return true;
      },
    );
  });
});

// ===========================================================================
// Validation — runs before any client construction.
// ===========================================================================

describe("Z.AI Repository Adapter — validation", () => {
  function makeAdapter() {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, adapter };
  }

  it("Search rejects a query without non-whitespace before any client construction", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(
      adapter.repository.search.invoke({
        repository: "facebook/react",
        query: "   ",
        language: "en",
      }),
      (err) => {
        // P6-04A: request validation throws ValidationError, not the
        // retryable ApiError 502 reserved for parser/envelope failures.
        assert.ok(
          err instanceof ValidationError,
          `expected ValidationError, got ${err.constructor.name}`,
        );
        assert.strictEqual(err.code, "VALIDATION_ERROR");
        assert.strictEqual(err.statusCode, 400);
        assert.strictEqual(err.retryable, false);
        return true;
      },
    );
    assert.strictEqual(factory.created.length, 0);
  });

  it("Search rejects a non-string query", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(
      adapter.repository.search.invoke({
        repository: "facebook/react",
        query: 42,
        language: "en",
      }),
      (err) => err instanceof ValidationError && err.statusCode === 400,
    );
    assert.strictEqual(factory.created.length, 0);
  });

  it("Search rejects a language other than 'en' or 'zh'", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(
      adapter.repository.search.invoke({
        repository: "facebook/react",
        query: "x",
        language: "fr",
      }),
      (err) => err instanceof ValidationError && err.statusCode === 400,
    );
    assert.strictEqual(factory.created.length, 0);
  });

  it("Search rejects a repository without a slash before any client construction", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(
      adapter.repository.search.invoke({
        repository: "facebook",
        query: "x",
        language: "en",
      }),
      (err) => err instanceof ValidationError && err.statusCode === 400,
    );
    assert.strictEqual(factory.created.length, 0);
  });

  it("File rejects an empty path before any client construction", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(
      adapter.repository.readFile.invoke({
        repository: "facebook/react",
        path: "",
      }),
      (err) => err instanceof ValidationError && err.statusCode === 400,
    );
    assert.strictEqual(factory.created.length, 0);
  });

  it("Directory rejects a non-string path before any client construction", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(
      adapter.repository.listDirectory.invoke({
        repository: "facebook/react",
        path: 42,
      }),
      (err) => err instanceof ValidationError && err.statusCode === 400,
    );
    assert.strictEqual(factory.created.length, 0);
  });

  it("missing credential throws ConfigurationError before any client construction", () => {
    const factory = makeClientFactory();
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({ env: {} });
    assert.throws(
      () =>
        adapter.repository.search.cacheIdentity({
          repository: "facebook/react",
          query: "x",
          language: "en",
        }),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
    assert.strictEqual(factory.created.length, 0);
  });
});

// ===========================================================================
// cacheIdentity — one credential resolution, full fingerprint, exact
// legacy candidate insertion order.
// ===========================================================================

describe("Z.AI Repository Adapter — cache identity", () => {
  function makeAdapter() {
    const factory = makeClientFactory();
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, adapter };
  }

  it("Search fingerprints the resolved credential and resolves the credential once", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.repository.search.cacheIdentity({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    });
    assert.strictEqual(identity.provider, "zai");
    assert.strictEqual(identity.capability, "repository-exploration");
    assert.strictEqual(identity.operation, "repository-search");
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.strictEqual(identity.request.repository, "facebook/react");
    assert.strictEqual(identity.request.query, "useState");
    assert.strictEqual(identity.request.language, "en");
    assert.strictEqual(identity.legacyCandidates.length, 1);
  });

  it("Search legacy key uses the exact repo_name, query, language insertion order", () => {
    const { adapter } = makeAdapter();
    const request = {
      repository: "facebook/react",
      query: "useState",
      language: "zh",
    };
    const identity = adapter.repository.search.cacheIdentity(request);
    const expected = buildLegacyRepositoryCacheKey(TEST_API_KEY, SEARCH_TOOL_PUBLIC_NAME, {
      repo_name: request.repository,
      query: request.query,
      language: request.language,
    });
    assert.strictEqual(identity.legacyCandidates[0].key, expected);
  });

  it("Search legacy decoder decodes a valid raw response through the production parser", async () => {
    const { adapter } = makeAdapter();
    const request = {
      repository: "facebook/react",
      query: "useState",
      language: "en",
    };
    const identity = adapter.repository.search.cacheIdentity(request);
    const decoded = identity.legacyCandidates[0].decode(fixtures.searchValid.raw);
    assert.ok(decoded);
    assert.strictEqual(decoded.repository, "facebook/react");
    assert.strictEqual(decoded.query, "useState");
    assert.strictEqual(decoded.excerpts.length, 3);
  });

  it("Search legacy decoder returns null on malformed raw response", () => {
    const { adapter } = makeAdapter();
    const request = {
      repository: "facebook/react",
      query: "useState",
      language: "en",
    };
    const identity = adapter.repository.search.cacheIdentity(request);
    assert.strictEqual(
      identity.legacyCandidates[0].decode(fixtures.searchMalformedWrapper.raw),
      null,
    );
    assert.strictEqual(identity.legacyCandidates[0].decode(fixtures.errorMcpQuota.raw), null);
    assert.strictEqual(identity.legacyCandidates[0].decode(null), null);
    assert.strictEqual(identity.legacyCandidates[0].decode(42), null);
  });

  it("File legacy key uses the exact repo_name, file_path insertion order", () => {
    const { adapter } = makeAdapter();
    const request = { repository: "facebook/react", path: "packages/react/index.js" };
    const identity = adapter.repository.readFile.cacheIdentity(request);
    const expected = buildLegacyRepositoryCacheKey(TEST_API_KEY, FILE_TOOL_PUBLIC_NAME, {
      repo_name: request.repository,
      file_path: request.path,
    });
    assert.strictEqual(identity.legacyCandidates[0].key, expected);
  });

  it("Directory root uses only repo_name in legacy args", () => {
    const { adapter } = makeAdapter();
    const request = { repository: "facebook/react", path: "" };
    const identity = adapter.repository.listDirectory.cacheIdentity(request);
    const expected = buildLegacyRepositoryCacheKey(TEST_API_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: request.repository,
    });
    assert.strictEqual(identity.legacyCandidates[0].key, expected);
  });

  it("Directory non-root uses repo_name then dir_path in legacy args", () => {
    const { adapter } = makeAdapter();
    const request = { repository: "facebook/react", path: "packages" };
    const identity = adapter.repository.listDirectory.cacheIdentity(request);
    const expected = buildLegacyRepositoryCacheKey(TEST_API_KEY, DIRECTORY_TOOL_PUBLIC_NAME, {
      repo_name: request.repository,
      dir_path: request.path,
    });
    assert.strictEqual(identity.legacyCandidates[0].key, expected);
  });

  it("injected credential wins over conflicting ambient env (fingerprint proof)", () => {
    const ambient = "ambient-zai-api-key";
    const ambientFp = crypto.createHash("sha256").update(ambient).digest("hex");
    const d = createZaiDescriptor();
    const adapter = d.create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    const identity = adapter.repository.search.cacheIdentity({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    });
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.notStrictEqual(identity.credentialFingerprint, ambientFp);
  });

  it("ZAI_API_KEY alias resolves when only the alias is set", () => {
    const aliasFp = crypto.createHash("sha256").update("alias-key").digest("hex");
    const d = createZaiDescriptor();
    const adapter = d.create({ env: { ZAI_API_KEY: "alias-key" } });
    const identity = adapter.repository.search.cacheIdentity({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    });
    assert.strictEqual(identity.credentialFingerprint, aliasFp);
  });

  it("Z_AI_API_KEY takes precedence over ZAI_API_KEY (fingerprint proof)", () => {
    const primaryFp = crypto.createHash("sha256").update("primary-key").digest("hex");
    const d = createZaiDescriptor();
    const adapter = d.create({
      env: { Z_AI_API_KEY: "primary-key", ZAI_API_KEY: "alias-key" },
    });
    const identity = adapter.repository.search.cacheIdentity({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    });
    assert.strictEqual(identity.credentialFingerprint, primaryFp);
  });

  it("candidate construction does not read ambient process.env (no leakage)", () => {
    // The Adapter must produce the same legacy keys regardless of any
    // ambient process.env state. We confirm by clearing ZAI_CACHE_DIR /
    // XDG_CACHE_HOME / Z_AI_API_KEY / ZAI_API_KEY and asserting the
    // legacy key is still produced from the injected env only.
    const env = withEnv(
      {
        ZAI_CACHE_DIR: "/tmp/some-leaky-cache",
        XDG_CACHE_HOME: "/tmp/some-leaky-xdg",
        Z_AI_API_KEY: "ambient-zai-leak",
        ZAI_API_KEY: "ambient-zai-alias-leak",
      },
      () => {
        const d = createZaiDescriptor();
        const adapter = d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
        const identity = adapter.repository.search.cacheIdentity({
          repository: "facebook/react",
          query: "useState",
          language: "en",
        });
        const expected = buildLegacyRepositoryCacheKey(TEST_API_KEY, SEARCH_TOOL_PUBLIC_NAME, {
          repo_name: "facebook/react",
          query: "useState",
          language: "en",
        });
        assert.strictEqual(identity.legacyCandidates[0].key, expected);
      },
    );
    return env();
  });

  it("all three operations carry the same fingerprint from the same credential", () => {
    const d = createZaiDescriptor();
    const adapter = d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const searchFp = adapter.repository.search.cacheIdentity({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    }).credentialFingerprint;
    const fileFp = adapter.repository.readFile.cacheIdentity({
      repository: "facebook/react",
      path: "README.md",
    }).credentialFingerprint;
    const dirFp = adapter.repository.listDirectory.cacheIdentity({
      repository: "facebook/react",
      path: "",
    }).credentialFingerprint;
    assert.strictEqual(searchFp, fileFp);
    assert.strictEqual(searchFp, dirFp);
    assert.strictEqual(searchFp, EXPECTED_FINGERPRINT);
  });
});

// ===========================================================================
// Invocation — raw public dotted name; fresh client per attempt; close
// exactly once; success / primary failure precedence over close.
// ===========================================================================

describe("Z.AI Repository Adapter — invoke lifecycle", () => {
  function makeAdapter(tool, internal, raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [internal]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, adapter };
  }

  it("invokes through the public dotted tool name; client resolves it internally", async () => {
    const { factory, adapter } = makeAdapter(
      SEARCH_TOOL_PUBLIC_NAME,
      INTERNAL_SEARCH_DOC,
      fixtures.searchValid.raw,
    );
    await adapter.repository.search.invoke({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    });
    const port = factory.created[0].port;
    assert.strictEqual(port.callToolCalls.length, 1);
    assert.strictEqual(port.callToolCalls[0].name, SEARCH_TOOL_PUBLIC_NAME);
    assert.strictEqual(port.callToolCalls[0].args.repo_name, "facebook/react");
    assert.strictEqual(port.callToolCalls[0].args.query, "useState");
    assert.strictEqual(port.callToolCalls[0].args.language, "en");
  });

  it("File invoke sends repo_name and file_path; client disables cache and retry", async () => {
    const { factory, adapter } = makeAdapter(
      FILE_TOOL_PUBLIC_NAME,
      INTERNAL_READ_FILE,
      fixtures.fileValid.raw,
    );
    await adapter.repository.readFile.invoke({
      repository: "facebook/react",
      path: "README.md",
    });
    const port = factory.created[0].port;
    assert.strictEqual(port.options.noCache, true);
    assert.strictEqual(port.options.disableRetry, true);
    assert.strictEqual(port.callToolCalls[0].name, FILE_TOOL_PUBLIC_NAME);
    assert.strictEqual(port.callToolCalls[0].args.repo_name, "facebook/react");
    assert.strictEqual(port.callToolCalls[0].args.file_path, "README.md");
  });

  it("Directory root invoke sends only repo_name; non-root adds dir_path", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_GET_REPO_STRUCTURE]: fixtures.treeRootValid.raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    await adapter.repository.listDirectory.invoke({
      repository: "facebook/react",
      path: "",
    });
    assert.deepStrictEqual(factory.created[0].port.callToolCalls[0].args, {
      repo_name: "facebook/react",
    });

    await adapter.repository.listDirectory.invoke({
      repository: "facebook/react",
      path: "packages",
    });
    const second = factory.created[1].port.callToolCalls[0].args;
    assert.deepStrictEqual(second, { repo_name: "facebook/react", dir_path: "packages" });
  });

  it("constructs a fresh client per invoke and disables cache + retry", async () => {
    const { factory, adapter } = makeAdapter(
      SEARCH_TOOL_PUBLIC_NAME,
      INTERNAL_SEARCH_DOC,
      fixtures.searchValid.raw,
    );
    await adapter.repository.search.invoke({
      repository: "facebook/react",
      query: "x",
      language: "en",
    });
    await adapter.repository.search.invoke({
      repository: "facebook/react",
      query: "y",
      language: "en",
    });
    assert.strictEqual(factory.created.length, 2, "exactly one fresh client per invoke");
    for (const { port } of factory.created) {
      assert.strictEqual(port.options.noCache, true);
      assert.strictEqual(port.options.disableRetry, true);
    }
  });

  it("closes the client exactly once on success", async () => {
    const { factory, adapter } = makeAdapter(
      SEARCH_TOOL_PUBLIC_NAME,
      INTERNAL_SEARCH_DOC,
      fixtures.searchValid.raw,
    );
    await adapter.repository.search.invoke({
      repository: "facebook/react",
      query: "x",
      language: "en",
    });
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });

  it("closes the client exactly once on primary failure", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      errorsByName: { [INTERNAL_SEARCH_DOC]: new Error("HTTP 500 internal") },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    await assert.rejects(
      adapter.repository.search.invoke({
        repository: "facebook/react",
        query: "x",
        language: "en",
      }),
    );
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });

  it("success survives a close rejection", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: fixtures.searchValid.raw },
    });
    // Wrap the factory so the constructed port's close() rejects. The
    // Adapter must still surface the success result.
    const wrapper = (options) => {
      const port = factory(options);
      port.close = async () => {
        throw new Error("close reject");
      };
      return port;
    };
    wrapper.created = factory.created;
    const adapter = createZaiDescriptor({ clientFactory: wrapper }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    const out = await adapter.repository.search.invoke({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    });
    assert.strictEqual(out.excerpts.length, 3);
  });

  it("primary failure survives a close rejection", async () => {
    // Force a malformed Directory response (primary 502) and a close
    // rejection. The outward error must be the 502, not the close error.
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_GET_REPO_STRUCTURE]: fixtures.treeRootMalformed.raw },
    });
    const wrapper = (options) => {
      const port = factory(options);
      port.close = async () => {
        throw new Error("close reject");
      };
      return port;
    };
    wrapper.created = factory.created;
    const adapter = createZaiDescriptor({ clientFactory: wrapper }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    let captured;
    try {
      await adapter.repository.listDirectory.invoke({
        repository: "facebook/react",
        path: "",
      });
    } catch (err) {
      captured = err;
    }
    assert.ok(captured, "Adapter must surface the primary failure");
    assert.ok(captured instanceof ApiError);
    assert.strictEqual(captured.statusCode, 502);
    assert.ok(!captured.message.includes("close reject"));
  });

  it("success survives a never-resolving close (bounded close timeout)", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: fixtures.searchValid.raw },
    });
    const wrapper = (options) => {
      const port = factory(options);
      // A close that never resolves must not stall the Adapter attempt.
      port.close = () => new Promise(() => {});
      return port;
    };
    wrapper.created = factory.created;
    const adapter = createZaiDescriptor({ clientFactory: wrapper }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    // Bounded by the Adapter's internal close-timeout window. If this
    // test ever flakes or hangs, the close bound needs tightening.
    const out = await Promise.race([
      adapter.repository.search.invoke({
        repository: "facebook/react",
        query: "useState",
        language: "en",
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Adapter attempt hung on close")), 5_000),
      ),
    ]);
    assert.ok(out.excerpts.length === 3, `expected 3 excerpts, got ${out.excerpts.length}`);
  });

  // P6-04A lifecycle corrections:
  //   - the production close bound matches `ZaiMcpClient.close` at 2000 ms;
  //   - the `repositoryCloseTimeoutMs` dependency seam lets tests inject a
  //     shorter bound so the never-resolving-close path is exercised below
  //     the production default.

  it("production close bound constant is 2000 ms (matches ZaiMcpClient.close)", () => {
    assert.strictEqual(
      ZAI_REPOSITORY_CLOSE_BOUND_MS,
      2000,
      "Production close bound must match the existing ZaiMcpClient.close(timeoutMs=2000) semantic",
    );
  });

  it("a short injected close bound bounds the never-resolving close below the production default", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
      resultsByName: { [INTERNAL_SEARCH_DOC]: fixtures.searchValid.raw },
    });
    const wrapper = (options) => {
      const port = factory(options);
      // A close that never resolves must not stall the Adapter attempt.
      port.close = () => new Promise(() => {});
      return port;
    };
    wrapper.created = factory.created;
    // Inject a 50 ms close bound through the test seam exposed on
    // `ZaiAdapterDependencies`. The production default remains 2000 ms.
    const adapter = createZaiDescriptor({
      clientFactory: wrapper,
      repositoryCloseTimeoutMs: 50,
    }).create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const start = Date.now();
    const out = await adapter.repository.search.invoke({
      repository: "facebook/react",
      query: "useState",
      language: "en",
    });
    const elapsed = Date.now() - start;
    assert.strictEqual(out.excerpts.length, 3);
    // The injected 50 ms bound must keep this well under the 2000 ms
    // production default. Use a generous upper safety margin to avoid
    // CI timing flakes while still proving the short bound applied.
    assert.ok(
      elapsed < 1000,
      `injected 50 ms bound should complete well under 1 s, took ${elapsed} ms`,
    );
  });
});

// ===========================================================================
// Cache hits construct no client (P6-03 executor behavior; Adapter
// supplies a noCache:true / disableRetry:true client per attempt, and a
// cache hit short-circuits before invoke).
// ===========================================================================

describe("Z.AI Repository Adapter — cache hits construct no client", () => {
  it("a normalized cache hit on the Adapter returns without invoking", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_ZREAD_TOOLS,
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    // Hand-roll a normalized result and exercise decodeCached directly.
    const result = adapter.repository.search.decodeCached({
      schemaVersion: 1,
      repository: "facebook/react",
      query: "useState",
      language: "en",
      excerpts: [{ text: "cached" }],
      truncated: false,
      originalTextLength: 6,
    });
    assert.ok(result);
    assert.strictEqual(result.excerpts[0].text, "cached");
    assert.strictEqual(factory.created.length, 0);
  });

  it("a malformed normalized cache entry is a miss (returns null)", () => {
    const factory = makeClientFactory();
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    assert.strictEqual(adapter.repository.search.decodeCached(null), null);
    assert.strictEqual(adapter.repository.search.decodeCached({ schemaVersion: 2 }), null);
    assert.strictEqual(
      adapter.repository.search.decodeCached({ schemaVersion: 1, excerpts: "x" }),
      null,
    );
    assert.strictEqual(adapter.repository.readFile.decodeCached({ schemaVersion: 1 }), null);
    assert.strictEqual(
      adapter.repository.readFile.decodeCached({
        schemaVersion: 1,
        repository: "x",
        path: "",
        content: "x",
        truncated: false,
        originalContentLength: 1,
      }),
      null,
    );
    assert.strictEqual(
      adapter.repository.listDirectory.decodeCached({
        repository: "x",
        path: "",
        entries: [{ name: "", path: "", kind: "file" }],
      }),
      null,
    );
  });

  // P6-04A: the Adapter's `decodeCached` delegates to the shared P6-02
  // total decoders, which reject fractional length metadata via
  // `Number.isInteger`. A fractional `originalTextLength` or
  // `originalContentLength` is a cache miss, not a successful decode.

  it("fractional originalTextLength is rejected by the shared Search decoder (P6-04A)", () => {
    const factory = makeClientFactory();
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    assert.strictEqual(
      adapter.repository.search.decodeCached({
        schemaVersion: 1,
        repository: "facebook/react",
        query: "x",
        language: "en",
        excerpts: [{ text: "ok" }],
        truncated: false,
        originalTextLength: 1.5,
      }),
      null,
    );
    // Negative and non-finite values are also rejected.
    assert.strictEqual(
      adapter.repository.search.decodeCached({
        schemaVersion: 1,
        repository: "facebook/react",
        query: "x",
        language: "en",
        excerpts: [{ text: "ok" }],
        truncated: false,
        originalTextLength: -1,
      }),
      null,
    );
    assert.strictEqual(
      adapter.repository.search.decodeCached({
        schemaVersion: 1,
        repository: "facebook/react",
        query: "x",
        language: "en",
        excerpts: [{ text: "ok" }],
        truncated: false,
        originalTextLength: Infinity,
      }),
      null,
    );
  });

  it("fractional originalContentLength is rejected by the shared File decoder (P6-04A)", () => {
    const factory = makeClientFactory();
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    assert.strictEqual(
      adapter.repository.readFile.decodeCached({
        schemaVersion: 1,
        repository: "facebook/react",
        path: "README.md",
        content: "x",
        truncated: false,
        originalContentLength: 2.5,
      }),
      null,
    );
  });
});
