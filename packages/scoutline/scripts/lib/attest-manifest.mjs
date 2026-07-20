#!/usr/bin/env node
/**
 * Phase 5 P5-03 — MiniMax specialized Vision attestation manifest helpers.
 *
 * Pure (no I/O at import, no Provider calls, no global state) helpers for
 * parsing and mutating the compiled attestation manifest
 * `src/providers/minimax/vision-attestations.ts` and validating live-state
 * flips in `src/providers/minimax/vision-conformance.ts`.
 *
 * Consumed by:
 *   - scripts/attest-minimax-vision.mjs (P5-03)
 *   - tests/attest-minimax-vision-helpers.test.js (this commit)
 *
 * Design rules:
 *   - Manifest helpers accept content as a string and return updated
 *     content. They never read or write files. Callers (the script)
 *     handle persistence.
 *   - The brace-counting parser is intentionally defensive: it handles
 *     nested braces inside `assertions: [...]`, escaped characters
 *     inside string literals, line and block comments, and template
 *     literals — even though the manifest only uses the first two in
 *     practice. This makes the parser robust to future schema versions.
 *   - Flip-state validation is a pure function of (currentState, refresh)
 *     so the rules can be tested without touching the conformance file.
 */

/**
 * Locate the manifest array literal span: the `[` that opens the
 * assignment value (after `=`) and the matching `];` that closes it.
 * Returns `{ openIdx, closeIdx }` as indices into `content`, or throws
 * if the manifest shape cannot be found. Locating via `= [` (not the
 * first `[` after the export name) avoids matching the `[` in the
 * `VisionAttestation[]` type annotation.
 */
export function locateManifestSpan(content) {
  const exportIdx = content.indexOf("MINIMAX_VISION_ATTESTATIONS");
  if (exportIdx === -1) {
    throw new Error("could not locate MINIMAX_VISION_ATTESTATIONS export");
  }
  const eqIdx = content.indexOf("=", exportIdx);
  if (eqIdx === -1) {
    throw new Error("could not locate manifest assignment '='");
  }
  const openIdx = content.indexOf("[", eqIdx);
  if (openIdx === -1) {
    throw new Error("could not locate manifest array literal '['");
  }
  const closeIdx = content.lastIndexOf("];");
  if (closeIdx === -1 || closeIdx < openIdx) {
    throw new Error("could not locate manifest array close '];'");
  }
  return { openIdx, closeIdx };
}

/**
 * Skip over a single- or double-quoted string literal starting at
 * `start` (which must point at the opening quote). Returns the index
 * one past the closing quote. Handles backslash escapes (so `\"`,
 * `\\`, `\n`, etc. do not terminate the string early).
 */
function skipString(body, start) {
  const quote = body[start];
  let i = start + 1;
  while (i < body.length) {
    if (body[i] === "\\") {
      i += 2;
      continue;
    }
    if (body[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return body.length;
}

/**
 * Skip over a backtick-delimited template literal starting at `start`
 * (which must point at the opening backtick). Returns the index one
 * past the closing backtick. Recurses into `${ ... }` expressions so
 * braces inside them are not counted by the outer brace walker.
 */
function skipTemplateLiteral(body, start) {
  let i = start + 1;
  while (i < body.length) {
    if (body[i] === "\\") {
      i += 2;
      continue;
    }
    if (body[i] === "`") return i + 1;
    if (body[i] === "$" && body[i + 1] === "{") {
      const close = findMatchingClose(body, i + 1);
      if (close === -1) return body.length;
      i = close;
      continue;
    }
    i++;
  }
  return body.length;
}

/**
 * Given that `body[openIdx]` is an opening `{`, return the index one
 * past the matching `}`. Skips over string literals, template
 * literals, line comments (`// ...`), and block comments
 * (`/* ... *\/`) so braces inside them are not counted. Returns -1 if
 * the matching close brace is not found.
 */
function findMatchingClose(body, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < body.length) {
    const ch = body[i];
    if (ch === "{") {
      depth++;
      i++;
    } else if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) return i;
    } else if (ch === '"' || ch === "'") {
      i = skipString(body, i);
    } else if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl + 1;
    } else if (ch === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i);
      i = end === -1 ? body.length : end + 2;
    } else if (ch === "`") {
      i = skipTemplateLiteral(body, i);
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Remove the existing attestation object literal for `operation` from
 * the compiled manifest, along with its trailing comma and any
 * inter-entry whitespace. Returns the updated source content. No-op
 * (returns input unchanged) when the entry is absent.
 *
 * Walks the manifest array body with a brace-counting parser that
 * finds each entry's opening `{` and tracks `{`/`}` depth to locate
 * the matching close. This naturally handles any level of nesting —
 * including the `assertions: [{ id: "...", passed: true }, ...]`
 * arrays inside each entry — whereas a non-greedy regex on `[^}]*?`
 * would terminate at the first inner `}`.
 */
export function removeAttestationFromManifest(content, operation) {
  const { openIdx, closeIdx } = locateManifestSpan(content);
  const arrayStart = openIdx + 1;
  const arrayEnd = closeIdx;
  const body = content.slice(arrayStart, arrayEnd);

  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    if (body[i] !== "{") {
      // Unexpected non-brace token (e.g. a stray comma). Skip
      // defensively rather than aborting — a malformed manifest
      // should still produce a no-op result for the absent-op case.
      i++;
      continue;
    }
    const entryClose = findMatchingClose(body, i);
    if (entryClose === -1) break;
    const entry = body.slice(i, entryClose);
    const opMatch = entry.match(/operation:\s*"([^"]+)"/);
    if (opMatch && opMatch[1] === operation) {
      // Skip the entry's trailing comma + inter-entry whitespace in the
      // original content so the surrounding entries (if any) butt up
      // against the array boundaries.
      let sliceEnd = arrayStart + entryClose;
      while (
        sliceEnd < content.length &&
        (content[sliceEnd] === "," ||
          content[sliceEnd] === " " ||
          content[sliceEnd] === "\n" ||
          content[sliceEnd] === "\t" ||
          content[sliceEnd] === "\r")
      ) {
        sliceEnd++;
      }
      return content.slice(0, arrayStart + i) + content.slice(sliceEnd);
    }
    i = entryClose;
  }
  return content;
}

/**
 * Validate whether the operation's live state can be flipped to
 * "pass". Pure function of (currentState, refresh); the caller
 * (script) extracts `currentState` from the conformance file.
 *
 * Refusal semantics (DESIGN.md §15 + C3 follow-up):
 *   - "fail"   → always refuse (deliberate regression; caller must
 *                clear the value manually before re-attesting).
 *   - "pass"   → refuse unless refresh=true (re-verifying a passing
 *                operation without --refresh is operator error; the
 *                C3 follow-up allows pass → pass with --refresh).
 *   - "pending" → always allow (normal attestation flow).
 *   - anything else → refuse defensively (unknown state should not
 *                    silently pass the gate).
 *
 * Returns `{ ok: true }` when the flip is allowed, or
 * `{ ok: false, reason }` when it is refused. The caller surfaces
 * `reason` to the operator verbatim.
 */
export function canFlipLiveState(currentState, refresh) {
  if (currentState === "fail") {
    return {
      ok: false,
      reason:
        'refusing to flip live state: current value is "fail" (clear the deliberate-regression state manually before re-attesting)',
    };
  }
  if (currentState === "pass" && !refresh) {
    return {
      ok: false,
      reason:
        'refusing to flip live state: current value is "pass" (pass --refresh to re-verify)',
    };
  }
  if (currentState !== "pending" && currentState !== "pass") {
    return {
      ok: false,
      reason: `refusing to flip live state: current value is ${JSON.stringify(
        currentState,
      )} (not a recognized state)`,
    };
  }
  return { ok: true };
}