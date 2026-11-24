/**
 * Offline consistency checks for the draft label layer of #307.
 *
 * The labels are a draft. These tests do not make them true. They check that the
 * draft is internally consistent and that it agrees with the existing field-level
 * labels in unified-review-labels.mjs wherever those apply:
 *
 *   - every development document has exactly one label per question, and the
 *     reserved cases have none;
 *   - the per-document labels aggregate, by the engine's own rule, to the CSV
 *     verdict the existing labels give;
 *   - the candidate values that would be accepted are exactly the version and
 *     license values the labels give;
 *   - the collector that sends requests to a judge never imports the labels.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inputs } from "./unified-review-corpus.mjs";
import { labels as ownerLabels } from "./unified-review-labels.mjs";
import { candidateProposals, supplementInputs } from "./judge-band-supplement.mjs";
import {
  candidateGold,
  engineLevelAbstention,
  labelStatus,
  questionLabels,
  rationale,
  supplementFieldGold,
} from "./judge-band-labels.mjs";

const T = "true";
const F = "false";
const allCases = [...inputs, ...supplementInputs];
const caseById = new Map(allCases.map((c) => [c.id, c]));
const ownerGold = new Map(ownerLabels.map((row) => [row.id, row.fields]));
const supplementGold = new Map(supplementFieldGold.map((row) => [row.id, row.fields]));
const development = allCases.filter((c) => c.split === "development");
const reserved = allCases.filter((c) => c.split !== "development");
const readable = (c) => c.sources.filter((s) => !s.readError && s.content);
const contentOf = (caseId, sourceId) =>
  readable(caseById.get(caseId)).find((s) => s.id === sourceId)?.content;

/** The engine's rule for one field, with indeterminate read as unknown. */
function aggregate(labels, enumValues) {
  const docs = labels.map(([, , relevant, supports, refutes]) => ({ relevant, supports, refutes }));
  const clearSupport = docs.filter((d) => d.relevant === T && d.supports === T).length;
  const clearRefute = docs.filter((d) => d.relevant === T && d.refutes === T).length;
  const supportBlocker = docs.some((d) => d.relevant !== F && d.refutes !== F);
  const refuteBlocker = docs.some((d) => d.relevant !== F && d.supports !== F);
  if (clearSupport && clearRefute) return enumValues.includes("disputed") ? "disputed" : null;
  if (clearSupport && !supportBlocker) return "supported";
  if (clearRefute && !refuteBlocker) return "refuted";
  return null;
}

const labelsOf = (caseId) => questionLabels.filter((row) => row[0] === caseId);
/** Values the engine would accept for a field: support true and conflict false. */
const acceptedValues = (caseId, fieldId) =>
  new Set(
    candidateProposals
      .filter((p) => p.caseId === caseId && p.fieldId === fieldId)
      .filter((p) => {
        const gold = candidateGold[p.id];
        return gold && gold[0] === T && gold[1] === F;
      })
      .map((p) => p.value),
  );
const expectedAccepted = (gold) => new Set(gold === null || gold === undefined ? [] : [gold]);

describe("judge band labels: coverage", () => {
  it("labels every readable document of every development case once, and nothing else", () => {
    const expected = new Set(
      development.flatMap((c) => readable(c).map((s) => `${c.id}/${s.id}`)),
    );
    const actual = questionLabels.map(([caseId, sourceId]) => `${caseId}/${sourceId}`);
    assert.equal(new Set(actual).size, actual.length, "no document is labelled twice");
    assert.deepEqual(new Set(actual), expected);
  });

  it("leaves the reserved cases unlabelled, so they stay out of tuning", () => {
    assert.ok(reserved.length > 0, "the corpus has reserved cases");
    for (const c of reserved) {
      assert.equal(labelsOf(c.id).length, 0, c.id);
    }
  });

  it("uses only true, false or indeterminate, one answer per question", () => {
    for (const [caseId, sourceId, ...answers] of questionLabels) {
      assert.equal(answers.length, 3, `${caseId}/${sourceId}`);
      for (const answer of answers) assert.ok([T, F, "indeterminate"].includes(answer), `${caseId}/${sourceId}: ${answer}`);
    }
  });

  it("keeps the supplement in new source families, on the development split", () => {
    const corpusFamilies = new Set(inputs.map((c) => c.sourceFamily));
    for (const c of supplementInputs) {
      assert.equal(c.split, "development", c.id);
      assert.equal(corpusFamilies.has(c.sourceFamily), false, `${c.id} shares the family ${c.sourceFamily}`);
    }
  });
});

describe("judge band labels: agreement with field-level gold", () => {
  it("per-document labels aggregate to the CSV verdict of the existing labels", () => {
    let checked = 0;
    for (const c of development) {
      if (!ownerGold.has(c.id) || c.id in engineLevelAbstention) continue;
      const enumValues = c.contract.requirements.csv.schema.enum;
      assert.equal(aggregate(labelsOf(c.id), enumValues), ownerGold.get(c.id).csv, c.id);
      checked += 1;
    }
    assert.ok(checked >= 10, `checked ${checked} cases`);
  });

  it("per-document labels aggregate to the CSV gold of the supplement", () => {
    let checked = 0;
    for (const c of supplementInputs) {
      if (c.id in engineLevelAbstention) continue;
      assert.equal(aggregate(labelsOf(c.id), ["supported", "refuted", "disputed"]), supplementGold.get(c.id).csv, c.id);
      checked += 1;
    }
    assert.ok(checked >= 10, `checked ${checked} cases`);
  });

  it("records why an engine-level abstention is not checked", () => {
    for (const [caseId, reason] of Object.entries(engineLevelAbstention)) {
      assert.ok(caseById.has(caseId), caseId);
      assert.equal(typeof reason, "string");
      const csv = ownerGold.has(caseId) ? ownerGold.get(caseId).csv : supplementGold.get(caseId)?.csv;
      assert.equal(csv, null, `${caseId}: the field gold is an abstention`);
    }
  });

  it("the values that would be accepted are exactly the version and license gold", () => {
    for (const c of development) {
      if (c.id in engineLevelAbstention) continue;
      const gold = ownerGold.get(c.id) ?? supplementGold.get(c.id);
      for (const fieldId of ["version", "license"]) {
        assert.deepEqual(acceptedValues(c.id, fieldId), expectedAccepted(gold[fieldId]), `${c.id}/${fieldId}`);
      }
    }
  });
});

describe("judge band labels: candidate proposals", () => {
  it("every proposal quotes its source, has a unique id, and carries gold", () => {
    const ids = candidateProposals.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, "proposal ids are unique");
    for (const p of candidateProposals) {
      const content = contentOf(p.caseId, p.sourceId);
      assert.ok(content !== undefined, `${p.id}: source exists`);
      assert.ok(content.includes(p.quote), `${p.id}: quote is in the source`);
      const gold = candidateGold[p.id];
      assert.ok(gold, `${p.id}: has gold`);
      const [support, conflict, kind] = gold;
      assert.ok([T, F].includes(support), `${p.id}: support`);
      assert.ok([T, F, "indeterminate"].includes(conflict), `${p.id}: conflict`);
      assert.equal(kind, support === T ? "positive" : "hard-negative", `${p.id}: kind follows support`);
    }
    // And no gold without a proposal.
    assert.equal(Object.keys(candidateGold).length, candidateProposals.length);
  });
});

describe("judge band labels: labels follow from the text", () => {
  // Agreement with field-level gold is necessary, not sufficient: in a case with
  // two supporting documents, a wrong label on one of them still aggregates to the
  // right verdict. So each label must also follow from the document text by the rule
  // below, or be an acknowledged exception with a rationale.
  const exceptions = new Set(["ember-note", "maple-enterprise", "willow-de", "willow-es", "willow-fr", "willow-ja"]);
  const irrelevant = new Set([
    "birch-junk",
    "dune-other",
    "larch-stuffed",
    "maple-template",
    "maple-older",
    "larch-lookalike",
    "willow-older",
    "larch-lookalike-again",
    "willow-junk",
  ]);

  it("every label follows from the document text, or is an acknowledged exception", () => {
    let byRule = 0;
    for (const [caseId, sourceId, ...labels] of questionLabels) {
      const text = contentOf(caseId, sourceId);
      if (exceptions.has(sourceId)) {
        assert.equal(typeof rationale[sourceId], "string", `${sourceId}: the exception carries a rationale`);
        continue;
      }
      if (irrelevant.has(sourceId)) assert.equal(typeof rationale[sourceId], "string", `${sourceId}: why it is off scope`);
      const expected = irrelevant.has(sourceId)
        ? [F, F, F]
        : [T, /supports CSV export/.test(text) ? T : F, /does not support CSV export/.test(text) ? T : F];
      assert.deepEqual(labels, expected, `${caseId}/${sourceId}`);
      byRule += 1;
    }
    assert.ok(byRule > 40, `${byRule} labels follow from the rule`);
  });
});

describe("judge band labels: status and separation", () => {
  it("says plainly that the labels are an unreviewed draft", () => {
    assert.equal(labelStatus, "draft-unreviewed");
  });

  it("the collector that talks to a judge never imports the labels", () => {
    const source = readFileSync(new URL("./judge-band-collect.mjs", import.meta.url), "utf8");
    const imports = source.split("\n").filter((line) => /^\s*import\b/.test(line) || /\bimport\s*\(/.test(line));
    assert.ok(imports.length >= 2, "the collector imports something");
    for (const line of imports) assert.doesNotMatch(line, /judge-band-labels/, line.trim());
    assert.match(source, /labelBlind: true/, "and it records that it was blind");
  });
});
