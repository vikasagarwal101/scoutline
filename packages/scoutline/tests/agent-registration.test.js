/**
 * Agent registration — T2: tool registry + line/marker mutation engines.
 *
 * Grounds: DESIGN D1 (data-driven registry, directory-probe detection,
 * notice-only cursor row), D2 (line insert / marker block engines with
 * shared rails: search-before-mutate idempotency, first-mutation backup,
 * byte-preserving outside the managed region), D7 (injected home roots,
 * byte-diff pins, idempotency pins, backup pins), PRD AC-2 (six-tool
 * matrix paths), AC-5 (marker format + version stamp), AC-9 (RULE_TEXT
 * verbatim, owner-approved).
 *
 * Hermetic: every test runs against an injected temp home root; no real
 * HOME, zero network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AGENT_TOOLS, RULE_TEXT } from "../dist/lib/agent-registration/registry.js";
import {
  lineInsert,
  markerBlockInsert,
  stripManagedRegion,
} from "../dist/lib/agent-registration/engines.js";
import {
  checkAgentRegistration,
  computeRuleTextHash,
  readAgentRegistrationStamp,
  registerAgentTools,
  unregisterAgentTools,
} from "../dist/lib/agent-registration/deploy.js";

const POINTER_LINE = "@rules/scoutline.md";
const START = "<!-- scoutline:start -->";
const END = "<!-- scoutline:end -->";

async function mkHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-agent-reg-"));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  return home;
}

async function read(p) {
  return fs.readFile(p, "utf8");
}

function tool(id) {
  const row = AGENT_TOOLS.find((row) => row.id === id);
  assert.ok(row, `registry must contain a "${id}" row`);
  return row;
}

// AC-9 verbatim (owner-approved 2026-09-08); em-dashes and backticks are
// load-bearing — T6 pins CHANGELOG against this byte-for-byte.
const RULE_TEXT_EXPECTED =
  "scoutline is installed — an agent-first CLI for web research\n" +
  "with provider routing, caching, and provenance built in.\n" +
  "Prefer it over raw curl/browser tools so results are\n" +
  "reproducible and quotable. Reach for it whenever the task\n" +
  "needs: web search (multi-provider, comparable), reading pages\n" +
  "or PDFs, fetching with content digests, site crawls,\n" +
  "multi-step research synthesis, archived/temporal lookups\n" +
  "(Wayback), or page-change monitoring. `scoutline --help`\n" +
  "lists the command surface; for flags, usage, and workflows,\n" +
  "load the `scoutline` agent skill — it is the working guide.";

describe("agent tool registry (D1)", () => {
  it("covers exactly the six tool rows plus the notice-only cursor row", () => {
    assert.deepEqual(AGENT_TOOLS.map((row) => row.id).sort(), [
      "claude",
      "codex",
      "copilot",
      "cursor",
      "gemini",
      "opencode",
      "qwen",
    ]);
  });

  it("detect probes the documented home directory per tool — present/absent", async (t) => {
    // D1: detection = directory-existence probes; tests inject roots.
    const probeDirs = {
      claude: ".claude",
      opencode: path.join(".config", "opencode"),
      codex: ".codex",
      gemini: ".gemini",
      qwen: ".qwen",
      copilot: ".copilot",
      cursor: ".cursor",
    };
    for (const [id, rel] of Object.entries(probeDirs)) {
      const row = tool(id);
      const absentHome = await mkHome(t);
      assert.strictEqual(
        await row.detect(absentHome),
        false,
        `${id} must not detect in an empty home`,
      );
      await fs.mkdir(path.join(absentHome, rel), { recursive: true });
      assert.strictEqual(
        await row.detect(absentHome),
        true,
        `${id} must detect when ${rel} exists`,
      );
    }
  });

  it("cursor is a detection-only row: honest notice, no mutation engines, no skill home", () => {
    const row = tool("cursor");
    assert.ok(
      typeof row.unsupportedNotice === "string" && row.unsupportedNotice.length > 0,
      "cursor row must carry an unsupportedNotice",
    );
    assert.strictEqual(row.pointer, undefined, "cursor must have no pointer engine");
    assert.strictEqual(row.skillHome, undefined, "cursor must have no skill home");
  });

  it("pins the documented registry paths for the line/block tools (AC-2, D1)", async (t) => {
    const home = await mkHome(t);
    const j = (...parts) => path.join(home, ...parts);

    const claude = tool("claude");
    assert.equal(claude.rulesFile(home), j(".claude", "rules", "scoutline.md"));
    assert.equal(claude.pointer.kind, "line");
    assert.equal(claude.pointer.target(home), j(".claude", "CLAUDE.md"));
    assert.equal(claude.skillHome(home), j(".claude", "skills"));

    const gemini = tool("gemini");
    assert.equal(gemini.rulesFile(home), j(".gemini", "rules", "scoutline.md"));
    assert.equal(gemini.pointer.kind, "line");
    assert.equal(gemini.pointer.target(home), j(".gemini", "GEMINI.md"));

    const codex = tool("codex");
    assert.equal(codex.pointer.kind, "block");
    assert.equal(codex.pointer.target(home), j(".codex", "AGENTS.md"));
    assert.equal(codex.skillHome(home), j(".codex", "skills"));

    const qwen = tool("qwen");
    assert.equal(qwen.pointer.kind, "block");
    assert.equal(qwen.pointer.target(home), j(".qwen", "QWEN.md"));
    assert.equal(qwen.skillHome(home), j(".qwen", "skills"));

    const opencode = tool("opencode");
    assert.equal(opencode.pointer.kind, "jsonArray");
    assert.equal(opencode.rulesFile(home), j(".config", "opencode", "rules", "scoutline.md"));
    assert.equal(opencode.skillHome(home), j(".config", "opencode", "skills"));

    // Copilot: pointer-free thin rules file + native skills home (D3).
    const copilot = tool("copilot");
    assert.equal(
      copilot.rulesFile(home),
      j(".copilot", "instructions", "scoutline.instructions.md"),
    );
    assert.ok(copilot.skillHome, "copilot must have a skill home");
    assert.ok(copilot.skillHome(home).includes(path.join(".copilot", "skills")));

    // Every one of the six tools has a skill home (D3); gemini's is the
    // documented global config home, not the legacy antigravity dir.
    for (const id of ["claude", "opencode", "codex", "gemini", "qwen", "copilot"]) {
      const skillHome = tool(id).skillHome(home);
      assert.ok(skillHome, `${id} must declare skillHome`);
      assert.ok(skillHome.startsWith(home), `${id} skillHome must live under the injected home`);
      assert.ok(skillHome.includes("skills"), `${id} skillHome must be a skills home`);
    }
    assert.ok(
      !tool("gemini").skillHome(home).includes("antigravity"),
      "gemini uses the documented global home, not the legacy antigravity dir",
    );
  });
});

describe("RULE_TEXT (AC-9)", () => {
  it("matches the owner-approved thin rule text byte-for-byte", () => {
    assert.equal(RULE_TEXT, RULE_TEXT_EXPECTED);
  });
});

describe("line insert engine (D2 — claude @rules/, gemini @ import)", () => {
  it("CRLF pre-existing file round-trips byte-identically through register + unregister (no stranded \\r)", async (t) => {
    // GROUND: the strip's newline swallow takes the FOLLOWING newline first —
    // eating backwards through a CRLF file's own \r\n strands a lone \r
    // (macroscope round 2). Both the append and splice placements must
    // restore the exact original bytes.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-crlf-"));
    t.after(async () => fs.rm(dir, { recursive: true, force: true }));
    const original = "# my notes\r\nsecond line\r\n";
    const pointer = "@rules/scoutline.md";

    // Append placement (convention absent).
    const appended = path.join(dir, "CLAUDE-append.md");
    await fs.writeFile(appended, original, "binary");
    await lineInsert({ filePath: appended, line: pointer });
    await stripManagedRegion(appended, pointer);
    assert.equal(
      (await fs.readFile(appended, "binary")).toString("binary"),
      original,
      "CRLF append placement must round-trip byte-identically",
    );

    // Splice placement (convention present between CRLF lines).
    const spliced = path.join(dir, "CLAUDE-splice.md");
    const withConv = "# my notes\r\n@rules/other.md\r\nsecond line\r\n";
    await fs.writeFile(spliced, withConv, "binary");
    await lineInsert({ filePath: spliced, line: pointer, convention: /^@rules\// });
    await stripManagedRegion(spliced, pointer);
    assert.equal(
      (await fs.readFile(spliced, "binary")).toString("binary"),
      withConv,
      "CRLF splice placement must round-trip byte-identically",
    );
  });

  it("appends a marker-wrapped pointer line at file end, preserving prior bytes exactly", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "CLAUDE.md");
    const original = "# My rules\n\nsome user content\n";
    await fs.writeFile(file, original);

    await lineInsert({ filePath: file, line: POINTER_LINE });

    const after = await read(file);
    assert.ok(after.startsWith(original), "bytes before the insertion must be untouched");
    assert.ok(after.includes(START) && after.includes(END), "pointer line must be marker-wrapped");
    assert.ok(
      after.includes(`\n${POINTER_LINE}\n`),
      "pointer line must be present as its own line",
    );
  });

  it("places the pointer under the existing rules list when the convention is present", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "GEMINI.md");
    const original = "# Gemini\n\n@rules/other.md\n@rules/second.md\n\ntrailing user text\n";
    await fs.writeFile(file, original);

    await lineInsert({ filePath: file, line: POINTER_LINE, convention: /^@rules\// });

    const after = await read(file);
    const lastConvention = after.indexOf("@rules/second.md\n");
    const inserted = after.indexOf(`@rules/${"scoutline.md"}`);
    assert.ok(inserted > lastConvention, "pointer must land after the last convention line");
    assert.ok(
      after.indexOf("trailing user text") > inserted,
      "trailing bytes must survive below the insertion",
    );
    assert.ok(
      after.startsWith("# Gemini\n\n@rules/other.md\n"),
      "bytes above the insertion untouched",
    );
  });

  it("is idempotent — re-run yields a byte-identical file (zero-diff pin)", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "CLAUDE.md");
    await fs.writeFile(file, "existing\n@rules/x.md\n");
    await lineInsert({ filePath: file, line: POINTER_LINE, convention: /^@rules\// });
    const once = await read(file);

    await lineInsert({ filePath: file, line: POINTER_LINE, convention: /^@rules\// });

    assert.equal(await read(file), once, "duplicate line insert must be a zero diff");
  });
});

describe("marker block engine (D2 — codex AGENTS.md, qwen QWEN.md; AC-5)", () => {
  it("augments a pre-existing file with a version-stamped scoutline block, bytes outside untouched", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "AGENTS.md");
    const original = "# Agent guide\n\nuser keeps this\n";
    await fs.writeFile(file, original);

    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "9.9.9-test" });

    const after = await read(file);
    assert.ok(after.startsWith(original), "pre-existing bytes must be preserved verbatim");
    assert.ok(after.includes(START) && after.includes(END), "block must be marker-wrapped (AC-5)");
    assert.ok(
      after.includes("<!-- scoutline:v9.9.9-test -->"),
      "block must carry the version stamp (AC-5)",
    );
    assert.ok(after.includes(RULE_TEXT), "block must carry the rule text");
    assert.ok(after.indexOf(END) > after.indexOf(START), "markers must be ordered");
  });

  it("creates the file when absent (qwen create-or-augment) and mints no backup for it", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "QWEN.md");

    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "9.9.9-test" });

    const after = await read(file);
    assert.ok(after.includes(START) && after.includes(RULE_TEXT) && after.includes(END));
    const backup = await fs.readdir(home);
    assert.ok(
      !backup.some((n) => n.endsWith(".scoutline-bak")),
      "a file we create must not be backed up",
    );
  });

  it("is idempotent — re-run at the same version yields a byte-identical file (zero-diff pin)", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "AGENTS.md");
    await fs.writeFile(file, "user header\n");
    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "9.9.9-test" });
    const once = await read(file);

    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "9.9.9-test" });

    assert.equal(await read(file), once, "duplicate block insert must be a zero diff");
  });

  it("rewrites the region in place on version bump — everything outside the block untouched", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "AGENTS.md");
    await fs.writeFile(file, "user header\n");
    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "1.0.0" });
    const before = await read(file);

    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "2.0.0" });
    const after = await read(file);

    assert.ok(after.includes("<!-- scoutline:v2.0.0 -->"), "stamp must update");
    assert.ok(!after.includes("v1.0.0"), "old stamp must not linger");
    assert.equal(
      after.replace("v2.0.0", "v1.0.0"),
      before,
      "only the version stamp may differ — bytes outside the block identical",
    );
    assert.equal(
      after.slice(0, after.indexOf(START)),
      before.slice(0, before.indexOf(START)),
      "bytes before the block unchanged",
    );
    const stripBlock = (s) =>
      s.replace(s.slice(s.indexOf(START), s.indexOf(END) + END.length + 1), "");
    assert.equal(stripBlock(after), stripBlock(before), "bytes after the block unchanged");
  });
});

describe("foreign marker-pair protection (A2/A3 — marker block engine)", () => {
  it("register beside a pre-existing foreign pair: our block appended, foreign bytes untouched, backup still minted", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "AGENTS.md");
    const foreignPair =
      "<!-- scoutline:start -->\nuser's own managed note\n<!-- scoutline:end -->\n";
    await fs.writeFile(file, foreignPair);

    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "9.9.9-test" });

    const after = await read(file);
    assert.ok(
      after.startsWith(foreignPair),
      "foreign pair bytes preserved verbatim at the head of the file",
    );
    assert.ok(
      after.includes(`<!-- scoutline:v9.9.9-test -->`) && after.includes(RULE_TEXT),
      "our block appended after the foreign content",
    );
    assert.equal(
      await read(`${file}.scoutline-bak`),
      foreignPair,
      "a foreign pair must NOT suppress the disaster-recovery backup (A3)",
    );
  });

  it("version-bump refresh on a foreign+ours file rewrites only OUR region", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "AGENTS.md");
    const foreignPair =
      "<!-- scoutline:start -->\nuser's own managed note\n<!-- scoutline:end -->\n";
    await fs.writeFile(file, foreignPair);
    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "1.0.0" });
    const before = await read(file);

    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "2.0.0" });
    const after = await read(file);

    assert.ok(after.includes("<!-- scoutline:v2.0.0 -->"), "our stamp updated");
    assert.ok(!after.includes("v1.0.0"), "old stamp gone");
    assert.ok(after.startsWith(foreignPair), "foreign pair still byte-untouched");
    assert.equal(
      after.slice(foreignPair.length),
      before.slice(foreignPair.length).replace("v1.0.0", "v2.0.0"),
      "only our region changed — bytes outside it identical",
    );
  });
});

describe("pre-existing unwrapped pointer line (A4 — user-owned, hands off)", () => {
  it("register is a NO-OP on a file already carrying the unwrapped pointer line", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "CLAUDE.md");
    const original = "# My rules\n\n@rules/scoutline.md\nsome user note\n";
    await fs.writeFile(file, original);

    await lineInsert({ filePath: file, line: POINTER_LINE });

    assert.equal(
      await read(file),
      original,
      "register must not rewrite user-owned bytes (no wrap-upgrade)",
    );
    const siblings = await fs.readdir(home);
    assert.ok(
      !siblings.some((n) => n.endsWith(".scoutline-bak")),
      "no mutation → no backup minted",
    );
  });

  it("unregister leaves the unwrapped line and its file alone", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "CLAUDE.md");
    const original = "# My rules\n\n@rules/scoutline.md\n";
    await fs.writeFile(file, original);

    await stripManagedRegion(file, POINTER_LINE);

    assert.equal(
      await read(file),
      original,
      "unregister must not touch a file with no managed region",
    );
  });
});

describe("stripManagedRegion whitespace survivor (#123)", () => {
  it("keeps a pre-existing whitespace-only file byte-identical through register + unregister", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "CLAUDE.md");
    const original = " \n"; // user-owned whitespace bytes — content, not absence
    await fs.writeFile(file, original);

    await lineInsert({ filePath: file, line: POINTER_LINE });
    await stripManagedRegion(file, POINTER_LINE);

    await fs.access(file); // must survive — the strip must not delete it
    assert.equal(
      await read(file),
      original,
      "whitespace-only user file must survive unregister byte-identically",
    );
  });

  it("still deletes a byte-empty survivor — a file the registration itself created", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "QWEN.md");

    await lineInsert({ filePath: file, line: POINTER_LINE }); // mints the file
    assert.equal(await read(file), `${START}\n${POINTER_LINE}\n${END}\n`);
    await stripManagedRegion(file, POINTER_LINE);

    await assert.rejects(() => fs.access(file), { code: "ENOENT" });
  });

  it("survives a whitespace-only file without trailing newline (accepted edge, bytes pinned as-is)", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "CLAUDE.md");
    const original = "  "; // two spaces, no trailing newline
    await fs.writeFile(file, original);

    await lineInsert({ filePath: file, line: POINTER_LINE });
    await stripManagedRegion(file, POINTER_LINE);

    await fs.access(file);
    // ACCEPTED EDGE (#123 triage): a no-EOL file gains one glue "\n" at
    // insert time; the strip's swallow-one-newline heuristic (engines.ts,
    // following-newline-first) restores the original bytes here, so the
    // round-trip below is byte-exact. If the heuristic ever eats the other
    // boundary this pin is the documented place to revisit.
    assert.equal(await read(file), original, "no-EOL whitespace file must survive unregister");
  });
});

describe("first-mutation backup rail (D2)", () => {
  it("mints <file>.scoutline-bak with the exact pre-mutation bytes on first mutation", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "CLAUDE.md");
    const original = "precious user bytes\n";
    await fs.writeFile(file, original);

    await lineInsert({ filePath: file, line: POINTER_LINE });
    const backup = await read(`${file}.scoutline-bak`);
    assert.equal(backup, original, "backup must hold the exact pre-mutation bytes");
  });

  it("never mints a second backup — refresh cycles keep exactly one, original bytes", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "AGENTS.md");
    const original = "user bytes\n";
    await fs.writeFile(file, original);
    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "1.0.0" });
    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "2.0.0" });

    const siblings = (await fs.readdir(home)).filter((n) => n.startsWith("AGENTS.md"));
    assert.equal(
      siblings.filter((n) => n.endsWith(".scoutline-bak")).length,
      1,
      "backup count must stay bounded at one per file",
    );
    assert.equal(
      await read(`${file}.scoutline-bak`),
      original,
      "backup must still be the original snapshot",
    );
  });

  it("no backup minted on refresh of a file we created (create-then-bump)", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "QWEN.md");

    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "1.0.0" });
    await markerBlockInsert({ filePath: file, content: RULE_TEXT, version: "2.0.0" });

    const names = await fs.readdir(home);
    assert.ok(
      !names.some((n) => n.endsWith(".scoutline-bak")),
      "refresh of our own block must never mint a backup — nothing pre-existing to protect",
    );
  });
});

describe("partial refresh failure (issue #122)", () => {
  it("keeps the stamp drifted when one tool fails — the failed tool self-heals on the next run", async (t) => {
    const home = await mkHome(t);
    const configRoot = await mkHome(t);

    await registerAgentTools({ home, configRoot, tools: ["claude", "codex"], version: "9.9.9" });

    // Sabotage codex only: replace its home dir with a regular file so the
    // skill deploy's mkdir under <home>/.codex fails with ENOTDIR
    // (root-safe sabotage — no chmod, works in root containers).
    const codexHome = path.join(home, ".codex");
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.writeFile(codexHome, "not a directory");

    const notices = [];
    const first = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.10",
      writeStderr: (value) => notices.push(value),
    });

    assert.equal(first.refreshed, true, "claude refreshed — the run is still a refresh");
    assert.ok(
      notices.some((n) => n.includes("codex")),
      "the failing tool's stderr notice must be emitted",
    );
    assert.deepEqual(
      await readAgentRegistrationStamp(configRoot),
      { version: "9.9.9", tools: ["claude", "codex"], ruleTextHash: computeRuleTextHash() },
      "a partial failure must NOT rewrite the stamp — the drift must survive so the failed tool retries",
    );

    // Self-heal: restore the codex home and re-run at the same new version.
    await fs.rm(codexHome, { force: true });
    const second = await checkAgentRegistration({
      home,
      configRoot,
      version: "9.9.10",
      writeStderr: (value) => notices.push(value),
    });

    assert.equal(second.refreshed, true, "the surviving drift must trigger the retry");
    await fs.access(path.join(home, ".codex", "skills", "scoutline", "SKILL.md"));
    assert.deepEqual(
      await readAgentRegistrationStamp(configRoot),
      { version: "9.9.10", tools: ["claude", "codex"], ruleTextHash: computeRuleTextHash() },
      "an all-tools-clean refresh writes the new stamp",
    );
  });
});

describe("pointer convention wiring (#121)", () => {
  it("claude pointer lands under the existing rules list at register level, not EOF", async (t) => {
    // Documented design intent (plan 19, line 48): the claude pointer
    // belongs in the Shared Rules list in ~/.claude/CLAUDE.md, not the
    // file end. Dead-wiring regression guard at the registerAgentTools
    // surface (the HIGH seam), not just the engine.
    const home = await mkHome(t);
    const configRoot = await mkHome(t);
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    const original =
      "# My rules\n\nintro user text\n\n@rules/other.md\n@rules/second.md\n\ntrailing user text\n";
    await fs.writeFile(claudeMd, original);

    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9-test" });

    const after = await read(claudeMd);
    const inserted = after.indexOf(`${START}\n@rules/scoutline.md\n${END}`);
    assert.ok(inserted !== -1, "marker-wrapped pointer must be present");
    assert.ok(
      inserted > after.lastIndexOf("@rules/second.md"),
      "pointer must land AFTER the last @rules/ line",
    );
    assert.ok(
      inserted < after.indexOf("trailing user text"),
      "pointer must NOT land at EOF — user content stays below",
    );
    assert.ok(
      after.startsWith("# My rules\n\nintro user text\n\n"),
      "bytes above the insertion untouched",
    );
  });

  it("gemini pointer lands under the existing @import rules list at register level", async (t) => {
    const home = await mkHome(t);
    const configRoot = await mkHome(t);
    await fs.mkdir(path.join(home, ".gemini"), { recursive: true });
    const geminiMd = path.join(home, ".gemini", "GEMINI.md");
    const original = "# Gemini rules\n\n@~/.gemini/rules/other.md\n\ntrailing user text\n";
    await fs.writeFile(geminiMd, original);

    await registerAgentTools({ home, configRoot, tools: ["gemini"], version: "9.9.9-test" });

    const after = await read(geminiMd);
    const inserted = after.indexOf(`${START}\n@~/.gemini/rules/scoutline.md\n${END}`);
    assert.ok(inserted !== -1, "marker-wrapped gemini pointer must be present");
    assert.ok(
      inserted > after.lastIndexOf("@~/.gemini/rules/other.md"),
      "gemini pointer must land AFTER the last @…/rules/ import line",
    );
    assert.ok(
      inserted < after.indexOf("trailing user text"),
      "gemini pointer must NOT land at EOF",
    );
  });

  it("no convention-matching line → pointer lands at EOF (fallback unchanged), register level", async (t) => {
    const home = await mkHome(t);
    const configRoot = await mkHome(t);
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    const original = "# My rules\n\nsome user content\n";
    await fs.writeFile(claudeMd, original);

    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9-test" });

    const after = await read(claudeMd);
    assert.ok(after.startsWith(original), "bytes above the insertion untouched");
    assert.ok(
      after.endsWith(`${START}\n@rules/scoutline.md\n${END}\n`),
      "pointer must land at EOF when no convention line exists",
    );
  });

  it("exactly the claude and gemini rows carry a pointer convention (extension boundary)", () => {
    const carrying = AGENT_TOOLS.filter((row) => row.pointer?.convention !== undefined).map(
      (row) => row.id,
    );
    assert.deepEqual(carrying.sort(), ["claude", "gemini"]);

    const claudeConvention = tool("claude").pointer.convention;
    const geminiConvention = tool("gemini").pointer.convention;
    assert.ok(claudeConvention instanceof RegExp, "claude convention must be a RegExp");
    assert.ok(geminiConvention instanceof RegExp, "gemini convention must be a RegExp");
    // claude: the bare @rules/ include it deploys matches; a home-anchored
    // @import line does not.
    assert.ok(claudeConvention.test("@rules/scoutline.md"));
    assert.ok(!claudeConvention.test("@~/.gemini/rules/other.md"));
    // gemini: the home-anchored @import it deploys matches; claude-style
    // bare relative lines and prose do not.
    assert.ok(geminiConvention.test("@~/.gemini/rules/scoutline.md"));
    assert.ok(!geminiConvention.test("@rules/other.md"));
    assert.ok(!geminiConvention.test("see @ rules folder"));
  });

  it("re-register is a byte-identical zero diff under the under-list placement", async (t) => {
    const home = await mkHome(t);
    const configRoot = await mkHome(t);
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    await fs.writeFile(claudeMd, "# My rules\n\n@rules/other.md\ntrailing text\n");

    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9-test" });
    const once = await read(claudeMd);
    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9-test" });

    assert.equal(await read(claudeMd), once, "re-registration must be a zero diff");
  });

  it("unregister restores the byte-identical pre-registration file (both directions guarded)", async (t) => {
    const home = await mkHome(t);
    const configRoot = await mkHome(t);
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    const original = "# My rules\n\n@rules/other.md\n\ntrailing user text\n";
    await fs.writeFile(claudeMd, original);

    await registerAgentTools({ home, configRoot, tools: ["claude"], version: "9.9.9-test" });
    assert.notEqual(await read(claudeMd), original, "registration must have mutated the file");

    await unregisterAgentTools({
      home,
      configRoot,
      configFilePath: path.join(configRoot, "config.json"),
    });

    assert.equal(
      await read(claudeMd),
      original,
      "unregister must restore the exact pre-registration bytes",
    );
  });
});
