# Troubleshooting

## `Z_AI_API_KEY environment variable is required`

Set the key in the shell that starts the CLI:

```bash
export Z_AI_API_KEY="your-api-key"
scoutline doctor --no-vision
```

`doctor --no-vision` isolates HTTP MCP configuration when you are not using vision features.

## The executable reports `LOAD_ERROR`

The package has not been built, or its compiled output is missing. From `packages/scoutline` run:

```bash
npm ci
npm run build
```

The published executable loads `dist/index.js`, not TypeScript source files.

## Build cannot resolve Node or UTCP types

Dependencies are missing or incomplete. Remove any partial install only if it is safe to do so, then run `npm ci` from `packages/scoutline`. The package requires Node 22 or later.

## A command times out

Increase the timeout for the process:

```bash
export Z_AI_TIMEOUT=60000
scoutline read https://example.com
```

The value is milliseconds. Retrying is limited to transient failures; authentication and validation errors should be fixed rather than retried.

## Results appear stale

Bypass the response cache for one request:

```bash
scoutline search "latest MCP specification" --no-cache
```

To disable caching for the process, set `ZAI_CACHE=0`. See [Configuration](configuration.md#response-cache) for TTL and directory controls.

## Vision startup is slow or fails for non-vision commands

Skip the optional vision MCP server:

```bash
scoutline doctor --no-vision
scoutline tools --no-vision
```

Set `Z_AI_VISION_MCP=0` when the environment should never start the server.

## A URL is rejected by `read`

`read` accepts absolute `http://` or `https://` URLs only. GitHub Gist URLs are rewritten to their raw form automatically.

## Need more information

Run command-local help, which is the canonical option reference:

```bash
scoutline <command> --help
```

For service setup and connectivity, run `scoutline doctor`.
