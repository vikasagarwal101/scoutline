import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "../dist/lib/errors.js";

/**
 * Ticket 2 — batch assignment module (`lib/batch-assign.ts`, DESIGN D4).
 *
 * Pins provider distribution semantics: eligibility per command-group
 * (configured + capable, registry order), round-robin cursors per
 * capability id, pin precedence (per-op > global > distribute), the
 * zero-eligible whole-batch VALIDATION_ERROR, vision per-operation
 * capability grouping, and determinism. Tests import dist/ per
 * AGENTS.md (build before test).
 */

const ALL_VISION_CAPS = [
  "vision.interpret-image",
  "vision.ui-artifact",
  "vision.extract-text",
  "vision.diagnose-error",
  "vision.diagram",
  "vision.chart",
  "vision.diff",
  "vision.video",
];

/**
 * Fully configured descriptor double: advertises `caps`, reports
 * configured for every capability. `create()` throws so an accidental
 * transport construction fails loudly (assignment is metadata-only).
 */
function alwaysConfigured(id, caps) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(caps),
    create() {
      throw new Error(`create() must not be called during assignment (${id})`);
    },
  };
}

/** Env-keyed descriptor double: configured iff `env[envVar]` is set. */
function keyedDescriptor(id, caps, envVar) {
  return {
    id,
    isConfigured: (env) => Boolean(env && env[envVar]),
    capabilities: () => new Set(caps),
    create() {
      throw new Error(`create() must not be called during assignment (${id})`);
    },
  };
}

function manifest(operations) {
  return { schemaVersion: 1, operations };
}

function op(name, command, input, extra = {}) {
  return { name, command, input, ...extra };
}

function searchOp(name, extra = {}) {
  return op(name, "search", { query: `q ${name}` }, extra);
}

async function load() {
  return await import("../dist/lib/batch-assign.js");
}

describe("batch assignment round-robin", () => {
  it("assigns the first two registry-eligible providers to two search ops over four eligible", async () => {
    const m = await load();
    const descriptors = [
      alwaysConfigured("zai", ["search"]),
      alwaysConfigured("minimax", ["search"]),
      alwaysConfigured("tavily", ["search"]),
      alwaysConfigured("exa", ["search"]),
    ];
    const result = m.assignBatchProviders(manifest([searchOp("s1"), searchOp("s2")]), {
      descriptors,
      env: {},
    });
    // Full record shape pinned: name, command, capabilityId, provider,
    // in manifest order.
    assert.deepStrictEqual(result, [
      { name: "s1", command: "search", capabilityId: "search", provider: "zai" },
      { name: "s2", command: "search", capabilityId: "search", provider: "minimax" },
    ]);
  });

  it("pins the 10-over-4 waves sequence exactly (round-robin 0,1,2,3,0,1,2,3,0,1)", async () => {
    const m = await load();
    const descriptors = [
      alwaysConfigured("zai", ["search"]),
      alwaysConfigured("minimax", ["search"]),
      alwaysConfigured("tavily", ["search"]),
      alwaysConfigured("exa", ["search"]),
    ];
    const operations = Array.from({ length: 10 }, (_, i) => searchOp(`s${i}`));
    const result = m.assignBatchProviders(manifest(operations), { descriptors, env: {} });
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      [
        "zai", "minimax", "tavily", "exa",
        "zai", "minimax", "tavily", "exa",
        "zai", "minimax",
      ],
    );
  });

  it("per-op pin skips its slot without advancing the group cursor", async () => {
    const m = await load();
    const descriptors = [
      alwaysConfigured("zai", ["search"]),
      alwaysConfigured("minimax", ["search"]),
      alwaysConfigured("tavily", ["search"]),
    ];
    const result = m.assignBatchProviders(
      manifest([
        searchOp("s1"),
        searchOp("s2", { provider: "tavily" }),
        searchOp("s3"),
      ]),
      { descriptors, env: {} },
    );
    // s1 takes cursor slot 0 (zai); the pinned s2 must not consume slot
    // 1, so s3 receives minimax — not tavily.
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      ["zai", "tavily", "minimax"],
    );
  });

  it("global pin routes every unpinned op and disables distribution", async () => {
    const m = await load();
    const descriptors = [
      alwaysConfigured("zai", ["search"]),
      alwaysConfigured("minimax", ["search"]),
      alwaysConfigured("tavily", ["search"]),
    ];
    const result = m.assignBatchProviders(manifest([searchOp("s1"), searchOp("s2"), searchOp("s3")]), {
      descriptors,
      env: {},
      globalProvider: "exa",
    });
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      ["exa", "exa", "exa"],
    );
  });

  it("per-op pin outranks the global pin", async () => {
    const m = await load();
    const descriptors = [
      alwaysConfigured("zai", ["search"]),
      alwaysConfigured("minimax", ["search"]),
      alwaysConfigured("tavily", ["search"]),
      alwaysConfigured("exa", ["search"]),
    ];
    const result = m.assignBatchProviders(
      manifest([searchOp("s1", { provider: "tavily" }), searchOp("s2"), searchOp("s3")]),
      { descriptors, env: {}, globalProvider: "exa" },
    );
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      ["tavily", "exa", "exa"],
    );
  });

  it("cursors are independent across command groups (a read op never consumes a search slot)", async () => {
    const m = await load();
    const descriptors = [
      alwaysConfigured("zai", ["search"]),
      alwaysConfigured("minimax", ["search"]),
      alwaysConfigured("tavily", ["reader"]),
      alwaysConfigured("exa", ["reader"]),
    ];
    const result = m.assignBatchProviders(
      manifest([
        searchOp("s1"),
        op("r1", "read", { url: "https://example.com/a" }),
        searchOp("s2"),
      ]),
      { descriptors, env: {} },
    );
    // The read op takes tavily from the reader group; the second search
    // must still take the search group's slot 1 (minimax).
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      ["zai", "tavily", "minimax"],
    );
    assert.deepStrictEqual(
      result.map((r) => r.capabilityId),
      ["search", "reader", "search"],
    );
  });

  it("one eligible provider degenerates to all-on-one", async () => {
    const m = await load();
    const descriptors = [
      keyedDescriptor("zai", ["search"], "Z_AI_API_KEY"),
      keyedDescriptor("minimax", ["search"], "MINIMAX_API_KEY"),
      keyedDescriptor("tavily", ["search"], "TAVILY_API_KEY"),
    ];
    const env = { Z_AI_API_KEY: "k" };
    const operations = Array.from({ length: 5 }, (_, i) => searchOp(`s${i}`));
    const result = m.assignBatchProviders(manifest(operations), { descriptors, env });
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      ["zai", "zai", "zai", "zai", "zai"],
    );
  });

  it("is deterministic: the same manifest and eligible sets assign identically twice", async () => {
    const m = await load();
    const descriptors = [
      alwaysConfigured("zai", ["search", ...ALL_VISION_CAPS]),
      alwaysConfigured("minimax", ["search", "vision.interpret-image"]),
      alwaysConfigured("tavily", ["search", "reader"]),
    ];
    const operations = [
      searchOp("s1"),
      op("r1", "read", { url: "https://example.com/a" }),
      op("v1", "vision", { subcommand: "analyze", source: "a.png" }),
      op("v2", "vision", { subcommand: "diff", expected: "a.png", actual: "b.png" }),
      searchOp("s2"),
      op("v3", "vision", { subcommand: "analyze", source: "c.png" }),
    ];
    const deps = { descriptors, env: {} };
    const first = m.assignBatchProviders(manifest(operations), deps);
    const second = m.assignBatchProviders(manifest(operations), deps);
    assert.deepStrictEqual(first, second);
  });
});

describe("batch assignment zero-eligibility", () => {
  it("rejects the whole batch with VALIDATION_ERROR naming the configured and registry sets (nothing configured)", async () => {
    const m = await load();
    const descriptors = [
      keyedDescriptor("zai", ["search", "crawl"], "Z_AI_API_KEY"),
      keyedDescriptor("minimax", ["search"], "MINIMAX_API_KEY"),
    ];
    assert.throws(
      () => m.assignBatchProviders(manifest([op("c1", "crawl", { url: "https://example.com" })]), {
        descriptors,
        env: {},
      }),
      (err) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err?.name}: ${err?.message}`);
        assert.strictEqual(err.code, "VALIDATION_ERROR");
        assert.strictEqual(
          err.message,
          'batch distribution produced no eligible providers for capability "crawl"; configured providers: (none) (registry: zai, minimax).',
        );
        return true;
      },
    );
  });

  it("names the configured set when credentials exist but no provider advertises the capability", async () => {
    const m = await load();
    const descriptors = [
      keyedDescriptor("zai", ["search"], "Z_AI_API_KEY"),
      keyedDescriptor("minimax", ["search"], "MINIMAX_API_KEY"),
    ];
    assert.throws(
      () => m.assignBatchProviders(manifest([op("c1", "crawl", { url: "https://example.com" })]), {
        descriptors,
        env: { Z_AI_API_KEY: "k" },
      }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.strictEqual(
          err.message,
          'batch distribution produced no eligible providers for capability "crawl"; configured providers: zai (registry: zai, minimax).',
        );
        return true;
      },
    );
  });

  it("a global pin suppresses the zero-eligible error (distribution is disabled)", async () => {
    const m = await load();
    const descriptors = [
      keyedDescriptor("zai", ["search"], "Z_AI_API_KEY"),
      keyedDescriptor("minimax", ["search"], "MINIMAX_API_KEY"),
    ];
    const result = m.assignBatchProviders(manifest([searchOp("s1"), searchOp("s2")]), {
      descriptors,
      env: {},
      globalProvider: "zai",
    });
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      ["zai", "zai"],
    );
  });
});

describe("batch assignment vision capability grouping", () => {
  const visionDescriptors = [
    alwaysConfigured("zai", ["search", ...ALL_VISION_CAPS]),
    alwaysConfigured("minimax", ["search", "vision.interpret-image"]),
  ];

  it("analyze eligibility walks zai and minimax per-operation", async () => {
    const m = await load();
    const result = m.assignBatchProviders(
      manifest([
        op("v1", "vision", { subcommand: "analyze", source: "a.png" }),
        op("v2", "vision", { subcommand: "analyze", source: "b.png" }),
        op("v3", "vision", { subcommand: "analyze", source: "c.png" }),
        op("v4", "vision", { subcommand: "analyze", source: "d.png" }),
      ]),
      { descriptors: visionDescriptors, env: {} },
    );
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      ["zai", "minimax", "zai", "minimax"],
    );
    assert.ok(result.every((r) => r.capabilityId === "vision.interpret-image"));
  });

  it("diff and video see only their capable providers (single eligible each)", async () => {
    const m = await load();
    const diffs = m.assignBatchProviders(
      manifest([
        op("d1", "vision", { subcommand: "diff", expected: "a.png", actual: "b.png" }),
        op("d2", "vision", { subcommand: "diff", expected: "c.png", actual: "d.png" }),
        op("d3", "vision", { subcommand: "diff", expected: "e.png", actual: "f.png" }),
      ]),
      { descriptors: visionDescriptors, env: {} },
    );
    assert.deepStrictEqual(
      diffs.map((r) => r.provider),
      ["zai", "zai", "zai"],
    );
    assert.ok(diffs.every((r) => r.capabilityId === "vision.diff"));

    const videos = m.assignBatchProviders(
      manifest([
        op("m1", "vision", { subcommand: "video", source: "a.mp4" }),
        op("m2", "vision", { subcommand: "video", source: "b.mp4" }),
      ]),
      { descriptors: visionDescriptors, env: {} },
    );
    assert.deepStrictEqual(
      videos.map((r) => r.provider),
      ["zai", "zai"],
    );
    assert.ok(videos.every((r) => r.capabilityId === "vision.video"));
  });

  it("a mixed-vision batch holds one cursor per sub-operation with a deterministic sequence", async () => {
    const m = await load();
    const result = m.assignBatchProviders(
      manifest([
        op("a1", "vision", { subcommand: "analyze", source: "a.png" }),
        op("d1", "vision", { subcommand: "diff", expected: "a.png", actual: "b.png" }),
        op("c1", "vision", { subcommand: "chart", source: "c.png" }),
        op("a2", "vision", { subcommand: "analyze", source: "d.png" }),
      ]),
      { descriptors: visionDescriptors, env: {} },
    );
    assert.deepStrictEqual(
      result.map((r) => r.provider),
      ["zai", "zai", "zai", "minimax"],
    );
    assert.deepStrictEqual(
      result.map((r) => r.capabilityId),
      ["vision.interpret-image", "vision.diff", "vision.chart", "vision.interpret-image"],
    );
  });
});

describe("batch assignment descriptor safety", () => {
  it("never calls descriptor.create()", async () => {
    const m = await load();
    let createCalls = 0;
    const counting = alwaysConfigured("zai", ["search"]);
    counting.create = () => {
      createCalls++;
      throw new Error("create must not run");
    };
    m.assignBatchProviders(manifest([searchOp("s1"), searchOp("s2")]), {
      descriptors: [counting],
      env: {},
    });
    assert.strictEqual(createCalls, 0);
  });
});
