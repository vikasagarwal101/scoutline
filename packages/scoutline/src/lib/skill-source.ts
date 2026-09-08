import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * Resolve the package-resident agent skill directory at runtime.
 *
 * Located "beside dist/": the compiled module lives at
 * <package>/dist/lib/skill-source.js, so walking up from
 * fileURLToPath(import.meta.url) reaches the package root without
 * consulting process.cwd() — resolution works identically from the
 * repo checkout and an installed package layout.
 */
export function resolveSkillSourceDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // dist/lib/ -> package root (defensive against nested output dirs)
  let dir = moduleDir;
  while (path.basename(dir) !== "dist" && path.dirname(dir) !== dir) {
    dir = path.dirname(dir);
  }
  const packageRoot = path.dirname(dir);
  return path.join(packageRoot, "skills", "scoutline");
}
