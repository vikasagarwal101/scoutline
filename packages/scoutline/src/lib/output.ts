/**
 * Output formatting for Scoutline
 */

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

export type OutputMode = "data" | "json" | "pretty" | "compact" | "markdown" | "refs" | "tty";

let outputMode: OutputMode = (process.env.ZAI_OUTPUT_MODE as OutputMode) || "data";

export function setOutputMode(mode: OutputMode): void {
  outputMode = mode;
  process.env.ZAI_OUTPUT_MODE = mode;
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

export function error(message: string, code?: string, help?: string): ErrorResponse {
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

export function outputError(message: string, code?: string, help?: string): void {
  const pretty = outputMode === "pretty";
  console.error(JSON.stringify(error(message, code, help), null, pretty ? 2 : 0));
  process.exit(1);
}
