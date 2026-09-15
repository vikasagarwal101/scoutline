/**
 * Registry-derived doc-completeness pin (#88).
 *
 * #79's lopsided doc syncs happened because no gate tied architecture.md
 * and SKILL.md provider tables to PROVIDER_IDS. you-docs.test.js pins a
 * hardcoded --provider enumeration; this file derives the expected set
 * from the registry so a provider that lands without its table/matrix
 * cell fails the gate.
 *
 * Cell-level capability derivation is out of scope: table presence is
 * the class #79 demonstrated.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { PROVIDER_IDS } from "../dist/providers/types.js";

/** Display labels used as capability-matrix column headers (registry order). */
// Science supplier seats added alongside the capability-matrix columns
// in architecture.md and SKILL.md.
const PROVIDER_MATRIX_LABELS = {
  zai: "Z.AI",
  minimax: "MiniMax",
  tavily: "Tavily",
  exa: "Exa",
  brave: "Brave",
  firecrawl: "Firecrawl",
  parallel: "Parallel",
  perplexity: "Perplexity",
  jina: "Jina AI",
  you: "You.com",
  linkup: "Linkup",
  spider: "Spider.cloud",
  arxiv: "arXiv",
  openalex: "OpenAlex",
  crossref: "Crossref",
  pubmed: "PubMed",
  europepmc: "Europe PMC",
};

const architecture = fs.readFile(new URL("../../../docs/architecture.md", import.meta.url), "utf8");
const skill = fs.readFile(new URL("../skills/scoutline/SKILL.md", import.meta.url), "utf8");

function expectedMatrixHeader() {
  const labels = PROVIDER_IDS.map((id) => {
    const label = PROVIDER_MATRIX_LABELS[id];
    assert.ok(label, `PROVIDER_MATRIX_LABELS is missing ${id}`);
    return label;
  });
  return `| Capability | ${labels.join(" | ")} | Command |`;
}

function backtickIdsIn(text) {
  const ids = [];
  for (const match of text.matchAll(/\| `([a-z][a-z0-9-]*)` \|/g)) {
    ids.push(match[1]);
  }
  return ids;
}

describe("doc completeness — architecture.md and SKILL.md follow PROVIDER_IDS (#88)", () => {
  it("every registry id has a matrix label and no extra labels exist", () => {
    assert.deepEqual(
      Object.keys(PROVIDER_MATRIX_LABELS).sort(),
      [...PROVIDER_IDS].sort(),
      "PROVIDER_MATRIX_LABELS must be exactly the registry",
    );
  });

  it("architecture.md Built-in Providers table lists every registry id and no extras", async () => {
    const text = await architecture;
    const start = text.indexOf("### Built-in Providers");
    assert.ok(start >= 0, "architecture.md must have ### Built-in Providers");
    const next = text.indexOf("\n### ", start + 1);
    const section = text.slice(start, next > start ? next : undefined);
    const ids = backtickIdsIn(section);
    assert.deepEqual(
      ids,
      [...PROVIDER_IDS],
      "Built-in Providers table ids must match PROVIDER_IDS in registry order",
    );
  });

  it("architecture.md capability matrix header lists every registry display name", async () => {
    const text = await architecture;
    assert.ok(
      text.includes(expectedMatrixHeader()),
      `architecture.md capability matrix must include: ${expectedMatrixHeader()}`,
    );
  });

  it("SKILL.md capability matrix header lists every registry display name", async () => {
    const text = await skill;
    assert.ok(
      text.includes(expectedMatrixHeader()),
      `SKILL.md capability matrix must include: ${expectedMatrixHeader()}`,
    );
  });
});

const troubleshooting = fs.readFile(
  new URL("../../../docs/troubleshooting.md", import.meta.url),
  "utf8",
);

describe("doc completeness — troubleshooting.md unknown-provider surfaces (#166 review)", () => {
  async function unknownProviderSection() {
    const text = await troubleshooting;
    const start = text.indexOf("## Unknown Provider ID");
    assert.ok(start >= 0, "troubleshooting.md must have ## Unknown Provider ID");
    const next = text.indexOf("\n## ", start + 1);
    return text.slice(start, next > start ? next : undefined);
  }

  it("fenced error example matches the built enumeration verbatim", async () => {
    const section = await unknownProviderSection();
    const expected = `Unknown provider "<value>". Accepted provider IDs: ${PROVIDER_IDS.join(", ")}.`;
    assert.ok(
      section.includes(expected),
      `troubleshooting.md fenced example must equal the built enumeration verbatim:\n${expected}`,
    );
  });

  it("prose acceptance sentence covers exactly the registry ids, in order", async () => {
    const section = await unknownProviderSection();
    // Extract the id sequence from the prose sentence (backticked ids
    // between "accept" and its closing period) — punctuation/backtick
    // wording may differ, the ID SET and ORDER may not.
    const sentence = section.match(/ accept ([^.]*?)\./);
    assert.ok(sentence, "prose acceptance sentence not found");
    const ids = [...sentence[1].matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]);
    assert.deepEqual(
      ids,
      [...PROVIDER_IDS],
      "prose id sequence must equal PROVIDER_IDS in registry order",
    );
  });
});
