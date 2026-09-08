import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { atomicReplaceFile } from "../config-store.js";
import { resolveSkillSourceDir } from "../skill-source.js";
import { jsonArrayInsert, lineInsert, markerBlockInsert } from "./engines.js";
import { AGENT_TOOLS, RULE_TEXT, type AgentTool } from "./registry.js";

/** Stamp file recording the last registration (DESIGN D5). */
export const STAMP_NAME = "agent-registration.json";

/** claude reads rules through the `@rules/` include convention (D1). */
const CLAUDE_RULES_POINTER = "@rules/scoutline.md";

/**
 * Line-engine pointer strings per tool. Gemini's GEMINI.md import must
 * reference the rules file registration actually deploys — a bare relative
 * `.scoutline/...` path resolves against the CLI process CWD, not the user
 * home, and reaches nothing.
 */
const LINE_POINTERS: Record<string, string> = {
  claude: CLAUDE_RULES_POINTER,
  gemini: "@~/.gemini/rules/scoutline.md",
};

export interface RegistrationStamp {
  version: string;
  tools: string[];
  ruleTextHash: string;
}

export type AgentRulesChoice = Record<string, boolean>;

export function computeRuleTextHash(): string {
  return createHash("sha256").update(RULE_TEXT).digest("hex");
}

function toolRow(id: string): AgentTool | undefined {
  return AGENT_TOOLS.find((row) => row.id === id);
}

// The skill destination is `<skillHome>/scoutline`. Rows whose registry
// skillHome already ends at `/scoutline` (gemini, copilot) are final as-is;
// bare `skills` roots (claude, opencode, codex, qwen) get the package
// directory appended. pin("agent-registration")
const skillDest = (home: string, id: string): string | undefined => {
  const skillHome = toolRow(id)?.skillHome?.(home);
  if (skillHome === undefined) return undefined;
  return path.basename(skillHome) === "scoutline" ? skillHome : path.join(skillHome, "scoutline");
};

/** Real recursive copy — symlinks break claude's loader (DESIGN D3, AC-4). */
async function copyTree(source: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      // ponytail: the package skill tree carries no symlinks today; a future
      // symlinked asset would need explicit copy-through semantics here.
      throw new Error(`scoutline: refusing to deploy symlinked skill entry ${entry.name}`);
    }
    const from = path.join(source, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else await fs.copyFile(from, to);
  }
}

export async function deploySkills(options: {
  home: string;
  tools: readonly string[];
}): Promise<void> {
  const source = resolveSkillSourceDir();
  for (const id of options.tools) {
    const dest = skillDest(options.home, id);
    if (dest === undefined) continue;
    // Mirror, not merge: a stale file from an older skill tree must not
    // linger next to the fresh copy (AC-4 pins an exact file-set match).
    await fs.rm(dest, { recursive: true, force: true });
    await copyTree(source, dest);
  }
}

async function writeStamp(configRoot: string, stamp: RegistrationStamp): Promise<void> {
  await fs.mkdir(configRoot, { recursive: true });
  await atomicReplaceFile(
    path.join(configRoot, STAMP_NAME),
    JSON.stringify(stamp, null, 2),
  );
}

export async function readAgentRegistrationStamp(
  configRoot: string,
): Promise<RegistrationStamp | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(configRoot, STAMP_NAME), "utf8"));
  } catch {
    return undefined; // absent or unreadable — never fatal to the command
  }
}

/** Write dedicated rules files we own wholesale (D2 engine class 1). */
async function writeDedicatedRules(home: string, id: string): Promise<void> {
  const rulesFile = toolRow(id)?.rulesFile?.(home);
  if (rulesFile === undefined) return;
  await fs.mkdir(path.dirname(rulesFile), { recursive: true });
  await atomicReplaceFile(rulesFile, RULE_TEXT);
}

/** Hook the tool's shared config surface through its pointer engine (D2). */
async function writePointer(home: string, id: string, version: string): Promise<void> {
  const pointer = toolRow(id)?.pointer;
  if (pointer?.target === undefined) return;
  const target = pointer.target(home);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (pointer.kind === "line") {
    const line = LINE_POINTERS[id];
    if (line === undefined) throw new Error(`scoutline: no pointer line registered for ${id}`);
    await lineInsert({ filePath: target, line });
  } else if (pointer.kind === "block") {
    await markerBlockInsert({ filePath: target, content: RULE_TEXT, version });
  } else {
    await jsonArrayInsert({
      filePath: target,
      element: `${skillDest(home, id) ?? ""}/SKILL.md`,
    });
  }
}

export async function registerAgentTools(options: {
  home: string;
  configRoot: string;
  tools: readonly string[];
  version: string;
}): Promise<void> {
  const { home, configRoot, tools, version } = options;
  for (const id of tools) {
    await writeDedicatedRules(home, id);
    await writePointer(home, id, version);
  }
  await deploySkills({ home, tools });
  await writeStamp(configRoot, {
    version,
    tools: [...tools],
    ruleTextHash: computeRuleTextHash(),
  });
}

/**
 * Lazy stamp check (DESIGN D5): stamp-absent runs are zero-cost no-ops;
 * a `!==` drift (version or ruleTextHash) refreshes the registered tools —
 * skill always re-copied, rule files only when the text drifted. Honors
 * `agentRules` (opted-out tools are skipped entirely). Refresh failures are
 * per-tool stderr notices, never fatal.
 */
export async function checkAgentRegistration(options: {
  home: string;
  configRoot: string;
  version: string;
  agentRules?: AgentRulesChoice;
  writeStderr: (value: string) => void;
}): Promise<{ refreshed: boolean }> {
  const { home, configRoot, version, writeStderr } = options;
  const stamp = await readAgentRegistrationStamp(configRoot);
  if (stamp === undefined) return { refreshed: false };

  const tools = Array.isArray(stamp.tools) ? stamp.tools : [];
  const versionDrifted = stamp.version !== version;
  const textDrifted = tools.length > 0 && stamp.ruleTextHash !== computeRuleTextHash();
  if (!versionDrifted && !textDrifted) return { refreshed: false };

  let refreshed = false;
  for (const id of tools) {
    if (options.agentRules !== undefined && options.agentRules[id] === false) continue;
    try {
      await deploySkills({ home, tools: [id] });
      if (textDrifted) {
        await writeDedicatedRules(home, id);
        await writePointer(home, id, version);
      }
      refreshed = true;
    } catch (error) {
      writeStderr(
        `scoutline: agent registration refresh failed for ${id} — ${error instanceof Error ? error.message : String(error)} (command continues)`,
      );
    }
  }
  if (refreshed) {
    await writeStamp(configRoot, {
      version,
      tools,
      ruleTextHash: computeRuleTextHash(),
    });
  }
  return { refreshed };
}
