# Development

The publishable package is `packages/scoutline`. Run package commands from that directory.

Development requires Node.js 22 or later.

## Setup

```bash
cd packages/scoutline
npm ci
npm run build
npm test
```

`npm run build` compiles `src/` to `dist/`. Tests import the compiled package, so a successful build is required before `npm test`.

## Useful Commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check and compile with TypeScript. |
| `npm run dev` | Rebuild on source changes. |
| `npm test` | Run Node's built-in test suite. |
| `node bin/scoutline.js --help` | Smoke-test the compiled command dispatcher. |
| `node scripts/bench-tools.mjs` | Compare tool-discovery performance with cache enabled and disabled. |

Network-backed smoke tests need a valid `Z_AI_API_KEY`. Keep unit and CLI parser tests independent of live services whenever possible.

## Test Layout

| File | Coverage |
| --- | --- |
| `tests/cli.test.js` | Help text, parsing, and CLI error behavior. |
| `tests/errors.test.js` | Typed error contracts and error serialization. |
| `tests/output.test.js` | Output mode and response envelope behavior. |
| `tests/mcp-live.test.js` | Live MCP behavior when credentials are available. |

## Change Checklist

1. Keep command handlers thin and put transport behavior in the shared clients.
2. Preserve the data-only default and JSON error contract for scripting users.
3. Close every created client in a `finally` block.
4. Update command help, the root README, and relevant files under `docs/` when public behavior changes.
5. Run `npm run build`, `npm test`, and `npm audit --omit=dev` before release.

See [RELEASING.md](../RELEASING.md) for the publish checklist and [CONTRIBUTING.md](../CONTRIBUTING.md) for repository contribution guidance.
