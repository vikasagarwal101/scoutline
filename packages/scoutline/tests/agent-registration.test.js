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
import { lineInsert, markerBlockInsert } from "../dist/lib/agent-registration/engines.js";

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
    assert.deepEqual(
      AGENT_TOOLS.map((row) => row.id).sort(),
      ["claude", "codex", "copilot", "cursor", "gemini", "opencode", "qwen"],
    );
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
    assert.equal(copilot.rulesFile(home), j(".copilot", "instructions", "scoutline.instructions.md"));
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
    assert.ok(!tool("gemini").skillHome(home).includes("antigravity"), "gemini uses the documented global home, not the legacy antigravity dir");
  });
});

describe("RULE_TEXT (AC-9)", () => {
  it("matches the owner-approved thin rule text byte-for-byte", () => {
    assert.equal(RULE_TEXT, RULE_TEXT_EXPECTED);
  });
});

describe("line insert engine (D2 — claude @rules/, gemini @ import)", () => {
  it("appends a marker-wrapped pointer line at file end, preserving prior bytes exactly", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "CLAUDE.md");
    const original = "# My rules\n\nsome user content\n";
    await fs.writeFile(file, original);

    await lineInsert({ filePath: file, line: POINTER_LINE });

    const after = await read(file);
    assert.ok(after.startsWith(original), "bytes before the insertion must be untouched");
    assert.ok(after.includes(START) && after.includes(END), "pointer line must be marker-wrapped");
    assert.ok(after.includes(`\n${POINTER_LINE}\n`), "pointer line must be present as its own line");
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
    assert.ok(after.indexOf("trailing user text") > inserted, "trailing bytes must survive below the insertion");
    assert.ok(after.startsWith("# Gemini\n\n@rules/other.md\n"), "bytes above the insertion untouched");
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
    assert.ok(after.includes("<!-- scoutline:v9.9.9-test -->"), "block must carry the version stamp (AC-5)");
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
    assert.ok(!backup.some((n) => n.endsWith(".scoutline-bak")), "a file we create must not be backed up");
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
    assert.equal(after.slice(0, after.indexOf(START)), before.slice(0, before.indexOf(START)), 'bytes before the block unchanged');
    const stripBlock = (s) => s.replace(s.slice(s.indexOf(START), s.indexOf(END) + END.length + 1), '');
    assert.equal(stripBlock(after), stripBlock(before), 'bytes after the block unchanged');
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
    assert.equal(await read(`${file}.scoutline-bak`), original, "backup must still be the original snapshot");
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
