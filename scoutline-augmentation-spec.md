# scoutline augmentation spec — requirements only (v1, 2026-09-03)

Requirements gathered from real usage in an investigative-research pipeline where scoutline is the primary web-access CLI. Each item: the capability, the rationale (functional, generic), and priority. No project specifics.

## TIER 1 — highest priority (these replaced the most manual fallback work)

### 1. `scoutline archive cdx <url-or-pattern> [--from TS] [--to TS] [--status 200]`
Enumerate Internet Archive captures for a URL or pattern. JSON output: timestamp, statuscode, length, digest, original URL.
Rationale: retrieving the historical states of a page is required for verifying whether/how a page changed over time, and for recovering content from sites that have died or restructured — such content is discoverable only through the archive's index, never through live search.

### 2. `scoutline archive get <url> [--at <timestamp|best>] [--raw]`
Fetch a capture's raw original content (no archive toolbar/chrome injected), or auto-select the best/latest capture when no timestamp is given.
Rationale: many pages serve JS shells or paywalls to non-browser clients while the archive holds the server-rendered original; raw replay is the standard verification and recovery path.

### 3. `scoutline get <url> [--out FILE] [--md5] [--raw] [--ua <agent>]`
Binary-safe direct GET, following redirects, real-browser default User-Agent, optional save-to-file, optional checksum printed on completion.
Rationale: large documents and data files (PDFs, CSVs, ZIPs) need byte-exact download + integrity hashing as one step for evidence-preservation chains.

### 4. `scoutline api <url> [--method POST] [--data @body.json] [--header K:V] [--raw]`
Raw HTTP with arbitrary methods, JSON request bodies from file, custom headers, response passthrough (no content-type mangling).
Rationale: structured JSON APIs and search endpoints require POST bodies with correct escaping; markdown conversion corrupts them.

## TIER 2 — workflow glue

### 5. PDF text handling on get/read: `--pdf text|raw`
Extract text from PDF responses on fetch (pdftotext-class); `--pdf-repair` attempt path for structurally broken files (xref damage).
Rationale: official records are overwhelmingly scanned/PDF; requiring a separate local toolchain per pipeline makes the CLI non-self-sufficient.

### 6. `scoutline providers --health`
One-shot live probe of each provider's availability/quota/consumption state.
Rationale: multi-provider fallback needs a cheap way to gate dispatches and rotate providers before errors happen, rather than discovering quota exhaustion mid-run by error messages.

### 7. `--raw` passthrough on read for non-HTML (XML/Atom/JSON)
Rationale: feeds and API responses get mangled by markdown conversion; machine-consumed formats must pass through byte-faithful.

## TIER 3 — robustness

### 8. Fix JSON output corruption under concurrent invocations
Parallel CLI runs appear to interfere with each other's `-O json` output. If the cause is a shared temp/output path, per-invocation isolation would remove the need for serialized-only usage and unblock parallel pipelines.
### 9. Language/region hints: `--lang <tag>` (or Accept-Language passthrough)
Non-English queries vary in quality per provider; a hint lets callers express requirements to the provider.
### 10. Consistent response envelope
One JSON envelope shape (success/data/error) across all subcommands; callers currently special-case each.

## NON-GOALS (deliberate)

- Bot-challenge/anti-bot evasion (Akamai/Incapsula-class): out of scope. The correct behavior is to classify the wall cleanly in output (challenge vs denial vs dead) and stop — gated sources are handled by authorized human routes by policy.
- Local OCR: a system toolchain concern, not a CLI concern (though `--pdf text` may shell out to one internally).
