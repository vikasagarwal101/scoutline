/**
 * Controls class-guard (audit cluster C07 descendants).
 *
 * Table-driven conformance: every documented Search / Reader / Research
 * control, per provider, must be in exactly one of two states:
 *
 *   rejected — validate() throws UnsupportedOptionError naming the
 *              option, and invoke() re-throws it BEFORE any transport
 *              access (zero wire calls).
 *   consumed — invoke() resolves and the control is observable either
 *              on the outgoing request (body / query / header / MCP
 *              args, captured at the injected transport seam) or in
 *              the returned normalized content.
 *
 * This kills the recurring class where validate() accepts (or ignores)
 * a control while invoke() silently drops it — e.g. Perplexity research
 * `model`, Parallel reader `retainImages`, Jina/Perplexity empty-URL
 * sources (all fixed this wave and now pinned here).
 *
 * A fourth state, `documented-strip`, pins an INTENTIONAL contract: the
 * control is accepted, stripped before the wire, AND disclosed by a stderr
 * warning (Exa research OD1 semantics — owner decision 2026-08-19). Unlike
 * `dropped`, it is a pass: the disclosure is the product behavior.
 *
 * A third state, `dropped`, is a CHARACTERIZED FINDING, not a pass: the
 * row asserts the control is accepted yet provably absent from the wire
 * (the bug class itself). If a fix lands, the dropped characterization
 * FAILS and the row must be upgraded to rejected/consumed. Every
 * dropped row must reference a FINDINGS entry — no silent skips.
 *
 * Source of truth for the control surface:
 *   src/capabilities/search.ts    (SearchControls)
 *   src/capabilities/reader.ts    (ReaderFetchRequest)
 *   src/capabilities/research.ts  (ResearchRequest)
 * Provider capability coverage follows each adapter's descriptor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { createMiniMaxDescriptor } from "../dist/providers/minimax/adapter.js";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createExaDescriptor } from "../dist/providers/exa/adapter.js";
import { createBraveDescriptor } from "../dist/providers/brave/adapter.js";
import { createFirecrawlDescriptor } from "../dist/providers/firecrawl/adapter.js";
import { ParallelAdapter } from "../dist/providers/parallel/adapter.js";
import { PerplexityAdapter } from "../dist/providers/perplexity/adapter.js";
import { JinaAdapter } from "../dist/providers/jina/adapter.js";
import { createYouDescriptor } from "../dist/providers/you/adapter.js";
import { createLinkupDescriptor } from "../dist/providers/linkup/adapter.js";
import { createInMemoryAsyncJobStateFile } from "../dist/lib/async-job-state.js";
import { UnsupportedOptionError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Findings registry — every `dropped` row must point here. These are the
// rows that CANNOT pass as rejected/consumed at HEAD; they encode the
// option-drop bug class as executable evidence. CC-1..CC-6 were fixed
// (issues #66–#70) and their rows upgraded to consumed.
// ---------------------------------------------------------------------------

// Findings registry: EMPTY — all nine CC findings resolved 2026-08-19.
// CC-1..CC-6 fixed (wired, see the provider commits); CC-7..CC-9 resolved as
// the owner-endorsed documented-strip contract below (kept + warned, not
// rejected — Exa research OD1 fallback semantics).
const FINDINGS = [];

const FINDINGS_BY_ID = new Map(FINDINGS.map((f) => [f.id, f]));

// ---------------------------------------------------------------------------
// Shared fixtures + capture transport
// ---------------------------------------------------------------------------

const PAGE_URL = "https://example.test/page";
const SEARCH_QUERY = "conformance query";
const RESEARCH_QUERY = "conformance research query";

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    headers: { get: () => null },
  };
}

const NO_OP_TIMERS = {
  setTimeout: (cb) => {
    setImmediate(cb);
    return 0;
  },
  clearTimeout: () => {},
};

/**
 * Capturing fetch: records {url, method, headers, body} per call. The
 * fake ignores init.signal, so injected immediate-fire timers (used by
 * the research poll loops) can never abort it — same trick as the
 * sibling adapter tests.
 */
function makeCaptureFetch(respond) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    let body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined; // SSE / opaque text bodies stay raw
      }
    }
    const record = {
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      bodyText: typeof init.body === "string" ? init.body : undefined,
      body,
      args: undefined, // MCP-args seam (zai) populates this instead
    };
    calls.push(record);
    return respond(record.url, record.method, init);
  };
  return { fetch: fetchFn, calls };
}

let sharedTmpDir;
function tmpStateDir() {
  if (!sharedTmpDir) {
    sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-controls-guard-"));
  }
  return sharedTmpDir;
}

// ---------------------------------------------------------------------------
// Per-provider responders: minimal raw shapes that normalize successfully.
// ---------------------------------------------------------------------------

const ZAI_SEARCH_RAW = [
  { title: "Result", link: "https://example.test/one", content: "Summary." },
];
const ZAI_READER_RAW = { title: "Page", url: PAGE_URL, content: "# Page body" };

const TAVILY_SEARCH_RAW = {
  results: [{ title: "Result", url: "https://example.test/one", content: "Summary." }],
};
const TAVILY_EXTRACT_RAW = {
  results: [{ url: PAGE_URL, raw_content: "![alt](https://img.example.test/i.png) # Page body" }],
};

const EXA_SEARCH_RAW = {
  results: [{ title: "Result", url: "https://example.test/one", highlights: ["Summary."] }],
};
const EXA_CONTENTS_RAW = {
  statuses: [{ id: PAGE_URL, status: "success" }],
  results: [
    {
      id: PAGE_URL,
      url: PAGE_URL,
      title: "Page",
      text: "![alt](https://img.example.test/i.png) Hello [world](https://example.com) !",
    },
  ],
};

const BRAVE_WEB_RAW = {
  web: { results: [{ title: "Result", url: "https://example.test/one", description: "Sum." }] },
};
const BRAVE_TOP_RAW = {
  results: [{ title: "Result", url: "https://example.test/one", description: "Sum." }],
};
const BRAVE_LLM_RAW = {
  grounding: {
    generic: [{ title: "Result", url: "https://example.test/one", snippets: ["Sum."] }],
  },
};

const FIRECRAWL_SEARCH_RAW = {
  data: { web: [{ title: "Result", url: "https://example.test/one", description: "Sum." }] },
};
const FIRECRAWL_SCRAPE_RAW = {
  data: {
    markdown: "# Page body",
    text: "Page body",
    metadata: { title: "Page", sourceURL: PAGE_URL },
  },
};

const MINIMAX_SEARCH_RAW = {
  organic: [{ title: "Result", link: "https://example.test/one", snippet: "Summary." }],
};

const PARALLEL_SEARCH_RAW = {
  results: [{ title: "Result", url: "https://example.test/one", excerpts: ["Summary."] }],
};
const PARALLEL_EXTRACT_RAW = {
  results: [
    {
      title: "Page",
      url: PAGE_URL,
      full_content: "![alt](https://img.example.test/i.png) Page body",
    },
  ],
};
const PARALLEL_RESEARCH_POLL_RAW = {
  run: { run_id: "trun-1", status: "completed", processor: "pro" },
  output: {
    content: "## Report",
    basis: [{ citations: [{ title: "Source", url: "https://example.test/s" }] }],
  },
};

const PERPLEXITY_SEARCH_RAW = {
  results: [{ title: "Result", url: "https://example.test/one", snippet: "Summary." }],
};
const PERPLEXITY_CHAT_RAW = {
  choices: [{ message: { content: "## Report" } }],
  search_results: [{ title: "Source", url: "https://example.test/s" }],
};

const JINA_SEARCH_RAW = {
  data: [{ title: "Result", url: "https://example.test/one", description: "Summary." }],
};
const JINA_READER_RAW = {
  data: { title: "Page", url: PAGE_URL, content: "Page [link](https://example.test/l) body" },
};
const JINA_DEEPSEARCH_SSE = [
  'data: {"choices":[{"delta":{"content":"## Report"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  "data: [DONE]",
  "",
].join("\n\n");

const YOU_SEARCH_RAW = {
  results: {
    web: [{ title: "Result", url: "https://example.test/one", snippets: ["Summary."] }],
    news: [],
  },
};
const YOU_CONTENTS_RAW = [
  { url: PAGE_URL, title: "Page", markdown: "# Page body", html: "<h1>Page body</h1>", status: 200 },
];
const YOU_RESEARCH_RAW = {
  output: {
    content: "## Report",
    content_type: "text",
    sources: [{ title: "Source", url: "https://example.test/s", snippets: ["Basis."] }],
  },
  metadata: { research_uuid: "research-fixture-001", latency: 3.45 },
};

const LINKUP_SEARCH_RAW = {
  results: [
    {
      name: "Result",
      url: "https://example.test/one",
      content: "Summary.",
      favicon: "https://example.test/favicon.ico",
      type: "text",
    },
  ],
};
const LINKUP_READER_RAW = { url: PAGE_URL, markdown: "# Page body" };
const LINKUP_RESEARCH_POLL_RAW = {
  id: "t1",
  status: "completed",
  output: {
    answer: "## Report",
    sources: [{ name: "Source", url: "https://example.test/s", snippet: "x" }],
  },
};
const RESPONDERS = {
  zai: null, // MCP seam, not fetch
  minimax(url, method) {
    // The coding-plan transport parses the envelope via json().
    const resp = jsonResponse({ ...MINIMAX_SEARCH_RAW, base_resp: { status_code: 0 } });
    return resp;
  },
  tavily(url, method) {
    if (method === "POST" && url.endsWith("/search")) return jsonResponse(TAVILY_SEARCH_RAW);
    if (method === "POST" && url.endsWith("/extract")) return jsonResponse(TAVILY_EXTRACT_RAW);
    if (method === "POST" && url.endsWith("/research")) {
      return jsonResponse({ request_id: "req-1", status: "pending" }, 201);
    }
    if (method === "GET" && url.includes("/research/")) {
      return jsonResponse({
        status: "completed",
        content: "## Report",
        sources: [{ title: "Source", url: "https://example.test/s" }],
      });
    }
    return jsonResponse({});
  },
  exa(url, method) {
    if (method === "POST" && url.endsWith("/search")) return jsonResponse(EXA_SEARCH_RAW);
    if (method === "POST" && url.endsWith("/contents")) return jsonResponse(EXA_CONTENTS_RAW);
    if (method === "POST" && url.includes("/agent/runs")) {
      return jsonResponse({ id: "run_test", status: "queued" });
    }
    if (method === "GET" && url.includes("/agent/runs/")) {
      return jsonResponse({
        id: "run_test",
        status: "completed",
        output: { text: "## Report", grounding: [] },
      });
    }
    return jsonResponse({});
  },
  brave(url) {
    if (url.includes("/videos/")) return jsonResponse(BRAVE_TOP_RAW);
    if (url.includes("/news/")) return jsonResponse(BRAVE_TOP_RAW);
    if (url.includes("/llm/")) return jsonResponse(BRAVE_LLM_RAW);
    return jsonResponse(BRAVE_WEB_RAW);
  },
  firecrawl(url) {
    if (url.endsWith("/v2/search")) return jsonResponse(FIRECRAWL_SEARCH_RAW);
    if (url.endsWith("/v2/scrape")) return jsonResponse(FIRECRAWL_SCRAPE_RAW);
    return jsonResponse({});
  },
  parallel(url, method) {
    if (method === "POST" && url.endsWith("/v1/search")) return jsonResponse(PARALLEL_SEARCH_RAW);
    if (method === "POST" && url.endsWith("/v1/extract")) {
      return jsonResponse(PARALLEL_EXTRACT_RAW);
    }
    if (method === "POST" && url.includes("/v1/tasks/runs")) {
      return jsonResponse({ run_id: "trun-1", status: "queued" }, 202);
    }
    if (method === "GET" && url.includes("/result")) {
      return jsonResponse(PARALLEL_RESEARCH_POLL_RAW);
    }
    return jsonResponse({});
  },
  perplexity(url) {
    if (url.endsWith("/search")) return jsonResponse(PERPLEXITY_SEARCH_RAW);
    if (url.endsWith("/chat/completions")) return jsonResponse(PERPLEXITY_CHAT_RAW);
    return jsonResponse({});
  },
  jina(url, method) {
    if (url.includes("deepsearch.jina.ai")) {
      // SSE text response for the streaming DeepSearch endpoint.
      return {
        ok: true,
        status: 200,
        text: async () => JINA_DEEPSEARCH_SSE,
        json: async () => {
          throw new Error("SSE body is not JSON");
        },
        headers: { get: () => null },
      };
    }
    if (url.includes("r.jina.ai")) return jsonResponse(JINA_READER_RAW);
    return jsonResponse(JINA_SEARCH_RAW); // s.jina.ai GET and POST
  },
  you(url, method) {
    // Dual host: ydc-index.io serves /search + /contents, api.you.com /research.
    if (method === "POST" && url.endsWith("/v1/search")) return jsonResponse(YOU_SEARCH_RAW);
    if (method === "POST" && url.endsWith("/v1/contents")) return jsonResponse(YOU_CONTENTS_RAW);
    if (method === "POST" && url.endsWith("/v1/research")) return jsonResponse(YOU_RESEARCH_RAW);
    return jsonResponse({});
  },
  linkup(url, method) {
    if (method === "POST" && url.endsWith("/search")) return jsonResponse(LINKUP_SEARCH_RAW);
    if (method === "POST" && url.endsWith("/fetch")) return jsonResponse(LINKUP_READER_RAW);
    if (method === "POST" && url.endsWith("/research")) {
      return jsonResponse({ id: "t1", status: "pending" });
    }
    if (method === "GET" && url.includes("/research/")) {
      return jsonResponse(LINKUP_RESEARCH_POLL_RAW);
    }
    if (method === "GET" && url.endsWith("/credits/balance")) {
      return jsonResponse({ balance: 182.45 });
    }
    return jsonResponse({});
  },
};

const ENV_BY_PROVIDER = {
  zai: { Z_AI_API_KEY: "k" },
  minimax: { MINIMAX_API_KEY: "k" },
  tavily: { TAVILY_API_KEY: "k" },
  exa: { EXA_API_KEY: "k" },
  brave: { BRAVE_SEARCH_API_KEY: "k" },
  firecrawl: { FIRECRAWL_API_KEY: "k" },
  parallel: { PARALLEL_API_KEY: "k" },
  perplexity: { PERPLEXITY_API_KEY: "k" },
  jina: {},
  you: { YDC_API_KEY: "k" },
  linkup: { LINKUP_API_KEY: "k" },
};

/** Research transports need a zero poll interval + no-op lock timers. */
function transportEnv(provider) {
  if (provider === "tavily") return { TAVILY_RESEARCH_POLL_INTERVAL_MS: "0" };
  if (provider === "exa") return { EXA_RESEARCH_POLL_INTERVAL_MS: "0" };
  return {};
}

/**
 * Build a fresh adapter harness for one row: a capturing transport (or
 * MCP client factory for zai) plus the adapter. Research rows get an
 * in-memory state file and a temp lock dir where the seam exists.
 */
function makeHarness(provider, capability) {
  const context = { env: ENV_BY_PROVIDER[provider] };

  if (provider === "zai") {
    const raw = capability === "search" ? ZAI_SEARCH_RAW : ZAI_READER_RAW;
    const calls = [];
    let clientCount = 0;
    const clientFactory = () => {
      clientCount += 1;
      return {
        async callToolRaw(name, args) {
          calls.push({ url: `mcp://${name}`, method: "CALL", headers: {}, args, body: args });
          return raw;
        },
        async listTools() {
          return [];
        },
        async close() {},
      };
    };
    const adapter = createZaiDescriptor({ clientFactory }).create(context);
    return { adapter, calls, clientCount };
  }

  const { fetch, calls } = makeCaptureFetch(RESPONDERS[provider]);
  const timerDelays = [];
  const transport = { fetch };
  if (capability === "research") {
    transport.env = transportEnv(provider);
    Object.assign(transport, NO_OP_TIMERS);
  } else {
    // Hermetic reader/search rows: record-and-swallow the abort timer so a
    // wired client abort budget is observable (on: "timer") without arming
    // real timers. The capture fetch ignores init.signal, so never firing
    // the abort callback is safe.
    transport.setTimeout = (cb, ms) => {
      timerDelays.push(ms);
      return 0;
    };
    transport.clearTimeout = () => {};
  }

  const stateFile = createInMemoryAsyncJobStateFile();
  switch (provider) {
    case "minimax":
      return {
        adapter: createMiniMaxDescriptor({ transport }).create(context),
        calls,
        timerDelays,
      };
    case "tavily":
      return {
        adapter: createTavilyDescriptor({
          transport,
          researchStateFile: stateFile,
          researchStateDir: capability === "research" ? tmpStateDir() : undefined,
        }).create(context),
        calls,
        timerDelays,
      };
    case "exa":
      return {
        adapter: createExaDescriptor({ transport, researchStateFile: stateFile }).create(
          context,
        ),
        calls,
        timerDelays,
      };
    case "brave":
      return { adapter: createBraveDescriptor({ transport }).create(context), calls, timerDelays };
    case "firecrawl":
      return {
        adapter: createFirecrawlDescriptor({ transport }).create(context),
        calls,
        timerDelays,
      };
    case "parallel":
      return {
        adapter: new ParallelAdapter(context, {
          transport,
          researchStateFile: stateFile,
          researchStateDir: capability === "research" ? tmpStateDir() : undefined,
        }),
        calls,
        timerDelays,
      };
    case "perplexity":
      return { adapter: new PerplexityAdapter(context, { transport }), calls, timerDelays };
    case "jina":
      return { adapter: new JinaAdapter(context, { transport }), calls, timerDelays };
    case "you":
      return { adapter: createYouDescriptor({ transport }).create(context), calls, timerDelays };
    case "linkup":
      return {
        adapter: createLinkupDescriptor({
          transport,
          researchStateFile: stateFile,
          researchStateDir: capability === "research" ? tmpStateDir() : undefined,
        }).create(context),
        calls,
        timerDelays,
      };
    default:
      throw new Error(`unknown provider ${provider}`);
  }
}

// ---------------------------------------------------------------------------
// Row runner: the two assertion paths (reject / consume) + dropped
// characterization for findings.
// ---------------------------------------------------------------------------

function getCapability(adapter, capability) {
  if (capability === "search") return adapter.search;
  if (capability === "reader") return adapter.reader.fetch;
  if (capability === "research") return adapter.research.run;
  throw new Error(`unknown capability ${capability}`);
}

function buildRequest(row) {
  if (row.capability === "search") {
    return { query: SEARCH_QUERY, controls: row.input };
  }
  if (row.capability === "reader") {
    return { url: PAGE_URL, ...row.input };
  }
  return { query: RESEARCH_QUERY, ...row.input };
}

function pickCapture(harness, pick) {
  const found = harness.calls.find(
    (c) =>
      (!pick?.method || c.method === pick.method) &&
      (!pick?.urlIncludes || c.url.includes(pick.urlIncludes)),
  );
  assert.ok(found, "expected at least one matching transport call");
  return found;
}

function getPath(obj, dotted) {
  return dotted
    .split(".")
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), obj);
}

function applyCheck(actual, row) {
  const where = `${row.provider} ${row.capability} ${row.control}`;
  if ("deepEqual" in row) {
    assert.deepStrictEqual(actual, row.deepEqual, `${where}: wire value mismatch`);
  } else if ("equals" in row) {
    assert.strictEqual(actual, row.equals, `${where}: wire value mismatch`);
  } else if ("includes" in row) {
    assert.ok(
      typeof actual === "string" && actual.includes(row.includes),
      `${where}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(row.includes)}`,
    );
  } else if ("excludes" in row) {
    assert.ok(
      typeof actual === "string" && !actual.includes(row.excludes),
      `${where}: expected ${JSON.stringify(actual)} to exclude ${JSON.stringify(row.excludes)}`,
    );
  } else if ("recentDateDays" in row) {
    const ms = new Date(actual).getTime();
    const toleranceDays = row.recentDateDays + 1; // clock skew slack
    assert.ok(
      Number.isFinite(ms) && Math.abs(Date.now() - ms) <= toleranceDays * 24 * 60 * 60 * 1000,
      `${where}: expected a recent date, got ${JSON.stringify(actual)}`,
    );
  } else {
    assert.fail(`${where}: row has no check`);
  }
}

function isUnsupportedOptionErrorFor(row) {
  return (err) =>
    err instanceof UnsupportedOptionError &&
    err.provider === row.provider &&
    err.capability === row.capability &&
    err.option === row.control;
}

async function runRow(row) {
  const harness = makeHarness(row.provider, row.capability);
  const capability = getCapability(harness.adapter, row.capability);
  const request = buildRequest(row);

  if (row.expect === "rejected") {
    // validate() rejects with the exact UnsupportedOptionError...
    assert.throws(
      () => capability.validate(request),
      isUnsupportedOptionErrorFor(row),
      `${row.provider} ${row.capability} ${row.control} must be rejected by validate()`,
    );
    // ...and invoke() re-throws it before any transport access.
    await assert.rejects(
      () => capability.invoke(request),
      isUnsupportedOptionErrorFor(row),
      `${row.provider} ${row.capability} ${row.control} must also be rejected by invoke()`,
    );
    assert.strictEqual(
      harness.calls.length,
      0,
      `${row.provider} ${row.capability} ${row.control}: rejection must precede transport access`,
    );
    return;
  }

  if (row.expect === "consumed") {
    const result = await capability.invoke(request);
    if (row.on === "result") {
      applyCheck(getPath(result, row.path), row);
      return;
    }
    if (row.on === "timer") {
      // Wire-observable for controls wired to the client abort budget:
      // the delay the transport armed its abort timer with.
      const delays = harness.timerDelays ?? [];
      assert.ok(
        delays.length > 0,
        `${row.provider} ${row.capability} ${row.control}: expected an armed client-side timer`,
      );
      applyCheck(delays[delays.length - 1], row);
      return;
    }
    const capture = pickCapture(harness, row.pick);
    switch (row.on) {
      case "body":
        applyCheck(getPath(capture.body, row.path), row);
        break;
      case "header":
        applyCheck(capture.headers[row.path], row);
        break;
      case "url":
        applyCheck(capture.url, row);
        break;
      case "query":
        applyCheck(new URL(capture.url).searchParams.get(row.path), row);
        break;
      case "args":
        applyCheck(getPath(capture.args, row.path), row);
        break;
      default:
        assert.fail(`unknown consume target ${row.on}`);
    }
    return;
  }

  if (row.expect === "documented-strip") {
    // Intentional contract: accepted, completed, stripped from the wire,
    // AND disclosed by a stderr warning. All four legs asserted.
    capability.validate(request); // must NOT throw
    const writes = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
    try {
      // Production sequence: the shared executor computes the cache
      // identity (where the disclosure fires) before invoking.
      capability.cacheIdentity(request);
      await capability.invoke(request); // must resolve
    } finally {
      process.stderr.write = realWrite;
    }
    const capture = pickCapture(harness, row.pick);
    const serialized = JSON.stringify([
      capture.url,
      capture.headers,
      capture.body ?? capture.bodyText,
      capture.args,
    ]).toLowerCase();
    assert.ok(
      !serialized.includes(row.absentToken.toLowerCase()),
      `${row.provider} ${row.capability} ${row.control}: documented-strip requires the control to stay off the wire`,
    );
    assert.ok(
      writes.some((w) => /ignoring unsupported option/i.test(w) && w.toLowerCase().includes(row.absentToken.toLowerCase())),
      `${row.provider} ${row.capability} ${row.control}: documented-strip requires the stderr disclosure naming the stripped option; got ${JSON.stringify(writes)}`,
    );
    return;
  }

  if (row.expect === "dropped") {
    // Characterized finding: accepted by validate, completed by invoke,
    // but provably absent from the wire. If this row ever fails, the
    // control was fixed — upgrade it to rejected/consumed.
    const finding = FINDINGS_BY_ID.get(row.finding);
    assert.ok(finding, `row references unknown finding ${row.finding}`);
    assert.strictEqual(
      `${finding.provider}:${finding.capability}:${finding.control}`,
      `${row.provider}:${row.capability}:${row.control}`,
      "dropped row must match its FINDINGS entry",
    );
    capability.validate(request); // must NOT throw
    await capability.invoke(request); // must resolve
    const capture = pickCapture(harness, row.pick);
    const serialized = JSON.stringify([
      capture.url,
      capture.headers,
      capture.body ?? capture.bodyText,
      capture.args,
    ]).toLowerCase();
    assert.ok(
      !serialized.includes(row.absentToken.toLowerCase()),
      `${row.provider} ${row.capability} ${row.control}: still dropped (accepted but absent ` +
        `from the wire) — finding ${row.finding}. If this control was fixed to reject or ` +
        `consume, upgrade this row instead of deleting the finding.`,
    );
    return;
  }

  assert.fail(`unknown expectation ${row.expect}`);
}

// ---------------------------------------------------------------------------
// The table. One row per (provider, control); extra rows only where the
// outcome is value-dependent (documented in the row's `note`).
// ---------------------------------------------------------------------------

const ROWS = [
  // ----- zai / search -----------------------------------------------------
  {
    provider: "zai",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "args",
    path: "search_domain_filter",
    equals: "example.com",
  },
  {
    provider: "zai",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "args",
    path: "search_recency_filter",
    equals: "oneWeek",
  },
  {
    provider: "zai",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "args",
    path: "content_size",
    equals: "high",
  },
  {
    provider: "zai",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "consumed",
    on: "args",
    path: "location",
    equals: "us",
  },
  {
    provider: "zai",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "args",
    path: "search_query",
    includes: "latest news",
  },
  {
    provider: "zai",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- zai / reader — every option is a native WebReader arg -------------
  {
    provider: "zai",
    capability: "reader",
    control: "format",
    input: { format: "text" },
    expect: "consumed",
    on: "args",
    path: "return_format",
    equals: "text",
  },
  {
    provider: "zai",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: false },
    expect: "consumed",
    on: "args",
    path: "retain_images",
    equals: false,
  },
  {
    provider: "zai",
    capability: "reader",
    control: "withLinksSummary",
    input: { withLinksSummary: true },
    expect: "consumed",
    on: "args",
    path: "with_links_summary",
    equals: true,
  },
  {
    provider: "zai",
    capability: "reader",
    control: "noGfm",
    input: { noGfm: true },
    expect: "consumed",
    on: "args",
    path: "no_gfm",
    equals: true,
  },
  {
    provider: "zai",
    capability: "reader",
    control: "keepImgDataUrl",
    input: { keepImgDataUrl: true },
    expect: "consumed",
    on: "args",
    path: "keep_img_data_url",
    equals: true,
  },
  {
    provider: "zai",
    capability: "reader",
    control: "withImagesSummary",
    input: { withImagesSummary: true },
    expect: "consumed",
    on: "args",
    path: "with_images_summary",
    equals: true,
  },
  {
    provider: "zai",
    capability: "reader",
    control: "timeout",
    input: { timeout: 20 },
    expect: "consumed",
    on: "args",
    path: "timeout",
    equals: 20,
  },

  // ----- minimax / search — everything except topic is rejected ------------
  {
    provider: "minimax",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "rejected",
  },
  {
    provider: "minimax",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "rejected",
  },
  {
    provider: "minimax",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "rejected",
  },
  {
    provider: "minimax",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "rejected",
  },
  {
    provider: "minimax",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "body",
    path: "q",
    includes: "latest news",
  },
  {
    provider: "minimax",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- tavily / search ---------------------------------------------------
  {
    provider: "tavily",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "include_domains",
    deepEqual: ["example.com"],
  },
  {
    provider: "tavily",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "body",
    path: "time_range",
    equals: "week",
  },
  {
    provider: "tavily",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "body",
    path: "search_depth",
    equals: "advanced",
  },
  {
    provider: "tavily",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "rejected",
  },
  {
    provider: "tavily",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "body",
    path: "topic",
    equals: "news",
  },
  {
    provider: "tavily",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- tavily / reader ---------------------------------------------------
  {
    provider: "tavily",
    capability: "reader",
    control: "format",
    input: { format: "text" },
    expect: "consumed",
    on: "body",
    path: "format",
    equals: "text",
  },
  {
    provider: "tavily",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: false },
    expect: "consumed",
    on: "result",
    path: "content",
    excludes: "![",
  },
  {
    provider: "tavily",
    capability: "reader",
    control: "withLinksSummary",
    input: { withLinksSummary: true },
    expect: "rejected",
  },
  {
    provider: "tavily",
    capability: "reader",
    control: "noGfm",
    input: { noGfm: true },
    expect: "rejected",
  },
  {
    provider: "tavily",
    capability: "reader",
    control: "keepImgDataUrl",
    input: { keepImgDataUrl: true },
    expect: "rejected",
  },
  {
    provider: "tavily",
    capability: "reader",
    control: "withImagesSummary",
    input: { withImagesSummary: true },
    expect: "rejected",
  },
  {
    provider: "tavily",
    capability: "reader",
    control: "timeout",
    input: { timeout: 20 },
    expect: "consumed",
    on: "body",
    path: "timeout",
    equals: 20,
  },

  // ----- tavily / research — all four controls ride the create POST --------
  {
    provider: "tavily",
    capability: "research",
    control: "model",
    input: { model: "pro" },
    expect: "consumed",
    on: "body",
    path: "model",
    equals: "pro",
    pick: { method: "POST", urlIncludes: "/research" },
  },
  {
    provider: "tavily",
    capability: "research",
    control: "outputLength",
    input: { outputLength: "long" },
    expect: "consumed",
    on: "body",
    path: "output_length",
    equals: "long",
    pick: { method: "POST", urlIncludes: "/research" },
  },
  {
    provider: "tavily",
    capability: "research",
    control: "citationFormat",
    input: { citationFormat: "apa" },
    expect: "consumed",
    on: "body",
    path: "citation_format",
    equals: "apa",
    pick: { method: "POST", urlIncludes: "/research" },
  },
  {
    provider: "tavily",
    capability: "research",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "include_domains",
    deepEqual: ["example.com"],
    pick: { method: "POST", urlIncludes: "/research" },
  },

  // ----- exa / search ------------------------------------------------------
  {
    provider: "exa",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "includeDomains",
    deepEqual: ["example.com"],
  },
  {
    provider: "exa",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "body",
    path: "startPublishedDate",
    recentDateDays: 7,
  },
  {
    provider: "exa",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "body",
    path: "type",
    equals: "deep",
  },
  {
    provider: "exa",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "consumed",
    on: "body",
    path: "userLocation",
    equals: "us",
  },
  {
    provider: "exa",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "body",
    path: "category",
    equals: "news",
  },
  {
    provider: "exa",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- exa / reader ------------------------------------------------------
  {
    provider: "exa",
    capability: "reader",
    control: "format",
    input: { format: "text" },
    expect: "consumed",
    on: "result",
    path: "contentFormat",
    equals: "text",
  },
  {
    provider: "exa",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: false },
    expect: "consumed",
    on: "result",
    path: "content",
    excludes: "![",
  },
  {
    provider: "exa",
    capability: "reader",
    control: "withLinksSummary",
    input: { withLinksSummary: true },
    expect: "rejected",
  },
  {
    provider: "exa",
    capability: "reader",
    control: "noGfm",
    input: { noGfm: true },
    expect: "rejected",
  },
  {
    provider: "exa",
    capability: "reader",
    control: "keepImgDataUrl",
    input: { keepImgDataUrl: true },
    expect: "rejected",
  },
  {
    provider: "exa",
    capability: "reader",
    control: "withImagesSummary",
    input: { withImagesSummary: true },
    expect: "rejected",
  },
  {
    provider: "exa",
    capability: "reader",
    control: "timeout",
    input: { timeout: 20 },
    expect: "consumed",
    on: "body",
    path: "livecrawlTimeout",
    equals: 20000,
  },

  // ----- exa / research — model maps to effort; the rest are stripped ------
  {
    provider: "exa",
    capability: "research",
    control: "model",
    input: { model: "pro" },
    expect: "consumed",
    on: "body",
    path: "effort",
    equals: "high",
    pick: { method: "POST", urlIncludes: "/agent/runs" },
  },
  {
    provider: "exa",
    capability: "research",
    control: "outputLength",
    input: { outputLength: "long" },
    expect: "documented-strip",
    absentToken: "outputlength",
    pick: { method: "POST", urlIncludes: "/agent/runs" },
  },
  {
    provider: "exa",
    capability: "research",
    control: "citationFormat",
    input: { citationFormat: "apa" },
    expect: "documented-strip",
    absentToken: "citationformat",
    pick: { method: "POST", urlIncludes: "/agent/runs" },
  },
  {
    provider: "exa",
    capability: "research",
    control: "domain",
    input: { domain: "example.com" },
    expect: "documented-strip",
    absentToken: "domain",
    pick: { method: "POST", urlIncludes: "/agent/runs" },
  },

  // ----- brave / search — every control honored; type is an endpoint switch -
  {
    provider: "brave",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "query",
    path: "q",
    includes: "site:example.com",
  },
  {
    provider: "brave",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "query",
    path: "freshness",
    equals: "pw",
  },
  {
    provider: "brave",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "url",
    includes: "/res/v1/llm/context",
  },
  {
    provider: "brave",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "consumed",
    on: "query",
    path: "country",
    equals: "US",
  },
  {
    provider: "brave",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "url",
    includes: "/res/v1/news/search",
  },
  {
    provider: "brave",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "consumed",
    on: "url",
    includes: "/res/v1/videos/search",
  },

  // ----- firecrawl / search ------------------------------------------------
  {
    provider: "firecrawl",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "includeDomains",
    deepEqual: ["example.com"],
  },
  {
    provider: "firecrawl",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "body",
    path: "tbs",
    equals: "qdr:w",
  },
  {
    provider: "firecrawl",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "body",
    path: "scrapeOptions",
    deepEqual: { formats: ["markdown"] },
  },
  {
    provider: "firecrawl",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "rejected",
  },
  {
    provider: "firecrawl",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "body",
    path: "sources",
    deepEqual: [{ type: "news" }],
  },
  {
    provider: "firecrawl",
    capability: "search",
    control: "topic",
    input: { topic: "finance" },
    expect: "rejected",
    note: "value-dependent: news is consumed (row above), finance has no native source",
  },
  {
    provider: "firecrawl",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- firecrawl / reader ------------------------------------------------
  {
    provider: "firecrawl",
    capability: "reader",
    control: "format",
    input: { format: "text" },
    expect: "consumed",
    on: "body",
    path: "formats",
    deepEqual: ["text"],
  },
  {
    provider: "firecrawl",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: false },
    expect: "consumed",
    on: "body",
    path: "removeBase64Images",
    equals: true,
  },
  {
    provider: "firecrawl",
    capability: "reader",
    control: "withLinksSummary",
    input: { withLinksSummary: true },
    expect: "rejected",
  },
  {
    provider: "firecrawl",
    capability: "reader",
    control: "noGfm",
    input: { noGfm: true },
    expect: "rejected",
  },
  {
    provider: "firecrawl",
    capability: "reader",
    control: "keepImgDataUrl",
    input: { keepImgDataUrl: true },
    expect: "rejected",
  },
  {
    provider: "firecrawl",
    capability: "reader",
    control: "withImagesSummary",
    input: { withImagesSummary: true },
    expect: "rejected",
  },
  {
    provider: "firecrawl",
    capability: "reader",
    control: "timeout",
    input: { timeout: 20 },
    expect: "consumed",
    on: "timer",
    equals: 20000,
  },

  // ----- jina / search -----------------------------------------------------
  {
    provider: "jina",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "header",
    path: "X-Site",
    equals: "example.com",
  },
  {
    provider: "jina",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "rejected",
  },
  {
    provider: "jina",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "rejected",
  },
  {
    provider: "jina",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "consumed",
    on: "body",
    path: "gl",
    equals: "us",
  },
  {
    provider: "jina",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "url",
    includes: "latest%20news",
  },
  {
    provider: "jina",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- jina / reader — options ride documented X-* headers ---------------
  {
    provider: "jina",
    capability: "reader",
    control: "format",
    input: { format: "text" },
    expect: "consumed",
    on: "header",
    path: "X-Return-Format",
    equals: "text",
  },
  {
    provider: "jina",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: false },
    expect: "consumed",
    on: "header",
    path: "X-Retain-Images",
    equals: "false",
  },
  {
    provider: "jina",
    capability: "reader",
    control: "withLinksSummary",
    input: { withLinksSummary: true },
    expect: "consumed",
    on: "header",
    path: "X-With-Links-Summary",
    equals: "true",
  },
  {
    provider: "jina",
    capability: "reader",
    control: "noGfm",
    input: { noGfm: true },
    expect: "consumed",
    on: "header",
    path: "X-No-Gfm",
    equals: "true",
  },
  {
    provider: "jina",
    capability: "reader",
    control: "keepImgDataUrl",
    input: { keepImgDataUrl: true },
    expect: "consumed",
    on: "header",
    path: "X-Keep-Img-Data-Url",
    equals: "true",
  },
  {
    provider: "jina",
    capability: "reader",
    control: "withImagesSummary",
    input: { withImagesSummary: true },
    expect: "consumed",
    on: "header",
    path: "X-With-Images-Summary",
    equals: "true",
  },
  {
    provider: "jina",
    capability: "reader",
    control: "timeout",
    input: { timeout: 20 },
    expect: "consumed",
    on: "header",
    path: "X-Timeout",
    equals: "20",
  },

  // ----- jina / research ---------------------------------------------------
  {
    provider: "jina",
    capability: "research",
    control: "model",
    input: { model: "pro" },
    expect: "rejected",
  },
  {
    provider: "jina",
    capability: "research",
    control: "outputLength",
    input: { outputLength: "long" },
    expect: "rejected",
  },
  {
    provider: "jina",
    capability: "research",
    control: "citationFormat",
    input: { citationFormat: "apa" },
    expect: "rejected",
  },
  {
    provider: "jina",
    capability: "research",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "only_hostnames",
    deepEqual: ["example.com"],
    pick: { method: "POST", urlIncludes: "deepsearch" },
  },

  // ----- perplexity / search -----------------------------------------------
  {
    provider: "perplexity",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "search_domain_filter",
    deepEqual: ["example.com"],
  },
  {
    provider: "perplexity",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "body",
    path: "search_recency_filter",
    equals: "week",
  },
  {
    provider: "perplexity",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "body",
    path: "search_context_size",
    equals: "high",
  },
  {
    provider: "perplexity",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "rejected",
  },
  {
    provider: "perplexity",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "body",
    path: "query",
    includes: "latest news",
  },
  {
    provider: "perplexity",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- perplexity / research — C07 fix: all four rejected -----------------
  {
    provider: "perplexity",
    capability: "research",
    control: "model",
    input: { model: "pro" },
    expect: "rejected",
  },
  {
    provider: "perplexity",
    capability: "research",
    control: "outputLength",
    input: { outputLength: "long" },
    expect: "rejected",
  },
  {
    provider: "perplexity",
    capability: "research",
    control: "citationFormat",
    input: { citationFormat: "apa" },
    expect: "rejected",
  },
  {
    provider: "perplexity",
    capability: "research",
    control: "domain",
    input: { domain: "example.com" },
    expect: "rejected",
  },

  // ----- parallel / search -------------------------------------------------
  {
    provider: "parallel",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "advanced_settings.source_policy.include_domains",
    deepEqual: ["example.com"],
  },
  {
    provider: "parallel",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "body",
    path: "advanced_settings.source_policy.after_date",
    recentDateDays: 7,
  },
  {
    provider: "parallel",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "body",
    path: "advanced_settings.excerpt_settings.max_chars_per_result",
    equals: 5000,
  },
  {
    provider: "parallel",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "consumed",
    on: "body",
    path: "advanced_settings.location",
    equals: "us",
  },
  {
    provider: "parallel",
    capability: "search",
    control: "location",
    input: { location: "cn" },
    expect: "rejected",
    note: "value-dependent: only 'us' is honored",
  },
  {
    provider: "parallel",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "body",
    path: "search_queries.0",
    includes: "latest news",
  },
  {
    provider: "parallel",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- parallel / reader — C07/#52 fix: retainImages:false strips locally -
  {
    provider: "parallel",
    capability: "reader",
    control: "format",
    input: { format: "text" },
    expect: "rejected",
    note: "Parallel Extract always returns markdown",
  },
  {
    provider: "parallel",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: false },
    expect: "consumed",
    on: "result",
    path: "content",
    excludes: "![",
  },
  {
    provider: "parallel",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: true },
    expect: "rejected",
    note: "value-dependent: only the strip direction (false) is supported",
  },
  {
    provider: "parallel",
    capability: "reader",
    control: "withLinksSummary",
    input: { withLinksSummary: true },
    expect: "rejected",
  },
  {
    provider: "parallel",
    capability: "reader",
    control: "noGfm",
    input: { noGfm: true },
    expect: "rejected",
  },
  {
    provider: "parallel",
    capability: "reader",
    control: "keepImgDataUrl",
    input: { keepImgDataUrl: true },
    expect: "rejected",
  },
  {
    provider: "parallel",
    capability: "reader",
    control: "withImagesSummary",
    input: { withImagesSummary: true },
    expect: "rejected",
  },
  {
    provider: "parallel",
    capability: "reader",
    control: "timeout",
    input: { timeout: 20 },
    expect: "consumed",
    on: "body",
    path: "advanced_settings.fetch_policy.timeout_seconds",
    equals: 20,
  },

  // ----- parallel / research — steering via task_spec -----------------------
  {
    provider: "parallel",
    capability: "research",
    control: "model",
    input: { model: "pro" },
    expect: "consumed",
    on: "body",
    path: "processor",
    equals: "ultra",
    pick: { method: "POST", urlIncludes: "/v1/tasks/runs" },
  },
  {
    provider: "parallel",
    capability: "research",
    control: "outputLength",
    input: { outputLength: "short" },
    expect: "consumed",
    on: "body",
    path: "task_spec.output_schema.description",
    includes: "concise",
    pick: { method: "POST", urlIncludes: "/v1/tasks/runs" },
  },
  {
    provider: "parallel",
    capability: "research",
    control: "citationFormat",
    input: { citationFormat: "apa" },
    expect: "consumed",
    on: "body",
    path: "task_spec.output_schema.description",
    includes: "APA",
    pick: { method: "POST", urlIncludes: "/v1/tasks/runs" },
  },
  {
    provider: "parallel",
    capability: "research",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "source_policy.include_domains",
    deepEqual: ["example.com"],
    pick: { method: "POST", urlIncludes: "/v1/tasks/runs" },
  },

  // ----- you / search — every control rides the /v1/search POST body ------
  {
    provider: "you",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "include_domains",
    deepEqual: ["example.com"],
  },
  {
    provider: "you",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "body",
    path: "freshness",
    equals: "week",
  },
  {
    provider: "you",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "body",
    path: "extraction.extraction_mode",
    equals: "full_page",
  },
  {
    provider: "you",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "consumed",
    on: "body",
    path: "country",
    equals: "US",
  },
  {
    provider: "you",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "body",
    path: "query",
    includes: "latest news",
  },
  {
    provider: "you",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },

  // ----- you / reader ------------------------------------------------------
  {
    provider: "you",
    capability: "reader",
    control: "format",
    input: { format: "text" },
    expect: "rejected",
  },
  {
    provider: "you",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: false },
    expect: "rejected",
  },
  {
    provider: "you",
    capability: "reader",
    control: "withLinksSummary",
    input: { withLinksSummary: true },
    expect: "rejected",
  },
  {
    provider: "you",
    capability: "reader",
    control: "noGfm",
    input: { noGfm: true },
    expect: "rejected",
  },
  {
    provider: "you",
    capability: "reader",
    control: "keepImgDataUrl",
    input: { keepImgDataUrl: true },
    expect: "rejected",
  },
  {
    provider: "you",
    capability: "reader",
    control: "withImagesSummary",
    input: { withImagesSummary: true },
    expect: "rejected",
  },
  {
    provider: "you",
    capability: "reader",
    control: "timeout",
    input: { timeout: 20 },
    expect: "consumed",
    on: "body",
    path: "crawl_timeout",
    equals: 20,
  },

  // ----- you / research — model and domain mapped; format/length rejected ---
  {
    provider: "you",
    capability: "research",
    control: "model",
    input: { model: "pro" },
    expect: "consumed",
    on: "body",
    path: "research_effort",
    equals: "deep",
  },
  {
    provider: "you",
    capability: "research",
    control: "outputLength",
    input: { outputLength: "short" },
    expect: "rejected",
  },
  {
    provider: "you",
    capability: "research",
    control: "citationFormat",
    input: { citationFormat: "numeric" },
    expect: "rejected",
  },
  {
    provider: "you",
    capability: "research",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "source_control.include_domains",
    deepEqual: ["example.com"],
  },

  // ----- linkup / search - includeDomains, date window, q-appends, depth
  {
    provider: "linkup",
    capability: "search",
    control: "domain",
    input: { domain: "example.com" },
    expect: "consumed",
    on: "body",
    path: "includeDomains",
    deepEqual: ["example.com"],
  },
  {
    provider: "linkup",
    capability: "search",
    control: "recency",
    input: { recency: "oneWeek" },
    expect: "consumed",
    on: "body",
    path: "fromDate",
    recentDateDays: 7,
  },
  {
    provider: "linkup",
    capability: "search",
    control: "contentSize",
    input: { contentSize: "high" },
    expect: "consumed",
    on: "body",
    path: "depth",
    equals: "deep",
  },
  {
    provider: "linkup",
    capability: "search",
    control: "location",
    input: { location: "us" },
    expect: "consumed",
    on: "body",
    path: "q",
    includes: "us",
  },
  {
    provider: "linkup",
    capability: "search",
    control: "topic",
    input: { topic: "news" },
    expect: "consumed",
    on: "body",
    path: "q",
    includes: "news",
  },
  {
    provider: "linkup",
    capability: "search",
    control: "type",
    input: { type: "video" },
    expect: "rejected",
  },
  // ----- linkup / reader - renderJs wired to /fetch; no-wire-equivalent
  // controls rejected (no accept-and-drop)
  {
    provider: "linkup",
    capability: "reader",
    control: "renderJs",
    input: { renderJs: false },
    expect: "consumed",
    on: "body",
    path: "renderJs",
    equals: false,
  },
  {
    provider: "linkup",
    capability: "reader",
    control: "format",
    input: { format: "text" },
    expect: "rejected",
  },
  {
    provider: "linkup",
    capability: "reader",
    control: "retainImages",
    input: { retainImages: false },
    expect: "rejected",
  },
  {
    provider: "linkup",
    capability: "reader",
    control: "withLinksSummary",
    input: { withLinksSummary: true },
    expect: "rejected",
  },
  {
    provider: "linkup",
    capability: "reader",
    control: "noGfm",
    input: { noGfm: true },
    expect: "rejected",
  },
  {
    provider: "linkup",
    capability: "reader",
    control: "keepImgDataUrl",
    input: { keepImgDataUrl: true },
    expect: "rejected",
  },
  {
    provider: "linkup",
    capability: "reader",
    control: "withImagesSummary",
    input: { withImagesSummary: true },
    expect: "rejected",
  },
  {
    provider: "linkup",
    capability: "reader",
    control: "timeout",
    input: { timeout: 20 },
    expect: "consumed",
    on: "timer",
    equals: 20000,
  },
  // ----- linkup / research - model maps to reasoningDepth, others rejected
  {
    provider: "linkup",
    capability: "research",
    control: "model",
    input: { model: "pro" },
    expect: "consumed",
    on: "body",
    path: "reasoningDepth",
    equals: "XL",
    pick: { method: "POST", urlIncludes: "/research" },
  },
  {
    provider: "linkup",
    capability: "research",
    control: "outputLength",
    input: { outputLength: "long" },
    expect: "rejected",
  },
  {
    provider: "linkup",
    capability: "research",
    control: "citationFormat",
    input: { citationFormat: "apa" },
    expect: "rejected",
  },
  {
    provider: "linkup",
    capability: "research",
    control: "domain",
    input: { domain: "example.com" },
    expect: "rejected",
  },
];

// ---------------------------------------------------------------------------
// Table integrity: the findings registry and the dropped rows must agree,
// and every dropped row must reference a real finding (no silent skips).
// ---------------------------------------------------------------------------

describe("controls class-guard — table integrity", () => {
  it("every finding is referenced by exactly one dropped row and vice versa", () => {
    const droppedRows = ROWS.filter((r) => r.expect === "dropped");
    const referenced = new Set(droppedRows.map((r) => r.finding));
    for (const finding of FINDINGS) {
      assert.ok(
        referenced.has(finding.id),
        `finding ${finding.id} (${finding.provider} ${finding.capability} ` +
          `${finding.control}) has no dropped row`,
      );
    }
    for (const row of droppedRows) {
      assert.ok(FINDINGS_BY_ID.has(row.finding), `dropped row references unknown finding`);
    }
    assert.strictEqual(droppedRows.length, FINDINGS.length);
  });

  it("covers every documented control for every provider that ships the capability", () => {
    const SEARCH_CONTROLS = ["domain", "recency", "contentSize", "location", "topic", "type"];
    const READER_CONTROLS = [
      "format",
      "retainImages",
      "withLinksSummary",
      "noGfm",
      "keepImgDataUrl",
      "withImagesSummary",
      "timeout",
    ];
    const RESEARCH_CONTROLS = ["model", "outputLength", "citationFormat", "domain"];
    const COVERAGE = {
      zai: { search: SEARCH_CONTROLS, reader: READER_CONTROLS },
      minimax: { search: SEARCH_CONTROLS },
      tavily: { search: SEARCH_CONTROLS, reader: READER_CONTROLS, research: RESEARCH_CONTROLS },
      exa: { search: SEARCH_CONTROLS, reader: READER_CONTROLS, research: RESEARCH_CONTROLS },
      brave: { search: SEARCH_CONTROLS },
      firecrawl: { search: SEARCH_CONTROLS, reader: READER_CONTROLS },
      jina: { search: SEARCH_CONTROLS, reader: READER_CONTROLS, research: RESEARCH_CONTROLS },
      perplexity: { search: SEARCH_CONTROLS, research: RESEARCH_CONTROLS },
      parallel: { search: SEARCH_CONTROLS, reader: READER_CONTROLS, research: RESEARCH_CONTROLS },
      you: { search: SEARCH_CONTROLS, reader: READER_CONTROLS, research: RESEARCH_CONTROLS },
      linkup: { search: SEARCH_CONTROLS, reader: READER_CONTROLS, research: RESEARCH_CONTROLS },
    };
    for (const [provider, capabilities] of Object.entries(COVERAGE)) {
      for (const [capability, controls] of Object.entries(capabilities)) {
        for (const control of controls) {
          assert.ok(
            ROWS.some(
              (r) =>
                r.provider === provider && r.capability === capability && r.control === control,
            ),
            `missing row for ${provider} ${capability} ${control}`,
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The guard itself: one generated test per row.
// ---------------------------------------------------------------------------

describe("controls class-guard — reject or consume, never silently drop", () => {
  for (const row of ROWS) {
    const variant =
      row.note ? ` [${JSON.stringify(row.input[row.control])}]` : "";
    it(`${row.expect} | ${row.provider} ${row.capability} ${row.control}${variant}`, async () => {
      await runRow(row);
    });
  }
});
