/**
 * Secrets-redaction conformance guard over SAVE_CAPABLE_COMMANDS (#269).
 *
 * The class bug (fixed in f92e202, investigate-only): a budgeted run
 * persisted the FULL untrimmed envelope through
 * `redactSecrets(pack, undefined)` — deps.secrets never threaded — so
 * the compaction master leaked credentials even though stdout was
 * redacted. The post-fix sweep of merged main found zero live
 * instances; this file is the prevention-grade guard so the NEXT
 * save-capable command cannot reintroduce the class invisibly.
 *
 * Shape: one main()-level row per save-capable command. Each row
 * injects a fixture secret through deps.env (a real credential env
 * var — redaction is by VALUE), embeds that secret in the command's
 * payload via a fake descriptor, runs budgeted where the command has
 * an Output Budget ladder (`--max-chars`) and `--save` (master-only)
 * where it does not (vision, map), then asserts the secret is absent
 * from BOTH stdout and EVERY persisted *.json artifact in the run's
 * isolated artifacts dir (compaction masters + the index.json log).
 *
 * SAVE_CAPABLE_COMMANDS is not exported from src/index.ts (it is a
 * private const at src/index.ts:800), so the nine-command set is a
 * test-local literal — but NOT a trusted one: the derivation row
 * re-derives the set from production behavior (the FILE_ERROR export
 * guard fires exactly on SAVE_CAPABLE_COMMANDS), so drift in EITHER
 * direction REDs naming the drifted command.
 *
 * 100% hermetic: fake descriptors / globalThis.fetch stub, isolated
 * artifacts + cache dirs per row, fixed clock. No network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { main, DISPATCHED_COMMANDS } from "../dist/index.js";
import { createInMemoryConsumptionSink } from "../dist/lib/consumption.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import {
  createFakeCrawlDescriptor,
  createFakeMapDescriptor,
  createFakeReaderDescriptor,
  createFakeResearchDescriptor,
} from "./helpers/fake-adapter.js";

// The derivation row sweeps every dispatched command; `init`'s eager
// initDeps build reads the ambient config root (#119 guard) — the
// file-level pin is the established idiom for that seam.
useTempConfigDir();

/**
 * SAVE_CAPABLE_COMMANDS mirror (src/index.ts:800 — not exported; exporting
 * it would be a production change outside the original commit's fence).
 * NOT trusted blindly: the behavioral derivation row below proves this
 * literal against production behavior — a production addition or removal
 * that this list misses REDs there.
 */
const SAVE_CAPABLE = [
  "search",
  "science",
  "read",
  "crawl",
  "map",
  "research",
  "repo",
  "vision",
  "investigate",
];

/** The fixture credential value. Injected as TAVILY_API_KEY (any configured var works — redaction is by value). */
const SECRET = "tavily-sk-probe-9f1e-DO-NOT-LEAK-7742";
const FILLER = "filler prose that pads the envelope past the budget. ";

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode() {},
    },
    stdout,
    stderr,
  };
}

/**
 * Drive main() for one row: isolated artifacts + cache dirs (cleanup
 * registered on the test context — the withTempDir idiom, so failure
 * paths never leak), the fixture secret in deps.env, and (unless the
 * row supplies its own descriptors) the row's fake descriptor list.
 * Returns the run plus the artifacts dir for the leak scan.
 */
async function runRow(t, argv, { descriptors, env = {}, consume } = {}) {
  const artifactsDir = await withTempDir(t, (dir) => dir, { prefix: "secrets-conf-art-" });
  const cacheDir = await withTempDir(t, (dir) => dir, { prefix: "secrets-conf-cache-" });
  const { adapter, stdout, stderr } = makeInvocation();
  const deps = hermeticMainDeps({
    invocation: adapter,
    env: {
      TAVILY_API_KEY: SECRET,
      SCOUTLINE_ARTIFACTS_DIR: artifactsDir,
      SCOUTLINE_CACHE_DIR: cacheDir,
      ...env,
    },
    ...(descriptors !== undefined ? { providerDescriptors: descriptors } : {}),
    ...(consume !== undefined ? { consume } : {}),
    now: () => 1_700_000_000_000,
  });
  const code = await main(argv, deps);
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), artifactsDir };
}

/** The row verdict: exit 0, secret in NEITHER stdout NOR any persisted artifact; a master must exist. */
async function assertSecretContained(label, run) {
  assert.strictEqual(run.code, 0, `${label}: exit 0, stderr: ${run.stderr}`);
  assert.ok(run.stdout.length > 0, `${label}: stdout must be non-empty (row integrity)`);
  assert.ok(!run.stdout.includes(SECRET), `${label}: secret leaked into stdout`);
  const entries = await fs.readdir(run.artifactsDir).catch(() => []);
  const jsonFiles = entries.filter((e) => e.endsWith(".json"));
  const masters = jsonFiles.filter((e) => e !== "index.json");
  assert.ok(
    masters.length >= 1,
    `${label}: a persisted master must exist (budget/save must have fired)`,
  );
  for (const file of jsonFiles) {
    const text = await fs.readFile(path.join(run.artifactsDir, file), "utf8");
    assert.ok(
      !text.includes(SECRET),
      `${label}: secret leaked into persisted artifact ${file}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Local descriptor doubles (trimmed idioms from the suites that own them)
// ---------------------------------------------------------------------------

/** Counting search descriptor (save-flags-main idiom). */
function makeSearchDescriptor(id, results) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(r) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: `fp-${id}`,
            request: r,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          return results[request.query] ?? results["*"];
        },
      },
    }),
  };
}

/** Recording repository descriptor (repository-command idiom, trimmed). */
function makeRepoDescriptor(search) {
  const op = {
    kind: "repository-search",
    validate() {},
    cacheIdentity(request) {
      return {
        provider: "zai",
        capability: "repository-exploration",
        operation: "repository-search",
        credentialFingerprint: "fp-zai",
        request,
        legacyCandidates: [],
      };
    },
    decodeCached(value) {
      return value && typeof value === "object" ? value : null;
    },
    async invoke() {
      return search();
    },
  };
  return {
    id: "zai",
    isConfigured: () => true,
    capabilities: () => new Set(["repository-exploration"]),
    create: () => ({ id: "zai", repository: { search: op } }),
  };
}

/** Science supplier descriptor (science-journal idiom, trimmed). */
function makeScienceDescriptor(id, works) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["science.search"]),
    create: () => ({
      id,
      science: {
        search: {
          validate() {},
          cacheIdentity(request) {
            return {
              supplier: id,
              capability: "science.search",
              credentialFingerprint: "",
              request,
            };
          },
          async invoke() {
            return works;
          },
        },
      },
    }),
  };
}

/** Investigate grid (investigate-cli idiom, trimmed). */
const QUESTION = "alpha | beta";
const PACK_URLS = ["https://e/s1", "https://e/s2", "https://e/s3"];

function makeInvestigateReader() {
  return {
    id: "zai",
    isConfigured: () => true,
    capabilities: () => new Set(["reader"]),
    create: () => ({
      id: "zai",
      reader: {
        fetch: {
          kind: "reader-fetch",
          validate() {},
          cacheIdentity(request) {
            return {
              provider: "zai",
              capability: "reader",
              operation: "reader-fetch",
              credentialFingerprint: "fp-zai",
              request,
              legacyCandidates: [],
            };
          },
          decodeCached(value) {
            return value && typeof value === "object" ? value : null;
          },
          async invoke(request) {
            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: request.url,
              title: "Page " + request.url,
              // Passage extraction is TERM-filtered (terms derive from
              // the question "alpha | beta") — the secret only reaches
              // the pack (and thus the compaction master) inside a
              // quoted window, so the content must carry BOTH a term
              // and the secret.
              content: `alpha protocol notes: credential ${SECRET} inside page prose. ` +
                FILLER.repeat(20),
              contentFormat: "markdown",
            };
          },
        },
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Rows — one per SAVE_CAPABLE command
// ---------------------------------------------------------------------------

describe("#269 — secrets-redaction conformance over SAVE_CAPABLE_COMMANDS", () => {
  it("derives SAVE_CAPABLE from production behavior: FILE_ERROR export guard fires exactly on the mirrored set", async (t) => {
    // Behavioral teeth for the mirror above (a literal-vs-literal pin is
    // vacuous — it cannot see production drift). Mechanism: both
    // pre-dispatch --save export guards gate on
    // SAVE_CAPABLE_COMMANDS.has(command) (src/index.ts:7019 science arm,
    // :7075 shared arm), so a --save pointed at an EXISTING file is
    // refused with exit 1 + FILE_ERROR + empty stdout EXACTLY on the
    // save-capable commands; everything else accepts-and-drops --save
    // and never runs the guard. A production command joining or leaving
    // SAVE_CAPABLE_COMMANDS changes the observed set -> this row REDs
    // naming the drifted command (add a conformance row / drop the row
    // with it). Tooth scope (mutation-verified with "quota"): commands
    // whose dispatch runs the shared guard. Commands with an EARLIER
    // credential-free short-circuit (cache/usage/history/init and the
    // science arm) return before the shared guard — for those the pin
    // sees the pre-short-circuit behavior, which is exactly what a
    // --save consumer experiences.
    const searchLike = {
      validate() {},
      cacheIdentity(r) {
        return {
          provider: "zai",
          capability: "search",
          credentialFingerprint: "fp",
          request: r,
          legacyCandidates: [],
        };
      },
      async invoke() {
        return [{ title: "t", url: "https://e/1", summary: "s" }];
      },
    };
    // One descriptor advertising every capability the minimal argvs
    // touch; commands whose behavior errors still never reach the save
    // hook — the guard fires BEFORE dispatch, so error exits are inert.
    const descriptor = {
      id: "zai",
      isConfigured: () => true,
      capabilities: () =>
        new Set([
          "search",
          "reader",
          "crawl",
          "map",
          "research",
          "repository-exploration",
          "vision.extract-text",
        ]),
      create: () => ({
        id: "zai",
        search: searchLike,
        reader: { fetch: searchLike },
        crawl: { fetch: searchLike },
        map: { fetch: searchLike },
        research: { run: searchLike },
        repository: { search: searchLike },
        vision: { validate() {}, supports: () => true, async invoke() { return "t"; } },
      }),
    };
    // Minimal hermetic argv per dispatched command (subcommands chosen
    // so parse succeeds; behavior never runs past the guard).
    const ARGV = {
      vision: ["vision", "extract-text", "x.png"],
      search: ["search", "q"],
      read: ["read", "https://e/1"],
      crawl: ["crawl", "https://e/"],
      map: ["map", "https://e/"],
      research: ["research", "q"],
      repo: ["repo", "search", "o/r", "q"],
      batch: ["batch", "--help"],
      tools: ["tools", "list"],
      tool: ["tool"],
      call: ["call"],
      doctor: ["doctor", "--json"],
      quota: ["quota"],
      code: ["code"],
      cache: ["cache", "stats"],
      usage: ["usage"],
      history: ["history", "list"],
      init: ["init"],
      config: ["config", "list"],
      fetch: ["fetch", "https://e/1"],
      archive: ["archive"],
      watch: ["watch", "https://e/1"],
      science: ["science", "search", "q"],
      investigate: ["investigate", "q"],
    };
    const guarded = await withTempDir(t, async (guardDir) => {
      const target = path.join(guardDir, "exists.json");
      await fs.writeFile(target, "keep");
      const observed = [];
      for (const command of DISPATCHED_COMMANDS) {
        await withTempDir(t, async (artifactsDir) => {
          const { adapter, stdout, stderr } = makeInvocation();
          const code = await main([...ARGV[command], "--save", target], hermeticMainDeps({
            invocation: adapter,
            env: {
              Z_AI_API_KEY: "k",
              SCOUTLINE_ARTIFACTS_DIR: artifactsDir,
            },
            providerDescriptors: [descriptor],
          }));
          const last = stderr.filter((l) => l.trim().startsWith("{")).at(-1);
          let errCode = "";
          try {
            errCode = last !== undefined ? (JSON.parse(last).code ?? "") : "";
          } catch {
            errCode = "";
          }
          if (code === 1 && errCode === "FILE_ERROR" && stdout.length === 0) {
            observed.push(command);
          }
        }, { prefix: "secrets-conf-derive-" });
      }
      return observed;
    }, { prefix: "secrets-conf-guard-" });
    assert.deepStrictEqual(
      [...guarded].sort(),
      [...SAVE_CAPABLE].sort(),
      "observed save-capable set (FILE_ERROR export guard) must equal the mirrored list — update SAVE_CAPABLE and add/drop the conformance row for the drifted command",
    );
  });

  it("search: budgeted run keeps the secret out of stdout and the compaction master", async (t) => {
    const run = await runRow(t, ["search", "probe query", "--max-chars", "200"], {
      descriptors: [
        makeSearchDescriptor("zai", {
          "*": [1, 2, 3].map((i) => ({
            title: `row-${i}`,
            url: `https://e/r${i}`,
            summary: `credential ${SECRET} embedded ` + FILLER.repeat(10),
          })),
        }),
      ],
    });
    await assertSecretContained("search", run);
  });

  it("read: budgeted run keeps the secret out of stdout and the compaction master", async (t) => {
    const reader = createFakeReaderDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          result: {
            schemaVersion: 1,
            url: "https://example.com/doc",
            finalUrl: "https://example.com/doc",
            title: "Doc",
            content: `credential ${SECRET} embedded. ` + FILLER.repeat(20),
            contentFormat: "markdown",
          },
        },
      },
    });
    const run = await runRow(t, ["read", "https://example.com/doc", "--max-chars", "200"], {
      descriptors: [reader.descriptor],
    });
    await assertSecretContained("read", run);
  });

  it("crawl: budgeted run keeps the secret out of stdout and the compaction master", async (t) => {
    const crawl = createFakeCrawlDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          result: {
            schemaVersion: 1,
            baseUrl: "https://example.com/",
            pages: [
              {
                url: "https://example.com/p1",
                content: `credential ${SECRET} embedded. ` + FILLER.repeat(20),
                contentFormat: "markdown",
              },
            ],
            totalPages: 1,
          },
        },
      },
    });
    const run = await runRow(t, ["crawl", "https://example.com/", "--max-chars", "200"], {
      descriptors: [crawl.descriptor],
    });
    await assertSecretContained("crawl", run);
  });

  it("research: budgeted run keeps the secret out of stdout and the compaction master", async (t) => {
    const research = createFakeResearchDescriptor({
      id: "zai",
      capabilityOptions: {
        run: {
          result: {
            schemaVersion: 1,
            query: "probe query",
            model: "auto",
            report: `Report cites credential ${SECRET}. ` + FILLER.repeat(20),
            sources: [{ title: "src", url: "https://e/s1" }],
          },
        },
      },
    });
    const run = await runRow(t, ["research", "probe query", "--max-chars", "200"], {
      descriptors: [research.descriptor],
    });
    await assertSecretContained("research", run);
  });

  it("repo: budgeted run keeps the secret out of stdout and the compaction master", async (t) => {
    const run = await runRow(t,
      ["repo", "search", "owner/repo", "query", "--max-chars", "5"],
      {
        descriptors: [
          makeRepoDescriptor(() => ({
            schemaVersion: 1,
            repository: "owner/repo",
            query: "query",
            language: "en",
            excerpts: [1, 2, 3].map((i) => ({
              text: `credential ${SECRET} in excerpt ${i}. ` + FILLER.repeat(10),
            })),
            truncated: false,
            originalTextLength: 999,
          })),
        ],
      },
    );
    await assertSecretContained("repo", run);
  });

  it("science: budgeted run keeps the secret out of stdout and the compaction master", async (t) => {
    const works = [1, 2, 3].map((i) => ({
      title: `work-${i}-title`,
      url: `https://example.org/work-${i}`,
      summary: `credential ${SECRET} in summary. ` + FILLER.repeat(40),
      authors: ["A"],
      venue: "Venue",
    }));
    const descriptors = ["openalex", "arxiv", "crossref", "pubmed", "europepmc"].map((id, i) =>
      makeScienceDescriptor(id, i === 0 ? works : []),
    );
    const run = await runRow(t, ["science", "search", "probe", "--max-chars", "400"], {
      descriptors,
    });
    await assertSecretContained("science", run);
  });

  it("investigate: budgeted run keeps the secret out of stdout and the compaction master", async (t) => {
    const byQuery = (query) =>
      PACK_URLS.slice(0, 2).map((url, i) => ({
        title: `source ${i} for ${query}`,
        url,
        summary: "s",
      }));
    const run = await runRow(t,
      // Budget 900 (verified): small enough that compaction fires,
      // large enough that the ladder's whole-source drops floor at TWO
      // sources — a tiny budget floors to an empty sources array (an
      // empty master cannot leak; the row would false-green), and a
      // large one skips compaction entirely (no master at all).
      ["--provider", "tavily,exa", "investigate", QUESTION, "--max-chars", "900"],
      {
        descriptors: [
          makeSearchDescriptor("tavily", { alpha: byQuery("alpha"), beta: byQuery("beta") }),
          makeSearchDescriptor("exa", { alpha: byQuery("alpha"), beta: byQuery("beta") }),
          makeInvestigateReader(),
        ],
      },
    );
    await assertSecretContained("investigate", run);
  });

  it("vision: saved run keeps the secret out of stdout and the master (no ladder — master-only --save)", async (t) => {
    // Production registry path (no injected descriptors): the extract
    // text rides the globalThis.fetch stub, so the OCR double embeds
    // the secret in the extracted text.
    const savedGlobalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      void url;
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ md_results: `extracted credential ${SECRET} from image` }),
      };
    };
    try {
      await withTempDir(t, async (src) => {
        const file = path.join(src, "doc.png");
        await fs.writeFile(file, Buffer.from("vision-probe"));
        const run = await runRow(t, ["vision", "extract-text", file, "--save"], {
          env: { Z_AI_API_KEY: "zai-key-ok" },
          consume: createInMemoryConsumptionSink(),
        });
        await assertSecretContained("vision", run);
      }, { prefix: "secrets-conf-vision-" });
    } finally {
      globalThis.fetch = savedGlobalFetch;
    }
  });

  it("map: saved run keeps the secret out of stdout and the master (no ladder — master-only --save)", async (t) => {
    const map = createFakeMapDescriptor({
      id: "zai",
      capabilityOptions: {
        fetch: {
          result: {
            schemaVersion: 1,
            baseUrl: "https://example.com/",
            urls: [`https://e/a?token=${SECRET}`, "https://e/b"],
            totalUrls: 2,
          },
        },
      },
    });
    const run = await runRow(t, ["map", "https://example.com/", "--save"], {
      descriptors: [map.descriptor],
    });
    await assertSecretContained("map", run);
  });
});
