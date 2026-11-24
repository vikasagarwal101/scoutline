/**
 * Evidence-backed implementation audit — first-slice consumer tests
 * (docs/plans/v3/FIRST-SLICE.json acceptance cases; review-repair round 1).
 *
 * 100% offline: the pinned snapshot, the trusted read seam and the
 * deterministic literal judge are fixtures. No network, no repository
 * execution, no behavioral probes.
 *
 * Review-repair controls baked in:
 *   - exact claim/snapshot revision agreement (different pins never conflate);
 *   - accepted findings are LITERAL predicates only — reachability and
 *     runtime claims stay unresolved by policy, however supportive the
 *     source text looks;
 *   - abstention on any incomplete basis (both polarities): acquisition
 *     order cannot change a verdict (no side-history flips) and a missing
 *     file cannot be masked by another file's failing literals;
 *   - consumer-owned frozen fixture bytes; relevant-only bounded index;
 *   - refusal kinds classified verbatim.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  runImplementationAudit,
  compileAuditClaimSet,
  compilePinnedSnapshot,
  createSnapshotReadDeps,
  snapshotFileUrl,
  SnapshotRefusalError,
  AUDIT_CEILINGS,
} from "../dist/lib/implementation-audit.js";

// ---------------------------------------------------------------------------
// Fixtures — synthetic CLI repository "fixture-cli" pinned to one revision
// ---------------------------------------------------------------------------

const REPO = "fixture-cli";
const PIN = "f100000000000000000000000000000000000000";
const OTHER_COMMIT = "0bad00000000000000000000000000000000000f";

const REGISTRY = `export const commands = ["help", "version", "inspect"];\n`;
const DISPATCHER_WIRED = `import { inspectHandler } from "./inspect-handler.js";\nroute("help", helpHandler);\nroute("inspect", inspectHandler);\n`;
const DISPATCHER_UNWIRED = `import { helpHandler } from "./help-handler.js";\nroute("help", helpHandler);\n`;
const HANDLER = `export function inspectHandler(argv) {\n  // Runtime behavior is not assessed from source.\n}\n`;
const README = `# fixture-cli\nThe inspect command prints a JSON report and works without network access.\n`;
const VERSION = `export const CLI_VERSION = "1.0.0";\n`;

const sha256 = (content) => createHash("sha256").update(content, "utf8").digest("hex");

function snap(files) {
  return {
    repository: REPO,
    revision: PIN,
    files: files.map(([path, revision, content]) => ({
      path,
      revision,
      content,
      sha256: sha256(content),
    })),
  };
}

const FULLY_WIRED = snap([
  ["src/registry.ts", PIN, REGISTRY],
  ["src/dispatcher.ts", PIN, DISPATCHER_WIRED],
  // Unrelated files: never indexed, hashed as evidence, or read.
  ["src/inspect-handler.ts", PIN, HANDLER],
  ["README.md", PIN, README],
]);

function standardClaims() {
  return {
    schemaVersion: 1,
    repository: REPO,
    revision: PIN,
    claims: [
      {
        id: "inspect-literals-present",
        text: 'Pinned src/registry.ts lists "inspect" and src/dispatcher.ts contains route("inspect", inspectHandler).',
        proofClass: "literal",
        checks: [
          { path: "src/registry.ts", allOf: ['"inspect"'] },
          { path: "src/dispatcher.ts", allOf: ['route("inspect", inspectHandler)'] },
        ],
        criteria: [
          "Literal predicates only: a finding asserts presence at the pinned revision, not active code.",
        ],
      },
      {
        id: "inspect-reachable",
        text: "The pinned snapshot dispatches the inspect command to its handler (public reachability).",
        proofClass: "reachability",
        checks: [{ path: "src/dispatcher.ts", allOf: ['route("inspect", inspectHandler)'] }],
      },
      {
        id: "inspect-works-offline",
        text: "The inspect command completes without network access.",
        proofClass: "runtime",
        checks: [],
      },
    ],
  };
}

const literalClaim = (report) => report.claims.find((c) => c.id === "inspect-literals-present");
const reachClaim = (report) => report.claims.find((c) => c.id === "inspect-reachable");
const runtimeClaim = (report) => report.claims.find((c) => c.id === "inspect-works-offline");

// ---------------------------------------------------------------------------
// Acceptance case 1 — registered and reachable (+ reachability/runtime
// claims unresolved by policy)
// ---------------------------------------------------------------------------

describe("implementation audit: registered-and-reachable", () => {
  it("supports the literal claim with a verified pin; reachability and runtime stay unresolved", async () => {
    const report = await runImplementationAudit(standardClaims(), FULLY_WIRED);

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.repository, REPO);
    assert.equal(report.revision, PIN);
    assert.equal(report.assessment, "semantic");
    // Mandatory reachability/runtime claims are open — partial is honest.
    assert.equal(report.status, "partial");

    // Literal claim: supported through the engine's acceptance path, with
    // zero judgment inconsistency (no side flips).
    const st = literalClaim(report);
    assert.equal(st.status, "supported");
    assert.equal(st.engine.status, "satisfied");
    assert.equal(st.engine.value, "supported");
    assert.equal(st.engine.inconsistentJudgments, 0);
    assert.ok(st.engine.judgmentCount >= 1);

    // Verified pin: every declared file retained at the pinned revision
    // with the consumer-recorded digest and a locator for each literal.
    assert.deepEqual(
      st.basis.map((b) => b.path).sort(),
      ["src/dispatcher.ts", "src/registry.ts"],
    );
    for (const b of st.basis) {
      assert.ok(b.retained, `${b.path} must be retained`);
      assert.equal(b.revision, PIN);
      assert.equal(b.missing.length, 0);
      const fixture = FULLY_WIRED.files.find((f) => f.path === b.path);
      assert.equal(b.sha256, fixture.sha256);
      for (const m of b.matched) {
        const [start, end] = m.charRange;
        const source = fixture.content;
        assert.ok(source.slice(start, end) === m.literal, "charRange must locate the literal");
      }
    }

    // Bounded index: only claim-relevant files were acquired — the
    // handler and README never entered evidence or the read budget.
    assert.deepEqual(
      report.evidence.map((e) => e.path).sort(),
      ["src/dispatcher.ts", "src/registry.ts"],
    );
    for (const ev of report.evidence) {
      assert.equal(ev.revision, PIN);
      assert.match(ev.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(report.refusals.length, 0);

    // Reachability: literal evidence is inadmissible — unresolved BY POLICY,
    // even though the dispatcher literal is present and reported as fact.
    const rc = reachClaim(report);
    assert.equal(rc.status, "unresolved");
    assert.equal(rc.unresolvedReason, "reachability_not_provable_from_literal_evidence");
    assert.equal(rc.engine.status, "unresolved");
    assert.ok(
      report.abstentions.some(
        (a) => a.fieldId === "inspect-reachable" && a.reason === "reachability_not_provable_from_literal_evidence",
      ),
    );
    const rcBasis = rc.basis.find((b) => b.path === "src/dispatcher.ts");
    assert.ok(rcBasis.retained);
    assert.equal(rcBasis.missing.length, 0);

    // Runtime: static source is inadmissible.
    assert.equal(runtimeClaim(report).unresolvedReason, "no_authorized_runtime_probe");

    // Honest coverage notes: literal-only scope and closed-scope acquisition.
    assert.ok(report.coverageNotes.some((n) => n.includes("literal-presence")));
    assert.ok(report.coverageNotes.some((n) => n.includes("closed-scope")));
    assert.ok(report.coverageNotes.some((n) => n.includes("not commit membership")));

    // Report immutability (PR #304 thread 2): the ENTIRE owned report is
    // frozen — claim rows, nested basis rows, matched locators with their
    // charRanges, engine projections and usage — so accepted findings and
    // provenance cannot be rewritten after the audit.
    assert.ok(Object.isFrozen(report.claims[0]));
    assert.ok(Object.isFrozen(report.evidence[0]));
    assert.ok(Object.isFrozen(report.claims));
    assert.ok(Object.isFrozen(st.basis));
    const basisRow = st.basis.find((b) => b.path === "src/dispatcher.ts");
    assert.ok(Object.isFrozen(basisRow));
    assert.ok(Object.isFrozen(basisRow.matched));
    assert.ok(Object.isFrozen(basisRow.matched[0]));
    assert.ok(Object.isFrozen(basisRow.matched[0].charRange));
    assert.ok(Object.isFrozen(basisRow.missing));
    assert.ok(Object.isFrozen(st.engine));
    assert.ok(Object.isFrozen(report.usage));
    assert.ok(Object.isFrozen(report.refusals));
    assert.ok(Object.isFrozen(report.abstentions));
    // Strict-mode mutation attempts throw (test files are ESM modules).
    assert.throws(() => { st.basis[0].missing.push("injected"); }, TypeError);
    assert.throws(() => { basisRow.matched[0].literal = "forged"; }, TypeError);
    assert.throws(() => { st.engine.value = "refuted"; }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// Acceptance case 2 — declared but unwired (complete basis, failing literal)
// ---------------------------------------------------------------------------

describe("implementation audit: declared-but-unwired", () => {
  it("refutes the literal predicate on the missing dispatch route; the holding registry conjunct cannot dispute it", async () => {
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", PIN, DISPATCHER_UNWIRED],
      ["src/inspect-handler.ts", PIN, HANDLER],
    ]);
    const report = await runImplementationAudit(standardClaims(), snapshot);

    const st = literalClaim(report);
    assert.equal(st.status, "refuted");
    assert.equal(st.engine.status, "satisfied");
    assert.equal(st.engine.value, "refuted");
    assert.equal(st.engine.inconsistentJudgments, 0);

    const dispatch = st.basis.find((b) => b.path === "src/dispatcher.ts");
    assert.ok(dispatch.retained);
    assert.equal(dispatch.revision, PIN);
    assert.deepEqual(dispatch.missing, ['route("inspect", inspectHandler)']);
    const registry = st.basis.find((b) => b.path === "src/registry.ts");
    assert.deepEqual(registry.missing, []);

    // Reachability/runtime: still unresolved regardless of the refutation.
    assert.equal(reachClaim(report).status, "unresolved");
    assert.equal(runtimeClaim(report).status, "unresolved");
  });
});

// ---------------------------------------------------------------------------
// Closed-evidence opt-in (v3 public integration): the read seam declares
// the claim-relevant universe to the engine, so coverage closure binds the
// EXACT declared sources (identity + digest) instead of trusting the
// scoped search to have enumerated completely.
// ---------------------------------------------------------------------------

describe("implementation audit: closed-evidence declaration", () => {
  it("declares the engine closed-evidence basis and keeps the refused path open", async () => {
    const report = await runImplementationAudit(standardClaims(), FULLY_WIRED);
    assert.ok(
      report.coverageNotes.some((n) => n.includes("closed-evidence-set")),
      "the engine's closed-set coverage note must surface in the audit report",
    );
    // The positive case still closes with the declared binding...
    assert.equal(literalClaim(report).status, "supported");
    // ...and the refused path (different commit) stays honestly open.
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", OTHER_COMMIT, DISPATCHER_WIRED],
      ["src/inspect-handler.ts", PIN, HANDLER],
    ]);
    const refused = await runImplementationAudit(standardClaims(), snapshot);
    const st = literalClaim(refused);
    assert.equal(st.status, "unresolved");
    assert.equal(st.unresolvedReason, "revision_mismatch:src/dispatcher.ts");
  });
});

// ---------------------------------------------------------------------------
// Acceptance case 3 — mismatched revision / runtime proof
// ---------------------------------------------------------------------------

describe("implementation audit: mismatched-or-runtime-proof", () => {
  it("refuses a required file from a different commit and leaves the claim unresolved", async () => {
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", OTHER_COMMIT, DISPATCHER_WIRED], // different commit
      ["src/inspect-handler.ts", PIN, HANDLER],
    ]);
    const report = await runImplementationAudit(standardClaims(), snapshot);

    const st = literalClaim(report);
    assert.equal(st.status, "unresolved");
    // Refusal kind classified verbatim — not folded into a generic reason.
    assert.equal(st.unresolvedReason, "revision_mismatch:src/dispatcher.ts");
    assert.ok(
      report.refusals.some(
        (r) => r.kind === "revision_mismatch" && r.url.includes("src/dispatcher.ts"),
      ),
    );
    assert.ok(
      report.acquisitionLog.some(
        (e) => e.kind === "read-failed" && e.detail.includes("src/dispatcher.ts"),
      ),
    );
    assert.ok(!report.evidence.some((e) => e.path === "src/dispatcher.ts"));
    for (const ev of report.evidence) assert.equal(ev.revision, PIN);

    // Frozen nested data on the unresolved path too: the observation row
    // (seam materialization of the refused other-commit file) and the
    // refusal records are owned frozen copies.
    const observedRow = st.basis.find((b) => b.path === "src/dispatcher.ts");
    assert.ok(Object.isFrozen(observedRow));
    assert.ok(Object.isFrozen(observedRow.observed));
    assert.ok(Object.isFrozen(observedRow.observed.matched));
    assert.ok(Object.isFrozen(observedRow.observed.matched[0].charRange));
    const refusal = report.refusals.find((r) => r.kind === "revision_mismatch");
    assert.ok(Object.isFrozen(refusal));

    assert.equal(runtimeClaim(report).unresolvedReason, "no_authorized_runtime_probe");
  });

  it("leaves a claim unresolved when a required file is absent from the snapshot", async () => {
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/inspect-handler.ts", PIN, HANDLER],
    ]);
    const report = await runImplementationAudit(standardClaims(), snapshot);
    const st = literalClaim(report);
    assert.equal(st.status, "unresolved");
    assert.equal(st.unresolvedReason, "missing_evidence:src/dispatcher.ts");
    const dispatch = st.basis.find((b) => b.path === "src/dispatcher.ts");
    assert.equal(dispatch.retained, false);
    assert.equal(dispatch.revision, null);
  });

  it("does not let a failing file mask a MISSING basis file (abstain on incomplete basis)", async () => {
    // Registry holds, dispatcher is present but FAILS its literals, and a
    // third declared file is absent: the basis is incomplete, so no
    // polarity may be reported — unresolved, never refuted.
    const claims = standardClaims();
    claims.claims[0] = {
      ...claims.claims[0],
      id: "three-part-literal",
      checks: [
        ...claims.claims[0].checks,
        { path: "src/usage.ts", allOf: ['command("usage"'] },
      ],
    };
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", PIN, DISPATCHER_UNWIRED], // would refute
      ["src/inspect-handler.ts", PIN, HANDLER], // src/usage.ts absent
    ]);
    const report = await runImplementationAudit(claims, snapshot);
    const st = report.claims.find((c) => c.id === "three-part-literal");
    assert.equal(st.status, "unresolved");
    assert.equal(st.unresolvedReason, "missing_evidence:src/usage.ts");
    assert.notEqual(st.status, "refuted");
    assert.equal(st.engine.inconsistentJudgments, 0);
  });
});

// ---------------------------------------------------------------------------
// Acquisition order — the verdict must not depend on read batching
// ---------------------------------------------------------------------------

describe("implementation audit: acquisition-order independence", () => {
  it("abstains while the basis is partial and accepts once complete, with zero inconsistency", async () => {
    // readBatchSize is 2: batch 1 retains version+registry while the
    // dispatcher is still pending. A judge that verdicted on that partial
    // basis would flip when the dispatcher lands — the engine would then
    // record inconsistent judgments and never accept. The abstaining judge
    // must leave nulls until the basis completes.
    const claims = standardClaims();
    claims.claims[0] = {
      ...claims.claims[0],
      id: "three-files-literal",
      checks: [
        { path: "src/version.ts", allOf: ["CLI_VERSION"] },
        { path: "src/registry.ts", allOf: ['"inspect"'] },
        { path: "src/dispatcher.ts", allOf: ['route("inspect", inspectHandler)'] },
      ],
    };
    const snapshot = snap([
      ["src/version.ts", PIN, VERSION],
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", PIN, DISPATCHER_WIRED], // arrives in batch 2
      ["README.md", PIN, README],
    ]);
    const report = await runImplementationAudit(claims, snapshot);
    const st = report.claims.find((c) => c.id === "three-files-literal");
    assert.equal(st.status, "supported");
    assert.equal(st.engine.status, "satisfied");
    assert.equal(st.engine.value, "supported");
    assert.equal(st.engine.inconsistentJudgments, 0);
    // The dispatcher WAS judged after arriving (null -> known is progress).
    assert.ok(st.engine.judgmentCount >= 2);
  });
});

// ---------------------------------------------------------------------------
// Exact pin agreement — claim set and snapshot must name the same revision
// ---------------------------------------------------------------------------

describe("implementation audit: exact revision agreement", () => {
  it("refuses to run when the claim set and snapshot pins differ", async () => {
    const claims = { ...standardClaims(), revision: OTHER_COMMIT };
    await assert.rejects(
      runImplementationAudit(claims, FULLY_WIRED),
      (error) => ValidationErrorLike(error) && /revision/i.test(error.message),
    );
    const foreignRepo = { ...standardClaims(), repository: "other-cli" };
    await assert.rejects(
      runImplementationAudit(foreignRepo, FULLY_WIRED),
      ValidationErrorLike,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-claim isolation — one claim's refused file must not block another
// (review fix2 P1: per-claim scoped acquisition)
// ---------------------------------------------------------------------------

describe("implementation audit: cross-claim isolation", () => {
  it("duplicate claim text cannot collide ownership: identical texts, distinct ids, refused file blocks only its owner", async () => {
    // Review fix3 P1: two DISTINCT claims render the same question body.
    // Without the unique claim-ID prefix the query plan would assign the
    // rendered query to one owner (last writer wins) and the other claim's
    // acceptance could be blocked by the owner's refused file.
    const sameText = "The declared command wiring is present in the pinned source.";
    const claims = {
      schemaVersion: 1,
      repository: REPO,
      revision: PIN,
      claims: [
        {
          id: "wiring-a",
          text: sameText,
          proofClass: "literal",
          checks: [
            { path: "src/registry.ts", allOf: ['"inspect"'] },
            { path: "src/dispatcher.ts", allOf: ['route("inspect", inspectHandler)'] },
          ],
        },
        {
          id: "wiring-b",
          text: sameText,
          proofClass: "literal",
          checks: [{ path: "src/version.ts", allOf: ["CLI_VERSION"] }],
        },
      ],
    };
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", OTHER_COMMIT, DISPATCHER_WIRED], // refused
      ["src/version.ts", PIN, VERSION],
    ]);
    const report = await runImplementationAudit(claims, snapshot);

    const a = report.claims.find((c) => c.id === "wiring-a");
    assert.equal(a.status, "unresolved");
    assert.equal(a.unresolvedReason, "revision_mismatch:src/dispatcher.ts");

    // The identically-worded claim with a complete basis is unaffected.
    const b = report.claims.find((c) => c.id === "wiring-b");
    assert.equal(b.status, "supported");
    assert.equal(b.engine.status, "satisfied");
    assert.equal(b.engine.inconsistentJudgments, 0);
  });

  it("duplicate text with an identical rendered basis: both claims assessed, neither swallowed", async () => {
    const sameText = "The version literal is present.";
    const claims = {
      schemaVersion: 1,
      repository: REPO,
      revision: PIN,
      claims: [
        {
          id: "version-first",
          text: sameText,
          proofClass: "literal",
          checks: [{ path: "src/version.ts", allOf: ["CLI_VERSION"] }],
        },
        {
          id: "version-second",
          text: sameText,
          proofClass: "literal",
          checks: [{ path: "src/version.ts", allOf: ["CLI_VERSION"] }],
        },
      ],
    };
    const snapshot = snap([["src/version.ts", PIN, VERSION]]);
    const report = await runImplementationAudit(claims, snapshot);
    for (const claim of report.claims) {
      assert.equal(claim.status, "supported", `${claim.id} must be assessed`);
      assert.equal(claim.engine.inconsistentJudgments, 0);
    }
  });

  it("accepts a complete-basis claim while another claim's file is refused", async () => {
    const claims = {
      schemaVersion: 1,
      repository: REPO,
      revision: PIN,
      claims: [
        {
          id: "blocked-claim",
          text: "Claim whose dispatcher came from a different commit.",
          proofClass: "literal",
          checks: [
            { path: "src/registry.ts", allOf: ['"inspect"'] },
            { path: "src/dispatcher.ts", allOf: ['route("inspect", inspectHandler)'] },
          ],
        },
        {
          id: "clean-claim",
          text: "Pinned src/version.ts contains CLI_VERSION.",
          proofClass: "literal",
          checks: [{ path: "src/version.ts", allOf: ["CLI_VERSION"] }],
        },
      ],
    };
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", OTHER_COMMIT, DISPATCHER_WIRED], // refused
      ["src/version.ts", PIN, VERSION],
    ]);
    const report = await runImplementationAudit(claims, snapshot);

    const blocked = report.claims.find((c) => c.id === "blocked-claim");
    assert.equal(blocked.status, "unresolved");
    assert.equal(blocked.unresolvedReason, "revision_mismatch:src/dispatcher.ts");

    // The clean claim is NOT tainted by the other claim's refusal.
    const clean = report.claims.find((c) => c.id === "clean-claim");
    assert.equal(clean.status, "supported");
    assert.equal(clean.engine.status, "satisfied");
    assert.equal(clean.engine.inconsistentJudgments, 0);

    // Observation preserved with locators for the refused file: the seam's
    // own verified copy of the OTHER-commit dispatcher still shows the
    // literal — as an observation, never acceptance evidence.
    const observedRow = blocked.basis.find((b) => b.path === "src/dispatcher.ts");
    assert.equal(observedRow.retained, false);
    assert.ok(observedRow.observed);
    assert.equal(observedRow.observed.revision, OTHER_COMMIT);
    assert.equal(observedRow.observed.missing.length, 0);
    for (const m of observedRow.observed.matched) {
      assert.ok(DISPATCHER_WIRED.slice(...m.charRange) === m.literal);
    }
  });
});

// ---------------------------------------------------------------------------
// Ceilings — bounds enforced before any walk, copy or hash
// ---------------------------------------------------------------------------

describe("implementation audit: bounded ceilings", () => {
  it("rejects claim sets over the engine field ceiling", () => {
    const four = [1, 2, 3, 4].map((n) => ({
      id: `claim-${n}`,
      text: `Claim ${n}.`,
      proofClass: "literal",
      checks: [{ path: `src/f${n}.ts`, allOf: ["x"] }],
    }));
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), claims: four }),
      (error) => ValidationErrorLike(error) && /field ceiling/.test(error.message),
    );
  });

  it("rejects per-claim check count and per-check clause count over ceiling", () => {
    const manyChecks = Array.from({ length: 7 }, (_, i) => ({
      path: `src/f${i}.ts`,
      allOf: ["x"],
    }));
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], checks: manyChecks }],
        }),
      (error) => ValidationErrorLike(error) && /per-claim ceiling/.test(error.message),
    );
    const manyClauses = Array.from({ length: 9 }, () => "x");
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            { ...standardClaims().claims[0], checks: [{ path: "src/registry.ts", allOf: manyClauses }] },
          ],
        }),
      (error) => ValidationErrorLike(error) && /per-check ceiling/.test(error.message),
    );
  });

  it("rejects snapshots over the entry ceiling before any per-file work", () => {
    const files = Array.from({ length: 65 }, (_, i) => [
      `src/f${i}.ts`,
      PIN,
      "x;\n",
    ]);
    assert.throws(
      () => compilePinnedSnapshot(snap(files)),
      (error) => ValidationErrorLike(error) && /entry ceiling/.test(error.message),
    );
  });

  it("rejects claim-relevant files over the per-file byte ceiling before hashing", async () => {
    const big = `export const blob = "${"x".repeat(17_000)}";\n`;
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", PIN, DISPATCHER_WIRED],
      ["src/inspect-handler.ts", PIN, big],
    ]);
    const claims = {
      ...standardClaims(),
      claims: [
        {
          id: "big-basis",
          text: "Pinned src/inspect-handler.ts contains the blob.",
          proofClass: "literal",
          checks: [{ path: "src/inspect-handler.ts", allOf: ["blob"] }],
        },
      ],
    };
    await assert.rejects(
      runImplementationAudit(claims, snapshot),
      (error) => ValidationErrorLike(error) && /per-file byte ceiling/.test(error.message),
    );
  });

  it("rejects declared bases over the read budget (visible unassessed, fail-loud)", async () => {
    // 8 unique relevant paths across two claims (per-claim ceiling is 6):
    // the AGGREGATE read budget is what must fail loud here.
    const claims = {
      ...standardClaims(),
      claims: [0, 1].map((n) => ({
        id: `wide-basis-${n}`,
        text: `Wide basis ${n} over the engine read budget.`,
        proofClass: "literal",
        checks: Array.from({ length: 4 }, (_, i) => ({
          path: `src/f${n * 4 + i}.ts`,
          allOf: ["x"],
        })),
      })),
    };
    const snapshot = snap(
      Array.from({ length: 8 }, (_, i) => [`src/f${i}.ts`, PIN, "x;\n"]),
    );
    await assert.rejects(
      runImplementationAudit(claims, snapshot),
      (error) => ValidationErrorLike(error) && /read budget/.test(error.message),
    );
  });
});

// ---------------------------------------------------------------------------
// Identity and address controls — canonical revision shape, reversible URL
// ---------------------------------------------------------------------------

describe("implementation audit: identity and address controls", () => {
  it("accepts only full canonical 40/64 lowercase-hex revisions", () => {
    const sha256Shape = "f".repeat(64);
    assert.doesNotThrow(() =>
      compileAuditClaimSet({ ...standardClaims(), revision: sha256Shape }),
    );
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), revision: "f1000000000" }),
      ValidationErrorLike,
    ); // abbreviated
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), revision: PIN.toUpperCase() }),
      ValidationErrorLike,
    ); // mixed case
    assert.throws(
      () => compilePinnedSnapshot({ ...FULLY_WIRED, revision: "f1000000000" }),
      ValidationErrorLike,
    );
  });

  it("rejects repository and path identities that break the address scheme", () => {
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), repository: "fixture@cli" }),
      ValidationErrorLike,
    );
    assert.throws(
      () => compilePinnedSnapshot({ ...FULLY_WIRED, repository: "fixture cli" }),
      ValidationErrorLike,
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            { ...standardClaims().claims[0], checks: [{ path: "src/@bad.ts", allOf: ["x"] }] },
          ],
        }),
      ValidationErrorLike,
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            { ...standardClaims().claims[0], checks: [{ path: "src/ba%64.ts", allOf: ["x"] }] },
          ],
        }),
      ValidationErrorLike,
    );
  });

  it("refuses to build a non-reversible snapshot URL (own validation)", () => {
    // "@" in the repository component breaks parse-back of the authority.
    assert.throws(() => snapshotFileUrl("bad@repo", PIN, "src/x.ts"), ValidationErrorLike);
    // A non-hex revision cannot round-trip through the address scheme.
    assert.throws(() => snapshotFileUrl(REPO, "not-hex!", "src/x.ts"), ValidationErrorLike);
    // Canonical identities round-trip exactly.
    const url = snapshotFileUrl(REPO, PIN, "src/dispatcher.ts");
    assert.equal(url, `snapshot://${REPO}@${PIN}/src/dispatcher.ts`);
  });

  it("does not serve an entry under a revision other than its own (seam spoof)", async () => {
    const claims = compileAuditClaimSet(standardClaims());
    const snapshot = snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", OTHER_COMMIT, DISPATCHER_WIRED],
    ]);
    const { deps } = createSnapshotReadDeps(claims, snapshot);
    // PIN-revision address for a path whose materialized entry is at
    // OTHER_COMMIT: must NOT serve other-commit bytes as pinned evidence.
    await assert.rejects(
      deps.read(snapshotFileUrl(REPO, PIN, "src/dispatcher.ts")),
      (error) => error instanceof SnapshotRefusalError && error.refusal.kind === "unknown_file",
    );
  });

  it("rejects null poison in every input position", () => {
    assert.throws(() => compileAuditClaimSet({ ...standardClaims(), schemaVersion: null }), ValidationErrorLike);
    assert.throws(() => compileAuditClaimSet({ ...standardClaims(), claims: [null] }), ValidationErrorLike);
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], checks: null }],
        }),
      ValidationErrorLike,
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], checks: [{ path: "src/x.ts", allOf: [null] }] }],
        }),
      ValidationErrorLike,
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], criteria: [null] }],
        }),
      ValidationErrorLike,
    );
    assert.throws(
      () => compilePinnedSnapshot({ ...FULLY_WIRED, files: [null] }),
      ValidationErrorLike,
    );
    assert.throws(
      () => compilePinnedSnapshot({ ...FULLY_WIRED, revision: null }),
      ValidationErrorLike,
    );
  });
});

// ---------------------------------------------------------------------------
// Fix3 — seam admission, header capture, grammar unity, UTF-16 well-formedness
// ---------------------------------------------------------------------------

describe("implementation audit: seam admission and header capture", () => {
  it("enforces claim/snapshot pin agreement on its own (direct callers included)", () => {
    const claims = compileAuditClaimSet(standardClaims());
    const snapshot = compilePinnedSnapshot(FULLY_WIRED);
    const drifted = { ...snapshot, revision: OTHER_COMMIT };
    assert.throws(
      () => createSnapshotReadDeps(claims, drifted),
      (error) => ValidationErrorLike(error) && /never be conflated/.test(error.message),
    );
    const foreignRepo = { ...snapshot, repository: "other-repo" };
    assert.throws(() => createSnapshotReadDeps(claims, foreignRepo), ValidationErrorLike);
  });

  it("captures the validated header once: post-creation mutation of the caller object cannot move the pin", async () => {
    const claims = compileAuditClaimSet(standardClaims());
    const snapshot = compilePinnedSnapshot(FULLY_WIRED);
    const { deps } = createSnapshotReadDeps(claims, snapshot);
    // Caller mutates the (runtime-mutable) PinnedSnapshot header afterwards.
    Object.assign(snapshot, { repository: "other-repo", revision: OTHER_COMMIT });
    // The captured pin still admits the ORIGINAL pinned address...
    const content = await deps.read(snapshotFileUrl(REPO, PIN, "src/dispatcher.ts"));
    assert.equal(content, DISPATCHER_WIRED);
    // ...and the drifted header's own addresses are refused.
    await assert.rejects(
      deps.read(snapshotFileUrl("other-repo", OTHER_COMMIT, "src/dispatcher.ts")),
      (error) => error instanceof SnapshotRefusalError,
    );
  });
});

describe("implementation audit: one address grammar, well-formed UTF-16", () => {
  it("rejects control characters, dot-segments and reserved delimiters in paths at admission AND construction", () => {
    for (const bad of [
      "src/x\ny.ts",
      "src/.hidden.ts",
      "src/../registry.ts",
      "src/x%41.ts",
      "src/x@y.ts",
      "src/:x.ts",
      "src\\x.ts",
      "/abs/path.ts",
    ]) {
      assert.throws(
        () =>
          compileAuditClaimSet({
            ...standardClaims(),
            claims: [
              { ...standardClaims().claims[0], checks: [{ path: bad, allOf: ["x"] }] },
            ],
          }),
        ValidationErrorLike,
        `admission must reject ${JSON.stringify(bad)}`,
      );
      assert.throws(() => snapshotFileUrl(REPO, PIN, bad), ValidationErrorLike);
    }
  });

  it("rejects lone-surrogate strings before hashing or comparing (digest/verdict consistency)", async () => {
    // A lone surrogate in a LITERAL: includes() would compare UTF-16 while
    // the engine's digest would mangle it to U+FFFD — refused up front.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [{ path: "src/registry.ts", allOf: ["\uD800bad"] }],
            },
          ],
        }),
      ValidationErrorLike,
    );
    // A lone surrogate in claim TEXT.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], text: "bad \uD800 text" }],
        }),
      ValidationErrorLike,
    );
    // A lone surrogate in claim-relevant CONTENT: refused at materialization
    // before any hashing.
    const claims = {
      ...standardClaims(),
      claims: [
        {
          id: "content-claim",
          text: "Pinned content claim.",
          proofClass: "literal",
          checks: [{ path: "src/registry.ts", allOf: ["x"] }],
        },
      ],
    };
    const surrogateContent = `export const x = "a\uD800b";\n`;
    const snapshot = snap([["src/registry.ts", PIN, surrogateContent]]);
    await assert.rejects(
      runImplementationAudit(claims, snapshot),
      (error) => ValidationErrorLike(error) && /well-formed UTF-16/.test(error.message),
    );
  });

  it("bounds metadata code units before scans: text, criteria, literals", () => {
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], text: "t".repeat(513) }],
        }),
      (error) => ValidationErrorLike(error) && /512 code units/.test(error.message),
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              criteria: Array.from({ length: 9 }, () => "c"),
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /at most 8/.test(error.message),
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              criteria: ["c".repeat(257)],
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /256 code units/.test(error.message),
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [{ path: "src/registry.ts", allOf: ["x".repeat(257)] }],
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /256 code units/.test(error.message),
    );
  });

  it("enforces count caps BEFORE validation scans (malformed overflow item reports the cap, not the item)", () => {
    // 9 clauses where the 9th is null: the COUNT error must fire without
    // scanning item contents.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [
                { path: "src/registry.ts", allOf: ["a", "b", "c", "d", "e", "f", "g", "h", null] },
              ],
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /per-check ceiling/.test(error.message),
    );
    // 7 checks where the 7th is malformed: same rule one level up.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [
                { path: "src/a.ts", allOf: ["x"] },
                { path: "src/b.ts", allOf: ["x"] },
                { path: "src/c.ts", allOf: ["x"] },
                { path: "src/d.ts", allOf: ["x"] },
                { path: "src/e.ts", allOf: ["x"] },
                { path: "src/f.ts", allOf: ["x"] },
                null,
              ],
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /per-claim ceiling/.test(error.message),
    );
  });
});

// ---------------------------------------------------------------------------
// Fix4 — cheap path-length gate, non-echo diagnostics, no seam bypass,
// frozen owned claim state
// ---------------------------------------------------------------------------

describe("implementation audit: fix4 hardening", () => {
  it("rejects oversized paths cheaply before any split/regex/scan", () => {
    const hugePath = `src/${"a".repeat(10_000)}.ts`;
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            { ...standardClaims().claims[0], checks: [{ path: hugePath, allOf: ["x"] }] },
          ],
        }),
      ValidationErrorLike,
    );
    assert.throws(() => snapshotFileUrl(REPO, PIN, hugePath), ValidationErrorLike);
    // EXACT accepted-path ceiling (PR #304 thread 1): the grammar-legal
    // maximum is 12 segments of ≤100 chars joined by 11 slashes = 1211
    // code units, which must be admitted by BOTH the cheap maxPathChars
    // gate (ceiling 1212) and the segment grammar.
    const legalMaxPath = Array.from({ length: 12 }, () => "a".repeat(100)).join("/");
    assert.equal(legalMaxPath.length, 1211);
    assert.doesNotThrow(() =>
      compileAuditClaimSet({
        ...standardClaims(),
        claims: [
          { ...standardClaims().claims[0], checks: [{ path: legalMaxPath, allOf: ["x"] }] },
        ],
      }),
    );
    assert.doesNotThrow(() => snapshotFileUrl(REPO, PIN, legalMaxPath));
    // One code unit past the cheap ceiling (maxPathChars + 1 = 1213) is
    // rejected by the length gate before any split/regex/scan.
    const justOverCeiling = "a".repeat(1213);
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            { ...standardClaims().claims[0], checks: [{ path: justOverCeiling, allOf: ["x"] }] },
          ],
        }),
      ValidationErrorLike,
    );
    assert.throws(() => snapshotFileUrl(REPO, PIN, justOverCeiling), ValidationErrorLike);
  });

  it("non-echo diagnostics: circular and huge malformed values yield bounded ValidationErrors", () => {
    const circular = { self: null };
    circular.self = circular;
    // Circular object: JSON.stringify would throw TypeError — must be a
    // clean ValidationError instead.
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), schemaVersion: circular }),
      (error) => ValidationErrorLike(error) && error.message.length < 300,
    );
    // Huge malformed proofClass: bounded message, no content echo.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], proofClass: "x".repeat(1_000_000) }],
        }),
      (error) =>
        ValidationErrorLike(error) &&
        error.message.length < 300 &&
        !error.message.includes("xxxxxxxx"),
    );
    // Huge malformed schemaVersion string: same fixed shape.
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), schemaVersion: "1".repeat(1_000_000) }),
      (error) => ValidationErrorLike(error) && error.message.length < 300,
    );
  });

  it("closes the call-surface bypass: raw unvalidated snapshots are rejected at the seam", () => {
    const claims = compileAuditClaimSet(standardClaims());
    // A structurally-typed object that NEVER went through
    // compilePinnedSnapshot: duplicate paths must be refused at the seam.
    const unvalidated = {
      repository: REPO,
      revision: PIN,
      files: [
        { path: "src/registry.ts", revision: PIN, content: REGISTRY, sha256: sha256(REGISTRY) },
        { path: "src/registry.ts", revision: PIN, content: REGISTRY, sha256: sha256(REGISTRY) },
        { path: "src/dispatcher.ts", revision: PIN, content: DISPATCHER_WIRED, sha256: sha256(DISPATCHER_WIRED) },
      ],
    };
    assert.throws(
      () => createSnapshotReadDeps(claims, unvalidated),
      (error) => ValidationErrorLike(error) && /duplicates path/.test(error.message),
    );
    // Oversized entry count bypassing compile: refused at the seam.
    const oversized = {
      repository: REPO,
      revision: PIN,
      files: Array.from({ length: 65 }, (_, i) => ({
        path: `src/f${i}.ts`,
        revision: PIN,
        content: "x;\n",
        sha256: sha256("x;\n"),
      })),
    };
    assert.throws(
      () => createSnapshotReadDeps(claims, oversized),
      (error) => ValidationErrorLike(error) && /entry ceiling/.test(error.message),
    );
  });

  it("returns frozen owned claim state (mid-run mutation of caller references is impossible)", () => {
    const compiled = compileAuditClaimSet(standardClaims());
    assert.ok(Object.isFrozen(compiled.claims));
    for (const claim of compiled.claims) {
      assert.ok(Object.isFrozen(claim));
      assert.ok(Object.isFrozen(claim.checks));
      for (const check of claim.checks) {
        assert.ok(Object.isFrozen(check));
        assert.ok(Object.isFrozen(check.allOf));
      }
    }
  });

  it("recompiles structurally constructed claim sets at the seam: allOf mutated after construction has no effect", async () => {
    // Structurally constructed, NEVER through the compiler, fully mutable.
    const rawClaims = {
      schemaVersion: 1,
      repository: REPO,
      revision: PIN,
      claims: [
        {
          id: "mutable-claim",
          text: "Pinned dispatcher contains the route literal.",
          proofClass: "literal",
          checks: [{ path: "src/dispatcher.ts", allOf: ['route("inspect", inspectHandler)'] }],
        },
      ],
    };
    const snapshot = compilePinnedSnapshot(snap([
      ["src/registry.ts", PIN, REGISTRY],
      ["src/dispatcher.ts", PIN, DISPATCHER_WIRED],
    ]));
    // The RAW mutable object itself crosses the exported seam — the exact
    // structural-bypass surface. No precompiled copy is involved.
    const { deps } = createSnapshotReadDeps(rawClaims, snapshot);
    // Caller mutates THAT EXACT object's literals AFTER seam construction —
    // a literal that is NOT in the pinned dispatcher.
    rawClaims.claims[0].checks[0].allOf = ["WILL_NOT_MATCH_ANYTHING"];
    // The judge still assesses against the CAPTURED compiled literals.
    const verdict = await deps.judge({
      fieldId: "mutable-claim",
      fieldQuestion: "irrelevant to the deterministic judge",
      criteria: [],
      scope: {},
      candidates: ["supported", "refuted", "disputed"],
      documents: [
        {
          evidenceId: "e1",
          url: snapshotFileUrl(REPO, PIN, "src/registry.ts"),
          title: "src/registry.ts",
          content: REGISTRY,
        },
        {
          evidenceId: "e2",
          url: snapshotFileUrl(REPO, PIN, "src/dispatcher.ts"),
          title: "src/dispatcher.ts",
          content: DISPATCHER_WIRED,
        },
      ],
    });
    const dispatcher = verdict.documents.find((d) => d.evidenceId === "e2");
    assert.deepEqual(
      dispatcher,
      { evidenceId: "e2", relevant: true, supportsClaim: true, refutesClaim: false },
      "judge must follow the captured compiled literals, not the mutated raw ones",
    );
    // And the raw form still round-trips the compiler (schemaVersion carried).
    assert.equal(compileAuditClaimSet(rawClaims).schemaVersion, 1);
  });
});

// ---------------------------------------------------------------------------
// Trusted snapshot read seam — unit controls
// ---------------------------------------------------------------------------

describe("implementation audit: trusted snapshot read seam", () => {
  it("serves materialized files with a verified digest journal (offline positive pin)", async () => {
    const claims = compileAuditClaimSet(standardClaims());
    const snapshot = compilePinnedSnapshot(FULLY_WIRED);
    const { deps, journal } = createSnapshotReadDeps(claims, snapshot);
    const url = snapshotFileUrl(REPO, PIN, "src/dispatcher.ts");
    const content = await deps.read(url);
    assert.equal(content, DISPATCHER_WIRED);
    assert.equal(journal.verifiedPins.length, 1);
    assert.equal(journal.verifiedPins[0].revision, PIN);
    assert.equal(journal.verifiedPins[0].sha256, sha256(DISPATCHER_WIRED));
    assert.equal(journal.refusals.length, 0);
  });

  it("refuses any URL whose revision is not the pinned audit revision", async () => {
    const claims = compileAuditClaimSet(standardClaims());
    const snapshot = compilePinnedSnapshot(FULLY_WIRED);
    const { deps, journal } = createSnapshotReadDeps(claims, snapshot);
    await assert.rejects(
      deps.read(snapshotFileUrl(REPO, OTHER_COMMIT, "src/dispatcher.ts")),
      (error) => error instanceof SnapshotRefusalError && error.refusal.kind === "revision_mismatch",
    );
    assert.equal(journal.verifiedPins.length, 0);
    assert.equal(journal.refusals[0].kind, "revision_mismatch");
  });

  it("refuses files outside the claim-relevant index with unknown_file", async () => {
    const claims = compileAuditClaimSet(standardClaims());
    const snapshot = compilePinnedSnapshot(FULLY_WIRED);
    const { deps } = createSnapshotReadDeps(claims, snapshot);
    // README exists in the fixture but is not claim-relevant: not indexed.
    await assert.rejects(
      deps.read(snapshotFileUrl(REPO, PIN, "README.md")),
      (error) => error instanceof SnapshotRefusalError && error.refusal.kind === "unknown_file",
    );
  });

  it("serves the consumer's own frozen bytes: caller-side mutation after materialization is invisible", async () => {
    const claims = compileAuditClaimSet(standardClaims());
    const input = compilePinnedSnapshot(FULLY_WIRED);
    const { deps, journal } = createSnapshotReadDeps(claims, input);
    // Tamper with the CALLER's input object after the seam owns its copy.
    input.files[1] = {
      ...input.files[1],
      content: "export const tampered = true;\n",
      sha256: sha256("export const tampered = true;\n"),
    };
    const content = await deps.read(snapshotFileUrl(REPO, PIN, "src/dispatcher.ts"));
    assert.equal(content, DISPATCHER_WIRED);
    assert.equal(journal.verifiedPins[0].sha256, sha256(DISPATCHER_WIRED));
  });

  it("validates declared digests only for claim-relevant files (bounded materialization)", () => {
    const claims = compileAuditClaimSet(standardClaims());
    const good = compilePinnedSnapshot(FULLY_WIRED);
    // Unrelated file with a lying digest: never hashed, never blocks the run.
    const unrelatedBad = compilePinnedSnapshot({
      ...FULLY_WIRED,
      files: [
        ...FULLY_WIRED.files,
        { path: "docs/unrelated.md", revision: PIN, content: "x", sha256: "0".repeat(64) },
      ],
    });
    assert.doesNotThrow(() => createSnapshotReadDeps(claims, unrelatedBad));
    // Claim-relevant file with a lying digest: refused before any dispatch.
    const relevantBad = compilePinnedSnapshot({
      ...FULLY_WIRED,
      files: FULLY_WIRED.files.map((f) =>
        f.path === "src/dispatcher.ts" ? { ...f, sha256: "0".repeat(64) } : f,
      ),
    });
    assert.throws(() => createSnapshotReadDeps(claims, relevantBad), ValidationErrorLike);
    void good;
  });

  it("scopes search to the claim owning each query; unknown queries surface nothing", async () => {
    const claims = compileAuditClaimSet(standardClaims());
    const snapshot = compilePinnedSnapshot(FULLY_WIRED);
    const { deps } = createSnapshotReadDeps(claims, snapshot);
    // Shared contract question enumerates the whole relevant index.
    const shared = await deps.search(
      `Assess the declared literal implementation predicates for ${REPO} at revision ${PIN}.`,
    );
    assert.deepEqual(
      shared.map((r) => r.title).sort(),
      ["src/dispatcher.ts", "src/registry.ts"],
    );
    // A claim's own question (unique claim-ID prefixed, fix3) surfaces only
    // that claim's declared files.
    const reachabilityQuestion = `[audit:inspect-reachable] ${standardClaims().claims[1].text} (proof class: reachability; declared literal basis: src/dispatcher.ts)`;
    const scoped = await deps.search(reachabilityQuestion);
    assert.deepEqual(scoped.map((r) => r.title), ["src/dispatcher.ts"]);
    // Unknown queries fail closed: nothing is surfaced.
    assert.deepEqual(await deps.search("not a plan query"), []);
    for (const r of [...shared, ...scoped]) assert.ok(r.url.startsWith(`snapshot://${REPO}@`));
    const t1 = deps.now();
    await new Promise((resolve) => setImmediate(resolve));
    const t2 = deps.now();
    assert.ok(t2 >= t1, "clock must be monotonic non-decreasing");
    assert.ok(typeof t1 === "number" && Number.isFinite(t1));
  });
});

// ---------------------------------------------------------------------------
// Preflight validation — zero acquisition on malformed input
// ---------------------------------------------------------------------------

describe("implementation audit: preflight validation", () => {
  it("rejects malformed claim sets before any acquisition", () => {
    assert.throws(() => compileAuditClaimSet({ schemaVersion: 2 }), ValidationErrorLike);
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), revision: "main" }),
      ValidationErrorLike,
    );
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), claims: [] }),
      ValidationErrorLike,
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], proofClass: "static" }],
        }),
      ValidationErrorLike,
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], id: "bad id!" }],
        }),
      ValidationErrorLike,
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], id: "__proto__" }],
        }),
      ValidationErrorLike,
    );
    // Literal claims must declare at least one structural check.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], checks: [] }],
        }),
      ValidationErrorLike,
    );
    // Duplicate paths within a claim: ambiguous basis.
    assert.throws(
      () => {
        const [claim] = standardClaims().claims;
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...claim, checks: [...claim.checks, claim.checks[0]] }],
        });
      },
      ValidationErrorLike,
    );
    // Duplicate clauses within a check.
    assert.throws(
      () => {
        const [claim] = standardClaims().claims;
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            { ...claim, checks: [{ path: "src/registry.ts", allOf: ['"inspect"', '"inspect"'] }] },
          ],
        });
      },
      ValidationErrorLike,
    );
    // Trust boundary: path traversal in a declared check is refused.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            { ...standardClaims().claims[0], checks: [{ path: "../outside.ts", allOf: ["x"] }] },
          ],
        }),
      ValidationErrorLike,
    );
    // Duplicate claim ids.
    assert.throws(
      () => {
        const [a] = standardClaims().claims;
        compileAuditClaimSet({ ...standardClaims(), claims: [a, a] });
      },
      ValidationErrorLike,
    );
  });

  it("rejects ambiguous or malformed snapshots", () => {
    assert.throws(() => compilePinnedSnapshot({ repository: REPO, revision: PIN }), ValidationErrorLike);
    assert.throws(
      () => compilePinnedSnapshot({ ...snap([]) }),
      ValidationErrorLike,
    );
    // Duplicate file paths: ambiguous provenance.
    assert.throws(
      () =>
        compilePinnedSnapshot({
          ...FULLY_WIRED,
          files: [...FULLY_WIRED.files, FULLY_WIRED.files[0]],
        }),
      ValidationErrorLike,
    );
    // Malformed file revision.
    assert.throws(
      () =>
        compilePinnedSnapshot({
          ...FULLY_WIRED,
          files: FULLY_WIRED.files.map((f) =>
            f.path === "README.md" ? { ...f, revision: "latest" } : f,
          ),
        }),
      ValidationErrorLike,
    );
  });
});

it("a caller option cannot claim Git provenance for a fixture snapshot", async () => {
  const report = await runImplementationAudit(standardClaims(), FULLY_WIRED, {
    localGit: true,
    allowEmptySnapshot: true,
  });
  assert.equal(literalClaim(report).status, "supported");
  assert.equal(report.coverageNotes.some((note) => note.includes("exact pinned local Git commit")), false);
});

const ValidationErrorLike = (error) =>
  error != null && typeof error === "object" && error.name === "ValidationError";

// ---------------------------------------------------------------------------
// PR #304 admission fixes — sparse arrays (r4654875641) and capture-once
// headers/references (r4654875644); single-run architecture unchanged
// ---------------------------------------------------------------------------

describe("implementation audit: sparse-array rejection (r4654875641)", () => {
  it("rejects holes in every bounded input array with a ValidationError", () => {
    const holed = (items) => {
      const array = [...items];
      delete array[0];
      return array;
    };
    // Sparse checks on a literal claim: previously sailed past the scans
    // and detonated as a TypeError in relevantPaths.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            { ...standardClaims().claims[0], checks: new Array(1) },
          ],
        }),
      (error) => ValidationErrorLike(error) && /dense/.test(error.message),
    );
    // Sparse allOf: every() skips holes; for-of then hit undefined.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [{ path: "src/registry.ts", allOf: holed(["x"]) }],
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /dense/.test(error.message),
    );
    // Sparse criteria.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [{ ...standardClaims().claims[0], criteria: holed(["c"]) }],
        }),
      (error) => ValidationErrorLike(error) && /dense/.test(error.message),
    );
    // Sparse claims array.
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), claims: holed([standardClaims().claims[0]]) }),
      (error) => ValidationErrorLike(error) && /dense/.test(error.message),
    );
    // Sparse snapshot files.
    assert.throws(
      () => compilePinnedSnapshot({ ...FULLY_WIRED, files: holed(FULLY_WIRED.files) }),
      (error) => ValidationErrorLike(error) && /dense/.test(error.message),
    );
  });

  it("rejects a hole masked by an INHERITED index (own-property density, not `in`)", () => {
    // A hole whose index exists on the prototype chain: `in` accepts it,
    // map/every skip it — only Object.hasOwn-based density rejects it.
    const inheritedHole = ["x"];
    delete inheritedHole[0];
    Object.setPrototypeOf(inheritedHole, { 0: "inherited" });
    assert.ok(0 in inheritedHole, "fixture must genuinely mask the hole via inheritance");
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [{ path: "src/registry.ts", allOf: inheritedHole }],
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /dense/.test(error.message),
    );
  });

  it("rejects huge sparse arrays on the CHEAP count ceiling, never after a density walk", () => {
    assert.throws(
      () => compileAuditClaimSet({ ...standardClaims(), claims: new Array(10_000_000) }),
      (error) => ValidationErrorLike(error) && /field ceiling/.test(error.message),
    );
    assert.throws(
      () => compilePinnedSnapshot({ ...FULLY_WIRED, files: new Array(10_000_000) }),
      (error) => ValidationErrorLike(error) && /entry ceiling/.test(error.message),
    );
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [{ path: "src/registry.ts", allOf: new Array(10_000_000) }],
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /per-check ceiling/.test(error.message),
    );
  });
});

describe("implementation audit: capture-once headers and references (r4654875644)", () => {
  it("validates and returns the SAME captured pin values from drifting getters", () => {
    let repoReads = 0;
    let revReads = 0;
    const driftingSnapshot = {
      get repository() {
        repoReads += 1;
        return repoReads === 1 ? REPO : "other-repo";
      },
      get revision() {
        revReads += 1;
        return revReads === 1 ? PIN : OTHER_COMMIT;
      },
      files: FULLY_WIRED.files,
    };
    const compiledSnapshot = compilePinnedSnapshot(driftingSnapshot);
    assert.equal(compiledSnapshot.repository, REPO);
    assert.equal(compiledSnapshot.revision, PIN);
    let claimRevReads = 0;
    const driftingClaims = {
      ...standardClaims(),
      get revision() {
        claimRevReads += 1;
        return claimRevReads === 1 ? PIN : OTHER_COMMIT;
      },
    };
    const compiledClaims = compileAuditClaimSet(driftingClaims);
    assert.equal(compiledClaims.revision, PIN);
    // A stable mismatch still fails at the seam (captured vs captured).
    assert.throws(
      () =>
        createSnapshotReadDeps(
          compiledClaims,
          compilePinnedSnapshot({ ...FULLY_WIRED, revision: OTHER_COMMIT }),
        ),
      (error) => ValidationErrorLike(error) && /never be conflated/.test(error.message),
    );
    assert.doesNotThrow(() => createSnapshotReadDeps(compiledClaims, compiledSnapshot));
  });

  it("captures the named collection references once: a swapped second array is never admitted", () => {
    // A claims getter that hands validation one array and the copy another:
    // the FIRST captured array is the only one admitted.
    const goodClaims = standardClaims().claims;
    const evilClaims = [
      { ...goodClaims[0], text: "SWAPPED-IN TEXT THAT WAS NEVER VALIDATED." },
      goodClaims[1],
      goodClaims[2],
    ];
    let claimsReads = 0;
    const swapping = {
      ...standardClaims(),
      get claims() {
        claimsReads += 1;
        return claimsReads === 1 ? goodClaims : evilClaims;
      },
    };
    const compiled = compileAuditClaimSet(swapping);
    assert.equal(compiled.claims[0].text, goodClaims[0].text);
    // Same rule for the snapshot files array.
    const goodFiles = FULLY_WIRED.files;
    const evilFiles = FULLY_WIRED.files.map((f) =>
      f.path === "src/dispatcher.ts" ? { ...f, content: "export const swapped = true;\n" } : f,
    );
    let filesReads = 0;
    const swappingSnapshot = {
      ...FULLY_WIRED,
      get files() {
        filesReads += 1;
        return filesReads === 1 ? goodFiles : evilFiles;
      },
    };
    const compiledSnapshot = compilePinnedSnapshot(swappingSnapshot);
    const dispatcher = compiledSnapshot.files.find((f) => f.path === "src/dispatcher.ts");
    assert.equal(dispatcher.content, DISPATCHER_WIRED);
    // And the digest of the admitted copy still binds the GOOD bytes.
    assert.equal(dispatcher.sha256, sha256(DISPATCHER_WIRED));
    // Per-claim check fields: a drifting path getter validates and admits
    // the same captured value.
    let pathReads = 0;
    const driftingCheck = {
      get path() {
        pathReads += 1;
        return pathReads === 1 ? "src/registry.ts" : "src/../outside.ts";
      },
      allOf: ["x"],
    };
    const compiledDrifting = compileAuditClaimSet({
      ...standardClaims(),
      claims: [{ ...standardClaims().claims[0], checks: [driftingCheck] }],
    });
    assert.equal(compiledDrifting.claims[0].checks[0].path, "src/registry.ts");
  });
});

describe("implementation audit: own-index item capture (review follow-up)", () => {
  it("allOf items are read once: drifting own-index accessors admit the captured literals only", () => {
    // Each index read returns a DIFFERENT literal: validation sees "good",
    // the copy spread must admit exactly the captured values — never a
    // later drift, never a mixture.
    const drifting = ["placeholder0", "placeholder1"];
    let reads = 0;
    Object.defineProperty(drifting, 0, {
      get() {
        reads += 1;
        return reads <= 1 ? "first-good" : "LATE-DRIFT";
      },
    });
    Object.defineProperty(drifting, 1, {
      get() {
        return "second-good";
      },
    });
    assert.ok(Array.isArray(drifting) && Object.hasOwn(drifting, 0));
    const compiled = compileAuditClaimSet({
      ...standardClaims(),
      claims: [
        {
          ...standardClaims().claims[0],
          checks: [{ path: "src/registry.ts", allOf: drifting }],
        },
      ],
    });
    const admitted = compiled.claims[0].checks[0].allOf;
    assert.deepEqual([...admitted], ["first-good", "second-good"]);
    // Repeat reads of the compiled copy are stable regardless of drift.
    assert.deepEqual([...admitted], [...admitted]);
  });

  it("criteria items are read once: the every-scan and the copy see the same captured values", () => {
    const drifting = ["placeholder0", "placeholder1"];
    let reads = 0;
    Object.defineProperty(drifting, 0, {
      get() {
        reads += 1;
        return reads <= 1 ? "criterion-one" : "LATE-DRIFT";
      },
    });
    Object.defineProperty(drifting, 1, {
      get() {
        return "criterion-two";
      },
    });
    assert.ok(Array.isArray(drifting) && Object.hasOwn(drifting, 0));
    const compiled = compileAuditClaimSet({
      ...standardClaims(),
      claims: [{ ...standardClaims().claims[0], criteria: drifting }],
    });
    assert.deepEqual([...compiled.claims[0].criteria], ["criterion-one", "criterion-two"]);
    assert.deepEqual([...compiled.claims[0].criteria], [...compiled.claims[0].criteria]);
  });
});


describe("implementation audit: own-index capture under mutation", () => {
  it("refuses a later slot removed while earlier literals are captured", () => {
    const literals = ["first", "second"];
    Object.defineProperty(literals, "0", {
      get() { delete literals[1]; return "first"; },
    });
    const input = standardClaims();
    const claim = input.claims[0];
    assert.throws(
      () => compileAuditClaimSet({
        ...input,
        claims: [{ ...claim, checks: [{ ...claim.checks[0], allOf: literals }] }],
      }),
      (error) => ValidationErrorLike(error) && /dense array/.test(error.message),
    );
  });
});

describe("implementation audit: literal guard ordering (Greptile r4659860497)", () => {
  it("is CAUSAL: the oversized sentinel is never hashed into the dedup Set (instrumented)", () => {
    // Instrument Set.has/add to count probes of exactly the oversized
    // sentinel (restored in finally; synchronous compile only). The guard
    // must reject the clause BEFORE any dedup lookup or insertion of it:
    // zero sentinel lookups/insertions. Under the pre-fix order the very
    // first occurrence is probed and inserted before the length check —
    // this fails without relying on timing or duplicate error text.
    const sentinel = "s".repeat(AUDIT_CEILINGS.maxLiteralChars + 1);
    assert.ok(sentinel.length === 257);
    const originalHas = Set.prototype.has;
    const originalAdd = Set.prototype.add;
    let sentinelHas = 0;
    let sentinelAdd = 0;
    Set.prototype.has = function (value) {
      if (value === sentinel) sentinelHas += 1;
      return originalHas.call(this, value);
    };
    Set.prototype.add = function (value) {
      if (value === sentinel) sentinelAdd += 1;
      return originalAdd.call(this, value);
    };
    try {
      assert.throws(
        () =>
          compileAuditClaimSet({
            ...standardClaims(),
            claims: [
              {
                ...standardClaims().claims[0],
                checks: [{ path: "src/registry.ts", allOf: [sentinel] }],
              },
            ],
          }),
        (error) =>
          ValidationErrorLike(error) &&
          /256 code units or is not well-formed UTF-16/.test(error.message),
      );
    } finally {
      Set.prototype.has = originalHas;
      Set.prototype.add = originalAdd;
    }
    assert.equal(sentinelHas, 0, "oversized sentinel must never reach Set.has (guard must fire first)");
    assert.equal(sentinelAdd, 0, "oversized sentinel must never reach Set.add (guard must fire first)");
  });

  it("rejects an oversized clause on the cheap guard BEFORE dedup examines or records it", () => {
    // The same oversized clause twice: the pre-fix order hashed it into
    // the seen-literal Set first and reported the DUPLICATE; the guard
    // must fire first, so the error is the ceiling diagnostic and the
    // second occurrence is never examined.
    const oversized = "x".repeat(AUDIT_CEILINGS.maxLiteralChars + 1);
    assert.ok(oversized.length === 257);
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [{ path: "src/registry.ts", allOf: [oversized, oversized] }],
            },
          ],
        }),
      (error) =>
        ValidationErrorLike(error) &&
        /256 code units or is not well-formed UTF-16/.test(error.message) &&
        !/duplicate clause/.test(error.message),
    );
    // Well-formedness likewise precedes dedup: an ill-formed clause that
    // is also a duplicate reports the guard, not the duplicate.
    const illFormedTwice = ["\uD800bad", "\uD800bad"];
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [{ path: "src/registry.ts", allOf: illFormedTwice }],
            },
          ],
        }),
      (error) =>
        ValidationErrorLike(error) &&
        /256 code units or is not well-formed UTF-16/.test(error.message) &&
        !/duplicate clause/.test(error.message),
    );
    // The duplicate diagnostic itself is unchanged for bounded clauses.
    assert.throws(
      () =>
        compileAuditClaimSet({
          ...standardClaims(),
          claims: [
            {
              ...standardClaims().claims[0],
              checks: [{ path: "src/registry.ts", allOf: ["ok", "ok"] }],
            },
          ],
        }),
      (error) => ValidationErrorLike(error) && /duplicate clause/.test(error.message),
    );
  });
});


describe("implementation audit: bounded assessment context", () => {
  it("preserves a fitting claim alongside a claim whose own JSON context overflows", async () => {
    const small = { id: "small-fits", text: "A small basis", proofClass: "literal",
      checks: [{ path: "src/small.ts", allOf: ["small marker"] }] };
    const bigPaths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const big = { id: "big-context", text: "An escaped basis", proofClass: "literal",
      checks: bigPaths.map((path) => ({ path, allOf: ["x"] })) };
    const content = "x" + "\u0000".repeat(16 * 1024 - 1);
    const input = { schemaVersion: 1, repository: REPO, revision: PIN, claims: [small, big] };
    const snapshot = snap([["src/small.ts", PIN, "small marker"], ...bigPaths.map((path) => [path, PIN, content])]);
    assert.equal(Buffer.byteLength(content, "utf8"), 16 * 1024);
    assert.ok(3 * Buffer.byteLength(JSON.stringify(content), "utf8") > 256 * 1024);
    const report = await runImplementationAudit(input, snapshot);
    assert.equal(report.status, "partial");
    assert.equal(report.claims[0].status, "supported");
    assert.equal(report.claims[1].status, "unresolved");
    assert.equal(report.claims[1].engine.reason, "assessment_context_overflow");
    assert.equal(report.usage.readAttempts, 4);
    assert.equal(report.usage.readsRetained, 4);
    assert.equal(report.evidence.length, 4);
    const smallId = report.evidence.find((record) => record.path === "src/small.ts").evidenceId;
    const judgments = report.acquisitionLog.filter((row) => row.kind === "judge" && row.detail.startsWith("small-fits "));
    assert.ok(judgments.length > 0);
    assert.ok(judgments.every((row) => row.detail === `small-fits over [${smallId}]`));
  });

  it("uses one acquisition budget across three claims that share six files", async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `src/file-${i}.ts`);
    const checks = paths.map((path) => ({ path, allOf: ["marker"] }));
    const claims = Array.from({ length: 3 }, (_, i) => ({
      id: `claim-${i}`, text: `Claim ${i}`, proofClass: "literal", checks,
    }));
    const snapshot = snap(paths.map((path) => [path, PIN, "marker"]));
    const report = await runImplementationAudit({ schemaVersion: 1, repository: REPO, revision: PIN, claims }, snapshot);
    assert.equal(report.status, "complete");
    assert.deepEqual(report.claims.map((claim) => claim.status), ["supported", "supported", "supported"]);
    assert.equal(report.usage.readAttempts, 6);
    assert.equal(report.usage.readsRetained, 6);
    assert.ok(report.usage.searches <= 7);
    assert.equal(report.evidence.length, 6);
  });
});
