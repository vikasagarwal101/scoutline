/**
 * Watch store (watch-temporal-diff lane B, ticket T2).
 *
 * Persistence substrate for the `watch` family — no fetch, no diffing,
 * no exit codes here; the tick orchestrator (T5) drives it. Layout
 * under one root (`SCOUTLINE_WATCH_DIR`, else `<config root>/watch`,
 * resolved pure like {@link resolveArtifactsDir}):
 *
 *   <root>/targets.json            — registry (atomic replace under lock)
 *   <root>/<targetId>/snapshots/gen-<n>.snapshot   — bounded ring
 *   <root>/<targetId>/change-log.jsonl             — append-only, never pruned
 *
 * Invariants (binding plan rulings #3/#4/#6):
 *   - ids are minted `newRequestId`-style (`<UTC compact>-<4 hex>`) so
 *     same-second adds still differ, sort chronologically, and are
 *     never reused: uniqueness is enforced against BOTH live ids and
 *     the retired-id tombstones default removal leaves behind.
 *   - the ring advances ONLY through {@link appendSnapshot}: a failed
 *     capture is a change-log `error` entry with `gen: null` and the
 *     snapshot listing is untouched. There is no other gen-advancing
 *     call — this module pins that by construction.
 *   - generation numbers are 1-based and derived from the current MAX
 *     gen (never a file count), so a crash mid-prune that leaves extra
 *     old generations on disk cannot reissue a number.
 *   - the change log is JSONL, appended one `\n`-terminated line per
 *     entry under the per-target lock, and read FAILS CLOSED LOUDLY:
 *     an unknown kind or malformed line throws ValidationError — never
 *     silently skipped (contrast {@link readLog}, which fails open:
 *     curated history tolerates holes; audit evidence must not).
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  atomicReplaceFile,
  resolveConfigRootPure,
  type ConfigRootEnvironment,
  type ConfigRootPlatform,
} from "./config-store.js";
import { ValidationError } from "./errors.js";
import {
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  withAsyncFileLock,
} from "./async-file-lock.js";
import { newRequestId, type RandomBytesSource } from "./artifacts.js";

/** Registry filename under the watch root. */
export const WATCH_REGISTRY_FILENAME = "targets.json";
/** Change-log filename under a target dir. */
export const WATCH_CHANGELOG_FILENAME = "change-log.jsonl";
/** Snapshot files live in this per-target subdir as `gen-<n>.snapshot`. */
export const WATCH_SNAPSHOTS_DIRNAME = "snapshots";

/** Default ring size (`--keep` overrides per target; plan ruling #6). */
export const WATCH_DEFAULT_KEEP = 5;
/** Smallest legal ring size. */
export const WATCH_MIN_KEEP = 1;
/** Largest legal ring size. */
export const WATCH_MAX_KEEP = 100;

/** v1 target type discriminator (plan ruling #4: page only, additive kinds later). */
export type WatchTargetType = "page";

/** One registry row in `targets.json`. */
export interface WatchTarget {
  readonly id: string;
  readonly name: string;
  readonly type: WatchTargetType;
  readonly url: string;
  readonly keep: number;
  readonly createdAt: string;
}

/** Full registry file shape. */
export interface WatchRegistry {
  readonly targets: readonly WatchTarget[];
  /** Retired ids (default removal leaves the dir): ids are never reused. */
  readonly retiredIds?: readonly string[];
}

/** Environment keys {@link resolveWatchDir} reads. */
export interface WatchDirEnvironment extends ConfigRootEnvironment {
  readonly SCOUTLINE_WATCH_DIR?: string;
}

/**
 * Watch root: `SCOUTLINE_WATCH_DIR` wins; otherwise the config root's
 * `watch/` sibling. Pure — the caller supplies env and platform; the
 * thin `process.env`-reading wrapper is left to the command layer (the
 * {@link newRequestId}/{@link resolveArtifactsDir} pattern) so tests
 * never touch process.env.
 */
export function resolveWatchDir(
  env: WatchDirEnvironment,
  platform: ConfigRootPlatform = { homedir: os.homedir() },
): string {
  return env.SCOUTLINE_WATCH_DIR || path.join(resolveConfigRootPure(env, platform), "watch");
}

/** Injectable knobs for store calls (tests inject small lock timings). */
export interface WatchStoreOptions {
  /** Lock-timing overrides (tests use small values). */
  readonly lock?: {
    readonly timeoutMs?: number;
    readonly staleMs?: number;
    readonly setTimeout?: typeof setTimeout;
  };
}

/** Options for {@link addTarget}. */
export interface AddTargetOptions extends WatchStoreOptions {
  /** The page URL to watch (http(s) only, v1). */
  readonly url: string;
  /** Caller-supplied `--name`; omitted → minted from the URL host+path. */
  readonly name?: string;
  /** Ring size; omitted → {@link WATCH_DEFAULT_KEEP}. */
  readonly keep?: number;
  /** Injection seams — never Date.now()/crypto inside the store. */
  readonly now?: Date | number;
  readonly randomBytes?: RandomBytesSource;
}

/** Options for {@link removeTarget}. */
export interface RemoveTargetOptions extends WatchStoreOptions {
  /** true → also delete the per-target dir (default keeps the evidence). */
  readonly purge?: boolean;
}

/** Stored snapshot metadata (JSON sidecar, `gen-<n>.snapshot`). */
export interface SnapshotMetadata {
  readonly gen: number;
  readonly capturedAt: string;
  readonly byteLength: number;
  readonly contentType?: string;
  readonly finalUrl?: string;
}

/** Options for {@link appendSnapshot}. */
export interface AppendSnapshotOptions extends WatchStoreOptions {
  readonly body: Uint8Array;
  /** Timestamp from the CALLER's injected instant; never Date.now(). */
  readonly now: Date | number;
  /** Final content type after redirects, e.g. `text/html; charset=gbk`. */
  readonly contentType?: string;
  /** Post-redirect URL (plan ruling #7: `finalUrl` recorded). */
  readonly finalUrl?: string;
}

/** {@link readSnapshot} result: raw captured bytes plus their metadata. */
export interface WatchSnapshot extends SnapshotMetadata {
  readonly body: Uint8Array;
}

/** v1 change-log kinds (binding set — future kinds extend this union). */
export type ChangeLogKind = "baseline" | "change" | "moved" | "error" | "no-change";

const CHANGE_LOG_KINDS: readonly ChangeLogKind[] = [
  "baseline",
  "change",
  "moved",
  "error",
  "no-change",
];

/** One appended change-log line. */
export interface ChangeLogEntry {
  readonly at: Date | number | string;
  readonly kind: ChangeLogKind;
  readonly exit: 0 | 1 | 2;
  /** Generation the entry refers to; null for `error` (ring did not advance). */
  readonly gen: number | null;
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
  readonly changed?: readonly string[];
  readonly hashOnly?: boolean;
  readonly finalUrl?: string;
}

/** Parsed change-log line (same shape, `at` normalized to ISO). */
export interface ParsedChangeLogEntry {
  readonly at: string;
  readonly kind: ChangeLogKind;
  readonly exit: number;
  readonly gen: number | null;
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
  readonly changed?: readonly string[];
  readonly hashOnly?: boolean;
  readonly finalUrl?: string;
}

/** Fixed lock identities (the `artifacts-write` precedent). */
const REGISTRY_LOCK = "watch-registry";
const targetLock = (id: string): string => `watch-target-${id}`;

function lockOptions(
  label: string,
  lock: WatchStoreOptions["lock"],
): Parameters<typeof withAsyncFileLock>[3] {
  return {
    timeoutMs: lock?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: lock?.staleMs ?? DEFAULT_LOCK_STALE_MS,
    setTimeout: lock?.setTimeout,
    timeoutLabel: label,
  };
}

function toIso(value: Date | number | string): string {
  return new Date(value).toISOString();
}

async function isEnoent(error: unknown): Promise<boolean> {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Registry read: missing file is the empty registry; malformed is loud. */
async function readRegistry(root: string): Promise<WatchRegistry> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, WATCH_REGISTRY_FILENAME), "utf8");
  } catch (error) {
    if (await isEnoent(error)) return { targets: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError(
      "watch targets.json is corrupt (invalid JSON)",
      "Fix or remove the file in the watch directory.",
    );
  }
  const candidate = parsed as { targets?: unknown; retiredIds?: unknown };
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !Array.isArray(candidate.targets) ||
    (candidate.retiredIds !== undefined && !Array.isArray(candidate.retiredIds))
  ) {
    throw new ValidationError(
      "watch targets.json has an unrecognized shape",
      'Expected {"targets":[...]} — fix or remove the file in the watch directory.',
    );
  }
  return {
    targets: candidate.targets as WatchTarget[],
    ...(candidate.retiredIds !== undefined
      ? { retiredIds: candidate.retiredIds as string[] }
      : {}),
  };
}

async function writeRegistry(root: string, registry: WatchRegistry): Promise<void> {
  await atomicReplaceFile(
    path.join(root, WATCH_REGISTRY_FILENAME),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
}

/** http(s) page URL guard — v1 watch targets are fetchable pages only. */
function requireHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`Invalid watch target URL "${url}".`, "Use a full http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ValidationError(
      `Unsupported watch target URL scheme "${parsed.protocol}"`,
      "Only http(s) page URLs are watchable in v1.",
    );
  }
  return parsed;
}

/** Default name from the URL: host + path slug, `--name` override wins. */
function mintName(parsed: URL): string {
  const slug = parsed.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.replace(/[^a-zA-Z0-9-]+/g, "-"))
    .join("-");
  return slug === "" ? parsed.host : `${parsed.host}-${slug}`;
}

function requireKeep(keep: number): void {
  if (!Number.isInteger(keep) || keep < WATCH_MIN_KEEP || keep > WATCH_MAX_KEEP) {
    throw new ValidationError(
      `Invalid keep ${keep}: must be an integer between ${WATCH_MIN_KEEP} and ${WATCH_MAX_KEEP}.`,
      "Use --keep <1..100>.",
    );
  }
}

/**
 * Register a watch target. Name defaults to the URL host+path slug;
 * names are unique case-sensitively; ids are minted `newRequestId`-style
 * and checked against both live and retired ids (never reused). The
 * read-check-write runs under the registry lock, so concurrent adds
 * serialize and the loser's duplicate name is caught.
 */
export async function addTarget(
  root: string,
  options: AddTargetOptions,
): Promise<WatchTarget> {
  const parsed = requireHttpUrl(options.url);
  const name = options.name?.trim() || mintName(parsed);
  const keep = options.keep ?? WATCH_DEFAULT_KEEP;
  requireKeep(keep);
  return withAsyncFileLock(
    root,
    REGISTRY_LOCK,
    async () => {
      const registry = await readRegistry(root);
      const nameTaken = registry.targets.some((target) => target.name === name);
      if (nameTaken) {
        throw new ValidationError(
          `Watch target name "${name}" is already in use.`,
          "Use a different --name, or remove the existing target first.",
        );
      }
      // Mint under the lock and retire-check so a removed target's id is
      // never reissued (ids are historical anchors for change logs).
      const now = options.now ?? new Date();
      let id: string;
      do {
        id = newRequestId(now, options.randomBytes);
      } while (
        registry.targets.some((target) => target.id === id) ||
        (registry.retiredIds?.includes(id) ?? false)
      );
      const target: WatchTarget = {
        id,
        name,
        type: "page",
        url: parsed.toString(),
        keep,
        createdAt: toIso(now),
      };
      await writeRegistry(root, { targets: [...registry.targets, target] });
      return target;
    },
    lockOptions("Watch registry write", options.lock),
  );
}

/** Registry listing, ascending by id (== chronological, ids sort). */
export async function listTargets(root: string): Promise<readonly WatchTarget[]> {
  const registry = await readRegistry(root);
  return [...registry.targets].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Resolve one target by exact id, else by exact name. */
export async function getTarget(root: string, ref: string): Promise<WatchTarget> {
  const registry = await readRegistry(root);
  const byId = registry.targets.find((target) => target.id === ref);
  if (byId) return byId;
  const byName = registry.targets.find((target) => target.name === ref);
  if (byName) return byName;
  throw unknownTargetError(ref);
}

function unknownTargetError(ref: string): ValidationError {
  return new ValidationError(
    `Unknown watch target "${ref}".`,
    'Run "scoutline watch list" to see the registered targets.',
  );
}

/**
 * Identity-guarded removal. Default removal deletes ONLY the registry
 * entry — the `<root>/<id>/` change log is evidence and is never pruned
 * implicitly; the id is retired so it is never reused. `purge: true`
 * also deletes the per-target directory.
 */
export async function removeTarget(
  root: string,
  ref: string,
  options: RemoveTargetOptions = {},
): Promise<WatchTarget> {
  return withAsyncFileLock(
    root,
    REGISTRY_LOCK,
    async () => {
      const registry = await readRegistry(root);
      const target =
        registry.targets.find((candidate) => candidate.id === ref) ??
        registry.targets.find((candidate) => candidate.name === ref);
      if (!target) throw unknownTargetError(ref);
      await writeRegistry(root, {
        targets: registry.targets.filter((candidate) => candidate.id !== target.id),
        retiredIds: [...(registry.retiredIds ?? []), target.id],
      });
      if (options.purge) {
        await fs.rm(path.join(root, target.id), { recursive: true, force: true });
      }
      return target;
    },
    lockOptions("Watch registry write", options.lock),
  );
}

// ---------------------------------------------------------------------------
// Snapshot ring
// ---------------------------------------------------------------------------

function snapshotDir(root: string, id: string): string {
  return path.join(root, id, WATCH_SNAPSHOTS_DIRNAME);
}

function snapshotPath(root: string, id: string, gen: number): string {
  return path.join(snapshotDir(root, id), `gen-${gen}.snapshot`);
}

/** Parse `gen-<n>.snapshot` filenames; anything else is not a generation. */
function genFromFilename(filename: string): number | undefined {
  const match = /^gen-(\d+)\.snapshot$/.exec(filename);
  return match ? Number(match[1]) : undefined;
}

/**
 * List a target's surviving generations with their metadata, ascending.
 * Reads only `gen-<n>.snapshot` files (the metadata sidecar IS the file —
 * bytes live in a sibling `.bytes` file so metadata stays plain JSON).
 */
export async function listSnapshots(
  root: string,
  id: string,
): Promise<readonly SnapshotMetadata[]> {
  const dir = snapshotDir(root, id);
  let filenames: string[];
  try {
    filenames = await fs.readdir(dir);
  } catch (error) {
    if (await isEnoent(error)) return [];
    throw error;
  }
  const metadata: SnapshotMetadata[] = [];
  for (const filename of filenames) {
    const gen = genFromFilename(filename);
    if (gen === undefined) continue;
    const raw = await fs.readFile(path.join(dir, filename), "utf8");
    metadata.push(JSON.parse(raw) as SnapshotMetadata);
  }
  return metadata.sort((a, b) => a.gen - b.gen);
}

async function requireTarget(root: string, id: string): Promise<WatchTarget> {
  const registry = await readRegistry(root);
  const target = registry.targets.find((candidate) => candidate.id === id);
  if (!target) throw unknownTargetError(id);
  return target;
}

/**
 * Append one generation to a target's snapshot ring and return its
 * generation number. The ONLY gen-advancing call in the store. Ordering:
 * mkdir → write gen file → unlink old generations. Atomic-enough first:
 * the new generation is complete on disk before any old generation is
 * unlinked — a crash mid-prune leaves extra old generations, never a
 * hole at the head; the next append re-prunes (keep is recomputed from
 * the full on-disk listing, not from an assumed ring shape).
 */
export async function appendSnapshot(
  root: string,
  id: string,
  options: AppendSnapshotOptions,
): Promise<number> {
  const target = await requireTarget(root, id);
  return withAsyncFileLock(
    path.join(root, id),
    targetLock(id),
    async () => {
      await fs.mkdir(snapshotDir(root, id), { recursive: true, mode: 0o700 });
      // Max gen on disk — NOT a file count: crash leftovers must not
      // reissue a number.
      const listing = await listSnapshots(root, id);
      const maxGen = listing.reduce((max, snap) => Math.max(max, snap.gen), 0);
      const gen = maxGen + 1;
      const bytesPath = path.join(snapshotDir(root, id), `gen-${gen}.snapshot.bytes`);
      await fs.writeFile(bytesPath, options.body, { mode: 0o600 });
      const metadata: SnapshotMetadata = {
        gen,
        capturedAt: toIso(options.now),
        byteLength: options.body.byteLength,
        ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
        ...(options.finalUrl !== undefined ? { finalUrl: options.finalUrl } : {}),
      };
      // Atomic-enough ordering: metadata sidecar last. A reader that sees
      // a gen file without its bytes file skips it; bytes without a gen
      // file are invisible to the listing and swept by the prune below.
      await atomicReplaceFile(snapshotPath(root, id, gen), `${JSON.stringify(metadata)}\n`);
      // Prune old generations AFTER the new one is durable. keep is
      // recomputed from the listing every time, so stale survivors from
      // a crashed prune are swept here too.
      const survivors = [...listing, metadata].sort((a, b) => a.gen - b.gen);
      const excess = survivors.slice(0, Math.max(0, survivors.length - target.keep));
      for (const stale of excess) {
        await fs
          .unlink(path.join(snapshotDir(root, id), `gen-${stale.gen}.snapshot`))
          .catch(() => {});
        await fs
          .unlink(path.join(snapshotDir(root, id), `gen-${stale.gen}.snapshot.bytes`))
          .catch(() => {});
      }
      return gen;
    },
    lockOptions("Watch snapshot append", options.lock),
  );
}

/**
 * Read one generation: raw captured bytes plus metadata. A gen whose
 * metadata or bytes are missing (crashed append) is a ValidationError —
 * the ring never advances past a hole, so a listed gen must read.
 */
export async function readSnapshot(root: string, id: string, gen: number): Promise<WatchSnapshot> {
  const dir = snapshotDir(root, id);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, `gen-${gen}.snapshot`), "utf8");
  } catch {
    throw new ValidationError(
      `Watch target ${id} has no snapshot generation ${gen}.`,
      "Run the target's snapshots through listSnapshots for the surviving gens.",
    );
  }
  const metadata = JSON.parse(raw) as SnapshotMetadata;
  let body: Uint8Array;
  try {
    body = new Uint8Array(
      await fs.readFile(path.join(dir, `gen-${gen}.snapshot.bytes`)),
    );
  } catch {
    throw new ValidationError(
      `Snapshot generation ${gen} of ${id} is missing its captured bytes.`,
      "The snapshot is incomplete; treat the generation as absent.",
    );
  }
  return { ...metadata, body };
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

function validateKind(kind: string): asserts kind is ChangeLogKind {
  if (!(CHANGE_LOG_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(
      `Unknown change-log kind "${kind}".`,
      `Use one of: ${CHANGE_LOG_KINDS.join(", ")}.`,
    );
  }
}

/**
 * Structural guard for one parsed log line. Unknown kinds are a
 * ValidationError — the reader fails closed loudly rather than skipping
 * (audit evidence must never thin itself; contrast the artifacts log's
 * fail-open reads).
 */
function parseChangeLogLine(file: string, line: string, index: number): ParsedChangeLogEntry {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new ValidationError(
      `Change log ${file} line ${index} is malformed JSON.`,
      "The log is append-only evidence; repair it by hand or remove the file to reset.",
    );
  }
  const kind = parsed.kind;
  if (typeof kind !== "string" || !(CHANGE_LOG_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(
      `Change log ${file} line ${index} has unknown kind ${JSON.stringify(kind)}.`,
      "The log is append-only evidence; repair it by hand or remove the file to reset.",
    );
  }
  return {
    at: typeof parsed.at === "string" ? parsed.at : String(parsed.at),
    kind: kind as ChangeLogKind,
    exit: typeof parsed.exit === "number" ? parsed.exit : Number(parsed.exit),
    gen: parsed.gen === null ? null : Number(parsed.gen),
    ...(parsed.added !== undefined ? { added: parsed.added as string[] } : {}),
    ...(parsed.removed !== undefined ? { removed: parsed.removed as string[] } : {}),
    ...(parsed.changed !== undefined ? { changed: parsed.changed as string[] } : {}),
    ...(parsed.hashOnly !== undefined ? { hashOnly: Boolean(parsed.hashOnly) } : {}),
    ...(parsed.finalUrl !== undefined ? { finalUrl: parsed.finalUrl as string } : {}),
  };
}

/**
 * Read a target's full change log. Missing/empty file → []. Malformed
 * JSON or unknown kinds throw ValidationError — fail-closed, loudly,
 * never a silent skip.
 */
export async function readChangeLog(
  root: string,
  id: string,
): Promise<readonly ParsedChangeLogEntry[]> {
  const file = path.join(root, id, WATCH_CHANGELOG_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (await isEnoent(error)) return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line, index) => parseChangeLogLine(file, line, index + 1));
}

/**
 * Append one change-log entry as a single `\n`-terminated JSON line,
 * under the per-target lock so concurrent double-fires serialize (the
 * JSONL analogue of {@link appendLogEntry} — no lost update, no torn
 * line). Validation happens BEFORE the file is opened: an unknown kind
 * never reaches disk.
 */
export async function appendChangeLog(
  root: string,
  id: string,
  entry: ChangeLogEntry,
  options: WatchStoreOptions = {},
): Promise<void> {
  validateKind(entry.kind);
  const line = `${JSON.stringify({
    at: toIso(entry.at),
    kind: entry.kind,
    exit: entry.exit,
    gen: entry.gen,
    ...(entry.added !== undefined ? { added: entry.added } : {}),
    ...(entry.removed !== undefined ? { removed: entry.removed } : {}),
    ...(entry.changed !== undefined ? { changed: entry.changed } : {}),
    ...(entry.hashOnly !== undefined ? { hashOnly: entry.hashOnly } : {}),
    ...(entry.finalUrl !== undefined ? { finalUrl: entry.finalUrl } : {}),
  })}\n`;
  await withAsyncFileLock(
    path.join(root, id),
    targetLock(id),
    async () => {
      await fs.mkdir(path.join(root, id), { recursive: true, mode: 0o700 });
      // 0600, same discipline as atomicReplaceFile and the snapshot
      // bytes: evidence files are owner-only.
      const handle = await fs.open(path.join(root, id, WATCH_CHANGELOG_FILENAME), "a", 0o600);
      try {
        await handle.writeFile(line);
      } finally {
        await handle.close();
      }
    },
    lockOptions("Watch change-log append", options.lock),
  );
}
