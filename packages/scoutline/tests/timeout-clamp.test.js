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
 * count guard below. A resolver the table has never heard of is caught
 * by the "source-sweep guard #233" describe below: any src file whose
 * line combines `parseInt` with a `*_TIMEOUT` identifier must import
 * `clampTimeoutMs`.
 *
 * Teeth are by mutation — reverting one provider's clamp (restoring
 * its ad-hoc `Number.isFinite(raw) && raw > 0 ? raw : DEFAULT` return)
 * must fail exactly that provider's row.
 *
 * Providers WITHOUT a `*_TIMEOUT` env resolver (fixed-constant
 * timeouts, nothing user-overridable to clamp) are intentionally absent
 * from this table: the media fetch constants (zai/media.ts,
 * minimax/media.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { clampTimeoutMs, TIMEOUT_MS_MAX } from "../dist/lib/timeout.js";
import * as zaiMcpClient from "../dist/lib/mcp-client.js";
import * as zaiCodeModeClient from "../dist/lib/code-mode.js";
import { loadConfig } from "../dist/lib/config.js";
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
import * as spiderClient from "../dist/providers/spider/client.js";
import * as arxivClient from "../dist/providers/arxiv/client.js";
import * as crossrefClient from "../dist/providers/crossref/client.js";
import * as pubmedClient from "../dist/providers/pubmed/client.js";
import * as europepmcClient from "../dist/providers/europepmc/client.js";
import * as openalexClient from "../dist/providers/openalex/client.js";

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
    provider: "spider",
    envVar: "SPIDER_TIMEOUT",
    resolve: spiderClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "arxiv",
    envVar: "ARXIV_TIMEOUT",
    resolve: arxivClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "crossref",
    envVar: "CROSSREF_TIMEOUT",
    resolve: crossrefClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "pubmed",
    envVar: "PUBMED_TIMEOUT",
    resolve: pubmedClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "europepmc",
    envVar: "EUROPEPMC_TIMEOUT",
    resolve: europepmcClient.resolveTimeoutMs,
    defaultMs: 30000,
  },
  {
    provider: "openalex",
    envVar: "OPENALEX_TIMEOUT",
    resolve: openalexClient.resolveTimeoutMs,
    defaultMs: 30000,
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
  {
    // loadConfig requires a credential; every row spreads the test key
    // first so the Z_AI_TIMEOUT override is the only variable.
    provider: "zai-config-loadconfig",
    envVar: "Z_AI_TIMEOUT",
    resolve: (env) => loadConfig({ Z_AI_API_KEY: "clamp-conformance-key", ...env }).timeout,
    defaultMs: 30000,
  },
];

describe("cross-provider timeout clamp conformance (#214)", () => {
  it("covers every provider that ships a *_TIMEOUT env resolver", () => {
    // Guardrail against accidental row loss: 27 resolver rows across 24
    // modules — 21 provider client modules (jina, perplexity, and
    // minimax contribute two resolvers each; you contributes the legacy
    // YDC alias row; the five science suppliers and spider add one each),
    // the two shared Z.AI lib clients (mcp-client, code-mode), and
    // loadConfig's inline Z_AI_TIMEOUT parse. A resolver added to the
    // codebase but not to this table is NOT caught here — extend the
    // table whenever a client gains a *_TIMEOUT env resolver.
    assert.equal(RESOLVER_ROWS.length, 27);
    const providers = new Set(RESOLVER_ROWS.map((r) => r.provider));
    assert.equal(providers.size, 27);
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

// ---------------------------------------------------------------------------
// Source-sweep guard (#233): the table above pins only the resolvers it
// lists. This sweep walks src/**/*.ts and asserts that every file with a
// line combining `parseInt` with a `*_TIMEOUT` identifier actually USES
// `clampTimeoutMs` at the match site — not merely imports it (an import
// can be a dead binding; NIT-1). A matched line counts as clamped iff:
//
//   (a) `clampTimeoutMs(` appears on the matched line itself —
//       src/lib/mcp-client.ts:93:
//       `return clampTimeoutMs(parseIntOrDefault(env.Z_AI_TIMEOUT, ...), ...);`
//   (b) `clampTimeoutMs(` appears on the matched line +1 or +2 — the
//       dominant shape, all 21 provider-style resolvers, e.g.
//       src/providers/brave/client.ts:86:
//       `const raw = parseInt(env.BRAVE_TIMEOUT || ..., 10);`
//       then `return clampTimeoutMs(raw, DEFAULT_TIMEOUT_MS);`
//   (c) the immediately preceding line ends with `clampTimeoutMs(` —
//       src/lib/config.ts:71-72, where the parseInt opens the clamp
//       call's argument list. The ends-with-`(` requirement excludes an
//       adjacent sibling resolver's already-closed
//       `return clampTimeoutMs(raw, DEFAULT);` line from satisfying a
//       different unclamped resolver two lines above (the
//       adjacent-resolver false-green).
//
// A NEW provider client that parses a *_TIMEOUT env var without
// clamping therefore fails deterministically here.
//
// Known honest gap (documented, not fixed): src/lib/code-mode.ts reads
// Z_AI_TIMEOUT on a line separate from its parseInt call, so a same-line
// sweep does not match that file — it clamps anyway (verified by the
// zai-code-mode rows above). The sweep is a guard (matched ⇒ must clamp),
// not a proof of coverage.
describe("source-sweep guard #233 (parseInt-on-*_TIMEOUT must use clampTimeoutMs)", () => {
  const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
  const LINE_RE = /parseInt/;
  const TIMEOUT_ID_RE = /[A-Z][A-Z0-9_]*_TIMEOUT/;
  const CALL_RE = /clampTimeoutMs\s*\(/;
  const CALL_OPEN_END_RE = /clampTimeoutMs\s*\(\s*$/;

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
        ? [full]
        : [];
    });

  const sweep = () => {
    const offenders = [];
    for (const file of walk(srcRoot)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const matching = lines
        .map((text, i) => ({ text, line: i + 1 }))
        .filter(({ text }) => LINE_RE.test(text) && TIMEOUT_ID_RE.test(text));
      if (matching.length === 0) continue;
      const unclamped = matching.filter(({ line }) => {
        const i = line - 1;
        // (a) clamp call on the matched line, or (b) on the matched line +1/+2.
        if (
          CALL_RE.test(lines[i]) ||
          CALL_RE.test(lines[i + 1] || "") ||
          CALL_RE.test(lines[i + 2] || "")
        ) {
          return false;
        }
        // (c) the preceding line opens the clamp call's argument list (ends
        // with `clampTimeoutMs(`) — a closed sibling call does not count.
        return !CALL_OPEN_END_RE.test(lines[i - 1] || "");
      });
      if (unclamped.length > 0) {
        offenders.push({
          file: relative(srcRoot, file).split(sep).join("/"),
          lines: unclamped.map(({ text, line }) => `${line}: ${text.trim()}`),
        });
      }
    }
    return offenders;
  };

  it("every parseInt-on-*_TIMEOUT match site uses clampTimeoutMs", () => {
    const offenders = sweep();
    assert.deepStrictEqual(
      offenders,
      [],
      `Files parse a *_TIMEOUT value without a clampTimeoutMs( call at the match site:\n${offenders
        .map((o) => `  ${o.file}\n${o.lines.map((l) => `    ${l}`).join("\n")}`)
        .join("\n")}`,
    );
  });

  it("sweep still matches the canary files (rot-to-zero guard)", () => {
    const matched = new Set();
    for (const file of walk(srcRoot)) {
      const content = fs.readFileSync(file, "utf8");
      if (
        content.split("\n").some((text) => LINE_RE.test(text) && TIMEOUT_ID_RE.test(text))
      ) {
        matched.add(relative(srcRoot, file).split(sep).join("/"));
      }
    }
    for (const canary of ["providers/firecrawl/client.ts", "lib/config.ts"]) {
      assert.ok(
        matched.has(canary),
        `canary ${canary} no longer matched by the sweep — pattern rotted?`,
      );
    }
  });
});
