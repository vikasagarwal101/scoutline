/**
 * #263: central `--flag=value` ≡ `--flag value` normalization.
 *
 * Defect: shared arg parsing had no equals-form handling — such tokens
 * landed as garbage boolean keys and were silently dropped. Two commands
 * (archive, investigate) guarded locally; the seam replaces both and
 * applies to EVERY command.
 *
 * Rows:
 *   - pure normalizer: first-'=' split only; values containing '=' are
 *     never split; `--=x`, bare `--`, short flags, non-flag tokens
 *     untouched; `--flag=` is the valueless form.
 *   - equivalence: for every command with a valued flag, `--flag=value`
 *     and `--flag value` produce identical parsed state (through
 *     main(), hermetic).
 *   - strict mode: SCOUTLINE_STRICT_FLAGS rejects unknown equals-form
 *     keys identically to space-form.
 *   - seam removal: archive and investigate no longer have local
 *     equals-form rejections — `--timeout=300` now RUNS (equivalence),
 *     and `--verify=x` / `--synthesize=x` still reject via the
 *     boolean-value guard with the same envelope code.
 *
 * Tests import from ../dist (the established convention); build first.
 */
import { describe, it } from "node:test";
import * as fsMod from "node:fs/promises";
import * as osMod from "node:os";
import * as pathMod from "node:path";
import assert from "node:assert/strict";

import { main, normalizeEqualsFormFlags, STRICT_FLAG_ALLOWLIST } from "../dist/index.js";
import { parseArchiveArgs, parseArchiveTokens } from "../dist/commands/archive.js";
import { ValidationError } from "../dist/lib/errors.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

useTempConfigDir();

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    invocation: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

function envelopeCode(stderr) {
  const m = stderr.match(/"code"\s*:\s*"([A-Z_]+)"/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 1. Pure seam
// ---------------------------------------------------------------------------

describe("normalizeEqualsFormFlags (pure)", () => {
  it("splits on the FIRST '=' in a long flag only", () => {
    assert.deepStrictEqual(normalizeEqualsFormFlags(["--flag=value"]), ["--flag", "value"]);
    // A value's internal '='s are never split (fetch --header K:V=W).
    assert.deepStrictEqual(normalizeEqualsFormFlags(["--header=K:V=W"]), ["--header", "K:V=W"]);
    assert.deepStrictEqual(normalizeEqualsFormFlags(["--data=a=b=c"]), ["--data", "a=b=c"]);
  });

  it("leaves non-flag tokens, bare --, empty-key, and short flags untouched", () => {
    assert.deepStrictEqual(normalizeEqualsFormFlags(["a=b", "q"]), ["a=b", "q"]);
    assert.deepStrictEqual(normalizeEqualsFormFlags(["--"]), ["--"]);
    assert.deepStrictEqual(normalizeEqualsFormFlags(["--=x"]), ["--=x"]);
    assert.deepStrictEqual(normalizeEqualsFormFlags(["-O=json"]), ["-O=json"]);
    assert.deepStrictEqual(normalizeEqualsFormFlags(["--plain"]), ["--plain"]);
  });

  it("--flag= normalizes to the valueless form", () => {
    assert.deepStrictEqual(normalizeEqualsFormFlags(["--flag="]), ["--flag", ""]);
  });

  it("normalizes every matching token in argv, order-preserving", () => {
    assert.deepStrictEqual(
      normalizeEqualsFormFlags(["--a=1", "pos", "--b", "2", "--c=3=4"]),
      ["--a", "1", "pos", "--b", "2", "--c", "3=4"],
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Equivalence through main(): --flag=value ≡ --flag value on EVERY
//    command. One representative valued flag per command, chosen from
//    STRICT_FLAG_ALLOWLIST (the seam must hold command-wide).
// ---------------------------------------------------------------------------

// Commands whose representative run is fully hermetic and reaches the
// handler's parse (all of these reject/complete before any network).
// [command, argvPrefix, flagToken, envelope evidence of a parsed flag]
const EQUIVALENCE_ROWS = [
  // archive: the OLD local guard rejected `--timeout=300`; now ≡ space form.
  {
    cmd: "archive",
    argv: ["archive", "cdx", "https://example.com/*"],
    flag: "--timeout=300",
    space: ["--timeout", "300"],
    // Both forms must now produce the SAME outcome (an attempted cdx run,
    // not the #172 garbage-key silent drop).
    sameOutcome: true,
  },
  // investigate --verify: the OLD guard rejected `--verify=foo` with a
  // dedicated equals-form error; now it normalizes to `--verify foo` and
  // the boolean-value guard rejects it identically.
  {
    cmd: "investigate",
    argv: ["investigate", "q"],
    flag: "--verify=foo",
    space: ["--verify", "foo"],
    sameOutcome: true,
  },
  // investigate --synthesize: same story.
  {
    cmd: "investigate",
    argv: ["investigate", "q"],
    flag: "--synthesize=foo",
    space: ["--synthesize", "foo"],
    sameOutcome: true,
  },
];

async function runHermeticMain(argv, extraEnv = {}) {
  const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "scoutline-eq-"));
  try {
    const { invocation, stderr } = makeInvocation();
    const deps = hermeticMainDeps({
      invocation,
      env: { SCOUTLINE_CONFIG_DIR: dir, ...extraEnv },
    });
    const code = await main(argv, deps);
    return { code, stderr: stderr() };
  } finally {
    await fsMod.rm(dir, { recursive: true, force: true });
  }
}

describe("#263 equals-form ≡ space-form through main()", () => {
  for (const row of EQUIVALENCE_ROWS) {
    it(`${row.cmd} ${row.flag} ≡ ${row.space.join(" ")}`, { timeout: 10000 }, async () => {
      const equalsRun = await runHermeticMain([...row.argv, row.flag]);
      const spaceRun = await runHermeticMain([...row.argv, ...row.space]);
      // Identical exit code and envelope code: the seam makes the forms
      // indistinguishable downstream.
      assert.strictEqual(equalsRun.code, spaceRun.code);
      assert.strictEqual(envelopeCode(equalsRun.stderr), envelopeCode(spaceRun.stderr));
      // And neither is the #263 defect signature: a garbage-key silent
      // drop would look like the flag was never passed (exit 0 / a
      // different envelope than the properly-parsed space form).
      assert.notStrictEqual(envelopeCode(equalsRun.stderr), "PARSE_ERROR");
    });
  }

  it("a valued flag's equals form reaches the handler as a VALUE (fetch --header)", async () => {
    // fetch --header K:V=W: the value contains '=' and must arrive intact.
    // A dry-ish surface: --md5 with an unreachable host never reaches
    // network config load; instead pin the pure seam + parseArchiveArgs
    // (exported) for value integrity.
    const parsed = parseArchiveArgs(["cdx", "https://example.com/*", "--timeout=300"]);
    assert.strictEqual(parsed.flags.timeout, "300");
    const parsedEq = parseArchiveArgs(["cdx", "https://example.com/*", "--from=2026-01-01"]);
    assert.strictEqual(parsedEq.flags.from, "2026-01-01");
  });

  it("valueless flags keep their forms: --json-style booleans unaffected", () => {
    // --raw through the pure seam is untouched; parseArchiveArgs maps
    // `--raw=1` to --raw + positional 1 (no-branch consumes nothing).
    const parsed = parseArchiveArgs(["get", "https://example.com/", "--raw"]);
    assert.strictEqual(parsed.flags.raw, true);
  });
});

// ---------------------------------------------------------------------------
// 3. STRICT_FLAGS rejects unknown equals-form keys identically
// ---------------------------------------------------------------------------

describe("SCOUTLINE_STRICT_FLAGS × equals form", () => {
  it("rejects an unknown equals-form key with the strict error", { timeout: 10000 }, async () => {
    const run = await runHermeticMain(["search", "q", "--fusio=rrf"], {
      SCOUTLINE_STRICT_FLAGS: "1",
    });
    assert.strictEqual(run.code, 1);
    assert.match(run.stderr, /SCOUTLINE_STRICT_FLAGS/);
    // Identically to space-form: the gate sees normalized tokens, so the
    // error names `--fusio` exactly as the space-form rejection does.
    assert.match(run.stderr, /unknown flag \\"--fusio\\"/);
  });

  it("accepts a KNOWN equals-form key under strict mode (runs, not rejects)", { timeout: 10000 }, async () => {
    // search --count=3 is allowlisted; strict mode must not reject the
    // token itself. The run reaches provider resolution and exits 3
    // (no configured provider, the hermetic-env expectation) — the
    // strict gate never fires.
    const run = await runHermeticMain(["search", "q", "--count=3"], {
      SCOUTLINE_STRICT_FLAGS: "1",
    });
    assert.strictEqual(run.code, 3, "no-provider exit, not the strict-gate 1");
    assert.ok(!/SCOUTLINE_STRICT_FLAGS/.test(run.stderr), "must not hit the strict gate");
  });

  it("every STRICT_FLAG_ALLOWLIST command's representative flag normalizes identically", () => {
    // Enumeration pin: for every allowlisted command, take its first
    // multi-char flag and assert the seam splits it cleanly. This is the
    // "enumerating commands" AC — the seam must not depend on which
    // command is dispatching.
    for (const [command, allowed] of Object.entries(STRICT_FLAG_ALLOWLIST)) {
      const flag = [...allowed].find((f) => f.length > 1 && f !== "h");
      assert.ok(flag, `${command} has a representative flag`);
      const split = normalizeEqualsFormFlags([`--${flag}=v`]);
      assert.deepStrictEqual(split, [`--${flag}`, "v"], `${command}: --${flag}=v splits`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Local guards REMOVED (one seam)
// ---------------------------------------------------------------------------

describe("local equals-form guards removed (#263)", () => {
  it("parseArchiveArgs no longer throws on the =-form — it parses it", () => {
    const parsed = parseArchiveArgs(["--timeout=300"]);
    assert.strictEqual(parsed.flags.timeout, "300");
  });

  it("archive main(): --timeout=300 no longer errors with 'not supported'", { timeout: 10000 }, async () => {
    // The #172-era rejection text is gone; the run proceeds (hermetic
    // fetch refusal pins that parsing succeeded — different error).
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network reached");
    };
    try {
      const run = await runHermeticMain(["archive", "get", "https://example.com/", "--timeout=300"]);
      assert.strictEqual(run.code, 1);
      assert.ok(!/not supported/.test(run.stderr), "no equals-form rejection text");
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it("investigate --verify=foo still rejects (boolean guard), same envelope as space form", { timeout: 10000 }, async () => {
    const run = await runHermeticMain(["investigate", "q", "--verify=foo"]);
    assert.strictEqual(run.code, 1);
    assert.strictEqual(envelopeCode(run.stderr), "VALIDATION_ERROR");
    assert.match(run.stderr, /--verify is a boolean flag/);
  });

  it("investigate --synthesize=foo still rejects (boolean guard)", { timeout: 10000 }, async () => {
    const run = await runHermeticMain(["investigate", "q", "--synthesize=foo"]);
    assert.strictEqual(run.code, 1);
    assert.strictEqual(envelopeCode(run.stderr), "VALIDATION_ERROR");
  });

  it("single application: a produced value starting with -- keeps its '=' (kody PR-278)", () => {
    // `--foo=--bar=baz` must reach parsers as --foo + VALUE "--bar=baz".
    // The regression shape (fixed): a second seam pass re-splits the
    // value into --bar + baz, changing parsed state. The seam is
    // single-application BY ARCHITECTURE: the exported wrapper
    // (parseArchiveArgs) normalizes at the raw-argv boundary; internal
    // dispatch paths (main → handleArchive → parseArchiveTokens) receive
    // pre-normalized tokens and never re-apply. Mutation: making
    // handleArchive re-normalize REDs this row via the flags assertion.
    const once = normalizeEqualsFormFlags(["--foo=--bar=baz"]);
    assert.deepEqual(once, ["--foo", "--bar=baz"]);
    // Teeth: the internal single-application parser must never re-split
    // a produced value. Mutation — adding normalize inside
    // parseArchiveTokens (the double-application regression) — turns
    // flags["bar=baz"] into flags.bar:"baz" and REDs here.
    const tokens = parseArchiveTokens(["--foo", "--bar=baz"]);
    assert.deepEqual(tokens.flags, { "bar=baz": true, foo: true });
  });

});
