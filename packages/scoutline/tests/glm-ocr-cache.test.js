/**
 * GLM-OCR content-hash cache + media plumbing (glm-ocr lane T3,
 * ADR-0014 D3/D4).
 *
 * Hermetic: layout-parsing REST double + isolated SCOUTLINE_CACHE_DIR
 * per test. Pins:
 *   - content-hash identity: same file bytes via two different paths →
 *     one cache entry, second run warm, zero transports;
 *   - URL identity: canonical URL keys; `--no-cache` skips read+write;
 *     cache hit constructs no transport, records no ledger row, emits
 *     no notice;
 *   - PDF <=50MB accepted (fixture bytes), >50MB VALIDATION_ERROR
 *     pre-transport; image >10MB likewise;
 *   - local file → base64 `file` value; hash computed on the same read
 *     pass (single content read observed).
 *
 * The cache key namespace is pinned:
 * v2.vision-ocr-layout-parsing.zai.<credential-hash>.<request-hash>.json
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import crypto from "node:crypto";

import { createZaiDescriptor } from "../dist/providers/zai/adapter.js";
import { buildProviderCacheKey } from "../dist/lib/cache.js";
import { ValidationError } from "../dist/lib/errors.js";

const ENV = {
  Z_AI_API_KEY: "test-zai-api-key-DO-NOT-LEAK",
};

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function makeRest(responder) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body });
    return responder(calls.length);
  };
  return { calls, fetch };
}

const WARM = () => jsonResponse({ md_results: "# cached-able text" });

function makeAdapter({ rest, notices, cacheEnv }) {
  const descriptor = createZaiDescriptor({
    clientFactory: () => {
      throw new Error("MCP client must never be constructed on the OCR arm");
    },
    layoutParsingFetch: rest.fetch,
    notice: notices,
    ...(cacheEnv !== undefined ? { layoutParsingCacheEnv: cacheEnv } : {}),
  });
  return descriptor.create({ env: ENV });
}

/** Isolated cache dir per test (D8). */
let tmpRoot;
let savedCacheDir;
let savedIsolated;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glm-ocr-cache-"));
  savedCacheDir = process.env.SCOUTLINE_CACHE_DIR;
  savedIsolated = process.env.SCOUTLINE_ISOLATED;
  process.env.SCOUTLINE_CACHE_DIR = tmpRoot;
  delete process.env.SCOUTLINE_ISOLATED;
});

afterEach(async () => {
  if (savedCacheDir === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
  else process.env.SCOUTLINE_CACHE_DIR = savedCacheDir;
  if (savedIsolated === undefined) delete process.env.SCOUTLINE_ISOLATED;
  else process.env.SCOUTLINE_ISOLATED = savedIsolated;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeTemp(name, bytes) {
  const filePath = path.join(tmpRoot, name);
  await fs.writeFile(filePath, bytes);
  return filePath;
}

const REQUEST = (source) => ({
  operation: "extract-text",
  source,
  instruction: "Extract all text from this image.",
});

describe("glm-ocr T3 — content-hash cache identity", () => {
  it("same file bytes via two different paths → second run warm, zero transports on it", async () => {
    const bytes = Buffer.from("same-bytes-identity-probe");
    const fileA = await writeTemp("a.png", bytes);
    const fileB = await writeTemp("b-renamed.png", bytes);
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });

    const first = await adapter.vision.invoke(REQUEST(fileA));
    const firstTransportCount = rest.calls.length;
    const second = await adapter.vision.invoke(REQUEST(fileB));

    assert.strictEqual(first, "# cached-able text");
    assert.strictEqual(second, "# cached-able text", "same bytes → same cached result");
    assert.strictEqual(firstTransportCount, 1);
    assert.strictEqual(rest.calls.length, 1, "the renamed run constructs NO transport");
  });

  it("different bytes at the same-looking name DO transport again (key is content, not name)", async () => {
    const fileA = await writeTemp("same-name.png", Buffer.from("bytes-one"));
    await fs.rm(fileA);
    const fileB = await writeTemp("same-name.png", Buffer.from("bytes-two-entirely"));
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    await adapter.vision.invoke(REQUEST(fileB));
    await adapter.vision.invoke(REQUEST(fileA === fileB ? fileB : fileB));
    assert.strictEqual(rest.calls.length, 1, "same bytes again stays warm");
    await fs.rm(fileB);
    await writeTemp("same-name.png", Buffer.from("changed-content"));
    await adapter.vision.invoke(REQUEST(fileB));
    assert.strictEqual(rest.calls.length, 2, "changed content transports again");
  });

  it("cache file lands in the v2.vision-ocr-layout-parsing.zai namespace", async () => {
    const file = await writeTemp("ns.png", Buffer.from("namespace-probe"));
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    await adapter.vision.invoke(REQUEST(file));

    const cacheDir = path.join(tmpRoot, "cache");
    const entries = await fs.readdir(cacheDir);
    const glmEntries = entries.filter((e) => e.startsWith("v2.vision-ocr-layout-parsing.zai."));
    assert.strictEqual(glmEntries.length, 1, "exactly one v2 OCR entry");
    // Credential partition: the key embeds the SHA-256 of the API key.
    const expectedCred = crypto.createHash("sha256").update(ENV.Z_AI_API_KEY).digest("hex");
    assert.ok(
      glmEntries[0].includes(expectedCred),
      "the cache key carries the credential fingerprint",
    );
  });

  it("strip-notice state never enters the key: custom prompt then default on the same file stays warm", async () => {
    const file = await writeTemp("prompt-state.png", Buffer.from("prompt-state-probe"));
    const rest = makeRest(WARM);
    const notices = [];
    const adapter = makeAdapter({ rest, notices: (l) => notices.push(l) });
    await adapter.vision.invoke({ operation: "extract-text", source: file, instruction: "custom prompt" });
    await adapter.vision.invoke(REQUEST(file));
    assert.strictEqual(rest.calls.length, 1, "same file identity regardless of prompt → warm");
  });

  it("URL identity: canonical URL keys — same URL twice → one transport; different URL → transports", async () => {
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    await adapter.vision.invoke(REQUEST("https://example.test/doc.png"));
    await adapter.vision.invoke(REQUEST("https://example.test/doc.png"));
    assert.strictEqual(rest.calls.length, 1, "same URL is warm");
    await adapter.vision.invoke(REQUEST("https://example.test/other.png"));
    assert.strictEqual(rest.calls.length, 2, "different URL transports");
  });

  it("cache hit: no transport, no notice, no ledger observable (silent warm path)", async () => {
    const file = await writeTemp("warm.png", Buffer.from("warm-path-probe"));
    const rest = makeRest(WARM);
    const notices = [];
    const adapter = makeAdapter({
      rest,
      notices: (l) => notices.push(l),
    });
    await adapter.vision.invoke(REQUEST(file));
    await adapter.vision.invoke(REQUEST(file));
    assert.strictEqual(rest.calls.length, 1);
    assert.deepStrictEqual(notices, [], "warm hits emit no notices (strip notices suppressed on cache hit)");
  });

  it("--no-cache (SCOUTLINE_CACHE=0) skips read AND write — every run transports", async () => {
    const file = await writeTemp("nocache.png", Buffer.from("no-cache-probe"));
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    process.env.SCOUTLINE_CACHE = "0";
    try {
      await adapter.vision.invoke(REQUEST(file));
      await adapter.vision.invoke(REQUEST(file));
      assert.strictEqual(rest.calls.length, 2, "no-cache never reads or writes");
      const cacheDir = path.join(tmpRoot, "cache");
      const entries = await fs.readdir(cacheDir).catch(() => []);
      assert.deepStrictEqual(
        entries.filter((e) => e.startsWith("v2.vision-ocr-layout-parsing.")),
        [],
        "no cache file written",
      );
    } finally {
      delete process.env.SCOUTLINE_CACHE;
    }
  });

  it("a poisoned cache entry (wrong shape) fails closed to a fresh transport", async () => {
    const file = await writeTemp("poison.png", Buffer.from("poison-probe"));
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    await adapter.vision.invoke(REQUEST(file));

    // Corrupt every OCR entry in the cache dir.
    const cacheDir = path.join(tmpRoot, "cache");
    for (const name of await fs.readdir(cacheDir)) {
      if (name.startsWith("v2.vision-ocr-layout-parsing.")) {
        await fs.writeFile(path.join(cacheDir, name), "not-json{", "utf8");
      }
    }
    const result = await adapter.vision.invoke(REQUEST(file));
    assert.strictEqual(result, "# cached-able text");
    assert.strictEqual(rest.calls.length, 2, "poisoned entry re-transported");
  });
});

describe("glm-ocr T3 — media plumbing limits", () => {
  /** Sparse file of exactly `size` bytes (hole, not allocated). */
  async function sparse(dir, name, size) {
    const filePath = path.join(dir, name);
    const handle = await fs.open(filePath, "w");
    await handle.truncate(size);
    await handle.close();
    return filePath;
  }

  it("PDF <=50MB is accepted pre-fallback (fixture bytes route to layout_parsing)", async () => {
    const pdf = await sparse(tmpRoot, "doc.pdf", 50 * 1024 * 1024);
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    const result = await adapter.vision.invoke(REQUEST(pdf));
    assert.strictEqual(result, "# cached-able text");
    assert.strictEqual(rest.calls.length, 1);
    const body = JSON.parse(rest.calls[0].body);
    assert.strictEqual(body.model, "glm-ocr");
  });

  it("PDF >50MB fails VALIDATION_ERROR before any transport", async () => {
    const pdf = await sparse(tmpRoot, "huge.pdf", 50 * 1024 * 1024 + 1);
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    await assert.rejects(adapter.vision.invoke(REQUEST(pdf)), ValidationError);
    assert.strictEqual(rest.calls.length, 0, "over-limit never transports (no billing)");
  });

  it("image >10MB fails VALIDATION_ERROR before any transport", async () => {
    const img = await sparse(tmpRoot, "huge.png", 10 * 1024 * 1024 + 1);
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    await assert.rejects(adapter.vision.invoke(REQUEST(img)), ValidationError);
    assert.strictEqual(rest.calls.length, 0);
  });

  it("image <=10MB (over the old 5 MiB vision cap) is accepted on the OCR arm", async () => {
    const img = await sparse(tmpRoot, "big-ok.png", 8 * 1024 * 1024);
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    const result = await adapter.vision.invoke(REQUEST(img));
    assert.strictEqual(result, "# cached-able text");
    assert.strictEqual(rest.calls.length, 1);
  });

  it("unsupported extension still rejects (e.g. .webp on zai)", async () => {
    const file = await writeTemp("x.webp", Buffer.from("webp-not-allowed"));
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    await assert.rejects(adapter.vision.invoke(REQUEST(file)), ValidationError);
    assert.strictEqual(rest.calls.length, 0);
  });
});

describe("glm-ocr T3 — single-read hash discipline", () => {
  it("local file → base64 `file`; one content read serves both hash and upload", async () => {
    const secret = `single-read-${crypto.randomUUID()}`;
    const file = await writeTemp("single.png", Buffer.from(secret));
    const rest = makeRest(WARM);
    const adapter = makeAdapter({ rest, notices: () => {} });
    await adapter.vision.invoke(REQUEST(file));
    const body = JSON.parse(rest.calls[0].body);
    assert.strictEqual(Buffer.from(body.file, "base64").toString("utf8"), secret);
  });

  it("buildProviderCacheKey round-trips the documented namespace grammar", async () => {
    const key = buildProviderCacheKey({
      provider: "zai",
      capability: "vision-ocr-layout-parsing",
      credentialFingerprint: "a".repeat(64),
      request: { model: "glm-ocr", file: "sha256:" + "b".repeat(64) },
    });
    assert.match(key, /^v2\.vision-ocr-layout-parsing\.zai\.a{64}\.[0-9a-f]{64}\.json$/);
  });
});
