import { ConfigurationError } from "../../lib/errors.js";

export const ENV_NAMES = ["DEEPSEEK_API_KEY"] as const;

export function getDeepSeekApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.DEEPSEEK_API_KEY?.trim() || undefined;
}

export function requireDeepSeekApiKey(env: NodeJS.ProcessEnv): string {
  const key = getDeepSeekApiKey(env);
  if (!key) {
    throw new ConfigurationError(
      "DEEPSEEK_API_KEY environment variable is required",
      'export DEEPSEEK_API_KEY="your-deepseek-api-key"',
    );
  }
  return key;
}

export function isDeepSeekConfigured(env: NodeJS.ProcessEnv): boolean {
  return getDeepSeekApiKey(env) !== undefined;
}
