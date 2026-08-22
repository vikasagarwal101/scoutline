/**
 * You.com provider — docs pass teeth.
 *
 * The provider is wired in code (registry, init wizard, conformance
 * table); these assertions pin the public docs that must name it: both
 * public READMEs (root repo + npm package), the configuration doc for
 * `YDC_API_KEY`, the root CHANGELOG's Unreleased section, and the CLI
 * help surfaces that enumerate providers by name. SEARCH_HELP import
 * precedent: tests/search.test.js; MAIN_HELP is pinned by spawning
 * `--help` (precedent: tests/cli-smoke.test.js). Docs assertions read
 * the repo files relative to this test file (tests never ship in the
 * npm tarball — see tests/package.test.js — so repo-relative reads are
 * in-repo only).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { SEARCH_HELP } from "../dist/commands/search.js";
import { runProcess } from "./helpers/run-process.js";

const PROVIDER_ENUM =
  "--provider <zai|minimax|tavily|exa|brave|firecrawl|parallel|perplexity|jina|you|linkup|spider>";
const PROVIDER_LIST_TAIL =
  "Z.AI, MiniMax, Tavily, Exa, Brave, Firecrawl, Parallel AI, Perplexity, Jina AI, You.com, Linkup, or Spider.cloud";

const packageReadme = fs.readFile(new URL("../README.md", import.meta.url), "utf8");
const rootReadme = fs.readFile(new URL("../../../README.md", import.meta.url), "utf8");
const configuration = fs.readFile(
  new URL("../../../docs/configuration.md", import.meta.url),
  "utf8",
);
const changelog = fs.readFile(
  new URL("../../../CHANGELOG.md", import.meta.url),
  "utf8",
);

describe("You.com docs — public READMEs", () => {
  it("package README lists You.com in the provider selection surface", async () => {
    const text = await packageReadme;
    assert.ok(
      text.includes(PROVIDER_LIST_TAIL),
      "package README features must name You.com in the provider list",
    );
    assert.ok(
      text.includes(PROVIDER_ENUM),
      "package README must list you in the --provider enumeration",
    );
    assert.ok(
      text.includes("| You.com |"),
      "package README capability matrix must have a You.com column",
    );
  });

  it("root README lists You.com and documents YDC_API_KEY setup", async () => {
    const text = await rootReadme;
    assert.ok(
      text.includes(PROVIDER_LIST_TAIL),
      "root README features must name You.com in the provider list",
    );
    assert.ok(
      text.includes(PROVIDER_ENUM),
      "root README must list you in the --provider enumeration",
    );
    assert.ok(
      text.includes("### Using You.com"),
      "root README must carry a Using You.com section",
    );
    assert.ok(text.includes("YDC_API_KEY"), "root README must document YDC_API_KEY");
    assert.ok(
      text.includes("YOU_API_KEY"),
      "root README must document the YOU_API_KEY alias",
    );
    assert.ok(
      text.includes("| You.com |"),
      "root README capability matrix must have a You.com column",
    );
  });
});

describe("You.com docs — configuration", () => {
  it("docs/configuration.md documents YDC_API_KEY and the you provider id", async () => {
    const text = await configuration;
    assert.ok(
      text.includes("## You.com Settings"),
      "configuration.md must have a You.com Settings section",
    );
    assert.ok(text.includes("YDC_API_KEY"), "configuration.md must document YDC_API_KEY");
    assert.ok(
      text.includes("YOU_API_KEY"),
      "configuration.md must document the YOU_API_KEY alias",
    );
    assert.ok(
      text.includes("|jina|you>"),
      "configuration.md --provider enumeration must include you",
    );
    assert.match(
      text,
      /\| `you` \| always-unknown \|/,
      "configuration.md quota authority table must carry the you always-unknown row",
    );
  });
});

describe("You.com docs — CHANGELOG", () => {
  it("root CHANGELOG carries the You.com entry under a single Unreleased heading", async () => {
    const text = await changelog;
    const headings = text.match(/^## \[Unreleased\]$/gm) ?? [];
    assert.equal(headings.length, 1, "CHANGELOG must have exactly one ## [Unreleased] heading");
    const start = text.indexOf("## [Unreleased]");
    const next = text.indexOf("## [", start + 1);
    assert.ok(next > start, "Unreleased must be followed by a version section");
    const section = text.slice(start, next);
    assert.ok(section.includes("You.com"), "the Unreleased section must mention You.com");
    assert.ok(
      section.includes("YDC_API_KEY"),
      "the Unreleased section must mention YDC_API_KEY",
    );
  });
});

describe("You.com docs — CLI help enumerations", () => {
  it("SEARCH_HELP lists you in the --provider enumeration", () => {
    assert.ok(
      SEARCH_HELP.includes(PROVIDER_ENUM),
      "SEARCH_HELP must list you in --provider",
    );
  });

  it("main help names You.com among the providers", async () => {
    const result = await runProcess(["--help"], {
      env: { Z_AI_API_KEY: "docs-teeth-key" },
    });
    assert.equal(result.code, 0);
    assert.ok(
      result.stdout.includes("all 12 Providers"),
      "main help must count 12 providers",
    );
    assert.ok(
      result.stdout.includes("perplexity|jina|you|linkup|spider>"),
      "main help must list you in --provider",
    );
    assert.ok(
      result.stdout.includes("You.com advertises search, reader, and research"),
      "main help must advertise You.com capabilities",
    );
    assert.ok(
      result.stdout.includes("Exa, Firecrawl, Parallel, Jina, You.com, Linkup, and Spider.cloud supply it"),
      "main help must list You.com among the read suppliers",
    );
    assert.ok(
      result.stdout.includes("Perplexity, Jina, and You.com support it"),
      "main help must list You.com among the research suppliers",
    );
  });
});
