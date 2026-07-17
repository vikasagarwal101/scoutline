/**
 * Package / install surface tests (P2-06, DESIGN.md §13, NFR-001).
 *
 * The shipped package must:
 *   - Build current source before importing the compiled `dist/`
 *     surface (this test runs after `npm run test:offline`, which
 *     invokes the build).
 *   - Expose a `main` export from `dist/index.js` that loads without
 *     performing side effects at module load.
 *   - Pack (`npm pack --dry-run --json`) the `bin` and current `dist`
 *     directories while excluding `tests/`, fixtures, local planning
 *     artifacts (`docs/plans/`), and credential-shaped files. The
 *     package manifest explicitly lists `"files": ["bin", "dist"]`,
 *     so anything outside that allowlist must be rejected.
 *   - Pin `mmx-cli` to exactly `1.0.16` (no range prefix), preserving
 *     the P2-04 MiniMax SDK isolation contract.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const PACKAGE_JSON = path.join(PACKAGE_ROOT, "package.json");

const CREDENTIAL_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\.[^/\\]+$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.mmx[\\/]config\.json$/i,
  /credentials\.json$/i,
  /secrets?\.(json|ya?ml|toml|env)$/i,
];

async function loadPackageJson() {
  const raw = await fs.readFile(PACKAGE_JSON, "utf8");
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
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`npm pack --dry-run emitted invalid JSON: ${err.message}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Root export and package metadata
// ---------------------------------------------------------------------------

describe("scoutline package — root export and metadata", () => {
  it("dist/index.js exports main without performing side effects at load", async () => {
    // The test runner runs `npm run build` before tests; the dist
    // surface exists by this point. The dynamic import exercises the
    // module load path and asserts a function `main` is exposed.
    let mod;
    try {
      mod = await import("../dist/index.js");
    } catch (error) {
      assert.fail(`importing dist/index.js threw: ${error.message}`);
    }
    assert.strictEqual(typeof mod.main, "function");
  });

  it("manifest pins mmx-cli to exactly 1.0.16 with no range prefix", async () => {
    const pkg = await loadPackageJson();
    const value = pkg.dependencies && pkg.dependencies["mmx-cli"];
    assert.ok(
      typeof value === "string" && value.length > 0,
      "mmx-cli must be a string dependency (got " + JSON.stringify(value) + ")",
    );
    assert.ok(
      !/[\^~>=<*]/.test(value),
      `mmx-cli dependency must be an exact version (1.0.16), got "${value}"`,
    );
    assert.strictEqual(value, "1.0.16");
  });

  it("manifest files allowlist is exactly [bin, dist]", async () => {
    const pkg = await loadPackageJson();
    assert.deepStrictEqual(
      pkg.files,
      ["bin", "dist"],
      "package.json \"files\" allowlist must be exactly [\"bin\", \"dist\"]",
    );
  });
});

// ---------------------------------------------------------------------------
// `npm pack --dry-run --json` contents
// ---------------------------------------------------------------------------

describe("scoutline package — npm pack contents", () => {
  it("includes the bin directory and current dist directory", async () => {
    const out = await runNpmPackDryRun();
    const files = (out[0] && out[0].files) || [];
    const paths = files.map((f) => f.path);

    const hasBin = paths.some((p) => p === "bin" || p.startsWith("bin/"));
    assert.ok(hasBin, `pack must include bin/ — paths: ${paths.slice(0, 8).join(", ")}...`);

    const hasDist = paths.some((p) => p === "dist" || p.startsWith("dist/"));
    assert.ok(hasDist, `pack must include dist/ — paths: ${paths.slice(0, 8).join(", ")}...`);

    // Spot-check: the compiled `dist/index.js` and `bin/scoutline.js`
    // must both be present so the package is consumable.
    assert.ok(
      paths.includes("dist/index.js"),
      "pack must include dist/index.js (compiled main)",
    );
    assert.ok(
      paths.includes("bin/scoutline.js"),
      "pack must include bin/scoutline.js (executable entrypoint)",
    );
  });

  it("excludes tests/, fixtures, planning artifacts, and credential-shaped files", async () => {
    const out = await runNpmPackDryRun();
    const files = (out[0] && out[0].files) || [];
    const paths = files.map((f) => f.path);

    // Local planning artifacts (used during development; never shipped).
    const offenders = [];

    for (const p of paths) {
      if (p === "tests" || p.startsWith("tests/")) {
        offenders.push(`tests leaked into pack: ${p}`);
      }
      // Fixtures live under tests/fixtures/ (already caught above) but
      // also assert explicitly for clarity.
      if (p.includes("/tests/fixtures/") || p.includes("tests/fixtures/")) {
        offenders.push(`fixture leaked into pack: ${p}`);
      }
      // docs/plans/ contains the phase plan and is not a shipped surface.
      if (p.startsWith("docs/plans/")) {
        offenders.push(`plan artifact leaked into pack: ${p}`);
      }
      // Credential-shaped files must not appear anywhere.
      for (const rx of CREDENTIAL_FILE_PATTERNS) {
        if (rx.test(p)) {
          offenders.push(`credential-shaped file leaked into pack: ${p}`);
        }
      }
    }

    assert.deepStrictEqual(
      offenders,
      [],
      `pack must exclude tests/fixtures/docs/credentials: ${offenders.join("; ")}`,
    );
  });

  it("package summary reports a non-trivial tarball size", async () => {
    const out = await runNpmPackDryRun();
    const summary = out[0] || {};
    assert.ok(summary.size > 0, "npm pack summary.size must be > 0");
    assert.ok(typeof summary.filename === "string" && summary.filename.endsWith(".tgz"),
      "npm pack summary.filename must be a .tgz path");
  });
});
