/**
 * Agent registration — skill deployment + version-stamped lazy refresh.
 *
 * Grounds: DESIGN D3 (recursive real copy to every skillHome, byte-identical,
 * references/ included, no symlink — claude breakage; copilot native skills
 * home with pointer-free instructions file coexisting unchanged), D5 (stamp
 * file <configRoot>/agent-registration.json {version, tools, ruleTextHash};
 * !== compare — downgrades refresh too; refresh re-copies skill AND rewrites
 * rule files through the same engines when ruleTextHash drifted — dedicated
 * files wholesale, marker regions in-region, pointer lines unchanged; honors
 * agentRules; failures are stderr notices, never fatal; stamp-absent runs are
 * no-ops with zero extra bytes), D6 (src/index.ts stamp-check wiring via
 * injectable dependencies.agentRegistrationCheck + --unregister parse at the
 * init dispatch surface), PRD AC-4 (real copies), AC-7 (lazy refresh), AC-2
 * (documented homes — gemini's is the documented config home, NOT legacy
 * antigravity).
 *
 * Module contract under test (single import point — a split implementation
 * re-exports from dist/lib/agent-registration/deploy.js):
 *   deploySkills({ home, tools })                      — real-copy deploy only
 *   registerAgentTools({ home, configRoot, tools, version }) — deploy + rules + stamp
 *   readAgentRegistrationStamp(configRoot)              — stamp | undefined
 *   checkAgentRegistration({ home, configRoot, version, agentRules?, writeStderr })
 *                                                       — { refreshed: boolean }
 *   computeRuleTextHash()                               — stable sha256 hex of RULE_TEXT
 * plus main()'s optional `agentRegistrationCheck` dependency (production
 * default; tests inject doubles) and the `init --unregister` flag parse.
 *
 * Hermetic: every registration/refresh test runs against injected temp home
 * and config roots; no real HOME or ~/.scoutline is written; zero network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { RULE_TEXT } from "../dist/lib/agent-registration/registry.js";
import { resolveSkillSourceDir } from "../dist/lib/skill-source.js";
import { createDefaultConfigStore } from "../dist/commands/init.js";
import { main } from "../dist/index.js";

// Lazy loader: keeps every test individually red (module-not-found surfaces
// per-test, not as a dead file) until the implementation lands.
let deployModulePromise;
function loadDeploy() {
  deployModulePromise ??= import("../dist/lib/agent-registration/deploy.js");
  return deployModulePromise;
}

const ALL_SIX = ["claude", "opencode", "codex", "gemini", "qwen", "copilot"];

// Documented skill destinations (PRD AC-2 / DESIGN D3): every tool receives
// the skill as <skills home>/scoutline/; gemini's skills home is the
// documented global config home, not the legacy antigravity dir.
const SKILL_DEST = {
  claude: [".claude", "skills", "scoutline"],
  opencode: [".config", "opencode", "skills", "scoutline"],
  codex: [".codex", "skills", "scoutline"],
  gemini: [".gemini", "config", "skills", "scoutline"],
  qwen: [".qwen", "skills", "scoutline"],
  copilot: [".copilot", "skills", "scoutline"],
};

const RULES_FILE = {
  claude: (home) => path.join(home, ".claude", "rules", "scoutline.md"),
  opencode: (home) => path.join(home, ".config", "opencode", "rules", "scoutline.md"),
  copilot: (home) => path.join(home, ".copilot", "instructions", "scoutline.instructions.md"),
  gemini: (home) => path.join(home, ".gemini", "rules", "scoutline.md"),
};

const STAMP_NAME = "agent-registration.json";

async function mkTemp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-agent-deploy-"));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function read(p) {
  return fs.readFile(p, "utf8");
}

function skillDest(home, id) {
  return path.join(home, ...SKILL_DEST[id]);
}

/** Recursive tree walk with an lstat no-symlink pin on the root and EVERY entry (AC-4). */
async function walkReal(root) {
  const files = new Map();
  const rootStat = await fs.lstat(root);
  assert.equal(
    rootStat.isSymbolicLink(),
    false,
    "the deployed skill directory itself must be a real directory, not a symlink",
  );
  async function rec(dir, rel) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const st = await fs.lstat(full);
      assert.equal(
        st.isSymbolicLink(),
        false,
        `${relPath} must be a real copy — symlinks break claude's skill loader`,
      );
      if (st.isDirectory()) await rec(full, relPath);
      else files.set(relPath, await fs.readFile(full));
    }
  }
  await rec(root, "");
  return files;
}

async function writeStamp(configRoot, stamp) {
  await fs.writeFile(path.join(configRoot, STAMP_NAME), JSON.stringify(stamp));
}

async function sourceSkillBytes() {
  return fs.readFile(path.join(resolveSkillSourceDir(), "SKILL.md"));
}

describe("skill deployment (DESIGN D3, PRD AC-4)", () => {
  it("deploys a byte-identical real copy of the package skill to every documented skillHome — references/ included, lstat no-symlink", async (t) => {
    const { deploySkills } = await loadDeploy();
    const home = await mkTemp(t);
    const source = await walkReal(resolveSkillSourceDir());
    assert.ok(source.has("SKILL.md"), "source must carry SKILL.md");
    assert.ok(
      [...source.keys()].some((rel) => rel.startsWith("references/")),
      "source must carry references/ — AC-4 requires it in every copy",
    );

    await deploySkills({ home, tools: ALL_SIX });

    for (const id of ALL_SIX) {
      const got = await walkReal(skillDest(home, id)); // lstat pin fires per entry
      assert.deepEqual(
        [...got.keys()].sort(),
        [...source.keys()].sort(),
        `${id} deployed file set must mirror the source tree exactly`,
      );
      for (const [rel, bytes] of source) {
        assert.deepEqual(got.get(rel), bytes, `${id} ${rel} must be byte-identical to the source`);
      }
    }
  });

  it("gemini deploys to the documented config skills home — the legacy antigravity dir is never created", async (t) => {
    // GROUND: AC-2 / D1 — ~/.gemini/config/skills/scoutline/ is the DOCUMENTED
    // global home; antigravity/skills/ is legacy back-compat we must not use.
    const { deploySkills } = await loadDeploy();
    const home = await mkTemp(t);
    await deploySkills({ home, tools: ["gemini"] });

    const skill = await read(path.join(skillDest(home, "gemini"), "SKILL.md"));
    assert.ok(skill.length > 0, "gemini skill must be deployed to the documented home");
    await assert.rejects(
      fs.stat(path.join(home, ".gemini", "antigravity")),
      (error) => error.code === "ENOENT",
      "the legacy antigravity skills dir must NOT be created",
    );
  });

  it("copilot deploys natively and deploy alone leaves the pointer-free instructions file untouched", async (t) => {
    // GROUND: AC-2 / D3 — ~/.copilot/skills/scoutline/ is the official home;
    // the pointer-free ~/.copilot/instructions/ rules file coexists and is not
    // the deployer's business.
    const { deploySkills } = await loadDeploy();
    const home = await mkTemp(t);
    await deploySkills({ home, tools: ["copilot"] });

    assert.deepEqual(
      await fs.readdir(path.join(home, ".copilot")),
      ["skills"],
      "deploy must create nothing under ~/.copilot except the skills tree",
    );
    await assert.rejects(
      fs.stat(path.join(home, ".copilot", "instructions")),
      (error) => error.code === "ENOENT",
      "skill deploy must not mint the instructions rules file",
    );
  });
});

describe("registration stamp (DESIGN D5)", () => {
  it("register writes the stamp at <configRoot>/agent-registration.json with exactly {version, tools, ruleTextHash}; the hash is the stable sha256 of RULE_TEXT", async (t) => {
    const { computeRuleTextHash, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);

    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });

    const stampPath = path.join(configRoot, STAMP_NAME);
    assert.ok((await fs.stat(stampPath)).isFile(), "stamp must live at the documented path");
    // deepEqual against the exact object pins the key SET (no extras).
    assert.deepEqual(JSON.parse(await read(stampPath)), {
      version: "9.9.9",
      tools: ["claude"],
      ruleTextHash: computeRuleTextHash(),
    });
    // The drift detector hashes RULE_TEXT deterministically — writer and
    // checker must agree across processes and versions.
    assert.equal(computeRuleTextHash(), computeRuleTextHash(), "hash must be stable");
    assert.match(computeRuleTextHash(), /^[0-9a-f]{64}$/, "hash must be sha256 hex");
    assert.equal(
      computeRuleTextHash(),
      createHash("sha256").update(RULE_TEXT).digest("hex"),
      "hash input must be RULE_TEXT verbatim",
    );
  });

  it("register writes rules through each engine class and copilot stays pointer-free", async (t) => {
    // GROUND: D5 "rewrite rule files through the same engines" presumes
    // register wrote them; D2 engine classes = dedicated file (claude /
    // opencode / copilot), marker block (codex), pointer line (claude
    // CLAUDE.md / opencode instructions array); AC-2 copilot = pointer-free.
    const { registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    // Pre-existing user bytes in the codex shared file: register must augment
    // around them, never clobber.
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.writeFile(path.join(home, ".codex", "AGENTS.md"), "# codex user notes\n");

    await registerAgentTools({
      home,
      configRoot,
      tools: ["claude", "codex", "opencode", "copilot", "gemini", "qwen"],
      version: "1.0.0",
    });

    // Dedicated thin-rules files we own wholesale.
    assert.equal(await read(RULES_FILE.claude(home)), RULE_TEXT);
    assert.equal(await read(RULES_FILE.opencode(home)), RULE_TEXT);
    assert.equal(await read(RULES_FILE.copilot(home)), RULE_TEXT);
    assert.equal(await read(RULES_FILE.gemini(home)), RULE_TEXT);

    // Pointer line in the claude shared surface.
    assert.match(
      await read(path.join(home, ".claude", "CLAUDE.md")),
      /@rules\/scoutline\.md/,
      "claude pointer must point at the rules file via the @rules/ convention",
    );

    // Gemini pointer line must reference the rules file registration actually
    // deploys (~/.gemini/rules/scoutline.md) — a relative .scoutline/ path
    // resolves against the CLI process CWD and reaches nothing (AC-2).
    const geminiMd = await read(path.join(home, ".gemini", "GEMINI.md"));
    assert.ok(
      !geminiMd.includes(".scoutline/rules/"),
      "gemini pointer must not use the unresolvable .scoutline/ relative path",
    );
    assert.ok(
      geminiMd.includes("@~/.gemini/rules/scoutline.md"),
      "gemini pointer must reference the deployed rules file",
    );

    // qwen marker block in QWEN.md (create-or-augment engine class).
    const qwenMd = await read(path.join(home, ".qwen", "QWEN.md"));
    assert.ok(qwenMd.includes("<!-- scoutline:start -->"), "qwen block must be marker-wrapped");
    assert.ok(qwenMd.includes("<!-- scoutline:end -->"), "qwen block must close its marker");
    assert.ok(qwenMd.includes(RULE_TEXT), "qwen block must carry the rule text");

    // Marker block in the codex shared file, user bytes preserved above it.
    const agents = await read(path.join(home, ".codex", "AGENTS.md"));
    assert.ok(
      agents.startsWith("# codex user notes\n"),
      "user bytes before the block must survive",
    );
    assert.ok(agents.includes("<!-- scoutline:start -->"), "codex block must be marker-wrapped");
    assert.ok(agents.includes(RULE_TEXT), "codex block must carry the rule text");

    // opencode instructions array entry; file must still be valid JSON.
    const opencodeConfig = JSON.parse(
      await read(path.join(home, ".config", "opencode", "opencode.json")),
    );
    assert.ok(
      Array.isArray(opencodeConfig.instructions) &&
        opencodeConfig.instructions.some(
          (entry) => typeof entry === "string" && entry.includes("scoutline"),
        ),
      "opencode instructions array must carry our entry",
    );

    // Copilot is pointer-free: nothing under ~/.copilot except the rules file
    // and the skills tree.
    assert.deepEqual((await fs.readdir(path.join(home, ".copilot"))).sort(), [
      "instructions",
      "skills",
    ]);
  });
});

describe("lazy refresh (DESIGN D5, PRD AC-7)", () => {
  it("stamp absent → zero-cost no-op: no files touched, nothing written to stderr", async (t) => {
    // GROUND: D5 "skip entirely if no stamp exists — zero cost for non-users".
    const { checkAgentRegistration, readAgentRegistrationStamp } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    const notices = [];

    assert.equal(
      await readAgentRegistrationStamp(configRoot),
      undefined,
      "absent stamp reads as undefined",
    );
    const result = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.9",
      writeStderr: (value) => notices.push(value),
    });

    assert.equal(result.refreshed, false);
    assert.deepEqual(await fs.readdir(home), [], "no skill home may be created without a stamp");
    assert.deepEqual(notices, [], "stamp-absent runs emit zero stderr bytes");
    assert.equal(
      await readAgentRegistrationStamp(configRoot),
      undefined,
      "no stamp may be minted by a check",
    );
  });

  it("version-LOWER stamp (downgrade) refreshes: skill re-copied, stamp rewritten to current, tools preserved", async (t) => {
    // GROUND: D5 "Stamp compare is !== ... downgrades and text drift refresh
    // too" — a version-lower stamp MUST trigger, not compare less-than.
    const { checkAgentRegistration, computeRuleTextHash, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });

    const sourceSkill = await sourceSkillBytes();
    const destSkill = path.join(skillDest(home, "claude"), "SKILL.md");
    const rulesFile = RULES_FILE.claude(home);
    await fs.writeFile(destSkill, "STALE BYTES");
    await fs.writeFile(rulesFile, "STALE RULES\n");
    // Version-only drift: hash still current — isolates the version trigger.
    await writeStamp(configRoot, {
      version: "0.0.1",
      tools: ["claude"],
      ruleTextHash: computeRuleTextHash(),
    });

    const result = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.9",
      writeStderr: () => {},
    });

    assert.equal(result.refreshed, true, "a version-LOWER stamp must refresh");
    assert.deepEqual(
      await fs.readFile(destSkill),
      sourceSkill,
      "skill must be re-copied from source",
    );
    assert.equal(
      await read(rulesFile),
      "STALE RULES\n",
      "version-only drift must NOT rewrite rule files (AC-7: rewrite only when text drifted)",
    );
    assert.deepEqual(
      JSON.parse(await read(path.join(configRoot, STAMP_NAME))),
      {
        version: "9.9.9",
        tools: ["claude"],
        ruleTextHash: computeRuleTextHash(),
      },
      "stamp must be rewritten to current values with tools preserved",
    );
  });

  it("ruleTextHash-mismatch stamp rewrites rules through the same engines: dedicated wholesale, marker in-region, pointer lines byte-unchanged, skill re-copied", async (t) => {
    // GROUND: D5 "rewrite rule files through the same mutation engines when
    // ruleTextHash drifted (dedicated rules files replaced with the current
    // text; codex/qwen marker regions rewritten in-region; pointer lines
    // unchanged)" + AC-7 "skill re-copied to registered skillHomes".
    const { checkAgentRegistration, computeRuleTextHash, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.writeFile(path.join(home, ".codex", "AGENTS.md"), "# codex user notes\n");
    const tools = ["claude", "codex", "opencode"];
    await registerAgentTools({ home, configRoot, tools, version: "9.9.9" });

    // Stale-ify everything a refresh could touch, then capture the surfaces
    // that must stay byte-identical (pointer lines).
    const destSkill = path.join(skillDest(home, "claude"), "SKILL.md");
    const sourceSkill = await sourceSkillBytes();
    await fs.writeFile(destSkill, "STALE BYTES");
    await fs.writeFile(RULES_FILE.claude(home), "OLD RULES\n");
    await fs.writeFile(RULES_FILE.opencode(home), "OLD RULES\n");
    const agentsPath = path.join(home, ".codex", "AGENTS.md");
    const oldRegion = await read(agentsPath);
    assert.ok(oldRegion.includes(RULE_TEXT));
    await fs.writeFile(agentsPath, oldRegion.replace(RULE_TEXT, "OLD REGION TEXT"));
    const claudeMdPath = path.join(home, ".claude", "CLAUDE.md");
    const opencodeJsonPath = path.join(home, ".config", "opencode", "opencode.json");
    const claudeMdBefore = await read(claudeMdPath);
    const opencodeJsonBefore = await read(opencodeJsonPath);
    // Hash-only drift: version still current — isolates the text trigger.
    await writeStamp(configRoot, { version: "9.9.9", tools, ruleTextHash: "deadbeef" });

    const result = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.9",
      writeStderr: () => {},
    });

    assert.equal(result.refreshed, true, "a ruleTextHash-mismatch stamp must refresh");
    // Dedicated files replaced wholesale with the current text.
    assert.equal(
      await read(RULES_FILE.claude(home)),
      RULE_TEXT,
      "claude rules file must be replaced wholesale",
    );
    assert.equal(
      await read(RULES_FILE.opencode(home)),
      RULE_TEXT,
      "opencode rules file must be replaced wholesale",
    );
    // Marker region rewritten IN-REGION: user prefix intact, old text gone.
    const agents = await read(agentsPath);
    assert.ok(
      agents.startsWith("# codex user notes\n"),
      "bytes outside the marker region must be preserved",
    );
    assert.ok(agents.includes(RULE_TEXT), "marker region must carry the current rule text");
    assert.ok(!agents.includes("OLD REGION TEXT"), "old region text must not linger");
    // Pointer lines byte-unchanged.
    assert.equal(
      await read(claudeMdPath),
      claudeMdBefore,
      "claude pointer surface must be byte-identical",
    );
    assert.equal(
      await read(opencodeJsonPath),
      opencodeJsonBefore,
      "opencode pointer surface must be byte-identical",
    );
    const opencodeConfig = JSON.parse(opencodeJsonBefore);
    assert.ok(
      Array.isArray(opencodeConfig.instructions) &&
        opencodeConfig.instructions.some(
          (entry) => typeof entry === "string" && entry.includes("scoutline"),
        ),
      "opencode array entry must survive the refresh",
    );
    // Skill re-copied even on hash-only drift.
    assert.deepEqual(await fs.readFile(destSkill), sourceSkill, "skill must be re-copied");
    // Stamp's hash updated to current.
    const stamp = JSON.parse(await read(path.join(configRoot, STAMP_NAME)));
    assert.equal(stamp.ruleTextHash, computeRuleTextHash());
    assert.equal(stamp.version, "9.9.9");
  });

  it("version AND hash both current → no refresh: stale deployed bytes and the stamp itself survive untouched", async (t) => {
    // GROUND: D5 refresh fires only on drift. Mutation pin: an implementation
    // that always refreshes (or re-copies on every run) fails here.
    const { checkAgentRegistration, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });

    const destSkill = path.join(skillDest(home, "claude"), "SKILL.md");
    const rulesFile = RULES_FILE.claude(home);
    await fs.writeFile(destSkill, "STALE BYTES");
    await fs.writeFile(rulesFile, "STALE RULES\n");
    const stampPath = path.join(configRoot, STAMP_NAME);
    const stampBefore = await read(stampPath);

    const result = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.9",
      writeStderr: () => {},
    });

    assert.equal(result.refreshed, false, "no drift → no refresh");
    assert.equal(await read(destSkill), "STALE BYTES", "skill must NOT be re-copied without drift");
    assert.equal(
      await read(rulesFile),
      "STALE RULES\n",
      "rules must NOT be rewritten without drift",
    );
    assert.equal(await read(stampPath), stampBefore, "stamp must not be rewritten without drift");
  });

  it("refresh honors agentRules: a tool opted out with false is skipped entirely", async (t) => {
    // GROUND: D5 "refresh for registered tools honoring agentRules"; AC-7
    // "honors agentRules choices" — registration choices are never re-prompted.
    const { checkAgentRegistration, computeRuleTextHash, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    await registerAgentTools({ home, configRoot, tools: ["claude", "codex"], version: "9.9.9" });

    const claudeSkill = path.join(skillDest(home, "claude"), "SKILL.md");
    const codexSkill = path.join(skillDest(home, "codex"), "SKILL.md");
    const sourceSkill = await sourceSkillBytes();
    await fs.writeFile(claudeSkill, "STALE BYTES");
    await fs.writeFile(codexSkill, "STALE BYTES");
    await writeStamp(configRoot, {
      version: "0.0.1",
      tools: ["claude", "codex"],
      ruleTextHash: computeRuleTextHash(),
    });

    const result = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.9",
      agentRules: { claude: false },
      writeStderr: () => {},
    });

    assert.equal(result.refreshed, true, "drifted tools that are still opted in must refresh");
    assert.equal(
      await read(claudeSkill),
      "STALE BYTES",
      "opted-out tool's skill must be left alone",
    );
    assert.deepEqual(
      await fs.readFile(codexSkill),
      sourceSkill,
      "opted-in tool's skill must be re-copied",
    );
  });

  it("production refresh (agentRules option omitted) honors the persisted config.json opt-out", async (t) => {
    // GROUND: bot-review — the production default closure in main() calls
    // checkAgentRegistration WITHOUT agentRules, so a persisted `false`
    // choice never fired: a user who opted out was still refreshed on
    // drift. When the option is omitted the module must load the persisted
    // choices from <configRoot>/config.json itself.
    const { checkAgentRegistration, computeRuleTextHash, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    await registerAgentTools({ home, configRoot, tools: ["claude", "codex"], version: "9.9.9" });
    const claudeSkill = path.join(skillDest(home, "claude"), "SKILL.md");
    const codexSkill = path.join(skillDest(home, "codex"), "SKILL.md");
    const sourceSkill = await sourceSkillBytes();
    await fs.writeFile(claudeSkill, "STALE BYTES");
    await fs.writeFile(codexSkill, "STALE BYTES");
    await fs.writeFile(
      path.join(configRoot, "config.json"),
      JSON.stringify({ version: 1, providers: {}, agentRules: { claude: false } }),
    );
    await writeStamp(configRoot, {
      version: "0.0.1",
      tools: ["claude", "codex"],
      ruleTextHash: computeRuleTextHash(),
    });

    const result = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.9",
      writeStderr: () => {},
    });

    assert.equal(result.refreshed, true, "opted-in drifted tools must still refresh");
    assert.equal(
      await read(claudeSkill),
      "STALE BYTES",
      "the persisted opt-out must be honored without an explicit agentRules option",
    );
    assert.deepEqual(await fs.readFile(codexSkill), sourceSkill, "the opted-in tool must re-copy");
  });

  it("a corrupt config.json never breaks the production refresh — treated as unconfigured, never fatal", async (t) => {
    // GROUND: the persisted-choices load must tolerate absent/corrupt config
    // exactly like the stamp read — a broken config.json must neither throw
    // nor silently opt every tool out.
    const { checkAgentRegistration, computeRuleTextHash, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });
    const destSkill = path.join(skillDest(home, "claude"), "SKILL.md");
    const sourceSkill = await sourceSkillBytes();
    await fs.writeFile(destSkill, "STALE BYTES");
    await fs.writeFile(path.join(configRoot, "config.json"), "{corrupt");
    await writeStamp(configRoot, {
      version: "0.0.1",
      tools: ["claude"],
      ruleTextHash: computeRuleTextHash(),
    });

    const result = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.9",
      writeStderr: () => {},
    });

    assert.equal(result.refreshed, true, "corrupt config must not throw nor opt the tool out");
    assert.deepEqual(
      await fs.readFile(destSkill),
      sourceSkill,
      "the tool must refresh as unconfigured",
    );
  });

  it("refresh failure is a stderr notice, never a thrown error", async (t) => {
    // GROUND: D5 "Failures are noticed, never fatal to the invoked command
    // ... refresh notices are stderr-only".
    const { checkAgentRegistration, computeRuleTextHash, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });
    await writeStamp(configRoot, {
      version: "0.0.1",
      tools: ["claude"],
      ruleTextHash: computeRuleTextHash(),
    });

    // Make every write under the claude home fail (read+execute only).
    // ponytail: chmod-based EACCES fails open under root — if this test ever
    // flakes in a root container, swap for an immutable-parent sentinel file.
    const rulesDir = path.join(home, ".claude", "rules");
    const skillsDir = path.join(home, ".claude", "skills");
    await fs.chmod(rulesDir, 0o500);
    await fs.chmod(skillsDir, 0o500);
    const notices = [];
    try {
      await assert.doesNotReject(
        () =>
          checkAgentRegistration({
            home,
            configRoot,
            version: "9.9.9",
            writeStderr: (value) => notices.push(value),
          }),
        "a failing refresh must degrade, not reject",
      );
    } finally {
      await fs.chmod(rulesDir, 0o700);
      await fs.chmod(skillsDir, 0o700);
    }
    assert.ok(
      notices.length >= 1 && notices.every((n) => typeof n === "string" && n.length > 0),
      "at least one non-empty stderr notice must be emitted for the failed refresh",
    );
  });
  it("an unreadable shared file fails the reversal loudly — never silently 'clean'", async (t) => {
    // GROUND: reversal readers treat only ENOENT as the expected
    // pre-registration state; an EACCES (or other I/O) read error must
    // PROPAGATE so `init --unregister` reports the failed reversal instead
    // of claiming success while the region stays in place.
    // ponytail: chmod-based EACCES fails open under root — same caveat as
    // the refresh-failure pin; swap for an immutable-parent sentinel if a
    // root container ever flakes this.
    const { unregisterAgentTools, registerAgentTools } = await loadDeploy();
    const home = await mkTemp(t, "scoutline-agent-home-");
    const configRoot = await mkTemp(t, "scoutline-agent-cfg-");
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9" });
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    await fs.chmod(claudeMd, 0o000);
    try {
      await assert.rejects(
        () =>
          unregisterAgentTools({
            home,
            configRoot,
            configFilePath: path.join(configRoot, "config.json"),
          }),
        /EACCES|permission/i,
        "an unreadable shared file must reject the reversal, not pass as already-clean",
      );
    } finally {
      await fs.chmod(claudeMd, 0o600);
    }
  });
});

describe("main() wiring (DESIGN D5/D6)", () => {
  function makeDeps(overrides = {}) {
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
      ...overrides,
    };
    return { deps, stdout, stderr };
  }

  it("invokes the injected agentRegistrationCheck dependency exactly once per CLI run", async () => {
    // GROUND: D5 "The stamp check is an injectable main() dependency
    // (dependencies.agentRegistrationCheck, production default; tests inject
    // a no-op double)".
    let calls = 0;
    const { deps, stdout } = makeDeps({
      agentRegistrationCheck: async () => {
        calls += 1;
      },
    });

    const code = await main(["history"], deps);

    assert.equal(calls, 1, "the stamp-check hook must fire exactly once before dispatch");
    assert.equal(code, 0);
    assert.match(stdout.join(""), /scoutline history/);
  });

  it("a rejecting agentRegistrationCheck never breaks the invoked command", async () => {
    // GROUND: D5 "Failures are noticed, never fatal to the invoked command" —
    // main() owns that guarantee even if the hook itself rejects.
    let calls = 0;
    const { deps, stdout } = makeDeps({
      agentRegistrationCheck: async () => {
        calls += 1;
        throw new Error("registration infrastructure failure");
      },
    });

    const code = await main(["history"], deps);

    assert.equal(calls, 1, "the hook must actually run");
    assert.equal(code, 0, "a broken refresh must not break the command");
    assert.match(stdout.join(""), /scoutline history/, "command output must be unaffected");
  });

  it("stamp-absent run with the production default check is byte-identical to a no-op-double run", async (t) => {
    // GROUND: D5 "stamp-absent runs emit zero extra stdout/stderr bytes".
    // Env-honest: pinned against an empty injected config root — valid on any
    // machine where that root carries no stamp; a machine with a real
    // registered stamp would exercise the production refresh by design.
    const configRoot = await mkTemp(t);
    const withDouble = makeDeps({ agentRegistrationCheck: async () => {} });
    await main(["history"], withDouble.deps);
    // The production default resolves the config root through the ambient
    // env seam (resolveConfigRoot reads SCOUTLINE_CONFIG_DIR), so scope the
    // process env around the production run in addition to deps.env.
    const previous = process.env.SCOUTLINE_CONFIG_DIR;
    process.env.SCOUTLINE_CONFIG_DIR = configRoot;
    try {
      const production = makeDeps({ env: { SCOUTLINE_CONFIG_DIR: configRoot } });
      await main(["history"], production.deps);

      assert.equal(
        production.stdout.join(""),
        withDouble.stdout.join(""),
        "stamp-absent production runs must add zero stdout bytes",
      );
      assert.equal(
        production.stderr.join(""),
        withDouble.stderr.join(""),
        "stamp-absent production runs must add zero stderr bytes",
      );
    } finally {
      if (previous === undefined) delete process.env.SCOUTLINE_CONFIG_DIR;
      else process.env.SCOUTLINE_CONFIG_DIR = previous;
    }
  });

  it("init --unregister is parsed at the dispatch surface — it does not fall into the interactive wizard", async (t) => {
    // GROUND: D6 "src/index.ts — stamp check in main() + --unregister
    // parse". Surface pin only: the flag must be recognized (non-interactive
    // reversal path), not silently swallowed by the wizard. Exit code and
    // output content are the unregister ticket's contract.
    // Hermetic (D7): without injected roots + check, both the reversal and
    // the pre-dispatch stamp check resolve the production home (~/.claude,
    // ~/.codex, ...) and real config root — pin temp roots/store/no-op so
    // even a parse regression cannot touch the developer's real HOME.
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    const { deps, stderr } = makeDeps({
      agentRegistrationRoots: { home, configRoot },
      agentRegistrationCheck: async () => ({ refreshed: false }),
      initConfigStore: createDefaultConfigStore({ filePath: path.join(configRoot, "config.json") }),
    });
    await main(["init", "--unregister"], deps);

    assert.doesNotMatch(
      stderr.join(""),
      /requires an interactive terminal/,
      "--unregister must never route into the interactive wizard's non-TTY refuse",
    );
  });

  it("init --unregister never issues a wizard prompt", async (t) => {
    // GROUND: D6 surface pin, TTY side — unregister is non-interactive by
    // construction; any prompt attempt is a parse leak into the wizard.
    // Hermetic (D7): pin the reversal roots to temp dirs and keep the
    // pre-dispatch stamp check off the real home — the disk scan must never
    // touch the developer's real HOME.
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    let promptAttempts = 0;
    const refuse = () => {
      promptAttempts += 1;
      throw new Error("wizard prompt must not run for --unregister");
    };
    const prompts = {
      checkbox: refuse,
      select: refuse,
      confirm: refuse,
      password: refuse,
      input: refuse,
    };
    const { deps } = makeDeps({
      agentRegistrationRoots: { home, configRoot },
      agentRegistrationCheck: async () => ({ refreshed: false }),
      initPrompts: prompts,
      initConfigStore: createDefaultConfigStore({ filePath: path.join(configRoot, "config.json") }),
    });
    deps.invocation.stdinIsTTY = true;

    await main(["init", "--unregister"], deps);

    assert.equal(promptAttempts, 0, "--unregister must be consumed before any wizard prompt");
  });

  it("init --unregister --help prints help — the destructive reversal never fires on a help invocation", async (t) => {
    // GROUND: bot-review High — the --unregister branch ran its disk-scan
    // reversal even when --help was present; the isHelpInvocation binding
    // must win (documentation, not a run). Hermetic (D7, sibling pattern):
    // temp roots + no-op check + tmp store; a pre-registered agentRules must
    // survive untouched.
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    const configPath = path.join(configRoot, "config.json");
    await fs.mkdir(configRoot, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ version: 1, providers: {}, agentRules: { claude: true } }),
    );
    const { deps, stdout, stderr } = makeDeps({
      agentRegistrationRoots: { home, configRoot },
      agentRegistrationCheck: async () => ({ refreshed: false }),
      initConfigStore: createDefaultConfigStore({ filePath: configPath }),
    });
    deps.invocation.stdinIsTTY = true;

    const code = await main(["init", "--unregister", "--help"], deps);

    assert.equal(code, 0, "help must exit 0");
    assert.match(
      stdout.join(""),
      /--unregister\s+Reverse agent registration/,
      "INIT_HELP must be printed (its Options section documents --unregister)",
    );
    assert.doesNotMatch(stdout.join(""), /agent registration removed/, "no removal success notice");
    assert.doesNotMatch(stderr.join(""), /--unregister failed/, "no reversal failure notice");
    assert.deepEqual(
      JSON.parse(await read(configPath)).agentRules,
      { claude: true },
      "the injected config must not be mutated by the help invocation",
    );
  });

  it("plain init still refuses non-TTY exactly as before (regression pin)", async (t) => {
    // Regression guard for the parse: unchanged init dispatch. Green today
    // by design — it pins that adding --unregister did not alter plain init.
    // Hermetic (D7): pin roots + no-op check so main()'s pre-dispatch stamp
    // check can never resolve the real HOME/config root (sibling of the
    // --unregister wiring tests' injections).
    const home = await mkTemp(t);
    const configRoot = await mkTemp(t);
    const { deps, stderr } = makeDeps({
      agentRegistrationRoots: { home, configRoot },
      agentRegistrationCheck: async () => ({ refreshed: false }),
    });
    const code = await main(["init"], deps);
    assert.equal(code, 1);
    assert.match(stderr.join(""), /requires an interactive terminal/);
  });
});
