/**
 * Engine closed-evidence-set capability (v3 public integration).
 *
 * Direct engine tests: a deps-declared closed source set (private
 * runtime/adapter capability, never a contract key) lets a value field
 * finalize when every source its obligation names is retained with the
 * declared digest — without faking a successful counterevidence search.
 * A declared-but-absent source blocks only the fields that name it;
 * malformed declarations reject before any dispatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { runLeanInvestigation } from "../dist/lib/lean-investigation.js";

const DOC_A =
  "ExampleApp release 2.4.0. License MIT applies to release 2.4.0.";
const URL_A = "urn:x-scoutline:manifest:sha256-" + createHash("sha256").update(DOC_A, "utf8").digest("hex");
const SHA_A = createHash("sha256").update(DOC_A, "utf8").digest("hex");

const CONTRACT = {
  schemaVersion: 1,
  question: "Read the version and license from the retained documents.",
  scope: { entity: "ExampleApp" },
  requirements: {
    version: { question: "Which release version is stated?", schema: { type: "string" }, required: true },
    license: { question: "Which license identifier is stated?", schema: { type: "string" }, required: true },
  },
};

const record = (url, content) => ({
  evidenceId: "seed-" + url.slice(-8),
  url,
  title: "declared document",
  content,
  byteLength: Buffer.byteLength(content, "utf8"),
  origins: [],
});

const extract = async (request) => {
  const text = request.sourceText ?? "";
  const pick = (needle) => {
    const i = text.indexOf(needle);
    return i >= 0 ? { value: needle, quote: needle, charRange: [i, i + needle.length] } : null;
  };
  const payload = {};
  for (const field of request.fields) {
    const hit = field.id === "version" ? pick("2.4.0") : field.id === "license" ? pick("MIT") : null;
    if (hit) payload[field.id] = hit;
  }
  return { finishReason: "stop", rawOutput: JSON.stringify(payload), usage: { inputTokens: 10, outputTokens: 10 }, observedCost: null, elapsedMs: 1, requestSha256: "closed-evidence-extract", attempts: 1 };
};

const candidateJudge = async (input) => {
  const answers = {};
  input.candidates.forEach((c, i) => {
    const supported = input.source.content.includes(c.quote);
    answers[`q${i}s`] = { type: "noul", noul: supported ? 0.97 : 0.05 };
    answers[`q${i}c`] = { type: "noul", noul: 0.03 };
  });
  return { model: "closed-evidence-judge", answers, usage: { inputTokens: 20, outputTokens: 5 }, requestSha256: "closed-evidence-judge", elapsedMs: 1, attempts: 1 };
};

function closedDeps({ extraEvidence = [], closed = true } = {}) {
  return {
    search: async () => {
      throw Object.assign(new Error("closed-document-set: no acquisition configured."), { code: "MANIFEST_NO_ACQUISITION" });
    },
    read: async (url) => {
      if (url === URL_A) return DOC_A;
      throw new Error("closed-document-set: unknown source " + url);
    },
    judge: async () => {
      throw new Error("enum judge must never dispatch in a value-mode closed run");
    },
    extract,
    extractorRevision: "closed-evidence-test-1",
    candidateJudge,
    now: () => 0,
    seed: { evidence: [record(URL_A, DOC_A), ...extraEvidence] },
    ...(closed
      ? {
          closedEvidence: {
            sources: [{ url: URL_A, sha256: SHA_A }],
            fieldSources: { version: [URL_A], license: [URL_A] },
          },
        }
      : {}),
  };
}

test("closed evidence set: judged candidates finalize without a counterevidence search", async () => {
  const result = await runLeanInvestigation(CONTRACT, closedDeps());
  assert.equal(result.requirements.version.status, "satisfied");
  assert.equal(result.requirements.version.value, "2.4.0");
  assert.equal(result.requirements.license.status, "satisfied");
  assert.equal(result.requirements.license.value, "MIT");
  assert.equal(result.status, "complete");
  // No fake search coverage: every planned search failed honestly.
  assert.ok(result.acquisitionLog.every((e) => e.kind !== "search"));
  assert.ok(result.acquisitionLog.some((e) => e.kind === "search-failed"));
  assert.ok(result.coverageNotes.some((n) => n.includes("closed-evidence-set")));
});

test("control: without the capability the same run stays honestly unresolved", async () => {
  const result = await runLeanInvestigation(CONTRACT, closedDeps({ closed: false }));
  assert.equal(result.requirements.version.status, "unresolved");
  assert.equal(result.requirements.version.reason, "counterevidence_not_acquired");
  assert.equal(result.requirements.license.status, "unresolved");
});

test("a declared-but-absent source blocks only the fields that name it", async () => {
  const DOC_B = "ExampleApp supplementary notice.";
  const URL_B = "urn:x-scoutline:manifest:sha256-b";
  const result = await runLeanInvestigation(CONTRACT, {
    ...closedDeps(),
    closedEvidence: {
      sources: [
        { url: URL_A, sha256: SHA_A },
        { url: URL_B, sha256: createHash("sha256").update(DOC_B, "utf8").digest("hex") },
      ],
      fieldSources: { version: [URL_A, URL_B], license: [URL_A] },
    },
  });
  assert.equal(result.requirements.version.status, "unresolved");
  assert.equal(result.requirements.license.status, "satisfied");
  assert.equal(result.requirements.license.value, "MIT");
  assert.equal(result.status, "partial");
});

test("malformed declarations reject before any dispatch", async () => {
  let dispatched = false;
  const base = {
    ...closedDeps(),
    search: async () => {
      dispatched = true;
      return [];
    },
  };
  for (const closedEvidence of [
    { sources: [], fieldSources: { version: [URL_A] } },
    { sources: [{ url: URL_A, sha256: "not-hex" }], fieldSources: {} },
    { sources: [{ url: URL_A, sha256: SHA_A }, { url: URL_A, sha256: SHA_A }], fieldSources: {} },
    { sources: [{ url: URL_A, sha256: SHA_A }], fieldSources: { version: ["urn:not-declared"] } },
    { sources: [{ url: URL_A, sha256: SHA_A }], fieldSources: { version: "not-an-array" } },
  ]) {
    await assert.rejects(
      runLeanInvestigation(CONTRACT, { ...base, closedEvidence }),
      (error) => error.code === "VALIDATION_ERROR",
    );
  }
  assert.equal(dispatched, false);
});

test("an empty open search does not close an incomplete declared source set", async () => {
  const url = "urn:missing:notice";
  const result = await runLeanInvestigation(CONTRACT, {
    ...closedDeps(),
    search: async () => [],
    closedEvidence: {
      sources: [{ url: URL_A, sha256: SHA_A }, { url, sha256: SHA_A }],
      fieldSources: { version: [URL_A, url], license: [URL_A] },
    },
  });
  assert.equal(result.requirements.version.status, "unresolved");
  assert.equal(result.requirements.license.status, "satisfied");
});

test("closed seeds and acquired records share the source ceiling without charging seed dispatches", async () => {
  const docs = Array.from({ length: 6 }, (_, i) => ({ url: `https://offline.test/notice-${i}` }));
  const dispatched = [];
  const result = await runLeanInvestigation(CONTRACT, {
    ...closedDeps(),
    search: async () => docs,
    read: async (url) => {
      dispatched.push(url);
      return "Supplementary notice, no release claim.";
    },
  });
  assert.equal(result.evidence.length, 6);
  assert.equal(dispatched.length, 5);
  assert.equal(result.usage.readAttempts, 5);
  assert.ok(result.evidence.some((row) => row.url === URL_A));
});
