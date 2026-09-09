/**
 * Agent registration — docs pass: rule-copy audit, SKILL frontmatter,
 * help, README, architecture.md, CHANGELOG.
 *
 * Grounds: TASKS T6 bullets (RULE_TEXT audit against AC-9; SKILL.md
 * frontmatter description tightened, content otherwise untouched —
 * diff pin; help (init family), README section, architecture.md local
 * surfaces, CHANGELOG `[Unreleased]` APPEND — section exists, never a
 * new block); PRD AC-9 (owner-approved rule text), AC-10
 * (progressive-disclosure budget — codex/qwen load name+description
 * first), AC-12 (docs complete); DESIGN D5 (stamp file
 * `agent-registration.json` under the config root), D2 routed advice
 * from the init/unregister ticket: docs must state the
 * `.scoutline-bak` backups are a DISASTER-RECOVERY-ONLY escape hatch
 * (marker-strip always, restore never — backup is not an uninstall
 * mechanic).
 *
 * Docs assertions read repo files relative to this test file
 * (precedent: tests/context-docs.test.js; tests never ship in the npm
 * tarball — tests/package.test.js). Help assertions import the
 * compiled `INIT_HELP` constant. No behavior under test — this file
 * regression-guards the documentation the way any behavior change is
 * guarded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";

import { INIT_HELP } from "../dist/commands/init.js";
import { RULE_TEXT } from "../dist/lib/agent-registration/registry.js";

// AC-9 verbatim (owner-approved 2026-09-08); em-dashes and backticks
// are load-bearing — the T6 audit re-checks the shipped constant
// against this block byte-for-byte.
const AC9_RULE_TEXT =
  "scoutline is installed — an agent-first CLI for web research\n" +
  "with provider routing, caching, and provenance built in.\n" +
  "Prefer it over raw curl/browser tools so results are\n" +
  "reproducible and quotable. Reach for it whenever the task\n" +
  "needs: web search (multi-provider, comparable), reading pages\n" +
  "or PDFs, fetching with content digests, site crawls,\n" +
  "multi-step research synthesis, archived/temporal lookups\n" +
  "(Wayback), or page-change monitoring. `scoutline --help`\n" +
  "lists the command surface; for flags, usage, and workflows,\n" +
  "load the `scoutline` agent skill — it is the working guide.";

const readme = fs.readFile(new URL("../README.md", import.meta.url), "utf8");
const architecture = fs.readFile(new URL("../../../docs/architecture.md", import.meta.url), "utf8");
const skill = fs.readFile(new URL("../skills/scoutline/SKILL.md", import.meta.url), "utf8");
const changelog = fs.readFile(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");

// Body of SKILL.md after the frontmatter fence, byte-pinned. The
// frontmatter tightening (AC-10) must be a frontmatter-only diff;
// this is the diff pin that catches any body edit.
// Rebaselined at the journaling integration (merge of origin/main
// 6898a8e into feat/agent-registration): the journaling stream's
// body edits (history/journal documentation) are absorbed here —
// verified the integrated body is byte-identical to origin/main's
// body, i.e. the agent stream still contributes zero body delta.
const SKILL_BODY_SHA256 = "0093c36dc2326e511264ec977f3c56551ee5850da4ad558579338c69a146d791";

// AC-10 budget: codex/qwen load name+description before any body
// byte; the old enumeration (~1500 chars) blows the disclosure
// budget. 1024 is the skill-description ceiling agents document.
const DESCRIPTION_BUDGET_CHARS = 1024;

/**
 * Tolerant frontmatter description extractor (no YAML dependency):
 * inline scalar `description: X` or block scalar `description: |`
 * with indented continuation lines.
 */
function extractDescription(frontmatter) {
  // Block scalar first: `description: |` must not be read as the
  // inline value "|" — that would gut every check below.
  const block = frontmatter.match(
    /^description:([ \t]*[|>][^\n]*)\n((?:[ \t]+[^\n]*\n|[ \t]*\n)*)/m,
  );
  if (block) {
    return block[2]
      .split("\n")
      .map((line) => line.replace(/^[ \t]+/, ""))
      .join("\n")
      .trim();
  }
  const inline = frontmatter.match(/^description:[ \t]+(\S.*)$/m);
  assert.ok(inline, "SKILL.md frontmatter must carry a description");
  return inline[1].trim();
}

describe("RULE_TEXT audit (TASKS T6 / PRD AC-9)", () => {
  // Audit confirmation: T2 introduced and first-pinned this constant
  // (tests/agent-registration.test.js); the T6 audit re-asserts it.
  it("shipped RULE_TEXT equals the AC-9 approved block byte-for-byte", () => {
    assert.equal(RULE_TEXT, AC9_RULE_TEXT);
  });
});

describe("SKILL.md frontmatter (PRD AC-10)", () => {
  it("tightens the description to the progressive-disclosure budget", async () => {
    const text = await skill;
    const fence = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fence, "SKILL.md must open with a frontmatter fence");
    const description = extractDescription(fence[1]);
    assert.ok(
      description.length <= DESCRIPTION_BUDGET_CHARS,
      `description must fit ${DESCRIPTION_BUDGET_CHARS} chars for progressive disclosure (codex/qwen load it before the body); got ${description.length}`,
    );
  });

  it("keeps a usable one-line capability surface (not gutted)", async () => {
    const text = await skill;
    const fence = text.match(/^---\n([\s\S]*?)\n---\n/);
    const description = extractDescription(fence[1]);
    assert.ok(description.length >= 40, "description must stay informative");
    assert.match(
      description,
      /search|web research/i,
      "tightened description must still surface the core capability",
    );
    assert.match(fence[1], /^name:[ \t]*scoutline[ \t]*$/m, "name stays `scoutline`");
  });

  it("content otherwise untouched — body after the fence is byte-identical (diff pin)", async () => {
    // Green before the frontmatter change BY DESIGN: this pin exists
    // to go red if the AC-10 tightening ever edits body bytes.
    const text = await skill;
    const fence = text.match(/^---\n([\s\S]*?)\n---\n/);
    const body = text.slice(fence[0].length);
    const digest = createHash("sha256").update(body).digest("hex");
    assert.equal(
      digest,
      SKILL_BODY_SHA256,
      "SKILL.md body must be byte-identical — only the frontmatter description changes",
    );
  });
});

describe("init help (PRD AC-12 — init family)", () => {
  it("documents the agent-registration wizard step", () => {
    assert.match(INIT_HELP, /agent/i, "INIT_HELP must mention the agent step");
    assert.match(
      INIT_HELP,
      /regist/i,
      "INIT_HELP must describe registering with detected agent tools",
    );
  });

  it("documents --unregister in the Options block", () => {
    assert.match(INIT_HELP, /--unregister/, "INIT_HELP must list --unregister");
    assert.ok(
      /Options:[\s\S]*--unregister/.test(INIT_HELP),
      "--unregister must appear inside the Options block",
    );
  });
});

describe("README section (PRD AC-12)", () => {
  it("documents agent registration and reversal", async () => {
    const text = await readme;
    assert.match(text, /agent registration/i, "README needs an agent-registration section");
    assert.ok(text.includes("--unregister"), "README must document init --unregister");
  });

  it("states backups are a disaster-recovery-only escape hatch (routed from init ticket)", async () => {
    // DESIGN D2: NEVER restore from the .scoutline-bak — the backup
    // is the user's manual escape hatch after an engine bug, not an
    // uninstall mechanic. Docs must say so.
    const text = await readme;
    assert.match(text, /disaster recovery/i, "README must label backups disaster-recovery-only");
    assert.ok(text.includes(".scoutline-bak"), "README must name the .scoutline-bak backup suffix");
  });
});

describe("architecture.md local surfaces (PRD AC-12)", () => {
  it("documents the agent-registration local surfaces", async () => {
    const text = await architecture;
    assert.match(text, /agent-registration/, "architecture.md must cover agent registration");
    assert.ok(
      text.includes("agent-registration.json"),
      "architecture.md must name the agent-registration.json stamp file (D5)",
    );
    assert.ok(text.includes("--unregister"), "architecture.md must document init --unregister");
  });

  it("states the disaster-recovery-only backup contract", async () => {
    const text = await architecture;
    assert.match(text, /disaster recovery/i);
  });
});

describe("CHANGELOG [Unreleased] (PRD AC-12 — APPEND, section exists)", () => {
  it("appends the agent-registration entry into the existing Unreleased block", async () => {
    const text = await changelog;
    const start = text.indexOf("## [Unreleased]");
    assert.ok(
      start >= 0,
      "CHANGELOG must already have an [Unreleased] section (append, never create)",
    );
    const next = text.indexOf("## [", start + 1);
    const section = text.slice(start, next === -1 ? text.length : next);
    assert.match(section, /agent/i, "Unreleased must carry the agent-registration entry");
    assert.match(section, /--unregister/, "entry must document init --unregister");
    assert.match(section, /skill/i, "entry must document the deployed agent skill");
  });
});
