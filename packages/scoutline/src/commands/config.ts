/**
 * Config command — scriptable settings surface (routing-table plan,
 * Ticket 4).
 *
 * Presentation-only over the typed key registry in `src/lib/config-store.ts`
 * (Ticket 3): `resolveConfigKey` / `setConfigValue` / `unsetConfigValue`
 * own validation and atomic persistence. The dispatcher wires production
 * helpers; tests inject doubles.
 *
 * `get` output is ALWAYS redacted: values pass through `redactSecrets`
 * against the merged env's credential values, and credential-bearing
 * field names (e.g. `apiKey`) mask regardless — so a file-stored key is
 * never printable. `set` refuses credential paths outright at the
 * registry layer (API keys never ride argv, AGENTS.md).
 */

import type { CommandResult, TextOutputMode } from "../command-invocation.js";
import {
  resolveConfigKey,
  type ScoutlineConfig,
} from "../lib/config-store.js";
import { ValidationError } from "../lib/errors.js";
import { redactSecrets } from "../lib/redact.js";

// ---------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface ConfigGetDependencies {
  /** Read the current config (production: `readConfig`). */
  readonly read: () => Promise<ScoutlineConfig>;
  /** Credential values to redact against (production: `configuredSecrets(mergedEnv)`). */
  readonly secrets: () => string[];
}

export interface ConfigSetDependencies {
  /** Strict set (production: `setConfigValue`). */
  readonly set: (path: string, value: string) => Promise<ScoutlineConfig>;
}

export interface ConfigUnsetDependencies {
  /** Unset (production: `unsetConfigValue`). */
  readonly unset: (path: string) => Promise<ScoutlineConfig>;
}

// ---------------------------------------------------------------------------
// Presentation helpers (pure)
// ---------------------------------------------------------------------------

/** Render a routing table as human lines: `search → tavily, brave`. */
function formatRoutingLines(routing: Readonly<Record<string, readonly string[]>>): string {
  const capabilities = Object.keys(routing).sort();
  if (capabilities.length === 0) return "(routing table is empty)";
  return capabilities.map((cap) => `${cap} → ${routing[cap].join(", ")}`).join("\n");
}

/** Render one non-routing value: `key → value`. */
function formatScalar(path: string, value: unknown): string {
  if (value === undefined || value === null) return `${path} → (not set)`;
  return `${path} → ${typeof value === "string" ? value : JSON.stringify(value)}`;
}

function textPresentations(text: string): Partial<Record<TextOutputMode, string>> {
  return { compact: text, markdown: text, refs: text, tty: text };
}

/** Extract the raw (pre-redaction) value a resolved path points at. */
function valueAtPath(config: ScoutlineConfig, path: string): unknown {
  const trimmed = path.trim();
  if (trimmed === "routing") return config.routing;
  if (trimmed.startsWith("routing.")) return config.routing?.[trimmed.slice("routing.".length)];
  if (trimmed === "fallbackEnabled") return config.fallbackEnabled;
  const providerMatch = /^providers\.([a-z0-9-]+)(?:\.[A-Za-z0-9-]+)*$/.exec(trimmed);
  if (providerMatch?.[1]) return config.providers[providerMatch[1] as keyof typeof config.providers];
  return undefined;
}

function presentationsFor(path: string, value: unknown): Partial<Record<TextOutputMode, string>> {
  if (path.trim() === "routing" && typeof value === "object" && value !== null) {
    return textPresentations(formatRoutingLines(value as Record<string, readonly string[]>));
  }
  return textPresentations(formatScalar(path, value));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * `config get [path]`. No path → the full redacted config. With a path
 * → the redacted value at that path. Unknown paths fail with the valid
 * roots listed.
 */
export async function configGetCommand(
  path: string | undefined,
  deps: ConfigGetDependencies,
): Promise<CommandResult<unknown>> {
  const config = await deps.read();
  const secrets = deps.secrets();
  if (path === undefined || path.trim().length === 0) {
    const redacted = redactSecrets(config, secrets);
    return { kind: "data", data: redacted };
  }
  const key = resolveConfigKey(path);
  if (key === null || !key.gettable) {
    throw new ValidationError(
      `Unknown config key "${path}".`,
      'Valid keys: routing, routing.<capability>, fallbackEnabled, providers.<id>. Run "scoutline config --help".',
    );
  }
  const raw = valueAtPath(config, path);
  const redacted = redactSecrets(raw ?? null, secrets);
  return {
    kind: "data",
    data: redacted,
    presentations: presentationsFor(path, redacted),
  };
}

/**
 * `config set <path> <value>`. Strict validation and credential
 * refusal live in `setConfigValue`; this layer formats the result.
 */
export async function configSetCommand(
  path: string,
  value: string,
  deps: ConfigSetDependencies,
): Promise<CommandResult<{ path: string; value: unknown }>> {
  const updated = await deps.set(path, value);
  const raw = valueAtPath(updated, path);
  return {
    kind: "data",
    data: { path: path.trim(), value: raw },
    presentations: presentationsFor(path, raw),
  };
}

/**
 * `config unset <path>`. Removal semantics live in `unsetConfigValue`.
 */
export async function configUnsetCommand(
  path: string,
  deps: ConfigUnsetDependencies,
): Promise<CommandResult<{ path: string }>> {
  await deps.unset(path);
  return {
    kind: "data",
    data: { path: path.trim() },
    presentations: textPresentations(`${path.trim()} → (not set)`),
  };
}

export const CONFIG_HELP = `
Config - Inspect and change scoutline settings

Usage:
  scoutline config get [key]          # view settings (always redacted)
  scoutline config set <key> <value>  # change a setting (strict validation)
  scoutline config unset <key>        # remove a setting

Keys:
  routing                     The per-capability provider preference table
                             (view). Example: search → tavily, brave
  routing.<capability>        Ordered provider list for one capability.
                             Example: scoutline config set routing.search tavily,brave
  fallbackEnabled             true|false — the always-on provider fallback switch.
  providers.<id>              Provider configuration (view only; credential
                             values are always masked).

Behaviour:
  get   Prints the whole (redacted) config when no key is given.
        Credential values never appear in any output mode.
  set   Validates strictly: a typo'd provider or capability fails with the
        accepted list instead of storing something different. Credential-
        bearing keys cannot be set here — use "scoutline init" or the
        provider's environment variable (API keys never belong in command
        arguments).
  unset Removes a routing capability (and the table when the last entry
        goes), the whole routing table, or the fallbackEnabled switch.

Routing semantics: when no --provider / SCOUTLINE_PROVIDER pin exists,
the routed list orders provider selection for that capability — the
first configured, capable provider in the list wins, even over quota
ranking. Explicit pins always override routing.

Exit codes:
  0  Success.
  1  Unknown key, invalid value, or credential-path refusal (JSON error
     envelope on stderr).

Examples:
  scoutline config get
  scoutline config get routing
  scoutline config set routing.search tavily,brave
  scoutline config set fallbackEnabled false
  scoutline config unset routing.search
  scoutline config --help
`.trim();
