/**
 * Local-context plan, Ticket 6 — docs pass.
 *
 * The ticket's testable contract: the "what leaves your machine" wording
 * must appear in help for research `bias`/`both` and for search
 * `--context`, and the flag blocks (SEARCH_HELP gained no context flags
 * in Tickets 4–5; RESEARCH_HELP gained only the Ticket 3 re-pipe note)
 * must document the flag surface. The remaining assertions pin the
 * non-code docs (package README, repo architecture, skill, changelog)
 * so the docs pass is regression-guarded like any behavior change.
 *
 * Help assertions import the compiled `dist/` constants (precedent:
 * tests/research-context.test.js imports RESEARCH_HELP; tests/search.test.js
 * imports SEARCH_HELP). Docs assertions read the repo files relative to
 * this test file (tests never ship in the npm tarball — see
 * tests/package.test.js — so repo-relative reads are in-repo only).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { RESEARCH_HELP } from "../dist/commands/research.js";
import { SEARCH_HELP } from "../dist/commands/search.js";

const readme = fs.readFile(new URL("../README.md", import.meta.url), "utf8");
const architecture = fs.readFile(
  new URL("../../../docs/architecture.md", import.meta.url),
  "utf8",
);
const skill = fs.readFile(
  new URL("../../../skills/scoutline/SKILL.md", import.meta.url),
  "utf8",
);
const changelog = fs.readFile(
  new URL("../../../CHANGELOG.md", import.meta.url),
  "utf8",
);

describe("Ticket 6 — research help flag block", () => {
  it("documents --context, --context-stdin, and --context-mode with the mode values", async () => {
    assert.match(RESEARCH_HELP, /--context <path>/);
    assert.match(RESEARCH_HELP, /--context-stdin/);
    assert.match(RESEARCH_HELP, /--context-mode/);
    for (const mode of ["organize", "bias", "both"]) {
      assert.ok(
        RESEARCH_HELP.includes(mode),
        `RESEARCH_HELP must name the --context-mode value "${mode}"`,
      );
    }
  });

  it("states organize as the default mode", () => {
    assert.match(RESEARCH_HELP, /organize \(default\)/);
  });

  it("carries the what-leaves-your-machine wording for bias/both", () => {
    assert.match(RESEARCH_HELP, /leaves your machine/);
  });

  it("states that bias/both change the cache key (D5: --help states it)", () => {
    assert.match(RESEARCH_HELP, /cache key/);
  });

  it("documents the envelope context field as metadata-only", () => {
    assert.match(RESEARCH_HELP, /derived counts/);
  });
});

describe("Ticket 6 — search help flag block", () => {
  it("documents --context and --context-stdin", () => {
    assert.match(SEARCH_HELP, /--context <path>/);
    assert.match(SEARCH_HELP, /--context-stdin/);
  });

  it("carries the what-leaves-your-machine wording for search --context", () => {
    assert.match(SEARCH_HELP, /leaves your machine/);
  });

  it("documents the --merge mutual exclusion", () => {
    assert.ok(
      SEARCH_HELP.includes("Mutually exclusive with `--merge`"),
      "SEARCH_HELP must mark --context as mutually exclusive with --merge",
    );
  });

  it("discloses the fan-out cost multiplication and the counts-only wrapper", () => {
    assert.match(SEARCH_HELP, /sub-queries × M arms/);
    assert.match(SEARCH_HELP, /SHA-256/i);
  });
});

describe("Ticket 6 — docs files", () => {
  it("README documents the flags and the privacy boundary", async () => {
    const text = await readme;
    for (const needle of [
      "--context",
      "--context-stdin",
      "--context-mode",
      "organize",
      "leaves your machine",
    ]) {
      assert.ok(text.includes(needle), `README must mention ${needle}`);
    }
  });

  it("architecture.md carries context boundary notes in the search and research sections", async () => {
    const text = await architecture;
    assert.match(text, /--context-stdin/);
    assert.match(text, /--context-mode/);
    assert.match(text, /leaves the machine/);
  });

  it("SKILL.md documents local context steering", async () => {
    const text = await skill;
    assert.ok(text.includes("--context"), "SKILL.md must mention --context");
    assert.ok(
      text.includes("--context-stdin"),
      "SKILL.md must mention --context-stdin",
    );
  });

  it("CHANGELOG re-creates [Unreleased] with the local-context entry", async () => {
    const text = await changelog;
    assert.ok(
      text.includes("## [Unreleased]"),
      "CHANGELOG must re-create the [Unreleased] section",
    );
    const unreleased = text.slice(
      text.indexOf("## [Unreleased]"),
      text.indexOf("## [0.16.0]"),
    );
    assert.ok(
      unreleased.includes("--context"),
      "the [Unreleased] section must document the --context flags",
    );
  });
});
