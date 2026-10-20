
import { createTavilyDescriptor } from "../../dist/providers/tavily/adapter.js";
import { createTypesafeJudge } from "../../dist/lib/lean-typesafe-judge.js";
import assert from "node:assert/strict";

export function nativeRuntime({
  noJudge = false,
  producer = false,
  failJudge = false,
  retryJudge = false,
  failReader = false,
  sourceContent,
  sourceTitle = "ExampleApp release",
} = {}) {
  const calls = [],
    events = [],
    reservations = [];
  const content =
    sourceContent ?? "ExampleApp release 2.4.0 supports CSV export. Its exact release is 2.4.0.";
  const transportEnv = { TAVILY_API_KEY: "synthetic-acquisition-secret" };
  const acquisitionFetch = async (url, init) => {
    calls.push({ kind: "acquisition", url: String(url), body: JSON.parse(init.body) });
    if (String(url).endsWith("/search"))
      return Response.json({
        results: [{ title: sourceTitle, url: "https://example.test/release", content }],
      });
    if (String(url).endsWith("/extract"))
      return failReader
        ? Response.json({ error: "refused synthetic-acquisition-secret" }, { status: 401 })
        : Response.json({
            results: [{ url: "https://example.test/release", raw_content: content }],
            failed_results: [],
          });
    throw new Error(`unapproved fixture route ${url}`);
  };
  const transport = { fetch: acquisitionFetch, env: transportEnv };
  const descriptor = createTavilyDescriptor({ transport });
  let judgeAttempts = 0;
  const profile = noJudge
    ? null
    : createTypesafeJudge({
        apiKey: "synthetic-judge-secret",
        reserveAttempt: (c) => reservations.push(c),
        onAttempt: (e) => events.push(e),
        maxAttempts: retryJudge ? 2 : 1,
        retrySettings: retryJudge
          ? { maxTransientRetries: 1, baseDelayMs: 1, maxDelayMs: 1 }
          : undefined,
        fetchLike: async (url, init) => {
          judgeAttempts++;
          const body = JSON.parse(init.body);
          calls.push({ kind: "judge", url: String(url), body });
          assert.equal(url, "https://api.typesafe.ai/v1/systemone");
          assert.equal(body.model, "jev-1.13.0");
          assert.equal(init.redirect, "error");
          if (failJudge)
            return Response.json({ secret: "synthetic-judge-secret" }, { status: 401 });
          if (retryJudge && judgeAttempts === 1)
            return Response.json({}, { status: 429, headers: { "retry-after": "0" } });
          const answers = Object.fromEntries(
            Object.keys(body.questions).map((key) => [
              key,
              { type: "noul", noul: /[fc]$/.test(key) ? 0.05 : 0.95 },
            ]),
          );
          return Response.json({
            model: "jev-1.13.0",
            answers,
            usage: { input_tokens: 13, output_tokens: 2 },
          });
        },
      });
  // Extractor boundary over the same fake-HTTP contract the removed
  // development transport carried: the production ExtractorDeps seam
  // consumes the choices/message/usage envelope directly.
  const extract = !producer
    ? null
    : async (req) => {
        const state = { source: req.sourceText, fields: req.fields };
        calls.push({ kind: "parser", url: "https://parser.example.test/chat/completions", body: state });
        assert.equal(state.source, req.sourceText);
        const rawOutput = Object.fromEntries(
          req.fields.map((f) => [
            f.id,
            f.id === "license"
              ? { value: "MIT", quote: "License: MIT." }
              : { value: "2.4.0", quote: "Its exact release is 2.4.0." },
          ]),
        );
        return {
          finishReason: "stop",
          rawOutput: JSON.stringify(rawOutput),
          usage: { inputTokens: 11, outputTokens: 3 },
          observedCost: null,
        };
      };
  return {
    calls,
    events,
    reservations,
    descriptor,
    factory: ({ noCache }) => ({
      acquisitionOptions: {
        searchDescriptor: descriptor,
        readerDescriptor: descriptor,
        env: transportEnv,
        transports: { tavily: transport },
        descriptorFactory: (_id, t) => createTavilyDescriptor({ transport: t }),
        cache: noCache
          ? { get: async () => null, set: async () => {} }
          : { get: async () => null, set: async () => {} },
        sleep: async () => {},
        random: () => 0.5,
        maxPhysicalAttempts: 12,
      },
      engineDeps: {
        judge: profile?.judge ?? null,
        candidateJudge: profile?.candidateJudge ?? null,
        extract,
        extractorRevision: producer ? "explicit-fixture-parser" : undefined,
        now: () => Date.now(),
      },
      secrets: [
        "synthetic-acquisition-secret",
        "synthetic-judge-secret",
        "synthetic-parser-secret",
      ],
    }),
  };
}
