#!/usr/bin/env node
/**
 * Development-only E2E runner: arbitrary-candidate path with NATIVE
 * transports (runtime-configured) × external fixture sources.
 *
 * OPT-IN: dry-run default (refusing stubs, zero network). --live requires
 * LUNA_DEV_* + JEV_DEV_* runtime env (parent-only; never printed).
 *
 *   --fixture <path>          EXTRACTION-LUNA-INSTRUCTED.json (7 sources + golds)
 *   --rejection-fixtures <p>  bad Turbo/Small raw outputs for replay controls
 *
 * Caps (brief): 8 extraction + 16 judge calls GLOBAL (per-dispatch
 * reservation, failures count), 30s extraction / 15s judge timeouts,
 * 5-minute outer bound, serial, no retries. Fatal classes (AUTH/MALFORMED/
 * MODEL/PROTOCOL/REQUEST_CAP) stop further live work. Report: per-source
 * per-field validation/judgement/acceptance trail, raw probabilities,
 * hashes, usage/cost-or-null (never fabricated zero; official-rate cost
 * estimates are computed ONLY from rates passed at runtime via
 * --cost-rates <path>), latency p50/range, coverage/precision vs golds.
 */
import { readFileSync } from "node:fs";
import { validateCandidates, assessCandidates, acceptCandidate, candidateSourceDigest, buildCandidateJudgeRequest } from "../dist/lib/lean-candidates.js";
import { runLunaExtraction, runCandidateJudge } from "../dist/lib/lean-candidate-transport.js";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const FIXTURE = flag("--fixture");
const REJECTION = flag("--rejection-fixtures");
const COST_RATES = flag("--cost-rates");

if (!FIXTURE) {
  console.error("--fixture <path> is required (external EXTRACTION-LUNA-INSTRUCTED.json)");
  process.exit(2);
}

const LUNA = LIVE && {
  endpoint: process.env.LUNA_DEV_ENDPOINT,
  model: process.env.LUNA_DEV_MODEL,
  apiKey: process.env.LUNA_DEV_API_KEY,
  allowHttp: process.env.LUNA_DEV_ALLOW_HTTP === "1",
  allowedModels: process.env.LUNA_DEV_ALLOWED_MODELS?.split(",").map((m) => m.trim()).filter(Boolean),
};
const JEV = LIVE && {
  endpoint: process.env.JEV_DEV_ENDPOINT,
  model: process.env.JEV_DEV_MODEL,
  apiKey: process.env.JEV_DEV_API_KEY,
  allowHttp: process.env.JEV_DEV_ALLOW_HTTP === "1",
  allowedModels: process.env.JEV_DEV_ALLOWED_MODELS?.split(",").map((m) => m.trim()).filter(Boolean),
};
if (LIVE && (!LUNA.endpoint || !LUNA.model || !LUNA.apiKey || !JEV.endpoint || !JEV.model || !JEV.apiKey)) {
  console.error("live mode requires LUNA_DEV_ENDPOINT/MODEL/API_KEY and JEV_DEV_ENDPOINT/MODEL/API_KEY");
  process.exit(2);
}

const CAP_EXTRACT = 8;
const CAP_JUDGE = 16;
const OUTER_BOUND_MS = 300_000;
const EXTRACT_TIMEOUT = 30_000;
const JUDGE_TIMEOUT = 15_000;
const REQUEST_CAP = 96 * 1024; // serialized framing+schema+source; explicit CAND_REQUEST_CAP, never trim
const RESPONSE_CAP = 64 * 1024;

const outerStart = Date.now();
const remainingOuter = () => OUTER_BOUND_MS - (Date.now() - outerStart);
let extractUsed = 0;
let judgeUsed = 0;
const stopReasons = [];
let stopped = false;
const attempts = [];

const FIELD_SCHEMAS = {
  invoiceId: { pattern: "^INV-[0-9A-Za-z\\uFF10-\\uFF19-\\u7532\\u4E59]+$", minLength: 3, maxLength: 4096 },
  license: { pattern: "^[A-Za-z0-9.+-]+$", minLength: 2, maxLength: 4096 },
};
const FIELD_SPECS = [
  { id: "invoiceId", description: "The billing invoice identifier exactly as printed for this release." },
  { id: "license", description: "The license explicitly applying to ExampleApp release 2.4.0." },
];
const FIELD_MEANINGS = Object.fromEntries(FIELD_SPECS.map((f) => [f.id, f.description]));
const SCOPE = { entity: "ExampleApp", release: "2.4.0" };

const refusingFetch = async () => {
  throw new Error("DRY RUN: network is forbidden without --live");
};

const MAX_FIXTURE_FILE_BYTES = 1024 * 1024; // 1 MiB per approved proof cap
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RAW_OUTPUT_BYTES = 64 * 1024;

/**
 * Preflight an external workload file: finite byte size, unique record
 * IDs, exact two string|null gold fields, string bounded source and
 * rawOutput, string finishReason. Throws a loud ValidationError —
 * BEFORE any model dispatch. No schema framework; static shape checks.
 */
function preflightWorkload(parsed, what) {
  const text = JSON.stringify(parsed);
  if (Buffer.byteLength(text, "utf8") > MAX_FIXTURE_FILE_BYTES) {
    throw new Error(`${what}: file exceeds the ${MAX_FIXTURE_FILE_BYTES}-byte proof ceiling`);
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.results)) {
    throw new Error(`${what}: expected an object with a results array`);
  }
  const seen = new Set();
  for (const r of parsed.results) {
    if (r === null || typeof r !== "object") throw new Error(`${what}: record not an object`);
    if (typeof r.id !== "string" || r.id.length === 0) throw new Error(`${what}: record id must be a non-empty string`);
    if (seen.has(r.id)) throw new Error(`${what}: duplicate record id "${r.id}"`);
    seen.add(r.id);
    if (typeof r.source !== "string") throw new Error(`${what} "${r.id}": source must be a string`);
    if (Buffer.byteLength(r.source, "utf8") > MAX_SOURCE_BYTES) throw new Error(`${what} "${r.id}": source exceeds ${MAX_SOURCE_BYTES} bytes`);
    if (typeof r.rawOutput !== "string") throw new Error(`${what} "${r.id}": rawOutput must be a string`);
    if (Buffer.byteLength(r.rawOutput, "utf8") > MAX_RAW_OUTPUT_BYTES) throw new Error(`${what} "${r.id}": rawOutput exceeds ${MAX_RAW_OUTPUT_BYTES} bytes`);
    if (typeof r.finishReason !== "string") throw new Error(`${what} "${r.id}": finishReason must be a string`);
    const gold = r.gold;
    if (gold === null || typeof gold !== "object" || Array.isArray(gold)) throw new Error(`${what} "${r.id}": gold must be an object`);
    const keys = Object.keys(gold).sort();
    if (keys.length !== 2 || keys[0] !== "invoiceId" || keys[1] !== "license") {
      throw new Error(`${what} "${r.id}": gold must have exactly the invoiceId and license fields`);
    }
    for (const v of Object.values(gold)) {
      if (v !== null && typeof v !== "string") throw new Error(`${what} "${r.id}": gold values must be string or null`);
    }
  }
  return parsed;
}

/** Rates must be exactly four finite non-negative numbers (0 is legit). */
function preflightRates(parsed) {
  if (parsed === null || typeof parsed !== "object") throw new Error("cost rates: expected an object");
  for (const key of ["extractionInputPerMillion", "extractionOutputPerMillion", "judgeInputPerMillion", "judgeOutputPerMillion"]) {
    const v = parsed[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`cost rates: ${key} must be a finite non-negative number`);
    }
  }
  return parsed;
}

import { statSync, openSync, readSync, closeSync, fstatSync } from "node:fs";

/**
 * Bounded raw-file read with an EOF SENTINEL against growth: stat the
 * path (regular-file gate) BEFORE open, then trust only the FD —
 * fstat its CURRENT size, allocate cap+1, and read until EOF. A file
 * that grew after stat yields fstat size > cap (or a suffix read past
 * the stat size) and rejects BEFORE parse/network. The retained bytes
 * are exactly what the fd yielded; no claim of an atomic read beyond
 * that (same-size in-place mutation would read mutated bytes — the
 * digest binds whatever was actually read).
 */
function readBoundedJson(path, what) {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${what}: not a regular file`);
  const fd = openSync(path, "r");
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile()) throw new Error(`${what}: fd is not a regular file`);
    if (fst.size > MAX_FIXTURE_FILE_BYTES) {
      throw new Error(`${what}: file is ${fst.size} bytes, over the ${MAX_FIXTURE_FILE_BYTES}-byte proof ceiling`);
    }
    // Allocate cap+1 so a growth past the cap is READ (detected) rather
    // than pre-truncated by the buffer bound.
    const buf = Buffer.alloc(MAX_FIXTURE_FILE_BYTES + 1);
    let read = 0;
    while (read <= MAX_FIXTURE_FILE_BYTES) {
      const n = readSync(fd, buf, read, buf.length - read);
      if (n <= 0) break; // EOF sentinel: fd exhausted
      read += n;
      if (read > MAX_FIXTURE_FILE_BYTES) {
        throw new Error(`${what}: file grew past the ${MAX_FIXTURE_FILE_BYTES}-byte ceiling during read`);
      }
      // Any bytes beyond the stat-time size mean the file changed after
      // stat — reject before parse/network.
      if (read > st.size) {
        throw new Error(`${what}: file changed size after stat (suffix present) — refusing the read`);
      }
    }
    return JSON.parse(buf.subarray(0, read).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

// ALL external inputs validated UPFRONT — before any primary model work.
// The parsed representations are RETAINED and reused; nothing is read a
// second time later (billed work cannot precede a replay re-read).
const fixture = preflightWorkload(readBoundedJson(FIXTURE, "fixture"), "fixture");
const rates = COST_RATES ? preflightRates(readBoundedJson(COST_RATES, "cost rates")) : null;
const rejectionWorkload = REJECTION
  ? preflightWorkload(readBoundedJson(REJECTION, "rejection fixtures"), "rejection fixtures")
  : null;

function reserve(kind) {
  if (kind === "extract" && extractUsed >= CAP_EXTRACT) return false;
  if (kind === "judge" && judgeUsed >= CAP_JUDGE) return false;
  if (remainingOuter() <= 0) return false;
  if (kind === "extract") extractUsed += 1;
  else judgeUsed += 1;
  return true;
}

/**
 * SHARED attempt normalization for every outcome (ok and error alike —
 * no extractor/judge asymmetry): observed metadata from either
 * `metadata` (ok) or `observed` (rejected-but-measured) is conserved;
 * unknown stays absent, never fabricated.
 */
function noteAttempt(kind, result) {
  const m = result.kind === "ok" ? result.metadata : result.observed;
  attempts.push({
    kind,
    ok: result.kind === "ok",
    code: result.kind === "error" ? result.code : undefined,
    requestSha256: m?.requestSha256,
    resolvedModel: m?.resolvedModel,
    usage: m?.usage,
    observedCost: result.kind === "ok" ? result.metadata.observedCost : undefined,
    elapsedMs: m?.elapsedMs,
    status: m?.status,
  });
  return result;
}

const FATAL = ["CAND_AUTH", "CAND_MALFORMED", "CAND_MODEL", "CAND_PROTOCOL", "CAND_REQUEST_CAP"];

async function extract(source) {
  if (!reserve("extract")) {
    stopReasons.push("extraction cap or outer bound reached");
    stopped = true;
    return { kind: "error", code: "CAND_CAP", message: "cap" };
  }
  const r = await runLunaExtraction(
    { sourceId: source.evidenceId, sourceText: source.content, fields: FIELD_SPECS },
    {
      ...(LIVE
        ? {
            endpoint: LUNA.endpoint,
            model: LUNA.model,
            apiKey: LUNA.apiKey,
            allowHttp: LUNA.allowHttp,
            ...(LUNA.allowedModels ? { allowedModels: LUNA.allowedModels } : {}),
          }
        : { endpoint: "https://dry-run.invalid/x", model: "dry", apiKey: "dry" }),
      maxRequestBytes: REQUEST_CAP,
      maxResponseBytes: RESPONSE_CAP,
      timeoutMs: Math.min(EXTRACT_TIMEOUT, Math.max(1, remainingOuter())),
    },
    LIVE ? undefined : refusingFetch,
  );
  noteAttempt("extract", r);
  if (r.kind === "error" && FATAL.includes(r.code)) {
    stopReasons.push(`fatal extraction failure: ${r.code}`);
    stopped = true;
  }
  return r;
}

async function judge(input) {
  if (!reserve("judge")) {
    stopReasons.push("judge cap or outer bound reached");
    stopped = true;
    return { kind: "error", code: "CAND_CAP", message: "cap" };
  }
  return dispatchJudgeNoReserve(input);
}

/** Judge dispatch WITHOUT reservation (caller reserved already). */
async function dispatchJudgeNoReserve(input) {
  const r = await runCandidateJudge(
    input,
    {
      ...(LIVE
        ? { endpoint: JEV.endpoint, model: JEV.model, apiKey: JEV.apiKey, allowHttp: JEV.allowHttp, ...(JEV.allowedModels ? { allowedModels: JEV.allowedModels } : {}) }
        : { endpoint: "https://dry-run.invalid/x", model: "dry", apiKey: "dry" }),
      maxRequestBytes: REQUEST_CAP,
      maxResponseBytes: RESPONSE_CAP,
      timeoutMs: Math.min(JUDGE_TIMEOUT, Math.max(1, remainingOuter())),
    },
    buildCandidateJudgeRequest,
    LIVE ? undefined : refusingFetch,
  );
  noteAttempt("judge", r);
  if (r.kind === "error" && FATAL.includes(r.code)) {
    stopReasons.push(`fatal judge failure: ${r.code}`);
    stopped = true;
  }
  return r;
}

// --- primary workload: the 7 fixed sources -------------------------------
const cases = [];
for (const record of fixture.results) {
  if (stopped) { cases.push({ id: record.id, skipped: true }); continue; }
  const source = {
    evidenceId: `s-${record.id}`,
    url: `fixture://${record.id}`,
    title: record.id,
    content: record.source,
    byteLength: Buffer.byteLength(record.source, "utf8"),
    origins: [],
  };
  const caseStart = Date.now();
  const row = { id: record.id, gold: record.gold, fields: {}, latencies: { extractionMs: 0, judgeMs: 0 } };

  // Extraction (dry-run: use the fixture's own rawOutput — deterministic replay)
  let extraction;
  if (LIVE) {
    const t0 = Date.now();
    extraction = await extract(source);
    row.latencies.extractionMs = Date.now() - t0;
  } else {
    extraction = {
      kind: "ok",
      value: { finishReason: record.finishReason, rawOutput: record.rawOutput },
      metadata: { requestSha256: `dry-${record.id}`, requestedModel: "dry", resolvedModel: "dry", status: 0, elapsedMs: 0, usage: { inputTokens: 0, outputTokens: 0 }, observedCost: null },
    };
  }
  if (extraction.kind !== "ok") {
    row.extractionError = extraction.code;
    row.latencies.endToEndMs = Date.now() - caseStart;
    cases.push(row);
    continue;
  }

  const validation = validateCandidates(source, extraction.value, FIELD_SCHEMAS);
  row.validation = validation.fields.map((f) => ({ fieldId: f.fieldId, status: f.status, reason: f.reason }));

  const candidates = validation.fields.filter((f) => f.status === "candidate" && f.value && f.quote && f.charRange);
  if (candidates.length > 0 && !stopped) {
    const judgedInput = {
      source,
      fieldMeanings: FIELD_MEANINGS,
      scope: SCOPE,
      candidates: candidates.map((c) => ({ fieldId: c.fieldId, value: c.value, quote: c.quote, charRange: c.charRange })),
      opposingContext: [],
    };
    let assessment;
    if (LIVE) {
      const t0 = Date.now();
      const judged = await judge(judgedInput);
      row.latencies.judgeMs = Date.now() - t0;
      if (judged.kind !== "ok") {
        row.judgeError = judged.code;
        // Failed judgment still records the case E2E time and the
        // VALIDATED candidate provenance (quote/range/digest/candidateId)
        // — visible without being accepted.
        for (const c of candidates) {
          row.fields[c.fieldId] = {
            status: "unresolved",
            reason: "judge_error",
            value: c.value,
            quote: c.quote,
            charRange: c.charRange,
            sourceDigest: validation.sourceDigest,
            candidateId: c.candidateId,
          };
        }
        row.latencies.endToEndMs = Date.now() - caseStart;
        cases.push(row);
        continue;
      }
      assessment = await assessCandidates(judgedInput, { judge: async () => ({
        model: judged.metadata.resolvedModel,
        answers: judged.value,
        usage: judged.metadata.usage,
        requestSha256: judged.metadata.requestSha256,
        elapsedMs: judged.metadata.elapsedMs,
      }) });
    } else {
      void 0;
      // DRY RUN: deterministic synthetic probabilities from the fixture
      // GOLD — proves the pipeline wiring end-to-end with zero network.
      // Disclosed: dry-run judgments are gold-derived, not model output.
      row.latencies.judgeMs = 0;
      assessment = await assessCandidates(judgedInput, { judge: async (input) => ({
        model: "dry-run-synthetic",
        answers: Object.fromEntries(input.candidates.flatMap((c, i) => {
          const gold = record.gold[c.fieldId];
          const correct = gold === c.value;
          return [
            [`q${i}s`, { type: "noul", noul: correct ? 0.97 : 0.03 }],
            [`q${i}c`, { type: "noul", noul: 0.02 }],
          ];
        })),
        usage: { inputTokens: 0, outputTokens: 0 },
        requestSha256: `dry-judge-${record.id}`,
        elapsedMs: 0,
      }) });
    }
    if (assessment.error) row.assessmentError = assessment.error;
    if (assessment.error) row.assessmentError = assessment.error;
    for (let i = 0; i < candidates.length; i++) {
      const outcome = acceptCandidate(candidates[i], assessment.judgements[i] ?? null, source, validation.sourceDigest, judgedInput);
      const p = outcome.provenance;
      row.fields[candidates[i].fieldId] = {
        status: outcome.status,
        reason: outcome.reason,
        // Full evidence audit: value/quote/charRange/sourceDigest/candidateId
        // (from the validated candidate) + raw scores, retained on
        // acceptance AND rejection.
        value: p?.value ?? candidates[i].value,
        quote: p?.quote ?? candidates[i].quote,
        charRange: p?.charRange ?? candidates[i].charRange,
        sourceDigest: p?.sourceDigest ?? validation.sourceDigest,
        candidateId: candidates[i].candidateId,
        raw: assessment.judgements[i] ? { support: assessment.judgements[i].rawSupport, conflict: assessment.judgements[i].rawConflict } : undefined,
      };
    }
  }
  row.latencies.endToEndMs = Date.now() - caseStart;
  cases.push(row);
}

// --- adversarial replay workload (separate; structurally-ELIGIBLE bad rows are judged under the cap, only structurally-invalid rows stay zero-judge) --
const rejection = [];
if (REJECTION) {
  const rej = rejectionWorkload; // retained upfront representation — no second read
  for (const record of rej.results ?? []) {
    const source = {
      evidenceId: `r-${record.id}`,
      url: `fixture://rejection/${record.id}`,
      title: record.id,
      content: record.source,
      byteLength: Buffer.byteLength(record.source, "utf8"),
      origins: [],
    };
    const validation = validateCandidates(source, { finishReason: record.finishReason, rawOutput: record.rawOutput }, FIELD_SCHEMAS);
    const eligible = validation.fields.filter((f) => f.status === "candidate" && f.value && f.quote && f.charRange);
    const row = {
      id: record.id,
      gold: record.gold,
      validation: validation.fields.map((f) => ({ fieldId: f.fieldId, status: f.status, reason: f.reason })),
      judgeCalls: 0,
      fields: {},
    };
    if (eligible.length > 0 && !stopped) {
      if (!reserve("judge")) {
        // Structurally-ELIGIBLE bad row skipped because the cap is
        // exhausted — never mislabeled structurally invalid.
        row.note = "judge cap exhausted — eligible candidate not judged";
        rejection.push(row);
        continue;
      }
      // Structurally VALID bad candidates (literal-quote script /
      // wrong-release / conflict rows) are NOT rejected on structure —
      // they receive a REAL semantic judgment under the remaining judge
      // cap; only structurally-invalid rows (bad quote/length/refusal)
      // stay zero-judge.
      const judgedInput = {
        source,
        fieldMeanings: FIELD_MEANINGS,
        scope: SCOPE,
        candidates: eligible.map((c) => ({ fieldId: c.fieldId, value: c.value, quote: c.quote, charRange: c.charRange })),
        opposingContext: [],
      };
      let judged;
      if (LIVE) {
        // Reservation already taken by the wrap above; dispatch without
        // a second reservation.
        const t0 = Date.now();
        judged = await dispatchJudgeNoReserve(judgedInput);
        row.judgeMs = Date.now() - t0;
      } else {
        // DRY RUN: gold-derived synthetic judgment (disclosed; wiring
        // control only) — bad replay candidates get LOW support because
        // gold says the field is absent/null.
        judged = { kind: "ok", value: Object.fromEntries(judgedInput.candidates.flatMap((c, i) => {
          const gold = record.gold[c.fieldId];
          const correct = gold === c.value;
          return [[`q${i}s`, { type: "noul", noul: correct ? 0.97 : 0.03 }], [`q${i}c`, { type: "noul", noul: 0.02 }]];
        })), metadata: { requestSha256: `dry-replay-${record.id}`, resolvedModel: "dry-run-synthetic", usage: { inputTokens: 0, outputTokens: 0 }, elapsedMs: 0 } };
        // Same reservation accounting as LIVE (shared cap ≤16; dry never
        // exceeds the proof ceiling). Denied reservation → capped label.
      }
      if (judged.kind === "ok") {
        row.judgeCalls = 1;
        const assessment = await assessCandidates(judgedInput, { judge: async () => ({
          model: judged.metadata.resolvedModel,
          answers: judged.value,
          usage: judged.metadata.usage,
          requestSha256: judged.metadata.requestSha256,
          elapsedMs: judged.metadata.elapsedMs,
        }) });
        for (let i = 0; i < eligible.length; i++) {
          const outcome = acceptCandidate(eligible[i], assessment.judgements[i] ?? null, source, validation.sourceDigest, judgedInput);
          row.fields[eligible[i].fieldId] = {
            status: outcome.status,
            reason: outcome.reason,
            value: eligible[i].value,
            quote: eligible[i].quote,
            charRange: eligible[i].charRange,
            sourceDigest: validation.sourceDigest,
            candidateId: eligible[i].candidateId,
            raw: assessment.judgements[i] ? { support: assessment.judgements[i].rawSupport, conflict: assessment.judgements[i].rawConflict } : undefined,
            judgeMs: row.judgeMs ?? 0,
          };
        }
      } else {
        row.judgeError = judged.code;
      }
    } else {
      row.note = "structurally invalid — zero judge dispatch by design";
    }
    rejection.push(row);
  }
}

// --- metrics ------------------------------------------------------------
// Denominators derive from the IMMUTABLE loaded workload (fixture rows),
// never from the processed/skipped subset: failed or skipped fields stay
// in the eligible denominators.
const workloadRows = fixture.results.filter((r) => r.gold);
const goldSlots = workloadRows.flatMap((r) => Object.keys(r.gold));
const presentGoldCount = workloadRows.flatMap((r) => Object.entries(r.gold).filter(([, v]) => v !== null).map(([k]) => k)).length;
const abstainGold = goldSlots.length - presentGoldCount;
let acceptedCorrect = 0;
let acceptedTotal = 0;
for (const c of cases) {
  for (const [fieldId, f] of Object.entries(c.fields ?? {})) {
    if (f.status === "accepted") {
      acceptedTotal += 1;
      if (c.gold[fieldId] === f.value) acceptedCorrect += 1;
    }
  }
}
// Eligible coverage: accepted-correct over ALL present gold fields —
// an all-reject run reports coverage 0 with precision null (never a
// fake precision from an empty denominator).
const eligibleCoverage = presentGoldCount > 0 ? acceptedCorrect / presentGoldCount : null;
// Per-stage latency distributions + per-case end-to-end walltimes.
const dist = (vals) => {
  const sorted = vals.filter((v) => typeof v === "number").sort((a, b) => a - b);
  return sorted.length ? { samples: sorted.length, p50Ms: sorted[Math.floor(sorted.length / 2)], rangeMs: [sorted[0], sorted[sorted.length - 1]] } : null;
};
const stageLatency = {
  extraction: dist(cases.flatMap((c) => c.latencies?.extractionMs)),
  judge: dist(cases.flatMap((c) => (typeof c.latencies?.judgeMs === "number" ? [c.latencies.judgeMs] : []))),
  endToEnd: dist(cases.map((c) => c.latencies?.endToEndMs)),
  // Interpret carefully: judge samples are PER-CASE judge-stage times
  // and include ZERO-duration entries for cases with no judge dispatch
  // (a no-judge case contributes 0 to this axis, not an absence); E2E
  // covers all processed cases. These are not per-request latencies —
  // p50 here understates actual per-request judge time when no-dispatch
  // cases are present.
};
// Per-stage token totals (all attempts incl. failures + replay; observed
// metadata only — absent usage stays absent, never zero-inferred).
const stageTokens = (kind) => attempts.filter((a) => a.kind === kind && a.usage).reduce((acc, a) => ({ input: acc.input + a.usage.inputTokens, output: acc.output + a.usage.outputTokens }), { input: 0, output: 0 });
const extractTokens = stageTokens("extract");
const judgeTokens = stageTokens("judge");
// Per-stage cost at PER-STAGE rates; total = extraction + judge; plus
// cost per correct accepted field. Unknown rates → null (not zero).
const estimate = (tokens, rin, rout) =>
  rates ? (tokens.input / 1e6) * rin + (tokens.output / 1e6) * rout : null;
const estimatedExtraction = estimate(extractTokens, rates?.extractionInputPerMillion, rates?.extractionOutputPerMillion);
const estimatedJudge = estimate(judgeTokens, rates?.judgeInputPerMillion, rates?.judgeOutputPerMillion);
// UNKNOWN-usage rule: any PHYSICAL attempt without measured usage makes
// the whole-workload estimate incomplete — total and cost-per-correct are
// null (never a silent zero-token sum). Known-attempt subtotals stand as
// an explicit LOWER BOUND.
const physicalAttempts = attempts.length;
const unknownUsageAttempts = attempts.filter((a) => !a.usage).length;
const estimateIncomplete = physicalAttempts > 0 && unknownUsageAttempts > 0;
const estimatedTotal = estimateIncomplete || estimatedExtraction === null || estimatedJudge === null
  ? null
  : estimatedExtraction + estimatedJudge;
const costPerCorrectAccepted = estimatedTotal !== null && acceptedCorrect > 0 ? estimatedTotal / acceptedCorrect : null;
const estimatedKnownLowerBound = estimateIncomplete
  ? (estimatedExtraction ?? 0) + (estimatedJudge ?? 0)
  : null;
// Observed TOTAL billing: unknown (null) whenever ANY physical attempt's
// charge is unknown — a partial known sum is never presented as the
// total. The known subtotal is reported separately.
const attemptCosts = attempts.map((a) => (typeof a.observedCost === "number" ? a.observedCost : null));
const anyUnknown = attemptCosts.some((c) => c === null);
const knownSubtotal = attemptCosts.reduce((acc, c) => (c === null ? acc : acc + c), 0);
const observedTotal = attempts.length === 0 ? null : anyUnknown ? null : knownSubtotal;

const report = {
  mode: LIVE ? "live" : "dry-run",
  caps: { extract: { used: extractUsed, cap: CAP_EXTRACT }, judge: { used: judgeUsed, cap: CAP_JUDGE }, outerBoundMs: OUTER_BOUND_MS, elapsedMs: Date.now() - outerStart },
  stopReasons,
  gold: { totalSlots: goldSlots.length, present: presentGoldCount, abstentions: abstainGold, note: "denominators from the immutable loaded workload incl. skipped cases" },
  metrics: {
    acceptedFields: acceptedTotal,
    acceptedCorrect,
    acceptedPrecision: acceptedTotal > 0 ? acceptedCorrect / acceptedTotal : null,
    eligibleCoverage,
    latency: { ...stageLatency, note: "per-stage distributions + per-case end-to-end walltimes; mixing stages is not E2E" },
    usage: LIVE
      ? { extraction: extractTokens, judge: judgeTokens, note: "observed only — absent counters absent, never zero-inferred" }
      : "dry-run (fixture-replay zeros are metadata, not observed usage)",
    estimatedOfficialCost: LIVE
      ? {
          extraction: estimatedExtraction,
          judge: estimatedJudge,
          total: estimatedTotal,
          costPerCorrectAccepted,
          ...(estimateIncomplete
            ? {
                incomplete: true,
                knownLowerBound: estimatedKnownLowerBound,
                note: `${unknownUsageAttempts}/${physicalAttempts} physical attempts have unknown usage — total and per-correct are null; knownLowerBound covers measured attempts only. Rates are caller-supplied published rates; actual billing unknown, never inferred free.`,
              }
            : {
                note: "computed from caller-supplied published rates at per-stage rates incl. failed attempts and replay work — actual billing unknown, never inferred free",
              }),
        }
      : null,
    observedCost: observedTotal,
    observedCostKnownSubtotal: observedTotal === null && attempts.length > 0 ? knownSubtotal : observedTotal,
  },
  cases,
  rejectionReplay: rejection,
  attempts,
  disclosures: [
    "Production provider attestation EXPLICITLY UNBUILT — no official-route substitution claim.",
    "observedCost null means absent; never inferred free/zero from a local route.",
    "Replay workload: structurally-ELIGIBLE bad candidates (literal-quote script/wrong-release/conflict) receive real semantic judgment under the judge cap; only structurally-invalid rows (bad quote/length/refusal) stay zero-judge.",
    "First evaluation is not calibration.",
  ],
};

console.log(JSON.stringify(report, null, 2));
