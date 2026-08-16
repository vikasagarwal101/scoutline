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
  unknownConfigKeyError,
  type FanoutNoticeContext,
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
  /**
   * Success-path notice channel (production: the invocation context's
   * `notice`, stderr). Used for registry-mandated warnings like the
   * fan-out cost sentence (search-fanout DESIGN D7) — visible in every
   * output mode while stdout stays data-only. Optional so presentation
   * doubles stay minimal.
   */
  readonly notify?: (message: string) => void;
  /**
   * Eligibility context (env + provider registry) the fan-out cost
   * notice needs to name only the routed providers that would actually
   * bill — the same arm set `resolveFanoutPlan` computes (review fix,
   * PR #36). Optional: without it the notice falls back to the blanket
   * sentence instead of naming raw routing entries.
   */
  readonly noticeContext?: FanoutNoticeContext;
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
  return capabilities
    .map((cap) => `${cap} → ${(routing[cap] ?? []).join(", ")}`)
    .join("\n");
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
  if (trimmed === "fanout") return config.fanout;
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
    // A typo'd routing capability is an unknown key here too — never a
    // silent "(not set)"; other unknown paths list the valid roots.
    throw path.trim().startsWith("routing.")
      ? unknownConfigKeyError(path)
      : new ValidationError(
          `Unknown config key "${path}".`,
          'Valid keys: routing, routing.<capability>, fallbackEnabled, fanout, providers.<id>. Run "scoutline config --help".',
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
  // Registry-mandated enable-time warning (fan-out cost sentence, D7):
  // emitted as a stderr notice so it reaches every output mode while
  // stdout stays data-only. The registry supplies the sentence for the
  // UPDATED config plus the eligibility context — with `routing.search`
  // set it names only the routed arms that are ELIGIBLE (configured ∩
  // search-capable, the same set `resolveFanoutPlan` computes) instead
  // of claiming ALL configured providers or naming raw routing entries
  // that would not bill (review fix, PR #36).
  const key = resolveConfigKey(path);
  if (key?.setTrueNotice !== undefined && raw === true) {
    deps.notify?.(key.setTrueNotice(updated, deps.noticeContext));
  }
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
  fanout                      true|false — the multi-provider search fan-out
                             switch (default false; enabling warns about the
                             billable cost — every configured search provider,
                             or the routing.search subset when routed).
                             Remove the standing switch with
                             \`scoutline config unset fanout\`.
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
        goes), the whole routing table, the fallbackEnabled switch, or
        the fanout switch.

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
  scoutline config set fanout true
  scoutline config unset routing.search
  scoutline config unset fanout
  scoutline config --help
`.trim();
