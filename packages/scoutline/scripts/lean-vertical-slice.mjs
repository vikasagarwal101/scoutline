#!/usr/bin/env node
/**
 * Requirements-driven Investigation — development-only vertical slice
 * (unified-investigation delivery ticket; NOT a shipped CLI surface).
 *
 * Full path with the REAL library composition:
 *   requirements file/stdin/inline JSON
 *     → strict preflight (one compiler; unknown keys/depth/unsupported
 *       declarations rejected BEFORE any acquisition)
 *     → runLeanInvestigation with acquisition deps from
 *       createLeanAcquisitionDeps (real Provider descriptors + shared
 *       executeSearch/executeReaderOperation + per-operation bounded
 *       native transport wrapper)
 *     → LeanResult JSON (redacted) + acquisition provenance + physical
 *       lifecycle ledger on stdout; exit 0 complete / 1 partial / 2
 *       input/config error.
 *
 * CONSENT MODEL (cold-correction property 1 — fail-closed):
 *   - Importing this module performs no work and no I/O.
 *   - Ordinary invocation — including SLICE_DEV_MAIN=0 or unset — NEVER
 *     makes HTTP merely because ambient credentials exist. Live
 *     acquisition requires BOTH the explicit opt-in flag `--live` AND
 *     an explicit validated runtime acquisition profile
 *     (SLICE_LIVE_SEARCH_PROVIDER + that provider's credential env,
 *     declared through SLICE_LIVE_PROFILE=1). Without them the run
 *     fails closed BEFORE runtime creation: no network, no fabricated
 *     result.
 *   - The judge is independently consented: JEV_DEV_* must be complete
 *     or entirely absent. A PARTIAL judge profile (e.g. endpoint
 *     without model/key) fails closed before acquisition — never a
 *     silent deterministic-only downgrade. Consent to Search/Reader
 *     does not imply transmitting evidence to a judge.
 *   - Test/embedded callers bypass consent ONLY through the injected
 *     runtime (they construct acquisitionOptions themselves — the
 *     facade composes what it is handed; no ambient fallback exists in
 *     the facade path).
 *
 * INPUT BOUNDS (cold-correction property 4): stdin is read
 * INCREMENTALLY from a pipe (maxBytes+1 detection, no fstat size
 * trust); files likewise (read up to maxBytes+1, excess rejected).
 * Byte/depth/known-key/subset checks precede acquisition for all
 * three input modes. This preflight is LOCAL to the development
 * entrypoint — the shared compiler stays untouched (shared-symbol
 * risk); the strict supported-subset rejection lives here.
 *
 * Credential rule: values are never printed or persisted; only ENV
 * NAMES appear in messages. Local router is development-only and
 * never a tracked default.
 *
 * Run (offline/hermetic only by default — live requires explicit opt-in):
 *   node scripts/lean-vertical-slice.mjs --requirements req.json
 *   node scripts/lean-vertical-slice.mjs --requirements - < req.json
 *   node scripts/lean-vertical-slice.mjs --requirements-json '<json>'
 * Live (explicit): add --live AND SLICE_LIVE_PROFILE=1 plus the
 * provider credential env; both are required together.
 */
import { open, read, close } from "node:fs";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { compileLeanContract, runLeanInvestigation } from "../dist/lib/lean-investigation.js";
import { createLeanJevJudge } from "../dist/lib/lean-jev-adapter.js";
import { resolveTypesafeJudgeProfile } from "../dist/lib/lean-typesafe-judge.js";
import { createLeanAcquisitionDeps } from "../dist/lib/lean-acquisition-bridge.js";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { defaultResponseCache } from "../dist/lib/cache.js";
import { redactSecrets } from "../dist/lib/redact.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import { ValidationError } from "../dist/lib/errors.js";

// ---------------------------------------------------------------------------
// Shared requirements loader (file | stdin | inline — mutually exclusive)
// ---------------------------------------------------------------------------

export const MAX_REQUIREMENTS_BYTES = 1024 * 1024; // 1 MiB input ceiling
const MAX_INPUT_DEPTH = 16;

/** Parse argv into {source, live} or throw with the exact usage error. */
export function parseVerticalSliceArgv(argv) {
  const live = argv.includes("--live");
  const rest = argv.filter((a) => a !== "--live");
  const hasFile = rest.includes("--requirements");
  const hasInline = rest.includes("--requirements-json");
  if (hasFile && hasInline) {
    throw new Error("--requirements and --requirements-json are mutually exclusive.");
  }
  if (!hasFile && !hasInline) {
    throw new Error("Provide --requirements <file|-> or --requirements-json '<json>'.");
  }
  if (hasFile) {
    const i = rest.indexOf("--requirements");
    const target = rest[i + 1];
    if (target === undefined || target === "") {
      throw new Error("--requirements requires a file path or '-' for stdin.");
    }
    const extra = rest.filter((_a, idx) => idx !== i && idx !== i + 1);
    if (extra.length > 0) throw new Error(`Unexpected arguments: ${extra.join(" ")}`);
    return { source: { kind: "file", target }, live };
  }
  const i = rest.indexOf("--requirements-json");
  const inline = rest[i + 1];
  if (inline === undefined) {
    throw new Error("--requirements-json requires a JSON string argument.");
  }
  const extra = rest.filter((_a, idx) => idx !== i && idx !== i + 1);
  if (extra.length > 0) throw new Error(`Unexpected arguments: ${extra.join(" ")}`);
  return { source: { kind: "inline", value: inline }, live };
}

/** Structural depth/known-key preflight (development entrypoint local).
 *  Rejects unknown top-level/requirement/evidence/policy declarations —
 *  accept-and-drop is forbidden. Mirrors the compiler's supported
 *  subset and adds the envelope-level policy keys the compiler cannot
 *  see. */
function preflightShape(value, what, depth = 0) {
  if (depth > MAX_INPUT_DEPTH)
    throw new ValidationError(`${what}: nesting exceeds the ${MAX_INPUT_DEPTH}-depth ceiling.`);
  if (Array.isArray(value)) {
    for (const item of value) preflightShape(item, what, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    const known = what === "requirements" ? REQUIREMENT_KEYS.has(key) : TOP_LEVEL_KEYS.has(key);
    if (!known) {
      throw new ValidationError(
        `requirements declare unsupported key "${key}" — this development slice supports a strict subset; unknown declarations are rejected, not dropped.`,
      );
    }
    preflightShape(value[key], what, depth + 1);
  }
}

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "question",
  "scope",
  "requirements",
  "evidence",
  "limits",
]);
const REQUIREMENT_KEYS = new Set(["question", "schema", "criteria", "required", "dependsOn"]);
const SCHEMA_KEYS = new Set(["enum", "type", "pattern", "minLength", "maxLength"]);
const EVIDENCE_KEYS = new Set(["criteria"]);
const LIMIT_KEYS = new Set([
  "readBatchSize",
  "maxUniqueReads",
  "maxSearchAttempts",
  "maxJudgeAttempts",
  "deadlineMs",
]);

/** Preflight the parsed contract: envelope keys, requirement keys,
 *  evidence keys — everything unknown rejects before acquisition. */
export function preflightRequirements(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("requirements must be a JSON object.");
  }
  if (input.limits !== undefined) {
    if (input.limits === null || typeof input.limits !== "object" || Array.isArray(input.limits)) {
      throw new ValidationError("limits must be an object.");
    }
    for (const key of Object.keys(input.limits)) {
      if (!LIMIT_KEYS.has(key)) {
        throw new ValidationError(`limits declare unsupported key "${key}".`);
      }
    }
  }
  if (input.scope !== undefined) {
    if (input.scope === null || typeof input.scope !== "object" || Array.isArray(input.scope)) {
      throw new ValidationError("scope must be an object of string tokens.");
    }
    for (const value of Object.values(input.scope)) {
      if (typeof value !== "string") throw new ValidationError("scope values must be strings.");
    }
  }
  const shallow = { ...input, requirements: null, evidence: null, limits: null, scope: null };
  preflightShape(shallow, "envelope");
  if (input.evidence !== undefined) {
    if (
      input.evidence === null ||
      typeof input.evidence !== "object" ||
      Array.isArray(input.evidence)
    ) {
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
    if (
      input.requirements === null ||
      typeof input.requirements !== "object" ||
      Array.isArray(input.requirements)
    ) {
      throw new ValidationError("requirements must be an object keyed by field id.");
    }
    // The requirements map's keys ARE caller-chosen field ids (any
    // non-empty string the compiler validates); each FIELD's inner
    // shape is key-checked here.
    for (const field of Object.values(input.requirements)) {
      if (
        field !== null &&
        typeof field === "object" &&
        !Array.isArray(field) &&
        field.schema !== undefined
      ) {
        if (
          field.schema === null ||
          typeof field.schema !== "object" ||
          Array.isArray(field.schema)
        ) {
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
// Facade
// ---------------------------------------------------------------------------

/**
 * @param {readonly string[]} argv
 * @param {{
 *   acquisitionOptions: import("../dist/lib/lean-acquisition-bridge.js").LeanAcquisitionBridgeOptions,
 *   engineDeps: {
 *     judge?: ((input: unknown, options?: unknown) => Promise<unknown>) | null,
 *     extract?: ((request: unknown, options?: unknown) => Promise<unknown>) | null,
 *     candidateJudge?: ((input: unknown, options?: unknown) => Promise<unknown>) | null,
 *     extractorRevision?: string,
 *     now: () => number,
 *   },
 *   invocation: {
 *     readStdin(maxBytes: number): Promise<string>,
 *     readFile(path: string, maxBytes: number): Promise<string>,
 *     writeOut(text: string): void,
 *     writeErr(text: string): void,
 *     setExit(code: number): void,
 *   },
 *   secrets?: readonly string[],
 * }} runtime
 */
/** Secret strings derived from the injected acquisition env (values
 *  only; never the names). Used for output/error redaction. */
function secretsFromRuntime(runtime) {
  const env = runtime.acquisitionOptions?.env ?? {};
  const names = [
    "TAVILY_API_KEY",
    "EXA_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "FIRECRAWL_API_KEY",
    "Z_AI_API_KEY",
    "ZAI_API_KEY",
    "MINIMAX_API_KEY",
    "JEV_DEV_API_KEY",
    "JEV_DEV_ENDPOINT",
  ];
  const fromEnv = names.map((n) => env[n]).filter((v) => typeof v === "string" && v !== "");
  return [...fromEnv, ...(runtime.secrets ?? [])];
}

/** Wrap both judge seams so each engine call's ACTUAL physical attempt
 *  count joins the delivered total. Success carries the count on the
 *  audit symbol; typed rejections carry it as `attempts`. Engine-call
 *  count and observer count never masquerade as physical work. */
function countingJudgeSeams(engineDeps, onCount) {
  const wrap = (seam, kind) => {
    const fn = engineDeps[seam];
    if (typeof fn !== "function") return null;
    return async (input, options) => {
      try {
        const response = await fn(input, options);
        const meta = response?.[Symbol.for("leanJevAttemptMeta")];
        if (meta && Number.isSafeInteger(meta.attempts)) onCount(meta.attempts, kind, true);
        else if (Number.isSafeInteger(response?.attempts)) onCount(response.attempts, kind, true);
        return response;
      } catch (error) {
        if (Number.isSafeInteger(error?.attempts)) onCount(error.attempts, kind, false);
        throw error;
      }
    };
  };
  return { judge: wrap("judge", "classification"), candidateJudge: wrap("candidateJudge", "candidate") };
}

export async function runLeanVerticalSlice(argv, runtime) {
  const secrets = secretsFromRuntime(runtime);
  // Usage errors THROW, redacted at the SAME outward boundary (argv
  // material can contain configured secrets — finished-boundary item 5).
  let source;
  try {
    ({ source } = parseVerticalSliceArgv(argv));
  } catch (error) {
    const message = String(error?.message ?? error);
    throw new Error(String(redactSecrets(message, secrets) ?? message));
  }
  let text;
  try {
    // The byte bound shapes the read itself: stdin and file both read
    // INCREMENTALLY with maxBytes+1 detection — never fstat-size trust.
    text =
      source.kind === "inline"
        ? source.value
        : source.target === "-"
          ? await runtime.invocation.readStdin(MAX_REQUIREMENTS_BYTES)
          : await runtime.invocation.readFile(source.target, MAX_REQUIREMENTS_BYTES);
  } catch (error) {
    const message = `requirements read failed: ${error?.code ?? ""} ${error?.message ?? "error"}`;
    runtime.invocation.writeErr(redactSecrets(message, secrets) ?? message);
    runtime.invocation.setExit(2);
    return 2;
  }
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes > MAX_REQUIREMENTS_BYTES) {
    runtime.invocation.writeErr(
      `requirements exceed the ${MAX_REQUIREMENTS_BYTES}-byte input ceiling.`,
    );
    runtime.invocation.setExit(2);
    return 2;
  }

  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    const message = `requirements are not valid JSON: ${error.message}`;
    runtime.invocation.writeErr(redactSecrets(message, secrets) ?? message);
    runtime.invocation.setExit(2);
    return 2;
  }

  try {
    // Strict preflight BEFORE any acquisition: unknown keys/depth reject
    // (never accept-and-drop), then the real compiler validates the
    // supported subset semantics.
    preflightRequirements(input);
    compileLeanContract(input);
  } catch (error) {
    const message = `${error?.code ? `[${error.code}] ` : ""}${error.message}`;
    runtime.invocation.writeErr(redactSecrets(message, secrets) ?? message);
    runtime.invocation.setExit(2);
    return 2;
  }

  let result;
  const provenance = [];
  const physical = { acquisitionAttempts: 0, attempts: 0, perAttempt: [], refused: 0, judgeDispatches: 0 };
  // Physical ledger totals: acquisition attempts from the bridge ledger
  // PLUS direct-judge dispatches observed through onAttempt (one event per
  // actual physical attempt — refusals and pre-dispatch cancellations emit
  // events too, but only dispatched work counts here via outcome class).
  try {
    const acquisition = createLeanAcquisitionDeps({
      ...runtime.acquisitionOptions,
      onReadProvenance: (record) => {
        provenance.push(record);
        runtime.acquisitionOptions.onReadProvenance?.(record);
      },
      onPhysicalLedger: (ledger) => {
        physical.acquisitionAttempts = ledger.attempts;
        physical.perAttempt = ledger.perAttempt;
        physical.refused = ledger.reservationsRefused;
        runtime.acquisitionOptions.onPhysicalLedger?.(ledger);
      },
    });
    const deps = {
      ...acquisition,
      judge: runtime.engineDeps.judge ?? null,
      extract: runtime.engineDeps.extract ?? null,
      candidateJudge: runtime.engineDeps.candidateJudge ?? null,
      // Delivered physical totals include DIRECT-JUDGE dispatches: the
      // seam wrapper reads the per-call attempt count from the engine
      // audit metadata (success) or the typed rejection (`attempts`),
      // both of which the direct module sets to actual physical attempts.
      ...countingJudgeSeams(runtime.engineDeps, (count, kind, ok) => {
        physical.judgeDispatches += count;
        if (!ok && runtime.engineDeps.onAttempt) return;
        void kind;
      }),
      ...(runtime.engineDeps.extractorRevision !== undefined
        ? { extractorRevision: runtime.engineDeps.extractorRevision }
        : {}),
      now: runtime.engineDeps.now,
    };
    result = await runLeanInvestigation(input, deps);
  } catch (error) {
    const message = `${error?.code ? `[${error.code}] ` : ""}${error.message}`;
    runtime.invocation.writeErr(redactSecrets(message, secrets) ?? message);
    runtime.invocation.setExit(2);
    return 2;
  }

  // Output: redacted result + serve-following provenance + observed
  // physical lifecycle (counts only — never billing inference).
  // Evidence identity (correction review P1): each retained record keeps
  // the digest of its ORIGINAL normalized content; the REDACTED DISPLAY
  // bytes are named as a derivative with their own digest — the original
  // representation remains what locators/provenance refer to.
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const evidenceWithIdentity = result.evidence.map((record) => {
    const contentSha256 = sha256(record.content);
    const redacted = redactSecrets(record.content, secrets);
    if (typeof redacted === "string" && redacted !== record.content) {
      return {
        ...record,
        content: redacted,
        contentSha256,
        contentByteLength: Buffer.byteLength(record.content, "utf-8"),
        displayContentSha256: sha256(redacted),
        displayByteLength: Buffer.byteLength(redacted, "utf-8"),
        displayRedacted: true,
        // Explicit derivative disclosure: the displayed bytes are a
        // redaction of the retained normalized representation; all
        // locators (candidate charRange etc.) index the ORIGINAL
        // normalized text in UTF-16 code units, never display offsets.
        locatorBasis: "original-normalized-content",
        locatorUnit: "utf16-code-units",
        locatorRange: "half-open",
      };
    }
    return {
      ...record,
      contentSha256,
      contentByteLength: Buffer.byteLength(record.content, "utf-8"),
      displayContentSha256: contentSha256,
      displayByteLength: Buffer.byteLength(record.content, "utf-8"),
      displayRedacted: false,
      locatorBasis: "original-normalized-content",
      locatorUnit: "utf16-code-units",
      locatorRange: "half-open",
    };
  });
  const envelope = {
    ...result,
    evidence: evidenceWithIdentity,
    // ASSEMBLY-TIME total: acquisition ledger attempts + judge dispatches
    // counted independently — a judge attempt after the FINAL acquisition
    // callback is still included (the ledger fires per acquisition
    // dispatch; this snapshot needs no later callback to be correct).
    usage: { ...result.usage, physicalHttpAttempts: physical.acquisitionAttempts + physical.judgeDispatches },
    acquisition: {
      readProvenance: provenance,
      physicalAttempts: physical.perAttempt,
      reservationsRefused: physical.refused,
    },
  };
  runtime.invocation.writeOut(
    JSON.stringify(redactSecrets(envelope, secrets) ?? envelope, null, 2),
  );
  const code = result.status === "complete" ? 0 : 1;
  runtime.invocation.setExit(code);
  return code;
}

// ---------------------------------------------------------------------------
// Incremental bounded readers (production main; tests inject their own)
// ---------------------------------------------------------------------------

/** Incremental bounded read of a numeric fd: reads chunks until numeric
 *  EOF (bytesRead === 0), maxBytes+1 excess detection — promisify(read)
 *  resolves {bytesRead, buffer}, NOT a count (correction review P1). */
async function readFdIncrementally(fd, maxBytes) {
  const chunk = Buffer.alloc(64 * 1024);
  const parts = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { bytesRead } = await promisify(read)(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      const err = new Error(`input exceeds the ${maxBytes}-byte ceiling`);
      err.code = "INPUT_TOO_LARGE";
      throw err;
    }
    parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(parts).toString("utf-8");
}

/** Open, incrementally read, close on every path. promisify(fs.open)
 *  resolves a NUMERIC fd (verified protocol control) — read and close
 *  that same fd. stdin uses fd 0 (never closed — process-owned). */
async function readBoundedIncremental(target, maxBytes) {
  if (target === "-") {
    return readFdIncrementally(0, maxBytes);
  }
  const fd = await promisify(open)(target, "r");
  try {
    return await readFdIncrementally(fd, maxBytes);
  } finally {
    await promisify(close)(fd).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Development main — fail-closed consent (property 1)
// ---------------------------------------------------------------------------

function descriptorFor(id) {
  const descriptor = BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === id);
  if (descriptor === undefined) throw new Error(`Unknown provider "${id}" in the registry.`);
  return descriptor;
}

/** Validate the explicit live acquisition profile. Returns descriptors+
 *  env or throws a fail-closed error. BOTH --live and SLICE_LIVE_PROFILE=1
 *  are required; ambient credentials alone never authorize dispatch. */
function liveAcquisitionProfile(argvHasLive, env) {
  const profileDeclared = env.SLICE_LIVE_PROFILE === "1";
  if (!argvHasLive && !profileDeclared) {
    // Ordinary invocation: no runtime acquisition at all — the run fails
    // closed before runtime creation. Importing stays inert.
    return null;
  }
  if (argvHasLive && !profileDeclared) {
    throw new ValidationError(
      "--live additionally requires SLICE_LIVE_PROFILE=1 (explicit runtime acquisition profile).",
    );
  }
  if (!argvHasLive && profileDeclared) {
    throw new ValidationError("SLICE_LIVE_PROFILE=1 additionally requires the --live opt-in flag.");
  }
  const searchId = env.SLICE_LIVE_SEARCH_PROVIDER ?? "tavily";
  const readerId = env.SLICE_LIVE_READER_PROVIDER ?? searchId;
  const searchDescriptor = descriptorFor(searchId);
  const readerDescriptor = descriptorFor(readerId);
  // Credential PRESENCE per provider is validated by the adapters at
  // invoke; here we require the env NAMES the chosen providers read to
  // be non-empty strings — an explicit profile with no credential
  // fails closed before any dispatch.
  const requiredCredential = (id) =>
    ({
      tavily: "TAVILY_API_KEY",
      exa: "EXA_API_KEY",
      brave: "BRAVE_SEARCH_API_KEY",
    })[id];
  for (const id of [searchId, readerId]) {
    const name = requiredCredential(id);
    if (name === undefined) continue; // keyless provider
    const value = env[name];
    if (typeof value !== "string" || value === "") {
      throw new ValidationError(
        `live profile: provider "${id}" requires ${name} to be set (explicit profile, no ambient fallback).`,
      );
    }
  }
  return { searchDescriptor, readerDescriptor, env };
}

/** Judge profile: complete JEV_DEV_* AND an EXPLICIT judge-transmission
 *  opt-in (SLICE_JUDGE_TRANSMIT=1) — complete ambient credentials alone
 *  are NOT consent (correction review P1). PARTIAL profile or a partial
 *  opt-in fails closed — never a deterministic-only downgrade. Entirely
 *  absent (no JEV vars at all) keeps approved deterministic-only. */
function judgeProfile(env, reserveAttempt) {
  const endpoint = env.JEV_DEV_ENDPOINT;
  const model = env.JEV_DEV_MODEL;
  const apiKey = env.JEV_DEV_API_KEY;
  const transmitOptIn = env.SLICE_JUDGE_TRANSMIT === "1";
  const directKey = env.TYPESAFE_API_KEY;
  const devPresent = [endpoint, model, apiKey].filter((v) => v !== undefined).length;
  const directPresent = directKey !== undefined ? 1 : 0;
  if (devPresent > 0 && directPresent > 0) {
    // Simultaneous dev-router and official direct selection is a conflict,
    // never a precedence-based substitution.
    throw new ValidationError(
      "JEV_DEV_* and TYPESAFE_API_KEY are both set; select exactly one judge profile (dev router or official direct), not both.",
    );
  }
  if (devPresent === 0 && directPresent === 0) {
    // Malformed direct overrides are rejected even with NO key/consent:
    // probe the resolver's closed-selection validation before absent return.
    resolveTypesafeJudgeProfile(
      { env: { TYPESAFE_MODEL: env.TYPESAFE_MODEL, TYPESAFE_ENDPOINT: env.TYPESAFE_ENDPOINT }, transmitConsent: false },
      { reserveAttempt: () => {} },
    );
    if (!transmitOptIn) return null; // approved deterministic-only
    throw new ValidationError(
      "SLICE_JUDGE_TRANSMIT=1 selected judge transmission but no judge profile is configured; refusing a silent deterministic-only downgrade.",
    );
  }
  if (directPresent > 0) {
    // Official direct TypeSafe: SLICE_JUDGE_TRANSMIT=1 is the SAME
    // independent transmission consent; the key alone never authorizes.
    if (!transmitOptIn) {
      throw new ValidationError(
        "TYPESAFE_API_KEY is present but judge transmission was not selected: set SLICE_JUDGE_TRANSMIT=1 to consent to transmitting evidence to the judge (credentials alone are not consent).",
      );
    }
    // The run-owned admission closure is REQUIRED and shared with
    // acquisition — the judge is never allowed its own private budget.
    // Without one (unit selector tests) a profile-local counter keeps the
    // seam honest for that profile's lifetime.
    let profileLocal = 0;
    const directProfile = resolveTypesafeJudgeProfile(
      { env, transmitConsent: true },
      {
        ...(reserveAttempt !== undefined
          ? { reserveAttempt }
          : { reserveAttempt: () => { profileLocal += 1; } }),
      },
    );
    // BOTH official semantic seams travel together: the dev branch below
    // returns a classification-only judge, the direct branch carries the
    // candidate dependency from the same profile (same admission closure).
    return {
      judge: directProfile.judge,
      candidateJudge: directProfile.candidateJudge,
    };
  }
  if (devPresent !== 3) {
    throw new ValidationError(
      "JEV_DEV_ENDPOINT/JEV_DEV_MODEL/JEV_DEV_API_KEY must be supplied together; a partial judge profile fails closed (no deterministic-only downgrade).",
    );
  }
  if (!transmitOptIn) {
    throw new ValidationError(
      "JEV_DEV_* credentials are present but judge transmission was not selected: set SLICE_JUDGE_TRANSMIT=1 to consent to transmitting evidence to the judge (credentials alone are not consent).",
    );
  }
  return {
    judge: createLeanJevJudge({
    endpoint,
    model,
    apiKey,
    ...(env.JEV_DEV_ALLOW_HTTP === "1" ? { allowHttp: true } : {}),
    ...(env.JEV_DEV_ALLOWED_MODELS !== undefined
      ? {
          allowedModels: env.JEV_DEV_ALLOWED_MODELS.split(",")
            .map((m) => m.trim())
            .filter(Boolean),
        }
      : {}),
  }), candidateJudge: null };
}

function developmentRuntime(argvHasLive, env, hooks = {}) {
  const live = liveAcquisitionProfile(argvHasLive, env); // throws on partial/mismatched opt-in
  if (live === null) {
    // Fail-closed ordinary invocation: no acquisition runtime is built.
    throw new ValidationError(
      "development slice invoked without explicit live opt-in: this entrypoint performs no acquisition without --live AND SLICE_LIVE_PROFILE=1 (ambient credentials are never authorization).",
    );
  }
  // Shared run admission: ONE closure enforced by acquisition AND both
  // judge seams. The run cap is physical, across all stages.
  let runPhysical = 0;
  const runCap = Number.isSafeInteger(Number(env.SLICE_PHYSICAL_CAP)) && Number(env.SLICE_PHYSICAL_CAP) > 0
    ? Number(env.SLICE_PHYSICAL_CAP)
    : Number.POSITIVE_INFINITY;
  const reserveRun = () => {
    if (runPhysical >= runCap) throw new Error(`run physical cap (${runCap}) exhausted`);
    runPhysical += 1;
    hooks.onReserve?.();
  };
  const judgeSelection = judgeProfile(env, reserveRun); // throws on partial profile
  // judgeProfile returns BOTH official seams (or a dev classification-only
  // wrapper); unwrap into the engine dependency shape.
  const judge = typeof judgeSelection === "function" ? judgeSelection : judgeSelection?.judge ?? null;
  const candidateJudge =
    judgeSelection !== null && typeof judgeSelection === "object" ? judgeSelection.candidateJudge ?? null : null;
  const secrets = [
    env.TAVILY_API_KEY,
    env.EXA_API_KEY,
    env.JEV_DEV_API_KEY,
    env.TYPESAFE_API_KEY,
    ...(env.JEV_DEV_ENDPOINT !== undefined ? [env.JEV_DEV_ENDPOINT] : []),
  ].filter((v) => typeof v === "string" && v !== "");
  // Per-operation bounded transport: the live profile requires the
  // caller-owned transports map + the registry factory so every actual
  // HTTP dispatch passes through the bridge wrapper (correction P1 —
  // unwrapped descriptors cannot certify zero work).
  // Caller-owned transports keyed by provider: the production fetch
  // (global fetch) declared explicitly so the bridge's bounded route is
  // the ONLY route — the per-operation copy wraps this fetch through
  // descriptorFactory. No unwrapped dispatch is possible.
  const transports = {};
  const ensureTransportEntry = (providerId) => {
    if (transports[providerId] === undefined) {
      transports[providerId] = { fetch: globalThis.fetch.bind(globalThis), env };
    }
    return transports[providerId];
  };
  const FACTORIES = { tavily: createTavilyDescriptor };
  const descriptorFactory = (providerId, transport) => {
    const factory = FACTORIES[providerId];
    if (factory === undefined) {
      throw new ValidationError(
        `No bounded-transport factory available for provider "${providerId}" in this development slice.`,
      );
    }
    // Returns the descriptor ONLY. The base map keeps the ORIGINAL raw
    // transport — the operation-owned wrapped copy is never published
    // back, so the next operation wraps the raw fetch exactly once
    // (current-mechanism review P1: nested wrappers inflated the
    // ledger and inherited expired deadlines).
    return factory({ transport });
  };
  for (const id of [live.searchDescriptor.id, live.readerDescriptor.id]) {
    if (FACTORIES[id] === undefined) {
      throw new ValidationError(
        `Live provider "${id}" has no bounded-transport composition in this development slice (refusing unwrapped dispatch).`,
      );
    }
    ensureTransportEntry(id);
  }
  return {
    acquisitionOptions: {
      searchDescriptor: live.searchDescriptor,
      readerDescriptor: live.readerDescriptor,
      transports,
      descriptorFactory,
      env,
      cache: defaultResponseCache,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      // The SAME closure the judge reserves through: one physical run cap.
      reservePhysicalAttempt: reserveRun,
      maxPhysicalAttempts: Number.isFinite(runCap) ? runCap : undefined,
    },
    engineDeps: {
      judge,
      // Official direct profile carries the candidate seam; the dev router
      // has none (null), and the parser is ALWAYS separately injected —
      // judge credentials never configure candidate production.
      ...(candidateJudge !== null ? { candidateJudge } : {}),
      ...(hooks?.extract !== undefined ? { extract: hooks.extract, extractorRevision: hooks.extractorRevision ?? "injected" } : {}),
      now: () => Date.now(),
      ...(hooks.onAttempt !== undefined ? { onAttempt: hooks.onAttempt } : {}),
    },
    invocation: {
      readStdin: async (maxBytes) => readBoundedIncremental("-", maxBytes),
      readFile: async (path, maxBytes) => readBoundedIncremental(path, maxBytes),
      writeOut: (text) => process.stdout.write(text),
      writeErr: (text) => process.stderr.write(`${text}\n`),
      setExit: (code) => {
        process.exitCode = code;
      },
    },
    secrets,
  };
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const mainSecrets = [
    process.env.TAVILY_API_KEY,
    process.env.EXA_API_KEY,
    process.env.JEV_DEV_API_KEY,
    process.env.JEV_DEV_ENDPOINT,
  ].filter(Boolean);
  try {
    const argv = process.argv.slice(2);
    const { live } = parseVerticalSliceArgv(argv);
    const runtime = developmentRuntime(live, process.env);
    if (process.env.SLICE_DEV_MAIN !== "0") {
      process.stderr.write(
        "scoutline lean-vertical-slice: DEVELOPMENT-ONLY entrypoint (not a shipped CLI surface)\n" +
          `live acquisition: explicit opt-in profile\n` +
          `judge: ${process.env.JEV_DEV_ENDPOINT !== undefined ? "JEV_DEV_* runtime config" : process.env.TYPESAFE_API_KEY !== undefined ? "official direct TypeSafe (consented)" : "absent → deterministic-only"}\n`,
      );
    }
    runLeanVerticalSlice(argv, runtime).catch((error) => {
      process.stderr.write(
        `${redactSecrets(String(error?.message ?? "development invocation failed"), mainSecrets)}\n`,
      );
      process.exitCode = 2;
    });
  } catch (gateError) {
    // Fail-closed gate: exit 2 before ANY runtime creation.
    process.stderr.write(
      `${redactSecrets(String(gateError?.message ?? "development profile rejected"), mainSecrets)}\n`,
    );
    process.exitCode = 2;
  }
}
