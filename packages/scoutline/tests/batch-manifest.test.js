import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "../dist/lib/errors.js";

/**
 * Ticket 1 — batch manifest module (`lib/batch-manifest.ts`).
 *
 * Pins the D2 strict parse (schema gate, name rules, allowlist, per-command
 * input tables, provider pins, output dirs, op-count cap, first-offender
 * errors) and the D2.8 `compileInput → argv` compiler snapshots.
 * Tests import dist/ per AGENTS.md (build before test).
 */

const D3_MESSAGE =
  "batch accepts capability operations only (search, read, research, repo, vision, crawl, map)";

const ALL_CAPS = [
  "search",
  "reader",
  "crawl",
  "map",
  "research",
  "repository-exploration",
  "vision.interpret-image",
  "vision.ui-artifact",
  "vision.extract-text",
  "vision.diagnose-error",
  "vision.diagram",
  "vision.chart",
  "vision.diff",
  "vision.video",
];

const zaiAll = {
  id: "zai",
  isConfigured: () => true,
  capabilities: () => new Set(ALL_CAPS),
  create() {
    throw new Error("create() must not be called during manifest parse");
  },
};

const minimaxPartial = {
  id: "minimax",
  isConfigured: () => true,
  capabilities: () => new Set(["search", "vision.interpret-image"]),
  create() {
    throw new Error("create() must not be called during manifest parse");
  },
};

const DEPS = {
  descriptors: [zaiAll, minimaxPartial],
  dirExists: (d) => d === "/out",
};

async function load() {
  return await import("../dist/lib/batch-manifest.js");
}

function manifest(...operations) {
  return { schemaVersion: 1, operations };
}

function op(name, command, input, extra = {}) {
  return { name, command, input, ...extra };
}

async function assertRejects(raw, message, deps = DEPS) {
  const m = await load();
  assert.throws(
    () => m.parseBatchManifest(raw, deps),
    (err) => {
      assert.ok(
        err instanceof ValidationError,
        `expected ValidationError, got ${err?.name}: ${err?.message}`,
      );
      assert.strictEqual(err.message, message);
      return true;
    },
  );
}

async function assertParses(raw, expected, deps = DEPS) {
  const m = await load();
  const parsed = m.parseBatchManifest(raw, deps);
  assert.deepStrictEqual(parsed, expected);
}

describe("batch manifest top-level validation", () => {
  it("rejects a non-object manifest (array)", async () => {
    await assertRejects([], "batch manifest must be a JSON object");
  });

  it("rejects a non-object manifest (null)", async () => {
    await assertRejects(null, "batch manifest must be a JSON object");
  });

  it("rejects a non-object manifest (string)", async () => {
    await assertRejects("nope", "batch manifest must be a JSON object");
  });

  it("rejects an unknown top-level field naming the first offender", async () => {
    await assertRejects(
      { schemaVersion: 1, priority: 5, operations: [op("s", "search", { query: "q" })] },
      'unknown manifest field "priority"',
    );
  });

  it("rejects a missing schemaVersion", async () => {
    await assertRejects(
      { operations: [op("s", "search", { query: "q" })] },
      'missing required manifest field "schemaVersion"',
    );
  });

  it("rejects schemaVersion 2", async () => {
    await assertRejects(
      { schemaVersion: 2, operations: [op("s", "search", { query: "q" })] },
      "unsupported schemaVersion 2: expected 1",
    );
  });

  it("rejects a string schemaVersion (strict equality gate)", async () => {
    await assertRejects(
      { schemaVersion: "1", operations: [op("s", "search", { query: "q" })] },
      'unsupported schemaVersion "1": expected 1',
    );
  });

  it("rejects missing operations", async () => {
    await assertRejects({ schemaVersion: 1 }, 'missing required manifest field "operations"');
  });

  it("rejects non-array operations", async () => {
    await assertRejects(
      { schemaVersion: 1, operations: "many" },
      'manifest field "operations" must be an array',
    );
  });

  it("rejects an empty operations array (cap is 1..256)", async () => {
    await assertRejects(
      { schemaVersion: 1, operations: [] },
      'manifest "operations" must contain between 1 and 256 entries',
    );
  });

  it("rejects 257 operations", async () => {
    const operations = Array.from({ length: 257 }, (_, i) => op(`op${i}`, "search", { query: "q" }));
    await assertRejects(
      { schemaVersion: 1, operations },
      'manifest "operations" must contain between 1 and 256 entries',
    );
  });
});

describe("batch manifest operation-level validation", () => {
  it("rejects a non-object operation", async () => {
    await assertRejects(manifest("not-an-op"), "operations[0] must be an object");
  });

  it("rejects an unknown operation field", async () => {
    await assertRejects(
      manifest({ name: "s", command: "search", input: { query: "q" }, priority: 1 }),
      'operations[0]: unknown field "priority"',
    );
  });

  it("rejects a missing name", async () => {
    await assertRejects(manifest({ command: "search", input: { query: "q" } }), 'operations[0]: missing required field "name"');
  });

  it("rejects a non-string name", async () => {
    await assertRejects(manifest({ name: 5, command: "search", input: { query: "q" } }), 'operations[0]: field "name" must be a string');
  });

  it("rejects a name violating the character rule", async () => {
    await assertRejects(
      manifest(op("bad name", "search", { query: "q" })),
      'operations[0]: invalid operation name "bad name" (must be 1-64 characters from letters, digits, ".", "_", "-")',
    );
  });

  it("rejects a 65-character name", async () => {
    await assertRejects(
      manifest(op("a".repeat(65), "search", { query: "q" })),
      `operations[0]: invalid operation name "${"a".repeat(65)}" (must be 1-64 characters from letters, digits, ".", "_", "-")`,
    );
  });

  it("rejects a duplicate name naming the second occurrence", async () => {
    await assertRejects(
      manifest(op("dup", "search", { query: "a" }), op("dup", "search", { query: "b" })),
      'operations[1]: duplicate operation name "dup"',
    );
  });

  it("rejects a missing command", async () => {
    await assertRejects(manifest({ name: "s", input: { query: "q" } }), 'operations[0]: missing required field "command"');
  });

  it("rejects a non-string command", async () => {
    await assertRejects(manifest({ name: "s", command: 7, input: { query: "q" } }), 'operations[0]: field "command" must be a string');
  });

  it("rejects an out-of-allowlist command with the D3 message (quota)", async () => {
    await assertRejects(manifest(op("q", "quota", {})), D3_MESSAGE);
  });

  it("rejects an out-of-allowlist command with the D3 message (batch)", async () => {
    await assertRejects(manifest(op("b", "batch", {})), D3_MESSAGE);
  });

  it("rejects an out-of-allowlist command with the D3 message (tools)", async () => {
    await assertRejects(manifest(op("t", "tools", {})), D3_MESSAGE);
  });

  it("rejects a missing input", async () => {
    await assertRejects(manifest({ name: "s", command: "search" }), 'operations[0]: missing required field "input"');
  });

  it("rejects a non-object input", async () => {
    await assertRejects(manifest(op("s", "search", "query")), 'operations[0]: field "input" must be an object');
  });

  it("reports the first offending operation", async () => {
    await assertRejects(
      manifest(op("s", "search", {}), op("r", "read", {})),
      'operations[0].input: missing required field "query"',
    );
  });

  it("rejects an unknown input field before reporting a missing required field", async () => {
    await assertRejects(
      manifest(op("s", "search", { focus: "x" })),
      'operations[0].input: unknown field "focus" for command "search"',
    );
  });
});

describe("batch manifest search input validation", () => {
  const base = { query: "q" };

  it("rejects an unknown field", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, focus: "api" })),
      'operations[0].input: unknown field "focus" for command "search"',
    );
  });

  it("rejects a wrong type on a number field", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, count: "10" })),
      'operations[0].input: field "count" must be a number',
    );
  });

  it("rejects a wrong type on a boolean field", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, noCache: "true" })),
      'operations[0].input: field "noCache" must be a boolean',
    );
  });

  it("rejects a wrong type on a string field", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, domain: 5 })),
      'operations[0].input: field "domain" must be a string',
    );
  });

  it("rejects an empty optional string", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, domain: "" })),
      'operations[0].input: field "domain" must be a non-empty string',
    );
  });

  it("rejects a bad recency enum", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, recency: "yesterday" })),
      "operations[0].input: field \"recency\" must be one of: oneDay, oneWeek, oneMonth, oneYear, noLimit",
    );
  });

  it("rejects a bad contentSize enum", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, contentSize: "low" })),
      'operations[0].input: field "contentSize" must be one of: medium, high',
    );
  });

  it("rejects a bad location enum", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, location: "eu" })),
      'operations[0].input: field "location" must be one of: cn, us',
    );
  });

  it("rejects a bad topic enum", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, topic: "sports" })),
      'operations[0].input: field "topic" must be one of: general, news, finance',
    );
  });

  it("rejects a bad type enum", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, type: "image" })),
      'operations[0].input: field "type" must be one of: video',
    );
  });

  it("rejects non-string elements in fields", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, fields: ["title", 5] })),
      'operations[0].input: field "fields" must be an array of strings',
    );
  });

  it("rejects fields when it is not an array", async () => {
    await assertRejects(
      manifest(op("s", "search", { ...base, fields: "title,link" })),
      'operations[0].input: field "fields" must be an array of strings',
    );
  });

  it("rejects a missing query", async () => {
    await assertRejects(manifest(op("s", "search", {})), 'operations[0].input: missing required field "query"');
  });

  it("rejects an empty query as missing-required", async () => {
    await assertRejects(manifest(op("s", "search", { query: "" })), 'operations[0].input: missing required field "query"');
  });

  it("rejects a non-string query", async () => {
    await assertRejects(manifest(op("s", "search", { query: 5 })), 'operations[0].input: field "query" must be a string');
  });
});

describe("batch manifest read input validation", () => {
  const base = { url: "https://example.com/a" };

  it("rejects an unknown field", async () => {
    await assertRejects(
      manifest(op("r", "read", { ...base, depth: 1 })),
      'operations[0].input: unknown field "depth" for command "read"',
    );
  });

  it("rejects a wrong type on a boolean field", async () => {
    await assertRejects(
      manifest(op("r", "read", { ...base, noImages: "yes" })),
      'operations[0].input: field "noImages" must be a boolean',
    );
  });

  it("rejects a bad format enum", async () => {
    await assertRejects(
      manifest(op("r", "read", { ...base, format: "html" })),
      'operations[0].input: field "format" must be one of: markdown, text',
    );
  });

  it("rejects a missing url", async () => {
    await assertRejects(manifest(op("r", "read", {})), 'operations[0].input: missing required field "url"');
  });

  it("rejects an empty url as missing-required", async () => {
    await assertRejects(manifest(op("r", "read", { url: "" })), 'operations[0].input: missing required field "url"');
  });
});

describe("batch manifest crawl input validation", () => {
  const base = { url: "https://example.com" };

  it("rejects an unknown field", async () => {
    await assertRejects(
      manifest(op("c", "crawl", { ...base, maxSummary: 1 })),
      'operations[0].input: unknown field "maxSummary" for command "crawl"',
    );
  });

  it("rejects a wrong type on a number field", async () => {
    await assertRejects(
      manifest(op("c", "crawl", { ...base, depth: "2" })),
      'operations[0].input: field "depth" must be a number',
    );
  });

  it("rejects a bad format enum", async () => {
    await assertRejects(
      manifest(op("c", "crawl", { ...base, format: "html" })),
      'operations[0].input: field "format" must be one of: markdown, text',
    );
  });

  it("rejects a bad contentSize enum", async () => {
    await assertRejects(
      manifest(op("c", "crawl", { ...base, contentSize: "low" })),
      'operations[0].input: field "contentSize" must be one of: medium, high',
    );
  });

  it("rejects a missing url", async () => {
    await assertRejects(manifest(op("c", "crawl", {})), 'operations[0].input: missing required field "url"');
  });

  it("rejects an empty url as missing-required", async () => {
    await assertRejects(manifest(op("c", "crawl", { url: "" })), 'operations[0].input: missing required field "url"');
  });
});

describe("batch manifest map input validation", () => {
  const base = { url: "https://example.com" };

  it("rejects an unknown field", async () => {
    await assertRejects(
      manifest(op("m", "map", { ...base, format: "text" })),
      'operations[0].input: unknown field "format" for command "map"',
    );
  });

  it("rejects a wrong type on a number field", async () => {
    await assertRejects(
      manifest(op("m", "map", { ...base, breadth: true })),
      'operations[0].input: field "breadth" must be a number',
    );
  });

  it("rejects a wrong type on a string field", async () => {
    await assertRejects(
      manifest(op("m", "map", { ...base, instructions: 5 })),
      'operations[0].input: field "instructions" must be a string',
    );
  });

  it("rejects a missing url", async () => {
    await assertRejects(manifest(op("m", "map", {})), 'operations[0].input: missing required field "url"');
  });

  it("rejects an empty url as missing-required", async () => {
    await assertRejects(manifest(op("m", "map", { url: "" })), 'operations[0].input: missing required field "url"');
  });
});

describe("batch manifest research input validation", () => {
  const base = { query: "quantum computing" };

  it("rejects an unknown field", async () => {
    await assertRejects(
      manifest(op("res", "research", { ...base, count: 5 })),
      'operations[0].input: unknown field "count" for command "research"',
    );
  });

  it("rejects a wrong type on a boolean field", async () => {
    await assertRejects(
      manifest(op("res", "research", { ...base, noCache: "true" })),
      'operations[0].input: field "noCache" must be a boolean',
    );
  });

  it("rejects a bad model enum", async () => {
    await assertRejects(
      manifest(op("res", "research", { ...base, model: "turbo" })),
      'operations[0].input: field "model" must be one of: mini, pro, auto',
    );
  });

  it("rejects a bad outputLength enum", async () => {
    await assertRejects(
      manifest(op("res", "research", { ...base, outputLength: "longer" })),
      'operations[0].input: field "outputLength" must be one of: short, standard, long',
    );
  });

  it("rejects a bad citationFormat enum", async () => {
    await assertRejects(
      manifest(op("res", "research", { ...base, citationFormat: "ieee" })),
      'operations[0].input: field "citationFormat" must be one of: numbered, mla, apa, chicago',
    );
  });

  it("rejects a missing query", async () => {
    await assertRejects(manifest(op("res", "research", {})), 'operations[0].input: missing required field "query"');
  });

  it("rejects an empty query as missing-required", async () => {
    await assertRejects(manifest(op("res", "research", { query: "" })), 'operations[0].input: missing required field "query"');
  });
});

describe("batch manifest repo input validation", () => {
  it("rejects a missing subcommand", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { repository: "owner/name" })),
      'operations[0].input: missing required field "subcommand"',
    );
  });

  it("rejects a bad subcommand enum", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "clone", repository: "owner/name" })),
      'operations[0].input: field "subcommand" must be one of: search, tree, read, brief',
    );
  });

  it("rejects a missing repository", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "tree" })),
      'operations[0].input: missing required field "repository"',
    );
  });

  it("rejects an empty repository as missing-required", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "tree", repository: "" })),
      'operations[0].input: missing required field "repository"',
    );
  });

  it("rejects repo search without query (required-for-subcommand)", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "search", repository: "owner/name" })),
      'operations[0].input: missing required field "query"',
    );
  });

  it("rejects repo read without path (required-for-subcommand)", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "read", repository: "owner/name" })),
      'operations[0].input: missing required field "path"',
    );
  });

  it("rejects query on repo tree (subcommand-scoped misuse)", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "tree", repository: "o/n", query: "x" })),
      'operations[0].input: field "query" is not valid for repo subcommand "tree"',
    );
  });

  it("rejects focus on repo search (subcommand-scoped misuse)", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "search", repository: "o/n", query: "x", focus: "api" })),
      'operations[0].input: field "focus" is not valid for repo subcommand "search"',
    );
  });

  it("rejects depth on repo search (subcommand-scoped misuse)", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "search", repository: "o/n", query: "x", depth: 2 })),
      'operations[0].input: field "depth" is not valid for repo subcommand "search"',
    );
  });

  it("rejects a bad language enum", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "search", repository: "o/n", query: "x", language: "fr" })),
      'operations[0].input: field "language" must be one of: en, zh',
    );
  });

  it("rejects a wrong type on a number field", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "read", repository: "o/n", path: "README.md", maxChars: "500" })),
      'operations[0].input: field "maxChars" must be a number',
    );
  });

  it("rejects language on tree/read/brief (the repo handler honors it for search only)", async () => {
    for (const subcommand of ["tree", "read", "brief"]) {
      const input = { subcommand, repository: "o/n" };
      if (subcommand === "read") input.path = "README.md";
      await assertRejects(
        manifest(op("repo", "repo", { ...input, language: "en" })),
        `operations[0].input: field "language" is not valid for repo subcommand "${subcommand}"`,
      );
    }
  });

  it("rejects maxChars on tree (the tree handler ignores it)", async () => {
    await assertRejects(
      manifest(op("repo", "repo", { subcommand: "tree", repository: "o/n", maxChars: 500 })),
      'operations[0].input: field "maxChars" is not valid for repo subcommand "tree"',
    );
  });

  it("accepts maxChars on search, read, and brief repo subcommands", async () => {
    const m = await load();
    const parsed = m.parseBatchManifest(
      manifest(
        op("rs", "repo", { subcommand: "search", repository: "o/n", query: "x", maxChars: 100, language: "en" }),
        op("rr", "repo", { subcommand: "read", repository: "o/n", path: "README.md", maxChars: 100 }),
        op("rb", "repo", { subcommand: "brief", repository: "o/n", maxChars: 100 }),
      ),
      DEPS,
    );
    assert.strictEqual(parsed.operations.length, 3);
    for (const operation of parsed.operations) {
      assert.strictEqual(operation.input.maxChars, 100);
    }
  });
});

describe("batch manifest vision input validation", () => {
  it("rejects a missing subcommand", async () => {
    await assertRejects(
      manifest(op("v", "vision", { source: "img.png" })),
      'operations[0].input: missing required field "subcommand"',
    );
  });

  it("rejects a bad subcommand enum", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "summarize", source: "img.png" })),
      'operations[0].input: field "subcommand" must be one of: analyze, ui-to-code, extract-text, diagnose-error, diagram, chart, diff, video',
    );
  });

  it("rejects vision without source", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "analyze" })),
      'operations[0].input: missing required field "source"',
    );
  });

  it("rejects an empty source as missing-required", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "analyze", source: "" })),
      'operations[0].input: missing required field "source"',
    );
  });

  it("rejects diff without expected", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "diff", actual: "b.png" })),
      'operations[0].input: missing required field "expected"',
    );
  });

  it("rejects diff without actual", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "diff", expected: "a.png" })),
      'operations[0].input: missing required field "actual"',
    );
  });

  it("rejects source on diff (subcommand-scoped misuse)", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "diff", expected: "a.png", actual: "b.png", source: "c.png" })),
      'operations[0].input: field "source" is not valid for vision subcommand "diff"',
    );
  });

  it("rejects expected on analyze (subcommand-scoped misuse)", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "analyze", source: "a.png", expected: "b.png" })),
      'operations[0].input: field "expected" is not valid for vision subcommand "analyze"',
    );
  });

  it("rejects language on analyze (subcommand-scoped misuse)", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "analyze", source: "a.png", language: "en" })),
      'operations[0].input: field "language" is not valid for vision subcommand "analyze"',
    );
  });

  it("rejects focus on analyze (subcommand-scoped misuse)", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "analyze", source: "a.png", focus: "trend" })),
      'operations[0].input: field "focus" is not valid for vision subcommand "analyze"',
    );
  });

  it("rejects a wrong type on a string field", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "analyze", source: "a.png", prompt: 5 })),
      'operations[0].input: field "prompt" must be a string',
    );
  });

  it("rejects a bad output enum on ui-to-code", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "ui-to-code", source: "ui.png", output: "json" })),
      'operations[0].input: field "output" must be one of: code, prompt, spec, description',
    );
  });

  it("rejects output on analyze (subcommand-scoped misuse)", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "analyze", source: "a.png", output: "code" })),
      'operations[0].input: field "output" is not valid for vision subcommand "analyze"',
    );
  });

  it("rejects an unknown field", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "analyze", source: "a.png", maxChars: 5 })),
      'operations[0].input: unknown field "maxChars" for command "vision"',
    );
  });
});

describe("batch manifest provider pin validation", () => {
  it("rejects a non-string provider", async () => {
    await assertRejects(
      manifest(op("s", "search", { query: "q" }, { provider: 5 })),
      'operations[0]: field "provider" must be a string',
    );
  });

  it("rejects a provider outside the registry", async () => {
    await assertRejects(
      manifest(op("s", "search", { query: "q" }, { provider: "notaprovider" })),
      'operations[0]: unknown provider "notaprovider". Built-in providers: zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina.',
    );
  });

  it("rejects a registry provider that is not capable (read on minimax)", async () => {
    await assertRejects(
      manifest(op("r", "read", { url: "https://x" }, { provider: "minimax" })),
      'operations[0]: provider "minimax" does not support capability "reader"',
    );
  });

  it("rejects a registry provider missing from the descriptor list", async () => {
    await assertRejects(
      manifest(op("s", "search", { query: "q" }, { provider: "brave" })),
      'operations[0]: provider "brave" does not support capability "search"',
    );
  });

  it("validates vision pins against the per-operation capability id", async () => {
    await assertRejects(
      manifest(op("v", "vision", { subcommand: "chart", source: "c.png" }, { provider: "minimax" })),
      'operations[0]: provider "minimax" does not support capability "vision.chart"',
    );
  });

  it("accepts a capable pin", async () => {
    await assertParses(
      manifest(op("v", "vision", { subcommand: "chart", source: "c.png" }, { provider: "zai" })),
      {
        schemaVersion: 1,
        operations: [
          { name: "v", command: "vision", input: { subcommand: "chart", source: "c.png" }, provider: "zai" },
        ],
      },
    );
  });
});

describe("batch manifest output validation", () => {
  it("rejects a non-string output", async () => {
    await assertRejects(
      manifest(op("s", "search", { query: "q" }, { output: 5 })),
      'operations[0]: field "output" must be a non-empty string',
    );
  });

  it("rejects an empty output", async () => {
    await assertRejects(
      manifest(op("s", "search", { query: "q" }, { output: "" })),
      'operations[0]: field "output" must be a non-empty string',
    );
  });

  it("rejects an output whose dirname does not exist", async () => {
    await assertRejects(
      manifest(op("s", "search", { query: "q" }, { output: "/nope/out.json" })),
      'operations[0]: output directory "/nope" does not exist',
    );
  });

  it("accepts an output whose dirname exists and preserves it", async () => {
    await assertParses(
      manifest(op("s", "search", { query: "q" }, { output: "/out/s.json" })),
      {
        schemaVersion: 1,
        operations: [{ name: "s", command: "search", input: { query: "q" }, output: "/out/s.json" }],
      },
    );
  });

  it("rejects duplicate output targets naming the earlier owner (review fix: no silent overwrite)", async () => {
    await assertRejects(
      manifest(
        op("first", "search", { query: "a" }, { output: "/out/same.json" }),
        op("second", "search", { query: "b" }, { output: "/out/same.json" }),
      ),
      'operations[1]: duplicate output target "/out/same.json" (already declared by operation "first")',
    );
  });

  it("rejects equivalent-but-distinct output target strings (review fix: resolve before duplicate detection)", async () => {
    // `out/a.json` vs `out/./a.json`: string-distinct, same file. The
    // D9 temp+rename write would silently let the later op overwrite
    // the earlier op's result.
    await assertRejects(
      manifest(
        op("first", "search", { query: "a" }, { output: "out/a.json" }),
        op("second", "search", { query: "b" }, { output: "out/./a.json" }),
      ),
      'operations[1]: duplicate output target "out/./a.json" (already declared by operation "first")',
      { descriptors: DEPS.descriptors, dirExists: () => true },
    );
  });

  it("rejects separator-variant output targets (out//a.json, ./out/a.json)", async () => {
    const deps = { descriptors: DEPS.descriptors, dirExists: () => true };
    await assertRejects(
      manifest(
        op("first", "search", { query: "a" }, { output: "out/a.json" }),
        op("second", "search", { query: "b" }, { output: "out//a.json" }),
      ),
      'operations[1]: duplicate output target "out//a.json" (already declared by operation "first")',
      deps,
    );
    await assertRejects(
      manifest(
        op("first", "search", { query: "a" }, { output: "out/a.json" }),
        op("second", "search", { query: "b" }, { output: "./out/a.json" }),
      ),
      'operations[1]: duplicate output target "./out/a.json" (already declared by operation "first")',
      deps,
    );
  });

  it("accepts distinct output targets across operations", async () => {
    const m = await load();
    const parsed = m.parseBatchManifest(
      manifest(
        op("first", "search", { query: "a" }, { output: "/out/a.json" }),
        op("second", "search", { query: "b" }, { output: "/out/b.json" }),
      ),
      DEPS,
    );
    assert.deepStrictEqual(
      parsed.operations.map((operation) => operation.output),
      ["/out/a.json", "/out/b.json"],
    );
  });
});

describe("batch manifest successful parses", () => {
  it("parses a minimal manifest", async () => {
    await assertParses(manifest(op("s1", "search", { query: "q" })), {
      schemaVersion: 1,
      operations: [{ name: "s1", command: "search", input: { query: "q" } }],
    });
  });

  it("parses an operation for every allowed command", async () => {
    const raw = manifest(
      op("s", "search", { query: "q", count: 5, topic: "news" }),
      op("r", "read", { url: "https://a", format: "text" }),
      op("res", "research", { query: "q", model: "pro" }),
      op("rs", "repo", { subcommand: "search", repository: "o/n", query: "x" }),
      op("rt", "repo", { subcommand: "tree", repository: "o/n", depth: 2 }),
      op("rr", "repo", { subcommand: "read", repository: "o/n", path: "README.md" }),
      op("rb", "repo", { subcommand: "brief", repository: "o/n", focus: "api" }),
      op("v", "vision", { subcommand: "analyze", source: "a.png", prompt: "p" }),
      op("vd", "vision", { subcommand: "diff", expected: "a.png", actual: "b.png" }),
      op("c", "crawl", { url: "https://a", depth: 2, breadth: 10 }),
      op("m", "map", { url: "https://a", limit: 5 }),
    );
    const m = await load();
    const parsed = m.parseBatchManifest(raw, DEPS);
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.operations.length, 11);
    assert.deepStrictEqual(parsed.operations.map((o) => o.command), [
      "search", "read", "research", "repo", "repo", "repo", "repo", "vision", "vision", "crawl", "map",
    ]);
  });

  it("never calls descriptor.create() while parsing", async () => {
    const m = await load();
    let createCalls = 0;
    const counting = {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(ALL_CAPS),
      create: () => {
        createCalls++;
        throw new Error("create must not run");
      },
    };
    m.parseBatchManifest(
      manifest(op("s", "search", { query: "q" }, { provider: "zai" })),
      { descriptors: [counting], dirExists: () => true },
    );
    assert.strictEqual(createCalls, 0);
  });
});

describe("compileInput argv snapshots", () => {
  async function compile(command, input) {
    const m = await load();
    return m.compileInput({ name: "x", command, input });
  }

  it("compiles a bare search query as one positional, never a --query flag", async () => {
    const argv = await compile("search", { query: "hello world" });
    assert.deepStrictEqual(argv, ["hello world"]);
    assert.ok(!argv.includes("--query"));
  });

  it("compiles a full search input to its pinned argv", async () => {
    const argv = await compile("search", {
      query: "q",
      count: 5,
      domain: "example.com",
      recency: "oneWeek",
      contentSize: "high",
      location: "cn",
      topic: "news",
      type: "video",
      maxSummary: 2,
      fields: ["title", "link"],
      noCache: true,
      merge: true,
    });
    assert.deepStrictEqual(argv, [
      "q",
      "--count", "5",
      "--domain", "example.com",
      "--recency", "oneWeek",
      "--content-size", "high",
      "--location", "cn",
      "--topic", "news",
      "--type", "video",
      "--max-summary", "2",
      "--fields", "title,link",
      "--no-cache",
      "--merge",
    ]);
  });

  it("emits nothing for false and undefined booleans", async () => {
    const argv = await compile("search", { query: "q", noCache: false, merge: false });
    assert.deepStrictEqual(argv, ["q"]);
  });

  it("compiles a full read input to its pinned argv (url first)", async () => {
    const argv = await compile("read", {
      url: "https://example.com/a",
      format: "text",
      noImages: true,
      withLinks: true,
      withImagesSummary: true,
      noCache: true,
    });
    assert.deepStrictEqual(argv, [
      "https://example.com/a",
      "--format", "text",
      "--no-images",
      "--with-links",
      "--with-images-summary",
      "--no-cache",
    ]);
  });

  it("compiles a full crawl input to its pinned argv with verbatim select/exclude paths", async () => {
    const argv = await compile("crawl", {
      url: "https://example.com",
      depth: 2,
      breadth: 10,
      limit: 5,
      selectPaths: "/docs/*",
      excludePaths: "/blog/*",
      instructions: "find api docs",
      format: "markdown",
      contentSize: "medium",
      timeout: 30,
      maxChars: 1000,
      noCache: true,
    });
    assert.deepStrictEqual(argv, [
      "https://example.com",
      "--depth", "2",
      "--breadth", "10",
      "--limit", "5",
      "--select-paths", "/docs/*",
      "--exclude-paths", "/blog/*",
      "--instructions", "find api docs",
      "--format", "markdown",
      "--content-size", "medium",
      "--timeout", "30",
      "--max-chars", "1000",
      "--no-cache",
    ]);
  });

  it("compiles a full map input to its pinned argv (url first)", async () => {
    const argv = await compile("map", {
      url: "https://example.com",
      depth: 1,
      breadth: 20,
      limit: 5,
      selectPaths: "/api/*",
      excludePaths: "/assets/*",
      instructions: "map endpoints",
      noCache: true,
    });
    assert.deepStrictEqual(argv, [
      "https://example.com",
      "--depth", "1",
      "--breadth", "20",
      "--limit", "5",
      "--select-paths", "/api/*",
      "--exclude-paths", "/assets/*",
      "--instructions", "map endpoints",
      "--no-cache",
    ]);
  });

  it("compiles a full research input to its pinned argv (query positional)", async () => {
    const argv = await compile("research", {
      query: "quantum computing",
      model: "pro",
      outputLength: "long",
      citationFormat: "apa",
      domain: "arxiv.org",
      maxChars: 900,
      timeout: 60,
      noCache: true,
    });
    assert.deepStrictEqual(argv, [
      "quantum computing",
      "--model", "pro",
      "--output-length", "long",
      "--citation-format", "apa",
      "--domain", "arxiv.org",
      "--max-chars", "900",
      "--timeout", "60",
      "--no-cache",
    ]);
  });

  it("compiles repo search with the query as the third positional", async () => {
    const argv = await compile("repo", {
      subcommand: "search",
      repository: "owner/name",
      query: "test",
      language: "en",
      maxChars: 100,
      noCache: true,
    });
    assert.deepStrictEqual(argv, [
      "search", "owner/name", "test",
      "--language", "en",
      "--max-chars", "100",
      "--no-cache",
    ]);
  });

  it("compiles repo tree with path as a flag", async () => {
    const argv = await compile("repo", { subcommand: "tree", repository: "owner/name", path: "src", depth: 2 });
    assert.deepStrictEqual(argv, ["tree", "owner/name", "--path", "src", "--depth", "2"]);
  });

  it("compiles repo brief with focus and path flags", async () => {
    const argv = await compile("repo", {
      subcommand: "brief",
      repository: "owner/name",
      path: "docs",
      focus: "api",
      depth: 1,
      maxChars: 500,
    });
    assert.deepStrictEqual(argv, [
      "brief", "owner/name",
      "--path", "docs",
      "--max-chars", "500",
      "--focus", "api",
      "--depth", "1",
    ]);
  });

  it("compiles repo read with path as the third positional", async () => {
    const argv = await compile("repo", { subcommand: "read", repository: "owner/name", path: "README.md" });
    assert.deepStrictEqual(argv, ["read", "owner/name", "README.md"]);
  });

  it("compiles vision analyze with source and prompt positionals", async () => {
    const argv = await compile("vision", { subcommand: "analyze", source: "img.png", prompt: "describe" });
    assert.deepStrictEqual(argv, ["analyze", "img.png", "describe"]);
  });

  it("compiles vision extract-text with the language flag", async () => {
    const argv = await compile("vision", { subcommand: "extract-text", source: "img.png", prompt: "p", language: "en" });
    assert.deepStrictEqual(argv, ["extract-text", "img.png", "p", "--language", "en"]);
  });

  it("compiles vision ui-to-code with the output flag", async () => {
    const argv = await compile("vision", { subcommand: "ui-to-code", source: "ui.png", output: "spec" });
    assert.deepStrictEqual(argv, ["ui-to-code", "ui.png", "--output", "spec"]);
  });

  it("compiles vision diagnose-error with the context flag", async () => {
    const argv = await compile("vision", { subcommand: "diagnose-error", source: "e.png", context: "stack trace" });
    assert.deepStrictEqual(argv, ["diagnose-error", "e.png", "--context", "stack trace"]);
  });

  it("compiles vision diagram with the type flag", async () => {
    const argv = await compile("vision", { subcommand: "diagram", source: "d.png", type: "flow" });
    assert.deepStrictEqual(argv, ["diagram", "d.png", "--type", "flow"]);
  });

  it("compiles vision chart with the focus flag", async () => {
    const argv = await compile("vision", { subcommand: "chart", source: "c.png", focus: "trend" });
    assert.deepStrictEqual(argv, ["chart", "c.png", "--focus", "trend"]);
  });

  it("compiles vision diff with expected/actual/prompt positionals", async () => {
    const argv = await compile("vision", { subcommand: "diff", expected: "a.png", actual: "b.png", prompt: "what changed" });
    assert.deepStrictEqual(argv, ["diff", "a.png", "b.png", "what changed"]);
  });

  it("rejects dash-prefixed positional values at compile time", async () => {
    const m = await load();
    assert.throws(
      () => m.compileInput({ name: "x", command: "search", input: { query: "-help" } }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.strictEqual(err.message, 'input field "query" must not begin with "-"');
        return true;
      },
    );
  });

  it("rejects dash-prefixed flag values at compile time", async () => {
    const m = await load();
    assert.throws(
      () => m.compileInput({ name: "x", command: "search", input: { query: "q", domain: "-evil" } }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.strictEqual(err.message, 'input field "domain" must not begin with "-"');
        return true;
      },
    );
  });

  it("rejects negative number values at compile time", async () => {
    const m = await load();
    assert.throws(
      () => m.compileInput({ name: "x", command: "crawl", input: { url: "https://a", depth: -1 } }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.strictEqual(err.message, 'input field "depth" must not begin with "-"');
        return true;
      },
    );
  });

  it("is deterministic: the same input compiles to the same argv twice", async () => {
    const m = await load();
    const input = { query: "q", count: 3, fields: ["title", "link"], noCache: true };
    const a = m.compileInput({ name: "x", command: "search", input });
    const b = m.compileInput({ name: "x", command: "search", input });
    assert.deepStrictEqual(a, b);
  });

  it("compiles parsed operations end to end", async () => {
    const m = await load();
    const parsed = m.parseBatchManifest(
      manifest(op("s1", "search", { query: "hello world", count: 5 })),
      DEPS,
    );
    const argv = m.compileInput(parsed.operations[0]);
    assert.deepStrictEqual(argv, ["hello world", "--count", "5"]);
  });

  it("emits nothing for an empty fields array", async () => {
    const argv = await compile("search", { query: "q", fields: [] });
    assert.deepStrictEqual(argv, ["q"]);
  });
});
