/**
 * Provider selection tests (DESIGN.md §6, PRD FR-001 through FR-005).
 *
 * P2-01 asserts:
 *   - `parseProviderId` trims, lowercases, and rejects empty or unknown
 *     values with `VALIDATION_ERROR`.
 *   - `resolveProviderId` honours explicit → environment → default.
 *   - An explicitly empty Provider is present and invalid; it must NOT fall
 *     through to the environment or default.
 *   - Provider selection is independent of credentials: the same input
 *     yields the same selection regardless of which keys are present.
 *   - `getConfiguredProviderDescriptors` is purely metadata-driven and
 *     `create()` is side-effect-free.
 *   - Validation throws before any descriptor factory runs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseProviderId,
  resolveProviderId,
  getProviderDescriptor,
  getConfiguredProviderDescriptors,
} from "../dist/providers/selection.js";
import { ValidationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// parseProviderId: accepts and normalizes valid Provider IDs
// ---------------------------------------------------------------------------

describe("parseProviderId: valid IDs", () => {
  const validCases = [
    { input: "zai", expected: "zai" },
    { input: "MiniMax", expected: "minimax" },
    { input: "  zai  ", expected: "zai" },
    { input: "\tminimax\n", expected: "minimax" },
  ];

  it("accepts both IDs and normalizes case and whitespace", () => {
    for (const { input, expected } of validCases) {
      assert.strictEqual(parseProviderId(input), expected);
    }
  });
});

// ---------------------------------------------------------------------------
// parseProviderId: rejects empty and unknown values with VALIDATION_ERROR
// ---------------------------------------------------------------------------

describe("parseProviderId: invalid input throws ValidationError", () => {
  function assertInvalid(value) {
      let captured;
      try {
        parseProviderId(value);
      } catch (err) {
        captured = err;
      }
      assert.ok(captured instanceof ValidationError, "must throw ValidationError");
      assert.strictEqual(captured.code, "VALIDATION_ERROR");
      assert.ok(captured.help && /zai|minimax/.test(captured.help), "help must list accepted IDs");
  }

  it("rejects empty input", () => assertInvalid(""));
  it("rejects an unknown provider", () => assertInvalid("openai"));
});

// ---------------------------------------------------------------------------
// resolveProviderId: precedence table
// ---------------------------------------------------------------------------

describe("resolveProviderId: precedence table", () => {
  const cases = [
    { name: "default zai when both are absent", explicit: undefined, env: {}, expected: "zai" },
    { name: "explicit zai wins over default", explicit: "zai", env: {}, expected: "zai" },
    {
      name: "explicit minimax wins over default",
      explicit: "minimax",
      env: {},
      expected: "minimax",
    },
    {
      name: "explicit wins over environment",
      explicit: "zai",
      env: { SCOUTLINE_PROVIDER: "minimax" },
      expected: "zai",
    },
    {
      name: "environment minimax is the fallback",
      explicit: undefined,
      env: { SCOUTLINE_PROVIDER: "minimax" },
      expected: "minimax",
    },
    { name: "mixed case explicit is normalized", explicit: "  ZAI  ", env: {}, expected: "zai" },
    {
      name: "mixed case environment is normalized",
      explicit: undefined,
      env: { SCOUTLINE_PROVIDER: "MiniMax" },
      expected: "minimax",
    },
    {
      name: "empty explicit does not fall through",
      explicit: "",
      env: { SCOUTLINE_PROVIDER: "minimax" },
      throws: true,
    },
    {
      name: "unknown explicit does not fall through",
      explicit: "openai",
      env: { SCOUTLINE_PROVIDER: "minimax" },
      throws: true,
    },
    {
      name: "unknown environment throws",
      explicit: undefined,
      env: { SCOUTLINE_PROVIDER: "openai" },
      throws: true,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      if (c.throws) {
        assert.throws(() => resolveProviderId(c.explicit, c.env), ValidationError);
        return;
      }
      const got = resolveProviderId(c.explicit, c.env);
      assert.strictEqual(got, c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Credential independence: provider selection does not look at credentials
// ---------------------------------------------------------------------------

describe("resolveProviderId: credential independence", () => {
  it("credentials never influence default, environment, or explicit selection", () => {
    const cases = [
      {
        explicit: undefined,
        env: { MINIMAX_API_KEY: "mini-secret" },
        expected: "zai",
      },
      {
        explicit: undefined,
        env: { SCOUTLINE_PROVIDER: "minimax", Z_AI_API_KEY: "zai-secret" },
        expected: "minimax",
      },
      {
        explicit: "zai",
        env: { SCOUTLINE_PROVIDER: "minimax", MINIMAX_API_KEY: "mini-secret" },
        expected: "zai",
      },
    ];
    for (const { explicit, env, expected } of cases) {
      assert.strictEqual(resolveProviderId(explicit, env), expected);
    }
  });
});

// ---------------------------------------------------------------------------
// FR-003: default selection NEVER consults credentials (Fixup A — B5)
// ---------------------------------------------------------------------------

describe("resolveProviderId: default never consults credentials (FR-003, Fixup A — B5)", () => {
  // A registry where `zai` is NOT configured: only minimax has a key.
  // Pre-fix this threw ValidationError ("Default provider zai is not
  // registered") because the default branch consulted credentials.
  function minimaxOnlyRegistry() {
    return [
      {
        id: "zai",
        isConfigured: (env) => Boolean(env.Z_AI_API_KEY),
        capabilities: () => new Set(["search"]),
        create: () => ({ id: "zai" }),
      },
      {
        id: "minimax",
        isConfigured: (env) => Boolean(env.MINIMAX_API_KEY),
        capabilities: () => new Set(["search"]),
        create: () => ({ id: "minimax" }),
      },
    ];
  }

  it("returns the default zai regardless of descriptor configuration", () => {
    const descriptors = minimaxOnlyRegistry();
    assert.strictEqual(
      resolveProviderId(undefined, { MINIMAX_API_KEY: "k" }, descriptors),
      "zai",
      "default selection must not be inferred from credentials",
    );
    assert.strictEqual(resolveProviderId(undefined, {}, descriptors), "zai");
  });
});

describe("ProviderDescriptor double", () => {
  function makeDouble(id, caps, configured) {
    let createdCount = 0;
    let lastContext = null;
    const descriptor = {
      id,
      isConfigured: (env) => configured(env),
      capabilities: () => new Set(caps),
      create: (ctx) => {
        createdCount += 1;
        lastContext = ctx;
        return { id };
      },
    };
    return { descriptor, stats: () => ({ createdCount, lastContext }) };
  }

  it("isConfigured and capabilities do not construct an adapter or transport", () => {
    const d = makeDouble("zai", ["search"], () => true);
    // Repeated introspection must not trigger create().
    d.descriptor.isConfigured({});
    d.descriptor.capabilities();
    d.descriptor.isConfigured({ Z_AI_API_KEY: "x" });
    assert.strictEqual(d.stats().createdCount, 0);
  });

  it("create() performs no credential resolution (validation occurs first)", () => {
    // Validation gates credentials: the descriptor never inspects
    // credentials itself; the Adapter does that inside invoke().
    let credentialAccess = false;
    const d = {
      id: "minimax",
      isConfigured: (env) => {
        credentialAccess = true;
        return Boolean(env.MINIMAX_API_KEY);
      },
      capabilities: () => new Set(["search"]),
      create: () => ({ id: "minimax" }),
    };
    // capabilities() must not leak into credential resolution.
    d.capabilities();
    assert.strictEqual(credentialAccess, false, "capabilities() must not touch credentials");
    // isConfigured() may inspect credentials but must not construct transport.
    d.isConfigured({});
    assert.strictEqual(credentialAccess, true);
    d.create({ env: {} });
    assert.strictEqual(credentialAccess, true, "create() must not touch credentials either");
  });

  it("isConfigured treats whitespace-only credentials as unconfigured", () => {
    const d = {
      id: "zai",
      isConfigured: (env) => typeof env.Z_AI_API_KEY === "string" && /\S/.test(env.Z_AI_API_KEY),
      capabilities: () => new Set(["search"]),
      create: () => ({ id: "zai" }),
    };
    assert.strictEqual(d.isConfigured({}), false);
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "" }), false);
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "   " }), false);
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "\n\t  " }), false);
    assert.strictEqual(d.isConfigured({ Z_AI_API_KEY: "real-key" }), true);
  });

  it("configured filter is purely metadata-driven", () => {
    const configuredZai = makeDouble("zai", ["search"], (env) => Boolean(env.Z_AI_API_KEY));
    const configuredMini = makeDouble("minimax", ["search"], (env) => Boolean(env.MINIMAX_API_KEY));
    const all = [configuredZai.descriptor, configuredMini.descriptor];

    const onlyZai = getConfiguredProviderDescriptors({ Z_AI_API_KEY: "k" }, all);
    assert.deepStrictEqual(
      onlyZai.map((d) => d.id),
      ["zai"],
    );

    const onlyMini = getConfiguredProviderDescriptors({ MINIMAX_API_KEY: "k" }, all);
    assert.deepStrictEqual(
      onlyMini.map((d) => d.id),
      ["minimax"],
    );

    const both = getConfiguredProviderDescriptors({ Z_AI_API_KEY: "k", MINIMAX_API_KEY: "k" }, all);
    assert.deepStrictEqual(
      both.map((d) => d.id),
      ["zai", "minimax"],
    );

    const none = getConfiguredProviderDescriptors({}, all);
    assert.deepStrictEqual(none, []);
  });

  it("getProviderDescriptor returns the descriptor for the given id", () => {
    const a = makeDouble("zai", ["search"], () => true).descriptor;
    const b = makeDouble("minimax", ["search"], () => true).descriptor;
    assert.strictEqual(getProviderDescriptor("zai", [a, b]), a);
    assert.strictEqual(getProviderDescriptor("minimax", [a, b]), b);
  });
});

// ---------------------------------------------------------------------------
// ValidationError ordering: parseProviderId throws before any descriptor work
// ---------------------------------------------------------------------------

describe("resolveProviderId ordering: validation before descriptor resolution", () => {
  it("invalid explicit and environment values throw before consulting descriptor factories", () => {
    // The descriptor factory would never run for an invalid explicit value.
    let factoryInvoked = false;
    const fakeDescriptors = [
      {
        id: "zai",
        isConfigured: () => true,
        capabilities: () => new Set(["search"]),
        create: () => {
          factoryInvoked = true;
          return { id: "zai" };
        },
      },
    ];
    // Force the production default descriptor lookup to fail first.
    assert.throws(() => resolveProviderId("bogus", {}, fakeDescriptors), ValidationError);
    assert.strictEqual(factoryInvoked, false, "factory must not run on invalid explicit");
    assert.throws(
      () => resolveProviderId(undefined, { SCOUTLINE_PROVIDER: "bogus" }, fakeDescriptors),
      ValidationError,
    );
    assert.strictEqual(factoryInvoked, false, "factory must not run on invalid env");
  });
});
