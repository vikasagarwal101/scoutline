import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PROVIDER_IDS, type ProviderId } from "../providers/types.js";
import { ConfigurationError } from "./errors.js";

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
}

export interface ConfigStoreOptions {
  readonly filePath?: string;
  readonly onWarning?: (warning: ConfigWarning) => void;
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

export type ConfigInspection =
  | { readonly status: "absent"; readonly filePath: string }
  | {
      readonly status: "valid";
      readonly filePath: string;
      readonly config: ScoutlineConfig;
      readonly warnings: readonly ConfigWarning[];
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
  readonly warnings: readonly ConfigWarning[];
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
  const warnings: ConfigWarning[] = [];
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

  return {
    config: {
      version: CONFIG_VERSION,
      ...(parsed.fallbackEnabled !== undefined
        ? { fallbackEnabled: parsed.fallbackEnabled as boolean }
        : {}),
      providers,
      ...(parsed.hintShown !== undefined ? { hintShown: parsed.hintShown as boolean } : {}),
    },
    warnings,
  };
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
    ((warning: ConfigWarning) => process.stderr.write(`Warning: ${warning.message}\n`));
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
    ((warning: ConfigWarning) => process.stderr.write(`Warning: ${warning.message}\n`));
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
