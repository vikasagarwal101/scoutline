import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Thin rule text every agent tool receives (PRD AC-9, owner-approved
 * 2026-09-08). Em-dashes and backticks are load-bearing — later tickets
 * hash this constant for the registration stamp and pin it byte-for-byte.
 */
export const RULE_TEXT = [
  "scoutline is installed — an agent-first CLI for web research",
  "with provider routing, caching, and provenance built in.",
  "Prefer it over raw curl/browser tools so results are",
  "reproducible and quotable. Reach for it whenever the task",
  "needs: web search (multi-provider, comparable), reading pages",
  "or PDFs, fetching with content digests, site crawls,",
  "multi-step research synthesis, archived/temporal lookups",
  "(Wayback), or page-change monitoring. `scoutline --help`",
  "lists the command surface; for flags, usage, and workflows,",
  "load the `scoutline` agent skill — it is the working guide.",
].join("\n");

export type AgentToolId =
  | "claude"
  | "opencode"
  | "codex"
  | "gemini"
  | "qwen"
  | "copilot"
  | "cursor";

export interface PointerSpec {
  kind: "line" | "block" | "jsonArray";
  target?: (home: string) => string;
}

export interface AgentTool {
  id: AgentToolId;
  /** Home-dir directory probe — production passes os.homedir(), tests inject roots. */
  detect: (home: string) => boolean;
  /** Dedicated thin-rules file we own wholesale. */
  rulesFile?: (home: string) => string;
  /** How we hook into the tool's shared config surface (absent = pointer-free / detect-only). */
  pointer?: PointerSpec;
  /** Real-copy skill destination (every tool row except detect-only cursor). */
  skillHome?: (home: string) => string;
  /** Set only on detect-only rows: printed instead of a registration prompt. */
  unsupportedNotice?: string;
}

function dirProbe(...segments: string[]): (home: string) => boolean {
  return (home) => {
    try {
      return fs.statSync(path.join(home, ...segments)).isDirectory();
    } catch {
      return false;
    }
  };
}

/**
 * Data-driven tool registry (DESIGN D1): widening support is a row, not a
 * code path. Cursor stays a row — detection + notice, no engines.
 */
export const AGENT_TOOLS: AgentTool[] = [
  {
    id: "claude",
    detect: dirProbe(".claude"),
    rulesFile: (home) => path.join(home, ".claude", "rules", "scoutline.md"),
    pointer: { kind: "line", target: (home) => path.join(home, ".claude", "CLAUDE.md") },
    skillHome: (home) => path.join(home, ".claude", "skills"),
  },
  {
    id: "opencode",
    detect: dirProbe(".config", "opencode"),
    rulesFile: (home) => path.join(home, ".config", "opencode", "rules", "scoutline.md"),
    pointer: {
      kind: "jsonArray",
      target: (home) => path.join(home, ".config", "opencode", "opencode.json"),
    },
    skillHome: (home) => path.join(home, ".config", "opencode", "skills"),
  },
  {
    id: "codex",
    detect: dirProbe(".codex"),
    pointer: { kind: "block", target: (home) => path.join(home, ".codex", "AGENTS.md") },
    skillHome: (home) => path.join(home, ".codex", "skills"),
  },
  {
    id: "gemini",
    detect: dirProbe(".gemini"),
    rulesFile: (home) => path.join(home, ".gemini", "rules", "scoutline.md"),
    pointer: { kind: "line", target: (home) => path.join(home, ".gemini", "GEMINI.md") },
    // Documented global skills home — antigravity/skills/ is legacy back-compat.
    skillHome: (home) => path.join(home, ".gemini", "config", "skills", "scoutline"),
  },
  {
    id: "qwen",
    detect: dirProbe(".qwen"),
    pointer: { kind: "block", target: (home) => path.join(home, ".qwen", "QWEN.md") },
    skillHome: (home) => path.join(home, ".qwen", "skills"),
  },
  {
    id: "copilot",
    detect: dirProbe(".copilot"),
    rulesFile: (home) => path.join(home, ".copilot", "instructions", "scoutline.instructions.md"),
    skillHome: (home) => path.join(home, ".copilot", "skills", "scoutline"),
  },
  {
    id: "cursor",
    detect: dirProbe(".cursor"),
    unsupportedNotice: "Cursor registration is unsupported until MCP server mode ships.",
  },
];
