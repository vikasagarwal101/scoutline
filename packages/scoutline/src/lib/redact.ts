/**
 * Recursive Provider credential redaction (DESIGN.md §16).
 *
 * This Module is the single source of truth for stripping Provider
 * credentials before any value leaves Scoutline's outward boundaries:
 * formatted errors, cached metadata, quota failures, diagnostics output,
 * and fatal shell errors.
 *
 * Redaction properties (Phase 4 P4-01):
 *   - Case-insensitive for the canonical credential-shaped keys.
 *   - Recursive through nested arrays and plain objects.
 *   - Non-mutating — the original input is never modified.
 *   - Secret-aware — every configured secret value is replaced inside
 *     any string the value tree reaches, not just the configured key.
 *   - Empty-safe — empty strings are never treated as a replacement token.
 *
 * The Module retains the legacy `redactSecrets(value, apiKey?)` and
 * `redactTool(tool)` exports so existing call sites keep compiling.
 * New code should pass an explicit array of secrets so every Provider's
 * credential is covered in one pass.
 */

import type { Tool } from "@utcp/sdk";

/**
 * Canonical credential-shaped key names. Lowercased so case-insensitive
 * matching is a one-step compare. Covers every name DESIGN.md §16
 * enumerates plus the common HTTP header aliases.
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "api_key",
  "apikey",
  "access_token",
  "token",
  "z_ai_api_key",
  "zai_api_key",
  "minimax_api_key",
]);

const REDACTED = "[REDACTED]";

/**
 * Replace credential-shaped substrings inside a single string. Useful
 * for error messages and load-failure texts where the value is a flat
 * string rather than a structured object.
 *
 * Replaces:
 *   - Bearer authorization values (any case).
 *   - x-api-key assignments (any case; `=`, `:`, or whitespace as the
 *     key/value separator — covers both `x-api-key=value` and
 *     `x-api-key value`).
 *   - Z_AI_API_KEY, ZAI_API_KEY, MINIMAX_API_KEY assignments.
 *   - The literal credentials passed in `extraSecrets` (each value is
 *     replaced wherever it appears; empty strings are skipped).
 */
export function redactCredentialString(input: string, extraSecrets?: string | string[]): string {
  if (typeof input !== "string") return input;
  let result = input;
  result = result.replace(/Bearer\s+\S+/gi, REDACTED);
  // Fixup C — W3: the class accepts either `=`, `:`, or any whitespace
  // as the key/value separator. The trailing `\S+` consumes the secret
  // value; the entire `key + separator + value` span is replaced with
  // the redaction marker.
  result = result.replace(/x-api-key[\s=:]+[^\s,;"'`]+/gi, REDACTED);
  result = result.replace(/Z_AI_API_KEY\s*=\s*\S+/gi, REDACTED);
  result = result.replace(/ZAI_API_KEY\s*=\s*\S+/gi, REDACTED);
  result = result.replace(/MINIMAX_API_KEY\s*=\s*\S+/gi, REDACTED);
  // Embedded credential substrings inside URLs, e.g.
  // `https://user:secret@host/path`. Catches both `https://` and
  // `http://` schemes and replaces the entire URL with the marker so
  // the user info does not leak.
  result = result.replace(/https?:\/\/[^\s/:]+:[^\s@\/]+@[^\s/]+/gi, REDACTED);
  const secrets = normalizeSecrets(extraSecrets);
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    // Escape regex meta characters so a secret containing characters
    // like `.` or `+` does not accidentally broaden the replacement.
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(escaped, "g"), REDACTED);
  }
  return result;
}

/**
 * Normalise the `secrets` argument to a deduplicated array of
 * non-empty strings. A `undefined` argument yields an empty list;
 * a single string yields `[string]`; an array yields the filtered
 * list.
 */
function normalizeSecrets(secrets?: string | string[]): string[] {
  if (secrets === undefined) return [];
  const list = Array.isArray(secrets) ? secrets : [secrets];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    if (item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Resolve the configured Provider credential values from the current
 * process environment. Returned values are deduplicated and empty
 * entries skipped, so callers can pass the result directly to
 * {@link redactSecrets}.
 */
export function configuredSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: Array<string | undefined> = [
    env.Z_AI_API_KEY,
    env.ZAI_API_KEY,
    env.MINIMAX_API_KEY,
  ];
  return normalizeSecrets(candidates.filter((c): c is string => typeof c === "string"));
}

/**
 * Recursively redact credential values from an arbitrary tree.
 *
 * Accepts either a single string (back-compat overload) or an array of
 * secret values. Returns a NEW value tree; the input is never mutated.
 *
 * Key matching is case-insensitive over {@link CREDENTIAL_KEYS}. Plain
 * objects and arrays are descended into. Other object kinds (Date,
 * typed arrays, class instances) are returned as-is so their internal
 * state is not reflected.
 */
export function redactSecrets(value: unknown, secrets?: string | string[]): unknown {
  const normalized = normalizeSecrets(secrets);

  // Fast path: primitive value or null/undefined.
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") {
    return redactCredentialString(value as string, normalized);
  }
  if (t !== "object") return value;

  // Recurse through arrays.
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, normalized));
  }

  // Skip exotic non-plain objects: Date, TypedArrays, Map, Set,
  // class instances. Plain objects descend; everything else is left
  // untouched to avoid reflecting internal state.
  if (!isPlainObject(value)) {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactSecrets(input[key], normalized);
  }
  return output;
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Redact credential-shaped fields from a Tool's metadata tree.
 *
 * Back-compat: when called with a single argument the function reads
 * the configured Provider credentials from the current process
 * environment. When called with an explicit secrets argument, the
 * caller's value is used instead.
 */
export function redactTool(tool: Tool, secrets?: string | string[]): Tool {
  const resolved = secrets === undefined
    ? configuredSecrets()
    : normalizeSecrets(secrets);
  const clone = JSON.parse(JSON.stringify(tool)) as Tool;
  return redactSecrets(clone, resolved) as Tool;
}
