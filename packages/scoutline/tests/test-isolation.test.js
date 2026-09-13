import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ScoutlineError,
  ConfigurationError,
} from "../dist/lib/errors.js";

/**
 * Comparator unit pins for the write-chokepoint test-isolation guard
 * (`assertTestSafeWrite`, lane-K T4 rework §1 — replaces the dropped
 * resolution-time T4 e4c99a2).
 *
 * Doctrine: RESOLVING a real-homedir path is legal (#119/#137 stay
 * resolution-time); MUTATING one while `NODE_TEST_CONTEXT` is ambient is
 * not. The guard fires only at write seams.
 *
 * `NODE_TEST_CONTEXT` is set by `node --test` in every spawned test child
 * (value varies by Node version — pins check "is set", never a literal).
 * Env manipulation uses save/restore try/finally throughout.
 */

/** Run `operation` under a controlled env overlay, restoring after. */
async function withEnv(overrides, operation) {
  const saved = { ...process.env };
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await operation();
  } finally {
    process.env = saved;
  }
}

const testContextOverrides = {
  NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1",
  SCOUTLINE_CONFIG_DIR: undefined,
  SCOUTLINE_ARTIFACTS_DIR: undefined,
  SCOUTLINE_CACHE_DIR: undefined,
  SCOUTLINE_WATCH_DIR: undefined,
  SCOUTLINE_NO_TEST_GUARD: undefined,
};

async function loadGuard() {
  return import("../dist/lib/test-isolation.js");
}

describe("assertTestSafeWrite comparator pins (T4 rework §1)", () => {
  it("symlinked HOME layout: SCOUTLINE_CACHE_DIR=B (symlink → A) allows writes under A", async (t) => {
    const { assertTestSafeWrite } = await loadGuard();
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-iso-real-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-iso-link-"));
    t.after(() => {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });
    const link = path.join(dirB, "link-to-a");
    fs.symlinkSync(dirA, link);
    await withEnv(
      { ...testContextOverrides, SCOUTLINE_CACHE_DIR: link },
      () => {
        // target under the REAL path of the symlinked root must pass
        const realA = fs.realpathSync(dirA);
        assert.doesNotThrow(() =>
          assertTestSafeWrite(path.join(realA, "cache", "entry.json"), "cache"),
        );
        // and a target through the link itself must also pass
        assert.doesNotThrow(() =>
          assertTestSafeWrite(path.join(link, "cache", "entry.json"), "cache"),
        );
      },
    );
  });

  it("nested isolated-in-homedir: SCOUTLINE_CONFIG_DIR under the real homedir allows its subtree", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    const nested = path.join(os.homedir(), "scoutline-t4a-iso-pin");
    fs.mkdirSync(nested, { recursive: true });
    try {
      await withEnv({ ...testContextOverrides, SCOUTLINE_CONFIG_DIR: nested }, () => {
        assert.doesNotThrow(() =>
          assertTestSafeWrite(path.join(nested, "config.json"), "config"),
        );
      });
    } finally {
      fs.rmSync(nested, { recursive: true, force: true });
    }
  });

  it("legacy aliases: ZAI_CACHE_DIR-armed root allows its subtree", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-iso-zaicache-"));
    try {
      await withEnv(
        { ...testContextOverrides, ZAI_CACHE_DIR: root },
        () => {
          assert.doesNotThrow(() =>
            assertTestSafeWrite(path.join(root, "cache", "x.json"), "cache"),
          );
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("trailing slash on the env-var root still allows the subtree", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-iso-slash-"));
    try {
      await withEnv(
        { ...testContextOverrides, SCOUTLINE_CACHE_DIR: root + path.sep },
        () => {
          assert.doesNotThrow(() =>
            assertTestSafeWrite(path.join(root, "responses", "x.json"), "cache"),
          );
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("relative target resolves against cwd (path.resolve semantics) and is judged there", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-iso-rel-"));
    try {
      await withEnv(
        { ...testContextOverrides, SCOUTLINE_CACHE_DIR: root },
        () => {
          // cwd is the package dir; a relative target resolves against it
          // and lands outside every isolation root → must throw. This PINS
          // the semantics: relative paths are cwd-resolved, never naively
          // prefix-compared.
          assert.throws(() => assertTestSafeWrite("relative/write.json", "cache"));
          // absolute target inside the root passes
          assert.doesNotThrow(() =>
            assertTestSafeWrite(path.join(root, "y.json"), "cache"),
          );
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("SCOUTLINE_NO_TEST_GUARD=1 bypasses; =0 does NOT (strict-equality pin)", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    const outside = path.join(os.tmpdir(), "..", "definitely-not-real-root");
    await withEnv({ ...testContextOverrides, SCOUTLINE_NO_TEST_GUARD: "1" }, () => {
      assert.doesNotThrow(() => assertTestSafeWrite(outside, "cache"));
    });
    await withEnv({ ...testContextOverrides, SCOUTLINE_NO_TEST_GUARD: "0" }, () => {
      assert.throws(() => assertTestSafeWrite(outside, "cache"));
    });
    // empty string and other junk also do NOT bypass (strict === "1")
    await withEnv({ ...testContextOverrides, SCOUTLINE_NO_TEST_GUARD: "" }, () => {
      assert.throws(() => assertTestSafeWrite(outside, "cache"));
    });
  });

  it("hatch unset + no isolation roots → throws", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    await withEnv({ ...testContextOverrides }, () => {
      assert.throws(
        () => assertTestSafeWrite("/home/someuser/.scoutline/config.json", "config"),
        (error) => {
          assert.ok(error instanceof ScoutlineError);
          return true;
        },
      );
    });
  });

  it("tmpdir allowance: write under os.tmpdir() passes WITHOUT any env vars", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    await withEnv({ ...testContextOverrides }, () => {
      assert.doesNotThrow(() =>
        assertTestSafeWrite(path.join(os.tmpdir(), "plain-write.json"), "cache"),
      );
    });
  });

  it("no NODE_TEST_CONTEXT → no throw even for a real-homedir path (production mode)", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    await withEnv({ ...testContextOverrides, NODE_TEST_CONTEXT: undefined }, () => {
      assert.doesNotThrow(() =>
        assertTestSafeWrite(
          path.join(os.homedir(), ".scoutline", "config.json"),
          "config",
        ),
      );
    });
  });

  it("throws carry: seam + resolved path + SCOUTLINE_NO_TEST_GUARD in the message", async () => {
    const { assertTestSafeWrite } = await loadGuard();
    await withEnv({ ...testContextOverrides }, () => {
      assert.throws(
        () => assertTestSafeWrite("/home/someuser/.scoutline/state.json", "quota-state"),
        (error) => {
          assert.match(error.message, /quota-state/);
          assert.match(error.message, /state\.json/);
          assert.match(error.message, /SCOUTLINE_NO_TEST_GUARD/);
          assert.match(error.message, /SCOUTLINE_CONFIG_DIR/);
          return true;
        },
      );
    });
  });

  it("isTestIsolationViolation narrows the thrown error; false for generic/ConfigurationError", async () => {
    const { assertTestSafeWrite, isTestIsolationViolation } = await loadGuard();
    const { TestIsolationViolationError } = await import("../dist/lib/test-isolation.js");
    await withEnv({ ...testContextOverrides }, () => {
      let caught;
      try {
        assertTestSafeWrite("/home/someuser/.scoutline/x", "seam-x");
      } catch (e) {
        caught = e;
      }
      assert.ok(caught);
      assert.ok(isTestIsolationViolation(caught));
      assert.ok(caught instanceof TestIsolationViolationError);
      assert.ok(caught instanceof ScoutlineError);
      assert.strictEqual(caught.code, "TEST_ISOLATION_VIOLATION");
      assert.strictEqual(isTestIsolationViolation(new Error("plain")), false);
      assert.strictEqual(isTestIsolationViolation(new ConfigurationError("c")), false);
      assert.strictEqual(isTestIsolationViolation(undefined), false);
    });
  });
});
