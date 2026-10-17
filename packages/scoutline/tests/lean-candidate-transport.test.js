/**
 * Offline transport guards for the candidate path (arbitrary-candidates
 * ticket). 100% offline: fetch fixtures; no endpoint/model/credential
 * values (obviously-fake config markers only).
 *
 * Pins: strict finish/content shape, strict usage (no fabricated zero,
 * chat + one-api both accepted), serialized request cap (explicit, never
 * trim), status classification without body reads, deadline at header and
 * body with owned-reader cancel, single attempt, no redirect, sanitized
 * errors.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as tsj from "../dist/lib/lean-typesafe-judge.js";
import {
  buildCandidateJudgeRequest,
  validateCandidates,
} from "../dist/lib/lean-candidates.js";

const LUNA_CONFIG = {
  endpoint: "https://cand-dev.invalid/v1/chat/completions",
  model: "fixture-extractor",
  apiKey: "fixture-not-real",
  maxRequestBytes: 96 * 1024,
  maxResponseBytes: 64 * 1024,
  timeoutMs: 50,
};
const JEV_CONFIG = {
  ...LUNA_CONFIG,
  endpoint: "https://cand-dev.invalid/v1/systemone",
  model: "fixture-judge",
};

const EXTRACT_REQ = {
  sourceId: "s1",
  sourceText: "Invoice identifier: INV-73. License: Apache-2.0.",
  fields: [
    { id: "invoiceId", description: "invoice" },
    { id: "license", description: "license" },
  ],
};

const chatOk = (content = '{"invoiceId":{"value":"INV-73","quote":"Invoice identifier: INV-73"}}') => ({
  model: "fixture-extractor",
  choices: [{ finish_reason: "stop", message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

function resp(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => "application/json" },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)));
        c.close();
      },
    }),
  };
}

/** Official candidate judge over a fixture fetch. */
async function judgeOnce(input, fetchLike, deps = {}) {
  const profile = tsj.createTypesafeJudge({
    apiKey: "fixture-not-real",
    reserveAttempt: () => {},
    fetchLike,
    ...deps,
  });
  return profile.candidateJudge(input);
}

// Dev-only, removed per independent audit: the extractor describe block
// re-implemented the deleted transport's chat-envelope parser inside the
// test (extractOnce) and asserted that local parser. The shipped
// extraction seam is ExtractorDeps + validateCandidates: finish-reason
// and refusal rejection are pinned by lean-candidate-native-independent
// and lean-candidates.* suites; judgment wire/protocol shape is pinned
// by the official-judge suites below.

describe("candidate transport: judge", () => {
  const judgedInput = {
    source: { evidenceId: "e1", url: "u", title: "t", content: "License: Apache-2.0.", byteLength: 20, origins: [] },
    fieldMeanings: { license: "license of release" },
    scope: { release: "2.4.0" },
    candidates: [{ fieldId: "license", value: "Apache-2.0", quote: "License: Apache-2.0.", charRange: [0, 20] }],
    opposingContext: [],
  };
  const judgeOk = () => ({
    model: "jev-1.13.0",
    answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.02 } },
    usage: { input_tokens: 50, output_tokens: 10 },
  });

  it("noul answers validated; non-noul/nonfinite reject", async () => {
    const ok = await judgeOnce(judgedInput, async () => resp(judgeOk()));
    assert.equal(ok.answers.q0s.noul, 0.97);
    for (const answers of [
      { q0s: { type: "choice", noul: 1 }, q0c: { type: "noul", noul: 0 } },
      { q0s: { type: "noul", noul: 1.5 }, q0c: { type: "noul", noul: 0 } },
      { q0s: null, q0c: { type: "noul", noul: 0 } },
    ]) {
      let error;
      try {
        await judgeOnce(judgedInput, async () => resp({ ...judgeOk(), answers }));
      } catch (caught) {
        error = caught;
      }
      assert(error, "protocol-invalid answers must reject");
      assert.match(error.code, /^TYPESAFE_(PROTOCOL|MALFORMED)$/);
    }
  });

  it("a resolved model outside the pinned set is rejected", async () => {
    let error;
    try {
      await judgeOnce(judgedInput, async () => resp({ ...judgeOk(), model: "unexpected" }));
    } catch (caught) {
      error = caught;
    }
    assert.equal(error.code, "TYPESAFE_MODEL");
  });
});

describe("candidate transport: shared guards", () => {
  it("status classification without reading body: 401/422 reject typed, body cancelled", async () => {
    for (const status of [401, 422]) {
      let cancelled = false;
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      let error;
      try {
        await judgeOnce(
          judgedInputGuard(),
          async () => ({ status, ok: false, headers: { get: () => null }, body }),
        );
      } catch (caught) {
        error = caught;
      }
      assert(error);
      assert.equal(cancelled, true, "unread body must be cancelled");
    }
  });

  it("timeout at header bounds an ignore-signal fetch; single attempt", async () => {
    let calls = 0;
    let error;
    try {
      await judgeOnce(judgedInputGuard(), async () => {
        calls += 1;
        return new Promise(() => {});
      }, { timeoutMs: 10 });
    } catch (caught) {
      error = caught;
    }
    assert(error, "a fetch that never settles must still be bounded");
    assert.equal(error.code, "TYPESAFE_TIMEOUT");
    assert.equal(calls, 1);
  });

  // Deterministic timer-ordering regression (Sol P2): an injected clock
  // advanced to 1ms-before-deadline during fetch setup makes the HEADER
  // timer (1ms) fire strictly before the whole-attempt timer. When the
  // header deadline wins, the owned controller must abort and the typed
  // result must be TYPESAFE_TIMEOUT (dispatched work, remote uncertainty
  // preserved) — never a bare AbortError reclassified as
  // TYPESAFE_REMOTE_UNCERTAIN with the local signal left un-aborted.
  it("header-deadline race settles timeout: owned abort + TYPESAFE_TIMEOUT, single dispatch", async () => {
    let clock = 0, calls = 0, ownedSignal;
    let error;
    try {
      await judgeOnce(judgedInputGuard(), async (_url, options) => {
        calls += 1;
        ownedSignal = options.signal;
        clock = 29; // header timer now ~1ms while the attempt timer has ~30ms
        return new Promise(() => {}); // never settles: only the deadline can bound it
      }, { timeoutMs: 30, now: () => clock });
    } catch (caught) {
      error = caught;
    }
    assert(error, "bounded by the deadline");
    assert.equal(calls, 1, "single physical dispatch");
    assert.equal(error.code, "TYPESAFE_TIMEOUT", `typed deadline, got ${error.code}`);
    assert.equal(error.remoteWorkUncertain, true, "dispatched work stays remote-uncertain");
    // After the deadline has passed, the owned local signal must be aborted.
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(ownedSignal.aborted, true, "owned controller aborted once the header deadline wins");
  });

  it("timeout during stalled body cancels the owned reader", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    let error;
    try {
      await judgeOnce(
        judgedInputGuard(),
        async () => ({ status: 200, ok: true, headers: { get: () => "application/json" }, body }),
        { timeoutMs: 10 },
      );
    } catch (caught) {
      error = caught;
    }
    assert.equal(error.code, "TYPESAFE_TIMEOUT");
    assert.equal(cancelled, true);
  });

  it("otherwise-valid protocol JSON over the body ceiling rejects at the cap and cancels the reader", async () => {
    // The stimulus is VALID protocol shape (correct model/usage/answers)
    // padded past the ceiling, so the ONLY legitimate rejection cause is
    // the byte cap — not malformed JSON. The reader must be cancelled at
    // the cap, never drained to completion. Raising the allowance makes
    // this GREEN only by actually parsing, so a disabled cap REDs.
    const valid = {
      model: "jev-1.13.0",
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: { q0s: { type: "noul", noul: 0.9 }, q0c: { type: "noul", noul: 0.1 } },
    };
    const pad = '"pad": "' + "x".repeat(160 * 1024) + '"';
    const bodyText =
      "{" +
      Object.entries(valid)
        .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
        .join(",") +
      "," +
      pad +
      "}";
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      start(c) {
        const bytes = new TextEncoder().encode(bodyText);
        const middle = Math.floor(bytes.length / 2);
        c.enqueue(bytes.slice(0, middle));
        c.enqueue(bytes.slice(middle));
        c.close();
      },
    });
    const wrapped = {
      getReader() {
        const reader = stream.getReader();
        return {
          read: (...a) => {
            reads += 1;
            return reader.read(...a);
          },
          cancel: (reason) => {
            cancelled = true;
            return reader.cancel(reason);
          },
        };
      },
      cancel: stream.cancel.bind(stream),
    };
    let error;
    try {
      await judgeOnce(
        judgedInputGuard(),
        async () => ({ status: 200, ok: true, headers: { get: () => "application/json" }, body: wrapped }),
        { maxResponseBytes: 64 * 1024 },
      );
    } catch (caught) {
      error = caught;
    }
    assert(error, "over-ceiling response must reject");
    assert.equal(
      error.code,
      "TYPESAFE_PROTOCOL",
      `expected the bounded-body-ceiling rejection, got ${error.code}`,
    );
    assert.match(error.message, /bounded body ceiling/);
    assert(cancelled, "the reader must be cancelled at the ceiling, not drained");
  });

  it("sanitized errors carry no credential/body material", async () => {
    let error;
    try {
      await judgeOnce(judgedInputGuard(), async () => {
        throw new TypeError("connect ECONNREFUSED fixture-secret-marker");
      });
    } catch (caught) {
      error = caught;
    }
    assert.equal(error.code, "TYPESAFE_REMOTE_UNCERTAIN");
    assert.ok(!error.message.includes("fixture-secret-marker"));
    assert.ok(!error.message.includes("fixture-not-real"));
  });

  it("config validation: non-finite caps/timeouts reject upfront", async () => {
    for (const [bad, field] of [
      [{ maxRequestBytes: 0 }, "maxRequestBytes"],
      [{ maxResponseBytes: -1 }, "maxResponseBytes"],
      [{ timeoutMs: 0 }, "timeoutMs"],
    ]) {
      let error;
      let constructed = false;
      try {
        constructed = true;
        tsj.createTypesafeJudge({
          apiKey: "fixture-not-real",
          reserveAttempt: () => {},
          fetchLike: async () => resp({
            model: "jev-1.13.0",
            answers: { q0s: { type: "noul", noul: 0.9 }, q0c: { type: "noul", noul: 0.1 } },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          ...bad,
        });
      } catch (caught) {
        error = caught;
      }
      void constructed;
      assert(error, "invalid judge dependency bounds must reject");
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.match(error.message, new RegExp(`\\b${field}\\b`));
    }
  });
});

function judgedInputGuard() {
  return {
    source: { evidenceId: "e1", url: "u", title: "t", content: "License: Apache-2.0.", byteLength: 20, origins: [] },
    fieldMeanings: { license: "license of release" },
    scope: { release: "2.4.0" },
    candidates: [{ fieldId: "license", value: "Apache-2.0", quote: "License: Apache-2.0.", charRange: [0, 20] }],
    opposingContext: [],
  };
}
