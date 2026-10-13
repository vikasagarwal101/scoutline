/**
 * Reviewer-pattern behavioral RED proof for the caller-rounds seed seam.
 * Loads the FROZEN dist with the seed consumption disabled (the only
 * caller-rounds delta reverted in memory) and re-runs the cross-round
 * teeth from tests/lean-caller-rounds.test.mjs; each must FAIL there.
 * Zero production mutation. Usage: node scripts/caller-rounds-mutant-check.mjs
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";

const distDir = path.resolve(new URL(".", import.meta.url).pathname, "..", "dist");
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cr-mutant-"));
await fs.cp(distDir, tmpDir, { recursive: true });
const enginePath = path.join(tmpDir, "lib", "lean-investigation.js");
const source = await fs.readFile(enginePath, "utf8");
const MUTATED = source.replace("const seed = deps.seed;", "const seed = undefined; // MUTANT");
assert.notEqual(MUTATED, source, "mutation marker not found in dist");
await fs.writeFile(enginePath, MUTATED);
const { runLeanInvestigation } = await import(`file://${enginePath}`);
globalThis.fetch = () => { throw new Error("HTTP refused"); };

const now = () => 1000;
const contract = {
  schemaVersion: 1,
  question: "What version is package foo?",
  requirements: { version: { question: "What version is package foo?", schema: { type: "string" }, required: true } },
};
const seedEvidence = [{
  evidenceId: "e1",
  url: "https://example.test/pkg",
  title: "https://example.test/pkg",
  content: "package foo version 1.2.3 license MIT",
  byteLength: 40,
  origins: ["What version is package foo?"],
}];
const deps = {
  search: async () => [],
  read: async () => { throw new Error("no reread"); },
  judge: async () => ({ documents: [] }),
  now,
};

// Tooth 1: seeded evidence reuse — with the seed consumed, no evidence.
const r = await runLeanInvestigation(contract, { ...deps, seed: { evidence: seedEvidence, issuedQueries: contract.requirements ? [] : [] } });
assert.equal(r.evidence.length, 0, `MUTANT still retained seed evidence (${r.evidence.length})`);
console.log("RED proven: mutant drops seeded evidence (expected behavior retains it)");
await fs.rm(tmpDir, { recursive: true, force: true });
