/**
 * Science command layer — T6 RED tests (TASKS T6; DESIGN D5/D6/D6b;
 * PRD AC-4b, AC-5d, AC-7, AC-7b).
 *
 * GROUND map (per describe below):
 *   - TASKS T6: `src/commands/science.ts` — search+get handlers,
 *     identifier grammar parse, `--type component` rejection, help
 *     text. Handlers RETURN CommandResult (`{kind:"data", data}`)
 *     through the invocation seam — `outputSuccess`/`outputError`
 *     were removed (22337a1) and are test-forbidden (DESIGN D6
 *     correction; tests/output.test.js).
 *   - TASKS T6: index.ts dispatch — ONE credential-free
 *     `if (command === "science") {` arm inside main() at line start
 *     (`archive` precedent; the arm-shape/source pin itself is T8's).
 *   - TASKS T6 / DESIGN D6b: `SCIENCE_LADDER` exported from
 *     commands/science.ts and wired in the dispatcher ladder branch;
 *     `science` NOT in REJECT_MAX_CHARS_COMMANDS (PRD AC-5d — science
 *     joins the ladder partition, never the rejection set).
 *   - TASKS T6 interim resolver (T10 owns the full D5 grammar):
 *     no pin → FIRST configured+capable science supplier in the D5
 *     openalex-first arm order (openalex, arxiv, crossref, pubmed,
 *     europepmc); pin honored; `--provider all` treated as the no-pin
 *     default for now; marked TODO(T10). T6's done-when does NOT
 *     claim AC-1's fan-out.
 *   - Interim-pin guard (2026-09-10, the "legacy tests encode the
 *     bug" class): the interim tests below are named `interim-…`,
 *     assert SINGLE-ARM (not merged) output, and carry a comment
 *     naming T10 as the flip owner. T10's diff UPDATES these tests to
 *     fan-out semantics, never deletes the pin silently.
 *   - DESIGN D6: identifier grammar parsed ONCE at the command layer
 *     and routed to suppliers serving that id type (DOI → all but
 *     arxiv; PMID → openalex/europepmc/pubmed; arXiv → arxiv only —
 *     D10 Q3 membership), "pinned by test" per D6. PRD AC-4b.
 *   - DESIGN D6 parse-level rejection + PRD AC-7/AC-7b: `--type`
 *     accepts exactly the union vocabulary article | preprint |
 *     conference-paper | chapter | dataset | review | other;
 *     `component` is rejected at parse — never requestable, never
 *     surfaced (AC-4's junk filter is supplier-output side, not a
 *     flag value). `--year` closed forms "2020" | "2018:2022";
 *     empty/bad/reversed ranges rejected at parse.
 *   - DESIGN D6 envelope: `science search` → data CommandResult with
 *     ScienceWork[] (bare array, data-only stdout); `science get` →
 *     single ScienceWork; errors through the invocation error path
 *     (JSON error contract preserved).
 *   - DESIGN D6b trim order (budget test): `summary` first, then
 *     `authors` tail, then `venue`; never-cut: `title`, `url`,
 *     `identifiers`.
 *
 * Hermeticity (TASKS T6 "Tests: hermetic main()"): main()-level via
 * hermeticMainDeps — config injection (`env:{}` is NOT isolation,
 * GitHub #42), fake science descriptors (search-fanout.test.js idiom)
 * recording every capability invoke, injected clock, isolated
 * SCOUTLINE_ARTIFACTS_DIR for the budget run.
 * Tests import ../dist/... — verification order is build, then test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main, REJECT_MAX_CHARS_COMMANDS } from "../dist/index.js";
import { ApiError } from "../dist/lib/errors.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";
import { withTempDir } from "./helpers/temp-dir.js";

const NOW = 1_800_000_000_000;

/**
 * The D5 openalex-first ARM order (an executor-side ordering rule, NOT
 * the D2/PROVIDER_IDS registry listing order). Literal in the test on
 * purpose (T5b discipline): a registry-order leak into the interim
 * resolver (arxiv first) fails this independent literal.
 */
const D5_ARM_ORDER = ["openalex", "arxiv", "crossref", "pubmed", "europepmc"];

/**
 * The D6 `--type` union vocabulary as an independent test-file literal
 * (PRD AC-7). `component` is NOT a member.
 */
const TYPE_UNION = [
  "article",
  "preprint",
  "conference-paper",
  "chapter",
  "dataset",
  "review",
  "other",
];

// ---------------------------------------------------------------------------
// Fakes — one descriptor per science id, recording every invoke
// ---------------------------------------------------------------------------

/**
 * Fake science supplier descriptor (search-fanout.test.js idiom,
 * adapted to the science capability slots). Every capability invoke is
 * recorded; `configured`/`caps` shape the resolver's eligibility walk.
 */
function makeScienceDescriptor(id, opts = {}) {
  const calls = { create: 0, search: [], get: [], createEnvs: [] };
  const descriptor = {
    id,
    isConfigured: (_env, capabilityId) =>
      opts.configured === undefined ? true : opts.configured(capabilityId),
    capabilities: () => new Set(opts.caps ?? ["science.search", "science.get"]),
    create(context) {
      calls.create += 1;
      calls.createEnvs.push(context?.env);
      return {
        id,
        science: {
          search: {
            validate() {},
            cacheIdentity: (request) => ({
              supplier: id,
              capability: "science.search",
              credentialFingerprint: "",
              request,
            }),
            async invoke(request) {
              calls.search.push(request);
              return opts.searchWorks !== undefined
                ? opts.searchWorks(request)
                : [{ title: `search-from-${id}`, url: `https://example.org/${id}` }];
            },
          },
          get: {
            validate() {},
            cacheIdentity: (request) => ({
              supplier: id,
              capability: "science.get",
              credentialFingerprint: "",
              request,
            }),
            async invoke(request) {
              calls.get.push(request);
              return (
                opts.getWork?.(request) ?? {
                  title: `work-from-${id}`,
                  url: `https://example.org/${id}`,
                }
              );
            },
          },
        },
      };
    },
    credentialEnvVars: opts.credentialEnvVars ?? [],
  };
  return { descriptor, calls };
}

/** All five science suppliers, eligible, keyed by id for assertions. */
function scienceFive(perIdOpts = {}) {
  const byId = {};
  const descriptors = [];
  for (const id of D5_ARM_ORDER) {
    const made = makeScienceDescriptor(id, perIdOpts[id] ?? {});
    byId[id] = made;
    descriptors.push(made.descriptor);
  }
  return { descriptors, byId };
}

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

async function runMain(argv, { descriptors, artifactsDir, loadScoutlineConfig } = {}) {
  const { adapter, stdout, stderr } = makeInvocation();
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      env: {
        ...(artifactsDir !== undefined ? { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } : {}),
      },
      now: () => NOW,
      ...(descriptors !== undefined ? { providerDescriptors: descriptors } : {}),
      ...(loadScoutlineConfig !== undefined ? { loadScoutlineConfig } : {}),
    }),
  });
  return { status, stdout, stderr };
}

function parseStderr(stderr) {
  return JSON.parse(stderr.join(""));
}

// ---------------------------------------------------------------------------
// Dispatch + help (TASKS T6 dispatch bullet; DESIGN D6 help bullet)
// ---------------------------------------------------------------------------

describe("science noun dispatch + help", () => {
  it("science --help exits 0 with subcommand help on stdout, stderr empty", async () => {
    // GROUND: TASKS T6 "help text … subcommand help mirrors archive
    // shape" (archive precedent: <cmd> --help prints ARCHIVE_HELP).
    const { status, stdout, stderr } = await runMain(["science", "--help"], {
      descriptors: scienceFive().descriptors,
    });
    assert.equal(status, 0);
    assert.deepEqual(stderr, [], "help is stdout-only");
    const help = stdout.join("");
    assert.match(help, /science search/, "help documents the search subcommand");
    assert.match(help, /science get/, "help documents the get subcommand");
  });

  it("bare science (no subcommand) renders help and exits 0", async () => {
    // GROUND: archive precedent — subcommand undefined → help, exit 0.
    const { status, stdout } = await runMain(["science"], {
      descriptors: scienceFive().descriptors,
    });
    assert.equal(status, 0);
    assert.match(stdout.join(""), /science search/);
  });

  it("unknown science subcommand fails VALIDATION_ERROR naming the valid subcommands", async () => {
    // GROUND: archive precedent — "Unknown archive subcommand" shape.
    const { status, stdout, stderr } = await runMain(["science", "transmogrify", "x"], {
      descriptors: scienceFive().descriptors,
    });
    assert.equal(status, 1);
    assert.deepEqual(stdout, [], "data-only stdout contract — nothing on stdout");
    const err = parseStderr(stderr);
    assert.equal(err.code, "VALIDATION_ERROR");
    assert.match(err.error, /search/);
    assert.match(err.error, /get/);
  });

  it("science dispatches credential-free: a throwing config loader never blocks a science run", async () => {
    // GROUND: TASKS T6 "credential-free `if (command === "science") {`
    // arm" — the archive precedent short-circuits BEFORE config load;
    // if the science arm landed inside the credentialed switch, the
    // throwing loader below would fail the run instead.
    const { descriptors } = scienceFive();
    const { status, stdout } = await runMain(["science", "search", "q"], {
      descriptors,
      loadScoutlineConfig: async () => {
        throw new Error("config must not be loaded for science commands");
      },
    });
    assert.equal(status, 0);
    assert.ok(stdout.length > 0, "successful run writes stdout");
  });
});

// ---------------------------------------------------------------------------
// Parse-level rejections (TASKS T6 "parse-level rejections"; DESIGN D6;
// PRD AC-7/AC-7b, AC-4b)
// ---------------------------------------------------------------------------

describe("science search — parse-level rejections before any supplier invoke", () => {
  async function assertRejectedAtParse(argv, expectedCode, messagePattern, label) {
    // Env-honest pin (AGENTS.md): `science` IS dispatched (the
    // credential-free arm in index.ts), so a parse-level rejection is
    // the handler's own ValidationError — the doesNotMatch guard below
    // keeps the row honest against the dispatcher's unknown-command
    // error, and the message pattern is what pins each flag's wording.
    const { descriptors } = scienceFive();
    const { status, stdout, stderr } = await runMain(argv, { descriptors });
    assert.equal(status, 1, `${label}: exit 1`);
    assert.deepEqual(stdout, [], `${label}: data-only stdout — nothing on stdout`);
    const err = parseStderr(stderr);
    assert.equal(err.code, expectedCode, `${label}: error code`);
    assert.doesNotMatch(
      err.error,
      /Unknown command/,
      `${label}: not the dispatcher's unknown-command error`,
    );
    assert.match(err.error, messagePattern, `${label}: message names the offending flag/value`);
    return err;
  }

  it("--type component is rejected at parse — never requestable, never surfaced", async () => {
    // GROUND: TASKS T6 "`--type component` rejection"; DESIGN D6
    // "Parse-level rejection: `--type component` rejected (never
    // surfaced)"; PRD AC-7 "component is rejected at parse". Grammar
    // violation = house ValidationError class (archive --limit /
    // output-format precedent).
    const { descriptors } = scienceFive();
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "attention", "--type", "component"],
      { descriptors },
    );
    assert.equal(status, 1);
    assert.deepEqual(stdout, []);
    const err = parseStderr(stderr);
    assert.equal(err.code, "VALIDATION_ERROR");
    assert.doesNotMatch(err.error, /Unknown command/, "not the unknown-command error");
    assert.match(err.error, /--type/, "message names the rejected flag");
  });

  it("--type outside the union vocabulary is rejected at parse", async () => {
    // GROUND: PRD AC-7 "--type accepts exactly the D6 union
    // vocabulary"; DESIGN D6 type bullet.
    await assertRejectedAtParse(
      ["science", "search", "attention", "--type", "peer-review"],
      "VALIDATION_ERROR",
      /--type/,
      "unknown type value",
    );
  });

  it("--year reversed range is rejected at parse", async () => {
    // GROUND: PRD AC-7b "empty/bad ranges rejected at parse"; D1
    // closed-form year grammar (start must not exceed end).
    await assertRejectedAtParse(
      ["science", "search", "attention", "--year", "2022:2018"],
      "VALIDATION_ERROR",
      /--year/,
      "reversed year range",
    );
  });

  it("--year malformed value is rejected at parse", async () => {
    // GROUND: PRD AC-7b — only "2020" | "2018:2022" closed forms.
    await assertRejectedAtParse(
      ["science", "search", "attention", "--year", "20x20"],
      "VALIDATION_ERROR",
      /--year/,
      "malformed year",
    );
  });

  it("--author without a value is rejected at parse", async () => {
    // GROUND: value-required gate (review) — a valueless `--author`
    // parses as boolean true and must reject exactly like `--year`
    // does, never silently broaden the search.
    await assertRejectedAtParse(
      ["science", "search", "attention", "--author"],
      "VALIDATION_ERROR",
      /--author requires a value/,
      "valueless --author",
    );
  });

  it("--venue without a value is rejected at parse", async () => {
    // GROUND: same value-required gate — valueless `--venue` rejects
    // at parse with the flag-naming message, like `--author`.
    await assertRejectedAtParse(
      ["science", "search", "attention", "--venue"],
      "VALIDATION_ERROR",
      /--venue requires a value/,
      "valueless --venue",
    );
  });

  it("missing query fails VALIDATION_ERROR (archive cdx required-positional precedent)", async () => {
    // GROUND: TASKS T6 handler bullet — search takes <query>;
    // DESIGN D1 empty-query rejection mirrored at command parse.
    await assertRejectedAtParse(
      ["science", "search"],
      "VALIDATION_ERROR",
      /[Qq]uery/,
      "missing query",
    );
  });

  it("every rejection above fires before ANY supplier invoke (parse-time teeth)", async () => {
    // GROUND: "parse-level" — the D6 junk filter for `component` is
    // never surfaced means no supplier saw the request; same for the
    // grammar rejections. Mutation guard: a resolver that creates an
    // adapter and defers validation to invoke-time fails here.
    const { descriptors, byId } = scienceFive();
    await runMain(["science", "search", "attention", "--type", "component"], {
      descriptors,
    });
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.search.length, 0, `${id}.invoke must not run`);
    }
  });

  it("valueless --author/--venue rejections also fire before ANY supplier invoke", async () => {
    // GROUND: parse-time teeth for the value-required gates — a
    // resolver that defers the boolean-true rejection to invoke time
    // (or drops the flag silently) fails here.
    const { descriptors, byId } = scienceFive();
    await runMain(["science", "search", "attention", "--author"], { descriptors });
    await runMain(["science", "search", "attention", "--venue"], { descriptors });
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.search.length, 0, `${id}.invoke must not run`);
    }
  });
});

describe("science get — identifier grammar at the command layer (AC-4b; DESIGN D6)", () => {
  it("missing identifier fails VALIDATION_ERROR", async () => {
    const { descriptors } = scienceFive();
    const { status, stdout, stderr } = await runMain(["science", "get"], { descriptors });
    assert.equal(status, 1);
    assert.deepEqual(stdout, []);
    const err = parseStderr(stderr);
    assert.equal(err.code, "VALIDATION_ERROR");
    assert.doesNotMatch(err.error, /Unknown command/, "not the unknown-command error");
    assert.match(err.error, /[Ii]dentifier/, "message names the identifier");
  });

  it("a prefixed doi: identifier is outside the bare grammar and fails VALIDATION_ERROR", async () => {
    // GROUND: DESIGN D6/D1 — bare forms ONLY; `doi:10.1038/…` returns
    // null from parseScienceIdentifier → command-layer rejection.
    const { descriptors, byId } = scienceFive();
    const { status, stdout, stderr } = await runMain(
      ["science", "get", "doi:10.1038/nature12373"],
      { descriptors },
    );
    assert.equal(status, 1);
    assert.deepEqual(stdout, []);
    const err = parseStderr(stderr);
    assert.equal(err.code, "VALIDATION_ERROR");
    assert.doesNotMatch(err.error, /Unknown command/, "not the unknown-command error");
    assert.match(err.error, /[Ii]dentifier/, "message names the identifier");
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.get.length, 0, `${id}.get must not run`);
    }
  });

  it("free-text identifiers fail VALIDATION_ERROR before any supplier", async () => {
    // GROUND: DESIGN D6 closed grammar — identifiers that match no
    // bare form never reach a supplier.
    const { descriptors, byId } = scienceFive();
    const { status, stderr } = await runMain(["science", "get", "hello world"], { descriptors });
    assert.equal(status, 1);
    const err = parseStderr(stderr);
    assert.doesNotMatch(err.error, /Unknown command/, "not the unknown-command error");
    assert.match(err.error, /[Ii]dentifier/, "message names the identifier");
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.get.length, 0, `${id}.get must not run`);
    }
  });
});

// ---------------------------------------------------------------------------
// Envelope shape (DESIGN D6; data-only stdout preserved)
// ---------------------------------------------------------------------------

describe("science envelope shape — data CommandResult, data-only stdout", () => {
  it("science search returns the ScienceWork[] as the data payload (bare array)", async () => {
    // GROUND: DESIGN D6 "`science search <query> → data CommandResult
    // with ScienceWork[] (data-only stdout preserved)" — the house
    // search shape: data-mode stdout IS the results array.
    const works = [
      {
        title: "Attention Is All You Need",
        url: "https://doi.org/10.5555/3295222.3295349",
        identifiers: { doi: "10.5555/3295222.3295349" },
        year: 2017,
      },
      {
        title: "A second work",
        url: "https://example.org/second",
      },
    ];
    // T10 flip: the no-pin default is the fan-out; zeroing the four
    // sibling arms keeps this envelope pin single-supplier-shaped.
    const { descriptors } = scienceFive({
      openalex: { searchWorks: () => works },
      arxiv: { searchWorks: () => [] },
      crossref: { searchWorks: () => [] },
      pubmed: { searchWorks: () => [] },
      europepmc: { searchWorks: () => [] },
    });
    const { status, stdout } = await runMain(["science", "search", "attention"], {
      descriptors,
    });
    assert.equal(status, 0);
    assert.equal(stdout.length, 1, "one stdout value — data-only contract");
    const parsed = JSON.parse(stdout.join(""));
    assert.ok(Array.isArray(parsed), "data payload is the bare ScienceWork array");
    assert.equal(parsed.length, 2);
    for (const w of parsed) {
      assert.equal(typeof w.title, "string", "ScienceWork.title is a string");
      assert.equal(typeof w.url, "string", "ScienceWork.url is a string");
    }
    assert.deepEqual(parsed, works, "supplier works pass through unmodified");
  });

  it("science get returns a single ScienceWork object", async () => {
    // GROUND: DESIGN D6 "`science get <identifier> → data CommandResult
    // single ScienceWork`".
    const work = { title: "A single work", url: "https://example.org/one" };
    const { descriptors } = scienceFive({
      openalex: { getWork: () => work },
    });
    const { status, stdout } = await runMain(["science", "get", "10.1038/nature12373"], {
      descriptors,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(typeof parsed, "object");
    assert.ok(!Array.isArray(parsed), "get payload is a single work, not an array");
    assert.equal(typeof parsed.title, "string");
    assert.equal(typeof parsed.url, "string");
    assert.deepEqual(parsed, work);
  });

  it("supplier failures surface through the invocation error path (JSON contract preserved)", async () => {
    // GROUND: DESIGN D6 "Errors through the invocation error path
    // (JSON contract preserved)" — one structured stderr envelope, no
    // stdout, typed error code pass-through.
    // T10 flip: pin the failing arm — an unpinned fan-out deliberately
    // continues past a failed arm when others serve; the single-arm
    // failure contract is the pin.
    const { descriptors } = scienceFive({
      openalex: {
        searchWorks: () => {
          throw new ApiError("openalex exploded", 503);
        },
      },
    });
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "q", "--provider", "openalex"],
      { descriptors },
    );
    assert.equal(status, 1);
    assert.deepEqual(stdout, [], "failure path keeps stdout empty");
    const err = parseStderr(stderr);
    assert.equal(err.code, "API_ERROR");
    assert.match(err.error, /openalex exploded/);
  });
});

// ---------------------------------------------------------------------------
// Resolver — interim pins FLIPPED to fan-out semantics (TASKS T10 flip
// ownership, named in the T6-era TODO(T10) comments; DESIGN D5
// openalex-first arm order governs first-supplier-wins merge). The
// merge/dedup/enrichment teeth live in science-fanout-merge.test.js.
// ---------------------------------------------------------------------------

describe("resolver (T10 fan-out semantics — interim pins flipped in-ticket)", () => {
  it("default-no-pin: search invokes EVERY enabled supplier in D5 arm order — merged fan-out, not single-arm", async () => {
    // GROUND: TASKS T10 "NO-PIN DEFAULT fan-out across all enabled
    // science suppliers" — the T6 interim pin (single openalex arm,
    // openalex-only output) flipped in-ticket per the interim-pin
    // guard: T10's diff UPDATES these tests, never deletes them.
    // Asserts the arm SET + merged output; dedup/enrichment detail is
    // science-fanout-merge.test.js's.
    const { descriptors, byId } = scienceFive();
    const { status, stdout } = await runMain(["science", "search", "attention"], {
      descriptors,
    });
    assert.equal(status, 0);
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.search.length, 1, `${id} invoked once in the fan-out`);
    }
    const parsed = JSON.parse(stdout.join(""));
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 5, "merged across all five arms");
    assert.deepEqual(
      parsed.map((w) => w.title).sort(),
      [
        "search-from-arxiv",
        "search-from-crossref",
        "search-from-europepmc",
        "search-from-openalex",
        "search-from-pubmed",
      ],
      "fan-out output: every arm's works merged — never a single-arm result",
    );
  });

  it("pin: --provider <id> is honored over the fan-out default", async () => {
    // GROUND: TASKS T10 "single `--provider <id>` pin" (unchanged from
    // T6: a pin is single-arm by design); D5 "`--provider openalex`
    // pins directly (bare id — no new grammar)".
    const { descriptors, byId } = scienceFive();
    const { status } = await runMain(["science", "search", "q", "--provider", "crossref"], {
      descriptors,
    });
    assert.equal(status, 0);
    assert.equal(byId.crossref.calls.search.length, 1, "pinned supplier invoked");
    assert.equal(byId.openalex.calls.search.length, 0, "other arms not consulted");
    assert.equal(byId.arxiv.calls.search.length, 0);
  });

  it("provider-all: --provider all runs the real fan-out (all five arms, merged array)", async () => {
    // GROUND: TASKS T10 "`--provider all`" — flipped from the T6
    // interim "treated as the no-pin default" to the actual fan-out:
    // every arm invokes, one merged result set.
    const { descriptors, byId } = scienceFive();
    const { status, stdout } = await runMain(["science", "search", "q", "--provider", "all"], {
      descriptors,
    });
    assert.equal(status, 0, "--provider all must not fail as an unknown provider");
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.search.length, 1, `${id} runs in the pinned fan-out`);
    }
    assert.equal(JSON.parse(stdout.join("")).length, 5);
  });

  it("fanout-empty-success: a rejected sibling does not fail an EMPTY-but-fulfilled fan-out (review)", async () => {
    // GROUND: review round 4 — "fail only when every arm rejects". A
    // fulfilled arm may validly return zero works; the old
    // `works.length === 0 && firstRejected` condition failed the whole
    // command even though a supplier completed successfully. The failed
    // sibling is disclosed per-arm on stderr; the command succeeds
    // with the (empty) merged set.
    const five = scienceFive({
      openalex: {
        searchWorks: () => {
          throw new ApiError("openalex down", 503);
        },
      },
      arxiv: { searchWorks: () => [] },
      crossref: { searchWorks: () => [] },
      pubmed: { searchWorks: () => [] },
      europepmc: { searchWorks: () => [] },
    });
    const result = await runMain(["science", "search", "q"], {
      descriptors: five.descriptors,
    });
    assert.equal(result.status, 0, "empty-but-fulfilled fan-out succeeds");
    assert.equal(five.byId.openalex.calls.search.length, 1, "the failing arm was attempted");
    assert.deepEqual(JSON.parse(result.stdout.join("")), [], "merged set is honestly empty");
    assert.match(
      result.stderr.join(""),
      /openalex arm failed/,
      "the failed sibling is disclosed per-arm",
    );
  });

  it("fanout-skip-unconfigured: an unconfigured arm is excluded; the fan-out proceeds on the remaining enabled arms", async () => {
    // GROUND: DESIGN D5 "fan-out across all ENABLED science suppliers"
    // — the T6 interim single-arm walk flipped: openalex down no
    // longer selects arxiv ALONE; the remaining four arms all run and
    // merge.
    const { descriptors, byId } = scienceFive({
      openalex: { configured: () => false },
    });
    const { status, stdout } = await runMain(["science", "search", "q"], {
      descriptors,
    });
    assert.equal(status, 0);
    assert.equal(byId.openalex.calls.search.length, 0, "unconfigured arm excluded");
    for (const id of ["arxiv", "crossref", "pubmed", "europepmc"]) {
      assert.equal(byId[id].calls.search.length, 1, `${id} runs in the narrowed fan-out`);
    }
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.length, 4);
    assert.deepEqual(parsed.map((w) => w.title).sort(), [
      "search-from-arxiv",
      "search-from-crossref",
      "search-from-europepmc",
      "search-from-pubmed",
    ]);
  });

  it("fanout-skip-incapable: a supplier not advertising science.search is excluded from the fan-out", async () => {
    // GROUND: DESIGN D5 "enabled = configured+capable" — capabilities()
    // gates the fan-out arm set beside isConfigured.
    const { descriptors, byId } = scienceFive({
      openalex: { caps: ["science.get", "diagnostics"] },
    });
    const { status } = await runMain(["science", "search", "q"], { descriptors });
    assert.equal(status, 0);
    assert.equal(byId.openalex.calls.search.length, 0, "incapable arm excluded");
    for (const id of ["arxiv", "crossref", "pubmed", "europepmc"]) {
      assert.equal(byId[id].calls.search.length, 1, `${id} still runs`);
    }
  });

  it("get-routing: get routes by identifier type through the D5 arm order (DOI→openalex, arXiv→arxiv, legacy arXiv→arxiv, PMID→openalex)", async () => {
    // GROUND: DESIGN D6 "parse once, route to suppliers that serve
    // that id type … id-type→supplier membership … consumed by
    // T6/T10, pinned by test" + D10 Q3 membership (DOI → all but
    // arxiv; PMID → openalex/europepmc/pubmed; arXiv → arxiv only).
    // The routing table itself survives the T10 fallback flip
    // unchanged — fallback reroutes ON FAILURE (see
    // science-fanout-merge.test.js), the first-attempt routing still
    // walks the same order.
    const cases = [
      { identifier: "10.1038/nature12373", expected: "openalex" },
      { identifier: "2401.12345", expected: "arxiv" },
      { identifier: "cs/0501001", expected: "arxiv" },
      { identifier: "31672840", expected: "openalex" },
    ];
    for (const { identifier, expected } of cases) {
      const { descriptors, byId } = scienceFive();
      const { status } = await runMain(["science", "get", identifier], { descriptors });
      assert.equal(status, 0, `${identifier}: exit 0`);
      assert.equal(byId[expected].calls.get.length, 1, `${identifier}: routed to ${expected}`);
      for (const id of D5_ARM_ORDER) {
        if (id !== expected) {
          assert.equal(byId[id].calls.get.length, 0, `${identifier}: ${id} not consulted`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Controls threading (DESIGN D6/D7; PRD AC-7)
// ---------------------------------------------------------------------------

describe("science controls thread from CLI flags into the capability request", () => {
  it("all four controls (--author --year --venue --type) reach the pinned supplier's request", async () => {
    // GROUND: DESIGN D7 wire table — crossref consumes author, year,
    // venue (container-title), and type; the command layer must build
    // ScienceControls from the flags and pass them through to the
    // selected supplier's request (never accept-and-drop).
    const { descriptors, byId } = scienceFive();
    const { status } = await runMain(
      [
        "science",
        "search",
        "attention mechanism",
        "--provider",
        "crossref",
        "--author",
        "Vaswani",
        "--year",
        "2018:2022",
        "--venue",
        "Nature",
        "--type",
        "review",
      ],
      { descriptors },
    );
    assert.equal(status, 0);
    assert.equal(byId.crossref.calls.search.length, 1);
    const request = byId.crossref.calls.search[0];
    assert.equal(request.query, "attention mechanism");
    assert.deepEqual(request.controls, {
      author: "Vaswani",
      year: "2018:2022",
      venue: "Nature",
      type: "review",
    });
  });

  it("every D6 union vocabulary value is accepted at parse and carried on the request", async () => {
    // GROUND: PRD AC-7 — the union is exactly the seven values; each
    // must be requestable (the vocabulary literal is test-side).
    for (const type of TYPE_UNION) {
      const { descriptors, byId } = scienceFive();
      const { status } = await runMain(
        ["science", "search", "q", "--provider", "crossref", "--type", type],
        { descriptors },
      );
      assert.equal(status, 0, `--type ${type} must parse`);
      assert.equal(byId.crossref.calls.search[0].controls.type, type);
    }
  });

  it("single-year and range forms both pass parse onto the request", async () => {
    // GROUND: PRD AC-7b "--year accepts single year and from:to range".
    for (const year of ["2020", "2018:2022"]) {
      const { descriptors, byId } = scienceFive();
      const { status } = await runMain(
        ["science", "search", "q", "--provider", "crossref", "--year", year],
        { descriptors },
      );
      assert.equal(status, 0, `--year ${year} must parse`);
      assert.equal(byId.crossref.calls.search[0].controls.year, year);
    }
  });
});

// ---------------------------------------------------------------------------
// Output budget ladder (DESIGN D6b; PRD AC-5d)
// ---------------------------------------------------------------------------

describe("science output budget — SCIENCE_LADDER partition (D6b, AC-5d)", () => {
  it("SCIENCE_LADDER is exported from commands/science.ts as a non-empty ladder", async () => {
    // GROUND: TASKS T6 "SCIENCE_LADDER (D6b) exported from
    // commands/science.ts" — one ladder serving both verbs (get
    // budgets the single-work envelope). Dynamic import keeps the RED
    // phase observable per-test.
    const mod = await import("../dist/commands/science.js");
    assert.ok(Array.isArray(mod.SCIENCE_LADDER), "SCIENCE_LADDER is an array");
    assert.ok(mod.SCIENCE_LADDER.length > 0, "ladder is non-empty");
  });

  it("science is NOT in REJECT_MAX_CHARS_COMMANDS (ladder partition, not rejection)", async () => {
    // GROUND: TASKS T6 "science NOT in REJECT_MAX_CHARS_COMMANDS
    // (partition test duty, AC-5d)"; DESIGN D6b "science joins the
    // ladder partition, not the rejection set". The structural
    // partition pin in output-budget-rejection.test.js widens to
    // science in the same commit (T8 re-pins; this asserts the T6
    // side of the partition directly).
    assert.equal(
      REJECT_MAX_CHARS_COMMANDS.has("science"),
      false,
      "science must never join the --max-chars rejection set",
    );
  });

  it("science search --max-chars is honored: envelope shrinks, title/url never cut", async (t) => {
    // GROUND: DESIGN D6b — trim order summary first, then authors
    // tail, then venue; never-cut title/url/identifiers. D6b trim
    // order asserted at the observable seam: budgeted stdout loses
    // summary mass, keeps every title and url.
    await withTempDir(t, async (dir) => {
      const bigSummary = "s".repeat(5000);
      const works = [1, 2, 3].map((i) => ({
        title: `work-${i}-title`,
        url: `https://example.org/work-${i}`,
        summary: bigSummary,
        authors: ["A", "B", "C"],
        venue: "Some Venue",
      }));
      // T10 flip: zero the sibling arms so the fan-out default yields
      // exactly these works (budget assertions unchanged).
      const { descriptors } = scienceFive({
        openalex: { searchWorks: () => works },
        arxiv: { searchWorks: () => [] },
        crossref: { searchWorks: () => [] },
        pubmed: { searchWorks: () => [] },
        europepmc: { searchWorks: () => [] },
      });
      const full = await runMain(["science", "search", "q"], {
        descriptors,
        artifactsDir: dir,
      });
      assert.equal(full.status, 0);
      assert.ok(
        full.stdout.join("").includes(bigSummary),
        "unbudgeted run prints the full envelope",
      );

      const budgeted = await runMain(["science", "search", "q", "--max-chars", "600"], {
        descriptors,
        artifactsDir: dir,
      });
      assert.equal(budgeted.status, 0, "--max-chars must be accepted, not UNSUPPORTED_OPTION");
      const out = budgeted.stdout.join("");
      assert.ok(out.length < full.stdout.join("").length, "budgeted envelope is smaller");
      assert.ok(!out.includes(bigSummary), "summary mass was trimmed/dropped");
      const parsed = JSON.parse(out);
      const rows = Array.isArray(parsed) ? parsed : (parsed.results ?? []);
      assert.ok(rows.length > 0, "rows survive the budget walk");
      for (const w of rows) {
        assert.equal(typeof w.title, "string", "title is never-cut");
        assert.match(w.title, /^work-\d+-title$/, "title survives verbatim");
        assert.equal(typeof w.url, "string", "url is never-cut");
        assert.match(w.url, /^https:\/\/example\.org\/work-\d+$/, "url survives verbatim");
      }
    });
  });

  it("science get --max-chars is honored: envelope shrinks, title/url intact, compaction ref carried", async (t) => {
    // GROUND: DESIGN D6b "single ladder serving both verbs — get budgets
    // the single-work envelope". The get branch of
    // applyScienceOutputBudget (src/commands/science.ts) is exercised
    // by no other test in this lane. Same observable seam as the search
    // test above: budgeted stdout loses summary mass, title/url survive
    // verbatim, the full envelope is persisted and the payload carries
    // the compaction ref.
    await withTempDir(t, async (dir) => {
      const bigSummary = "s".repeat(5000);
      const { descriptors } = scienceFive({
        openalex: {
          getWork: () => ({
            title: "work-title",
            url: "https://example.org/one",
            summary: bigSummary,
          }),
        },
      });
      const full = await runMain(["science", "get", "10.1038/nature12373"], {
        descriptors,
        artifactsDir: dir,
      });
      assert.equal(full.status, 0);
      assert.ok(
        full.stdout.join("").includes(bigSummary),
        "unbudgeted get prints the full single-work envelope",
      );

      const budgeted = await runMain(
        ["science", "get", "10.1038/nature12373", "--max-chars", "600"],
        { descriptors, artifactsDir: dir },
      );
      assert.equal(
        budgeted.status,
        0,
        "--max-chars must be accepted on get, not UNSUPPORTED_OPTION",
      );
      const out = budgeted.stdout.join("");
      assert.ok(
        out.length < full.stdout.join("").length,
        "budgeted single-work envelope is smaller",
      );
      assert.ok(!out.includes(bigSummary), "summary mass was trimmed/dropped");
      const parsed = JSON.parse(out);
      assert.match(parsed.title, /^work-title$/, "title survives verbatim");
      assert.equal(parsed.url, "https://example.org/one", "url survives verbatim");
      assert.ok(
        typeof parsed.compaction?.ref === "string" && parsed.compaction.ref.length > 0,
        "budgeted get payload carries a compaction ref",
      );
    });
  });

  it("a text output mode prints the BUDGETED view: presentations rebuilt from the projection", async (t) => {
    // GROUND: review R5 (search.ts precedent) — when --max-chars
    // compaction fires, the text presentations are REBUILT from the
    // projected envelope (applyScienceOutputBudget). Pre-fix defect:
    // a text mode printed the ORIGINAL unbudgeted render while only
    // the data envelope carried the projection. The compaction notice
    // must fire on the same run.
    await withTempDir(t, async (dir) => {
      const bigSummary = "s".repeat(5000);
      const works = [1, 2, 3].map((i) => ({
        title: `work-${i}-title`,
        url: `https://example.org/work-${i}`,
        summary: bigSummary,
        authors: ["A", "B", "C"],
        venue: "Some Venue",
      }));
      // T10 flip: zero the sibling arms so the fan-out default yields
      // exactly these works (budget assertions unchanged).
      const { descriptors } = scienceFive({
        openalex: { searchWorks: () => works },
        arxiv: { searchWorks: () => [] },
        crossref: { searchWorks: () => [] },
        pubmed: { searchWorks: () => [] },
        europepmc: { searchWorks: () => [] },
      });
      const budgeted = await runMain(
        ["--output-format", "compact", "science", "search", "q", "--max-chars", "600"],
        { descriptors, artifactsDir: dir },
      );
      assert.equal(budgeted.status, 0);
      const text = budgeted.stdout.join("");
      assert.ok(
        !text.includes(bigSummary),
        "text view must not carry summary mass the ladder trimmed",
      );
      assert.match(text, /work-1-title/, "text view still renders the projected rows");
      assert.match(
        budgeted.stderr.join(""),
        /output budget: 600 chars/,
        "the compaction notice fires",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// House output seam (DESIGN D6 correction; tests/output.test.js rule)
// ---------------------------------------------------------------------------

describe("science command module uses the CommandResult seam, not the removed output API", () => {
  it("commands/science.ts never references outputSuccess/outputError", () => {
    // GROUND: TASKS T6 "outputSuccess/outputError were removed
    // (22337a1) and are test-forbidden (tests/output.test.js; see
    // DESIGN D6 correction)" — mirror of output.test.js's source pin
    // for the new command module.
    const src = readFileSync(
      fileURLToPath(new URL("../src/commands/science.ts", import.meta.url)),
      "utf8",
    );
    assert.ok(!/\boutputSuccess\b/.test(src), "no outputSuccess identifier");
    assert.ok(!/\boutputError\b/.test(src), "no outputError identifier");
  });
});

// ---------------------------------------------------------------------------
// --no-journal gate (T2a command-local gate; FLIPPED by T7 — the
// journal-integration ticket named as flip owner in the T6-era pin)
// ---------------------------------------------------------------------------

describe("science joins the --no-journal accept set (T7 flip)", () => {
  it("science search --no-journal is ACCEPTED: exit 0, the run journals nothing", async () => {
    // GROUND: TASKS T7 REVISED 2026-09-10 — "`--no-journal` escape
    // (src/index.ts command-local parse)": science capabilities join
    // JournalableCapability, so `science` joins
    // ACCEPT_NO_JOURNAL_COMMANDS. This test is the T6-era rejection
    // pin UPDATED in-ticket (the "legacy tests may encode the bug"
    // rule — T6's comment named T7 as the flip owner). The full
    // escape-switch matrix (kill-switch, help exemption, entry
    // append pins) lives in tests/science-journal.test.js.
    const { descriptors, byId } = scienceFive();
    const { status, stdout, stderr } = await runMain(["science", "search", "q", "--no-journal"], {
      descriptors,
    });
    assert.equal(status, 0, "--no-journal must be accepted on science after T7");
    assert.equal(byId.openalex.calls.search.length, 1, "the search itself ran");
    assert.ok(stdout.length > 0, "data envelope still emitted");
    const err = stderr.length > 0 ? parseStderr(stderr) : undefined;
    assert.equal(
      err !== undefined && err.code === "UNSUPPORTED_OPTION",
      false,
      "never the T2a UNSUPPORTED_OPTION rejection",
    );
  });
});

// ---------------------------------------------------------------------------
// `science get` file-configured credentials (review round 4) — the
// credential-free arm resolves stored keys through the credentialed
// seam (resolveEnvFromConfig): a key persisted by `scoutline init`
// (openalex/pubmed keyed opt-in) must reach the supplier adapters.
// ---------------------------------------------------------------------------

describe("science arm applies file-configured supplier credentials (review)", () => {
  it("a stored openalex apiKey reaches the science adapters through create({ env })", async () => {
    // GROUND: review round 4 — the science arm passed the RAW env to
    // every adapter, so a key stored via the init keyed opt-in was
    // invisible to the science suppliers. The arm now resolves through
    // resolveEnvFromConfig (env wins over the file key — that seam's
    // own contract, pinned in config-store tests).
    const { descriptors, byId } = scienceFive({
      openalex: { credentialEnvVars: ["OPENALEX_API_KEY"] },
    });
    const { status } = await runMain(["science", "get", "10.1038/nature12373"], {
      descriptors,
      loadScoutlineConfig: async () => ({
        version: 1,
        providers: { openalex: { apiKey: "stored-openalex-key" } },
      }),
    });
    assert.equal(status, 0);
    const openalexEnv = byId.openalex.calls.createEnvs.at(-1);
    assert.equal(
      openalexEnv?.OPENALEX_API_KEY,
      "stored-openalex-key",
      "the file key must reach the openalex adapter env",
    );
    const arxivEnv = byId.arxiv.calls.createEnvs.at(-1);
    assert.equal(arxivEnv?.OPENALEX_API_KEY, undefined, "keyless suppliers see no injected key");
  });

  it("no config (fail-open posture) keeps the raw env untouched", async () => {
    const { descriptors, byId } = scienceFive();
    const { status } = await runMain(["science", "get", "10.1038/nature12373"], {
      descriptors,
      loadScoutlineConfig: async () => {
        throw new Error("unreadable config");
      },
    });
    assert.equal(status, 0, "a throwing loader degrades to the raw env, exit 0");
    assert.equal(byId.openalex.calls.createEnvs.at(-1)?.OPENALEX_API_KEY, undefined);
  });
});

// ---------------------------------------------------------------------------
// `science get` provider-fallback kill-switch — persisted config consult
// (T10 precedence: --no-fallback flag > SCOUTLINE_NO_FALLBACK env >
// config fallbackEnabled === false > default true). runMain injects an
// env WITHOUT SCOUTLINE_NO_FALLBACK, so these rows exercise exactly the
// config tier (env-honest per AGENTS.md).
// ---------------------------------------------------------------------------

describe("science get fallback honors persisted config.fallbackEnabled (T10 precedence)", () => {
  function openalexDownDescriptors() {
    return scienceFive({
      openalex: {
        getWork: () => {
          throw new ApiError("openalex down", 503);
        },
      },
    });
  }

  it("fallbackEnabled:false config fails STRICT on the first supplier error — no reroute, no reroute notice", async (t) => {
    // GROUND: T10 kill-switch precedence — the wizard's persisted
    // `config.fallbackEnabled === false` must be consulted by the
    // science arm (after the --no-fallback flag and the env var, both
    // absent here). The effective arm's own error surfaces; the walk
    // never advances to the next DOI-serving supplier. Pre-fix defect:
    // the config tier was ignored, so this rerouted with a notice.
    await withTempDir(t, async (dir) => {
      const { descriptors, byId } = openalexDownDescriptors();
      const { status, stdout, stderr } = await runMain(["science", "get", "10.1038/nature12373"], {
        descriptors,
        artifactsDir: dir,
        loadScoutlineConfig: async () => ({
          version: 1,
          providers: {},
          fallbackEnabled: false,
        }),
      });
      assert.equal(status, 1);
      assert.deepEqual(stdout, [], "strict failure keeps stdout empty");
      const err = parseStderr(stderr);
      assert.equal(err.code, "API_ERROR", "the effective arm's own error surfaces");
      assert.match(err.error, /openalex down/);
      assert.equal(byId.openalex.calls.get.length, 1, "first arm attempted");
      assert.equal(byId.crossref.calls.get.length, 0, "no reroute to the next supplier");
      assert.ok(!/rerouting/.test(stderr.join("")), "no reroute stderr notice");
    });
  });

  it("default config still reroutes: openalex failure falls through to crossref with the stderr notice", async (t) => {
    // GROUND: AC-5b — with fallbackEnabled absent (the always-on
    // default), the same supplier error reroutes to the next
    // DOI-serving arm in the D5 order, and the reroute notice names
    // BOTH the failed supplier and the reroute target.
    await withTempDir(t, async (dir) => {
      const { descriptors, byId } = openalexDownDescriptors();
      const { status, stdout, stderr } = await runMain(["science", "get", "10.1038/nature12373"], {
        descriptors,
        artifactsDir: dir,
        loadScoutlineConfig: async () => ({ version: 1, providers: {} }),
      });
      assert.equal(status, 0);
      assert.equal(byId.openalex.calls.get.length, 1, "first arm attempted");
      assert.equal(byId.crossref.calls.get.length, 1, "rerouted to the next DOI arm");
      const parsed = JSON.parse(stdout.join(""));
      assert.equal(parsed.title, "work-from-crossref", "the reroute target served the work");
      assert.match(stderr.join(""), /openalex get failed/);
      assert.match(stderr.join(""), /rerouting to crossref/);
    });
  });
});
