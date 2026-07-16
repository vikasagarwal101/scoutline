# Architecture

Scoutline is a Node.js command-line client that presents several Z.AI capabilities through one consistent interface. It is an MCP client, not an MCP server.

## Runtime Flow

```text
scoutline executable
  -> dist/index.js command dispatcher
  -> command handler
  -> ZaiMcpClient or ZaiCodeModeClient
  -> UTCP client and registered MCP server
  -> Z.AI or ZRead service
```

`packages/scoutline/bin/scoutline.js` is the published executable. It dynamically loads the compiled `dist/index.js` entry point and emits a structured load error if the package was not built.

`packages/scoutline/src/index.ts` owns global option parsing, output-mode selection, help/version output, and dispatch for each top-level command. Command-specific validation and presentation live in `src/commands/`.

## MCP Services

`src/lib/mcp-config.ts` builds one UTCP MCP call template with the manual name `scoutline.zai`.

| Service | Transport | Purpose |
| --- | --- | --- |
| `search` | HTTP | Web search. |
| `reader` | HTTP | Web page retrieval and conversion. |
| `zread` | HTTP | GitHub repository tree, search, and file access. |
| `vision` | stdio, optional | Image and video analysis through `@z_ai/mcp-server`. |

Vision is optional so non-vision commands can avoid starting its subprocess. The `--no-vision` option and `Z_AI_VISION_MCP=0` disable it.

## Command Layer

| Module | Responsibility |
| --- | --- |
| `commands/vision.ts` | Eight vision operations with shared client lifecycle management. |
| `commands/search.ts` | Search filtering, formatting, and multi-query result merging. |
| `commands/read.ts` | URL validation, gist raw-URL rewriting, extraction, and truncation. |
| `commands/repo.ts` | ZRead search, tree, and file operations. |
| `commands/tools.ts` | MCP tool discovery, schema lookup, and raw calls. |
| `commands/code.ts` | TypeScript tool chaining through UTCP Code Mode. |
| `commands/doctor.ts`, `commands/quota.ts` | Diagnostics and quota reporting. |

Each command is responsible for input validation, silencing dependency logs, producing the final response, and closing its client in a `finally` block.

## Shared Runtime Behavior

`src/lib/mcp-client.ts` is the main integration boundary. It initializes UTCP once per client, registers MCP services, resolves tool names, normalizes failures into CLI error classes, and closes transports.

- Retriable failures use bounded exponential backoff with jitter. Retrying closes the current client before trying again.
- Search/read/ZRead calls use the response cache unless `--no-cache` is supplied. Vision calls are never cached.
- Multi-query search creates one client per concurrent query because UTCP clients are not concurrency-safe for parallel calls.
- Tool discovery has a separate cache from normal response caching.

`src/lib/output.ts` owns the output contract. Commands should send successful values through `outputSuccess`; failures are serialized by `formatErrorOutput` from `src/lib/errors.ts`.

## Boundaries

- The CLI does not own the web-search, reader, ZRead, or vision implementations; it adapts their MCP tool contracts.
- The disk cache stores raw upstream responses before truncation, extraction, or output formatting. Presentation flags therefore do not produce separate response-cache entries.
- Code Mode is an explicit advanced execution path. Normal commands should remain predictable wrappers around named MCP operations.
