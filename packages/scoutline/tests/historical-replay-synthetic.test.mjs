// SYNTHETIC regression suite for the software requirements formerly
// exercised by the unavailable historical evaluation04/05 replay guards.
//
// This is NEW evidence only: it does NOT attest that the original 16
// recorded-response replay assertions pass, and it does not merge into any
// historical outcome claim. The historical gates live in
// tests/historical-replay/*.recovery.mjs and stay UNAVAILABLE (failing
// explicitly) until the exact sanitized originals are recovered.
//
// Requirements covered (from the lost guards' software semantics, asserted
// against the in-tree synthetic corpus and offline protocol fixtures):
//   1. final-context retention: a trusted final-context accepted guide
//      survives later unknown-support candidates and cache iteration
//   2. prerequisite reconciliation: dependent work is attempted with the
//      prerequisite's exact accepted value/provenance binding; unrecorded
//      dependent work produces an explicit unresolved reason, never an
//      invented acceptance
//   3. material conflict/stale-context prohibition: a clear final-context
//      conflict blocks reuse of support accepted on a smaller context
//   4. explicit unresolved reasons: failed contrary coverage yields a
//      named reason (counterevidence_not_acquired), not internal_stop
//   5. physical extraction cap attribution: a pre-dispatch cap throw is
//      recorded as cap, not network failure or deadline
//
// Discrimination (teeth) proof: every semantic guard is paired with a
// control that flips the engine outcome, so a regression to the pre-fix
// mechanism (accepted-guide loss, stale-context reuse, internal_stop
// fallback) is observable as a concrete assertion failure.
import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

test("synthetic retention: trusted final-context guide license survives later unknown candidate and re-assessment", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "birch-progressive"));
  const { deps, calls } = offlineDeps(c);
  const judge = deps.candidateJudge;
  let sawFinalGuideLicense = false;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    if (
      input.source.evidenceId === "e2" &&
      input.opposingContext.length >= 1 &&
      input.candidates.some((x) => x.fieldId === "license")
    ) {
      sawFinalGuideLicense = true;
      // A later unknown-support candidate must not dislodge the trusted
      // final-context acceptance (unknown = neither support nor conflict).
      r.answers[`q${input.candidates.findIndex((x) => x.fieldId === "license")}s`] = {
        type: "noul",
        noul: 0.5,
      };
    }
    return r;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(sawFinalGuideLicense, "final-context license was actually assessed");
  assert.equal(result.data.version, "5.1");
  assert.equal(
    result.data.license,
    "Apache-2.0",
    "trusted final-context guide license must survive later unknown support",
  );
  assert(
    ["e2", "e3"].includes(result.requirements.license.provenance.sourceId),
    "accepted license retains a trusted final-context provenance",
  );
  assert(calls.candidateJudge.length > 0, "cache iteration still re-assessed");
});

test("synthetic retention teeth: clearing the same final-context support loses the license", async () => {
  // Control for the guard above: the SAME run with final-context support
  // flipped to unknown must NOT accept the license. If this control ever
  // accepts, the retention assertion above is pinning nothing.
  const c = structuredClone(inputs.find((x) => x.id === "birch-progressive"));
  const { deps } = offlineDeps(c);
  const judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    if (
      (input.source.evidenceId === "e2" || input.source.evidenceId === "e3") &&
      input.opposingContext.length >= 1 &&
      input.candidates.some((x) => x.fieldId === "license")
    ) {
      // BOTH final guide sources conflicted: no trusted final-context
      // license acceptance can survive anywhere.
      const i = input.candidates.findIndex((x) => x.fieldId === "license");
      r.answers[`q${i}s`] = { type: "noul", noul: 0.5 };
      r.answers[`q${i}c`] = { type: "noul", noul: 0.97 }; // clear conflict
    }
    return r;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(
    !("license" in result.data),
    "clear final-context conflict must block license acceptance",
  );
  assert.equal(result.data.version, "5.1");
});

test("synthetic prerequisite reconciliation: dependent candidate binds exact accepted prerequisite value and provenance", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "birch-progressive"));
  const { deps, calls } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.data.version, "5.1");
  assert.equal(result.data.license, "Apache-2.0");
  const license = result.requirements.license;
  const bindingInput = calls.candidateJudge.find((x) =>
    x.candidates.some((y) => y.fieldId === "license"),
  );
  assert(bindingInput, "dependent license work was attempted");
  assert.equal(
    bindingInput.depBindings?.version?.value,
    result.data.version,
    "dependent judged under the exact accepted prerequisite value",
  );
  assert.equal(
    bindingInput.depBindings?.version?.evidenceId,
    result.requirements.version.provenance.sourceId,
    "dependent binds the accepted prerequisite evidence id",
  );
  assert.match(bindingInput.depBindings.version.sourceDigest, /^[a-f0-9]{64}$/);
});

test("synthetic reconciliation teeth: missing dependent acceptance yields explicit unresolved status, never invented data", async () => {
  // Keep the prerequisite satisfied but make every dependent license
  // judgment return unknown support: license must stay explicitly
  // unresolved with a recorded reason — no silent acceptance, no
  // internal_stop fallback.
  const c = structuredClone(inputs.find((x) => x.id === "birch-progressive"));
  const { deps } = offlineDeps(c);
  const judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    if (input.candidates.some((x) => x.fieldId === "license"))
      for (const [k, v] of Object.entries(r.answers))
        if (k.endsWith("s")) r.answers[k] = { type: "noul", noul: 0.5 };
    return r;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.data.version, "5.1");
  assert(!("license" in result.data), "unknown support cannot produce acceptance");
  assert.equal(result.requirements.license.status, "unresolved");
  assert.equal(typeof result.requirements.license.reason, "string");
  assert(result.requirements.license.reason.length > 0);
  assert.notEqual(result.requirements.license.reason, "internal_stop");
});

test("synthetic stale-context prohibition: support accepted on smaller context cannot satisfy final conflicting context", async () => {
  // License accepted on the guide-only context, then a revision of the
  // same guide ID invalidates earlier validations: the stale smaller-
  // context acceptance must not authorize final publication.
  const c = structuredClone(inputs.find((x) => x.id === "aster-clean"));
  const { deps, live } = offlineDeps(c, { captureLiveTargets: true });
  const judge = deps.candidateJudge;
  let mutated = false;
  let sawFullGuideLicense = false;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    if (
      input.source.evidenceId === "e1" &&
      input.opposingContext.length === 1 &&
      input.candidates.some((x) => x.fieldId === "license")
    ) {
      sawFullGuideLicense = true;
      if (!mutated) {
        mutated = true;
        live.reviseSource(live.retained.get(input.source.evidenceId), (source) => {
          source.content += "\nSame-ID revision invalidates earlier validated candidate.";
        });
      }
    }
    return r;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(sawFullGuideLicense, "final guide license assessment occurred");
  assert(
    !("license" in result.data),
    "same-ID revision must invalidate the earlier validated candidate",
  );
});

test("synthetic explicit reasons: failed mandatory contrary read ends in counterevidence_not_acquired, not internal_stop", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "cedar-challenge-failed"));
  const { deps } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert.deepEqual(result.data, {}, "no acceptance without contrary coverage");
  assert.equal(result.requirements.version.reason, "counterevidence_not_acquired");
  assert.equal(
    result.requirements.license.reason,
    "prerequisite_unresolved:version",
    "dependent explicitly names its blocked prerequisite",
  );
  for (const row of Object.values(result.requirements))
    assert.notEqual(row.reason, "internal_stop");
});

test("synthetic cap attribution: pre-dispatch extraction cap records global_extraction_cap with explicit reason", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  c.contract.requirements.version.criteria.push(
    "Require two independently extracted source witnesses before this field is fulfilled.",
  );
  const { deps } = offlineDeps(c);
  let physical = 0;
  const original = deps.extract;
  deps.extract = async (input) => {
    if (physical === 1)
      throw Object.assign(Error("physical extraction cap reserved before dispatch"), {
        code: "EVAL_STOPPED",
        reason: "global_extraction_cap",
      });
    physical++;
    return original(input);
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(physical, 1);
  assert(!("version" in result.data));
  assert.equal(result.requirements.version.reason, "global_extraction_cap");
});

test("synthetic positive control: clean case completes all fields end to end", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "aster-clean"));
  const { deps } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.data, { version: "2.4", license: "MIT", csv: "supported" });
});

// Generic current-source/contrary invariants, preserved verbatim from the
// retired witness-first pilot guard file (2026-10-15 subtractive cleanup):
// the bodies predate and outlive the pilot — contrary-read retry accounting
// and no-retrospective-shortcut ordering are engine invariants, not pilot
// screens. setup() inline replacement noted per test.
test("failed required opposition read never qualifies one-sided witness", async () => {
  const c = structuredClone(inputs[0]);
  c.contract.requirements = { version: c.contract.requirements.version };
  c.sources[1].readError = "fixture_read_failed";
  const { deps, calls } = offlineDeps(c);
  const r = await runLeanInvestigation(c.contract, deps);
  assert.equal(
    calls.read.length,
    3,
    "failed contrary source is retried within existing acquisition",
  );
  assert(!("version" in r.data));
  assert.equal(r.requirements.version.reason, "counterevidence_not_acquired");
});
test("pending other-field contrary query prevents retrospective final-set shortcut", async () => {
  const c = structuredClone(inputs[0]);
  const { deps, calls } = offlineDeps(c);
  const extract = deps.extract;
  let observedPending = false;
  deps.extract = async (input) => {
    if (input.fields[0].id === "version" && input.sourceId === "e2") {
      assert(
        !calls.search.includes(`${c.contract.requirements.csv.question} contrary evidence refuted`),
      );
      observedPending = true;
    }
    return extract(input);
  };
  await runLeanInvestigation(c.contract, deps);
  assert(
    observedPending,
    "a full eventual source-set witness must not qualify while acquisition can still enlarge context",
  );
});
