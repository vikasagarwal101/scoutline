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
 *   - strip default ports: `:443` for https, `:80` for http (also
 *     already done by the WHATWG parser — `parsed.host` never carries
 *     a scheme-default port)
 *   - strip the URL fragment
 *   - strip a trailing `/` from the path (the root `/` is preserved)
 *   - remove `utm_*` and `fbclid` query parameters — each parameter
 *     NAME is percent-decoded before the match (`?%66bclid=x`
 *     collapses with `?fbclid=x`), while the surviving raw pairs keep
 *     their exact bytes and order
 *   - relative or malformed inputs pass through verbatim — identity
 *     must never throw, so the Map key for an unparseable string is
 *     the string itself
 *
 * Everything NOT in that list is preserved verbatim: the raw path is
 * re-sliced from the input (WHATWG collapses dot segments —
 * `/a/../b` → `/b` — a normalization D4 does not authorize) and
 * userinfo is kept in the key (D4 authorizes dropping no authority
 * component, so `https://user@host/a` and `https://host/a` stay
 * distinct identities).
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

  // No host (opaque-path / non-special schemes like `mailto:` or
  // `data:`): the `${protocol}//${host}…` template below would
  // fabricate an authority the input never had. Pass through verbatim
  // — identity only, never a rewritten URL.
  if (parsed.host.length === 0) {
    return input;
  }

  // WHATWG already lowercased the scheme+host and stripped an explicit
  // default port (`:443` on https, `:80` on http) from `host`, so the
  // canonical host is `parsed.host` as-is; only non-default ports
  // survive the parser.
  const host = parsed.host;

  // Raw userinfo + path, re-sliced from the input between the
  // authority and the query/fragment. WHATWG normalization (dot-segment
  // collapsing, userinfo dropping, non-ASCII percent-encoding) is NOT
  // authorized by D4, so the identity keeps the exact bytes the
  // provider emitted. `parsed` remains the source for the lowercased
  // scheme/host and the already-stripped default port.
  let userinfo = "";
  let path = parsed.pathname;
  const schemeEnd = input.indexOf(":");
  const afterScheme = schemeEnd >= 0 ? input.slice(schemeEnd + 1) : "";
  if (afterScheme.startsWith("//")) {
    const rest = afterScheme.slice(2);
    const authorityEnd = rest.search(/[/?#]/);
    const rawAuthority = rest.slice(0, authorityEnd === -1 ? rest.length : authorityEnd);
    const atSign = rawAuthority.lastIndexOf("@");
    if (atSign >= 0) {
      userinfo = rawAuthority.slice(0, atSign + 1);
    }
    const rawTail = authorityEnd === -1 ? "" : rest.slice(authorityEnd);
    const queryOrFragment = rawTail.search(/[?#]/);
    const rawPath = queryOrFragment === -1 ? rawTail : rawTail.slice(0, queryOrFragment);
    // An authority with no path keeps the parser's implicit root "/"
    // (D4 preserves the root slash); anything else keeps its raw bytes.
    if (rawPath.length > 0) {
      path = rawPath;
    }
  }

  // Trailing-slash trimming on non-root paths. The root `/` has length
  // 1 and is left intact — `example.com/` and `example.com` are kept
  // as distinct URL forms because collapsing them would change the
  // canonical identity for genuinely path-empty results.
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  // Query parameter filtering. Walk the raw `search` string so the
  // survivor order matches the input; `URLSearchParams` alphabetizes
  // keys, which would silently reorder the canonical identity. Each
  // parameter NAME is percent-decoded before the tracking match so an
  // encoded name (`%66bclid`) collapses with its decoded twin; the
  // surviving raw pair keeps its exact bytes. Malformed escapes
  // (`%zz`) fail the decode and fall back to the raw name — identity
  // must never throw.
  let query = "";
  const rawSearch = parsed.search;
  if (rawSearch.length > 1) {
    const survivors: string[] = [];
    for (const pair of rawSearch.slice(1).split("&")) {
      const eq = pair.indexOf("=");
      const name = eq >= 0 ? pair.slice(0, eq) : pair;
      let matchName = name;
      try {
        matchName = decodeURIComponent(name);
      } catch {
        // Malformed percent-escape — match against the raw bytes.
      }
      const lowerName = matchName.toLowerCase();
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
  return `${parsed.protocol}//${userinfo}${host}${path}${query}`;
}
