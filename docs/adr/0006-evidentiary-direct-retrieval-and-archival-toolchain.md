# Evidentiary Direct Retrieval and Archival Toolchain

Status: accepted (2026-09-04)

Extends Scoutline from a multi-provider AI search/reader gateway into a complete investigative research CLI with direct binary/REST HTTP access via `scoutline fetch`, temporal archival intelligence via `scoutline archive`, and pipeline-grade operational reliability.

## Context

Scoutline's core architecture was designed around provider-abstracted capabilities (`search`, `read`, `crawl`, `map`, `research`, `vision`) with transparent fallback across AI providers. In investigative-research pipelines, however, this model introduces critical gaps:

1. **Evidentiary preservation**: Downloading raw datasets, PDFs, and official records requires byte-exact retrieval with integrity checksums of the original response bytes (`--md5` for transmission-integrity compatibility checks; `--sha256` for collision-resistant evidentiary verification) and browser-like user agents, which AI scraping/reader APIs do not provide.
2. **REST/API communication**: Querying structured endpoints requires sending arbitrary JSON payloads and receiving un-mangled responses without Markdown conversion.
3. **Archival provenance**: Recovering lost content, verifying historical site changes, and discovering deleted endpoints requires querying the Internet Archive Wayback Machine CDX API and replaying raw, unadulterated captures (without archive chrome/toolbars).
4. **Pipeline reliability & concurrency**: Running high-throughput parallel pipelines (`xargs -P N`) suffers from output corruption when multiple processes contend for shared disk state (`~/.scoutline/`) or leak notices to stdout. Mid-pipeline quota exhaustion causes preventable failures if providers cannot be probed prior to dispatch.

## Decisions

### 1. Direct Evidentiary Web Access via `scoutline fetch`
Direct, provider-independent HTTP operations are consolidated under the first-class `scoutline fetch` command:
- `scoutline fetch <url> [--out <file>] [--md5] [--raw] [--ua <agent>] [--method <verb>] [--data <@file|string>] [--header <K:V>]`:
  - **Evidentiary GET mode (default)**: Byte-exact, binary-safe retrieval following redirects, defaulting to a modern browser User-Agent, with optional streaming to disk (`--out`) and cryptographic integrity hashing (`--md5`).
  - **Structured API / REST mode**: Supports arbitrary HTTP methods (`--method POST`, `-X POST`), JSON request payloads from file (`--data @body.json`), and custom headers (`--header K:V`), returning un-mangled responses without Markdown translation.
- `scoutline fetch` is strictly direct: it does not invoke AI providers, does not participate in provider fallback, and does not perform AI/markdown conversion.

### 2. Dedicated Archival Namespace (`scoutline archive <cdx|get>`)
Archival intelligence represents a distinct domain separate from direct fetching and AI readers, and is given a dedicated first-class command group:
- `scoutline archive cdx <url-or-pattern> [--from <TS>] [--to <TS>] [--status <200>]`: Queries the Internet Archive's public CDX Server API, returning structured JSON capture metadata (`timestamp`, `statuscode`, `length`, `digest`, `original URL`).
- `scoutline archive get <url> [--at <timestamp|best>] [--raw]`: Fetches verbatim historical snapshots via Wayback's `id_` replay mode (stripping injected toolbars and scripts). Auto-resolves the nearest capture via the Wayback Availability API if `--at` is omitted or set to `best`.

### 3. Provider Health Probe via `scoutline doctor --health`
To avoid command bloat from single-purpose top-level commands, the requirement for an active provider health check (`providers --health`) is consolidated into the existing diagnostic command as `scoutline doctor --health`:
- Performs an active, concurrent probe across all configured providers checking endpoint reachability, response latency, and operational health status (quota balances remain read from cached/stored snapshots).
- A dedicated `providers` command is rejected because diagnostics already belong to `doctor`.

### 4. Hybrid PDF Extraction and Repair
PDF handling on `fetch` (`--pdf text|raw`, `--pdf-repair`). `read` deliberately has no PDF/byte modes: the Reader capability returns provider-normalized content, which cannot be byte-faithful, so `read --pdf`/`--pdf-repair` are rejected at parse time with a pointer to `fetch`:
- Pure-JS text extraction is bundled into the package so Scoutline remains fully self-sufficient out-of-the-box without mandatory external system dependencies.
- Opportunistic delegation to system tools is used when installed on the host: `pdftotext` for external text layer extraction, and `qpdf` specifically for structural xref repair (`--pdf-repair`).

### 5. Concurrency Resilience and Ephemeral Execution
To eliminate JSON output corruption under concurrent invocations:
- **Default isolation**: State writes (`~/.scoutline/usage.json`, quota cache) are guarded with non-blocking concurrency safety, and process output guarantees absolute separation between `stdout` (pure payload) and `stderr` (diagnostics, notices, locks).
- **`--isolated` flag**: An explicit flag skips local state persistence entirely (`usage.json`, background quota refresh) for high-throughput headless batch jobs.

### 6. Standardized Response Envelope under `-O json`
- Under `-O json` (and `pretty`), every subcommand guarantees the canonical wrapped envelope: `{ success: true, data: T, timestamp: number }` (or `{ success: false, error: string, code: string }`).
- Raw `-O data` mode is preserved for backward-compatible un-wrapped piping.

### 7. Strict Control Conformance for `--lang <tag>`
In accordance with Scoutline's strict anti-silent-drop policy:
- `--lang` is passed as `Accept-Language` on direct HTTP (`fetch`) and reader requests.
- For search providers, `--lang` is mapped to native provider parameters (e.g. `gl`/`hl` or language settings) where supported.
- If a provider does not support language localization, the command rejects with `UNSUPPORTED_OPTION` rather than silently dropping the parameter.

### 8. Format Fidelity via Direct Retrieval (`fetch --raw`)
Byte-faithful output is a property of owning the HTTP socket, so it lives in `scoutline fetch --raw` (and `archive get --raw` for snapshot replays). `scoutline read` reports exactly what the Reader provider returned (`contentFormat: markdown|text`); relabeling provider-normalized content as "raw" was rejected during PR #101 review because the provider round-trip has already decoded the bytes (UTF-8), making byte reconstruction impossible.

## Consequences

- The CLI surface expands coherently without command sprawl: `scoutline fetch` handles direct evidentiary/API HTTP (including all byte-exact and PDF modes), `scoutline archive` handles temporal index discovery and replay, while `doctor` absorbs operational augmentations.
- Direct commands (`fetch`, `archive`) are keyless and deterministic; they never spend AI provider tokens or trigger provider fallback.
- Batch and automated pipelines gain robust concurrency guarantees and pre-flight health gating.
