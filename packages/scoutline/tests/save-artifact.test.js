/**
 * save-artifacts T4 — the `--save` hook at the invocation seam.
 *
 * Hermetic end-to-end pins: every `main()` drive injects
 * `loadScoutlineConfig` (via `hermeticMainDeps`), a fake invocation
 * adapter, an isolated `SCOUTLINE_ARTIFACTS_DIR`, and counting search
 * descriptor doubles — no ambient config, no real cache, no network.
 *
 * Pins (ticket T4):
 *   1. Clean report: master = `{schemaVersion, requestId, result}` and
 *      NOTHING else (no provider/args/cliVersion/timestamp); `result` is
 *      the exact value data-mode stdout serializes; export copy is
 *      byte-identical to the master; log joins by requestId; the stderr
 *      notice carries requestId + both destinations.
 *   2. stdout is byte-identical with and without `--save`.
 *   3. Redaction: a credential-shaped fixture field + an injected-env
 *      credential appear in NEITHER master, export, nor log.
 *   4. Post-behavior failures: artifacts-dir-is-a-file -> FILE_ERROR,
 *      non-zero, NO stdout; an export target created mid-run (the T3
 *      pre-check race) is refused by the write-time exists-recheck.
 *   5. Log content: provider-influencing args only (no -O, --raw, or --save
 *      flags; no positional text); single requested/effective (fallback fixture
 *      pins requested != effective); fan-out pins {mode, arms} with no
 *      single effective.
 *   6. Markdown artifacts: comment header + stdout-markdown rendering.
 *   7. Non-capable commands still accept-and-drop: no store writes.
 *   8. --save-force overwrites the export through the write-time recheck.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../dist/index.js";
import { TimeoutError } from "../dist/lib/errors.js";
import { createInMemoryResponseCache, hermeticMainDeps } from "./helpers/hermetic-main.js";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
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

/** Search descriptor double: counting, optionally failing / custom result / invoke side effect. */
function makeSaveSearchDescriptor(id, log, options = {}) {
  const { fail = false, result, onInvoke } = options;
  return {
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
            credentialFingerprint: `fp-${id}`,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          log.push(id);
          if (onInvoke) onInvoke();
          if (fail) throw new TimeoutError(`simulated outage on ${id}`);
          return result ?? [{ title: id, url: `https://${id}/r`, summary: "s" }];
        },
      },
    }),
  };
}

/** Reader-shaped descriptor double: nested `{ fetch: operation }` — the cold-review finding-1 shape. */
function makeSaveReaderDescriptor(id, log, options = {}) {
  const { fail = false } = options;
  return {
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
              credentialFingerprint: `fp-${id}`,
              request,
              legacyCandidates: [],
            };
          },
          decodeCached: () => null,
          async invoke() {
            log.push(id);
            if (fail) throw new TimeoutError(`simulated outage on ${id}`);
            return { content: `read by ${id}`, format: "markdown" };
          },
        },
      },
    }),
  };
}

function baseDeps(adapter, log, extra = {}) {
  return hermeticMainDeps({
    invocation: adapter,
    env: {},
    providerDescriptors: [makeSaveSearchDescriptor("zai", log)],
    ...extra,
  });
}

/** Read the artifacts dir: returns {masterName, requestId, report, store}. */
function readStore(artifactsDir, extension = "json") {
  const files = readdirSync(artifactsDir).sort();
  const masters = files.filter((f) => f !== "index.json");
  assert.strictEqual(masters.length, 1, `expected one master, got ${files.join(",")}`);
  const masterName = masters[0];
  const report =
    extension === "json"
      ? JSON.parse(readFileSync(join(artifactsDir, masterName), "utf8"))
      : undefined;
  const store = JSON.parse(readFileSync(join(artifactsDir, "index.json"), "utf8"));
  return {
    masterName,
    requestId: masterName.replace(new RegExp(`\\.${extension}$`), ""),
    report,
    store,
  };
}

describe("save-artifacts T4: the --save hook at the invocation seam", () => {
  it("writes a clean report {schemaVersion, requestId, result} and nothing else", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-artifacts-");
    const exportDir = makeTempDir("scoutline-save-t4-export-");
    const exportTarget = join(exportDir, "report.json");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save", exportTarget],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { masterName, requestId, report, store } = readStore(artifactsDir);
      // The owner ruling: exactly three keys, in any order — and none of
      // the metadata keys the log owns.
      assert.deepStrictEqual(
        [...Object.keys(report)].sort(),
        ["requestId", "result", "schemaVersion"],
      );
      assert.strictEqual(report.schemaVersion, 1);
      assert.strictEqual(report.requestId, requestId);
      // `result` is the same value the data-mode stdout path serialized.
      const stdoutData = JSON.parse(stdout[0]);
      assert.deepStrictEqual(report.result, stdoutData);
      // Export copy is byte-identical to the master.
      assert.strictEqual(
        readFileSync(exportTarget, "utf8"),
        readFileSync(join(artifactsDir, masterName), "utf8"),
      );
      // The log joins by requestId and records the export destination.
      assert.deepStrictEqual(store.entries.map((e) => e.requestId), [requestId]);
      assert.strictEqual(store.entries[0].exportPath, exportTarget);
      // The stderr notice carries the requestId + both destinations.
      const notice = stderr.find((line) => line.includes(requestId));
      assert.ok(notice, `no notice carrying the requestId; stderr=${JSON.stringify(stderr)}`);
      assert.ok(notice.includes(masterName), `notice misses the master path: ${notice}`);
      assert.ok(notice.includes(exportTarget), `notice misses the export path: ${notice}`);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("leaves stdout byte-identical with and without --save", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-stdout-");
    const run = async (argv) => {
      const log = [];
      const { adapter, stdout, stderr } = makeAdapter();
      const status = await main(
        argv,
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      return { status, stdout, stderr };
    };
    try {
      const plain = await run(["search", "q"]);
      const saved = await run(["search", "q", "--save"]);
      assert.strictEqual(plain.status, 0, `plain stderr=${JSON.stringify(plain.stderr)}`);
      assert.strictEqual(saved.status, 0, `saved stderr=${JSON.stringify(saved.stderr)}`);
      assert.deepStrictEqual(
        saved.stdout,
        plain.stdout,
        "stdout must be byte-identical with and without --save",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("redacts credential-shaped fields and injected-env credentials from master, export, and log", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-redact-artifacts-");
    const exportDir = makeTempDir("scoutline-save-t4-redact-export-");
    const exportTarget = join(exportDir, "report.json");
    const SECRET_VALUE = "super-secret-credential-value-9f2";
    const SECRET_KEY_VALUE = "sk-fake-credential-key-abcdef0123456789";
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save", exportTarget],
        baseDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir, Z_AI_API_KEY: SECRET_VALUE },
          providerDescriptors: [
            makeSaveSearchDescriptor("zai", log, {
              result: [
                {
                  title: "leaky",
                  url: "https://leaky/r",
                  summary: `wrapped ${SECRET_VALUE} inside text`,
                  apiKey: SECRET_KEY_VALUE,
                },
              ],
            }),
          ],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { masterName } = readStore(artifactsDir);
      for (const file of [join(artifactsDir, masterName), exportTarget, join(artifactsDir, "index.json")]) {
        const text = readFileSync(file, "utf8");
        assert.ok(!text.includes(SECRET_VALUE), `credential value leaked into ${file}`);
        assert.ok(!text.includes(SECRET_KEY_VALUE), `credential-shaped field leaked into ${file}`);
      }
      // stdout keeps its own redaction contract (same secrets, same pass).
      assert.ok(!stdout.join("").includes(SECRET_VALUE), "credential value leaked to stdout");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("turns a post-behavior save failure into FILE_ERROR with NO stdout (behavior ran)", async () => {
    const blockedParent = makeTempDir("scoutline-save-t4-blocked-");
    const fileDir = join(blockedParent, "not-a-dir");
    writeFileSync(fileDir, "x");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: fileDir } }),
      );
      assert.strictEqual(status, 1);
      assert.deepStrictEqual(stdout, [], "stdout must stay empty when the save fails");
      const envelope = JSON.parse(stderr.at(-1));
      assert.strictEqual(envelope.success, false);
      assert.strictEqual(envelope.code, "FILE_ERROR");
      assert.deepStrictEqual(log, ["zai"], "the behavior ran; the save failed after it");
    } finally {
      rmSync(blockedParent, { recursive: true, force: true });
    }
  });

  it("refuses an export target created mid-run (the write-time recheck closes the T3 race)", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-race-artifacts-");
    const exportDir = makeTempDir("scoutline-save-t4-race-export-");
    const exportTarget = join(exportDir, "report.json");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save", exportTarget],
        baseDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [
            makeSaveSearchDescriptor("zai", log, {
              onInvoke: () => writeFileSync(exportTarget, "mid-run"),
            }),
          ],
        }),
      );
      assert.strictEqual(status, 1);
      assert.deepStrictEqual(stdout, [], "stdout must stay empty when the save fails");
      const envelope = JSON.parse(stderr.at(-1));
      assert.strictEqual(envelope.code, "FILE_ERROR");
      assert.match(envelope.error, /artifact exists/);
      assert.match(envelope.help, /--save-force/);
      // The refused write leaves the winner byte-identical.
      assert.strictEqual(readFileSync(exportTarget, "utf8"), "mid-run");
      // D6 write order: master and log entry persist; only the export failed.
      const { store } = readStore(artifactsDir);
      assert.strictEqual(store.entries.length, 1);
      assert.strictEqual(store.entries[0].exportPath, exportTarget);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("logs the full save entry: kinds, clock, routing, formats, and the master path", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-log-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { masterName, requestId, store } = readStore(artifactsDir);
      const entry = store.entries[0];
      assert.strictEqual(store.version, 1);
      assert.strictEqual(entry.kind, "save");
      assert.strictEqual(entry.command, "search");
      assert.strictEqual(typeof entry.timestamp, "number");
      assert.strictEqual(entry.requestId, requestId);
      assert.deepStrictEqual(entry.provider, { mode: "single", effective: "zai" });
      assert.ok(!("requested" in entry.provider), "no pin: requested stays absent");
      assert.deepStrictEqual(entry.args, {});
      assert.strictEqual(entry.outputFormat, "data");
      assert.strictEqual(entry.artifactFormat, "json");
      assert.strictEqual(typeof entry.cliVersion, "string");
      assert.ok(entry.cliVersion.length > 0, "cliVersion must be stamped");
      assert.strictEqual(entry.masterPath, masterName);
      assert.ok(!("exportPath" in entry), "master-only save records no exportPath");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("records provider-influencing args only; -O/--raw/--save* and positionals stay out", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-args-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--provider", "zai", "--count", "5", "-O", "json", "--raw", "--save"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { store } = readStore(artifactsDir);
      const entry = store.entries[0];
      assert.deepStrictEqual(entry.args, { provider: "zai", count: 5 });
      const argsFlat = JSON.stringify(entry.args);
      for (const forbidden of ['"-O"', '"raw"', '"save"', '"save-format"', '"save-force"', '"q"']) {
        assert.ok(!argsFlat.includes(forbidden), `args must not carry ${forbidden}: ${argsFlat}`);
      }
      assert.strictEqual(entry.provider.requested, "zai");
      assert.strictEqual(entry.provider.effective, "zai");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("fallback fixture: the log records requested != effective (the provider that actually served)", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-fallback-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--provider", "tavily", "--save"],
        baseDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [
            makeSaveSearchDescriptor("tavily", log, { fail: true }),
            makeSaveSearchDescriptor("zai", log),
          ],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      // TimeoutError is the retryable class: the executor may re-attempt the
      // primary before falling back (observed ['tavily','tavily','zai']). The
      // pin is who SERVED, not the attempt count — the latter would pin
      // executor policy, not the save contract.
      assert.ok(log.includes("tavily"), "tavily was attempted");
      assert.strictEqual(log.at(-1), "zai", "zai served after tavily failed");
      const { store } = readStore(artifactsDir);
      assert.deepStrictEqual(store.entries[0].provider, {
        mode: "single",
        requested: "tavily",
        effective: "zai",
      });
      assert.notStrictEqual(
        store.entries[0].provider.requested,
        store.entries[0].provider.effective,
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("cold-review f1: nested operation capture — read fallback records the provider that actually served", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-readfallback-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["read", "https://example.com/a", "--provider", "tavily", "--save"],
        baseDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          providerDescriptors: [
            makeSaveReaderDescriptor("tavily", log, { fail: true }),
            makeSaveReaderDescriptor("zai", log),
          ],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.ok(log.includes("tavily"), "tavily was attempted");
      assert.strictEqual(log.at(-1), "zai", "zai served after tavily failed");
      const { store } = readStore(artifactsDir);
      assert.deepStrictEqual(store.entries[0].provider, {
        mode: "single",
        requested: "tavily",
        effective: "zai",
      }, "nested {fetch:{invoke}} operations must be captured, not just direct-invoke slots");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  // Review round 2 (macroscope, index.ts capture): a fallback candidate
  // that serves from CACHE never reaches invoke() — the shared executors
  // return straight after the cache lookup — so the invoke-only capture
  // stayed unset and the log recorded the pre-run effective (the FAILED
  // provider) instead of the provider whose cache served.
  it("review r2: a cache-hit fallback records the provider whose cache served, not the pre-run effective", async () => {
    const artifactsDir = makeTempDir("scoutline-save-r2-cachehit-");
    const invokeLog = [];
    const cache = createInMemoryResponseCache();
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const descriptors = [
        makeSaveSearchDescriptor("tavily", invokeLog, { fail: true }),
        makeSaveSearchDescriptor("zai", invokeLog),
      ];
      const depsFor = () =>
        baseDeps(adapter, invokeLog, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          searchCache: cache,
          providerDescriptors: descriptors,
        });
      const argv = ["search", "q", "--provider", "tavily", "--save"];

      // Run 1: tavily fails live, zai serves live (warms zai's cache entry).
      const status1 = await main(argv, depsFor());
      assert.strictEqual(status1, 0, `stderr=${JSON.stringify(stderr)}`);
      const zaiLive = invokeLog.filter((id) => id === "zai").length;
      assert.ok(zaiLive > 0, "run 1: zai served live");

      // Run 2: identical request — zai now serves from cache (no invoke).
      const zaiBefore = invokeLog.filter((id) => id === "zai").length;
      const status2 = await main(argv, depsFor());
      assert.strictEqual(status2, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.strictEqual(
        invokeLog.filter((id) => id === "zai").length,
        zaiBefore,
        "run 2: zai must serve from cache — invoke must not run",
      );

      const store = JSON.parse(readFileSync(join(artifactsDir, "index.json"), "utf8"));
      assert.ok(store.entries.length >= 2, "both runs logged");
      const run2 = store.entries.at(-1);
      assert.deepStrictEqual(run2.provider, {
        mode: "single",
        requested: "tavily",
        effective: "zai",
      }, "the cache-served provider must be recorded as effective");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("cold-review f3: search records --no-cache in its args allow-list (sibling parity)", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-nocache-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--no-cache", "--save"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { store } = readStore(artifactsDir);
      assert.deepStrictEqual(store.entries[0].args, { "no-cache": true });
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("fan-out fixture: the log records {mode:'fanout', arms} with no single effective", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-fanout-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save"],
        baseDeps(adapter, log, {
          env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          configFanout: true,
          providerDescriptors: [makeSaveSearchDescriptor("zai", log), makeSaveSearchDescriptor("brave", log)],
        }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { store } = readStore(artifactsDir);
      const provider = store.entries[0].provider;
      assert.strictEqual(provider.mode, "fanout");
      assert.deepStrictEqual(provider.arms, ["zai", "brave"]);
      assert.ok(!("effective" in provider), "fan-out has no single effective provider");
      assert.ok(!("requested" in provider), "no pin: requested stays absent");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("markdown artifacts: comment header, then the stdout-markdown rendering", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-md-artifacts-");
    const exportDir = makeTempDir("scoutline-save-t4-md-export-");
    const exportTarget = join(exportDir, "report.md");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save", exportTarget, "--save-format", "markdown"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { masterName, requestId, store } = readStore(artifactsDir, "md");
      assert.ok(masterName.endsWith(".md"), `master must be .md: ${masterName}`);
      assert.strictEqual(store.entries[0].artifactFormat, "markdown");
      const exported = readFileSync(exportTarget, "utf8");
      const lines = exported.split("\n");
      assert.strictEqual(
        lines[0],
        `<!-- scoutline artifact requestId=${requestId} schemaVersion=1 -->`,
      );
      assert.ok(lines.slice(1).join("\n").trim().length > 0, "markdown body must not be empty");
      // Export copy is byte-identical to the master.
      assert.strictEqual(exported, readFileSync(join(artifactsDir, masterName), "utf8"));
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("--save-force overwrites a pre-existing export through the write-time recheck", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-force-artifacts-");
    const exportDir = makeTempDir("scoutline-save-t4-force-export-");
    const exportTarget = join(exportDir, "report.json");
    writeFileSync(exportTarget, "stale");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save", exportTarget, "--save-force"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const exported = JSON.parse(readFileSync(exportTarget, "utf8"));
      assert.deepStrictEqual(
        [...Object.keys(exported)].sort(),
        ["requestId", "result", "schemaVersion"],
      );
      const { store } = readStore(artifactsDir);
      assert.strictEqual(store.entries[0].exportPath, exportTarget);
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });

  it("non-capable commands still accept-and-drop --save: exit shape identical, store untouched", async () => {
    const artifactsDir = makeTempDir("scoutline-save-t4-noncap-artifacts-");
    const cacheDir = makeTempDir("scoutline-save-t4-noncap-cache-");
    const exportDir = makeTempDir("scoutline-save-t4-noncap-export-");
    try {
      const run = async (argv) => {
        const { adapter, stdout, stderr } = makeAdapter();
        const status = await main(
          argv,
          baseDeps(adapter, [], {
            env: { SCOUTLINE_CACHE_DIR: cacheDir, SCOUTLINE_ARTIFACTS_DIR: artifactsDir },
          }),
        );
        return { status, stdout, stderr };
      };
      const plain = await run(["cache", "stats"]);
      const saved = await run(["cache", "stats", "--save", join(exportDir, "r.json")]);
      assert.strictEqual(plain.status, 0, `plain stderr=${JSON.stringify(plain.stderr)}`);
      assert.strictEqual(saved.status, plain.status);
      assert.deepStrictEqual(saved.stdout, plain.stdout);
      assert.deepStrictEqual(
        readdirSync(artifactsDir),
        [],
        "a non-capable command must never write the artifacts store",
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
