/**
 * Code Mode commands for tool chaining
 */

import * as fs from "node:fs/promises";
import { ZaiCodeModeClient } from "../lib/code-mode.js";
import { outputSuccess } from "../lib/output.js";
import { formatErrorOutput } from "../lib/errors.js";
import { silenceConsole, restoreConsole } from "../lib/silence.js";

export interface CodeRunOptions {
  timeout?: number;
  includeLogs?: boolean;
}

export async function runCodeFile(filePath: string, options: CodeRunOptions = {}): Promise<void> {
  const code = await fs.readFile(filePath, "utf8");

  silenceConsole();
  const codeClient = new ZaiCodeModeClient();
  try {
    const result = await codeClient.callToolChain(code, options.timeout);
    if (options.includeLogs) {
      outputSuccess(result);
    } else {
      outputSuccess(result.result);
    }
  } catch (error) {
    restoreConsole();
    console.error(formatErrorOutput(error));
    process.exit(1);
  } finally {
    await codeClient.close().catch(() => {});
    restoreConsole();
  }
}

export async function evalCode(code: string, options: CodeRunOptions = {}): Promise<void> {
  silenceConsole();
  const codeClient = new ZaiCodeModeClient();
  try {
    const result = await codeClient.callToolChain(code, options.timeout);
    if (options.includeLogs) {
      outputSuccess(result);
    } else {
      outputSuccess(result.result);
    }
  } catch (error) {
    restoreConsole();
    console.error(formatErrorOutput(error));
    process.exit(1);
  } finally {
    await codeClient.close().catch(() => {});
    restoreConsole();
  }
}

export async function printInterfaces(): Promise<void> {
  silenceConsole();
  const codeClient = new ZaiCodeModeClient();
  try {
    const interfaces = await codeClient.getAllInterfaces();
    outputSuccess(interfaces);
  } catch (error) {
    restoreConsole();
    console.error(formatErrorOutput(error));
    process.exit(1);
  } finally {
    await codeClient.close().catch(() => {});
    restoreConsole();
  }
}

export function printPromptTemplate(): void {
  outputSuccess(ZaiCodeModeClient.getPromptTemplate());
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
