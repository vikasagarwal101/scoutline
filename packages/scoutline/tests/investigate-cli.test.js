/**
 * T6 — CLI wiring + controls conformance (investigate-pipeline lane;
 * docs/plans/investigate-pipeline TASKS T6, PRD AC-1/AC-9/AC-10).
 *
 * main()-hermetic dispatch: every run injects loadScoutlineConfig +
 * fixture providerDescriptors (hermeticMainDeps — `env: {}` is NOT
 * isolation; the real ~/.scoutline/config.json leaks fanout/routing).
 * Fixture adapters mirror tests/investigate-orchestrator.test.js
 * (tavily/exa search arms, a zai reader supplier); no network.
 *
 * Rows:
 *   - dispatch: `investigate "q"` → pack in data mode; json/pretty wrap
 *     {success,data,timestamp}; text modes fall back to JSON.
 *   - controls: --provider fan-out / single pin / config fanout tiers;
 *     --sources consumed; --context consumed; --max-chars consumed;
 *     --save writes the artifact; --no-journal suppresses the journal;
 *     --isolated accepted with the isolated/<pid> cache segment.
 *   - rejections: --depth/--arms/--budget-tokens/--context-stdin each
 *     VALIDATION_ERROR (unknown-flag rejection IS the feature); bad
 *     --sources / --max-chars values VALIDATION_ERROR.
 *   - INVESTIGATE_HELP printed on --help.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { INVESTIGATE_HELP } from "../dist/commands/investigate.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { withTempDir } from "./helpers/temp-dir.js";

const QUESTION = "alpha | beta";

// ---------------------------------------------------------------------------
// Fixture adapters (mirror tests/investigate-orchestrator.test.js)
// ---------------------------------------------------------------------------

const URLS = {
  s1: "https://e/s1",
  s2: "https://e/s2",
  s3: "https://e/s3",
  b2: "https://e/b2",
  va: "https://e/va",
  vb: "https://e/vb",
};

function makeSearchDescriptor(id, resultsByQuery) {
  const invokes = [];
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(request) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: "fp-" + id,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          invokes.push(request.query);
          return resultsByQuery[request.query] ?? [];
        },
      },
    }),
  };
  return { descriptor, invokes };
}

function makeReaderDescriptor(id, results) {
  const invokes = [];
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["reader"]),
    create: () => ({
      id,
      reader: {
        fetch: {
          kind: "reader-fetch",
          validate() {},
          cacheIdentity(request) {
            return {
              provider: id,
              capability: "reader",
              operation: "reader-fetch",
              credentialFingerprint: "fp-" + id,
              request,
              legacyCandidates: [],
            };
          },
          decodeCached(value) {
            if (value === null || typeof value !== "object") return null;
            return value;
          },
          async invoke(request) {
            invokes.push(request.url);
            const canned = results[request.url];
            if (canned === undefined) throw new Error("no canned result");
            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: request.url,
              title: "Page " + request.url,
              content: canned.content,
              contentFormat: "markdown",
            };
          },
        },
      },
    }),
  };
  return { descriptor, invokes };
}

function baseGrid() {
  return [
    makeSearchDescriptor("tavily", {
      alpha: [
        { title: "shared source one page summary", url: URLS.s1, summary: "s1" },
        { title: "second source page summary for alpha queries", url: URLS.s2, summary: "s2" },
      ],
      beta: [
        { title: "shared source one page summary", url: URLS.s1, summary: "s1 again" },
        { title: "fourth source page with beta analysis", url: URLS.b2, summary: "b2" },
      ],
    }),
    makeSearchDescriptor("exa", {
      alpha: [
        { title: "third source page about beta protocols", url: URLS.s3, summary: "s3" },
        { title: "shared source one page summary", url: URLS.s1, summary: "s1 third" },
      ],
      beta: [
        {
          title: "evaluating the performance characteristics of modern vector database systems in production today",
          url: URLS.va,
          summary: "va",
        },
        {
          title: "evaluating the performance characteristics of modern vector database systems in production environments",
          url: URLS.vb,
          summary: "vb",
        },
      ],
    }),
  ];
}

function baseReader() {
  const results = {};
  for (const url of Object.values(URLS)) {
    if (url === URLS.vb) continue; // cluster member never read
    results[url] = {
      content:
        "The alpha protocol overview. This page documents alpha internals. Unrelated filler text. More beta notes follow.",
    };
  }
  return makeReaderDescriptor("zai", results);
}

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

/** Parse the single stderr error envelope, if any. */
function stderrEnvelope(stderr) {
  const line = stderr.find((l) => l.trim().startsWith("{"));
  return line === undefined ? undefined : JSON.parse(line);
}

/** Envelope error code — `error` is the message string in this shape. */
function envelopeCode(envelope) {
  return envelope?.error?.code ?? envelope?.code;
}

/** Envelope error message. */
function envelopeMessage(envelope) {
  return typeof envelope?.error === "string" ? envelope.error : envelope?.error?.message ?? "";
}

// ---------------------------------------------------------------------------
// 1. Dispatch + output modes
// ---------------------------------------------------------------------------

describe("investigate: main() hermetic dispatch + output modes", () => {
  it("investigate \"q\" returns the pack in data mode", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["--provider", "tavily,exa", "investigate", QUESTION], {
      ...hermeticMainDeps({
        invocation: adapter,
        providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
      }),
    });
    assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
    const pack = JSON.parse(stdout[0]);
    assert.strictEqual(pack.schemaVersion, 1);
    assert.strictEqual(pack.question, QUESTION);
    assert.deepStrictEqual(pack.subQueries, ["alpha", "beta"]);
    assert.strictEqual(pack.coverage.sourcesRead, 5);
    assert.ok(pack.sources.every((s) => /^[0-9a-f]{64}$/.test(s.contentSha256)));
    assert.ok(pack.sources.every((s) => s.passages.length >= 1));
  });

  it("json / pretty wrap {success, data, timestamp}", async () => {
    for (const mode of ["json", "pretty"]) {
      const grid = baseGrid();
      const reader = baseReader();
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(["--provider", "tavily,exa", "investigate", QUESTION, "-O", mode], {
        ...hermeticMainDeps({
          invocation: adapter,
          providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
        }),
      });
      assert.strictEqual(status, 0, `${mode}: stderr=${JSON.stringify(stderr)}`);
      const envelope = JSON.parse(stdout[0]);
      assert.strictEqual(envelope.success, true);
      assert.strictEqual(typeof envelope.timestamp, "number");
      assert.strictEqual(envelope.data.schemaVersion, 1);
      assert.strictEqual(envelope.data.question, QUESTION);
    }
  });

  it("text modes (compact/markdown/refs/tty) fall back to JSON — the pack is data, not prose", async () => {
    for (const mode of ["compact", "markdown", "refs", "tty"]) {
      const grid = baseGrid();
      const reader = baseReader();
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(["--provider", "tavily,exa", "investigate", QUESTION, "-O", mode], {
        ...hermeticMainDeps({
          invocation: adapter,
          providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
        }),
      });
      assert.strictEqual(status, 0, `${mode}: stderr=${JSON.stringify(stderr)}`);
      // No presentation override: the pack itself prints as JSON.
      const pack = JSON.parse(stdout[0]);
      assert.strictEqual(pack.schemaVersion, 1, `${mode} emitted the pack as JSON`);
    }
  });

  it("--help prints INVESTIGATE_HELP and exits 0", async () => {
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["investigate", "--help"], {
      ...hermeticMainDeps({ invocation: adapter }),
    });
    assert.strictEqual(status, 0);
    assert.deepStrictEqual(stderr, []);
    assert.strictEqual(stdout.join(""), INVESTIGATE_HELP);
  });
});

// ---------------------------------------------------------------------------
// 2. Rejected flags (rejection IS the feature)
// ---------------------------------------------------------------------------

describe("investigate: rejected flags are VALIDATION_ERROR, never accept-and-drop", () => {
  const REJECTED = [
    ["--depth", ["investigate", "q", "--depth", "2"]],
    ["--arms", ["investigate", "q", "--arms", "3"]],
    ["--budget-tokens", ["investigate", "q", "--budget-tokens", "1000"]],
    ["--context-stdin", ["investigate", "q", "--context-stdin"]],
  ];
  for (const [flag, argv] of REJECTED) {
    it(`${flag} rejects VALIDATION_ERROR naming investigate (exit 1, before any provider work)`, async () => {
      // Tripwire descriptors: the rejection must fire before any adapter
      // construction (parse-level, the handleSearch guard order).
      const descriptors = [
        {
          id: "tavily",
          isConfigured: () => true,
          capabilities: () => new Set(["search"]),
          create() {
            throw new Error("create() must not be reached on a rejected flag");
          },
        },
      ];
      const { adapter, stderr } = makeAdapter();
      const status = await main(argv, {
        ...hermeticMainDeps({ invocation: adapter, providerDescriptors: descriptors }),
      });
      assert.strictEqual(status, 1);
      const envelope = stderrEnvelope(stderr);
      assert.ok(envelope !== undefined, "stderr carries the error envelope");
      assert.strictEqual(envelopeCode(envelope), "VALIDATION_ERROR");
      const message = envelopeMessage(envelope);
      assert.ok(
        message.includes(flag.slice(2)) || message.includes("investigate"),
        `error names the flag/command: ${message}`,
      );
    });
  }

  it("both spellings: --no-depth rejects too (the #242 two-spelling contract)", async () => {
    const { adapter, stderr } = makeAdapter();
    const status = await main(["investigate", "q", "--no-depth"], {
      ...hermeticMainDeps({ invocation: adapter }),
    });
    assert.strictEqual(status, 1);
    assert.strictEqual(envelopeCode(stderrEnvelope(stderr)), "VALIDATION_ERROR");
  });

  it("--sources 0 / -1 / 2.5 / valueless are VALIDATION_ERROR before provider work", async () => {
    for (const argv of [
      ["investigate", "q", "--sources", "0"],
      ["investigate", "q", "--sources", "-1"],
      ["investigate", "q", "--sources", "2.5"],
      ["investigate", "q", "--sources"],
    ]) {
      const descriptors = [
        {
          id: "tavily",
          isConfigured: () => true,
          capabilities: () => new Set(["search"]),
          create() {
            throw new Error("create() must not be reached on a bad --sources");
          },
        },
      ];
      const { adapter, stderr } = makeAdapter();
      const status = await main(argv, {
        ...hermeticMainDeps({ invocation: adapter, providerDescriptors: descriptors }),
      });
      assert.strictEqual(status, 1, `argv=${argv.join(" ")}`);
      assert.strictEqual(envelopeCode(stderrEnvelope(stderr)), "VALIDATION_ERROR");
    }
  });

  it("--max-chars 0 / -5 / 2.5 are VALIDATION_ERROR before provider work", async () => {
    for (const value of ["0", "-5", "2.5"]) {
      const { adapter, stderr } = makeAdapter();
      const status = await main(["investigate", "q", "--max-chars", value], {
        ...hermeticMainDeps({ invocation: adapter }),
      });
      assert.strictEqual(status, 1);
      assert.strictEqual(envelopeCode(stderrEnvelope(stderr)), "VALIDATION_ERROR");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Provider tiers (AC-1: search's activation tiers verbatim)
// ---------------------------------------------------------------------------

describe("investigate: provider activation tiers", () => {
  it("--provider tavily,exa fans out — coverage.armsUsed 2, both arms invoked", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["--provider", "tavily,exa", "investigate", QUESTION], {
      ...hermeticMainDeps({
        invocation: adapter,
        providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
      }),
    });
    assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
    const pack = JSON.parse(stdout[0]);
    assert.strictEqual(pack.coverage.armsUsed, 2);
    assert.ok(grid[0].invokes.length > 0, "tavily arm ran");
    assert.ok(grid[1].invokes.length > 0, "exa arm ran");
  });

  it("single pin runs ONE arm — coverage.armsUsed 1, only the pinned arm invoked", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["--provider", "tavily", "investigate", QUESTION], {
      ...hermeticMainDeps({
        invocation: adapter,
        providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
      }),
    });
    assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
    const pack = JSON.parse(stdout[0]);
    assert.strictEqual(pack.coverage.armsUsed, 1);
    assert.strictEqual(grid[1].invokes.length, 0, "exa arm never ran under the pin");
    assert.ok(grid[0].invokes.length > 0);
    assert.ok(pack.sources.every((s) => s.provider === "tavily"));
  });

  it("config fanout: true (no pin) is a standing fan-out — armsUsed 2", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["investigate", QUESTION], {
      ...hermeticMainDeps({
        invocation: adapter,
        configFanout: true,
        providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
      }),
    });
    assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
    const pack = JSON.parse(stdout[0]);
    assert.strictEqual(pack.coverage.armsUsed, 2);
    assert.ok(grid[0].invokes.length > 0 && grid[1].invokes.length > 0);
  });

  it("--sources 2 threads the read cap — 2 sources read, merged order preserved", async () => {
    const grid = baseGrid();
    const reader = baseReader();
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(
      ["--provider", "tavily,exa", "investigate", QUESTION, "--sources", "2"],
      {
        ...hermeticMainDeps({
          invocation: adapter,
          providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
        }),
      },
    );
    assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
    const pack = JSON.parse(stdout[0]);
    assert.deepStrictEqual(
      pack.sources.map((s) => s.url),
      [URLS.s1, URLS.va],
    );
    assert.strictEqual(pack.coverage.sourcesRead, 2);
    assert.strictEqual(pack.coverage.sourcesConsidered, 5);
  });
});

// ---------------------------------------------------------------------------
// 4. --context consumed (context tier through main())
// ---------------------------------------------------------------------------

describe("investigate: --context is wire-consumed", () => {
  it("a notes file derives the sub-query grid (planner context tier)", async (t) => {
    await withTempDir(t, async (dir) => {
      const notes = path.join(dir, "notes.md");
      fs.writeFileSync(notes, "# Heading One\n- What about alpha limits?\n");
      const arm = makeSearchDescriptor("tavily", {
        "What about alpha limits?": [{ title: "ctx page", url: "https://e/c1", summary: "s" }],
        "Heading One": [{ title: "ctx page", url: "https://e/c1", summary: "s" }],
      });
      const reader = makeReaderDescriptor("zai", {
        "https://e/p1": { content: "alpha body. beta body." },
        "https://e/c1": { content: "alpha body. beta body." },
      });
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(
        // Pipe-free question: pipes would win over --context by design
        // (planner precedence), so the context tier test must not carry one.
        ["--provider", "tavily", "investigate", "alpha beta topic", "--context", notes],
        {
          ...hermeticMainDeps({
            invocation: adapter,
            providerDescriptors: [arm.descriptor, reader.descriptor],
          }),
        },
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const pack = JSON.parse(stdout[0]);
      // Context tier: deriveSubQueries output verbatim (no original
      // prepend) — the derived stream IS the grid.
      assert.ok(
        pack.subQueries.includes("What about alpha limits?") ||
          pack.subQueries.includes("Heading One"),
        `derived sub-queries present: ${JSON.stringify(pack.subQueries)}`,
      );
      assert.ok(!pack.subQueries.includes("alpha"), "original question not prepended");
      assert.strictEqual(pack.coverage.subQueries, pack.subQueries.length);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. --no-journal (underlying op journals suppressed)
// ---------------------------------------------------------------------------

describe("investigate: --no-journal", () => {
  function readJournal(artifactsDir) {
    const file = path.join(artifactsDir, "index.json");
    if (!fs.existsSync(file)) return { entries: [] };
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  it("with journaling: the run's underlying search op records a journal entry", async (t) => {
    await withTempDir(t, async (artifactsDir) => {
      const grid = baseGrid();
      const reader = baseReader();
      const { adapter } = makeAdapter();
      const status = await main(["--provider", "tavily,exa", "investigate", QUESTION], {
        ...hermeticMainDeps({
          invocation: adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
        }),
      });
      assert.strictEqual(status, 0);
      const entries = readJournal(artifactsDir).entries.filter((e) => e.kind === "journal");
      assert.ok(entries.length >= 1, "the journaling run records underlying ops");
      assert.strictEqual(entries[0].capability, "search");
      assert.strictEqual(entries[0].provider.mode, "fanout");
    });
  });

  it("--no-journal: NO journal entries for the run's ops", async (t) => {
    await withTempDir(t, async (artifactsDir) => {
      const grid = baseGrid();
      const reader = baseReader();
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(
        ["--provider", "tavily,exa", "investigate", QUESTION, "--no-journal"],
        {
          ...hermeticMainDeps({
            invocation: adapter,
            env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
            providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
          }),
        },
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.ok(JSON.parse(stdout[0]).schemaVersion, "run itself succeeds");
      const store = readJournal(artifactsDir);
      assert.deepStrictEqual(
        store.entries.filter((e) => e.kind === "journal"),
        [],
        "no journal entries under --no-journal",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 6. --isolated accepted (cache under isolated/<pid>)
// ---------------------------------------------------------------------------

describe("investigate: --isolated accepted", () => {
  it("runs the full pack; the cache lands under <root>/cache/isolated/<pid>", async (t) => {
    await withTempDir(t, async (cacheRoot) => {
      const grid = baseGrid();
      const reader = baseReader();
      const { adapter, stdout, stderr } = makeAdapter();
      const deps = hermeticMainDeps({
        invocation: adapter,
        env: { SCOUTLINE_CACHE_DIR: cacheRoot },
        providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
      });
      // Force the real isolated file cache (drop the injected in-memory doubles).
      delete deps.searchCache;
      delete deps.readerCache;
      delete deps.repositoryCache;
      const status = await main(["--isolated", "--provider", "tavily,exa", "investigate", QUESTION], deps);
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const pack = JSON.parse(stdout[0]);
      assert.strictEqual(pack.coverage.sourcesRead, 5, "full pack — never rejected");
      // The pid-segment pin (isolated-cache.test.js idiom).
      const isolatedDir = path.join(cacheRoot, "cache", "isolated", `${process.pid}`);
      assert.ok(fs.existsSync(isolatedDir), `isolated dir exists: ${isolatedDir}`);
      assert.ok(
        fs.readdirSync(isolatedDir).length > 0,
        "the run's cache entries live under isolated/<pid>",
      );
      // Nothing leaks at the shared root.
      assert.deepStrictEqual(fs.readdirSync(path.join(cacheRoot, "cache")), ["isolated"]);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. --save (the pack is the saved result)
// ---------------------------------------------------------------------------

describe("investigate: --save", () => {
  it("writes the master artifact {schemaVersion, requestId, result: pack} + log entry", async (t) => {
    await withTempDir(t, async (artifactsDir) => {
      const grid = baseGrid();
      const reader = baseReader();
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(["--provider", "tavily,exa", "investigate", QUESTION, "--save"], {
        ...hermeticMainDeps({
          invocation: adapter,
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [grid[0].descriptor, grid[1].descriptor, reader.descriptor],
        }),
      });
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const pack = JSON.parse(stdout[0]);
      const log = JSON.parse(fs.readFileSync(path.join(artifactsDir, "index.json"), "utf8"));
      const entry = log.entries.find((e) => e.kind === "save" && e.command === "investigate");
      assert.ok(entry, "save log entry present");
      const master = JSON.parse(fs.readFileSync(path.join(artifactsDir, entry.masterPath), "utf8"));
      assert.deepStrictEqual(Object.keys(master).sort(), ["requestId", "result", "schemaVersion"]);
      assert.deepStrictEqual(master.result, pack);
      assert.strictEqual(entry.provider.mode, "fanout");
    });
  });
});

// ---------------------------------------------------------------------------
// 8. --max-chars through main() (budget consumed at the seam)
// ---------------------------------------------------------------------------

describe("investigate: --max-chars consumed through main()", () => {
  it("a crush budget stamps compaction {budget, ref} in-band", async (t) => {
    await withTempDir(t, async (artifactsDir) => {
      // Long passages so the assembled pack exceeds the 900-char budget.
      const LONG = Array.from(
        { length: 8 },
        (_, i) => `alpha evidence sentence number ${i} ${"detail ".repeat(12)}`,
      ).join(" ");
      const arm = makeSearchDescriptor("tavily", {
        alpha: [{ title: "one", url: "https://e/s1", summary: "s" }],
        beta: [{ title: "two", url: "https://e/s2", summary: "s" }],
      });
      const reader = makeReaderDescriptor("zai", {
        "https://e/s1": { content: LONG },
        "https://e/s2": { content: LONG },
      });
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(
        ["--provider", "tavily", "investigate", "alpha | beta", "--max-chars", "900"],
        {
          ...hermeticMainDeps({
            invocation: adapter,
            env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
            providerDescriptors: [arm.descriptor, reader.descriptor],
          }),
        },
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const data = JSON.parse(stdout[0]);
      assert.ok(data.compaction, "compaction stamped");
      assert.strictEqual(data.compaction.budget, 900);
      assert.match(data.compaction.ref, /^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
      assert.strictEqual(data.question, "alpha | beta", "question never cut");
      assert.strictEqual(data.sources.length, 2, "both sources survive the passage-first order");
    });
  });
});
