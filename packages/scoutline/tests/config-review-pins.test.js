/**
 * Pins for the PR #127 cubic review follow-ups (issue #119 sweep).
 *
 * 1. `writeConfig`'s .bak rotation rides the SAME atomic replace as the
 *    main write: an injected `options.atomic.rename` must observe the
 *    `<file>.bak` destination (rotation is rename-atomic — no
 *    copyFile+chmod window; a crash mid-rotation can never truncate the
 *    .bak that rename alone promotes into place).
 * 2. hermetic-main's lazy quota-store singleton removes its temp dir on
 *    process exit (sync-only `process.on("exit")` handler — exit
 *    handlers cannot await).
 * 3. `useTempConfigDir`'s after() hook is state-guarded: a before()
 *    failure surfaces the ORIGINAL error, never a secondary
 *    ERR_INVALID_ARG_TYPE from cleanup racing on undefined state.
 *
 * Pins 1b and 3a are positive regression guards (green before and after
 * the fixes); 1a, 2 and 3b redden against the pre-fix sources.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { withTempDir } from "./helpers/temp-dir.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HERMETIC_MAIN_URL = pathToFileURL(path.join(HERE, "helpers", "hermetic-main.js")).href;
const CONFIG_DIR_PIN_URL = pathToFileURL(path.join(HERE, "helpers", "config-dir-pin.js")).href;

describe("writeConfig .bak rotation rides the injected atomic rename (cubic P2)", () => {
  it("the rotation's <file>.bak destination goes through options.atomic.rename", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeConfig } = await import("../dist/lib/config-store.js");
      const destinations = [];
      const atomic = {
        rename: async (from, to) => {
          destinations.push(String(to));
          return fs.rename(from, to);
        },
      };
      const filePath = path.join(dir, "config.json");
      const v1 = { version: 1, providers: {} };
      const v2 = { version: 1, providers: {}, fallbackEnabled: true };
      await writeConfig(v1, { filePath, atomic });
      await writeConfig(v2, { filePath, atomic });

      assert.ok(
        destinations.includes(`${filePath}.bak`),
        `expected the rotation to rename into ${filePath}.bak; observed: ${JSON.stringify(destinations)}`,
      );
      assert.ok(
        destinations.includes(filePath),
        `expected the main write to rename into the config path; observed: ${JSON.stringify(destinations)}`,
      );
      assert.deepStrictEqual(JSON.parse(await fs.readFile(`${filePath}.bak`, "utf8")), v1);
      assert.deepStrictEqual(JSON.parse(await fs.readFile(filePath, "utf8")), v2);
      if (process.platform !== "win32") {
        assert.strictEqual((await fs.stat(`${filePath}.bak`)).mode & 0o777, 0o600);
      }
    });
  });

  it("the first write performs no .bak rename and leaves no .bak behind", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeConfig } = await import("../dist/lib/config-store.js");
      const destinations = [];
      const atomic = {
        rename: async (from, to) => {
          destinations.push(String(to));
          return fs.rename(from, to);
        },
      };
      const filePath = path.join(dir, "config.json");
      await writeConfig({ version: 1, providers: {} }, { filePath, atomic });
      assert.deepStrictEqual(destinations, [filePath]);
      await assert.rejects(fs.stat(`${filePath}.bak`), (error) => error.code === "ENOENT");
    });
  });
});

describe("hermetic quota-store singleton exit cleanup (cubic)", () => {
  it("the singleton's temp dir is gone once the consuming process exits", async (t) => {
    await withTempDir(t, async (dir) => {
      const child = path.join(dir, "hermetic-consumer.mjs");
      await fs.writeFile(
        child,
        `
        import { readdirSync } from "node:fs";
        import { tmpdir } from "node:os";
        // TMPDIR is this test's private dir, so the only
        // scoutline-hermetic-quota-* entries here are this child's own —
        // a global /tmp count would race other test workers (cubic wave 2).
        const { hermeticMainDeps } = await import(${JSON.stringify(HERMETIC_MAIN_URL)});
        hermeticMainDeps();
        const created = readdirSync(tmpdir()).filter((n) =>
          n.startsWith("scoutline-hermetic-quota-"),
        );
        if (created.length !== 1) {
          throw new Error("expected exactly one hermetic quota dir, got: " + JSON.stringify(created));
        }
        console.log("CREATED:" + created[0]);
      `,
      );
      const result = spawnSync(process.execPath, [child], {
        encoding: "utf8",
        // TMPDIR covers POSIX; TEMP/TMP are what os.tmpdir() honors on
        // Windows — set all three so the private dir is the child's
        // tmpdir everywhere (cubic wave 3).
        env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir },
      });
      assert.strictEqual(result.status, 0, `consumer failed: ${result.stderr}`);
      const created = result.stdout
        .split("\n")
        .find((line) => line.startsWith("CREATED:"))
        ?.slice("CREATED:".length);
      assert.ok(
        created,
        `expected the child to report its singleton dir; stdout: ${result.stdout}`,
      );
      assert.strictEqual(
        existsSync(path.join(dir, created)),
        false,
        `hermetic quota dir leaked after exit: ${created}`,
      );
    });
  });
});

describe("useTempConfigDir after-hook state guard (cubic)", () => {
  it("restores the env exactly and removes the pinned dir on the happy path", async (t) => {
    await withTempDir(t, async (dir) => {
      const child = path.join(dir, "pin-positive.mjs");
      await fs.writeFile(
        child,
        `
        import { it } from "node:test";
        import assert from "node:assert/strict";
        import { existsSync } from "node:fs";
        // Capture the inherited value: under the offline runner the child
        // is spawned with SCOUTLINE_CONFIG_DIR already set — the hook's
        // contract is "restores the PRIOR value", not "deletes the var".
        const initial = process.env.SCOUTLINE_CONFIG_DIR;
        const { useTempConfigDir } = await import(${JSON.stringify(CONFIG_DIR_PIN_URL)});
        useTempConfigDir();
        let pinnedDir;
        it("runs under a pinned temp config dir", () => {
          pinnedDir = process.env.SCOUTLINE_CONFIG_DIR;
          assert.ok(pinnedDir?.includes("scoutline-test-config-"), ` +
          "`pinned dir: ${pinnedDir}`" +
          `);
        });
        // Runs after node:test's after() hooks, so it observes their work.
        process.on("exit", () => {
          console.log("RESTORED:" + (process.env.SCOUTLINE_CONFIG_DIR === initial ? "yes" : "no"));
          console.log(
            "REMOVED:" + (pinnedDir !== undefined && !existsSync(pinnedDir) ? "yes" : "no"),
          );
        });
      `,
      );
      const result = spawnSync(process.execPath, [child], { encoding: "utf8" });
      assert.strictEqual(result.status, 0, `positive pin child failed: ${result.stderr}`);
      assert.match(result.stdout, /RESTORED:yes/);
      assert.match(result.stdout, /REMOVED:yes/);
    });
  });

  it("a before() failure surfaces the original error, not ERR_INVALID_ARG_TYPE", async (t) => {
    await withTempDir(t, async (dir) => {
      // `--require` (CJS) preload patches the fs CJS exports before the
      // main graph loads; the `--import`/ESM variant does NOT intercept
      // the named builtin import on this Node (verified empirically).
      const preload = path.join(dir, "mkdtemp-fault.cjs");
      const child = path.join(dir, "pin-fault.mjs");
      await fs.writeFile(
        preload,
        `
        const fs = require("node:fs");
        const original = fs.mkdtempSync;
        let armed = true;
        fs.mkdtempSync = (...args) => {
          if (armed) {
            armed = false;
            throw new Error("mkdtemp fault-injection (original failure)");
          }
          return original(...args);
        };
      `,
      );
      await fs.writeFile(
        child,
        `
        import { it } from "node:test";
        const { useTempConfigDir } = await import(${JSON.stringify(CONFIG_DIR_PIN_URL)});
        useTempConfigDir();
        it("never reached", () => {});
      `,
      );
      const result = spawnSync(process.execPath, ["--require", preload, child], {
        encoding: "utf8",
      });
      assert.notStrictEqual(result.status, 0, "the fault-injected child must fail");
      const output = `${result.stdout}\n${result.stderr}`;
      assert.match(output, /mkdtemp fault-injection/);
      assert.doesNotMatch(output, /ERR_INVALID_ARG_TYPE/);
    });
  });
});
