/**
 * Save-artifact hook construction (save-artifacts T4 / DESIGN D6).
 *
 * The four helpers below moved here from src/index.ts (ruling round)
 * so command modules without a dispatch-layer dependency — notably
 * `commands/science.ts`, which cannot import runtime values from
 * index.js without a module cycle — can build the same hook. Bodies
 * are byte-identical to the index-local versions; index.ts re-exports
 * createSaveArtifactHook unchanged for the existing call sites.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CommandResult, SaveHook } from "../command-invocation.js";
import { formatSuccessOutput } from "./output.js";
import { configuredSecrets, redactSecrets } from "./redact.js";
import { atomicReplaceFile } from "./config-store.js";
import { FileError } from "./errors.js";
import {
  atomicPlaceNoClobber,
  CLI_VERSION,
  newRequestId,
  resolveArtifactsDir,
  writeArtifactWithLogEntry,
  type ProviderRouting,
  type SaveLogEntry,
} from "./artifacts.js";
import type { OutputMode } from "./output.js";
/**
 * Structural deps for {@link createSaveArtifactHook}: only `save`
 * (the {request, capture} input main wires) and `env` (the artifacts
 * root) are read. Declared locally so this module has no import edge
 * into src/index.ts (the dispatch layer) — command modules import
 * this one directly.
 */
/** Mirrors index.ts's SaveRequest (exported there); structural here to keep this module import-edge-clean. */
interface SaveRequestShape {
  exportPath?: string;
  format: "json" | "markdown";
  force: boolean;
}

interface SaveCapableDeps {
  readonly save?: {
    readonly request: SaveRequestShape;
    readonly capture: {
      savedRequestId?: string;
      servedProvider?: import("../providers/types.js").ProviderId;
      servedFrom?: "live" | "cache";
    };
  };
  readonly env: NodeJS.ProcessEnv;
}

const REPORT_SCHEMA_VERSION = 1;

export function artifactHeaderComment(requestId: string): string {
  return `<!-- scoutline artifact requestId=${requestId} schemaVersion=${REPORT_SCHEMA_VERSION} -->`;
}

export function renderMarkdownArtifactBody(
  result: CommandResult,
  redactedData: unknown,
  resolvedSecrets: string[],
  now: () => number,
): string {
  const override = result.kind === "data" ? result.presentations?.markdown : undefined;
  return typeof override === "string"
    ? (redactSecrets(override, resolvedSecrets) as string)
    : formatSuccessOutput(redactedData, "markdown", now);
}

export async function exportTargetExists(filePath: string): Promise<boolean> {
  try {
    // lstat so a dangling symlink counts as existing (review fixup; see
    // assertExportTargetAcceptable).
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createSaveArtifactHook(
  deps: SaveCapableDeps,
  meta: {
    readonly command: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly provider: ProviderRouting;
    readonly outputMode: OutputMode;
  },
): SaveHook | undefined {
  const save = deps.save;
  if (save === undefined) return undefined;
  const { request, capture } = save;
  return async ({ result, resolvedSecrets, now, notice }) => {
    try {
      const dir = resolveArtifactsDir(deps.env);
      const requestId = newRequestId(now());
      // T2a saveRef cross-link: stamp this requestId into the shared
      // capture cell — the journal hook (running after this hook in the
      // same invokeCommand) reads it so the journal entry of the SAME
      // run carries saveRef (PRD AC10).
      capture.savedRequestId = requestId;
      const data = result.kind === "data" ? result.data : result.text;
      const redactedData = redactSecrets(data, resolvedSecrets);
      const content =
        request.format === "markdown"
          ? `${artifactHeaderComment(requestId)}\n${renderMarkdownArtifactBody(result, redactedData, resolvedSecrets, now)}\n`
          : `${JSON.stringify(
              { schemaVersion: REPORT_SCHEMA_VERSION, requestId, result: redactedData },
              null,
              2,
            )}\n`;
      // PR #111 A2: the master target is computed here (the same rule
      // writeArtifact used — `<requestId>.<extension>`) so the entry's
      // masterPath and the file the combined write lays down cannot
      // drift apart.
      const extension = request.format === "markdown" ? "md" : "json";
      const masterPath = path.join(dir, `${requestId}.${extension}`);
      const provider: ProviderRouting =
        meta.provider.mode === "fanout"
          ? meta.provider
          : {
              ...meta.provider,
              // The executor's actual server wins over the pre-run
              // resolution when runtime fallback switched providers (D5).
              effective: capture.servedProvider ?? meta.provider.effective,
              // Issue #108: distinguish "the effective provider served
              // live" from "the effective provider's on-disk cache served
              // (possibly while the provider was unreachable)". Capture
              // unset (non-capable command, pre-run failure) records
              // "live" — the pre-#108 entry's implicit assumption.
              servedFrom: capture.servedFrom ?? "live",
              // Issue #108: unpinned runs previously logged no
              // `requested`, so a cache-served defaulted run was
              // indistinguishable from a pinned live one. Record the
              // defaulted request (pre-run effective) alongside the
              // capture-derived effective.
              ...(meta.provider.requested === undefined
                ? { requested: meta.provider.effective }
                : {}),
            };
      const entry: SaveLogEntry = {
        kind: "save",
        requestId,
        timestamp: now(),
        command: meta.command,
        args: meta.args,
        provider,
        outputFormat: meta.outputMode,
        artifactFormat: request.format,
        cliVersion: CLI_VERSION,
        masterPath: path.basename(masterPath),
        // PR #111 A2: the log carries the ABSOLUTE export path — a
        // relative --save value is resolved against THIS process's cwd,
        // so history reads and `--all` sweeps never reinterpret it in
        // another working directory.
        ...(request.exportPath !== undefined
          ? { exportPath: path.resolve(request.exportPath) }
          : {}),
      };
      const logNotice = await writeArtifactWithLogEntry(dir, requestId, content, entry, {
        format: request.format,
      });
      if (logNotice !== undefined) notice(logNotice);
      if (request.exportPath !== undefined) {
        // Write-time exists-recheck: closes the T3 pre-dispatch race
        // window (DESIGN D6). Without --save-force a target that appeared
        // mid-run is refused, byte-identical.
        if (!request.force && (await exportTargetExists(request.exportPath))) {
          throw new FileError(
            `artifact exists: ${request.exportPath}`,
            "Pass --save-force to overwrite the existing export target.",
          );
        }
        if (request.force) {
          await atomicReplaceFile(request.exportPath, content);
        } else {
          // Atomic check-and-place (review fixup): fs.link fails EEXIST
          // when a target appeared between the recheck and the write, so
          // the no-overwrite refusal is one atomic step, byte-identical
          // for the target, never a mid-run overwrite.
          const placed = await atomicPlaceNoClobber(request.exportPath, content);
          if (!placed) {
            throw new FileError(
              `artifact exists: ${request.exportPath}`,
              "Pass --save-force to overwrite the existing export target.",
            );
          }
        }
        notice(
          `ℹ️  saved artifact ${requestId} (master: ${masterPath}; export: ${request.exportPath})`,
        );
      } else {
        notice(`ℹ️  saved artifact ${requestId} (master: ${masterPath})`);
      }
    } catch (error) {
      if (error instanceof FileError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new FileError(
        `Failed to save artifact: ${message}`,
        "Check the artifacts directory and export path, then retry.",
      );
    }
  };
}
