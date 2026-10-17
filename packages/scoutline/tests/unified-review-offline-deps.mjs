// Offline fixture protocol only. It imports NO labels and makes NO network calls.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { candidateSourceDigest } from "../dist/lib/lean-candidates.js";
const hash = (x) => createHash("sha256").update(x).digest("hex");
export function offlineDeps(c, { captureLiveTargets = false, seed } = {}) {
  // Fault injection is opt-in and independent of the detached judge input.
  // These references come only from the engine's existing retention/extract seams.
  const live = captureLiveTargets ? {
    retained: new Map(),
    scope: null,
    reviseSource(record, mutate) {
      assert(record, "live retained revision target exists");
      assert.equal(this.retained.get(record.evidenceId), record, "revision targets the actual retained evidence ID");
      const content = record.content;
      const digest = candidateSourceDigest(record);
      mutate(record);
      const actual = this.retained.get(record.evidenceId);
      assert.notEqual(actual.content, content, "actual retained source content changed at the revision trigger");
      assert.notEqual(candidateSourceDigest(actual), digest, "actual retained source digest changed at the revision trigger");
    },
    reviseScope(mutate) {
      assert(this.scope, "live compiled scope revision target exists");
      const before = structuredClone(this.scope);
      mutate(this.scope);
      assert.notDeepEqual(this.scope, before, "actual compiled scope changed at the revision trigger");
    },
  } : null;
  const calls = { search: [], read: [], extract: [], candidateJudge: [], judge: [] };
  const byId = new Map(c.sources.map((s) => [s.id, s]));
  const byUrl = new Map(c.sources.map((s) => [s.url, s]));
  let laterIssued = false;
  const deps = {
    now: () => 0,
    extractorRevision: "independent-fixture-parser-v1",
    search: async (query) => {
      calls.search.push(query);
      let ids;
      if (/contrary evidence refuted/.test(query)) {
        ids = c.acquisition.later;
        laterIssued = true;
        if (c.acquisition.late && /license/i.test(query)) ids = c.acquisition.late;
      } else ids = laterIssued ? c.acquisition.later : c.acquisition.initial;
      return ids.map((id) => ({ url: byId.get(id).url, title: byId.get(id).title }));
    },
    read: async (url) => {
      calls.read.push(url);
      const s = byUrl.get(url);
      if (!s || s.readError) throw new Error(s?.readError ?? "unknown fixture URL");
      return s.content;
    },
    extract: async (input) => {
      if (live) live.scope = input.scope;
      calls.extract.push(structuredClone(input));
      const scope = input.scope === undefined ? c.contract.scope : input.scope;
      const text = input.sourceText.replace(/<script>[\s\S]*?<\/script>/g, "");
      const output = {};
      for (const f of input.fields) {
        const scopeVersion = scope.release;
        let value = null;
        if (f.id === "version") {
          const match = text.match(
            new RegExp(`${scope.entity} release ([^\\s.;]+(?:\\.[^\\s.;]+)*)[.;\\s]`),
          );
          if (match && match[1] === scopeVersion) value = match[1];
        } else if (f.id === "license") {
          const escaped = scopeVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const match = text.match(
            new RegExp(
              `License for release ${escaped}: ([\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*)|release ${escaped} verification: license ([\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)*)`,
              "iu",
            ),
          );
          if (match) value = match[1] ?? match[2];
        }
        // Use the full containing line, unmodified; the engine checks locators.
        const line =
          value === null
            ? null
            : input.sourceText
                .split("\n")
                .find((line) => line.includes(value) && !line.includes("<script>"));
        output[f.id] = line ? { value, quote: line } : { value: null, quote: null };
      }
      return {
        finishReason: "stop",
        rawOutput: JSON.stringify(output),
        usage: { inputTokens: 11, outputTokens: 7 },
        observedCost: null,
        elapsedMs: 1,
        requestSha256: hash(JSON.stringify(input)),
      };
    },
    judge: async (input) => {
      calls.judge.push(structuredClone(input));
      return {
        documents: input.documents.map((d) => {
          const text = d.content.replace(/<script>[\s\S]*?<\/script>/g, "");
          const relevant =
            text.includes(input.scope.entity) &&
            (text.includes(`release ${input.scope.release}`) ||
              input.scope.release === "current");
          const oldOnly = text.includes("These statements do not describe");
          return {
            evidenceId: d.evidenceId,
            relevant: relevant && !oldOnly,
            supportsClaim: text.includes("does not independently document CSV behavior")
              ? null
              : /supports CSV export/.test(text),
            refutesClaim: /does not support CSV export/.test(text),
          };
        }),
      };
    },
    candidateJudge: async (input) => {
      calls.candidateJudge.push(structuredClone(input));
      const all = [input.source, ...input.opposingContext].map((x) => x.content).join("\n");
      const answers = {};
      input.candidates.forEach((candidate, i) => {
        const conflictingLicense =
          candidate.fieldId === "license" &&
          /License for release 2\.0: GPL-3\.0/.test(all) &&
          /License for release 2\.0: MIT/.test(all);
        answers[`q${i}s`] = { type: "noul", noul: 0.97 };
        answers[`q${i}c`] = { type: "noul", noul: conflictingLicense ? 0.97 : 0.01 };
      });
      return {
        model: "independent-offline-protocol",
        answers,
        usage: { inputTokens: 13, outputTokens: 5 },
        elapsedMs: 1,
        requestSha256: hash(JSON.stringify(input)),
      };
    },
  };
  if (seed !== undefined) deps.seed = seed;
  if (live) {
    const priorSeed = deps.seed;
    deps.seed = {
      ...priorSeed,
      retainEvidence: async (record) => {
        await priorSeed?.retainEvidence?.(record);
        live.retained.set(record.evidenceId, record);
      },
    };
    return { deps, calls, live };
  }
  return { deps, calls };
}
