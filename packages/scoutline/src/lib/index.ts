/**
 * Library exports for programmatic usage.
 *
 * `formatErrorOutput` lives in `./output.js` (DESIGN.md §3, canonical
 * invocation-local 2-arg form). `./errors.js` keeps a legacy 1-arg
 * compat version that Phase 1 command handlers import directly until
 * P1-10 migrates them. To avoid a duplicate-export error in this
 * aggregator, the errors-module re-export below is explicit and omits
 * `formatErrorOutput`; the canonical 2-arg version from `./output.js`
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