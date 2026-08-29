/**
 * T1 — Artifact store core: requestId + atomic write + overwrite guard.
 *
 * Pins (ticket t1-artifact-store-core):
 *   1. newRequestId(now): `<UTC compact>-<4 lowercase hex>`, timestamp from
 *      the INJECTED now (repo time-bomb rule), per-call hex tail, lex order.
 *   2. resolveArtifactsDir(env): SCOUTLINE_ARTIFACTS_DIR wins, else
 *      <resolveConfigRootPure(env)>/artifacts. Pure — no disk, no process.env.
 *   3. writeArtifact: delegates to atomicReplaceFile (0700 dir / 0600 file
 *      inherited), plus the pre-check it lacks — existing target without
 *      `force` throws FILE_ERROR and leaves the file BYTE-IDENTICAL.
 *
 * Hermeticity: every path lives inside a withTempDir tmp dir, or is a pure
 * injected-env computation. Nothing reads process.env; nothing touches
 * ~/.scoutline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withTempDir } from "./helpers/temp-dir.js";
import { FileError } from "../dist/lib/errors.js";

// 2026-08-29T14:22:33Z — injected, never Date.now() (repo time-bomb rule).
const NOW_BASE = Date.UTC(2026, 7, 29, 14, 22, 33);

/** Deterministic randomBytes double: distinct bytes per call, seeded. */
function byteStream(seed) {
  let n = seed & 0xff;
  return (size) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      n = (n * 31 + 7) & 0xff;
      out[i] = n;
    }
    return out;
  };
}

const RID = "20260829T142233Z-7f3a";

describe("newRequestId", () => {
  it("matches the <UTC compact>-<4 lowercase hex> shape", async () => {
    const { newRequestId } = await import("../dist/lib/artifacts.js");

    assert.match(newRequestId(NOW_BASE), /^\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  });

  it("formats the INJECTED now as a UTC compact timestamp — never wall-clock", async () => {
    const { newRequestId } = await import("../dist/lib/artifacts.js");

    const id = newRequestId(NOW_BASE);
    assert.ok(
      id.startsWith("20260829T142233Z-"),
      `expected the injected instant 20260829T142233Z, got ${id}`,
    );

    // Accepts a Date too, same instant, same timestamp part.
    const fromDate = newRequestId(new Date(NOW_BASE));
    assert.ok(fromDate.startsWith("20260829T142233Z-"));
  });

  it("orders lexicographically ascending as the injected now ascends (incl. day rollover)", async () => {
    const { newRequestId } = await import("../dist/lib/artifacts.js");

    const s1 = newRequestId(Date.UTC(2026, 7, 29, 14, 22, 33), byteStream(5));
    const s2 = newRequestId(Date.UTC(2026, 7, 29, 14, 22, 34), byteStream(5));
    assert.ok(s1 < s2, `${s1} should sort before ${s2}`);

    const d1 = newRequestId(Date.UTC(2026, 7, 29, 23, 59, 59), byteStream(5));
    const d2 = newRequestId(Date.UTC(2026, 7, 30, 0, 0, 0), byteStream(5));
    assert.ok(d1 < d2, `${d1} should sort before ${d2} across the day rollover`);

    const h1 = newRequestId(Date.UTC(2026, 7, 29, 9, 59, 59), byteStream(5));
    const h2 = newRequestId(Date.UTC(2026, 7, 29, 10, 0, 0), byteStream(5));
    assert.ok(h1 < h2, `${h1} should sort before ${h2} across the hour boundary`);
  });

  it("draws the hex tail per call — two calls at the same now differ", async () => {
    const { newRequestId } = await import("../dist/lib/artifacts.js");

    const a = newRequestId(NOW_BASE, byteStream(1));
    const b = newRequestId(NOW_BASE, byteStream(2));
    assert.notStrictEqual(a, b);
  });
});

describe("resolveArtifactsDir", () => {
  it("lets SCOUTLINE_ARTIFACTS_DIR win over the config root", async () => {
    const { resolveArtifactsDir } = await import("../dist/lib/artifacts.js");

    assert.strictEqual(
      resolveArtifactsDir(
        { SCOUTLINE_ARTIFACTS_DIR: "/tmp/iso/art", SCOUTLINE_CONFIG_DIR: "/tmp/iso/config" },
        { homedir: "/home/u" },
      ),
      "/tmp/iso/art",
    );
  });

  it("defaults to <resolveConfigRootPure(env)>/artifacts — pure, no disk, honors SCOUTLINE_CONFIG_DIR", async () => {
    const { resolveArtifactsDir } = await import("../dist/lib/artifacts.js");

    assert.strictEqual(
      resolveArtifactsDir({}, { homedir: "/home/u" }),
      path.join("/home/u", ".scoutline", "artifacts"),
    );
    assert.strictEqual(
      resolveArtifactsDir({ SCOUTLINE_CONFIG_DIR: "/cfg" }, { homedir: "/home/u" }),
      path.join("/cfg", "artifacts"),
    );
  });
});

describe("writeArtifact", () => {
  it("writes <requestId>.json into a created dir, returns the target, no temp residue", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeArtifact } = await import("../dist/lib/artifacts.js");

      const target = await writeArtifact(dir, RID, '{"ok":true}');

      assert.strictEqual(target, path.join(dir, `${RID}.json`));
      assert.strictEqual(await fs.readFile(target, "utf8"), '{"ok":true}');
      assert.deepStrictEqual((await fs.readdir(dir)).sort(), [`${RID}.json`]);
    });
  });

  it("uses the .md extension for format markdown", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeArtifact } = await import("../dist/lib/artifacts.js");

      const target = await writeArtifact(dir, RID, "# report", { format: "markdown" });

      assert.strictEqual(target, path.join(dir, `${RID}.md`));
      assert.strictEqual(await fs.readFile(target, "utf8"), "# report");
    });
  });

  it("inherits the atomic discipline through atomicReplaceFile: 0700 dir, 0600 file", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeArtifact } = await import("../dist/lib/artifacts.js");

      const target = await writeArtifact(dir, RID, "x");

      assert.strictEqual((await fs.stat(dir)).mode & 0o777, 0o700);
      assert.strictEqual((await fs.stat(target)).mode & 0o777, 0o600);
    });
  });

  it("refuses overwrite without force: FILE_ERROR and the target stays BYTE-IDENTICAL", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeArtifact } = await import("../dist/lib/artifacts.js");

      const target = await writeArtifact(dir, RID, "original");
      const before = await fs.stat(target);
      const beforeContent = await fs.readFile(target, "utf8");

      await assert.rejects(
        writeArtifact(dir, RID, "replacement"),
        (error) => error instanceof FileError && error.code === "FILE_ERROR",
      );

      const after = await fs.stat(target);
      assert.strictEqual(after.size, before.size, "stat size must be unchanged");
      assert.strictEqual(
        await fs.readFile(target, "utf8"),
        beforeContent,
        "content must be byte-identical after a refused write",
      );
      assert.deepStrictEqual((await fs.readdir(dir)).sort(), [`${RID}.json`]);
    });
  });

  it("force overwrites atomically: new content, still 0600, no temp residue", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeArtifact } = await import("../dist/lib/artifacts.js");

      await writeArtifact(dir, RID, "original");
      const target = await writeArtifact(dir, RID, "forced", { force: true });

      assert.strictEqual(await fs.readFile(target, "utf8"), "forced");
      assert.strictEqual((await fs.stat(target)).mode & 0o777, 0o600);
      assert.deepStrictEqual((await fs.readdir(dir)).sort(), [`${RID}.json`]);
    });
  });

  // Review fixup (coderabbit minor, lstat): a DANGLING symlink at the
  // master target is an existing entry — fs.stat misses it (ENOENT through
  // the link) and a force=false write would silently replace it.
  it("refuses a dangling symlink at the master target without force (lstat, not stat)", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeArtifact } = await import("../dist/lib/artifacts.js");

      const target = path.join(dir, `${RID}.json`);
      await fs.symlink(path.join(dir, "vanished-target.json"), target);

      await assert.rejects(
        writeArtifact(dir, RID, "replacement"),
        (error) => error instanceof FileError && error.code === "FILE_ERROR",
      );
      // The symlink itself survives untouched.
      assert.strictEqual((await fs.lstat(target)).isSymbolicLink(), true);
    });
  });

  // Review fixup (macroscope HIGH + coderabbit Major, artifacts.ts:139):
  // concurrent same-requestId saves must not both pass the existence check
  // and let the second overwrite the first — the check re-runs INSIDE the
  // artifacts-write lock, so the loser is refused, never a silent clobber.
  it("concurrent writes with the same requestId: exactly one wins, the loser gets FILE_ERROR", async (t) => {
    await withTempDir(t, async (dir) => {
      const { writeArtifact } = await import("../dist/lib/artifacts.js");

      const fastTimer = (callback, ms) => setTimeout(callback, Math.min(ms, 5));
      const results = await Promise.allSettled([
        writeArtifact(dir, RID, "first", { lock: { setTimeout: fastTimer } }),
        writeArtifact(dir, RID, "second", { lock: { setTimeout: fastTimer } }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.strictEqual(fulfilled.length, 1, "exactly one write may win");
      assert.strictEqual(rejected.length, 1, "the other must be refused");
      const error = rejected[0].reason;
      assert.ok(error instanceof FileError && error.code === "FILE_ERROR");
      assert.match(error.message, /Refusing to overwrite existing artifact/);
      // The winner's content is intact — no interleaved overwrite.
      assert.strictEqual(await fs.readFile(path.join(dir, `${RID}.json`), "utf8"), "first");
    });
  });

  // Review fixup (macroscope HIGH, index.ts export TOCTOU): the export
  // copy's no-overwrite path is now atomic check-and-place.
  describe("atomicPlaceNoClobber", () => {
    it("places content when the target is absent", async (t) => {
      await withTempDir(t, async (dir) => {
        const { atomicPlaceNoClobber } = await import("../dist/lib/artifacts.js");

        const target = path.join(dir, "report.json");
        assert.strictEqual(await atomicPlaceNoClobber(target, "placed"), true);
        assert.strictEqual(await fs.readFile(target, "utf8"), "placed");
        assert.strictEqual((await fs.stat(target)).mode & 0o777, 0o600);
        // No temp residue.
        assert.deepStrictEqual(await fs.readdir(dir), ["report.json"]);
      });
    });

    it("refuses an existing target: false, byte-identical, no temp residue", async (t) => {
      await withTempDir(t, async (dir) => {
        const { atomicPlaceNoClobber } = await import("../dist/lib/artifacts.js");

        const target = path.join(dir, "report.json");
        await fs.writeFile(target, "original", { mode: 0o600 });

        assert.strictEqual(await atomicPlaceNoClobber(target, "replacement"), false);
        assert.strictEqual(await fs.readFile(target, "utf8"), "original");
        assert.deepStrictEqual(await fs.readdir(dir), ["report.json"]);
      });
    });

    it("sees a dangling symlink at the target as existing (EEXIST through link)", async (t) => {
      await withTempDir(t, async (dir) => {
        const { atomicPlaceNoClobber } = await import("../dist/lib/artifacts.js");

        const target = path.join(dir, "report.json");
        await fs.symlink(path.join(dir, "vanished.json"), target);

        assert.strictEqual(await atomicPlaceNoClobber(target, "replacement"), false);
        assert.strictEqual((await fs.lstat(target)).isSymbolicLink(), true);
      });
    });

    // Review nitpick (coderabbit, artifacts.ts): the temp file opens in
    // path.dirname(filePath), so a missing target directory must be
    // created first — atomicReplaceFile parity (0700 dir).
    it("creates a missing target directory (0700) before placing", async (t) => {
      await withTempDir(t, async (dir) => {
        const { atomicPlaceNoClobber } = await import("../dist/lib/artifacts.js");

        const target = path.join(dir, "missing", "nested", "report.json");
        assert.strictEqual(await atomicPlaceNoClobber(target, "placed"), true);
        assert.strictEqual(await fs.readFile(target, "utf8"), "placed");
        const created = path.dirname(target);
        assert.strictEqual((await fs.stat(created)).mode & 0o777, 0o700);
      });
    });
  });
});
