/**
 * Test helper: read fixture files under tests/fixtures/.
 *
 * JSON files are parsed; everything else is returned as a Buffer.
 * Paths are constrained to tests/fixtures/ to prevent accidental reads
 * of real filesystem locations.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "..", "fixtures");

function resolve(...segments) {
  const resolved = path.resolve(FIXTURE_ROOT, ...segments);
  // Containment check: must stay inside the fixtures root.
  if (
    resolved !== FIXTURE_ROOT &&
    !resolved.startsWith(FIXTURE_ROOT + path.sep)
  ) {
    throw new Error(`Fixture path escapes fixtures root: ${resolved}`);
  }
  return resolved;
}

export function readFixture(...segments) {
  const filePath = resolve(...segments);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return fs.readFile(filePath, "utf8").then((raw) => JSON.parse(raw));
  }
  return fs.readFile(filePath);
}

export async function readFixtureText(...segments) {
  const filePath = resolve(...segments);
  return fs.readFile(filePath, "utf8");
}

export async function readFixtureBuffer(...segments) {
  const filePath = resolve(...segments);
  return fs.readFile(filePath);
}

export function fixturePath(...segments) {
  return resolve(...segments);
}
