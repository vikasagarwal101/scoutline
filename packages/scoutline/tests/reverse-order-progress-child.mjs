// Test-local replacement child for the frozen /tmp/opencode child
// (e2fdf64f2dc747fb22407a4819c423746ddcff5a68ef5e779dea034149f3ff7a),
// whose exact bytes are unrecoverable. Rebuilt from the review recipe in
// epic artifact independent-review/reverse-order-final-cold-review
// ("Frozen Aster synthetic contract, with CSV classification depending on
// license, which already depends on version ... append a sentence to that
// guide with the same ID ... clock remains 0"). This is a NEW synthetic
// guard with the same purpose and assertions, not a byte-identical
// recovery: documented original-missing limitation.
import { writeSync } from "node:fs";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

const [mode, slowStartupMs = "0", stallMs = "0"] = process.argv.slice(2);
// Synchronous main-thread block: the event loop never turns while it runs.
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Reverse-declaration-order chain: leaf declared first, prerequisite
// (version) declared last.
const c = structuredClone(inputs.find((x) => x.id === "aster-clean"));
c.contract.requirements = {
  csv: c.contract.requirements.csv,
  license: c.contract.requirements.license,
  version: c.contract.requirements.version,
};
c.contract.requirements.license.dependsOn = ["version"];
c.contract.requirements.csv.dependsOn = ["license"];
// Protocol-valid unknown license support keeps license nonterminal after
// its full-context assessment (the offline collaborator's default .97/.01
// would otherwise accept every candidate); csv then has no eligible turn
// in either mode.
const { deps, calls, live } = offlineDeps(c, { captureLiveTargets: true });
const judge = deps.candidateJudge;
let guideRef = null;
let lastGuideLicenseNow = null;
deps.candidateJudge = async (input, options) => {
  if (input.source.evidenceId === "e1") guideRef = live.retained.get(input.source.evidenceId);
  const r = await judge(input, options);
  if (input.candidates.some((x) => x.fieldId === "license")) {
    for (const k of Object.keys(r.answers)) r.answers[k] = { type: "noul", noul: 0.5 };
    if (input.source.evidenceId === "e1" && input.opposingContext.length === 1)
      lastGuideLicenseNow = nowN;
  }
  return r;
};

// Mode "revise": the revision lands at the first post-terminalization
// now() read after the final full-context guide license judgment. The
// standing version accept then fails its live proof (same-ID content
// revision) before version finalizes, so version, license and csv stay
// required nonterminal waiters and the run ends at the acquisition
// no-progress break, never reaching the no-eligible branch. Mode
// "unchanged": no mutation — version stays accepted, license/csv are
// published only when eligible (they are not).
//
// Mode "terminal": version's contrary query is the plan's last search.
// The revision lands at the first loop entry after that search's
// mid-loop finalization made version terminally satisfied (the
// standing-terminal recipe). Its accept then fails the live proof, so
// license is blocked (no unblocking proof) yet actionable: its
// prerequisite is terminally satisfied and its judged dependency
// binding no longer exists. With judge budget left and no eligible
// field, the scheduler re-enters on that wait-set. The re-entry pass
// changes nothing, so the next pass sees the identical wait-set.
let nowN = 0;
let mutated = false;
let armed = false;
let readsSinceFinalSearch = 0;
let readsAfterRevision = 0;
const search = deps.search;
deps.search = async (query, options) => {
  const results = await search(query, options);
  if (query === `${c.contract.requirements.version.question} contrary evidence refuted`)
    armed = true;
  return results;
};
deps.now = () => {
  nowN += 1;
  if (mutated) readsAfterRevision += 1;
  if (
    (mode === "revise" &&
      !mutated &&
      lastGuideLicenseNow !== null &&
      nowN > lastGuideLicenseNow + 1) ||
    (mode === "terminal" && !mutated && armed && ++readsSinceFinalSearch === 2)
  ) {
    mutated = true;
    live.reviseSource(guideRef, (guideRef) => {
      guideRef.content += "\nSame-ID revision invalidates earlier validated candidate.";
    });
  }
  return 0;
};

// Parent-requested synchronous scheduler stall: the scheduler's first clock
// read blocks past the stall budget, like a no-eligible re-entry spinning
// without yielding under a frozen clock. One bounded block, so a dead
// watchdog fails its pin instead of hanging the suite.
if (stallMs !== "0") {
  const read = deps.now;
  let first = true;
  deps.now = () => {
    if (first) block(Number(stallMs));
    first = false;
    return read();
  };
}

// Startup boundary: fd 3 reports that module loading and harness setup,
// including the stall hook above, are complete, so the parent's stall
// budget starts with the scheduler run. A parent-requested slow startup
// blocks before the boundary.
block(Number(slowStartupMs));
writeSync(3, "ready\n");

const result = await runLeanInvestigation(c.contract, deps);
process.stdout.write(
  JSON.stringify({ data: result.data, status: result.status, nowReads: nowN, readsAfterRevision }) +
    "\n",
);
