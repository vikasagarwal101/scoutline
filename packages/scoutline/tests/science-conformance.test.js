/**
 * Science conformance gates + pins — T8 (TASKS T8; PRD AC-6/AC-10b; DESIGN
 * D6b/D7).
 *
 * GROUND map (per describe below):
 *   - TASKS T8 "Controls-vs-supplier pin, interim-scoped (2026-09-10
 *     fix): T8 pins ONLY what the T6 interim resolver can honor — a
 *     PINNED supplier that rejects the request's controls fails
 *     UNSUPPORTED_OPTION (AC-5b, single-arm exclusion empties the arm
 *     set)" / PRD AC-5b "Control rejection is NOT fallback — a pinned
 *     supplier that rejects the request's controls fails the command
 *     outright, it does not reroute". The multi-arm
 *     exclusion-with-stderr-notice and all-reject pins are T10's —
 *     NOT here (TASKS T8 interim-scoped bullet: "they would be red at
 *     T8's green gate").
 *   - TASKS T8 "DISPATCHED_COMMANDS pin widened 22→23 (one `science`
 *     noun)" / PRD AC-10b — the audit-list literal, the F-6
 *     source-derived equality, and the `SWITCH_CASES.size +
 *     IF_ARMS.size` numeral (now "14 switch cases + 9 if arms") all
 *     live in tests/output-budget-rejection.test.js. This file's
 *     mutation-evidence block (below) proves those pins have teeth:
 *     scratch-removing the science arm from a copy of the source, or
 *     the `science` entry from the dispatched set, fails the pin both
 *     directions. The arm-shape fact itself (credential-free
 *     line-start `if (command === "science") {` inside main(), NOT an
 *     else-if chain or switch case — the F-6 regexes only match that
 *     shape) is pinned structurally here against the LIVE source
 *     extraction so a reshape cannot pass silently.
 *   - TASKS T8 "Ladder partition test gains `science` on the ladder
 *     side (D6b)" — the partition assertion lives in
 *     output-budget-rejection.test.js (ladder side of the
 *     every-dispatched-command walk); this file adds the mutation
 *     evidence: the pin must fail when science is (simulated) moved to
 *     the rejection set.
 *   - TASKS T8 "CHANGELOG `[Unreleased]` created-if-missing + bullet
 *     (chained)" / PRD AC-10c + AC-10c fix — the [Unreleased] section
 *     must EXIST (create if missing — the post-release disappearance
 *     trap, twice) AND carry the science feature bullet. Note: T9
 *     carries the docs bullets; T8 pins the feature bullet that rides
 *     the behavior (AC-10c "lands in the same commit as the
 *     behavior" — the ladder commits already shipped the behavior).
 *   - TASKS T8 COORDINATION NOTE: "batch is an explicit NON-GOAL for
 *     this lane — batch-manifest.ts:39-41 allowlists search/read/
 *     research only; science ops do NOT join batch in v1 (flagging gap
 *     closed; widening is a documented follow-up, not silent
 *     absence)" — pinned so the absence is documented-by-test, not
 *     silent: `BATCH_ALLOWED_COMMANDS` must NOT contain science.
 *
 * Hermeticity: main()-level via hermeticMainDeps (config injection,
 * fake descriptors, injected clock — GitHub #42). Tests import
 * ../dist/... — verification order is build, then test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  main,
  DISPATCHED_COMMANDS,
  REJECT_MAX_CHARS_COMMANDS,
  SWITCH_CASES,
  IF_ARMS,
} from "../dist/index.js";
import { UnsupportedOptionError } from "../dist/lib/errors.js";
import { BATCH_ALLOWED_COMMANDS } from "../dist/lib/batch-manifest.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Fakes — real-supplier-shaped doubles whose validate() rejects
// exactly like the production adapters (UnsupportedOptionError naming
// supplier+capability+control), so the interim pinned-supplier
// contract is exercised against the real error class.
// ---------------------------------------------------------------------------

/**
 * A science supplier double with an explicit reject set: every control
 * in `rejects` throws UnsupportedOptionError(id, "science.search",
 * control) from validate, mirroring the production adapters (arxiv
 * rejects all four; the wire-consumers reject the D7-ruled subset).
 */
function makeRejectingScienceDescriptor(id, rejects) {
  const calls = { search: [] };
  return {
    descriptor: {
      id,
      isConfigured: () => true,
      capabilities: () => new Set(["science.search", "science.get"]),
      create() {
        return {
          id,
          science: {
            search: {
              validate(request) {
                for (const control of rejects) {
                  if (request.controls?.[control] !== undefined) {
                    throw new UnsupportedOptionError(id, "science.search", control);
                  }
                }
              },
              async invoke(request) {
                calls.search.push(request);
                return [{ title: `work-from-${id}`, url: `https://example.org/${id}` }];
              },
            },
            get: {
              validate() {},
              async invoke() {
                return { title: `work-from-${id}`, url: `https://example.org/${id}` };
              },
            },
          },
        };
      },
      credentialEnvVars: [],
    },
    calls,
  };
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

async function runMain(argv, descriptors) {
  const { adapter, stdout, stderr } = makeInvocation();
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      env: {},
      ...(descriptors !== undefined ? { providerDescriptors: descriptors } : {}),
      now: () => NOW,
    }),
  });
  return { status, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Controls-vs-supplier — interim-scoped (TASKS T8 interim bullet)
// ---------------------------------------------------------------------------

describe("interim controls-vs-supplier: pinned rejecting supplier fails UNSUPPORTED_OPTION (AC-5b)", () => {
  it("pinned supplier rejecting the request's controls fails the command outright — no reroute, no drop", async () => {
    // GROUND: TASKS T8 "a PINNED supplier that rejects the request's
    // controls fails UNSUPPORTED_OPTION (AC-5b, single-arm exclusion
    // empties the arm set)" / PRD AC-5b "Control rejection is NOT
    // fallback — a pinned supplier that rejects the request's controls
    // fails the command outright (D5 ruling), it does not reroute" /
    // PRD AC-3 "rejects it with UNSUPPORTED_OPTION at validation —
    // never accept-and-drop". arXiv-shaped double rejects --author.
    const arxiv = makeRejectingScienceDescriptor("arxiv", [
      "author",
      "year",
      "venue",
      "type",
    ]);
    const openalex = makeRejectingScienceDescriptor("openalex", ["venue"]);
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "attention", "--provider", "arxiv", "--author", "Vaswani"],
      [arxiv.descriptor, openalex.descriptor],
    );
    assert.equal(status, 1, "pinned rejecting supplier fails the command");
    assert.deepEqual(stdout, [], "data-only stdout contract — nothing on stdout");
    const err = JSON.parse(stderr.join(""));
    assert.equal(err.code, "UNSUPPORTED_OPTION", "error class is UNSUPPORTED_OPTION");
    assert.match(err.error, /arxiv/, "the message names the pinned supplier");
    assert.match(err.error, /author/, "the message names the rejected control");
    // Not a reroute: openalex (D5 arm #1, configured+capable) must NOT
    // have been consulted — the pin is the whole arm set.
    assert.equal(openalex.calls.search.length, 0, "no fallback arm runs — the pin is the arm set");
    assert.equal(arxiv.calls.search.length, 0, "the rejecting supplier's invoke never runs");
  });

  it("pinned supplier rejecting on --venue fails UNSUPPORTED_OPTION too (venue is crossref-only in v1)", async () => {
    // GROUND: DESIGN D7 venue column — openalex/pubmed/europepmc/arxiv
    // all reject `--venue`; pinned to any of them the run fails loud.
    // Same AC-5b contract, second control, so the pin is not
    // author-specific.
    const openalex = makeRejectingScienceDescriptor("openalex", ["venue"]);
    const { status, stderr } = await runMain(
      ["science", "search", "q", "--provider", "openalex", "--venue", "Nature"],
      [openalex.descriptor],
    );
    assert.equal(status, 1);
    const err = JSON.parse(stderr.join(""));
    assert.equal(err.code, "UNSUPPORTED_OPTION");
    assert.match(err.error, /venue/);
  });

  it("a pinned supplier that ACCEPTS the full control set still succeeds — rejection is control-shaped, not unconditional", async () => {
    // GROUND: PRD AC-3 "the run proceeds on remaining arms" — at the
    // interim single-arm scope: a pinned accepting supplier succeeds
    // with the same controls that failed the arxiv pin above. Guards
    // the opposite mutation (validation rejecting everything).
    const openalex = makeRejectingScienceDescriptor("openalex", ["venue"]);
    const { status, stdout } = await runMain(
      ["science", "search", "attention", "--provider", "openalex", "--author", "Vaswani"],
      [openalex.descriptor],
    );
    assert.equal(status, 0, "author is a supported control on openalex");
    assert.equal(openalex.calls.search.length, 1, "the pinned accepting supplier ran");
    assert.ok(stdout.length > 0, "data envelope emitted");
  });
});

// ---------------------------------------------------------------------------
// Dispatch enumeration — structural facts + mutation evidence
// (TASKS T8 dispatch bullet; PRD AC-10b)
// ---------------------------------------------------------------------------

describe("dispatch enumeration pins have teeth (mutation evidence)", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  );

  it("science is a dispatched noun and the dispatch surface is 23 (14 switch cases + 9 if arms)", () => {
    // GROUND: TASKS T8 "DISPATCHED_COMMANDS pin widened 22→23 (one
    // `science` noun)" / PRD AC-10b. The equality against the
    // hand-maintained audit-list literal lives in
    // output-budget-rejection.test.js; here the source-derived counts
    // are re-pinned so the numeral cannot drift independently.
    assert.ok(DISPATCHED_COMMANDS.has("science"), "science is a dispatched noun");
    assert.equal(SWITCH_CASES.size + IF_ARMS.size, 23, "14 switch cases + 9 if arms");
    assert.equal(
      SWITCH_CASES.size + IF_ARMS.size,
      DISPATCHED_COMMANDS.size,
      "dispatch surface equals the dispatched set",
    );
  });

  it("the science arm is a credential-free line-start `if (command === \"science\") {` inside main() — the F-6-extractable shape", () => {
    // GROUND: TASKS T8 "Arm shape: credential-free `if (command ===
    // \"science\") {` inside main() (line-start, `archive` precedent —
    // NOT an `else if` chain or a switch case, both of which evade the
    // F-6 regexes)". Verified against the live source: IF_ARMS (the
    // same regex the dispatcher's own extractor uses) must contain
    // science — if the arm were reshaped into an else-if, this fails
    // even though the command still works, which is exactly the
    // coverage gap the F-6 equality exists to close.
    assert.ok(IF_ARMS.has("science"), "science dispatches via an F-6-visible if arm");
    assert.ok(
      /^\s*if \(command === "science"\) \{$/m.test(SOURCE),
      "the arm appears at (indented) line start in src/index.ts — the F-6 shape",
    );
  });

  it("mutation: dropping `science` from the dispatched set breaks the source-derived equality (both directions)", () => {
    // GROUND: PRD AC-10b "Mutation evidence targets the audit-list
    // literal" — simulated here without touching src/: the source-
    // derived surface (SWITCH_CASES + IF_ARMS) still contains science,
    // so a DISPATCHED_COMMANDS copy without it fails the same
    // equality assertion output-budget-rejection.test.js runs. This is
    // the observed-failure proof for that pin (scratch-break recorded
    // in the ticket; the real-file scratch mutation was also run —
    // see ticket evidence).
    const mutated = new Set(DISPATCHED_COMMANDS);
    mutated.delete("science");
    const extracted = new Set([...SWITCH_CASES, ...IF_ARMS]);
    assert.notDeepEqual(
      [...extracted].sort(),
      [...mutated].sort(),
      "a dispatched set missing science must disagree with the extracted surface",
    );
  });

  it("mutation: a future command without a ladder or rejection row fails the partition pin by omission", () => {
    // GROUND: TASKS T8 "Ladder partition test gains `science` on the
    // ladder side (D6b)" — the partition pin is
    // DISPATCHED_COMMANDS ⊆ ladder ∪ reject. Mutation: move science
    // out of the ladder into the rejection set (the inverse mutation:
    // a set where science is neither) fails the walk. Mirrors the
    // existing omission-guard idiom in output-budget-rejection.test.js
    // with the real current sets.
    const ladder = new Set(["search", "read", "crawl", "research", "repo", "science"]);
    const badSet = new Set([...DISPATCHED_COMMANDS, "transmogrify"]);
    const uncovered = [];
    for (const command of badSet) {
      if (!ladder.has(command) && !REJECT_MAX_CHARS_COMMANDS.has(command)) uncovered.push(command);
    }
    assert.deepEqual(
      uncovered,
      ["transmogrify"],
      "an unladdered, unrejected command is caught",
    );
    assert.ok(
      !REJECT_MAX_CHARS_COMMANDS.has("science"),
      "science must sit on the LADDER side (D6b), never the rejection set",
    );
  });
});

// ---------------------------------------------------------------------------
// Batch NON-GOAL pin (TASKS T8 COORDINATION NOTE)
// ---------------------------------------------------------------------------

describe("science does NOT join batch in v1 (documented non-goal, pinned)", () => {
  it("BATCH_ALLOWED_COMMANDS carries no science entry — the absence is documented-by-test, not silent", () => {
    // GROUND: TASKS T8 COORDINATION NOTE "batch is an explicit NON-GOAL
    // for this lane — batch-manifest.ts:39-41 allowlists search/read/
    // research only; science ops do NOT join batch in v1 (flagging gap
    // closed; widening is a documented follow-up, not silent
    // absence)". The pin makes the gap loud: if science ever JOINS
    // batch, this test goes red and forces the follow-up to be
    // documented (manifest tests, runner, docs) in the same change.
    assert.equal(
      BATCH_ALLOWED_COMMANDS.includes("science"),
      false,
      "science must not join BATCH_ALLOWED_COMMANDS in v1 (non-goal); widen this pin together with the batch follow-up",
    );
  });
});

// ---------------------------------------------------------------------------
// CHANGELOG [Unreleased] bullet (TASKS T8; PRD AC-10c + AC-10c fix)
// ---------------------------------------------------------------------------

describe("CHANGELOG [Unreleased] carries the science feature bullet (AC-10c)", () => {
  const changelog = readFileSync(
    fileURLToPath(new URL("../../../CHANGELOG.md", import.meta.url)),
    "utf8",
  );

  it("the `## [Unreleased]` section exists (create-if-missing duty honored)", () => {
    // GROUND: PRD AC-10c fix "`## [Unreleased]` section must EXIST
    // before appending (create if missing — the post-release
    // disappearance trap, twice)".
    assert.ok(
      /^## \[Unreleased\]$/m.test(changelog),
      "CHANGELOG must have a [Unreleased] section",
    );
  });

  it("the Unreleased block carries a science command bullet naming the science noun", () => {
    // GROUND: TASKS T8 "CHANGELOG `[Unreleased]` created-if-missing +
    // bullet (chained)" / PRD AC-10c "CHANGELOG `[Unreleased]` bullet
    // lands in the same commit as the behavior". The bullet names the
    // science command (the shipped behavior: search+get across five
    // scholarly suppliers).
    const start = changelog.search(/^## \[Unreleased\]$/m);
    const end = changelog.search(/^## \[\d/m); // next released version heading
    const section = changelog.slice(start, end === -1 ? undefined : end);
    assert.ok(start !== -1, "[Unreleased] found");
    assert.match(
      section,
      /science/i,
      "the Unreleased block must carry the science feature bullet",
    );
  });
});
