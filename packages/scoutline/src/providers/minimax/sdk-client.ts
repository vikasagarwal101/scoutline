/**
 * MiniMax SDK client factory (DESIGN.md §12 — P2-04).
 *
 * This is the ONLY module that imports `mmx-cli/sdk`. The Adapter and
 * registry consume {@link createMiniMaxSdk} plus the injectable
 * {@link MiniMaxSdkConstructor} / {@link MiniMaxSdkPort} types declared
 * in `providers/types.ts`, so the transitional SDK never leaks past
 * this boundary.
 *
 * The characterized SDK reads its own config directory during
 * construction (it calls `getConfigDir()`, which honours
 * `MMX_CONFIG_DIR`). To prevent the SDK from touching the user's real
 * `~/.mmx` state, the factory temporarily points `MMX_CONFIG_DIR` at a
 * unique nonexistent path for the synchronous construction call only,
 * then restores the prior value in `finally`. The temporary directory
 * is NEVER created on disk.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { MiniMaxSDK } from "mmx-cli/sdk";
import type { MiniMaxSdkConstructor, MiniMaxSdkPort } from "../types.js";

const MMX_CONFIG_DIR = "MMX_CONFIG_DIR";

/**
 * Construct a MiniMax SDK port. The optional `constructor` lets tests
 * inject a fake; production omits it and uses the pinned `mmx-cli/sdk`
 * implementation.
 */
export function createMiniMaxSdk(
  options: { apiKey: string; region: "global" | "cn"; baseUrl: string },
  constructor?: MiniMaxSdkConstructor,
): MiniMaxSdkPort {
  const Ctor = constructor ?? (MiniMaxSDK as unknown as MiniMaxSdkConstructor);

  const hadPrev = Object.prototype.hasOwnProperty.call(process.env, MMX_CONFIG_DIR);
  const prev = process.env[MMX_CONFIG_DIR];
  // A unique nonexistent path. It is deliberately never created.
  const temporaryDir = path.join(tmpdir(), `scoutline-minimax-${randomUUID()}`);
  process.env[MMX_CONFIG_DIR] = temporaryDir;
  try {
    // Construction is synchronous and reads MMX_CONFIG_DIR via the
    // SDK's getConfigDir(). The async search/vision calls happen
    // after this block, with the original env already restored.
    return new Ctor(options);
  } finally {
    if (hadPrev) {
      process.env[MMX_CONFIG_DIR] = prev;
    } else {
      delete process.env[MMX_CONFIG_DIR];
    }
  }
}
