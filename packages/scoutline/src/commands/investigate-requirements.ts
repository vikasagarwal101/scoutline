/**
 * Requirements-mode investigate handler (unified-investigation
 * public-command-integration). EXPERIMENTAL surface — the plain
 * `investigate <question>` EvidencePack lane (ADR-0013) is untouched;
 * `--requirements <path|->` / `--requirements-json '<json>'` delegate
 * here BEFORE any plain-mode guard fires.
 *
 * Composition (all approved, reviewed modules — no second engine):
 *   preflight  strict envelope/depth/key subset + the shared compiler
 *              (compileLeanContract — zero acquisition on failure)
 *   engine     runLeanInvestigation over LeanUnifiedDeps built from
 *              createLeanAcquisitionDeps (real descriptors + shared
 *              executors + bounded per-operation transport wrapper)
 *   judge      resolveTypesafeJudgeProfile — explicit
 *              TYPESAFE_API_KEY + SCOUTLINE_JUDGE_TRANSMIT=1, both or
 *              neither; selected-and-failing NEVER silently downgrades
 *   candidates extract/candidateJudge ride ONLY the injected runtime;
 *              no production parser is activated by judge credentials
 *
 * Result envelope: {kind:"requirements-investigation", schemaVersion:1,
 * complete|partial, accepted-only data, per-field rows, evidence with
 * original/display digests, physical totals, resultSha256}. Exit 0
 * complete / 1 partial (engineering recommendation, ADR draft pending).
 *
 * Provider selection (conservative runtime contract ruling): the
 * caller-supplied resolved id from main's EXISTING precedence
 * (--provider > SCOUTLINE_PROVIDER > routing > quota-rank > zai) is
 * honored; a resolved supplier outside the executable bounded
 * Search+Reader subset is a typed preflight failure BEFORE any HTTP —
 * never a silent Tavily reroute (no requirements-only default exists).
 */

import { createHash } from "node:crypto";
import { validateCallerPhysical, type CallerPhysicalSnapshot } from "../lib/caller-physical.js";
import { open, read, close, fstat, constants } from "node:fs";
import { stat } from "node:fs/promises";
const fstatP = promisify(fstat);
import { promisify } from "node:util";

import { compileLeanContract, runLeanInvestigation } from "../lib/lean-investigation.js";
import type {
  LeanAcquisitionEvent,
  LeanFieldRow,
  LeanResult,
  LeanUnifiedDeps,
} from "../lib/lean-investigation.js";
import { createLeanAcquisitionDeps } from "../lib/lean-acquisition-bridge.js";
import type {
  LeanAcquisitionBridgeOptions,
  LeanPhysicalAttempt,
  LeanReadProvenance,
} from "../lib/lean-acquisition-bridge.js";
import { resolveTypesafeJudgeProfile } from "../lib/lean-typesafe-judge.js";
import { ValidationError } from "../lib/errors.js";
import { redactSecrets } from "../lib/redact.js";
import type { ResponseCache } from "../lib/cache.js";
import type { CommandResult } from "../command-invocation.js";
import type { ProviderDescriptor, ProviderId } from "../providers/types.js";
import { resolveEffectiveProvider } from "../providers/selection.js";
import type { TavilyTransportDeps } from "../providers/tavily/client.js";
import type { ExaTransportDeps } from "../providers/exa/client.js";
import type { FirecrawlTransportDeps } from "../providers/firecrawl/client.js";
import type { LinkupTransportDeps } from "../providers/linkup/client.js";
import type { SpiderTransportDeps } from "../providers/spider/client.js";
import { createTavilyDescriptor } from "../providers/tavily/adapter.js";
import { createExaDescriptor } from "../providers/exa/adapter.js";
import { createFirecrawlDescriptor } from "../providers/firecrawl/adapter.js";
import { createLinkupDescriptor } from "../providers/linkup/adapter.js";
import { createSpiderDescriptor } from "../providers/spider/adapter.js";

/** 1 MiB requirements input ceiling (file / stdin / inline alike). */
export const MAX_REQUIREMENTS_BYTES = 1024 * 1024;
const MAX_INPUT_DEPTH = 16;

/**
 * Executable bounded-composition subset: adapter factory accepts a
 * `{fetch, env}` transport injection AND the descriptor serves BOTH
 * search and reader. Honest enumeration verified against the live
 * adapters — brave/bocha/searchapi serve no reader; jina's factory
 * takes no transport injection. Extend only with a verified entry.
 */
const EXECUTABLE_SUPPLIERS: ReadonlySet<string> = new Set([
  "tavily",
  "exa",
  "firecrawl",
  "linkup",
  "spider",
]);

/**
 * EXPERIMENTAL shared physical ceiling (consolidated root 3): a fixed
 * experiment value, NOT an owner-approved budget. It may be LOWERED for
 * a constrained run through `SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL` and is
 * NEVER raised: a present value must be a base-10 integer in 1..48 —
 * 49, 100000, 0, -1, "banana" and any other malformed input reject as
 * typed VALIDATION_ERROR BEFORE any HTTP, never a silent default.
 */
export const EXPERIMENTAL_MAX_PHYSICAL_ATTEMPTS = 48;

/** Resolve this run's ceiling: the experimental value, or a strictly
 *  lower integer. Present-but-invalid is a typed preflight failure. */
function physicalAttemptCeiling(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL;
  if (raw === undefined || raw === "") return EXPERIMENTAL_MAX_PHYSICAL_ATTEMPTS;
  const reject = (why: string): never => {
    throw new ValidationError(
      `SCOUTLINE_REQUIREMENTS_MAX_PHYSICAL must be a base-10 integer between 1 and ${EXPERIMENTAL_MAX_PHYSICAL_ATTEMPTS} (experimental ceiling); got ${JSON.stringify(raw)} (${why}).`,
      "Lower the run's physical dispatch budget, or unset the variable for the default ceiling. Raising it is not supported.",
    );
  };
  if (!/^[0-9]+$/.test(raw)) reject("not a base-10 integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) reject("below the minimum of 1");
  if (value > EXPERIMENTAL_MAX_PHYSICAL_ATTEMPTS) {
    reject("above the experimental ceiling — the ceiling is never raised");
  }
  return value;
}

/** Human-readable file type for the typed nonregular rejection. */
function describeFileType(stats: import("node:fs").Stats): string {
  if (stats.isFIFO()) return "FIFO";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character device";
  if (stats.isBlockDevice()) return "block device";
  return "a non-regular file";
}


const BOUNDED_TRANSPORT_FACTORIES: Readonly<
  Record<string, (transport: { fetch: unknown; env: NodeJS.ProcessEnv }) => ProviderDescriptor>
> = {
  tavily: (transport) => createTavilyDescriptor({ transport: transport as TavilyTransportDeps }),
  exa: (transport) => createExaDescriptor({ transport: transport as ExaTransportDeps }),
  firecrawl: (transport) => createFirecrawlDescriptor({ transport: transport as FirecrawlTransportDeps }),
  linkup: (transport) => createLinkupDescriptor({ transport: transport as LinkupTransportDeps }),
  spider: (transport) => createSpiderDescriptor({ transport: transport as SpiderTransportDeps }),
};

/** Help section appended to INVESTIGATE_HELP (same stdout surface —
 *  the existing help-pinning guard asserts the concatenation). */
export const INVESTIGATE_REQUIREMENTS_HELP = `
Requirements mode (EXPERIMENTAL — unified-investigation):
  scoutline investigate --requirements <path|->       # file / stdin
  scoutline investigate --requirements-json '<json>'  # inline

  Runs the requirements-driven investigation engine: a strict
  compiler validates the document (unknown keys/declarations
  reject BEFORE any acquisition), then a bounded acquisition
  loop produces an accepted-only structured answer with
  per-field outcomes, evidence identity and physical HTTP
  accounting. Exit 0 complete / 1 partial. Mutually exclusive
  with the positional question and plain-mode controls.
  Provider: the existing selection precedence is preserved
  (--provider > SCOUTLINE_PROVIDER > routing > configured
  default); the resolved supplier must serve BOTH search and
  reader over a bounded transport in this mode (executable
  subset: ${[...EXECUTABLE_SUPPLIERS].join(", ")}) — otherwise
  a typed preflight error names the subset, never a reroute.
  Semantic judge: explicit TYPESAFE_API_KEY +
  SCOUTLINE_JUDGE_TRANSMIT=1 (both or neither; absent judge
  keeps deterministic-only results with unresolved semantic
  fields — never a silent downgrade).
`;

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "question", "scope", "requirements", "evidence", "limits"]);
const REQUIREMENT_KEYS = new Set(["question", "schema", "criteria", "required", "dependsOn"]);
const SCHEMA_KEYS = new Set(["enum", "type", "pattern", "minLength", "maxLength"]);
const EVIDENCE_KEYS = new Set(["criteria"]);
const LIMIT_KEYS = new Set(["readBatchSize", "maxUniqueReads", "maxSearchAttempts", "maxJudgeAttempts", "deadlineMs"]);

// ---------------------------------------------------------------------------
// Injected runtime seam (tests inject fake transports + fake judge/
// extractor; production default composes the real bridge + direct judge)
// ---------------------------------------------------------------------------

export interface RequirementsRuntimeContext {
  readonly env: NodeJS.ProcessEnv;
  /** Caller-resolved provider id (main's existing precedence — this
   *  module adds NO default of its own; a bare "tavily" in test context
   *  is the caller's explicit choice, never an inference). */
  readonly provider: string;
  readonly noCache: boolean;
  readonly cache: ResponseCache;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  /**
   * Producer physical-dispatch observer (cold-review finding 1): the
   * handler owns this counter; a runtime that configures an explicitly
   * selected producer calls it once per permitted physical dispatch —
   * BEFORE the request, sharing the run's finite admission. A producer
   * that performs no physical work never calls it (a truthful zero);
   * an opaque producer that does not use the seam leaves its stage
   * explicitly unknown rather than inferred.
   */
  readonly observeProducerDispatch?: () => void;
  /**
   * THE shared pre-dispatch admission closure (final boundary repair,
   * root 1). The runtime hands this EXACT function to the native direct
   * judge as its `reserveAttempt`, so every physical judge request —
   * first attempt and every retry — reserves against the one run-wide
   * ceiling before the request is dispatched. A production runtime
   * must not create its own second budget.
   */
  readonly reserveAttempt?: () => void;
}

export interface RequirementsEngineDeps {
  readonly judge?: RequirementsJudgeFn | null;
  readonly extract?: ((request: unknown, options?: unknown) => Promise<unknown>) | null;
  readonly candidateJudge?: RequirementsJudgeFn | null;
  readonly extractorRevision?: string;
  /**
   * Optional declared producer attempt metadata. When a producer
   * publishes a count up front (rather than per response), the handler
   * validates it at composition time — before any dispatch — so a
   * malformed declaration is a typed measurement error even if the
   * producer never runs. Absent (the common case) means unknown.
   */
  readonly declaredProducerAttempts?: number;
  readonly now?: () => number;
}

export interface RequirementsRuntimeInput {
  readonly acquisitionOptions: LeanAcquisitionBridgeOptions;
  readonly engineDeps: RequirementsEngineDeps;
  readonly secrets?: readonly string[];
  /**
   * Producer (extractor) physical-dispatch observer — the producer-side
   * twin of the bridge/judge admission seams (cold-review finding 1).
   * A producer that performs physical HTTP calls this BEFORE each
   * permitted dispatch, so its work shares the finite run admission and
   * joins the measured totals. A producer that performs none (local /
   * cache-served / deterministic) simply never calls it — zero is a
   * truthful measurement, not an omission. A producer configured
   * WITHOUT an observer leaves its dispatch count UNKNOWN (the total
   * publishes `physicalHttpAttemptsUnknown`), never a per-call floor.
   */
  readonly producerPhysical?: {
    readonly reserve: () => void;
  };
  /**
   * Declared judge admission (root 4): "shared" only when the runtime
   * wired the run-owned pre-dispatch closure into its native judge, so
   * the delivered envelope can state that judge requests are bounded by
   * the run's shared ceiling. Absent/anything else is opaque: measured,
   * but with unknown enforcement.
   */
  readonly judgeAdmission?: "shared";
}

export type RequirementsRuntimeFactory = (context: RequirementsRuntimeContext) => RequirementsRuntimeInput;

// ---------------------------------------------------------------------------
// Input validation helpers (strict — unknown keys reject, never drop)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preflightShape(value: unknown, what: "envelope" | "requirements", depth = 0): void {
  if (depth > MAX_INPUT_DEPTH) {
    throw new ValidationError(`${what}: nesting exceeds the ${MAX_INPUT_DEPTH}-depth ceiling.`);
  }
  if (Array.isArray(value)) {
    for (const item of value) preflightShape(item, what, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const keys = what === "requirements" ? REQUIREMENT_KEYS : TOP_LEVEL_KEYS;
  for (const key of Object.keys(record)) {
    const known = keys.has(key);
    if (!known) {
      throw new ValidationError(
        `requirements declare unsupported key "${key}" — requirements mode supports a strict subset; unknown declarations are rejected, not dropped.`,
      );
    }
    preflightShape(record[key], what, depth + 1);
  }
}

/** Strict preflight: envelope keys, per-requirement keys, schema keys,
 *  evidence/limit keys, depth — everything unknown rejects before any
 *  acquisition. Mirrors the development slice; the shared compiler
 *  still owns the semantic validation. */
export function preflightRequirements(input: unknown): void {
  if (!isPlainObject(input)) {
    throw new ValidationError("requirements must be a JSON object.");
  }
  if (input.limits !== undefined) {
    if (!isPlainObject(input.limits)) {
      throw new ValidationError("limits must be an object.");
    }
    for (const key of Object.keys(input.limits)) {
      if (!LIMIT_KEYS.has(key)) {
        throw new ValidationError(`limits declare unsupported key "${key}".`);
      }
    }
  }
  if (input.scope !== undefined) {
    if (!isPlainObject(input.scope)) {
      throw new ValidationError("scope must be an object of string tokens.");
    }
    for (const value of Object.values(input.scope)) {
      if (typeof value !== "string") throw new ValidationError("scope values must be strings.");
    }
  }
  const shallow = { ...input, requirements: null, evidence: null, limits: null, scope: null };
  preflightShape(shallow, "envelope");
  if (input.evidence !== undefined) {
    if (!isPlainObject(input.evidence)) {
      throw new ValidationError("evidence must be an object.");
    }
    for (const key of Object.keys(input.evidence)) {
      if (!EVIDENCE_KEYS.has(key)) {
        throw new ValidationError(`evidence declares unsupported key "${key}".`);
      }
    }
    preflightShape(input.evidence, "requirements");
  }
  if (input.requirements !== undefined) {
    if (!isPlainObject(input.requirements)) {
      throw new ValidationError("requirements must be an object keyed by field id.");
    }
    for (const field of Object.values(input.requirements)) {
      if (isPlainObject(field) && field.schema !== undefined) {
        if (!isPlainObject(field.schema)) {
          throw new ValidationError("requirement schema must be an object.");
        }
        for (const key of Object.keys(field.schema)) {
          if (!SCHEMA_KEYS.has(key)) {
            throw new ValidationError(`requirement schema declares unsupported key "${key}".`);
          }
        }
        preflightShape({ ...field, schema: null }, "requirements");
      } else {
        preflightShape(field, "requirements");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Judge selection (explicit consent; never a silent downgrade)
// ---------------------------------------------------------------------------

type RequirementsJudgeFn = (input: unknown, options?: unknown) => Promise<unknown>;

/**
 * Official direct TypeSafe judge profile from explicit selection:
 * TYPESAFE_API_KEY and SCOUTLINE_JUDGE_TRANSMIT=1 must BOTH be present;
 * either alone is a typed configuration error, neither is approved
 * deterministic-only. Malformed overrides (TYPESAFE_MODEL /
 * TYPESAFE_ENDPOINT) reject even with no key — the resolver's
 * closed-selection validation runs before the absent return.
 */
export function selectRequirementsJudge(
  env: NodeJS.ProcessEnv,
  reserveAttempt: () => void,
): { judge: RequirementsJudgeFn | null; candidateJudge: RequirementsJudgeFn | null } {
  const key = env.TYPESAFE_API_KEY;
  const consent = env.SCOUTLINE_JUDGE_TRANSMIT === "1";
  if (key === undefined && !consent) {
    // Probe the closed-selection validation (rejects malformed
    // overrides) then return the approved absent profile.
    resolveTypesafeJudgeProfile(
      {
        env: { TYPESAFE_MODEL: env.TYPESAFE_MODEL, TYPESAFE_ENDPOINT: env.TYPESAFE_ENDPOINT },
        transmitConsent: false,
      },
      { apiKey: "probe-not-used", reserveAttempt },
    );
    return { judge: null, candidateJudge: null };
  }
  if (key === undefined || !consent) {
    throw new ValidationError(
      "requirements-mode judge selection is incomplete: TYPESAFE_API_KEY and SCOUTLINE_JUDGE_TRANSMIT=1 must be supplied together (credentials alone are not consent; consent alone has no judge).",
    );
  }
  const profile = resolveTypesafeJudgeProfile(
    { env, transmitConsent: true },
    { apiKey: key, reserveAttempt },
  );
  if (profile === null) {
    throw new ValidationError("requirements-mode judge profile resolved to null after explicit selection.");
  }
  return {
    judge: profile.judge as unknown as RequirementsJudgeFn,
    candidateJudge: profile.candidateJudge as unknown as RequirementsJudgeFn,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface InvestigateRequirementsDeps {
  /**
   * Owned-interruption registrar (correction 7): registers a callback
   * fired on the host's user-interrupt signal (bin: process SIGINT).
   * Returns an unregister closure. Absent (test adapters) — the run
   * simply has no OS-signal bridge; the engine contract is unchanged.
   */
  readonly registerUserInterrupt?: (onInterrupt: () => void) => () => void;
  /** Requirement file reader — bounded incremental (production: fd
   *  reader with maxBytes+1 detection and guaranteed close; tests:
   *  doubles). stdin/inline use readStdin/inline bytes. */
  readonly readFile: (path: string) => Promise<string>;
  /**
   * Requirements input read. The optional signal is the owned
   * interruption's: a source that supports cancellation (the compiled
   * bin's real stdin) disposes its subscription and unblocks, so an
   * interrupt settles 130 without waiting for EOF.
   */
  readonly readStdin: (signal?: AbortSignal) => Promise<string>;
  readonly now: () => number;
  /** Injectable runtime factory (tests inject fake transports and
   *  fake judge/extractor collaborators; production leaves undefined
   *  and the default real composition below runs). */
  readonly requirementsRuntime?: RequirementsRuntimeFactory;
  /**
   * Runtime-secret sink (cold-review findings 2/3): the handler reports
   * the explicit judge/producer/runtime secret values it composed the
   * instant the runtime exists — BEFORE the compiler/preflight errors
   * that follow can be formatted — so the dispatcher can merge them
   * into its ONE redaction list for the error, output and save
   * boundaries without any shared-seam change.
   */
  readonly onRuntimeSecrets?: (secrets: readonly string[]) => void;
  /**
   * Resolved-provider sink (cold-review finding 6): the handler reports
   * the supplier the ESTABLISHED resolver actually selected, the moment
   * the runtime context is built — so the dispatcher's save metadata can
   * record the real serving supplier instead of a guess.
   */
  readonly onResolvedProvider?: (provider: string) => void;
}

/** Incremental bounded file read: reads 64 KiB chunks until EOF,
 *  rejecting the moment total exceeds maxBytes (maxBytes+1 detection)
 *  — never fstat-size trust, never buffering an unbounded file. The
 *  fd is closed on every path (correction finding 4). */
export async function readRequirementsFileBounded(path: string, maxBytes: number): Promise<string> {
  // Race-safe nonregular rejection (consolidated root 4): a pre-open
  // stat is only ADVISORY — a regular file can be replaced by a FIFO
  // before open(2), and a blocking open on a FIFO never returns. So the
  // descriptor is opened NONBLOCKING (O_NONBLOCK makes open(2) on a FIFO
  // with no writer return immediately instead of blocking) and the
  // authoritative regular-file check is the post-open fstat, inside the
  // descriptor's `finally` so a rejected fstat still closes it.
  let preStat;
  try {
    preStat = await stat(path);
  } catch (error) {
    throw new ValidationError(
      `requirements file "${path}" cannot be read: ${(error as Error).message}`,
    );
  }
  if (preStat.isDirectory()) {
    throw new ValidationError(
      `requirements input "${path}" is a directory; pass a regular file, or '-' for stdin.`,
    );
  }

  const fd = await promisify(open)(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const postStat = await fstatP(fd);
    if (!postStat.isFile()) {
      throw new ValidationError(
        `requirements input "${path}" is not a regular file (opened descriptor reports ${describeFileType(postStat)}); FIFO, device and socket inputs are rejected.`,
      );
    }
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await promisify(read)(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw new ValidationError(
          `requirements file exceeds the ${maxBytes}-byte input ceiling.`,
        );
      }
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    await promisify(close)(fd).catch(() => {});
  }
}

/** Bounded read: inline checked before anything; file read
 *  incrementally with maxBytes+1 detection; stdin bounded by the
 *  adapter's maxBytes+1 read (the caller passes MAX_REQUIREMENTS_BYTES
 *  as the bound). */
async function readRequirements(
  source: { kind: "file"; path: string } | { kind: "stdin" } | { kind: "inline"; value: string },
  deps: Pick<InvestigateRequirementsDeps, "readFile" | "readStdin">,
  signal?: AbortSignal,
): Promise<string> {
  if (source.kind === "inline") {
    if (Buffer.byteLength(source.value, "utf8") > MAX_REQUIREMENTS_BYTES) {
      throw new ValidationError(
        `requirements exceed the ${MAX_REQUIREMENTS_BYTES}-byte input ceiling.`,
      );
    }
    return source.value;
  }
  if (source.kind === "stdin") {
    const text = await deps.readStdin(signal);
    if (Buffer.byteLength(text, "utf8") > MAX_REQUIREMENTS_BYTES) {
      throw new ValidationError(
        `requirements exceed the ${MAX_REQUIREMENTS_BYTES}-byte input ceiling.`,
      );
    }
    return text;
  }
  return deps.readFile(source.path);
}

interface PhysicalTotals {
  acquisitionAttempts: number;
  perAttempt: readonly LeanPhysicalAttempt[];
  refused: number;
  judgeDispatches: number;
  /** Explicit producer (extractor) dispatches observed through the
   *  `attempts`-reporting seam (a reported count is a measured
   *  dispatch count). */
  producerDispatches: number;
  /** True when the runtime supplied a `producerPhysical` observer —
   *  only then is the producer's physical work measured; otherwise
   *  the total is explicitly unknown for that stage. */
  producerObserved: boolean;
  producerConfigured: boolean;
  /**
   * Judge admission participation (root 4): "shared" when a judge seam
   * declared the run's pre-dispatch closure (its requests are bounded
   * by the run ceiling), "unknown" when an opaque judge was injected
   * without that seam — its physical count is measured but its
   * enforcement is NOT part of the shared admission, and the delivered
   * envelope says so instead of implying all-stage enforcement.
   */
  judgeAdmission: "shared" | "unknown" | "not-configured";
  /** A judge was configured but reported no attempt telemetry. */
  judgeTelemetryMissing: boolean;
}

/** Count physical attempts on a seam response/rejection: the engine
 *  audit symbol (judge/candidateJudge) or an `attempts` field. */
/**
 * Read a declared attempt measurement, DISTINGUISHING "not reported"
 * (undefined) from "reported but invalid" (a present value that is not a
 * nonnegative safe integer — the caller raises a typed measurement
 * error). Malformed values are never filtered into absence: that would
 * turn a declared-but-broken measurement into a silent unknown.
 */
function attemptsOf(response: unknown): number | undefined {
  const meta = (response as { [k: symbol]: unknown } | null | undefined)?.[
    Symbol.for("leanJevAttemptMeta")
  ] as { attempts?: unknown } | undefined;
  if (meta !== undefined && "attempts" in meta) {
    const value = meta.attempts;
    if (value === undefined || value === null) return undefined;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : Number.NaN; // present but invalid — the caller must diagnose
  }
  const direct = (response as { attempts?: unknown } | null | undefined)?.attempts;
  if (direct === undefined || direct === null) return undefined;
  return typeof direct === "number" && Number.isSafeInteger(direct) && direct >= 0
    ? direct
    : Number.NaN;
}

/** Declared-but-malformed measurements are typed errors at the shared
 *  measurement boundary (root 4), never silently zero or unknown. */
function assertMeasuredCount(count: number, stage: string): void {
  if (Number.isSafeInteger(count) && count >= 0) return;
  throw new ValidationError(
    `${stage} declared an invalid physical-attempt measurement (${String(count)}); counts must be nonnegative safe integers.`,
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Owned-interruption session (consolidated root 6): registration happens
 * at the COMMAND's start — before the input read, parse, compile and
 * runtime construction — so a pending file/stdin read is covered too. The
 * returned `release` is idempotent and runs on every exit path; the
 * controller's signal is the one handed to the engine.
 */
interface OwnedInterruption {
  readonly controller: AbortController;
  readonly interrupted: () => boolean;
  readonly release: () => void;
  /** Throw the settled 130 outcome when the user interrupted the run. */
  readonly settle: () => void;
}

function beginOwnedInterruption(deps: InvestigateRequirementsDeps): OwnedInterruption {
  const controller = new AbortController();
  let interrupted = false;
  let released = false;
  const unregister = deps.registerUserInterrupt?.(() => {
    interrupted = true;
    controller.abort();
  });
  return {
    controller,
    interrupted: () => interrupted,
    release: () => {
      if (released) return;
      released = true;
      unregister?.();
    },
    settle: () => {
      if (!interrupted) return;
      const err = new ValidationError(
        "requirements investigation interrupted by user (SIGINT): in-flight work was cancelled; remote completion state is unknown.",
        "The run was cancelled before all planned evidence was gathered; re-run to complete.",
      );
      // Exit-code settlement lives on the instance (ValidationError's
      // signature pins exit 1; 130 is the owned-interrupt outcome).
      (err as { exitCode: number }).exitCode = 130;
      throw err;
    },
  };
}

/**
 * Await a stage while the owned interruption is live: an interrupt
 * settles immediately (the stage's own cancellation — where the source
 * supports it — disposes the underlying subscription) and the stage's
 * eventual settlement is OBSERVED so a late rejection never escapes as
 * an unhandled rejection. Cleanup runs whichever path wins.
 */
async function raceWithInterrupt<T>(work: Promise<T>, owned: OwnedInterruption): Promise<T> {
  // NAMED listener, removed in a guaranteed finally on success,
  // rejection and abort alike (root 3): an anonymous callback left a
  // listener installed on the owned signal after a normal read.
  let onAbort: (() => void) | undefined;
  const interrupt = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(
        Object.assign(new Error("requirements run interrupted before the stage settled"), {
          name: "AbortError",
        }),
      );
    };
    owned.controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (owned.controller.signal.aborted === true) onAbort?.();
    return await Promise.race([work, interrupt]);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && owned.interrupted()) {
      // The stage's own cancellation (where the source supports it)
      // disposes its subscription; its late outcome is OBSERVED so a
      // late rejection never escapes as an unhandled rejection.
      void work.catch(() => undefined);
      owned.settle();
    }
    throw error;
  } finally {
    if (onAbort !== undefined) owned.controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function withRequirementsRuntime<T>(input: unknown, deps: InvestigateRequirementsDeps, host: RuntimeContextHost,
  execute: (input: unknown, unified: LeanUnifiedDeps, observation: () => CallerPhysicalSnapshot) => Promise<{ result: LeanResult; value: T }>, signal?: AbortSignal): Promise<{ value: T; projected: CommandResult; secrets: string[] }> {
  const owned = beginOwnedInterruption(deps);
  const abort = (): void => owned.controller.abort();
  signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  try {
    let value!: T;
    const run = await runWithRuntime(input, deps, host, owned, async (contract, unified, observation) => {
      const answer = await execute(contract, unified, observation); value = answer.value; return answer.result;
    });
    // Caller adapter returns an inspectable cancelled handoff; ordinary requirements still settle 130 above.
    return { value, projected: projectResult(run.result, run.secrets, host, run.physical, run.provenance), secrets: run.secrets };
  } finally { signal?.removeEventListener("abort", abort); owned.release(); }
}

export async function handleInvestigateRequirements(
  args: {
    readonly source: { kind: "file"; path: string } | { kind: "stdin" } | { kind: "inline"; value: string };
  },
  deps: InvestigateRequirementsDeps,
  host?: RuntimeContextHost,
): Promise<CommandResult> {
  // Owned interruption from the FIRST line of the command: the pending
  // input read, JSON parse, compiler preflight, runtime construction and
  // final projection all sit inside the signal window; an interrupt in
  // any of them settles 130 and releases the registrar.
  const owned = beginOwnedInterruption(deps);
  try {
    // Pending input (final boundary repair, root 3): the read carries
    // the owned signal so a cancellable source disposes its
    // subscription; the race makes the settle prompt even for a source
    // that cannot cancel, and the late rejection is observed (never an
    // unhandled rejection) whichever path wins.
    const text = await raceWithInterrupt(readRequirements(args.source, deps, owned.controller.signal), owned);
    owned.settle();

    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch (error) {
      throw new ValidationError(`requirements are not valid JSON: ${(error as Error).message}`);
    }
    owned.settle();

    // Strict preflight BEFORE any acquisition: unknown keys/depth reject
    // (never accept-and-drop), then the shared compiler validates the
    // supported subset semantics — zero network on any failure.
    preflightRequirements(input);
    compileLeanContract(input);
    owned.settle();

    const runHost = host ?? {};
    const result = await runWithRuntime(input, deps, runHost, owned);
    owned.settle();
    // Same merged set the dispatcher hands invokeCommand (findings 2/3):
    // the envelope is projected against that one merged list.
    return projectResult(result.result, result.secrets, runHost, result.physical, result.provenance);
  } finally {
    owned.release();
  }
}

/** Compose the runtime (injected or production default), run the
 *  engine, and collect the physical totals. */
async function runWithRuntime(
  input: unknown,
  deps: InvestigateRequirementsDeps,
  host: RuntimeContextHost,
  owned: OwnedInterruption,
  execute: (input: unknown, deps: LeanUnifiedDeps, observation: () => CallerPhysicalSnapshot) => Promise<LeanResult> = runLeanInvestigation,
): Promise<{
  result: LeanResult;
  secrets: string[];
  physical: PhysicalTotals;
  provenance: readonly LeanReadProvenance[];
}> {
  const physical: PhysicalTotals = {
    acquisitionAttempts: 0,
    perAttempt: [],
    refused: 0,
    judgeDispatches: 0,
    producerDispatches: 0,
    producerObserved: false,
    producerConfigured: false,
    judgeAdmission: "not-configured",
    judgeTelemetryMissing: false,
  };
  const provenance: LeanReadProvenance[] = [];
  const now = deps.now;

  const runtime = deps.requirementsRuntime ?? defaultRequirementsRuntime;
  // Selection snapshot (findings 4/6): the dispatcher-supplied
  // fail-open read of the production quotaStore, awaited ONCE here and
  // only when the lane actually resolves a provider. Undefined stays
  // undefined — the resolver's documented compatibility branch, not an
  // invented snapshot.
  let snapshot = host.quotaState;
  if (snapshot === undefined && typeof host.readQuotaSnapshot === "function") {
    // Stalled setup wait (root 2): the snapshot read is a potentially
    // blocking stage, so it is raced with the owned signal like the
    // input read. A cancelled run settles 130 here — before any
    // runtime construction or acquisition — and the late snapshot
    // settlement is observed rather than left dangling.
    snapshot = (await raceWithInterrupt(
      Promise.resolve(host.readQuotaSnapshot()),
      owned,
    )) as unknown;
  }
  // Run-owned finite physical admission (consolidated roots 1/2): ONE
  // ceiling shared by acquisition, the selected native judge and every
  // explicitly observable producer dispatch. The reservation runs BEFORE
  // the side effect it admits and refuses past the ceiling; the same
  // closure reaches all three stages (the bridge reservation below wraps
  // the runtime's own, the judge profile reserves through it, and the
  // producer observer reserves through it), so no stage can widen the
  // budget. A refusal throws — it never counts and never dispatches.
  const maxPhysical = physicalAttemptCeiling(host.env);
  let runPhysical = 0;
  /**
   * THE admission authority (final boundary repair, root 1): one
   * pre-dispatch reservation closure created BEFORE the runtime factory
   * runs and handed to it through the context, so the actual native
   * TypeSafe judge and candidate judge reserve against THIS closure
   * before every physical request (including retries). Acquisition and
   * explicit producer dispatches use the same closure. A refusal throws
   * BEFORE the request — nothing is dispatched, and the refused attempt
   * is never counted. Response metadata only measures after the fact;
   * it never grants permission retroactively.
   */
  const reservePhysicalAttempt = (): void => {
    if (runPhysical >= maxPhysical) {
      physical.refused += 1;
      throw new ValidationError(
        `requirements run exhausted its shared physical budget of ${maxPhysical} HTTP dispatches across acquisition, judge and producer stages.`,
      );
    }
    runPhysical += 1;
  };
  const context: RequirementsRuntimeContext = {
    ...runtimeContextFrom({ ...host, quotaState: snapshot }),
    // The producer's pre-dispatch admission: reserve FIRST (a refusal
    // throws before any producer side effect), then count the one
    // dispatch that reservation admitted. Authoritative producer count —
    // an informational `attempts` on the response may corroborate, never
    // add a second count.
    observeProducerDispatch: () => {
      reservePhysicalAttempt();
      physical.producerDispatches += 1;
      physical.producerObserved = true;
    },
    // Handed to the runtime so the actual native judge/candidate judge
    // reserve HERE, pre-dispatch, against the same ceiling.
    reserveAttempt: reservePhysicalAttempt,
  };
  deps.onResolvedProvider?.(context.provider);
  const composed = runtime(context);
  const { acquisitionOptions, engineDeps } = composed;
  // Report runtime/explicit-judge/producer secrets the moment they
  // exist — before any later error can reach a formatting boundary
  // (findings 2/3).
  deps.onRuntimeSecrets?.([...(composed.secrets ?? [])]);

  const acquisition = createLeanAcquisitionDeps({
    ...acquisitionOptions,
    // Shared admission: the run-owned closure IS the authority. A
    // runtime-supplied reservation is composed AFTER it (its refusal
    // still lands), but the shared ceiling is charged exactly once per
    // dispatch — never twice for one request.
    reservePhysicalAttempt: (): void => {
      reservePhysicalAttempt();
      // Compose a runtime's OWN reservation only when it is a different
      // closure — the production runtime passes the shared one through,
      // and charging it twice would refuse legitimate dispatches.
      const own = acquisitionOptions.reservePhysicalAttempt;
      if (own !== undefined && own !== reservePhysicalAttempt) own();
    },
    onReadProvenance: (record) => {
      provenance.push(record);
      acquisitionOptions.onReadProvenance?.(record);
    },
    onPhysicalLedger: (ledger) => {
      physical.acquisitionAttempts = ledger.attempts;
      physical.perAttempt = ledger.perAttempt;
      // Shared closure owns refusal accounting across every stage; bridge ledger overlaps it.
      acquisitionOptions.onPhysicalLedger?.(ledger);
    },
  });

  // Judge seams (final boundary repair, roots 1/2): the ADMISSION is
  // already done pre-dispatch by the native judge's own reserveAttempt
  // (the shared closure). What remains here is MEASUREMENT ONLY — the
  // reported attempt count joins the delivered total; it never reserves
  // and never authorizes a request that already happened. An injected
  // opaque judge that does not opt into the closure is therefore
  // measured-but-unbounded, which its own stage disclosure states.
  // Judge admission participation (root 4): the runtime declares whether
  // its judge is wired to the run-owned pre-dispatch closure
  // (`producerPhysical`-style declaration is not used; the runtime
  // reports `judgeAdmission`). A judge that declared the shared closure
  // is bounded by the run ceiling and may state so; an opaque judge is
  // measured only, and the delivered envelope discloses that its
  // enforcement is unknown. A runtime that does not declare either is
  // treated as opaque (unknown), never as shared.
  const declaredJudgeAdmission = composed.judgeAdmission;
  if (engineDeps.judge === null && engineDeps.candidateJudge === null) {
    physical.judgeAdmission = "not-configured";
  } else if (declaredJudgeAdmission === "shared") {
    physical.judgeAdmission = "shared";
  } else {
    physical.judgeAdmission = "unknown";
  }
  const markJudgeTelemetryMissing = (): void => {
    physical.judgeTelemetryMissing = true;
  };
  const wrappedJudge = countingSeam(
    engineDeps.judge,
    (count) => {
      assertMeasuredCount(count, "judge");
      physical.judgeDispatches += count;
    },
    markJudgeTelemetryMissing,
  );
  const wrappedCandidateJudge = countingSeam(
    engineDeps.candidateJudge,
    (count) => {
      assertMeasuredCount(count, "candidate judge");
      physical.judgeDispatches += count;
    },
    markJudgeTelemetryMissing,
  );
  // Producer (extractor) physical accounting (cold-review finding 1):
  // ONLY observed dispatches count — the runtime hands the producer an
  // observer through `producerPhysical.reserve` and every call there is
  // one measured dispatch sharing the finite admission. A producer
  // without an observer leaves the count UNKNOWN (explicit
  // `physicalHttpAttemptsUnknown`), never a per-call floor: a local or
  // cache-served producer that reserves zero is a truthful zero.
  physical.producerConfigured = typeof engineDeps.extract === "function";
  // Declared measurement metadata is validated where it is declared, not
  // only when a response happens to arrive (root 4): a producer that
  // ships a malformed declared count is a measurement error from the
  // moment it is configured, before any dispatch. Absent stays absent.
  if (engineDeps.declaredProducerAttempts !== undefined) {
    const declared = engineDeps.declaredProducerAttempts;
    if (!Number.isSafeInteger(declared) || declared < 0) {
      throw new ValidationError(
        `producer declared an invalid physical-attempt measurement (${String(declared)}); counts must be nonnegative safe integers.`,
      );
    }
  }
  // Observation is per-stage and evidence-based: the runtime declares a
  // producer physical seam (reserve) when its producer is wired for
  // measured dispatches; the context observer then counts each
  // permitted dispatch. A producer without that declared seam has an
  // UNKNOWN physical count — the total publishes measured stages plus
  // the explicit unknown marker, never a per-call floor (finding 1).
  if (composed.producerPhysical !== undefined) physical.producerObserved = true;
  const extractFn = engineDeps.extract;
  const wrappedExtract =
    typeof extractFn === "function"
      ? async (request: unknown, options?: unknown) => {
          // Producer measurement (final boundary repair, roots 2/4):
          // the OBSERVER is the admission and the count — it reserves
          // pre-dispatch. A returned `attempts` field is telemetry
          // only: it never reserves (the request already happened) and
          // never double counts an observed dispatch. Present-but-
          // invalid metadata (fractional, negative, string, NaN,
          // unsafe) is a typed measurement error; absent stays absent
          // (unknown), never zero. A producer that neither observes nor
          // reports leaves the stage explicitly unbounded/unknown.
          const observedBefore = physical.producerDispatches;
          const response = await extractFn(request, options);
          const count = attemptsOf(response);
          if (count !== undefined && !Number.isSafeInteger(count)) {
            // Declared but malformed (fractional, negative, NaN,
            // unsafe, non-numeric): a measurement error, not a total and
            // not an absent value. It is marked fatal so the ENGINE's
            // failed-extraction absorb arm rethrows it instead of
            // silently terminalizing the field — a broken measurement
            // must not hide as an unresolved field.
            throw Object.assign(
              new ValidationError(
                `producer declared an invalid physical-attempt measurement (${String((response as { attempts?: unknown }).attempts)}); counts must be nonnegative safe integers.`,
              ),
              { fatalMeasurement: true },
            );
          }
          if (physical.producerDispatches > observedBefore) return response;
          if (count !== undefined) {
            physical.producerDispatches += count;
            physical.producerObserved = true;
          }
          return response;
        }
      : undefined;

  // Owned interruption (correction 7): a run-owned controller bridges an
  // OS SIGINT into the engine's cancellation — the engine's externalSignal
  // seam forwards it to every in-flight dispatch, the listener is removed
  // at every exit, and an observed interrupt settles the invocation as an
  // explicit 130 outcome (never a raw process death, never a partial
  // result masquerading as complete). Registration is scoped to this
  // handler call: no global listener outlives the run. Test adapters
  // without a host process signal API (injected runtimes) skip
  // registration — the engine contract is unchanged for them.
  // Registration itself moved to the command's start (below) — see
  // `beginOwnedInterruption`.

  const unified = {
    ...acquisition,
    judge: (wrappedJudge ?? engineDeps.judge ?? null) as LeanUnifiedDeps["judge"],
    extract: wrappedExtract as LeanUnifiedDeps["extract"],
    candidateJudge: (wrappedCandidateJudge ?? engineDeps.candidateJudge ?? null) as LeanUnifiedDeps["candidateJudge"],
    ...(engineDeps.extractorRevision !== undefined ? { extractorRevision: engineDeps.extractorRevision } : {}),
    externalSignal: owned.controller.signal,
    now,
  } as LeanUnifiedDeps;

  // The engine's own gate consults this signal before every dispatch,
  // so an abort stops NEW work even when a dependency ignores it; the
  // caller's `settle()` then turns the cancelled run into exit 130.
  const observation = (): CallerPhysicalSnapshot => {
    const judge = physical.judgeTelemetryMissing ? null : physical.judgeDispatches;
    const producer = physical.producerConfigured && !physical.producerObserved ? null : physical.producerDispatches;
    const knownSubtotal = physical.acquisitionAttempts + (judge ?? 0) + (producer ?? 0);
    const snapshot: CallerPhysicalSnapshot = { schemaVersion: 1, source: "handler-owned-native-ledger", cutoff: "locally-settled",
      stages: { acquisition: physical.acquisitionAttempts, judge, producer }, knownSubtotal,
      total: judge === null || producer === null || physical.perAttempt.some(a => a.outcome === "unknown") ? null : knownSubtotal,
      reservationsRefused: physical.refused,
      admission: { acquisition: "shared", judge: physical.judgeAdmission, producer: !physical.producerConfigured ? "not-configured" : physical.producerObserved ? "shared" : "unknown" },
      attempts: physical.perAttempt.map(a => ({ provider: a.provider, phase: "acquisition", outcome: a.outcome })),
    };
    validateCallerPhysical(snapshot); return JSON.parse(JSON.stringify(snapshot)) as CallerPhysicalSnapshot;
  };
  const result = await execute(input, unified, observation);
  const secretList = [...(composed.secrets ?? [])];
  return { result, secrets: secretList, physical, provenance };
}

/** Wrap one semantic seam so each engine call's ACTUAL physical attempt
 *  count joins the delivered total (success carries the count on the
 *  audit symbol or `attempts`; typed rejections carry it as
 *  `attempts`). */
function countingSeam(
  fn: RequirementsJudgeFn | ((request: unknown, options?: unknown) => Promise<unknown>) | null | undefined,
  onCount: (count: number) => void,
  onMissingTelemetry?: () => void,
): ((input: unknown, options?: unknown) => Promise<unknown>) | undefined {
  if (typeof fn !== "function") return undefined;
  return async (input: unknown, options?: unknown) => {
    try {
      const response = await fn(input, options);
      const count = attemptsOf(response);
      if (count !== undefined) onCount(count);
      else onMissingTelemetry?.(); // ran, reported nothing: unknown, not zero
      return response;
    } catch (error) {
      const count = (error as { attempts?: unknown }).attempts;
      if (Number.isSafeInteger(count)) onCount(count as number);
      else onMissingTelemetry?.(); // failed attempt without telemetry
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------
// Production default runtime (real bridge + explicit direct judge)
// ---------------------------------------------------------------------------

/** Provider id → descriptor with a verified bounded-transport
 *  composition. Fails closed (typed) for ids outside the executable
 *  subset, naming it. */
function boundedDescriptorFor(
  providerId: string,
  transport: { fetch: unknown; env: NodeJS.ProcessEnv },
): ProviderDescriptor {
  const factory = BOUNDED_TRANSPORT_FACTORIES[providerId];
  if (factory === undefined) {
    throw new ValidationError(
      `provider "${providerId}" cannot execute the requirements-mode bounded composition: it must serve both search and reader over an injected transport. Executable suppliers: ${[...EXECUTABLE_SUPPLIERS].join(", ")}. Refusing any reroute — pass --provider <one of these> explicitly.`,
    );
  }
  return factory(transport);
}

/** Runtime-context fields the production default needs. Threaded from
 *  the dispatcher through the dispatcher-owned host object; the
 *  optional fields keep direct unit callers working with ambient
 *  defaults. */
interface RuntimeContextHost {
  readonly env?: NodeJS.ProcessEnv;
  /** The invocation's provider secret list (deps.secrets in the
   *  dispatcher) — merged with runtime/judge/producer secrets as the
   *  ONE redaction basis (cold-review findings 2/3). */
  readonly secrets?: readonly string[];
  /** Caller-RESOLVED provider id (main's existing precedence). When
   *  absent (direct unit callers), main's compatibility default "zai"
   *  applies — which then fails the executable-subset preflight
   *  honestly unless the caller pins a supported supplier. */
  readonly provider?: string;
  readonly noCache?: boolean;
  readonly cache?: ResponseCache;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Selection inputs mirroring main's resolver (routing + quota
   *  snapshot + descriptor registry) — when present the effective
   *  provider resolves through resolveEffectiveProvider exactly like
   *  every shared-capability command; `provider` above then acts as
   *  the explicit pin. */
  readonly routing?: Readonly<Record<string, readonly ProviderId[]>>;
  readonly quotaState?: unknown;
  /** Fail-open snapshot read (the dispatcher's quotaStore) used only
   *  when no snapshot was threaded — never refreshes, never transports. */
  readonly readQuotaSnapshot?: () => unknown;
  readonly providerDescriptors?: readonly ProviderDescriptor[];
}

function runtimeContextFrom(host: RuntimeContextHost): RequirementsRuntimeContext {
  const env = host.env ?? {};
  // Cold-review finding 6: reuse the ESTABLISHED shared resolver with
  // the actual normalized inputs — no requirements-only branch. The
  // resolver's own precedence IS the product behavior: explicit pin
  // (normalized + validated by parseProviderId) > SCOUTLINE_PROVIDER
  // > routing walk > quota-ranked first-pick > "zai" compatibility
  // default when the snapshot is absent. The bounded-subset preflight
  // in boundedDescriptorFor then fails closed for suppliers outside
  // the executable five — the parent ruling (no silent Tavily default)
  // is enforced by that preflight, NOT by diverging from the resolver.
  const provider = resolveEffectiveProvider({
    explicitProvider: host.provider,
    env,
    capabilityId: "search",
    descriptors: host.providerDescriptors ?? [],
    // The requirements lane reads the SAME production snapshot main
    // would (fail-open quotaStore.read(); no transport, no policy
    // change) whenever a store exists but the dispatcher did not thread
    // a snapshot — so routing/quota selection behaves exactly as the
    // shared resolver does in production, including its documented
    // undefined-snapshot compatibility branch.
    // Fail-open snapshot (findings 4/6): the production read when
    // available; a state read that throws under a test-context guard
    // degrades to the EMPTY snapshot the store's own fail-open contract
    // produces — never a throw, never a selection block.
    // Snapshot (findings 4/6): exactly what the dispatcher read from the
    // production quotaStore (fail-open, no transport), or undefined
    // when no store exists — preserving the resolver's documented
    // undefined-snapshot compatibility branch rather than inventing a
    // snapshot.
    quotaSnapshot: host.quotaState as never,
    routing: host.routing,
  });
  return {
    env,
    provider,
    noCache: host.noCache ?? false,
    cache: host.noCache === true ? nullCache() : host.cache ?? nullCache(),
    sleep: host.sleep ?? realSleep,
    random: host.random ?? Math.random,
  };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NULL_CACHE: ResponseCache = {
  get: async () => null,
  set: async () => undefined,
};
function nullCache(): ResponseCache {
  return NULL_CACHE;
}

const defaultRequirementsRuntime: RequirementsRuntimeFactory = (context) => {
  const { env, provider } = context;
  const transport = { fetch: globalThis.fetch.bind(globalThis), env };
  const descriptor = boundedDescriptorFor(provider, transport);
  const adapter = descriptor.create({ env });
  if (adapter.search === undefined || adapter.reader === undefined) {
    throw new ValidationError(
      `provider "${provider}" does not serve both search and reader in requirements mode.`,
    );
  }
  const secrets = [env.TYPESAFE_API_KEY].filter((v): v is string => typeof v === "string" && v !== "");

  // Production runtime's budget view (final boundary repair, root 1):
  // there is NO second counter here. The handler's single pre-dispatch
  // closure (context.reserveAttempt) IS the admission authority for
  // every stage; this runtime hands that exact function to the native
  // direct judge, whose lifecycle calls it before every physical
  // request including retries. A missing closure is a preflight error,
  // never a runtime-local budget.
  const reserveRun = context.reserveAttempt;
  if (reserveRun === undefined) {
    throw new ValidationError(
      "requirements production runtime requires the shared pre-dispatch admission closure (context.reserveAttempt).",
      "The admission authority is created by the handler and threaded through the runtime context; a runtime-local budget is not accepted.",
    );
  }
  const MAX_RUN_PHYSICAL_ATTEMPTS = physicalAttemptCeiling(env);
  const judge = selectRequirementsJudge(env, reserveRun);
  return {
    acquisitionOptions: {
      searchDescriptor: descriptor,
      readerDescriptor: descriptor,
      transports: { [provider]: transport },
      descriptorFactory: (id, t) => boundedDescriptorFor(id, t as { fetch: unknown; env: NodeJS.ProcessEnv }),
      env,
      cache: context.cache,
      sleep: context.sleep,
      random: context.random,
      reservePhysicalAttempt: reserveRun,
      maxPhysicalAttempts: MAX_RUN_PHYSICAL_ATTEMPTS,
    },
    // Producer side of the SAME finite admission: a producer that
    // performs physical work reserves here before each dispatch.
    // Production wires no producer today (value extraction rides the
    // injected runtime only), so the seam is absent and the stage is
    // honestly absent rather than falsely "observed zero".
    engineDeps: {
      judge: judge.judge,
      candidateJudge: judge.candidateJudge,
      now: () => Date.now(),
    },
    secrets,
    judgeAdmission: "shared",
  };
};

// ---------------------------------------------------------------------------
// Result projection (whole-envelope redaction; original/display
// evidence identity disclosed separately)
// ---------------------------------------------------------------------------

function projectResult(
  result: LeanResult,
  secrets: readonly string[],
  host: { secrets?: readonly string[] },
  physical: PhysicalTotals,
  provenance: readonly LeanReadProvenance[],
): CommandResult {
  // Cold-review findings 2/3: ONE merged secret set — runtime/explicit
  // judge/producer secrets UNION the invocation's provider secrets —
  // is the single redaction basis for the whole envelope, and the
  // display digests + final resultSha256 are computed over the exact
  // delivered (redacted) form. The dispatcher passes the same merged
  // set to invokeCommand, so the error/save boundaries cannot
  // re-redact a different set over already-hashed bytes.
  const merged = [...new Set([...(host.secrets ?? []), ...secrets])].filter(
    (s) => typeof s === "string" && s !== "",
  );
  // Original normalized digests are computed BEFORE any redaction and
  // disclosed as the locator basis; the DISPLAYED content is the
  // redacted derivative with its own digest (correction finding 2).
  const evidence = result.evidence.map((record) => {
    const contentSha256 = sha256Hex(record.content);
    const redacted = redactSecrets(record.content, merged);
    const displayRedacted = typeof redacted === "string" && redacted !== record.content;
    const display = displayRedacted ? (redacted as string) : record.content;
    return {
      evidenceId: record.evidenceId,
      url: record.url,
      title: record.title,
      content: display,
      byteLength: record.byteLength,
      origins: record.origins,
      contentSha256,
      contentByteLength: Buffer.byteLength(record.content, "utf8"),
      displayContentSha256: sha256Hex(display),
      displayByteLength: Buffer.byteLength(display, "utf8"),
      displayRedacted,
      locatorBasis: "original-normalized-content",
      locatorUnit: "utf16-code-units",
      locatorRange: "half-open",
    };
  });

  const logicalTotals = {
    searches: result.usage.searches,
    readAttempts: result.usage.readAttempts,
    readsRetained: result.usage.readsRetained,
    judgeCalls: result.usage.judgeCalls,
    extractorCalls: result.usage.extractorCalls,
    extractorCacheHits: result.usage.extractorCacheHits,
    candidateJudgeCalls: result.usage.candidateJudgeCalls,
  };
  const baseEnvelope = {
    kind: "requirements-investigation" as const,
    schemaVersion: 1,
    status: result.status,
    assessment: result.assessment,
    question: result.question,
    plan: result.plan,
    data: result.data,
    requirements: result.requirements,
    evidence,
    acquisitionLog: result.acquisitionLog,
    coverageNotes: result.coverageNotes,
    // Stage-scoped admission + measurement disclosure (root 4): what
    // is MEASURED is separated from what is ENFORCED. The judge stage
    // states whether its requests are bounded by the shared pre-dispatch
    // ceiling or whether enforcement is unknown (an opaque injected
    // judge); a judge without attempt telemetry says so rather than
    // implying zero.
    admission: {
      acquisition: "shared",
      ...(physical.judgeAdmission === "not-configured"
        ? {}
        : { judge: physical.judgeAdmission }),
      ...(physical.producerConfigured
        ? { producer: physical.producerObserved ? "shared" : "unknown" }
        : {}),
    },
    ...(physical.judgeAdmission === "unknown"
      ? {
          judgeAdmissionUnknown:
            "an injected judge did not join the shared pre-dispatch admission; its requests are measured but not bounded by the run ceiling",
        }
      : {}),

    usage: {
      ...logicalTotals,
      ...(physical.judgeTelemetryMissing
        ? {
            judgeTelemetryUnknown:
              "a judge ran without reporting physical attempt telemetry; its dispatches are NOT included in physicalHttpAttempts (absent, not zero) — the total covers acquisition and any reporting stages only",
          }
        : {}),
      physicalHttpAttempts: physical.acquisitionAttempts + physical.judgeDispatches + physical.producerDispatches,
      ...(physical.producerConfigured && !physical.producerObserved
        ? { physicalHttpAttemptsUnknown: "producer dispatches unobserved — this total covers acquisition and judge stages only" }
        : {}),
    },
    acquisition: {
      readProvenance: provenance,
      physicalAttempts: physical.perAttempt,
      reservationsRefused: physical.refused,
    },
  };
  // Whole-envelope redaction (correction finding 2): the delivered
  // data — titles, URLs, question, outcomes, metadata — passes the
  // same secret set as the content; the delivered resultSha256 is the
  // hash of THIS redacted envelope.
  const redactedEnvelope = redactSecrets(baseEnvelope, merged);
  const resultSha256 = sha256Hex(JSON.stringify(redactedEnvelope));
  const exitCode = result.status === "complete" ? 0 : 1;
  return {
    kind: "data",
    data: { ...(redactedEnvelope as typeof baseEnvelope), resultSha256 },
    exitCode,
  };
}

export type { LeanResult, LeanFieldRow, LeanAcquisitionEvent };
