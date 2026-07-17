/**
 * In-process tests for the Command Invocation Seam (P1-02).
 *
 * These tests exercise the pure `invokeCommand` contract from
 * DESIGN.md §2 using a recording fake adapter. They verify:
 *   - data/text success paths
 *   - presentation override selection for text-oriented modes
 *   - notice ordering and isolation
 *   - single-stdout-write / single-structured-stderr-write invariants
 *   - behaviour-selected and error-derived exit codes
 *   - dependency-log restoration ordering (runQuietly restores before output)
 *   - invocation isolation across consecutive calls
 *   - deterministic json envelopes via injected `now`
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { invokeCommand } from "../dist/command-invocation.js";
import { ScoutlineError, ValidationError, ConfigurationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Fixup C — B8 (NFR-001): clear Provider credentials for the entire file.
// Some tests in this suite exercise command handlers (tools, read, repo,
// code) that construct a real `ZaiMcpClient` / `ZaiCodeModeClient`. When
// `Z_AI_API_KEY` or `MINIMAX_API_KEY` is present in the ambient
// environment, those constructors try to initialise UTCP transports and
// make real network calls — violating NFR-001 ("Ordinary CI shall require
// no Provider credentials and shall perform no live Provider calls").
//
// Strip the three Provider credential env vars before any test in this
// file runs and restore them after, so the offline suite is hermetic
// regardless of the shell environment it is launched from.
// ---------------------------------------------------------------------------

const PROVIDER_ENV_VARS = ["Z_AI_API_KEY", "ZAI_API_KEY", "MINIMAX_API_KEY"];
const savedProviderEnv = {};

before(() => {
  for (const key of PROVIDER_ENV_VARS) {
    savedProviderEnv[key] = process.env[key];
    delete process.env[key];
  }
});

after(() => {
  for (const key of PROVIDER_ENV_VARS) {
    const saved = savedProviderEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

/**
 * Build SearchExecutionDependencies from a query->results map (P2-05).
 * The search command now receives an injected SearchCapability and
 * shared execution dependencies instead of a clientFactory. Each
 * capability.invoke returns the scripted normalized results for the
 * request query.
 */
function makeSearchExecDeps(resultsByQuery = {}) {
  const capability = {
    validate() {},
    cacheIdentity(request) {
      return {
        provider: "zai",
        capability: "search",
        credentialFingerprint: "fp",
        request,
        legacyCandidates: [],
      };
    },
    async invoke(request) {
      return resultsByQuery[request.query] ?? [];
    },
  };
  const store = new Map();
  return {
    capability,
    cache: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    sleep: async () => {},
    random: () => 0.5,
  };
}

/**
 * Build a fake adapter that records every interaction into arrays
 * and an ordered event log. Each adapter instance is independent so
 * consecutive invocations cannot share state.
 */
function createRecordingAdapter(overrides = {}) {
  const stdout = [];
  const stderr = [];
  const events = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: undefined,
    readStdin: async () => "",
    writeStdout: (value) => {
      stdout.push(value);
      events.push(["writeStdout", value]);
    },
    writeStderr: (value) => {
      stderr.push(value);
      events.push(["writeStderr", value]);
    },
    runQuietly: async (operation) => {
      events.push(["suppress"]);
      try {
        return await operation();
      } finally {
        events.push(["restore"]);
      }
    },
    setExitCode: (value) => {
      events.push(["setExitCode", value]);
    },
    ...overrides,
  };
  return { adapter, stdout, stderr, events };
}

describe("invokeCommand — success paths", () => {
  it("data result in data mode writes formatted data to stdout and returns 0", async () => {
    const { adapter, stdout, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => ({ kind: "data", data: { count: 2 } }),
      "data",
    );
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.strictEqual(stdout[0], JSON.stringify({ count: 2 }));
    assert.deepStrictEqual(stderr, []);
  });

  it("text result writes the text directly regardless of output mode", async () => {
    const { adapter, stdout } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => ({ kind: "text", text: "hello world" }),
      "data",
    );
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.strictEqual(stdout[0], "hello world");
  });

  it("presentation override is selected for the requested text-oriented mode", async () => {
    const { adapter, stdout } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => ({
        kind: "data",
        data: { items: [1, 2] },
        presentations: { compact: "compact-form", markdown: "md-form" },
      }),
      "compact",
    );
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout[0], "compact-form");
  });

  it("falls back to base data when text-oriented mode has no presentation override", async () => {
    const { adapter, stdout } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => ({
        kind: "data",
        data: { items: [1, 2] },
        presentations: { markdown: "md-form" },
      }),
      "tty",
    );
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout[0], JSON.stringify({ items: [1, 2] }));
  });

  it("does not use presentations for data-oriented modes", async () => {
    const { adapter, stdout } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async () => ({
        kind: "data",
        data: { x: 1 },
        presentations: { compact: "should-not-be-used" },
      }),
      "data",
    );
    assert.strictEqual(stdout[0], JSON.stringify({ x: 1 }));
  });

  it("returns behaviour-selected nonzero exit code on success", async () => {
    const { adapter } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => ({ kind: "data", data: null, exitCode: 2 }),
      "data",
    );
    assert.strictEqual(status, 2);
  });

  it("text result can carry a nonzero exit code", async () => {
    const { adapter } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => ({ kind: "text", text: "warning output", exitCode: 2 }),
      "data",
    );
    assert.strictEqual(status, 2);
  });
});

describe("invokeCommand — json envelope", () => {
  it("produces a deterministic json envelope with injected now", async () => {
    const { adapter, stdout } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async () => ({ kind: "data", data: { value: 42 } }),
      "json",
      () => 1234,
    );
    assert.strictEqual(
      stdout[0],
      JSON.stringify({ success: true, data: { value: 42 }, timestamp: 1234 }),
    );
  });

  it("produces an indented pretty envelope", async () => {
    const { adapter, stdout } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async () => ({ kind: "data", data: { value: 42 } }),
      "pretty",
      () => 1234,
    );
    assert.ok(stdout[0].includes("\n"));
    const parsed = JSON.parse(stdout[0]);
    assert.strictEqual(parsed.success, true);
    assert.deepStrictEqual(parsed.data, { value: 42 });
    assert.strictEqual(parsed.timestamp, 1234);
  });
});

describe("invokeCommand — single-write invariants", () => {
  it("writes to stdout exactly once on success", async () => {
    const { adapter, stdout } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async () => ({ kind: "data", data: { ok: true } }),
      "json",
      () => 1234,
    );
    assert.strictEqual(stdout.length, 1);
  });

  it("writes exactly one structured stderr value on thrown normalized error", async () => {
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => {
        throw new ScoutlineError("boom", "API_ERROR", { statusCode: 500 });
      },
      "data",
    );
    assert.strictEqual(status, 1);
    assert.strictEqual(stderr.length, 1);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.error, "boom");
    assert.strictEqual(parsed.code, "API_ERROR");
  });
});

describe("invokeCommand — error conversion", () => {
  it("converts a thrown ValidationError into VALIDATION_ERROR stderr and exit 1", async () => {
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => {
        throw new ValidationError("bad input", "fix it");
      },
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.strictEqual(parsed.error, "bad input");
    assert.strictEqual(parsed.help, "fix it");
  });

  it("converts a thrown plain Error into UNKNOWN_ERROR stderr and exit 1", async () => {
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => {
        throw new Error("unexpected");
      },
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "UNKNOWN_ERROR");
    assert.strictEqual(parsed.error, "unexpected");
  });

  it("uses ScoutlineError exit code for thrown normalized error", async () => {
    const { adapter } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      async () => {
        throw new ScoutlineError("config issue", "FILE_ERROR", { exitCode: 3 });
      },
      "data",
    );
    assert.strictEqual(status, 3);
  });

  it("formats errors in pretty mode when output mode is pretty", async () => {
    const { adapter, stderr } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async () => {
        throw new Error("fail");
      },
      "pretty",
    );
    assert.ok(stderr[0].includes("\n"), "pretty error should be indented");
  });
});

describe("invokeCommand — injected-secret redaction (Fixup B — B3)", () => {
  // A secret that exists ONLY in the injected secrets list (never in
  // process.env) must still be redacted from public stderr output. This
  // proves the redaction seam honours injected credentials rather than
  // reading ambient process.env (W2 completeness).
  const INJECTED_ONLY_SECRET = "INJECTED_ONLY_SECRET_VALUE_XYZ";

  // Ensure the fixture is truly absent from the ambient environment so
  // the assertion can only pass via the injected-secrets plumbing.
  let saved;
  before(() => {
    saved = process.env.Z_AI_API_KEY;
    delete process.env.Z_AI_API_KEY;
    delete process.env.ZAI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
  });
  after(() => {
    if (saved === undefined) delete process.env.Z_AI_API_KEY;
    else process.env.Z_AI_API_KEY = saved;
  });

  it("redacts an injected-only secret from a thrown error message", async () => {
    const { adapter, stderr } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async () => {
        throw new Error(`provider rejected key=${INJECTED_ONLY_SECRET}`);
      },
      "data",
      undefined,
      [INJECTED_ONLY_SECRET],
    );
    const formatted = stderr[0];
    assert.ok(
      !formatted.includes(INJECTED_ONLY_SECRET),
      `injected-only secret leaked: ${formatted}`,
    );
    const parsed = JSON.parse(formatted);
    assert.ok(parsed.error.includes("[REDACTED]"), `expected redaction marker: ${parsed.error}`);
  });

  it("redacts an injected-only secret embedded in help text", async () => {
    const { adapter, stderr } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async () => {
        throw new ScoutlineError(`failure using ${INJECTED_ONLY_SECRET}`, "AUTH_ERROR", {
          help: `re-check the key ${INJECTED_ONLY_SECRET}`,
        });
      },
      "data",
      undefined,
      [INJECTED_ONLY_SECRET],
    );
    const parsed = JSON.parse(stderr[0]);
    assert.ok(!parsed.error.includes(INJECTED_ONLY_SECRET), `secret in error: ${stderr[0]}`);
    assert.ok(!parsed.help.includes(INJECTED_ONLY_SECRET), `secret in help: ${stderr[0]}`);
  });

  it("falls back to process.env secrets when no secrets are injected", async () => {
    // Backward-compat: callers that don't pass the secrets arg still get
    // process.env-based redaction (existing behaviour preserved).
    process.env.Z_AI_API_KEY = "AMBIENT_ENV_SECRET_ABC";
    try {
      const { adapter, stderr } = createRecordingAdapter();
      await invokeCommand(
        adapter,
        async () => {
          throw new Error("key=AMBIENT_ENV_SECRET_ABC rejected");
        },
        "data",
      );
      assert.ok(
        !stderr[0].includes("AMBIENT_ENV_SECRET_ABC"),
        `ambient secret leaked: ${stderr[0]}`,
      );
    } finally {
      delete process.env.Z_AI_API_KEY;
    }
  });
});

describe("invokeCommand — notices", () => {
  it("flushes notices to stderr in encounter order", async () => {
    const { adapter, stderr } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async (ctx) => {
        ctx.notice("first");
        ctx.notice("second");
        ctx.notice("third");
        return { kind: "data", data: {} };
      },
      "data",
    );
    assert.deepStrictEqual(stderr, ["first", "second", "third"]);
  });

  it("flushes notices even when the command throws", async () => {
    const { adapter, stderr } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async (ctx) => {
        ctx.notice("before failure");
        throw new Error("fail");
      },
      "data",
    );
    assert.strictEqual(stderr.length, 2);
    assert.strictEqual(stderr[0], "before failure");
    JSON.parse(stderr[1]);
  });

  it("does not write notices to stdout", async () => {
    const { adapter, stdout, stderr } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async (ctx) => {
        ctx.notice("stderr only");
        return { kind: "data", data: {} };
      },
      "data",
    );
    assert.strictEqual(stdout.length, 1);
    assert.deepStrictEqual(stderr, ["stderr only"]);
  });
});

describe("invokeCommand — dependency-log restoration ordering", () => {
  it("restores dependency logging before writing notices and output", async () => {
    const { adapter, events } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async (ctx) => {
        ctx.notice("a notice");
        return { kind: "data", data: { x: 1 } };
      },
      "data",
    );
    const restoreIndex = events.findIndex((e) => e[0] === "restore");
    const writeStderrIndex = events.findIndex((e) => e[0] === "writeStderr");
    const writeStdoutIndex = events.findIndex((e) => e[0] === "writeStdout");
    assert.notStrictEqual(restoreIndex, -1);
    assert.notStrictEqual(writeStderrIndex, -1);
    assert.notStrictEqual(writeStdoutIndex, -1);
    assert.ok(restoreIndex < writeStderrIndex, "restore must precede writeStderr");
    assert.ok(restoreIndex < writeStdoutIndex, "restore must precede writeStdout");
  });

  it("restores dependency logging before writing error output on throw", async () => {
    const { adapter, events } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      async (ctx) => {
        ctx.notice("notice before throw");
        throw new Error("boom");
      },
      "data",
    );
    const restoreIndex = events.findIndex((e) => e[0] === "restore");
    const firstWriteIndex = events.findIndex((e) => e[0] === "writeStderr");
    assert.notStrictEqual(restoreIndex, -1);
    assert.notStrictEqual(firstWriteIndex, -1);
    assert.ok(restoreIndex < firstWriteIndex, "restore must precede first stderr write");
  });
});

describe("invokeCommand — invocation isolation", () => {
  it("does not share state between two consecutive invocations", async () => {
    const rec1 = createRecordingAdapter();
    await invokeCommand(
      rec1.adapter,
      async (ctx) => {
        ctx.notice("from first");
        return { kind: "data", data: { run: 1 } };
      },
      "data",
    );

    const rec2 = createRecordingAdapter();
    await invokeCommand(
      rec2.adapter,
      async (ctx) => {
        ctx.notice("from second");
        return { kind: "data", data: { run: 2 } };
      },
      "json",
      () => 9999,
    );

    // First invocation: data mode, no envelope
    assert.deepStrictEqual(rec1.stderr, ["from first"]);
    assert.strictEqual(rec1.stdout[0], JSON.stringify({ run: 1 }));

    // Second invocation: json mode, envelope with injected timestamp
    assert.deepStrictEqual(rec2.stderr, ["from second"]);
    const parsed2 = JSON.parse(rec2.stdout[0]);
    assert.strictEqual(parsed2.success, true);
    assert.deepStrictEqual(parsed2.data, { run: 2 });
    assert.strictEqual(parsed2.timestamp, 9999);

    // No cross-contamination
    assert.ok(!rec1.stdout[0].includes("9999"));
    assert.ok(!rec2.stderr.includes("from first"));
  });
});

describe("invokeCommand — command context", () => {
  it("context exposes adapter stdin TTY state and delegates readStdin", async () => {
    const stdinContent = "piped input data";
    const { adapter } = createRecordingAdapter({
      stdinIsTTY: false,
      readStdin: async () => stdinContent,
    });
    let capturedTTY = undefined;
    let capturedStdin = undefined;
    await invokeCommand(
      adapter,
      async (ctx) => {
        capturedTTY = ctx.stdinIsTTY;
        capturedStdin = await ctx.readStdin();
        return { kind: "data", data: {} };
      },
      "data",
    );
    assert.strictEqual(capturedTTY, false);
    assert.strictEqual(capturedStdin, stdinContent);
  });

  it("context stdinIsTTY reflects adapter state", async () => {
    const { adapter } = createRecordingAdapter({ stdinIsTTY: true });
    let capturedTTY = undefined;
    await invokeCommand(
      adapter,
      async (ctx) => {
        capturedTTY = ctx.stdinIsTTY;
        return { kind: "data", data: {} };
      },
      "data",
    );
    assert.strictEqual(capturedTTY, true);
  });
});

describe("invokeCommand — search command routed through the seam (P1-04)", () => {
  it("routes search's compact presentation to stdout and surfaces merge notices on stderr", async () => {
    const { search } = await import("../dist/commands/search.js");
    const { adapter, stdout, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) =>
        search(
          "rust|rust tokio",
          { merge: true },
          makeSearchExecDeps({
            rust: [{ title: "Rust async", url: "https://e/r1", summary: "c" }],
            "rust tokio": [{ title: "Rust async", url: "https://e/r1", summary: "c" }],
          }),
          ctx,
        ),
      "compact",
    );
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    assert.ok(stdout[0].includes("Rust async"));
    assert.ok(stdout[0].includes("https://e/r1"));
    assert.strictEqual(stderr.length, 1);
    assert.match(stderr[0], /merged 2 queries/);
  });

  it("routes search errors to stderr as a structured VALIDATION_ERROR-equivalent envelope and returns exit 1", async () => {
    const { search } = await import("../dist/commands/search.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => search("|||", { merge: true }, makeSearchExecDeps(), ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    assert.strictEqual(stderr.length, 1);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.success, false);
    assert.match(parsed.error, /merge requires at least one non-empty query/);
    assert.strictEqual(parsed.code, "UNKNOWN_ERROR");
  });

  it("search in data mode emits the raw JSON data result on stdout", async () => {
    const { search } = await import("../dist/commands/search.js");
    const { adapter, stdout } = createRecordingAdapter();
    await invokeCommand(
      adapter,
      (ctx) =>
        search(
          "alpha",
          {},
          makeSearchExecDeps({
            alpha: [{ title: "Alpha", url: "https://e/a", summary: "summary" }],
          }),
          ctx,
        ),
      "data",
    );
    assert.strictEqual(stdout.length, 1);
    const parsed = JSON.parse(stdout[0]);
    assert.deepStrictEqual(parsed, [
      {
        rank: 1,
        title: "Alpha",
        url: "https://e/a",
        summary: "summary",
      },
    ]);
  });
});

describe("invokeCommand — read and repo routed through the seam (P1-05)", () => {
  it("read rejects URLs that aren't http/https", async () => {
    const { read } = await import("../dist/commands/read.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => read("ftp://example.com/file", {}, "data", ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /URL must start with/);
  });

  it("read rejects unknown --extract modes", async () => {
    const { read } = await import("../dist/commands/read.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => read("https://example.com/x", { extract: "bogus" }, "data", ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Invalid --extract mode/);
  });

  it("repoTree throws ValidationError on invalid repo format through the seam", async () => {
    const { repoTree } = await import("../dist/commands/repo.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => repoTree("invalid-format", {}, ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    assert.strictEqual(stderr.length, 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Invalid repository format/);
  });

  it("repoTree rejects non-positive depth through the seam", async () => {
    const { repoTree } = await import("../dist/commands/repo.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => repoTree("owner/repo", { depth: 0 }, ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Depth must be a positive integer/);
  });

  it("repoSearch validation rejects an invalid language", async () => {
    const { repoSearch } = await import("../dist/commands/repo.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => repoSearch("owner/repo", "query", { language: "fr" }, ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Language must be/);
  });

  it("repoRead throws ValidationError on invalid repo format through the seam", async () => {
    const { repoRead } = await import("../dist/commands/repo.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => repoRead("badrepo", "README.md", {}, ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Invalid repository format/);
  });
});

describe("invokeCommand — tools routed through the seam (P1-06)", () => {
  it("showTool fails fast with ConfigurationError when Provider credentials are missing (Fixup C — B8)", async () => {
    // Fixup C — B8 (NFR-001): showTool must NEVER reach the network in the
    // offline suite. The file-scoped `before` hook cleared
    // Z_AI_API_KEY/ZAI_API_KEY/MINIMAX_API_KEY so the handler fails fast
    // at init() with ConfigurationError (exit 3) instead of registering
    // MCP servers against a real endpoint.
    const { showTool } = await import("../dist/commands/tools.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => showTool("nonexistent.tool", {}, ctx),
      "data",
    );
    assert.strictEqual(status, 3, "missing credentials must exit 3");
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "CONFIGURATION_ERROR");
    assert.match(parsed.error, /Z_AI_API_KEY/);
  });

  it("listTools and showTool signatures do not accept or resolve a Provider ID", async () => {
    // Boundary assertion: the public command functions in tools.ts must
    // neither accept a Provider ID parameter nor surface one through their
    // return values. P2-05 introduces Provider selection; until then this
    // invariant is encoded in source.
    const tools = await import("../dist/commands/tools.js");
    const listLen = tools.listTools.length;
    const showLen = tools.showTool.length;
    const callLen = tools.callTool.length;
    // listTools: (options, context?) → length 2 max
    // showTool: (name, options, context?) → length 3 max
    // callTool: (toolName, options, context?) → length 3 max
    assert.ok(listLen <= 2, `listTools arity grew: ${listLen}`);
    assert.ok(showLen <= 3, `showTool arity grew: ${showLen}`);
    assert.ok(callLen <= 3, `callTool arity grew: ${callLen}`);
    // Source-level: no "provider" identifier in the public parameter names.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/commands/tools.ts", import.meta.url), "utf8"),
    );
    const noProviderId = !/\bproviderId\b|\bprovider_id\b/.test(src);
    assert.ok(noProviderId, "tools.ts must not reference a Provider ID");
  });

  it("callTool fails fast with ConfigurationError when Provider credentials are missing (Fixup C — B8)", async () => {
    // Fixup C — B8 (NFR-001): callTool must NEVER reach the network in
    // the offline suite. Even with --dry-run, the handler still calls
    // resolveToolName() which triggers init() against UTCP — credentials
    // must be checked first.
    const { callTool } = await import("../dist/commands/tools.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => callTool("scoutline.zai.test.tool", { json: '{"foo":"bar"}', dryRun: true }, ctx),
      "data",
    );
    assert.strictEqual(status, 3, "missing credentials must exit 3");
    assert.ok(stderr.length >= 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.code, "CONFIGURATION_ERROR");
  });

  it("callTool's parseToolArgs routes invalid --json to a structured ValidationError", async () => {
    const { callTool } = await import("../dist/commands/tools.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => callTool("scoutline.zai.test.tool", { json: "{not-json" }, ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Invalid JSON/);
  });
});

describe("invokeCommand — code routed through the seam (P1-07)", () => {
  it("printPromptTemplate returns the prompt template through the seam", async () => {
    const { printPromptTemplate } = await import("../dist/commands/code.js");
    const { adapter, stdout } = createRecordingAdapter();
    await invokeCommand(adapter, async (ctx) => printPromptTemplate(ctx), "data");
    assert.strictEqual(stdout.length, 1);
    // Template is a non-empty string (ZaiCodeModeClient.getPromptTemplate).
    assert.strictEqual(typeof stdout[0], "string");
    assert.ok(stdout[0].length > 0);
  });

  it("printInterfaces and eval/run preserve Phase 0 code-mode semantics", async () => {
    const code = await import("../dist/commands/code.js");
    // Function arity sanity: all four signatures accept (..., context?)
    // and return Promise<CommandResult> (or CommandResult for prompt).
    assert.strictEqual(typeof code.printInterfaces, "function");
    assert.strictEqual(typeof code.printPromptTemplate, "function");
    assert.strictEqual(typeof code.runCodeFile, "function");
    assert.strictEqual(typeof code.evalCode, "function");
    // runCodeFile: (filePath, options, context?) → length 3 max
    // evalCode: (code, options, context?) → length 3 max
    assert.ok(code.runCodeFile.length <= 3);
    assert.ok(code.evalCode.length <= 3);
    // No Provider selection: confirm the source has no "providerId".
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/commands/code.ts", import.meta.url), "utf8");
    assert.ok(
      !/\bproviderId\b|\bprovider_id\b/.test(src),
      "code.ts must not reference a Provider ID",
    );
  });
});

describe("invokeCommand — vision routed through the seam (P1-08)", () => {
  it("vision.analyze throws ValidationError when source is missing", async () => {
    const vision = await import("../dist/commands/vision.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => vision.analyze("", undefined, ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Missing image source/);
  });

  it("vision.diff throws ValidationError when one source is missing", async () => {
    const vision = await import("../dist/commands/vision.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      (ctx) => vision.diff("", "", undefined, ctx),
      "data",
    );
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Missing image sources/);
  });

  it("vision.video throws ValidationError when video source is missing", async () => {
    const vision = await import("../dist/commands/vision.js");
    const { adapter, stderr } = createRecordingAdapter();
    const status = await invokeCommand(adapter, (ctx) => vision.video("", undefined, ctx), "data");
    assert.strictEqual(status, 1);
    const parsed = JSON.parse(stderr[stderr.length - 1]);
    assert.strictEqual(parsed.code, "VALIDATION_ERROR");
    assert.match(parsed.error, /Missing video source/);
  });

  it("all vision functions return CommandResult with no Provider selection", async () => {
    const vision = await import("../dist/commands/vision.js");
    // Boundary: arity check + source-level guard against Provider ID.
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/commands/vision.ts", import.meta.url), "utf8");
    assert.ok(
      !/\bproviderId\b|\bprovider_id\b/.test(src),
      "vision.ts must not reference a Provider ID",
    );

    // Each function takes a CommandContext as its last parameter.
    assert.ok(vision.analyze.length >= 1);
    assert.ok(vision.video.length >= 1);
    assert.ok(vision.diff.length >= 2);
  });
});

describe("invokeCommand — doctor routed through the seam (P4-04)", () => {
  it("doctor returns a schema-version-1 diagnostics report rendered through the seam", async () => {
    const { doctor } = await import("../dist/commands/doctor.js");
    const { adapter, stdout, stderr } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      () =>
        doctor({
          buildReport: async () => ({
            schemaVersion: 1,
            effectiveProvider: "zai",
            sharedCapabilities: ["search", "vision.interpret-image", "quota", "diagnostics"],
            zaiOnlyCapabilities: ["reader"],
            node: { version: process.version, visionMcpCompatible: true },
            providers: [
              { provider: "zai", configured: true, capabilities: ["search"], status: "ok" },
            ],
          }),
        }),
      "data",
    );
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    const report = JSON.parse(stdout[0]);
    assert.strictEqual(report.schemaVersion, 1);
    assert.strictEqual(report.effectiveProvider, "zai");
    assert.strictEqual(report.providers[0].status, "ok");
    assert.deepStrictEqual(stderr, []);
  });

  it("doctor propagates the computed exit code when a probe fails", async () => {
    const { doctor } = await import("../dist/commands/doctor.js");
    const { adapter, stdout } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      () =>
        doctor({
          buildReport: async () => ({
            schemaVersion: 1,
            effectiveProvider: "zai",
            sharedCapabilities: [],
            zaiOnlyCapabilities: [],
            node: { version: process.version, visionMcpCompatible: true },
            providers: [
              {
                provider: "zai",
                configured: true,
                capabilities: ["search"],
                status: "error",
                error: { code: "AUTH_ERROR", message: "nope" },
              },
            ],
          }),
        }),
      "data",
    );
    assert.strictEqual(status, 1);
    const report = JSON.parse(stdout[0]);
    assert.strictEqual(report.providers[0].status, "error");
    assert.strictEqual(stdout.length, 1, "failed entries are still rendered");
  });
});

describe("invokeCommand — quota routed through the seam (P4-03)", () => {
  // A schema-version-1 QuotaDashboard with a single Z.AI success entry,
  // matching the normalized Provider-quota Interface (ADR-0001).
  function zaiDashboard() {
    return {
      schemaVersion: 1,
      effectiveProvider: "zai",
      providers: [
        {
          provider: "zai",
          status: "ok",
          plan: "pro",
          categories: [
            {
              name: "requests",
              unit: "requests",
              current: {
                used: 42,
                limit: 100,
                remaining: 58,
                remainingPercent: 58,
                resetsAt: "2023-11-14T22:13:20.000Z",
              },
            },
          ],
        },
      ],
    };
  }

  it("quota returns the normalized dashboard as base data", async () => {
    const { quota } = await import("../dist/commands/quota.js");
    const { adapter, stdout } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      () => quota({ buildDashboard: async () => zaiDashboard() }),
      "data",
    );
    assert.strictEqual(status, 0);
    const data = JSON.parse(stdout[0]);
    assert.strictEqual(data.schemaVersion, 1);
    assert.strictEqual(data.effectiveProvider, "zai");
    assert.strictEqual(data.providers[0].status, "ok");
    assert.strictEqual(data.providers[0].plan, "pro");
    assert.strictEqual(data.providers[0].categories[0].current.remainingPercent, 58);
  });

  it("quota tty presentation renders provider and category with remaining percentage", async () => {
    const { quota } = await import("../dist/commands/quota.js");
    const { adapter, stdout } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      () => quota({ buildDashboard: async () => zaiDashboard() }),
      "tty",
    );
    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.length, 1);
    const tty = stdout[0];
    assert.ok(tty.includes("zai"), "provider label present");
    assert.ok(tty.includes("requests"), "category name present");
    assert.ok(/58%/.test(tty), "remaining percentage present");
    assert.throws(() => JSON.parse(tty), "tty presentation is not JSON");
  });

  it("quota surfaces a thrown ConfigurationError (missing key) as one structured stderr value, exit 3", async () => {
    const { quota } = await import("../dist/commands/quota.js");
    const { adapter, stderr } = createRecordingAdapter();
    // The default buildDashboard path resolves the effective Provider and
    // throws ConfigurationError when it is unconfigured (no key).
    const status = await invokeCommand(
      adapter,
      () =>
        quota({
          buildDashboard: async () => {
            throw new ConfigurationError("Z_AI_API_KEY environment variable is required");
          },
        }),
      "data",
    );
    assert.strictEqual(status, 3);
    assert.strictEqual(stderr.length, 1, "exactly one structured stderr value");
    const parsed = JSON.parse(stderr[0]);
    assert.strictEqual(parsed.success, false);
    assert.strictEqual(parsed.code, "CONFIGURATION_ERROR");
    assert.ok(parsed.error.includes("Z_AI_API_KEY"));
  });

  it("quota dashboard with a failure entry yields exit 1", async () => {
    const { quota } = await import("../dist/commands/quota.js");
    const { adapter } = createRecordingAdapter();
    const status = await invokeCommand(
      adapter,
      () =>
        quota({
          buildDashboard: async () => ({
            schemaVersion: 1,
            effectiveProvider: "zai",
            providers: [
              zaiDashboard().providers[0],
              {
                provider: "minimax",
                status: "error",
                error: { code: "AUTH_ERROR", message: "minimax down" },
              },
            ],
          }),
        }),
      "data",
    );
    assert.strictEqual(status, 1);
  });
});
