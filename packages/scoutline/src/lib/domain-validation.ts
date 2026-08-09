/**
 * Shared domain/hostname validation (8P.3, 8J.3, 8J.4).
 *
 * Validates a bare hostname like "example.com" — rejects URLs, ports,
 * wildcards, protocol prefixes, and enforces DNS label (63-char) and
 * hostname (253-char) length limits.
 *
 * The length limit is checked FIRST (fail-fast) so oversized input is
 * rejected before any pattern matching, and error messages never echo
 * the full oversized value.
 */

import { ValidationError } from "./errors.js";

const MAX_LABEL_LENGTH = 63;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_DISPLAY_LENGTH = 50;
const HOSTNAME_REGEX =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

/**
 * Truncate a domain for display in error messages so oversized input
 * is never echoed in full.
 */
function displayDomain(domain: string): string {
  return domain.length > MAX_DISPLAY_LENGTH
    ? `${domain.slice(0, MAX_DISPLAY_LENGTH)}...`
    : domain;
}

/**
 * Validate a domain string is a plausible hostname. Throws
 * `ValidationError` on invalid input.
 */
export function validateDomain(domain: string): void {
  if (typeof domain !== "string" || domain.trim().length === 0) {
    throw new ValidationError("Domain must be a non-empty string");
  }
  // Fail fast: enforce the 253-char hostname limit BEFORE pattern
  // matching so oversized input doesn't drive avoidable regex work.
  if (domain.length > MAX_HOSTNAME_LENGTH) {
    throw new ValidationError(
      `Domain exceeds ${MAX_HOSTNAME_LENGTH}-character hostname limit`,
    );
  }
  // Reject protocol-prefixed values, paths, ports, wildcards.
  if (
    /^https?:\/\//.test(domain) ||
    domain.includes("/") ||
    domain.includes(":") ||
    domain.includes("*")
  ) {
    throw new ValidationError(
      `Invalid domain "${displayDomain(domain)}" — expected a bare hostname like "example.com"`,
    );
  }
  // Basic hostname check: labels of alphanumerics/hyphens, dot-separated.
  if (!HOSTNAME_REGEX.test(domain)) {
    throw new ValidationError(
      `Invalid domain "${displayDomain(domain)}" — expected a bare hostname like "example.com"`,
    );
  }
  // Enforce DNS label (63-char) length limit.
  for (const label of domain.split(".")) {
    if (label.length > MAX_LABEL_LENGTH) {
      throw new ValidationError(
        `Invalid domain "${displayDomain(domain)}" — DNS label exceeds ${MAX_LABEL_LENGTH}-character limit`,
      );
    }
  }
}
