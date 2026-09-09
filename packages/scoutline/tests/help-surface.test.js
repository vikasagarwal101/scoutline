/**
 * MAIN_HELP ↔ dispatcher structural pin (#104).
 *
 * The rejection-matrix enumeration pins (output-budget-rejection.test.js)
 * tie DISPATCHED_COMMANDS to the dispatch surface extracted from the
 * module's own source — but NOTHING tied the Commands block of
 * `scoutline --help` to either. `config` shipped (PR #33) with no help
 * row and stayed invisible through 0.20.x because no pin forces
 * dispatch↔help agreement. This is the missing direction: the
 * user-visible --help surface — rendered through hermetic main(), i.e.
 * the BUILT dist artifact, not the source string — must carry exactly
 * one Commands row per dispatched command. Omissions (a dispatched
 * command with no row) and phantoms (a row naming an undispatched
 * command) both fail.
 *
 * Row shape: 2-space indent + command name + padding spaces + a
 * Capitalized description. The `)`-prefixed alternative tolerates the
 * one mid-line row (read's continuation runs into crawl's label) — a
 * known MAIN_HELP formatting glitch, not license for new ones.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main, DISPATCHED_COMMANDS } from "../dist/index.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

/** Row label: (line start or `)` + two spaces) + name + padding + Capital. */
const COMMAND_ROW = /(?:^|\)) {2}([a-z-]+) +[A-Z]/gm;

async function renderMainHelp() {
  const stdout = [];
  const stderr = [];
  const status = await main(["--help"], {
    ...hermeticMainDeps({
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
      env: { Z_AI_API_KEY: "zai-key" },
    }),
  });
  assert.equal(status, 0, "--help exits 0");
  assert.deepEqual(stderr, [], "--help is stdout-only");
  return stdout.join("");
}

function extractCommandRows(help) {
  assert.ok(help.includes("Commands:"), "help has a Commands block");
  const end = help.indexOf("\n\nProvider selection");
  assert.ok(end > 0, "Commands block is bounded by the Provider selection prose");
  const block = help.slice(help.indexOf("Commands:"), end);
  return [...new Set(Array.from(block.matchAll(COMMAND_ROW), (m) => m[1]))];
}

describe("MAIN_HELP Commands block mirrors the dispatched surface (#104)", () => {
  it("--help renders through hermetic main() with no stderr", async () => {
    const help = await renderMainHelp();
    assert.ok(help.includes("scoutline"), "help names the CLI");
    assert.ok(extractCommandRows(help).length > 0, "Commands block has rows");
  });

  it("every dispatched command has exactly one Commands row — no omissions, no phantoms", async () => {
    const rows = extractCommandRows(await renderMainHelp()).sort();
    const dispatched = [...DISPATCHED_COMMANDS].sort();
    const missing = dispatched.filter((c) => !rows.includes(c));
    const phantom = rows.filter((r) => !dispatched.includes(r));
    assert.deepEqual(
      rows,
      dispatched,
      `Commands rows must equal DISPATCHED_COMMANDS (missing: [${missing}] phantom: [${phantom}])`,
    );
  });
});
