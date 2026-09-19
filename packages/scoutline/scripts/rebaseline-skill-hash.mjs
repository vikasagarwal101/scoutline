#!/usr/bin/env node
// rebaseline-skill-hash.mjs — replaces the manual SKILL_BODY_SHA256
// rebaseline ritual (issue #235). Recomputes the body hash over the
// CURRENT skills/scoutline/SKILL.md using the byte-identical recipe
// from tests/agent-registration-docs.test.js (slice after the
// `---\n…\n---\n` fence, SHA-256 hex), rewrites the pin line when it
// drifts (no-op when unchanged), and fails loud if the body lost any
// structural marker.
//
//   node scripts/rebaseline-skill-hash.mjs          # rewrite pin if stale
//   node scripts/rebaseline-skill-hash.mjs --check  # exit 1 when stale, no writes

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const checkOnly = process.argv.includes("--check");
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillPath = join(packageRoot, "skills", "scoutline", "SKILL.md");
const testPath = join(packageRoot, "tests", "agent-registration-docs.test.js");

const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(1);
};

const skillText = await readFile(skillPath, "utf8");

// Structural markers must survive before we re-pin anything.
const fence = skillText.match(/^---\n([\s\S]*?)\n---\n/);
if (!fence) fail(`${skillPath} has no frontmatter fence`);
const body = skillText.slice(fence[0].length);
for (const marker of ["## Capability Matrix", "## Commands"]) {
  if (!body.includes(marker)) {
    fail(`SKILL.md body missing structural marker: ${marker}`);
  }
}

// Byte-identical recipe to the pin test: hash of everything after the fence.
const digest = createHash("sha256").update(body).digest("hex");

const testText = await readFile(testPath, "utf8");
const pinLine = testText
  .split("\n")
  .find((line) => line.includes("SKILL_BODY_SHA256 ="));
if (!pinLine) fail(`no SKILL_BODY_SHA256 pin line in ${testPath}`);
const oldHash = pinLine.match(/"([0-9a-f]{64})"/)?.[1];
if (!oldHash) fail("pin line carries no 64-hex-digit SHA-256 literal");

if (oldHash === digest) {
  console.log(`in sync: ${digest}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`out of sync: pin ${oldHash} != current body ${digest}`);
  process.exit(1);
}

console.log(`rebaselined: ${oldHash} -> ${digest}`);
await writeFile(
  testPath,
  testText.replace(pinLine, pinLine.replace(oldHash, digest)),
);
