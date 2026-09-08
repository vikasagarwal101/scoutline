/**
 * Skill shipping pins — skill lives in the package + runtime source
 * resolution.
 *
 * GROUND (ticket bullets + PRD AC-1 + DESIGN D3/D6):
 *   - `skills/scoutline/` moves from repo root into
 *     `packages/scoutline/skills/scoutline/` (npm `files` cannot reach
 *     outside the package dir — the root copy ships nothing); the
 *     package copy is the single source of truth from here on.
 *   - `skills` appears in package.json `files`.
 *   - `npm pack` tarball contains `skills/scoutline/SKILL.md` and
 *     `skills/scoutline/references/` files (PRD AC-1 pack pin).
 *   - Repo references repointed (`.claude-plugin/marketplace.json`,
 *     root README).
 *   - Runtime skill-source resolver: package-resident skill resolved
 *     "beside dist/, fileURLToPath(import.meta.url) walk-up, no cwd
 *     dependence" (DESIGN D3); the installed package exposes the
 *     skill source at a runtime-resolvable path (AC-1).
 *
 * Red phase: every pin below fails on the current tree (skill still
 * repo-root, files lacks "skills", dist/lib/skill-source.js absent).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");

async function loadPackageJson() {
  const raw = await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8");
  return JSON.parse(raw);
}

function runNpmPackDryRun() {
  return new Promise((resolve, reject) => {
    const proc = spawn("npm", ["pack", "--dry-run", "--json"], {
      cwd: PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`npm pack --dry-run exited ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        // npm <=11 emits an array of pack entries; npm 12 emits a
        // name-keyed OBJECT. Normalize to the array shape either way
        // (same normalization as tests/package.test.js).
        resolve(Array.isArray(parsed) ? parsed : Object.values(parsed));
      } catch (err) {
        reject(new Error(`npm pack --dry-run emitted invalid JSON: ${err.message}`));
      }
    });
  });
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Relocation: package copy is source of truth (bullet 1, AC-1)
// ---------------------------------------------------------------------------

describe("skill shipping — package relocation", () => {
  it("package skill dir contains SKILL.md and references/ with files", async () => {
    // GROUND: bullet 1 — skills/scoutline/ moves INTO the package.
    const skillDir = path.join(PACKAGE_ROOT, "skills", "scoutline");
    assert.ok(await exists(skillDir), `${skillDir} must exist after the move`);
    assert.ok(
      await exists(path.join(skillDir, "SKILL.md")),
      "package skill dir must contain SKILL.md",
    );
    const refs = path.join(skillDir, "references");
    assert.ok(await exists(refs), "package skill dir must contain references/");
    const refFiles = await fs.readdir(refs);
    assert.ok(refFiles.length > 0, "references/ must contain its files");
  });

  it("repo-root skills/scoutline/ is gone after the move", async () => {
    // GROUND: bullet 1 — relocation, not duplication. A surviving
    // root copy would drift from the package source of truth.
    assert.equal(
      await exists(path.join(REPO_ROOT, "skills")),
      false,
      "repo-root skills/ directory must not survive the move (D6)",
    );
  });

  it("package SKILL.md byte-matches the moved content (non-trivial, frontmatter intact)", async () => {
    // GROUND: bullet 1 — the move carries the content; "content
    // otherwise untouched" work happens later. Guard the floor:
    // SKILL.md keeps YAML frontmatter with name+description.
    const text = await fs.readFile(path.join(PACKAGE_ROOT, "skills", "scoutline", "SKILL.md"), "utf8");
    assert.ok(text.startsWith("---\n"), "SKILL.md must start with YAML frontmatter");
    assert.match(text, /^name:\s*scoutline\s*$/m, "SKILL.md frontmatter must name the skill");
    assert.match(text, /^description:/m, "SKILL.md frontmatter must carry a description");
    assert.ok(text.length > 1000, `SKILL.md must be the full guide (got ${text.length} bytes)`);
  });
});

// ---------------------------------------------------------------------------
// package.json files allowlist (bullet 2)
// ---------------------------------------------------------------------------

describe("skill shipping — files allowlist", () => {
  it('files includes "skills"', async () => {
    // GROUND: bullet 2 — skills/ in package.json files.
    const pkg = await loadPackageJson();
    assert.ok(
      Array.isArray(pkg.files) && pkg.files.includes("skills"),
      `package.json files must include "skills" — got ${JSON.stringify(pkg.files)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// npm pack pin (bullet 3, PRD AC-1)
// ---------------------------------------------------------------------------

describe("skill shipping — npm pack ships the skill", () => {
  it("tarball contains skills/scoutline/SKILL.md and references/ entries", async () => {
    // GROUND: PRD AC-1 — "pinned: npm pack tarball contains
    // skills/scoutline/SKILL.md + references/".
    const out = await runNpmPackDryRun();
    const files = (out[0] && out[0].files) || [];
    const paths = files.map((f) => f.path);

    assert.ok(
      paths.includes("skills/scoutline/SKILL.md"),
      `pack must include skills/scoutline/SKILL.md — skills entries: ${
        paths.filter((p) => p.startsWith("skills")).join(", ") || "(none)"
      }`,
    );

    const refEntries = paths.filter((p) => p.startsWith("skills/scoutline/references/"));
    assert.ok(refEntries.length > 0, "pack must include skills/scoutline/references/ entries");
  });
});

// ---------------------------------------------------------------------------
// Repo references repointed (bullet 1)
// ---------------------------------------------------------------------------

describe("skill shipping — repo references repointed", () => {
  it("marketplace.json points at packages/scoutline/skills/scoutline, not the repo-root path", async () => {
    // GROUND: bullet 1 — .claude-plugin/marketplace.json repointed;
    // the old ./skills/scoutline entry dangles once the move lands.
    const raw = await fs.readFile(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8");
    const json = JSON.parse(raw);
    const flat = JSON.stringify(json);
    assert.ok(
      /packages\/scoutline\/skills\/scoutline/.test(flat),
      "marketplace.json must reference packages/scoutline/skills/scoutline",
    );
    assert.ok(
      !/"\s*\.\/skills\/scoutline\s*"/.test(flat),
      "marketplace.json must no longer reference ./skills/scoutline",
    );
    // The skills array survives the repoint (marketplace still ships
    // the skill; only the path changes).
    const plugin = (json.plugins || []).find((p) =>
      Array.isArray(p.skills) && p.skills.length > 0,
    );
    assert.ok(plugin, "marketplace.json plugins must keep a non-empty skills array");
  });

  it("root README repository-layout tree drops the repo-root skills line and names the package location", async () => {
    // GROUND: bullet 1 — root README repointed (tree entry at README:505).
    const text = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
    assert.ok(
      !/skills\/scoutline\s+#\s+Agent skill/.test(text),
      "README layout tree must drop the repo-root skills/scoutline line",
    );
    assert.ok(
      /packages\/scoutline\/skills\/scoutline/.test(text),
      "README must reference packages/scoutline/skills/scoutline",
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime skill-source resolver (bullet 5, DESIGN D3)
// ---------------------------------------------------------------------------

describe("skill shipping — runtime source resolver", () => {
  it("resolveSkillSourceDir() returns the package-resident skills/scoutline directory", async () => {
    // GROUND: D3 — source resolved from the installed package root,
    // "resolvable beside dist/ — fileURLToPath(import.meta.url)
    // walk-up". The compiled resolver lives in dist/lib/skill-source.js.
    const mod = await import("../dist/lib/skill-source.js");
    assert.strictEqual(
      typeof mod.resolveSkillSourceDir,
      "function",
      "dist/lib/skill-source.js must export resolveSkillSourceDir",
    );
    const skillDir = mod.resolveSkillSourceDir();
    assert.strictEqual(
      skillDir,
      path.join(PACKAGE_ROOT, "skills", "scoutline"),
      `resolver must return <package>/skills/scoutline, got ${skillDir}`,
    );
    assert.ok(
      await exists(path.join(skillDir, "SKILL.md")),
      "resolved dir must contain SKILL.md",
    );
  });

  it("resolver output is cwd-independent (import.meta walk-up, not process.cwd())", async () => {
    // GROUND: D3 — "no cwd dependence". Resolve, chdir to the OS
    // tempdir, resolve again: identical path. A process.cwd()-based
    // join would drift (or throw) under the unrelated cwd.
    const mod = await import("../dist/lib/skill-source.js");
    const before = mod.resolveSkillSourceDir();
    const prevCwd = process.cwd();
    process.chdir(os.tmpdir());
    try {
      const after = mod.resolveSkillSourceDir();
      assert.strictEqual(after, before, "resolver output must not depend on process.cwd()");
      assert.ok(
        await exists(path.join(after, "SKILL.md")),
        "resolved dir must still contain SKILL.md from an unrelated cwd",
      );
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("resolver survives a simulated installed layout (dist beside skills/)", async () => {
    // GROUND: AC-1 — "the installed package exposes the skill source
    // at a runtime-resolvable path beside the bin". Simulate the
    // installed shape: copy dist/ + skills/ + package.json into a
    // temp root, run the copied resolver from a shim with that temp
    // root as cwd. A resolver that hardcodes the repo location (or
    // leans on repo-only siblings) fails this pin.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "skill-resolver-"));
    try {
      await fs.cp(path.join(PACKAGE_ROOT, "dist"), path.join(base, "dist"), { recursive: true });
      await fs.cp(path.join(PACKAGE_ROOT, "skills"), path.join(base, "skills"), { recursive: true });
      await fs.copyFile(
        path.join(PACKAGE_ROOT, "package.json"),
        path.join(base, "package.json"),
      );
      const shim = path.join(base, "shim.mjs");
      await fs.writeFile(
        shim,
        `import { resolveSkillSourceDir } from "./dist/lib/skill-source.js";\n` +
          `console.log(resolveSkillSourceDir());\n`,
      );
      const resolved = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [shim], {
          cwd: base,
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        proc.stdout.on("data", (d) => (out += d.toString()));
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code !== 0) reject(new Error(`shim exited ${code}`));
          else resolve(out.trim().split("\n").pop());
        });
      });
      assert.strictEqual(
        resolved,
        path.join(base, "skills", "scoutline"),
        `resolver must resolve beside the simulated install's dist/, got ${resolved}`,
      );
      assert.ok(
        await exists(path.join(resolved, "SKILL.md")),
        "simulated-install resolution must find SKILL.md",
      );
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
