/**
 * save-artifacts T3 — hermetic `main()` pins for the global `--save`
 * flag surface (`--save [<path>]`, `--save-format <json|markdown>`,
 * `--save-force`) and their pre-dispatch guards.
 *
 * Follows the `main-config-hermetic.test.js` conventions (#73): every
 * `main()` drive injects `loadScoutlineConfig` (via `hermeticMainDeps`)
 * plus a fake invocation adapter and a counting search descriptor, so no
 * pin can reach the ambient `~/.scoutline` config, the real cache
 * directory, or the network. The pre-dispatch guards are read-only
 * filesystem checks against temp-dir export paths created by the test
 * itself; the actual artifact writing is T4's job and must stay inert
 * here (pinned by byte-identical target files).
 *
 * Pins (ticket T3):
 *   1. Pre-dispatch FILE_ERROR: existing export target + no --save-force
 *      -> exit 1, EMPTY stdout, envelope on stderr, behavior never runs.
 *   2. Missing / unwritable export parent -> FILE_ERROR, same shape.
 *   3. `--save` value guards (the `--provider` precedent): a dash-prefixed
 *      or empty follower -> VALIDATION_ERROR, never bound as the path.
 *   4. `--save-format` outside {json, markdown} (and valueless) ->
 *      VALIDATION_ERROR naming both valid values.
 *   5. Trailing valueless `--save` = master-only save -> no export guard,
 *      behavior runs normally.
 *   6. `--save-force` bypasses the exists guard; nothing is written.
 *   7. Non-capable commands accept and silently drop all three flags —
 *      exit shape identical to the same command without them.
 *   8. Command-help invocations skip the export guard (help wins).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../dist/index.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

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

/** Search descriptor double whose invoke() records every call in `log`. */
function makeCountingSearchDescriptor(id, log) {
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
        async invoke() {
          log.push(id);
          return [{ title: id, url: `https://${id}/r`, summary: "s" }];
        },
      },
    }),
  };
}

/** Hermetic deps: injected config loader, counting search descriptor. */
function baseDeps(adapter, log, extra = {}) {
  return hermeticMainDeps({
    invocation: adapter,
    env: {},
    providerDescriptors: [makeCountingSearchDescriptor("zai", log)],
    ...extra,
  });
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Assert the FILE_ERROR pre-dispatch envelope shape on stderr. */
function assertFileErrorEnvelope(stderr) {
  assert.ok(stderr.length > 0, "an error envelope must reach stderr");
  const envelope = JSON.parse(stderr.at(-1));
  assert.strictEqual(envelope.success, false);
  assert.strictEqual(envelope.code, "FILE_ERROR");
  return envelope;
}

/** Assert the VALIDATION_ERROR extraction envelope shape on stderr. */
function assertValidationErrorEnvelope(stderr) {
  assert.ok(stderr.length > 0, "an error envelope must reach stderr");
  const envelope = JSON.parse(stderr.at(-1));
  assert.strictEqual(envelope.success, false);
  assert.strictEqual(envelope.code, "VALIDATION_ERROR");
  return envelope;
}

describe("save-artifacts T3: --save/--save-format/--save-force global flags", () => {
  it("refuses an existing export target with FILE_ERROR before behavior runs", async () => {
    const dir = makeTempDir("scoutline-save-t3-exists-");
    const target = join(dir, "report.json");
    writeFileSync(target, "keep");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(["search", "q", "--save", target], baseDeps(adapter, log));
      assert.strictEqual(status, 1);
      assert.deepStrictEqual(stdout, [], "stdout must stay empty on the refused save");
      const envelope = assertFileErrorEnvelope(stderr);
      assert.match(envelope.error, /artifact exists/);
      assert.match(envelope.help, /--save-force/);
      assert.deepStrictEqual(log, [], "behavior must never run behind the guard");
      assert.strictEqual(readFileSync(target, "utf8"), "keep", "guard is read-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing export parent with FILE_ERROR before behavior runs", async () => {
    const dir = makeTempDir("scoutline-save-t3-missing-parent-");
    const target = join(dir, "no-such-dir", "report.json");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(["search", "q", "--save", target], baseDeps(adapter, log));
      assert.strictEqual(status, 1);
      assert.deepStrictEqual(stdout, [], "stdout must stay empty on the refused save");
      const envelope = assertFileErrorEnvelope(stderr);
      assert.match(envelope.error, /does not exist/);
      assert.deepStrictEqual(log, [], "behavior must never run behind the guard");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unwritable export parent with FILE_ERROR before behavior runs", async () => {
    const dir = makeTempDir("scoutline-save-t3-readonly-parent-");
    const target = join(dir, "report.json");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    chmodSync(dir, 0o500);
    try {
      const status = await main(["search", "q", "--save", target], baseDeps(adapter, log));
      assert.strictEqual(status, 1);
      assert.deepStrictEqual(stdout, [], "stdout must stay empty on the refused save");
      const envelope = assertFileErrorEnvelope(stderr);
      assert.match(envelope.error, /not writable/);
      assert.deepStrictEqual(log, [], "behavior must never run behind the guard");
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review fixup (greptile P1): the old pins here encoded a defect this PR's
  // own README documents away — `--save --save-format markdown` is the
  // documented MASTER-ONLY markdown form, so a follower that cannot serve as
  // a path (option token, empty string) must leave `--save` valueless under
  // parseArgs' binding rule, never exit VALIDATION_ERROR. The token stays in
  // the rest stream for its own flag.
  it("treats an option-token --save follower as master-only: the run happens and the follower keeps its own meaning", async () => {
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    const dir = makeTempDir("scoutline-save-follower-opt-");
    try {
      const status = await main(
        ["search", "q", "--save", "--limit", "5"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: dir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.deepStrictEqual(log, ["zai"], "the search behavior must run");
      assert.strictEqual(stdout.length, 1, "data stdout is preserved");
      const masters = readdirSync(dir).filter((f) => f !== "index.json");
      assert.deepStrictEqual(masters.length, 1, "a master-only save wrote exactly one master");
      assert.match(stderr.join(""), /saved artifact/, "the save notice must reach stderr");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the documented master-only markdown form: --save --save-format markdown", async () => {
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    const dir = makeTempDir("scoutline-save-doc-md-");
    try {
      const status = await main(
        ["search", "q", "--save", "--save-format", "markdown"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: dir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.deepStrictEqual(log, ["zai"], "the search behavior must run");
      const masters = readdirSync(dir);
      assert.deepStrictEqual(
        masters.filter((f) => f.endsWith(".md")).length,
        1,
        `exactly one markdown master expected, got ${JSON.stringify(masters)}`,
      );
      assert.deepStrictEqual(
        masters.filter((f) => f.endsWith(".json") && f !== "index.json").length,
        0,
        "no json master",
      );
      const notice = stderr.join("");
      assert.match(notice, /saved artifact/, "the save notice must reach stderr");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an empty --save follower as valueless (master-only), the parseArgs empty-string rule", async () => {
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    const dir = makeTempDir("scoutline-save-follower-empty-");
    try {
      const status = await main(
        ["search", "q", "--save", ""],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: dir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.deepStrictEqual(log, ["zai"], "the search behavior must run");
      const files = readdirSync(dir).filter((f) => f !== "index.json");
      assert.deepStrictEqual(files.length, 1, "exactly one master, no export");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review fixup (coderabbit minor, lstat): a dangling symlink at the
  // export target is an EXISTING entry — stat's ENOENT through the link
  // would let the guard pass and the write silently replace the link.
  it("refuses a dangling symlink at the export target without --save-force (lstat guard)", async () => {
    const dir = makeTempDir("scoutline-save-t3-dangling-");
    const target = join(dir, "report.json");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      symlinkSync(join(dir, "vanished-target.json"), target);
      const status = await main(["search", "q", "--save", target], baseDeps(adapter, log));
      assert.strictEqual(status, 1);
      assert.deepStrictEqual(stdout, [], "stdout must stay empty on the refused save");
      const envelope = assertFileErrorEnvelope(stderr);
      assert.match(envelope.error, /artifact exists/);
      assert.deepStrictEqual(log, [], "behavior must never run behind the guard");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a --save-format value outside {json, markdown}, naming both valid values", async () => {
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(
      ["search", "q", "--save-format", "yaml"],
      baseDeps(adapter, log),
    );
    assert.strictEqual(status, 1);
    assert.deepStrictEqual(stdout, []);
    const envelope = assertValidationErrorEnvelope(stderr);
    assert.match(envelope.error, /Invalid save format: yaml/);
    assert.ok(
      typeof envelope.help === "string" && envelope.help.includes("json") && envelope.help.includes("markdown"),
      `help must name both valid values, got: ${envelope.help}`,
    );
    assert.deepStrictEqual(log, [], "behavior must never run behind the guard");
  });

  it("rejects a valueless --save-format with VALIDATION_ERROR", async () => {
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    const status = await main(["search", "q", "--save-format"], baseDeps(adapter, log));
    assert.strictEqual(status, 1);
    assert.deepStrictEqual(stdout, []);
    const envelope = assertValidationErrorEnvelope(stderr);
    assert.match(envelope.error, /--save-format requires a value/);
    assert.deepStrictEqual(log, [], "behavior must never run behind the guard");
  });

  it("drops --save on a non-capable command even with an option-token follower (accept-and-drop)", async () => {
    const cacheDir = makeTempDir("scoutline-save-t3-cache-");
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["cache", "stats", "--save", "--older-than", "60s"],
        baseDeps(adapter, [], { env: { SCOUTLINE_CACHE_DIR: cacheDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.deepStrictEqual(stderr, [], "flags silently dropped");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("treats a trailing valueless --save as a master-only save: no export guard, behavior runs", async () => {
    // save-artifacts T4 update: T3's original pin asserted the run wrote
    // nothing, but that encoded T3's inert scope, not an eternal contract.
    // T4 owns the write; this row now pins the master-only write shape
    // (store master + log entry, no export copy, stdout preserved).
    const dir = makeTempDir("scoutline-save-t3-mastersonly-");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: dir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.deepStrictEqual(log, ["zai"], "the search behavior must run");
      assert.strictEqual(stdout.length, 1, "data stdout is preserved");
      const data = JSON.parse(stdout[0]);
      assert.ok(Array.isArray(data) && data.length === 1, `unexpected stdout: ${stdout[0]}`);
      const files = readdirSync(dir).sort();
      assert.strictEqual(files.length, 2, `expected master + index.json, got ${files.join(",")}`);
      const masterName = files.find((f) => f !== "index.json");
      const report = JSON.parse(readFileSync(join(dir, masterName), "utf8"));
      assert.deepStrictEqual([...Object.keys(report)].sort(), ["requestId", "result", "schemaVersion"]);
      assert.strictEqual(report.result.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets --save-force bypass the exists guard; T4 overwrites the export with the clean report", async () => {
    // save-artifacts T4 update: T3's original pin asserted the run stayed
    // write-inert, but that encoded T3's scope. T4's write-time recheck
    // honors --save-force: the stale export is atomically replaced with
    // the clean report and the store gains the master + log entry.
    const dir = makeTempDir("scoutline-save-t3-force-");
    const artifactsDir = makeTempDir("scoutline-save-t3-force-artifacts-");
    const target = join(dir, "report.json");
    writeFileSync(target, "keep");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "q", "--save", target, "--save-force"],
        baseDeps(adapter, log, { env: { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } }),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.deepStrictEqual(log, ["zai"], "the search behavior must run");
      assert.strictEqual(stdout.length, 1, "data stdout is preserved");
      const exported = JSON.parse(readFileSync(target, "utf8"));
      assert.deepStrictEqual([...Object.keys(exported)].sort(), ["requestId", "result", "schemaVersion"]);
      const files = readdirSync(artifactsDir).sort();
      const masters = files.filter((f) => f !== "index.json");
      assert.strictEqual(masters.length, 1);
      assert.deepStrictEqual(
        JSON.parse(readFileSync(join(artifactsDir, masters[0]), "utf8")),
        exported,
        "master and export must be byte-identical in content",
      );
      const store = JSON.parse(readFileSync(join(artifactsDir, "index.json"), "utf8"));
      assert.strictEqual(store.entries.length, 1);
      assert.strictEqual(store.entries[0].exportPath, target);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });

  it("accepts and drops the flags on a non-capable command: exit shape identical without them", async () => {
    const cacheDir = makeTempDir("scoutline-save-t3-cache-identity-");
    const dir = makeTempDir("scoutline-save-t3-identity-target-");
    const target = join(dir, "report.json");
    writeFileSync(target, "keep");
    try {
      const run = async (argv) => {
        const { adapter, stdout, stderr } = makeAdapter();
        const status = await main(
          argv,
          baseDeps(adapter, [], { env: { SCOUTLINE_CACHE_DIR: cacheDir } }),
        );
        return { status, stdout, stderr };
      };
      const plain = await run(["cache", "stats"]);
      const withFlags = await run(["cache", "stats", "--save", target, "--save-format", "markdown"]);
      assert.strictEqual(plain.status, 0, `plain stderr=${JSON.stringify(plain.stderr)}`);
      assert.strictEqual(
        withFlags.status,
        plain.status,
        `exit code must be identical; flags-run stderr=${JSON.stringify(withFlags.stderr)}`,
      );
      assert.deepStrictEqual(
        withFlags.stdout,
        plain.stdout,
        "stdout must be byte-identical: the flags were accepted and dropped",
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fire the export guard on a command-help invocation (help wins)", async () => {
    const dir = makeTempDir("scoutline-save-t3-help-");
    const target = join(dir, "report.json");
    writeFileSync(target, "keep");
    const log = [];
    const { adapter, stdout, stderr } = makeAdapter();
    try {
      const status = await main(
        ["search", "--help", "--save", target],
        baseDeps(adapter, log),
      );
      assert.strictEqual(status, 0, `stderr=${JSON.stringify(stderr)}`);
      assert.ok(stdout.length > 0, "help text must reach stdout");
      assert.deepStrictEqual(log, [], "help renders no behavior");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
