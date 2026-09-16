/**
 * #159 — lazy async-job state-dir resolution.
 *
 * registry.ts constructs every Provider Descriptor at MODULE IMPORT. The
 * async-job adapters used to resolve `asyncJobStateDir(...)` into a
 * string at that moment, so a `SCOUTLINE_CACHE_DIR` set (or changed)
 * AFTER import never reached the state dir — the stale-capture defect.
 *
 * These pins require the state-dir default to resolve at `create()`
 * time: the descriptor is constructed FIRST, the cache root env is set
 * SECOND, and the invoke must then land its billing state under the NEW
 * root. A stale capture instead resolves the real home, which the
 * store-perimeter guard turns into a loud TEST_ISOLATION_VIOLATION —
 * so the lazy behavior and the hermetic behavior are one assertion.
 *
 * A spawn-based import-purity canary additionally pins that importing
 * the provider registry performs NO filesystem writes (the IO-free
 * import invariant documented at registry.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createExaDescriptor } from "../dist/providers/exa/adapter.js";
import { createLinkupDescriptor } from "../dist/providers/linkup/adapter.js";
import { createFirecrawlDescriptor } from "../dist/providers/firecrawl/adapter.js";

function makeResponse(json, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(json),
    json: async () => json,
  };
}

const immediateTimer = {
  setTimeout: (cb) => {
    setImmediate(cb);
    return 0;
  },
  clearTimeout: () => {},
};

/**
 * Run one adapter invoke whose state-file write must land under a cache
 * root that is set AFTER the descriptor was constructed.
 */
async function assertLazyStateDir({ name, buildDescriptor, env, run, capabilitySegment }) {
  const root = mkdtempSync(join(tmpdir(), `lazy-state-${name}-`));
  const saved = process.env.SCOUTLINE_CACHE_DIR;
  process.env.SCOUTLINE_CACHE_DIR = root;
  try {
    // The caller constructed the descriptor BEFORE this helper flipped
    // the env, so a construction-time capture resolves the pre-change
    // (real) home; a create()-time resolution lands under `root`.
    await run();
    assert.ok(
      existsSync(join(root, capabilitySegment)),
      `${name}: state dir must resolve under the post-construction cache root (${join(root, capabilitySegment)})`,
    );
  } finally {
    if (saved === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
    else process.env.SCOUTLINE_CACHE_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("#159 lazy async-job state-dir resolution", () => {
  it("tavily research state lands under a cache root set after descriptor construction", async () => {
    const descriptor = createTavilyDescriptor({
      transport: {
        fetch: async (url, init) => {
          const method = init?.method ?? "GET";
          if (method === "POST")
            return makeResponse({ request_id: "req-lazy", status: "pending" }, 201);
          return makeResponse({
            status: "completed",
            content: "Report.",
            sources: [{ title: "S", url: "https://example.test/s" }],
          });
        },
        env: { TAVILY_RESEARCH_POLL_INTERVAL_MS: "0" },
      },
    });
    let adapter;
    await assertLazyStateDir({
      name: "tavily",
      capabilitySegment: "research",
      run: async () => {
        adapter ??= descriptor.create({ env: { TAVILY_API_KEY: "tvly-lazy-test" } });
        const result = await adapter.research.run.invoke({ query: "lazy resolution" });
        assert.equal(result.schemaVersion, 1);
      },
    });
  });

  it("exa research state lands under a cache root set after descriptor construction", async () => {
    const descriptor = createExaDescriptor({
      transport: {
        fetch: async (url, init) => {
          const method = init?.method ?? "GET";
          if (method === "POST") return makeResponse({ id: "run_lazy", status: "queued" }, 201);
          return makeResponse({ id: "run_lazy", status: "completed", output: { text: "Report." } });
        },
        ...immediateTimer,
        env: { EXA_RESEARCH_POLL_INTERVAL_MS: "0" },
      },
    });
    let adapter;
    await assertLazyStateDir({
      name: "exa",
      capabilitySegment: "research",
      run: async () => {
        adapter ??= descriptor.create({ env: { EXA_API_KEY: "exa-lazy-test" } });
        const result = await adapter.research.run.invoke({ query: "lazy resolution" });
        assert.equal(result.schemaVersion, 1);
      },
    });
  });

  it("linkup research state lands under a cache root set after descriptor construction", async () => {
    const descriptor = createLinkupDescriptor({
      transport: {
        fetch: async (url, init) => {
          const method = init?.method ?? "GET";
          if (method === "POST" && String(url).endsWith("/research")) {
            return makeResponse({ id: "job-lazy", status: "pending" }, 200);
          }
          return makeResponse({
            status: "completed",
            output: { answer: "Report.", sources: [] },
          });
        },
        ...immediateTimer,
      },
    });
    let adapter;
    await assertLazyStateDir({
      name: "linkup",
      capabilitySegment: "research",
      run: async () => {
        adapter ??= descriptor.create({ env: { LINKUP_API_KEY: "linkup-lazy-test" } });
        const result = await adapter.research.run.invoke({
          query: "lazy resolution",
          model: "auto",
        });
        assert.equal(result.schemaVersion, 1);
      },
    });
  });

  it("firecrawl crawl state lands under a cache root set after descriptor construction", async () => {
    const descriptor = createFirecrawlDescriptor({
      transport: {
        fetch: async (url, init) => {
          const method = init?.method ?? "GET";
          if (method === "POST" && String(url).includes("/v2/crawl")) {
            return makeResponse({ success: true, id: "crawl-lazy", status: "scraping" }, 200);
          }
          return makeResponse({ success: true, status: "completed", data: [] });
        },
        ...immediateTimer,
        env: { FIRECRAWL_CRAWL_POLL_INTERVAL_MS: "0" },
      },
    });
    let adapter;
    await assertLazyStateDir({
      name: "firecrawl",
      capabilitySegment: "crawl",
      run: async () => {
        adapter ??= descriptor.create({
          env: { FIRECRAWL_API_KEY: "fc-lazy-test", FIRECRAWL_CRAWL_POLL_INTERVAL_MS: "0" },
        });
        const result = await adapter.crawl.fetch.invoke({ url: "https://start.example" });
        assert.equal(result.schemaVersion, 1);
      },
    });
  });

  it("importing the provider registry performs no filesystem writes (IO-free import canary)", () => {
    const home = mkdtempSync(join(tmpdir(), "import-purity-home-"));
    try {
      const registryUrl = new URL("../dist/providers/registry.js", import.meta.url).href;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `import(${JSON.stringify(registryUrl)}).then(() => console.log("IMPORT_OK")).catch((e) => { console.error(e); process.exit(1); })`,
        ],
        {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
          encoding: "utf8",
          timeout: 30000,
        },
      );
      assert.equal(result.status, 0, `registry import failed: ${result.stderr}`);
      assert.match(result.stdout, /IMPORT_OK/);
      const entries = readdirSync(home);
      assert.deepEqual(
        entries,
        [],
        `module import must not write under HOME; found ${entries.join(", ")}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
