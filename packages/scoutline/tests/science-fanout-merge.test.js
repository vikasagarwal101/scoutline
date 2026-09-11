/**
 * Science fan-out merge — T10 RED tests (TASKS T10; DESIGN D5 audit
 * round 2 correction + fan-out bullets; PRD AC-1, AC-3, AC-5b, AC-11,
 * AC-12c).
 *
 * GROUND map:
 *   - TASKS T10: "NO-PIN DEFAULT fan-out across all enabled science
 *     suppliers (AC-1's mode), single `--provider <id>` pin, and
 *     `--provider all`. Parallel arms, DOI-dedup merge, field-wise
 *     union enrichment (D12), one journal entry."
 *   - TASKS T10 / DESIGN D5 correction: dedup identity is
 *     identifiers.doi FIRST, normalized-url fallback — NOT the search
 *     command's canonical-URL merge; union enrichment (D12) is NEW
 *     science-executor logic. First-supplier-wins merge preference
 *     follows the D5 openalex-first arm order.
 *   - TASKS T10 / PRD AC-1 + AC-3 + D5 controls-vs-fan-out ruling:
 *     control-rejecting arms are EXCLUDED from the arm set at
 *     validation with a per-arm stderr notice naming supplier+control
 *     (visible narrowing, never silent drop); the run proceeds on the
 *     remaining arms; all-reject → UNSUPPORTED_OPTION.
 *   - TASKS T10 / PRD AC-5b: `science get` fallback — unresolved
 *     identifier reroutes to the next D5-priority supplier with a
 *     stderr note; `--no-fallback` fails strict. Control rejection is
 *     NOT fallback (pinned-reject stays in science-conformance).
 *   - PRD AC-11 + AC-12c: a fan-out `science search` run records ONE
 *     journal entry (merged identity) regardless of arm count; the
 *     fanout provider routing shape is {mode:"fanout", arms} (the
 *     search-command fan-out journal precedent, journal.test.js
 *     "must-fix 3").
 *
 * Interim flip ownership: the interim single-arm pins in
 * science-command.test.js / science-journal.test.js name T10 as flip
 * owner — updated in the same diff as these new pins, never deleted.
 *
 * Hermeticity: main()-driven via hermeticMainDeps (fake science
 * descriptors recording every capability invoke, isolated
 * SCOUTLINE_ARTIFACTS_DIR for journal reads). Tests import ../dist/
 * ... — verification order is build, then test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../dist/index.js";
import { ApiError, UnsupportedOptionError } from "../dist/lib/errors.js";
import { readLog } from "../dist/lib/artifacts.js";
import { skeletonContentHash } from "../dist/lib/journal.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

/**
 * The D5 openalex-first ARM order (executor-side ordering rule, NOT
 * the D2/PROVIDER_IDS registry listing). Test-side literal (T5b
 * discipline): a registry-order leak into the fan-out arm walk (arxiv
 * first) fails the independent literal.
 */
const D5_ARM_ORDER = ["openalex", "arxiv", "crossref", "pubmed", "europepmc"];

/** DOI-get try order (D6/D10 Q3): DOI → all but arxiv, D5 arm order. */
const DOI_GET_ARM_ORDER = ["openalex", "crossref", "pubmed", "europepmc"];

/**
 * Fake science supplier double. `rejects` throws
 * UnsupportedOptionError(id, "science.search", control) from validate
 * exactly like the production adapters (arxiv rejects all four
 * controls); `failGet` makes get invoke throw ApiError (the reroute
 * trigger); `searchWorks`/`getWork` shape results.
 */
function makeScienceDescriptor(id, opts = {}) {
  const calls = { search: [], get: [] };
  const descriptor = {
    id,
    isConfigured: (_env, capabilityId) =>
      opts.configured === undefined ? true : opts.configured(capabilityId),
    capabilities: () => new Set(opts.caps ?? ["science.search", "science.get"]),
    create() {
      return {
        id,
        science: {
          search: {
            validate(request) {
              for (const control of opts.rejects ?? []) {
                if (request.controls?.[control] !== undefined) {
                  throw new UnsupportedOptionError(id, "science.search", control);
                }
              }
            },
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
              if (opts.failGet === true) {
                throw new ApiError(`${id} get failed`, 503);
              }
              return (
                opts.getWork?.(request) ?? {
                  title: `work-from-${id}`,
                  url: `https://example.org/${id}/work`,
                }
              );
            },
          },
        },
      };
    },
    credentialEnvVars: [],
  };
  return { descriptor, calls };
}

/** All five science suppliers, keyed by id for per-arm assertions. */
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

async function runMain(argv, { descriptors, artifactsDir } = {}) {
  const { adapter, stdout, stderr } = makeInvocation();
  const status = await main(argv, {
    ...hermeticMainDeps({
      invocation: adapter,
      env: {
        ...(artifactsDir !== undefined ? { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } : {}),
      },
      ...(descriptors !== undefined ? { providerDescriptors: descriptors } : {}),
    }),
  });
  return { status, stdout, stderr };
}

/**
 * Extract the structured error envelope from mixed stderr (exclusion
 * notices precede the JSON envelope on the failure path — parse each
 * write, keep the one with a `code`).
 */
function parseErrorEnvelope(stderr) {
  for (const chunk of stderr) {
    try {
      const parsed = JSON.parse(chunk);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.code === "string") {
        return parsed;
      }
    } catch {
      // a plain-text notice chunk — skip
    }
  }
  assert.fail(`no error envelope in stderr: ${JSON.stringify(stderr)}`);
}

/** Order-insensitive titles of a merged result array. */
function sortedTitles(rows) {
  return rows.map((w) => w.title).sort();
}

/** Order-insensitive url+title skeleton rows. */
function sortedSkeletonRows(results) {
  return [...results].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

// ---------------------------------------------------------------------------
// AC-1 default fan-out + --provider all (TASKS T10 selection grammar)
// ---------------------------------------------------------------------------

describe("T10 fan-out default: no pin → every enabled science supplier runs, results merged", () => {
  it("AC-1 default: all five arms invoke once each; stdout is ONE merged array of all five arms' works; no stderr noise", async () => {
    // GROUND: TASKS T10 "NO-PIN DEFAULT fan-out across all enabled
    // science suppliers (AC-1's `science search "graph transformers"`
    // mode)"; DESIGN D5 "Default (no pin): fan-out across all enabled
    // science suppliers (seed 18 owner ruling #3)". Distinct urls per
    // arm → no dedup interference; the pin is the arm SET + merged
    // envelope, order-insensitive (output row order is not spec'd).
    const { descriptors, byId } = scienceFive();
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "graph transformers"],
      { descriptors },
    );
    assert.equal(status, 0);
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.search.length, 1, `${id} invoked exactly once`);
    }
    assert.equal(stdout.length, 1, "one stdout value — data-only contract");
    const parsed = JSON.parse(stdout.join(""));
    assert.ok(Array.isArray(parsed), "merged data payload is an array");
    assert.equal(parsed.length, 5, "all five arms' works merged into one set");
    assert.deepEqual(
      sortedTitles(parsed),
      ["search-from-arxiv", "search-from-crossref", "search-from-europepmc", "search-from-openalex", "search-from-pubmed"],
      "merged set = union of every arm's rows",
    );
    assert.deepEqual(stderr, [], "no exclusions → no stderr notices");
  });

  it("--provider all pins the explicit fan-out: all five arms invoke, one merged array", async () => {
    // GROUND: TASKS T10 "`--provider all`" (D5 "Fan-out: `--provider
    // all` style"); the interim T6 pin treated `all` as no-pin
    // single-arm — T10 makes it the real fan-out.
    const { descriptors, byId } = scienceFive();
    const { status, stdout } = await runMain(
      ["science", "search", "q", "--provider", "all"],
      { descriptors },
    );
    assert.equal(status, 0);
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.search.length, 1, `${id} invoked in the pinned fan-out`);
    }
    assert.equal(JSON.parse(stdout.join("")).length, 5);
  });

  it("fan-out skips non-enabled arms and proceeds on the rest (openalex unconfigured → four arms merge)", async () => {
    // GROUND: D5 "fan-out across all ENABLED science suppliers" —
    // enabled = configured+capable (the resolver's eligibility pair);
    // a disabled arm narrows the set, never fails the run.
    const { descriptors, byId } = scienceFive({
      openalex: { configured: () => false },
    });
    const { status, stdout } = await runMain(["science", "search", "q"], {
      descriptors,
    });
    assert.equal(status, 0);
    assert.equal(byId.openalex.calls.search.length, 0, "unconfigured arm excluded");
    for (const id of ["arxiv", "crossref", "pubmed", "europepmc"]) {
      assert.equal(byId[id].calls.search.length, 1, `${id} still runs`);
    }
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.length, 4);
    assert.deepEqual(
      sortedTitles(parsed),
      ["search-from-arxiv", "search-from-crossref", "search-from-europepmc", "search-from-pubmed"],
    );
  });
});

// ---------------------------------------------------------------------------
// DOI-dedup merge identity + D12 union enrichment (DESIGN D5
// correction; TASKS T10 "dedup identity … and union enrichment are NEW
// logic here")
// ---------------------------------------------------------------------------

describe("T10 merge: DOI-first dedup identity", () => {
  it("the same DOI across two arms collapses to ONE row; the D5 first arm's body wins", async () => {
    // GROUND: TASKS T10 "DOI-dedup merge"; DESIGN D5 "science dedup
    // identity (identifiers.doi first …)"; "OpenAlex-first … governs
    // first-supplier-wins merge preference" — the duplicate's survivor
    // is the earlier arm's work (openalex #1), not the later (crossref).
    const { descriptors, byId } = scienceFive({
      openalex: {
        searchWorks: () => [
          { title: "Canonical", url: "https://example.org/oa", identifiers: { doi: "10.1234/abc" } },
        ],
      },
      crossref: {
        searchWorks: () => [
          { title: "Crossref copy", url: "https://example.org/cr", identifiers: { doi: "10.1234/abc" } },
        ],
      },
      arxiv: { searchWorks: () => [] },
      pubmed: { searchWorks: () => [] },
      europepmc: { searchWorks: () => [] },
    });
    const { status, stdout } = await runMain(["science", "search", "q"], {
      descriptors,
    });
    assert.equal(status, 0);
    assert.equal(byId.crossref.calls.search.length, 1, "the duplicate-carrying arm ran");
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.length, 1, "same-DOI works across arms collapse to one row");
    assert.equal(parsed[0].title, "Canonical", "first-arm (D5 openalex-first) body wins");
    assert.equal(parsed[0].url, "https://example.org/oa");
  });

  it("identifier subfields keep the FIRST arm's value on conflict (review round 6)", async () => {
    // GROUND: D12 field-wise union fills MISSING subfields — a later
    // arm's conflicting pmid must not overwrite the first arm's
    // (first-arm-wins governs identifiers like every other field),
    // while genuinely-missing subfields ARE filled.
    const { descriptors, byId } = scienceFive({
      openalex: {
        searchWorks: () => [
          { title: "Canonical", url: "https://example.org/oa", identifiers: { doi: "10.1234/abc", pmid: "11111111" } },
        ],
      },
      crossref: {
        searchWorks: () => [
          { title: "Crossref copy", url: "https://example.org/cr", identifiers: { doi: "10.1234/abc", pmid: "99999999" } },
        ],
      },
      arxiv: { searchWorks: () => [] },
      pubmed: { searchWorks: () => [] },
      europepmc: { searchWorks: () => [] },
    });
    void byId;
    const { status, stdout } = await runMain(["science", "search", "dedup"], {
      descriptors,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].identifiers.pmid, "11111111", "first arm's pmid survives the merge");
  });

  it("DOI identity applies even when urls differ (doi beats url as identity)", async () => {
    // GROUND: DESIGN D5 — dedup identity is identifiers.doi FIRST;
    // two works sharing a DOI but NOT a url still dedup. The inverse
    // mutation (url-only identity) leaves two rows and fails here.
    const { descriptors } = scienceFive({
      openalex: {
        searchWorks: () => [
          { title: "OA", url: "https://example.org/oa-only", identifiers: { doi: "10.9999/x" } },
        ],
      },
      crossref: {
        searchWorks: () => [
          { title: "CR", url: "https://example.org/cr-only", identifiers: { doi: "10.9999/x" } },
        ],
      },
      arxiv: { searchWorks: () => [] },
      pubmed: { searchWorks: () => [] },
      europepmc: { searchWorks: () => [] },
    });
    const { status, stdout } = await runMain(["science", "search", "q"], {
      descriptors,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.length, 1, "DOI identity dedups despite differing urls");
  });

  it("normalized-url fallback dedups DOI-less duplicates", async () => {
    // GROUND: DESIGN D5 "identifiers.doi first, NORMALIZED URL
    // fallback" — works without identifiers dedup on the url identity.
    // Exact-url twins pinned (the floor); further url normalization
    // (trailing-slash/query trimming) is GREEN's latitude.
    const { descriptors } = scienceFive({
      openalex: {
        searchWorks: () => [{ title: "OA url twin", url: "https://example.org/same-doc" }],
      },
      arxiv: {
        searchWorks: () => [{ title: "arXiv url twin", url: "https://example.org/same-doc" }],
      },
      crossref: { searchWorks: () => [] },
      pubmed: { searchWorks: () => [] },
      europepmc: { searchWorks: () => [] },
    });
    const { status, stdout } = await runMain(["science", "search", "q"], {
      descriptors,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.length, 1, "identical urls without DOIs collapse to one row");
    assert.equal(parsed[0].title, "OA url twin", "first-arm body wins on url identity too");
  });
});

describe("T10 merge: D12 field-wise union enrichment", () => {
  it("duplicate rows UNION their fields: later-arm-only fields fill the first-arm body; identifiers subfields merge; conflicting scalars keep the first arm's value", async () => {
    // GROUND: TASKS T10 "field-wise union enrichment (D12)"; DESIGN D5
    // "first-supplier-wins merge preference" + "duplicates identified,
    // fields unioned, NOTHING HIDDEN". openalex (arm #1) carries
    // title/url/year/summary/authors; crossref (arm #3) carries
    // venue/citationCount/pdfUrl + identifiers.pmid — the merged row
    // keeps openalex's conflicting year (2017, not 2019) AND surfaces
    // every crossref-only field.
    const { descriptors } = scienceFive({
      openalex: {
        searchWorks: () => [
          {
            title: "Union winner",
            url: "https://example.org/w",
            identifiers: { doi: "10.1234/uni" },
            year: 2017,
            summary: "abstract from openalex",
            authors: ["Alpha", "Beta"],
          },
        ],
      },
      crossref: {
        searchWorks: () => [
          {
            title: "Crossref twin",
            url: "https://example.org/c",
            identifiers: { doi: "10.1234/uni", pmid: "12345678" },
            year: 2019,
            venue: "Nature",
            citationCount: 42,
            pdfUrl: "https://example.org/w.pdf",
          },
        ],
      },
      arxiv: { searchWorks: () => [] },
      pubmed: { searchWorks: () => [] },
      europepmc: { searchWorks: () => [] },
    });
    const { status, stdout } = await runMain(["science", "search", "q"], {
      descriptors,
    });
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.length, 1);
    const row = parsed[0];
    assert.equal(row.title, "Union winner", "first-arm identity fields win");
    assert.equal(row.url, "https://example.org/w");
    assert.equal(row.year, 2017, "conflicting scalar: D5 first-supplier preference");
    assert.equal(row.summary, "abstract from openalex", "first-arm field preserved");
    assert.deepEqual(row.authors, ["Alpha", "Beta"]);
    assert.equal(row.venue, "Nature", "later-arm-only field FILLS the merged row (nothing hidden)");
    assert.equal(row.citationCount, 42, "later-arm-only field fills");
    assert.equal(row.pdfUrl, "https://example.org/w.pdf", "later-arm-only field fills");
    assert.deepEqual(
      row.identifiers,
      { doi: "10.1234/uni", pmid: "12345678" },
      "identifiers union subfield-wise",
    );
  });
});

// ---------------------------------------------------------------------------
// One journal entry per fan-out run (PRD AC-11 + AC-12c)
// ---------------------------------------------------------------------------

describe("T10 fan-out journals ONE entry with fanout routing (AC-11/AC-12c)", () => {
  it("a five-arm default search appends EXACTLY ONE journal entry: capability science, provider {mode:\"fanout\", arms}, merged skeleton", async () => {
    // GROUND: TASKS T10 "one journal entry"; PRD AC-12c "if fan-out
    // merges results from several suppliers, ONE entry regardless of
    // arm count"; AC-11 "fan-out science search records ONE journal
    // entry (merged identity) — not five per-supplier entries". The
    // fanout routing shape is the must-fix-3 union (search fan-out
    // precedent, journal.test.js) — no silent skip of the arm set.
    const dir = mkdtempSync(join(tmpdir(), "scoutline-fanout-jr-"));
    try {
      const { descriptors } = scienceFive();
      const { status, stderr } = await runMain(
        ["science", "search", "graph transformers"],
        { descriptors, artifactsDir: dir },
      );
      assert.equal(status, 0, `stderr=${JSON.stringify(stderr)}`);
      const { log, notice } = await readLog(dir);
      assert.strictEqual(notice, undefined, "no corruption notice");
      const entries = log.entries.filter((e) => e.kind === "journal");
      assert.strictEqual(entries.length, 1, "ONE entry regardless of arm count (AC-12c)");
      const entry = entries[0];
      assert.strictEqual(entry.repeatOf, undefined, "full entry, live fan-out run");
      assert.strictEqual(entry.capability, "science");
      assert.strictEqual(entry.query, "graph transformers", "user-visible query (AC-12)");
      assert.deepStrictEqual(
        entry.provider,
        { mode: "fanout", arms: [...D5_ARM_ORDER] },
        "fanout routing shape: ordered arm set, no single effective",
      );
      // Merged identity skeleton: url+title of every MERGED row (5
      // distinct works — one per arm), order-insensitive (merge order
      // is not spec'd; the SET is).
      assert.equal(entry.skeleton.results.length, 5, "skeleton = the merged result set");
      assert.deepEqual(
        sortedSkeletonRows(entry.skeleton.results),
        sortedSkeletonRows(
          D5_ARM_ORDER.map((id) => ({ url: `https://example.org/${id}`, title: `search-from-${id}` })),
        ),
      );
      assert.strictEqual(entry.contentHash, skeletonContentHash(entry.skeleton));
      assert.ok(typeof entry.cacheKey === "string" && entry.cacheKey.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Controls vs fan-out (DESIGN D5 ruling; PRD AC-1/AC-3)
// ---------------------------------------------------------------------------

describe("T10 controls vs fan-out: rejecting arms excluded with per-arm stderr notice", () => {
  it("arxiv rejects --author → excluded at validation with a stderr notice naming arxiv+author; the run proceeds merged on the four accepting arms", async () => {
    // GROUND: PRD AC-1 verbatim scenario ("returns merged results from
    // the arms that accept author+year … with one stderr notice for
    // excluded arxiv arm") + AC-3 ("a rejecting ARM is excluded at
    // validation with a per-arm stderr notice naming supplier+control;
    // visible narrowing — never a silent drop"). The rejecting arm's
    // invoke NEVER runs; accepting arms each run once.
    const { descriptors, byId } = scienceFive({
      arxiv: { rejects: ["author", "year", "venue", "type"] },
    });
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "attention mechanism", "--author", "Vaswani", "--year", "2018:2022"],
      { descriptors },
    );
    assert.equal(status, 0, "the run proceeds on the accepting arms");
    assert.equal(byId.arxiv.calls.search.length, 0, "rejecting arm excluded — invoke never runs");
    for (const id of ["openalex", "crossref", "pubmed", "europepmc"]) {
      assert.equal(byId[id].calls.search.length, 1, `${id} accepting arm ran`);
    }
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.length, 4, "merged output from the four accepting arms");
    assert.ok(!sortedTitles(parsed).includes("search-from-arxiv"), "no arxiv rows");
    const joined = stderr.join("");
    assert.match(joined, /arxiv/, "notice names the excluded supplier");
    assert.match(joined, /author/, "notice names the rejected control");
    // Count pin (fix-round teeth): exactly ONE notice for the excluded
    // arxiv arm (PRD AC-1 verbatim) — the loop that printed one notice
    // per REQUESTED control (author AND year) misattributed controls
    // arxiv's error never named; this count is what kills it.
    const exclusionNotices = stderr.filter((l) =>
      l.includes("excluded from this science fan-out"),
    );
    assert.equal(
      exclusionNotices.length,
      1,
      `exactly one exclusion notice (got ${JSON.stringify(exclusionNotices)})`,
    );
    assert.match(exclusionNotices[0], /does not support author/);
  });

  it("a supplier rejecting ONE control of a multi-control request gets exactly that control named — no false notices for controls it accepts", async () => {
    // GROUND: PRD AC-3 "per-arm stderr notice naming supplier+control"
    // — the notice must name the control the arm's
    // UnsupportedOptionError actually carried, never the full
    // requested set. openalex rejects only --venue here; the request
    // also carries --author and --year, which openalex ACCEPTS — any
    // notice naming author/year is a misattribution defect.
    const { descriptors, byId } = scienceFive({
      openalex: { rejects: ["venue"] },
    });
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "q", "--author", "Vaswani", "--year", "2020", "--venue", "Nature"],
      { descriptors },
    );
    assert.equal(status, 0, "four accepting arms serve the run");
    assert.equal(byId.openalex.calls.search.length, 0, "venue-rejecting arm excluded");
    assert.equal(JSON.parse(stdout.join("")).length, 4, "merged rows from accepting arms only");
    const exclusionNotices = stderr.filter((l) =>
      l.includes("excluded from this science fan-out"),
    );
    assert.equal(exclusionNotices.length, 1, "exactly one exclusion notice");
    assert.match(exclusionNotices[0], /openalex/, "names the rejecting supplier");
    assert.match(exclusionNotices[0], /does not support venue/, "names the rejected control");
    assert.doesNotMatch(exclusionNotices[0], /author/, "no false author notice");
    assert.doesNotMatch(exclusionNotices[0], /\byear\b/, "no false year notice");
  });

  it("empty arm set with NO controls on the request is an availability ValidationError — never UNSUPPORTED_OPTION", async () => {
    // GROUND: AGENTS.md stderr JSON error contract — the error's
    // code/message must describe the actual failure class. A pin to an
    // unconfigured supplier with no controls to reject is an
    // AVAILABILITY failure; the old fall-through threw
    // UnsupportedOptionError('science', …, 'request') — nonsense
    // ("does not support option request") and the wrong error class.
    const { descriptors, byId } = scienceFive({
      crossref: { configured: () => false },
    });
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "q", "--provider", "crossref"],
      { descriptors },
    );
    assert.equal(status, 1);
    assert.deepEqual(stdout, [], "data-only stdout contract");
    assert.equal(byId.crossref.calls.search.length, 0, "unconfigured arm never invokes");
    const err = parseErrorEnvelope(stderr);
    assert.equal(err.code, "VALIDATION_ERROR", "availability failure is a validation error");
    assert.match(err.error, /crossref/, "names the pinned supplier");
    assert.match(err.error, /not configured\/capable for science\.search/);
    assert.match(err.help ?? "", /Science suppliers/, "help line lists the suppliers");
  });

  it("every enabled supplier rejects the request's controls → UNSUPPORTED_OPTION, zero invokes, empty stdout", async () => {
    // GROUND: DESIGN D5 "the command fails loud with
    // UNSUPPORTED_OPTION only when NO enabled science supplier accepts
    // the request's full control set" — all-reject empties the arm
    // set at validation.
    const { descriptors, byId } = scienceFive(
      Object.fromEntries(D5_ARM_ORDER.map((id) => [id, { rejects: ["author"] }])),
    );
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "q", "--author", "Nobody"],
      { descriptors },
    );
    assert.equal(status, 1);
    assert.deepEqual(stdout, [], "data-only stdout — nothing on stdout");
    for (const id of D5_ARM_ORDER) {
      assert.equal(byId[id].calls.search.length, 0, `${id} invoke never runs`);
    }
    const err = parseErrorEnvelope(stderr);
    assert.equal(err.code, "UNSUPPORTED_OPTION", "all-reject fails UNSUPPORTED_OPTION");
  });

  it("an arm failing at INVOKE time is disclosed on stderr — partial fan-out is visible narrowing, never a silent drop", async () => {
    // GROUND: DESIGN D5 visible-narrowing principle ("visible
    // narrowing — never silent drop") + AGENTS.md disclosure posture;
    // search-command precedent armNotice (search.ts) discloses every
    // dropped arm. Previously a mid-fan-out invoke failure (ApiError/
    // network) was silently dropped when other arms succeeded — the
    // user believed all five suppliers served. The single-arm pin
    // failure path (zero works → firstRejected verbatim) stays
    // pinned in science-command.test.js.
    const { descriptors, byId } = scienceFive({
      crossref: {
        searchWorks: () => {
          throw new ApiError("crossref exploded", 503);
        },
      },
    });
    const { status, stdout, stderr } = await runMain(
      ["science", "search", "q"],
      { descriptors },
    );
    assert.equal(status, 0, "four serving arms keep the run green");
    assert.equal(byId.crossref.calls.search.length, 1, "the failing arm was attempted");
    assert.equal(JSON.parse(stdout.join("")).length, 4, "merged rows from surviving arms");
    const joined = stderr.join("");
    assert.match(joined, /crossref/, "the failure notice names the dropped arm");
    assert.match(
      joined,
      /crossref arm failed .*dropped from this fan-out/,
      "notice shape: arm failed (message) — dropped from this fan-out",
    );
    assert.match(joined, /crossref exploded/, "the failure message rides the notice");
  });
});

// ---------------------------------------------------------------------------
// science get fallback (TASKS T10; PRD AC-5b)
// ---------------------------------------------------------------------------

describe("T10 science get fallback: reroute with stderr note; --no-fallback strict", () => {
  it("openalex get failure reroutes to the next DOI-serving supplier (crossref) with a stderr note; exit 0", async () => {
    // GROUND: TASKS T10 "`science get` fallback: unresolved identifier
    // reroutes to the next D5-priority supplier with a stderr note";
    // PRD AC-5b "OpenAlex failure reroutes to next configured science
    // supplier with a stderr notice". DOI get arm order: openalex →
    // crossref → pubmed → europepmc (D6/D10 Q3 membership).
    const { descriptors, byId } = scienceFive({
      openalex: { failGet: true },
    });
    const { status, stdout, stderr } = await runMain(
      ["science", "get", "10.1038/nature12373"],
      { descriptors },
    );
    assert.equal(status, 0, "reroute succeeds");
    assert.equal(byId.openalex.calls.get.length, 1, "the failed arm attempted first");
    assert.equal(byId.crossref.calls.get.length, 1, "rerouted to crossref (DOI arm #2)");
    assert.equal(byId.pubmed.calls.get.length, 0, "pubmed not needed");
    assert.equal(byId.europepmc.calls.get.length, 0, "europepmc not needed");
    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.title, "work-from-crossref", "the rerouted supplier's work serves");
    const joined = stderr.join("");
    assert.match(joined, /openalex/, "the stderr note names the failed supplier");
    assert.match(joined, /crossref/, "the stderr note names the reroute target");
  });

  it("the reroute walks the DOI arm order until an arm serves (openalex + crossref fail → pubmed serves)", async () => {
    // GROUND: TASKS T10 "reroutes to the NEXT D5-priority supplier" —
    // the walk is ordered, not random: two failures chain to arm #3.
    const { descriptors, byId } = scienceFive({
      openalex: { failGet: true },
      crossref: { failGet: true },
    });
    const { status, stdout } = await runMain(
      ["science", "get", "10.1038/nature12373"],
      { descriptors },
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout.join("")).title, "work-from-pubmed");
    assert.equal(byId.pubmed.calls.get.length, 1);
    assert.equal(byId.europepmc.calls.get.length, 0, "earlier arm served — walk stops");
  });

  it("--no-fallback fails strict: the openalex failure surfaces as the error, no reroute attempt", async () => {
    // GROUND: TASKS T10 "`--no-fallback` fails strict (AC-5b)" / PRD
    // AC-5b "`--no-fallback` fails loud. Confirmed in tests." Paired
    // negative control of the reroute pin above: same fixture, kill
    // switch on → the effective arm's own error, zero downstream
    // invokes. (Hold-style pin pre-T10 too — the interim single
    // attempt already fails this way; its teeth guard the GREEN
    // fallback implementation.)
    const { descriptors, byId } = scienceFive({
      openalex: { failGet: true },
    });
    const { status, stdout, stderr } = await runMain(
      ["science", "get", "10.1038/nature12373", "--no-fallback"],
      { descriptors },
    );
    assert.equal(status, 1, "strict fail, exit 1");
    assert.deepEqual(stdout, []);
    assert.equal(byId.crossref.calls.get.length, 0, "no reroute under --no-fallback");
    assert.equal(byId.pubmed.calls.get.length, 0);
    const err = parseErrorEnvelope(stderr);
    assert.equal(err.code, "API_ERROR");
    assert.match(err.error, /openalex/, "the failed arm's own error surfaces");
    assert.doesNotMatch(err.error, /crossref/, "no reroute target in the error");
  });
});
