/**
 * Joins collected judge answers with the draft labels, for threshold band work
 * (#307) and the context comparison (#308).
 *
 * Makes no requests. It reads the observations file written by
 * judge-band-collect.mjs and imports the labels, which that collector never does.
 *
 * Usage: node tests/judge-band-score.mjs observations.json [--json out.json]
 *
 * The labels are a draft that nobody has reviewed. A bound derived here is a
 * proposal to put in front of the reviewers, not a band to ship.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  candidateGold,
  engineLevelAbstention,
  labelRevision,
  labelStatus,
  questionLabels,
  reviewQuestions,
} from "./judge-band-labels.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--json");
const jsonOut = at === -1 ? undefined : args[at + 1];
const file = args.find((a, i) => i !== at && i !== at + 1 && !a.startsWith("--"));
if (!file) {
  console.error("Usage: node tests/judge-band-score.mjs observations.json [--json out.json]");
  process.exit(2);
}

const TRIAL = { trueBound: 0.9, falseBound: 0.1 };
const f2 = (v) => (v === undefined ? "   -  " : v.toFixed(2));

const data = JSON.parse(readFileSync(file, "utf8"));
if (data.labelBlind !== true) {
  console.error("The observations were not collected blind (labelBlind is not true). Refusing to score them.");
  process.exit(2);
}

// ---- join -------------------------------------------------------------------

const goldOfClassification = new Map();
for (const [caseId, sourceId, relevant, supports, refutes] of questionLabels) {
  goldOfClassification.set(`${caseId}/${sourceId}/relevant`, relevant);
  goldOfClassification.set(`${caseId}/${sourceId}/supports`, supports);
  goldOfClassification.set(`${caseId}/${sourceId}/refutes`, refutes);
}
const goldOfCandidate = (observation) => {
  const gold = candidateGold[observation.proposalId];
  return gold ? gold[observation.question === "support" ? 0 : 1] : undefined;
};

/** One row per answer: what was asked, what the judge answered, and the gold. */
const rows = [];
const unlabeled = new Set();
const errors = data.observations.filter((o) => o.error);
for (const o of data.observations) {
  if (o.error) continue;
  const key = o.kind === "classification" ? `${o.caseId}/${o.sourceId}/${o.question}` : undefined;
  const gold = o.kind === "classification" ? goldOfClassification.get(key) : goldOfCandidate(o);
  if (gold === undefined) {
    unlabeled.add(key ?? o.proposalId);
    continue;
  }
  rows.push({ ...o, gold, item: key ?? `${o.proposalId}/${o.question}`, set: o.kind === "classification" ? o.question : `candidate ${o.question}` });
}
const labelledKeys = new Set([
  ...[...goldOfClassification.keys()],
  ...Object.keys(candidateGold).flatMap((id) => [`${id}/support`, `${id}/conflict`]),
]);
const missing = [...labelledKeys].filter((k) => !rows.some((r) => r.item === k));

const print = (line = "") => console.log(line);

print(`observations: ${data.observations.length} rows, ${data.mode}, judge ${data.judge.requestedModel} (${data.judge.expectedResolvedModel}), band ${data.judge.thresholdRevision}, repeat ${data.repeat}`);
print(`labels: ${labelRevision} (${labelStatus})`);
print(`errors in collection: ${errors.length}${errors.length ? `, first: ${errors[0].error}` : ""}`);
print(`joined: ${rows.length} answers. Unlabelled answers dropped: ${unlabeled.size}. Labelled answers never collected: ${missing.length}${missing.length ? `, first: ${missing[0]}` : ""}.`);
if (data.mode === "dry-run") print("DRY-RUN observations: the numbers below come from a keyword fixture and say nothing about any model.");

// ---- per question -----------------------------------------------------------

const bySet = new Map();
for (const r of rows) bySet.set(r.set, [...(bySet.get(r.set) ?? []), r]);
const sets = [...bySet.keys()].sort((a, b) => (a.startsWith("candidate") ? 1 : 0) - (b.startsWith("candidate") ? 1 : 0) || a.localeCompare(b));
const of = (list, gold) => list.filter((r) => r.gold === gold).map((r) => r.raw);
const max = (v) => (v.length ? Math.max(...v) : undefined);
const min = (v) => (v.length ? Math.min(...v) : undefined);
const count = (v, test) => v.filter(test).length;

print("\n== Answers by gold label, all rounds and repeats ==");
print("set                   true false undet  highF  highFU   lowT   lowTU | T->?   T->F   F->?   F->T");
const summary = {};
for (const set of sets) {
  const list = bySet.get(set);
  const t = of(list, "true");
  const f = of(list, "false");
  const u = of(list, "indeterminate");
  const highFalseOrUnd = max([...f, ...u]);
  const lowTrueOrUnd = min([...t, ...u]);
  summary[set] = {
    items: new Set(list.map((r) => r.item)).size,
    observations: list.length,
    true: t.length,
    false: f.length,
    indeterminate: u.length,
    highestFalse: max(f),
    highestFalseOrIndeterminate: highFalseOrUnd,
    lowestTrue: min(t),
    lowestTrueOrIndeterminate: lowTrueOrUnd,
    trialTrueReadUnknown: count(t, (p) => p < TRIAL.trueBound && p > TRIAL.falseBound),
    trialTrueReadFalse: count(t, (p) => p <= TRIAL.falseBound),
    trialFalseReadUnknown: count(f, (p) => p > TRIAL.falseBound && p < TRIAL.trueBound),
    trialFalseReadTrue: count(f, (p) => p >= TRIAL.trueBound),
    trueAtOrBelowHighestFalseOrIndeterminate: count(t, (p) => highFalseOrUnd !== undefined && p <= highFalseOrUnd),
    falseAtOrAboveLowestTrueOrIndeterminate: count(f, (p) => lowTrueOrUnd !== undefined && p >= lowTrueOrUnd),
  };
  const s = summary[set];
  const col = (v, w) => String(v).padStart(w);
  print(
    `${set.padEnd(19)}  ${col(s.true, 4)}${col(s.false, 6)}${col(s.indeterminate, 6)}  ${f2(s.highestFalse)}  ${f2(s.highestFalseOrIndeterminate)}   ${f2(s.lowestTrue)}  ${f2(s.lowestTrueOrIndeterminate)} |${col(s.trialTrueReadUnknown, 6)}${col(s.trialTrueReadFalse, 7)}${col(s.trialFalseReadUnknown, 7)}${col(s.trialFalseReadTrue, 7)}`,
  );
}
print("Counts are answers. highF: highest answer on a false label. highFU: highest on a false or");
print("indeterminate label. lowT: lowest answer on a true label. lowTU: lowest on a true or");
print("indeterminate label. Under the trial band (.9/.1): T->? true read as unknown, T->F true read");
print("as false, F->? false read as unknown, F->T false read as true.");

print("\n== What a band would have to look like, under the rule proposed in #307 ==");
print("The upper bound sits above every false or indeterminate answer; the lower bound below every true or indeterminate one.");
for (const set of sets) {
  const s = summary[set];
  const upperLoss = s.trueAtOrBelowHighestFalseOrIndeterminate;
  const lowerLoss = s.falseAtOrAboveLowestTrueOrIndeterminate;
  const verdict = upperLoss === 0 && lowerLoss === 0 ? "a band exists on this evidence" : "NO band separates the labels on this evidence";
  print(`- ${set}: upper bound above ${f2(s.highestFalseOrIndeterminate)} (costs ${upperLoss} of ${s.true} true answers); lower bound below ${f2(s.lowestTrueOrIndeterminate)} (costs ${lowerLoss} of ${s.false} false answers). ${verdict}.`);
}

print("\n== Answers the trial band gets wrong ==");
let shown = 0;
for (const r of rows) {
  const wrong = (r.gold === "true" && r.raw < TRIAL.trueBound) || (r.gold === "false" && r.raw > TRIAL.falseBound);
  if (!wrong) continue;
  if (shown === 25) {
    print("  ...");
    break;
  }
  const where = r.kind === "classification" ? `round ${r.round}` : `${r.fieldId}=${r.value}`;
  print(`  ${r.gold.padEnd(5)} read as ${String(r.verdict === null ? "unknown" : r.verdict).padEnd(7)} at ${r.raw.toFixed(2)}  ${r.item}  (${where}, rep ${r.rep})`);
  shown += 1;
}
if (shown === 0) print("  none");

// ---- spread over repeats ------------------------------------------------------

print(`\n== Spread across ${data.repeat} repeat(s) of the same request ==`);
if (data.repeat < 2) {
  print("One repeat only: nothing to measure. Collect with --repeat 3 or more before trusting a bound.");
} else {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.item}|${r.kind === "classification" ? `round ${r.round}` : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const spreads = [...groups.values()].map((g) => Math.max(...g.map((r) => r.raw)) - Math.min(...g.map((r) => r.raw)));
  const unstable = [...groups.values()].filter((g) => new Set(g.map((r) => r.verdict)).size > 1);
  const sorted = [...spreads].sort((a, b) => a - b);
  print(`largest spread ${f2(max(spreads))}, median ${f2(sorted[Math.floor(sorted.length / 2)])}; requests whose verdict changed between repeats: ${unstable.length} of ${groups.size}. A band narrower than the largest spread will flip verdicts on unchanged input.`);
}

// ---- context drift, for #308 ---------------------------------------------------

print("\n== Context drift: one document's answer as more documents join the request (#308) ==");
{
  const series = new Map();
  for (const r of rows) {
    if (r.kind !== "classification") continue;
    const key = r.item;
    const byRound = series.get(key) ?? new Map();
    byRound.set(r.round, [...(byRound.get(r.round) ?? []), r]);
    series.set(key, byRound);
  }
  const movers = [];
  for (const [item, byRound] of series) {
    const rounds = [...byRound.keys()].sort((a, b) => a - b);
    if (rounds.length < 2) continue;
    const mean = (k) => byRound.get(k).reduce((sum, r) => sum + r.raw, 0) / byRound.get(k).length;
    const verdict = (k) => (byRound.get(k).every((r) => r.verdict === byRound.get(k)[0].verdict) ? byRound.get(k)[0].verdict : "mixed");
    const first = rounds[0];
    const last = rounds[rounds.length - 1];
    movers.push({ item, rounds: rounds.length, first: mean(first), last: mean(last), drift: mean(last) - mean(first), verdictChanged: verdict(first) !== verdict(last) });
  }
  const changed = movers.filter((m) => m.verdictChanged);
  const multi = movers.filter((m) => m.rounds > 2);
  print(`${movers.length} document answers were observed in more than one round (${multi.length} of them in three or more). Verdict changed between the first and the last round for ${changed.length}.`);
  for (const m of [...movers].sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift)).slice(0, 12)) {
    print(`  ${m.drift >= 0 ? "+" : ""}${m.drift.toFixed(2)}  ${m.first.toFixed(2)} -> ${m.last.toFixed(2)} over ${m.rounds} rounds${m.verdictChanged ? "  VERDICT CHANGED" : ""}  ${m.item}`);
  }
  print("This collector uses one request shape only, so it cannot tell a drift caused by the");
  print("other documents from run-to-run noise. The two-shape comparison in #308 can.");
}

print("\n== Questions reviewers must settle before any of this is ground truth ==");
for (const q of reviewQuestions) print(`- ${q}`);
print(`\nCases whose field gold is null for an engine-level reason, and so is not checked here: ${Object.keys(engineLevelAbstention).join(", ") || "none"}.`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ observations: { file, mode: data.mode, judge: data.judge, repeat: data.repeat }, labels: { labelRevision, labelStatus }, summary }, null, 1) + "\n");
  print(`\nsummary written to ${jsonOut}`);
}
