/**
 * Tests for the recursive Provider credential redaction Module
 * (`src/lib/redact.ts`).
 *
 * Phase 4 P4-01 makes redaction:
 *   - Case-insensitive for the canonical credential-shaped keys.
 *   - Recursive through nested arrays and plain objects.
 *   - Non-mutating — the original input is never modified.
 *   - Secret-aware — every configured secret value is replaced inside
 *     any string the value tree reaches, not just one configured key.
 *   - Empty-safe — empty strings are never treated as a replacement token.
 *
 * Outward-boundary fixtures (formatted errors, cached metadata, executable
 * load failures) verify the new module is the single source of truth.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  configuredSecrets,
  redactSecrets,
  redactTool,
  redactCredentialString,
} from "../dist/lib/redact.js";
import { writeToolCache, readToolCache } from "../dist/lib/tool-cache.js";
import { formatErrorOutput } from "../dist/lib/output.js";

const Z_KEY = "zai-secret-key-value-AAA";
const Z_ALIAS_KEY = "zai-secret-alias-key-value-BBB";
const M_KEY = "minimax-secret-key-value-CCC";
const FC_KEY = "fc-test-secret-key-GGG";
const B_KEY = "brave-secret-key-value-GGG";
const E_KEY = "exa-secret-key-value-GGG";
const BEARER = "Bearer zai-secret-bearer-token-DDD";
const X_API = "x-api-key secret-x-api-key-value-EEE";
const EMBEDDED = "https://user:minimax-secret-embedded-FFF@host/path";

function buildMixedFixture() {
  return {
    Authorization: Z_KEY,
    authorization: Z_KEY,
    AUTHORIZATION: Z_KEY,
    "x-api-key": X_API,
    "X-API-Key": X_API,
    api_key: Z_KEY,
    apiKey: Z_KEY,
    API_KEY: Z_KEY,
    access_token: Z_KEY,
    Access_Token: Z_KEY,
    token: Z_KEY,
    TOKEN: Z_KEY,
    Z_AI_API_KEY: Z_KEY,
    z_ai_api_key: Z_ALIAS_KEY,
    ZAI_API_KEY: Z_ALIAS_KEY,
    zai_api_key: Z_ALIAS_KEY,
    MINIMAX_API_KEY: M_KEY,
    minimax_api_key: M_KEY,
    nested: {
      Authorization: BEARER,
      raw: `${BEARER} and ${Z_KEY} inline`,
      url: `${EMBEDDED}?api_key=${M_KEY}`,
      array: [
        { Authorization: BEARER, ok: "plain string" },
        [`Bearer ${Z_KEY}`, `x-api-key=${Z_ALIAS_KEY}`],
        "totally normal text",
      ],
    },
    sibling: {
      harmless: "this string mentions Z_AI_API_KEY but no value",
    },
    notASecret: "the quick brown fox",
  };
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("redactSecrets — recursive case-insensitive key redaction", () => {
  it("redacts every configured credential value when given as a single string (back-compat)", () => {
    const input = {
      Authorization: Z_KEY,
      nested: { ZAI_API_KEY: Z_ALIAS_KEY },
      url: `Bearer ${Z_KEY} inline`,
    };
    const before = snapshot(input);
    const result = redactSecrets(input, Z_KEY);
    assert.deepStrictEqual(input, before, "input must not be mutated");
    assert.strictEqual(result.Authorization, "[REDACTED]");
    assert.strictEqual(result.nested.ZAI_API_KEY, "[REDACTED]");
    assert.ok(!result.url.includes(Z_KEY), `url still contains secret: ${result.url}`);
    assert.ok(result.url.includes("[REDACTED]"), `expected redaction marker in url: ${result.url}`);
  });

  it("redacts every configured credential value across a string array of secrets", () => {
    const input = buildMixedFixture();
    const before = snapshot(input);
    const result = redactSecrets(input, [Z_KEY, Z_ALIAS_KEY, M_KEY]);

    assert.deepStrictEqual(input, before, "input must not be mutated");

    const direct = [
      "Authorization",
      "authorization",
      "AUTHORIZATION",
      "x-api-key",
      "X-API-Key",
      "api_key",
      "apiKey",
      "API_KEY",
      "access_token",
      "Access_Token",
      "token",
      "TOKEN",
      "Z_AI_API_KEY",
      "z_ai_api_key",
      "ZAI_API_KEY",
      "zai_api_key",
      "MINIMAX_API_KEY",
      "minimax_api_key",
    ];
    for (const k of direct) {
      assert.strictEqual(result[k], "[REDACTED]", `expected redacted value for key ${k}`);
    }

    assert.strictEqual(result.nested.Authorization, "[REDACTED]");
    const raw = result.nested.raw;
    assert.ok(!raw.includes(Z_KEY), `raw string still contains Z_KEY: ${raw}`);
    assert.ok(!raw.includes(BEARER), `raw string still contains bearer: ${raw}`);
    const url = result.nested.url;
    assert.ok(!url.includes(M_KEY), `url still contains M_KEY: ${url}`);
    assert.ok(!url.includes(EMBEDDED), `url still contains embedded credential: ${url}`);

    const arr = result.nested.array;
    assert.strictEqual(arr[0].ok, "plain string");
    assert.strictEqual(arr[0].Authorization, "[REDACTED]");
    assert.ok(!arr[1][0].includes(Z_KEY));
    assert.ok(!arr[1][1].includes(Z_ALIAS_KEY));
    assert.strictEqual(arr[2], "totally normal text");

    assert.strictEqual(result.sibling.harmless, "this string mentions Z_AI_API_KEY but no value");
    assert.strictEqual(result.notASecret, "the quick brown fox");
  });

  it("matches keys case-insensitively for every canonical credential name", () => {
    const input = {
      AUTHORIZATION: Z_KEY,
      "X-API-KEY": Z_KEY,
      API_KEY: Z_KEY,
      APIKEY: Z_KEY,
      ACCESS_TOKEN: Z_KEY,
      TOKEN: Z_KEY,
      Z_AI_API_KEY: Z_KEY,
      ZAI_API_KEY: Z_ALIAS_KEY,
      MINIMAX_API_KEY: M_KEY,
      EXA_API_KEY: E_KEY,
    };
    const result = redactSecrets(input, [Z_KEY, Z_ALIAS_KEY, M_KEY, E_KEY]);
    for (const k of Object.keys(input)) {
      assert.strictEqual(result[k], "[REDACTED]", `expected redacted value for ${k}`);
    }
  });

  it("never treats an empty secret as a replacement token", () => {
    const input = {
      Authorization: Z_KEY,
      nested: { ZAI_API_KEY: Z_ALIAS_KEY, normal: "leave me alone" },
      array: ["plain text", "another plain entry"],
    };
    const result = redactSecrets(input, [""]);
    // Empty secret must NOT smash unrelated text. The Bearer / x-api-key
    // / known env-var patterns still fire because they are key-shaped,
    // not secret-shaped — the rule is that empty `secrets[]` entries
    // never act as a replacement target.
    assert.strictEqual(result.nested.normal, "leave me alone");
    assert.strictEqual(result.array[0], "plain text");
    assert.strictEqual(result.array[1], "another plain entry");
    assert.strictEqual(result.Authorization, "[REDACTED]");

    // An empty entry sitting alongside a real secret must be skipped —
    // the real secret does the replacement, the empty one does nothing.
    const mixed = redactSecrets({ Authorization: Z_KEY, plain: "abc" }, ["", Z_KEY]);
    assert.strictEqual(mixed.Authorization, "[REDACTED]");
    assert.strictEqual(mixed.plain, "abc");
  });

  it("leaves ordinary non-secret strings unchanged", () => {
    const input = {
      title: "A normal title",
      body: "the quick brown fox jumps over the lazy dog",
      count: 7,
      flag: true,
      empty: null,
    };
    const result = redactSecrets(input, [Z_KEY, M_KEY]);
    assert.deepStrictEqual(result, input);
  });

  it("returns primitive values unchanged when no secrets are configured", () => {
    assert.strictEqual(redactSecrets("plain"), "plain");
    assert.strictEqual(redactSecrets(123), 123);
    assert.strictEqual(redactSecrets(null), null);
    assert.strictEqual(redactSecrets(undefined), undefined);
    assert.strictEqual(redactSecrets(true), true);
  });

  it("handles deeply nested arrays inside arrays", () => {
    const input = [
      [Z_KEY, "safe"],
      [{ Authorization: Z_KEY }, { Authorization: M_KEY }],
    ];
    const before = snapshot(input);
    const result = redactSecrets(input, [Z_KEY, M_KEY]);
    assert.deepStrictEqual(input, before, "input must not be mutated");
    assert.strictEqual(result[0][0], "[REDACTED]");
    assert.strictEqual(result[0][1], "safe");
    assert.strictEqual(result[1][0].Authorization, "[REDACTED]");
    assert.strictEqual(result[1][1].Authorization, "[REDACTED]");
  });

  it("skips non-plain objects (Date, Uint8Array, class instances) without throwing", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const input = {
      when: date,
      bytes: new Uint8Array([1, 2, 3]),
      Authorization: Z_KEY,
    };
    const result = redactSecrets(input, [Z_KEY]);
    assert.strictEqual(result.Authorization, "[REDACTED]");
    assert.strictEqual(result.when, date);
    assert.ok(result.bytes instanceof Uint8Array);
  });
});

describe("redactCredentialString — single-string redaction", () => {
  it("redacts Bearer values regardless of case", () => {
    assert.strictEqual(redactCredentialString(`prefix ${BEARER}`), "prefix [REDACTED]");
    assert.strictEqual(
      redactCredentialString(`Authorization: ${BEARER.toLowerCase()}`),
      "Authorization: [REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString(`Mixed: ${BEARER.toUpperCase()}`),
      "Mixed: [REDACTED]",
    );
  });

  it("redacts x-api-key, Z_AI_API_KEY, ZAI_API_KEY, MINIMAX_API_KEY and EXA_API_KEY assignments", () => {
    assert.strictEqual(redactCredentialString(`x-api-key=${Z_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`Z_AI_API_KEY=${Z_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`ZAI_API_KEY=${Z_ALIAS_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`MINIMAX_API_KEY=${M_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`EXA_API_KEY=${E_KEY}`), "[REDACTED]");
  });

  it("redacts FIRECRAWL_API_KEY assignments (FC-02)", () => {
    assert.strictEqual(redactCredentialString(`FIRECRAWL_API_KEY=${FC_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`FIRECRAWL_API_KEY: ${FC_KEY}`), "[REDACTED]");
    assert.strictEqual(
      redactCredentialString(`key was ${FC_KEY} here`, [FC_KEY]),
      "key was [REDACTED] here",
    );
  });

  it("redacts bare Firecrawl fc-… keys via length-constrained regex (1.5)", () => {
    // A canonical long-tail Firecrawl key is redacted by the regex alone
    // (no configured secret needed).
    const LONG_FC_KEY = "fc-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    assert.strictEqual(
      redactCredentialString(`api key: ${LONG_FC_KEY}`),
      "api key: [REDACTED]",
      "bare fc- key must be redacted by regex backstop",
    );
    assert.strictEqual(
      redactCredentialString(LONG_FC_KEY),
      "[REDACTED]",
      "lone fc- key string must be fully redacted",
    );
    // Short fc- tokens are NOT redacted (length constraint avoids false
    // positives on prose like ticket IDs).
    assert.strictEqual(
      redactCredentialString("refer to fc-ab for details"),
      "refer to fc-ab for details",
      "short fc- token must NOT be redacted",
    );
    assert.strictEqual(
      redactCredentialString("the FC-03 ticket"),
      "the FC-03 ticket",
      "uppercase FC- in prose must NOT be redacted by the fc- pattern",
    );
    // A string that merely starts with fc- but is too short stays safe.
    assert.strictEqual(
      redactCredentialString("fc-short"),
      "fc-short",
      "short fc- token must NOT be redacted",
    );
  });

  it("configuredSecrets surfaces FIRECRAWL_API_KEY (the load-bearing value loop)", () => {
    const secrets = configuredSecrets({ FIRECRAWL_API_KEY: FC_KEY });
    assert.ok(
      secrets.includes(FC_KEY),
      "configuredSecrets must include the FIRECRAWL_API_KEY value so it is redacted at every outward boundary",
    );
  });

  it("redacts BRAVE_SEARCH_API_KEY assignments (= and : separators)", () => {
    assert.strictEqual(redactCredentialString(`BRAVE_SEARCH_API_KEY=${B_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`brave_search_api_key: ${B_KEY}`), "[REDACTED]");
    assert.strictEqual(
      redactCredentialString("the BRAVE_SEARCH_API_KEY environment variable is required"),
      "the BRAVE_SEARCH_API_KEY environment variable is required",
    );
  });

  it("F5: redacts colon separator forms (JSON/header/YAML)", () => {
    // The named-key patterns must accept `:` as a separator, not just
    // `=` — `Z_AI_API_KEY: sk-foo` (JSON/HTTP-header/YAML) previously
    // slipped the named-key backstop (only `=` was accepted). Bare
    // whitespace is intentionally NOT a separator for these names: they
    // appear in prose error messages ("MINIMAX_API_KEY environment
    // variable is required") and a whitespace separator would
    // over-redact that prose.
    assert.strictEqual(redactCredentialString(`Z_AI_API_KEY: ${Z_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`ZAI_API_KEY:${Z_ALIAS_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`MINIMAX_API_KEY : ${M_KEY}`), "[REDACTED]");
    // Prose mention with no separator token must NOT be redacted.
    assert.strictEqual(
      redactCredentialString("the Z_AI_API_KEY environment variable is required"),
      "the Z_AI_API_KEY environment variable is required",
    );
  });

  // Fixup C — W3: the regex now also covers whitespace-separated forms
  // (`x-api-key abc123`, `x-api-key   abc123`) since real Provider/transport
  // errors occasionally emit headers that way. The match must consume
  // the trailing value and replace the entire `key + value` span.
  it("redacts whitespace-separated x-api-key assignments (Fixup C — W3)", () => {
    assert.strictEqual(
      redactCredentialString(`x-api-key ${Z_KEY}`),
      "[REDACTED]",
      "single space between key and value",
    );
    assert.strictEqual(
      redactCredentialString(`x-api-key   ${Z_KEY}`),
      "[REDACTED]",
      "multiple spaces between key and value",
    );
    assert.strictEqual(
      redactCredentialString(`x-api-key\t${Z_KEY}`),
      "[REDACTED]",
      "tab between key and value",
    );
    // The previously supported colon/equals forms must still match.
    assert.strictEqual(redactCredentialString(`x-api-key=${Z_KEY}`), "[REDACTED]");
    assert.strictEqual(redactCredentialString(`x-api-key: ${Z_KEY}`), "[REDACTED]");
  });

  it("redacts embedded credential strings in URLs", () => {
    const out = redactCredentialString(`endpoint: ${EMBEDDED}`);
    assert.ok(!out.includes(M_KEY), `still contains secret: ${out}`);
    assert.ok(!out.includes("user:"), `embedded user: prefix should be gone: ${out}`);
  });

  it("replaces extra secrets passed via the second argument", () => {
    assert.strictEqual(redactCredentialString(`token=${M_KEY}`, [M_KEY]), "token=[REDACTED]");
    assert.strictEqual(redactCredentialString(`nothing to do here`, [M_KEY]), "nothing to do here");
  });

  it("leaves ordinary text untouched", () => {
    const input = "the quick brown fox jumps over the lazy dog";
    assert.strictEqual(redactCredentialString(input), input);
  });
});

describe("configuredSecrets — credential discovery from environment", () => {
  it("includes EXA_API_KEY alongside the other provider credentials", () => {
    const secrets = configuredSecrets({
      Z_AI_API_KEY: Z_KEY,
      MINIMAX_API_KEY: M_KEY,
      EXA_API_KEY: E_KEY,
    });
    assert.ok(secrets.includes(E_KEY), "EXA_API_KEY value should be in configuredSecrets");
    assert.ok(secrets.includes(Z_KEY), "Z_AI_API_KEY value should be in configuredSecrets");
    assert.ok(secrets.includes(M_KEY), "MINIMAX_API_KEY value should be in configuredSecrets");
  });

  it("omits EXA_API_KEY when not set", () => {
    const secrets = configuredSecrets({ Z_AI_API_KEY: Z_KEY });
    assert.ok(!secrets.includes(E_KEY));
  });

  it("redacts an EXA_API_KEY leaked into an error message via redactCredentialString", () => {
    const leaked = `Exa request failed: EXA_API_KEY=${E_KEY}`;
    const redacted = redactCredentialString(leaked);
    assert.ok(!redacted.includes(E_KEY), `EXA key must be redacted: ${redacted}`);
    assert.ok(redacted.includes("[REDACTED]"));
  });
});

describe("redactTool — Tool metadata redaction", () => {
  it("redacts the configured Z_AI_API_KEY across nested tool metadata without mutating the input", () => {
    const tool = {
      name: "scoutline.zai.test",
      description: `uses key ${Z_KEY}`,
      inputs: {
        type: "object",
        properties: {
          Authorization: Z_KEY,
          nested: {
            "x-api-key": Z_KEY,
            array: [{ token: Z_KEY }],
          },
        },
      },
    };
    const before = snapshot(tool);
    const out = redactTool(tool, [Z_KEY, Z_ALIAS_KEY, M_KEY]);
    assert.deepStrictEqual(tool, before, "tool must not be mutated");
    assert.strictEqual(out.description, "uses key [REDACTED]");
    assert.strictEqual(out.inputs.properties.Authorization, "[REDACTED]");
    assert.strictEqual(out.inputs.properties.nested["x-api-key"], "[REDACTED]");
    assert.strictEqual(out.inputs.properties.nested.array[0].token, "[REDACTED]");
  });

  it("redacts Z_AI_API_KEY / MINIMAX_API_KEY drawn from the environment", () => {
    const savedZ = process.env.Z_AI_API_KEY;
    const savedM = process.env.MINIMAX_API_KEY;
    process.env.Z_AI_API_KEY = Z_KEY;
    process.env.MINIMAX_API_KEY = M_KEY;
    try {
      const tool = {
        description: `${Z_KEY} / ${M_KEY}`,
        inputs: { Authorization: Z_KEY },
      };
      const out = redactTool(tool);
      assert.strictEqual(out.description, "[REDACTED] / [REDACTED]");
      assert.strictEqual(out.inputs.Authorization, "[REDACTED]");
    } finally {
      if (savedZ === undefined) delete process.env.Z_AI_API_KEY;
      else process.env.Z_AI_API_KEY = savedZ;
      if (savedM === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = savedM;
    }
  });

  it("redacts BRAVE_SEARCH_API_KEY drawn from the environment", () => {
    // Locks the configuredSecrets() fix: a Brave key read from env must
    // be redacted by the env-derived secret path (no explicit secrets
    // passed), so it cannot leak through tool metadata or errors.
    const savedB = process.env.BRAVE_SEARCH_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = B_KEY;
    try {
      const tool = {
        description: `key ${B_KEY}`,
        inputs: { Authorization: B_KEY },
      };
      const out = redactTool(tool);
      assert.strictEqual(out.description, "key [REDACTED]");
      assert.strictEqual(out.inputs.Authorization, "[REDACTED]");
    } finally {
      if (savedB === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
      else process.env.BRAVE_SEARCH_API_KEY = savedB;
    }
  });
});

describe("redaction across outward-boundary formatters", () => {
  it("formatErrorOutput (output.ts) redacts credentials embedded in help and error", () => {
    const err = {
      message: `Request failed: Bearer ${Z_KEY}`,
      code: "AUTH_ERROR",
      help: `Use Z_AI_API_KEY=${Z_KEY} instead of MINIMAX_API_KEY=${M_KEY}`,
      statusCode: 401,
    };
    const out = formatErrorOutput(err, "pretty");
    assert.ok(!out.includes(Z_KEY), `output contains Z_KEY: ${out}`);
    assert.ok(!out.includes(M_KEY), `output contains M_KEY: ${out}`);
  });

  it("formatErrorOutput (output.ts) redacts credentials embedded in message and help via ambient env", async () => {
    const savedZ = process.env.Z_AI_API_KEY;
    const savedM = process.env.MINIMAX_API_KEY;
    process.env.Z_AI_API_KEY = Z_KEY;
    process.env.MINIMAX_API_KEY = M_KEY;
    try {
      const { ScoutlineError } = await import("../dist/lib/errors.js");
      const err = new ScoutlineError(`Bearer ${Z_KEY} and MINIMAX_API_KEY=${M_KEY}`, "AUTH_ERROR", {
        help: `Set Z_AI_API_KEY=${Z_KEY}`,
        statusCode: 401,
      });
      const out = formatErrorOutput(err, "data");
      assert.ok(!out.includes(Z_KEY), `output contains Z_KEY: ${out}`);
      assert.ok(!out.includes(M_KEY), `output contains M_KEY: ${out}`);
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.code, "AUTH_ERROR");
    } finally {
      if (savedZ === undefined) delete process.env.Z_AI_API_KEY;
      else process.env.Z_AI_API_KEY = savedZ;
      if (savedM === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = savedM;
    }
  });

  it("redactSecrets on a cached-metadata fixture redacts everything without mutating the source", () => {
    const cache = {
      version: 1,
      timestamp: 1234,
      tools: [
        {
          name: "scoutline.zai.test",
          inputs: { Authorization: Z_KEY, apiKey: Z_ALIAS_KEY },
        },
        {
          name: "scoutline.zai.another",
          inputs: { headers: { Authorization: BEARER } },
        },
      ],
    };
    const before = snapshot(cache);
    const safe = redactSecrets(cache, [Z_KEY, Z_ALIAS_KEY, M_KEY]);
    assert.deepStrictEqual(cache, before, "cache must not be mutated");
    assert.strictEqual(safe.tools[0].inputs.Authorization, "[REDACTED]");
    assert.strictEqual(safe.tools[0].inputs.apiKey, "[REDACTED]");
    assert.strictEqual(safe.tools[1].inputs.headers.Authorization, "[REDACTED]");
  });

  it("executable-load failure formatter strips credential material from the message", async () => {
    const savedZ = process.env.Z_AI_API_KEY;
    const savedZAlias = process.env.ZAI_API_KEY;
    process.env.Z_AI_API_KEY = Z_KEY;
    process.env.ZAI_API_KEY = Z_ALIAS_KEY;
    try {
      const { formatLoadFailure } = await import("../dist/node-command-invocation-adapter.js");
      const err = new Error(
        `Cannot find module '/secret/path/${Z_KEY}/dist/index.js' (Z_AI_API_KEY=${Z_KEY})`,
      );
      const out = formatLoadFailure(err);
      assert.ok(!out.includes(Z_KEY), `load failure output contains secret: ${out}`);
      assert.ok(!out.includes(Z_ALIAS_KEY), `load failure output contains alias secret: ${out}`);
      const parsed = JSON.parse(out);
      assert.strictEqual(parsed.success, false);
      assert.strictEqual(parsed.code, "LOAD_ERROR");
    } finally {
      if (savedZ === undefined) delete process.env.Z_AI_API_KEY;
      else process.env.Z_AI_API_KEY = savedZ;
      if (savedZAlias === undefined) delete process.env.ZAI_API_KEY;
      else process.env.ZAI_API_KEY = savedZAlias;
    }
  });
});

describe("writeToolCache — file-only key redaction (1.1.a)", () => {
  it("redacts a file-only configured key when secrets are threaded into writeToolCache", async () => {
    // A credential that exists ONLY in the injected env (simulating a
    // file-only key from config.json), NOT in process.env.
    const FILE_ONLY_KEY = "file-only-zai-key-XYZ-789";
    const injectedEnv = { Z_AI_API_KEY: FILE_ONLY_KEY };

    // Confirm the gap: the key is not in process.env.
    assert.ok(
      !process.env.Z_AI_API_KEY?.includes(FILE_ONLY_KEY),
      "FILE_ONLY_KEY should not be in process.env",
    );

    // A tool whose metadata echoes the file-only credential.
    const tool = {
      name: "scoutline_zai.test.tool_cache_redact",
      description: `endpoint uses key ${FILE_ONLY_KEY}`,
      inputs: {
        type: "object",
        properties: {
          Authorization: FILE_ONLY_KEY,
        },
      },
    };

    const cacheConfig = {
      mode: "ZAI",
      baseUrl: "https://test.example.com",
      endpoints: { search: "https://test.example.com/search" },
      enableVision: false,
    };

    // Point the cache at a temp dir and make sure the tool cache is enabled.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-redact-"));
    const savedCacheDir = process.env.SCOUTLINE_CACHE_DIR;
    const savedScoutlineCache = process.env.SCOUTLINE_CACHE;
    const savedToolCache = process.env.ZAI_MCP_TOOL_CACHE;
    process.env.SCOUTLINE_CACHE_DIR = tmpDir;
    delete process.env.SCOUTLINE_CACHE;
    delete process.env.ZAI_MCP_TOOL_CACHE;

    try {
      // Write with secrets resolved from the injected env — the fix.
      await writeToolCache(cacheConfig, [tool], configuredSecrets(injectedEnv));

      const cached = await readToolCache(cacheConfig);
      assert.ok(cached, "tool cache must be readable after write");
      assert.strictEqual(
        cached[0].description,
        "endpoint uses key [REDACTED]",
        "file-only key must be redacted in tool description",
      );
      assert.strictEqual(
        cached[0].inputs.properties.Authorization,
        "[REDACTED]",
        "file-only key must be redacted in tool inputs",
      );
    } finally {
      if (savedCacheDir === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
      else process.env.SCOUTLINE_CACHE_DIR = savedCacheDir;
      if (savedScoutlineCache === undefined) delete process.env.SCOUTLINE_CACHE;
      else process.env.SCOUTLINE_CACHE = savedScoutlineCache;
      if (savedToolCache === undefined) delete process.env.ZAI_MCP_TOOL_CACHE;
      else process.env.ZAI_MCP_TOOL_CACHE = savedToolCache;
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("tools list/show — file-only key redaction via configuredSecrets (1.1.b)", () => {
  it("a file-only key in options.env is redacted when secrets are threaded into redactTool", () => {
    // A credential that exists ONLY in the handler's options.env
    // (simulating a file-configured key), NOT in process.env.
    const FILE_ONLY_KEY = "file-only-handler-key-1-1-b-456";
    const handlerEnv = { Z_AI_API_KEY: FILE_ONLY_KEY };

    // Confirm the key is not in process.env (the gap).
    assert.ok(
      !process.env.Z_AI_API_KEY?.includes(FILE_ONLY_KEY),
      "FILE_ONLY_KEY should not be in process.env",
    );

    // The tools handler pattern after the fix:
    // redactTool(tool, configuredSecrets(options.env))
    const secrets = configuredSecrets(handlerEnv);
    assert.ok(
      secrets.includes(FILE_ONLY_KEY),
      "configuredSecrets must include the file-only key from options.env",
    );

    const tool = {
      name: "scoutline.zai.search.web_search_prime",
      description: `endpoint key: ${FILE_ONLY_KEY}`,
      inputs: {
        type: "object",
        properties: {
          Authorization: FILE_ONLY_KEY,
        },
      },
    };

    // What listTools/showTool now do after the fix:
    const redacted = redactTool(tool, secrets);
    assert.strictEqual(redacted.description, "endpoint key: [REDACTED]");
    assert.strictEqual(redacted.inputs.properties.Authorization, "[REDACTED]");

    // Prove the gap is real: without passing secrets, the file-only key
    // would NOT be redacted (it's not in process.env).
    const withoutSecrets = redactTool(tool);
    assert.ok(
      withoutSecrets.description.includes(FILE_ONLY_KEY),
      "without secrets, file-only key must NOT be redacted (proves the gap)",
    );
  });
});
