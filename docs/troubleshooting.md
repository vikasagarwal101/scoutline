# Troubleshooting

## Missing Provider Credential

```
Z_AI_API_KEY environment variable is required
```

Set the credential for the Provider you intend to use:

```bash
# Z.AI
export Z_AI_API_KEY="your-api-key"
scoutline doctor

# MiniMax Token Plan
export MINIMAX_API_KEY="your-minimax-key"
scoutline doctor --provider minimax
```

Provider selection is never inferred from which credentials are present. An
unconfigured effective Provider is a configuration failure (`exit 3`) for the
default quota command and a diagnostic failure (`exit 1`) for `doctor`.

## Unknown Provider ID

```
Unknown provider "<value>". Accepted provider IDs: zai, minimax.
```

`--provider` and `SCOUTLINE_PROVIDER` accept only `zai` or `minimax`. Unknown
or empty values fail with `VALIDATION_ERROR` (`exit 1`) before any Provider
invocation. Note that `read`, `repo`, `tools`, `tool`, `call`, and `code` accept
the flag but ignore it — they remain Z.AI-only in the base release.

## Unsupported MiniMax Search Control

```
Unsupported option "domain" for minimax.search
```

MiniMax does not accept domain, recency, content-size, or location search
controls. Drop the unsupported control and re-run. The `--count` and
`--max-summary` flags are still applied locally after normalization.

## Unsupported MiniMax Vision Operation

```
Unsupported capability "vision.diff" for provider minimax
```

MiniMax supports general single-image interpretation (`scoutline vision
analyze`) in the base release. Two-image comparison (`vision diff`), video
analysis (`vision video`), and the specialized mappings (`ui-to-code`,
`extract-text`, `diagnose-error`, `diagram`, `chart`) are Z.AI-only until
their Phase 5 conformance gates pass.

## The executable reports `LOAD_ERROR`

The package has not been built, or its compiled output is missing. From
`packages/scoutline` run:

```bash
npm ci
npm run build
```

The published executable loads `dist/index.js`, not TypeScript source files.

## Build cannot resolve Node or UTCP types

Dependencies are missing or incomplete. Remove any partial install only if it
is safe to do so, then run `npm ci` from `packages/scoutline`. The package
requires Node 22 or later.

## A command times out

Increase the timeout for the process:

```bash
export Z_AI_TIMEOUT=60000
scoutline read https://example.com
```

The value is milliseconds. Retrying is limited to transient failures;
authentication, validation, unsupported, and exhausted-quota failures are
terminal.

## Results appear stale

Bypass the response cache for one request:

```bash
scoutline search "latest MCP specification" --no-cache
```

To disable caching for the process, set `ZAI_CACHE=0`. See
[Configuration](configuration.md#response-cache) for TTL and directory
controls. Note that Vision results are never cached regardless.

## Vision startup is slow or fails for non-vision commands

Skip the optional vision MCP server:

```bash
scoutline doctor --no-vision
scoutline tools --no-vision
```

Set `Z_AI_VISION_MCP=0` when the environment should never start the server.

## A URL is rejected by `read`

`read` accepts absolute `http://` or `https://` URLs only. GitHub Gist URLs
are rewritten to their raw form automatically.

## `quota --all-providers` exits 1

That is the documented exit semantics: any configured Provider failure
preserves the successful entries and yields exit 1. Inspect the dashboard to
find the failing entry — the failure is reported as a normalized redacted
error alongside the successful entries.

## `doctor` exits 1

`doctor` exits 1 when the effective Provider is unconfigured or any
configured probe fails. Inspect the report: missing non-effective credentials
appear as `skipped` and do not fail the report. Under `--no-tools` every
configured Provider is reported as `skipped` (reason `tools-disabled`) and
does not fail the report either.

## Need more information

Run command-local help, which is the canonical option reference:

```bash
scoutline <command> --help
```

For Provider setup and connectivity, run `scoutline doctor`. To list every
configured Provider's quota, run `scoutline quota --all-providers`.