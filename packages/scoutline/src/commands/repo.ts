/**
 * Repo commands — thin handlers over the Repository Explorer (P6-07,
 * DESIGN.md §18, §11, PRD FR-080–FR-088).
 *
 * Each handler applies parse-level defaults/validation, builds the
 * Explorer request, and returns the normalized Explorer result as
 * base data. The handlers own NO Provider client, raw MCP name,
 * ZRead parser, traversal transport, cache policy, retry, or close.
 *
 * Provider selection, capability support, configuration, Adapter
 * construction, and adapter.repository agreement live in
 * `src/index.ts`. The Explorer receives a `RepositoryCapability`
 * plus shared `ExecutionDependencies` and owns path canonicalization,
 * BFS, maxChars projection, and result projection.
 *
 * Handler interface (P6-07A): mirrors the shared Search command
 * pattern. `deps: RepoHandlerDependencies` is REQUIRED — production
 * and direct tests cross the same compile-checked Interface. An
 * optional trailing `CommandContext` follows when a caller wants to
 * surface per-invocation context; the handlers do not currently read
 * it. A `CommandContext` is NOT a valid substitute for `deps`: a
 * direct caller who omits `deps` fails loudly with a TypeError
 * before reaching the Explorer rather than silently degrading.
 */

import type { CommandContext, CommandResult } from "../command-invocation.js";
import type {
  RepositoryCapability,
  RepositoryTreeResult,
  RepoBriefFocus,
  RepoManifestKind,
} from "../capabilities/repository.js";
import type { ExecutionDependencies } from "../lib/execution.js";
import { OUTPUT_MODES } from "../lib/output.js";
import { explorerSearch, explorerReadFile, explorerTree } from "./repository-explorer.js";
import { ValidationError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Parse-level validation
// ---------------------------------------------------------------------------

/**
 * Validate the repository string at parse time. Preserves the
 * existing at-least-one-slash rule and exact message so direct
 * handler tests keep their contract. The Explorer re-runs an
 * identical check as a defensive backstop.
 */
function validateRepo(repo: string): void {
  if (!repo.includes("/")) {
    throw new ValidationError(
      `Invalid repository format: "${repo}". Use "owner/repo" format (e.g., "facebook/react")`,
    );
  }
}

// ---------------------------------------------------------------------------
// Repository Brief — constants and pure helpers (DESIGN D1, D7; SCHEMA.md)
//
// These helpers are exported for unit testing and are pure (no I/O,
// no Provider, no env). The handler composition in `repoBrief` is a
// separate ticket that wires them into the Explorer envelope.
// ---------------------------------------------------------------------------

/**
 * Sealed v1 probe set. Opening the set later is additive — do NOT
 * mutate this constant at runtime.
 */
export const REPO_BRIEF_FOCUS: readonly RepoBriefFocus[] = [
  "structure",
  "readme",
  "manifest",
  "files",
] as const;

/**
 * Probe query constants per DESIGN D7. These are NOT constructed at
 * call time — they are literal constants so the brief's evidence
 * chain (search.query inside the envelope) is reproducible byte-for-
 * byte across providers and reruns.
 */
export const README_QUERY = "README";
export const MANIFEST_QUERY =
  "package.json pyproject.toml Cargo.toml go.mod";

/**
 * Canonical manifest-kind priority order (DESIGN D7 step 8). The
 * README, when present, is always selected first; manifests follow in
 * this exact order, capped so total reads ≤ 4.
 */
const MANIFEST_KIND_ORDER: readonly RepoManifestKind[] = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

/** Hard cap on total read probes (1 README + up to 3 manifests). */
const BRIEF_READ_CAP = 4;

/** README basename pattern per DESIGN D7 step 6 (case-insensitive). */
const README_BASENAME_RE = /^readme(?:\.[a-z0-9]+)?$/i;

/**
 * Compute the depth (number of segments past root) of a
 * repository-relative POSIX path. Root (`""`) has depth 0; `"a/b"`
 * has depth 2; `"a"` has depth 1.
 */
function pathDepth(path: string): number {
  if (path.length === 0) return 0;
  // split("/").length - 1 — root is excluded by the empty-string check
  // above; an empty string returns 0, otherwise the count of segments.
  return path.split("/").length;
}

/** Last segment of a repository-relative POSIX path (basename). */
function basenameOf(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? "";
}

/**
 * Pick the winning entry for a given match predicate using D7's
 * selection rule: minimum depth; ties broken by first occurrence in
 * (snapshot order, then entry order) — i.e. BFS / provider order,
 * which is stable for a given Provider response.
 *
 * The predicate is invoked with `(path, basename, kind)`; non-file
 * entries (directories) are filtered out before the predicate runs.
 */
function selectWinnerByDepth<T extends { path: string; kind: "file" | "directory" }>(
  tree: RepositoryTreeResult,
  predicate: (path: string, basename: string, kind: "file" | "directory") => boolean,
): { path: string } | undefined {
  let best: { path: string; depth: number } | undefined;
  for (const snapshot of tree.snapshots) {
    for (const entry of snapshot.entries) {
      if (entry.kind !== "file") continue;
      if (!predicate(entry.path, basenameOf(entry.path), entry.kind)) continue;
      const depth = pathDepth(entry.path);
      if (best === undefined || depth < best.depth) {
        best = { path: entry.path, depth };
      }
    }
  }
  return best ? { path: best.path } : undefined;
}

/**
 * Pure tree-derived file selection (DESIGN D1 / D7 steps 5–8). The
 * tree is the path inventory — search excerpts carry no paths, so
 * file selection MUST be tree-derived. The returned `manifests` array
 * is in canonical kind order; `readme` is the single shallowest
 * README match. Non-file entries (directories) are ignored even when
 * their `name` happens to look like a README/manifest.
 */
export function selectBriefFiles(
  tree: RepositoryTreeResult,
): { readme?: string; manifests: string[] } {
  const readme = selectWinnerByDepth(tree, (_path, basename) =>
    README_BASENAME_RE.test(basename),
  );

  const manifests: string[] = [];
  for (const kind of MANIFEST_KIND_ORDER) {
    if (manifests.length + (readme ? 1 : 0) >= BRIEF_READ_CAP) break;
    const winner = selectWinnerByDepth(tree, (_path, basename) => basename === kind);
    if (winner) manifests.push(winner.path);
  }

  return {
    ...(readme ? { readme: readme.path } : {}),
    manifests,
  };
}

/**
 * Parse the `--focus` flag value. Splits on `,`, trims, drops empties,
 * validates against the sealed `REPO_BRIEF_FOCUS` set, dedupes
 * preserving first occurrence, and rejects empty-after-processing.
 *
 * The error message names the sealed set so a consumer can fix the
 * value without consulting docs (DESIGN D7 step 3).
 */
export function parseBriefFocus(raw: string): readonly RepoBriefFocus[] {
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    throw new ValidationError(
      "--focus must include at least one of: structure, readme, manifest, files",
    );
  }

  const seen = new Set<RepoBriefFocus>();
  const out: RepoBriefFocus[] = [];
  for (const token of tokens) {
    if (!(REPO_BRIEF_FOCUS as readonly string[]).includes(token)) {
      throw new ValidationError(
        `Unknown --focus value "${token}". Allowed: ${REPO_BRIEF_FOCUS.join(", ")}`,
      );
    }
    const focus = token as RepoBriefFocus;
    if (seen.has(focus)) continue;
    seen.add(focus);
    out.push(focus);
  }

  return out;
}

/**
 * Parse the `--depth` flag value. Positive integer (≥ 1); `undefined`
 * means "unset — use the Explorer's default". Coerces numeric strings
 * to numbers (CLI parses flags as strings).
 */
export function parseBriefDepth(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new ValidationError("--depth must be a positive integer");
  }
  return value;
}

/**
 * Parse the `--max-chars` flag value. Positive integer (≥ 1);
 * `undefined` means "unset — use the Explorer's default upper bound".
 * Coerces numeric strings to numbers.
 */
export function parseBriefMaxChars(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new ValidationError("--max-chars must be a positive integer");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Option and dependency types
// ---------------------------------------------------------------------------

export interface RepoSearchOptions {
  language?: "en" | "zh";
  maxChars?: number;
  noCache?: boolean;
}

export interface RepoTreeOptions {
  path?: string;
  depth?: number;
  noCache?: boolean;
}

export interface RepoReadOptions {
  maxChars?: number;
  noCache?: boolean;
}

/**
 * Dependencies injected by `src/index.ts` after Provider selection,
 * capability support check, configuration check, Adapter
 * construction, and adapter.repository agreement. The handlers
 * never resolve a Provider descriptor themselves. Required — a
 * caller that omits `deps` is malformed and fails loudly.
 */
export interface RepoHandlerDependencies {
  readonly capability: RepositoryCapability;
  readonly execution: ExecutionDependencies;
}

// ---------------------------------------------------------------------------
// Handlers — thin wrappers over the Explorer
// ---------------------------------------------------------------------------

/**
 * Repository Search. Validates parse-level request shape, delegates
 * to the Explorer with the injected Repository Capability, and
 * returns the normalized Search result as base data.
 */
export async function repoSearch(
  repo: string,
  query: string,
  options: RepoSearchOptions,
  deps: RepoHandlerDependencies,
  _context?: CommandContext,
): Promise<CommandResult> {
  validateRepo(repo);
  if (options.language && options.language !== "en" && options.language !== "zh") {
    throw new ValidationError('Language must be "en" or "zh"');
  }

  const result = await explorerSearch(
    deps.capability,
    { repository: repo, query, language: options.language },
    { noCache: options.noCache, maxChars: options.maxChars },
    deps.execution,
  );
  return { kind: "data", data: result };
}

/**
 * Repository Tree. Validates parse-level request shape (including
 * depth), delegates to the Explorer's BFS traversal, and returns
 * the normalized Tree result as base data. Tree is never
 * character-limited; `maxChars` is intentionally not accepted.
 */
export async function repoTree(
  repo: string,
  options: RepoTreeOptions,
  deps: RepoHandlerDependencies,
  _context?: CommandContext,
): Promise<CommandResult> {
  validateRepo(repo);
  if (options.depth !== undefined) {
    const depthValue = Number(options.depth);
    if (!Number.isFinite(depthValue) || depthValue < 1) {
      throw new ValidationError("Depth must be a positive integer");
    }
  }

  const result = await explorerTree(
    deps.capability,
    { repository: repo, path: options.path, depth: options.depth },
    { noCache: options.noCache },
    deps.execution,
  );
  return { kind: "data", data: result };
}

/**
 * Repository File read. Validates parse-level request shape,
 * delegates to the Explorer with the injected Repository Capability,
 * and returns the normalized File result as base data.
 */
export async function repoRead(
  repo: string,
  path: string,
  options: RepoReadOptions,
  deps: RepoHandlerDependencies,
  _context?: CommandContext,
): Promise<CommandResult> {
  validateRepo(repo);

  const result = await explorerReadFile(
    deps.capability,
    { repository: repo, path },
    { noCache: options.noCache, maxChars: options.maxChars },
    deps.execution,
  );
  return { kind: "data", data: result };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/**
 * Canonical output-mode list for `--output-format`. Derived from the
 * shared `OUTPUT_MODES` contract so the help text cannot drift from
 * the accepted set. Joined with " | " for inline display under
 * Common Options below.
 */
const OUTPUT_MODE_LIST = OUTPUT_MODES.join(" | ");

export const REPO_HELP = `
Repo Commands - Explore GitHub repositories (Provider Capability)

Usage: scoutline repo <command> <owner/repo> [args]

Commands:
  search <owner/repo> <query>   Search docs and code in repository
  tree <owner/repo>             Get repository directory structure
  read <owner/repo> <path>      Read a file from repository

Search Options:
  --language <lang>   Result language: en (default) or zh
  --max-chars <n>     Truncate output to <n> chars

Tree Options:
  --path <path>       Directory path to inspect (default: repo root)
  --depth <n>         Expand subdirectory trees (default: 1)

Read Options:
  --max-chars <n>     Truncate file content to <n> chars

Common Options:
  --no-cache                 Bypass the response cache for this invocation
  --provider <id>            Override the active Provider (zai | minimax | tavily | exa)
  --output-format <mode>     One of: ${OUTPUT_MODE_LIST} (default: data)
  -O <mode>                  Alias for --output-format

Provider selection (precedence: --provider, then SCOUTLINE_PROVIDER,
then zai):
  - The 'repo' command participates in Provider selection.
  - Z.AI advertises the repository-exploration Capability and supplies
    the Adapter; selecting zai routes Search/File/Tree through it.
  - MiniMax, Tavily, Exa, Brave, and Firecrawl do NOT advertise
    repository-exploration. By default (0.11.0+) Provider fallback
    emits a stderr notice and silently reroutes to Z.AI. Under
    --no-fallback (or SCOUTLINE_NO_FALLBACK=1) the preflight surfaces
    UNSUPPORTED_CAPABILITY for the selected non-supplier.

Output format (intentional schema-version-1 migration):
  - search: {schemaVersion, repository, query, language, excerpts:[{text}],
             truncated, originalTextLength}
  - read:   {schemaVersion, repository, path, content, truncated,
             originalContentLength}
  - tree:   {schemaVersion, repository, path, depth,
             snapshots:[{repository, path, entries:[{name, path, kind}]}]}
  Root path is the empty string "". --max-chars applies only to
  search/read content; tree is never character-limited.
  Output modes for repo results:
    - data: raw schema-version-1 value as plain JSON (no envelope).
    - json / pretty: standard {success, data, timestamp} envelope
      (indent 0 for json, indent 2 for pretty).
    - compact / markdown / refs / tty: JSON fallback (same value as
      data mode). Repo never supplies a per-mode prose presentation.

Examples:
  scoutline repo search facebook/react "server components"
  scoutline repo search facebook/react "server components" --language en --max-chars 2000
  scoutline repo tree vercel/next.js
  scoutline repo tree vercel/next.js --path packages --depth 2
  scoutline repo read anthropics/anthropic-sdk-python src/anthropic/client.py
  scoutline repo read facebook/react README.md --max-chars 3000
  scoutline --provider minimax repo search owner/repo query   # UNSUPPORTED_CAPABILITY

Notes:
  - Repository must be public
  - Use "owner/repo" format (e.g., "facebook/react")
  - Paths are relative to repository root
  - Depth >= 1 returns structured snapshots; depth 1 is also structured
`.trim();
