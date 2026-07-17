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
| `npm test` | Run the full offline test suite (build + offline tests). |
| `npm run test:offline` | Build and run every offline test file. |
| `npm run test:smoke` | Build and run the executable smoke suite (`cli-smoke.test.js`). |
| `npm run test:live` | Build and run every opt-in live test (requires credentials). |
| `npm run test:live:release` | Build and run the release live test (requires both `Z_AI_API_KEY` and `MINIMAX_API_KEY`). |
| `node bin/scoutline.js --help` | Smoke-test the compiled command dispatcher. |
| `node scripts/bench-tools.mjs` | Compare tool-discovery performance with cache enabled and disabled. |

Live modes set `SCOUTLINE_LIVE_TESTS=1` in the spawned child and require
explicit credentials. Offline and smoke modes clear the variable so a stray
shell setting cannot accidentally trigger network calls.

| Mode | Behavior |
| --- | --- |
| Offline | Every test except the smoke and live files. No credentials. |
| Smoke | Only `cli-smoke.test.js` (executable spawn + CLI parsing). |
| Live | Both opt-in live files (`mcp-live.test.js`, `provider-live.test.js`). Unconfigured Providers may skip. |
| Live-release | Only `provider-live.test.js`. Both `Z_AI_API_KEY` and `MINIMAX_API_KEY` required; any skip fails. |

## Test Layout

| File | Coverage |
| --- | --- |
| `tests/cli.test.js` | Help text, parsing, and CLI error behavior. |
| `tests/cli-smoke.test.js` | Executable spawn behavior (smoke only). |
| `tests/errors.test.js` | Typed error contracts and error serialization. |
| `tests/output.test.js` | Output mode and response envelope behavior. |
| `tests/redact.test.js` | Recursive credential redaction. |
| `tests/cache.test.js` | Provider-partitioned cache keys and on-disk behavior. |
| `tests/provider-selection.test.js` | Provider precedence and validation. |
| `tests/provider-boundary.test.js` | Adapter boundary rules and capability ownership. |
| `tests/provider-errors.test.js` | Provider-specific failure normalization. |
| `tests/adapter-conformance.test.js` | Shared search/vision conformance suite. |
| `tests/quota-conformance.test.js` | Normalized quota Interface and ADR-0001 conformance. |
| `tests/doctor.test.js` | Provider-aware diagnostics report and exit semantics. |
| `tests/vision-capability.test.js` | Vision capability contract and Provider mapping. |
| `tests/zai-adapter.test.js` | Z.AI Adapter mapping, media, and cache identity. |
| `tests/minimax-adapter.test.js` | MiniMax Adapter mapping, media, and SDK isolation. |
| `tests/execution.test.js` | Shared execution retry and policy. |
| `tests/invocation.test.js` | Command invocation seam and output envelope. |
| `tests/mcp-client.test.js` | Z.AI MCP client lifecycle and tool resolution. |
| `tests/package.test.js` | Pack contents, root export safety, and tarball install. |
| `tests/mcp-live.test.js` | Opt-in live MCP behavior when `Z_AI_API_KEY` is available. |
| `tests/provider-live.test.js` | Opt-in live Provider behavior; required for release. |

## Change Checklist

1. Keep command handlers thin and put transport behavior in the Adapters or shared execution.
2. Preserve the data-only default and JSON error contract for scripting users.
3. Close every created client in a `finally` block.
4. Update command help, the root README, and relevant files under `docs/` when public behavior changes. Update `CHANGELOG.md` for release-visible behavior changes.
5. Keep Provider field names, response shapes, and media rules inside the matching Adapter. Commands consume Capability interfaces only.
6. Run `npm run build`, `npm run test:offline`, `npm run test:smoke`, and `npm pack --dry-run` before release. Do not run live tests unless you have explicitly opted in.

## Package and Publication

The package manifest declares `"files": ["bin", "dist"]` — tests, fixtures,
local planning artifacts, and credential-shaped files are excluded from the
tarball. `prepublishOnly` runs the full offline suite, so publishing without a
green offline build fails fast.

`tests/package.test.js` verifies the pack contents, the root export, the
`mmx-cli@1.0.16` pin, and a generated-tarball install. The install test uses
`--offline --ignore-scripts` so it never contacts the npm registry: it relies
on the surrounding `npm install` of the package itself having already
populated the local cache.

## Transitional SDK and Direct Replacement

The initial MiniMax Adapter uses `mmx-cli/sdk` (pinned to exactly `1.0.16`)
as a replaceable transport for Search and Vision. Only
`src/providers/minimax/sdk-client.ts` imports the SDK directly. Quota uses a
narrow Adapter-local transport against
`<baseUrl>/v1/api/openplatform/coding_plan/remains` because the pinned SDK
does not preserve an arbitrary configured quota host.

Replacing the SDK transport with a direct MiniMax endpoint implementation
requires no change outside the MiniMax Adapter, its transport tests, the
package manifest, the lockfile, and the documentation. The same Search,
Vision, quota, diagnostics, media, error, and live conformance suite must
pass before the SDK pin is removed. No release date is currently planned for
this replacement.

See [RELEASING.md](../RELEASING.md) for the publish checklist and
[CONTRIBUTING.md](../CONTRIBUTING.md) for repository contribution guidance.