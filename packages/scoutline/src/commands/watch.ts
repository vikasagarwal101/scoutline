/**
 * watch command — keyless page monitoring registry (watch-temporal-diff
 * lane B, T4).
 *
 * The stateful family over the T2 watch store:
 *
 *   - `watch add <url> [--name <name>] [--keep <1..100>]` — register a
 *     page target; the name defaults to the URL host+path slug.
 *   - `watch list` — the registry, ascending by id (chronological).
 *   - `watch remove <name-or-id> [--purge]` — identity-guarded removal;
 *     the change-log evidence dir survives by default, `--purge` drops it.
 *   - `watch run` — the cron tick with the 0/1/2 exit contract.
 *   - `watch feed <name-or-id> [--format <jsonl|rss>]` — the change
 *     history as a document: jsonl streams the change log verbatim,
 *     rss renders change/moved entries as RSS 2.0.
 *
 * Credential-free (no Provider resolution, no Adapter, no quota
 * tracking) and dispatched before the credentialed config load — but
 * stateful BY DESIGN: the persistent snapshot ring and change log live
 * under `SCOUTLINE_WATCH_DIR` / `<config root>/watch`, which is exactly
 * why the dispatcher rejects `--isolated` (a unique artifacts namespace
 * would silently orphan the monitored state).
 */

import type {
  CommandResult,
  CommandInvocationAdapter,
  TextOutputMode,
} from "../command-invocation.js";
import { invokeCommand } from "../command-invocation.js";
import type { OutputMode } from "../lib/output.js";
import { ValidationError } from "../lib/errors.js";
import type { HandlerDependencies } from "../index.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  resolveWatchDir,
  addTarget,
  listTargets,
  removeTarget,
  getTarget,
  listSnapshots,
  readSnapshot,
  readChangeLog,
  appendSnapshot,
  appendChangeLog,
  WATCH_DEFAULT_KEEP,
  WATCH_MIN_KEEP,
  WATCH_MAX_KEEP,
  WATCH_CHANGELOG_FILENAME,
  type WatchTarget,
  type WatchDirEnvironment,
  type ParsedChangeLogEntry,
} from "../lib/watch-store.js";
import { extractSections, diffDocuments } from "../lib/section-diff.js";
import {
  fetchLiveDocument,
  charsetFromContentType,
  isSameDocumentUrl,
} from "./archive.js";

export const WATCH_HELP = `
scoutline watch <subcommand> [args] [options] - Keyless page monitoring

Register pages, run cron ticks, and read the change history — all
state lives under SCOUTLINE_WATCH_DIR (default ~/.scoutline/watch).
No credentials, no Providers; watch is stateful by design and cannot
run under --isolated.

Subcommands:
  add <url>                Register a page target (http(s) only)
  list                     List registered targets (oldest first)
  remove <name-or-id>      Remove a target; the change-log evidence dir
                           survives unless --purge is passed
  run <name-or-id|--all>   One monitoring tick (0=no change, 1=change,
                           2=fetch error; --all: worst wins)
  feed <name-or-id>        Change history as JSONL or RSS 2.0

Options for 'watch add':
  --name <name>            Target name (default: host+path slug); names
                           are unique case-sensitively
  --keep <1..100>          Snapshot ring size (default: 5)

Options for 'watch remove':
  --purge                  Also delete the per-target change log and
                           snapshots (default keeps the evidence)

Options for 'watch run':
  --timeout <ms>           Live fetch timeout in milliseconds
                           (default: 30000; must be a positive integer)

Options for 'watch feed':
  --format <jsonl|rss>     Feed format (default: jsonl). jsonl streams
                           the change log verbatim; rss renders change
                           and moved entries as an RSS 2.0 document —
                           in both modes stdout IS the document

Global Options:
  --output-format, -O      Output format: data, json, pretty, compact, markdown, refs, tty
`.trim();

/** Report envelope for `watch add` (the registry entry + removal evidence). */
export interface WatchAddReport extends WatchTarget {
  readonly schemaVersion: 1;
}

/** Report envelope for `watch remove`. */
export interface WatchRemoveReport {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly url: string;
  readonly keep: number;
  readonly createdAt: string;
  /** true when --purge deleted the per-target evidence dir. */
  readonly purged: boolean;
}

/** Report envelope for `watch list`. */
export interface WatchListReport {
  readonly schemaVersion: 1;
  readonly total: number;
  readonly targets: readonly WatchTarget[];
}

/**
 * Parse CLI args for the watch command (the `parseArchiveArgs` shape:
 * `--help`-aware, leading `--flags` never displace the subcommand).
 */
export function parseWatchArgs(args: readonly string[]): {
  readonly subcommand?: string;
  readonly positional: readonly string[];
  readonly flags: Record<string, string | boolean>;
  readonly showHelp: boolean;
} {
  let showHelp = false;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      i++;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
      i++;
    } else {
      i++;
    }
  }

  const subcommand = positional[0];
  return { subcommand, positional: positional.slice(1), flags, showHelp };
}

/**
 * `--keep` gate: strict decimal integer in 1..100, BEFORE the store is
 * touched (same gate class as the limit parses — `Number()` alone would
 * admit "1e2", " 5", and "5.0" spellings the contract excludes).
 */
function parseKeep(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  // `--no-keep <x>` lands here as `false` — same valueless refusal.
  if (typeof raw !== "string") {
    throw new ValidationError(
      "--keep requires a value.",
      `Pass an integer between ${WATCH_MIN_KEEP} and ${WATCH_MAX_KEEP}, e.g. --keep 10.`,
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(
      `Invalid --keep value "${raw}".`,
      `--keep must be an integer between ${WATCH_MIN_KEEP} and ${WATCH_MAX_KEEP}, e.g. --keep 10.`,
    );
  }
  const keep = Number(raw);
  if (keep < WATCH_MIN_KEEP || keep > WATCH_MAX_KEEP) {
    throw new ValidationError(
      `Invalid --keep value "${raw}".`,
      `--keep must be an integer between ${WATCH_MIN_KEEP} and ${WATCH_MAX_KEEP}, e.g. --keep 10.`,
    );
  }
  return keep;
}

function parseName(raw: string | boolean | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // `--no-name <x>` lands here as `false` — same valueless refusal.
  if (typeof raw !== "string") {
    throw new ValidationError(
      "--name requires a value.",
      "Pass a non-empty target name, e.g. --name example-docs.",
    );
  }
  if (raw.trim() === "") {
    throw new ValidationError(
      "--name cannot be empty.",
      "Pass a non-empty target name, e.g. --name example-docs.",
    );
  }
  return raw;
}

function watchPresentations(
  text: string,
): Partial<Record<TextOutputMode, string>> {
  return { tty: text, compact: text, markdown: text, refs: text };
}

function formatTargetRow(target: WatchTarget): string {
  return `${target.id}  ${target.name}  keep=${target.keep}  ${target.url}`;
}

// ---------------------------------------------------------------------------
// watch run (T5 — the cron tick)
// ---------------------------------------------------------------------------

/** Default live-fetch timeout (reuses the fetch-command constant value). */
const RUN_DEFAULT_TIMEOUT_MS = 30000;
/** Live response cap per tick (the 50MB fetch-command default class). */
const RUN_MAX_BYTES = 50 * 1024 * 1024;

/** `watch run` report payload (frozen contract; data-only stdout). */
export interface WatchRunReport {
  readonly schemaVersion: 1;
  readonly target: string;
  readonly gen: number | null;
  readonly result: "baseline" | "no-change" | "change" | "moved" | "error";
  readonly baseline?: boolean;
  readonly diff?: { added: string[]; removed: string[]; changed: string[] };
  readonly hashOnly?: boolean;
  readonly finalUrl?: string | null;
  /** Present only when result is "moved" (plan ruling #7). */
  readonly moved?: boolean;
  /** Present only when result is "error" (the failure reason). */
  readonly reason?: string;
  readonly prevAt: string | null;
  readonly nowAt: string;
}

/** `watch run --all` payload: one report per target, id (chronological) order. */
export interface WatchRunAllReport {
  readonly schemaVersion: 1;
  readonly results: readonly WatchRunReport[];
}

/**
 * `--timeout` gate: strict positive integer, matching the `--keep` gate
 * class (`Number()` alone would admit "1e3", " 300", "300.0").
 */
function parseTimeout(raw: string | boolean | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ValidationError(
      "--timeout requires a value.",
      "Pass a positive integer of milliseconds, e.g. --timeout 30000.",
    );
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new ValidationError(
      `Invalid --timeout value "${raw}".`,
      "--timeout must be a positive integer of milliseconds, e.g. --timeout 30000.",
    );
  }
  return Number(raw);
}

/** Descriptive message for a live-fetch failure (exit-2 path). */
function fetchFailureReason(url: string, error: unknown): string {
  if (error instanceof ValidationError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return `live fetch of ${url} failed: ${message}`;
}

/**
 * One monitoring tick against one target (plan rulings #5/#7 + the T5
 * dispatch brief):
 *
 *   - fetch failure (network error / HTTP >= 400 / timeout) → NOTHING is
 *     written to the ring, an `error` change-log entry lands with
 *     `gen: null`, report `result: "error"`, exit 2. An HTTP-500 page is
 *     a FAILED CAPTURE, not content — it is never diffed.
 *   - first run (no prior snapshot) → baseline: gen-1 snapshot + baseline
 *     log entry, exit 0. Baseline establishes, never detects.
 *   - otherwise the prior snapshot's RAW bytes (plus the charset hint
 *     derived from its stored contentType) diff against the fresh live
 *     bytes: identical sections AND identical raw hash AND unchanged
 *     finalUrl → no-change, exit 0; anything else → change, exit 1.
 *   - permanent move (permanent redirect AND finalUrl differs from the
 *     registered url) → `moved`: the snapshot is written at the NEW
 *     finalUrl, gen advances, exit 1 even when the content is
 *     byte-identical (durable identity changed; the operator updates the
 *     registry). Temporary redirects ride normal change/no-change.
 */
async function runTick(
  root: string,
  target: WatchTarget,
  options: {
    readonly timeoutMs: number;
    readonly now: Date;
  },
): Promise<WatchRunReport> {
  const nowAt = options.now.toISOString();
  const listing = await listSnapshots(root, target.id);
  const last = listing.at(-1);
  const prevAt = last ? last.capturedAt : null;
  const prior = last ? await readSnapshot(root, target.id, last.gen) : null;

  let live: Awaited<ReturnType<typeof fetchLiveDocument>>;
  try {
    live = await fetchLiveDocument(target.url, options.timeoutMs);
  } catch (error) {
    // Ring does NOT advance: no appendSnapshot. The failed capture is
    // logged as evidence with gen:null (a 500 page is not content).
    const reason = fetchFailureReason(target.url, error);
    await appendChangeLog(root, target.id, {
      at: options.now,
      kind: "error",
      exit: 2,
      gen: null,
    });
    return {
      schemaVersion: 1,
      target: target.name,
      gen: null,
      result: "error",
      reason,
      finalUrl: null,
      prevAt,
      nowAt,
    };
  }

  // An HTTP >= 400 page is a FAILED CAPTURE, not content: same handling
  // as a network error — nothing written to the ring, never diffed.
  if (live.statusCode >= 400) {
    const reason = `live fetch of ${target.url} failed: HTTP ${live.statusCode}`;
    await appendChangeLog(root, target.id, {
      at: options.now,
      kind: "error",
      exit: 2,
      gen: null,
    });
    return {
      schemaVersion: 1,
      target: target.name,
      gen: null,
      result: "error",
      reason,
      finalUrl: null,
      prevAt,
      nowAt,
    };
  }

  const currentBytes = new Uint8Array(
    live.raw.buffer,
    live.raw.byteOffset,
    live.raw.byteLength,
  );
  const gen = await appendSnapshot(root, target.id, {
    body: currentBytes,
    now: options.now,
    contentType: live.contentType,
    finalUrl: live.finalUrl,
  });
  const finalUrl = live.finalUrl;

  // Baseline establishes, never detects (ruling #5).
  if (prior === null) {
    await appendChangeLog(root, target.id, {
      at: options.now,
      kind: "baseline",
      exit: 0,
      gen,
      ...(finalUrl !== undefined ? { finalUrl } : {}),
    });
    return {
      schemaVersion: 1,
      target: target.name,
      gen,
      result: "baseline",
      baseline: true,
      diff: { added: [], removed: [], changed: [] },
      hashOnly: false,
      finalUrl,
      prevAt: null,
      nowAt,
    };
  }

  const priorExtraction = extractSections(
    prior.body,
    charsetFromContentType(prior.contentType),
  );
  const currentExtraction = extractSections(
    currentBytes,
    charsetFromContentType(live.contentType),
  );

  // Permanent move (ruling #7): permanent redirect AND the final URL left
  // the registered one, compared via isSameDocumentUrl (exported from
  // archive.ts) so watch and `archive diff` give the same word the same
  // meaning: a trailing-slash variant of the same path is NOT a move.
  // Exit 1 even when the content is byte-identical — the durable identity
  // changed.
  if (live.moved && !isSameDocumentUrl(finalUrl, target.url)) {
    const diff = diffDocuments(priorExtraction, currentExtraction);
    await appendChangeLog(root, target.id, {
      at: options.now,
      kind: "moved",
      exit: 1,
      gen,
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
      hashOnly: diff.hashOnly,
      ...(finalUrl !== undefined ? { finalUrl } : {}),
    });
    return {
      schemaVersion: 1,
      target: target.name,
      gen,
      result: "moved",
      baseline: false,
      moved: true,
      diff: { added: diff.added, removed: diff.removed, changed: diff.changed },
      hashOnly: diff.hashOnly,
      finalUrl,
      prevAt,
      nowAt,
    };
  }

  const diff = diffDocuments(priorExtraction, currentExtraction);
  const unchanged =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    priorExtraction.hash === currentExtraction.hash &&
    // Same-document comparison (see isSameDocumentUrl): a finalUrl hop
    // to a trailing-slash variant of the same path is not a change.
    (prior.finalUrl === finalUrl ||
      (prior.finalUrl != null && isSameDocumentUrl(prior.finalUrl, finalUrl ?? "")));
  if (unchanged) {
    await appendChangeLog(root, target.id, {
      at: options.now,
      kind: "no-change",
      exit: 0,
      gen,
      ...(finalUrl !== undefined ? { finalUrl } : {}),
    });
    return {
      schemaVersion: 1,
      target: target.name,
      gen,
      result: "no-change",
      baseline: false,
      diff: { added: [], removed: [], changed: [] },
      hashOnly: diff.hashOnly,
      finalUrl,
      prevAt,
      nowAt,
    };
  }

  await appendChangeLog(root, target.id, {
    at: options.now,
    kind: "change",
    exit: 1,
    gen,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed,
    hashOnly: diff.hashOnly,
    ...(finalUrl !== undefined ? { finalUrl } : {}),
  });
  return {
    schemaVersion: 1,
    target: target.name,
    gen,
    result: "change",
    baseline: false,
    diff: { added: diff.added, removed: diff.removed, changed: diff.changed },
    hashOnly: diff.hashOnly,
    finalUrl,
    prevAt,
    nowAt,
  };
}

/** `watch run` presentation text (tty/compact/markdown/refs). */
function runReportText(report: WatchRunReport): string {
  if (report.result === "error") {
    return `watch ${report.target}: error (${report.reason})`;
  }
  const parts: string[] = [];
  const diff = report.diff ?? { added: [], removed: [], changed: [] };
  if (diff.added.length > 0) parts.push(`added: ${diff.added.join(", ")}`);
  if (diff.removed.length > 0) parts.push(`removed: ${diff.removed.join(", ")}`);
  if (diff.changed.length > 0) parts.push(`changed: ${diff.changed.join(", ")}`);
  if (report.result === "baseline") parts.push("baseline established");
  if (report.result === "moved") parts.push(`moved to ${report.finalUrl}`);
  const detail = parts.length > 0 ? ` — ${parts.join("; ")}` : " — no change";
  return `watch ${report.target} [gen ${report.gen}]: ${report.result}${detail}`;
}

const RUN_EXIT: Record<WatchRunReport["result"], number> = {
  baseline: 0,
  "no-change": 0,
  change: 1,
  moved: 1,
  error: 2,
};

/**
 * `watch run <name-or-id|--all> [--timeout <ms>]` dispatcher. One tick
 * (or, with `--all`, one tick per registered target in id order); exit
 * code per the 0/1/2 contract, worst-wins for `--all` (2 > 1 > 0).
 */
async function executeWatchRun(input: {
  readonly flags: Record<string, string | boolean>;
  readonly positional: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly invocation: CommandInvocationAdapter;
  readonly outputMode: OutputMode;
  readonly secrets: string[];
}): Promise<number> {
  const all = input.flags.all === true;
  const ref = input.positional[0];
  if (all && ref !== undefined) {
    throw new ValidationError(
      "watch run --all cannot be combined with an explicit target.",
      "Pass either --all or a target name/id, not both.",
    );
  }
  if (!all && !ref) {
    throw new ValidationError(
      "watch run requires a target name or id (or --all).",
      'Run "scoutline watch list" to see the registered targets.',
    );
  }
  const timeoutMs = parseTimeout(input.flags.timeout) ?? RUN_DEFAULT_TIMEOUT_MS;
  const root = resolveWatchDir(input.env as WatchDirEnvironment);

  return invokeCommand(
    input.invocation,
    async () => {
      const targets = all ? await listTargets(root) : [await getTarget(root, ref!)];
      // One invocation = one logical instant: every target in an --all
      // sweep ticks at the same captured now (review advisory A1).
      const now = input.now ? new Date(input.now()) : new Date();
      const reports: WatchRunReport[] = [];
      for (const target of targets) {
        reports.push(await runTick(root, target, { timeoutMs, now }));
      }
      const exit = reports.reduce(
        (worst, report) => Math.max(worst, RUN_EXIT[report.result]),
        0,
      );
      if (all) {
        const data: WatchRunAllReport = { schemaVersion: 1, results: reports };
        const text = reports.map((r) => runReportText(r)).join("\n");
        return {
          kind: "data" as const,
          data,
          exitCode: exit,
          presentations: watchPresentations(text),
        };
      }
      const report = reports[0]!;
      return {
        kind: "data" as const,
        data: report,
        exitCode: exit,
        presentations: watchPresentations(runReportText(report)),
      };
    },
    input.outputMode,
    input.now,
    input.secrets,
  );
}

// ---------------------------------------------------------------------------
// watch feed (T6)
// ---------------------------------------------------------------------------

/** Legal `--format` values (ruling #1: jsonl default). */
const FEED_FORMATS: readonly ["jsonl", "rss"] = ["jsonl", "rss"];

function parseFeedFormat(raw: string | boolean | undefined): "jsonl" | "rss" {
  if (raw === undefined) return "jsonl";
  // `--no-format <x>` lands here as `false` — same valueless refusal as
  // the --keep/--name/--timeout gate class (a bare `--format` is `true`).
  if (typeof raw !== "string") {
    throw new ValidationError(
      "--format requires a value.",
      "Use one of: jsonl, rss.",
    );
  }
  if (raw !== "jsonl" && raw !== "rss") {
    throw new ValidationError(
      `Invalid --format ${JSON.stringify(raw)}.`,
      "Use one of: jsonl, rss.",
    );
  }
  return raw;
}

/**
 * XML escaping (ruling #5 — SECURITY-CRITICAL): section headings are
 * arbitrary web text, so every text node and attribute value goes
 * through this BEFORE templating. `&` first (else double-escapes), then
 * the four markup delimiters; `'` as `&#39;` (also valid in attribute
 * values). No CDATA tricks — the frozen fixture pins the mapping.
 * XML 1.0 forbids control chars other than \t \n \r — any other char
 * below 0x20 would make strict readers reject the whole feed, so it is
 * stripped (not entity-encoded: no valid encoding exists). Chars above
 * the BMP (surrogate pairs / invalid code points) are out of scope.
 */
function xmlEscape(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex -- test fixture uses \x01
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * pubDate = RFC 822 (GMT) from the entry's own `at` instant. Invalid
 * dates (hand-edited logs) render as NaN → the item keeps position but
 * the reader sees an unusable date — same non-throw posture the T2
 * review advisory set for the rest of the renderer.
 */
function rfc822(at: string): string {
  return new Date(at).toUTCString();
}

function feedItemTitle(
  entry: ParsedChangeLogEntry,
): string {
  if (entry.kind === "moved") return `moved: ${entry.finalUrl ?? ""}`;
  const changed = entry.changed ?? [];
  if (changed.length > 0) return `changed: ${changed[0] ?? ""}`;
  const added = entry.added ?? [];
  if (added.length > 0) return `added: ${added[0] ?? ""}`;
  const removed = entry.removed ?? [];
  if (removed.length > 0) return `removed: ${removed[0] ?? ""}`;
  // finalUrl-only change (empty diff arrays): the fallback would render
  // a garbage "removed: " + empty description — name the actual change.
  if (entry.finalUrl) return `changed: ${entry.finalUrl}`;
  return `changed: (content only)`;
}

function feedItemDescription(entry: ParsedChangeLogEntry): string {
  const segments: string[] = [];
  const added = entry.added ?? [];
  const removed = entry.removed ?? [];
  const changed = entry.changed ?? [];
  if (added.length > 0) segments.push(`added: ${added.join(", ")}`);
  if (removed.length > 0) segments.push(`removed: ${removed.join(", ")}`);
  if (changed.length > 0) segments.push(`changed: ${changed.join(", ")}`);
  if (entry.kind === "moved") segments.push(`moved to ${entry.finalUrl ?? ""}`);
  // Mirrors feedItemTitle's fallback: a finalUrl-only change renders as
  // an explicit url-change description, never an empty string.
  if (segments.length === 0 && entry.finalUrl) segments.push(`url changed to ${entry.finalUrl}`);
  return segments.join("; ");
}

/**
 * RSS 2.0 document for one target — the frozen shape from the plan:
 * channel title `scoutline watch: <name>`, channel link = target url,
 * items are `change` and `moved` entries ONLY (ruling #3; baseline /
 * no-change / error stay log noise for the jsonl stream), guid
 * `{targetId}:{gen}` isPermaLink="false" (pure function of id+gen,
 * ruling #4). Deterministic by construction (ruling #6): the only
 * timestamps come from entry `at`, declaration + indentation are fixed.
 */
function renderRssFeed(target: WatchTarget, entries: readonly ParsedChangeLogEntry[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `  <title>${xmlEscape(`scoutline watch: ${target.name}`)}</title>`,
    `  <link>${xmlEscape(target.url)}</link>`,
  ];
  for (const entry of entries) {
    if (entry.kind !== "change" && entry.kind !== "moved") continue;
    lines.push(
      "  <item>",
      `    <title>${xmlEscape(feedItemTitle(entry))}</title>`,
      `    <guid isPermaLink="false">${xmlEscape(`${target.id}:${entry.gen}`)}</guid>`,
      `    <pubDate>${xmlEscape(rfc822(entry.at))}</pubDate>`,
      `    <description>${xmlEscape(feedItemDescription(entry))}</description>`,
      "  </item>",
    );
  }
  lines.push("</channel></rss>");
  return lines.join("\n");
}

/**
 * `watch feed` behavior. The OUTPUT BODY IS THE DOCUMENT (ruling #2,
 * the `archive-get --raw` / fetch `--raw` precedent): jsonl mode
 * streams the change-log FILE verbatim (byte passthrough — the raw
 * text is read, never re-serialized through the parsed shapes, so
 * key order and spacing survive); rss mode emits the XML. Both write
 * through `deps.invocation.writeStdout` directly — a feed is a
 * document, so no CommandResult envelope ever wraps it, in ANY output
 * mode. Fail-closed parsing comes free: `readChangeLog` throws
 * ValidationError on malformed lines and unknown kinds (for jsonl that
 * validation-only read happens BEFORE the passthrough write).
 */
async function executeWatchFeed(input: {
  readonly flags: Record<string, string | boolean>;
  readonly positional: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly invocation: CommandInvocationAdapter;
}): Promise<number> {
  const ref = input.positional[0];
  if (!ref) {
    throw new ValidationError(
      "watch feed requires a target name or id.",
      'Run "scoutline watch list" to see the registered targets.',
    );
  }
  const format = parseFeedFormat(input.flags.format);
  const root = resolveWatchDir(input.env as WatchDirEnvironment);
  const target = await getTarget(root, ref);

  if (format === "jsonl") {
    // Byte passthrough: stdout is the log's JSONL lines verbatim (the
    // raw file text, never re-serialized through the parsed shapes, so
    // key order and spacing survive). Missing file (no baseline yet) is
    // the empty document. Hand-edited lines still fail closed loudly —
    // the validation-only read below runs BEFORE anything is written.
    let raw = "";
    try {
      raw = await fs.readFile(
        path.join(root, target.id, WATCH_CHANGELOG_FILENAME),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== "") await readChangeLog(root, target.id);
    input.invocation.writeStdout(raw);
    return 0;
  }

  const entries = await readChangeLog(root, target.id);
  input.invocation.writeStdout(renderRssFeed(target, entries));
  return 0;
}

/**
 * Dispatcher handler for `watch` in `src/index.ts`. `isolated` is the
 * global-flag extraction result: watch state is a design feature (the
 * persistent ring + change log), so a subcommand run under --isolated
 * is refused here — at parse time, before any store I/O. Help surfaces
 * (bare `watch`, `--help`) still render documentation.
 */
export async function handleWatch(
  args: string[],
  outputMode: OutputMode,
  deps: HandlerDependencies,
  isolated = false,
): Promise<number> {
  const { subcommand, positional, flags, showHelp } = parseWatchArgs(args);

  if (showHelp || subcommand === undefined) {
    deps.invocation.writeStdout(WATCH_HELP);
    return 0;
  }

  // Parse-time guard (plan T4): fires for every subcommand INCLUDING the
  // not-yet-live ones — the statefulness rationale applies to the whole
  // family, and a later landing run/feed must not re-litigate it.
  if (isolated) {
    throw new ValidationError(
      "watch cannot run under --isolated.",
      "watch is stateful by design: the persistent snapshot ring and change log live under SCOUTLINE_WATCH_DIR (default ~/.scoutline/watch). Drop --isolated to keep the monitored state.",
    );
  }

  if (subcommand === "add") {
    const url = positional[0];
    if (!url) {
      throw new ValidationError(
        "URL is required for watch add.",
        "Example: scoutline watch add https://example.com/docs --name example-docs",
      );
    }
    const keep = parseKeep(flags.keep);
    const name = parseName(flags.name);
    const root = resolveWatchDir(deps.env as WatchDirEnvironment);
    return invokeCommand(
      deps.invocation,
      async () => {
        const target = await addTarget(root, {
          url,
          ...(name !== undefined ? { name } : {}),
          ...(keep !== undefined ? { keep } : {}),
          // Timestamp from the caller's injected instant, never wall clock.
          ...(deps.now ? { now: deps.now() } : {}),
        });
        const data: WatchAddReport = { schemaVersion: 1, ...target };
        const text = `added watch target ${target.name} (${target.id}), ring keeps ${target.keep}`;
        return {
          kind: "data" as const,
          data,
          presentations: watchPresentations(text),
        };
      },
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  if (subcommand === "list") {
    const root = resolveWatchDir(deps.env as WatchDirEnvironment);
    return invokeCommand(
      deps.invocation,
      async () => {
        const targets = await listTargets(root);
        const data: WatchListReport = {
          schemaVersion: 1,
          total: targets.length,
          targets,
        };
        const lines = [`watch: ${targets.length} target(s)`];
        for (const target of targets) lines.push(formatTargetRow(target));
        return {
          kind: "data" as const,
          data,
          presentations: watchPresentations(lines.join("\n")),
        };
      },
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  if (subcommand === "remove") {
    const ref = positional[0];
    if (!ref) {
      throw new ValidationError(
        "watch remove requires a target name or id.",
        'Run "scoutline watch list" to see the registered targets.',
      );
    }
    const purge = flags.purge === true;
    const root = resolveWatchDir(deps.env as WatchDirEnvironment);
    return invokeCommand(
      deps.invocation,
      async () => {
        const target = await removeTarget(root, ref, { purge });
        const data: WatchRemoveReport = {
          schemaVersion: 1,
          ...target,
          purged: purge,
        };
        const text = purge
          ? `removed watch target ${target.name} (${target.id}) and purged its evidence`
          : `removed watch target ${target.name} (${target.id}); evidence kept (use --purge to delete)`;
        return {
          kind: "data" as const,
          data,
          presentations: watchPresentations(text),
        };
      },
      outputMode,
      deps.now,
      deps.secrets,
    );
  }

  if (subcommand === "run") {
    return await executeWatchRun({
      flags,
      positional,
      env: deps.env,
      now: deps.now,
      invocation: deps.invocation,
      outputMode,
      secrets: deps.secrets,
    });
  }

  if (subcommand === "feed") {
    return await executeWatchFeed({
      flags,
      positional,
      env: deps.env,
      invocation: deps.invocation,
    });
  }

  throw new ValidationError(
    `Unknown watch subcommand "${subcommand}".`,
    "Valid subcommands: add, list, remove, run, feed.",
  );
}
