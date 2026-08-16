/**
 * Init command — interactive onboarding wizard (T3a + T3b — Plan A).
 *
 * This module owns the interactive `scoutline init` flow:
 *   - State detection (absent / corrupt / already-onboarded / fresh).
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
 * T3b additions:
 *   - **Re-config menu** when an already-valid config exists: edit a
 *     Provider key, add a Provider, remove a Provider, change the
 *     fallback preference, re-run the full wizard, or cancel. Editing
 *     a Provider key resets `verification.status` to `unverified`
 *     (Doctor re-promotes after a successful probe).
 *   - **Corrupt-config repair**: tolerant `inspectConfig` distinguishes
 *     `absent` / `valid` / `corrupt`. On `corrupt` the wizard offers to
 *     back up the live file and rewrite a fresh config — `init` is the
 *     recovery path, not a victim of corruption.
 *   - **Formal non-TTY refuse**: without an interactive terminal the
 *     wizard refuses before any prompt, prints env instructions and
 *     the `init` hint, and exits.
 *   - **Stale-env-after-import warning**: when the user imports a key
 *     from env, the wizard notes that the env value will continue to
 *     take precedence (env > file in the runtime precedence rule) —
 *     the wizard cannot turn off the env value for the user.
 *   - **`hintShown` reset on re-init**: a re-config or fresh write
 *     resets the env-only hint marker so a user who later switches to
 *     env-only usage sees the hint once again.
 *
 * Boundary rules:
 *   - No Provider transport is constructed outside the per-provider probe;
 *     the candidate credential lives only in the ephemeral env until the
 *     final atomic write.
 *   - All prompt IO flows through the {@link InitPrompts} seam; no direct
 *     `process.stdin` / `process.stdout` reads in this module. Production
 *     wires `@inquirer/prompts`; tests inject scripted doubles.
 *   - Registration links render BOTH a terminal hyperlink AND the literal
 *     URL text so captured / non-hyperlink output stays usable.
 *   - No selection work (Plan B); the wizard writes at most one
 *     `fallbackEnabled` flag and per-Provider records.
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
import { PROVIDER_CAPABILITIES, PROVIDER_IDS } from "../providers/types.js";
import { AuthError, ApiError, NetworkError } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Help text for `scoutline init --help`. T3b completes the wizard's
 * lifecycle (re-config menu, corrupt-config repair, formal non-TTY
 * refuse), so the T3a PREVIEW caveat is dropped — the public claim of
 * a complete `init` is now accurate.
 */
export const INIT_HELP = `
init - Interactive onboarding wizard

Usage: scoutline init [options]

The wizard walks you through recording API keys in
~/.scoutline/config.json (mode 0600). It supports four states:

  - ABSENT (no config yet): the fresh-onboarding flow runs.
  - VALID + ALREADY-ONBOARDED: a re-config menu runs (edit a key,
    add a Provider, remove a Provider, change the fallback
    preference, edit the routing table, re-run the full wizard, or
    cancel). Editing a key
    resets that Provider's verification to "unverified".
  - VALID + EMPTY: the fresh-onboarding flow runs.
  - CORRUPT: the wizard offers to back up the live file and rewrite
    a fresh config. init is the recovery path for a corrupt config.

The fresh flow:
  - offers to import a provider key already present in env (the
    wizard notes that env precedence means the env value keeps
    winning at runtime)
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

Non-interactive terminals: init refuses before any prompt and exits.
Run it inside a real TTY, or set up credentials via the documented
environment variables instead.

Options:
  --help   Show this help

Exit codes:
  0  Onboarding completed, re-config applied, or already-onboarded
       with the user choosing Cancel.
  1  User cancelled (Ctrl+C / EOF), the wizard was invoked without a
       terminal, a write failed, or the user declined corrupt-config
       repair.
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
  parallel: {
    label: "Parallel AI",
    envVar: "PARALLEL_API_KEY",
    registrationUrl: "https://parallel.ai",
    probeCostsCredit: true,
  },
  perplexity: {
    label: "Perplexity Sonar",
    envVar: "PERPLEXITY_API_KEY",
    registrationUrl: "https://www.perplexity.ai/settings/api",
    probeCostsCredit: true,
  },
  jina: {
    label: "Jina AI",
    envVar: "JINA_API_KEY",
    registrationUrl: "https://jina.ai",
    probeCostsCredit: false,
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
  /**
   * Single-select menu. Returns the chosen value. Throws on user
   * cancel. Used by the T3b re-config menu (edit/add/remove/fallback/
   * rerun/cancel) and the corrupt-config-repair prompt.
   */
  select<T>(message: string, choices: readonly InitChoice<T>[]): Promise<T>;
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
 * Non-TTY refuse message. The wizard is interactive end-to-end; without
 * a terminal it cannot receive keypresses, and we do not want a partial
 * (config-only) flow that misleads users into thinking they configured
 * something. The refuse message points users at the environment-variable
 * path AND at `init` so they have a non-interactive alternative.
 */
function formatNonTTYRefuse(
  env: NodeJS.ProcessEnv,
  descriptors: readonly ProviderDescriptor[],
): string {
  const example = descriptors[0];
  const exampleVar = example ? providerMeta(example.id).envVar : "Z_AI_API_KEY";
  const detected = descriptors.filter((d) => {
    const v = env[providerMeta(d.id).envVar];
    return typeof v === "string" && v.trim().length > 0;
  });
  const detectedLine =
    detected.length > 0
      ? `\nDetected env keys: ${detected.map((d) => `$${providerMeta(d.id).envVar}`).join(", ")}. The CLI will use them at runtime.`
      : "";
  return (
    "scoutline init requires an interactive terminal.\n" +
    "Re-run inside a TTY, or set up credentials via environment variables:\n" +
    `  export ${exampleVar}="your-api-key"\n` +
    "Then run any command directly (for example `scoutline doctor`)." +
    detectedLine +
    "\n"
  );
}

/**
 * Run the interactive init wizard. Performs the T3b state dispatch:
 *   - non-TTY → refuse before any prompt + exit 1.
 *   - corrupt config → offer backup + rewrite (init is the recovery path).
 *   - valid + already-onboarded → re-config menu.
 *   - valid + empty / absent → fresh-onboarding flow.
 *
 * Returns the exit code:
 *   - 0 on success, re-config applied, or already-onboarded + Cancel.
 *   - 1 on user cancel, non-TTY refuse, write failure, or declined repair.
 */
export async function runFreshOnboarding(deps: InitDependencies): Promise<number> {
  // Formal non-TTY refuse (T3b). Without a TTY the wizard cannot run;
  // we refuse before any prompt and surface the env-only alternative.
  if (!deps.stdinIsTTY) {
    deps.writeStderr(formatNonTTYRefuse(deps.env, deps.descriptors));
    return 1;
  }

  // Tolerant state detection. `inspect` returns absent / valid / corrupt;
  // the wizard dispatches on the status rather than entering a single
  // flow. This is the recovery path for a corrupt config.
  const inspection = await deps.configStore.inspect();
  if (inspection.status === "corrupt") {
    return repairCorruptConfig(deps, inspection.filePath, inspection.error);
  }

  if (inspection.status === "valid" && isAlreadyOnboarded(inspection.config)) {
    return runReconfigMenu(deps, inspection.config, inspection.filePath);
  }

  // Absent OR valid+empty → fresh-onboarding flow. The fresh flow writes
  // a complete config (replacing any empty valid file) and resets the
  // env-only hint marker so a later switch to env-only usage re-hints.
  return runFreshFlow(deps);
}

/**
 * The fresh-onboarding flow (T3a). Splash + env-key detection + provider
 * checklist + per-provider probe + fallback preference + atomic write.
 * Resets `hintShown` on the written config (the T3b release contract:
 * a fresh write clears the marker so the trigger-detection hint can
 * fire again if the user later switches to env-only usage).
 */
async function runFreshFlow(deps: InitDependencies): Promise<number> {
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
  // replaces the live file atomically or leaves it untouched. The
  // `hintShown` field is deliberately OMITTED from buildConfig so the
  // written file does not carry the marker — a fresh write clears it.
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

// ---------------------------------------------------------------------------
// Corrupt-config repair (T3b). init is the documented recovery path for
// a corrupt config.json; the wizard offers a backup + rewrite rather
// than refusing or silently clobbering the live file.
// ---------------------------------------------------------------------------

/**
 * Offer corrupt-config repair. Surfaces the underlying error, asks for
 * confirmation, and on Yes:
 *   1. Renames the live file to `<filePath>.corrupt-<timestamp>.bak`
 *      (best-effort; a rename failure does NOT block the rewrite —
 *      the user already confirmed).
 *   2. Writes a fresh config via the normal atomic primitive (the
 *      backup line is logged to stderr; the live file is not unlinked
 *      without a backup unless rename fails, in which case we ask
 *      again).
 *   3. Falls through to the fresh-onboarding flow so the user can
 *      rebuild their config interactively.
 *
 * On No (decline), the wizard exits 1 without modifying anything. This
 * keeps init safe: a user who lands here by accident can back out.
 */
async function repairCorruptConfig(
  deps: InitDependencies,
  filePath: string,
  error: unknown,
): Promise<number> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  deps.writeStderr(
    [
      "",
      `scoutline: config.json at ${filePath} is corrupt or unreadable.`,
      `Reason: ${errorMessage}`,
      "",
      "init can back up the live file and write a fresh config.",
      "The backup is named <config.json>.corrupt-<timestamp>.bak and is",
      "never deleted by scoutline.",
      "",
    ].join("\n"),
  );

  let proceed: boolean;
  try {
    proceed = await deps.prompts.confirm(
      "Back up the corrupt config and run the fresh-onboarding flow? [y/N]",
      false,
    );
  } catch {
    // Cancel on the repair confirm is the same as declining.
    return 1;
  }
  if (!proceed) {
    deps.writeStderr(
      "Declined repair. Run `scoutline init` again to retry, or fix/remove the file manually.\n",
    );
    return 1;
  }

  // Best-effort backup. The ConfigStore interface owns the file path
  // (real or temp-dir-injected); we delegate the rename to a typed
  // helper if the store exposes one, otherwise we use the same write
  // primitive to land the fresh file (the live corrupt bytes are
  // replaced atomically). The store seam is intentionally narrow so
  // tests do not need a real fs.rename injection.
  const backupPath = `${filePath}.corrupt-${deps.now()}.bak`;
  const backedUp = await backupCorruptFile(deps, filePath, backupPath);
  if (backedUp) {
    deps.writeStderr(`Backed up corrupt config to ${backupPath}.\n`);
  } else {
    // Rename failed — we did not create a backup. Re-ask the user so
    // the live file is never clobbered without explicit consent.
    deps.writeStderr("Could not create a backup (rename failed or unsupported by the store).");
    try {
      const clobber = await deps.prompts.confirm(
        "Rewrite the live config WITHOUT a backup? [y/N]",
        false,
      );
      if (!clobber) {
        deps.writeStderr("Declined. Repair aborted; the live file is untouched.\n");
        return 1;
      }
    } catch {
      return 1;
    }
  }

  // Fall through to the fresh flow. The first write replaces the live
  // (corrupt) bytes atomically; nothing partial reaches disk.
  deps.writeStderr("Running the fresh-onboarding flow. The corrupt file has been set aside.\n");
  return runFreshFlow(deps);
}

/**
 * Try to rename the corrupt file to the backup path. Returns `true` on
 * success. The implementation prefers a store-supplied rename hook
 * (tests can inject a fake); in production the real store delegates to
 * `fs.rename`. A thrown rename is swallowed and reported as `false` so
 * the caller can re-ask the user.
 */
async function backupCorruptFile(
  deps: InitDependencies,
  filePath: string,
  backupPath: string,
): Promise<boolean> {
  const store = deps.configStore as InitConfigStore & {
    backupCorrupt?(filePath: string, backupPath: string): Promise<boolean>;
  };
  if (typeof store.backupCorrupt === "function") {
    try {
      return await store.backupCorrupt(filePath, backupPath);
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Re-config menu (T3b). When an already-valid config exists, the wizard
// offers to edit a key, add a Provider, remove a Provider, change the
// fallback preference, re-run the full wizard, or cancel.
// ---------------------------------------------------------------------------

/**
 * The re-config menu options. `Cancel` exits 0 without modifying the
 * config; `ReRun` delegates to the fresh flow (replacing the live file).
 */
type ReconfigChoice =
  | "edit-key"
  | "add-provider"
  | "remove-provider"
  | "change-fallback"
  | "edit-routing"
  | "rerun-full"
  | "cancel";

/**
 * Offer the re-config menu when an already-valid config exists. Each
 * menu action re-uses the T3a ask-key → input → validate loop where
 * applicable; editing a Provider key resets that Provider's
 * `verification.status` to `unverified` (Doctor re-promotes after a
 * successful probe).
 *
 * The menu loops until the user picks `cancel` or `rerun-full` (which
 * exits the loop and either returns 0 or delegates to the fresh flow).
 */
async function runReconfigMenu(
  deps: InitDependencies,
  config: ScoutlineConfig,
  filePath: string,
): Promise<number> {
  const configuredIds = Object.keys(config.providers).filter((id) => {
    const provider = config.providers[id as ProviderId];
    return provider && typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
  }) as ProviderId[];

  const fallbackLine =
    config.fallbackEnabled === undefined
      ? "fallback: default (true)"
      : `fallback: ${config.fallbackEnabled ? "enabled" : "disabled"}`;

  deps.writeStderr(
    [
      "",
      `scoutline is already set up at ${filePath}.`,
      `Providers configured: ${configuredIds.length === 0 ? "none" : configuredIds.join(", ")}.`,
      fallbackLine,
      "",
    ].join("\n"),
  );

  for (;;) {
    const action = await promptReconfigAction(deps, configuredIds);
    if (action === null) {
      // Cancel on the menu itself.
      return 1;
    }
    if (action === "cancel") {
      deps.writeStderr("No changes made.\n");
      return 0;
    }
    if (action === "rerun-full") {
      deps.writeStderr(
        "Re-running the full onboarding flow. The live config will be replaced atomically.\n",
      );
      return runFreshFlow(deps);
    }

    // Mutating actions: each returns the next config (or null on cancel).
    const next = await applyReconfigAction(deps, action, config, configuredIds);
    if (next === "write-error") {
      return 1;
    }
    if (next === "loop") {
      // The action was a no-op (e.g. user backed out of a sub-prompt);
      // re-render the menu.
      continue;
    }
    if (next === "cancel") {
      deps.writeStderr("No changes made.\n");
      return 0;
    }
    // next === "written": the action mutated and persisted the config.
    // Re-render the menu so the user can take another action.
    configuredIds.length = 0;
    const fresh = await deps.configStore.inspect();
    if (fresh.status === "valid") {
      for (const id of Object.keys(fresh.config.providers)) {
        const provider = fresh.config.providers[id as ProviderId];
        if (provider && typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0) {
          configuredIds.push(id as ProviderId);
        }
      }
      // Mirror mutations into the local `config` reference so the next
      // iteration sees the latest state.
      Object.assign(config, fresh.config);
    }
  }
}

/**
 * Render the re-config menu and return the chosen action. Returns
 * `null` on cancel (Ctrl+C / EOF).
 */
async function promptReconfigAction(
  deps: InitDependencies,
  configuredIds: readonly ProviderId[],
): Promise<ReconfigChoice | null> {
  const choices: InitChoice<ReconfigChoice>[] = [];
  if (configuredIds.length > 0) {
    choices.push({
      value: "edit-key",
      name: "Edit a provider key",
      description: "Replace an existing API key (resets verification to unverified)",
    });
    choices.push({
      value: "remove-provider",
      name: "Remove a provider",
      description: "Drop a provider entry from the config",
    });
  }
  choices.push({
    value: "add-provider",
    name: "Add a provider",
    description: "Run the per-provider flow for a provider not yet configured",
  });
  choices.push({
    value: "change-fallback",
    name: "Change fallback preference",
    description: "Toggle the Provider-fallback flag (currently consulted at runtime)",
  });
  choices.push({
    value: "edit-routing",
    name: "Edit routing table",
    description: "Set per-capability provider preferences (search: tavily,brave)",
  });
  choices.push({
    value: "rerun-full",
    name: "Re-run full onboarding",
    description: "Discard the current config and start the wizard from scratch",
  });
  choices.push({ value: "cancel", name: "Cancel", description: "Exit without changes" });

  try {
    return await deps.prompts.select<ReconfigChoice>("What would you like to do?", choices);
  } catch {
    return null;
  }
}

/**
 * Apply a single mutating re-config action. Persists the result via the
 * store and returns a status the caller uses to decide whether to
 * re-render the menu, exit, or loop.
 *
 *   - "written": the config was mutated + persisted successfully.
 *   - "loop": the user backed out of a sub-prompt (no mutation); re-render.
 *   - "cancel": the user explicitly cancelled; exit 0.
 *   - "write-error": the atomic write failed; exit 1.
 */
async function applyReconfigAction(
  deps: InitDependencies,
  action: Exclude<ReconfigChoice, "cancel" | "rerun-full">,
  config: ScoutlineConfig,
  configuredIds: readonly ProviderId[],
): Promise<"written" | "loop" | "cancel" | "write-error"> {
  if (action === "change-fallback") {
    return changeFallback(deps, config);
  }
  if (action === "edit-routing") {
    return editRouting(deps, config);
  }
  if (action === "add-provider") {
    return addProvider(deps, config, configuredIds);
  }
  if (action === "remove-provider") {
    return removeProvider(deps, config, configuredIds);
  }
  // edit-key
  return editProviderKey(deps, config, configuredIds);
}

/**
 * Toggle the fallback flag. Reads the current value, asks the new
 * preference, and persists.
 */
async function changeFallback(
  deps: InitDependencies,
  config: ScoutlineConfig,
): Promise<"written" | "loop" | "cancel" | "write-error"> {
  const current = config.fallbackEnabled ?? true;
  try {
    const next = await deps.prompts.confirm(
      `Route automatically if the selected provider is unavailable? [${current ? "Y/n" : "y/N"}]`,
      current,
    );
    const updated: ScoutlineConfig = {
      ...config,
      providers: { ...config.providers },
      fallbackEnabled: next,
      // hintShown is intentionally preserved (re-config does not reset it;
      // only a fresh-write or re-init does).
      ...(config.hintShown !== undefined ? { hintShown: config.hintShown } : {}),
    };
    return persistConfig(deps, updated);
  } catch {
    return "loop";
  }
}

/**
 * Edit the per-capability routing table (routing-table plan). Shows the
 * current table, then reads `capability: provider1,provider2` lines
 * until a blank line. Lenient like the config loader: unknown
 * capabilities/providers warn and drop (valid lines still apply);
 * `capability:` with an empty value removes that entry; removing the
 * last entry drops the whole key. Cancel (Ctrl+C/EOF) on any input
 * loops back to the menu without writing.
 */
async function editRouting(
  deps: InitDependencies,
  config: ScoutlineConfig,
): Promise<"written" | "loop" | "cancel" | "write-error"> {
  const current = Object.entries(config.routing ?? {}).sort(([a], [b]) => a.localeCompare(b));
  deps.writeStderr(
    current.length === 0
      ? "\nCurrent routing table: (empty)\n"
      : `\nCurrent routing table:\n${current.map(([cap, ids]) => `  ${cap} → ${(ids ?? []).join(", ")}`).join("\n")}\n`,
  );
  deps.writeStderr(
    'Enter routing lines as "capability: provider1,provider2" (e.g. search: tavily,brave).\n' +
      "An empty value after the colon removes the capability. Blank line to finish.\n\n",
  );

  const capabilitySet = new Set<string>(PROVIDER_CAPABILITIES);
  const routing: Record<string, ProviderId[]> = {};
  for (const [cap, ids] of Object.entries(config.routing ?? {})) {
    routing[cap] = [...(ids ?? [])];
  }

  try {
    for (;;) {
      const line = (await deps.prompts.input("routing> ")).trim();
      if (line.length === 0) break;
      const sep = line.indexOf(":");
      if (sep <= 0) {
        deps.writeStderr(`  \u26a0\ufe0f  skipped "${line}" \u2014 expected "capability: provider1,provider2"\n`);
        continue;
      }
      const capability = line.slice(0, sep).trim();
      const value = line.slice(sep + 1).trim();
      if (!capabilitySet.has(capability)) {
        deps.writeStderr(`  \u26a0\ufe0f  unknown capability "${capability}" \u2014 skipped\n`);
        continue;
      }
      if (value.length === 0) {
        delete routing[capability];
        deps.writeStderr(`  \u2212 removed routing for ${capability}\n`);
        continue;
      }
      const ids: ProviderId[] = [];
      const seen = new Set<string>();
      for (const raw of value.split(",")) {
        const id = raw.trim().toLowerCase();
        if (id.length === 0) continue;
        if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
          deps.writeStderr(`  \u26a0\ufe0f  unknown provider "${id}" \u2014 dropped\n`);
          continue;
        }
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id as ProviderId);
        }
      }
      if (ids.length === 0) {
        deps.writeStderr(`  \u26a0\ufe0f  no valid providers on this line \u2014 ignored\n`);
        continue;
      }
      routing[capability] = ids;
      deps.writeStderr(`  \u2713 ${capability} \u2192 ${ids.join(", ")}\n`);
    }
  } catch {
    // Cancel on any input prompt: no mutation, back to the menu.
    return "loop";
  }

  const { routing: _oldRouting, ...rest } = config;
  void _oldRouting;
  const updated: ScoutlineConfig =
    Object.keys(routing).length > 0 ? { ...rest, routing } : rest;
  return persistConfig(deps, updated);
}

/**
 * Add a provider not yet configured. Reuses the T3a per-provider flow
 * (ask-key → input → validate). The new record joins the existing
 * `providers` map without disturbing the others.
 */
async function addProvider(
  deps: InitDependencies,
  config: ScoutlineConfig,
  configuredIds: readonly ProviderId[],
): Promise<"written" | "loop" | "cancel" | "write-error"> {
  const available = deps.descriptors.map((d) => d.id).filter((id) => !configuredIds.includes(id));
  if (available.length === 0) {
    deps.writeStderr("Every built-in provider is already configured.\n");
    return "loop";
  }
  const choices: InitChoice<ProviderId>[] = available.map((id) => ({
    value: id,
    name: providerMeta(id).label,
    description: providerMeta(id).probeCostsCredit
      ? "validation probe costs ~1 credit"
      : "validation probe is free",
  }));
  let providerId: ProviderId;
  try {
    providerId = await deps.prompts.select<ProviderId>("Add which provider?", choices);
  } catch {
    return "loop";
  }
  const descriptor = deps.descriptors.find((d) => d.id === providerId);
  if (!descriptor) {
    deps.writeStderr(`Provider "${providerId}" is not in the registry.\n`);
    return "loop";
  }
  // Reuse the T3a per-provider flow against an empty envKeyProviders so
  // the import offer is skipped (the user is ADDING; we do not auto-pull
  // from env here). The probe runs against the ephemeral candidate.
  const onboarding = await onboardSingleProvider(deps, providerId, []);
  if (onboarding === null) {
    return "loop";
  }
  if (onboarding === "skip") {
    return "loop";
  }
  const updated: ScoutlineConfig = {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: {
        apiKey: onboarding.apiKey,
        onboarded: true,
        verification: onboarding.verification,
      },
    },
    ...(config.hintShown !== undefined ? { hintShown: config.hintShown } : {}),
  };
  const status = persistConfig(deps, updated);
  if ((await status) === "written") {
    deps.writeStdout(
      `${providerMeta(providerId).label}: added (verification: ${onboarding.verification.status}).\n`,
    );
  }
  return status;
}

/**
 * Remove a configured provider. The user picks from the currently
 * configured set; the chosen entry is dropped from `providers`.
 */
async function removeProvider(
  deps: InitDependencies,
  config: ScoutlineConfig,
  configuredIds: readonly ProviderId[],
): Promise<"written" | "loop" | "cancel" | "write-error"> {
  if (configuredIds.length === 0) {
    deps.writeStderr("No providers are configured.\n");
    return "loop";
  }
  const choices: InitChoice<ProviderId | undefined>[] = configuredIds.map((id) => ({
    value: id,
    name: providerMeta(id).label,
  }));
  choices.push({ value: undefined, name: "Back" });
  let providerId: ProviderId | undefined;
  try {
    providerId = await deps.prompts.select<ProviderId | undefined>(
      "Remove which provider?",
      choices,
    );
  } catch {
    return "loop";
  }
  if (providerId === undefined) {
    return "loop";
  }
  try {
    const confirmed = await deps.prompts.confirm(
      `Remove ${providerMeta(providerId).label} from the config? [y/N]`,
      false,
    );
    if (!confirmed) {
      return "loop";
    }
  } catch {
    return "loop";
  }
  const nextProviders: Partial<Record<ProviderId, ProviderConfig>> = {
    ...config.providers,
  };
  delete nextProviders[providerId];
  const updated: ScoutlineConfig = {
    ...config,
    providers: nextProviders,
    ...(config.hintShown !== undefined ? { hintShown: config.hintShown } : {}),
  };
  const status = persistConfig(deps, updated);
  if ((await status) === "written") {
    deps.writeStdout(`${providerMeta(providerId).label}: removed.\n`);
  }
  return status;
}

/**
 * Edit (replace) a configured provider's key. Reuses the T3a per-provider
 * flow's validate step against the ephemeral candidate. Editing a key
 * RESETS that Provider's `verification.status` to `unverified` —
 * Doctor re-promotes after a successful probe (the probe the wizard
 * runs here does NOT promote because the wizard's probe is a
 * connectivity check, not a Doctor invocation).
 */
async function editProviderKey(
  deps: InitDependencies,
  config: ScoutlineConfig,
  configuredIds: readonly ProviderId[],
): Promise<"written" | "loop" | "cancel" | "write-error"> {
  if (configuredIds.length === 0) {
    deps.writeStderr("No providers are configured.\n");
    return "loop";
  }
  const choices: InitChoice<ProviderId | undefined>[] = configuredIds.map((id) => ({
    value: id,
    name: providerMeta(id).label,
  }));
  choices.push({ value: undefined, name: "Back" });
  let providerId: ProviderId | undefined;
  try {
    providerId = await deps.prompts.select<ProviderId | undefined>(
      "Edit which provider's key?",
      choices,
    );
  } catch {
    return "loop";
  }
  if (providerId === undefined) {
    return "loop";
  }
  const descriptor = deps.descriptors.find((d) => d.id === providerId);
  if (!descriptor) {
    deps.writeStderr(`Provider "${providerId}" is not in the registry.\n`);
    return "loop";
  }
  const meta = providerMeta(providerId);
  if (meta.probeCostsCredit) {
    deps.writeStderr(
      `${meta.label}: validating the new key costs ~1 credit against your account.\n`,
    );
  }
  let candidate: string;
  try {
    candidate = (
      await deps.prompts.password(`Paste the new ${meta.label} API key (input hidden):`)
    ).trim();
  } catch {
    return "loop";
  }
  // Reuse the T3a validate loop. The candidate is probed; on verified
  // we persist a verified record; on save-unverified we persist an
  // unverified record; on skip/cancel we re-render the menu.
  const result = await validateAndCollect(deps, descriptor, candidate);
  if (result === null) {
    return "loop";
  }
  if (result === "skip") {
    return "loop";
  }
  const updated: ScoutlineConfig = {
    ...config,
    providers: {
      ...config.providers,
      [providerId]: {
        apiKey: result.apiKey,
        onboarded: true,
        verification: result.verification,
      },
    },
    ...(config.hintShown !== undefined ? { hintShown: config.hintShown } : {}),
  };
  const status = persistConfig(deps, updated);
  if ((await status) === "written") {
    deps.writeStdout(
      `${meta.label}: key updated (verification: ${result.verification.status}). ` +
        `Run \`scoutline doctor\` to re-verify.\n`,
    );
  }
  return status;
}

/**
 * Persist a mutated config through the store. Returns `"written"` on
 * success or `"write-error"` on failure (the caller surfaces the exit
 * code). The atomic primitive guarantees no partial write reaches disk.
 */
async function persistConfig(
  deps: InitDependencies,
  config: ScoutlineConfig,
): Promise<"written" | "write-error"> {
  try {
    await deps.configStore.write(config);
    return "written";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.writeStderr(`Failed to write config: ${message}\n`);
    return "write-error";
  }
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
          // Stale-env-after-import warning (T3b edge case). The runtime
          // precedence rule is env > file: an env value still set at
          // runtime will keep winning over this imported file key, so
          // the saved key is effectively dormant until the env value is
          // removed. The wizard notes this so the user is not surprised
          // later. The env value still wins at runtime by design; the
          // wizard cannot unset it for the user.
          deps.writeStderr(
            `Note: env precedence means $${meta.envVar} will keep overriding the saved key at runtime. ` +
              `Unset it (or remove it from your shell profile) to make the saved key authoritative.\n`,
          );
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
  select: <T>(config: unknown, context: unknown) => Promise<T>;
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
    async select<T>(message: string, choices: readonly InitChoice<T>[]): Promise<T> {
      const inquirer = await loadInquirer();
      return inquirer.select<T>(
        {
          message,
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
