import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PROVIDER_CAPABILITIES, PROVIDER_IDS, type ProviderId } from "../providers/types.js";
import { ConfigurationError, ValidationError } from "./errors.js";
import {
  withAsyncFileLock,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_STALE_MS,
} from "./async-file-lock.js";

export const CONFIG_VERSION = 1 as const;

export interface ProviderVerification {
  readonly status: "verified" | "unverified";
  readonly checkedAt: number;
  readonly reason?: string;
}

export interface ProviderConfig {
  readonly apiKey?: string;
  readonly onboarded?: boolean;
  readonly verification?: ProviderVerification;
}

export interface ScoutlineConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly fallbackEnabled?: boolean;
  readonly providers: Partial<Record<ProviderId, ProviderConfig>>;
  readonly hintShown?: boolean;
  /**
   * Per-capability routed provider preference (routing-table plan).
   * Keys are capability ids (validated against PROVIDER_CAPABILITIES);
   * values are ordered ProviderId lists. Validation is LENIENT at load
   * time: unknown ids/capabilities and malformed entries warn and drop
   * (never a load failure). An empty list is stored as absent. Absent
   * on configs written by older binaries (they rebuild from known
   * fields) — the documented drop trade-off.
   */
  readonly routing?: Readonly<Record<string, readonly ProviderId[]>>;
}

export interface ConfigStoreOptions {
  readonly filePath?: string;
  readonly onWarning?: (warning: AnyConfigWarning) => void;
}

export interface AtomicReplaceOptions {
  readonly platform?: NodeJS.Platform;
  readonly randomId?: () => string;
  readonly rename?: typeof fs.rename;
}

export interface WriteConfigOptions extends ConfigStoreOptions {
  readonly atomic?: AtomicReplaceOptions;
}

export interface ConfigWarning {
  readonly code: "UNKNOWN_PROVIDER";
  readonly providerId: string;
  readonly message: string;
}

/**
 * Routing-specific config warning: an unknown capability key or a
 * malformed routing list in config.json. Warn-and-drop like
 * UNKNOWN_PROVIDER — never a load failure.
 */
export interface RoutingConfigWarning {
  readonly code: "UNKNOWN_CAPABILITY";
  readonly capability: string;
  readonly message: string;
}

export type AnyConfigWarning = ConfigWarning | RoutingConfigWarning;

export type ConfigInspection =
  | { readonly status: "absent"; readonly filePath: string }
  | {
      readonly status: "valid";
      readonly filePath: string;
      readonly config: ScoutlineConfig;
      readonly warnings: readonly AnyConfigWarning[];
    }
  | {
      readonly status: "corrupt";
      readonly filePath: string;
      readonly error: ConfigurationError;
    };

export interface ConfigRootEnvironment {
  readonly SCOUTLINE_CONFIG_DIR?: string;
}

export interface ConfigRootPlatform {
  readonly homedir: string;
}

export function resolveConfigRootPure(
  env: ConfigRootEnvironment,
  platform: ConfigRootPlatform,
): string {
  return env.SCOUTLINE_CONFIG_DIR || path.join(platform.homedir, ".scoutline");
}

export function resolveConfigRoot(): string {
  return resolveConfigRootPure(
    { SCOUTLINE_CONFIG_DIR: process.env.SCOUTLINE_CONFIG_DIR },
    { homedir: os.homedir() },
  );
}

export function configFilePath(root = resolveConfigRoot()): string {
  return path.join(root, "config.json");
}

function emptyConfig(): ScoutlineConfig {
  return { version: CONFIG_VERSION, providers: {} };
}

interface ParsedConfig {
  readonly config: ScoutlineConfig;
  readonly warnings: readonly AnyConfigWarning[];
}

function corruptConfig(): ConfigurationError {
  return new ConfigurationError(
    "config.json is corrupt",
    "Run `scoutline init` to reconfigure, or fix/remove the file.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVerification(value: unknown): ProviderVerification | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw corruptConfig();
  const { status, checkedAt, reason } = value;
  if (
    (status !== "verified" && status !== "unverified") ||
    typeof checkedAt !== "number" ||
    !Number.isFinite(checkedAt) ||
    checkedAt < 0 ||
    (reason !== undefined && typeof reason !== "string")
  ) {
    throw corruptConfig();
  }
  return {
    status,
    checkedAt,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
  };
}

function parseProviderConfig(value: unknown): ProviderConfig {
  if (!isRecord(value)) throw corruptConfig();
  const { apiKey, onboarded } = value;
  if (
    (apiKey !== undefined && typeof apiKey !== "string") ||
    (onboarded !== undefined && typeof onboarded !== "boolean")
  ) {
    throw corruptConfig();
  }
  const verification = parseVerification(value.verification);
  return {
    ...(apiKey?.trim() ? { apiKey } : {}),
    ...(onboarded !== undefined ? { onboarded } : {}),
    ...(verification ? { verification } : {}),
  };
}

function parseConfig(contents: string): ParsedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw corruptConfig();
  }
  if (!isRecord(parsed)) throw corruptConfig();
  const version = parsed.version;
  if (version !== CONFIG_VERSION) {
    throw new ConfigurationError(
      `Unsupported config version ${String(version)}`,
      "Upgrade Scoutline to read this config file.",
    );
  }
  if (
    (parsed.fallbackEnabled !== undefined && typeof parsed.fallbackEnabled !== "boolean") ||
    (parsed.hintShown !== undefined && typeof parsed.hintShown !== "boolean") ||
    (parsed.providers !== undefined && !isRecord(parsed.providers))
  ) {
    throw corruptConfig();
  }

  const providers: Partial<Record<ProviderId, ProviderConfig>> = {};
  const warnings: AnyConfigWarning[] = [];
  for (const [providerId, value] of Object.entries(parsed.providers ?? {})) {
    if (!(PROVIDER_IDS as readonly string[]).includes(providerId)) {
      warnings.push({
        code: "UNKNOWN_PROVIDER",
        providerId,
        message: `Ignoring unknown provider "${providerId}" in config.json.`,
      });
      continue;
    }
    providers[providerId as ProviderId] = parseProviderConfig(value);
  }

  const routing = parseRoutingConfig(parsed.routing, warnings);

  return {
    config: {
      version: CONFIG_VERSION,
      ...(parsed.fallbackEnabled !== undefined
        ? { fallbackEnabled: parsed.fallbackEnabled as boolean }
        : {}),
      providers,
      ...(parsed.hintShown !== undefined ? { hintShown: parsed.hintShown as boolean } : {}),
      ...(routing !== undefined ? { routing } : {}),
    },
    warnings,
  };
}

/**
 * Lenient validation of the optional `routing` key (routing-table plan
 * DESIGN D4). Every failure mode warns and drops — a broken routing
 * table never prevents config load. Unknown provider ids inside a list
 * drop individually; unknown capability keys and malformed lists drop
 * whole entries; duplicates deduplicate preserving first occurrence;
 * an all-dropped or empty list leaves the key absent.
 */
function parseRoutingConfig(
  value: unknown,
  warnings: AnyConfigWarning[],
): Record<string, ProviderId[]> | undefined {
  const capabilitySet = new Set<string>(PROVIDER_CAPABILITIES);
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warnings.push({
      code: "UNKNOWN_CAPABILITY",
      capability: "routing",
      message: 'Ignoring malformed "routing" in config.json (expected an object of capability -> provider lists).',
    });
    return undefined;
  }
  let routing: Record<string, ProviderId[]> | undefined;
  for (const [capability, list] of Object.entries(value as Record<string, unknown>)) {
    if (!capabilitySet.has(capability)) {
      warnings.push({
        code: "UNKNOWN_CAPABILITY",
        capability,
        message: `Ignoring unknown capability "${capability}" in config.json routing.`,
      });
      continue;
    }
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
      warnings.push({
        code: "UNKNOWN_CAPABILITY",
        capability,
        message: `Ignoring malformed routing list for "${capability}" in config.json (expected an array of provider ids).`,
      });
      continue;
    }
    const ids: ProviderId[] = [];
    const seen = new Set<string>();
    for (const raw of list as string[]) {
      const id = raw.trim().toLowerCase();
      if (id.length === 0) continue;
      if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
        warnings.push({
          code: "UNKNOWN_PROVIDER",
          providerId: id,
          message: `Ignoring unknown provider "${id}" in config.json routing for "${capability}".`,
        });
        continue;
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id as ProviderId);
      }
    }
    if (ids.length > 0) {
      (routing ??= {})[capability] = ids;
    }
  }
  return routing;
}

export async function readConfig(options: ConfigStoreOptions = {}): Promise<ScoutlineConfig> {
  const file = options.filePath ?? configFilePath();
  let contents: string;
  try {
    contents = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    throw new ConfigurationError(
      "Unable to read config.json",
      "Run `scoutline init` to reconfigure, or fix/remove the file.",
    );
  }
  const parsed = parseConfig(contents);
  const onWarning =
    options.onWarning ??
    ((warning: AnyConfigWarning) => process.stderr.write(`Warning: ${warning.message}\n`));
  for (const warning of parsed.warnings) onWarning(warning);
  return parsed.config;
}

export async function inspectConfig(options: ConfigStoreOptions = {}): Promise<ConfigInspection> {
  const filePath = options.filePath ?? configFilePath();
  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent", filePath };
    }
    return {
      status: "corrupt",
      filePath,
      error: new ConfigurationError(
        "Unable to read config.json",
        "Run `scoutline init` to reconfigure, or fix/remove the file.",
      ),
    };
  }
  try {
    const parsed = parseConfig(contents);
    return { status: "valid", filePath, config: parsed.config, warnings: parsed.warnings };
  } catch (error) {
    return {
      status: "corrupt",
      filePath,
      error: error as ConfigurationError,
    };
  }
}

export async function atomicReplaceFile(
  filePath: string,
  contents: string | Uint8Array,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const root = path.dirname(filePath);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await fs.chmod(root, 0o700);

  const randomId = options.randomId ?? randomUUID;
  let tempPath: string | undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    tempPath = path.join(root, `.${path.basename(filePath)}.${process.pid}.${randomId()}.tmp`);
    try {
      handle = await fs.open(tempPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!handle || !tempPath) {
    throw new Error("Unable to allocate a unique atomic-write temp file");
  }

  let renamed = false;
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Node's rename maps to an atomic replacing rename on supported Windows
    // filesystems. If that guarantee is unavailable, fail closed: never unlink
    // the live config as a non-atomic fallback.
    await (options.rename ?? fs.rename)(tempPath, filePath);
    renamed = true;

    if (platform !== "win32") {
      const directory = await fs.open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await fs.unlink(tempPath).catch(() => {});
  }
}

export async function writeConfig(
  config: ScoutlineConfig,
  options: WriteConfigOptions = {},
): Promise<void> {
  const parsed = parseConfig(JSON.stringify(config));
  const onWarning =
    options.onWarning ??
    ((warning: AnyConfigWarning) => process.stderr.write(`Warning: ${warning.message}\n`));
  for (const warning of parsed.warnings) onWarning(warning);
  const payload = `${JSON.stringify(parsed.config, null, 2)}\n`;
  try {
    await atomicReplaceFile(options.filePath ?? configFilePath(), payload, options.atomic);
  } catch {
    throw new ConfigurationError(
      "Unable to write config.json",
      "Check the config directory permissions and try again.",
    );
  }
}


// ---------------------------------------------------------------------------
// Typed key registry (routing-table plan, Ticket 3) — the `config`
// command family's seam. Adding a settings key = adding one row below;
// get/set/unset, validation, and atomic persistence come for free.
// ---------------------------------------------------------------------------

/**
 * One settable/gettable settings surface. `parseValue` is STRICT: it
 * throws ValidationError on anything it cannot store verbatim-in-meaning
 * (contrast the lenient load-time warn-and-drop of parseConfig — an
 * explicit single-value command must not silently store a different
 * value than the user typed).
 */
export interface ConfigKeyDescriptor {
  /** Literal path, or a parameterized prefix for `match` handling. */
  readonly path: string;
  readonly gettable: boolean;
  readonly settable: boolean;
  /** true → `config get` redacts the value; `config set` refuses it. */
  readonly credential: boolean;
  readonly describe: string;
}

const KEY_FALLBACK_ENABLED: ConfigKeyDescriptor = {
  path: "fallbackEnabled",
  gettable: true,
  settable: true,
  credential: false,
  describe: "boolean — always-on provider fallback switch",
};

const KEY_ROUTING_TABLE: ConfigKeyDescriptor = {
  path: "routing",
  gettable: true,
  settable: false,
  credential: false,
  describe: "per-capability routed provider preference table",
};

const KEY_ROUTING_CAPABILITY: ConfigKeyDescriptor = {
  path: "routing.<capability>",
  gettable: true,
  settable: true,
  credential: false,
  describe: "ordered provider list for one capability (comma-separated)",
};

function providerKey(id: string): ConfigKeyDescriptor {
  return {
    path: `providers.${id}`,
    gettable: true,
    settable: false,
    credential: true,
    describe: `provider configuration for ${id} (view only; credentials redacted)`,
  };
}

/**
 * Sub-field path (`providers.zai.apiKey`): resolves so `set`/`unset`
 * refuse it as credential-bearing, but `get` reports it as unknown —
 * field paths are not a viewable surface, and returning the whole
 * provider object would misrepresent the request.
 */
function providerFieldKey(id: string): ConfigKeyDescriptor {
  return {
    path: `providers.${id}`,
    gettable: false,
    settable: false,
    credential: true,
    describe: `provider field under ${id} (credential-bearing; not a config surface)`,
  };
}

/**
 * Resolve a dotted settings path to its key descriptor, or null when
 * the path names no registered key (including internal fields like
 * `version`/`hintShown`, which are deliberately not config-command
 * surfaces).
 */
export function resolveConfigKey(path: string): ConfigKeyDescriptor | null {
  const trimmed = path.trim();
  if (trimmed === "fallbackEnabled") return KEY_FALLBACK_ENABLED;
  if (trimmed === "routing") return KEY_ROUTING_TABLE;
  if (trimmed.startsWith("routing.")) {
    // Capability-validated: `routing.serch` must not resolve — get/set/
    // unset agree that it is an unknown key, never a silent "(not set)".
    const capability = trimmed.slice("routing.".length);
    return (PROVIDER_CAPABILITIES as readonly string[]).includes(capability)
      ? KEY_ROUTING_CAPABILITY
      : null;
  }
  if (trimmed.startsWith("providers.")) {
    // Provider ids are validated against the registry: `providers.tylvy`
    // is an unknown key, not a misleading credential path. Sub-field
    // paths resolve to the field descriptor (credential refusal for
    // set/unset; get reports unknown rather than dumping the provider).
    const idMatch = /^providers\.([a-z0-9-]+)((?:\.[A-Za-z0-9-]+)+)?$/.exec(trimmed);
    if (idMatch?.[1] && (PROVIDER_IDS as readonly string[]).includes(idMatch[1])) {
      return idMatch[2] ? providerFieldKey(idMatch[1]) : providerKey(idMatch[1]);
    }
  }
  return null;
}

/**
 * Shared unknown-path error for the three config subcommands: a
 * `routing.<x>` path names the accepted capabilities (the specific
 * wording set/unset have always produced); any other unknown path
 * points at the family help.
 */
function unknownCapabilityError(capability: string): ValidationError {
  return new ValidationError(
    `Unknown capability "${capability}".`,
    `Use one of: ${PROVIDER_CAPABILITIES.join(", ")}.`,
  );
}

export function unknownConfigKeyError(path: string): ValidationError {
  const trimmed = path.trim();
  if (trimmed.startsWith("routing.")) {
    return unknownCapabilityError(trimmed.slice("routing.".length));
  }
  return new ValidationError(
    `Unknown config key "${trimmed}".`,
    'Run "scoutline config --help" for the settable keys.',
  );
}

/**
 * Serialize a config read-modify-write against overlapping processes.
 * The file replacement itself is atomic, but two concurrent
 * set/unset commands could otherwise read the same snapshot and the
 * later write would silently drop the earlier command's change. Same
 * advisory-lock pattern as cache writes (`async-file-lock.ts`); lock
 * failures propagate — failing loud beats silently losing a change.
 */
async function serializeConfigWrite<T>(
  options: ConfigKeyOptions,
  run: () => Promise<T>,
): Promise<T> {
  const dir = path.dirname(options.filePath ?? configFilePath());
  return withAsyncFileLock(dir, "config-write", run, {
    timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    staleMs: DEFAULT_LOCK_STALE_MS,
    timeoutLabel: "Config write",
  });
}

/** Strict parse of a `routing.<capability>` value: comma-separated ids. */
function parseRoutingValue(path: string, value: string): { capability: string; ids: ProviderId[] } {
  const capability = path.trim().slice("routing.".length);
  if (!new Set<string>(PROVIDER_CAPABILITIES).has(capability)) {
    throw unknownCapabilityError(capability);
  }
  const ids: ProviderId[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const id = raw.trim().toLowerCase();
    if (id.length === 0) continue;
    if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
      throw new ValidationError(
        `Unknown provider "${id}". Accepted provider IDs: ${PROVIDER_IDS.join(", ")}.`,
        `Accepted provider IDs: ${PROVIDER_IDS.join(", ")}.`,
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id as ProviderId);
    }
  }
  if (ids.length === 0) {
    throw new ValidationError(
      "Routing list must contain at least one provider id.",
      "Example: scoutline config set routing.search tavily,brave",
    );
  }
  return { capability, ids };
}

/** Options for the typed set/unset helpers (same surface as writeConfig). */
export interface ConfigKeyOptions extends WriteConfigOptions {}

/**
 * Set one registered key, strictly. Read-modify-write through the
 * existing atomic save path, with a round-trip guarantee: the stored
 * config re-parses (leniently, warning-free) to the same value.
 * Credential-bearing paths refuse with a pointer to `init` / env —
 * API keys never belong in command arguments (AGENTS.md).
 */
export async function setConfigValue(
  path: string,
  value: string,
  options: ConfigKeyOptions = {},
): Promise<ScoutlineConfig> {
  const key = resolveConfigKey(path);
  if (key === null) {
    throw unknownConfigKeyError(path);
  }
  if (!key.settable) {
    if (key.credential) {
      throw new ValidationError(
        `"${key.path}" is credential-bearing; API keys are never set via command arguments.`,
        "Use `scoutline init` or the provider's environment variable instead.",
      );
    }
    throw new ValidationError(
      `"${key.path}" is not settable.`,
      'Run "scoutline config --help" for the settable keys.',
    );
  }
  return serializeConfigWrite(options, async () => {
    const current = await readConfig(options);
    let next: ScoutlineConfig;
    if (key === KEY_FALLBACK_ENABLED) {
      const lowered = value.trim().toLowerCase();
      if (lowered !== "true" && lowered !== "false") {
        throw new ValidationError(
          `Invalid boolean "${value}".`,
          "Use one of: true, false.",
        );
      }
      next = { ...current, fallbackEnabled: lowered === "true" };
    } else {
      const { capability, ids } = parseRoutingValue(path, value);
      const routing = { ...current.routing, [capability]: ids };
      next = { ...current, routing };
    }
    const reparsed = parseConfig(JSON.stringify(next));
    if (reparsed.warnings.length > 0) {
      // Strictly validated values must round-trip warning-free; if they
      // ever do not, refuse rather than store something unexpected.
      throw new ValidationError(
        "Refusing to store a value that does not round-trip cleanly.",
        "This is an internal invariant failure; please report it.",
      );
    }
    await writeConfig(reparsed.config, options);
    return reparsed.config;
  });
}

/**
 * Unset one registered key: a routing capability removes that entry
 * (and the table itself when the last entry goes); `routing` removes
 * the whole table; `fallbackEnabled` removes the switch. Unsetting a
 * nonexistent entry fails — silence would look like success.
 */
export async function unsetConfigValue(
  path: string,
  options: ConfigKeyOptions = {},
): Promise<ScoutlineConfig> {
  const key = resolveConfigKey(path);
  if (key === null) {
    throw unknownConfigKeyError(path);
  }
  return serializeConfigWrite(options, async () => {
    const current = await readConfig(options);
    let next: ScoutlineConfig;
    const trimmed = path.trim();
    if (trimmed === "routing") {
      if (current.routing === undefined) {
        throw new ValidationError(
          '"routing" is not set.',
          "Nothing to unset.",
        );
      }
      const { routing: _drop, ...rest } = current;
      void _drop;
      next = rest;
    } else if (trimmed.startsWith("routing.")) {
      const capability = trimmed.slice("routing.".length);
      if (!new Set<string>(PROVIDER_CAPABILITIES).has(capability)) {
        throw unknownCapabilityError(capability);
      }
      if (current.routing?.[capability] === undefined) {
        throw new ValidationError(
          `"routing.${capability}" is not set.`,
          "Nothing to unset.",
        );
      }
      const routing = { ...current.routing };
      delete routing[capability];
      const { routing: _old, ...rest } = current;
      void _old;
      next = Object.keys(routing).length > 0 ? { ...rest, routing } : rest;
    } else if (trimmed === "fallbackEnabled") {
      if (current.fallbackEnabled === undefined) {
        throw new ValidationError('"fallbackEnabled" is not set.', "Nothing to unset.");
      }
      const { fallbackEnabled: _fb, ...rest } = current;
      void _fb;
      next = rest;
    } else {
      throw new ValidationError(
        `"${key.path}" is not unsettable via config.`,
        'Run "scoutline config --help" for the settable keys.',
      );
    }
    await writeConfig(next, options);
    return next;
  });
}

// ---------------------------------------------------------------------------
// Credential-view resolution (T2a — Plan A)
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of a Provider Descriptor that
 * {@link resolveEnvFromConfig} consumes. Keeping this a structural subset
 * (not the full `ProviderDescriptor`) lets the helper stay pure and
 * testable without importing transport-level types.
 */
export interface CredentialDescriptor {
  readonly id: string;
  isConfigured(env: NodeJS.ProcessEnv): boolean;
  /**
   * Environment-variable names this Provider reads to decide it is
   * configured. The FIRST entry is the canonical (primary) variable that
   * file-configured keys are written into; subsequent entries are
   * aliases that are checked but never populated from the file.
   */
  readonly credentialEnvVars?: readonly string[];
}

/**
 * Build the resolved environment view that shared commands see: the
 * injected `env` with file-configured API keys layered in for any
 * Provider that is NOT already configured via `env`.
 *
 * Precedence rules (Plan A — T2a):
 *   - **Env overrides file.** A non-blank key already present in `env`
 *     (including aliases like `ZAI_API_KEY`) wins; the file key for that
 *     Provider is not written. This preserves the documented alias
 *     precedence (`Z_AI_API_KEY` > `ZAI_API_KEY` > file key).
 *   - **`process.env` is never mutated.** The returned object is a fresh
 *     shallow copy; the caller owns its lifetime.
 *   - File keys are written into the Provider's CANONICAL variable
 *     (the first `credentialEnvVars` entry, e.g. `Z_AI_API_KEY` for zai)
 *     so the existing `resolveXApiKey` resolvers discover them without a
 *     new code path.
 *
 * A Provider with no matching descriptor, a blank file key, or no
 * `credentialEnvVars` is silently skipped.
 */
export function resolveEnvFromConfig(
  env: NodeJS.ProcessEnv,
  config: ScoutlineConfig,
  descriptors: readonly CredentialDescriptor[],
): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = { ...env };
  const byId = new Map(descriptors.map((d) => [d.id, d] as const));

  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    const fileKey = providerConfig.apiKey;
    if (typeof fileKey !== "string" || fileKey.trim().length === 0) continue;

    const descriptor = byId.get(providerId);
    if (!descriptor) continue;

    // Env wins: if the Provider is already configured through the
    // injected env (primary OR alias), the file key must not clobber it.
    if (descriptor.isConfigured(env)) continue;

    const canonical = descriptor.credentialEnvVars?.[0];
    if (typeof canonical !== "string" || canonical.length === 0) continue;

    // Only populate when the canonical slot is absent or blank in the
    // resolved view. This guards against an earlier iteration writing a
    // different Provider's alias into the same variable name (none exist
    // today, but the guard keeps the function total).
    const existing = resolved[canonical];
    if (typeof existing === "string" && existing.trim().length > 0) continue;

    resolved[canonical] = fileKey;
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Targeted read-modify-write mutations (T3b — verification promotion +
// hintShown persistence). These layer on top of {@link inspectConfig} +
// {@link writeConfig} so the wizard and doctor share the same atomic,
// 0600-permissioned write primitive as the fresh-onboarding path. Each
// helper re-reads the live config before mutating so a concurrent
// onboarding write does not get clobbered; the atomic rename in
// {@link atomicReplaceFile} keeps the final state crash-safe.
// ---------------------------------------------------------------------------

/**
 * Injectable verification-promotion store. Doctor calls `promote` after
 * a successful Provider probe to flip the matching record from
 * `unverified` to `verified`. Production wires
 * {@link createDefaultVerificationPromoter} (real read-modify-write
 * against `~/.scoutline/config.json`); tests inject in-memory doubles
 * so the promotion assertions never touch real config-root I/O.
 *
 * Contract:
 *   - Only a Provider whose probe SUCCEEDED is promoted. Skipped,
 *     failed, no-tools, and network-deferred records are NOT promoted
 *     (Doctor's report still reflects the probe's authoritative status).
 *   - A record that is already `verified` (or absent, or has no
 *     verification record) is a no-op.
 *   - Write failure is surfaced through the returned promise so the
 *     caller can isolate it (Doctor logs and continues; the report
 *     stays unaffected).
 */
export interface VerificationPromotionStore {
  promote(providerId: ProviderId, checkedAt: number): Promise<void>;
}

/**
 * Production {@link VerificationPromotionStore}. Reads the live config,
 * flips the matching Provider record's `verification.status` from
 * `unverified` to `verified`, and rewrites the file atomically. A
 * record that is absent, has no verification field, or is already
 * `verified` is a no-op (no write, no error). The read-modify-write is
 * not cross-process locked; Doctor is a single-shot CLI command and the
 * atomic rename keeps the final state crash-safe against partial writes.
 */
export function createDefaultVerificationPromoter(
  options: WriteConfigOptions = {},
): VerificationPromotionStore {
  return {
    async promote(providerId, checkedAt) {
      const inspection = await inspectConfig(options);
      if (inspection.status !== "valid") return;
      const existing = inspection.config.providers[providerId];
      if (!existing || !existing.verification) return;
      if (existing.verification.status === "verified") return;
      const updated: ScoutlineConfig = {
        ...inspection.config,
        providers: {
          ...inspection.config.providers,
          [providerId]: {
            ...existing,
            verification: { status: "verified", checkedAt },
          },
        },
      };
      await writeConfig(updated, options);
    },
  };
}

/**
 * Injectable hint-shown store. Trigger detection calls `setHintShown`
 * once after emitting the env-only hint so the hint never repeats.
 * Production wires {@link createDefaultHintShownStore}; tests inject
 * in-memory doubles so the hint persistence assertions stay hermetic.
 *
 * Contract:
 *   - Absent / corrupt config is a no-op (no hint can be persisted when
 *     the config substrate is unavailable; the hint simply does not
 *     repeat within this process and is re-emitted on the next run
 *     after the user repairs via `init`).
 *   - `hintShown === true` already is a no-op.
 *   - `false → true` is the only write.
 */
export interface HintShownStore {
  setHintShown(): Promise<void>;
}

/**
 * Production {@link HintShownStore}. Reads the live config, sets
 * `hintShown: true` if it is currently unset/false, and rewrites the
 * file atomically. Same read-modify-write caveats as the verification
 * promoter.
 *
 * When the config is ABSENT, the store creates a minimal config file
 * (`{version:1, providers:{}, hintShown:true}`) so the hint does NOT
 * repeat on every subsequent run — the ticket's "one-time marker"
 * contract requires persistence, and absent-config is the common case
 * for a user who just installed scoutline and is running on env vars.
 * A CORRUPT config is a no-op (init is the recovery path; the hint
 * store must not silently rewrite a corrupt file).
 */
export function createDefaultHintShownStore(options: WriteConfigOptions = {}): HintShownStore {
  return {
    async setHintShown() {
      const inspection = await inspectConfig(options);
      if (inspection.status === "corrupt") return;
      if (inspection.status === "valid") {
        if (inspection.config.hintShown === true) return;
        const updated: ScoutlineConfig = {
          ...inspection.config,
          hintShown: true,
        };
        await writeConfig(updated, options);
        return;
      }
      // Absent — create a minimal config carrying just the marker so the
      // hint does not repeat. This is the common env-only-install case.
      await writeConfig({ version: CONFIG_VERSION, providers: {}, hintShown: true }, options);
    },
  };
}
