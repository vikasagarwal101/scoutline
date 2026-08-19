/**
 * Characterization suite for diagnostics probe-error normalization (issue #57).
 *
 * Every provider diagnostics module carries a module-private
 * `normalizeProbeError`. This suite pins the OBSERVABLE mapping of that
 * function for all seven providers through the only public seam —
 * `create<DiagnosticsCapability>(...).invoke({ probe: true })` — by
 * injecting a failing `transport.fetch` and asserting the surfaced
 * error class, message, statusCode, help, and retryability.
 *
 * These are PINS of current behavior: they pass at HEAD and fail only
 * if a shared-factory refactor changes observable semantics.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createBraveDiagnosticsCapability } from "../dist/providers/brave/diagnostics.js";
import { createExaDiagnosticsCapability } from "../dist/providers/exa/diagnostics.js";
import { createFirecrawlDiagnosticsCapability } from "../dist/providers/firecrawl/diagnostics.js";
import { createJinaDiagnosticsCapability } from "../dist/providers/jina/diagnostics.js";
import { createParallelDiagnosticsCapability } from "../dist/providers/parallel/diagnostics.js";
import { createPerplexityDiagnosticsCapability } from "../dist/providers/perplexity/diagnostics.js";
import { createTavilyDiagnosticsCapability } from "../dist/providers/tavily/diagnostics.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
} from "../dist/lib/errors.js";

const TEST_KEY = "scoutline-test-key-DO-NOT-LEAK";

function statusFetch(status, body = '{"detail":{"error":"msg"}}') {
  return async () => ({
    ok: false,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
    headers: { get: () => null },
  });
}

function throwingFetch(error) {
  return async () => {
    throw error;
  };
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function assertSurfaced(thrown, expect) {
  assert.ok(
    thrown instanceof expect.cls,
    `surfaced class: expected ${expect.cls.name}, got ${thrown?.constructor?.name} ("${thrown?.message}")`,
  );
  if (expect.message !== undefined) {
    assert.equal(thrown.message, expect.message);
  }
  if (expect.messagePattern !== undefined) {
    assert.match(thrown.message, expect.messagePattern);
  }
  if (expect.statusCode !== undefined) {
    assert.equal(thrown.statusCode, expect.statusCode);
  }
  if (expect.helpIncludes !== undefined) {
    assert.ok(
      (thrown.help ?? "").includes(expect.helpIncludes),
      `help "${thrown.help}" must include "${expect.helpIncludes}"`,
    );
  }
  if (expect.retryable !== undefined) {
    assert.equal(thrown.retryable, expect.retryable);
  }
}

function timeoutCase(helpEnvVar) {
  return {
    name: "fetch throws AbortError -> TimeoutError",
    fetch: throwingFetch(abortError()),
    expect: { cls: TimeoutError, messagePattern: /^Request timed out after \d+ms$/, helpIncludes: helpEnvVar },
  };
}

const PROVIDERS = [
  {
    id: "brave",
    factory: createBraveDiagnosticsCapability,
    keyEnv: { BRAVE_SEARCH_API_KEY: TEST_KEY },
    cases: [
      {
        name: "HTTP 401 -> AuthError pass-through",
        fetch: statusFetch(401),
        expect: { cls: AuthError, message: "Brave authentication failed", helpIncludes: "BRAVE_SEARCH_API_KEY" },
      },
      {
        name: "HTTP 429 -> QuotaError pass-through (terminal)",
        fetch: statusFetch(429),
        expect: {
          cls: QuotaError,
          message: "Brave quota exhausted. Check your Brave plan rate limits.",
          helpIncludes: "scoutline quota --provider brave",
          retryable: false,
        },
      },
      {
        name: "transport-thrown QuotaError -> QuotaError pass-through",
        fetch: throwingFetch(new QuotaError("probe quota marker", "probe quota help")),
        expect: { cls: QuotaError, message: "probe quota marker", helpIncludes: "probe quota help", retryable: false },
      },
      {
        name: "generic Error -> ApiError(\"Brave request failed\", 500)",
        fetch: throwingFetch(new Error("boom")),
        expect: { cls: ApiError, message: "Brave request failed", statusCode: 500 },
      },
      {
        name: "connection-refused -> NetworkError(\"Brave network error\")",
        fetch: throwingFetch(new Error("fetch failed: ECONNREFUSED")),
        expect: { cls: NetworkError, message: "Brave network error" },
      },
      timeoutCase("BRAVE_TIMEOUT"),
    ],
  },
  {
    id: "exa",
    factory: createExaDiagnosticsCapability,
    keyEnv: { EXA_API_KEY: TEST_KEY },
    cases: [
      {
        name: "HTTP 401 -> AuthError pass-through",
        fetch: statusFetch(401),
        expect: { cls: AuthError, message: "Exa authentication failed", helpIncludes: "EXA_API_KEY" },
      },
      {
        name: "HTTP 402 -> QuotaError pass-through (terminal)",
        fetch: statusFetch(402),
        expect: {
          cls: QuotaError,
          message: "Exa quota exhausted. Top up credits on the Exa dashboard.",
          helpIncludes: "dashboard.exa.ai",
          retryable: false,
        },
      },
      {
        name: "transport-thrown QuotaError -> QuotaError pass-through",
        fetch: throwingFetch(new QuotaError("probe quota marker", "probe quota help")),
        expect: { cls: QuotaError, message: "probe quota marker", helpIncludes: "probe quota help", retryable: false },
      },
      {
        name: "generic Error -> ApiError(\"Exa request failed\", 500)",
        fetch: throwingFetch(new Error("boom")),
        expect: { cls: ApiError, message: "Exa request failed", statusCode: 500 },
      },
      {
        name: "connection-refused -> NetworkError(\"Exa network error\")",
        fetch: throwingFetch(new Error("fetch failed: ECONNREFUSED")),
        expect: { cls: NetworkError, message: "Exa network error" },
      },
      timeoutCase("EXA_TIMEOUT"),
    ],
  },
  {
    id: "firecrawl",
    factory: createFirecrawlDiagnosticsCapability,
    keyEnv: { FIRECRAWL_API_KEY: TEST_KEY },
    cases: [
      {
        name: "HTTP 401 -> AuthError pass-through",
        fetch: statusFetch(401),
        expect: { cls: AuthError, message: "Firecrawl authentication failed", helpIncludes: "FIRECRAWL_API_KEY" },
      },
      {
        name: "HTTP 402 -> QuotaError pass-through (terminal)",
        fetch: statusFetch(402),
        expect: {
          cls: QuotaError,
          message: "Firecrawl plan credits exhausted",
          helpIncludes: "firecrawl.dev",
          retryable: false,
        },
      },
      {
        name: "transport-thrown QuotaError -> QuotaError pass-through",
        fetch: throwingFetch(new QuotaError("probe quota marker", "probe quota help")),
        expect: { cls: QuotaError, message: "probe quota marker", helpIncludes: "probe quota help", retryable: false },
      },
      {
        name: "generic Error -> ApiError(\"Firecrawl request failed\", 500)",
        fetch: throwingFetch(new Error("boom")),
        expect: { cls: ApiError, message: "Firecrawl request failed", statusCode: 500 },
      },
      {
        name: "connection-refused -> NetworkError(\"Firecrawl network error\")",
        fetch: throwingFetch(new Error("fetch failed: ECONNREFUSED")),
        expect: { cls: NetworkError, message: "Firecrawl network error" },
      },
      timeoutCase("FIRECRAWL_TIMEOUT"),
    ],
  },
  {
    id: "jina",
    factory: createJinaDiagnosticsCapability,
    keyEnv: { JINA_API_KEY: TEST_KEY },
    cases: [
      {
        name: "HTTP 401 -> AuthError pass-through",
        fetch: statusFetch(401),
        expect: { cls: AuthError, message: "Jina AI authentication failed", helpIncludes: "JINA_API_KEY" },
      },
      {
        name: "HTTP 429 -> QuotaError pass-through (terminal)",
        fetch: statusFetch(429),
        expect: {
          cls: QuotaError,
          message: "Jina AI rate limit exceeded.",
          helpIncludes: "upgrade your Jina AI plan",
          retryable: false,
        },
      },
      {
        name: "transport-thrown QuotaError -> QuotaError pass-through",
        fetch: throwingFetch(new QuotaError("probe quota marker", "probe quota help")),
        expect: { cls: QuotaError, message: "probe quota marker", helpIncludes: "probe quota help", retryable: false },
      },
      {
        name: "generic Error -> NetworkError(\"Jina AI request failed: boom\")",
        fetch: throwingFetch(new Error("boom")),
        expect: { cls: NetworkError, message: "Jina AI request failed: boom" },
      },
      {
        name: "connection-refused -> NetworkError with chained message",
        fetch: throwingFetch(new Error("fetch failed: ECONNREFUSED")),
        expect: { cls: NetworkError, message: "Jina AI request failed: fetch failed: ECONNREFUSED" },
      },
      timeoutCase("JINA_TIMEOUT"),
    ],
  },
  {
    id: "parallel",
    factory: createParallelDiagnosticsCapability,
    keyEnv: { PARALLEL_API_KEY: TEST_KEY },
    cases: [
      {
        name: "HTTP 401 -> AuthError pass-through",
        fetch: statusFetch(401),
        expect: { cls: AuthError, message: "Parallel AI authentication failed", helpIncludes: "PARALLEL_API_KEY" },
      },
      {
        name: "HTTP 402 -> QuotaError pass-through (terminal)",
        fetch: statusFetch(402),
        expect: {
          cls: QuotaError,
          message: "Parallel AI quota exhausted. Insufficient account credit.",
          helpIncludes: "parallel.ai",
          retryable: false,
        },
      },
      {
        name: "transport-thrown QuotaError -> QuotaError pass-through",
        fetch: throwingFetch(new QuotaError("probe quota marker", "probe quota help")),
        expect: { cls: QuotaError, message: "probe quota marker", helpIncludes: "probe quota help", retryable: false },
      },
      {
        name: "generic Error -> NetworkError(\"Parallel AI request failed: boom\")",
        fetch: throwingFetch(new Error("boom")),
        expect: { cls: NetworkError, message: "Parallel AI request failed: boom" },
      },
      {
        name: "connection-refused -> NetworkError with chained message",
        fetch: throwingFetch(new Error("fetch failed: ECONNREFUSED")),
        expect: { cls: NetworkError, message: "Parallel AI request failed: fetch failed: ECONNREFUSED" },
      },
      {
        name: "HTTP 422 ValidationError -> probe fallback ApiError(\"Parallel AI diagnostics probe failed\", 500)",
        fetch: statusFetch(422),
        expect: { cls: ApiError, message: "Parallel AI diagnostics probe failed", statusCode: 500 },
      },
      timeoutCase("PARALLEL_TIMEOUT"),
    ],
  },
  {
    id: "perplexity",
    factory: createPerplexityDiagnosticsCapability,
    keyEnv: { PERPLEXITY_API_KEY: TEST_KEY },
    cases: [
      {
        name: "HTTP 401 -> AuthError pass-through",
        fetch: statusFetch(401),
        expect: { cls: AuthError, message: "Perplexity authentication failed", helpIncludes: "PERPLEXITY_API_KEY" },
      },
      {
        name: "HTTP 429 -> ApiError(\"Perplexity rate limit exceeded\", 429), NOT QuotaError",
        fetch: statusFetch(429),
        expect: { cls: ApiError, message: "Perplexity rate limit exceeded", statusCode: 429 },
      },
      {
        name: "transport-thrown QuotaError -> NetworkError (quota class NOT passed through)",
        fetch: throwingFetch(new QuotaError("probe quota marker", "probe quota help")),
        expect: { cls: NetworkError, message: "Perplexity search failed: probe quota marker" },
      },
      {
        name: "generic Error -> NetworkError(\"Perplexity search failed: boom\")",
        fetch: throwingFetch(new Error("boom")),
        expect: { cls: NetworkError, message: "Perplexity search failed: boom" },
      },
      {
        name: "connection-refused -> NetworkError with chained message",
        fetch: throwingFetch(new Error("fetch failed: ECONNREFUSED")),
        expect: { cls: NetworkError, message: "Perplexity search failed: fetch failed: ECONNREFUSED" },
      },
      timeoutCase("PERPLEXITY_TIMEOUT"),
    ],
  },
  {
    id: "tavily",
    factory: createTavilyDiagnosticsCapability,
    keyEnv: { TAVILY_API_KEY: TEST_KEY },
    cases: [
      {
        name: "HTTP 401 -> AuthError pass-through",
        fetch: statusFetch(401),
        expect: { cls: AuthError, message: "Tavily authentication failed", helpIncludes: "TAVILY_API_KEY" },
      },
      {
        name: "HTTP 429 -> ApiError(\"Tavily rate limit exceeded\", 429), NOT QuotaError",
        fetch: statusFetch(429),
        expect: { cls: ApiError, message: "Tavily rate limit exceeded", statusCode: 429 },
      },
      {
        name: "transport-thrown QuotaError -> ApiError(\"Tavily request failed\", 500) (quota class NOT passed through)",
        fetch: throwingFetch(new QuotaError("probe quota marker", "probe quota help")),
        expect: { cls: ApiError, message: "Tavily request failed", statusCode: 500 },
      },
      {
        name: "generic Error -> ApiError(\"Tavily request failed\", 500)",
        fetch: throwingFetch(new Error("boom")),
        expect: { cls: ApiError, message: "Tavily request failed", statusCode: 500 },
      },
      {
        name: "connection-refused -> NetworkError(\"Tavily network error\")",
        fetch: throwingFetch(new Error("fetch failed: ECONNREFUSED")),
        expect: { cls: NetworkError, message: "Tavily network error" },
      },
      timeoutCase("TAVILY_TIMEOUT"),
    ],
  },
];

for (const spec of PROVIDERS) {
  describe(`[${spec.id}] diagnostics probe error mapping`, () => {
    for (const testCase of spec.cases) {
      it(testCase.name, async () => {
        const capability = spec.factory({
          env: { ...spec.keyEnv },
          transport: { fetch: testCase.fetch },
        });
        let thrown;
        try {
          await capability.invoke({ probe: true });
        } catch (error) {
          thrown = error;
        }
        assert.ok(thrown !== undefined, "invoke({probe:true}) must reject");
        assertSurfaced(thrown, testCase.expect);
      });
    }

    it("missing API key -> ConfigurationError naming the env var, fetch untouched", async () => {
      let fetchCalls = 0;
      const capability = spec.factory({
        env: {},
        transport: {
          fetch: async () => {
            fetchCalls += 1;
            return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
          },
        },
      });
      let thrown;
      try {
        await capability.invoke({ probe: true });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown !== undefined, "invoke must reject without a key");
      assertSurfaced(thrown, {
        cls: ConfigurationError,
        helpIncludes: Object.keys(spec.keyEnv)[0],
      });
      assert.equal(thrown.message.includes(Object.keys(spec.keyEnv)[0]), true);
      assert.equal(fetchCalls, 0, "fetch must not be called without a key");
    });
  });
}
