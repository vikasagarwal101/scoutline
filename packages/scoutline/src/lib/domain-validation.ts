/**
 * Shared domain/hostname validation (8P.3, 8J.3, 8J.4).
 *
 * Validates a bare hostname like "example.com" — rejects URLs, ports,
 * wildcards, protocol prefixes, and enforces DNS label (63-char) and
 * hostname (253-char) length limits.
 */

import { ValidationError } from "./errors.js";

const MAX_LABEL_LENGTH = 63;
const MAX_HOSTNAME_LENGTH = 253;
const HOSTNAME_REGEX =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

/**
 * Validate a domain string is a plausible hostname. Throws
 * `ValidationError` on invalid input.
 */
export function validateDomain(domain: string): void {
  if (typeof domain !== "string" || domain.trim().length === 0) {
    throw new ValidationError("Domain must be a non-empty string");
  }
  // Reject protocol-prefixed values, paths, ports, wildcards.
  if (
    /^https?:\/\//.test(domain) ||
    domain.includes("/") ||
    domain.includes(":") ||
    domain.includes("*")
  ) {
    throw new ValidationError(
      `Invalid domain "${domain}" — expected a bare hostname like "example.com"`,
    );
  }
  // Basic hostname check: labels of alphanumerics/hyphens, dot-separated.
  if (!HOSTNAME_REGEX.test(domain)) {
    throw new ValidationError(
      `Invalid domain "${domain}" — expected a bare hostname like "example.com"`,
    );
  }
  // Enforce DNS label (63-char) and hostname (253-char) length limits.
  if (domain.length > MAX_HOSTNAME_LENGTH) {
    throw new ValidationError(
      `Invalid domain "${domain}" — hostname exceeds ${MAX_HOSTNAME_LENGTH}-character limit`,
    );
  }
  for (const label of domain.split(".")) {
    if (label.length > MAX_LABEL_LENGTH) {
      throw new ValidationError(
        `Invalid domain "${domain}" — DNS label exceeds ${MAX_LABEL_LENGTH}-character limit`,
      );
    }
  }
}
