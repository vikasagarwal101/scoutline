// Offline fixture protocol only. It imports NO labels and makes NO network calls.
import { createHash } from "node:crypto";
const hash = (x) => createHash("sha256").update(x).digest("hex");
export function offlineDeps(c) {
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
      calls.extract.push(structuredClone(input));
      const text = input.sourceText.replace(/<script>[\s\S]*?<\/script>/g, "");
      const output = {};
      for (const f of input.fields) {
        const scopeVersion = c.contract.scope.release;
        let value = null;
        if (f.id === "version") {
          const match = text.match(
            new RegExp(`${c.contract.scope.entity} release ([^\\s.;]+(?:\\.[^\\s.;]+)*)[.;\\s]`),
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
            text.includes(c.contract.scope.entity) &&
            (text.includes(`release ${c.contract.scope.release}`) ||
              c.contract.scope.release === "current");
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
  return { deps, calls };
}
