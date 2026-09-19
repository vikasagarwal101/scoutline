/**
 * Fusion config key tests — seed-24 fusion T1.
 *
 * Scope of THIS ticket: the `fusion` config key (rrf | occurrence), the
 * SCOUTLINE_FUSION env door, strict enum validation, and the resolveFusionMode
 * precedence helper. Owner rulings: NO --fusion query flag (config key + env
 * only, AC-1 pin at the bottom); env > config > default "rrf"; typos FAIL
 * at `config set` and at env resolution — never silently drop.
 *
 * Tests import from ../dist (the established convention); build first.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsMod from "node:fs/promises";
import * as osMod from "node:os";
import * as pathMod from "node:path";

import { main } from "../dist/index.js";
import { resolveFusionMode } from "../dist/lib/config-store.js";
import { mergeResults, search } from "../dist/commands/search.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import { hermeticMainDeps, getHermeticArtifactsDir } from "./helpers/hermetic-main.js";

useTempConfigDir();

// ---------------------------------------------------------------------------
// config set/get round-trip (strict enum registry row)
// ---------------------------------------------------------------------------

describe("fusion config key: set/get round-trip", () => {
  for (const value of ["rrf", "occurrence"]) {
    it(`config set fusion ${value} persists and config get renders it`, async (t) => {
      await withTempConfig(t, async (dir) => {
        const setStatus = await runMain(["config", "set", "fusion", value], dir);
        assert.strictEqual(setStatus, 0);

        const { readConfig } = await import("../dist/lib/config-store.js");
        const stored = await readConfig({
          filePath: pathMod.join(dir, "config.json"),
          onWarning: () => {},
        });
        assert.strictEqual(stored.fusion, value);

        const io = makeInvocation();
        const getStatus = await main(
          ["config", "get", "fusion"],
          await baseDeps(io.invocation, dir),
        );
        assert.strictEqual(getStatus, 0);
        // data output mode: stdout carries the JSON value, text mode the
        // `fusion → <value>` presentation — the value must appear either way.
        assert.ok(io.stdout().includes(value) || io.stdout().includes(`fusion → ${value}`));
      });
    });
  }
});

describe("fusion config key: strict enum validation", () => {
  for (const bad of ["rrff", "RRF", ""]) {
    it(`config set fusion ${JSON.stringify(bad)} throws ValidationError`, async (t) => {
      await withTempConfig(t, async (dir) => {
        const { setConfigValue } = await import("../dist/lib/config-store.js");
        await assert.rejects(
          () => setConfigValue("fusion", bad, { filePath: pathMod.join(dir, "config.json") }),
          (error) => {
            assert.strictEqual(error.name, "ValidationError");
            // House style: message names the bad value, help lists the
            // accepted enum (mirrors the routing "tavlly" precedent).
            assert.match(String(error.message) + " " + String(error.help), /rrf/);
            assert.match(String(error.help), /occurrence/);
            return true;
          },
        );
      });
    });
  }

  it("config unset fusion removes the switch; absent switch fails", async (t) => {
    await withTempConfig(t, async (dir) => {
      const filePath = pathMod.join(dir, "config.json");
      const { setConfigValue, unsetConfigValue, readConfig } =
        await import("../dist/lib/config-store.js");
      assert.strictEqual(
        (await setConfigValue("fusion", "occurrence", { filePath })).fusion,
        "occurrence",
      );
      const updated = await unsetConfigValue("fusion", { filePath });
      assert.strictEqual(updated.fusion, undefined);
      await assert.rejects(
        () => unsetConfigValue("fusion", { filePath }),
        (error) => error.name === "ValidationError" && error.message.includes("not set"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// DESIGN D1: the user-facing `config set fusion` notice names the ordering
// consequence in one plain sentence (stderr; stdout stays data-only).
// ---------------------------------------------------------------------------

describe("fusion config key: set notice names the ranking consequence (D1)", () => {
  for (const value of ["rrf", "occurrence"]) {
    it(`config set fusion ${value} emits a stderr notice naming the new ordering`, async (t) => {
      await withTempConfig(t, async (dir) => {
        const { invocation, stdout, stderr } = makeInvocation();
        const deps = await baseDeps(invocation, dir);
        const status = await main(["config", "set", "fusion", value], deps);
        assert.strictEqual(status, 0);
        assert.match(stderr(), /rank/i);
        assert.ok(stderr().includes(value), "notice names the active mode");
        // stdout stays data-only — the notice never leaks into it.
        assert.ok(!stdout().toLowerCase().includes("rank by"));
      });
    });
  }
});

// ---------------------------------------------------------------------------
// resolveFusionMode — pure precedence: env > config > "rrf" default
// ---------------------------------------------------------------------------

describe("resolveFusionMode precedence (pure, injected env+config)", () => {
  it("env SCOUTLINE_FUSION=occurrence wins over config fusion rrf", () => {
    assert.strictEqual(
      resolveFusionMode(
        { SCOUTLINE_FUSION: "occurrence" },
        { version: 1, providers: {}, fusion: "rrf" },
      ),
      "occurrence",
    );
  });

  it("env unset + config occurrence → occurrence", () => {
    assert.strictEqual(
      resolveFusionMode({}, { version: 1, providers: {}, fusion: "occurrence" }),
      "occurrence",
    );
  });

  it("both unset → default rrf", () => {
    assert.strictEqual(resolveFusionMode({}, { version: 1, providers: {} }), "rrf");
    assert.strictEqual(resolveFusionMode({}, undefined), "rrf");
  });

  it("env typo throws ValidationError (strict — never drops)", () => {
    assert.throws(
      () => resolveFusionMode({ SCOUTLINE_FUSION: "bogus" }, { version: 1, providers: {} }),
      (error) => {
        assert.strictEqual(error.name, "ValidationError");
        assert.match(String(error.help), /occurrence/);
        return true;
      },
    );
  });

  it("env empty string is treated as unset (not a ValidationError)", () => {
    assert.strictEqual(
      resolveFusionMode(
        { SCOUTLINE_FUSION: "" },
        { version: 1, providers: {}, fusion: "occurrence" },
      ),
      "occurrence",
    );
  });
});

// ---------------------------------------------------------------------------
// AC-1 pin: NO --fusion query flag — rejected at the parser, forever
// ---------------------------------------------------------------------------

describe("AC-1: search rejects --fusion and --no-fusion at parse time", () => {
  for (const flagForm of [["--fusion", "rrf"], ["--no-fusion"]]) {
    it(`search q ${flagForm.join(" ")} exits 1 pointing at the config key`, async (t) => {
      await withTempConfig(t, async (dir) => {
        const { invocation, stdout, stderr } = makeInvocation();
        const deps = hermeticMainDeps({
          invocation,
          env: { SCOUTLINE_CONFIG_DIR: dir },
          providerDescriptors: [configuredDescriptor("tavily")],
        });
        const status = await main(["search", "q", ...flagForm], deps);
        assert.strictEqual(status, 1);
        assert.ok(stderr().includes("VALIDATION_ERROR"));
        assert.match(stderr(), /--fusion/);
        assert.match(stderr(), /config set fusion|SCOUTLINE_FUSION/);
        assert.strictEqual(stdout(), "");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// T3 — RRF core + fusionScore emission (DESIGN D2)
//
// HAND-COMPUTED FIXTURE (arithmetic independently re-verified against the
// grid below; every tie the chain relies on is bit-exact in IEEE-754
// doubles because 60, 62, 93, 122, 124 are exact and 1/(2^k) subtracts
// exactly). RRF score = Σ 1/(60+rank) over every grid occurrence.
//
//   3 arms × 2 sub-queries (FormattedResult {rank,title,url,summary}):
//   tavily q1 [A r1, Q r2, F r62]        q2 [A r1, F r62, U r1]
//   exa    q1 [A r1, P r33, C r40, W r63] q2 [P r33, C r40, B r1, W r63]
//   brave  q1 [B r2, C r40, X r5]         q2 [E r1, Y r5, Q r126]
//
//   raw → toFixed(3)   occurrences / bestPos / mergedFrom
//   A {1,1,1}  3/61 = 0.049180327868852458 → "0.049"  occ3 bp1 [tavily,exa]
//   B {1,2}    1/61+1/62 = 0.032522474881015340 → "0.033" occ2 bp1 [exa,brave]
//   C {40,40,40} 3/100 = 0.030000000000000000 → "0.030" occ3 bp40 [exa,brave]
//   Q {2,126}  1/62+1/186 = 0.021505376344086023 → "0.022" occ2 bp2 [tavily,brave]
//   P {33,33}  2/93      = 0.021505376344086023 → "0.022" occ2 bp33 [exa]
//   F {62,62}  2/122     = 0.016393442622950820 → "0.016" occ2 bp62 [tavily]
//   U {1}      1/61      = 0.016393442622950820 → "0.016" occ1 bp1 [tavily]
//   E {1}      1/61      = 0.016393442622950820 → "0.016" occ1 bp1 [brave]
//   W {63,63}  2/123     = 0.016260162601626018 → "0.016" occ2 bp63 [exa]
//   X {5}      1/65      = 0.015384615384615385 → "0.015" occ1 bp5 [brave]
//   Y {5}      1/65      = 0.015384615384615385 → "0.015" occ1 bp5 [brave]
//
// RRF ORDER:      A, B, C, Q, P, F, U, E, W, X, Y
// OCCURRENCE:     A, C, B, Q, P, F, W, U, E, X, Y
// Every chain link is exercised:
//   score decides      B > C            (0.0325 vs 0.0300)
//   exact score tie → occ desc         F > U   (both 0.016393442622950820)
//   score+occ tie → bestPos asc        Q > P   (both 0.021505376344086023)
//   full tie → first-encounter         U > E ; X > Y  (stable sort, insertion order)
// W is the rounding-boundary probe: W.toFixed(3) === F.toFixed(3), so sorting
// on the ROUNDED value would tie W with F/U/E and lift W above E on occ desc.
// Raw-double sorting keeps W below all three.
//
// NOTE (fixture correction, reported to the orchestrator): the plan's hand
// table attributes U to [exa], but the grid above places U in tavily q2, so
// the grid-derived provenance is [tavily]. Ordering is unaffected (U carries
// no score/occ distinction), and the assertion below follows the GRID.
// ---------------------------------------------------------------------------

/** The hand-computed 3-arm × 2-sub-query grid (layout in the header). */
function fusionGrid() {
  const fr = (rank, title, url) => ({ rank, title, url, summary: "s" });
  return [
    {
      provider: "tavily",
      results: [
        [
          fr(1, "A", "https://e/shared-top"),
          fr(2, "Q", "https://e/bp-tie-wins"),
          fr(62, "F", "https://e/twin-late"),
        ],
        [
          fr(1, "A", "https://e/shared-top"),
          fr(62, "F", "https://e/twin-late"),
          fr(1, "U", "https://e/round-winner"),
        ],
      ],
    },
    {
      provider: "exa",
      results: [
        [
          fr(1, "A", "https://e/shared-top"),
          fr(33, "P", "https://e/bp-tie-loses"),
          fr(40, "C", "https://e/deep-many"),
          fr(63, "W", "https://e/round-loser"),
        ],
        [
          fr(33, "P", "https://e/bp-tie-loses"),
          fr(40, "C", "https://e/deep-many"),
          fr(1, "B", "https://e/high-few"),
          fr(63, "W", "https://e/round-loser"),
        ],
      ],
    },
    {
      provider: "brave",
      results: [
        [
          fr(2, "B", "https://e/high-few"),
          fr(40, "C", "https://e/deep-many"),
          fr(5, "X", "https://e/encounter-first"),
        ],
        [
          fr(1, "E", "https://e/solo-early"),
          fr(5, "Y", "https://e/encounter-second"),
          fr(126, "Q", "https://e/bp-tie-wins"),
        ],
      ],
    },
  ];
}

const EXPECTED_RRF_URLS = [
  "https://e/shared-top", // A
  "https://e/high-few", // B
  "https://e/deep-many", // C
  "https://e/bp-tie-wins", // Q
  "https://e/bp-tie-loses", // P
  "https://e/twin-late", // F
  "https://e/round-winner", // U
  "https://e/solo-early", // E
  "https://e/round-loser", // W
  "https://e/encounter-first", // X
  "https://e/encounter-second", // Y
];

const EXPECTED_RRF_SCORES = [
  "0.049",
  "0.033",
  "0.030",
  "0.022",
  "0.022",
  "0.016",
  "0.016",
  "0.016",
  "0.016",
  "0.015",
  "0.015",
];

const EXPECTED_OCCURRENCE_URLS = [
  "https://e/shared-top", // A occ3 bp1
  "https://e/deep-many", // C occ3 bp40
  "https://e/high-few", // B occ2 bp1
  "https://e/bp-tie-wins", // Q occ2 bp2
  "https://e/bp-tie-loses", // P occ2 bp33
  "https://e/twin-late", // F occ2 bp62
  "https://e/round-loser", // W occ2 bp63
  "https://e/round-winner", // U occ1 bp1
  "https://e/solo-early", // E occ1 bp1
  "https://e/encounter-first", // X occ1 bp5
  "https://e/encounter-second", // Y occ1 bp5
];

/** Per-URL occurrences + mergedFrom, keyed by the emitted url (grid-derived). */
const EXPECTED_META = {
  "https://e/shared-top": { occurrences: 3, mergedFrom: ["tavily", "exa"] },
  "https://e/high-few": { occurrences: 2, mergedFrom: ["exa", "brave"] },
  "https://e/deep-many": { occurrences: 3, mergedFrom: ["exa", "brave"] },
  "https://e/bp-tie-wins": { occurrences: 2, mergedFrom: ["tavily", "brave"] },
  "https://e/bp-tie-loses": { occurrences: 2, mergedFrom: ["exa"] },
  "https://e/twin-late": { occurrences: 2, mergedFrom: ["tavily"] },
  "https://e/round-winner": { occurrences: 1, mergedFrom: ["tavily"] },
  "https://e/solo-early": { occurrences: 1, mergedFrom: ["brave"] },
  "https://e/round-loser": { occurrences: 2, mergedFrom: ["exa"] },
  "https://e/encounter-first": { occurrences: 1, mergedFrom: ["brave"] },
  "https://e/encounter-second": { occurrences: 1, mergedFrom: ["brave"] },
};

describe("T3 mergeResults rrf: the hand-computed table", () => {
  it("emits the exact rrf order, fusionScore strings, occurrences and mergedFrom", () => {
    const merged = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    assert.deepStrictEqual(
      merged.map((r) => r.url),
      EXPECTED_RRF_URLS,
      "raw-double score desc → occurrences desc → bestPos asc → first-encounter",
    );
    assert.deepStrictEqual(
      merged.map((r) => r.fusionScore),
      EXPECTED_RRF_SCORES,
      "fusionScore strings (exactly 3 decimals, locale-independent)",
    );
    for (const row of merged) {
      const meta = EXPECTED_META[row.url];
      assert.strictEqual(row.occurrences, meta.occurrences, `occurrences for ${row.url}`);
      assert.deepStrictEqual(row.mergedFrom, meta.mergedFrom, `mergedFrom for ${row.url}`);
      assert.ok(!Object.hasOwn(row, "bestPos"), "bestPos is internal and must never leak");
    }
  });

  it("appends fusionScore after the existing fields (row 1 key order)", () => {
    const merged = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    assert.deepStrictEqual(Object.keys(merged[0]), [
      "rank",
      "title",
      "url",
      "summary",
      "occurrences",
      "mergedFrom",
      "fusionScore",
    ]);
  });

  it("occurrence mode: same grid, occ order, NO fusionScore key anywhere", () => {
    const merged = mergeResults(fusionGrid(), { mode: "occurrence", emitMergedFrom: true });
    assert.deepStrictEqual(merged.map((r) => r.url), EXPECTED_OCCURRENCE_URLS);
    for (const row of merged) {
      assert.ok(
        !Object.hasOwn(row, "fusionScore"),
        `occurrence mode emits no fusionScore (leaked on ${row.url})`,
      );
      assert.ok(!Object.hasOwn(row, "bestPos"), "bestPos is internal and must never leak");
      const meta = EXPECTED_META[row.url];
      assert.strictEqual(row.occurrences, meta.occurrences, `occurrences for ${row.url}`);
      assert.deepStrictEqual(row.mergedFrom, meta.mergedFrom, `mergedFrom for ${row.url}`);
    }
  });
});

describe("T3 tiebreak chain: each link is pinned by an adjacent pair", () => {
  it("score decides: B (1/61+1/62) outranks C (3/100)", () => {
    const merged = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    const urls = merged.map((r) => r.url);
    assert.strictEqual(urls.indexOf("https://e/high-few") + 1, urls.indexOf("https://e/deep-many"));
    assert.ok(urls.indexOf("https://e/high-few") < urls.indexOf("https://e/deep-many"));
  });

  it("exact score tie → occurrences desc: F (occ2) before U (occ1)", () => {
    const merged = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    const urls = merged.map((r) => r.url);
    const f = urls.indexOf("https://e/twin-late");
    const u = urls.indexOf("https://e/round-winner");
    assert.ok(f < u, "F and U share the raw score; occurrences desc breaks it");
    assert.strictEqual(merged[f].fusionScore, merged[u].fusionScore, "display tie");
  });

  it("score+occ tie → bestPos asc: Q (bp2) before P (bp33)", () => {
    const merged = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    const urls = merged.map((r) => r.url);
    const q = urls.indexOf("https://e/bp-tie-wins");
    const p = urls.indexOf("https://e/bp-tie-loses");
    assert.strictEqual(q + 1, p, "Q and P are adjacent");
    assert.strictEqual(merged[q].fusionScore, merged[p].fusionScore, "bit-exact raw tie");
    assert.strictEqual(merged[q].occurrences, merged[p].occurrences, "same occurrence count");
  });

  it("full tie → first-encounter: U before E, X before Y", () => {
    const merged = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    const urls = merged.map((r) => r.url);
    assert.ok(
      urls.indexOf("https://e/round-winner") < urls.indexOf("https://e/solo-early"),
      "U and E are full ties; exa q2 precedes brave q2",
    );
    assert.ok(
      urls.indexOf("https://e/encounter-first") < urls.indexOf("https://e/encounter-second"),
      "X and Y are full ties; X encountered first",
    );
  });

  it("W is the rounding-boundary probe: same display string, lower raw score, stays last", () => {
    const merged = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    const urls = merged.map((r) => r.url);
    const w = urls.indexOf("https://e/round-loser");
    // W.toFixed(3) === F/U/E display string, so a rounded-value sort would
    // lift W above E on occurrences desc. Raw-double sorting must not.
    assert.strictEqual(merged[w].fusionScore, "0.016");
    assert.ok(w > urls.indexOf("https://e/round-winner"), "W stays below U");
    assert.ok(w > urls.indexOf("https://e/solo-early"), "W stays below E");
  });
});

describe("T3 rrf determinism", () => {
  it("two runs over the same grid serialize identically (rounding included)", () => {
    const a = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    const b = mergeResults(fusionGrid(), { mode: "rrf", emitMergedFrom: true });
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  });
});

describe("T3 mode is a required caller-supplied seam", () => {
  it("an absent mode throws a plain Error (internal invariant, not ValidationError)", () => {
    assert.throws(
      () => mergeResults(fusionGrid()),
      (error) => {
        assert.strictEqual(error.name, "Error", "plain Error, never ValidationError");
        assert.match(String(error.message), /mode/i);
        return true;
      },
    );
  });

  it("an unknown mode string throws the same plain Error", () => {
    assert.throws(
      () => mergeResults(fusionGrid(), { mode: "bogus" }),
      (error) => error.name === "Error" && /mode/i.test(String(error.message)),
    );
  });
});

describe("T3 fusionScore flows through --fields (search seam) and the single-provider merge", () => {
  it("fields ['url','fusionScore'] projects exactly those two keys under rrf", async () => {
    const { result } = await runFusionSearch(
      "a|b",
      { merge: true, fields: ["url", "fusionScore"] },
      {
        a: [fr("A1", "https://e/shared", "sa"), fr("A2", "https://e/only-a", "oa")],
        b: [fr("B1", "https://e/shared", "sb")],
      },
      "rrf",
    );
    assert.ok(result.data.length > 0);
    for (const row of result.data) {
      assert.deepStrictEqual(Object.keys(row).sort(), ["fusionScore", "url"]);
      assert.match(row.fusionScore, /^\d+\.\d{3}$/, "3-decimal string survives the projection");
    }
  });

  it("without --fields the rrf rows carry fusionScore among the standard fields", async () => {
    const { result } = await runFusionSearch(
      "a|b",
      { merge: true },
      {
        a: [fr("A1", "https://e/shared", "sa"), fr("A2", "https://e/only-a", "oa")],
        b: [fr("B1", "https://e/shared", "sb")],
      },
      "rrf",
    );
    for (const row of result.data) {
      assert.ok(Object.hasOwn(row, "fusionScore"), "rf rows carry fusionScore");
      assert.match(row.fusionScore, /^\d+\.\d{3}$/);
    }
  });

  it("single seam: the same search() merge under occurrence is unchanged (no fusionScore)", async () => {
    const { result } = await runFusionSearch(
      "a|b",
      { merge: true },
      {
        a: [fr("A1", "https://e/shared", "shared A"), fr("A2", "https://e/only-a", "only A")],
        b: [fr("B1", "https://e/shared", "shared B"), fr("B2", "https://e/only-b", "only B")],
      },
      "occurrence",
    );
    assert.deepStrictEqual(result.data, [
      { rank: 1, title: "A1", url: "https://e/shared", summary: "shared A", occurrences: 2 },
      { rank: 2, title: "A2", url: "https://e/only-a", summary: "only A", occurrences: 1 },
      { rank: 3, title: "B2", url: "https://e/only-b", summary: "only B", occurrences: 1 },
    ]);
    assert.strictEqual(
      JSON.stringify(result.data),
      '[{"rank":1,"title":"A1","url":"https://e/shared","summary":"shared A","occurrences":2},' +
        '{"rank":2,"title":"A2","url":"https://e/only-a","summary":"only A","occurrences":1},' +
        '{"rank":3,"title":"B2","url":"https://e/only-b","summary":"only B","occurrences":1}]',
      "byte-identical to today's single-path output shape",
    );
  });
});

// ---------------------------------------------------------------------------
// T4 — occurrence-mode byte-identity golden (PRD AC-4)
//
// CURATION RULES — the fixture set is audited for near-dup crossings and
// curated to none, so this suite stays valid across the whole fan-out lane:
//   (a) www-SAFE: no fixture URL is the www/apex twin of another. Every host
//       is the single label `e` with a distinct path, so T2's URL-identity
//       widening can never collapse two golden rows into one.
//   (b) SHINGLE-SAFE: every title is at most two words and every summary is
//       a single whitespace-free token, so no title/summary n-gram can
//       collide across rows. The upcoming T5 title clustering has nothing
//       to merge here.
//
// CAPTURE PROCEDURE — goldens captured at main @ 9ac85fd, BEFORE any change
// on this lane (PRD AC-4 "golden bytes captured at main"), and pasted
// VERBATIM below: `git archive main packages/scoutline` into a scratch tree,
// `npm run build` there, then run the three grids through that tree's own
// `mergeResults(grid, {emitMergedFrom[, count]})` — main has NO mode option,
// so its occurrence ranking is simply the default — and record
// `JSON.stringify(...)` unchanged. The worktree dist is never touched.
// Fingerprints (sha256 of each literal, first 24 hex chars):
//   G1 f4f43be3199c0a357e4986ed
//   G2 baef9d58270ca0ef472a2acf
//   G3 595a2d86f83cbd6a00cf7019
//
// The grids also drive the A/B leg: the SAME grid under "rrf" must agree on
// every row's metadata (first-writer title/summary/url, occurrences,
// mergedFrom) and differ only by rank order plus the added fusionScore.
// ---------------------------------------------------------------------------

/** G1/G3 fixture — 3 arms × 2 sub-queries; the {1,63,40} / {4,40} shape. */
function goldenGridG1() {
  const g = (rank, title, url, summary) => ({ rank, title, url, summary });
  return [
    {
      provider: "tavily",
      results: [
        [
          g(1, "Tav A", "https://e/shared", "s-tav-q1-r1"),
          g(2, "Tav B", "https://e/only-a", "s-tav-q1-r2"),
        ],
        [g(1, "Tav C", "https://e/shared", "s-tav-q2-r1")],
      ],
    },
    {
      provider: "exa",
      results: [
        [
          g(1, "Exa D", "https://e/shared", "s-exa-q1-r1"),
          g(63, "Exa E", "https://e/high-few", "s-exa-q1-r63"),
        ],
        [],
      ],
    },
    {
      provider: "brave",
      results: [
        [
          g(2, "Brave F", "https://e/high-few", "s-brave-q1-r2"),
          g(4, "Brave G", "https://e/deep-many", "s-brave-q1-r4"),
          g(40, "Brave H", "https://e/deep-many2", "s-brave-q1-r40"),
        ],
        [g(40, "Brave I", "https://e/deep-many", "s-brave-q2-r40")],
      ],
    },
  ];
}

/** G2 fixture — one arm, no provider, two sub-queries (single-path shape). */
function goldenGridG2() {
  const g = (rank, title, url, summary) => ({ rank, title, url, summary });
  return [
    {
      results: [
        [
          g(1, "A One", "https://e/x", "s-q1-r1"),
          g(2, "B Two", "https://e/y", "s-q1-r2"),
        ],
        [
          g(1, "C Three", "https://e/x", "s-q2-r1"),
          g(3, "D Four", "https://e/z", "s-q2-r3"),
        ],
      ],
    },
  ];
}

/** main @ 9ac85fd, G1: emitMergedFrom, no count. */
const GOLDEN_G1 =
  "[{\"rank\":1,\"title\":\"Tav A\",\"url\":\"https://e/shared\",\"summary\":\"s-tav-q1-r1\",\"occurrences\":3,\"mergedFrom\":[\"tavily\",\"exa\"]}," +
  "{\"rank\":2,\"title\":\"Exa E\",\"url\":\"https://e/high-few\",\"summary\":\"s-exa-q1-r63\",\"occurrences\":2,\"mergedFrom\":[\"exa\",\"brave\"]}," +
  "{\"rank\":3,\"title\":\"Brave G\",\"url\":\"https://e/deep-many\",\"summary\":\"s-brave-q1-r4\",\"occurrences\":2,\"mergedFrom\":[\"brave\"]}," +
  "{\"rank\":4,\"title\":\"Tav B\",\"url\":\"https://e/only-a\",\"summary\":\"s-tav-q1-r2\",\"occurrences\":1,\"mergedFrom\":[\"tavily\"]}," +
  "{\"rank\":5,\"title\":\"Brave H\",\"url\":\"https://e/deep-many2\",\"summary\":\"s-brave-q1-r40\",\"occurrences\":1,\"mergedFrom\":[\"brave\"]}]";

/** main @ 9ac85fd, G2: no emitMergedFrom (single path), no count. */
const GOLDEN_G2 =
  "[{\"rank\":1,\"title\":\"A One\",\"url\":\"https://e/x\",\"summary\":\"s-q1-r1\",\"occurrences\":2}," +
  "{\"rank\":2,\"title\":\"B Two\",\"url\":\"https://e/y\",\"summary\":\"s-q1-r2\",\"occurrences\":1}," +
  "{\"rank\":3,\"title\":\"D Four\",\"url\":\"https://e/z\",\"summary\":\"s-q2-r3\",\"occurrences\":1}]";

/** main @ 9ac85fd, G3: G1's arms with emitMergedFrom + count 2. */
const GOLDEN_G3 =
  "[{\"rank\":1,\"title\":\"Tav A\",\"url\":\"https://e/shared\",\"summary\":\"s-tav-q1-r1\",\"occurrences\":3,\"mergedFrom\":[\"tavily\",\"exa\"]}," +
  "{\"rank\":2,\"title\":\"Exa E\",\"url\":\"https://e/high-few\",\"summary\":\"s-exa-q1-r63\",\"occurrences\":2,\"mergedFrom\":[\"exa\",\"brave\"]}]";

/**
 * `sameRowSet` is false for G3 only: the --count slice runs AFTER ranking, so
 * the two modes slice in different rows and only the count survives as an
 * invariant. The reordering consequence is pinned by its own test below.
 */
const GOLDEN_GRIDS = [
  {
    name: "G1 fan-out shape",
    grid: goldenGridG1,
    options: { emitMergedFrom: true },
    golden: GOLDEN_G1,
    sameRowSet: true,
  },
  { name: "G2 single-path shape", grid: goldenGridG2, options: {}, golden: GOLDEN_G2, sameRowSet: true },
  {
    name: "G3 count slice",
    grid: goldenGridG1,
    options: { emitMergedFrom: true, count: 2 },
    golden: GOLDEN_G3,
    sameRowSet: false,
  },
];

/**
 * Rows keyed by url with `rank` and `fusionScore` dropped: the two keys that
 * legitimately differ between the modes. Everything left — first-writer
 * title/summary/url, occurrences, mergedFrom — must be mode-invariant.
 */
function rowsWithoutRankOrScore(rows) {
  const map = new Map();
  for (const row of rows) {
    const { rank: _rank, fusionScore: _score, ...rest } = row;
    void _rank;
    void _score;
    map.set(row.url, rest);
  }
  return map;
}

describe("occurrence mode: byte-identity golden (AC-4)", () => {
  for (const { name, grid, options, golden, sameRowSet } of GOLDEN_GRIDS) {
    it(`${name}: occurrence output is byte-identical to the main @ 9ac85fd capture`, () => {
      const merged = mergeResults(grid(), { mode: "occurrence", ...options });
      const bytes = JSON.stringify(merged);
      assert.strictEqual(bytes, golden, `${name} drifted from the captured main bytes`);
      // Guard the guard: the literal is a real capture, not a mirror of the
      // live output — it must still parse back to the same rows.
      assert.deepStrictEqual(JSON.parse(golden), JSON.parse(bytes));
      for (const row of merged) {
        assert.ok(!Object.hasOwn(row, "fusionScore"), `occurrence emits no fusionScore (${row.url})`);
      }
    });

    it(`${name}: rrf keeps every row's metadata and the same row count`, () => {
      const occurrence = mergeResults(grid(), { mode: "occurrence", ...options });
      const rrf = mergeResults(grid(), { mode: "rrf", ...options });
      assert.strictEqual(rrf.length, occurrence.length, "row count is mode-invariant");
      if (!sameRowSet) {
        // The count slice is applied post-ranking, so a differing order
        // legitimately selects different rows. Only the two-mode
        // equivalence is asserted for this grid.
        return;
      }
      assert.deepStrictEqual(
        rowsWithoutRankOrScore(rrf),
        rowsWithoutRankOrScore(occurrence),
        "title/url/summary/occurrences/mergedFrom are mode-invariant",
      );
    });

    it(`${name}: every rrf row carries a 3-decimal fusionScore string`, () => {
      const rrf = mergeResults(grid(), { mode: "rrf", ...options });
      for (const row of rrf) {
        assert.ok(Object.hasOwn(row, "fusionScore"), `fusionScore present on ${row.url}`);
        assert.strictEqual(typeof row.fusionScore, "string", `fusionScore is a string (${row.url})`);
        assert.match(row.fusionScore, /^\d+\.\d{3}$/, `3 decimals, no locale drift (${row.url})`);
      }
    });
  }

  it("G1: the divisible pair flips — occurrence pins bestPos, rrf pins the score", () => {
    const occurrence = mergeResults(goldenGridG1(), { mode: "occurrence", emitMergedFrom: true });
    const rrf = mergeResults(goldenGridG1(), { mode: "rrf", emitMergedFrom: true });
    const urls = (rows) => rows.map((r) => r.url);
    // Same two occurrences, but Exa E carries rank 63 while Brave G carries 4:
    // occurrence ties on count and breaks on bestPos (1 < 4 → E first), rrf
    // scores 1/123 vs 2/64 (→ G first).
    assert.ok(
      urls(occurrence).indexOf("https://e/high-few") < urls(occurrence).indexOf("https://e/deep-many"),
      "occurrence: high-few (bestPos 1) outranks deep-many (bestPos 4)",
    );
    assert.ok(
      urls(rrf).indexOf("https://e/deep-many") < urls(rrf).indexOf("https://e/high-few"),
      "rrf: deep-many (two hits) outranks high-few",
    );
    assert.notDeepStrictEqual(urls(rrf), urls(occurrence), "the two modes genuinely reorder");
  });

  it("G2: the single path keeps the same order — fusionScore is the only diff", () => {
    const occurrence = mergeResults(goldenGridG2(), { mode: "occurrence" });
    const rrf = mergeResults(goldenGridG2(), { mode: "rrf" });
    assert.deepStrictEqual(
      rrf.map((r) => r.url),
      occurrence.map((r) => r.url),
      "no score inversion to exploit here: order is identical",
    );
    const stripScore = (rows) => rows.map(({ fusionScore: _f, ...rest }) => rest);
    assert.deepStrictEqual(
      stripScore(rrf),
      stripScore(occurrence),
      "stripping fusionScore makes the rows identical, rank included",
    );
  });

  it("G3: the count slice keeps the same rows but rrf ranks a different second row", () => {
    const options = { emitMergedFrom: true, count: 2 };
    const occurrence = mergeResults(goldenGridG1(), { mode: "occurrence", ...options });
    const rrf = mergeResults(goldenGridG1(), { mode: "rrf", ...options });
    assert.strictEqual(occurrence[0].url, "https://e/shared");
    assert.strictEqual(rrf[0].url, "https://e/shared");
    assert.strictEqual(occurrence[1].url, "https://e/high-few", "occurrence slices E in");
    assert.strictEqual(rrf[1].url, "https://e/deep-many", "rrf slices G in");
  });
});

// ---------------------------------------------------------------------------
// T5 — title-shingle near-duplicate clustering (DESIGN D4)
//
// BOUNDARY ARITHMETIC — every Jaccard below was re-derived EMPIRICALLY against
// the shipped implementation before being encoded (scratch script over the
// real shingle/Jaccard code), not taken from the ticket prose: distinct words
// ⇒ shingles = words − 2, and members of a Jaccard pair share every shingle
// except the appended tail.
//   exact   : 6w vs 7w  → ∩4 ∪5  → J = 4/5  = 0.8000000000000000  CLUSTERS
//   below   : 21w vs 26w → ∩19 ∪24 → J = 19/24 = 0.7916666666666666 NO
//   above   : 11w vs 13w → ∩9  ∪11 → J = 9/11 = 0.8181818181818182 CLUSTERS
//   floor   : 5w vs 5w  → 3 shingles each → gated out at J = 1.0     NO
//
// The 21w/26w pair is ALSO the short-circuit witness: |sa| = 19 < 0.8 × |sb| =
// 24, so the pair's ceiling J ≤ 19/24 < 0.8 proves it cannot merge and the
// implementation skips it without intersecting. The two rows staying separate
// is therefore evidence of BOTH the threshold comparison and the size bound.
// ---------------------------------------------------------------------------

/** n distinct words → "w1 w2 … wn" (distinct ⇒ exactly n − 2 shingles). */
function wordTitle(n) {
  return Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" ");
}

/** A clustering fixture row: one-token summary, explicit rank. */
function ranked(rank, title, url) {
  return { rank, title, url, summary: `s-${rank}` };
}

/** The US-3 syndication triple: a www/apex pair (T2 collapses it) + a copy. */
const SYNDICATED_TITLE = "one two three four five six";
const SYNDICATED_VARIANT = "one two three four five six seven";

function syndicationGrid() {
  return [
    {
      provider: "tavily",
      results: [[ranked(1, SYNDICATED_TITLE, "https://reuters.com/article-x")]],
    },
    {
      provider: "brave",
      results: [[ranked(1, SYNDICATED_TITLE, "https://www.reuters.com/article-x")]],
    },
    {
      provider: "exa",
      results: [[ranked(1, SYNDICATED_VARIANT, "https://news.yahoo.com/same-story")]],
    },
  ];
}

describe("T5 clustering: Jaccard boundary pins", () => {
  it("clusters the exact-0.80 pair (J = ∩4/∪5 = 0.80) — the inclusive threshold", () => {
    const merged = mergeResults(
      [
        {
          provider: "tavily",
          results: [[ranked(1, "one two three four five six", "https://e/six")]],
        },
        {
          provider: "exa",
          results: [[ranked(1, "one two three four five six seven", "https://e/seven")]],
        },
      ],
      { mode: "rrf", emitMergedFrom: true },
    );
    assert.strictEqual(merged.length, 1, "J = 0.80 exactly must cluster (threshold is >=");
    const row = merged[0];
    // Both rows score 1/61 with occ 1 at bestPos 1, so the D2 chain falls
    // through to first-encounter: the tavily row is the representative.
    assert.strictEqual(row.url, "https://e/six", "first-encounter representative");
    assert.strictEqual(row.title, "one two three four five six", "representative keeps its OWN title");
    assert.strictEqual(row.occurrences, 2, "occurrences sum over the cluster");
    assert.deepStrictEqual(row.mergedFrom, ["tavily", "exa"]);
    assert.deepStrictEqual(row.clusterUrls, ["https://e/seven"]);
    assert.strictEqual(row.rank, 1);
    assert.strictEqual(row.fusionScore, (1 / 61).toFixed(3), "the representative's OWN raw score");
  });

  it("leaves the 0.7917 pair apart (J = ∩19/∪24) — below threshold", () => {
    const merged = mergeResults(
      [
        { provider: "tavily", results: [[ranked(1, wordTitle(21), "https://e/a21")]] },
        { provider: "exa", results: [[ranked(1, wordTitle(26), "https://e/b26")]] },
      ],
      { mode: "rrf", emitMergedFrom: true },
    );
    // |sa| = 19 < 0.8 × |sb| = 24, so the size short-circuit skips the pair
    // before any intersection: J ≤ 19/24 < 0.8 either way.
    assert.strictEqual(merged.length, 2, "J = 19/24 ≈ 0.7917 stays two rows");
    for (const row of merged) {
      assert.strictEqual(row.occurrences, 1);
      assert.ok(!Object.hasOwn(row, "clusterUrls"), `no clusterUrls on ${row.url}`);
    }
  });

  it("clusters the 0.8182 pair (J = ∩9/∪11) — above threshold", () => {
    const merged = mergeResults(
      [
        { provider: "tavily", results: [[ranked(1, wordTitle(11), "https://e/a11")]] },
        { provider: "exa", results: [[ranked(1, wordTitle(13), "https://e/b13")]] },
      ],
      { mode: "rrf", emitMergedFrom: true },
    );
    assert.strictEqual(merged.length, 1, "J = 9/11 ≈ 0.8182 clusters");
    assert.strictEqual(merged[0].url, "https://e/a11", "first-encounter representative");
    assert.deepStrictEqual(merged[0].clusterUrls, ["https://e/b13"]);
    assert.strictEqual(merged[0].occurrences, 2);
  });

  it("never clusters a < 4-shingle title, even at J = 1.0 (identical 5-word titles)", () => {
    const fiveWords = "alpha bravo charlie delta echo"; // 5 words → 3 shingles
    const merged = mergeResults(
      [
        { provider: "tavily", results: [[ranked(1, fiveWords, "https://e/one")]] },
        { provider: "brave", results: [[ranked(1, fiveWords, "https://e/two")]] },
      ],
      { mode: "rrf", emitMergedFrom: true },
    );
    assert.strictEqual(merged.length, 2, "3 shingles is below the 4-shingle floor");
    for (const row of merged) {
      assert.ok(!Object.hasOwn(row, "clusterUrls"), `no clusterUrls on ${row.url}`);
      assert.strictEqual(row.occurrences, 1, "nothing accumulated");
    }
  });

  it("a lone row carries no clusterUrls key at all", () => {
    const merged = mergeResults(
      [
        {
          provider: "tavily",
          results: [[ranked(1, "one two three four five six", "https://e/solo")]],
        },
      ],
      { mode: "rrf", emitMergedFrom: true },
    );
    assert.strictEqual(merged.length, 1);
    assert.ok(
      !Object.hasOwn(merged[0], "clusterUrls"),
      "an unclustered row must not carry the key (absent, never undefined)",
    );
  });
});

describe("T5 clustering: the US-3 syndication triple", () => {
  it("rrf: one row, occurrences 3, url and provenance merged across both identities", () => {
    const merged = mergeResults(syndicationGrid(), { mode: "rrf", emitMergedFrom: true });
    assert.strictEqual(merged.length, 1, "T2 collapses the www/apex pair, D4 the syndicated copy");
    const row = merged[0];
    // reuters 2/61 outranks the yahoo copy's 1/61, so the reuters row (whose
    // emitted url is tavily's original non-www string) is the representative.
    assert.strictEqual(row.url, "https://reuters.com/article-x");
    assert.strictEqual(row.title, SYNDICATED_TITLE);
    assert.strictEqual(row.occurrences, 3, "2 from the www/apex collapse + 1 syndicated");
    assert.deepStrictEqual(row.mergedFrom, ["tavily", "brave", "exa"]);
    assert.deepStrictEqual(row.clusterUrls, ["https://news.yahoo.com/same-story"]);
  });

  it("occurrence: the same cluster forms with clusterUrls but no fusionScore", () => {
    const merged = mergeResults(syndicationGrid(), { mode: "occurrence", emitMergedFrom: true });
    assert.strictEqual(merged.length, 1, "the identity layer is rank-independent");
    const row = merged[0];
    assert.strictEqual(row.url, "https://reuters.com/article-x", "occ 3 wins the occurrence chain");
    assert.strictEqual(row.occurrences, 3);
    assert.deepStrictEqual(row.mergedFrom, ["tavily", "brave", "exa"]);
    assert.deepStrictEqual(row.clusterUrls, ["https://news.yahoo.com/same-story"]);
    assert.ok(!Object.hasOwn(row, "fusionScore"), "occurrence emits no fusionScore");
    assert.ok(!Object.hasOwn(row, "bestPos"), "bestPos never leaks");
  });
});

describe("T5 representative pick: the D2 chain orders the cluster", () => {
  it("a higher-scoring syndicated copy takes the representative slot over first-encounter", () => {
    // reuters: two hits at rank 63 → 2/123 ≈ 0.016260
    // yahoo  : one hit  at rank 1  → 1/61  ≈ 0.016393 (strictly higher)
    // Lexicographic order would pick "https://news.…" (n < r) — which here
    // coincides with the SCORE pick, so this fixture cannot catch that mutant;
    // the US-3 rrf fixture above is the one that inverts under it.
    const merged = mergeResults(
      [
        {
          provider: "tavily",
          results: [[ranked(63, SYNDICATED_TITLE, "https://reuters.com/article-x")]],
        },
        {
          provider: "brave",
          results: [[ranked(63, SYNDICATED_TITLE, "https://www.reuters.com/article-x")]],
        },
        {
          provider: "exa",
          results: [[ranked(1, SYNDICATED_VARIANT, "https://news.yahoo.com/same-story")]],
        },
      ],
      { mode: "rrf", emitMergedFrom: true },
    );
    assert.strictEqual(merged.length, 1);
    const row = merged[0];
    assert.strictEqual(row.url, "https://news.yahoo.com/same-story", "highest raw score wins");
    assert.strictEqual(row.title, SYNDICATED_VARIANT, "representative keeps its OWN title");
    assert.strictEqual(row.summary, "s-1", "…and its own summary");
    assert.strictEqual(row.fusionScore, (1 / 61).toFixed(3), "the representative's own score, not the sum");
    assert.strictEqual(row.occurrences, 3, "occurrences still accumulate over the cluster");
    assert.deepStrictEqual(
      row.clusterUrls,
      ["https://reuters.com/article-x"],
      "the www twin is one map row already, emitted under its first writer's url",
    );
  });

  it("accumulates occurrences and unions provenance across arms in first-encounter order", () => {
    const merged = mergeResults(
      [
        {
          provider: "tavily",
          results: [[ranked(1, SYNDICATED_TITLE, "https://e/alpha")]],
        },
        {
          provider: "exa",
          results: [[ranked(1, SYNDICATED_VARIANT, "https://e/beta")]],
        },
        {
          provider: "brave",
          results: [[ranked(1, SYNDICATED_VARIANT, "https://e/beta")]],
        },
      ],
      { mode: "rrf", emitMergedFrom: true },
    );
    assert.strictEqual(merged.length, 1);
    const row = merged[0];
    assert.strictEqual(row.url, "https://e/beta", "occ 2 (and a higher score) beats occ 1");
    assert.strictEqual(row.occurrences, 3, "1 + 2 across the two members");
    assert.deepStrictEqual(
      row.mergedFrom,
      ["tavily", "exa", "brave"],
      "union in first-encounter order: alpha's arm first, then beta's two",
    );
    assert.deepStrictEqual(row.clusterUrls, ["https://e/alpha"], "the non-representative's verbatim url");
  });
});

describe("T5 clustering determinism", () => {
  /** A three-member cluster: one title across three distinct canonical URLs. */
  function tripleGrid() {
    return [
      { provider: "tavily", results: [[ranked(1, SYNDICATED_TITLE, "https://e/a")]] },
      { provider: "exa", results: [[ranked(1, SYNDICATED_TITLE, "https://e/b")]] },
      { provider: "brave", results: [[ranked(1, SYNDICATED_TITLE, "https://e/c")]] },
    ];
  }

  it("lists every non-representative url in first-encounter order", () => {
    const merged = mergeResults(tripleGrid(), { mode: "rrf", emitMergedFrom: true });
    assert.strictEqual(merged.length, 1);
    const row = merged[0];
    assert.strictEqual(row.url, "https://e/a", "full tie → first-encounter representative");
    assert.deepStrictEqual(row.clusterUrls, ["https://e/b", "https://e/c"]);
    assert.deepStrictEqual(row.mergedFrom, ["tavily", "exa", "brave"]);
    assert.strictEqual(row.occurrences, 3);
  });

  it("two runs over the same grid serialize identically (clusterUrls order included)", () => {
    const a = mergeResults(tripleGrid(), { mode: "rrf", emitMergedFrom: true });
    const b = mergeResults(tripleGrid(), { mode: "rrf", emitMergedFrom: true });
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
    const c = mergeResults(syndicationGrid(), { mode: "occurrence", emitMergedFrom: true });
    const d = mergeResults(syndicationGrid(), { mode: "occurrence", emitMergedFrom: true });
    assert.strictEqual(JSON.stringify(c), JSON.stringify(d));
  });
});

// --- T3 local helpers (mirroring tests/search-fanout.test.js:332) ---------

/** Shorthand for a single formatted result (search-fanout.test.js `src`). */
function fr(title, url, summary) {
  return { rank: 1, title, url, summary };
}

/** Build a fake SearchCapability returning scripted results per query. */
function makeFakeCapability(resultsByQuery) {
  const invokes = [];
  const capability = {
    validate() {},
    cacheIdentity(request) {
      return {
        provider: "zai",
        capability: "search",
        credentialFingerprint: "fake-fingerprint",
        request,
        legacyCandidates: [],
      };
    },
    async invoke(request) {
      invokes.push(request);
      return resultsByQuery[request.query] ?? [];
    },
  };
  return { capability, invokes };
}

/** Drive the exported search() with an injected fusion mode. */
async function runFusionSearch(query, options, resultsByQuery, fusionMode) {
  const fake = makeFakeCapability(resultsByQuery);
  const store = new Map();
  const notices = [];
  const context = {
    stdinIsTTY: false,
    readStdin: async () => "",
    notice: (m) => notices.push(m),
  };
  const result = await search(
    query,
    options,
    {
      capability: fake.capability,
      cache: {
        async get(key) {
          return store.has(key) ? store.get(key) : null;
        },
        async set(key, value) {
          store.set(key, value);
        },
      },
      sleep: async () => {},
      random: () => 0.5,
      fusionMode,
    },
    context,
  );
  return { result, fake, notices };
}

// ---------------------------------------------------------------------------
// Local helpers (mirroring tests/config-command.test.js + search-fanout patterns)
// ---------------------------------------------------------------------------

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    invocation: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

async function baseDeps(invocation, dir) {
  return {
    invocation,
    env: { SCOUTLINE_CONFIG_DIR: dir },
  };
}

async function runMain(args, dir) {
  const { invocation } = makeInvocation();
  return main(args, await baseDeps(invocation, dir));
}

async function withTempConfig(t, run) {
  const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "scoutline-fusion-"));
  const savedConfigDir = process.env.SCOUTLINE_CONFIG_DIR;
  process.env.SCOUTLINE_CONFIG_DIR = dir;
  t.after(async () => {
    if (savedConfigDir === undefined) delete process.env.SCOUTLINE_CONFIG_DIR;
    else process.env.SCOUTLINE_CONFIG_DIR = savedConfigDir;
    await fsMod.rm(dir, { recursive: true, force: true });
  });
  await run(dir);
}

/** Minimal configured search descriptor (no transport touched on a parse error). */
function configuredDescriptor(id) {
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    create: () => ({ id, search: {} }),
  };
}
