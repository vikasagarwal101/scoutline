/**
 * Pins for the runProcess env-isolation contract (issue #154).
 *
 * A spawned CLI child cannot inherit the test process's perimeter guards
 * (hermeticMainDeps injects deps.env, but the child re-reads the ambient
 * environment). buildIsolatedEnv is the child's ONLY protection: every
 * run gets fresh per-call SCOUTLINE_CONFIG_DIR, SCOUTLINE_CACHE_DIR, and
 * SCOUTLINE_ARTIFACTS_DIR temp dirs, and caller-supplied values
 * (options.env or inherited process.env) always win.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildIsolatedEnv, runProcess } from "./helpers/run-process.js";

describe("runProcess buildIsolatedEnv", () => {
  it("injects all three isolation dirs as distinct temp paths", async () => {
    const env = await buildIsolatedEnv({});
    assert.ok(env.SCOUTLINE_CONFIG_DIR.startsWith(os.tmpdir()));
    assert.ok(env.SCOUTLINE_CACHE_DIR.startsWith(os.tmpdir()));
    assert.ok(env.SCOUTLINE_ARTIFACTS_DIR.startsWith(os.tmpdir()));
    assert.notEqual(env.SCOUTLINE_CONFIG_DIR, env.SCOUTLINE_CACHE_DIR);
    assert.notEqual(env.SCOUTLINE_CONFIG_DIR, env.SCOUTLINE_ARTIFACTS_DIR);
    assert.notEqual(env.SCOUTLINE_CACHE_DIR, env.SCOUTLINE_ARTIFACTS_DIR);
  });

  it("creates fresh dirs per call", async () => {
    const a = await buildIsolatedEnv({});
    const b = await buildIsolatedEnv({});
    assert.notEqual(a.SCOUTLINE_CACHE_DIR, b.SCOUTLINE_CACHE_DIR);
    assert.notEqual(a.SCOUTLINE_ARTIFACTS_DIR, b.SCOUTLINE_ARTIFACTS_DIR);
    assert.notEqual(a.SCOUTLINE_CONFIG_DIR, b.SCOUTLINE_CONFIG_DIR);
  });

  it("caller-supplied env values win", async () => {
    const env = await buildIsolatedEnv({
      env: {
        SCOUTLINE_CACHE_DIR: "/custom/cache",
        SCOUTLINE_ARTIFACTS_DIR: "/custom/artifacts",
      },
    });
    assert.equal(env.SCOUTLINE_CACHE_DIR, "/custom/cache");
    assert.equal(env.SCOUTLINE_ARTIFACTS_DIR, "/custom/artifacts");
  });

  it("ambient store roots are STRIPPED and replaced by temp defaults (PR #160 review)", async () => {
    // Ambient SCOUTLINE_CACHE_DIR / SCOUTLINE_ARTIFACTS_DIR must NOT flow
    // into spawned children — an inherited value could direct the child's
    // writes at a persistent host store. The strip happens before the
    // options.env merge; explicit options.env values still win.
    const prevCache = process.env.SCOUTLINE_CACHE_DIR;
    const prevArtifacts = process.env.SCOUTLINE_ARTIFACTS_DIR;
    process.env.SCOUTLINE_CACHE_DIR = "/ambient/cache";
    process.env.SCOUTLINE_ARTIFACTS_DIR = "/ambient/artifacts";
    try {
      const env = await buildIsolatedEnv({});
      assert.notEqual(env.SCOUTLINE_CACHE_DIR, "/ambient/cache");
      assert.notEqual(env.SCOUTLINE_ARTIFACTS_DIR, "/ambient/artifacts");
      assert.ok(env.SCOUTLINE_CACHE_DIR.startsWith(os.tmpdir()), "replaced by per-call temp default");
      assert.ok(env.SCOUTLINE_ARTIFACTS_DIR.startsWith(os.tmpdir()), "replaced by per-call temp default");

      const explicit = await buildIsolatedEnv({
        env: { SCOUTLINE_CACHE_DIR: "/explicit/cache" },
      });
      assert.equal(explicit.SCOUTLINE_CACHE_DIR, "/explicit/cache", "explicit options.env still wins");
      assert.notEqual(explicit.SCOUTLINE_ARTIFACTS_DIR, "/ambient/artifacts");
    } finally {
      if (prevCache === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
      else process.env.SCOUTLINE_CACHE_DIR = prevCache;
      if (prevArtifacts === undefined) delete process.env.SCOUTLINE_ARTIFACTS_DIR;
      else process.env.SCOUTLINE_ARTIFACTS_DIR = prevArtifacts;
    }
  });

  it("configDir:false skips only the config-dir injection", async () => {
    // configDir:false disables the T3b config isolation only; the #154
    // cache/artifacts guards still apply. Ambient SCOUTLINE_CONFIG_DIR
    // (runner pins one) still flows through baseEnv — that is the
    // caller-values-win contract pinned above.
    const env = await buildIsolatedEnv({ configDir: false });
    assert.ok(env.SCOUTLINE_CACHE_DIR.startsWith(os.tmpdir()));
    assert.ok(env.SCOUTLINE_ARTIFACTS_DIR.startsWith(os.tmpdir()));
  });
});

describe("runProcess per-call temp cleanup (#167)", () => {
  it("removes the config/cache/artifacts dirs it created once the child closes", async () => {
    const { code, createdTempDirs } = await runProcess(["--help"]);
    assert.equal(code, 0);
    assert.equal(createdTempDirs.length, 3);
    for (const dir of createdTempDirs) {
      assert.equal(fs.existsSync(dir), false, `leaked: ${dir}`);
    }
  });

  it("caller-supplied configDir survives the call", async () => {
    const keep = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-pin-keep-"));
    try {
      const { code, createdTempDirs } = await runProcess(["--help"], { configDir: keep });
      assert.equal(code, 0);
      assert.equal(fs.existsSync(keep), true, "caller configDir must not be removed");
      // Only cache + artifacts were mkdtemp'd this call; the config dir
      // was caller-supplied, so it must not be in the tracked set.
      assert.equal(createdTempDirs.length, 2);
      for (const dir of createdTempDirs) {
        assert.equal(fs.existsSync(dir), false, `leaked: ${dir}`);
      }
    } finally {
      fs.rmSync(keep, { recursive: true, force: true });
    }
  });
});

describe("runProcess error/partial-failure cleanup (#167 review)", () => {
  // Both pins keep every created temp dir inside a PRIVATE pen (TMPDIR
  // retarget, honored by os.tmpdir() at call time) so the leak assertion
  // is immune to sibling test files' concurrent subprocess temp dirs in
  // the shared os.tmpdir().
  it("buildIsolatedEnv partial failure cleans the dirs created so far", async () => {
    const pen = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-pin-pen-"));
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = pen;
    try {
      // JSON.stringify throws on BigInt: the config write fails AFTER the
      // config dir was created — the partial-failure leak shape.
      await assert.rejects(
        buildIsolatedEnv({ config: { v: 1n } }),
        /Do not know how to serialize/,
      );
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
    }
    const left = fs.readdirSync(pen);
    fs.rmSync(pen, { recursive: true, force: true });
    assert.deepEqual(left, [], `partial failure leaked created-so-far dirs: ${left}`);
  });

  it("spawn-error path cleans the per-call temp dirs before rejecting", async () => {
    const pen = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-pin-pen-"));
    const prevTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = pen;
    try {
      // Missing cwd: spawn emits 'error' (ENOENT) then 'close'. The
      // cleanup must run BEFORE the reject, not only on the close path.
      await assert.rejects(
        runProcess(["--help"], { cwd: "/nonexistent-scoutline-pin-cwd" }),
      );
    } finally {
      if (prevTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdir;
    }
    const left = fs.readdirSync(pen);
    fs.rmSync(pen, { recursive: true, force: true });
    assert.deepEqual(left, [], `spawn-error path leaked per-call dirs: ${left}`);
  });
});
