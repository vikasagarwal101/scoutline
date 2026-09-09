/**
 * Agent registration — init wizard step, agentRules config key, --unregister.
 *
 * Grounds: TASKS T5 bullets; DESIGN D4 (one wizard step after state
 * detection, independent of fresh-vs-reconfig dispatch — reconfig users are
 * the primary audience; per-detected-tool confirm prompt default yes via the
 * existing injectable prompt IO seam; notice-only rows print their notice,
 * no prompt; choices persist to additive config key `agentRules` — object
 * map, not boolean; `--unregister` runs the reversal + removes stamp +
 * clears `agentRules`), D2 (--unregister scans disk itself: deletes owned
 * files by fixed registry paths, strips lines/blocks by our markers,
 * removes array entries by exact string; NEVER restore from the
 * `.scoutline-bak` — marker-strip always, restore never; backup is bounded,
 * unregister deletes it, re-register re-mints against current bytes),
 * D6 (src/commands/init.ts one wizard step + flag; config-store additive
 * key + validator), PRD AC-6 (per-detected-tool confirm, default register;
 * undetected skipped silently; cursor → honest unsupported report),
 * AC-8 (init --unregister reverses everything, backup-compare pin).
 *
 * Module contract under test (the seam this file defines for GREEN):
 *   - `InitDependencies` and `MainDependencies` gain an injectable
 *     `agentRegistrationRoots?: { home: string; configRoot: string }`
 *     (production default `os.homedir()` + `resolveConfigRoot()`; tests
 *     inject temp roots — no real HOME or ~/.scoutline is ever probed).
 *     The wizard step consumes it for detection + registration; the
 *     `init --unregister` dispatch consumes it for the disk-scan reversal.
 *   - `--unregister` clears `agentRules` through the injected
 *     `initConfigStore` seam (same store the wizard uses).
 *   - `config-store` accepts/validates `agentRules` as an additive
 *     optional key: `Record<string, boolean>`; wrong top-level type or a
 *     non-boolean value is corrupt config (the `fanout` boolean precedent,
 *     DESIGN D6).
 *
 * Coexistence bullet (conditional, T5): Lane C's journal prompt has NOT
 * landed in this tree — per the ticket, this file pins agent-rules step
 * presence + placement only; the journal/agent-rules coexistence pin is
 * added at merge-train integration.
 *
 * Hermetic: every test runs against injected temp home/config roots; the
 * main()-driven tests inject a no-op `agentRegistrationCheck` double so the
 * production stamp check never probes ambient state; zero network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { handleInitWithHelp, createDefaultConfigStore } from "../dist/commands/init.js";
import { inspectConfig, writeConfig } from "../dist/lib/config-store.js";
import { RULE_TEXT, AGENT_TOOLS } from "../dist/lib/agent-registration/registry.js";
import { START_MARKER, END_MARKER } from "../dist/lib/agent-registration/engines.js";
import {
  registerAgentTools,
  checkAgentRegistration,
  computeRuleTextHash,
} from "../dist/lib/agent-registration/deploy.js";

const FIXED_NOW = 1_700_000_000_000;
const STAMP_NAME = "agent-registration.json";

const ALL_SIX = ["claude", "opencode", "codex", "gemini", "qwen", "copilot"];

// Registry detect dirs (D1) and our owned/managed surfaces (AC-2).
const DETECT_DIR = {
  claude: [".claude"],
  opencode: [".config", "opencode"],
  codex: [".codex"],
  gemini: [".gemini"],
  qwen: [".qwen"],
  copilot: [".copilot"],
  cursor: [".cursor"],
};

const RULES_FILE = {
  claude: (home) => path.join(home, ".claude", "rules", "scoutline.md"),
  opencode: (home) => path.join(home, ".config", "opencode", "rules", "scoutline.md"),
  gemini: (home) => path.join(home, ".gemini", "rules", "scoutline.md"),
  copilot: (home) => path.join(home, ".copilot", "instructions", "scoutline.instructions.md"),
};

const SKILL_DEST = {
  claude: [".claude", "skills", "scoutline"],
  opencode: [".config", "opencode", "skills", "scoutline"],
  codex: [".codex", "skills", "scoutline"],
  gemini: [".gemini", "config", "skills", "scoutline"],
  qwen: [".qwen", "skills", "scoutline"],
  copilot: [".copilot", "skills", "scoutline"],
};

const skillDest = (home, id) => path.join(home, ...SKILL_DEST[id]);

// Pre-existing user bytes for shared surfaces (unregister fixtures).
const PRE_EXISTING = {
  claudeMd: "# my claude notes\nUse @rules/other.md too.\n",
  geminiMd: "# gemini global config\nSome existing @imports live here.\n",
  agentsMd: "# codex user notes\nKeep my formatting.\n",
  qwenMd: "# qwen notes\n",
  opencodeJson:
    '{\n  "$schema": "https://opencode.ai/config.json",\n  "instructions": ["./global.md", "./security.md"],\n  "model": "anthropic/claude-sonnet"\n}\n',
  // No-trailing-newline variants (AC-8 reversal byte-symmetry: a pre-existing
  // file whose last byte is NOT \n must round-trip byte-identically too —
  // the newline-joining asymmetry the EOL fixtures leave unpinned).
  claudeMdNoEol: "# my claude notes\nUse @rules/other.md too.",
  qwenMdNoEol: "# qwen notes",
  opencodeJsonEmpty: '{"instructions":[]}',
};

async function mkTemp(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function mkHome(t, ids) {
  const home = await mkTemp(t, "scoutline-agent-home-");
  for (const id of ids) {
    await fs.mkdir(path.join(home, ...DETECT_DIR[id]), { recursive: true });
  }
  return home;
}

async function read(p) {
  return fs.readFile(p, "utf8");
}

async function assertAbsent(p, message) {
  await assert.rejects(
    fs.stat(p),
    (error) => error.code === "ENOENT",
    message ?? `${p} must not exist`,
  );
}

/** Every `*.scoutline-bak` under root (recursive), for boundedness pins. */
async function findBackups(root) {
  const found = [];
  async function rec(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await rec(full);
      else if (entry.name.endsWith(".scoutline-bak")) found.push(full);
    }
  }
  try {
    await rec(root);
  } catch {
    /* absent root — no backups */
  }
  return found;
}

async function writeStamp(configRoot, stamp) {
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(path.join(configRoot, STAMP_NAME), JSON.stringify(stamp));
}

// ---------------------------------------------------------------------------
// Prompt double: records kind + message order (placement pins) and answers
// confirms by tool id (order-independent across registry rows).
// ---------------------------------------------------------------------------

function createRecordingPrompts({
  confirmHandler,
  checkboxAnswer = null, // null → cancel at the checklist (wizard exits 1)
  selectAnswer = "cancel",
  selectAnswers = null, // ordered queue; the last answer repeats
  passwordAnswer = "zai-secret",
} = {}) {
  const log = [];
  const confirmCalls = [];
  const queue = selectAnswers === null ? null : [...selectAnswers];
  const prompts = {
    async checkbox(message) {
      log.push({ kind: "checkbox", message });
      if (checkboxAnswer === null) throw new Error("cancel");
      return checkboxAnswer;
    },
    async select(message) {
      log.push({ kind: "select", message });
      if (queue === null) return selectAnswer;
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    async confirm(message, defaultYes) {
      log.push({ kind: "confirm", message, defaultYes });
      confirmCalls.push({ message, defaultYes });
      return confirmHandler ? confirmHandler(message, defaultYes) : true;
    },
    async password(message) {
      log.push({ kind: "password", message });
      return passwordAnswer;
    },
    async input(message) {
      log.push({ kind: "input", message });
      return "";
    },
  };
  return { prompts, log, confirmCalls };
}

/** Answer confirms per tool id mentioned in the prompt; everything else yes. */
function confirmByTool(choices) {
  return (message) => {
    for (const [tool, answer] of Object.entries(choices)) {
      if (message.includes(tool)) return answer;
    }
    return true;
  };
}

// Minimal fake provider descriptor (no network): one diagnostics probe that
// resolves — the same double shape tests/init.test.js uses.
function fakeZaiDescriptor() {
  return {
    id: "zai",
    credentialEnvVars: ["Z_AI_API_KEY"],
    isConfigured: () => false,
    capabilities: () => new Set(["search", "diagnostics"]),
    create: () => ({
      id: "zai",
      diagnostics: { async invoke() {} },
    }),
  };
}

function createWizardDeps({ prompts, configFilePath, home, configRoot, descriptors = [] }) {
  const stderrChunks = [];
  const stdoutChunks = [];
  const deps = {
    descriptors,
    prompts,
    configStore: createDefaultConfigStore({ filePath: configFilePath }),
    env: {},
    now: () => FIXED_NOW,
    stdinIsTTY: true,
    writeStderr: (v) => stderrChunks.push(v),
    writeStdout: (v) => stdoutChunks.push(v),
    agentRegistrationRoots: { home, configRoot },
  };
  return { deps, stderrChunks, stdoutChunks };
}

function createMainDeps({ configFilePath, home, configRoot }) {
  const stdout = [];
  const stderr = [];
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: () => {},
  };
  const deps = {
    invocation: adapter,
    env: {},
    loadScoutlineConfig: () => {
      throw new Error("Should not be called!");
    },
    agentRegistrationCheck: async () => ({ refreshed: false }),
    initConfigStore: createDefaultConfigStore({ filePath: configFilePath }),
    agentRegistrationRoots: { home, configRoot },
  };
  return { deps, stdout, stderr };
}

/** Register all six tools against pre-existing shared files (unregister world). */
async function registerWorld(home, configRoot) {
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), PRE_EXISTING.claudeMd);
  await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
  await fs.writeFile(path.join(home, ".gemini", "GEMINI.md"), PRE_EXISTING.geminiMd);
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  await fs.writeFile(path.join(home, ".codex", "AGENTS.md"), PRE_EXISTING.agentsMd);
  await fs.mkdir(path.join(home, ".qwen"), { recursive: true });
  await fs.writeFile(path.join(home, ".qwen", "QWEN.md"), PRE_EXISTING.qwenMd);
  await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".config", "opencode", "opencode.json"),
    PRE_EXISTING.opencodeJson,
  );
  await fs.mkdir(path.join(home, ".copilot"), { recursive: true });

  await registerAgentTools({ home, configRoot, tools: ALL_SIX, version: "9.9.9" });

  const configPath = path.join(configRoot, "config.json");
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      providers: { zai: { apiKey: "prior-key" } },
      agentRules: {
        claude: true,
        opencode: false,
        codex: true,
        gemini: true,
        qwen: true,
        copilot: true,
      },
    }),
  );
  return { configPath };
}

// ---------------------------------------------------------------------------
// agentRules additive config key + validator (DESIGN D6, PRD AC-6)
// ---------------------------------------------------------------------------

describe("agentRules config key (DESIGN D6: additive optional key + validator)", () => {
  it("writeConfig round-trips agentRules as a Record<toolId, boolean> object map", async (t) => {
    // GROUND: T5 "agentRules persisted (additive config key, validator)";
    // DESIGN D4 "object map, not boolean" — the `fanout?: boolean` precedent.
    const dir = await mkTemp(t, "scoutline-agent-config-");
    const filePath = path.join(dir, "config.json");
    await writeConfig(
      { version: 1, providers: {}, agentRules: { claude: true, codex: false } },
      { filePath },
    );
    const inspection = await inspectConfig({ filePath });
    assert.equal(inspection.status, "valid", "an object-map agentRules must load as valid config");
    assert.deepEqual(
      inspection.config.agentRules,
      { claude: true, codex: false },
      "agentRules must survive the write→parse round-trip (parseConfig must carry it)",
    );
  });

  it("a non-object agentRules value is corrupt config (validator)", async (t) => {
    // GROUND: DESIGN D6 "additive optional key + validator" — same strictness
    // as `fanout` being a non-boolean (config-store parseConfig precedent).
    const dir = await mkTemp(t, "scoutline-agent-config-");
    const filePath = path.join(dir, "config.json");
    await fs.writeFile(
      filePath,
      '{"version":1,"providers":{},"agentRules":"yes-to-all"}',
    );
    const inspection = await inspectConfig({ filePath });
    assert.equal(inspection.status, "corrupt", "a string agentRules must be rejected, not dropped");
  });

  it("a non-boolean per-tool value is corrupt config (validator)", async (t) => {
    // GROUND: PRD AC-6 '"agentRules": { <toolId>: bool }' — value types are
    // validated, not silently accepted.
    const dir = await mkTemp(t, "scoutline-agent-config-");
    const filePath = path.join(dir, "config.json");
    await fs.writeFile(
      filePath,
      '{"version":1,"providers":{},"agentRules":{"claude":"yes"}}',
    );
    const inspection = await inspectConfig({ filePath });
    assert.equal(inspection.status, "corrupt", "a non-boolean agentRules value must be rejected");
  });
});

// ---------------------------------------------------------------------------
// Wizard step — fresh onboarding path (DESIGN D4, PRD AC-6)
// ---------------------------------------------------------------------------

describe("wizard agent step: fresh onboarding path (DESIGN D4)", () => {
  it("detected tool gets a confirm prompt (default yes) BEFORE the provider checklist; yes registers it and persists agentRules into the final config", async (t) => {
    // GROUND: T5 "per-detected-tool confirm prompt (default yes) via
    // scripted-double IO seam — pinned for BOTH fresh onboarding and the
    // already-onboarded reconfig path (step runs after state detection)";
    // DESIGN D4 "one wizard step, placed after state detection"; PRD AC-6
    // "choices persist to additive config key agentRules".
    const home = await mkHome(t, ["claude"]);
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const script = createRecordingPrompts({
      confirmHandler: confirmByTool({ claude: true }),
      checkboxAnswer: ["zai"],
    });

    const { deps } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    const status = await handleInitWithHelp([], deps);

    assert.equal(status, 0);
    // Placement: the agent-rules confirm precedes the provider checklist.
    const agentConfirm = script.log.findIndex(
      (c) => c.kind === "confirm" && /claude/i.test(c.message),
    );
    const checklist = script.log.findIndex((c) => c.kind === "checkbox");
    assert.ok(agentConfirm !== -1, "a claude agent-rules confirm prompt must be issued");
    assert.ok(agentConfirm < checklist, "the agent step must run before the provider checklist");
    // Default yes (PRD AC-6 "default: register").
    const agentCall = script.confirmCalls[agentConfirm];
    assert.equal(agentCall.defaultYes, true, "the agent-rules confirm must default to yes");
    // Registration actually happened (wired through the T4 deploy module).
    assert.equal(await read(RULES_FILE.claude(home)), RULE_TEXT, "claude rules file must be written");
    assert.ok(
      (await fs.stat(path.join(skillDest(home, "claude"), "SKILL.md"))).isFile(),
      "the skill must be deployed to the claude skillHome",
    );
    const stamp = JSON.parse(await read(path.join(configRoot, STAMP_NAME)));
    assert.deepEqual(stamp.tools, ["claude"], "the stamp must record the registered tool");
    // Choices persist into the config the fresh flow finally writes.
    assert.deepEqual(JSON.parse(await read(path.join(configRoot, "config.json"))), {
      version: 1,
      fallbackEnabled: true,
      providers: {
        zai: {
          apiKey: "zai-secret",
          onboarded: true,
          verification: { status: "verified", checkedAt: FIXED_NOW },
        },
      },
      agentRules: { claude: true },
    });
  });

  it("the agent choice persists immediately — cancelling the fresh flow afterwards still leaves agentRules and the registration on disk", async (t) => {
    // GROUND: DESIGN D4 "confirm prompt ..., then register. Persisted to
    // additive config key agentRules" — the step owns its persistence; a
    // later wizard cancel is a config-flow cancel, not an agent-unregister.
    const home = await mkHome(t, ["claude"]);
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const script = createRecordingPrompts({
      confirmHandler: confirmByTool({ claude: true }),
      checkboxAnswer: null, // cancel at the provider checklist
    });

    const { deps } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    const status = await handleInitWithHelp([], deps);

    assert.equal(status, 1, "checkbox cancel is still a fresh-flow cancel (exit 1)");
    const config = JSON.parse(await read(path.join(configRoot, "config.json")));
    assert.deepEqual(config.agentRules, { claude: true }, "agentRules must already be persisted");
    assert.equal(await read(RULES_FILE.claude(home)), RULE_TEXT, "registration must already be on disk");
  });

  it("six detected tools get one confirm each (each naming its tool, all default yes); opt-outs are recorded but never registered; undetected tools are absent entirely", async (t) => {
    // GROUND: T5/AC-6 per-detected-tool prompt; "undetected tools never
    // prompt" is the companion pin (this fixture detects all six — the
    // zero-detection variant lives in the cursor describe below).
    const home = await mkHome(t, ALL_SIX);
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const choices = {
      claude: true,
      opencode: false,
      codex: true,
      gemini: false,
      qwen: true,
      copilot: true,
    };
    const script = createRecordingPrompts({
      confirmHandler: confirmByTool(choices),
      checkboxAnswer: null,
    });

    const { deps } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    await handleInitWithHelp([], deps);

    // One confirm per detected tool, each naming the tool, all default yes.
    assert.equal(script.confirmCalls.length, 6, "exactly one confirm per detected tool");
    for (const id of ALL_SIX) {
      const call = script.confirmCalls.find((c) => c.message.includes(id));
      assert.ok(call, `a confirm prompt must name ${id}`);
      assert.equal(call.defaultYes, true, `${id} confirm must default to yes`);
    }
    // Choices persist for every detected tool — opt-outs included.
    const config = JSON.parse(await read(path.join(configRoot, "config.json")));
    assert.deepEqual(config.agentRules, choices, "all six choices must persist, opt-outs included");
    // Opted-out tools are NOT registered (no rules file, no pointer surface).
    await assertAbsent(RULES_FILE.opencode(home), "opted-out opencode must get no rules file");
    await assertAbsent(
      path.join(home, ".config", "opencode", "opencode.json"),
      "opted-out opencode must get no instructions entry",
    );
    await assertAbsent(RULES_FILE.gemini(home), "opted-out gemini must get no rules file");
    await assertAbsent(path.join(home, ".gemini", "GEMINI.md"), "opted-out gemini must get no pointer");
    // Opted-in tools are registered.
    for (const id of ["claude", "codex", "qwen", "copilot"]) {
      assert.ok(
        (await fs.stat(path.join(skillDest(home, id), "SKILL.md"))).isFile(),
        `${id} must be registered`,
      );
    }
    const stamp = JSON.parse(await read(path.join(configRoot, STAMP_NAME)));
    assert.deepEqual(
      stamp.tools,
      ["claude", "codex", "qwen", "copilot"],
      "the stamp must record exactly the opted-in tools",
    );
  });
});

// ---------------------------------------------------------------------------
// Wizard step — already-onboarded reconfig path (DESIGN D4, PRD AC-6)
// ---------------------------------------------------------------------------

describe("wizard agent step: already-onboarded reconfig path (DESIGN D4)", () => {
  it("reconfig users reach the agent step BEFORE the re-config menu (no rerun-full needed); menu cancel still persists agentRules + registers, preserving existing providers", async (t) => {
    // GROUND: T5 "pinned for BOTH fresh onboarding and the already-onboarded
    // reconfig path (step runs after state detection; reconfig users reach it
    // without choosing rerun-full)"; DESIGN D4 "runReconfigMenu users are the
    // primary audience — a fresh-flow-only step would never reach them".
    const home = await mkHome(t, ["claude"]);
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const configPath = path.join(configRoot, "config.json");
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ version: 1, providers: { zai: { apiKey: "prior-key" } } }),
    );
    const script = createRecordingPrompts({
      confirmHandler: confirmByTool({ claude: true }),
      selectAnswer: "cancel", // exit the re-config menu without changes
    });

    const { deps } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: configPath,
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    const status = await handleInitWithHelp([], deps);

    assert.equal(status, 0, "menu cancel exits 0");
    // Placement: agent confirm precedes the menu select.
    const agentConfirm = script.log.findIndex(
      (c) => c.kind === "confirm" && /claude/i.test(c.message),
    );
    const menuSelect = script.log.findIndex((c) => c.kind === "select");
    assert.ok(agentConfirm !== -1, "the reconfig path must issue the agent-rules confirm");
    assert.ok(agentConfirm < menuSelect, "the agent step must run before the re-config menu");
    // The step persisted its choice + registered, providers untouched.
    const config = JSON.parse(await read(configPath));
    assert.deepEqual(config.agentRules, { claude: true }, "agentRules must persist on the reconfig path");
    assert.deepEqual(
      config.providers,
      { zai: { apiKey: "prior-key" } },
      "existing providers must survive the agent step write",
    );
    assert.equal(await read(RULES_FILE.claude(home)), RULE_TEXT, "registration must be on disk");
  });

  it("a mutating menu action persists agentRules — the reconfig menu must re-inspect the config the agent step just wrote (regression: stale pre-step config drops agentRules)", async (t) => {
    // GROUND: DESIGN D4 "choices persist to additive config key agentRules"
    // + the fresh-flow sibling (init.ts re-inspects before its final write so
    // "a fresh-flow rewrite must not drop them"). The agent step persists
    // agentRules in its OWN write; the already-onboarded branch then hands the
    // reconfig menu the PRE-step inspection.config — every mutating menu
    // action (change-fallback, add/remove-provider, edit-key) re-persists that
    // stale object and silently drops agentRules (config says unregistered,
    // disk says registered).
    const home = await mkHome(t, ["claude"]);
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const configPath = path.join(configRoot, "config.json");
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ version: 1, providers: { zai: { apiKey: "prior-key" } } }),
    );
    const script = createRecordingPrompts({
      confirmHandler: (message) => message.includes("claude"), // agent yes, fallback no
      selectAnswers: ["change-fallback", "cancel"],
    });

    const { deps } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: configPath,
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    const status = await handleInitWithHelp([], deps);
    assert.equal(status, 0);

    const config = JSON.parse(await read(configPath));
    assert.deepEqual(
      config.agentRules,
      { claude: true },
      "agentRules must survive a mutating reconfig menu action (no stale pre-step config)",
    );
    assert.equal(config.fallbackEnabled, false, "the menu action must have applied");
    assert.deepEqual(
      config.providers,
      { zai: { apiKey: "prior-key" } },
      "providers must survive the menu action",
    );
  });

  it("a tool whose agentRules choice is already set is NOT re-prompted; a newly detected tool registers alongside it without erasing it from the stamp (D4: prompt where detect true AND agentRules[id] unset)", async (t) => {
    // GROUND: DESIGN D4 "for each registry row where `detect` is true and
    // `agentRules[id]` is unset → confirm prompt" — the unset guard: a
    // still-deployed tool with a persisted choice re-runs no confirm on a
    // later wizard visit (choices never re-prompt, T4 refresh contract), and
    // registering a NEW tool must not drop the prior tool from the stamp
    // (D5 refresh iterates stamp.tools).
    const home = await mkHome(t, ["claude", "codex"]);
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const configPath = path.join(configRoot, "config.json");
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        providers: { zai: { apiKey: "prior-key" } },
        agentRules: { claude: true },
      }),
    );
    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });

    const script = createRecordingPrompts({
      confirmHandler: confirmByTool({ claude: true, codex: true }), // claude would say yes — must never be asked
      selectAnswer: "cancel",
    });
    const { deps } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: configPath,
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    const status = await handleInitWithHelp([], deps);
    assert.equal(status, 0);

    assert.equal(
      script.confirmCalls.filter((c) => /claude/i.test(c.message)).length,
      0,
      "an agentRules-set tool must not re-prompt (D4 unset guard)",
    );
    assert.equal(script.confirmCalls.length, 1, "only the newly detected codex prompts");
    assert.ok(/codex/i.test(script.confirmCalls[0].message), "the one prompt is for codex");
    const config = JSON.parse(await read(configPath));
    assert.deepEqual(
      config.agentRules,
      { claude: true, codex: true },
      "prior choice preserved, new choice recorded",
    );
    const stamp = JSON.parse(await read(path.join(configRoot, STAMP_NAME)));
    assert.deepEqual(
      [...stamp.tools].sort(),
      ["claude", "codex"],
      "registering codex must not erase claude from the stamp (refresh iterates stamp.tools)",
    );
  });
});

// ---------------------------------------------------------------------------
// Undetected tools + cursor notice-only row (DESIGN D1, PRD AC-6)
// ---------------------------------------------------------------------------

describe("undetected tools and the cursor notice-only row (DESIGN D1, AC-6)", () => {
  it("no detected tool homes → zero agent confirms, no agentRules, no stamp (regression pin: undetected tools never prompt)", async (t) => {
    // GROUND: AC-6 "undetected tools skipped silently". Green-by-design
    // companion of the detected-tool pins (disclosed pre-green): it guards
    // that the step, once it lands, prompts ONLY for detected tools.
    const home = await mkTemp(t, "scoutline-agent-home-");
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const script = createRecordingPrompts({ checkboxAnswer: null });

    const { deps } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    const status = await handleInitWithHelp([], deps);

    assert.equal(status, 1);
    assert.equal(script.confirmCalls.length, 0, "no detected tools → no agent confirms");
    await assertAbsent(path.join(configRoot, "config.json"), "nothing to persist when no tool is detected");
    await assertAbsent(path.join(configRoot, STAMP_NAME), "no registration → no stamp");
    assert.deepEqual(await findBackups(home), [], "no backups may be minted");
  });

  it("cursor home detected → the registry's unsupportedNotice prints verbatim (notice-only row: no prompt, no files, no stamp)", async (t) => {
    // GROUND: T5 "cursor home detected → honest unsupported notice (pinned
    // text; notice-only registry row)"; DESIGN D1 "cursor ... participates in
    // detection/wizard iteration with no engines, emitting unsupportedNotice
    // instead of a prompt".
    const home = await mkHome(t, ["cursor"]);
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const script = createRecordingPrompts({ checkboxAnswer: null });
    const cursorRow = AGENT_TOOLS.find((row) => row.id === "cursor");
    assert.ok(cursorRow?.unsupportedNotice, "the registry must carry the cursor notice");

    const { deps, stderrChunks } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    await handleInitWithHelp([], deps);

    const joined = stderrChunks.join("");
    const occurrences = joined.split(cursorRow.unsupportedNotice).length - 1;
    assert.equal(occurrences, 1, "the unsupportedNotice must print exactly once, verbatim");
    assert.equal(script.confirmCalls.length, 0, "a notice-only row must never prompt");
    assert.deepEqual(
      await fs.readdir(path.join(home, ".cursor")),
      [],
      "cursor stays notice-only: no engines may write under ~/.cursor",
    );
    await assertAbsent(path.join(configRoot, STAMP_NAME), "nothing registered → no stamp");
  });

  it("cursor + claude detected → notice once, confirm only for the engine row", async (t) => {
    // GROUND: AC-6 mixed case — the notice and the prompt coexist; the
    // notice-only row never turns into a registration.
    const home = await mkHome(t, ["cursor", "claude"]);
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const script = createRecordingPrompts({
      confirmHandler: confirmByTool({ claude: true }),
      checkboxAnswer: null,
    });
    const cursorRow = AGENT_TOOLS.find((row) => row.id === "cursor");

    const { deps, stderrChunks } = createWizardDeps({
      prompts: script.prompts,
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
      descriptors: [fakeZaiDescriptor()],
    });
    await handleInitWithHelp([], deps);

    const joined = stderrChunks.join("");
    assert.equal(joined.split(cursorRow.unsupportedNotice).length - 1, 1, "notice exactly once");
    assert.equal(script.confirmCalls.length, 1, "only the claude row prompts");
    assert.ok(/claude/i.test(script.confirmCalls[0].message), "the one prompt is for claude");
    assert.deepEqual(
      JSON.parse(await read(path.join(configRoot, "config.json"))).agentRules,
      { claude: true },
      "only the engine row's choice persists",
    );
  });
});

// ---------------------------------------------------------------------------
// init --unregister (DESIGN D2/D4, PRD AC-8)
// ---------------------------------------------------------------------------

describe("init --unregister: disk-scan reversal (DESIGN D2, PRD AC-8)", () => {
  it("reverses a full six-tool registration: owned files unlinked, skills removed, shared surfaces byte-identical to their backups, stamp + agentRules cleared, backups deleted; exit 0", async (t) => {
    // GROUND: T5 "init --unregister — disk-scan reversal (owned files by
    // registry path, marker strip, array entry removal); stamp + agentRules
    // cleared. TWO pins, never restore-from-backup: (a) untouched file →
    // output byte-identical to .scoutline-bak"; DESIGN D2 "deletes owned
    // files by fixed registry paths, strips inserted lines/blocks by our
    // markers, removes array entries by exact string, clears agentRules +
    // stamp. Unregister deletes the backup"; PRD AC-8.
    const home = await mkTemp(t, "scoutline-agent-home-");
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const { configPath } = await registerWorld(home, configRoot);

    // Capture every backup byte-for-byte BEFORE unregister (unregister
    // deletes them — the comparison target must be snapshotted).
    const shared = {
      claudeMd: path.join(home, ".claude", "CLAUDE.md"),
      geminiMd: path.join(home, ".gemini", "GEMINI.md"),
      agentsMd: path.join(home, ".codex", "AGENTS.md"),
      qwenMd: path.join(home, ".qwen", "QWEN.md"),
      opencodeJson: path.join(home, ".config", "opencode", "opencode.json"),
    };
    const backupBytes = new Map();
    for (const p of Object.values(shared)) {
      backupBytes.set(p, await fs.readFile(`${p}.scoutline-bak`));
    }

    const { deps, stderr } = createMainDeps({ configFilePath: configPath, home, configRoot });
    const code = await main(["init", "--unregister"], deps);

    assert.equal(code, 0, "--unregister exits 0");
    assert.doesNotMatch(stderr.join(""), /not implemented/, "the placeholder must be gone");
    // Owned dedicated files unlinked by fixed registry path.
    for (const id of ["claude", "opencode", "gemini", "copilot"]) {
      await assertAbsent(RULES_FILE[id](home), `${id} rules file must be unlinked`);
    }
    // Skill copies removed from every skillHome.
    for (const id of ALL_SIX) {
      await assertAbsent(skillDest(home, id), `${id} skill copy must be removed`);
    }
    // PIN (a): untouched shared surfaces byte-identical to their backups.
    for (const [p, bytes] of backupBytes) {
      assert.deepEqual(
        await fs.readFile(p),
        bytes,
        `${path.basename(p)} must be byte-identical to its pre-registration backup`,
      );
    }
    // The opencode.json reversal keeps it valid JSON (array entry removed).
    JSON.parse(await read(shared.opencodeJson));
    // Stamp + agentRules cleared; the rest of the config survives.
    await assertAbsent(path.join(configRoot, STAMP_NAME), "the stamp must be removed");
    const config = JSON.parse(await read(configPath));
    assert.equal(config.agentRules, undefined, "agentRules must be cleared");
    assert.deepEqual(
      config.providers,
      { zai: { apiKey: "prior-key" } },
      "provider config must survive --unregister",
    );
    // Backups deleted: state fully restored, escape hatch spent (D2).
    assert.deepEqual(await findBackups(home), [], "every .scoutline-bak must be deleted");
  });

  it("user-edited file: our region is stripped and user bytes preserved — NOT restored from the backup (the pin a restore-from-backup implementation fails)", async (t) => {
    // GROUND: T5 pin (b) "user-edited file → our region stripped, user bytes
    // preserved (the pin restore-from-backup would fail)"; DESIGN D2 "NEVER
    // restore from the .scoutline-bak — a user who edited the file since
    // registration would lose their edits; marker-strip always, restore
    // never".
    const home = await mkTemp(t, "scoutline-agent-home-");
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const { configPath } = await registerWorld(home, configRoot);

    // The user edits AFTER registration but BEFORE unregister.
    const agentsPath = path.join(home, ".codex", "AGENTS.md");
    const backupBytes = await fs.readFile(`${agentsPath}.scoutline-bak`);
    await fs.writeFile(
      agentsPath,
      (await read(agentsPath)).replace(
        PRE_EXISTING.agentsMd,
        "# codex user notes\n# my later edit\n",
      ),
    );

    const { deps } = createMainDeps({ configFilePath: configPath, home, configRoot });
    const code = await main(["init", "--unregister"], deps);

    assert.equal(code, 0);
    const after = await read(agentsPath);
    assert.ok(!after.includes(START_MARKER), "marker residue must be stripped");
    assert.ok(!after.includes(END_MARKER), "end-marker residue must be stripped");
    assert.ok(!after.includes(RULE_TEXT), "our rule text must be stripped");
    assert.ok(after.includes("# my later edit"), "the user's post-registration edit must survive");
    assert.ok(after.includes("# codex user notes"), "the user's original bytes must survive");
    assert.notDeepEqual(
      await fs.readFile(agentsPath),
      backupBytes,
      "restore-from-backup would lose the user's later edit — that implementation must fail here",
    );
  });

  it("unregister round-trips a no-trailing-newline pointer file byte-identically (line, block, json-empty — the EOL fixtures leave the newline-joining asymmetry unpinned)", async (t) => {
    // GROUND: PRD AC-8 "pre-registration state byte-identical" — pin (a)
    // only compares files whose last byte IS a newline; every PRE_EXISTING
    // fixture ends in \n. When the original lacks a final newline the insert
    // engines historically forced one (join asymmetry), so the strip could
    // never restore exact bytes, and the opencode empty-array fast path left
    // whitespace residue inside the array.
    const cases = [
      {
        id: "claude",
        pointerFile: (home) => path.join(home, ".claude", "CLAUDE.md"),
        original: PRE_EXISTING.claudeMdNoEol,
      },
      {
        id: "qwen",
        pointerFile: (home) => path.join(home, ".qwen", "QWEN.md"),
        original: PRE_EXISTING.qwenMdNoEol,
      },
      {
        id: "opencode",
        pointerFile: (home) => path.join(home, ".config", "opencode", "opencode.json"),
        original: PRE_EXISTING.opencodeJsonEmpty,
      },
    ];
    for (const { id, pointerFile, original } of cases) {
      const home = await mkTemp(t, "scoutline-agent-home-");
      const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
      const target = pointerFile(home);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, original);
      const configPath = path.join(configRoot, "config.json");
      await fs.mkdir(configRoot, { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ version: 1, providers: {}, agentRules: { [id]: true } }),
      );

      await registerAgentTools({ home, configRoot, tools: [id], version: "9.9.9" });
      const { deps } = createMainDeps({ configFilePath: configPath, home, configRoot });
      assert.equal(await main(["init", "--unregister"], deps), 0);

      const after = await fs.readFile(target, "utf8");
      assert.equal(
        after,
        original,
        `${id}: unregister must restore the exact pre-registration bytes (no newline/whitespace residue)`,
      );
    }
  });

  it("a user-authored foreign marker pair survives unregister byte-identically — strip removes only OUR region", async (t) => {
    // GROUND: stripManagedRegion historically stripped EVERY
    // <!-- scoutline:start/end --> pair in the file, destroying user bytes on
    // a shared surface. DESIGN D2 "strips inserted lines/blocks by OUR
    // markers" — the strip must match our region content (pointer line /
    // rule text), leaving foreign pairs untouched.
    const home = await mkTemp(t, "scoutline-agent-home-");
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    await fs.mkdir(path.dirname(claudeMd), { recursive: true });
    const original =
      "# my notes\n" +
      "<!-- scoutline:start -->\n" +
      "not ours\n" +
      "<!-- scoutline:end -->\n";
    await fs.writeFile(claudeMd, original);
    const configPath = path.join(configRoot, "config.json");
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ version: 1, providers: {}, agentRules: { claude: true } }),
    );

    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });
    const registered = await fs.readFile(claudeMd, "utf8");
    assert.ok(
      registered.includes("@rules/scoutline.md"),
      "our pointer line must have been inserted next to the foreign pair",
    );

    const { deps } = createMainDeps({ configFilePath: configPath, home, configRoot });
    assert.equal(await main(["init", "--unregister"], deps), 0);

    assert.equal(
      await fs.readFile(claudeMd, "utf8"),
      original,
      "the user-authored marker pair must survive byte-identically; only our own region is stripped",
    );
  });

  it("files the registration itself created (no backup exists) are deleted outright", async (t) => {
    // GROUND: AC-8 "leaving pre-registration state byte-identical" — a
    // shared surface that did NOT exist before registration has no
    // pre-registration bytes to restore; its pre-registration state is
    // absence, so it is unlinked.
    const home = await mkHome(t, ["claude"]); // detect dir only — no CLAUDE.md
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    assert.ok((await fs.stat(claudeMd)).isFile(), "registration must have created CLAUDE.md");
    await assertAbsent(`${claudeMd}.scoutline-bak`, "no backup exists for a file we created");

    const { deps } = createMainDeps({
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
    });
    const code = await main(["init", "--unregister"], deps);

    assert.equal(code, 0);
    await assertAbsent(claudeMd, "a file we created must be deleted, not emptied");
    await assertAbsent(RULES_FILE.claude(home), "owned rules file unlinked");
    await assertAbsent(skillDest(home, "claude"), "skill copy removed");
    await assertAbsent(path.join(configRoot, STAMP_NAME), "stamp removed");
  });

  it("nothing registered → clean no-op exit 0, no placeholder, nothing minted", async (t) => {
    // GROUND: reversal of nothing touches nothing — no stamp, no config
    // minting, exit 0 (the flag is a safe re-run).
    const home = await mkTemp(t, "scoutline-agent-home-");
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");

    const { deps, stderr } = createMainDeps({
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
    });
    const code = await main(["init", "--unregister"], deps);

    assert.equal(code, 0);
    assert.doesNotMatch(stderr.join(""), /not implemented/, "the placeholder must be gone");
    await assertAbsent(path.join(configRoot, "config.json"), "unregister must not mint a config");
    await assertAbsent(path.join(configRoot, STAMP_NAME), "no stamp to remove, none minted");
    assert.deepEqual(await findBackups(home), [], "no backups minted");
  });
});

// ---------------------------------------------------------------------------
// Backup boundedness across the register → refresh → unregister → re-register
// lifecycle (DESIGN D2)
// ---------------------------------------------------------------------------

describe("backup boundedness: two refresh cycles → one untouched backup; unregister deletes it; re-register re-mints (DESIGN D2)", () => {
  it("backup count stays 1 with mtime unchanged across two drift refreshes; unregister spends it; re-register re-mints against current bytes", async (t) => {
    // GROUND: T5 "Backup-boundedness pins: two refresh cycles → exactly one
    // backup file, untouched; unregister deletes it; re-register re-mints
    // against current bytes"; DESIGN D2 "repeated version bumps NEVER mint
    // new backups (max one per file at any time). Unregister deletes the
    // backup ... a later re-register re-mints it fresh against current
    // bytes. Pinned: two refresh cycles → backup file count 1, mtime
    // unchanged."
    const home = await mkTemp(t, "scoutline-agent-home-");
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.writeFile(path.join(home, ".codex", "AGENTS.md"), PRE_EXISTING.agentsMd);

    await registerAgentTools({ home, configRoot, tools: ["codex"], version: "9.9.9" });
    const agentsPath = path.join(home, ".codex", "AGENTS.md");
    const bakPath = `${agentsPath}.scoutline-bak`;
    const minted = await fs.stat(bakPath);
    assert.deepEqual(await findBackups(home), [bakPath], "first mutation of a pre-existing file mints exactly one backup");

    // Two refresh cycles (version-only drift each time — refreshes touch
    // only our marker region, never minting a new backup).
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await writeStamp(configRoot, {
        version: "0.0.1",
        tools: ["codex"],
        ruleTextHash: computeRuleTextHash(),
      });
      const result = await checkAgentRegistration({
        home,
        configRoot,
        version: "9.9.9",
        writeStderr: () => {},
      });
      assert.equal(result.refreshed, true, `refresh cycle ${cycle + 1} must fire`);
    }

    const afterRefreshes = await fs.stat(bakPath);
    assert.deepEqual(await findBackups(home), [bakPath], "two refresh cycles → still exactly one backup");
    assert.equal(
      afterRefreshes.mtimeMs,
      minted.mtimeMs,
      "the backup must be untouched across refresh cycles",
    );

    // Unregister spends the escape hatch.
    const { deps } = createMainDeps({
      configFilePath: path.join(configRoot, "config.json"),
      home,
      configRoot,
    });
    assert.equal(await main(["init", "--unregister"], deps), 0);
    assert.deepEqual(await findBackups(home), [], "unregister must delete the backup");
    assert.equal(
      await read(agentsPath),
      PRE_EXISTING.agentsMd,
      "the file itself must be back to its pre-registration bytes",
    );

    // Re-register re-mints against CURRENT bytes (no stale backup surviving
    // as fake pre-registration state).
    await registerAgentTools({ home, configRoot, tools: ["codex"], version: "9.9.9" });
    assert.deepEqual(await findBackups(home), [bakPath], "re-register re-mints the backup");
    assert.equal(
      await read(bakPath),
      PRE_EXISTING.agentsMd,
      "the re-minted backup must snapshot the current (stripped) bytes",
    );
  });
});
