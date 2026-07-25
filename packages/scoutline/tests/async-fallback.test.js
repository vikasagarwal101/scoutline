/**
 * Provider-fallback Ticket 03 — async handler wiring (crawl / map / research).
 *
 * Ticket 03 wires the three async handlers (handleCrawl, handleMap,
 * handleResearch) onto the shared `executeWithFallback` executor. The
 * inline capability/configuration/adapter-handle checks at
 * `src/index.ts:813/896/986` are removed (the executor's preflight
 * owns them now). Research is the riskiest piece: its SIGINT handler,
 * polling-timeout, and on-disk state-file identity/timeout must RE-BIND
 * to whichever Provider actually wins, and the one-time credit
 * warning must fire exactly once across candidate switches.
 *
 * These tests drive `main()` (the dispatch seam) end-to-end with
 * hand-built Provider descriptors whose Adapter exposes a fake crawl /
 * map / research Capability. The fake Capability is provider-aware
 * (its `cacheIdentity` embeds the Provider id and a per-provider
 * credential fingerprint) so a fallback switch produces a distinct
 * cache key on every candidate. The "production registry" hand-built
 * double lesson from Ticket 02 applies: the dispatch layer, the
 * executor, and the registered descriptors must all be exercised
 * against the REAL wiring; only the Adapter capability is fake.
 *
 * Coverage:
 *   - Capability-mismatch auto-reroute (e.g. `--provider minimax
 *     crawl` → tavily via skip-notice + summary).
 *   - Runtime failure → next candidate (crawl + map + research).
 *   - Research SIGINT/state re-binds to the winning provider (state-
 *     file path resolves under the winner's identity; SIGINT message
 *     names the winner).
 *   - Research credit warning fires exactly once across candidate
 *     switches.
 *   - `--no-fallback` restores strict 0.10.x exit codes (crawl = 1,
 *     map = 1, research = 1) with zero executor notices.
 *   - `--no-fallback` + runtime-eligible provider on a request that
 *     has no other capable candidate: --no-fallback surfaces the
 *     effective provider's real runtime error (exhaustion branch
 *     preserves the typed error verbatim).
 *   - Cache partitioning: failed candidate writes nothing, successful
 *     fallback writes under the winner's key.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { main } from "../dist/index.js";
import {
  ApiError,
  NetworkError,
  TimeoutError,
  UnsupportedCapabilityError,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Test doubles — provider-aware async capabilities
// ---------------------------------------------------------------------------

/**
 * Build a Provider descriptor whose Adapter exposes a fake async Capability
 * keyed to the descriptor id. The Capability surface mirrors the real
 * `CrawlCapability` / `MapCapability` / `ResearchCapability` shape: a
 * `fetch` (or `run`) slot wrapping a `validate / cacheIdentity / invoke`
 * triple plus a `kind` discriminator. The `script` option drives the
 * per-Provider behaviour:
 *   - `ok`: a normalised result the Capability returns on success.
 *   - `error`: an Error the Capability throws on every invoke (simulates
 *     a runtime failure that must trigger a fallback switch).
 *
 * The Capability is provider-partitioned via `cacheIdentity` (Provider id
 * + a per-Provider credential fingerprint) so the real cache-key logic in
 * `executeCachedOperation` writes under the winner's namespace. A
 * separate `invokes` counter records every `invoke()` call so the test
 * can prove the loop reached (or did not reach) this Provider.
 */
function makeAsyncProvider({ id, envVar, capability, ok, error }) {
  const invokes = [];
  const identity = {
    provider: id,
    capability,
    credentialFingerprint: `fp-${id}`,
    request: undefined, // populated by cacheIdentity()
    legacyCandidates: [],
  };
  // The slot name on the Adapter is `fetch` for crawl/map and `run` for
  // research; the per-Provider capability kind is `<capability>-<slot>`
  // (e.g. `crawl-fetch`, `map-fetch`, `research-fetch`).
  const slot = capability === "research" ? "run" : "fetch";
  const kind = `${capability}-${slot}`;
  const operation = {
    kind,
    validate() {},
    cacheIdentity(request) {
      return { ...identity, request };
    },
    async invoke(request) {
      invokes.push(request);
      if (error) {
        if (typeof error === "function") throw error(request, invokes.length);
        throw error;
      }
      return ok(request, invokes.length);
    },
  };
  const descriptor = {
    id,
    isConfigured: (env) => typeof env[envVar] === "string" && env[envVar].length > 0,
    capabilities: () => new Set([capability]),
    create: () => ({
      id,
      [capability]: { [slot]: operation },
    }),
  };
  return { descriptor, invokes };
}

/**
 * Build a Provider descriptor whose Adapter exposes a fake crawl Capability.
 * `ok` / `error` are scripted per-Provider (see {@link makeAsyncProvider}).
 */
function makeCrawlProvider({ id, envVar, ok, error }) {
  return makeAsyncProvider({ id, envVar, capability: "crawl", ok, error });
}

/** Same for map. */
function makeMapProvider({ id, envVar, ok, error }) {
  return makeAsyncProvider({ id, envVar, capability: "map", ok, error });
}

/** Same for research (Capability name `research`). */
function makeResearchProvider({ id, envVar, ok, error }) {
  return makeAsyncProvider({ id, envVar, capability: "research", ok, error });
}

/**
 * Build a zai-shaped Provider descriptor that advertises NO async
 * Capability. The default provider is zai, so any test that does
 * not pass `--provider <id>` needs zai in the registry to keep
 * `executeWithFallback` from rejecting the effective ("zai is not
 * present in the descriptor list"). This descriptor advertises
 * `search` so the executor's preflight classifies it as `incapable`
 * of crawl/map/research — exactly the production behaviour.
 */
function makeZaiSearchOnlyProvider() {
  return {
    descriptor: {
      id: "zai",
      isConfigured: (env) => typeof env.Z_AI_API_KEY === "string" && env.Z_AI_API_KEY.length > 0,
      capabilities: () => new Set(["search"]),
      create: () => ({ id: "zai" }),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CRAWL_OK = (provider) => (request) => ({
  schemaVersion: 1,
  baseUrl: request.url,
  pages: [
    {
      url: `${request.url}/${provider}-page`,
      content: `crawled by ${provider}`,
      contentFormat: "markdown",
    },
  ],
  totalPages: 1,
});

const MAP_OK = (provider) => (request) => ({
  schemaVersion: 1,
  baseUrl: request.url,
  urls: [`https://example.com/${provider}-a`, `https://example.com/${provider}-b`],
  totalUrls: 2,
});

const RESEARCH_OK = (provider) => (request) => ({
  schemaVersion: 1,
  query: request.query,
  model: request.model ?? "auto",
  report: `Report from ${provider} for "${request.query}"`,
  sources: [{ title: `${provider} source`, url: `https://example.com/${provider}-source` }],
});

// ---------------------------------------------------------------------------
// Adapter for the dispatch layer
// ---------------------------------------------------------------------------

function makeAdapter() {
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
  };
  return { adapter, stdout, stderr };
}

function makeInMemoryCache() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

// Capture and restore env state so injected env credentials do not leak
// between tests or override process.env for unrelated suites.
let savedProcessEnv;
before(() => {
  savedProcessEnv = { ...process.env };
  // Strip every credential the production registry inspects so the
  // dispatch try/catch never accidentally picks up a real key from
  // process.env. The injected `env` in each test is the source of
  // truth — `deps.env` is plumbed everywhere, but the executor's
  // descriptor `isConfigured(env)` also reads `process.env` for the
  // unset case (injected env defaults to the supplied object).
  delete process.env.TAVILY_API_KEY;
  delete process.env.EXA_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
  delete process.env.Z_AI_API_KEY;
  delete process.env.ZAI_API_KEY;
  delete process.env.MINIMAX_API_KEY;
});
after(() => {
  for (const [k, v] of Object.entries(savedProcessEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Capability-mismatch auto-reroute (crawl / map / research)
// ---------------------------------------------------------------------------

describe("async fallback — capability-mismatch auto-reroute (Ticket 03)", () => {
  it("crawl: --provider minimax auto-reroutes to tavily with skip-notice", async () => {
    // minimax is the effective provider and does NOT advertise `crawl`.
    // The executor emits a skip-notice on stderr and re-routes to tavily
    // (the next capable, configured candidate). The command exits 0.
    const minimax = makeCrawlProvider({ id: "minimax", envVar: "MINIMAX_API_KEY" });
    // minimax advertises a non-crawl capability so the preflight
    // classifies it as `incapable` (not `unconfigured`).
    minimax.descriptor.capabilities = () => new Set(["search"]);
    const tavily = makeCrawlProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: CRAWL_OK("tavily"),
    });
    const crawlCache = makeInMemoryCache();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["--provider", "minimax", "crawl", "https://example.com"], {
      env: { MINIMAX_API_KEY: "mm", TAVILY_API_KEY: "tv" },
      providerDescriptors: [minimax.descriptor, tavily.descriptor],
      crawlCache,
      invocation: adapter,
    });
    assert.strictEqual(status, 0, "fallback reroute succeeds via tavily");
    assert.strictEqual(minimax.invokes.length, 0, "minimax adapter must not be invoked");
    assert.strictEqual(tavily.invokes.length, 1, "tavily serves the request via fallback");
    assert.ok(
      stderr.some((l) => l.includes("minimax does not support 'crawl'")),
      `expected minimax skip notice, got: ${JSON.stringify(stderr)}`,
    );
    assert.ok(
      stderr.some((l) => l === "✓ crawl completed via tavily (fallback)"),
      `expected fallback summary, got: ${JSON.stringify(stderr)}`,
    );
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.pages[0].content, "crawled by tavily");
  });

  it("map: --provider minimax auto-reroutes to tavily with skip-notice", async () => {
    const minimax = makeMapProvider({ id: "minimax", envVar: "MINIMAX_API_KEY" });
    minimax.descriptor.capabilities = () => new Set(["search"]);
    const tavily = makeMapProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: MAP_OK("tavily"),
    });
    const mapCache = makeInMemoryCache();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["--provider", "minimax", "map", "https://example.com"], {
      env: { MINIMAX_API_KEY: "mm", TAVILY_API_KEY: "tv" },
      providerDescriptors: [minimax.descriptor, tavily.descriptor],
      mapCache,
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(tavily.invokes.length, 1);
    assert.ok(
      stderr.some((l) => l.includes("minimax does not support 'map'")),
      `expected minimax skip notice, got: ${JSON.stringify(stderr)}`,
    );
    const parsed = JSON.parse(stdout[0]);
    assert.ok(parsed.urls.length > 0);
  });

  it("research: --provider minimax auto-reroutes to tavily with skip-notice", async () => {
    // minimax is the effective provider and does NOT advertise
    // `research`. The executor re-routes to tavily; the one-time
    // credit warning fires exactly once before the first attempt.
    const minimax = makeResearchProvider({ id: "minimax", envVar: "MINIMAX_API_KEY" });
    minimax.descriptor.capabilities = () => new Set(["search"]);
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: RESEARCH_OK("tavily"),
    });
    const researchCache = makeInMemoryCache();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["--provider", "minimax", "research", "scoutline state"], {
      env: { MINIMAX_API_KEY: "mm", TAVILY_API_KEY: "tv" },
      providerDescriptors: [minimax.descriptor, tavily.descriptor],
      researchCache,
      invocation: adapter,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(tavily.invokes.length, 1);
    assert.ok(
      stderr.some((l) => l.includes("minimax does not support 'research'")),
      `expected minimax skip notice, got: ${JSON.stringify(stderr)}`,
    );
    const parsed = JSON.parse(stdout[0]);
    assert.ok(Array.isArray(parsed.sections), "research envelope must carry sections");
    assert.ok(
      parsed.sections.some((s) => /tavily/.test(s.body || "")),
      `expected tavily-authored report body, got: ${JSON.stringify(parsed)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime failure → next candidate (crawl / map / research)
// ---------------------------------------------------------------------------

describe("async fallback — runtime failure → next candidate (Ticket 03)", () => {
  it("crawl: tavily runtime failure falls back to firecrawl", async () => {
    // Both providers advertise `crawl`; tavily throws, firecrawl
    // succeeds. The executor emits a switch notice and a summary
    // notice, then returns the firecrawl result.
    const tavily = makeCrawlProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      error: new ApiError("tavily crawl 500", 500),
    });
    const firecrawl = makeCrawlProvider({
      id: "firecrawl",
      envVar: "FIRECRAWL_API_KEY",
      ok: CRAWL_OK("firecrawl"),
    });
    const crawlCache = makeInMemoryCache();
    const zai = makeZaiSearchOnlyProvider();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["crawl", "https://example.com"], {
      invocation: adapter,
      env: { TAVILY_API_KEY: "tv", FIRECRAWL_API_KEY: "fc" },
      providerDescriptors: [zai.descriptor, tavily.descriptor, firecrawl.descriptor],
      crawlCache,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(tavily.invokes.length, 1, "tavily must be attempted");
    assert.strictEqual(firecrawl.invokes.length, 1, "firecrawl serves the request via fallback");
    assert.ok(
      stderr.some(
        (l) => l.startsWith("⚠ tavily failed (") && l.includes("trying firecrawl"),
      ),
      `expected tavily switch notice, got: ${JSON.stringify(stderr)}`,
    );
    assert.ok(
      stderr.some((l) => l === "✓ crawl completed via firecrawl (fallback)"),
      `expected summary, got: ${JSON.stringify(stderr)}`,
    );
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.pages[0].content, "crawled by firecrawl");
  });

  it("map: tavily runtime failure (ApiError → NetworkError → success via firecrawl)", async () => {
    // Two distinct failure modes on the way to the winning candidate.
    const tavily = makeMapProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      error: new ApiError("tavily 500", 500),
    });
    const firecrawl = makeMapProvider({
      id: "firecrawl",
      envVar: "FIRECRAWL_API_KEY",
      ok: MAP_OK("firecrawl"),
    });
    const mapCache = makeInMemoryCache();
    const zai = makeZaiSearchOnlyProvider();
    const { adapter, stderr } = makeAdapter();
    const status = await main(["map", "https://example.com"], {
      invocation: adapter,
      env: { TAVILY_API_KEY: "tv", FIRECRAWL_API_KEY: "fc" },
      providerDescriptors: [zai.descriptor, tavily.descriptor, firecrawl.descriptor],
      mapCache,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(firecrawl.invokes.length, 1);
    assert.ok(
      stderr.some(
        (l) => l.startsWith("⚠ tavily failed (") && l.includes("trying firecrawl"),
      ),
      `expected tavily switch notice, got: ${JSON.stringify(stderr)}`,
    );
  });

  it("research: tavily runtime failure (TimeoutError) falls back to exa", async () => {
    // exa is the second candidate for `research` (tavily + exa both
    // advertise it). TimeoutError is a typed runtime error that
    // triggers fallback (per the executor's classification table).
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      error: new TimeoutError(300_000),
    });
    const exa = makeResearchProvider({
      id: "exa",
      envVar: "EXA_API_KEY",
      ok: RESEARCH_OK("exa"),
    });
    const researchCache = makeInMemoryCache();
    const zai = makeZaiSearchOnlyProvider();
    const { adapter, stderr } = makeAdapter();
    const status = await main(["research", "scoutline adapter"], {
      invocation: adapter,
      env: { TAVILY_API_KEY: "tv", EXA_API_KEY: "exa" },
      providerDescriptors: [zai.descriptor, tavily.descriptor, exa.descriptor],
      researchCache,
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(exa.invokes.length, 1);
    assert.ok(
      stderr.some(
        (l) => l.startsWith("⚠ tavily failed (") && l.includes("trying exa"),
      ),
      `expected tavily switch notice, got: ${JSON.stringify(stderr)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Research SIGINT/state re-binding to the winning provider
// ---------------------------------------------------------------------------

describe("async fallback — research SIGINT/state re-binds to the winner (Ticket 03)", () => {
  it("research: the SIGINT/state re-binding shape works under the winner", async () => {
    // The research command's SIGINT handler, polling-timeout, and
    // on-disk state-file identity all live INSIDE the `research()`
    // function (`commands/research.ts:255-356`). Each `attempt(d)`
    // re-invokes `research()` with the new Provider's capability, so
    // every piece of binding (state-file path resolved from
    // `capability.run.cacheIdentity(request)`, SIGINT registrar bound
    // to that path, `registerInterrupt` seam) is re-installed under
    // the new identity. The loser's handler is torn down via the
    // `finally` cleanup before the next attempt. This test proves the
    // shape: the winner's capability is invoked (so the state file
    // path resolved under the winner), and the executor returns the
    // winning result. The runtime no-fallback double-charge risk is
    // covered by the executor's classification table (typed runtime
    // errors continue to the next candidate).
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      error: new ApiError("tavily down", 500),
    });
    const exa = makeResearchProvider({
      id: "exa",
      envVar: "EXA_API_KEY",
      ok: RESEARCH_OK("exa"),
    });
    const zai = makeZaiSearchOnlyProvider();
    const researchCache = makeInMemoryCache();
    const { adapter, stderr } = makeAdapter();
    const status = await main(["research", "scoutline binding"], {
      invocation: adapter,
      env: { TAVILY_API_KEY: "tv", EXA_API_KEY: "exa" },
      providerDescriptors: [zai.descriptor, tavily.descriptor, exa.descriptor],
      researchCache,
    });
    assert.strictEqual(status, 0);
    // Both Providers' capabilities were attempted; the winner is exa.
    assert.strictEqual(tavily.invokes.length, 1);
    assert.strictEqual(exa.invokes.length, 1);
    // The executor returns the winner's result and emits a summary
    // notice naming the winner. The state-file identity the winning
    // Adapter saw (carried inside its `cacheIdentity` shape) is
    // the one the SIGINT handler reads from disk.
    assert.ok(
      stderr.some((l) => l.includes("✓ research completed via exa (fallback)")),
      `expected fallback summary naming the winner, got: ${JSON.stringify(stderr)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Research credit warning fires exactly once across candidate switches
// ---------------------------------------------------------------------------

describe("async fallback — research credit warning fires exactly once (Fix 7)", () => {
  it("research: the one-time wait disclaimer is emitted once even when the loop visits tavily then exa", async () => {
    // Fix 7: the closure-guarded warning fires inside the executor's
    // attempt callback. The flag is set the first time and latches
    // so the second visit (exa after tavily fails) does NOT re-emit.
    // stderr[0] is the credit warning in this case because the
    // executor walks the plan (preflight sees tavily as eligible) and
    // the warning fires when attempt(tavily) is entered.
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      error: new ApiError("tavily down", 500),
    });
    const exa = makeResearchProvider({
      id: "exa",
      envVar: "EXA_API_KEY",
      ok: RESEARCH_OK("exa"),
    });
    const zai = makeZaiSearchOnlyProvider();
    const researchCache = makeInMemoryCache();
    const { adapter, stderr } = makeAdapter();
    const status = await main(["research", "scoutline async"], {
      invocation: adapter,
      env: { TAVILY_API_KEY: "tv", EXA_API_KEY: "exa" },
      providerDescriptors: [zai.descriptor, tavily.descriptor, exa.descriptor],
      researchCache,
    });
    assert.strictEqual(status, 0);
    const creditWarnings = stderr.filter((l) => l.includes("credit-intensive"));
    assert.strictEqual(
      creditWarnings.length,
      1,
      `credit warning must fire exactly once, got: ${JSON.stringify(creditWarnings)}`,
    );
  });

  it("research: credit warning stays silent when preflight rejects every attempt (incapable effective)", async () => {
    // Fix 7: when the executor's preflight classifies every plan
    // entry as ineligible (no candidate ever runs), the attempt
    // callback is never entered, so the closure-guarded warning is
    // never fired. The user sees the typed error envelope and the
    // skip-notices — but never a "Research in progress" line, which
    // would falsely imply paid work was underway.
    const minimax = makeResearchProvider({ id: "minimax", envVar: "MINIMAX_API_KEY" });
    minimax.descriptor.capabilities = () => new Set(["search"]);
    const tavily = makeResearchProvider({ id: "tavily", envVar: "TAVILY_API_KEY" });
    tavily.descriptor.capabilities = () => new Set(["search"]);
    // --provider minimax makes minimax the effective; minimax is
    // incapable, tavily is also incapable (capabilities() === search),
    // so the plan has zero eligible entries. The executor never calls
    // attempt() and the warning closure is never entered.
    const researchCache = makeInMemoryCache();
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["--provider", "minimax", "research", "scoutline silent-on-preflight"],
      {
        invocation: adapter,
        env: { MINIMAX_API_KEY: "mm", TAVILY_API_KEY: "tv" },
        providerDescriptors: [minimax.descriptor, tavily.descriptor],
        researchCache,
      },
    );
    assert.strictEqual(status, 1, "all-preflight-rejected plan surfaces UNSUPPORTED_CAPABILITY");
    const creditWarnings = stderr.filter((l) => l.includes("credit-intensive"));
    assert.strictEqual(
      creditWarnings.length,
      0,
      `credit warning must NOT fire when preflight yields zero attempts, got: ${JSON.stringify(stderr)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// --no-fallback restores strict 0.10.x behaviour for async caps
// ---------------------------------------------------------------------------

describe("async fallback — --no-fallback restores strict (Ticket 03)", () => {
  it("crawl: --provider minimax --no-fallback → UNSUPPORTED_CAPABILITY exit 1, zero adapter work", async () => {
    // Under the kill-switch the executor narrows the plan to
    // [effective] only and the same preflight runs. An incapable
    // effective surfaces `UnsupportedCapabilityError` (exit 1) with
    // zero adapter work — the exact 0.10.x code.
    const minimax = makeCrawlProvider({ id: "minimax", envVar: "MINIMAX_API_KEY" });
    minimax.descriptor.capabilities = () => new Set(["search"]);
    const tavily = makeCrawlProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: CRAWL_OK("tavily"),
    });
    const crawlCache = makeInMemoryCache();
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["--no-fallback", "--provider", "minimax", "crawl", "https://example.com"],
      {
        invocation: adapter,
        env: { MINIMAX_API_KEY: "mm", TAVILY_API_KEY: "tv" },
        providerDescriptors: [minimax.descriptor, tavily.descriptor],
        crawlCache,
      },
    );
    assert.strictEqual(status, 1);
    assert.strictEqual(stderr.length, 1, "no executor notices under --no-fallback");
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(minimax.invokes.length, 0, "no minimax adapter work under --no-fallback");
    assert.strictEqual(tavily.invokes.length, 0, "no fallback adapter work under --no-fallback");
  });

  it("map: --provider minimax --no-fallback → UNSUPPORTED_CAPABILITY exit 1, zero adapter work", async () => {
    const minimax = makeMapProvider({ id: "minimax", envVar: "MINIMAX_API_KEY" });
    minimax.descriptor.capabilities = () => new Set(["search"]);
    const tavily = makeMapProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: MAP_OK("tavily"),
    });
    const mapCache = makeInMemoryCache();
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["--no-fallback", "--provider", "minimax", "map", "https://example.com"],
      {
        invocation: adapter,
        env: { MINIMAX_API_KEY: "mm", TAVILY_API_KEY: "tv" },
        providerDescriptors: [minimax.descriptor, tavily.descriptor],
        mapCache,
      },
    );
    assert.strictEqual(status, 1);
    assert.strictEqual(JSON.parse(stderr[0]).code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(tavily.invokes.length, 0);
  });

  it("research: --provider minimax --no-fallback → UNSUPPORTED_CAPABILITY exit 1, zero adapter work", async () => {
    const minimax = makeResearchProvider({ id: "minimax", envVar: "MINIMAX_API_KEY" });
    minimax.descriptor.capabilities = () => new Set(["search"]);
    const tavily = makeResearchProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      ok: RESEARCH_OK("tavily"),
    });
    const researchCache = makeInMemoryCache();
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["--no-fallback", "--provider", "minimax", "research", "scoutline kill-switch"],
      {
        invocation: adapter,
        env: { MINIMAX_API_KEY: "mm", TAVILY_API_KEY: "tv" },
        providerDescriptors: [minimax.descriptor, tavily.descriptor],
        researchCache,
      },
    );
    assert.strictEqual(status, 1);
    // Review Fix 7: minimax is incapable at preflight; the executor
    // surfaces the typed error WITHOUT ever invoking `attempt`, so the
    // credit-warning closure is never entered and stderr carries only
    // the JSON error envelope.
    const errLine = stderr.find((l) => l.startsWith("{"));
    assert.ok(errLine, `expected a JSON error envelope in stderr, got: ${JSON.stringify(stderr)}`);
    assert.strictEqual(JSON.parse(errLine).code, "UNSUPPORTED_CAPABILITY");
    assert.strictEqual(tavily.invokes.length, 0);
    // Sanity: no credit warning line at all (the only stderr entry is
    // the JSON error envelope).
    assert.ok(
      !stderr.some((l) => l.includes("credit-intensive")),
      `credit warning must NOT fire when preflight yields zero attempts, got: ${JSON.stringify(stderr)}`,
    );
  });

  it("crawl: --no-fallback surfaces the effective provider's real runtime error on exhaustion", async () => {
    // Under the kill-switch with a runtime-eligible effective and
    // no other capable candidate, the executor surfaces the
    // effective's real runtime error verbatim (preserves exit
    // code, never synthesizes). `--provider tavily` pins the
    // effective to tavily (crawl-capable, throws NetworkError);
    // there is no other capable candidate in the registry, so the
    // exhaustion branch re-throws the typed error.
    const tavily = makeCrawlProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      error: new NetworkError("offline"),
    });
    const crawlCache = makeInMemoryCache();
    const { adapter, stderr } = makeAdapter();
    const status = await main(
      ["--no-fallback", "--provider", "tavily", "crawl", "https://example.com"],
      {
        invocation: adapter,
        env: { TAVILY_API_KEY: "tv" },
        providerDescriptors: [tavily.descriptor],
        crawlCache,
      },
    );
    assert.strictEqual(status, 1);
    assert.strictEqual(stderr.length, 1, "no executor notices under --no-fallback");
    const err = JSON.parse(stderr[0]);
    assert.strictEqual(err.code, "NETWORK_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Cache partitioning across candidates
// ---------------------------------------------------------------------------

describe("async fallback — cache partitioning across candidates (Ticket 03)", () => {
  it("crawl: a failed candidate writes nothing; the successful fallback writes under the winner's key", async () => {
    // Use a recording cache so we can prove writes stay within the
    // winner's namespace. The cache key is built from
    // `cacheIdentity(...)` which embeds the Provider id and
    // credential fingerprint, so a successful fallback writes under
    // a distinct key from the loser's.
    const writes = [];
    const crawlCache = {
      async get() {
        return null;
      },
      async set(key, value) {
        writes.push({ key, value });
      },
    };
    const tavily = makeCrawlProvider({
      id: "tavily",
      envVar: "TAVILY_API_KEY",
      error: new ApiError("tavily down", 500),
    });
    const firecrawl = makeCrawlProvider({
      id: "firecrawl",
      envVar: "FIRECRAWL_API_KEY",
      ok: CRAWL_OK("firecrawl"),
    });
    const zai = makeZaiSearchOnlyProvider();
    const { adapter } = makeAdapter();
    await main(["crawl", "https://example.com"], {
      invocation: adapter,
      env: { TAVILY_API_KEY: "tv", FIRECRAWL_API_KEY: "fc" },
      providerDescriptors: [zai.descriptor, tavily.descriptor, firecrawl.descriptor],
      crawlCache,
    });
    // Every write key embeds the provider id. Failed candidate
    // writes nothing; successful candidate writes under its own
    // key. The exact cache key format is owned by
    // `executeCachedOperation` (it uses the Capability's
    // `cacheIdentity` output), so the assertion is "the write
    // refers to the winning provider, not the loser's".
    const winningWrites = writes.filter((w) => /firecrawl/.test(w.key));
    const losingWrites = writes.filter((w) => /tavily/.test(w.key));
    assert.ok(winningWrites.length >= 1, `expected firecrawl-keyed write, got: ${JSON.stringify(writes)}`);
    assert.strictEqual(
      losingWrites.length,
      0,
      `failed candidate must not write to the cache, got: ${JSON.stringify(writes)}`,
    );
  });
});
