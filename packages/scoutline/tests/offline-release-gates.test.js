import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runnerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "scoutline-release-gates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "tests"));
  for (const script of ["run-tests.mjs", "store-census.mjs"]) {
    copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(root, "scripts", script));
  }
  return {
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
    import { basename, join } from "node:path";
    import test from "node:test";
    import { SourceTextModule } from "node:vm";
    test("offline MJS witness", () => {
      assert.equal(process.env.SCOUTLINE_LIVE_TESTS, "");
      assert.equal(process.env.ZAI_LIVE_TESTS, "");
      assert.match(basename(process.env.SCOUTLINE_CONFIG_DIR), /^scoutline-test-/);
      assert.equal(process.env.SCOUTLINE_ARTIFACTS_DIR, join(process.env.SCOUTLINE_CONFIG_DIR, "artifacts"));
      assert.equal(typeof SourceTextModule, "function");
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
});
