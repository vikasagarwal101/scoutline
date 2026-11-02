import { ValidationError } from "./errors.js";

export type JudgeRoute = "openrouter" | "typesafe";

export interface JudgeDescriptor {
  readonly route: JudgeRoute;
  readonly endpoint: string;
  readonly requestedModel: string;
  readonly expectedResolvedModel: string;
  readonly questionRevision: string;
  readonly thresholdRevision: string;
  readonly uncertaintyRevision: string;
  readonly maxAttempts: 1;
  readonly allowFallbacks: false;
}

export function judgeDescriptor(route: JudgeRoute, model?: string): JudgeDescriptor {
  const profiles: Readonly<Record<JudgeRoute, Readonly<Record<string, string>>>> = {
    openrouter: { "typesafe/jev-1.14": "typesafe/jev-1.14-20261014", "typesafe/jev-1.13": "typesafe/jev-1.13-20260917" },
    typesafe: { "jev-1.13.0": "jev-1.13.0", "jev-1.14.0": "jev-1.14.0" },
  };
  if (route !== "openrouter" && route !== "typesafe") throw new ValidationError("Unsupported judge route.");
  const requestedModel = model ?? (route === "openrouter" ? "typesafe/jev-1.14" : "jev-1.13.0");
  if (!Object.hasOwn(profiles[route], requestedModel)) throw new ValidationError("Unsupported judge model.");
  return Object.freeze({
    route,
    endpoint: route === "openrouter" ? "https://openrouter.ai/api/v1/systemone" : "https://api.typesafe.ai/v1/systemone",
    requestedModel,
    expectedResolvedModel: profiles[route][requestedModel]!,
    questionRevision: "native-noul-attribution-v1",
    thresholdRevision: "trial-v1-p9-p1",
    uncertaintyRevision: "per-source-null-v1",
    maxAttempts: 1,
    allowFallbacks: false,
  });
}

export const JUDGE_ROUTE_DEFAULT = "openrouter" as const;

/** The finite supported request ids per route, recommended model first. */
export const JUDGE_ROUTE_MODELS: Readonly<Record<JudgeRoute, readonly string[]>> = {
  openrouter: ["typesafe/jev-1.14", "typesafe/jev-1.13"],
  typesafe: ["jev-1.13.0", "jev-1.14.0"],
};

/** The route's own credential environment variable. */
export function judgeRouteEnvVar(route: JudgeRoute): string {
  return route === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
}

export function judgeDefaultModel(route: JudgeRoute): string {
  return judgeDescriptor(route).requestedModel;
}

export interface JudgeSettings {
  route?: JudgeRoute;
  openrouter?: { model?: string; transmitConsent?: boolean; apiKey?: string };
  typesafe?: { model?: string; transmitConsent?: boolean; apiKey?: string };
}

export function resolveJudgeSettings(env: Readonly<Record<string, string | undefined>>, stored: unknown = undefined) {
  const parsed = parseJudgeSettings(stored);
  const route = (env.SCOUTLINE_JUDGE ?? parsed.route ?? "openrouter") as JudgeRoute;
  const profile = parsed[route];
  const descriptor = judgeDescriptor(route, env.SCOUTLINE_JUDGE_MODEL ?? profile?.model);
  if (env.SCOUTLINE_JUDGE_TRANSMIT !== undefined && env.SCOUTLINE_JUDGE_TRANSMIT !== "1" && env.SCOUTLINE_JUDGE_TRANSMIT !== "0") {
    throw new ValidationError("Invalid judge transmission consent.");
  }
  const consent = env.SCOUTLINE_JUDGE_TRANSMIT === undefined ? profile?.transmitConsent ?? false : env.SCOUTLINE_JUDGE_TRANSMIT === "1";
  if (!consent) return Object.freeze({ enabled: false as const, route, model: descriptor.requestedModel });
  const apiKey = env[route === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY"] ?? profile?.apiKey;
  if (!apiKey?.trim()) throw new ValidationError("Judge consent requires a selected-route API key. To select direct TypeSafe, set SCOUTLINE_JUDGE=typesafe or use init/config.");
  return Object.freeze({ enabled: true as const, route, model: descriptor.requestedModel, apiKey, descriptor });
}

export function parseJudgeSettings(value: unknown): JudgeSettings {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Invalid judge settings.");
  const input = value as Record<string, unknown>;
  const parsed: JudgeSettings = {};
  if (input.route !== undefined) {
    if (input.route !== "openrouter" && input.route !== "typesafe") throw new ValidationError("Unsupported judge route.");
    parsed.route = input.route;
  }
  for (const route of ["openrouter", "typesafe"] as const) {
    const raw = input[route];
    if (raw === undefined) continue;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(`Invalid judge ${route} profile.`);
    const profile = raw as Record<string, unknown>;
    const out: NonNullable<JudgeSettings[typeof route]> = {};
    if (profile.model !== undefined) {
      if (typeof profile.model !== "string" || !profile.model) throw new ValidationError(`Invalid judge ${route} model.`);
      judgeDescriptor(route, profile.model);
      out.model = profile.model;
    }
    if (profile.transmitConsent !== undefined) {
      if (typeof profile.transmitConsent !== "boolean") throw new ValidationError(`Invalid judge ${route} consent.`);
      out.transmitConsent = profile.transmitConsent;
    }
    if (profile.apiKey !== undefined) {
      if (typeof profile.apiKey !== "string" || !profile.apiKey.trim()) throw new ValidationError(`Invalid judge ${route} API key.`);
      out.apiKey = profile.apiKey;
    }
    for (const key of Object.keys(profile)) {
      if (key !== "model" && key !== "transmitConsent" && key !== "apiKey") throw new ValidationError(`Unknown judge ${route} field.`);
    }
    parsed[route] = out;
  }
  for (const key of Object.keys(input)) {
    if (key !== "route" && key !== "openrouter" && key !== "typesafe") throw new ValidationError("Unknown judge field.");
  }
  return parsed;
}

export function collectJudgeSecrets(env: Readonly<Record<string, string | undefined>>, stored: JudgeSettings = {}): string[] {
  return [...new Set([env.OPENROUTER_API_KEY, env.TYPESAFE_API_KEY, stored.openrouter?.apiKey, stored.typesafe?.apiKey].filter((value): value is string => typeof value === "string" && value.length > 0))];
}
