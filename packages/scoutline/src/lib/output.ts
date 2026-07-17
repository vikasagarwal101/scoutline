/**
 * Output formatting for Scoutline.
 *
 * P1-01 adds the pure, invocation-local API from DESIGN.md §3:
 *   OUTPUT_MODES, OutputMode, isOutputMode,
 *   formatSuccessOutput, formatErrorOutput.
 *
 * The legacy mutable API (setOutputMode / getOutputMode / outputSuccess /
 * outputError / output) is preserved as a compatibility surface for
 * Phase 1 command handlers and is removed in P1-10.
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
  return (
    typeof value === "string" &&
    (OUTPUT_MODES as readonly string[]).includes(value)
  );
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
    return JSON.stringify(
      { success: true, data, timestamp: now() },
      null,
      indent,
    );
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
    const presentations = (data as { presentations: Record<string, unknown> })
      .presentations;
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
    value !== null &&
    typeof value === "object" &&
    "message" in value &&
    "code" in value;

  if (isShapedError) {
    const err = value as {
      message: unknown;
      code: unknown;
      help?: unknown;
      statusCode?: unknown;
    };
    const rawError =
      typeof err.message === "string" ? err.message : String(err.message);
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
// Compatibility exports — kept temporarily for Phase 1 command handlers.
// P1-10 removes the mutable state and these side-effecting helpers; until
// then, command code in P1-04..P1-09 keeps compiling unchanged.
// ---------------------------------------------------------------------------

let outputMode: OutputMode =
  (typeof process !== "undefined" && process.env
    ? (process.env.ZAI_OUTPUT_MODE as OutputMode)
    : undefined) || "data";

export function setOutputMode(mode: OutputMode): void {
  outputMode = mode;
  if (typeof process !== "undefined" && process.env) {
    process.env.ZAI_OUTPUT_MODE = mode;
  }
}

export function getOutputMode(): OutputMode {
  return outputMode;
}

export function success<T>(data: T): SuccessResponse<T> {
  return {
    success: true,
    data,
    timestamp: Date.now(),
  };
}

export function error(
  message: string,
  code?: string,
  help?: string,
): ErrorResponse {
  return {
    success: false,
    error: message,
    ...(code && { code }),
    ...(help && { help }),
  };
}

export function output<T>(response: Response<T>): void {
  const pretty = outputMode === "pretty";
  console.log(JSON.stringify(response, null, pretty ? 2 : 0));
}

export function outputSuccess<T>(data: T): void {
  // Search-specific text formats; data is expected to be a pre-formatted string.
  if (
    outputMode === "compact" ||
    outputMode === "markdown" ||
    outputMode === "refs" ||
    outputMode === "tty"
  ) {
    if (typeof data === "string") {
      console.log(data);
      return;
    }
    console.log(JSON.stringify(data, null, 0));
    return;
  }
  if (outputMode === "data") {
    if (typeof data === "string") {
      console.log(data);
      return;
    }
    console.log(JSON.stringify(data, null, 0));
    return;
  }
  output(success(data));
}

export function outputError(
  message: string,
  code?: string,
  help?: string,
): void {
  const pretty = outputMode === "pretty";
  console.error(JSON.stringify(error(message, code, help), null, pretty ? 2 : 0));
  process.exit(1);
}
