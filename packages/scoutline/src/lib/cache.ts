/**
 * Local response cache for Z.AI API responses.
 *
 * Stores the RAW response from Z.AI (before any post-processing like
 * truncation, format conversion, or extraction) keyed by a hash of the
 * command + request-affecting arguments. Post-processing flags like
 * --max-chars, --output-format, --extract are NOT part of the cache key,
 * so the same cached response can serve multiple presentation variants.
 *
 * Default TTL: 24h. Default size cap: 100MB. LRU eviction when full.
 * Disable per-call with --no-cache.
 */

import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getApiKey } from "./config.js";

const DEFAULT_TTL_MS = parseInt(process.env.ZAI_CACHE_TTL_MS || "", 10) || 24 * 60 * 60 * 1000;
const DEFAULT_SIZE_CAP_BYTES =
  parseInt(process.env.ZAI_CACHE_SIZE_MB || "", 10) * 1024 * 1024 || 100 * 1024 * 1024;
const CACHE_ENABLED = !["0", "false"].includes((process.env.ZAI_CACHE || "1").toLowerCase());

interface CacheEntry<T> {
  ts: number;
  data: T;
}

function resolveCacheDir(): string {
  const explicit = process.env.ZAI_CACHE_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CACHE_HOME;
  // Retain the adapter cache location until provider configuration is generalized.
  if (xdg) return path.join(xdg, "zai-cli", "responses");
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "zai-cli", "responses");
  }
  return path.join(os.homedir(), ".cache", "zai-cli", "responses");
}

/**
 * Build a stable cache key from command + request-affecting args.
 * Post-processing flags (maxChars, outputFormat, extract, fullEnvelope)
 * are intentionally excluded so one cached fetch serves many presentations.
 */
export function buildCacheKey(command: string, requestArgs: Record<string, unknown>): string {
  const apiKey = getApiKey();
  // Namespace by api key hash so different keys never collide
  const keyHash = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12);
  const payload = JSON.stringify({ command, args: requestArgs });
  const argsHash = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 24);
  return `${command}.${keyHash}.${argsHash}.json`;
}

export function isCacheEnabled(): boolean {
  return CACHE_ENABLED;
}

export async function readCache<T>(key: string, ttlMs = DEFAULT_TTL_MS): Promise<T | null> {
  if (!CACHE_ENABLED || ttlMs <= 0) return null;
  const file = path.join(resolveCacheDir(), key);
  try {
    const raw = await fs.readFile(file, "utf8");
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (!entry || typeof entry.ts !== "number") return null;
    if (Date.now() - entry.ts > ttlMs) return null;
    // Touch the file for LRU freshness (best-effort)
    await fs.utimes(file, new Date(), new Date()).catch(() => {});
    return entry.data;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  if (!CACHE_ENABLED) return;
  const dir = resolveCacheDir();
  const file = path.join(dir, key);
  try {
    await fs.mkdir(dir, { recursive: true });
    const entry: CacheEntry<T> = { ts: Date.now(), data };
    await fs.writeFile(file, JSON.stringify(entry));
    await evictIfNeeded(dir);
  } catch {
    // Best-effort cache only
  }
}

async function evictIfNeeded(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    const stats = await Promise.all(
      entries.map(async (name) => {
        try {
          const p = path.join(dir, name);
          const s = await fs.stat(p);
          return { name, size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    const valid = stats.filter((s): s is NonNullable<typeof s> => s !== null);
    const totalBytes = valid.reduce((sum, e) => sum + e.size, 0);
    if (totalBytes <= DEFAULT_SIZE_CAP_BYTES) return;
    // Evict oldest until under cap
    const sorted = valid.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let bytes = totalBytes;
    for (const entry of sorted) {
      if (bytes <= DEFAULT_SIZE_CAP_BYTES * 0.8) break;
      await fs.unlink(path.join(dir, entry.name)).catch(() => {});
      bytes -= entry.size;
    }
  } catch {
    // Best-effort
  }
}

export async function clearCache(): Promise<{ cleared: number; bytesFreed: number }> {
  const dir = resolveCacheDir();
  let cleared = 0;
  let bytesFreed = 0;
  try {
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      const p = path.join(dir, name);
      try {
        const s = await fs.stat(p);
        await fs.unlink(p);
        cleared += 1;
        bytesFreed += s.size;
      } catch {
        // skip
      }
    }
  } catch {
    // dir doesn't exist
  }
  return { cleared, bytesFreed };
}

export async function cacheStats(): Promise<{
  entries: number;
  totalBytes: number;
  dir: string;
  ttlMs: number;
  sizeCapBytes: number;
  enabled: boolean;
}> {
  const dir = resolveCacheDir();
  let entries = 0;
  let totalBytes = 0;
  try {
    const names = await fs.readdir(dir);
    for (const name of names) {
      try {
        const s = await fs.stat(path.join(dir, name));
        entries += 1;
        totalBytes += s.size;
      } catch {
        // skip
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return {
    entries,
    totalBytes,
    dir,
    ttlMs: DEFAULT_TTL_MS,
    sizeCapBytes: DEFAULT_SIZE_CAP_BYTES,
    enabled: CACHE_ENABLED,
  };
}
