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
 * are preserved verbatim; re-running is a zero diff. A pre-existing
 * UNWRAPPED pointer line is user-owned content — registration is a no-op
 * (never rewritten into the wrapped form).
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
  const hasManagedRegion = original.includes(wrapped);

  if (hasManagedRegion) return; // idempotent: search before mutate
  // Pre-existing UNWRAPPED pointer line: user-owned — hands off entirely.
  if (original.split("\n").includes(line)) return;

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
      next =
        original.endsWith("\n") || original === ""
          ? `${original}${wrapped}\n`
          : `${original}\n${wrapped}`;
    } else {
      lines.splice(insertAt, 0, wrapped);
      next = lines.join("\n");
    }
  } else {
    next =
      original.endsWith("\n") || original === ""
        ? `${original}${wrapped}\n`
        : `${original}\n${wrapped}`;
  }

  await backupIfPreExisting(filePath, existed, hasManagedRegion);
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
 * bump rewrites the region in place and bytes outside stay identical. A
 * foreign marker pair (inner content not ours) is user content — the
 * append paths leave it byte-untouched.
 */
export async function markerBlockInsert(options: MarkerBlockInsertOptions): Promise<void> {
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

  const block = [`${START_MARKER}<!-- scoutline:v${version} -->`, content, END_MARKER, ""].join(
    "\n",
  );

  if (original.includes(block)) return; // idempotent

  // Foreign marker-pair protection: scan pairs exactly like
  // stripManagedRegion — a pair that is not ours is foreign user content,
  // skipped, never rewritten. Ours = carries our version stamp right after
  // the start marker (content may have drifted — refresh still rewrites it
  // in place) or its inner content matches ours (version-stamp comments
  // stripped, same normalization stripManagedRegion applies). With no
  // region of ours we fall through to the append paths so foreign bytes
  // stay untouched.
  let regionStart = -1;
  let regionEnd = -1;
  let searchFrom = 0;
  for (;;) {
    const start = original.indexOf(START_MARKER, searchFrom);
    if (start === -1) break;
    const end = original.indexOf(END_MARKER, start);
    if (end === -1) break; // malformed — leave the rest untouched
    const inner = original.slice(start + START_MARKER.length, end);
    const isOurs =
      /^\s*<!-- scoutline:v/.test(inner) || // our version-stamped region, even with drifted text
      inner.replace(/<!--[^>]*-->/g, "").trim() === content.trim();
    if (isOurs) {
      regionStart = start;
      regionEnd = end;
      break;
    }
    searchFrom = end + END_MARKER.length; // foreign pair — hands off
  }
  const hasManagedRegion = regionStart !== -1;
  let next: string;
  if (regionStart !== -1) {
    // Region rewrite: replace markers-and-body in place, keep everything
    // else. A trailing newline after END_MARKER belongs to the block — but
    // only when the file itself ended with one (a no-EOL original must not
    // gain a newline through a rewrite; the strip must restore exact bytes).
    const before = original.slice(0, regionStart);
    let after = original.slice(regionEnd + END_MARKER.length);
    if (after.startsWith("\n")) after = after.slice(1);
    const glue = (part: string) => (part === "" || part.endsWith("\n") ? part : `${part}\n`);
    const tail = after === "" && !original.endsWith("\n") ? block.slice(0, -1) : block;
    next = `${glue(before)}${tail}${after}`;
  } else if (original === "") {
    next = block;
  } else if (original.endsWith("\n")) {
    next = `${original}${block}`;
  } else {
    next = `${original}\n${block.slice(0, -1)}`;
  }

  await backupIfPreExisting(filePath, existed, hasManagedRegion);
  await atomicReplaceFile(filePath, next);
}

export interface JsonArrayInsertOptions {
  filePath: string;
  /** Absolute pointer path appended to the target's JSON array (opencode instructions). */
  element: string;
}

function jsonInsertError(cause: string): Error {
  const error = new Error(
    `scoutline: opencode.json mutation produced invalid JSON — original restored (${cause})`,
  );
  error.name = "AgentRegistrationJsonError";
  return error;
}

const INSTRUCTIONS_KEY = '"instructions"';

/** String-aware walk from `[` at `openAt` to its matching `]`. */
function matchingBracketSpan(
  original: string,
  openAt: number,
): { openAt: number; closeAt: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openAt; i < original.length; i += 1) {
    const ch = original[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return { openAt, closeAt: i };
    }
  }
  return null;
}

/**
 * Locate the TOP-LEVEL `instructions` array's `[ ... ]` span, string-aware:
 * the `"instructions"` token counts as the key only at brace depth 1 (a
 * direct child of the root object) followed by `:` (then `[`). The same
 * text inside a string value or a nested object/array is skipped. Returns
 * null when no top-level instructions array exists (absent key).
 */
function findTopLevelInstructionsArray(
  original: string,
): { openAt: number; closeAt: number } | null {
  const root = original.indexOf("{");
  if (root === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = root; i < original.length; i += 1) {
    const ch = original[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth === 1 && original.startsWith(INSTRUCTIONS_KEY, i)) {
        let j = i + INSTRUCTIONS_KEY.length;
        while (j < original.length && /\s/.test(original[j]!)) j += 1;
        if (original[j] === ":") {
          let k = j + 1;
          while (k < original.length && /\s/.test(original[k]!)) k += 1;
          if (original[k] === "[") {
            const span = matchingBracketSpan(original, k);
            if (span) return span;
          }
        }
      }
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    }
  }
  return null;
}

/**
 * JSON array insert (opencode `instructions`, DESIGN D2): locate the array,
 * skip if the element is already present (idempotent), surgically insert
 * `,\n    "<element>"` before the closing `]` as TEXT (preserves all other
 * formatting); empty array inserts without the leading comma; absent key
 * inserts a new top-level `"instructions": ["<element>"]`; then JSON.parse
 * validates — failure restores the original bytes and rejects (init-time
 * registration exits non-zero; refresh contexts catch and degrade).
 */
export async function jsonArrayInsert(options: JsonArrayInsertOptions): Promise<void> {
  const { filePath, element } = options;
  let existed = true;
  let original: string;
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
    original = "";
  }

  let next: string;
  // JSON-safe encoding: the quoted+escaped token as it must appear in the
  // document text (backslash paths and other escape-requiring characters
  // round-trip); POSIX paths are byte-identical through the change.
  const encoded = JSON.stringify(element);
  const arrayRange = findTopLevelInstructionsArray(original);
  // Idempotency scoped to the instructions array: only early-return when the
  // array's own inner text contains the element (absent key → proceed below).
  if (arrayRange) {
    const inner = original.slice(arrayRange.openAt + 1, arrayRange.closeAt);
    if (inner.includes(encoded)) return; // idempotent: search before mutate
    const insertAt = arrayRange.closeAt; // before `]`
    if (inner.trim() === "") {
      // Empty array: no leading comma, and a ONE-LINE single element so
      // removal restores the bare `[]` byte-exactly (AC-8 reversal symmetry).
      next = `${original.slice(0, insertAt)}${encoded}${original.slice(insertAt)}`;
    } else {
      next = `${original.slice(0, insertAt)},\n    ${encoded}${original.slice(insertAt)}`;
    }
  } else if (original === "" || /^\{\s*\}$/.test(original.trim())) {
    // Absent key on a missing or empty object (including internal
    // whitespace like `{ }` / `{\n}`): mint the whole document.
    next = `{\n  "instructions": [${encoded}]\n}`;
  } else {
    // Absent key: insert a new top-level instructions element. Naive text
    // insertion could still produce unparseable JSON — validation below
    // catches that too (e.g. the original was already broken).
    next = original.replace(/\}\s*$/, `,\n  "instructions": [${encoded}]\n}`);
  }

  try {
    JSON.parse(next);
  } catch (error) {
    // No rollback write: nothing has touched the file yet (validation
    // precedes every write), and rewriting "original" back through a
    // utf8 round-trip could itself mangle non-UTF-8 bytes.
    throw jsonInsertError((error as Error).message);
  }

  await backupIfPreExisting(filePath, existed, false);
  await atomicReplaceFile(filePath, next);
}

export function backupPathFor(filePath: string): string {
  return `${filePath}.scoutline-bak`;
}

// ---------------------------------------------------------------------------
// Reversal engines (DESIGN D2: `init --unregister` disk-scan).
// NEVER restore from the `.scoutline-bak` — a user who edited the file
// since registration would lose their edits. Marker-strip always,
// restore never. The backup is disaster recovery only; unregister
// deletes it.
// ---------------------------------------------------------------------------

/**
 * Remove OUR managed region(s) from a file, preserving every other byte —
 * including marker pairs whose inner content is not ours (a user-authored
 * `<!-- scoutline:start --> … <!-- scoutline:end -->` block is foreign
 * user content; DESIGN D2 strips inserted regions by OUR markers AND our
 * content, never by markers alone). Deletes the file outright when nothing
 * survives the strip (registration itself created it). No-op on ENOENT.
 * Used by line AND block pointers — both wrap their bytes in the same
 * marker pair.
 */
export async function stripManagedRegion(filePath: string, expectedContent: string): Promise<void> {
  let original: string;
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    // Only absence is the expected pre-registration state; an unreadable
    // file (EACCES etc.) must surface, not silently pass as "already
    // clean" — the caller reports the failed reversal.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return; // absent — nothing to strip
  }
  let stripped = original;
  // Loop: multiple non-nested regions are tolerated; foreign pairs (inner
  // content not ours) are skipped, not stripped — keep scanning past them.
  let searchFrom = 0;
  for (;;) {
    const start = stripped.indexOf(START_MARKER, searchFrom);
    if (start === -1) break;
    const end = stripped.indexOf(END_MARKER, start);
    if (end === -1) break; // malformed — leave the rest untouched
    const inner = stripped.slice(start + START_MARKER.length, end).replace(/<!--[^>]*-->/g, ""); // version-stamp comments are ours, not content
    if (inner.trim() !== expectedContent.trim()) {
      searchFrom = end + END_MARKER.length; // foreign pair — hands off
      continue;
    }
    let from = start;
    let to = end + END_MARKER.length;
    // Swallow ONE newline boundary the insertion joined with, so an
    // untouched file returns byte-identical to its pre-registration bytes.
    // FOLLOWING newline first: on a CRLF file the preceding "\r\n" is the
    // file's own line ending — eating backwards through it strands a lone
    // "\r" — while the newline AFTER our region is always one we joined.
    if (stripped[to] === "\n") to += 1;
    else if (from > 0 && stripped[from - 1] === "\n") from -= 1;
    stripped = stripped.slice(0, from) + stripped.slice(to);
    searchFrom = Math.max(0, from - 1);
  }
  if (stripped.trim() === "") {
    // Nothing user-owned survives — the registration itself created this
    // file; its pre-registration state is absence.
    await fs.rm(filePath, { force: true });
    return;
  }
  await atomicReplaceFile(filePath, stripped);
}

/**
 * Remove `element` from the `instructions` array of a JSON file by exact
 * string match (D2 symmetry with `jsonArrayInsert`). No-op on ENOENT or
 * when the element is absent. String-aware scan keyed to the TOP-LEVEL
 * `instructions` key (shared walker with insert) so a `]` inside a string
 * cannot confuse it. Re-validates JSON before
 * writing; a parse failure after removal leaves the file untouched.
 */
export async function jsonArrayRemove(options: {
  filePath: string;
  element: string;
}): Promise<void> {
  const { filePath, element } = options;
  let original: string;
  try {
    original = await fs.readFile(filePath, "utf8");
  } catch (error) {
    // Mirror stripManagedRegion: ENOENT is absence; other I/O errors
    // propagate so a failed removal is reported, never assumed done.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return; // absent — nothing to remove
  }

  const arrayRange = findTopLevelInstructionsArray(original);
  if (!arrayRange) return; // no top-level instructions array — nothing to remove
  const { openAt, closeAt } = arrayRange;

  const needle = JSON.stringify(element); // quoted + escaped (Windows paths etc.)
  // Find the element as a whole JSON string token inside the array.
  for (let i = openAt + 1; i < closeAt; i += 1) {
    if (!original.startsWith(needle, i)) continue;
    // Splice back through any whitespace before the element; if a comma
    // sits before that whitespace (the appended-entry form
    // `,\n    "<element>"` jsonArrayInsert writes), swallow the comma too
    // so an untouched file reverses to its pre-registration bytes.
    let from = i;
    const inner = original.slice(openAt + 1, closeAt);
    if (inner.trim() === needle) {
      // The element is the array's ONLY member: restore a bare `[]` —
      // splicing the token alone would leave whitespace residue inside our
      // own region (and re-registration's empty-array fast path would see a
      // non-empty array).
      const candidate = `${original.slice(0, openAt + 1)}${original.slice(closeAt)}`;
      try {
        JSON.parse(candidate);
      } catch {
        return;
      }
      await atomicReplaceFile(filePath, candidate);
      return;
    }
    let f = from;
    while (f > openAt + 1 && /\s/.test(original[f - 1]!)) f -= 1;
    if (original[f - 1] === ",") from = f - 1;
    const candidate = original.slice(0, from) + original.slice(i + needle.length);
    try {
      JSON.parse(candidate);
    } catch {
      return; // never leave broken JSON behind; file untouched
    }
    await atomicReplaceFile(filePath, candidate);
    return;
  }
  // Element absent — no-op.
}
