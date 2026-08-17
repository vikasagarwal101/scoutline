/**
 * Batch Manifest module (batch-runner DESIGN D2, D2.8, D3).
 *
 * Strict parse of the manifest schema v1 plus the deterministic
 * `input → argv` compiler. The manifest carries STRUCTURED, typed values
 * (numbers as numbers, booleans as booleans, enums as enum members);
 * the compiler renders them to the exact argv the command handlers'
 * `parseArgs` consumes, which stays the single semantic validation
 * authority. Manifest parse checks shape only: required fields, types,
 * enum membership, subcommand scoping.
 *
 * Strict parse throughout: unknown fields reject at every level (top
 * level, op level, inside `input`) naming the first offender, and old
 * manifests either parse cleanly or reject — never silently reinterpreted.
 *
 * This module performs no I/O of its own: provider capability checks run
 * against injected descriptors (never `descriptor.create()`), and output
 * dirname existence runs against an injected `dirExists` probe.
 */

import * as path from "node:path";
import { ValidationError } from "./errors.js";
import { PROVIDER_IDS } from "../providers/types.js";
import type { ProviderCapability, ProviderDescriptor, ProviderId } from "../providers/types.js";
import { visionOperationToCapability } from "../capabilities/vision.js";
import type { VisionOperation } from "../capabilities/vision.js";
import type { SearchRecency, SearchTopic, SearchType } from "../capabilities/search.js";

// ---------------------------------------------------------------------------
// D3 — capability-operation allowlist
// ---------------------------------------------------------------------------

/**
 * Commands a batch manifest may carry (owner decision 2026-08-17):
 * capability operations only. The array order fixes the rejection
 * message wording and is part of the pinned contract.
 */
export const BATCH_ALLOWED_COMMANDS = [
  "search",
  "read",
  "research",
  "repo",
  "vision",
  "crawl",
  "map",
] as const;

export type AllowedBatchCommand = (typeof BATCH_ALLOWED_COMMANDS)[number];

/** Rejection message for out-of-allowlist commands (D3, verbatim). */
export const BATCH_ALLOWLIST_MESSAGE = `batch accepts capability operations only (${BATCH_ALLOWED_COMMANDS.join(", ")})`;

export type RepoBatchSubcommand = "search" | "tree" | "read" | "brief";

export type VisionBatchSubcommand =
  | "analyze"
  | "ui-to-code"
  | "extract-text"
  | "diagnose-error"
  | "diagram"
  | "chart"
  | "diff"
  | "video";

/**
 * Mirror of `visionOperationForCommand` (module-private in `index.ts`,
 * deliberately not exported from there). Kept as an explicit local switch
 * so the footprint stays two regions, chained through the exported
 * `visionOperationToCapability` single source of truth for ids.
 */
function visionSubcommandToOperation(subcommand: string): VisionOperation {
  switch (subcommand) {
    case "analyze":
      return "interpret-image";
    case "ui-to-code":
      return "ui-artifact";
    case "extract-text":
      return "extract-text";
    case "diagnose-error":
      return "diagnose-error";
    case "diagram":
      return "diagram";
    case "chart":
      return "chart";
    case "diff":
      return "diff";
    case "video":
      return "video";
    default:
      throw new ValidationError(`Unknown vision command: ${subcommand}`);
  }
}

/**
 * Capability id a batch op exercises (DESIGN D4). Vision ops resolve to
 * their per-operation `vision.<operation>` id; this is the grouping key
 * provider assignment uses and the id the per-op pin is validated
 * against.
 */
export function batchCommandCapabilityId(
  command: AllowedBatchCommand,
  input: Readonly<Record<string, unknown>>,
): ProviderCapability {
  switch (command) {
    case "search":
      return "search";
    case "read":
      return "reader";
    case "crawl":
      return "crawl";
    case "map":
      return "map";
    case "research":
      return "research";
    case "repo":
      return "repository-exploration";
    case "vision":
      return visionOperationToCapability(visionSubcommandToOperation(String(input.subcommand)));
  }
}

// ---------------------------------------------------------------------------
// D2.1–D2.7 — per-command input field tables
// ---------------------------------------------------------------------------

type FieldKind = "string" | "number" | "boolean" | "stringArray";

interface FieldSpec {
  readonly kind: FieldKind;
  /** Enum members mirror the handler validators; rendered verbatim. */
  readonly enumValues?: readonly string[];
  /** Required for every invocation of the command. */
  readonly required?: boolean;
  /** Required only when `input.subcommand` is one of these values. */
  readonly requiredFor?: readonly string[];
  /** Allowed only when `input.subcommand` is one of these values. */
  readonly allowedFor?: readonly string[];
}

type FieldEntry = readonly [field: string, spec: FieldSpec];

const RECENCY_VALUES: readonly string[] = ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"];
const CONTENT_SIZE_VALUES: readonly string[] = ["medium", "high"];
const LOCATION_VALUES: readonly string[] = ["cn", "us"];
const TOPIC_VALUES: readonly string[] = ["general", "news", "finance"];
const SEARCH_TYPE_VALUES: readonly string[] = ["video"];
const FORMAT_VALUES: readonly string[] = ["markdown", "text"];
const RESEARCH_MODEL_VALUES: readonly string[] = ["mini", "pro", "auto"];
const OUTPUT_LENGTH_VALUES: readonly string[] = ["short", "standard", "long"];
const CITATION_FORMAT_VALUES: readonly string[] = ["numbered", "mla", "apa", "chicago"];
const REPO_LANGUAGE_VALUES: readonly string[] = ["en", "zh"];
const REPO_SUBCOMMAND_VALUES: readonly string[] = ["search", "tree", "read", "brief"];
const VISION_SUBCOMMAND_VALUES: readonly string[] = [
  "analyze",
  "ui-to-code",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
  "diff",
  "video",
];
const VISION_OUTPUT_VALUES: readonly string[] = ["code", "prompt", "spec", "description"];

const VISION_NON_DIFF_SUBCOMMANDS: readonly string[] = [
  "analyze",
  "ui-to-code",
  "extract-text",
  "diagnose-error",
  "diagram",
  "chart",
  "video",
];

/**
 * Field tables in canonical order. The declaration order is the compile
 * order for flags (D2.8) and the validation order within an input
 * object, making both deterministic. `subcommand` is first for `repo`
 * and `vision` so scoped rules always have a validated value.
 */
const INPUT_FIELD_TABLES: Readonly<Record<AllowedBatchCommand, readonly FieldEntry[]>> = {
  search: [
    ["query", { kind: "string", required: true }],
    ["count", { kind: "number" }],
    ["domain", { kind: "string" }],
    ["recency", { kind: "string", enumValues: RECENCY_VALUES }],
    ["contentSize", { kind: "string", enumValues: CONTENT_SIZE_VALUES }],
    ["location", { kind: "string", enumValues: LOCATION_VALUES }],
    ["topic", { kind: "string", enumValues: TOPIC_VALUES }],
    ["type", { kind: "string", enumValues: SEARCH_TYPE_VALUES }],
    ["maxSummary", { kind: "number" }],
    ["fields", { kind: "stringArray" }],
    ["noCache", { kind: "boolean" }],
    ["merge", { kind: "boolean" }],
  ],
  read: [
    ["url", { kind: "string", required: true }],
    ["format", { kind: "string", enumValues: FORMAT_VALUES }],
    ["noImages", { kind: "boolean" }],
    ["withLinks", { kind: "boolean" }],
    ["withImagesSummary", { kind: "boolean" }],
    ["noCache", { kind: "boolean" }],
  ],
  crawl: [
    ["url", { kind: "string", required: true }],
    ["depth", { kind: "number" }],
    ["breadth", { kind: "number" }],
    ["limit", { kind: "number" }],
    ["selectPaths", { kind: "string" }],
    ["excludePaths", { kind: "string" }],
    ["instructions", { kind: "string" }],
    ["format", { kind: "string", enumValues: FORMAT_VALUES }],
    ["contentSize", { kind: "string", enumValues: CONTENT_SIZE_VALUES }],
    ["timeout", { kind: "number" }],
    ["maxChars", { kind: "number" }],
    ["noCache", { kind: "boolean" }],
  ],
  map: [
    ["url", { kind: "string", required: true }],
    ["depth", { kind: "number" }],
    ["breadth", { kind: "number" }],
    ["limit", { kind: "number" }],
    ["selectPaths", { kind: "string" }],
    ["excludePaths", { kind: "string" }],
    ["instructions", { kind: "string" }],
    ["noCache", { kind: "boolean" }],
  ],
  research: [
    ["query", { kind: "string", required: true }],
    ["model", { kind: "string", enumValues: RESEARCH_MODEL_VALUES }],
    ["outputLength", { kind: "string", enumValues: OUTPUT_LENGTH_VALUES }],
    ["citationFormat", { kind: "string", enumValues: CITATION_FORMAT_VALUES }],
    ["domain", { kind: "string" }],
    ["maxChars", { kind: "number" }],
    ["timeout", { kind: "number" }],
    ["noCache", { kind: "boolean" }],
  ],
  repo: [
    ["subcommand", { kind: "string", enumValues: REPO_SUBCOMMAND_VALUES, required: true }],
    ["repository", { kind: "string", required: true }],
    ["query", { kind: "string", requiredFor: ["search"], allowedFor: ["search"] }],
    [
      "path",
      { kind: "string", requiredFor: ["read"], allowedFor: ["tree", "read", "brief"] },
    ],
    // Scoped to the subcommands whose handlers consume the compiled
    // flag: the repo handler threads `language` only into `search`, and
    // `maxChars` into `search`/`read`/`brief` (`tree` ignores both) —
    // a manifest must never request an option the handler silently
    // discards.
    ["language", { kind: "string", enumValues: REPO_LANGUAGE_VALUES, allowedFor: ["search"] }],
    ["maxChars", { kind: "number", allowedFor: ["search", "read", "brief"] }],
    ["focus", { kind: "string", allowedFor: ["brief"] }],
    ["depth", { kind: "number", allowedFor: ["tree", "brief"] }],
    ["noCache", { kind: "boolean" }],
  ],
  vision: [
    ["subcommand", { kind: "string", enumValues: VISION_SUBCOMMAND_VALUES, required: true }],
    [
      "source",
      { kind: "string", requiredFor: VISION_NON_DIFF_SUBCOMMANDS, allowedFor: VISION_NON_DIFF_SUBCOMMANDS },
    ],
    ["prompt", { kind: "string" }],
    ["language", { kind: "string", allowedFor: ["extract-text"] }],
    ["context", { kind: "string", allowedFor: ["diagnose-error"] }],
    ["type", { kind: "string", allowedFor: ["diagram"] }],
    ["focus", { kind: "string", allowedFor: ["chart"] }],
    ["output", { kind: "string", enumValues: VISION_OUTPUT_VALUES, allowedFor: ["ui-to-code"] }],
    ["expected", { kind: "string", requiredFor: ["diff"], allowedFor: ["diff"] }],
    ["actual", { kind: "string", requiredFor: ["diff"], allowedFor: ["diff"] }],
  ],
};

// ---------------------------------------------------------------------------
// D2 — typed input shapes
// ---------------------------------------------------------------------------

export interface SearchBatchInput {
  readonly query: string;
  readonly count?: number;
  readonly domain?: string;
  readonly recency?: SearchRecency;
  readonly contentSize?: "medium" | "high";
  readonly location?: "cn" | "us";
  readonly topic?: SearchTopic;
  readonly type?: SearchType;
  readonly maxSummary?: number;
  readonly fields?: string[];
  readonly noCache?: boolean;
  readonly merge?: boolean;
}

export interface ReadBatchInput {
  readonly url: string;
  readonly format?: "markdown" | "text";
  readonly noImages?: boolean;
  readonly withLinks?: boolean;
  readonly withImagesSummary?: boolean;
  readonly noCache?: boolean;
}

export interface CrawlBatchInput {
  readonly url: string;
  readonly depth?: number;
  readonly breadth?: number;
  readonly limit?: number;
  readonly selectPaths?: string;
  readonly excludePaths?: string;
  readonly instructions?: string;
  readonly format?: "markdown" | "text";
  readonly contentSize?: "medium" | "high";
  readonly timeout?: number;
  readonly maxChars?: number;
  readonly noCache?: boolean;
}

export interface MapBatchInput {
  readonly url: string;
  readonly depth?: number;
  readonly breadth?: number;
  readonly limit?: number;
  readonly selectPaths?: string;
  readonly excludePaths?: string;
  readonly instructions?: string;
  readonly noCache?: boolean;
}

export interface ResearchBatchInput {
  readonly query: string;
  readonly model?: "mini" | "pro" | "auto";
  readonly outputLength?: "short" | "standard" | "long";
  readonly citationFormat?: "numbered" | "mla" | "apa" | "chicago";
  readonly domain?: string;
  readonly maxChars?: number;
  readonly timeout?: number;
  readonly noCache?: boolean;
}

export interface RepoBatchInput {
  readonly subcommand: RepoBatchSubcommand;
  readonly repository: string;
  readonly query?: string;
  readonly path?: string;
  readonly language?: "en" | "zh";
  readonly maxChars?: number;
  readonly focus?: string;
  readonly depth?: number;
  readonly noCache?: boolean;
}

/**
 * `source` is required for every subcommand except `diff`, which carries
 * `expected` + `actual` instead. The optionality here is a TypeScript
 * limitation; the strict parse enforces the per-subcommand requirements
 * and `compileInput` defends them again.
 */
export interface VisionBatchInput {
  readonly subcommand: VisionBatchSubcommand;
  readonly source?: string;
  readonly prompt?: string;
  readonly language?: string;
  readonly context?: string;
  readonly type?: string;
  readonly focus?: string;
  readonly output?: "code" | "prompt" | "spec" | "description";
  readonly expected?: string;
  readonly actual?: string;
}

interface BatchOperationBase {
  readonly name: string;
  readonly provider?: ProviderId;
  readonly output?: string;
}

export interface SearchBatchOperation extends BatchOperationBase {
  readonly command: "search";
  readonly input: SearchBatchInput;
}

export interface ReadBatchOperation extends BatchOperationBase {
  readonly command: "read";
  readonly input: ReadBatchInput;
}

export interface ResearchBatchOperation extends BatchOperationBase {
  readonly command: "research";
  readonly input: ResearchBatchInput;
}

export interface RepoBatchOperation extends BatchOperationBase {
  readonly command: "repo";
  readonly input: RepoBatchInput;
}

export interface VisionBatchOperation extends BatchOperationBase {
  readonly command: "vision";
  readonly input: VisionBatchInput;
}

export interface CrawlBatchOperation extends BatchOperationBase {
  readonly command: "crawl";
  readonly input: CrawlBatchInput;
}

export interface MapBatchOperation extends BatchOperationBase {
  readonly command: "map";
  readonly input: MapBatchInput;
}

export type BatchOperation =
  | SearchBatchOperation
  | ReadBatchOperation
  | ResearchBatchOperation
  | RepoBatchOperation
  | VisionBatchOperation
  | CrawlBatchOperation
  | MapBatchOperation;

export interface BatchManifest {
  readonly schemaVersion: 1;
  readonly operations: readonly BatchOperation[];
}

/** Injected dependencies: descriptors stay metadata-only, fs stays behind a probe. */
export interface BatchManifestDeps {
  readonly descriptors: readonly ProviderDescriptor[];
  readonly dirExists: (dir: string) => boolean;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

const MANIFEST_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "operations"]);
const OPERATION_KEYS: ReadonlySet<string> = new Set(["name", "command", "input", "provider", "output"]);
const OPERATION_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_OPERATIONS = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedBatchCommand(value: string): value is AllowedBatchCommand {
  return (BATCH_ALLOWED_COMMANDS as readonly string[]).includes(value);
}

function isKnownProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function isRequiredFor(spec: FieldSpec, subcommand: string | undefined): boolean {
  if (spec.required) return true;
  return spec.requiredFor !== undefined && subcommand !== undefined && spec.requiredFor.includes(subcommand);
}

function validateInputObject(
  where: string,
  command: AllowedBatchCommand,
  input: Record<string, unknown>,
): void {
  const table = INPUT_FIELD_TABLES[command];
  const knownFields = new Set(table.map(([field]) => field));

  // Unknown fields reject before any value validation (strict parse,
  // first offender in key order).
  for (const key of Object.keys(input)) {
    if (!knownFields.has(key)) {
      throw new ValidationError(`${where}.input: unknown field "${key}" for command "${command}"`);
    }
  }

  let subcommand: string | undefined;
  for (const [field, spec] of table) {
    const present = input[field] !== undefined;
    const value = input[field];

    if (field === "subcommand") {
      if (!present) {
        throw new ValidationError(`${where}.input: missing required field "subcommand"`);
      }
      if (typeof value !== "string") {
        throw new ValidationError(`${where}.input: field "subcommand" must be a string`);
      }
      if (spec.enumValues && !spec.enumValues.includes(value)) {
        throw new ValidationError(
          `${where}.input: field "subcommand" must be one of: ${spec.enumValues.join(", ")}`,
        );
      }
      subcommand = value;
      continue;
    }

    if (!present) {
      if (isRequiredFor(spec, subcommand)) {
        throw new ValidationError(`${where}.input: missing required field "${field}"`);
      }
      continue;
    }

    // Present: subcommand scoping is checked before type/enum so a
    // misplaced field is reported as a scoping error, never as a type
    // error against the wrong subcommand's expectations.
    if (spec.allowedFor !== undefined && (subcommand === undefined || !spec.allowedFor.includes(subcommand))) {
      throw new ValidationError(
        `${where}.input: field "${field}" is not valid for ${command} subcommand "${subcommand}"`,
      );
    }

    switch (spec.kind) {
      case "string": {
        if (typeof value !== "string") {
          throw new ValidationError(`${where}.input: field "${field}" must be a string`);
        }
        if (spec.enumValues !== undefined && !spec.enumValues.includes(value)) {
          throw new ValidationError(
            `${where}.input: field "${field}" must be one of: ${spec.enumValues.join(", ")}`,
          );
        }
        if (value.length === 0) {
          // D2: an empty required value rejects as missing-required, so
          // the parser normalizes across handlers' differing guards.
          if (isRequiredFor(spec, subcommand)) {
            throw new ValidationError(`${where}.input: missing required field "${field}"`);
          }
          throw new ValidationError(`${where}.input: field "${field}" must be a non-empty string`);
        }
        break;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new ValidationError(`${where}.input: field "${field}" must be a number`);
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          throw new ValidationError(`${where}.input: field "${field}" must be a boolean`);
        }
        break;
      }
      case "stringArray": {
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
          throw new ValidationError(`${where}.input: field "${field}" must be an array of strings`);
        }
        break;
      }
    }
  }
}

/**
 * Strict-parse a batch manifest (D2). Every rejection throws
 * `ValidationError` naming the first offender; nothing about a rejected
 * manifest is partially accepted. Provider pins are validated against
 * the injected descriptor metadata only — `create()` is never called.
 */
export function parseBatchManifest(raw: unknown, deps: BatchManifestDeps): BatchManifest {
  if (!isPlainObject(raw)) {
    throw new ValidationError("batch manifest must be a JSON object");
  }

  for (const key of Object.keys(raw)) {
    if (!MANIFEST_KEYS.has(key)) {
      throw new ValidationError(`unknown manifest field "${key}"`);
    }
  }

  if (raw.schemaVersion === undefined) {
    throw new ValidationError('missing required manifest field "schemaVersion"');
  }
  // Strict-equality gate (config-store precedent): only `1` parses.
  if (raw.schemaVersion !== 1) {
    throw new ValidationError(
      `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)}: expected 1`,
    );
  }

  if (raw.operations === undefined) {
    throw new ValidationError('missing required manifest field "operations"');
  }
  const rawOperations: unknown = raw.operations;
  if (!Array.isArray(rawOperations)) {
    throw new ValidationError('manifest field "operations" must be an array');
  }
  if (rawOperations.length < 1 || rawOperations.length > MAX_OPERATIONS) {
    throw new ValidationError(`manifest "operations" must contain between 1 and ${MAX_OPERATIONS} entries`);
  }

  const seenNames = new Set<string>();
  // Declared output targets, path -> owning op name: two ops writing the
  // same target would silently overwrite each other at the D9 rename, so
  // duplicates reject at parse naming the earlier owner.
  const seenOutputs = new Map<string, string>();
  const operations: BatchOperation[] = [];
  for (let index = 0; index < rawOperations.length; index++) {
    const where = `operations[${index}]`;
    const rawOp: unknown = rawOperations[index];
    if (!isPlainObject(rawOp)) {
      throw new ValidationError(`${where} must be an object`);
    }

    for (const key of Object.keys(rawOp)) {
      if (!OPERATION_KEYS.has(key)) {
        throw new ValidationError(`${where}: unknown field "${key}"`);
      }
    }

    if (rawOp.name === undefined) {
      throw new ValidationError(`${where}: missing required field "name"`);
    }
    const name: unknown = rawOp.name;
    if (typeof name !== "string") {
      throw new ValidationError(`${where}: field "name" must be a string`);
    }
    if (name.length < 1 || name.length > 64 || !OPERATION_NAME_PATTERN.test(name)) {
      throw new ValidationError(
        `${where}: invalid operation name "${name}" (must be 1-64 characters from letters, digits, ".", "_", "-")`,
      );
    }
    if (seenNames.has(name)) {
      throw new ValidationError(`${where}: duplicate operation name "${name}"`);
    }
    seenNames.add(name);

    if (rawOp.command === undefined) {
      throw new ValidationError(`${where}: missing required field "command"`);
    }
    const command: unknown = rawOp.command;
    if (typeof command !== "string") {
      throw new ValidationError(`${where}: field "command" must be a string`);
    }
    if (!isAllowedBatchCommand(command)) {
      // D3 pins this rejection message verbatim (no per-op prefix).
      throw new ValidationError(BATCH_ALLOWLIST_MESSAGE);
    }

    if (rawOp.input === undefined) {
      throw new ValidationError(`${where}: missing required field "input"`);
    }
    const input: unknown = rawOp.input;
    if (!isPlainObject(input)) {
      throw new ValidationError(`${where}: field "input" must be an object`);
    }
    validateInputObject(where, command, input);

    let provider: ProviderId | undefined;
    if (rawOp.provider !== undefined) {
      const rawProvider: unknown = rawOp.provider;
      if (typeof rawProvider !== "string") {
        throw new ValidationError(`${where}: field "provider" must be a string`);
      }
      if (!isKnownProviderId(rawProvider)) {
        throw new ValidationError(
          `${where}: unknown provider "${rawProvider}". Built-in providers: ${PROVIDER_IDS.join(", ")}.`,
        );
      }
      const capabilityId = batchCommandCapabilityId(command, input);
      const descriptor = deps.descriptors.find((entry) => entry.id === rawProvider);
      if (descriptor === undefined || !descriptor.capabilities().has(capabilityId)) {
        throw new ValidationError(
          `${where}: provider "${rawProvider}" does not support capability "${capabilityId}"`,
        );
      }
      provider = rawProvider;
    }

    let output: string | undefined;
    if (rawOp.output !== undefined) {
      const rawOutput: unknown = rawOp.output;
      if (typeof rawOutput !== "string" || rawOutput.length === 0) {
        throw new ValidationError(`${where}: field "output" must be a non-empty string`);
      }
      const dir = path.dirname(rawOutput);
      if (!deps.dirExists(dir)) {
        throw new ValidationError(`${where}: output directory "${dir}" does not exist`);
      }
      const priorOwner = seenOutputs.get(rawOutput);
      if (priorOwner !== undefined) {
        throw new ValidationError(
          `${where}: duplicate output target "${rawOutput}" (already declared by operation "${priorOwner}")`,
        );
      }
      seenOutputs.set(rawOutput, name);
      output = rawOutput;
    }

    // `validateInputObject` proved `input` matches the field table for
    // `command` (only known keys, validated types and enums), but that
    // runtime guarantee cannot narrow the Record to the per-command
    // input union here — hence the double cast.
    operations.push({
      name,
      command,
      input: { ...input },
      ...(provider !== undefined ? { provider } : {}),
      ...(output !== undefined ? { output } : {}),
    } as unknown as BatchOperation);
  }

  return { schemaVersion: 1, operations };
}

// ---------------------------------------------------------------------------
// D2.8 — input → argv compiler
// ---------------------------------------------------------------------------

/** Mechanical camelCase → kebab-case flag name mapping (D2.8, no exceptions). */
function flagName(field: string): string {
  return `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function assertNoLeadingDash(rendered: string, field: string): string {
  if (rendered.startsWith("-")) {
    // parseArgs would split the value into a new flag + stray positional,
    // so the compiler refuses rather than corrupt argv.
    throw new ValidationError(`input field "${field}" must not begin with "-"`);
  }
  return rendered;
}

/**
 * Emit a flag. Booleans render as the bare flag only when `true` —
 * `false` and `undefined` both emit nothing (the handler default is the
 * off-state). Numbers and strings render as the next argv element;
 * `fields` joins with "," (the handler re-splits on comma).
 */
function emitFlag(argv: string[], field: string, value: unknown): void {
  if (value === undefined || value === false) return;
  if (value === true) {
    argv.push(flagName(field));
    return;
  }
  let rendered: string;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    rendered = value.map((entry) => String(entry)).join(",");
  } else if (typeof value === "number") {
    rendered = String(value);
  } else if (typeof value === "string") {
    if (value.length === 0) {
      throw new ValidationError(`input field "${field}" must not be empty`);
    }
    rendered = value;
  } else {
    throw new ValidationError(`input field "${field}" has an unsupported value`);
  }
  argv.push(flagName(field), assertNoLeadingDash(rendered, field));
}

/** Emit a positional value; defensive against unparsed inputs. */
function emitPositional(argv: string[], field: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) {
    throw new ValidationError(`input field "${field}" must not be empty`);
  }
  argv.push(assertNoLeadingDash(value, field));
}

/**
 * Compile a parsed operation's `input` to the argv its handler consumes
 * (D2.8). Deterministic: same input → same argv, always. Output is a
 * `string[]` — no shell joining, no escaping hazards. Required fields
 * for the five positional handlers never render as flags.
 */
export function compileInput(op: BatchOperation): string[] {
  const argv: string[] = [];
  switch (op.command) {
    case "search": {
      const input = op.input;
      emitPositional(argv, "query", input.query);
      emitFlag(argv, "count", input.count);
      emitFlag(argv, "domain", input.domain);
      emitFlag(argv, "recency", input.recency);
      emitFlag(argv, "contentSize", input.contentSize);
      emitFlag(argv, "location", input.location);
      emitFlag(argv, "topic", input.topic);
      emitFlag(argv, "type", input.type);
      emitFlag(argv, "maxSummary", input.maxSummary);
      emitFlag(argv, "fields", input.fields);
      emitFlag(argv, "noCache", input.noCache);
      emitFlag(argv, "merge", input.merge);
      return argv;
    }
    case "read": {
      const input = op.input;
      emitPositional(argv, "url", input.url);
      emitFlag(argv, "format", input.format);
      emitFlag(argv, "noImages", input.noImages);
      emitFlag(argv, "withLinks", input.withLinks);
      emitFlag(argv, "withImagesSummary", input.withImagesSummary);
      emitFlag(argv, "noCache", input.noCache);
      return argv;
    }
    case "research": {
      const input = op.input;
      emitPositional(argv, "query", input.query);
      emitFlag(argv, "model", input.model);
      emitFlag(argv, "outputLength", input.outputLength);
      emitFlag(argv, "citationFormat", input.citationFormat);
      emitFlag(argv, "domain", input.domain);
      emitFlag(argv, "maxChars", input.maxChars);
      emitFlag(argv, "timeout", input.timeout);
      emitFlag(argv, "noCache", input.noCache);
      return argv;
    }
    case "repo": {
      const input = op.input;
      argv.push(input.subcommand);
      emitPositional(argv, "repository", input.repository);
      if (input.subcommand === "search") {
        emitPositional(argv, "query", input.query);
      } else if (input.subcommand === "read") {
        emitPositional(argv, "path", input.path);
      } else {
        // tree / brief: path renders as the --path flag.
        emitFlag(argv, "path", input.path);
      }
      emitFlag(argv, "language", input.language);
      emitFlag(argv, "maxChars", input.maxChars);
      emitFlag(argv, "focus", input.focus);
      emitFlag(argv, "depth", input.depth);
      emitFlag(argv, "noCache", input.noCache);
      return argv;
    }
    case "vision": {
      const input = op.input;
      argv.push(input.subcommand);
      if (input.subcommand === "diff") {
        emitPositional(argv, "expected", input.expected);
        emitPositional(argv, "actual", input.actual);
        if (input.prompt !== undefined) emitPositional(argv, "prompt", input.prompt);
      } else {
        emitPositional(argv, "source", input.source);
        if (input.prompt !== undefined) emitPositional(argv, "prompt", input.prompt);
      }
      emitFlag(argv, "language", input.language);
      emitFlag(argv, "context", input.context);
      emitFlag(argv, "type", input.type);
      emitFlag(argv, "focus", input.focus);
      emitFlag(argv, "output", input.output);
      return argv;
    }
    case "crawl": {
      const input = op.input;
      emitPositional(argv, "url", input.url);
      emitFlag(argv, "depth", input.depth);
      emitFlag(argv, "breadth", input.breadth);
      emitFlag(argv, "limit", input.limit);
      emitFlag(argv, "selectPaths", input.selectPaths);
      emitFlag(argv, "excludePaths", input.excludePaths);
      emitFlag(argv, "instructions", input.instructions);
      emitFlag(argv, "format", input.format);
      emitFlag(argv, "contentSize", input.contentSize);
      emitFlag(argv, "timeout", input.timeout);
      emitFlag(argv, "maxChars", input.maxChars);
      emitFlag(argv, "noCache", input.noCache);
      return argv;
    }
    case "map": {
      const input = op.input;
      emitPositional(argv, "url", input.url);
      emitFlag(argv, "depth", input.depth);
      emitFlag(argv, "breadth", input.breadth);
      emitFlag(argv, "limit", input.limit);
      emitFlag(argv, "selectPaths", input.selectPaths);
      emitFlag(argv, "excludePaths", input.excludePaths);
      emitFlag(argv, "instructions", input.instructions);
      emitFlag(argv, "noCache", input.noCache);
      return argv;
    }
  }
}
