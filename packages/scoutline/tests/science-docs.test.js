/**
 * Science docs — T9 (TASKS T9; PRD AC-9b scope note, AC-10d; DESIGN
 * D2/D5/D6).
 *
 * GROUND map (per describe below):
 *   - TASKS T9: "README, architecture.md, configuration.md, SKILL.md,
 *     help text. … T9 adds prose, sections, and the science docs
 *     section on top" — the T2-landed matrix COLUMNS and provider-table
 *     rows are pinned by provider-docs-completeness.test.js; this file
 *     pins the T9 DELTA: a science section + `scoutline science`
 *     usage in every public doc surface.
 *   - TASKS T9 / T2 ruling: "science suppliers get their own docs
 *     section (T2 ruling)" and the you-docs PROVIDER_LIST_TAIL prose
 *     tails "stay untouched" — the science section is the sanctioned
 *     home for supplier prose; the tails themselves are pinned
 *     unchanged by you-docs.test.js (no re-pin needed here).
 *   - TASKS T9: "CONTEXT.md glossary terms (Science Capability,
 *     ScienceWork) ship HERE — with the feature, per owner rule"
 *     (memory: glossary-ships-with-feature).
 *   - TASKS T9: "CHANGELOG typo guard: literal string `## [Unreleased]`
 *     present after edit" — already pinned GREEN by
 *     science-conformance.test.js (T8's describe); not duplicated here.
 *   - DESIGN D2: keyless-default + optional OPENALEX_API_KEY /
 *     NCBI_API_KEY upgrade tiers — configuration.md must document both
 *     env vars and the keyless default (house style: per-provider
 *     Settings sections).
 *   - TASKS T2 / PRD AC-5 round 5: the five PROVIDER_AUTHORITY_POLICIES
 *     always-unknown rows shipped in code with T2; docs/configuration.md
 *     "Quota Capability Mapping" table documents the same policy per
 *     provider (you-docs.test.js pins the `you` row precedent) — the
 *     science rows are T9's docs delta.
 *   - Stale-wording pins: T2's matrix/provider-table copy said
 *     "adapter ships in a follow-up ticket" while T3–T5 landed the
 *     adapters; T9's doc pass must retire the stale string (both
 *     files) and the stale 12-id registry-order bracket in the package
 *     README's Capability Matrix paragraph (the registry is 17 since
 *     T2; any honest fix — widen or reword — turns the pin green).
 *
 * Docs assertions read repo files relative to this test file
 * (precedent: you-docs.test.js, context-docs.test.js — tests never
 * ship in the npm tarball, so repo-relative reads are in-repo only).
 * SKILL.md edit rides the shipped copy (TASKS T9 NOTE, post seed-19:
 * packages/scoutline/skills/scoutline/SKILL.md is the npm-shipped
 * source of truth, PR #116).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";

const rootReadme = fs.readFile(new URL("../../../README.md", import.meta.url), "utf8");
const packageReadme = fs.readFile(new URL("../README.md", import.meta.url), "utf8");
const architecture = fs.readFile(
  new URL("../../../docs/architecture.md", import.meta.url),
  "utf8",
);
const configuration = fs.readFile(
  new URL("../../../docs/configuration.md", import.meta.url),
  "utf8",
);
const skill = fs.readFile(
  new URL("../skills/scoutline/SKILL.md", import.meta.url),
  "utf8",
);
const context = fs.readFile(new URL("../../../CONTEXT.md", import.meta.url), "utf8");

/** Slice a doc from a `Science` heading to the next same-or-higher heading. */
function scienceSection(text) {
  const start = text.search(/^#{2,4} Science\b/m);
  if (start === -1) return null;
  const level = text.slice(start).match(/^#+/)[0].length;
  const rest = text.slice(start + level);
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return text.slice(start, next === -1 ? undefined : start + level + next);
}

// The five supplier display labels as the matrix columns render them
// (provider-docs-completeness.test.js PROVIDER_MATRIX_LABELS).
const SUPPLIERS = ["arXiv", "OpenAlex", "Crossref", "PubMed", "Europe PMC"];

describe("science docs — root README (TASKS T9 docs bullet)", () => {
  it("carries a Science section documenting both verbs as keyless scholarly lookup", async () => {
    // GROUND: TASKS T9 "README … T9 adds prose, sections, and the
    // science docs section on top" / PRD G3 (`scoutline science
    // search <query>`, `scoutline science get <identifier>`). The
    // 17-id --provider enumeration (T2) is already pinned by
    // you-docs.test.js; the section is the missing piece.
    const text = await rootReadme;
    const section = scienceSection(text);
    assert.ok(section, "root README must have a `Science` heading section");
    assert.ok(
      section.includes("scoutline science search"),
      "the section must show `scoutline science search` usage",
    );
    assert.ok(
      section.includes("scoutline science get"),
      "the section must show `scoutline science get` usage",
    );
    assert.match(section, /keyless/i);
  });
});

describe("science docs — package README (TASKS T9 docs bullet)", () => {
  it("carries a Science section documenting both verbs as keyless scholarly lookup", async () => {
    // GROUND: TASKS T9 "README …" — both READMEs are public surfaces
    // (you-docs.test.js pins both for provider onboarding; science
    // gets the same two-surface treatment).
    const text = await packageReadme;
    const section = scienceSection(text);
    assert.ok(section, "package README must have a `Science` heading section");
    assert.ok(section.includes("scoutline science search"));
    assert.ok(section.includes("scoutline science get"));
    assert.match(section, /keyless/i);
  });

  it("no longer claims the registry ends at spider — the 12-id bracket is stale since T2", async () => {
    // GROUND: TASKS T9 "T9 adds prose … on top" + TASKS T2 (registry
    // widened to 17). The Capability Matrix paragraph's bracket
    // `[zai, …, spider]` is a factual claim about the registry; it
    // has been false since T2. Absence-pin form: any honest fix
    // (widen to 17 or drop the literal) goes green; leaving it stale
    // stays red.
    const text = await packageReadme;
    assert.ok(
      !text.includes("[zai, minimax, tavily, exa, brave, firecrawl, parallel, perplexity, jina, you, linkup, spider]"),
      "package README must not carry the stale 12-id registry-order bracket (registry is 17 since the science seats)",
    );
  });
});

describe("science docs — architecture.md (TASKS T9: the science docs section)", () => {
  it("has a Science section naming the capability ids, the five suppliers, keyless default, and usage", async () => {
    // GROUND: TASKS T9 "architecture.md/SKILL.md matrix COLUMNS
    // already landed in T2's commit … T9 adds prose, sections, and
    // the science docs section on top" / DESIGN D1 (capability ids
    // `science.search`/`science.get`) / DESIGN D2 (five suppliers,
    // keyless-default) / PRD G3.
    const text = await architecture;
    const section = scienceSection(text);
    assert.ok(section, "architecture.md must have a `Science` heading section");
    assert.ok(section.includes("science.search"), "the section names the science.search capability");
    assert.ok(section.includes("science.get"), "the section names the science.get capability");
    for (const supplier of SUPPLIERS) {
      assert.ok(section.includes(supplier), `the section names ${supplier}`);
    }
    assert.match(section, /keyless/i);
    assert.ok(section.includes("scoutline science search"));
  });

  it("capability matrix carries a Science row mapping the suppliers to `scoutline science`", async () => {
    // GROUND: TASKS T2 moved the matrix COLUMNS into T2's commit and
    // left the ROW for T9 ("T9 adds prose, sections, and the science
    // docs section on top"); the matrix row is the data-side
    // expression of the section — a Science capability row with the
    // `scoutline science` command cell.
    const text = await architecture;
    const row = text
      .split("\n")
      .find((line) => line.startsWith("| Science") && line.includes("scoutline science"));
    assert.ok(
      row,
      "architecture.md capability matrix must have a `| Science …` row whose Command cell is `scoutline science`",
    );
  });

  it("retires the stale `adapter ships in a follow-up ticket` wording — the adapters landed", async () => {
    // GROUND: T2's interim provider-table/matrix copy said "Adapter
    // ships in a follow-up ticket"; T3–T5 landed all five adapters
    // (TASKS T3/T4/T4b/T4c/T5). TASKS T9's doc pass updates the prose
    // on top of the T2 columns — the string is false now.
    const text = await architecture;
    assert.ok(
      !text.includes("follow-up ticket"),
      "architecture.md must not claim the science adapter ships in a follow-up ticket (it shipped)",
    );
  });
});

describe("science docs — SKILL.md (TASKS T9: npm-shipped copy)", () => {
  it("documents the science command for agents: usage, controls, keyless posture", async () => {
    // GROUND: TASKS T9 NOTE "SKILL.md is now npm-shipped … T9's
    // SKILL.md edit rides the shipped copy" + TASKS T9 docs bullet.
    // Agents are the primary SKILL audience; they need the verb pair,
    // the controls (PRD AC-7: exactly --author/--year/--venue/--type),
    // and the keyless fact (DESIGN D2).
    const text = await skill;
    const section = scienceSection(text);
    assert.ok(section, "SKILL.md must have a `Science` heading section");
    assert.ok(section.includes("scoutline science search"));
    assert.ok(section.includes("scoutline science get"));
    for (const control of ["--author", "--year", "--venue", "--type"]) {
      assert.ok(section.includes(control), `the section documents ${control}`);
    }
    assert.match(section, /keyless/i);
  });

  it("capability matrix carries a Science row mapping the suppliers to `scoutline science`", async () => {
    // GROUND: same as the architecture.md row pin — T2 landed the
    // columns, T9 lands the row (both surfaces are pinned by
    // provider-docs-completeness.test.js for column shape; this pins
    // the row's presence on both).
    const text = await skill;
    const row = text
      .split("\n")
      .find((line) => line.startsWith("| Science") && line.includes("scoutline science"));
    assert.ok(
      row,
      "SKILL.md capability matrix must have a `| Science …` row whose Command cell is `scoutline science`",
    );
  });

  it("retires the stale `adapter ships in a follow-up ticket` wording", async () => {
    // GROUND: same as the architecture.md stale-wording pin (T3–T5
    // landed the adapters).
    const text = await skill;
    assert.ok(
      !text.includes("follow-up ticket"),
      "SKILL.md must not claim the science adapter ships in a follow-up ticket (it shipped)",
    );
  });
});

describe("science docs — configuration.md (TASKS T9 + DESIGN D2 tiers)", () => {
  it("documents the science settings: keyless default plus the two optional upgrade env vars", async () => {
    // GROUND: TASKS T9 "configuration.md" + DESIGN D2 credential
    // tiers (OPENALEX_API_KEY, NCBI_API_KEY optional; keyless trio
    // has no key) / TASKS T2 bullet "Credential env vars:
    // OPENALEX_API_KEY, NCBI_API_KEY; [] for keyless trio" / PRD
    // AC-9 economics. House style: per-topic Settings sections
    // (you-docs.test.js pins `## You.com Settings`).
    const text = await configuration;
    const section = scienceSection(text);
    assert.ok(section, "configuration.md must have a `Science` heading section");
    assert.ok(section.includes("OPENALEX_API_KEY"));
    assert.ok(section.includes("NCBI_API_KEY"));
    assert.match(section, /keyless/i);
  });

  it("quota authority table carries an always-unknown row for each science supplier", async () => {
    // GROUND: TASKS T2 "add five PROVIDER_AUTHORITY_POLICIES rows
    // kind `always-unknown` (reason class: keyless scholarly index,
    // no spend signal)" shipped in code; configuration.md's "Quota
    // Capability Mapping" section documents every policy row
    // (you-docs.test.js pins the `you` row: /\\| `you` \\| always-unknown \\|/).
    // DESIGN D5: "science suppliers are excluded from quota-snapshot
    // availability ranking in v1" — the docs row is the visible half
    // of that exclusion.
    const text = await configuration;
    const start = text.indexOf("## Quota Capability Mapping");
    assert.ok(start > 0, "configuration.md must have a Quota Capability Mapping section");
    const end = text.indexOf("\n## ", start + 1);
    const section = text.slice(start, end === -1 ? undefined : end);
    for (const id of ["arxiv", "openalex", "crossref", "pubmed", "europepmc"]) {
      assert.match(
        section,
        new RegExp("\\|[^\\n]*`" + id + "`[^\\n]*always-unknown"),
        `the quota authority table must carry an always-unknown row naming \`${id}\``,
      );
    }
  });
});

describe("science docs — CONTEXT.md glossary (TASKS T9: terms ship with the feature)", () => {
  it("defines Science Capability and ScienceWork in the Language section", async () => {
    // GROUND: TASKS T9 "CONTEXT.md glossary terms (Science Capability,
    // ScienceWork) ship HERE — with the feature, per owner rule"
    // (memory: glossary-ships-with-feature — CONTEXT.md additions
    // happen in implementation tasks, never at plan/grill time).
    // House term format: bold term line inside ## Language
    // (see "Provider", "Capability", "Journal" entries).
    const text = await context;
    const start = text.indexOf("## Language");
    assert.ok(start > 0, "CONTEXT.md must have a Language section");
    const end = text.indexOf("## Flagged Ambiguities", start);
    assert.ok(end > start, "Language section must be bounded by Flagged Ambiguities");
    const language = text.slice(start, end);
    assert.match(
      language,
      /^\*\*Science Capability\*\*$/m,
      "CONTEXT.md Language must define **Science Capability**",
    );
    assert.match(
      language,
      /^\*\*ScienceWork\*\*$/m,
      "CONTEXT.md Language must define **ScienceWork**",
    );
    assert.match(
      language.slice(language.indexOf("**Science Capability**"), language.indexOf("**ScienceWork**")),
      /scholarly/i,
      "the Science Capability term must describe the scholarly meaning",
    );
  });
});
