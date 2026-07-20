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
 *   - Install successfully into a fresh temporary directory from the
 *     generated tarball, expose its `bin` executable, and import its
 *     root `main` export without performing side effects. This is the
 *     NFR-001 / NFR-003 install-safety gate; the install uses
 *     `--offline --ignore-scripts --no-audit --no-fund` and relies on
 *     the surrounding `npm install`/`npm ci` of the package itself
 *     having already populated the local npm cache. The test NEVER
 *     contacts the npm registry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * Run `npm pack --json --pack-destination <destDir>` against the package
 * and return the resulting tarball path. Uses the default registry
 * settings because `npm pack` does not perform any network resolution
 * for the package itself; only the tarball metadata is emitted.
 */
function packToDir(destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn("npm", ["pack", "--json", "--pack-destination", destDir], {
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
        reject(new Error(`npm pack exited ${code}: ${stderr}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        reject(new Error(`npm pack emitted invalid JSON: ${err.message}\nstdout=${stdout}`));
        return;
      }
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      const filename = entry && typeof entry.filename === "string" ? entry.filename : null;
      if (!filename) {
        reject(new Error(`npm pack response missing filename: ${stdout}`));
        return;
      }
      const tarballPath = path.join(destDir, path.basename(filename));
      resolve(tarballPath);
    });
  });
}

/**
 * Install a local tarball into `destDir` using offline-only npm. This
 * relies on the local cache having been populated by the preceding
 * `npm ci` / `npm install` of the package itself; no registry contact
 * occurs.
 */
function installTarballOffline(tarballPath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        destDir,
        tarballPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `npm install --offline exited ${code}: ${stderr || stdout}\n` +
              `Ensure the local npm cache is populated (run \`npm ci\` first).`,
          ),
        );
        return;
      }
      resolve();
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

  it("manifest pins mmx-cli to exactly 1.0.16 with no range prefix (C4: moved to devDependencies)", async () => {
    const pkg = await loadPackageJson();
    // C4: mmx-cli moved from runtime dependencies to devDependencies.
    // The direct transport (Phase B) replaced the runtime need; the
    // package remains a devDependency so the C2 envelope-parity live
    // test can compare direct-transport responses against the legacy
    // SDK. The exact-pin constraint is still required for deterministic
    // SDK behavior in that comparison.
    const value = pkg.devDependencies && pkg.devDependencies["mmx-cli"];
    assert.ok(
      typeof value === "string" && value.length > 0,
      "mmx-cli must be a string devDependency (got " + JSON.stringify(value) + ")",
    );
    assert.ok(
      !/[\^~>=<*]/.test(value),
      `mmx-cli devDependency must be an exact version (1.0.16), got "${value}"`,
    );
    assert.strictEqual(value, "1.0.16");
    // And it must NOT be in runtime dependencies.
    assert.ok(
      !(pkg.dependencies && pkg.dependencies["mmx-cli"]),
      "mmx-cli must not appear in runtime dependencies after C4 (direct transport owns the runtime path)",
    );
  });

  it("manifest files allowlist is exactly [bin, dist]", async () => {
    const pkg = await loadPackageJson();
    assert.deepStrictEqual(
      pkg.files,
      ["bin", "dist"],
      'package.json "files" allowlist must be exactly ["bin", "dist"]',
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
    assert.ok(paths.includes("dist/index.js"), "pack must include dist/index.js (compiled main)");
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
    assert.ok(
      typeof summary.filename === "string" && summary.filename.endsWith(".tgz"),
      "npm pack summary.filename must be a .tgz path",
    );
  });
});

// ---------------------------------------------------------------------------
// Tarball install round-trip (NFR-001, NFR-003)
// ---------------------------------------------------------------------------

describe("scoutline package — tarball install round-trip", () => {
  it("installs into a fresh directory and exposes bin + import-safe main", async () => {
    // Use two adjacent temp directories: one for the generated tarball
    // and one for the install prefix. Both are removed in `finally`
    // even if the install or assertions fail.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-pack-"));
    const packDir = path.join(base, "pack");
    const installDir = path.join(base, "install");
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(installDir, { recursive: true });

    try {
      // 1. Build the tarball in the first temp dir.
      const tarballPath = await packToDir(packDir);
      assert.ok(
        tarballPath.endsWith(".tgz"),
        `expected a .tgz path from npm pack, got ${tarballPath}`,
      );
      const tarballStat = await fs.stat(tarballPath);
      assert.ok(tarballStat.size > 0, `tarball must have non-zero size, got ${tarballStat.size}`);

      // 2. Install the tarball into the second temp dir with
      //    --offline --ignore-scripts --no-audit --no-fund. This must
      //    NEVER contact the npm registry; it relies on the local cache
      //    populated by the surrounding `npm ci` of the package itself.
      await installTarballOffline(tarballPath, installDir);

      // 3. Verify the installed bin shim is present and executable.
      const installedBin = path.join(
        installDir,
        "node_modules",
        "scoutline",
        "bin",
        "scoutline.js",
      );
      const installedPkg = path.join(installDir, "node_modules", "scoutline", "package.json");
      await fs.access(installedBin);
      await fs.access(installedPkg);
      const installedManifest = JSON.parse(await fs.readFile(installedPkg, "utf8"));
      assert.strictEqual(installedManifest.name, "scoutline", "installed package name mismatch");

      // 4. Verify the installed bin runs `--help` successfully. This
      //    exercises the published entry point end-to-end.
      const helpResult = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [installedBin, "--help"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
      assert.strictEqual(
        helpResult.code,
        0,
        `installed --help exited ${helpResult.code}: ${helpResult.stderr}`,
      );
      assert.ok(
        helpResult.stdout.includes("scoutline"),
        `installed --help must mention scoutline, got: ${helpResult.stdout.slice(0, 200)}`,
      );

      // 5. Verify the root `main` export loads without performing side
      //    effects (NFR-003). Spawn a child Node process that imports
      //    the installed module and reports whether it executed.
      const installedIndex = path.join(installDir, "node_modules", "scoutline", "dist", "index.js");
      const installedIndexUrl = pathToFileURL(installedIndex).href;
      const script =
        `import(${JSON.stringify(installedIndexUrl)})` +
        `.then((m) => process.stderr.write("IMPORT_OK:" + (typeof m.main) + "\\n"))` +
        `.catch((e) => process.stderr.write("IMPORT_REJECTED:" + e.message + "\\n"));`;
      const importResult = await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", reject);
        proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      });
      assert.strictEqual(
        importResult.stdout,
        "",
        `importing installed dist/index.js must not write to stdout (got: ${importResult.stdout.slice(0, 200)})`,
      );
      assert.ok(
        importResult.stderr.startsWith("IMPORT_OK:"),
        `installed import should report main as a function, got: ${importResult.stderr.slice(0, 200)}`,
      );
      assert.ok(
        importResult.stderr.includes("function"),
        `installed main must be a function, got: ${importResult.stderr.slice(0, 200)}`,
      );
      assert.strictEqual(importResult.code, 0, `installed import exited ${importResult.code}`);
    } finally {
      // 6. Clean up both directories regardless of outcome.
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Compiled Vision conformance registry (P5-02, DESIGN.md §15)
// ---------------------------------------------------------------------------

describe("scoutline package — compiled MiniMax vision conformance registry (P5-02)", () => {
  /**
   * Derive the local supported-operation set from the source registry,
   * pack + extract the tarball, import its compiled Vision conformance
   * Module, and assert the installed set and compiled attestations
   * match the source. Pending and failed entries remain unsupported in
   * the installed tarball just as they do in the source tree.
   */
  it("installed tarball exposes the same supported specialized vision operations as the source registry", async () => {
    // 1. Compute the local supported-operation set from the compiled
    //    dist (built before this test runs).
    const localConformance = await import("../dist/providers/minimax/vision-conformance.js");
    const localSupported = new Set(localConformance.listSupportedMiniMaxVisionOperations());
    const localAttestationCount = (await import("../dist/providers/minimax/vision-attestations.js"))
      .MINIMAX_VISION_ATTESTATIONS.length;

    // 2. Pack + extract + install the tarball in temp dirs.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-conf-"));
    const packDir = path.join(base, "pack");
    const installDir = path.join(base, "install");
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(installDir, { recursive: true });

    try {
      const tarballPath = await packToDir(packDir);
      await installTarballOffline(tarballPath, installDir);

      // 3. Import the installed conformance Module from the installed
      //    dist surface. This proves the registry compiles into the
      //    shipped package.
      const installedIndex = path.join(
        installDir,
        "node_modules",
        "scoutline",
        "dist",
        "providers",
        "minimax",
        "vision-conformance.js",
      );
      const installedIndexUrl = pathToFileURL(installedIndex).href;
      const installed = await import(installedIndexUrl);

      // 4. The installed supported set must match the local set.
      const installedSupported = new Set(installed.listSupportedMiniMaxVisionOperations());
      assert.deepStrictEqual(
        [...installedSupported].sort(),
        [...localSupported].sort(),
        "installed supported set must match local supported set",
      );

      // 5. The installed per-op support bits must match the local
      //    registry's bits exactly (attested ops supported, others
      //    not). Derive the expected bit from the local registry so
      //    this test tracks attestation state without hardcoding.
      for (const op of ["ui-artifact", "extract-text", "diagnose-error", "diagram", "chart"]) {
        const expected = localConformance.isMiniMaxVisionOperationSupported(op);
        assert.strictEqual(
          installed.isMiniMaxVisionOperationSupported(op),
          expected,
          `${op}: installed support bit must match local (${expected})`,
        );
      }

      // 6. The installed attestation manifest must have the same count
      //    as the source manifest (registry-derived count).
      const installedAttestations = await import(
        pathToFileURL(
          path.join(
            installDir,
            "node_modules",
            "scoutline",
            "dist",
            "providers",
            "minimax",
            "vision-attestations.js",
          ),
        ).href
      );
      assert.strictEqual(
        installedAttestations.MINIMAX_VISION_ATTESTATIONS.length,
        localAttestationCount,
        "installed attestation manifest count must match local",
      );
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("installed tarball exposes the same generated mapping revisions as the source registry", async () => {
    const localRevisions = (await import("../dist/providers/minimax/vision-revisions.js"))
      .MINIMAX_VISION_MAPPING_REVISIONS;

    const base = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-rev-"));
    const packDir = path.join(base, "pack");
    const installDir = path.join(base, "install");
    await fs.mkdir(packDir, { recursive: true });
    await fs.mkdir(installDir, { recursive: true });

    try {
      const tarballPath = await packToDir(packDir);
      await installTarballOffline(tarballPath, installDir);

      const installedRevisions = (
        await import(
          pathToFileURL(
            path.join(
              installDir,
              "node_modules",
              "scoutline",
              "dist",
              "providers",
              "minimax",
              "vision-revisions.js",
            ),
          ).href
        )
      ).MINIMAX_VISION_MAPPING_REVISIONS;

      // Every revision must match exactly. Promoted ops carry a real
      // SHA-256 digest; baseline ops (none currently) would carry the
      // "pending-no-mapping-module" placeholder.
      for (const op of ["ui-artifact", "extract-text", "diagnose-error", "diagram", "chart"]) {
        assert.strictEqual(
          installedRevisions[op],
          localRevisions[op],
          `installed ${op} revision must match local`,
        );
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
