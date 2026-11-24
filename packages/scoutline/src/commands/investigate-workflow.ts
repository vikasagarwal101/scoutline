/**
 * `investigate --workflow <file|->` — the v3 consumer public integration
 * (EXPERIMENTAL; unified-investigation).
 *
 * ONE bounded JSON mode over file/stdin carrying one of the five reviewed
 * v3 consumer kinds. The envelope is exact:
 *
 *   { "schemaVersion": 1, "kind": "<kind>", "request": { ... } }
 *
 * kind ∈ comparison | monitor | extraction | audit | resolution — no
 * aliases, no per-kind runtime/formatter forks: every kind reuses the
 * shared runtime composition, bounded file/stdin admission, owned
 * interruption, judge consent, redaction basis and result projection of
 * the existing requirements lane. Mode selection and envelope validation
 * happen BEFORE any runtime construction (invalid input builds nothing);
 * the audit kind never constructs a provider runtime at all (local Git
 * object reads only).
 *
 * Division of labor: this module owns ONLY the public envelope, dispatch
 * and the shared delivery projection (display digests computed against
 * the actual delivered redacted content; resultSha256 over the exact
 * delivered envelope). All domain semantics live in the reviewed lane
 * callables it forwards to.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { devNull } from "node:os";

import type { CommandResult } from "../command-invocation.js";
import { CancellationError, TimeoutError, ValidationError } from "../lib/errors.js";
import { redactSecrets } from "../lib/redact.js";
import { validateCallerPhysical, type CallerPhysicalSnapshot } from "../lib/caller-physical.js";
import {
  MAX_REQUIREMENTS_BYTES,
  composeLeanRuntime,
  countingSeam,
  beginOwnedInterruption,
  raceWithInterrupt,
  type OwnedInterruption,
  physicalAttemptCeiling,
  selectRequirementsJudge,
  withRequirementsRuntime,
  type ComposedLeanRuntime,
  type InvestigateRequirementsDeps,
} from "./investigate-requirements.js";
import { runEvidenceComparison } from "./investigate-comparison.js";
import {
  prepareFactMonitorTick,
  runPreparedFactMonitorTick,
  FactMonitorCancelledError,
} from "../lib/fact-monitor.js";
import { admitManifestInput, investigateReleaseManifest } from "../lib/manifest-investigate.js";
import { resolveDocumentProducer } from "../lib/document-manifest.js";
import {
  compileAuditClaimSet,
  runImplementationAudit,
  AUDIT_CEILINGS,
  type CompiledAuditClaimSet,
  type PinnedSnapshot,
} from "../lib/implementation-audit.js";
import { resolveConflict } from "../lib/resolve-conflict.js";

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export const WORKFLOW_KINDS = ["comparison", "monitor", "extraction", "audit", "resolution"] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export const INVESTIGATE_WORKFLOW_HELP = `
Investigate Workflow Mode - v3 consumer integration (EXPERIMENTAL)

Usage: scoutline investigate --workflow <file|-> [options]

Runs ONE reviewed v3 consumer workflow from a bounded JSON document
(file or stdin, <= 1 MiB). The envelope is exact — no aliases, no
positional question, and the mode is mutually exclusive with plain
investigate, --requirements/--requirements-json and the caller modes:

  { "schemaVersion": 1, "kind": "<kind>", "request": { ... } }

Kinds (each maps to one reviewed engine-backed consumer):

  comparison   Evidence-backed comparison matrix across declared
               entities and dimensions.
               request: { schemaVersion, question, entities, dimensions,
               frame, limits? } (the comparison contract; wrong-size
               matrices and unsafe keys reject before any dispatch)
  monitor      ONE explicit monitoring tick for one fact against its
               last accepted baseline.
               request: { monitorId, stateRoot, definition } — the
               stateRoot is the caller-owned monitor store root; the
               definition is the engine contract for the fact.
  extraction   Structured extraction over ONE caller-retained public or
               synthetic release-manifest text (closed document set; the
               claimed URL is attribution, never verified origin).
               request: { manifestText, admission: { materialClass,
               claimedUrl, title } } — judgment routes ONLY through the
               authorized runtime judge (consent-gated); a request may
               never carry its own judge.
  audit        Literal implementation claims against ONE pinned revision
               of an EXISTING local repository (bounded local Git object
               reads; no fetch, no hooks, no shell).
               request: { repository, revision, localRepositoryPath,
               claims: [{ id, text, proofClass, criteria?, checks: [{ path,
               allOf: [...] }] }] }
  resolution   Conflicting-evidence resolution under the caller's
               declared scope and alternatives.
               request: { schemaVersion, scope, alternatives, limits? }

Output: one JSON document per kind (kind-tagged, schemaVersion 1).
resultSha256 hashes the UTF-8 bytes of JSON.stringify of the delivered
redacted object with its own resultSha256 field omitted. Comparison's
engine object has its own digest by the same rule. Evidence display
digests are computed against the delivered content.

Exit codes: 0 complete; 1 partial (honest — absent judges, refused or
incomplete coverage never fake success); 2 monitor late-commit rejection;
130 interrupted (SIGINT).

Completed workflows that dispatched provider acquisition can trigger the
normal due quota refresh, outside the workflow attempt ledger.

Examples:
  scoutline investigate --workflow workflow.json
  cat workflow.json | scoutline investigate --workflow -
`.trim();

// ---------------------------------------------------------------------------
// Envelope validation (strict — unknown keys reject, never drop)
// ---------------------------------------------------------------------------

interface WorkflowEnvelope {
  readonly kind: WorkflowKind;
  readonly request: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateWorkflowEnvelope(parsed: unknown): WorkflowEnvelope {
  if (!isPlainObject(parsed)) {
    throw new ValidationError("workflow document must be a JSON object.");
  }
  const keys = Object.keys(parsed);
  for (const expected of ["schemaVersion", "kind", "request"]) {
    if (!keys.includes(expected)) {
      throw new ValidationError(`workflow document is missing "${expected}".`);
    }
  }
  const extras = keys.filter((key) => key !== "schemaVersion" && key !== "kind" && key !== "request");
  if (extras.length > 0) {
    throw new ValidationError(
      `workflow document carries unsupported keys (${extras.join(", ")}); the envelope is exactly {schemaVersion, kind, request}.`,
    );
  }
  if (parsed.schemaVersion !== 1) {
    throw new ValidationError(
      "workflow schemaVersion must be the number 1.",
    );
  }
  const kind = parsed.kind;
  if (typeof kind !== "string" || !(WORKFLOW_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(
      `workflow kind must be one of ${WORKFLOW_KINDS.join(", ")} (got ${JSON.stringify(kind)}).`,
    );
  }
  if (!isPlainObject(parsed.request)) {
    throw new ValidationError("workflow request must be a JSON object.");
  }
  return { kind: kind as WorkflowKind, request: parsed.request };
}

// ---------------------------------------------------------------------------
// Delivery projection (one captured basis; display facts bind delivered
// bytes; resultSha256 over the exact delivered envelope)
// ---------------------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redactWithBasis(value: string, basis: readonly string[]): string {
  return redactSecrets(value, [...basis]) as string;
}

/** Evidence display rows with digests computed against the FINAL redacted
 *  content — the projector correction: redaction never acts twice on
 *  already-hashed evidence. */
export function deliverEvidenceRows(
  records: readonly { evidenceId: string; url: string; title: string; content: string; byteLength?: number; origins?: readonly string[] }[],
  basis: readonly string[],
): { evidenceId: string; url: string; title: string; content: string; byteLength: number; origins: readonly string[]; contentSha256: string; contentByteLength: number; displayContentSha256: string; displayByteLength: number; displayRedacted: boolean }[] {
  return records.map((record) => {
    const display = redactWithBasis(record.content, basis);
    const content = typeof display === "string" ? display : record.content;
    return {
      evidenceId: record.evidenceId,
      url: record.url,
      title: record.title,
      content,
      byteLength: record.byteLength ?? Buffer.byteLength(record.content, "utf8"),
      origins: record.origins ?? [],
      contentSha256: sha256Hex(record.content),
      contentByteLength: Buffer.byteLength(record.content, "utf8"),
      displayContentSha256: sha256Hex(content),
      displayByteLength: Buffer.byteLength(content, "utf8"),
      displayRedacted: content !== record.content,
    };
  });
}

/** Rebind requirements and workflow hashes to the final redacted JSON data.
 *  Comparison contains a second, independently bound engine envelope. */
export function finalizeWorkflowData(data: unknown): unknown {
  if (!isPlainObject(data)) throw new ValidationError("Invalid workflow result.");
  const { resultSha256: _priorHash, ...body } = data;
  if (Array.isArray(body.evidence)) {
    body.evidence = body.evidence.map((row) => {
      if (!isPlainObject(row) || typeof row.content !== "string" || typeof row.contentSha256 !== "string") {
        throw new ValidationError("Invalid workflow evidence projection.");
      }
      const displayContentSha256 = sha256Hex(row.content);
      return {
        ...row,
        displayContentSha256,
        displayByteLength: Buffer.byteLength(row.content, "utf8"),
        displayRedacted: row.displayRedacted === true || displayContentSha256 !== row.contentSha256,
      };
    });
  }
  if (body.kind === "evidence-comparison") body.engine = finalizeWorkflowData(body.engine);
  return { ...body, resultSha256: sha256Hex(JSON.stringify(body)) };
}

/** Final delivery: whole-envelope redaction over the ONE captured basis,
 *  then the binding hash over the exact delivered object (the reviewed
 *  comparison-lane pattern). */
export function projectWorkflowResult(
  discriminator: string,
  payload: Record<string, unknown>,
  basis: readonly string[],
  exitCode: number,
): CommandResult {
  const envelope = { kind: discriminator, schemaVersion: 1, ...payload };
  return {
    kind: "data",
    data: finalizeWorkflowData(redactSecrets(envelope, [...basis])),
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Audit: trusted local Git object reads (no shell, no fetch, no hooks)
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const LOCAL_GIT_READ_TIMEOUT_MS = 10_000;

async function readLocalGitSnapshot(
  localRepositoryPath: string,
  claims: CompiledAuditClaimSet,
  signal: AbortSignal,
): Promise<{ snapshot: PinnedSnapshot; unreadAtDeadline: readonly string[] }> {
  const { repository, revision } = claims;
  const paths = [...new Set(claims.claims.flatMap((claim) => claim.checks.map((check) => check.path)))];
  if (paths.length > AUDIT_CEILINGS.maxRelevantPaths) {
    throw new ValidationError("Audit check paths exceed the read budget.");
  }

  // A minimal child environment: inherited repo redirects, alternates,
  // replacements and Git config overrides must not change the pinned object.
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(LOCAL_GIT_READ_TIMEOUT_MS)]);
  const preflightTimeout = () => new TimeoutError(
    LOCAL_GIT_READ_TIMEOUT_MS,
    "Local Git audit timed out during repository or commit verification.",
  );
  let root: string;
  try {
    root = await realpath(localRepositoryPath);
    const location = await execFileP(
      "git", ["-C", root, "rev-parse", "--show-toplevel"],
      { env, signal: deadline, maxBuffer: 8192 },
    );
    if (await realpath(location.stdout.replace(/\r?\n$/, "")) !== root) {
      throw new Error("repository discovery changed the directory");
    }
  } catch {
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted) throw preflightTimeout();
    throw new ValidationError("Audit requires the exact root of an existing local Git worktree.");
  }
  const git = ["-C", root, "--literal-pathspecs"];
  try {
    const out = await execFileP("git", [...git, "rev-parse", "--verify", revision + "^{commit}"], {
      env, signal: deadline, maxBuffer: 1024,
    });
    if (out.stdout.trim() !== revision) throw new Error("not the exact commit");
  } catch {
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted) throw preflightTimeout();
    throw new ValidationError("Audit revision is not present as a commit in the local repository.");
  }

  const files: PinnedSnapshot["files"][number][] = [];
  let unreadAtDeadline: readonly string[] = [];
  for (const [index, path] of paths.entries()) {
    try {
      const { stdout } = await execFileP("git", [...git, "ls-tree", "-z", revision, "--", path], {
        env, signal: deadline, maxBuffer: 4096,
      });
      const row = /^(100644|100755) blob ((?:[0-9a-f]{40}|[0-9a-f]{64}))\t([^\0]+)\0$/.exec(stdout);
      if (row === null || row[3] !== path) continue;
      const { stdout: bytes } = await execFileP("git", [...git, "cat-file", "blob", row[2]!], {
        env, signal: deadline, maxBuffer: AUDIT_CEILINGS.maxFileBytes + 1, encoding: "buffer",
      });
      if (bytes.length > AUDIT_CEILINGS.maxFileBytes) continue;
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      files.push({ path, revision, content, sha256: createHash("sha256").update(bytes).digest("hex") });
    } catch {
      if (signal.aborted) throw signal.reason;
      if (deadline.aborted) {
        unreadAtDeadline = paths.slice(index);
        break;
      }
      // The claim's exact path remains in the engine declaration. Missing,
      // unreadable or non-text blobs cannot be used as absence proof.
    }
  }
  return { snapshot: { repository, revision, files }, unreadAtDeadline };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function requireWorkflowKeys(input: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key))) {
    throw new ValidationError("Workflow request contains unsupported properties.");
  }
}

function assertWorkflowId(id: string, basis: readonly string[]): void {
  if (redactSecrets(id, [...basis]) !== id ||
      (redactSecrets({ [id]: 1 }, [...basis]) as Record<string, unknown>)[id] !== 1) {
    throw new ValidationError("Workflow identifier cannot be represented safely in redacted output.");
  }
}

function workflowMeasurement(
  composed: ComposedLeanRuntime,
  evidence: readonly { url: string; evidenceId: string }[] = [],
) {
  composed.finalCheck();
  const idsByUrl = new Map(evidence.map((record) => [record.url, record.evidenceId]));
  return {
    physical: composed.observation(),
    readProvenance: composed.readProvenance().map((row) => ({
      ...row,
      evidenceId: idsByUrl.get(row.url) ?? null,
    })),
  };
}

export type WorkflowHost = Parameters<typeof withRequirementsRuntime>[2];

/**
 * Typed interruption settlement for the EXTRACTION branch's post-kind,
 * pre-dispatch checkpoints and its manifest catch. Unlike the legacy
 * `owned.settle()` (a ValidationError with exit 130 — the pre-kind and
 * other-kind branches keep it, unchanged), this throws the shared
 * `CancellationError` so a user interrupt serializes as USER_CANCELLED
 * with exit 130 and NO HTTP status, and never replaces a typed
 * cancellation already thrown by the manifest seam. `owned.release()`
 * in the handler's outer finally still unsubscribes the interrupt on
 * every path.
 */
function settleExtractionInterrupt(owned: OwnedInterruption): void {
  if (!owned.interrupted()) return;
  throw new CancellationError(
    "investigate workflow extraction interrupted by user (SIGINT): in-flight work was cancelled; remote completion state is unknown.",
  );
}

export async function handleInvestigateWorkflow(
  args: { readonly source: { kind: "file"; path: string } | { kind: "stdin" } },
  deps: InvestigateRequirementsDeps,
  host: WorkflowHost,
  options: { readonly basis: readonly string[]; readonly onLocalAudit?: () => void } = { basis: [] },
): Promise<CommandResult> {
  // Owned interruption from the first line: the pending input read,
  // envelope validation, runtime composition and delivery all sit inside
  // the signal window; an interrupt settles 130.
  const owned = beginOwnedInterruption(deps);
  try {
    owned.settle();
    const text = await raceWithInterrupt(
      args.source.kind === "stdin"
        ? deps.readStdin(owned.controller.signal)
        : deps.readFile(args.source.path),
      owned,
    );
    owned.settle();
    if (Buffer.byteLength(text, "utf8") > MAX_REQUIREMENTS_BYTES) {
      throw new ValidationError(`workflow document exceeds the ${MAX_REQUIREMENTS_BYTES}-byte input ceiling.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ValidationError("Workflow JSON is invalid.");
    }
    // 2. Envelope validation BEFORE any runtime construction.
    const { kind, request } = validateWorkflowEnvelope(parsed);
    const basis = options.basis;

    // 3. Per-kind dispatch — each lane owns its own domain validation.
    if (kind === "comparison") {
      return await runEvidenceComparison(request, deps, host, owned.controller.signal);
    }

    if (kind === "monitor") {
      requireWorkflowKeys(request, ["monitorId", "stateRoot", "definition"]);
      const { monitorId, stateRoot, definition } = request;
      if (typeof monitorId !== "string" || monitorId.length === 0 || monitorId.length > 128) {
        throw new ValidationError("monitor request monitorId must be a non-empty string (<= 128 chars).");
      }
      if (typeof stateRoot !== "string" || stateRoot.length === 0) {
        throw new ValidationError(
          "monitor request stateRoot is required (the caller-owned monitor store root; no implicit real-user store is created).",
        );
      }
      if (!isPlainObject(definition)) {
        throw new ValidationError("monitor request definition must be a JSON object (the engine contract for the fact).");
      }
      const tickOptions = { now: new Date(deps.now()), signal: owned.controller.signal };
      let composed: ComposedLeanRuntime | undefined;
      try {
        const prepared = await prepareFactMonitorTick(stateRoot, monitorId, definition, tickOptions);
        for (const field of prepared.compiled.fields) assertWorkflowId(field.id, basis);
        owned.settle();
        const runtime = composed = await composeLeanRuntime(deps, host, owned);
        owned.settle();
        for (const field of prepared.compiled.fields) assertWorkflowId(field.id, basis);
        let measurement: ReturnType<typeof workflowMeasurement> | undefined;
        let evidence: ReturnType<typeof deliverEvidenceRows> = [];
        const report = await runPreparedFactMonitorTick(stateRoot, prepared, runtime.unified, tickOptions, (outcome) => {
          const records = outcome.kind === "result" ? outcome.result.evidence : [];
          for (const record of records) assertWorkflowId(record.evidenceId, basis);
          measurement = workflowMeasurement(runtime, records);
          evidence = deliverEvidenceRows(records, basis);
        });
        return projectWorkflowResult(
          "fact-monitor-tick", { report, evidence, measurement }, basis,
          report.rejection === "late_commit" ? 2 : report.engine.status === "complete" ? 0 : 1,
        );
      } catch (error) {
        if (error instanceof FactMonitorCancelledError) {
          return projectWorkflowResult("fact-monitor-tick", { monitorId, cancelled: true }, basis, 130);
        }
        throw composed?.rethrowMeasurement(error) ?? error;
      }
    }

    if (kind === "extraction") {
      for (const forbidden of ["judgeTransmission", "authorizedRuntimeJudge"]) {
        if (request[forbidden] !== undefined) {
          throw new ValidationError(
            `extraction request may not carry "${forbidden}": judgment routes only through the authorized runtime judge (consent-gated), never a caller-supplied transmission.`,
          );
        }
      }
      requireWorkflowKeys(request, ["manifestText", "admission", "producerId"]);
      const { manifestText, admission, producerId } = request;
      if (typeof manifestText !== "string") {
        throw new ValidationError("extraction request manifestText must be the exact retained manifest text.");
      }
      if (!isPlainObject(admission)) {
        throw new ValidationError(
          "extraction request admission is required: { materialClass: public|synthetic, claimedUrl, title }.",
        );
      }
      requireWorkflowKeys(admission, ["materialClass", "claimedUrl", "title"]);
      if (producerId !== undefined && typeof producerId !== "string") {
        throw new ValidationError("Extraction producerId must name an admitted producer.");
      }
      const input = {
        manifestText,
        admission: admission as unknown as Parameters<typeof investigateReleaseManifest>[0]["admission"],
        ...(typeof producerId === "string" ? { producerId } : {}),
        now: deps.now,
        externalSignal: owned.controller.signal,
      };
      admitManifestInput(input);
      if (producerId !== undefined) resolveDocumentProducer(producerId);
      settleExtractionInterrupt(owned);

      let authorizedJudge: NonNullable<Parameters<typeof investigateReleaseManifest>[1]>["authorizedRuntimeJudge"];
      let composed: ComposedLeanRuntime | undefined;
      let judgeReservations = 0;
      let reservationsRefused = 0;
      let judgeAttempts = 0;
      let judgeTelemetryMissing = false;
      let measurementError: ValidationError | undefined;
      const failMeasurement = (): never => {
        measurementError ??= new ValidationError("Invalid physical-attempt measurement for extraction.");
        throw measurementError;
      };
      if (deps.requirementsRuntime !== undefined) {
        // Scoped typed settlement at the composition boundary. The
        // ORIGINAL owned settles legacy (plain/other kinds keep it);
        // extraction composes with a derived view whose settle() is the
        // typed cancellation, so an interrupt during the AWAITED
        // quota-snapshot read inside composeLeanRuntime — raced via
        // raceWithInterrupt, whose abort path calls owned.settle() —
        // serializes as USER_CANCELLED, not VALIDATION_ERROR/400.
        // controller/interrupted/release are the original lifecycle
        // functions; the handler's outer finally still calls the one
        // idempotent owned.release().
        const extractionOwned: OwnedInterruption = {
          controller: owned.controller,
          interrupted: owned.interrupted,
          release: owned.release,
          settle: () => settleExtractionInterrupt(owned),
        };
        composed = await composeLeanRuntime(deps, host, extractionOwned);
        authorizedJudge = composed.unified.candidateJudge ?? undefined;
      } else {
        const ceiling = physicalAttemptCeiling(host.env);
        const selection = selectRequirementsJudge(host.env ?? {}, () => {
          if (judgeReservations >= ceiling) {
            reservationsRefused += 1;
            throw new ValidationError("Extraction exhausted its physical judge dispatch budget.");
          }
          judgeReservations += 1;
        }, host.judgeSettings);
        authorizedJudge = countingSeam(
          selection.candidateJudge,
          (count) => {
            if (judgeAttempts + count > 100_000) failMeasurement();
            judgeAttempts += count;
          },
          () => { judgeTelemetryMissing = true; },
          failMeasurement,
        ) as typeof authorizedJudge;
      }
      settleExtractionInterrupt(owned);
      let outcome: Awaited<ReturnType<typeof investigateReleaseManifest>>;
      try {
        outcome = await investigateReleaseManifest(input, authorizedJudge === undefined ? {} : { authorizedRuntimeJudge: authorizedJudge });
      } catch (error) {
        // Measurement faults stay visible even under a simultaneous
        // interrupt: malformed telemetry must never be masked by the
        // cancellation settlement (and vice versa: a typed cancellation
        // from the manifest seam is preserved, never replaced by the
        // legacy settle's ValidationError/400). A measurement fault is
        // recognized by its fatalMeasurement marker — the engine may
        // throw the composed fault ITSELF, in which case
        // rethrowMeasurement returns that same error (identity alone
        // would miss it).
        const isFatalMeasurement = (candidate: unknown): boolean =>
          candidate !== null && typeof candidate === "object" &&
          (candidate as { fatalMeasurement?: unknown }).fatalMeasurement === true;
        if (isFatalMeasurement(error)) throw error;
        if (measurementError !== undefined) throw measurementError;
        const rethrown = composed !== undefined ? composed.rethrowMeasurement(error) : undefined;
        if (rethrown !== undefined && rethrown !== error && isFatalMeasurement(rethrown)) throw rethrown;
        if (error instanceof CancellationError) throw error;
        if (owned.interrupted()) {
          throw new CancellationError(
            "investigate workflow extraction interrupted by user (SIGINT): in-flight work was cancelled; remote completion state is unknown.",
          );
        }
        throw error;
      }
      if (measurementError !== undefined) throw measurementError;
      assertWorkflowId(outcome.record.evidenceId, basis);
      let measurement: ReturnType<typeof workflowMeasurement>;
      if (composed === undefined) {
        const judge = judgeTelemetryMissing ? null : judgeAttempts;
        const physical: CallerPhysicalSnapshot = {
          schemaVersion: 1, source: "handler-owned-native-ledger", cutoff: "locally-settled",
          stages: { acquisition: 0, judge, producer: 0 },
          knownSubtotal: judge ?? 0, total: judge, reservationsRefused,
          admission: { acquisition: "shared", judge: authorizedJudge === undefined ? "not-configured" : "shared", producer: "not-configured" },
          attempts: [],
        };
        validateCallerPhysical(physical);
        measurement = { physical, readProvenance: [] };
      } else {
        measurement = workflowMeasurement(composed, [outcome.record]);
      }
      const interrupted = owned.interrupted() || outcome.cancelled;
      return projectWorkflowResult(
        "manifest-extraction",
        {
          materialClass: outcome.materialClass,
          claimedUrl: outcome.claimedUrl,
          claimedUrlVerification: outcome.claimedUrlVerification,
          ...(interrupted ? { cancelled: true, stopReason: "cancelled" } : {}),
          result: outcome.result,
          parse: outcome.parse,
          evidence: deliverEvidenceRows([outcome.record], basis),
          measurement,
        },
        basis,
        interrupted ? 130 : outcome.result.status === "complete" ? 0 : 1,
      );
    }

    if (kind === "audit") {
      requireWorkflowKeys(request, ["repository", "revision", "localRepositoryPath", "claims"]);
      const { repository, revision, localRepositoryPath } = request;
      if (typeof repository !== "string" || repository.length === 0) {
        throw new ValidationError("audit request repository must be a non-empty string.");
      }
      if (typeof revision !== "string") {
        throw new ValidationError("audit request revision must be the pinned full commit sha.");
      }
      if (typeof localRepositoryPath !== "string" || localRepositoryPath.length === 0) {
        throw new ValidationError(
          "audit request localRepositoryPath is required: the EXISTING local repository working tree to read pinned objects from (no fetch, no reconfiguration).",
        );
      }
      if (Array.isArray(request.claims)) {
        for (const claim of request.claims) {
          if (!isPlainObject(claim)) continue;
          requireWorkflowKeys(claim, ["id", "text", "proofClass", "criteria", "checks"]);
          if (Array.isArray(claim.checks)) for (const check of claim.checks) {
            if (isPlainObject(check)) requireWorkflowKeys(check, ["path", "allOf"]);
          }
        }
      }
      const claimSet = compileAuditClaimSet({ schemaVersion: 1, repository, revision, claims: request.claims });
      for (const claim of claimSet.claims) assertWorkflowId(claim.id, basis);
      const { snapshot, unreadAtDeadline } = await raceWithInterrupt(
        readLocalGitSnapshot(localRepositoryPath, claimSet, owned.controller.signal), owned,
      );
      owned.settle();
      const audited = await runImplementationAudit(claimSet, snapshot, {
        allowEmptySnapshot: true,
        signal: owned.controller.signal,
      });
      const interrupted = owned.interrupted();
      const coverageNotes = [
        ...audited.coverageNotes,
        "Retained text was read from regular blobs in the exact pinned local Git commit. This does not verify remote origin.",
      ];
      if (unreadAtDeadline.length > 0) {
        coverageNotes.push(
          `Local Git audit reached its read deadline. Unchecked paths: ${JSON.stringify(unreadAtDeadline)}.`,
        );
      }
      const report = { ...audited, coverageNotes };
      options.onLocalAudit?.();
      return projectWorkflowResult(
        "implementation-audit",
        { report, ...(interrupted ? { cancelled: true, stopReason: "cancelled" } : {}) },
        basis,
        interrupted ? 130 : report.status === "complete" ? 0 : 1,
      );
    }

    requireWorkflowKeys(request, ["schemaVersion", "scope", "alternatives", "limits"]);
    if (isPlainObject(request.scope)) requireWorkflowKeys(request.scope, ["entity", "release"]);
    const alternativeIds: string[] = [];
    if (Array.isArray(request.alternatives)) {
      for (const alternative of request.alternatives) {
        if (!isPlainObject(alternative)) continue;
        requireWorkflowKeys(alternative, ["id", "value", "source", "scope", "correctionOf", "mirrors"]);
        if (typeof alternative.id === "string") {
          assertWorkflowId(alternative.id, basis);
          alternativeIds.push(alternative.id);
        }
        if (isPlainObject(alternative.source)) requireWorkflowKeys(alternative.source, ["url", "title"]);
        if (isPlainObject(alternative.scope)) requireWorkflowKeys(alternative.scope, ["entity", "release"]);
        if (Array.isArray(alternative.mirrors)) {
          for (const mirror of alternative.mirrors) {
            if (isPlainObject(mirror)) requireWorkflowKeys(mirror, ["url", "title"]);
          }
        }
      }
    }
    let composed: ComposedLeanRuntime | undefined;
    let outcome: Awaited<ReturnType<typeof resolveConflict>>;
    try {
      outcome = await resolveConflict(request, async () => {
        composed = await composeLeanRuntime(deps, host, owned);
        owned.settle();
        for (const id of alternativeIds) assertWorkflowId(id, basis);
        return composed.unified;
      });
    } catch (error) {
      throw composed?.rethrowMeasurement(error) ?? error;
    }
    if (composed === undefined) throw new ValidationError("Resolution runtime was not composed.");
    for (const record of outcome.engineResult.evidence) assertWorkflowId(record.evidenceId, basis);
    const measurement = workflowMeasurement(composed, outcome.engineResult.evidence);
    const evidence = deliverEvidenceRows(outcome.engineResult.evidence, basis);
    return projectWorkflowResult(
      "conflict-resolution",
      { resolution: outcome.resolution, ...(outcome.cancelled ? { cancelled: true } : {}), evidence, measurement },
      basis,
      outcome.cancelled ? 130 : outcome.resolution?.status === "resolved" ? 0 : 1,
    );
  } finally {
    owned.release();
  }
}
