/**
 * Z.AI Reader Adapter (Reader Migration Ticket 03, DESIGN.md §18).
 *
 * Verifies the production Adapter contract for the single WebReader
 * operation (`scoutline.zai.reader.webReader`).
 *
 * Scope:
 *   - total parser for the characterized WebReader object response, plus
 *     the bare-string MCP-error envelope, malformed object responses,
 *     and missing/blank field coercion;
 *   - URL rewrite (gist.github.com/<user>/<id> -> /raw) is applied by
 *     the Adapter and surfaces as `finalUrl` in the result;
 *   - encoded MCP error classification BEFORE success parsing
 *     (exhausted quota is terminal `QUOTA_ERROR`; the rest of the
 *     taxonomy uses the shared retry/terminal classification);
 *   - one credential resolution per cache identity; full SHA-256
 *     fingerprint; exact legacy candidate with the documented v0.2
 *     argument insertion order; legacy decoder uses the production
 *     parser;
 *   - raw invocation through the public dotted tool name; the fake
 *     transport resolves the public name to the discovered internal
 *     identity;
 *   - a fresh transport per uncached attempt and exactly one
 *     best-effort close in `finally`; close failure never replaces
 *     success nor masks the primary operation failure;
 *   - no raw WebReader response types leak outside the Adapter;
 *   - descriptor metadata advertises `reader` after the Ticket 04
 *     cutover (Provider selection and Doctor inventory derive from
 *     the single source of truth).
 *
 * Tests use `createZaiDescriptor` with an injected `clientFactory` so no
 * real UTCP or network is touched. The Adapter capability is reached
 * through `adapter.reader.fetch`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { getMcpToolName } from "../dist/lib/mcp-config.js";
import { buildLegacyReaderCacheKey } from "../dist/lib/cache.js";
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
import { ZAI_READER_CLOSE_BOUND_MS } from "../dist/providers/zai/reader.js";
import { FakeUtcpClient } from "./helpers/fake-utcp-client.js";

const READER_TOOL_PUBLIC_NAME = getMcpToolName("reader", "webReader");
const INTERNAL_WEB_READER = "scoutline_zai.reader.webReader";

// ---------------------------------------------------------------------------
// Fake ZaiAdapterClientPort built on top of FakeUtcpClient so the Adapter
// exercises the same discovered-name raw invocation path the production
// ZaiMcpClient exposes (mirrors zai-repository-adapter.test.js).
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

const DISCOVERED_READER_TOOLS = [
  {
    name: INTERNAL_WEB_READER,
    inputs: {
      type: "object",
      properties: {
        url: { type: "string" },
        timeout: { type: "number" },
        no_cache: { type: "boolean" },
        return_format: { type: "string", enum: ["markdown", "text"] },
        retain_images: { type: "boolean" },
        with_links_summary: { type: "boolean" },
        no_gfm: { type: "boolean" },
        keep_img_data_url: { type: "boolean" },
        with_images_summary: { type: "boolean" },
      },
      required: ["url"],
    },
    outputs: { type: "object" },
  },
];

const TEST_API_KEY = "test-zai-api-key-DO-NOT-LEAK";
const EXPECTED_FINGERPRINT = crypto.createHash("sha256").update(TEST_API_KEY).digest("hex");

// ---------------------------------------------------------------------------
// Valid WebReader object response fixture (synthesized from the
// characterization artifact's example.com probe, sanitized).
// ---------------------------------------------------------------------------

function validResponse(overrides = {}) {
  return {
    title: "Example Domain",
    url: "https://example.com/",
    content: "This domain is for use in documentation examples…",
    metadata: { viewport: "width=device-width", lang: "en" },
    external: { icon: { href: "/favicon.ico" } },
    ...overrides,
  };
}

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

// ===========================================================================
// Descriptor metadata: Reader is NOT yet advertised (Ticket 03 → Ticket 04).
// The Adapter supplies `adapter.reader`. Descriptor metadata
// advertises `reader` after the Ticket 04 cutover.
// ===========================================================================

describe("Z.AI Reader Adapter — descriptor metadata (Ticket 03 + Ticket 04)", () => {
  it("capabilities() advertises reader (Ticket 04 flipped the descriptor)", () => {
    const descriptor = createZaiDescriptor();
    const caps = descriptor.capabilities();
    // Reader Migration Ticket 04 added the `reader` literal to the
    // ProviderCapability union and to the Z.AI descriptor capabilities()
    // set. Descriptor-derived Provider selection and Doctor inventory
    // now see reader as a Z.AI-advertised Capability.
    assert.ok(
      caps.has("reader"),
      "reader must be advertised on the Z.AI descriptor after Ticket 04",
    );
  });

  it("descriptor creation is side-effect-free (no transport, no I/O)", async () => {
    const factory = makeClientFactory();
    const d = createZaiDescriptor({ clientFactory: factory });
    d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    assert.strictEqual(factory.created.length, 0);
  });

  it("create() constructs and attaches a Reader Capability handle", () => {
    const factory = makeClientFactory();
    const d = createZaiDescriptor({ clientFactory: factory });
    const adapter = d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    assert.ok(adapter.reader, "Adapter must expose a reader handle");
    assert.ok(adapter.reader.fetch, "Reader capability must expose a fetch operation");
  });
});

// ===========================================================================
// Parser — total over WebReader object/string union.
// ===========================================================================

describe("Z.AI Reader Adapter — response parser", () => {
  function makeAdapter(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, capability: adapter.reader.fetch };
  }

  it("normalizes a valid object response into the v1 envelope", async () => {
    const { capability } = makeAdapter(validResponse());
    const out = await capability.invoke({ url: "https://example.com/" });
    assert.strictEqual(out.schemaVersion, 1);
    assert.strictEqual(out.url, "https://example.com/");
    assert.strictEqual(out.finalUrl, "https://example.com/");
    assert.strictEqual(out.title, "Example Domain");
    assert.strictEqual(out.content, validResponse().content);
    assert.strictEqual(out.contentFormat, "markdown");
    // metadata and external preserved verbatim when present.
    assert.deepStrictEqual(out.metadata, validResponse().metadata);
    assert.deepStrictEqual(out.external, validResponse().external);
  });

  it("preserves an explicit request.format into contentFormat", async () => {
    const { capability } = makeAdapter(validResponse());
    const out = await capability.invoke({
      url: "https://example.com/",
      format: "text",
    });
    assert.strictEqual(out.contentFormat, "text");
  });

  it("defaults contentFormat to 'markdown' when format is absent", async () => {
    const { capability } = makeAdapter(validResponse());
    const out = await capability.invoke({ url: "https://example.com/" });
    assert.strictEqual(out.contentFormat, "markdown");
  });

  it("coerces a blank title to null", async () => {
    const { capability } = makeAdapter(validResponse({ title: "   " }));
    const out = await capability.invoke({ url: "https://example.com/" });
    assert.strictEqual(out.title, null);
  });

  it("coerces a missing title to null", async () => {
    const raw = validResponse();
    delete raw.title;
    const { capability } = makeAdapter(raw);
    const out = await capability.invoke({ url: "https://example.com/" });
    assert.strictEqual(out.title, null);
  });

  it("drops top-level description (v1 envelope does not surface it)", async () => {
    const { capability } = makeAdapter(validResponse({ description: "Page not found" }));
    const out = await capability.invoke({ url: "https://example.com/" });
    assert.ok(!("description" in out), "description must not appear on the v1 envelope");
  });

  it("preserves metadata verbatim when external is absent", async () => {
    const raw = validResponse();
    delete raw.external;
    const { capability } = makeAdapter(raw);
    const out = await capability.invoke({ url: "https://example.com/" });
    assert.deepStrictEqual(out.metadata, validResponse().metadata);
    assert.ok(!("external" in out), "external absent on response → absent on envelope");
  });

  it("drops metadata and external cleanly when both absent", async () => {
    const raw = validResponse();
    delete raw.metadata;
    delete raw.external;
    const { capability } = makeAdapter(raw);
    const out = await capability.invoke({ url: "https://example.com/" });
    assert.ok(!("metadata" in out));
    assert.ok(!("external" in out));
  });

  it("rejects an object response missing content (malformed → 502)", async () => {
    const raw = validResponse();
    delete raw.content;
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects an object response with empty content (malformed → 502)", async () => {
    const { capability } = makeAdapter(validResponse({ content: "" }));
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a non-string non-object response (number → 502)", async () => {
    const { capability } = makeAdapter(42);
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects null response (malformed → 502)", async () => {
    const { capability } = makeAdapter(null);
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects an array response (malformed → 502)", async () => {
    const { capability } = makeAdapter([validResponse()]);
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("rejects a non-string content field (object shell, malformed → 502)", async () => {
    const { capability } = makeAdapter(validResponse({ content: { raw: "x" } }));
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });

  it("treats a non-MCP-error bare string as malformed (502)", async () => {
    // The characterization shows bare strings occur only for MCP-level
    // error envelopes ("MCP error -<status>..."). Any other string is a
    // degenerate shape the Adapter must reject as malformed, not parse
    // as content.
    const { capability } = makeAdapter("just some text without an MCP error envelope");
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof ApiError && err.statusCode === 502,
    );
  });
});

// ===========================================================================
// URL rewrite (gist → raw) — applied BEFORE invocation; surfaces as
// finalUrl. Rewriting is a Z.AI-specific concern because Z.AI's WebReader
// MCP is what recognizes the rewritten URL.
// ===========================================================================

describe("Z.AI Reader Adapter — URL rewrite (gist → raw)", () => {
  function makeAdapterWith(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, adapter };
  }

  it("rewrites a gist URL to /raw and surfaces both url and finalUrl", async () => {
    const { factory, adapter } = makeAdapterWith(validResponse());
    const original = "https://gist.github.com/octocat/3ef10a5c198a473514a6";
    const out = await adapter.reader.fetch.invoke({ url: original });
    assert.strictEqual(out.url, original);
    assert.strictEqual(out.finalUrl, `${original}/raw`);
    // The Provider is invoked with the REWRITTEN url (matches v0.2
    // legacy behaviour where args.url is what was actually fetched).
    assert.strictEqual(factory.created[0].port.callToolCalls[0].args.url, `${original}/raw`);
  });

  it("strips the fragment before appending /raw and re-appends it", async () => {
    const { factory, adapter } = makeAdapterWith(validResponse());
    const original = "https://gist.github.com/octocat/abc123#file-readme-md";
    const out = await adapter.reader.fetch.invoke({ url: original });
    assert.strictEqual(out.finalUrl, "https://gist.github.com/octocat/abc123/raw#file-readme-md");
    assert.strictEqual(
      factory.created[0].port.callToolCalls[0].args.url,
      "https://gist.github.com/octocat/abc123/raw#file-readme-md",
    );
  });

  it("passes through a non-gist URL unchanged (finalUrl === url)", async () => {
    const { adapter } = makeAdapterWith(validResponse());
    const original = "https://docs.anthropic.com/en/docs";
    const out = await adapter.reader.fetch.invoke({ url: original });
    assert.strictEqual(out.url, original);
    assert.strictEqual(out.finalUrl, original);
  });

  it("is idempotent for URLs already ending in /raw", async () => {
    const { adapter } = makeAdapterWith(validResponse());
    const original = "https://gist.github.com/octocast/abc123/raw";
    const out = await adapter.reader.fetch.invoke({ url: original });
    assert.strictEqual(out.finalUrl, original);
  });

  it("does NOT rewrite github.com/owner/repo URLs (only gist)", async () => {
    const { adapter } = makeAdapterWith(validResponse());
    const original = "https://github.com/facebook/react";
    const out = await adapter.reader.fetch.invoke({ url: original });
    assert.strictEqual(out.finalUrl, original);
  });

  it("rewrites a gist URL with a query string (drops the query, preserves fragment)", async () => {
    // v0.2 behaviour: the rewrite regex matches up to but not including
    // the query string, appends `/raw`, and preserves only the fragment.
    // The query is dropped (matches the existing `maybeRewriteToRaw`
    // preserved verbatim from commands/read.ts).
    const { adapter } = makeAdapterWith(validResponse());
    const original = "https://gist.github.com/octocat/abc123?x=1";
    const out = await adapter.reader.fetch.invoke({ url: original });
    assert.strictEqual(out.finalUrl, "https://gist.github.com/octocat/abc123/raw");
  });
});

// ===========================================================================
// Encoded MCP error taxonomy (DESIGN.md §18). Recognised BEFORE any
// success parsing.
// ===========================================================================

describe("Z.AI Reader Adapter — encoded MCP error taxonomy", () => {
  function makeAdapter(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, capability: adapter.reader.fetch };
  }

  it("code 1310 (quota) maps to terminal QuotaError 429", async () => {
    const raw =
      "MCP error -429\nerror.code: 1310\nerror.message: Weekly/Monthly Limit Exhausted\nreset: 2026-08-08 06:07:26";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof QuotaError, `expected QuotaError, got ${err.constructor.name}`);
      assert.strictEqual(err.code, "QUOTA_ERROR");
      assert.strictEqual(err.statusCode, 429);
      assert.strictEqual(err.retryable, false);
      return true;
    });
  });

  it("explicit 'quota has been exhausted' message maps to terminal QuotaError regardless of status", async () => {
    const raw = "MCP error -503\nerror.code: 9999\nerror.message: Quota has been exhausted\n";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof QuotaError,
    );
  });

  it("F4: a bare 'quota' non-exhaustion message stays retryable (not QuotaError)", async () => {
    // A message containing the bare word "quota" but no exhaustion
    // indicator (e.g. "quota window reset succeeded") must NOT be
    // mis-classified as terminal QuotaError — that would block the
    // legitimate single retry. Previously the bare-substring "quota"
    // branch fired here.
    const raw = "MCP error -429\nerror.code: 9999\nerror.message: quota window reset succeeded\n";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(
        !(err instanceof QuotaError),
        `bare 'quota' must not be terminal QuotaError, got ${err.constructor.name}`,
      );
      assert.strictEqual(err.code, "API_ERROR");
      assert.strictEqual(err.statusCode, 429);
      return true;
    });
  });

  it("code 1310 under a non-429 status still becomes terminal QuotaError", async () => {
    const raw = "MCP error -500\nerror.code: 1310\nerror.message: weekly limit exhausted\n";
    const { capability } = makeAdapter(raw);
    await assert.rejects(
      capability.invoke({ url: "https://example.com/" }),
      (err) => err instanceof QuotaError,
    );
  });

  it("401 encoded error maps to terminal AuthError with exact status 401", async () => {
    const raw = "MCP error -401\nerror.code: 401\nerror.message: unauthorized\n";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof AuthError, `expected AuthError, got ${err.constructor.name}`);
      assert.strictEqual(err.code, "AUTH_ERROR");
      assert.strictEqual(err.statusCode, 401);
      assert.strictEqual(err.retryable, false);
      // Sanitized: no raw Provider body / message / help leaks.
      assert.ok(!err.message.includes("unauthorized"));
      return true;
    });
  });

  it("403 encoded error maps to terminal AUTH_ERROR with exact status 403 (P6-04A)", async () => {
    const raw = "MCP error -403\nerror.code: 403\nerror.message: forbidden\n";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.strictEqual(err.code, "AUTH_ERROR");
      assert.strictEqual(
        err.statusCode,
        403,
        "exact 403 status preserved (must NOT collapse to 401)",
      );
      assert.strictEqual(err.retryable, false, "AUTH_ERROR is terminal");
      assert.ok(!err.message.includes("forbidden"));
      return true;
    });
  });

  it("404 encoded error maps to terminal ApiError 404", async () => {
    const raw = "MCP error -404\nerror.code: 404\nerror.message: not found\n";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.strictEqual(err.statusCode, 404);
      assert.ok(!err.message.includes("not found"));
      return true;
    });
  });

  it("429 without quota signal is retryable ApiError 429", async () => {
    const raw = "MCP error -429\nerror.code: 9998\nerror.message: rate limited\n";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.strictEqual(err.statusCode, 429);
      assert.ok(!(err instanceof QuotaError), "rate limited must NOT be QuotaError");
      return true;
    });
  });

  it("500 encoded error is retryable ApiError 500", async () => {
    const raw = "MCP error -500\nerror.code: 9999\nerror.message: internal failure";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.strictEqual(err.statusCode, 500);
      return true;
    });
  });

  it("501 encoded error is retryable ApiError 501", async () => {
    const raw = "MCP error -501\nerror.code: 9999\nerror.message: not implemented";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.strictEqual(err.statusCode, 501);
      return true;
    });
  });

  it("599 encoded error is retryable ApiError 599", async () => {
    const raw = "MCP error -599\nerror.code: 9999\nerror.message: network timeout";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.strictEqual(err.statusCode, 599);
      return true;
    });
  });

  it("malformed encoded envelope (no parseable status) maps to retryable ApiError 502", async () => {
    // Recognised as an encoded MCP error by prefix but missing the
    // numeric status — the parser cannot extract a status. This is the
    // "malformed envelope" row in DESIGN.md §18.
    const raw = "MCP error -";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.strictEqual(err.statusCode, 502);
      return true;
    });
  });

  it("encoded error message is sanitized (raw text never reaches outward field)", async () => {
    const raw =
      "MCP error -429\nerror.code: 1310\nerror.message: Weekly/Monthly Limit Exhausted\nreset: 2026-08-08 06:07:26";
    const { capability } = makeAdapter(raw);
    let captured;
    try {
      await capability.invoke({ url: "https://example.com/" });
    } catch (err) {
      captured = err;
    }
    const serialized = `${captured.message} ${captured.help ?? ""}`;
    assert.ok(!serialized.includes("1310"), `code leaked: ${serialized}`);
    assert.ok(!serialized.includes("Weekly/Monthly Limit Exhausted"));
    assert.ok(!serialized.includes("reset:"));
  });

  it("bare 'rate limited' 429 stays retryable ApiError 429 (P6-04B regression)", async () => {
    const raw =
      "MCP error -429\nerror.code: 9998\nerror.message: too many requests, rate limited\n";
    const { capability } = makeAdapter(raw);
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof ApiError);
      assert.strictEqual(err.statusCode, 429);
      assert.ok(!(err instanceof QuotaError));
      return true;
    });
  });
});

// ===========================================================================
// Typed transport error preservation (P6-04A). `callToolRaw` already
// normalizes NetworkError/TimeoutError/AuthError at the lower client
// layer; the Adapter MUST pass them through unchanged so the retry
// classifier sees the original `code` and `statusCode`.
// ===========================================================================

describe("Z.AI Reader Adapter — typed transport error preservation", () => {
  function makeAdapter(error) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      errorsByName: { [INTERNAL_WEB_READER]: error },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, capability: adapter.reader.fetch };
  }

  it("NetworkError surfaces unchanged (code NETWORK_ERROR, retryable)", async () => {
    const { capability } = makeAdapter(new NetworkError("ECONNRESET"));
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof NetworkError, `got ${err.constructor.name}`);
      assert.strictEqual(err.code, "NETWORK_ERROR");
      return true;
    });
  });

  it("TimeoutError surfaces with original duration preserved", async () => {
    const originalDuration = 12345;
    const { capability } = makeAdapter(new TimeoutError(originalDuration));
    await assert.rejects(capability.invoke({ url: "https://example.com/" }), (err) => {
      assert.ok(err instanceof TimeoutError, `got ${err.constructor.name}`);
      assert.strictEqual(err.code, "TIMEOUT_ERROR");
      assert.strictEqual(err.durationMs, originalDuration);
      return true;
    });
  });
});

// ===========================================================================
// Validation — runs before any client construction.
// ===========================================================================

describe("Z.AI Reader Adapter — validation", () => {
  function makeAdapter() {
    const factory = makeClientFactory({ discoveredTools: DISCOVERED_READER_TOOLS });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, adapter };
  }

  it("rejects a non-http(s) URL before any client construction", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(adapter.reader.fetch.invoke({ url: "ftp://example.com/" }), (err) => {
      assert.ok(err instanceof ValidationError, `got ${err.constructor.name}`);
      assert.strictEqual(err.code, "VALIDATION_ERROR");
      assert.strictEqual(err.statusCode, 400);
      assert.strictEqual(err.retryable, false);
      return true;
    });
    assert.strictEqual(factory.created.length, 0);
  });

  it("rejects a non-string URL", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(
      adapter.reader.fetch.invoke({ url: 42 }),
      (err) => err instanceof ValidationError && err.statusCode === 400,
    );
    assert.strictEqual(factory.created.length, 0);
  });

  it("rejects a missing URL", async () => {
    const { factory, adapter } = makeAdapter();
    await assert.rejects(
      adapter.reader.fetch.invoke({}),
      (err) => err instanceof ValidationError && err.statusCode === 400,
    );
    assert.strictEqual(factory.created.length, 0);
  });

  it("missing credential throws ConfigurationError before any client construction", () => {
    const factory = makeClientFactory();
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({ env: {} });
    assert.throws(
      () => adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" }),
      (err) => err instanceof ConfigurationError && err.exitCode === 3,
    );
    assert.strictEqual(factory.created.length, 0);
  });
});

// ===========================================================================
// cacheIdentity — one credential resolution, full fingerprint, exact
// legacy candidate insertion order.
// ===========================================================================

describe("Z.AI Reader Adapter — cache identity", () => {
  function makeAdapter() {
    const factory = makeClientFactory();
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, adapter };
  }

  it("fingerprints the resolved credential (full lowercase SHA-256 hex)", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    assert.strictEqual(identity.provider, "zai");
    assert.strictEqual(identity.capability, "reader");
    assert.strictEqual(identity.operation, "reader-fetch");
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.strictEqual(identity.legacyCandidates.length, 1);
  });

  it("identity.request mirrors the caller request (canonical: post-rewrite URL)", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.reader.fetch.cacheIdentity({
      url: "https://gist.github.com/octocat/abc",
    });
    // The identity request is canonical: the rewritten URL is what
    // determines whether two requests fetch the same Provider content.
    assert.strictEqual(identity.request.url, "https://gist.github.com/octocat/abc/raw");
  });

  it("legacy key uses the exact v0.2 insertion order with url only (rewritten)", () => {
    const { adapter } = makeAdapter();
    const request = { url: "https://example.com/" };
    const identity = adapter.reader.fetch.cacheIdentity(request);
    const expected = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: "https://example.com/",
    });
    assert.strictEqual(identity.legacyCandidates[0].key, expected);
  });

  it("legacy key for a gist URL uses the rewritten URL in args.url", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.reader.fetch.cacheIdentity({
      url: "https://gist.github.com/octocat/abc",
    });
    const expected = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
      url: "https://gist.github.com/octocat/abc/raw",
    });
    assert.strictEqual(identity.legacyCandidates[0].key, expected);
  });

  it("legacy decoder decodes a valid raw response through the production parser", async () => {
    const { adapter } = makeAdapter();
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    // The legacy decoder must accept the raw Provider object shape and
    // produce a valid v1 envelope.
    const decoded = identity.legacyCandidates[0].decode(validResponse());
    assert.ok(decoded);
    assert.strictEqual(decoded.schemaVersion, 1);
    assert.strictEqual(decoded.title, "Example Domain");
    assert.strictEqual(decoded.content, validResponse().content);
  });

  it("legacy decoder returns null on malformed raw response", () => {
    const { adapter } = makeAdapter();
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    // Bare strings (including encoded MCP error envelopes) are malformed
    // at the Capability layer — they cannot be served as cached results.
    assert.strictEqual(identity.legacyCandidates[0].decode("MCP error -500: oops"), null);
    assert.strictEqual(identity.legacyCandidates[0].decode(null), null);
    assert.strictEqual(identity.legacyCandidates[0].decode(42), null);
    assert.strictEqual(identity.legacyCandidates[0].decode({}), null);
    // Missing required content field.
    assert.strictEqual(identity.legacyCandidates[0].decode({ title: "x", url: "x" }), null);
  });

  it("distinct URLs produce distinct cache identities (partitioning)", () => {
    const { adapter } = makeAdapter();
    const a = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/a" });
    const b = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/b" });
    assert.notStrictEqual(a.credentialFingerprint, ""); // sanity
    assert.notStrictEqual(identityRequestJson(a.request), identityRequestJson(b.request));
    assert.notStrictEqual(a.legacyCandidates[0].key, b.legacyCandidates[0].key);
  });

  it("distinct formats produce distinct cache identities", () => {
    const { adapter } = makeAdapter();
    const a = adapter.reader.fetch.cacheIdentity({
      url: "https://example.com/",
      format: "markdown",
    });
    const b = adapter.reader.fetch.cacheIdentity({
      url: "https://example.com/",
      format: "text",
    });
    assert.notStrictEqual(identityRequestJson(a.request), identityRequestJson(b.request));
  });

  it("distinct pass-through flags produce distinct cache identities", () => {
    const { adapter } = makeAdapter();
    const a = adapter.reader.fetch.cacheIdentity({
      url: "https://example.com/",
      retainImages: true,
    });
    const b = adapter.reader.fetch.cacheIdentity({
      url: "https://example.com/",
      retainImages: false,
    });
    assert.notStrictEqual(identityRequestJson(a.request), identityRequestJson(b.request));
  });

  it("identical requests produce identical cache identities", () => {
    const { adapter } = makeAdapter();
    const a = adapter.reader.fetch.cacheIdentity({
      url: "https://example.com/",
      format: "markdown",
      retainImages: false,
    });
    const b = adapter.reader.fetch.cacheIdentity({
      url: "https://example.com/",
      format: "markdown",
      retainImages: false,
    });
    assert.strictEqual(identityRequestJson(a.request), identityRequestJson(b.request));
    assert.strictEqual(a.legacyCandidates[0].key, b.legacyCandidates[0].key);
  });

  it("injected credential wins over conflicting ambient env (fingerprint proof)", () => {
    const ambient = "ambient-zai-api-key";
    const ambientFp = crypto.createHash("sha256").update(ambient).digest("hex");
    const d = createZaiDescriptor();
    const adapter = d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    assert.strictEqual(identity.credentialFingerprint, EXPECTED_FINGERPRINT);
    assert.notStrictEqual(identity.credentialFingerprint, ambientFp);
  });

  it("ZAI_API_KEY alias resolves when only the alias is set", () => {
    const aliasFp = crypto.createHash("sha256").update("alias-key").digest("hex");
    const d = createZaiDescriptor();
    const adapter = d.create({ env: { ZAI_API_KEY: "alias-key" } });
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    assert.strictEqual(identity.credentialFingerprint, aliasFp);
  });

  it("Z_AI_API_KEY takes precedence over ZAI_API_KEY (alias parity)", () => {
    const primaryFp = crypto.createHash("sha256").update("primary-key").digest("hex");
    const d = createZaiDescriptor();
    const adapter = d.create({
      env: { Z_AI_API_KEY: "primary-key", ZAI_API_KEY: "alias-key" },
    });
    const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    assert.strictEqual(identity.credentialFingerprint, primaryFp);
  });

  it("alias parity: same resolved credential produces byte-identical legacy keys", () => {
    // Z_AI_API_KEY and ZAI_API_KEY with the same resolved value must
    // produce the same legacy key (this is the property that lets v0.2
    // cache entries written under one alias remain readable under the
    // other).
    const resolved = "sk-shared-resolved-credential-XYZ";
    const a = createZaiDescriptor().create({ env: { Z_AI_API_KEY: resolved } });
    const b = createZaiDescriptor().create({ env: { ZAI_API_KEY: resolved } });
    const idA = a.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    const idB = b.reader.fetch.cacheIdentity({ url: "https://example.com/" });
    assert.strictEqual(idA.legacyCandidates[0].key, idB.legacyCandidates[0].key);
    assert.strictEqual(idA.credentialFingerprint, idB.credentialFingerprint);
  });

  it("candidate construction does not read ambient process.env (no leakage)", () => {
    const env = withEnv(
      {
        SCOUTLINE_CACHE_DIR: "/tmp/some-leaky-scoutline",
        ZAI_CACHE_DIR: "/tmp/some-leaky-cache",
        Z_AI_API_KEY: "ambient-zai-leak",
        ZAI_API_KEY: "ambient-zai-alias-leak",
      },
      () => {
        const d = createZaiDescriptor();
        const adapter = d.create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
        const identity = adapter.reader.fetch.cacheIdentity({ url: "https://example.com/" });
        const expected = buildLegacyReaderCacheKey(TEST_API_KEY, READER_TOOL_PUBLIC_NAME, {
          url: "https://example.com/",
        });
        assert.strictEqual(identity.legacyCandidates[0].key, expected);
      },
    );
    return env();
  });
});

function identityRequestJson(request) {
  return JSON.stringify(request);
}

// ===========================================================================
// Invocation — raw public dotted name; fresh client per attempt; close
// exactly once; success / primary failure precedence over close.
// ===========================================================================

describe("Z.AI Reader Adapter — invoke lifecycle", () => {
  function makeAdapter(raw) {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: raw },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    return { factory, adapter };
  }

  it("invokes through the public dotted tool name; client resolves it internally", async () => {
    const { factory, adapter } = makeAdapter(validResponse());
    await adapter.reader.fetch.invoke({ url: "https://example.com/" });
    const port = factory.created[0].port;
    assert.strictEqual(port.callToolCalls.length, 1);
    assert.strictEqual(port.callToolCalls[0].name, READER_TOOL_PUBLIC_NAME);
    assert.strictEqual(port.callToolCalls[0].args.url, "https://example.com/");
  });

  it("invoke sends url + return_format only when set (mirrors v0.2 insertion order)", async () => {
    const { factory, adapter } = makeAdapter(validResponse());
    await adapter.reader.fetch.invoke({
      url: "https://example.com/",
      format: "text",
      retainImages: false,
      withLinksSummary: true,
    });
    const args = factory.created[0].port.callToolCalls[0].args;
    assert.deepStrictEqual(args, {
      url: "https://example.com/",
      return_format: "text",
      retain_images: false,
      with_links_summary: true,
    });
  });

  it("invoke sends only url when no optional fields are set", async () => {
    const { factory, adapter } = makeAdapter(validResponse());
    await adapter.reader.fetch.invoke({ url: "https://example.com/" });
    const args = factory.created[0].port.callToolCalls[0].args;
    assert.deepStrictEqual(args, { url: "https://example.com/" });
  });

  it("constructs a fresh client per invoke and disables cache + retry", async () => {
    const { factory, adapter } = makeAdapter(validResponse());
    await adapter.reader.fetch.invoke({ url: "https://example.com/a" });
    await adapter.reader.fetch.invoke({ url: "https://example.com/b" });
    assert.strictEqual(factory.created.length, 2, "exactly one fresh client per invoke");
    for (const { port } of factory.created) {
      assert.strictEqual(port.options.noCache, true);
      assert.strictEqual(port.options.disableRetry, true);
    }
  });

  it("closes the client exactly once on success", async () => {
    const { factory, adapter } = makeAdapter(validResponse());
    await adapter.reader.fetch.invoke({ url: "https://example.com/" });
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });

  it("closes the client exactly once on primary failure", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      errorsByName: { [INTERNAL_WEB_READER]: new Error("HTTP 500 internal") },
    });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    await assert.rejects(adapter.reader.fetch.invoke({ url: "https://example.com/" }));
    assert.strictEqual(factory.created[0].fake.closeCount, 1);
  });

  it("success survives a close rejection", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: validResponse() },
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
    const out = await adapter.reader.fetch.invoke({ url: "https://example.com/" });
    assert.strictEqual(out.title, "Example Domain");
  });

  it("primary failure survives a close rejection", async () => {
    // Force a malformed response (primary 502) and a close rejection.
    // The outward error must be the 502, not the close error.
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      // null response → 502
      resultsByName: { [INTERNAL_WEB_READER]: null },
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
      await adapter.reader.fetch.invoke({ url: "https://example.com/" });
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
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: validResponse() },
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
      adapter.reader.fetch.invoke({ url: "https://example.com/" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Adapter attempt hung on close")), 5_000),
      ),
    ]);
    assert.strictEqual(out.title, "Example Domain");
  });

  // Production close-bound mirror of P6-04A:
  it("production close bound constant is 2000 ms (matches ZaiMcpClient.close)", () => {
    assert.strictEqual(
      ZAI_READER_CLOSE_BOUND_MS,
      2000,
      "Production close bound must match the existing ZaiMcpClient.close(timeoutMs=2000) semantic",
    );
  });

  it("a short injected close bound bounds the never-resolving close below the production default", async () => {
    const factory = makeClientFactory({
      discoveredTools: DISCOVERED_READER_TOOLS,
      resultsByName: { [INTERNAL_WEB_READER]: validResponse() },
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
      readerCloseTimeoutMs: 50,
    }).create({ env: { Z_AI_API_KEY: TEST_API_KEY } });
    const start = Date.now();
    const out = await adapter.reader.fetch.invoke({ url: "https://example.com/" });
    const elapsed = Date.now() - start;
    assert.strictEqual(out.title, "Example Domain");
    assert.ok(
      elapsed < 1000,
      `injected 50 ms bound should complete well under 1 s, took ${elapsed} ms`,
    );
  });
});

// ===========================================================================
// Cache hits construct no client. The Adapter's `decodeCached` is the
// shared Ticket 01 total decoder; a normalized cache hit returns without
// invoking any transport.
// ===========================================================================

describe("Z.AI Reader Adapter — cache hits construct no client", () => {
  it("a normalized cache hit on the Adapter returns without invoking", async () => {
    const factory = makeClientFactory({ discoveredTools: DISCOVERED_READER_TOOLS });
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    const result = adapter.reader.fetch.decodeCached({
      schemaVersion: 1,
      url: "https://example.com/",
      finalUrl: "https://example.com/",
      title: "Cached",
      content: "# Cached\n\nbody",
      contentFormat: "markdown",
    });
    assert.ok(result);
    assert.strictEqual(result.title, "Cached");
    assert.strictEqual(factory.created.length, 0);
  });

  it("a malformed normalized cache entry is a miss (returns null)", () => {
    const factory = makeClientFactory();
    const adapter = createZaiDescriptor({ clientFactory: factory }).create({
      env: { Z_AI_API_KEY: TEST_API_KEY },
    });
    assert.strictEqual(adapter.reader.fetch.decodeCached(null), null);
    assert.strictEqual(adapter.reader.fetch.decodeCached({ schemaVersion: 2 }), null);
    assert.strictEqual(adapter.reader.fetch.decodeCached({ schemaVersion: 1 }), null);
    assert.strictEqual(adapter.reader.fetch.decodeCached({ schemaVersion: 1, url: "x" }), null);
    assert.strictEqual(
      adapter.reader.fetch.decodeCached({
        schemaVersion: 1,
        url: "x",
        finalUrl: "x",
        content: "y",
        title: 1,
      }),
      null,
    );
  });
});
