/**
 * Cross-provider timeout upper-clamp conformance (#214).
 *
 * `setTimeout` treats delays above the 32-bit signed maximum
 * (2,147,483,647 ms ≈ 24.8 days) as an immediate-fire 1 ms timer, so
 * every provider client's `*_TIMEOUT` env resolver must clamp the
 * parsed override to that bound. Linkup pioneered the clamp inline;
 * #214 lifts it into the shared `clampTimeoutMs` helper
 * (`src/lib/timeout.ts`) and makes every resolver use it.
 *
 * This table is the guardrail for every resolver it lists: reverting a
 * listed resolver's clamp fails its row, and dropping a row fails the
 * count guard below. It cannot catch a resolver it has never heard of —
 * a new client must add its row here when it gains a *_TIMEOUT env
 * resolver.
 *
 * Teeth are by mutation — reverting one provider's clamp (restoring
 * its ad-hoc `Number.isFinite(raw) && raw > 0 ? raw : DEFAULT` return)
 * must fail exactly that provider's row.
 *
 * Providers WITHOUT a `*_TIMEOUT` env resolver (fixed-constant
 * timeouts, nothing user-overridable to clamp) are intentionally absent
 * from this table: spider, the five science suppliers (arXiv,
 * OpenAlex, Crossref, PubMed, Europe PMC), and the media fetch
 * constants (zai/media.ts, minimax/media.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampTimeoutMs, TIMEOUT_MS_MAX } from "../dist/lib/timeout.js";
import * as zaiMcpClient from "../dist/lib/mcp-client.js";
import * as zaiCodeModeClient from "../dist/lib/code-mode.js";
import * as braveClient from "../dist/providers/brave/client.js";
import * as exaClient from "../dist/providers/exa/client.js";
import * as jinaClient from "../dist/providers/jina/client.js";
import * as perplexityClient from "../dist/providers/perplexity/client.js";
import * as tavilyClient from "../dist/providers/tavily/client.js";
import * as minimaxCodingPlanClient from "../dist/providers/minimax/coding-plan-client.js";
import * as minimaxQuotaClient from "../dist/providers/minimax/quota-client.js";
import * as kagiClient from "../dist/providers/kagi/client.js";
import * as zaiMonitorClient from "../dist/providers/zai/monitor-client.js";
import * as bochaClient from "../dist/providers/bocha/client.js";
import * as searchapiClient from "../dist/providers/searchapi/client.js";
import * as linkupClient from "../dist/providers/linkup/client.js";
import * as parallelClient from "../dist/providers/parallel/client.js";
import * as firecrawlClient from "../dist/providers/firecrawl/client.js";
import * as youClient from "../dist/providers/you/client.js";

const TIMEOUT_MAX = 2147483647;

describe("clampTimeoutMs shared helper (#214)", () => {
  it("exposes the setTimeout 32-bit signed maximum", () => {
    assert.equal(TIMEOUT_MS_MAX, TIMEOUT_MAX);
  });

  it("clamps out-of-range positive values to the max", () => {
    assert.equal(clampTimeoutMs(9999999999, 30000), TIMEOUT_MAX);
    assert.equal(clampTimeoutMs(TIMEOUT_MAX + 1, 30000), TIMEOUT_MAX);
  });

  it("passes in-range positive values through unchanged", () => {
    assert.equal(clampTimeoutMs(1, 30000), 1);
    assert.equal(clampTimeoutMs(45000, 30000), 45000);
    assert.equal(clampTimeoutMs(TIMEOUT_MAX, 30000), TIMEOUT_MAX);
  });

  it("falls to the provider default for NaN, zero, and negative inputs", () => {
    assert.equal(clampTimeoutMs(Number.NaN, 30000), 30000);
    assert.equal(clampTimeoutMs(0, 30000), 30000);
    assert.equal(clampTimeoutMs(-5000, 30000), 30000);
    assert.equal(clampTimeoutMs(Number.POSITIVE_INFINITY, 30000), 30000);
  });
});

/**
 * One row per `*_TIMEOUT` env resolver across every provider client.
 * `resolve` takes a NodeJS.ProcessEnv-like record and returns the
 * effective timeout in milliseconds.
 */
const RESOLVER_ROWS = [
  {
    provider: "brave",
    envVar: "BRAVE_TIMEOUT",
    resolve: braveClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  { provider: "exa", envVar: "EXA_TIMEOUT", resolve: exaClient.resolveTimeoutMs, defaultMs: 30000 },
  {
    provider: "jina",
    envVar: "JINA_TIMEOUT",
    resolve: jinaClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "jina-deepsearch",
    envVar: "JINA_DEEPSEARCH_TIMEOUT",
    resolve: jinaClient.resolveDeepSearchTimeoutMs,
    defaultMs: 120000,
  },
  {
    provider: "perplexity",
    envVar: "PERPLEXITY_TIMEOUT",
    resolve: perplexityClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "perplexity-research",
    envVar: "PERPLEXITY_RESEARCH_TIMEOUT",
    resolve: perplexityClient.resolveResearchTimeoutMs,
    defaultMs: 300000,
  },
  {
    provider: "tavily",
    envVar: "TAVILY_TIMEOUT",
    resolve: tavilyClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "minimax-coding-plan",
    envVar: "MINIMAX_TIMEOUT",
    resolve: minimaxCodingPlanClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "minimax-quota",
    envVar: "MINIMAX_TIMEOUT",
    resolve: minimaxQuotaClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "kagi",
    envVar: "KAGI_TIMEOUT",
    resolve: kagiClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "zai-monitor",
    envVar: "Z_AI_TIMEOUT",
    resolve: zaiMonitorClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "bocha",
    envVar: "BOCHA_TIMEOUT",
    resolve: bochaClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "searchapi",
    envVar: "SEARCHAPI_TIMEOUT",
    resolve: searchapiClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "linkup",
    envVar: "LINKUP_TIMEOUT",
    resolve: linkupClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "parallel",
    envVar: "PARALLEL_TIMEOUT",
    resolve: parallelClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "firecrawl",
    envVar: "FIRECRAWL_TIMEOUT",
    resolve: firecrawlClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "you-research",
    envVar: "YOU_RESEARCH_TIMEOUT",
    resolve: youClient.resolveResearchTimeoutMs,
    defaultMs: 300000,
  },
  {
    provider: "you-research-legacy-alias",
    envVar: "YDC_RESEARCH_TIMEOUT",
    resolve: youClient.resolveResearchTimeoutMs,
    defaultMs: 300000,
  },
  {
    provider: "zai-mcp",
    envVar: "Z_AI_TIMEOUT",
    resolve: zaiMcpClient.resolveZaiMcpTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "zai-code-mode",
    envVar: "Z_AI_TIMEOUT",
    resolve: zaiCodeModeClient.resolveCodeModeTimeoutMs,
    defaultMs: 30000,
  },
];

describe("cross-provider timeout clamp conformance (#214)", () => {
  it("covers every provider that ships a *_TIMEOUT env resolver", () => {
    // Guardrail against accidental row loss: 20 resolver rows across 17
    // modules — 15 provider client modules (jina, perplexity, and
    // minimax contribute two resolvers each; you contributes the legacy
    // YDC alias row) plus the two shared Z.AI lib clients (mcp-client,
    // code-mode). A resolver added to the codebase but not to this table
    // is NOT caught here — extend the table whenever a client gains a
    // *_TIMEOUT env resolver.
    assert.equal(RESOLVER_ROWS.length, 20);
    const providers = new Set(RESOLVER_ROWS.map((r) => r.provider));
    assert.equal(providers.size, 20);
  });

  for (const row of RESOLVER_ROWS) {
    describe(`${row.provider} (${row.envVar})`, () => {
      it("clamps an out-of-range override to the setTimeout 32-bit max", () => {
        assert.equal(
          row.resolve({ [row.envVar]: "9999999999" }),
          TIMEOUT_MAX,
          `${row.provider}: ${row.envVar}=9999999999 must clamp to ${TIMEOUT_MAX} (setTimeout treats larger delays as 1 ms)`,
        );
      });

      it("falls to the provider default when the override is absent", () => {
        assert.equal(row.resolve({}), row.defaultMs);
      });

      it("falls to the provider default on invalid (non-numeric) input", () => {
        assert.equal(row.resolve({ [row.envVar]: "not-a-number" }), row.defaultMs);
      });

      it("falls to the provider default on zero and negative input", () => {
        assert.equal(row.resolve({ [row.envVar]: "0" }), row.defaultMs);
        assert.equal(row.resolve({ [row.envVar]: "-30000" }), row.defaultMs);
      });

      it("passes a sane in-range override through unchanged", () => {
        assert.equal(row.resolve({ [row.envVar]: "45000" }), 45000);
      });
    });
  }
});
