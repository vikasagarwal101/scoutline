/**
 * T7 — `--synthesize` escape hatch (investigate-pipeline lane;
 * docs/plans/investigate-pipeline TASKS T7, PRD AC-7, DESIGN D6;
 * ADR-0013 §2).
 *
 * The escape hatch is ADDITIVE-ONLY and STRUCTURAL: the pack is fully
 * assembled before the synthesis call is attempted, so a failed
 * synthesis can never lose, shrink, or reorder the pack — and a
 * successful one only ADDS a `brief` key.
 *
 * All rows run at the main() seam (the seam that owns both the raw
 * provider pin and the transport wiring) with hermeticMainDeps — every
 * run injects loadScoutlineConfig + fixture descriptors + a fixture
 * `synthesize` dep. `env: {}` is NOT isolation: the real
 * ~/.scoutline/config.json leaks fanout/routing, so the injected
 * loader is mandatory here exactly as in investigate-cli.test.js.
 *
 * Rows:
 *   - default        : no flag → the pack has NO `brief` key.
 *   - additive-only  : identical fixtures flagged/unflagged; strip
 *                      `brief`; JSON.stringify byte-compare equal.
 *   - Z.AI-only      : --provider minimax --synthesize notices on
 *                      stderr and still synthesizes (fixture dep).
 *   - failure        : a throwing dep is the invocation's terminal
 *                      error — exit 1, no pack on stdout.
 *   - call order     : the pack was assembled BEFORE the dep ran
 *                      (structural; side effects asserted at the
 *                      production sequence).
 *   - prompt shape   : the dep receives question + subQueries + capped
 *                      passage quotes (deterministic; no clocks).
 *   - valueless      : --synthesize foo / --synthesize=foo →
 *                      VALIDATION_ERROR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { main } from "../dist/index.js";
import { ApiError } from "../dist/lib/errors.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const QUESTION = "alpha | beta";

// ---------------------------------------------------------------------------
// Fixture adapters (mirror tests/investigate-cli.test.js — no network)
// ---------------------------------------------------------------------------

const URLS = { s1: "https://e/s1", s2: "https://e/s2", b2: "https://e/b2" };

/** One search arm serving a 2-sub-query grid. */
function makeSearchDescriptor(id, resultsByQuery) {
  const invokes = [];
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(request) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: "fp-" + id,
            request,
            legacyCandidates: [],
          };
        },
        async invoke(request) {
          invokes.push(request.query);
          return resultsByQuery[request.query] ?? [];
        },
      },
    }),
  };
  return { descriptor, invokes };
}

function makeReaderDescriptor(id, results) {
  const invokes = [];
  const descriptor = {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["reader"]),
    create: () => ({
      id,
      reader: {
        fetch: {
          kind: "reader-fetch",
          validate() {},
          cacheIdentity(request) {
            return {
              provider: id,
              capability: "reader",
              operation: "reader-fetch",
              credentialFingerprint: "fp-" + id,
              request,
              legacyCandidates: [],
            };
          },
          decodeCached(value) {
            if (value === null || typeof value !== "object") return null;
            return value;
          },
          async invoke(request) {
            invokes.push(request.url);
            const canned = results[request.url];
            if (canned === undefined) throw new Error("no canned result");
            return {
              schemaVersion: 1,
              url: request.url,
              finalUrl: request.url,
              title: "Page " + request.url,
              content: canned.content,
              contentFormat: "markdown",
            };
          },
        },
      },
    }),
  };
  return { descriptor, invokes };
}

const SEARCH_ROWS = {
  alpha: [
    { title: "first source page about alpha", url: URLS.s1, summary: "s1" },
    { title: "second source page about alpha", url: URLS.s2, summary: "s2" },
  ],
  beta: [{ title: "third source page about beta", url: URLS.b2, summary: "b2" }],
};

const READ_CONTENT =
  "The alpha protocol overview. This page documents alpha internals. Unrelated filler text. More beta notes follow.";

/** A fresh fixture set per run — identical inputs, distinct recorder arrays. */
function fixtures() {
  const arm = makeSearchDescriptor("tavily", SEARCH_ROWS);
  const reader = makeReaderDescriptor("zai", {
    [URLS.s1]: { content: READ_CONTENT },
    [URLS.s2]: { content: READ_CONTENT },
    [URLS.b2]: { content: READ_CONTENT },
  });
  return { arm, reader, descriptors: [arm.descriptor, reader.descriptor] };
}

function makeAdapter() {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
  };
  return { adapter, stdout, stderr };
}

/** Parse the single stderr error envelope, if any. */
function stderrEnvelope(stderr) {
  const line = stderr.find((l) => l.trim().startsWith("{"));
  return line === undefined ? undefined : JSON.parse(line);
}

/** Envelope error code — `error` is the message string in this shape. */
function envelopeCode(envelope) {
  return envelope?.error?.code ?? envelope?.code;
}

/**
 * Run one investigate invocation through main() with a fixture dep.
 *
 * The fixed clock is MANDATORY for the additive-only byte-compare: every
 * source carries a `fetchedAt` stamp (T5, D5), so two runs at different
 * wall-clock millis differ by exactly that field. Inject, never default
 * (the orchestrator fixture's rule) — the determinism being pinned here
 * is the PACK SHAPE, and a leaked clock would otherwise mask it.
 */
async function runInvestigate({ argv, synthesizeDep, descriptors }) {
  const { adapter, stdout, stderr } = makeAdapter();
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      providerDescriptors: descriptors,
      now: () => 1_700_000_000_000,
      ...(synthesizeDep !== undefined ? { synthesize: synthesizeDep } : {}),
    }),
  });
  return { status, stdout, stderr, envelope: stderrEnvelope(stderr) };
}

/** A recording fixture dep: captures every prompt it was handed. */
function makeRecordingDep(brief = "SYNTHETIC BRIEF") {
  const calls = [];
  const dep = async (prompt) => {
    calls.push(prompt);
    return brief;
  };
  return { dep, calls };
}

// ---------------------------------------------------------------------------
// 1. Default + additive-only
// ---------------------------------------------------------------------------

describe("investigate --synthesize: absent by default, additive when set", () => {
  it("no flag → the pack has NO brief key", async () => {
    const { descriptors } = fixtures();
    const { dep, calls } = makeRecordingDep();
    const run = await runInvestigate({
      argv: ["--provider", "tavily", "investigate", QUESTION],
      descriptors,
      synthesizeDep: dep,
    });
    assert.strictEqual(run.status, 0, `stderr=${JSON.stringify(run.stderr)}`);
    const pack = JSON.parse(run.stdout[0]);
    assert.ok(!("brief" in pack), "the unflagged pack carries no brief key");
    assert.strictEqual(calls.length, 0, "the dep is never consulted without the flag");
  });

  it("additive-only: strip brief → byte-identical to the unflagged pack", async () => {
    const unflagged = await runInvestigate({
      argv: ["--provider", "tavily", "investigate", QUESTION],
      descriptors: fixtures().descriptors,
    });
    assert.strictEqual(unflagged.status, 0, `stderr=${JSON.stringify(unflagged.stderr)}`);

    const { dep, calls } = makeRecordingDep("A BRIEF");
    const flagged = await runInvestigate({
      argv: ["--provider", "tavily", "investigate", QUESTION, "--synthesize"],
      descriptors: fixtures().descriptors,
      synthesizeDep: dep,
    });
    assert.strictEqual(flagged.status, 0, `stderr=${JSON.stringify(flagged.stderr)}`);
    assert.strictEqual(calls.length, 1, "the flagged run consults the dep exactly once");

    const pack = JSON.parse(flagged.stdout[0]);
    assert.strictEqual(pack.brief, "A BRIEF", "brief attached");
    assert.strictEqual(
      Object.keys(pack).at(-1),
      "brief",
      `brief is the additive key LAST: ${JSON.stringify(Object.keys(pack))}`,
    );
    delete pack.brief;
    assert.strictEqual(
      JSON.stringify(pack),
      unflagged.stdout[0].trim(),
      "the pack minus brief is byte-identical to the no-flag pack",
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Z.AI-only
// ---------------------------------------------------------------------------

describe("investigate --synthesize: Z.AI-only escape hatch", () => {
  it("--provider minimax notices on stderr and synthesizes anyway", async () => {
    const arm = makeSearchDescriptor("minimax", SEARCH_ROWS);
    const reader = makeReaderDescriptor("zai", {
      [URLS.s1]: { content: READ_CONTENT },
      [URLS.s2]: { content: READ_CONTENT },
      [URLS.b2]: { content: READ_CONTENT },
    });
    const { dep, calls } = makeRecordingDep("MINIMAX-PINNED BRIEF");
    const run = await runInvestigate({
      argv: ["--provider", "minimax", "investigate", QUESTION, "--synthesize"],
      descriptors: [arm.descriptor, reader.descriptor],
      synthesizeDep: dep,
    });
    assert.strictEqual(run.status, 0, `stderr=${JSON.stringify(run.stderr)}`);
    assert.ok(
      run.stderr.some((line) => /Z\.AI-only/i.test(line)),
      `stderr carries the Z.AI-only notice: ${JSON.stringify(run.stderr)}`,
    );
    const pack = JSON.parse(run.stdout[0]);
    assert.strictEqual(pack.brief, "MINIMAX-PINNED BRIEF", "synthesis ran despite the pin");
    assert.strictEqual(calls.length, 1);
    // The PACK still used the pinned arm — only the brief ignores it.
    assert.strictEqual(pack.coverage.armsUsed, 1);
    assert.ok(pack.sources.every((s) => s.provider === "minimax"));
  });

  it("no notice when no provider pin is active", async () => {
    const { descriptors } = fixtures();
    const { dep, calls } = makeRecordingDep();
    const run = await runInvestigate({
      argv: ["investigate", QUESTION, "--synthesize"],
      descriptors,
      synthesizeDep: dep,
    });
    assert.strictEqual(run.status, 0, `stderr=${JSON.stringify(run.stderr)}`);
    assert.ok(
      !run.stderr.some((line) => /Z\.AI-only/i.test(line)),
      `no Z.AI-only notice without a pin: ${JSON.stringify(run.stderr)}`,
    );
    assert.strictEqual(calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Failure is terminal (structural: the pack assembled first)
// ---------------------------------------------------------------------------

describe("investigate --synthesize: transport failure is terminal, never a pack degradation", () => {
  it("a throwing dep fails the invocation and emits NO pack", async () => {
    const { descriptors } = fixtures();
    const failing = async () => {
      throw new ApiError("synthesis transport down", 503);
    };
    const run = await runInvestigate({
      argv: ["--provider", "tavily", "investigate", QUESTION, "--synthesize"],
      descriptors,
      synthesizeDep: failing,
    });
    assert.strictEqual(run.status, 1, "the invocation fails");
    assert.ok(
      run.envelope !== undefined,
      `stderr carries the error envelope: ${JSON.stringify(run.stderr)}`,
    );
    assert.strictEqual(envelopeCode(run.envelope), "API_ERROR");
    assert.deepStrictEqual(run.stdout, [], "no pack is emitted on the failure path");
  });

  it("the pack was fully assembled BEFORE the call (production call order)", async () => {
    // The dep observes the world at call time: if synthesis ran before
    // assembly, the recorders would be empty. Side effects asserted at
    // the production sequence, not by calling the endpoint directly
    // (the Exa-class lifecycle lesson).
    const { arm, reader, descriptors } = fixtures();
    let observed;
    const dep = async () => {
      observed = { search: [...arm.invokes], read: [...reader.invokes] };
      return "BRIEF";
    };
    const run = await runInvestigate({
      argv: ["--provider", "tavily", "investigate", QUESTION, "--synthesize"],
      descriptors,
      synthesizeDep: dep,
    });
    assert.strictEqual(run.status, 0, `stderr=${JSON.stringify(run.stderr)}`);
    assert.deepStrictEqual(
      observed.search.slice().sort(),
      ["alpha", "beta"],
      "both sub-queries ran before synthesis was attempted",
    );
    assert.strictEqual(
      observed.read.length,
      3,
      "every read resolved before synthesis was attempted",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Deterministic prompt shape
// ---------------------------------------------------------------------------

describe("investigate --synthesize: the brief prompt is deterministic", () => {
  it("the dep receives question + subQueries + bounded passage quotes", async () => {
    const { descriptors } = fixtures();
    const { dep, calls } = makeRecordingDep();
    const run = await runInvestigate({
      argv: ["--provider", "tavily", "investigate", QUESTION, "--synthesize"],
      descriptors,
      synthesizeDep: dep,
    });
    assert.strictEqual(run.status, 0, `stderr=${JSON.stringify(run.stderr)}`);
    assert.strictEqual(calls.length, 1);
    const prompt = calls[0];
    assert.strictEqual(prompt.question, QUESTION, "the bare question travels verbatim");
    assert.deepStrictEqual(prompt.subQueries, ["alpha", "beta"], "the planned grid travels verbatim");
    assert.ok(Array.isArray(prompt.quotes), "quotes is an array");
    assert.ok(prompt.quotes.length > 0, "passage quotes reach the prompt");
    assert.ok(prompt.quotes.length <= 20, `quotes capped at 20 (got ${prompt.quotes.length})`);
    assert.ok(
      prompt.quotes.every((q) => typeof q === "string" && q.length > 0),
      "every quote is a non-empty string",
    );

    // Determinism: identical fixtures → identical prompt, no clock, no
    // randomness. (The two runs also differ in wall-clock time, so a
    // timestamp leaking into the prompt would show up here.)
    const second = makeRecordingDep();
    const rerun = await runInvestigate({
      argv: ["--provider", "tavily", "investigate", QUESTION, "--synthesize"],
      descriptors: fixtures().descriptors,
      synthesizeDep: second.dep,
    });
    assert.strictEqual(rerun.status, 0, `stderr=${JSON.stringify(rerun.stderr)}`);
    assert.deepStrictEqual(second.calls[0], prompt, "identical fixtures → identical prompt");
  });
});

// ---------------------------------------------------------------------------
// 5. Valueless-flag contract
// ---------------------------------------------------------------------------

describe("investigate --synthesize: a string value is VALIDATION_ERROR", () => {
  it("rejects the separated and the =-form before any provider work", async () => {
    for (const argv of [
      ["investigate", "q", "--synthesize", "foo"],
      ["investigate", "q", "--synthesize=foo"],
    ]) {
      const descriptors = [
        {
          id: "tavily",
          isConfigured: () => true,
          capabilities: () => new Set(["search"]),
          create() {
            throw new Error("create() must not be reached on a bad --synthesize");
          },
        },
      ];
      const run = await runInvestigate({ argv, descriptors });
      assert.strictEqual(run.status, 1, `argv=${argv.join(" ")} must reject`);
      assert.strictEqual(
        envelopeCode(run.envelope),
        "VALIDATION_ERROR",
        `argv=${argv.join(" ")} → VALIDATION_ERROR`,
      );
    }
  });
});
