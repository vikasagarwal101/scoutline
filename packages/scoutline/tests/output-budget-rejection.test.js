/**
 * Output Budget — T6: honest rejection matrix (ADR-0007 D5).
 *
 * Every dispatched command NOT on the Output Budget ladder rejects
 * `--max-chars` with UNSUPPORTED_OPTION at parse time — before provider
 * resolution, before network, before credentials. No accept-and-drop.
 *
 * Structural pin: the command set is DERIVED from the dispatcher's own
 * exported partition (DISPATCHED_COMMANDS / REJECT_MAX_CHARS_COMMANDS),
 * never hand-maintained here — a future command added without a ladder
 * fails the enumeration pin by omission.
 *
 * Ladder surfaces keep working (no rejection): search / read / crawl /
 * research, repo search/read/brief; repo tree rejects (its own pin
 * lives in output-budget-t4.test.js).
 *
 * `map`, `config`, `init` are real commands and MUST appear in the
 * enumeration (the audit caught their omission in the planning list).
 *
 * Hermeticity: hermeticMainDeps (no ambient ~/.scoutline), fake
 * descriptors that THROW if create() is ever reached (the rejection
 * must precede provider work), no artifacts dir writes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../dist/index.js";
import {
  DISPATCHED_COMMANDS,
  REJECT_MAX_CHARS_COMMANDS,
  SWITCH_CASES,
  IF_ARMS,
} from "../dist/index.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const NOW = 1_800_000_000_000;

/**
 * Descriptor that fails the test if create() is reached: the rejection
 * matrix must fire at parse, before any provider construction. (No
 * descriptor is even consulted on these paths — the guard is upstream
 * of assignment — but the tripwire pins the ordering.)
 */
function tripwireDescriptors() {
  return [
    {
      id: "zai",
      isConfigured: () => true,
      capabilities: () => new Set(["search"]),
      create() {
        throw new Error("create() must not be reached on a rejected --max-chars");
      },
    },
  ];
}

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

async function runMain(argv) {
  const { adapter, stdout, stderr } = makeInvocation();
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      env: { Z_AI_API_KEY: "zai-key" },
      providerDescriptors: tripwireDescriptors(),
      now: () => NOW,
    }),
  });
  return { status, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Structural enumeration — the dispatcher's own partition is the truth
// ---------------------------------------------------------------------------

describe("the dispatcher's --max-chars partition is complete over all dispatched commands", () => {
  it("DISPATCHED_COMMANDS matches the full 22-command audit list exactly", () => {
    assert.deepEqual(
      [...DISPATCHED_COMMANDS].sort(),
      [
        "archive", "batch", "call", "cache", "code", "config", "crawl",
        "doctor", "fetch", "history", "init", "map", "quota", "read",
        "repo", "research", "search", "tool", "tools", "usage", "vision",
        "watch",
      ].sort(),
    );
  });

  it("F-6: DISPATCHED_COMMANDS equals the dispatch surface extracted from index.ts source", () => {
    // Mechanical link (review N10): the credentialed switch labels (the
    // ones carrying `commandRecognized = true`) plus the credential-free
    // if-chain arms, regex-extracted from the dispatcher's own source at
    // import time, must equal the exported set exactly. A command added
    // to dispatch without the set (or a set entry with no dispatch site)
    // fails here — the hand-maintained set can no longer drift.
    const extracted = new Set([...SWITCH_CASES, ...IF_ARMS]);
    assert.deepEqual(
      [...extracted].sort(),
      [...DISPATCHED_COMMANDS].sort(),
      "dispatch surface (switch cases + if arms) must equal DISPATCHED_COMMANDS",
    );
    assert.equal(SWITCH_CASES.size + IF_ARMS.size, 22, "14 switch cases + 8 if arms");
    for (const c of SWITCH_CASES) assert.ok(!IF_ARMS.has(c), `"${c}" dispatched twice`);
  });

  it("every dispatched command is either a ladder surface or in the rejection set", () => {
    const ladder = new Set(["search", "read", "crawl", "research", "repo"]);
    for (const command of DISPATCHED_COMMANDS) {
      assert.ok(
        ladder.has(command) || REJECT_MAX_CHARS_COMMANDS.has(command),
        `command "${command}" is neither a ladder surface nor in the rejection set`,
      );
    }
    // ...and the two sets are disjoint.
    for (const command of REJECT_MAX_CHARS_COMMANDS) {
      assert.ok(!ladder.has(command), `"${command}" cannot be both ladder and rejection`);
    }
  });

  it("a future command without a ladder fails the enumeration pin by omission (mutation guard)", () => {
    // Simulates the drift the pin exists to catch: add "transmogrify" to
    // the dispatched set without giving it a ladder or a rejection row.
    const simulated = new Set(DISPATCHED_COMMANDS);
    simulated.add("transmogrify");
    const ladder = new Set(["search", "read", "crawl", "research", "repo"]);
    const uncovered = [...simulated].filter(
      (c) => !ladder.has(c) && !REJECT_MAX_CHARS_COMMANDS.has(c),
    );
    assert.deepEqual(uncovered, ["transmogrify"], "an uncovered command must be exactly the omission");
  });
});

// ---------------------------------------------------------------------------
// Rejection rows — one per non-ladder command, no accept-and-drop
// ---------------------------------------------------------------------------

const REJECTION_ROWS = [
  { command: "vision", args: ["vision", "analyze", "img.png", "--max-chars", "500"] },
  { command: "map", args: ["map", "https://example.com", "--max-chars", "500"] },
  { command: "batch", args: ["batch", "manifest.json", "--max-chars", "500"] },
  { command: "tools", args: ["tools", "--max-chars", "500"] },
  { command: "tool", args: ["tool", "webSearch", "--max-chars", "500"] },
  { command: "call", args: ["call", "webSearch", "--query", "q", "--max-chars", "500"] },
  { command: "doctor", args: ["doctor", "--max-chars", "500"] },
  { command: "quota", args: ["quota", "--max-chars", "500"] },
  { command: "code", args: ["code", "--chain", "tsc", "--max-chars", "500"] },
  { command: "cache", args: ["cache", "stats", "--max-chars", "500"] },
  { command: "usage", args: ["usage", "--max-chars", "500"] },
  { command: "watch", args: ["watch", "--max-chars", "500"] },
  { command: "history", args: ["history", "list", "--max-chars", "500"] },
  { command: "init", args: ["init", "--max-chars", "500"] },
  { command: "config", args: ["config", "get", "providers", "--max-chars", "500"] },
  { command: "fetch", args: ["fetch", "https://example.com", "--max-chars", "500"] },
  { command: "archive", args: ["archive", "search", "example.com", "--max-chars", "500"] },
];

describe("non-ladder commands reject --max-chars with UNSUPPORTED_OPTION at parse", () => {
  for (const { command, args } of REJECTION_ROWS) {
    it(`${command}: --max-chars is UNSUPPORTED_OPTION, attributed to the command`, async () => {
      const { status, stdout, stderr } = await runMain(args);
      assert.equal(status, 1, `${command}: exit 1`);
      assert.deepEqual(stdout, [], `${command}: data-only stdout contract — nothing on stdout`);
      const err = JSON.parse(stderr.join(""));
      assert.equal(err.code, "UNSUPPORTED_OPTION", `${command}: error code`);
      // M7: the message is command-scoped, machine-parseable, and never
      // claims a provider was consulted (parse-time rejection — none was).
      assert.equal(
        err.error,
        `Command "${command}" does not accept option "--max-chars"`,
        `${command}: exact command-scoped message`,
      );
      // Derivation-style guard on top of the exact match: whatever the
      // message becomes, it must never contain the word "Provider" —
      // the lie the owner rejected.
      assert.ok(
        !/Provider/.test(err.error),
        `${command}: message must never say "Provider"`,
      );
    });
  }

  it("unknown command stays UNKNOWN/VALIDATION, not the --max-chars rejection", async () => {
    const { status, stderr } = await runMain(["transmogrify", "--max-chars", "500"]);
    assert.equal(status, 1);
    const err = JSON.parse(stderr.join(""));
    assert.ok(err.code !== "UNSUPPORTED_OPTION" || !/--max-chars/.test(err.error), "unknown command keeps its own error");
  });

  it("a valueless --max-chars on a non-ladder command still rejects as UNSUPPORTED_OPTION", async () => {
    const { status, stderr } = await runMain(["map", "https://example.com", "--max-chars"]);
    assert.equal(status, 1);
    const err = JSON.parse(stderr.join(""));
    assert.equal(err.code, "UNSUPPORTED_OPTION");
    assert.equal(
      err.error,
      'Command "map" does not accept option "--max-chars"',
      "valueless form gets the same command-scoped message",
    );
  });

  it("command help still renders for a non-ladder command carrying --max-chars", async () => {
    const { status, stdout } = await runMain(["map", "--help", "--max-chars", "500"]);
    assert.equal(status, 0);
    assert.ok(stdout.length > 0, "help is documentation, not a run");
  });
});

// ---------------------------------------------------------------------------
// Ladder surfaces are NOT rejected (partition honesty)
// ---------------------------------------------------------------------------

/**
 * Error code from stderr if a JSON error envelope is the last write;
 * undefined when the run succeeded or only warned. The rejection guard
 * is under test, not the provider plumbing: whatever else happens on a
 * ladder surface, it must not be the D5 rejection.
 */
function lastErrorCode(stderr) {
  const last = [...stderr].reverse().find((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("{") && trimmed.endsWith("}");
  });
  return last ? JSON.parse(last).code : undefined;
}

describe("ladder surfaces keep --max-chars (no over-rejection)", () => {
  const LADDER_ROWS = [
    ["search", ["--provider", "zai", "search", "query", "--max-chars", "500"]],
    ["read", ["--provider", "zai", "read", "https://example.com/doc", "--max-chars", "500"]],
    ["crawl", ["crawl", "https://example.com", "--max-chars", "500"]],
    ["research", ["research", "quantum", "--max-chars", "500"]],
  ];

  for (const [command, args] of LADDER_ROWS) {
    it(`${command}: NOT UNSUPPORTED_OPTION for --max-chars (parse passes to the ladder)`, async () => {
      const { status, stderr } = await runMain(args);
      // Any failure must be provider/config-related, never the rejection
      // (fake descriptors exist but tripwire create() guards misuse).
      if (status !== 0) {
        assert.notEqual(lastErrorCode(stderr), "UNSUPPORTED_OPTION", `${command} is a ladder surface`);
      }
    });
  }

  it("repo search/read/brief are ladder surfaces at the subcommand level", async () => {
    const { status, stderr } = await runMain(["repo", "search", "owner/repo", "query", "--max-chars", "500"]);
    if (status !== 0) {
      assert.notEqual(lastErrorCode(stderr), "UNSUPPORTED_OPTION", "repo search carries the flag");
    }
  });
});
