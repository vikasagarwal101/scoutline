/**
 * Init command — fresh-onboarding wizard (T3a — Plan A).
 *
 * This module owns the interactive `scoutline init` flow:
 *   - State detection (absent / already-onboarded / env-key present / fresh).
 *   - Provider checklist (registry-derived; none pre-checked — equal weight).
 *   - Per-provider ask-key-first → hidden input → inline single-attempt
 *     validation through `DiagnosticsCapability.invoke({probe:true})` against
 *     an EPHEMERAL resolved env (never persists, never mutates `process.env`).
 *   - Honest broad classification of probe failures: key-problems
 *     (`AuthError`/`ApiError`) reject + re-prompt; `NetworkError` offers
 *     save-unverified. No false-precise "wrong/disabled/mismatch" subtypes
 *     are inferred from message text — the taxonomy only distinguishes
 *     `AuthError`/`ApiError`/`NetworkError`.
 *   - Credit-cost disclosure before any paid-provider probe.
 *   - Fallback preference question.
 *   - Atomic config write (T1 `writeConfig` primitive) + redacted summary.
 *
 * Boundary rules (T3a ticket):
 *   - Fresh flow only. Re-config menu, corrupt-repair, trigger detection,
 *     non-TTY refusal, and selection (Plan B) belong to T3b.
 *   - No Provider transport is constructed outside the per-provider probe;
 *     the candidate credential lives only in the ephemeral env until the
 *     final atomic write.
 *   - All prompt IO flows through the {@link InitPrompts} seam; no direct
 *     `process.stdin` / `process.stdout` reads in this module. Production
 *     wires `@inquirer/prompts`; tests inject scripted doubles.
 *   - Registration links render BOTH a terminal hyperlink AND the literal
 *     URL text so captured / non-hyperlink output stays usable.
 *
 * Release gate (T3a ticket): the `init` command may ship its code now, but
 * its PUBLIC docs (top-level `MAIN_HELP` Commands list, README setup
 * section, `skills/scoutline/`) wait for T3b so the public claim of a
 * complete `init` is not made prematurely. The command's own
 * {@link INIT_HELP} carries an explicit caveat.
 */

import type {
  ConfigInspection,
  ProviderConfig,
  ProviderVerification,
  ScoutlineConfig,
  WriteConfigOptions,
} from "../lib/config-store.js";
import { inspectConfig, writeConfig } from "../lib/config-store.js";
import type { DiagnosticOptions, DiagnosticsCapability } from "../capabilities/diagnostics.js";
import type { ProviderDescriptor, ProviderId } from "../providers/types.js";
import { AuthError, ApiError, NetworkError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Help text for `scoutline init --help`. Carries the release-gate caveat
 * (T3a ticket): the command's code is shipped, but its public docs wait
 * for T3b. Anyone reading this help is told explicitly that re-config /
 * repair / non-TTY refusal are not yet wired.
 */
export const INIT_HELP = `
init - Interactive onboarding wizard (PREVIEW)

Usage: scoutline init [options]

PREVIEW: this command ships its fresh-onboarding flow today. The
re-configuration menu, corrupt-config repair, and trigger detection
for unconfigured commands land in a follow-up release. Non-TTY
invocation is not yet formally refused; it will not hang, but the
interactive prompts require a real terminal.

The wizard:
  - inspects the existing config (re-config is a follow-up)
  - offers to import a provider key already present in env
  - shows a provider checklist (Z.AI, MiniMax, Tavily, Exa, Brave,
    Firecrawl) with NO pre-checked defaults — every provider has
    equal weight
  - for each selected provider, asks whether you have a key, takes a
    hidden input, and performs a single inline validation probe
    against an ephemeral in-memory environment (the candidate
    credential is never persisted or written to process.env until the
    final atomic write)
  - honestly classifies probe failures as auth/api (reject + re-prompt)
    or network (offer save-unverified). No false-precise subtypes.
  - asks the fallback preference (route automatically when the
    selected provider is unavailable)
  - writes ~/.scoutline/config.json atomically with mode 0600

Options:
  --help   Show this help

Exit codes:
  0  Onboarding completed (or short-circuited as already-onboarded).
  1  User cancelled (Ctrl+C / EOF) — no config is written.
`.trim();

// ---------------------------------------------------------------------------
// Provider metadata (registration links, env-var labels, credit cost)
// ---------------------------------------------------------------------------

/**
 * Per-provider static metadata for the prompt surface. The canonical
 * provider list / order is the registry (`BUILT_IN_PROVIDER_DESCRIPTORS`);
 * this map only carries prompt-side presentation fields (registration URL,
 * human-readable env-var label, credit-cost disclosure). Adding a Provider
 * to the registry without an entry here is a coding error caught at the
 * `providerMeta` lookup below.
 */
interface ProviderPromptMeta {
  readonly label: string;
  readonly envVar: string;
  readonly registrationUrl: string;
  /**
   * True when the probe is billable (~1 credit). Z.AI and MiniMax probe
   * through free endpoints (tool discovery / raw quota probe); the other
   * four charge ~1 credit per probe. Surfaced before the user enters a
   * key so they can opt out before the charge occurs.
   */
  readonly probeCostsCredit: boolean;
}

const PROVIDER_PROMPT_META: Record<ProviderId, ProviderPromptMeta> = {
  zai: {
    label: "Z.AI",
    envVar: "Z_AI_API_KEY",
    registrationUrl: "https://z.ai/manage-apikey",
    probeCostsCredit: false,
  },
  minimax: {
    label: "MiniMax",
    envVar: "MINIMAX_API_KEY",
    registrationUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
    probeCostsCredit: false,
  },
  tavily: {
    label: "Tavily",
    envVar: "TAVILY_API_KEY",
    registrationUrl: "https://app.tavily.com/settings",
    probeCostsCredit: true,
  },
  exa: {
    label: "Exa",
    envVar: "EXA_API_KEY",
    registrationUrl: "https://dashboard.exa.ai/api-keys",
    probeCostsCredit: true,
  },
  brave: {
    label: "Brave Search",
    envVar: "BRAVE_SEARCH_API_KEY",
    registrationUrl: "https://api.search.brave.com/app/subscriptions",
    probeCostsCredit: true,
  },
  firecrawl: {
    label: "Firecrawl",
    envVar: "FIRECRAWL_API_KEY",
    registrationUrl: "https://www.firecrawl.dev/signin",
    probeCostsCredit: true,
  },
};

/**
 * Lookup helper that fails closed when a registry provider lacks prompt
 * metadata. Guards against a future Provider landing in the registry
 * without a matching entry above.
 */
function providerMeta(id: ProviderId): ProviderPromptMeta {
  const meta = PROVIDER_PROMPT_META[id];
  if (!meta) {
    throw new Error(
      `Provider "${id}" has no init-wizard metadata. ` +
        `Add it to PROVIDER_PROMPT_META in src/commands/init.ts.`,
    );
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Hyperlink rendering
// ---------------------------------------------------------------------------

/**
 * Terminal hyperlink escape (OSC 8). Modern terminals render this as a
 * clickable link; non-hyperlink terminals show the literal text. The
 * `printRegistrationLink` helper ALWAYS emits the literal URL too, so
 * captured/non-hyperlink output remains usable.
 */
function hyperlink(text: string, url: string): string {
  return `\x1B]8;;${url}\x1B\\${text}\x1B]8;;\x1B\\`;
}

/**
 * Render a registration link with BOTH a terminal hyperlink and the
 * literal URL text on a separate line. The literal URL is unconditional:
 * captured output (CI logs, pipe redirection) and non-hyperlink terminals
 * still see a copy-pasteable URL.
 */
function renderRegistrationLine(id: ProviderId): string {
  const meta = providerMeta(id);
  return `${meta.label}: ${hyperlink("Get an API key", meta.registrationUrl)}\n  ${meta.registrationUrl}`;
}

// ---------------------------------------------------------------------------
// Prompt seam
// ---------------------------------------------------------------------------

/**
 * Multi-select prompt choice for the provider checklist. `value` is the
 * provider id; `description` carries env-detected and credit-cost hints
 * surfaced in the choice description column.
 */
export interface InitChoice<T> {
  readonly value: T;
  readonly name: string;
  readonly description?: string;
  /**
   * Pre-checked state. The provider checklist NEVER pre-checks (equal
   * weight); this field exists for forward compatibility with T3b.
   */
  readonly checked?: boolean;
}

/**
 * Injectable prompt IO seam. Production wires `@inquirer/prompts` via
 * {@link createInquirerPrompts}; tests inject scripted doubles that
 * never touch a real TTY.
 *
 * The shape mirrors the four prompt types the wizard uses: multi-select
 * checkbox, yes/no confirm, hidden password, and free-text input.
 */
export interface InitPrompts {
  /**
   * Multi-select. Returns the chosen values in selection order. Throws
   * on user cancel (Ctrl+C / EOF) — the caller catches and treats as
   * no-write.
   */
  checkbox<T>(message: string, choices: readonly InitChoice<T>[]): Promise<T[]>;
  /** Yes/no. `defaultYes` carries the documented default ([Y/n] vs [y/N]). */
  confirm(message: string, defaultYes: boolean): Promise<boolean>;
  /** Hidden password input. Returns the trimmed value (possibly empty). */
  password(message: string): Promise<string>;
  /** Free-text input. Used for follow-up re-prompt loops. */
  input(message: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Config-store + diagnostics probe seams
// ---------------------------------------------------------------------------

/**
 * Injectable config-store seam. Production wires the real
 * {@link inspectConfig} / {@link writeConfig}; tests inject in-memory or
 * temp-dir-backed doubles so the wizard is hermetic — no real
 * `~/.scoutline/config.json` I/O during tests.
 */
export interface InitConfigStore {
  inspect(): Promise<ConfigInspection>;
  write(config: ScoutlineConfig, options?: WriteConfigOptions): Promise<void>;
}

/**
 * Wrap the real `inspectConfig` / `writeConfig` pair as an
 * {@link InitConfigStore}. The default options object is captured per-call
 * so the wizard can pass a temp `filePath` / atomic options through
 * unchanged in tests.
 */
export function createDefaultConfigStore(options: WriteConfigOptions = {}): InitConfigStore {
  return {
    async inspect() {
      return inspectConfig(options);
    },
    async write(config, writeOptions) {
      // The wizard prefers its own atomic options when supplied; otherwise
      // fall back to the store's. This keeps test-injected temp `filePath`
      // honored through both paths.
      const merged = writeOptions
        ? { ...options, ...writeOptions, atomic: { ...options.atomic, ...writeOptions.atomic } }
        : options;
      await writeConfig(config, merged);
    },
  };
}

/**
 * One-attempt connectivity probe outcome. Honest broad classification —
 * the contract only distinguishes {@link AuthError}/{@link ApiError}
 * (key-problem) from {@link NetworkError} (transient/connectivity) and
 * "everything else". No false-precise "wrong/disabled/mismatch" subtypes
 * are inferred from message text.
 */
type ProbeOutcome =
  | { readonly status: "verified" }
  | { readonly status: "auth-error"; message: string }
  | { readonly status: "network-error"; message: string }
  | { readonly status: "unknown-error"; message: string };

/**
 * Probe classifier. `AuthError`/`ApiError` (and HTTP-status-4xx-typed
 * variants) are key-problems → reject + re-prompt. `NetworkError` is
 * transient/connectivity → offer save-unverified. Everything else is
 * surfaced honestly as "unknown" rather than mis-typed.
 */
function classifyProbeError(error: unknown): ProbeOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AuthError || error instanceof ApiError) {
    return { status: "auth-error", message };
  }
  if (error instanceof NetworkError) {
    return { status: "network-error", message };
  }
  return { status: "unknown-error", message };
}

/**
 * Build the ephemeral resolved-env for a single-provider probe: a fresh
 * shallow copy of the injected env with the candidate key written into
 * the provider's canonical env-var slot. `process.env` is never mutated.
 *
 * The candidate lives only in this ephemeral view until the final atomic
 * write. If the same env-var is already set in `env` (env precedence),
 * the candidate overrides it for the probe only — we are testing the
 * CANDIDATE, not the ambient value.
 */
function buildEphemeralProbeEnv(
  env: NodeJS.ProcessEnv,
  canonicalVar: string,
  candidateKey: string,
): NodeJS.ProcessEnv {
  const ephemeral: NodeJS.ProcessEnv = { ...env };
  ephemeral[canonicalVar] = candidateKey;
  return ephemeral;
}

/**
 * Run a single probe against the descriptor. Constructs the adapter from
 * the EPHEMERAL env (never `deps.env` directly), calls
 * `diagnostics.invoke({probe:true})` EXACTLY once, and classifies the
 * outcome honestly. Doctor's retry wrapper is intentionally NOT used —
 * the wizard honours the "one attempt" contract from the ticket.
 */
async function probeProviderOnce(
  descriptor: ProviderDescriptor,
  ephemeralEnv: NodeJS.ProcessEnv,
): Promise<ProbeOutcome> {
  const options: DiagnosticOptions = { probe: true };
  try {
    const adapter = descriptor.create({ env: ephemeralEnv });
    const capability: DiagnosticsCapability | undefined = (
      adapter as { diagnostics?: DiagnosticsCapability }
    ).diagnostics;
    if (!capability) {
      // The descriptor advertises diagnostics but the adapter did not
      // supply the handle. Treat as unknown-error so the user can
      // save-unverified rather than hard-fail the wizard.
      return {
        status: "unknown-error",
        message: `Provider "${descriptor.id}" did not supply a diagnostics capability`,
      };
    }
    await capability.invoke(options);
    return { status: "verified" };
  } catch (error) {
    return classifyProbeError(error);
  }
}

// ---------------------------------------------------------------------------
// Wizard dependencies
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for the init wizard. Production supplies the
 * real defaults via the composition root in `src/index.ts`; tests pass
 * in-memory / temp-dir doubles for hermeticity.
 */
export interface InitDependencies {
  /** The provider registry — canonical checklist source/order. */
  readonly descriptors: readonly ProviderDescriptor[];
  /** Injectable prompt IO seam. */
  readonly prompts: InitPrompts;
  /** Injectable config-store seam. */
  readonly configStore: InitConfigStore;
  /** Injectable environment view (for env-key-import detection). */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Injectable clock, used for verification `checkedAt` timestamps.
   * Production wires `Date.now`; tests inject a fixed clock.
   */
  readonly now: () => number;
  /** Whether stdin is an interactive TTY. Non-TTY gets a graceful guard. */
  readonly stdinIsTTY: boolean;
  /** Progress / disclosure sink. */
  readonly writeStderr: (value: string) => void;
  /** Final-summary sink (the only stdout write in the wizard). */
  readonly writeStdout: (value: string) => void;
}

// ---------------------------------------------------------------------------
// Internal flow state
// ---------------------------------------------------------------------------

/**
 * Per-provider collected state across the wizard. A provider entry lands
 * here only when the user supplied (or imported) a candidate key, paired
 * with the verification outcome of its single inline probe.
 */
interface ProviderOnboarding {
  readonly providerId: ProviderId;
  readonly apiKey: string;
  readonly verification: ProviderVerification;
}

/**
 * `true` when the existing config indicates the user has already
 * completed onboarding. The wizard treats this state as
 * "already-onboarded — re-config is a T3b follow-up" rather than entering
 * the fresh flow.
 */
function isAlreadyOnboarded(config: ScoutlineConfig): boolean {
  for (const providerConfig of Object.values(config.providers)) {
    const pc = providerConfig as ProviderConfig | undefined;
    if (pc?.onboarded === true) return true;
    if (typeof pc?.apiKey === "string" && pc.apiKey.trim().length > 0) return true;
  }
  return false;
}

/**
 * Return the providers from `descriptors` whose canonical env-var holds a
 * non-blank key in `env`. Used to offer env-import at the start of the
 * fresh flow.
 */
function detectEnvKeyProviders(
  descriptors: readonly ProviderDescriptor[],
  env: NodeJS.ProcessEnv,
): ProviderId[] {
  const out: ProviderId[] = [];
  for (const descriptor of descriptors) {
    const canonical = providerMeta(descriptor.id).envVar;
    const value = env[canonical];
    if (typeof value === "string" && value.trim().length > 0) {
      out.push(descriptor.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wizard orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the fresh-onboarding wizard. Reads no module-level state and writes
 * no process-global state; every effect flows through
 * {@link InitDependencies}. The flow returns the exit code:
 *   - 0 on success or already-onboarded short-circuit.
 *   - 1 on user cancellation (Ctrl+C / EOF) or non-TTY guard.
 */
export async function runFreshOnboarding(deps: InitDependencies): Promise<number> {
  // Graceful minimal non-TTY guard (formal refuse is T3b). Without a TTY
  // the prompts cannot receive keypresses; we surface a friendly stderr
  // line and exit non-zero rather than hang.
  if (!deps.stdinIsTTY) {
    deps.writeStderr(
      "scoutline init requires an interactive terminal. " +
        "Re-run inside a TTY (formal non-TTY handling arrives in a follow-up release).\n",
    );
    return 1;
  }

  // Step 0 — state detection. The wizard does not enter the fresh flow
  // when the config already indicates onboarding completed; corrupt /
  // absent both fall through to the fresh flow (corrupt-repair is T3b).
  const inspection = await deps.configStore.inspect();
  if (inspection.status === "valid" && isAlreadyOnboarded(inspection.config)) {
    deps.writeStderr(
      "scoutline is already set up at " +
        `${inspection.filePath}. ` +
        "Re-configuration will arrive in a follow-up release.\n",
    );
    return 0;
  }

  // Splash (init-only). Sent to stderr so stdout stays data-only for the
  // final summary.
  deps.writeStderr(
    [
      "",
      "Welcome to scoutline onboarding.",
      "This wizard writes ~/.scoutline/config.json with mode 0600.",
      "You can cancel at any time with Ctrl+C — nothing is written until the end.",
      "",
    ].join("\n"),
  );

  // Detect ambient env keys for the import offer.
  const envKeyProviders = detectEnvKeyProviders(deps.descriptors, deps.env);
  if (envKeyProviders.length > 0) {
    const labels = envKeyProviders.map(
      (id) => `${providerMeta(id).label} ($${providerMeta(id).envVar})`,
    );
    deps.writeStderr(
      `Detected env key${envKeyProviders.length === 1 ? "" : "s"}: ${labels.join(", ")}.\n` +
        "Each will be offered as an import candidate in the per-provider flow.\n",
    );
  }

  // Step 1 — provider checklist. Choices come from the registry (equal
  // weight; none pre-checked). Env-key providers surface that hint in
  // their description column; credit-cost disclosure lands there too so
  // the user can opt out before any paid probe.
  const onboardings = await collectProviderOnboardings(deps, envKeyProviders);
  if (onboardings === null) {
    // User cancelled mid-flow.
    return 1;
  }

  // Step 2 — fallback preference. The wizard writes `fallbackEnabled`;
  // T2a consumes it at runtime.
  let fallbackEnabled = true;
  try {
    fallbackEnabled = await deps.prompts.confirm(
      "Route automatically if the selected provider is unavailable? [Y/n]",
      true,
    );
  } catch {
    // Cancel on the fallback prompt is still a cancel.
    return 1;
  }

  // Step 3 — atomic write (T1 primitive). Build the final config and
  // commit. No partial writes ever reach disk: `writeConfig` either
  // replaces the live file atomically or leaves it untouched.
  const config: ScoutlineConfig = buildConfig(onboardings, fallbackEnabled);
  try {
    await deps.configStore.write(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.writeStderr(`Failed to write config: ${message}\n`);
    return 1;
  }

  // Step 4 — redacted summary on stdout (data-only contract). The
  // summary line is the ONLY write to stdout in the wizard; it lists
  // provider ids and their verification status, never the keys.
  deps.writeStdout(`${formatSummary(onboardings, fallbackEnabled)}\n`);
  return 0;
}

/**
 * Step 1 of the wizard: collect per-provider onboarding state via the
 * checklist + ask-key-first + hidden input + single probe. Returns
 * `null` when the user cancelled mid-flow (so the caller treats it as a
 * no-write exit).
 */
async function collectProviderOnboardings(
  deps: InitDependencies,
  envKeyProviders: readonly ProviderId[],
): Promise<ProviderOnboarding[] | null> {
  // Loop until the user either selects at least one provider OR confirms
  // the zero-provider continue. The "back to checklist" path on a
  // zero-select-No branch is the documented fresh-flow edge case.
  for (;;) {
    const choices: InitChoice<ProviderId>[] = deps.descriptors.map((descriptor) => {
      const meta = providerMeta(descriptor.id);
      const hints: string[] = [];
      if (envKeyProviders.includes(descriptor.id)) {
        hints.push(`env $${meta.envVar} present (importable)`);
      }
      if (meta.probeCostsCredit) {
        hints.push("validation probe costs ~1 credit");
      } else {
        hints.push("validation probe is free");
      }
      return {
        value: descriptor.id,
        name: meta.label,
        description: hints.join("; "),
        checked: false,
      };
    });

    let selected: ProviderId[];
    try {
      selected = await deps.prompts.checkbox(
        "Select providers to configure (space to toggle, enter to confirm)",
        choices,
      );
    } catch {
      return null;
    }

    if (selected.length === 0) {
      // Zero-provider confirmation. Default No returns to the checklist
      // so the user does not accidentally exit on a stray enter.
      let continueWithNone = false;
      try {
        continueWithNone = await deps.prompts.confirm("Continue with no providers? [y/N]", false);
      } catch {
        return null;
      }
      if (!continueWithNone) {
        // Loop back to the checklist.
        continue;
      }
      // Empty-onboarding + fallback-default writes a minimal config and
      // leaves a pointer that the user can re-run `init` later.
      return [];
    }

    // Step 1b — per-provider ask-key-first → hidden input → single probe.
    const onboardings: ProviderOnboarding[] = [];
    for (const providerId of selected) {
      const onboarding = await onboardSingleProvider(deps, providerId, envKeyProviders);
      if (onboarding === null) {
        return null;
      }
      if (onboarding === "skip") {
        continue;
      }
      onboardings.push(onboarding);
    }
    return onboardings;
  }
}

/**
 * Per-provider flow: ask-key-first → hidden input → single probe. The
 * candidate credential lives only in the ephemeral probe env. Returns
 * `null` on cancel, `"skip"` if the user declined to provide a key (no
 * registration link visit, no probe), or the resulting onboarding state.
 */
async function onboardSingleProvider(
  deps: InitDependencies,
  providerId: ProviderId,
  envKeyProviders: readonly ProviderId[],
): Promise<ProviderOnboarding | "skip" | null> {
  const meta = providerMeta(providerId);
  const descriptor = deps.descriptors.find((d) => d.id === providerId);
  if (!descriptor) {
    // The checklist is registry-derived, so this is unreachable unless
    // the caller passed a divergent `descriptors` list.
    deps.writeStderr(`Provider "${providerId}" is not in the registry; skipping.\n`);
    return "skip";
  }

  // Env-import offer takes precedence over ask-key-first. The wizard
  // does NOT auto-import; it asks once per env-key provider.
  if (envKeyProviders.includes(providerId)) {
    try {
      const importFromEnv = await deps.prompts.confirm(
        `Import ${meta.label} key from $${meta.envVar}? [Y/n]`,
        true,
      );
      if (importFromEnv) {
        const candidate = deps.env[meta.envVar];
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          return validateAndCollect(deps, descriptor, candidate);
        }
        // The env value was blank/removed between detection and read;
        // fall through to ask-key-first so the user can still supply one.
        deps.writeStderr(
          `Env value for $${meta.envVar} is blank or missing; falling back to manual input.\n`,
        );
      }
    } catch {
      return null;
    }
  }

  // Ask-key-first. Default Yes — most users who reach this prompt have
  // a key. Declining (No) shows the registration link and skips the
  // provider; it does not advance on a key-problem, it just defers.
  let hasKey: boolean;
  try {
    hasKey = await deps.prompts.confirm(`Do you have a ${meta.label} API key? [Y/n]`, true);
  } catch {
    return null;
  }
  if (!hasKey) {
    deps.writeStderr(`${renderRegistrationLine(providerId)}\n`);
    return "skip";
  }

  // Credit-cost disclosure BEFORE any probe. Z.AI / MiniMax probes are
  // free (tool discovery / raw quota); the other four charge ~1 credit.
  if (meta.probeCostsCredit) {
    deps.writeStderr(`${meta.label}: validating the key costs ~1 credit against your account.\n`);
  }

  // Hidden password input. The value flows only into the ephemeral env.
  let candidate: string;
  try {
    candidate = await deps.prompts.password(`Paste your ${meta.label} API key (input hidden):`);
  } catch {
    return null;
  }

  return validateAndCollect(deps, descriptor, candidate);
}

/**
 * Build the ephemeral probe env for `descriptor` + `candidate`, run a
 * single probe, and classify. On verified → return the onboarding state.
 * On auth-error → re-prompt once for a fresh candidate. On
 * network-error → offer save-unverified. On unknown-error → surface
 * honestly and offer save-unverified (the wizard never claims an unknown
 * failure was verified). Returns `null` on cancel, `"skip"` if the user
 * declines all recovery options.
 */
async function validateAndCollect(
  deps: InitDependencies,
  descriptor: ProviderDescriptor,
  initialCandidate: string,
): Promise<ProviderOnboarding | "skip" | null> {
  const meta = providerMeta(descriptor.id);
  let candidate = initialCandidate.trim();
  // Re-prompt loop. We allow one re-entry per auth/unknown error so the
  // user can fix a typo without restarting the wizard. The probe itself
  // is exactly one attempt per loop iteration (the ticket's "one
  // attempt" contract).
  for (;;) {
    if (candidate.length === 0) {
      deps.writeStderr(`${meta.label}: blank key — skipping this provider.\n`);
      return "skip";
    }
    const ephemeralEnv = buildEphemeralProbeEnv(deps.env, meta.envVar, candidate);
    const outcome = await probeProviderOnce(descriptor, ephemeralEnv);

    if (outcome.status === "verified") {
      return {
        providerId: descriptor.id,
        apiKey: candidate,
        verification: { status: "verified", checkedAt: deps.now() },
      };
    }

    if (outcome.status === "network-error") {
      // Offer save-unverified. The candidate is preserved; the
      // verification record marks the deferred state with the reason.
      try {
        const save = await deps.prompts.confirm(
          `${meta.label}: connectivity check failed (${outcome.message}). ` +
            "Save the key as UNVERIFIED? [Y/n]",
          true,
        );
        if (save) {
          return {
            providerId: descriptor.id,
            apiKey: candidate,
            verification: {
              status: "unverified",
              checkedAt: deps.now(),
              reason: "network-deferred",
            },
          };
        }
        return "skip";
      } catch {
        return null;
      }
    }

    if (outcome.status === "auth-error") {
      // Key-problem → reject + re-prompt. Never advance on an
      // auth/api error.
      deps.writeStderr(`${meta.label}: key rejected (${outcome.message}).\n`);
      try {
        candidate = (
          await deps.prompts.password(
            `Re-enter your ${meta.label} API key (or press Ctrl+C to skip):`,
          )
        ).trim();
      } catch {
        return null;
      }
      continue;
    }

    // Unknown-error — surface honestly. Offer save-unverified as a
    // graceful recovery rather than masking as verified.
    deps.writeStderr(`${meta.label}: probe failed — ${outcome.message}\n`);
    try {
      const save = await deps.prompts.confirm(
        `${meta.label}: save the key as UNVERIFIED anyway? [y/N]`,
        false,
      );
      if (save) {
        return {
          providerId: descriptor.id,
          apiKey: candidate,
          verification: {
            status: "unverified",
            checkedAt: deps.now(),
            reason: "unknown-probe-failure",
          },
        };
      }
      return "skip";
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Config assembly + summary
// ---------------------------------------------------------------------------

/**
 * Build the final {@link ScoutlineConfig} from the wizard's collected
 * state. Each onboarding entry becomes a `providers[id]` row carrying
 * the api key, the onboarding-completed flag, and the verification
 * record. `fallbackEnabled` is the Step-2 answer.
 */
function buildConfig(
  onboardings: readonly ProviderOnboarding[],
  fallbackEnabled: boolean,
): ScoutlineConfig {
  const providers: Partial<Record<ProviderId, ProviderConfig>> = {};
  for (const onboarding of onboardings) {
    providers[onboarding.providerId] = {
      apiKey: onboarding.apiKey,
      onboarded: true,
      verification: onboarding.verification,
    };
  }
  return {
    version: 1,
    fallbackEnabled,
    providers,
  };
}

/**
 * Format the redacted stdout summary line. Provider ids and verification
 * status are surfaced; keys never are. One line per provider + a
 * fallback footer.
 */
function formatSummary(
  onboardings: readonly ProviderOnboarding[],
  fallbackEnabled: boolean,
): string {
  if (onboardings.length === 0) {
    return (
      "scoutline onboarding complete with no providers configured. " +
      "Re-run `scoutline init` to add one."
    );
  }
  const lines = onboardings.map((onboarding) => {
    const meta = providerMeta(onboarding.providerId);
    const status = onboarding.verification.status;
    return `${meta.label} (${onboarding.providerId}): ${status}`;
  });
  lines.push(`fallbackEnabled=${fallbackEnabled ? "true" : "false"}`);
  lines.push("Wrote ~/.scoutline/config.json (mode 0600).");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Production prompt adapter (inquirer)
// ---------------------------------------------------------------------------

/**
 * Cached inquirer module handle. The first call resolves the dynamic
 * import; subsequent calls reuse the same promise so the cost is paid
 * exactly once per process. Tests never reach this path — they inject
 * a scripted {@link InitPrompts} double instead.
 */
type InquirerModule = {
  checkbox: <T>(config: unknown, context: unknown) => Promise<T[]>;
  confirm: (config: unknown, context: unknown) => Promise<boolean>;
  password: (config: unknown, context: unknown) => Promise<string>;
  input: (config: unknown, context: unknown) => Promise<string>;
};

let inquirerPromise: Promise<InquirerModule> | undefined;

async function loadInquirer(): Promise<InquirerModule> {
  if (!inquirerPromise) {
    inquirerPromise = import("@inquirer/prompts").then((mod) => {
      return mod as unknown as InquirerModule;
    });
  }
  return inquirerPromise;
}

/**
 * Build the production {@link InitPrompts} from `@inquirer/prompts`. The
 * adapter:
 *   - Rewires the inquirer output stream to `process.stderr` so the
 *     wizard keeps the codebase's data-only-stdout contract (the final
 *     summary line is the only stdout write).
 *   - Maps the four wizard prompt shapes onto the inquirer calls.
 *
 * Tests never call this — they inject a scripted {@link InitPrompts}
 * double instead, so test runs are fully hermetic and do not need a TTY.
 */
export function createInquirerPrompts(): InitPrompts {
  const context = { output: process.stderr };
  return {
    async checkbox<T>(message: string, choices: readonly InitChoice<T>[]): Promise<T[]> {
      const inquirer = await loadInquirer();
      return inquirer.checkbox<T>(
        {
          message,
          // inquirer mutates the choice array; pass a defensive shallow
          // copy so the wizard's `readonly` source is untouched.
          choices: choices.map((c) => ({ ...c })),
        },
        context,
      );
    },
    async confirm(message: string, defaultYes: boolean): Promise<boolean> {
      const inquirer = await loadInquirer();
      return inquirer.confirm({ message, default: defaultYes }, context);
    },
    async password(message: string): Promise<string> {
      const inquirer = await loadInquirer();
      const value = await inquirer.password({ message, mask: "" }, context);
      return typeof value === "string" ? value.trim() : "";
    },
    async input(message: string): Promise<string> {
      const inquirer = await loadInquirer();
      return inquirer.input({ message }, context);
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level handler
// ---------------------------------------------------------------------------

/**
 * Top-level init handler. Wired into the dispatch switch in `index.ts`.
 *
 * - `--help` / `-h` prints {@link INIT_HELP} to stdout and returns 0.
 * - Otherwise dispatches to {@link runFreshOnboarding}.
 *
 * The CLI arg list is the same shape every other handler receives; the
 * handler only inspects it for the help flag.
 */
export async function handleInitWithHelp(
  args: readonly string[],
  deps: InitDependencies,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    deps.writeStdout(`${INIT_HELP}\n`);
    return 0;
  }
  return runFreshOnboarding(deps);
}

/**
 * Backwards-compatible alias used by the dispatch switch. Tests that drive
 * the wizard directly pass an empty arg list.
 */
export async function handleInit(deps: InitDependencies): Promise<number> {
  return handleInitWithHelp([], deps);
}
