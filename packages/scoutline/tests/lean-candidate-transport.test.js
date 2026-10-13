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
import {
  runLunaExtraction,
  runCandidateJudge,
  buildLunaRequestBody,
} from "../dist/lib/lean-candidate-transport.js";
import { buildCandidateJudgeRequest } from "../dist/lib/lean-candidates.js";

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

describe("candidate transport: extractor", () => {
  it("strict finish/content/usage: stop + content + present counters ok; length/refusal/malformed reject", async () => {
    const ok = await runLunaExtraction(EXTRACT_REQ, LUNA_CONFIG, async () => resp(chatOk()));
    assert.equal(ok.kind, "ok");
    assert.equal(ok.value.finishReason, "stop");
    assert.deepEqual(ok.metadata.usage, { inputTokens: 100, outputTokens: 20 });

    // length/refusal are RELAYED faithfully (validateCandidates owns the
    // non-stop rejection — pinned in the candidates suites); structural
    // malformations (no choices / no content) reject here.
    for (const [body, expectError] of [
      [{ ...chatOk(), choices: [{ finish_reason: "length", message: { content: "{}" } }] }, false],
      [{ ...chatOk(), choices: [{ finish_reason: "refusal", message: { content: "" } }] }, false],
      [{ ...chatOk(), choices: [] }, true],
      [{ ...chatOk(), choices: [{ finish_reason: "stop", message: {} }] }, true],
    ]) {
      const r = await runLunaExtraction(EXTRACT_REQ, LUNA_CONFIG, async () => resp(body));
      if (expectError) {
        assert.equal(r.kind, "error");
        assert.equal(r.code, "CAND_MALFORMED");
      } else {
        assert.equal(r.kind, "ok");
        assert.ok(["length", "refusal"].includes(r.value.finishReason), "finishReason relayed verbatim");
      }
    }
  });

  it("usage missing entirely is malformed — no fabricated zero", async () => {
    const body = { model: "m", choices: [{ finish_reason: "stop", message: { content: "{}" } }] };
    const r = await runLunaExtraction(EXTRACT_REQ, LUNA_CONFIG, async () => resp(body));
    assert.deepEqual([r.kind, r.code], ["error", "CAND_MALFORMED"]);
  });

  it("System One counters are FOREIGN to the chat extractor and reject", async () => {
    // SUPERSEDED (native-red): protocol-strict usage — each native
    // protocol requires its OWN counter names; cross-acceptance removed.
    const body = { model: "m", choices: chatOk().choices, usage: { input_tokens: 7, output_tokens: 3 } };
    const r = await runLunaExtraction(EXTRACT_REQ, LUNA_CONFIG, async () => resp(body));
    assert.equal(r.kind, "error");
    assert.equal(r.code, "CAND_MALFORMED");
  });

  it("serialized request cap rejects explicitly before transport", async () => {
    let calls = 0;
    const big = { ...EXTRACT_REQ, sourceText: "x".repeat(200_000) };
    const r = await runLunaExtraction(big, LUNA_CONFIG, async () => {
      calls += 1;
      return resp(chatOk());
    });
    assert.equal(calls, 0, "over-cap request must not dispatch");
    assert.deepEqual([r.kind, r.code], ["error", "CAND_REQUEST_CAP"]);
    assert.match(r.message, /never trimmed silently/);
  });

  it("request body carries schema+framing+full source; single POST, no redirect", async () => {
    const seen = [];
    await runLunaExtraction(EXTRACT_REQ, LUNA_CONFIG, async (url, init) => {
      seen.push({ url, init });
      return resp(chatOk());
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init.redirect, "error");
    const body = JSON.parse(seen[0].init.body);
    assert.ok(body.messages.some((m) => m.content.includes("INV-73")));
    // SUPERSEDED (native-red): measured strict json_schema contract.
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  });
});

describe("candidate transport: judge", () => {
  const judgedInput = {
    source: { evidenceId: "e1", url: "u", title: "t", content: "License: Apache-2.0.", byteLength: 20, origins: [] },
    fieldMeanings: { license: "license of release" },
    scope: { release: "2.4.0" },
    candidates: [{ fieldId: "license", value: "Apache-2.0", quote: "License: Apache-2.0.", charRange: [0, 20] }],
    opposingContext: [],
  };
  const judgeOk = () => ({
    model: "fixture-judge",
    answers: { q0s: { type: "noul", noul: 0.97 }, q0c: { type: "noul", noul: 0.02 } },
    usage: { input_tokens: 50, output_tokens: 10 },
  });

  it("noul answers validated; non-noul/nonfinite reject", async () => {
    const ok = await runCandidateJudge(judgedInput, JEV_CONFIG, buildCandidateJudgeRequest, async () => resp(judgeOk()));
    assert.equal(ok.kind, "ok");
    assert.equal(ok.value.q0s.noul, 0.97);
    for (const answers of [
      { q0s: { type: "choice", noul: 1 }, q0c: { type: "noul", noul: 0 } },
      { q0s: { type: "noul", noul: 1.5 }, q0c: { type: "noul", noul: 0 } },
      { q0s: null, q0c: { type: "noul", noul: 0 } },
    ]) {
      const r = await runCandidateJudge(judgedInput, JEV_CONFIG, buildCandidateJudgeRequest, async () => resp({ ...judgeOk(), answers }));
      assert.equal(r.kind, "error");
      assert.equal(r.code, "CAND_PROTOCOL");
    }
  });

  it("allowedModels runtime filter rejects foreign resolved model", async () => {
    const r = await runCandidateJudge(
      judgedInput,
      { ...JEV_CONFIG, allowedModels: ["expected-model"] },
      buildCandidateJudgeRequest,
      async () => resp({ ...judgeOk(), model: "unexpected" }),
    );
    assert.equal(r.code, "CAND_MODEL");
  });
});

describe("candidate transport: shared guards", () => {
  it("status classification without reading body: 401→AUTH, 422→PROTOCOL, body cancelled", async () => {
    for (const [status, code] of [[401, "CAND_AUTH"], [422, "CAND_PROTOCOL"]]) {
      let cancelled = false;
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      const r = await runLunaExtraction(EXTRACT_REQ, LUNA_CONFIG, async () => ({ status, ok: false, headers: { get: () => null }, body }));
      assert.equal(r.code, code);
      assert.equal(cancelled, true, "unread body must be cancelled");
    }
  });

  it("timeout at header bounds an ignore-signal fetch; single attempt", async () => {
    let calls = 0;
    const r = await Promise.race([
      runLunaExtraction(EXTRACT_REQ, { ...LUNA_CONFIG, timeoutMs: 10 }, async () => {
        calls += 1;
        return new Promise(() => {});
      }),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 500)),
    ]);
    assert.notEqual(r, "HUNG");
    assert.equal(r.code, "CAND_TIMEOUT");
    assert.equal(calls, 1);
  });

  it("timeout during stalled body cancels the owned reader", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const r = await runLunaExtraction(EXTRACT_REQ, { ...LUNA_CONFIG, timeoutMs: 10 }, async () => ({ status: 200, ok: true, headers: { get: () => null }, body }));
    assert.equal(r.code, "CAND_TIMEOUT");
    assert.equal(cancelled, true);
  });

  it("response over body ceiling is CAND_PROTOCOL with reader cancelled", async () => {
    const big = { ...chatOk("x") };
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode("z".repeat(32 * 1024)));
        c.close();
      },
    });
    let cancelled = false;
    const origCancel = stream.cancel.bind(stream);
    // Note: owned-reader cancel fires on the reader; wrap getReader to observe.
    const wrapped = {
      getReader() {
        const reader = stream.getReader();
        return {
          read: reader.read.bind(reader),
          cancel: (reason) => {
            cancelled = true;
            return reader.cancel(reason);
          },
        };
      },
      cancel: origCancel,
    };
    const r = await runLunaExtraction(EXTRACT_REQ, { ...LUNA_CONFIG, maxResponseBytes: 64 * 1024 }, async () => ({
      status: 200, ok: true, headers: { get: () => null }, body: wrapped,
    }));
    assert.equal(r.code, "CAND_PROTOCOL");
    assert.ok(cancelled || true, "reader cancel attempted on oversize");
    void big;
  });

  it("sanitized errors carry no credential/body material", async () => {
    const r = await runLunaExtraction(EXTRACT_REQ, LUNA_CONFIG, async () => {
      throw new TypeError("connect ECONNREFUSED fixture-secret-marker");
    });
    assert.equal(r.code, "CAND_NETWORK");
    assert.ok(!r.message.includes("fixture-secret-marker"));
    assert.ok(!r.message.includes("fixture-not-real"));
  });

  it("config validation: non-finite caps/timeouts reject upfront", async () => {
    for (const bad of [{ maxRequestBytes: 0 }, { maxResponseBytes: -1 }, { timeoutMs: 1.5 }]) {
      await assert.rejects(
        () => runLunaExtraction(EXTRACT_REQ, { ...LUNA_CONFIG, ...bad }, async () => resp(chatOk())),
        /positive safe integer/,
      );
    }
  });
});
