/**
 * Trigger detection (T3b — Plan A, Option B).
 *
 * When the user runs a credentialed command without ever having gone
 * through `scoutline init`, we want one of three classified outcomes
 * rather than a confusing per-handler stack trace:
 *
 *   - **env-only setup**: a key for the effective Provider is present
 *     in the injected env, but no Provider key is stored in
 *     `config.json`. We emit a ONE-TIME stderr hint pointing at
 *     `scoutline init` (so the user learns the wizard exists), persist
 *     `config.json.hintShown`, and then run the command normally. The
 *     command's natural output and exit code are preserved.
 *   - **missing credential everywhere**: the effective Provider has no
 *     key in env OR in `config.json`. We emit remediation and surface
 *     the existing `CONFIGURATION_ERROR` exit 3. A refused operation
 *     is NEVER exit 0 — scripting users must not treat refusal as
 *     success.
 *   - **credential-free commands** (`--help`, `--version`, `cache`,
 *     `init`, `<command> --help`): no config read at all. The T2a
 *     short-circuit already covers help/version/cache/init; this
 *     module exposes a helper to recognise per-command help so the
 *     trigger layer can route around it too (command help must remain
 *     usable under a corrupt config — see review item 9).
 *
 * Doctor and quota are observational: they report per-Provider state
 * rather than depending on a single effective credential, so trigger
 * detection does NOT classify them. They keep their existing per-handler
 * configuration-error behavior (Doctor reports skipped/error states;
 * quota surfaces its existing CONFIGURATION_ERROR when nothing is
 * configured).
 *
 * Raw Z.AI commands (`tools`, `tool`, `call`, `code`) ARE credentialed
 * and Z.AI-only, so missing-key remediation applies to them. They do
 * NOT gain Provider selection or fallback (still Z.AI-only).
 *
 * All functions here are pure (they take their inputs as arguments and
 * touch no module-level state). The dispatcher in `src/index.ts` wires
 * the real `HintShownStore`, the injected env, the descriptors, and the
 * stderr sink.
 */

import type { ProviderDescriptor, ProviderId } from "../providers/types.js";
import type { ScoutlineConfig } from "./config-store.js";
import { ConfigurationError } from "./errors.js";

/**
 * Commands that are observational rather than credentialed. They are
 * exempt from trigger detection because they already report per-Provider
 * state instead of depending on a single effective credential.
 */
export const OBSERVATIONAL_COMMANDS: ReadonlySet<string> = new Set(["doctor", "quota"]);

/**
 * Commands that are credential-free at the dispatcher level (handled
 * before the credentialed config read). Listed here for documentation
 * completeness; the dispatcher short-circuits them before reaching the
 * trigger layer.
 */
export const DISPATCHER_CREDENTIAL_FREE: ReadonlySet<string> = new Set(["cache", "init"]);

/**
 * Commands that are always Z.AI-only (raw Z.AI tools + Code Mode).
 * Trigger detection treats them as credentialed; their effective
 * Provider is always `zai` regardless of `--provider`.
 */
export const ZAI_ONLY_COMMANDS: ReadonlySet<string> = new Set(["tools", "tool", "call", "code"]);

/**
 * The classified credential state for the command being dispatched.
 * The dispatcher consumes this to decide whether to emit the hint,
 * refuse, or proceed normally. The classification is computed across
 * ALL descriptors (not just the effective Provider) so that Provider
 * fallback can route to a configured candidate even when the effective
 * is unconfigured — "missing" only fires when NO provider can serve
 * the request.
 */
export type CredentialState =
  | { readonly kind: "env-only" }
  | { readonly kind: "file-configured" }
  | { readonly kind: "env-and-file" }
  | { readonly kind: "missing" };

/**
 * Inputs to {@link classifyCredentialState}. Kept explicit so the
 * classifier stays a pure function — no module-level reads, no
 * descriptor lookup beyond what the caller passes in.
 */
export interface CredentialClassificationInput {
  /** The full provider registry (so fallback candidates are considered). */
  readonly descriptors: readonly ProviderDescriptor[];
  /** The injected environment view (env vars only, no file keys). */
  readonly env: NodeJS.ProcessEnv;
  /**
   * The resolved environment view (env + file keys layered in by
   * `resolveEnvFromConfig`). When this differs from `env`, a file
   * key is present.
   */
  readonly resolvedEnv: NodeJS.ProcessEnv;
  /** The loaded config (used to detect a file key directly). */
  readonly config: ScoutlineConfig;
}

/**
 * Classify the credential state across the whole registry.
 *
 *   - **missing**: NO descriptor is configured through env OR file.
 *     The command cannot succeed (no fallback candidate exists), so
 *     the dispatcher refuses with `CONFIGURATION_ERROR` exit 3.
 *   - **env-only**: at least one descriptor is configured through env,
 *     and NO descriptor has a file key. The user is running purely on
 *     environment variables; the one-time hint points them at `init`.
 *   - **env-and-file**: env keys and file keys both exist. Env
 *     precedence means the env value wins at runtime for the providers
 *     that have both; the file keys cover the rest. No hint needed
 *     (the user has been through onboarding).
 *   - **file-configured**: keys exist ONLY in the file (the normal
 *     post-onboarding steady state). No hint needed.
 *
 * The "env-only" classification is the trigger for the one-time hint;
 * "missing" is the trigger for remediation + exit 3. The other two
 * states proceed normally.
 */
export function classifyCredentialState(input: CredentialClassificationInput): CredentialState {
  const { descriptors, env, resolvedEnv, config } = input;
  // For the env-configured check, a keyless provider (one that reports
  // isConfigured without any of its credentialEnvVars actually set in env)
  // does NOT count as env-configured — there is no credential to record.
  const anyEnvConfigured = descriptors.some((d) => {
    if (!d.isConfigured(env)) return false;
    const credVars = d.credentialEnvVars ?? [];
    return credVars.some((v) => {
      const val = env[v];
      return typeof val === "string" && val.trim().length > 0;
    });
  });
  const anyResolvedConfigured = descriptors.some((d) => d.isConfigured(resolvedEnv));
  const anyFileConfigured = Object.values(config.providers).some((provider) => {
    const key = provider?.apiKey;
    return typeof key === "string" && key.trim().length > 0;
  });

  if (!anyResolvedConfigured) {
    return { kind: "missing" };
  }
  if (anyEnvConfigured && !anyFileConfigured) {
    return { kind: "env-only" };
  }
  if (anyEnvConfigured && anyFileConfigured) {
    return { kind: "env-and-file" };
  }
  // !anyEnvConfigured && anyFileConfigured — the resolved env picked up
  // the file key; this is the normal post-onboarding steady state.
  return { kind: "file-configured" };
}

/**
 * Format the one-time env-only hint. Sent to stderr so stdout stays
 * data-only. The hint names the wizard and points at it; it does NOT
 * repeat on subsequent runs because the dispatcher persists
 * `config.json.hintShown` after emitting it.
 */
export function formatEnvOnlyHint(): string {
  return (
    "scoutline: using credentials from the environment. " +
    "Run `scoutline init` to record them in ~/.scoutline/config.json " +
    "(enables fallback preferences, verification tracking, and re-config). " +
    "This is a one-time hint; it will not repeat.\n"
  );
}

/**
 * Build the missing-credential error. Reuses the existing
 * `CONFIGURATION_ERROR` / exit-3 contract so a refused operation is
 * NEVER confused with success. The help text lists the canonical env
 * vars across all providers so the user can pick one to set, and
 * points at `init` as the interactive alternative.
 */
export function missingCredentialError(
  descriptors: readonly ProviderDescriptor[],
): ConfigurationError {
  const vars: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.credentialEnvVars && descriptor.credentialEnvVars.length > 0) {
      const envVar = descriptor.credentialEnvVars[0];
      if (envVar) vars.push(envVar);
    }
  }
  const help =
    vars.length > 0
      ? `Set one of ${vars.join(", ")} (or run \`scoutline init\` to configure interactively).`
      : "Run `scoutline init` to configure a Provider, or set the required API key in the environment.";
  const message = "No Provider credential is configured (neither env nor ~/.scoutline/config.json)";
  return new ConfigurationError(message, help);
}

/**
 * Detect whether the command being dispatched should bypass trigger
 * detection because it is rendering command-local help. Command help
 * (`<command> --help` / `-h`) must remain usable even when config.json
 * is corrupt or absent — rendering help never needs a credential.
 *
 * This is a shallow peek at the arg list: it only looks for the help
 * flag, mirroring the per-handler short-circuit (`flags.help ||
 * flags.h`). It does NOT consume the args; the handler still parses
 * them itself.
 */
export function isCommandHelpInvocation(commandArgs: readonly string[]): boolean {
  return commandArgs.includes("--help") || commandArgs.includes("-h");
}

/**
 * Batch dry-run invocations (`batch <manifest> --dry-run` and the
 * `vision batch <input> --dry-run` wrapper) promise a NO-TRANSPORT
 * preview: no descriptor.create(), no cache reads/writes, no
 * consumption (batch-runner DESIGN D7/D10). The after-command quota
 * due-refresh in `main` is cadence-gated but live-probes stale
 * providers, so it must be skipped for these invocations (review fix).
 *
 * Same shallow-peek contract as isCommandHelpInvocation: this only
 * classifies, it does not consume the args — the handler still parses
 * them itself. Both batch flag surfaces reject a valued `--dry-run`
 * (`--dry-run false` fails validation inside the handler), so the bare
 * token unambiguously identifies a genuine dry-run preview.
 */
export function isDryRunBatchInvocation(
  command: string,
  commandArgs: readonly string[],
): boolean {
  const isBatchSurface =
    command === "batch" || (command === "vision" && commandArgs[0] === "batch");
  return isBatchSurface && commandArgs.includes("--dry-run");
}
