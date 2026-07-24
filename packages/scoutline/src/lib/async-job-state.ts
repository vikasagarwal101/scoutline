/**
 * Async-job state file — resume mechanism for interrupted async jobs
 * (tech-plan §3, T07 / FC-01).
 *
 * Some Provider operations run asynchronously server-side: a create call
 * starts the job and returns a `requestId`, then a poll call checks it
 * until completion. Tavily Research is the first (POST /research →
 * GET /research/{id}); Firecrawl async Crawl (FC-04) is the second. If
 * the CLI exits (Ctrl-C, crash) mid-poll, the job keeps running and
 * consuming credits/quota. Without a persistence mechanism, the next
 * identical request would start a SECOND job — a double charge.
 *
 * This module persists `{ requestId, identityHash, createdAt, status }`
 * to `<state-dir>/<state-hash>.json` so the next invocation of the same
 * request detects the in-flight job and polls it instead of creating a
 * new one. The state-hash is deterministic for a given
 * `{provider, capability, credentialFingerprint, request}` tuple (see
 * {@link computeAsyncJobStateHash}). The state directory is injected by
 * the caller (the Provider Descriptor resolves it via
 * `asyncJobStateDir(capability)`); this module never touches the cache
 * root, keeping it pure and unit-testable.
 *
 * Boundary rules (ARCHITECTURE.md §2):
 *   - May import normalized errors (none today) and node builtins only.
 *   - Must NOT import cache-root resolution, transport, command
 *     presentation, or a Provider Adapter.
 *
 * Resilience contract (tech-plan §3 / G1-G3):
 *   - `write()` uses `{ flag: "wx" }` for atomic creation. A concurrent
 *     invocation that finds the file already exists gets EEXIST and
 *     polls the existing job instead of creating a new one.
 *   - `read()` catches JSON parse errors, deletes the corrupt file, and
 *     returns `null` (treated as absent → new job created).
 *   - `remove()` deletes the file and ignores ENOENT (already gone).
 *
 * Wire-compat: the persisted `requestId` field name and the `status`
 * enum are fixed by the on-disk format and the SIGINT reader in
 * `commands/research.ts`. They are NOT renamed even though the module
 * is now async-job-generic (critique C1).
 */

import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/**
 * A single in-flight async job's persisted state. `status` tracks the
 * last-seen poll status ("pending" or "in_progress"); the poll loop
 * updates it so a resume after Ctrl-C skips statuses already observed.
 *
 * The `requestId` field name is part of the on-disk wire format and is
 * deliberately kept even though the module is generic — the SIGINT path
 * reads `parsed.requestId` off disk synchronously.
 */
export interface AsyncJobState {
  readonly requestId: string;
  readonly identityHash: string;
  readonly createdAt: string;
  readonly status: "pending" | "in_progress";
}

/**
 * Port the Adapter uses to read/write/remove async-job state. Production
 * wires {@link createProductionAsyncJobStateFile}; tests inject in-memory
 * doubles to exercise the lifecycle deterministically without touching
 * the filesystem.
 */
export interface AsyncJobStateFile {
  read(identityHash: string): Promise<AsyncJobState | null>;
  write(identityHash: string, state: AsyncJobState): Promise<void>;
  remove(identityHash: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Identity hash
// ---------------------------------------------------------------------------

/**
 * Inputs to the async-job state hash. `credentialFingerprint` is the full
 * lowercase SHA-256 hex digest of the active credential (same value used
 * for the response-cache fingerprint). `request` is the normalized
 * Capability request whose recursively key-sorted JSON becomes part of
 * the hash.
 */
export interface AsyncJobStateHashInput {
  readonly provider: string;
  readonly capability: string;
  readonly credentialFingerprint: string;
  readonly request: unknown;
}

/**
 * Recursively sort object keys so `JSON.stringify` produces a stable
 * representation regardless of insertion order. Mirrors the cache module's
 * `sortKeysDeep` so the same request hashes identically here and in the
 * response-cache key.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => sortKeysDeep(element));
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      out[key] = sortKeysDeep(input[key]);
    }
    return out;
  }
  return value;
}

/**
 * Compute the deterministic state-file identity hash for an async job
 * (tech-plan §3 / CR3).
 *
 *   state-hash = SHA-256(recursively-key-sorted-JSON({
 *     provider, capability, credentialFingerprint, request
 *   }))
 *
 * Same canonical approach as `buildProviderCacheKey`'s request hashing,
 * extended to include provider + capability + credential. Rotating the
 * API key orphans old state files (correct — the old job belongs to the
 * old key's billing). The hash never contains a raw credential.
 */
export function computeAsyncJobStateHash(input: AsyncJobStateHashInput): string {
  const payload = {
    provider: input.provider,
    capability: input.capability,
    credentialFingerprint: input.credentialFingerprint,
    request: sortKeysDeep(input.request),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ---------------------------------------------------------------------------
// Production state-file implementation
// ---------------------------------------------------------------------------

/**
 * Build a production {@link AsyncJobStateFile} backed by files under the
 * caller-supplied `dir` (one JSON file per in-flight job, named
 * `<state-hash>.json`). The caller — typically the Provider Descriptor —
 * resolves `dir` via `asyncJobStateDir(capability)`; this module performs
 * no cache-root resolution itself.
 *
 * - `write()` atomically creates the file with `{ flag: "wx" }`. A
 *   concurrent invocation that finds it exists throws EEXIST; the caller
 *   catches that and polls the existing job.
 * - `read()` catches JSON parse errors, deletes the corrupt file, and
 *   returns `null`.
 * - `remove()` deletes the file and ignores ENOENT.
 */
export function createProductionAsyncJobStateFile(dir: string): AsyncJobStateFile {
  function filePath(identityHash: string): string {
    return path.join(dir, `${identityHash}.json`);
  }

  return {
    async read(identityHash: string): Promise<AsyncJobState | null> {
      if (!identityHash) return null;
      const file = filePath(identityHash);
      let raw: string;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch {
        return null;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          await fs.unlink(file).catch(() => {});
          return null;
        }
        const obj = parsed as Record<string, unknown>;
        const requestId = obj.requestId;
        const storedHash = obj.identityHash;
        const createdAt = obj.createdAt;
        const status = obj.status;
        if (
          typeof requestId !== "string" ||
          requestId.length === 0 ||
          typeof storedHash !== "string" ||
          typeof createdAt !== "string" ||
          (status !== "pending" && status !== "in_progress")
        ) {
          await fs.unlink(file).catch(() => {});
          return null;
        }
        return { requestId, identityHash: storedHash, createdAt, status };
      } catch {
        // Corrupt JSON — delete the file so the next run creates a fresh
        // job instead of forever reading garbage.
        await fs.unlink(file).catch(() => {});
        return null;
      }
    },

    async write(identityHash: string, state: AsyncJobState): Promise<void> {
      await fs.mkdir(dir, { recursive: true });
      const file = filePath(identityHash);
      const payload = JSON.stringify(state);
      // `{ flag: "wx" }` atomically creates the file only if it does not
      // exist. A concurrent invocation that lost the race gets EEXIST;
      // the caller catches it and polls the existing job instead of
      // creating a second one.
      await fs.writeFile(file, payload, { flag: "wx" });
    },

    async remove(identityHash: string): Promise<void> {
      const file = filePath(identityHash);
      await fs.unlink(file).catch((err: NodeJS.ErrnoException) => {
        // ENOENT is expected (already removed, or never written). Swallow
        // it; any other error re-throws.
        if (err && err.code === "ENOENT") return;
        throw err;
      });
    },
  };
}

/**
 * Convenience helper exported for the Adapter and tests: builds an
 * in-memory {@link AsyncJobStateFile} that throws EEXIST on a second
 * write to the same hash, mirroring the production `{ flag: "wx" }`
 * contract exactly. The adapter's lifecycle must not depend on whether
 * the state file is disk-backed or memory-backed.
 */
export function createInMemoryAsyncJobStateFile(): AsyncJobStateFile & {
  readonly store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async read(identityHash: string): Promise<AsyncJobState | null> {
      const raw = store.get(identityHash);
      if (raw === undefined) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          store.delete(identityHash);
          return null;
        }
        const obj = parsed as Record<string, unknown>;
        const requestId = obj.requestId;
        const storedHash = obj.identityHash;
        const createdAt = obj.createdAt;
        const status = obj.status;
        if (
          typeof requestId !== "string" ||
          requestId.length === 0 ||
          typeof storedHash !== "string" ||
          typeof createdAt !== "string" ||
          (status !== "pending" && status !== "in_progress")
        ) {
          store.delete(identityHash);
          return null;
        }
        return { requestId, identityHash: storedHash, createdAt, status };
      } catch {
        store.delete(identityHash);
        return null;
      }
    },
    async write(identityHash: string, state: AsyncJobState): Promise<void> {
      if (store.has(identityHash)) {
        const err: NodeJS.ErrnoException = new Error(
          `EEXIST: file already exists, write '${identityHash}.json'`,
        );
        err.code = "EEXIST";
        throw err;
      }
      store.set(identityHash, JSON.stringify(state));
    },
    async remove(identityHash: string): Promise<void> {
      store.delete(identityHash);
    },
  };
}
