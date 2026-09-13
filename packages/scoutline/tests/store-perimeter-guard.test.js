import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isTestIsolationViolation, TestIsolationViolationError } from "../dist/lib/test-isolation.js";
import { atomicReplaceFile } from "../dist/lib/config-store.js";
import { withAsyncFileLock } from "../dist/lib/async-file-lock.js";
import { createProductionAsyncJobStateFile } from "../dist/lib/async-job-state.js";
import { writeCache } from "../dist/lib/cache.js";
import { writeToolCache } from "../dist/lib/tool-cache.js";
import { createDefaultQuotaStore } from "../dist/lib/quota-store.js";
import { createUsageLedgerSink } from "../dist/lib/usage-ledger.js";
import { appendSnapshot, appendChangeLog } from "../dist/lib/watch-store.js";

/**
 * Write-chokepoint test-isolation guard teeth pins (lane-K T4 rework, §5).
 *
 * Doctrine (spec §0):
 * - Resolving real path is LEGAL (import-time string math, defaults).
 * - Mutating disk while NODE_TEST_CONTEXT is ambient = THROW.
 * - Best-effort catches must NOT swallow TestIsolationViolationError.
 */

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

const baseTestEnv = {
  NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1",
  SCOUTLINE_CONFIG_DIR: undefined,
  SCOUTLINE_ARTIFACTS_DIR: undefined,
  SCOUTLINE_CACHE_DIR: undefined,
  SCOUTLINE_WATCH_DIR: undefined,
  ZAI_MCP_CACHE_DIR: undefined,
  ZAI_CACHE_DIR: undefined,
  SCOUTLINE_NO_TEST_GUARD: undefined,
};

const fakeRealHomedir = path.join(os.homedir(), ".scoutline");

describe("write-chokepoint test-isolation guards (T4 rework §5)", () => {
  describe("chokepoint: atomicReplaceFile", () => {
    it("throws TestIsolationViolationError on un-isolated write under NODE_TEST_CONTEXT", async () => {
      const target = path.join(fakeRealHomedir, "config.json");
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () => atomicReplaceFile(target, "{}"),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            assert.match(error.message, /atomicReplaceFile/);
            assert.match(error.message, /config\.json/);
            return true;
          },
        );
      });
    });

    it("allows write under set SCOUTLINE_CONFIG_DIR", async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-test-cfg-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const target = path.join(dir, "config.json");
      await withEnv({ ...baseTestEnv, SCOUTLINE_CONFIG_DIR: dir }, async () => {
        await assert.doesNotReject(async () => atomicReplaceFile(target, "{}"));
      });
      assert.strictEqual(fs.readFileSync(target, "utf8"), "{}");
    });

    it("allows write under os.tmpdir()", async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-tmp-sub-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const target = path.join(dir, "write.json");
      await withEnv(baseTestEnv, async () => {
        await assert.doesNotReject(async () => atomicReplaceFile(target, "tmp-ok"));
      });
      assert.strictEqual(fs.readFileSync(target, "utf8"), "tmp-ok");
    });

    it("SCOUTLINE_NO_TEST_GUARD=1 bypasses; =0 does not", async (t) => {
      const outside = path.join(fakeRealHomedir, "test-hatch.json");
      // Clean up if actually written
      t.after(() => fs.rmSync(outside, { force: true }));

      await withEnv({ ...baseTestEnv, SCOUTLINE_NO_TEST_GUARD: "1" }, async () => {
        // Hatch 1 bypasses isolation check (may throw or succeed on real fs, but NOT TestIsolationViolationError)
        try {
          await atomicReplaceFile(outside, "hatch-ok");
        } catch (error) {
          assert.strictEqual(isTestIsolationViolation(error), false);
        }
      });

      await withEnv({ ...baseTestEnv, SCOUTLINE_NO_TEST_GUARD: "0" }, async () => {
        await assert.rejects(
          async () => atomicReplaceFile(outside, "hatch-fail"),
          (error) => isTestIsolationViolation(error),
        );
      });
    });

    it("production mode (NODE_TEST_CONTEXT undefined) does not fire guard", async (t) => {
      const outside = path.join(fakeRealHomedir, "test-prod.json");
      t.after(() => fs.rmSync(outside, { force: true }));
      await withEnv({ ...baseTestEnv, NODE_TEST_CONTEXT: undefined }, async () => {
        try {
          await atomicReplaceFile(outside, "prod-ok");
        } catch (error) {
          assert.strictEqual(isTestIsolationViolation(error), false);
        }
      });
    });
  });

  describe("chokepoint: withAsyncFileLock", () => {
    it("throws TestIsolationViolationError on un-isolated stateDir", async () => {
      const unisolatedDir = path.join(fakeRealHomedir, "locks");
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () =>
            withAsyncFileLock(unisolatedDir, "test-lock", async () => "ok", {
              timeoutMs: 100,
              staleMs: 1000,
              timeoutLabel: "Test lock",
            }),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            assert.match(error.message, /withAsyncFileLock/);
            return true;
          },
        );
      });
    });

    it("skips guard when stateDir === undefined", async () => {
      await withEnv(baseTestEnv, async () => {
        const result = await withAsyncFileLock(
          undefined,
          "test-lock",
          async () => "in-memory-ok",
          { timeoutMs: 100, staleMs: 1000, timeoutLabel: "Test lock" },
        );
        assert.strictEqual(result, "in-memory-ok");
      });
    });

    it("allows execution when stateDir is isolated", async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-test-lock-"));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      await withEnv({ ...baseTestEnv, SCOUTLINE_CACHE_DIR: dir }, async () => {
        const result = await withAsyncFileLock(
          dir,
          "test-lock",
          async () => "locked-ok",
          { timeoutMs: 1000, staleMs: 5000, timeoutLabel: "Test lock" },
        );
        assert.strictEqual(result, "locked-ok");
      });
    });
  });

  describe("chokepoint: async-job-state", () => {
    it("write throws TestIsolationViolationError on un-isolated dir", async () => {
      const unisolatedDir = path.join(fakeRealHomedir, "research");
      const jobState = createProductionAsyncJobStateFile(unisolatedDir);
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () =>
            jobState.write("hash1", {
              requestId: "req-1",
              identityHash: "hash1",
              createdAt: new Date().toISOString(),
              status: "pending",
            }),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            assert.match(error.message, /async-job-state/);
            return true;
          },
        );
      });
    });

    it("remove throws TestIsolationViolationError on un-isolated dir", async () => {
      const unisolatedDir = path.join(fakeRealHomedir, "research");
      const jobState = createProductionAsyncJobStateFile(unisolatedDir);
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () => jobState.remove("hash1"),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            assert.match(error.message, /async-job-state/);
            return true;
          },
        );
      });
    });
  });

  describe("chokepoint: cache & un-swallow rule", () => {
    it("writeCache throws TestIsolationViolationError and is NOT swallowed", async () => {
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () => writeCache("test-key", { value: 123 }),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            assert.match(error.message, /writeCache|atomicReplaceFile/);
            return true;
          },
        );
      });
    });

    it("writeToolCache throws TestIsolationViolationError and is NOT swallowed (un-swallow pin)", async () => {
      const dummyConfig = {
        command: "test",
        args: [],
        env: {},
      };
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () =>
            writeToolCache(dummyConfig, [
              { name: "test-tool", description: "test", inputSchema: {} },
            ]),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            assert.match(error.message, /writeToolCache|atomicReplaceFile/);
            return true;
          },
        );
      });
    });

    it("legacy aliases ZAI_CACHE_DIR and ZAI_MCP_CACHE_DIR allow cache writes", async (t) => {
      const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-zai-cache-"));
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-zai-mcp-"));
      t.after(() => {
        fs.rmSync(dir1, { recursive: true, force: true });
        fs.rmSync(dir2, { recursive: true, force: true });
      });

      await withEnv({ ...baseTestEnv, ZAI_CACHE_DIR: dir1 }, async () => {
        await assert.doesNotReject(async () => writeCache("key-zai", { a: 1 }));
      });

      const dummyConfig = { command: "test-mcp", args: [], env: {} };
      await withEnv({ ...baseTestEnv, ZAI_MCP_CACHE_DIR: dir2 }, async () => {
        await assert.doesNotReject(async () =>
          writeToolCache(dummyConfig, [
            { name: "tool-mcp", description: "d", inputSchema: {} },
          ]),
        );
      });
    });
  });

  describe("chokepoint: quota-store un-swallow rule", () => {
    it("writeObserved throws TestIsolationViolationError when un-isolated", async () => {
      const unisolatedPath = path.join(fakeRealHomedir, "state.json");
      const store = createDefaultQuotaStore({ filePath: unisolatedPath });
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () =>
            store.writeObserved("brave", {
              observedAt: Date.now(),
              categories: [{ name: "default", limit: 100, used: 10 }],
            }),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            return true;
          },
        );
      });
    });
  });

  describe("chokepoint: usage-ledger un-swallow rule", () => {
    it("record throws TestIsolationViolationError when un-isolated", async () => {
      const unisolatedPath = path.join(fakeRealHomedir, "usage.json");
      const sink = createUsageLedgerSink({ filePath: unisolatedPath });
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () =>
            sink.record({
              provider: "brave",
              capability: "search",
              units: 1,
            }),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            return true;
          },
        );
      });
    });
  });

  describe("chokepoint: watch-store", () => {
    it("appendSnapshot throws TestIsolationViolationError on un-isolated root", async () => {
      const unisolatedRoot = path.join(fakeRealHomedir, "watch");
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () =>
            appendSnapshot(unisolatedRoot, "target1", {
              body: Buffer.from("test"),
              now: new Date(),
            }),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            return true;
          },
        );
      });
    });

    it("appendChangeLog throws TestIsolationViolationError on un-isolated root", async () => {
      const unisolatedRoot = path.join(fakeRealHomedir, "watch");
      await withEnv(baseTestEnv, async () => {
        await assert.rejects(
          async () =>
            appendChangeLog(unisolatedRoot, "target1", {
              at: new Date().toISOString(),
              kind: "initial",
              gen: 1,
            }),
          (error) => {
            assert.ok(isTestIsolationViolation(error));
            return true;
          },
        );
      });
    });
  });

  describe("#155 lesson pin: effective path determines safety, unconsulted isolation does not silence", () => {
    it("SCOUTLINE_CACHE_DIR isolation does not allow config.json write", async () => {
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-iso-cache-only-"));
      const configPath = path.join(fakeRealHomedir, "config.json");
      try {
        await withEnv({ ...baseTestEnv, SCOUTLINE_CACHE_DIR: cacheDir }, async () => {
          await assert.rejects(
            async () => atomicReplaceFile(configPath, "{}"),
            (error) => {
              assert.ok(isTestIsolationViolation(error));
              return true;
            },
          );
        });
      } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    });
  });
});
