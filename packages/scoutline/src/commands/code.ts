/**
 * Code Mode commands for tool chaining
 *
 * P1-07: each command returns a CommandResult instead of writing
 * directly to stdout/stderr. stdin is read through CommandContext rather
 * than the process stream. No Provider selection is added; Phase 0
 * Code Mode semantics (run, eval, logs, timeout, interfaces, prompt
 * template) are preserved.
 */

import * as fs from "node:fs/promises";
import { ZaiCodeModeClient } from "../lib/code-mode.js";
import type { CommandContext, CommandResult } from "../command-invocation.js";

export interface CodeRunOptions {
  timeout?: number;
  includeLogs?: boolean;
  /**
   * T2b — Credential view: resolved env (injected env + file keys)
   * forwarded to the Code Mode client so a wizard-written key
   * authorises transport without ambient state.
   */
  env?: NodeJS.ProcessEnv;
}

export async function runCodeFile(
  filePath: string,
  options: CodeRunOptions = {},
  context?: CommandContext,
): Promise<CommandResult> {
  const code = await fs.readFile(filePath, "utf8");

  const codeClient = new ZaiCodeModeClient({ env: options.env });
  try {
    const result = await codeClient.callToolChain(code, options.timeout);
    const data = options.includeLogs ? result : result.result;
    return { kind: "data", data };
  } finally {
    await codeClient.close().catch(() => {});
  }
}

export async function evalCode(
  code: string,
  options: CodeRunOptions = {},
  context?: CommandContext,
): Promise<CommandResult> {
  const codeClient = new ZaiCodeModeClient({ env: options.env });
  try {
    const result = await codeClient.callToolChain(code, options.timeout);
    const data = options.includeLogs ? result : result.result;
    return { kind: "data", data };
  } finally {
    await codeClient.close().catch(() => {});
  }
}

export async function printInterfaces(
  options: { env?: NodeJS.ProcessEnv } = {},
  context?: CommandContext,
): Promise<CommandResult> {
  const codeClient = new ZaiCodeModeClient({ env: options.env });
  try {
    const interfaces = await codeClient.getAllInterfaces();
    return { kind: "data", data: interfaces };
  } finally {
    await codeClient.close().catch(() => {});
  }
}

export function printPromptTemplate(context?: CommandContext): CommandResult {
  return { kind: "data", data: ZaiCodeModeClient.getPromptTemplate() };
}

// Help text
export const CODE_HELP = `
Code Mode - Execute TypeScript tool chains

Usage:
  scoutline code run <file> [options]
  scoutline code eval <code> [options]
  scoutline code interfaces
  scoutline code prompt

Options:
  --timeout <ms>   Execution timeout (default: 30000)
  --logs           Include console logs in output

Examples:
  scoutline code run ./chain.ts
  scoutline code eval "const r = await scoutline.zai.search.webSearchPrime({search_query:'ZAI'}); return r;"
  scoutline code interfaces
  scoutline code prompt
`.trim();
