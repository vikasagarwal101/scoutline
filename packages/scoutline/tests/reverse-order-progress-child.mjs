// Test-local replacement child for the frozen /tmp/opencode child
// (e2fdf64f2dc747fb22407a4819c423746ddcff5a68ef5e779dea034149f3ff7a),
// whose exact bytes are unrecoverable. Rebuilt from the review recipe in
// epic artifact independent-review/reverse-order-final-cold-review
// ("Frozen Aster synthetic contract, with CSV classification depending on
// license, which already depends on version ... append a sentence to that
// guide with the same ID ... clock remains 0"). This is a NEW synthetic
// guard with the same purpose and assertions, not a byte-identical
// recovery: documented original-missing limitation.
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

const mode = process.argv[2];

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
deps.candidateJudge = async (input) => {
  if (input.source.evidenceId === "e1") guideRef = live.retained.get(input.source.evidenceId);
  const r = await judge(input);
  if (input.candidates.some((x) => x.fieldId === "license")) {
    for (const k of Object.keys(r.answers)) r.answers[k] = { type: "noul", noul: 0.5 };
    if (input.source.evidenceId === "e1" && input.opposingContext.length === 1)
      lastGuideLicenseNow = nowN;
  }
  return r;
};

// Mode "revise": the revision lands at the first post-terminalization
// now() read after the final full-context guide license judgment. The
// terminal version accept then fails its live proof (same-ID content
// revision), license and csv stay required nonterminal waiters, and the
// no-eligible re-entry path must terminate under the frozen clock
// instead of spinning. Mode "unchanged": no mutation — version stays
// accepted, license/csv are published only when eligible (they are not).
let nowN = 0;
let mutated = false;
const baseNow = deps.now;
deps.now = () => {
  nowN += 1;
  if (
    mode === "revise" &&
    !mutated &&
    lastGuideLicenseNow !== null &&
    nowN > lastGuideLicenseNow + 1
  ) {
    mutated = true;
    live.reviseSource(guideRef, (guideRef) => {
      guideRef.content += "\nSame-ID revision invalidates earlier validated candidate.";
    });
  }
  return 0;
};

const result = await runLeanInvestigation(c.contract, deps);
process.stdout.write(
  JSON.stringify({ data: result.data, status: result.status, nowReads: nowN }) + "\n",
);
