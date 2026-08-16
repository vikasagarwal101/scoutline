/**
 * URL canonicalization (DESIGN D4, ADR-0004 §5).
 *
 * Pure, identity-only normalization used solely as the Map key for
 * cross-arm (and cross-sub-query) result dedupe in search merge. The
 * emitted `url` on every result is the first writer's original string;
 * `canonicalUrl` exists to identify "same URL across providers" — not
 * to present a prettier URL to the user.
 *
 * Rules (DESIGN D4):
 *   - lowercase scheme + host (the WHATWG URL parser handles both)
 *   - strip default ports: `:443` for https, `:80` for http
 *   - strip the URL fragment
 *   - strip a trailing `/` from the path (the root `/` is preserved)
 *   - remove `utm_*` and `fbclid` query parameters; preserve the order
 *     of the survivors
 *   - relative or malformed inputs pass through verbatim — identity
 *     must never throw, so the Map key for an unparseable string is
 *     the string itself
 *
 * No other normalization in v1: `www.` and apex hosts are genuinely
 * different origins and stay distinct; `www.example.com` and
 * `example.com` will not dedupe to each other. Adding that is recorded
 * as a gate on the canonicalization table.
 */

export function canonicalUrl(input: string): string {
  // Identity must never throw. Non-string and empty inputs round-trip
  // unchanged — the caller can decide what to do with them.
  if (typeof input !== "string" || input.length === 0) {
    return input;
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    // Relative or malformed — pass through verbatim. Search results
    // occasionally contain bare paths or provider-specific garbage;
    // those still dedupe against themselves because every writer hits
    // the same pass-through path.
    return input;
  }

  // Default-port stripping. WHATWG keeps the explicit port inside
  // `host`, so the canonical host has to be rebuilt for the two cases
  // where the port is just the scheme's default.
  let host: string;
  if (parsed.protocol === "https:" && parsed.port === "443") {
    host = parsed.hostname;
  } else if (parsed.protocol === "http:" && parsed.port === "80") {
    host = parsed.hostname;
  } else {
    host = parsed.host;
  }

  // Trailing-slash trimming on non-root paths. The root `/` has length
  // 1 and is left intact — `example.com/` and `example.com` are kept
  // as distinct URL forms because collapsing them would change the
  // canonical identity for genuinely path-empty results.
  let path = parsed.pathname;
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  // Query parameter filtering. Walk the raw `search` string so the
  // survivor order matches the input; `URLSearchParams` alphabetizes
  // keys, which would silently reorder the canonical identity.
  let query = "";
  const rawSearch = parsed.search;
  if (rawSearch.length > 1) {
    const survivors: string[] = [];
    for (const pair of rawSearch.slice(1).split("&")) {
      const eq = pair.indexOf("=");
      const name = eq >= 0 ? pair.slice(0, eq) : pair;
      const lowerName = name.toLowerCase();
      if (lowerName.startsWith("utm_") || lowerName === "fbclid") continue;
      survivors.push(pair);
    }
    if (survivors.length > 0) {
      query = "?" + survivors.join("&");
    }
  }

  // No fragment by construction — search results never carry a fragment
  // we want to forward through dedupe identity, and dropping it here is
  // cheaper than asking every provider to strip it.
  return `${parsed.protocol}//${host}${path}${query}`;
}
