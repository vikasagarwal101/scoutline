/**
 * Library exports for programmatic usage.
 *
 * `formatErrorOutput` lives in `./output.js` (DESIGN.md §3, canonical
 * invocation-local 2-arg form). The errors-module re-export below is
 * explicit; the canonical 2-arg `formatErrorOutput` from `./output.js`
 * wins through `export *` below.
 */

export * from "./config.js";
export {
  type ScoutlineErrorCode,
  type ScoutlineErrorOptions,
  ScoutlineError,
  ZaiError,
  ValidationError,
  ConfigurationError,
  UnsupportedCapabilityError,
  UnsupportedOptionError,
  AuthError,
  ApiError,
  NetworkError,
  TimeoutError,
  FileError,
  QuotaError,
  isRetryableError,
  getErrorExitCode,
} from "./errors.js";
export * from "./output.js";
export * from "./image.js";
export * from "./api-client.js";
export * from "./mcp-client.js";