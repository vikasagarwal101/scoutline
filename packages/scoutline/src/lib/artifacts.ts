/**
 * Artifact store core (save-artifacts epic, ticket T1).
 *
 * Three primitives every later save/history ticket builds on:
 *   - `newRequestId(now)` — `<UTC compact>-<4 lowercase hex>` (e.g.
 *     `20260829T142233Z-7f3a`). Timestamp from the INJECTED `now` (repo
 *     time-injection rule — never `Date.now()` for the timestamp part),
 *     hex tail from `crypto.randomBytes(2)` (injectable for hermetic
 *     tests). Lexicographically sortable; filesystem-safe.
 *   - `resolveArtifactsDir(env)` — `SCOUTLINE_ARTIFACTS_DIR` wins, else
 *     `<resolveConfigRootPure(env)>/artifacts`.
 *   - `writeArtifact(dir, requestId, content, { format, force })` — an
 *     atomic artifact write that REFUSES overwrites: the pre-check the
 *     `atomicReplaceFile` primitive deliberately lacks. The refusal leaves
 *     an existing target byte-identical (checked before any write); with
 *     `force` the replacement rides the same atomic rename.
 */
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  atomicReplaceFile,
  resolveConfigRootPure,
  type ConfigRootEnvironment,
  type ConfigRootPlatform,
} from "./config-store.js";
import { FileError } from "./errors.js";

/** Report format of a saved artifact (spec: `--save-format json|markdown`). */
export type ArtifactFormat = "json" | "markdown";

/** Environment keys {@link resolveArtifactsDir} reads. */
export interface ArtifactsDirEnvironment extends ConfigRootEnvironment {
  readonly SCOUTLINE_ARTIFACTS_DIR?: string;
}

/** Byte source for the request-id hex tail; defaults to crypto.randomBytes. */
export type RandomBytesSource = (size: number) => Uint8Array;

/** UTC compact timestamp `YYYYMMDDTHHMMSSZ` — fixed width, lex-sortable. */
function utcCompactTimestamp(now: Date): string {
  const pad2 = (value: number) => String(value).padStart(2, "0");
  return (
    `${String(now.getUTCFullYear()).padStart(4, "0")}` +
    `${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`
  );
}

/**
 * Build a request id from the injected instant: `<UTC compact>-<4 hex>`,
 * e.g. `20260829T142233Z-7f3a`. The hex tail comes from two random bytes
 * per call, so ids generated within the same second still differ.
 * Sorting ids lexicographically sorts them chronologically (same-second
 * ids tie — order between them is not defined).
 */
export function newRequestId(
  now: Date | number,
  randomBytes: RandomBytesSource = cryptoRandomBytes,
): string {
  const bytes = randomBytes(2);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${utcCompactTimestamp(new Date(now))}-${hex}`;
}

/**
 * Artifacts root: `SCOUTLINE_ARTIFACTS_DIR` (canonical SCOUTLINE_* name, no
 * legacy alias) wins; otherwise the config root's `artifacts/` sibling.
 * Pure — the caller supplies env and platform; the convenience wrapper is
 * left to the command layer (T2/T3) so tests never touch process.env.
 */
export function resolveArtifactsDir(
  env: ArtifactsDirEnvironment,
  platform: ConfigRootPlatform = { homedir: os.homedir() },
): string {
  return (
    env.SCOUTLINE_ARTIFACTS_DIR || path.join(resolveConfigRootPure(env, platform), "artifacts")
  );
}

export interface WriteArtifactOptions {
  /** Report extension; `"json"` (default) or `"markdown"` (`.md`). */
  readonly format?: ArtifactFormat;
  /** true → replace an existing target via the atomic path; false → refuse. */
  readonly force?: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Write one master artifact `<artifactsDir>/<requestId>.json|.md` through
 * {@link atomicReplaceFile} so the 0700-dir / 0600-temp / fsync / rename
 * discipline is inherited, never reimplemented. The one addition that
 * primitive lacks: without `force`, an existing target throws
 * {@link FileError} (`FILE_ERROR`, exit 1 — owner ruling, no new code)
 * BEFORE any write, leaving the file byte-identical. Resolves with the
 * target path (the later log's `masterPath`).
 */
export async function writeArtifact(
  dir: string,
  requestId: string,
  content: string,
  options: WriteArtifactOptions = {},
): Promise<string> {
  const extension = options.format === "markdown" ? "md" : "json";
  const target = path.join(dir, `${requestId}.${extension}`);
  if (!options.force && (await fileExists(target))) {
    throw new FileError(
      `Refusing to overwrite existing artifact: ${target}`,
      "Pass --save-force to overwrite the existing artifact.",
    );
  }
  await atomicReplaceFile(target, content);
  return target;
}
