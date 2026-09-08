import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicReplaceFile } from "../config-store.js";

/** Marker pair wrapping every managed region (PRD AC-5, GitNexus precedent). */
export const START_MARKER = "<!-- scoutline:start -->";
export const END_MARKER = "<!-- scoutline:end -->";

/**
 * Shared mutation rails (DESIGN D2):
 *  - search-before-mutate idempotency;
 *  - `<file>.scoutline-bak` copy ONLY on first mutation of a PRE-EXISTING file
 *    we have not already marked: files we created and refreshes that find our
 *    markers mint no backup (nothing pre-existing to protect);
 *  - tmp + atomicReplaceFile rename (never leave a half-written config).
 */
async function backupIfPreExisting(
  filePath: string,
  existed: boolean,
  markerPresent: boolean,
): Promise<void> {
  if (!existed || markerPresent) return;
  const backupPath = `${filePath}.scoutline-bak`;
  try {
    await fs.access(backupPath);
  } catch {
    await fs.copyFile(filePath, backupPath);
  }
}

export interface LineInsertOptions {
  filePath: string;
  line: string;
  /** Line convention locating the existing rules list (e.g. /^@rules\//). */
  convention?: RegExp;
}

/**
 * Line insert (claude `@rules/`, gemini `@` import in GEMINI.md):
 * marker-wrapped single line appended under the existing rules list when
 * the convention matches, else at file end. Bytes outside the wrapped line
 * are preserved verbatim; re-running is a zero diff.
 */
export async function lineInsert(options: LineInsertOptions): Promise<void> {
  const { filePath, line, convention } = options;
  let existed = true;
  let original: string;
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
    original = "";
  }

  const wrapped = `${START_MARKER}\n${line}\n${END_MARKER}`;

  if (original.includes(wrapped)) return; // idempotent: search before mutate
  // ponytail: matching an already-present unwrapped line upgrades it to the
  // marker-wrapped form; acceptable while only we insert pointer lines.
  if (original.split("\n").includes(line)) {
    const upgraded = original
      .split("\n")
      .map((candidate) => (candidate === line ? wrapped : candidate))
      .join("\n");
    await backupIfPreExisting(filePath, existed, original.includes(START_MARKER));
    await atomicReplaceFile(filePath, upgraded);
    return;
  }

  let next: string;
  if (convention) {
    const lines = original.split("\n");
    let insertAt = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (convention.test(lines[i]!)) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt === -1) {
      next = original.endsWith("\n") || original === ""
        ? `${original}${wrapped}\n`
        : `${original}\n${wrapped}\n`;
    } else {
      lines.splice(insertAt, 0, wrapped);
      next = lines.join("\n");
    }
  } else {
    next = original.endsWith("\n") || original === ""
      ? `${original}${wrapped}\n`
      : `${original}\n${wrapped}\n`;
  }

  await backupIfPreExisting(filePath, existed, original.includes(START_MARKER));
  await atomicReplaceFile(filePath, next);
}

export interface MarkerBlockInsertOptions {
  filePath: string;
  content: string;
  version: string;
}

/**
 * Marker block (codex AGENTS.md augment, qwen QWEN.md create-or-augment):
 * `<!-- scoutline:start --><!-- scoutline:v<version> -->` … rule text …
 * `<!-- scoutline:end -->`. Same-version re-run is a zero diff; a version
 * bump rewrites the region in place and bytes outside stay identical.
 */
export async function markerBlockInsert(
  options: MarkerBlockInsertOptions,
): Promise<void> {
  const { filePath, content, version } = options;
  let existed = true;
  let original: string;
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
    original = "";
  }

  const block = [
    `${START_MARKER}<!-- scoutline:v${version} -->`,
    content,
    END_MARKER,
    "",
  ].join("\n");

  if (original.includes(block)) return; // idempotent

  const startIndex = original.indexOf(START_MARKER);
  const endIndex = original.indexOf(END_MARKER);
  let next: string;
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    // Region rewrite: replace markers-and-body in place, keep everything
    // else — a trailing newline after END_MARKER belongs to the block.
    const before = original.slice(0, startIndex);
    let after = original.slice(endIndex + END_MARKER.length);
    if (after.startsWith("\n")) after = after.slice(1);
    const glue = (part: string) => (part === "" || part.endsWith("\n") ? part : `${part}\n`);
    next = `${glue(before)}${block}${after === "" ? after : `${after}`}`;
  } else if (original === "") {
    next = block;
  } else if (original.endsWith("\n")) {
    next = `${original}${block}`;
  } else {
    next = `${original}\n${block}`;
  }

  await backupIfPreExisting(filePath, existed, original.includes(START_MARKER));
  await atomicReplaceFile(filePath, next);
}

export function backupPathFor(filePath: string): string {
  return `${filePath}.scoutline-bak`;
}
