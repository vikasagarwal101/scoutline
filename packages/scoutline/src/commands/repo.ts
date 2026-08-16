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
  RepositoryBrief,
  RepositoryCapability,
  RepositorySearchResult,
  RepositoryTreeResult,
  RepoBriefDetected,
  RepoBriefFileEntry,
  RepoBriefFocus,
  RepoBriefProbeRecord,
  RepoManifestKind,
} from "../capabilities/repository.js";
import type { ExecutionDependencies } from "../lib/execution.js";
import { OUTPUT_MODES } from "../lib/output.js";
import { explorerSearch, explorerReadFile, explorerTree } from "./repository-explorer.js";
import { ValidationError } from "../lib/errors.js";
import { configuredSecrets, redactCredentialString } from "../lib/redact.js";

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
  // For non-empty paths the depth IS the segment count returned by
  // split("/").length — no subtraction: the root ("") already returned
  // 0 above, so "a" → 1 and "a/b" → 2, matching the JSDoc.
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
 * means "unset — use the Explorer's default". Accepts only numbers and
 * numeric strings (CLI parses flags as strings); every other runtime
 * type — booleans, null, objects — is rejected BEFORE coercion so a
 * `true` can never ride `Number(true) === 1` past validation.
 */
export function parseBriefDepth(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new ValidationError("--depth must be a positive integer");
  }
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new ValidationError("--depth must be a positive integer");
  }
  return value;
}

/**
 * Parse the `--max-chars` flag value. Positive integer (≥ 1);
 * `undefined` means "unset — use the Explorer's default upper bound".
 * Same runtime-type gate as `parseBriefDepth`: only numbers and numeric
 * strings are coerced.
 */
export function parseBriefMaxChars(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new ValidationError("--max-chars must be a positive integer");
  }
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

export interface RepoBriefOptions {
  /**
   * Requested focus, a subset of the sealed `REPO_BRIEF_FOCUS` set, in
   * caller order. Omitted defaults to all four. Non-empty; each token
   * must be a sealed member (DESIGN D7 step 3). Duplicate tokens are
   * collapsed preserving first occurrence, matching `parseBriefFocus`,
   * so direct handler callers cannot smuggle duplicates into the
   * envelope's `focus` field.
   */
  focus?: readonly RepoBriefFocus[];
  /** Tree-only scope (DESIGN D3: search/read have no path parameter). */
  path?: string;
  /** Tree-only depth; defaults to the Explorer's default (1). */
  depth?: number;
  /** Per-call search/read budget; tree is never character-limited. */
  maxChars?: number;
  /** Bypasses the response cache for every probe. */
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
  /**
   * Invocation-resolved credential values used to redact failed-probe
   * error messages. Injected by `src/index.ts` already resolved from
   * the invocation's env (including injected credentials absent from
   * ambient `process.env`). Omitted → the ambient `configuredSecrets()`
   * fallback, mirroring `invokeCommand`'s output/error boundary.
   */
  readonly secrets?: readonly string[];
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
// Repository Brief — handler composition (DESIGN D3/D4/D6, SCHEMA.md)
// ---------------------------------------------------------------------------

/**
 * A settled probe outcome: either a normalized result or the raw thrown
 * error. The ordered coverage record is pushed inside `settleProbe`, so
 * the `coverage.probes` list is the authoritative execution log.
 */
type SettledProbe<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Run one Explorer call inside the settled wrapper (DESIGN D6): a throw
 * becomes a `failed` probe record (stable code + redacted message) and
 * the brief continues. On success the probe is recorded `ok`.
 */
async function settleProbe<T>(
  probes: RepoBriefProbeRecord[],
  kind: "tree" | "search" | "read",
  label: string,
  fn: () => Promise<T>,
  secrets: readonly string[],
): Promise<SettledProbe<T>> {
  try {
    const value = await fn();
    probes.push({ kind, label, status: "ok" });
    return { ok: true, value };
  } catch (error) {
    probes.push({ kind, label, status: "failed", error: probeErrorInfo(error, secrets) });
    return { ok: false, error };
  }
}

/**
 * Derive the stable code + redacted message for a probe failure record.
 * Mirrors the standard stderr boundary (`formatErrorOutput`): a shaped
 * error's `code` string is preserved, everything else falls back to
 * `UNKNOWN_ERROR`; the message is redacted against the invocation's
 * resolved credentials (threaded via `RepoHandlerDependencies.secrets`
 * so injected-environment credentials absent from ambient `process.env`
 * are still covered) so no credential-shaped substring leaks into the
 * envelope.
 */
function probeErrorInfo(
  error: unknown,
  secrets: readonly string[],
): { code: string; message: string } {
  const code =
    error !== null &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "UNKNOWN_ERROR";
  const rawMessage = error instanceof Error ? error.message : String(error);
  return { code, message: redactCredentialString(rawMessage, [...secrets]) };
}

/**
 * Tree-derived structural signals (SCHEMA.md `RepoBriefDetected`). Every
 * field is `null` when the tree probe failed or was focus-excluded —
 * never guessed from search excerpts. `manifestKinds` lists every
 * present kind in canonical order, independent of the 4-read selection
 * cap (the cap is a read-budget, not a detection signal).
 */
function detectBriefSignals(tree: RepositoryTreeResult): RepoBriefDetected {
  let hasReadme = false;
  for (const snapshot of tree.snapshots) {
    for (const entry of snapshot.entries) {
      if (entry.kind !== "file") continue;
      if (README_BASENAME_RE.test(basenameOf(entry.path))) {
        hasReadme = true;
      }
    }
  }
  const manifestKinds: RepoManifestKind[] = [];
  for (const kind of MANIFEST_KIND_ORDER) {
    const winner = selectWinnerByDepth(tree, (_path, basename) => basename === kind);
    if (winner) manifestKinds.push(kind);
  }
  return {
    hasReadme,
    hasManifest: manifestKinds.length > 0,
    manifestKinds,
  };
}

/**
 * Repository Brief. Composes the three Explorer operations into one
 * schema-version-1 envelope (DESIGN D2/D3/D4). Fixed probe order:
 * tree → search("README") → search(manifest names) → read loop (README
 * first, then manifests in canonical kind order, cap 4 total reads).
 *
 * Parse-level validation (DESIGN D7): `validateRepo`, `--depth` and
 * `--max-chars` positive integers, `--focus` a non-empty subset of the
 * sealed set (default all four). Forwarding (DESIGN D3): `--no-cache`
 * to every call; `--max-chars` to searches/reads only (the tree is
 * never character-limited); `--depth`/`--path` to the tree only.
 *
 * Every Explorer call runs settled (DESIGN D6): a throw becomes a
 * `failed` probe record and the brief continues. Exit policy: ≥1 probe
 * `ok` → `{kind: "data"}` (exit 0); every probe terminal and failed →
 * the last error is rethrown so the executor routes it through the
 * standard stderr boundary (exit 1).
 */
export async function repoBrief(
  repo: string,
  options: RepoBriefOptions,
  deps: RepoHandlerDependencies,
  _context?: CommandContext,
): Promise<CommandResult<RepositoryBrief>> {
  validateRepo(repo);

  // Bind the parsed values: the VALIDATED (coerced) numbers are what
  // every probe receives — a direct caller's numeric string never leaks
  // downstream as a string.
  const depth = parseBriefDepth(options.depth);
  const maxChars = parseBriefMaxChars(options.maxChars);

  const focus =
    options.focus === undefined ? [...REPO_BRIEF_FOCUS] : [...new Set(options.focus)];
  if (focus.length === 0) {
    throw new ValidationError(
      "--focus must include at least one of: structure, readme, manifest, files",
    );
  }
  for (const token of focus) {
    if (!(REPO_BRIEF_FOCUS as readonly string[]).includes(token)) {
      throw new ValidationError(
        `Unknown --focus value "${token}". Allowed: ${REPO_BRIEF_FOCUS.join(", ")}`,
      );
    }
  }

  const wantsStructure = focus.includes("structure");
  const wantsReadme = focus.includes("readme");
  const wantsManifest = focus.includes("manifest");
  const wantsFiles = focus.includes("files");

  const probes: RepoBriefProbeRecord[] = [];
  let lastError: unknown = undefined;

  // Invocation-resolved credentials for failed-probe redaction. Direct
  // handler callers that omit `deps.secrets` get the ambient fallback
  // (same posture as `invokeCommand`'s error boundary).
  const secrets = deps.secrets ?? configuredSecrets();

  // Probe 1: tree — always runs (read-path selection and `detected`
  // both derive from it; DESIGN D1).
  const treeProbe = await settleProbe(probes, "tree", "tree", () =>
    explorerTree(
      deps.capability,
      { repository: repo, path: options.path, depth },
      { noCache: options.noCache },
      deps.execution,
    ),
    secrets,
  );
  if (!treeProbe.ok) lastError = treeProbe.error;

  // Probe 2: search("README") — only under `readme` focus.
  let docs: RepositorySearchResult | undefined;
  if (wantsReadme) {
    const probe = await settleProbe(probes, "search", "search:readme", () =>
      explorerSearch(
        deps.capability,
        { repository: repo, query: README_QUERY },
        { noCache: options.noCache, maxChars },
        deps.execution,
      ),
      secrets,
    );
    if (probe.ok) docs = probe.value;
    else lastError = probe.error;
  } else {
    probes.push({
      kind: "search",
      label: "search:readme",
      status: "skipped",
      reason: "focus-excluded",
    });
  }

  // Probe 3: search(manifest names) — only under `manifest` focus.
  let entryPoints: RepositorySearchResult | undefined;
  if (wantsManifest) {
    const probe = await settleProbe(probes, "search", "search:manifest", () =>
      explorerSearch(
        deps.capability,
        { repository: repo, query: MANIFEST_QUERY },
        { noCache: options.noCache, maxChars },
        deps.execution,
      ),
      secrets,
    );
    if (probe.ok) entryPoints = probe.value;
    else lastError = probe.error;
  } else {
    probes.push({
      kind: "search",
      label: "search:manifest",
      status: "skipped",
      reason: "focus-excluded",
    });
  }

  // Probe 4: read loop — only under `files` focus, using Ticket 1's
  // deterministic tree-derived selection (DESIGN D1/D7 steps 5-8).
  const files: RepoBriefFileEntry[] = [];
  if (wantsFiles) {
    if (treeProbe.ok) {
      const selection = selectBriefFiles(treeProbe.value);
      const readPaths: string[] = [];
      if (selection.readme !== undefined) readPaths.push(selection.readme);
      readPaths.push(...selection.manifests);
      if (readPaths.length === 0) {
        // The stage was requested but the tree-derived selection is
        // empty (no README, no manifest): record the terminal
        // `read:<files>` sentinel so a focus-requested read stage ALWAYS
        // ends in a read record (SCHEMA: probes is total over requested
        // stages). `no-selection` distinguishes this from focus-excluded
        // and dependency-failed.
        probes.push({
          kind: "read",
          label: "read:<files>",
          status: "skipped",
          reason: "no-selection",
        });
      }
      for (const path of readPaths) {
        const probe = await settleProbe(probes, "read", `read:${path}`, () =>
          explorerReadFile(
            deps.capability,
            { repository: repo, path },
            { noCache: options.noCache, maxChars },
            deps.execution,
          ),
          secrets,
        );
        if (probe.ok) {
          files.push({
            path: probe.value.path,
            content: probe.value.content,
            truncated: probe.value.truncated,
            originalContentLength: probe.value.originalContentLength,
          });
        } else {
          lastError = probe.error;
        }
      }
    } else {
      // The tree failed; read selection has no path inventory to run
      // against, so the files probe is recorded as dependency-failed.
      probes.push({
        kind: "read",
        label: "read:<files>",
        status: "skipped",
        reason: "dependency-failed",
      });
    }
  } else {
    probes.push({
      kind: "read",
      label: "read:<files>",
      status: "skipped",
      reason: "focus-excluded",
    });
  }

  // Exit policy (DESIGN D6): ≥1 probe `ok` → data (exit 0), because
  // degradations are data in `coverage`, not stderr noise. Otherwise
  // rethrow the last error so the executor surfaces it via the standard
  // stderr boundary (exit 1).
  if (!probes.some((p) => p.status === "ok")) {
    throw lastError;
  }

  const brief: RepositoryBrief = {
    schemaVersion: 1,
    repository: repo,
    focus,
    coverage: { probes },
    ...(wantsStructure && treeProbe.ok ? { tree: treeProbe.value } : {}),
    ...(wantsReadme && docs !== undefined ? { docs } : {}),
    ...(wantsManifest && entryPoints !== undefined ? { entryPoints } : {}),
    ...(wantsFiles && files.length > 0 ? { files } : {}),
    detected:
      treeProbe.ok
        ? detectBriefSignals(treeProbe.value)
        : { hasReadme: null, hasManifest: null, manifestKinds: null },
  };

  return { kind: "data", data: brief };
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
  brief <owner/repo>            Compose tree + search + read into one envelope

Search Options:
  --language <lang>   Result language: en (default) or zh
  --max-chars <n>     Truncate output to <n> chars

Tree Options:
  --path <path>       Directory path to inspect (default: repo root)
  --depth <n>         Expand subdirectory trees (default: 1)

Read Options:
  --max-chars <n>     Truncate file content to <n> chars

Brief Options:
  --focus <list>              Subset of: structure, readme, manifest, files
                              (default: all four; comma-separated, order preserved)
  --path <path>               Tree scope (search/read have no path parameter)
  --depth <n>                 Tree traversal depth (default: 1)
  --max-chars <n>             Per-call search/read character budget (forwarded
                              to every search and read probe; the tree is
                              never character-limited)

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
  - brief:  {schemaVersion, repository, focus, coverage:{probes},
             tree?, docs?, entryPoints?, files?, detected:{hasReadme,
             hasManifest, manifestKinds}}  (sections gated by --focus;
             coverage.probes records every probe attempt as ok/failed/
             skipped). Tree is never character-limited; --max-chars
             applies per call to searches and reads only.
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
  scoutline repo brief facebook/react
  scoutline repo brief facebook/react --focus structure,readme
  scoutline --provider minimax repo search owner/repo query   # UNSUPPORTED_CAPABILITY

Notes:
  - Repository must be public
  - Use "owner/repo" format (e.g., "facebook/react")
  - Paths are relative to repository root
  - Depth >= 1 returns structured snapshots; depth 1 is also structured
`.trim();
