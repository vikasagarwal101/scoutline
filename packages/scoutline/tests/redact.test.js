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

  it("redacts non-Bearer auth schemes: Basic, Digest, Token, ApiKey (1.6)", () => {
    // Basic auth (base64 credentials)
    assert.strictEqual(
      redactCredentialString("Authorization: Basic dXNlcjpwYXNzMTIz"),
      "Authorization: [REDACTED]",
    );
    // Basic auth — short base64 credentials still redacted (no length floor)
    assert.strictEqual(
      redactCredentialString("Authorization: Basic YTpi"),
      "Authorization: [REDACTED]",
      "short Basic credentials must still be redacted",
    );
    // Digest auth — single token
    assert.strictEqual(
      redactCredentialString("Authorization: Digest abc123response456"),
      "Authorization: [REDACTED]",
    );
    // Digest auth — full multi-parameter value (all params redacted)
    assert.strictEqual(
      redactCredentialString(
        'Authorization: Digest username="admin", realm="example.org", nonce="abc123", response="def456"',
      ),
      "Authorization: [REDACTED]",
      "all Digest parameters must be redacted including response",
    );
    // Custom Token scheme (min 8-char token)
    assert.strictEqual(
      redactCredentialString("Authorization: Token my-secret-token-XYZ"),
      "Authorization: [REDACTED]",
    );
    // ApiKey scheme
    assert.strictEqual(
      redactCredentialString("Authorization: ApiKey sk-abc123def456"),
      "Authorization: [REDACTED]",
    );
    // Case-insensitivity: lowercase scheme keyword
    assert.strictEqual(redactCredentialString("basic dXNlcjpwYXNz"), "[REDACTED]");
    // No over-match: a word that merely starts with a scheme keyword
    // but has no following whitespace+token must not be redacted.
    assert.strictEqual(redactCredentialString("Basically this is fine"), "Basically this is fine");
    assert.strictEqual(
      redactCredentialString("Tokenization is useful here"),
      "Tokenization is useful here",
    );
    assert.strictEqual(
      redactCredentialString("Digestion requires enzymes"),
      "Digestion requires enzymes",
    );
    // No over-match on short tokens after Bearer/Token/ApiKey (review fix):
    // "Token Plan" is a domain term, "Plan" is 4 chars — must NOT redact.
    assert.strictEqual(
      redactCredentialString("MiniMax Token Plan subscription"),
      "MiniMax Token Plan subscription",
      "Token followed by a short word must not be redacted",
    );
    assert.strictEqual(
      redactCredentialString("The bearer of bad news"),
      "The bearer of bad news",
      "bearer followed by a short word must not be redacted",
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
    // Prose-length strings that match the 20-char minimum but are NOT
    // real keys are still redacted by the regex — this is a known
    // trade-off documented here as a characterization test. The 20-char
    // minimum makes this extremely unlikely in practice (real prose
    // rarely has a 20+ char alphanumeric token starting with fc-).
    const PROSE_LENGTH_MATCH = "fc-abcdefghijklmnopqrstuvwxyz";
    assert.strictEqual(
      redactCredentialString(`see ${PROSE_LENGTH_MATCH} for context`),
      "see [REDACTED] for context",
      "prose-length fc- token matching the regex IS redacted (known trade-off)",
    );
    // A prose string with spaces in the token after fc- is NOT redacted
    // (the regex requires [a-zA-Z0-9] only, no spaces).
    assert.strictEqual(
      redactCredentialString("fc-abc def ghi jkl mno pqr stu vwx"),
      "fc-abc def ghi jkl mno pqr stu vwx",
      "fc- followed by spaces is NOT redacted (regex requires alphanumeric only)",
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

  it("surfaces the searchapi and serpapi credentials (#216)", () => {
    const SEARCHAPI = "sk-live-searchapi-e5";
    const SERPAPI = "sk-live-serpapi-f6";
    const secrets = configuredSecrets({
      SEARCHAPI_API_KEY: SEARCHAPI,
      SERPAPI_API_KEY: SERPAPI,
    });
    for (const [name, value] of [
      ["SEARCHAPI_API_KEY", SEARCHAPI],
      ["SERPAPI_API_KEY", SERPAPI],
    ]) {
      assert.ok(
        secrets.includes(value),
        `configuredSecrets must include the ${name} value so it is redacted at every outward boundary`,
      );
    }
  });

  it("surfaces the kagi credentials (kagi amendment)", () => {
    const KAGI = "kagi-live-amend-a7";
    const TOKEN = "kagi-legacy-amend-b8";
    for (const [name, value] of [
      ["KAGI_API_KEY", KAGI],
      ["KAGI_TOKEN", TOKEN],
    ]) {
      const secrets = configuredSecrets({ [name]: value });
      assert.ok(
        secrets.includes(value),
        `configuredSecrets must include the ${name} value so it is redacted at every outward boundary`,
      );
    }
  });

  it("omits the searchapi/serpapi credentials when not set (#216)", () => {
    const secrets = configuredSecrets({ Z_AI_API_KEY: Z_KEY });
    assert.ok(!secrets.includes("sk-absent-searchapi"));
    assert.ok(!secrets.includes("sk-absent-serpapi"));
  });

  it("omits EXA_API_KEY when not set", () => {
    const secrets = configuredSecrets({ Z_AI_API_KEY: Z_KEY });
    assert.ok(!secrets.includes(E_KEY));
  });

  it("surfaces the v3 provider credentials (LINKUP/SPIDER/YDC/YOU) — review batch 1", () => {
    const LINKUP = "lk-live-v3-a1";
    const SPIDER = "sp-live-v3-b2";
    const YDC = "yd-live-v3-c3";
    const YOU = "yo-live-v3-d4";
    const secrets = configuredSecrets({
      LINKUP_API_KEY: LINKUP,
      SPIDER_API_KEY: SPIDER,
      YDC_API_KEY: YDC,
      YOU_API_KEY: YOU,
    });
    for (const [name, value] of [
      ["LINKUP_API_KEY", LINKUP],
      ["SPIDER_API_KEY", SPIDER],
      ["YDC_API_KEY", YDC],
      ["YOU_API_KEY", YOU],
    ]) {
      assert.ok(
        secrets.includes(value),
        `configuredSecrets must include the ${name} value so it is redacted at every outward boundary`,
      );
    }
  });

  it("surfaces the science credential values (NCBI/OPENALEX) — #208", () => {
    const secrets = configuredSecrets({
      NCBI_API_KEY: "ncbi-live-key-1",
      OPENALEX_API_KEY: "openalex-live-key-2",
    });
    assert.ok(secrets.includes("ncbi-live-key-1"));
    assert.ok(secrets.includes("openalex-live-key-2"));
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


describe("audit 2026-08 #44", () => {
  it("redacts Digest parameters after a quoted realm containing an internal space", () => {
    const header =
      'Authorization: Digest username="admin", realm="My App", nonce="abc123", response="def456"';
    const redacted = redactCredentialString(header);

    assert.ok(!redacted.includes('nonce='), `nonce residue leaked: ${redacted}`);
    assert.ok(!redacted.includes('response='), `response residue leaked: ${redacted}`);
  });

  it("does not redact ordinary prose after Token or Basic schemes", () => {
    const prose = "Token subscription and Basic understanding are ordinary prose";
    const redacted = redactCredentialString(prose);

    assert.strictEqual(redacted, prose);
  });

  it("still redacts true credentials with eight or more characters", () => {
    assert.strictEqual(
      redactCredentialString("Authorization: Token abcdefgh"),
      "Authorization: [REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("Authorization: Basic dXNlcjpwYXNzMTIz"),
      "Authorization: [REDACTED]",
    );
  });
});

describe("v3 provider keys (2026-08 #78)", () => {
  // Incumbent convention (see the Z_AI_API_KEY pins above): the whole
  // VAR=value token is replaced, not just the value.
  it("redacts YDC_API_KEY and YOU_API_KEY assignments", () => {
    assert.strictEqual(
      redactCredentialString("YDC_API_KEY=ydc-secret-123"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("YOU_API_KEY: you-secret-456"),
      "[REDACTED]",
    );
  });

  it("redacts LINKUP_API_KEY and SPIDER_API_KEY assignments", () => {
    assert.strictEqual(
      redactCredentialString("LINKUP_API_KEY=linkup-secret-789"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("SPIDER_API_KEY: spider-secret-012"),
      "[REDACTED]",
    );
  });

  it("redacts BOCHA_API_KEY assignments (env-var-name form)", () => {
    assert.strictEqual(
      redactCredentialString("BOCHA_API_KEY: sk-test-bocha-345"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("BOCHA_API_KEY sk-test-bocha-345"),
      "[REDACTED]",
    );
  });

  it("redacts SEARCHAPI_API_KEY and SERPAPI_API_KEY assignments (#216)", () => {
    assert.strictEqual(
      redactCredentialString("SEARCHAPI_API_KEY=searchapi-secret-6789"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("SERPAPI_API_KEY: serpapi-secret-4321"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("SEARCHAPI_API_KEY sk-searchapi-1a2b3c"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("SERPAPI_API_KEY sk-serpapi-9z8y7x"),
      "[REDACTED]",
    );
  });

  it("redacts science credential env-var assignments (#208)", () => {
    assert.strictEqual(
      redactCredentialString("NCBI_API_KEY: k"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("OPENALEX_API_KEY=alex-key-123"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactSecrets({ NCBI_API_KEY: "n", OPENALEX_API_KEY: "o" }).NCBI_API_KEY,
      "[REDACTED]",
    );
  });

  it("masks searchapi/serpapi credential object keys by name (#216)", () => {
    assert.deepStrictEqual(
      redactSecrets({ searchapi_api_key: "sk-searchapi-6789" }),
      { searchapi_api_key: "[REDACTED]" },
    );
    assert.deepStrictEqual(
      redactSecrets({ SERPAPI_API_KEY: "sk-serpapi-4321" }),
      { SERPAPI_API_KEY: "[REDACTED]" },
    );
  });

  it("leaves ordinary prose naming the searchapi/serpapi variables intact (#216, #44 bar)", () => {
    for (const prose of [
      "SEARCHAPI_API_KEY is not set",
      "configure SERPAPI_API_KEY before use",
    ]) {
      assert.strictEqual(redactCredentialString(prose), prose);
    }
  });

  it("redacts KAGI_API_KEY and KAGI_TOKEN assignments (kagi amendment)", () => {
    assert.strictEqual(
      redactCredentialString("KAGI_API_KEY=kagi-secret-1357"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("KAGI_TOKEN: kagi-legacy-token-2468"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("KAGI_API_KEY kagi-key-9a8b7c6d"),
      "[REDACTED]",
    );
  });

  it("masks kagi credential object keys by name (kagi amendment)", () => {
    assert.deepStrictEqual(
      redactSecrets({ kagi_api_key: "kagi-secret-1357" }),
      { kagi_api_key: "[REDACTED]" },
    );
    assert.deepStrictEqual(
      redactSecrets({ KAGI_TOKEN: "kagi-legacy-token-2468" }),
      { KAGI_TOKEN: "[REDACTED]" },
    );
  });

  it("leaves ordinary prose naming the kagi variables intact (kagi amendment, #44 bar)", () => {
    for (const prose of [
      "KAGI_API_KEY or KAGI_TOKEN environment variable is required",
      "KAGI_API_KEY is not set",
    ]) {
      assert.strictEqual(redactCredentialString(prose), prose);
    }
  });

  it("redacts whitespace-separated v3 key assignments (x-api-key separator convention)", () => {
    assert.strictEqual(
      redactCredentialString("SPIDER_API_KEY sk-abc123xyz"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("LINKUP_API_KEY lk_9f8e7d6c5b"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("YDC_API_KEY ydc-AA11bb22cc"),
      "[REDACTED]",
    );
  });

  it("leaves ordinary prose naming the v3 variables intact (#44 bar)", () => {
    for (const prose of [
      "LINKUP_API_KEY is not set",
      "SPIDER_API_KEY environment variable",
      "configure YDC_API_KEY before use",
    ]) {
      assert.strictEqual(redactCredentialString(prose), prose);
    }
  });

  it("redacts the v3 keys case-insensitively like the incumbents", () => {
    assert.strictEqual(
      redactCredentialString("ydc_api_key = mixed-case-secret"),
      "[REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString("spider_api_key=another-secret"),
      "[REDACTED]",
    );
  });
});

describe("scheme-pass JSON boundary termination (#171)", () => {
  it("discriminating JSON boundary pin (a): does not swallow quotes or subsequent keys", () => {
    const input = JSON.stringify({ d: "token abcdef123", n: 1 });
    const out = redactCredentialString(input);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.n, 1);
    assert.strictEqual(parsed.d, "[REDACTED]");
    assert.ok(out.includes('"n"'), "n key must survive");
  });

  it("comma-credential corpus redacted whole in prose and JSON (b — F1)", () => {
    const bearerComma = "Bearer abcdefghij,IJKLMNOP";
    const apiKeyComma = "ApiKey lowerpart,UPPERPART123";
    const tokenCsv = "Token key1,key2,key3_DEF";

    // Plain prose: full run redacted whole, no partial [REDACTED],TAIL or verbatim leak
    assert.strictEqual(redactCredentialString(bearerComma), "[REDACTED]");
    assert.strictEqual(redactCredentialString(apiKeyComma), "[REDACTED]");
    assert.strictEqual(redactCredentialString(tokenCsv), "[REDACTED]");
    assert.ok(!redactCredentialString(bearerComma).includes(","), "no comma remnant in prose");
    assert.ok(!redactCredentialString(bearerComma).includes("IJKLMNOP"), "no tail leak in prose");

    // Inside JSON string values
    const jsonBearer = JSON.stringify({ token: bearerComma, ok: true });
    const outJsonBearer = redactCredentialString(jsonBearer);
    assert.ok(!outJsonBearer.includes("[REDACTED],"), "no partial [REDACTED],TAIL in JSON");
    assert.ok(!outJsonBearer.includes("IJKLMNOP"), "no tail leak in JSON");
    assert.deepStrictEqual(JSON.parse(outJsonBearer), { token: "[REDACTED]", ok: true });

    const jsonApiKey = JSON.stringify({ key: apiKeyComma, status: 200 });
    const outJsonApiKey = redactCredentialString(jsonApiKey);
    assert.deepStrictEqual(JSON.parse(outJsonApiKey), { key: "[REDACTED]", status: 200 });

    const jsonTokenCsv = JSON.stringify({ list: tokenCsv });
    const outJsonTokenCsv = redactCredentialString(jsonTokenCsv);
    assert.deepStrictEqual(JSON.parse(outJsonTokenCsv), { list: "[REDACTED]" });
  });

  it("anchored comma shape redacts whole with no tail remainder (c)", () => {
    const h1 = "Authorization: Bearer abcdefghij,DEF12345678";
    const h2 = "Authorization: Bearer abc,DEF12345678";

    assert.strictEqual(redactCredentialString(h1), "Authorization: [REDACTED]");
    assert.strictEqual(redactCredentialString(h2), "Authorization: [REDACTED]");
    assert.ok(!redactCredentialString(h1).includes(",DEF"), "no tail remainder on h1");
    assert.ok(!redactCredentialString(h2).includes(",DEF"), "no tail remainder on h2");

    const jsonH = JSON.stringify({ header: h2, code: 401 });
    const outJsonH = redactCredentialString(jsonH);
    assert.deepStrictEqual(JSON.parse(outJsonH), { header: "Authorization: [REDACTED]", code: 401 });
  });

  it("prose guard: trailing punctuation stripped before credential check (d)", () => {
    assert.strictEqual(
      redactCredentialString("Token subscription, and more"),
      "Token subscription, and more",
    );
    const inputJson = JSON.stringify({ msg: "Token subscription, and more" });
    assert.strictEqual(redactCredentialString(inputJson), inputJson);
  });

  it("M5 pin: 1M-token context... survives unredacted and JSON parses (e)", () => {
    const input = JSON.stringify({ d: "1M-token context...", context_len: 123 });
    const out = redactCredentialString(input);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.context_len, 123);
    assert.strictEqual(parsed.d, "1M-token context...");
    assert.ok(out.includes("context..."), `context... must survive in: ${out}`);
  });

  it("openrouter shape: trailing punctuation stripped so generation survives (f1)", () => {
    const input = JSON.stringify({ model: "foo", description: "faster token generation, and better performance" });
    const out = redactCredentialString(input);
    assert.ok(out.includes("generation"), `generation should survive in: ${out}`);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.model, "foo");
  });

  it("authorization-context JSON (f2): pass 1 does not swallow quotes or subsequent keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.payload";
    const input = JSON.stringify({ m: `Authorization: Bearer ${jwt}`, n: 2 });
    const out = redactCredentialString(input);
    assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"), `credential must be redacted: ${out}`);
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.m, "Authorization: [REDACTED]");
    assert.strictEqual(parsed.n, 2);
  });

  it("genuine credentials still redacted in prose and JSON (f3)", () => {
    const bearerJwt = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M";
    const tokenGhp = "Token ghp_16C7e42F292c6912E7710c838347Ae178B4a";
    const apiKeySk = "ApiKey sk-abc1234567890def";

    // Plain prose
    assert.strictEqual(redactCredentialString(bearerJwt), "[REDACTED]");
    assert.strictEqual(redactCredentialString(tokenGhp), "[REDACTED]");
    assert.strictEqual(redactCredentialString(apiKeySk), "[REDACTED]");

    // Authorization-context in prose
    assert.strictEqual(
      redactCredentialString(`Authorization: ${bearerJwt}`),
      "Authorization: [REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString(`Authorization: ${tokenGhp}`),
      "Authorization: [REDACTED]",
    );
    assert.strictEqual(
      redactCredentialString(`Authorization: ${apiKeySk}`),
      "Authorization: [REDACTED]",
    );

    // Inside JSON string values
    const jsonJwt = JSON.stringify({ token: bearerJwt });
    const redactedJsonJwt = redactCredentialString(jsonJwt);
    assert.ok(!redactedJsonJwt.includes("eyJhbGciOi"));
    assert.deepStrictEqual(JSON.parse(redactedJsonJwt), { token: "[REDACTED]" });

    const jsonGhp = JSON.stringify({ key: tokenGhp });
    const redactedJsonGhp = redactCredentialString(jsonGhp);
    assert.ok(!redactedJsonGhp.includes("ghp_16C7e42F292c6912E7710c838347Ae178B4a"));
    assert.deepStrictEqual(JSON.parse(redactedJsonGhp), { key: "[REDACTED]" });

    const jsonSk = JSON.stringify({ auth: apiKeySk });
    const redactedJsonSk = redactCredentialString(jsonSk);
    assert.ok(!redactedJsonSk.includes("sk-abc1234567890def"));
    assert.deepStrictEqual(JSON.parse(redactedJsonSk), { auth: "[REDACTED]" });
  });

  it("existing #44 prose-guard pins stay green (f4)", () => {
    assert.strictEqual(
      redactCredentialString("MiniMax Token Plan subscription"),
      "MiniMax Token Plan subscription",
    );
    assert.strictEqual(
      redactCredentialString("The bearer of bad news"),
      "The bearer of bad news",
    );
  });

  it("class guard: JSON bodies with scheme-words near boundaries parse cleanly (f5)", () => {
    const payloads = [
      JSON.stringify({ message: "1M-token context window", valid: true }),
      JSON.stringify({ note: "faster token generation, and better performance", code: 200 }),
      JSON.stringify({ status: "Bearer token required", ok: false }),
      JSON.stringify({ info: "ApiKey format: Bearer <token>", count: 5 }),
      JSON.stringify({ header: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.sig", retries: 0 }),
      JSON.stringify({ text: "The Token Economy, volume 2", pages: 300 }),
      JSON.stringify({ a: "token", b: 1 }),
      JSON.stringify({ desc: "Token-based auth, apiKey-based access, and bearer credentials" }),
      JSON.stringify({ d: "1M-token context...", context_len: 123 }),
    ];
    for (const payload of payloads) {
      const redacted = redactCredentialString(payload);
      assert.doesNotThrow(
        () => JSON.parse(redacted),
        `JSON.parse failed on redacted output for input: ${payload}\nOutput was: ${redacted}`,
      );
    }
  });
});

describe("quoted-scheme recovery and family-wide boundary invariants (#171 review F3/M1-M4)", () => {
  it("F3 Part A: quoted scheme pass redacts in prose and JSON without leaving orphan backslashes", () => {
    const bearerQuoted = 'Bearer "ghp_ABC123defGHI456"';
    const tokenQuoted = 'Token "ghp_ABC123defGHI456"';
    const apiKeyQuoted = 'ApiKey "sk-abc1234567890def"';

    // Prose redaction
    assert.strictEqual(redactCredentialString(bearerQuoted), "[REDACTED]");
    assert.strictEqual(redactCredentialString(tokenQuoted), "[REDACTED]");
    assert.strictEqual(redactCredentialString(apiKeyQuoted), "[REDACTED]");
    assert.strictEqual(
      redactCredentialString(`Authorization: ${bearerQuoted}`),
      "Authorization: [REDACTED]",
    );

    // JSON stringified — must parse cleanly, no orphan \[REDACTED] backslash
    const jsonBearer = JSON.stringify({ token: bearerQuoted, status: 200 });
    const outJsonBearer = redactCredentialString(jsonBearer);
    assert.ok(!outJsonBearer.includes("ghp_ABC123defGHI456"));
    assert.deepStrictEqual(JSON.parse(outJsonBearer), { token: "[REDACTED]", status: 200 });

    const jsonToken = JSON.stringify({ token: tokenQuoted, status: 200 });
    const outJsonToken = redactCredentialString(jsonToken);
    assert.deepStrictEqual(JSON.parse(outJsonToken), { token: "[REDACTED]", status: 200 });

    const jsonApiKey = JSON.stringify({ token: apiKeyQuoted, status: 200 });
    const outJsonApiKey = redactCredentialString(jsonApiKey);
    assert.deepStrictEqual(JSON.parse(outJsonApiKey), { token: "[REDACTED]", status: 200 });
  });

  it("F3 Part A: quoted prose guard preserves ordinary quoted words in prose and JSON", () => {
    assert.strictEqual(
      redactCredentialString('Token "subscription"'),
      'Token "subscription"',
    );
    assert.strictEqual(
      redactCredentialString('Token "subscription."'),
      'Token "subscription."',
    );

    const jsonSubscription = JSON.stringify({ note: 'Token "subscription"', valid: true });
    const outJson = redactCredentialString(jsonSubscription);
    assert.strictEqual(outJson, jsonSubscription);
    assert.deepStrictEqual(JSON.parse(outJson), { note: 'Token "subscription"', valid: true });
  });

  it("M1 Basic: both forms terminate at quotes to preserve JSON structure while redacting genuine credentials", () => {
    const basicCred = "dXNlcjpwYXNzd29yZDEyMw==";
    const anchored = `Authorization: Basic ${basicCred}`;
    const bare = `Basic ${basicCred}`;

    // Prose
    assert.strictEqual(redactCredentialString(anchored), "Authorization: [REDACTED]");
    assert.strictEqual(redactCredentialString(bare), "[REDACTED]");

    // Inside JSON — previously \S+ swallowed the closing quote and subsequent keys
    const jsonAnchored = JSON.stringify({ auth: anchored, code: 401 });
    const outJsonAnchored = redactCredentialString(jsonAnchored);
    assert.ok(!outJsonAnchored.includes(basicCred));
    assert.deepStrictEqual(JSON.parse(outJsonAnchored), { auth: "Authorization: [REDACTED]", code: 401 });

    const jsonBare = JSON.stringify({ auth: bare, code: 401 });
    const outJsonBare = redactCredentialString(jsonBare);
    assert.ok(!outJsonBare.includes(basicCred));
    assert.deepStrictEqual(JSON.parse(outJsonBare), { auth: "[REDACTED]", code: 401 });

    // Prose guards
    assert.strictEqual(
      redactCredentialString("Basic understanding"),
      "Basic understanding",
    );
    assert.strictEqual(
      redactCredentialString("Basic understanding, and more"),
      "Basic understanding, and more",
    );
    const jsonProse = JSON.stringify({ desc: "Basic understanding, and more", ok: true });
    assert.strictEqual(redactCredentialString(jsonProse), jsonProse);
  });

  it("M2 Env-vars: [=:] assignments terminate at quotes so JSON string boundaries survive", () => {
    const envVars = [
      "Z_AI_API_KEY", "ZAI_API_KEY", "MINIMAX_API_KEY", "TAVILY_API_KEY",
      "EXA_API_KEY", "BRAVE_SEARCH_API_KEY", "FIRECRAWL_API_KEY", "PARALLEL_API_KEY",
      "PERPLEXITY_API_KEY", "JINA_API_KEY", "YDC_API_KEY", "YOU_API_KEY",
      "LINKUP_API_KEY", "SPIDER_API_KEY", "SEARCHAPI_API_KEY", "SERPAPI_API_KEY",
      "KAGI_API_KEY", "KAGI_TOKEN",
    ];

    for (const key of envVars) {
      // Equals syntax in JSON
      const jsonEquals = JSON.stringify({ env: `${key}=secret_value_12345`, n: 1 });
      const outEquals = redactCredentialString(jsonEquals);
      assert.deepStrictEqual(
        JSON.parse(outEquals),
        { env: "[REDACTED]", n: 1 },
        `${key}= failed in JSON`,
      );

      // Colon syntax in JSON
      const jsonColon = JSON.stringify({ env: `${key}: secret_value_12345`, n: 2 });
      const outColon = redactCredentialString(jsonColon);
      assert.deepStrictEqual(
        JSON.parse(outColon),
        { env: "[REDACTED]", n: 2 },
        `${key}: failed in JSON`,
      );

      // Prose assignment
      assert.strictEqual(
        redactCredentialString(`export ${key}=secret_value_12345`),
        "export [REDACTED]",
      );
    }

    // Whitespace-guarded v3 env-var passes (#174): terminate at quotes to preserve JSON boundaries
    const wsEnvVars = [
      "YDC_API_KEY",
      "YOU_API_KEY",
      "LINKUP_API_KEY",
      "SPIDER_API_KEY",
      "SEARCHAPI_API_KEY",
      "SERPAPI_API_KEY",
      "KAGI_API_KEY",
      "KAGI_TOKEN",
    ];
    for (const key of wsEnvVars) {
      // Whitespace syntax in JSON (#174)
      const jsonWs = JSON.stringify({ h: `${key} key12345aB`, n: 1 });
      const outWs = redactCredentialString(jsonWs);
      assert.deepStrictEqual(
        JSON.parse(outWs),
        { h: "[REDACTED]", n: 1 },
        `${key} whitespace failed in JSON`,
      );

      // Genuine-key-still-redacted pin in prose (#174)
      assert.strictEqual(
        redactCredentialString(`${key} key12345aB`),
        "[REDACTED]",
        `${key} whitespace failed in prose`,
      );
    }
  });

  it("M3 x-api-key: verify-only charset preserves JSON string boundaries", () => {
    const jsonApiKey = JSON.stringify({ key: "x-api-key: secret_token_xyz", active: true });
    const outJson = redactCredentialString(jsonApiKey);
    assert.deepStrictEqual(JSON.parse(outJson), { key: "[REDACTED]", active: true });
  });

  it("M4a Digest: escaped-quote tolerance in quoted parameters and bare-token boundary protection", () => {
    // Full Digest with space in quoted realm inside JSON
    const digestFull = 'Digest username="user", realm="My App", nonce="abc123nonce", response="def456response"';
    const jsonFull = JSON.stringify({ auth: digestFull, attempts: 1 });
    const outJsonFull = redactCredentialString(jsonFull);
    assert.ok(!outJsonFull.includes("abc123nonce"), "nonce must not leak");
    assert.ok(!outJsonFull.includes("def456response"), "response must not leak");
    assert.deepStrictEqual(JSON.parse(outJsonFull), { auth: "[REDACTED]", attempts: 1 });

    // Full Digest in prose
    assert.strictEqual(redactCredentialString(digestFull), "[REDACTED]");

    // Bare param alternative in JSON does not swallow closing quote
    const jsonBare = JSON.stringify({ header: "Digest a=b", count: 1 });
    const outJsonBare = redactCredentialString(jsonBare);
    assert.deepStrictEqual(JSON.parse(outJsonBare), { header: "[REDACTED]", count: 1 });

    // Mixed Digest parameters in JSON
    const digestMixed = 'Digest username="user", algorithm=MD5, realm="Test Realm", qop=auth, nc=00000001, cnonce="0a4f113b", response="6629fae49393a05397450978507c4ef1", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
    const jsonMixed = JSON.stringify({ header: digestMixed, ok: true });
    const outJsonMixed = redactCredentialString(jsonMixed);
    assert.deepStrictEqual(JSON.parse(outJsonMixed), { header: "[REDACTED]", ok: true });
  });
});

describe("#180 — SigV4 Credential= pass and cross-quote lookahead narrowing", () => {
  // RFC-shaped AWS SigV4 Authorization header. The access-key-id rides
  // inside the `Credential=` param; the sibling params are comma-separated.
  const SIGV4_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
  const SIGV4_SCOPE = "20260916/us-east-1/s3/aws4_request";
  const SIGV4_HEADER = `Authorization: AWS4-HMAC-SHA256 Credential=${SIGV4_ACCESS_KEY}/${SIGV4_SCOPE}, SignedHeaders=host;x-amz-date, Signature=abc123def456`;

  // PR #185 review (Kody): the query-string SigV4 form — presigned URLs carry
  // X-Amz-Credential=...&X-Amz-Signature=... — must terminate the capture at
  // `&` so the sibling param LABEL stays readable (the value redacts whole).
  it("query-string form: capture terminates at & — sibling param label preserved", () => {
    const url = `https://example.s3.amazonaws.com/file?X-Amz-Credential=${SIGV4_ACCESS_KEY}/${SIGV4_SCOPE}&X-Amz-Signature=abc123def456`;
    const out = redactCredentialString(url);
    assert.ok(out.includes("X-Amz-Credential=[REDACTED]"), `label not preserved: ${out}`);
    assert.ok(out.includes("&X-Amz-Signature="), `sibling param label swallowed: ${out}`);
  });

  it("true positive: redacts the SigV4 access key inside Credential=, keeps the label and sibling params", () => {
    const out = redactCredentialString(SIGV4_HEADER);

    assert.ok(!out.includes(SIGV4_ACCESS_KEY), `access key leaked: ${out}`);
    assert.ok(!out.includes(SIGV4_SCOPE), `credential scope leaked: ${out}`);
    assert.ok(out.includes("Credential=[REDACTED]"), `Credential= label not preserved: ${out}`);
    // Capture terminates at the comma + whitespace, mirroring the Digest param
    // discipline, so the sibling params are untouched.
    assert.ok(out.includes("SignedHeaders=host;x-amz-date"), `SignedHeaders dropped: ${out}`);
    assert.ok(out.includes("Signature=abc123def456"), `Signature dropped: ${out}`);
    assert.strictEqual(
      out,
      "Authorization: AWS4-HMAC-SHA256 Credential=[REDACTED], SignedHeaders=host;x-amz-date, Signature=abc123def456",
    );
  });

  it("true positive: terminates at the quote in the JSON-embedded form", () => {
    const input = JSON.stringify({ auth: `Credential=${SIGV4_ACCESS_KEY}/${SIGV4_SCOPE}`, n: 1 });
    const out = redactCredentialString(input);

    assert.ok(!out.includes(SIGV4_ACCESS_KEY), `access key leaked: ${out}`);
    assert.deepStrictEqual(JSON.parse(out), { auth: "Credential=[REDACTED]", n: 1 });
  });

  it("documented judgment: a bare Credential= in prose is redacted (the pass is context-free)", () => {
    // Ruling: no `Authorization:` context gate — a bare `Credential=` in prose
    // is rare and redaction errs toward redacting.
    assert.strictEqual(
      redactCredentialString("Credential=foobar123"),
      "Credential=[REDACTED]",
    );
  });

  it("false positive: a JSON sibling digit no longer crosses the closing quote (#180 gap 2)", () => {
    const input = JSON.stringify({ h: "YDC_API_KEY abcdefgh", n: 1 });
    const out = redactCredentialString(input);

    assert.strictEqual(out, input, "value carries no digit of its own — must stay intact");
    assert.deepStrictEqual(JSON.parse(out), { h: "YDC_API_KEY abcdefgh", n: 1 });
  });

  it("narrowing keeps the whitespace-guarded pass firing when the digit is in-token", () => {
    const input = JSON.stringify({ h: "YDC_API_KEY abcdefgh1", n: 1 });
    const out = redactCredentialString(input);

    assert.deepStrictEqual(JSON.parse(out), { h: "[REDACTED]", n: 1 });
  });
});

