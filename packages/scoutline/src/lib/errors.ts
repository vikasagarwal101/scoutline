/**
 * Error types and handling for Scoutline
 */

export class ZaiError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public help?: string,
  ) {
    super(message);
    this.name = "ZaiError";
  }
}

export class AuthError extends ZaiError {
  constructor(message: string) {
    super(message, "AUTH_ERROR", 401, "Check your Z_AI_API_KEY is valid and has sufficient quota");
  }
}

export class ValidationError extends ZaiError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
  }
}

export class ApiError extends ZaiError {
  constructor(message: string, statusCode: number) {
    super(message, "API_ERROR", statusCode);
  }
}

export class NetworkError extends ZaiError {
  constructor(message: string) {
    super(message, "NETWORK_ERROR", undefined, "Check your internet connection");
  }
}

export class TimeoutError extends ZaiError {
  constructor(timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs}ms`,
      "TIMEOUT_ERROR",
      undefined,
      "Try again or increase timeout with Z_AI_TIMEOUT env var",
    );
  }
}

export class FileError extends ZaiError {
  constructor(message: string, help?: string) {
    super(message, "FILE_ERROR", undefined, help);
  }
}

export function formatErrorOutput(error: unknown): string {
  const pretty = (process.env.ZAI_OUTPUT_MODE || "") === "pretty";
  if (error instanceof ZaiError) {
    return JSON.stringify(
      {
        success: false,
        error: error.message,
        code: error.code,
        ...(error.help && { help: error.help }),
      },
      null,
      pretty ? 2 : 0,
    );
  }

  if (error instanceof Error) {
    return JSON.stringify(
      {
        success: false,
        error: error.message,
        code: "UNKNOWN_ERROR",
      },
      null,
      pretty ? 2 : 0,
    );
  }

  return JSON.stringify(
    {
      success: false,
      error: String(error),
      code: "UNKNOWN_ERROR",
    },
    null,
    pretty ? 2 : 0,
  );
}
