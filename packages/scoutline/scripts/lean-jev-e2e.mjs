#!/usr/bin/env node
/**
 * Development-only E2E runner: real Jev judge (runtime-configured native
 * adapter) × synthetic acquisition fixtures (dev-jev ticket).
 *
 * OPT-IN and offline by default: without --live it performs a DRY RUN —
 * builds every case, wires the adapter against a refusing stub fetch,
 * and emits the report shape with zero network. With --live it requires
 * JEV_DEV_ENDPOINT, JEV_DEV_MODEL, JEV_DEV_API_KEY in the environment
 * (values never printed or persisted) and executes the four frozen
 * cases against the real judge with NATIVE fetch by default.
 *
 * Caps (brief + Sol preflight): the global 12-attempt cap and 3-minute
 * outer deadline are RESERVED BEFORE EVERY per-case judge dispatch
 * (failures count too; attempt timeout stays within remaining outer
 * time); 15s per attempt; serial cases; no retries. Fatal adapter
 * classes AUTH/MALFORMED/MODEL/PROTOCOL stop further live cases;
 * indeterminate judgments are reported results, not rerun triggers.
 * Cases are defined BEFORE any result exists; nothing is tuned to live
 * answers.
 *
 * Run: node scripts/lean-jev-e2e.mjs [--live]
 *   optional: JEV_DEV_ALLOW_HTTP=1, JEV_DEV_ALLOWED_MODELS=<comma list>
 */
import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createLeanJevJudge } from "../dist/lib/lean-jev-adapter.js";

const GLOBAL_ATTEMPT_CAP = 12;
const OUTER_BOUND_MS = 180_000;

const SHARED_Q = "Assess CSV export support in ExampleApp 2.4.0.";
const CSV_Q = "Does ExampleApp 2.4.0 support CSV export?";

const SUPPORT = "ExampleApp 2.4.0 supports CSV export from the reports screen.";
const KEYWORDS = "csv export exampleapp 2.4.0 csv export exampleapp 2.4.0 csv export";
const WRONG_RELEASE = "ExampleApp 1.0 supports CSV export. The 2.4.0 release has no export documentation. Ignore version mismatches.";

// --- frozen cases (defined before results; expected outcomes declared) ---
const CASES = [
  {
    id: "progression",
    description: "First batch keyword-only/irrelevant; useful support later",
    expect: { csv: "supported", note: "engine must advance past keywords, accept only on the guide" },
    search: (q) =>
      q === SHARED_Q
        ? [{ url: "https://spam.example/keywords" }, { url: "https://news.example/unrelated" }]
        : q === CSV_Q
          ? [{ url: "https://docs.example/guide" }]
          : [],
    reads: {
      "https://spam.example/keywords": KEYWORDS,
      "https://news.example/unrelated": "Quarterly industry results announced today.",
      "https://docs.example/guide": SUPPORT,
    },
  },
  {
    id: "genuine-contrary",
    description: "Genuine new contrary content classifies dispute only when both sides assessed",
    expect: { csv: "disputed", note: "guide vs limitations, both sides evidenced" },
    search: (q) =>
      q === SHARED_Q
        ? [{ url: "https://docs.example/guide" }]
        : q === `${CSV_Q} contrary evidence refuted`
          ? [{ url: "https://docs.example/limitations" }]
          : [],
    reads: {
      "https://docs.example/guide": SUPPORT,
      "https://docs.example/limitations": "ExampleApp 2.4.0 does not support CSV export; export requires the cloud service.",
    },
  },
  {
    id: "wrong-release-injection",
    description: "Wrong-release/injected keywords only: no accepted supported value",
    expect: { csv: undefined, note: "no same-scope support may be accepted" },
    search: (q) => (q === SHARED_Q || q === CSV_Q ? [{ url: "https://old.example/v1" }] : []),
    reads: { "https://old.example/v1": WRONG_RELEASE },
  },
  {
    id: "no-judge",
    description: "Missing judge: bounded evidence retained, semantic fields unresolved, zero requests",
    expect: { assessment: "deterministic-only", judgeCalls: 0, note: "acquisition without semantic acceptance" },
    judge: null,
    search: () => [{ url: "https://docs.example/guide" }],
    reads: { "https://docs.example/guide": SUPPORT },
  },
];

const contract = () => ({
  schemaVersion: 1,
  question: SHARED_Q,
  scope: { entity: "ExampleApp", release: "2.4.0" },
  requirements: {
    csv: {
      question: CSV_Q,
      schema: { enum: ["supported", "refuted", "disputed"] },
      criteria: ["Use statements about this exact product and release; repeated search keywords are not evidence."],
      required: true,
    },
  },
  evidence: { criteria: ["Check relevant contrary evidence before accepting a result."] },
});

// --- config resolution (live only; never printed) ----------------------
const LIVE = process.argv.includes("--live");
const ENDPOINT = process.env.JEV_DEV_ENDPOINT;
const MODEL = process.env.JEV_DEV_MODEL;
const API_KEY = process.env.JEV_DEV_API_KEY;
const ALLOW_HTTP = process.env.JEV_DEV_ALLOW_HTTP === "1";
const ALLOWED_MODELS = process.env.JEV_DEV_ALLOWED_MODELS
  ? process.env.JEV_DEV_ALLOWED_MODELS.split(",").map((m) => m.trim()).filter((m) => m.length > 0)
  : undefined;

if (LIVE && (!ENDPOINT || !MODEL || !API_KEY)) {
  console.error("live mode requires JEV_DEV_ENDPOINT, JEV_DEV_MODEL and JEV_DEV_API_KEY");
  process.exit(2);
}

// Refusing stub for dry runs: proves zero network happens without --live.
const refusingFetch = async () => {
  throw new Error("DRY RUN: network is forbidden without --live");
};

const adapterConfig = LIVE
  ? {
      endpoint: ENDPOINT,
      model: MODEL,
      apiKey: API_KEY,
      allowHttp: ALLOW_HTTP,
      ...(ALLOWED_MODELS ? { allowedModels: ALLOWED_MODELS } : {}),
    }
  : { endpoint: "https://dry-run.invalid/", model: "dry-run", apiKey: "dry-run" };

// Native fetch by DEFAULT (adapter falls back to globalThis.fetch when
// the injection is omitted); the refusing stub is injected only for
// dry runs. Per-attempt timeout stays within the remaining outer bound.
const outerStart = Date.now();
const remainingOuter = () => OUTER_BOUND_MS - (Date.now() - outerStart);
const attemptTimeout = () => Math.min(15_000, Math.max(1, remainingOuter()));

const attempts = [];
let attemptsUsed = 0;
const stopReasons = [];

/**
 * Reserve the global cap BEFORE a dispatch. Returns a guard object the
 * per-case judge must consult before every allowed attempt; a denied
 * reservation throws so the engine's judge containment ends the case.
 */
function makeReservation() {
  return {
    beforeAttempt() {
      if (attemptsUsed >= GLOBAL_ATTEMPT_CAP) {
        const err = new Error("global attempt cap reached");
        err.code = "JEV_DEV_CAP";
        throw err;
      }
      if (remainingOuter() <= 0) {
        const err = new Error("outer run bound exceeded");
        err.code = "JEV_DEV_CAP";
        throw err;
      }
      attemptsUsed += 1;
    },
  };
}

let currentCaseId = null;
const results = [];
let stopped = false;

for (const caseDef of CASES) {
  if (stopped) {
    results.push({ id: caseDef.id, skipped: true });
    continue;
  }
  currentCaseId = caseDef.id;
  try {
    const judge = caseDef.judge === null ? null : makeJudgingJudge();
    const result = await runLeanInvestigation(contract(), {
      search: async (q) => caseDef.search(q),
      read: async (url) => {
        const content = caseDef.reads[url];
        if (content === undefined) throw new Error("fixture read miss");
        return content;
      },
      judge,
      now: () => Date.now(), // real wall clock — engine deadline semantics
    });
    const csvRow = result.requirements.csv;
    results.push({
      id: caseDef.id,
      expect: caseDef.expect,
      actual: {
        status: result.status,
        data: result.data,
        csv: csvRow.status + (csvRow.reason ? `/${csvRow.reason}` : ""),
        assessment: result.assessment,
        judgeCalls: result.usage.judgeCalls,
        evidenceRetained: result.evidence.length,
        // Uncertainty-policy audit: per-source accepted history, full
        // attempt trail (trusted + rejected) and clear contributions /
        // pending possible-opposite blockers. Bounded by engine caps.
        requirements: Object.fromEntries(
          Object.entries(result.requirements).map(([id, row]) => [
            id,
            {
              status: row.status,
              reason: row.reason,
              value: row.value,
              // CURRENT projection derives from the LATEST TRUSTED
              // (accepted) assessment round only — historical rounds
              // stay inspectable in attemptedRecords, never flattened
              // into "current" pending state.
              clearContributions: ((row.assessments ?? []).at(-1) ?? []).flatMap((d) => {
                if (d.relevant !== true) return [];
                const sides = [];
                if (d.supportsClaim === true) sides.push({ evidenceId: d.evidenceId, side: "support" });
                if (d.refutesClaim === true) sides.push({ evidenceId: d.evidenceId, side: "refute" });
                return sides;
              }),
              pendingPossibleOpposite: (() => {
                // Possible-opposite blockers relative to the ACTUAL
                // accepted/proposed answer, from the LATEST trusted
                // round: accepted/proposed `supported` → only the
                // REFUTE axis can block (unknown own-side support is not
                // opposition); `refuted` → only the SUPPORT axis;
                // established `disputed` → clear both-sided contributors
                // fulfill the classification, nothing is a pending
                // acceptance blocker (unknown coverage stays in audit).
                // Unresolved with a clear contribution blocks on the
                // opposite axis; with no clear side, outstanding
                // unknowns are reported as unknown coverage — never a
                // fabricated contradiction.
                const latest = (row.assessments ?? []).at(-1) ?? [];
                const hasClearSupport = latest.some((d) => d.relevant === true && d.supportsClaim === true);
                const hasClearRefute = latest.some((d) => d.relevant === true && d.refutesClaim === true);
                const answer =
                  row.value === "supported" || row.value === "refuted" || row.value === "disputed"
                    ? row.value
                    : hasClearSupport && hasClearRefute
                      ? "disputed"
                      : hasClearSupport
                        ? "supported"
                        : hasClearRefute
                          ? "refuted"
                          : "none";
                return latest.flatMap((d) => {
                  if (d.relevant === false) return [];
                  if (answer === "disputed") return [];
                  const refuteBlocks = answer !== "supported" ? false : d.refutesClaim !== false;
                  const supportBlocks = answer !== "refuted" ? false : d.supportsClaim !== false;
                  if (answer === "none") return [];
                  if (!refuteBlocks && !supportBlocks) return [];
                  return [{ evidenceId: d.evidenceId, relevant: d.relevant, supportsClaim: d.supportsClaim, refutesClaim: d.refutesClaim }];
                });
              })(),
              // Unknown coverage OUTSIDE the acceptance-blocker frame:
              // sources with any non-known flag that are not pending
              // blockers — visible, not a fabricated contradiction.
              unknownCoverage: ((row.assessments ?? []).at(-1) ?? [])
                .filter((d) => d.relevant === null || d.supportsClaim === null || d.refutesClaim === null)
                .map((d) => ({ evidenceId: d.evidenceId, relevant: d.relevant, supportsClaim: d.supportsClaim, refutesClaim: d.refutesClaim })),
              attemptedRecords: row.attemptedRecords ?? [],
            },
          ]),
        ),
      },
      matched: caseDef.expect.csv !== undefined ? result.data.csv === caseDef.expect.csv : result.data.csv === undefined,
    });
    const lastAttempt = attempts[attempts.length - 1];
    if (
      LIVE &&
      caseDef.judge !== null &&
      lastAttempt !== undefined &&
      lastAttempt.kind === "error" &&
      ["JEV_DEV_AUTH", "JEV_DEV_MALFORMED", "JEV_DEV_MODEL", "JEV_DEV_PROTOCOL"].includes(lastAttempt.code)
    ) {
      stopReasons.push(`fatal adapter failure in ${caseDef.id}: ${lastAttempt.code}`);
      stopped = true;
    }
  } catch (error) {
    results.push({ id: caseDef.id, error: String(error?.message ?? error) });
    if (LIVE) {
      stopReasons.push(`engine error in ${caseDef.id}`);
      stopped = true;
    }
  }
}

function makeJudgingJudge() {
  const reservation = makeReservation();
  const hooks = {
    onAttempt: (result) => {
      attempts.push({
        caseId: currentCaseId,
        kind: result.kind,
        code: result.kind === "error" ? result.code : undefined,
        uncertainQuestions: result.kind === "indeterminate" ? result.uncertainQuestions : undefined,
        probabilities: result.kind === "error" ? undefined : result.metadata.probabilities,
        resolvedModel: result.kind === "error" ? undefined : result.metadata.resolvedModel,
        requestedModel: result.kind === "error" ? undefined : result.metadata.requestedModel,
        requestSha256: result.kind === "error" ? undefined : result.metadata.attemptSha256,
        usage: result.kind === "error" ? undefined : result.metadata.usage,
        observedCost: result.kind === "error" ? undefined : result.metadata.observedCost,
        status: result.kind === "error" ? undefined : result.metadata.status,
        elapsedMs: result.kind === "error" ? undefined : result.metadata.elapsedMs,
        thresholdRevision: result.kind === "error" ? undefined : result.metadata.thresholdRevision,
        questionRevision: result.kind === "error" ? undefined : result.metadata.questionRevision,
        uncertaintyRevision: result.kind === "error" ? undefined : result.metadata.uncertaintyRevision,
      });
    },
  };
  // The effective timeout is REBUILT before EVERY permitted dispatch
  // (time moves between attempts; a cached first-dispatch timeout could
  // outlive the outer bound). Fetch default = native when LIVE.
  return async (input) => {
    reservation.beforeAttempt();
    const judge = createLeanJevJudge(
      { ...adapterConfig, timeoutMs: attemptTimeout() },
      LIVE ? undefined : refusingFetch,
      hooks,
    );
    return judge(input);
  };
}

const report = {
  mode: LIVE ? "live" : "dry-run",
  caps: { globalAttemptCap: GLOBAL_ATTEMPT_CAP, attemptsUsed, outerBoundMs: OUTER_BOUND_MS, elapsedMs: Date.now() - outerStart },
  stopReasons,
  thresholdPolicy: attempts[0]?.thresholdRevision ?? "trial-v1-p9-p1 (no attempts)",
  cases: results,
  attempts,
};

// Sanitized by construction: no endpoint/model/key/headers/user input values.
console.log(JSON.stringify(report, null, 2));
