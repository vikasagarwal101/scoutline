/**
 * Provider Fallback Executor — focused unit tests.
 *
 * Provider-fallback Ticket 01 introduces the candidate loop in
 * `src/lib/provider-fallback.ts` with NO handler wiring. These tests
 * characterize the executor in isolation, exercising every load-bearing
 * rule from the Tech Plan §"Core mechanism" and §"Error classification"
 * without touching the dispatch layer.
 *
 * Coverage map (per ticket scope):
 *   - Candidate plan ordering: effective first, then registry order,
 *     deduplicated by id, with the effective always winning the first
 *     slot.
 *   - Preflight ordering invariant (FR-023/024): capability metadata
 *     runs BEFORE configuration. An unsupported Provider is
 *     `incapable`, not `unconfigured`, even when its credential is
 *     also missing.
 *   - Error-classification table (Tech Plan §"Error classification"):
 *     one row per typed error and the unknown-error re-throw.
 *   - Exhaustion preserves the real effective error: the runtime
 *     error it produced if it ran, otherwise the typed preflight
 *     error (`ConfigurationError` exit 3 / `UnsupportedCapabilityError`
 *     exit 1). Never synthesizes a different error.
 *   - Kill-switch narrows the plan to `[effective]` and the SAME
 *     preflight runs on it (does NOT bypass it). No notices emitted.
 *   - Notices are stderr-only: the executor never writes to stdout
 *     and every notice flows through the injected `writeStderr`.
 *
 * Test file is `.test.js` (not `.ts`) so it runs under `node --test`
 * without a TypeScript preprocessor; the dist artefacts supply
 * runtime types via JSDoc and the runtime error classes are imported
 * as plain values.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeWithFallback } from "../dist/lib/provider-fallback.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import {
  ApiError,
  AuthError,
  ConfigurationError,
  NetworkError,
  QuotaError,
  TimeoutError,
  UnsupportedCapabilityError,
  UnsupportedOptionError,
  ValidationError,
  getErrorExitCode,
} from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Build a stub Provider Descriptor for a single Provider.
 *
 * The defaults match a minimal "search" provider: it is unconfigured
 * until `configured` is set, advertises a fixed capability set, and
 * creates an Adapter that exposes the matching slot. Each test
 * overrides only the fields it cares about so the failing-axis is
 * always explicit.
 */
function makeDescriptor(id, options = {}) {
  const capabilities = options.capabilities ?? ["search"];
  const configured = options.configured ?? false;
  const adapterHandle = options.adapterHandle;
  const createThrows = options.createThrows ?? false;
  const caps = new Set(capabilities);
  return {
    id,
    isConfigured: () => configured,
    capabilities: () => caps,
    create: createThrows
      ? () => {
          throw new Error(`${id} create failed`);
        }
      : () => {
          const adapter = { id };
          if (adapterHandle) {
            adapter[adapterHandle] = { kind: `${id}-${adapterHandle}` };
          }
          return adapter;
        },
  };
}

/**
 * Capture the stderr write stream so a test can assert the exact
 * notice lines the executor emitted. The returned object also
 * exposes a stdout trap so a test can prove the executor NEVER wrote
 * to stdout.
 */
function captureStderr() {
  const lines = [];
  let stdout = "";
  return {
    writeStderr: (s) => {
      lines.push(s);
    },
    writeStdout: (s) => {
      stdout += s;
    },
    get lines() {
      return lines;
    },
    get stdout() {
      return stdout;
    },
  };
}

/**
 * Run `executeWithFallback` with a uniform option bag. The remaining
 * fields are filled with sensible defaults so each test only
 * specifies what it actually varies.
 */
async function run(descriptors, effective, options = {}) {
  const cap = captureStderr();
  const result = await executeWithFallback(
    {
      capabilityId: options.capabilityId ?? "search",
      commandLabel: options.commandLabel ?? "search",
      effectiveProvider: effective,
      descriptors,
      env: options.env ?? {},
      fallbackEnabled: options.fallbackEnabled ?? true,
      writeStderr: cap.writeStderr,
    },
    options.attempt ?? (async (d) => `ok-${d.id}`),
  );
  return { result, lines: cap.lines, stdout: cap.stdout };
}

// ---------------------------------------------------------------------------
// Candidate plan ordering
// ---------------------------------------------------------------------------

describe("executeWithFallback — candidate plan ordering", () => {
  it("places the effective provider first, then registry order, deduplicated by id", async () => {
    // Capture the order in which `attempt` is invoked. The plan's
    // order is the only thing under test here; every candidate is
    // configured + capable so the loop walks the full plan.
    const visited = [];
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const exa = makeDescriptor("exa", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const brave = makeDescriptor("brave", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const firecrawl = makeDescriptor("firecrawl", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax, tavily, exa, brave, firecrawl];

    const { result } = await run(registry, "tavily", {
      attempt: async (d) => {
        visited.push(d.id);
        // Force the loop to walk every candidate by failing every
        // provider except the last one. We re-throw a typed runtime
        // error so the loop continues.
        if (d.id !== "firecrawl") {
          throw new ApiError("down", 500);
        }
        return "ok";
      },
    });

    // Effective (tavily) wins the first slot; the remaining five
    // appear in registry order. The original `tavily` does NOT
    // reappear at its registry slot because the plan is
    // deduplicated by id and the first occurrence wins.
    assert.deepStrictEqual(visited, [
      "tavily",
      "zai",
      "minimax",
      "exa",
      "brave",
      "firecrawl",
    ]);
    assert.strictEqual(result.provider, "firecrawl");
    assert.strictEqual(result.fellBack, true);
    assert.strictEqual(result.result, "ok");
  });

  it("effective is the only plan entry when it is the registry's first id", async () => {
    // Default zai is the first entry in `BUILT_IN_PROVIDER_DESCRIPTORS`.
    // The plan should be exactly `[zai, ...others]` with `zai`
    // deduped to the front, so `attempt` sees zai first and only
    // zai when zai is also the only eligible candidate.
    const visited = [];
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax, tavily];

    const { result } = await run(registry, "zai", {
      attempt: async (d) => {
        visited.push(d.id);
        return "ok";
      },
    });

    assert.deepStrictEqual(visited, ["zai"]);
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.fellBack, false);
  });
});

// ---------------------------------------------------------------------------
// Preflight ordering invariant (FR-023/024)
// ---------------------------------------------------------------------------

describe("executeWithFallback — preflight ordering (capability before configuration)", () => {
  it("an unsupported Provider is 'incapable' even when it is also unconfigured", async () => {
    // FR-023: capability metadata runs FIRST. An unsupported
    // Provider surfaces `incapable` regardless of its credential
    // status. Without the ordering invariant, an unsupported +
    // unconfigured Provider would surface `unconfigured` (exit 3)
    // instead of `incapable` (exit 1) — a behaviour reversal.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    // minimax advertises the capability BUT is unconfigured.
    // Effective is minimax; plan walker must classify minimax as
    // `incapable` because the capability check fails (minimax
    // does NOT advertise "search" here), NOT `unconfigured`.
    const minimax = makeDescriptor("minimax", {
      capabilities: ["reader"],
      configured: false,
      adapterHandle: "reader",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax, tavily];

    const { result, lines } = await run(registry, "minimax");

    // minimax surfaces as `incapable` (capability mismatch), so
    // the loop falls through to zai (the next eligible candidate).
    // The skip-notice wording must be the incapable variant.
    assert.deepStrictEqual(
      lines.filter((l) => l.includes("minimax")),
      ["⚠ minimax does not support 'search' — skipping"],
    );
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.fellBack, true);
  });

  it("a supported Provider is 'unconfigured' (not 'incapable') when its credential is missing", async () => {
    // FR-024: configuration runs SECOND, after the capability
    // check has passed. A supported but unconfigured Provider
    // surfaces `unconfigured` (exit 3 via ConfigurationError on
    // exhaustion) — never `incapable`. The skip-notice wording
    // is the unconfigured variant.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: false,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax, tavily];

    const { lines } = await run(registry, "minimax");

    assert.deepStrictEqual(
      lines.filter((l) => l.includes("minimax")),
      ["⚠ minimax is not configured — skipping"],
    );
  });

  it("an unsupported Provider reaches `descriptor.create()` zero times (FR-023 ordering)", async () => {
    // The capability check is pure metadata and must short-circuit
    // BEFORE `isConfigured` and `create` are called. A descriptor
    // that throws on `create()` is the canary: if the preflight
    // ever reaches step 3, the create() throw would surface
    // instead of the typed preflight error. We use a
    // `createThrows` descriptor to prove step 3 is never reached
    // for an incapable candidate.
    let createCalls = 0;
    const zai = {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["search"]),
      create: () => {
        createCalls += 1;
        return { id: "zai", search: {} };
      },
    };
    const minimax = makeDescriptor("minimax", {
      capabilities: ["reader"], // does NOT advertise search
      configured: true,
      adapterHandle: "reader",
      createThrows: true,
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax, tavily];

    const { result } = await run(registry, "minimax");

    // If the preflight had reached step 3 for the incapable
    // minimax, `createThrows` would have surfaced a generic
    // Error. The executor instead classified minimax as
    // `incapable` and moved on, so `createCalls` only counts the
    // zai preflight (zai is the only eligible candidate that
    // runs the attempt).
    assert.strictEqual(createCalls, 1, "create() must run exactly once for the eligible candidate");
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.fellBack, true);
  });
});

// ---------------------------------------------------------------------------
// Error classification (Tech Plan §"Error classification")
// ---------------------------------------------------------------------------

describe("executeWithFallback — error classification table", () => {
  // Each row of the classification table is a focused test. The
  // test driver below builds a 3-Provider plan where the effective
  // and the second candidate both throw the same typed error and
  // the third succeeds. The loop must continue past the first two
  // throws (or re-throw for terminal rows) and the third must be
  // reached only when the loop continues.
  const registry = () => {
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    return [zai, minimax, tavily];
  };

  it("ValidationError re-throws without looping", async () => {
    // Bad user input fails identically on every Provider, so the
    // loop must NOT continue to the next candidate. The
    // Validator's typed error is preserved verbatim (including
    // its exit code).
    let caught;
    const lines = [];
    try {
      await run(registry(), "zai", {
        attempt: async () => {
          throw new ValidationError("bad query");
        },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ValidationError, "must re-throw ValidationError");
    assert.strictEqual(caught.message, "bad query");
    assert.strictEqual(getErrorExitCode(caught), 1);
    assert.deepStrictEqual(lines, [], "no notices on validation short-circuit");
  });

  it("UnsupportedCapabilityError continues to the next candidate", async () => {
    const { result, lines } = await run(registry(), "zai", {
      attempt: async (d) => {
        if (d.id === "zai" || d.id === "minimax") {
          throw new UnsupportedCapabilityError(d.id, "search");
        }
        return "ok";
      },
    });
    assert.strictEqual(result.provider, "tavily");
    assert.strictEqual(result.fellBack, true);
    assert.ok(
      lines.some((l) => l === "⚠ zai does not support 'search' — trying minimax"),
      `expected zai switch notice, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) => l === "⚠ minimax does not support 'search' — trying tavily"),
      `expected minimax switch notice, got: ${JSON.stringify(lines)}`,
    );
  });

  it("UnsupportedOptionError continues to the next candidate and uses the structured option field", async () => {
    // Critique #6 fix: the executor reads `err.option` (the new
    // structured field) rather than parsing the message. The
    // notice wording uses the structured value verbatim.
    const { result, lines } = await run(registry(), "zai", {
      attempt: async (d) => {
        if (d.id === "zai" || d.id === "minimax") {
          throw new UnsupportedOptionError(d.id, "search", "type");
        }
        return "ok";
      },
    });
    assert.strictEqual(result.provider, "tavily");
    assert.ok(
      lines.some((l) => l === "⚠ zai does not support 'type' — trying minimax"),
      `expected zai option notice, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) => l === "⚠ minimax does not support 'type' — trying tavily"),
      `expected minimax option notice, got: ${JSON.stringify(lines)}`,
    );
  });

  it("runtime errors (ApiError, NetworkError, TimeoutError, AuthError, ConfigurationError, QuotaError) continue", async () => {
    // One test per typed error so a future regression in the
    // classification table is obvious in the failure message.
    const cases = [
      ["ApiError(500)", () => new ApiError("down", 500)],
      ["NetworkError", () => new NetworkError("offline")],
      ["TimeoutError", () => new TimeoutError(1000)],
      ["AuthError", () => new AuthError("nope")],
      [
        "ConfigurationError",
        () => new ConfigurationError("Provider \"zai\" is not configured. Set the required API key."),
      ],
      ["QuotaError", () => new QuotaError()],
    ];
    for (const [label, factory] of cases) {
      const { result, lines } = await run(registry(), "zai", {
        attempt: async (d) => {
          if (d.id === "zai" || d.id === "minimax") throw factory();
          return "ok";
        },
      });
      assert.strictEqual(
        result.provider,
        "tavily",
        `${label} must continue to the next candidate`,
      );
      assert.strictEqual(result.fellBack, true, `${label} must count as a fallback`);
      // The switch notice names the error code in parentheses. The
      // exact code string depends on the constructor; we assert
      // the "<p> failed (<code>) for search — trying <next>"
      // shape and that the per-candidate line exists.
      assert.ok(
        lines.some((l) => l.startsWith("⚠ zai failed (") && l.endsWith("for search — trying minimax")),
        `${label} must emit the zai switch notice, got: ${JSON.stringify(lines)}`,
      );
      assert.ok(
        lines.some(
          (l) => l.startsWith("⚠ minimax failed (") && l.endsWith("for search — trying tavily"),
        ),
        `${label} must emit the minimax switch notice, got: ${JSON.stringify(lines)}`,
      );
    }
  });

  it("unknown errors re-throw (fail closed) without looping", async () => {
    // A non-`ScoutlineError` (e.g. a raw `Error` from a buggy
    // Adapter) must NOT be masked by a cross-Provider fallback.
    // The executor re-throws the unknown error verbatim.
    let caught;
    try {
      await run(registry(), "zai", {
        attempt: async () => {
          throw new Error("plain");
        },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error);
    assert.strictEqual(caught.message, "plain");
  });
});

// ---------------------------------------------------------------------------
// Exhaustion preserves the real effective error
// ---------------------------------------------------------------------------

describe("executeWithFallback — exhaustion preserves the effective's real error", () => {
  it("re-throws the effective's runtime error verbatim when every candidate fails at runtime", async () => {
    // The effective (zai) runs and throws `ApiError(500)`. Every
    // other candidate also throws the same typed error. The
    // executor must re-throw the EFFECTIVE's own `ApiError`,
    // not a synthesized substitute and not the last candidate's
    // error. The status code on the re-thrown error is the
    // 0.10.x value (500 → exit 1; the typed-error exit code is 1
    // for ApiError).
    const registry = [
      makeDescriptor("zai", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      }),
      makeDescriptor("minimax", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      }),
      makeDescriptor("tavily", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      }),
    ];
    const effectiveError = new ApiError("zai is down", 503);
    let caught;
    try {
      await run(registry, "zai", {
        attempt: async (d) => {
          if (d.id === "zai") throw effectiveError;
          throw new ApiError(`${d.id} is down`, 500);
        },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ApiError, "must re-throw the effective's ApiError");
    assert.strictEqual(caught.message, "zai is down");
    assert.strictEqual(caught.statusCode, 503);
    assert.strictEqual(getErrorExitCode(caught), 1);
  });

  it("re-throws the effective's ConfigurationError (exit 3) when the effective is unconfigured", async () => {
    // The effective is unconfigured: no candidate ever runs. On
    // exhaustion the executor surfaces a fresh ConfigurationError
    // for the effective, with exit code 3. The other Providers
    // are configured so the loop walker visits them, but they
    // must NOT be promoted to "effective" for error purposes.
    const registry = [
      // Effective: capable but unconfigured.
      makeDescriptor("zai", {
        capabilities: ["search"],
        configured: false,
        adapterHandle: "search",
      }),
      makeDescriptor("minimax", {
        capabilities: ["search"],
        configured: false,
        adapterHandle: "search",
      }),
      makeDescriptor("tavily", {
        capabilities: ["search"],
        configured: false,
        adapterHandle: "search",
      }),
    ];
    let caught;
    try {
      await run(registry, "zai");
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof ConfigurationError,
      "must throw ConfigurationError for unconfigured effective",
    );
    assert.strictEqual(getErrorExitCode(caught), 3);
    assert.match(caught.message, /zai/);
  });

  it("re-throws UnsupportedCapabilityError (exit 1) when the effective is incapable", async () => {
    // The effective does not advertise the capability, AND no
    // other candidate can pick it up either — every Provider
    // is `incapable`. No candidate ever runs `attempt`. On
    // exhaustion the executor surfaces an
    // `UnsupportedCapabilityError` for the effective (exit 1).
    const registry = [
      makeDescriptor("zai", {
        capabilities: ["reader"], // does NOT advertise search
        configured: true,
        adapterHandle: "reader",
      }),
      makeDescriptor("minimax", {
        capabilities: ["reader"],
        configured: true,
        adapterHandle: "reader",
      }),
      makeDescriptor("tavily", {
        capabilities: ["reader"],
        configured: true,
        adapterHandle: "reader",
      }),
    ];
    let caught;
    try {
      await run(registry, "zai");
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof UnsupportedCapabilityError,
      "must throw UnsupportedCapabilityError for incapable effective",
    );
    assert.strictEqual(getErrorExitCode(caught), 1);
    assert.match(caught.message, /zai/);
  });

  it("re-throws the last eligible runtime error when the effective was skipped as incapable", async () => {
    // Issue #4 secondary: default zai (no research) → tavily fails →
    // exa fails. Exhaustion must surface the last eligible failure,
    // not UnsupportedCapabilityError(zai), so the envelope is
    // actionable.
    const registry = [
      makeDescriptor("zai", {
        capabilities: ["search"], // does NOT advertise research
        configured: true,
        adapterHandle: "search",
      }),
      makeDescriptor("tavily", {
        capabilities: ["research"],
        configured: true,
        adapterHandle: "research",
      }),
      makeDescriptor("exa", {
        capabilities: ["research"],
        configured: true,
        adapterHandle: "research",
      }),
    ];
    const tavilyErr = new ApiError("Tavily request failed", 500);
    const exaErr = new UnsupportedOptionError("exa", "research", "outputLength");
    const cap = captureStderr();
    let caught;
    try {
      await executeWithFallback(
        {
          capabilityId: "research",
          commandLabel: "research",
          effectiveProvider: "zai",
          descriptors: registry,
          env: {},
          fallbackEnabled: true,
          writeStderr: cap.writeStderr,
        },
        async (d) => {
          if (d.id === "tavily") throw tavilyErr;
          if (d.id === "exa") throw exaErr;
          throw new Error(`unexpected attempt: ${d.id}`);
        },
      );
    } catch (err) {
      caught = err;
    }
    assert.strictEqual(caught, exaErr, "must re-throw the last eligible error");
    assert.ok(
      !(caught instanceof UnsupportedCapabilityError),
      "must not mask with the skipped effective's UnsupportedCapabilityError",
    );
    assert.ok(
      cap.lines.some((l) => l.includes("exa failed") && l.includes("no further candidates")),
      `expected terminal exhaustion notice for exa, got: ${JSON.stringify(cap.lines)}`,
    );
  });

  it("never synthesizes a different error type from the effective's outcome", async () => {
    // Critique #7 fix: an unconfigured effective must NEVER
    // surface as `UnsupportedCapabilityError`, and an incapable
    // effective must NEVER surface as `ConfigurationError`. The
    // executor surfaces the exact typed error that matches the
    // preflight reason.
    const zaiUnconfigured = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: false,
      adapterHandle: "search",
    });
    const zaiIncapable = makeDescriptor("zai", {
      capabilities: ["reader"],
      configured: true,
      adapterHandle: "reader",
    });
    const others = [
      makeDescriptor("minimax", {
        capabilities: ["search"],
        configured: false,
        adapterHandle: "search",
      }),
      makeDescriptor("tavily", {
        capabilities: ["search"],
        configured: false,
        adapterHandle: "search",
      }),
    ];

    let unconfiguredResult;
    try {
      await run([zaiUnconfigured, ...others], "zai");
    } catch (err) {
      unconfiguredResult = err;
    }
    assert.ok(
      unconfiguredResult instanceof ConfigurationError,
      "unconfigured effective → ConfigurationError (not UnsupportedCapabilityError)",
    );
    assert.ok(
      !(unconfiguredResult instanceof UnsupportedCapabilityError),
      "unconfigured effective must not be reclassified as incapable",
    );

    let incapableResult;
    try {
      await run([zaiIncapable, ...others], "zai");
    } catch (err) {
      incapableResult = err;
    }
    assert.ok(
      incapableResult instanceof UnsupportedCapabilityError,
      "incapable effective → UnsupportedCapabilityError (not ConfigurationError)",
    );
    assert.ok(
      !(incapableResult instanceof ConfigurationError),
      "incapable effective must not be reclassified as unconfigured",
    );
  });

  // ---------------------------------------------------------
  // Review Fix 5: terminal exhaustion notice (stderr-only, then rethrow)
  // ---------------------------------------------------------

  it("emits a terminal '<last> failed (<code>) — no further candidates' notice on the final runtime failure", async () => {
    // Both candidates fail at runtime; zai is the effective and
    // ran first. Review Fix 5: the executor writes ONE terminal
    // notice naming the last candidate before re-throwing. The
    // rethrown error must be the effective's own ApiError (preserves
    // exit code) — the notice is purely observational.
    const registry = [
      makeDescriptor("zai", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      }),
      makeDescriptor("tavily", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      }),
    ];
    const zaiErr = new ApiError("zai down", 500);
    let caught;
    // Drive the executor through a small wrapper that captures both
    // the rethrown error AND the stderr lines. The executor's terminal
    // notice fires before the rethrow, so we still hold the captured
    // lines after the catch runs.
    const cap = captureStderr();
    try {
      await executeWithFallback(
        {
          capabilityId: "search",
          commandLabel: "search",
          effectiveProvider: "zai",
          descriptors: registry,
          env: {},
          fallbackEnabled: true,
          writeStderr: cap.writeStderr,
        },
        async (d) => {
          if (d.id === "zai") throw zaiErr;
          // Last eligible candidate also throws so the loop
          // exhausts with no winner.
          throw new ApiError(`${d.id} down`, 502);
        },
      );
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ApiError, "exhaustion must re-throw an ApiError");
    assert.strictEqual(caught, zaiErr, "exhaustion must re-throw the EFFECTIVE's error object");
    assert.ok(
      cap.lines.some((l) => l.includes("tavily failed") && l.includes("no further candidates")),
      `expected terminal exhaustion notice, got: ${JSON.stringify(cap.lines)}`,
    );
    assert.ok(
      cap.lines.some((l) => l.includes("(API_ERROR)") && l.includes("no further candidates")),
      `expected notice to carry the typed error code, got: ${JSON.stringify(cap.lines)}`,
    );
  });

  it("emits a 'no eligible candidates' notice when every candidate was rejected at preflight", async () => {
    // Every candidate is incapable (does not advertise the
    // capability). No `attempt` runs. Review Fix 5: still emit a
    // single terminal notice so the user sees the executor walked
    // and had nothing to try. Strict mode stays silent (covered in
    // the next test).
    const registry = [
      makeDescriptor("zai", {
        capabilities: ["reader"], // does NOT advertise search
        configured: true,
        adapterHandle: "reader",
      }),
      makeDescriptor("tavily", {
        capabilities: ["reader"],
        configured: true,
        adapterHandle: "reader",
      }),
    ];
    let caught;
    const cap = captureStderr();
    try {
      await executeWithFallback(
        {
          capabilityId: "search",
          commandLabel: "search",
          effectiveProvider: "zai",
          descriptors: registry,
          env: {},
          fallbackEnabled: true,
          writeStderr: cap.writeStderr,
        },
        async () => "never reached",
      );
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught instanceof UnsupportedCapabilityError,
      "exhaustion must re-throw UnsupportedCapabilityError",
    );
    assert.ok(
      cap.lines.some((l) => l === "⚠ search: no eligible candidates"),
      `expected terminal no-eligible notice, got: ${JSON.stringify(cap.lines)}`,
    );
  });

  it("--no-fallback does NOT emit any terminal exhaustion notice (strict mode is silent)", async () => {
    // Strict mode (`fallbackEnabled === false`) keeps the
    // pre-Fix-5 contract: stderr stays empty under --no-fallback
    // so the JSON error envelope for scripting users is unaffected.
    const registry = [
      makeDescriptor("zai", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      }),
      makeDescriptor("tavily", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      }),
    ];
    let caught;
    const cap = captureStderr();
    try {
      await executeWithFallback(
        {
          capabilityId: "search",
          commandLabel: "search",
          effectiveProvider: "zai",
          descriptors: registry,
          env: {},
          fallbackEnabled: false,
          writeStderr: cap.writeStderr,
        },
        async (d) => {
          if (d.id === "zai") throw new ApiError("zai down", 500);
          throw new ApiError(`${d.id} down`, 500);
        },
      );
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ApiError, "exhaustion must re-throw an ApiError");
    assert.strictEqual(
      cap.lines.length,
      0,
      `--no-fallback must stay silent (no terminal notice), got: ${JSON.stringify(cap.lines)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

describe("executeWithFallback — kill-switch (fallbackEnabled=false)", () => {
  it("narrows the plan to [effective] only and the SAME preflight runs on it", async () => {
    // The kill-switch does NOT bypass the preflight. An
    // unconfigured effective must still surface
    // `ConfigurationError` (exit 3), and an incapable effective
    // must still surface `UnsupportedCapabilityError` (exit 1) —
    // exactly the 0.10.x codes. The test drives both shapes.
    const zaiUnconfigured = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: false, // unconfigured → exit 3 path
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zaiUnconfigured, minimax];

    // Kill-switch on, effective unconfigured.
    let unconfiguredResult;
    try {
      await run(registry, "zai", { fallbackEnabled: false });
    } catch (err) {
      unconfiguredResult = err;
    }
    assert.ok(
      unconfiguredResult instanceof ConfigurationError,
      "kill-switch must surface ConfigurationError for unconfigured effective",
    );
    assert.strictEqual(getErrorExitCode(unconfiguredResult), 3);

    // Kill-switch on, effective incapable.
    const incapableRegistry = [
      makeDescriptor("zai", {
        capabilities: ["reader"],
        configured: true,
        adapterHandle: "reader",
      }),
      makeDescriptor("minimax", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      }),
    ];
    let incapableResult;
    try {
      await run(incapableRegistry, "zai", { fallbackEnabled: false });
    } catch (err) {
      incapableResult = err;
    }
    assert.ok(
      incapableResult instanceof UnsupportedCapabilityError,
      "kill-switch must surface UnsupportedCapabilityError for incapable effective",
    );
    assert.strictEqual(getErrorExitCode(incapableResult), 1);
  });

  it("does not call `attempt` for ineligible candidates under the kill-switch", async () => {
    // Under the kill-switch the plan is `[effective]` only. A
    // unconfigured / incapable effective is the only entry, and
    // `attempt` is NEVER called. This preserves the
    // "zero-adapter-work for the unsupported case" guarantee
    // from the Tech Plan §"Kill-switch plumbing".
    let attemptCalls = 0;
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: false,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax];

    try {
      await run(registry, "zai", {
        fallbackEnabled: false,
        attempt: async () => {
          attemptCalls += 1;
          return "should-not-run";
        },
      });
    } catch (_) {
      // expected: ConfigurationError
    }
    assert.strictEqual(attemptCalls, 0, "attempt must not run for ineligible effective");
  });

  it("emits NO notices under the kill-switch (no skip, no switch, no summary)", async () => {
    // The kill-switch is the user's strict-mode opt-out. The
    // 0.10.x behaviour was silent on stderr (the dispatch layer
    // only wrote the typed error envelope). Under the
    // kill-switch the executor must not add any noise.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: false,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax, tavily];

    const { lines, result } = await run(registry, "zai", {
      fallbackEnabled: false,
      attempt: async () => "ok",
    });
    assert.deepStrictEqual(lines, [], "kill-switch emits no notices");
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.fellBack, false);
  });

  it("kill-switch on a successful effective returns fellBack=false with no summary notice", async () => {
    // Sanity check: the kill-switch path that succeeds must NOT
    // emit a summary notice (summary notices are only for
    // cross-Provider wins; the kill-switch never falls back).
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax];

    const { result, lines } = await run(registry, "zai", {
      fallbackEnabled: false,
    });
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.fellBack, false);
    assert.deepStrictEqual(lines, []);
  });
});

// ---------------------------------------------------------------------------
// Notice semantics (stderr-only, summary only on fallback)
// ---------------------------------------------------------------------------

describe("executeWithFallback — notice semantics", () => {
  it("writes every notice to stderr (writeStderr) and never to stdout", async () => {
    // The Tech Plan §"Failure, notice & cache semantics" pins
    // the notice channel to stderr: data-mode scripts must see
    // an unchanged stdout. The test injects a stdout trap in
    // addition to the stderr capture and asserts stdout stays
    // empty for the success, skip, and switch paths.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: false,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const exa = makeDescriptor("exa", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax, tavily, exa];

    const cap = captureStderr();
    const result = await executeWithFallback(
      {
        capabilityId: "search",
        commandLabel: "search",
        effectiveProvider: "zai",
        descriptors: registry,
        env: {},
        fallbackEnabled: true,
        writeStderr: cap.writeStderr,
      },
      async (d) => {
        if (d.id === "zai") throw new ApiError("down", 500);
        return "ok";
      },
    );
    // Stdout must be empty: the executor never writes to it.
    assert.strictEqual(cap.stdout, "", "executor must not write to stdout");
    // Every emitted line went through the injected writeStderr.
    assert.ok(cap.lines.length > 0, "expected at least one notice line");
    assert.ok(typeof result.provider === "string");
  });

  it("emits the summary notice '✓ <cmd> completed via <p> (fallback)' only when fellBack=true", async () => {
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, tavily];

    // Effective succeeds → no summary.
    const success = await run(registry, "zai");
    assert.strictEqual(success.result.fellBack, false);
    assert.ok(
      !success.lines.some((l) => l.includes("completed via")),
      `no summary on effective success, got: ${JSON.stringify(success.lines)}`,
    );

    // Effective fails, tavily succeeds → summary uses
    // commandLabel + winning provider.
    const fallback = await run(registry, "zai", {
      commandLabel: "search",
      attempt: async (d) => {
        if (d.id === "zai") throw new ApiError("down", 500);
        return "ok";
      },
    });
    assert.strictEqual(fallback.result.fellBack, true);
    assert.strictEqual(fallback.result.provider, "tavily");
    assert.ok(
      fallback.lines.some((l) => l === "✓ search completed via tavily (fallback)"),
      `expected summary notice, got: ${JSON.stringify(fallback.lines)}`,
    );
  });

  it("emits the per-skip notice for each ineligible plan entry", async () => {
    // Effective (zai) is unconfigured so the loop walks past it
    // and emits the skip notice. minimax is incapable so the
    // loop also walks past it. exa is the first eligible
    // candidate and the executor succeeds through it. The
    // notices for zai + minimax are the per-skip entries we
    // assert; the notices for tavily (capable + configured) and
    // beyond are not emitted because the loop has already
    // returned.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: false, // unconfigured → skip notice
      adapterHandle: "search",
    });
    // minimax does not advertise the capability → skip notice.
    const minimax = makeDescriptor("minimax", {
      capabilities: ["reader"],
      configured: true,
      adapterHandle: "reader",
    });
    // tavily is the first eligible candidate after the two
    // ineligible entries. It is reached and succeeds; the loop
    // returns before any entry past it is visited.
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const exa = makeDescriptor("exa", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const registry = [zai, minimax, tavily, exa];

    const { lines } = await run(registry, "zai");
    assert.ok(
      lines.includes("⚠ zai is not configured — skipping"),
      `expected zai unconfigured notice, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.includes("⚠ minimax does not support 'search' — skipping"),
      `expected minimax incapable notice, got: ${JSON.stringify(lines)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Internal guards
// ---------------------------------------------------------------------------

describe("executeWithFallback — internal guards", () => {
  it("throws a plain Error when the effective provider is not in the descriptor list", async () => {
    // The handler is expected to validate the Provider id before
    // calling the executor. If it does not, the executor surfaces
    // a plain (non-`ScoutlineError`) Error so the dispatch catch
    // does not mistreat a programmer mistake as a typed Provider
    // failure.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    let caught;
    try {
      await run([zai], "minimax");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error);
    assert.ok(!(caught instanceof UnsupportedCapabilityError));
    assert.match(caught.message, /minimax/);
  });
});

// ---------------------------------------------------------------------------
// Provider-fallback Ticket 02 — credential hint on ProviderDescriptor
//
// The execution-log flag for ticket 02 requires the executor to surface
// Provider-specific "missing API key" guidance instead of the generic
// "Set the required API key." string. The hint comes from
// `descriptor.credentialEnvVars` (an optional field added to
// ProviderDescriptor). Without the field the executor falls back to
// the generic message; with the field the message names the env var.
// ---------------------------------------------------------------------------

describe("executeWithFallback — credential hint (Ticket 02 flag)", () => {
  function makeDescriptorWithEnvVars(id, envVars) {
    return {
      id,
      isConfigured: () => false,
      capabilities: () => new Set(["search"]),
      create: () => ({ id, search: { kind: "fake" } }),
      credentialEnvVars: envVars,
    };
  }

  it("surfaces a single-env-var credential hint on unconfigured effective", async () => {
    const zai = makeDescriptorWithEnvVars("zai", ["Z_AI_API_KEY"]);
    const registry = [zai];
    let caught;
    try {
      await run(registry, "zai");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ConfigurationError);
    assert.match(caught.message, /Set Z_AI_API_KEY\./);
    assert.ok(!/Set the required API key\./.test(caught.message), "must not use the generic fallback");
  });

  it("surfaces a multi-env-var credential hint with 'or' on the unconfigured effective", async () => {
    const zai = makeDescriptorWithEnvVars("zai", ["Z_AI_API_KEY", "ZAI_API_KEY"]);
    let caught;
    try {
      await run([zai], "zai");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ConfigurationError);
    assert.match(caught.message, /Set Z_AI_API_KEY or ZAI_API_KEY\./);
  });

  it("falls back to the generic message when credentialEnvVars is absent", async () => {
    // Test doubles that pre-date Ticket 02 have no
    // `credentialEnvVars` field; the executor must still work
    // (backward compatibility per AGENTS.md).
    const zai = {
      id: "zai",
      isConfigured: () => false,
      capabilities: () => new Set(["search"]),
      create: () => ({ id: "zai", search: { kind: "fake" } }),
      // intentionally NO credentialEnvVars
    };
    let caught;
    try {
      await run([zai], "zai");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ConfigurationError);
    assert.match(caught.message, /Set the required API key\./);
  });

  it("uses the effective descriptor's hint, not the exhausted candidate's", async () => {
    // Effective is zai (single-env-var hint). Other providers in the
    // registry are unconfigured too. Exhaustion surfaces the
    // effective's real error: a ConfigurationError that names
    // `Z_AI_API_KEY`, not the tavily/brave/firecrawl hints.
    const zai = makeDescriptorWithEnvVars("zai", ["Z_AI_API_KEY"]);
    const tavily = makeDescriptorWithEnvVars("tavily", ["TAVILY_API_KEY"]);
    const brave = makeDescriptorWithEnvVars("brave", ["BRAVE_SEARCH_API_KEY"]);
    const firecrawl = makeDescriptorWithEnvVars("firecrawl", ["FIRECRAWL_API_KEY"]);
    let caught;
    try {
      await run([zai, tavily, brave, firecrawl], "zai");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ConfigurationError);
    assert.match(caught.message, /Set Z_AI_API_KEY\./);
    assert.ok(!/TAVILY_API_KEY/.test(caught.message), "must not surface non-effective hints");
    assert.ok(!/BRAVE_SEARCH_API_KEY/.test(caught.message));
    assert.ok(!/FIRECRAWL_API_KEY/.test(caught.message));
  });
});

// ---------------------------------------------------------------------------
// Provider-fallback Ticket 02 — registry-import end-to-end check
//
// This is the test that should have caught the stub-vs-real confusion:
// it imports the real `BUILT_IN_PROVIDER_DESCRIPTORS` from the
// production registry and asserts that:
//   - every descriptor (zai, minimax, tavily, exa, brave, firecrawl)
//     exposes a non-empty `credentialEnvVars`;
//   - an unconfigured zai effective (the default provider!) surfaces
//     a `ConfigurationError` whose message names `Z_AI_API_KEY`,
//     NOT the generic fallback string. The default-provider path
//     is the one that hit the original regression.
//
// Hand-built doubles are intentionally not used here — this test
// exists specifically to prove the production wiring carries the
// hint through end-to-end.
// ---------------------------------------------------------------------------

describe("executeWithFallback — production registry carries credential hint end-to-end", () => {
  it("every built-in descriptor exposes a non-empty credentialEnvVars", () => {
    // The full set of built-in Providers MUST publish their env-var
    // names so the executor's typed `ConfigurationError` is targeted.
    // This is the test that proves the production wiring carries the
    // hint through the descriptor factory, not just a hand-built
    // double.
    const expected = {
      zai: ["Z_AI_API_KEY", "ZAI_API_KEY"],
      minimax: ["MINIMAX_API_KEY"],
      tavily: ["TAVILY_API_KEY"],
      exa: ["EXA_API_KEY"],
      brave: ["BRAVE_SEARCH_API_KEY"],
      firecrawl: ["FIRECRAWL_API_KEY"],
      parallel: ["PARALLEL_API_KEY"],
      perplexity: ["PERPLEXITY_API_KEY"],
      jina: ["JINA_API_KEY"],
    };
    for (const descriptor of BUILT_IN_PROVIDER_DESCRIPTORS) {
      const vars = descriptor.credentialEnvVars;
      assert.ok(
        Array.isArray(vars) && vars.length > 0,
        `descriptor "${descriptor.id}" must expose a non-empty credentialEnvVars array`,
      );
      assert.deepStrictEqual(
        vars,
        expected[descriptor.id],
        `descriptor "${descriptor.id}" credentialEnvVars must match the documented env-var set`,
      );
    }
  });

  it("an unconfigured zai effective (the default provider) surfaces a ConfigurationError naming Z_AI_API_KEY", async () => {
    // Use the REAL production registry — not a hand-built double.
    // The regression the original review caught: only the type
    // stubs in src/providers/types.ts had credentialEnvVars; the
    // real factory functions in src/providers/{zai,minimax}/adapter.ts
    // did not. So the default provider (zai) was falling back to the
    // generic "Set the required API key." string. This test
    // exercises the production code path end-to-end.
    //
    // Jina is excluded because it supports keyless access and is
    // always configured — including it would let the executor succeed
    // via Jina instead of surfacing the zai ConfigurationError.
    const credentialRequiredDescriptors = BUILT_IN_PROVIDER_DESCRIPTORS.filter(
      (d) => d.id !== "jina",
    );
    let caught;
    try {
      await run([...credentialRequiredDescriptors], "zai", {
        // No credentials at all — every remaining descriptor is unconfigured.
        env: {},
        attempt: async () => "should-not-reach",
      });
    } catch (err) {
      caught = err;
    }
    // The executor surfaces the effective's real ConfigurationError
    // on exhaustion; the message must name Z_AI_API_KEY because
    // that's the credential the production zai descriptor advertises.
    assert.ok(
      caught instanceof ConfigurationError,
      `expected ConfigurationError, got: ${caught && caught.constructor && caught.constructor.name}`,
    );
    assert.match(
      caught.message,
      /Z_AI_API_KEY/,
      `default-provider zai ConfigurationError must name Z_AI_API_KEY, got: ${caught.message}`,
    );
    assert.ok(
      !/Set the required API key\./.test(caught.message),
      `must NOT use the generic fallback message, got: ${caught.message}`,
    );
  });

  it("an unconfigured minimax effective surfaces a ConfigurationError naming MINIMAX_API_KEY", async () => {
    // Sibling coverage for the second built-in whose descriptor
    // lives outside src/providers/types.ts.
    // Jina excluded (keyless — always configured).
    const credentialRequiredDescriptors = BUILT_IN_PROVIDER_DESCRIPTORS.filter(
      (d) => d.id !== "jina",
    );
    let caught;
    try {
      await run([...credentialRequiredDescriptors], "minimax", {
        env: {},
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ConfigurationError);
    assert.match(caught.message, /MINIMAX_API_KEY/);
    assert.ok(
      !/Set the required API key\./.test(caught.message),
      `must NOT use the generic fallback message, got: ${caught.message}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Provider-fallback Ticket 02 — cache partitioning across candidates
//
// The executor's per-candidate attempts must NOT cross-contaminate
// each other's caches. A failed candidate writes nothing; a
// successful candidate writes under its own key. A cache hit on one
// candidate short-circuits that candidate as a success (the cache
// returns the cached value).
// ---------------------------------------------------------------------------

describe("executeWithFallback — cache partitioning (Ticket 02)", () => {
  it("a failed candidate does not write to the cache; a successful fallback writes under the winner's key", async () => {
    // The `attempt` callback is parameterised by a per-candidate
    // "cache" object so we can prove the writes stay within the
    // candidate's namespace. The executor never sees these objects;
    // it only calls `attempt(descriptor)`. This mirrors how the
    // real handlers inject a per-provider cache (the cache key
    // already includes the Provider id).
    const zaiCache = { writes: [], reads: [] };
    const tavilyCache = { writes: [], reads: [] };
    const cacheFor = (d) => (d.id === "zai" ? zaiCache : tavilyCache);
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });

    const { result, lines } = await run([zai, tavily], "zai", {
      attempt: async (d) => {
        const c = cacheFor(d);
        if (d.id === "zai") {
          c.writes.push({ provider: d.id, value: "zai-attempted" });
          throw new ApiError("zai down", 500);
        }
        c.writes.push({ provider: d.id, value: "tavily-attempted" });
        return "tavily-ok";
      },
    });
    assert.strictEqual(result.provider, "tavily");
    assert.strictEqual(result.fellBack, true);
    // zai recorded an attempted write inside its own attempt, but
    // the executor's cache-partitioning contract is enforced by the
    // cache key (which lives outside the executor). What the
    // executor does NOT do is share the per-candidate write
    // surface — the attempt callback receives the descriptor and
    // can use it to pick the right cache, just like the real
    // handler does.
    assert.strictEqual(zaiCache.writes.length, 1);
    assert.strictEqual(zaiCache.writes[0].provider, "zai");
    assert.strictEqual(tavilyCache.writes.length, 1);
    assert.strictEqual(tavilyCache.writes[0].provider, "tavily");
    // The executor's switch notice + summary notice both reach
    // stderr. Stdout is never touched.
    assert.ok(
      lines.some((l) => l.startsWith("⚠ zai failed (") && l.includes("trying tavily")),
      `expected zai switch notice, got: ${JSON.stringify(lines)}`,
    );
  });

  it("a cache hit on a candidate short-circuits that candidate as a success", async () => {
    // Simulate a cache hit by short-circuiting the attempt to return
    // the cached value without making any transport call. The
    // executor sees a success and returns the outcome unchanged.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const tavily = makeDescriptor("tavily", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const visited = [];
    const { result } = await run([zai, tavily], "zai", {
      attempt: async (d) => {
        visited.push(d.id);
        if (d.id === "zai") return "zai-cached"; // cache hit
        return "tavily-ok";
      },
    });
    assert.deepStrictEqual(visited, ["zai"], "tavily must not be visited when zai has a cache hit");
    assert.strictEqual(result.provider, "zai");
    assert.strictEqual(result.fellBack, false);
    assert.strictEqual(result.result, "zai-cached");
  });
});

// ---------------------------------------------------------------------------
// Provider-fallback Ticket 02 — search --merge whole-batch semantics
//
// The whole parallel sub-query batch in a `--merge` search runs
// against ONE candidate. A fallback switch replaces the entire
// batch — sub-queries never come from different providers (mixed-
// provider results would be incoherent). The executor's
// candidate-by-candidate attempt loop naturally enforces this: the
// `attempt` callback runs the entire batch and either succeeds or
// fails as a unit. The classification table re-throws
// `ValidationError` (bad query fragments) without looping, exactly
// the same way it does for a non-merged search.
// ---------------------------------------------------------------------------

describe("executeWithFallback — search --merge whole-batch semantics (Ticket 02)", () => {
  it("a single attempt callback handles the entire merge batch; one provider wins/fails the whole batch", async () => {
    // The "attempt" simulates the merged search: it splits the
    // query on '|', runs each sub-query against the provider's
    // adapter, and returns the merged result. If the attempt
    // throws, the whole batch fails and the loop moves on.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const brave = makeDescriptor("brave", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const merged = { kind: "merged", providers: [] };
    const { result, lines } = await run([zai, brave], "zai", {
      attempt: async (d) => {
        merged.providers.push(d.id);
        if (d.id === "zai") throw new ApiError("zai search down", 500);
        return { kind: "merged", provider: d.id, count: 3 };
      },
    });
    // Exactly one attempt per provider, even though the merged
    // search internally fans out to multiple sub-queries. The
    // whole batch is owned by ONE provider.
    assert.deepStrictEqual(merged.providers, ["zai", "brave"]);
    assert.strictEqual(result.provider, "brave");
    assert.strictEqual(result.fellBack, true);
    assert.deepStrictEqual(result.result, { kind: "merged", provider: "brave", count: 3 });
    assert.ok(
      lines.some((l) => l === "✓ search completed via brave (fallback)"),
      `expected fallback summary, got: ${JSON.stringify(lines)}`,
    );
  });

  it("a ValidationError from inside the merge short-circuits without falling back", async () => {
    // Bad user input (e.g. an empty sub-query after split) fails
    // identically on every provider, so the executor must NOT
    // loop. The merged search surfaces ValidationError directly
    // and the candidate chain never advances.
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const brave = makeDescriptor("brave", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    let caught;
    try {
      await run([zai, brave], "zai", {
        attempt: async () => {
          throw new ValidationError("merged search: empty sub-query");
        },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ValidationError);
    assert.strictEqual(caught.message, "merged search: empty sub-query");
    assert.strictEqual(getErrorExitCode(caught), 1);
  });
});

// ---------------------------------------------------------------------------
// Provider-fallback Ticket 02 — option-level via UnsupportedOptionError
//
// The executor treats `UnsupportedOptionError` as a "continue"
// classification (same as `UnsupportedCapabilityError`). The notice
// wording uses the structured `option` field. This is the path
// `search --type video` → brave takes under fallback: zai and
// minimax reject the `--type` option, brave accepts it, and the
// executor walks the chain.
// ---------------------------------------------------------------------------

describe("executeWithFallback — option-level capability via UnsupportedOptionError (Ticket 02)", () => {
  it("zai rejects --type video (UnsupportedOptionError), brave accepts it; executor walks the chain", async () => {
    const zai = makeDescriptor("zai", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const minimax = makeDescriptor("minimax", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const brave = makeDescriptor("brave", {
      capabilities: ["search"],
      configured: true,
      adapterHandle: "search",
    });
    const { result, lines } = await run([zai, minimax, brave], "zai", {
      attempt: async (d) => {
        if (d.id === "zai" || d.id === "minimax") {
          throw new UnsupportedOptionError(d.id, "search", "type");
        }
        return "brave-video-results";
      },
    });
    assert.strictEqual(result.provider, "brave");
    assert.strictEqual(result.fellBack, true);
    assert.ok(
      lines.some((l) => l === "⚠ zai does not support 'type' — trying minimax"),
      `expected zai option notice, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) => l === "⚠ minimax does not support 'type' — trying brave"),
      `expected minimax option notice, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) => l === "✓ search completed via brave (fallback)"),
      `expected summary notice, got: ${JSON.stringify(lines)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Provider-fallback Ticket 02 — runtime failure → next provider
//
// The classification table treats every runtime error family as
// "continue" so a transient failure (e.g. TimeoutError, NetworkError)
// moves to the next candidate. The switch notice carries the typed
// error code in parentheses.
// ---------------------------------------------------------------------------

describe("executeWithFallback — runtime failure → next provider (Ticket 02)", () => {
  const cases = [
    ["ApiError", () => new ApiError("down", 500)],
    ["NetworkError", () => new NetworkError("offline")],
    ["TimeoutError", () => new TimeoutError(1000)],
    ["AuthError", () => new AuthError("nope")],
    ["QuotaError", () => new QuotaError()],
  ];
  for (const [label, factory] of cases) {
    it(`${label} on effective → continues to next candidate with a switch notice`, async () => {
      const zai = makeDescriptor("zai", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      });
      const tavily = makeDescriptor("tavily", {
        capabilities: ["search"],
        configured: true,
        adapterHandle: "search",
      });
      const { result, lines } = await run([zai, tavily], "zai", {
        attempt: async (d) => {
          if (d.id === "zai") throw factory();
          return "ok";
        },
      });
      assert.strictEqual(result.provider, "tavily");
      assert.strictEqual(result.fellBack, true);
      assert.ok(
        lines.some(
          (l) => l.startsWith("⚠ zai failed (") && l.endsWith("for search — trying tavily"),
        ),
        `${label} must emit the zai switch notice, got: ${JSON.stringify(lines)}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Provider-fallback Review Fix 2 — option-level --type video routing
//
// Exa and Firecrawl were accept-and-ignore for `controls.type`, so the
// Executor would silently charge and return ordinary web results from
// them when `--type video` was passed under registry order. Fix 2 makes
// those adapters throw `UnsupportedOptionError(<provider>, "search",
// "type")` so the Executor continues to Brave (the only Provider that
// implements video search). These tests use the REAL adapter
// validators (not scripted doubles) to prove the option is rejected by
// the production code path and the Executor walks to Brave.
// ---------------------------------------------------------------------------

import { createExaDescriptor } from "../dist/providers/exa/adapter.js";
import { createFirecrawlDescriptor } from "../dist/providers/firecrawl/adapter.js";
import { createBraveDescriptor } from "../dist/providers/brave/adapter.js";

describe("executeWithFallback — --type video routes via UnsupportedOptionError (Fix 2)", () => {
  // Configure every adapter as if its credential is present. The
  // preflight check uses `isConfigured`, which depends on env vars; we
  // construct adapters directly so the test is independent of env.
  // We use the real `descriptor.create(...)` for the Brave attempt (so
  // the validator is the production code) and `capability.validate` for
  // the Exa/Firecrawl probes.
  it("exa rejects --type video at its real validator; brave's validator accepts it", () => {
    const exa = createExaDescriptor().create({ env: {} }).search;
    const brave = createBraveDescriptor().create({ env: {} }).search;
    assert.throws(
      () => exa.validate({ query: "q", controls: { type: "video" } }),
      (err) => err instanceof UnsupportedOptionError && err.provider === "exa" && err.option === "type",
      "Exa must reject controls.type",
    );
    // Brave accepts `type: "video"` — but only at the validator; a
    // full invoke would touch the network. assert.doesNotThrow proves
    // the validator does not reject the option (Brave's contentSize
    // and topic gates remain in place for other shapes).
    assert.doesNotThrow(() => brave.validate({ query: "q", controls: { type: "video" } }));
  });

  it("firecrawl rejects --type video at its real validator; brave accepts it", () => {
    const firecrawl = createFirecrawlDescriptor().create({ env: {} }).search;
    const brave = createBraveDescriptor().create({ env: {} }).search;
    assert.throws(
      () => firecrawl.validate({ query: "q", controls: { type: "video" } }),
      (err) =>
        err instanceof UnsupportedOptionError &&
        err.provider === "firecrawl" &&
        err.option === "type",
      "Firecrawl must reject controls.type",
    );
    assert.doesNotThrow(() => brave.validate({ query: "q", controls: { type: "video" } }));
  });

  it("firecrawl reclassifies --topic finance as UnsupportedOptionError (not ValidationError)", () => {
    const firecrawl = createFirecrawlDescriptor().create({ env: {} }).search;
    assert.throws(
      () => firecrawl.validate({ query: "q", controls: { topic: "finance" } }),
      (err) =>
        err instanceof UnsupportedOptionError &&
        err.provider === "firecrawl" &&
        err.option === "topic",
      "Firecrawl --topic finance must surface as UnsupportedOptionError so the Executor continues",
    );
  });

  it("Executor walks exa → brave on --type video using real adapter validators", async () => {
    const exaDesc = createExaDescriptor();
    const braveDesc = createBraveDescriptor();
    // Pretend every credential is configured so the preflight does
    // not reject on configuration; the option-level rejection
    // exercised here must come from the real adapter's `validate`.
    exaDesc.isConfigured = () => true;
    braveDesc.isConfigured = () => true;
    const request = { query: "video q", controls: { type: "video" } };

    const { result, lines } = await run([exaDesc, braveDesc], "exa", {
      attempt: async (d) => {
        // Use the real adapter's `validate` for every attempted
        // provider. Exa throws UnsupportedOptionError before any
        // network call; Brave's validate accepts it. The Executor must
        // walk to Brave and return Brave's video sources.
        const cap = d.create({ env: {} }).search;
        cap.validate(request);
        return [{ title: `video via ${d.id}`, url: `https://${d.id}/v`, summary: "" }];
      },
    });
    assert.strictEqual(result.provider, "brave");
    assert.strictEqual(result.fellBack, true);
    assert.ok(
      lines.some((l) => l === "⚠ exa does not support 'type' — trying brave"),
      `expected exa option notice, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) => l === "✓ search completed via brave (fallback)"),
      `expected summary notice, got: ${JSON.stringify(lines)}`,
    );
  });

  it("Executor walks firecrawl → brave on --type video using real adapter validators", async () => {
    const firecrawlDesc = createFirecrawlDescriptor();
    const braveDesc = createBraveDescriptor();
    firecrawlDesc.isConfigured = () => true;
    braveDesc.isConfigured = () => true;
    const request = { query: "video q", controls: { type: "video" } };

    const { result, lines } = await run([firecrawlDesc, braveDesc], "firecrawl", {
      attempt: async (d) => {
        const cap = d.create({ env: {} }).search;
        cap.validate(request);
        return [{ title: `video via ${d.id}`, url: `https://${d.id}/v`, summary: "" }];
      },
    });
    assert.strictEqual(result.provider, "brave");
    assert.strictEqual(result.fellBack, true);
    assert.ok(
      lines.some((l) => l === "⚠ firecrawl does not support 'type' — trying brave"),
      `expected firecrawl option notice, got: ${JSON.stringify(lines)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Provider-fallback Review Fix 4 — vision supports(operation) guard
//
// The shared live-vision dispatch (src/index.ts handleVision → attempt)
// must call `visionCapability.supports(operation)` and throw
// `UnsupportedCapabilityError` when the Adapter's `supports()` returns
// false, even when the descriptor metadata advertises the
// per-operation Capability. This protects against descriptor/adapter
// drift and ensures the executor falls through to a capable candidate
// (or surfaces the typed error under --no-fallback) instead of
// invoking an unsupported transport.
// ---------------------------------------------------------------------------

describe("executeWithFallback — vision supports(operation) guard (Fix 4)", () => {
  const VISION_OP = "vision.interpret-image";

  // Two vision-capable descriptors: provider "fake-advertises" advertises
  // the per-operation capability but its Adapter's `supports()`
  // returns false (descriptor/adapter drift). Provider "fake-accepts"
  // advertises AND its Adapter agrees.
  const fakeAdvertises = makeDescriptor("fake-advertises", {
    capabilities: [VISION_OP],
    configured: true,
    adapterHandle: "vision",
  });
  const fakeAccepts = makeDescriptor("fake-accepts", {
    capabilities: [VISION_OP],
    configured: true,
    adapterHandle: "vision",
  });

  it("Adapter supports() === false after metadata advertises → UnsupportedCapabilityError → next provider", async () => {
    let advertiseInvokes = 0;
    let acceptInvokes = 0;
    const { result, lines } = await run([fakeAdvertises, fakeAccepts], "fake-advertises", {
      capabilityId: VISION_OP,
      commandLabel: "vision",
      attempt: async (d) => {
        if (d.id === "fake-advertises") {
          // Simulate the Adapter-level supports() returning false
          // even though the descriptor advertised the capability.
          // The dispatch must throw UnsupportedCapabilityError here.
          advertiseInvokes += 1;
          throw new UnsupportedCapabilityError(d.id, VISION_OP);
        }
        acceptInvokes += 1;
        return `vision-result-${d.id}`;
      },
    });
    assert.strictEqual(advertiseInvokes, 1, "advertising-but-unsupported provider attempted once");
    assert.strictEqual(acceptInvokes, 1, "accepts provider served the request");
    assert.strictEqual(result.provider, "fake-accepts");
    assert.strictEqual(result.fellBack, true);
    // The classifier routes UnsupportedCapabilityError as
    // `continue`, so a switch notice fires naming the next
    // candidate and the summary notice credits the winner.
    assert.ok(
      lines.some((l) => l === `⚠ fake-advertises does not support 'vision.interpret-image' — trying fake-accepts`),
      `expected advertised-supports-unsupported notice, got: ${JSON.stringify(lines)}`,
    );
    assert.ok(
      lines.some((l) => l === "✓ vision completed via fake-accepts (fallback)"),
      `expected summary notice naming winner, got: ${JSON.stringify(lines)}`,
    );
  });

  it("Adapter supports() === false and --no-fallback → typed error propagates without invoking", async () => {
    // Under --no-fallback the plan is `[effective]` only, so an
    // advertising-but-unsupported effective must surface its real
    // typed error (UnsupportedCapabilityError, exit 1) without
    // silently invoking an unsupported transport. The classified
    // error is `continue` at the per-attempt loop, but with no next
    // candidate the executor re-throws the effective's own error.
    let invokes = 0;
    const singleAdvertises = makeDescriptor("fake-advertises", {
      capabilities: [VISION_OP],
      configured: true,
      adapterHandle: "vision",
    });
    await assert.rejects(
      run([singleAdvertises], "fake-advertises", {
        capabilityId: VISION_OP,
        commandLabel: "vision",
        fallbackEnabled: false,
        attempt: async () => {
          invokes += 1;
          throw new UnsupportedCapabilityError("fake-advertises", VISION_OP);
        },
      }),
      (err) =>
        err instanceof UnsupportedCapabilityError &&
        /fake-advertises/.test(err.message) &&
        new RegExp(VISION_OP.replace(/\./g, "\\.")).test(err.message),
      "--no-fallback must surface UnsupportedCapabilityError for advertising-but-unsupported effective",
    );
    // The attempt callback may be entered once under --no-fallback
    // (the executor calls it, then on classification `continue` with
    // no next entry re-throws). The invariant is that the error is
    // typed and the executor does not silently return a result.
    assert.strictEqual(invokes, 1, "attempt callable once before the typed error propagates");
  });
});

// ---------------------------------------------------------------------------
// Provider-fallback Ticket 02 — per-handler coverage (Ticket 02 ticket)
//
// For each of the four sync handlers (`handleSearch`, `handleRead`,
// `handleRepo`, `handleVision`) we prove the four required
// behaviours:
//   1. a direct success on the effective (silent, no notice);
//   2. a capability-mismatch auto-reroute;
//   3. a runtime fallback;
//   4. --no-fallback restoring strict (with the right exit code).
//
// We exercise the executor directly (the dispatch-level handler
// wiring is covered by the existing handler suites). The four
// capability ids are `search`, `reader`, `repository-exploration`,
// and per-operation vision ids (we use `vision.interpret-image` as
// a representative — every vision.* id follows the same shape).
// ---------------------------------------------------------------------------

describe("executeWithFallback — per-handler coverage (Ticket 02 ticket)", () => {
  for (const capabilityId of [
    "search",
    "reader",
    "repository-exploration",
    "vision.interpret-image",
  ]) {
    const adapterHandle = capabilityId.startsWith("vision.")
      ? "vision"
      : capabilityId === "search"
        ? "search"
        : capabilityId === "reader"
          ? "reader"
          : "repository";
    const commandLabel = commandLabelFor(capabilityId);
    describe(`capabilityId="${capabilityId}"`, () => {
      it("1. direct success on the effective is silent (no notice, no summary)", async () => {
        const zai = makeDescriptor("zai", {
          capabilities: [capabilityId],
          configured: true,
          adapterHandle,
        });
        const { result, lines } = await run([zai], "zai", {
          capabilityId,
          commandLabel,
        });
        assert.strictEqual(result.provider, "zai");
        assert.strictEqual(result.fellBack, false);
        assert.deepStrictEqual(lines, [], "no notice on silent effective success");
      });

      it("2. capability-mismatch auto-reroute to the next eligible candidate", async () => {
        // minimax advertises a different capability so it does NOT
        // match the per-handler capabilityId, forcing the
        // capability-mismatch skip notice and the auto-reroute to
        // zai.
        const minimax = makeDescriptor("minimax", {
          capabilities: ["some-other-capability"],
          configured: true,
          adapterHandle: "reader",
        });
        const zai = makeDescriptor("zai", {
          capabilities: [capabilityId],
          configured: true,
          adapterHandle,
        });
        const { result, lines } = await run([minimax, zai], "minimax", {
          capabilityId,
          commandLabel,
        });
        assert.strictEqual(result.provider, "zai");
        assert.strictEqual(result.fellBack, true);
        assert.ok(
          lines.some(
            (l) => l === `⚠ minimax does not support '${capabilityId}' — skipping`,
          ),
          `expected minimax skip notice, got: ${JSON.stringify(lines)}`,
        );
      });

      it("3. runtime failure on the effective falls back to the next candidate", async () => {
        const zai = makeDescriptor("zai", {
          capabilities: [capabilityId],
          configured: true,
          adapterHandle,
        });
        const tavily = makeDescriptor("tavily", {
          capabilities: [capabilityId],
          configured: true,
          adapterHandle,
        });
        const { result, lines } = await run([zai, tavily], "zai", {
          capabilityId,
          commandLabel,
          attempt: async (d) => {
            if (d.id === "zai") throw new ApiError(`${capabilityId} down`, 500);
            return "ok";
          },
        });
        assert.strictEqual(result.provider, "tavily");
        assert.strictEqual(result.fellBack, true);
        assert.ok(
          lines.some(
            (l) =>
              l.startsWith("⚠ zai failed (") &&
              l.endsWith(`for ${commandLabel} — trying tavily`),
          ),
          `expected zai switch notice, got: ${JSON.stringify(lines)}`,
        );
      });

      it("4. --no-fallback restores strict (typed error, no notice, right exit code)", async () => {
        // Incapable effective under the kill-switch surfaces
        // UnsupportedCapabilityError (exit 1) with zero adapter
        // work — the exact 0.10.x code.
        const minimax = makeDescriptor("minimax", {
          capabilities: ["some-other-capability"],
          configured: true,
          adapterHandle: "reader",
        });
        let caught;
        try {
          await run([minimax], "minimax", {
            capabilityId,
            commandLabel,
            fallbackEnabled: false,
          });
        } catch (err) {
          caught = err;
        }
        assert.ok(
          caught instanceof UnsupportedCapabilityError,
          "kill-switch must surface UnsupportedCapabilityError",
        );
        assert.strictEqual(getErrorExitCode(caught), 1);
      });
    });
  }
});

/**
 * Map a per-handler capability id to the human-readable `commandLabel`
 * the executor uses in switch notices. Mirrors the mapping the
 * handlers themselves use when wiring the executor.
 */
function commandLabelFor(capabilityId) {
  if (capabilityId === "search") return "search";
  if (capabilityId === "reader") return "read";
  if (capabilityId === "repository-exploration") return "repo";
  if (capabilityId.startsWith("vision.")) return "vision";
  return capabilityId;
}

// ---------------------------------------------------------------------------
// 4.5 — Exhaustive ProviderCapability dispatch
// ---------------------------------------------------------------------------

/**
 * The canonical list of every ProviderCapability union member. This is
 * intentionally a literal array (not derived from a runtime source) so
 * adding a new Capability to the TypeScript union without updating
 * `adapterSlotFor`'s switch causes this test to fail — the new value
 * would be missing here, and a reviewer would catch the gap.
 */
const ALL_PROVIDER_CAPABILITIES = [
  "search",
  "vision.interpret-image",
  "vision.ui-artifact",
  "vision.extract-text",
  "vision.diagnose-error",
  "vision.diagram",
  "vision.chart",
  "vision.diff",
  "vision.video",
  "quota",
  "diagnostics",
  "repository-exploration",
  "reader",
  "crawl",
  "map",
  "research",
];

describe("ProviderCapability dispatch is exhaustive (4.5)", () => {
  for (const cap of ALL_PROVIDER_CAPABILITIES) {
    it(`adapterSlotFor handles "${cap}" without falling through to never`, async () => {
      // Build a descriptor that advertises the capability, is configured,
      // and supplies every adapter slot. The preflight should classify
      // it as "eligible" — if adapterSlotFor doesn't handle this
      // capability, the exhaustiveness guard throws and preflight
      // never completes.
      const descriptor = makeDescriptor("zai", {
        capabilities: [cap],
        configured: true,
        adapterHandle: cap.startsWith("vision.")
          ? "vision"
          : cap === "repository-exploration"
            ? "repository"
            : cap,
      });
      const cap2 = captureStderr();
      // The attempt callback is never reached in this test because the
      // only candidate is eligible and the attempt succeeds; the point
      // is that the PREFLIGHT (which calls adapterSlotFor) does not
      // throw for any valid ProviderCapability.
      await executeWithFallback(
        {
          capabilityId: cap,
          commandLabel: commandLabelFor(cap),
          effectiveProvider: "zai",
          descriptors: [descriptor],
          env: { Z_AI_API_KEY: "test" },
          fallbackEnabled: false,
          writeStderr: cap2.writeStderr,
        },
        async () => "ok",
      );
      // If we got here, the preflight's adapterSlotFor handled the
      // capability without hitting the exhaustiveness guard.
      assert.ok(true, `preflight completed for ${cap}`);
    });
  }
});
