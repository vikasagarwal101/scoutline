import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runnerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "scoutline-release-gates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "tests"));
  const callerArtifacts = join(root, "caller-artifacts");
  mkdirSync(callerArtifacts);
  writeFileSync(join(callerArtifacts, "original.json"), "{}");
  for (const script of ["run-tests.mjs", "store-census.mjs"]) {
    copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(root, "scripts", script));
  }
  return {
    assertStoresClean() {
      assert.deepEqual(readdirSync(callerArtifacts), ["original.json"]);
      assert.equal(readdirSync(root).some((name) => name.startsWith("scoutline-test-")), false);
    },
    writeTest(name, contents) {
      writeFileSync(join(root, "tests", name), contents);
    },
    run(...args) {
      return spawnSync(process.execPath, args, {
        cwd: root,
        env: {
          TMPDIR: root,
          TEMP: root,
          TMP: root,
          HOME: root,
          SCOUTLINE_CONFIG_DIR: join(root, "ambient-config"),
          SCOUTLINE_ARTIFACTS_DIR: callerArtifacts,
          SCOUTLINE_LIVE_TESTS: "1",
          ZAI_LIVE_TESTS: "1",
        },
        encoding: "utf8",
        timeout: 15_000,
      });
    },
  };
}

test("offline gate runs JS and MJS with isolated configuration and live opt-ins cleared", (t) => {
  const fixture = runnerFixture(t);

  fixture.writeTest("offline-js.test.js", `
    import test from "node:test";
    test("offline JS witness", () => {});
  `);
  fixture.writeTest("offline-mjs.test.mjs", `
    import assert from "node:assert/strict";
    import { mkdirSync, writeFileSync } from "node:fs";
    import { basename, join } from "node:path";
    import test from "node:test";
    import { SourceTextModule } from "node:vm";
    test("offline MJS witness", () => {
      assert.equal(process.env.SCOUTLINE_LIVE_TESTS, "");
      assert.equal(process.env.ZAI_LIVE_TESTS, "");
      assert.match(basename(process.env.SCOUTLINE_CONFIG_DIR), /^scoutline-test-/);
      assert.equal(process.env.SCOUTLINE_ARTIFACTS_DIR, join(process.env.SCOUTLINE_CONFIG_DIR, "artifacts"));
      assert.equal(typeof SourceTextModule, "function");
      mkdirSync(process.env.SCOUTLINE_ARTIFACTS_DIR, { recursive: true });
      writeFileSync(join(process.env.SCOUTLINE_ARTIFACTS_DIR, "offline.json"), "{}");
    });
  `);

  for (const excluded of ["cli-smoke.test.js", "mcp-live.test.js", "provider-live.test.js"]) {
    fixture.writeTest(excluded, 'throw new Error("offline mode ran an excluded test");');
  }

  const result = fixture.run("scripts/run-tests.mjs", "offline");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /offline JS witness/);
  assert.match(result.stdout, /offline MJS witness/);
  fixture.assertStoresClean();
});

test("offline gate cleans its temporary store after a failing test", (t) => {
  const fixture = runnerFixture(t);
  fixture.writeTest("failing.test.mjs", `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const dir = process.env.SCOUTLINE_ARTIFACTS_DIR;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "failed-test.json"), "{}");
    throw new Error("synthetic test failure");
  `);

  const result = fixture.run("scripts/run-tests.mjs", "offline");
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /synthetic test failure/);
  fixture.assertStoresClean();
});

test("a cleanup failure warns and preserves a successful offline test result", (t) => {
  const fixture = runnerFixture(t);
  fixture.writeTest("passing.test.mjs", `
    import test from "node:test";
    test("offline result survives cleanup failure", () => {});
  `);
  fixture.writeTest("deny-cleanup.mjs", `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename } from "node:path";

    const remove = fs.rmSync;
    fs.rmSync = (target, options) => {
      if (basename(target).startsWith("scoutline-test-")) {
        throw Object.assign(new Error("synthetic cleanup denial"), { code: "EACCES" });
      }
      return remove(target, options);
    };
    syncBuiltinESMExports();
  `);

  const result = fixture.run("--import", "./tests/deny-cleanup.mjs", "scripts/run-tests.mjs", "offline");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /offline result survives cleanup failure/);
  assert.match(result.stderr, /\[run-tests\] temporary config cleanup failed: synthetic cleanup denial/);
});

test("store census fails on a store written by the selected MJS test", {
  skip: process.platform === "win32",
}, (t) => {
  const fixture = runnerFixture(t);
  fixture.writeTest("store-witness.test.mjs", `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { homedir } from "node:os";
    import { join } from "node:path";
    import test from "node:test";
    test("MJS store write witness", () => {
      const dir = join(homedir(), ".scoutline");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "mjs-witness.json"), "{}");
    });
  `);

  const result = fixture.run("scripts/store-census.mjs");
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /MJS store write witness/);
  assert.match(result.stderr, /\[store-census\] FAIL/);
  assert.match(result.stderr, /\.scoutline\/mjs-witness\.json/);
  fixture.assertStoresClean();
});
