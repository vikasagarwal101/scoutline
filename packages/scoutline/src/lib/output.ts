/**
 * Output formatting for Scoutline.
 *
 * This Module exposes the pure, invocation-local output contract from
 * DESIGN.md §3: OUTPUT_MODES, OutputMode, isOutputMode,
 * formatSuccessOutput, and formatErrorOutput. The pure `success` and
 * `error` response builders are retained as utility constructors.
 *
 * P1-10 removed the mutable output surface: there is no module-level output
 * mode, no mode setter/getter, no side-effecting success/error writers, no
 * output-mode environment mutation, and no console writes or process
 * termination here. Command presentation and process writes flow through
 * `invokeCommand` and the Node Adapter.
 */

export const OUTPUT_MODES = [
  "data",
  "json",
  "pretty",
  "compact",
  "markdown",
  "refs",
  "tty",
] as const;

export type OutputMode = (typeof OUTPUT_MODES)[number];

export interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
  timestamp: number;
}

export interface ErrorResponse {
  success: false;
  error: string;
  code?: string;
  help?: string;
}

export type Response<T = unknown> = SuccessResponse<T> | ErrorResponse;

export function isOutputMode(value: unknown): value is OutputMode {
  return typeof value === "string" && (OUTPUT_MODES as readonly string[]).includes(value);
}

/**
 * Strip credential-shaped substrings from a public-facing string.
 *
 * Applied to the `help` (and `error`) fields emitted by
 * `formatErrorOutput` so accidental credential leakage in error messages
 * is replaced with a redaction marker before it reaches stdout/stderr.
 * The set of patterns matches DESIGN.md §16 (Z_AI_API_KEY, ZAI_API_KEY,
 * MINIMAX_API_KEY, Bearer authorization values, x-api-key values, and
 * embedded credential strings). The full secret value is dropped, not
 * echoed.
 */
function redactCredentialString(input: string): string {
  let result = input;
  // Bearer authorization values (anywhere in the string).
  result = result.replace(/Bearer\s+\S+/g, "[REDACTED]");
  // x-api-key values.
  result = result.replace(/x-api-key\s*[=:]\s*\S+/gi, "[REDACTED]");
  // Known credential env-var assignments.
  result = result.replace(/Z_AI_API_KEY\s*=\s*\S+/g, "[REDACTED]");
  result = result.replace(/ZAI_API_KEY\s*=\s*\S+/g, "[REDACTED]");
  result = result.replace(/MINIMAX_API_KEY\s*=\s*\S+/g, "[REDACTED]");
  return result;
}

/**
 * Pure success formatter.
 *
 * - `data` mode emits the raw JSON-encoded data (no success envelope).
 * - `json` / `pretty` modes emit the success envelope with the timestamp
 *   taken from the injected `now` (defaults to `Date.now`). `pretty` uses
 *   2-space indentation.
 * - Text-oriented modes (`compact`, `markdown`, `refs`, `tty`) return the
 *   explicitly selected command presentation override when `data` carries
 *   one (i.e. `data.presentations[mode]` is a string). Otherwise they
 *   fall back to the JSON-encoded data.
 *
 * The function performs no I/O and mutates no shared state.
 */
export function formatSuccessOutput<T>(
  data: T,
  mode: OutputMode,
  now: () => number = Date.now,
): string {
  if (mode === "data") {
    return JSON.stringify(data);
  }

  if (mode === "json" || mode === "pretty") {
    const indent = mode === "pretty" ? 2 : 0;
    return JSON.stringify({ success: true, data, timestamp: now() }, null, indent);
  }

  // Text-oriented modes: prefer an explicitly selected command
  // presentation override carried on `data.presentations`.
  if (
    data !== null &&
    typeof data === "object" &&
    "presentations" in data &&
    (data as { presentations?: unknown }).presentations !== null &&
    typeof (data as { presentations?: unknown }).presentations === "object"
  ) {
    const presentations = (data as { presentations: Record<string, unknown> }).presentations;
    const override = presentations[mode];
    if (typeof override === "string") {
      return override;
    }
  }

  return JSON.stringify(data);
}

/**
 * Pure error formatter. Inspects the value through duck typing so this
 * Module does not have to import from `./errors.js` (avoids a circular
 * dependency with the error hierarchy).
 *
 * Recognises a ScoutlineError-shaped object (one carrying `message` and
 * `code`) and surfaces `help` and `statusCode` when present. Plain
 * `Error` instances and unknown values fall through to `UNKNOWN_ERROR`.
 * `pretty` mode indents; all other modes emit compact JSON.
 *
 * The public envelope contains only the documented fields — `success`,
 * `error`, `code`, optional `help`, optional `statusCode` — so stack,
 * cause, raw response body, and any non-envelope property of the input
 * are never serialised. Credential-shaped substrings inside `help` and
 * `error` are redacted.
 */
export function formatErrorOutput(value: unknown, mode: OutputMode): string {
  const indent = mode === "pretty" ? 2 : 0;

  let payload: Record<string, unknown>;

  const isShapedError =
    value !== null && typeof value === "object" && "message" in value && "code" in value;

  if (isShapedError) {
    const err = value as {
      message: unknown;
      code: unknown;
      help?: unknown;
      statusCode?: unknown;
    };
    const rawError = typeof err.message === "string" ? err.message : String(err.message);
    payload = {
      success: false,
      error: redactCredentialString(rawError),
      code: typeof err.code === "string" ? err.code : "UNKNOWN_ERROR",
    };
    if (typeof err.help === "string" && err.help.length > 0) {
      payload.help = redactCredentialString(err.help);
    }
    if (typeof err.statusCode === "number") {
      payload.statusCode = err.statusCode;
    }
  } else if (value instanceof Error) {
    payload = {
      success: false,
      error: redactCredentialString(value.message),
      code: "UNKNOWN_ERROR",
    };
  } else {
    payload = {
      success: false,
      error: redactCredentialString(String(value)),
      code: "UNKNOWN_ERROR",
    };
  }

  return JSON.stringify(payload, null, indent);
}

// ---------------------------------------------------------------------------
// Pure response builders. These construct plain response objects and perform
// no I/O. They are retained as utility constructors; the side-effecting
// mutable output surface (mode setter/getter, the success/error writers, the
// module-level mode variable, output-mode env mutation, and process
// termination) was removed in P1-10. Command presentation and process writes
// now flow exclusively through `invokeCommand` and the Node Adapter.
// ---------------------------------------------------------------------------

export function success<T>(data: T): SuccessResponse<T> {
  return {
    success: true,
    data,
    timestamp: Date.now(),
  };
}

export function error(message: string, code?: string, help?: string): ErrorResponse {
  return {
    success: false,
    error: message,
    ...(code && { code }),
    ...(help && { help }),
  };
}
