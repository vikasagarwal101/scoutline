/**
 * rejectFlagPair guard helper (#242).
 *
 * parseArgs maps `--no-X` to BOTH `flags.X = false` AND
 * `flags["no-X"] = true`. Any flag-forbidden feature that checks only
 * one spelling silently accepts the other. This file pins the shared
 * guard — rejectFlagPair(flags, name, makeError) throws for EITHER
 * spelling — and the fusion retrofit that now uses it (the AC-1
 * message stays byte-identical; the both-spellings pin in
 * tests/fusion.test.js keeps passing unchanged).
 *
 * Tests import from ../dist (the established convention); build first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsMod from "node:fs/promises";
import * as osMod from "node:os";
import * as pathMod from "node:path";

import { main, rejectFlagPair } from "../dist/index.js";
import { ValidationError } from "../dist/lib/errors.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

useTempConfigDir();

describe("rejectFlagPair (pure)", () => {
  const makeError = () => new ValidationError("no such flag", "use config instead");

  it("throws when the plain spelling is set (any value)", () => {
    for (const value of ["rrf", true, false]) {
      assert.throws(() => rejectFlagPair({ fusion: value }, "fusion", makeError), /no such flag/);
    }
  });

  it("throws when only the no- spelling is set (the double-map footgun)", () => {
    // parseArgs `--no-fusion` produces exactly this pair.
    assert.throws(
      () => rejectFlagPair({ fusion: false, "no-fusion": true }, "fusion", makeError),
      /no such flag/,
    );
    assert.throws(() => rejectFlagPair({ "no-fusion": true }, "fusion", makeError), /no such flag/);
  });

  it("silent when neither spelling is present — unrelated keys never throw", () => {
    rejectFlagPair({ count: "5", "no-cache": true }, "fusion", makeError);
    rejectFlagPair({}, "fusion", makeError);
  });

  it("makeError is lazy: no error object is built when neither spelling is set", () => {
    let built = 0;
    rejectFlagPair({}, "fusion", () => {
      built += 1;
      return new ValidationError("x", "y");
    });
    assert.strictEqual(built, 0);
  });

  it("throws the CALLER's error verbatim (message and help survive)", () => {
    assert.throws(
      () => rejectFlagPair({ fusion: "rrf" }, "fusion", makeError),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.strictEqual(error.message, "no such flag");
        assert.strictEqual(error.help, "use config instead");
        return true;
      },
    );
  });
});

describe("fusion rejection uses rejectFlagPair (#242 retrofit)", () => {
  it("the AC-1 message is byte-identical through main() for both spellings", async (t) => {
    const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "scoutline-rfp-"));
    t.after(async () => {
      await fsMod.rm(dir, { recursive: true, force: true });
    });
    for (const flagForm of [["--fusion", "rrf"], ["--no-fusion"]]) {
      const stdout = [];
      const stderr = [];
      const deps = hermeticMainDeps({
        invocation: {
          stdoutIsTTY: false,
          stdinIsTTY: false,
          environmentOutputMode: "data",
          readStdin: async () => "",
          writeStdout: (v) => stdout.push(v),
          writeStderr: (v) => stderr.push(v),
          runQuietly: async (op) => op(),
          setExitCode: () => {},
        },
        env: { SCOUTLINE_CONFIG_DIR: dir },
      });
      const status = await main(["search", "q", ...flagForm], deps);
      assert.strictEqual(status, 1);
      const text = stderr.join("");
      assert.match(text, /search has no --fusion flag/);
      assert.match(
        text,
        /Use `scoutline config set fusion <rrf\|occurrence>` or the SCOUTLINE_FUSION environment variable\./,
      );
      assert.strictEqual(stdout.join(""), "");
    }
  });
});

describe("parseArgs two-spelling contract comment (#242)", () => {
  it("the no- branch names the double-map contract in source", async () => {
    const source = await fsMod.readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    // The comment must sit at the `no-` branch and name the contract a
    // flag author must honor (both spellings / rejectFlagPair).
    const branch = source.indexOf('if (key.startsWith("no-"))');
    assert.ok(branch > 0, "parseArgs no- branch exists");
    const context = source.slice(Math.max(0, branch - 900), branch);
    assert.match(context, /two-spelling/i);
    assert.match(context, /rejectFlagPair/);
  });
});
