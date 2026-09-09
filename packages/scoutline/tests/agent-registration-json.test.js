/**
 * Agent registration — T3: JSON-array pointer engine (opencode).
 *
 * Grounds: DESIGN D2 JSON array insert engine (surgical text insert before
 * `]`, formatting preserved; empty array without leading comma; absent key
 * as new top-level element; JSON.parse validation; parse failure → restore
 * original bytes + surfaced error; atomic tmp+rename; first-mutation backup
 * rail), DESIGN D1/D7 (registry opencode row pins, injected home roots,
 * fixture trees, rollback pin, idempotency pin), TASKS T3 bullets 1-4.
 *
 * Hermetic: every test runs against an injected temp home root; no real
 * HOME, zero network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AGENT_TOOLS } from "../dist/lib/agent-registration/registry.js";
import { jsonArrayInsert, jsonArrayRemove } from "../dist/lib/agent-registration/engines.js";

const SKILL_POINTER = "/home/dev/.config/opencode/skills/scoutline/SKILL.md";

async function mkHome(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-agent-json-"));
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

describe("opencode registry row (D1 — jsonArray pointer)", () => {
  it("pins the documented opencode pointer target: ~/.config/opencode/opencode.json", async (t) => {
    const home = await mkHome(t);
    const row = tool("opencode");
    assert.equal(row.pointer.kind, "jsonArray");
    assert.equal(row.pointer.target(home), path.join(home, ".config", "opencode", "opencode.json"));
  });
});

describe("JSON array insert engine (D2 — opencode instructions)", () => {
  it("inserts into a populated instructions array; all other formatting preserved (fixture with dense/odd formatting)", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    // Dense/odd: single-line sibling array, no trailing newline, CRLF in a
    // string, tabs, 3-space indent in instructions.
    const original =
      '{"theme":"dark","keybinds":[  "a", "b" ],\n' +
      `   "instructions": [\n   "https://example.com/a.md",\n\t"https://example.com/b.md"\n   ],\n` +
      '"model":"xyz"}';
    await fs.writeFile(file, original);

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    const after = await read(file);
    const parsed = JSON.parse(after);
    assert.equal(parsed.theme, "dark", "unrelated scalar untouched");
    assert.deepEqual(parsed.keybinds, ["a", "b"], "unrelated array untouched");
    assert.equal(parsed.model, "xyz", "unrelated trailing key untouched");
    assert.deepEqual(
      parsed.instructions,
      ["https://example.com/a.md", "https://example.com/b.md", SKILL_POINTER],
      "skill pointer appended to instructions",
    );
    // Formatting pin: outside the inserted element the bytes are identical.
    assert.ok(
      after.startsWith(original.slice(0, original.indexOf('"instructions"'))),
      "bytes before the array untouched",
    );
    assert.ok(after.endsWith('"model":"xyz"}'), "bytes after the array untouched");
    assert.ok(
      after.includes(`,\n    "${SKILL_POINTER}"`),
      'inserted as D2\'s ,\\n    "<path>" text form before ]',
    );
  });

  it("empty instructions: [] inserts without a leading comma", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(file, '{"theme":"dark","instructions":[]}');

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    const after = await read(file);
    const parsed = JSON.parse(after);
    assert.deepEqual(parsed.instructions, [SKILL_POINTER]);
    assert.equal(parsed.theme, "dark");
    assert.ok(
      !after.includes(`,${JSON.stringify(SKILL_POINTER)}`),
      "no leading comma before the element",
    );
    assert.ok(
      !after.includes(`, ${JSON.stringify(SKILL_POINTER)}`),
      "no leading comma before the element (spaced)",
    );
    assert.ok(after.includes(`"${SKILL_POINTER}"`), "element present");
  });

  it('absent instructions key: a new top-level "instructions": ["<path>"] element is inserted', async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    const original = '{"theme":"dark","model":"big"}';
    await fs.writeFile(file, original);

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    const after = await read(file);
    const parsed = JSON.parse(after);
    assert.deepEqual(
      parsed.instructions,
      [SKILL_POINTER],
      "instructions created with exactly the skill pointer",
    );
    assert.equal(parsed.theme, "dark", "existing keys preserved");
    assert.equal(parsed.model, "big", "existing keys preserved");
    assert.ok(
      after.startsWith(original.slice(0, original.length - 1)),
      "existing bytes before the new element untouched",
    );
  });

  it("writes atomically — no tmp residue survives in the directory", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(file, '{"instructions":["https://example.com/a.md"]}');

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    const names = await fs.readdir(home);
    assert.ok(
      !names.some((n) => n.includes(".tmp")),
      "no tmp file survives — the write went through atomic tmp+rename",
    );
    assert.deepEqual(
      names.sort(),
      ["opencode.json", "opencode.json.scoutline-bak"],
      "only the config plus its first-mutation backup remain",
    );
  });

  it("mints <file>.scoutline-bak with the pre-mutation bytes on first mutation of a pre-existing file (shared backup rail, D2)", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    const original = '{"instructions":[]}';
    await fs.writeFile(file, original);

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    assert.equal(
      await read(`${file}.scoutline-bak`),
      original,
      "backup holds the exact pre-mutation bytes",
    );
  });

  it("idempotency check is scoped to the instructions array — the element appearing under another key does not block the insert", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(file, `{"model":"${SKILL_POINTER}","instructions":[]}`);

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    const parsed = JSON.parse(await read(file));
    assert.deepEqual(
      parsed.instructions,
      [SKILL_POINTER],
      "empty instructions array must still receive the pointer",
    );
  });

  it("string/escape-aware array scan: a ] inside a string value does not terminate the array", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(file, '{"instructions":["docs/[draft]*.md"]}');

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    const parsed = JSON.parse(await read(file));
    assert.deepEqual(
      parsed.instructions,
      ["docs/[draft]*.md", SKILL_POINTER],
      "registers successfully with entries parsed",
    );
  });

  it("nested arrays: the element is appended to the outer array with the inner array intact", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(file, '{"instructions":[[1,2]]}');

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    const parsed = JSON.parse(await read(file));
    assert.equal(parsed.instructions.length, 2, "pointer appended to the outer array");
    assert.deepEqual(parsed.instructions[0], [1, 2], "inner array intact");
    assert.equal(parsed.instructions[1], SKILL_POINTER);
  });
});

describe("rollback pin (D2 parse failure → original bytes restored, error surfaced, non-zero exit)", () => {
  it("restores the original bytes and rejects when the mutated text cannot be parsed", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    // Pre-existing trailing comma makes opencode.json non-JSON5 (and a
    // naive text-insert before `]` yields a document JSON.parse rejects).
    const original = '{"theme":"dark","instructions":["https://example.com/a.md",]}';
    await fs.writeFile(file, original);

    await assert.rejects(
      jsonArrayInsert({ filePath: file, element: SKILL_POINTER }),
      /parse|JSON|invalid/i,
      "parse failure must surface an error (init-time registration exits non-zero)",
    );

    assert.equal(await read(file), original, "original bytes must be restored on disk");
    // Semantics preserved too: the restored bytes parse back to the original
    // state (strip the trailing comma that makes the fixture non-strict-JSON).
    const semantic = JSON.parse(original.replace(/,\]/, "]"));
    assert.equal(semantic.instructions.length, 1, "no stray element was added");
    assert.equal(semantic.theme, "dark", "unrelated keys intact after rollback");
  });

  it("leaves no tmp residue after a failed write (rollback is clean)", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(file, '{"instructions":["https://example.com/a.md",]}');

    await assert.rejects(jsonArrayInsert({ filePath: file, element: SKILL_POINTER }));

    const names = await fs.readdir(home);
    assert.ok(!names.some((n) => n.includes(".tmp")), "no tmp file survives the rollback");
    assert.equal(names.filter((n) => n === "opencode.json").length, 1, "config file present");
  });
});

describe("idempotency (D2 search-before-mutate; TASKS T3 bullet 3)", () => {
  it("double-register is a zero diff — byte-identical file", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(file, '{"instructions":["https://example.com/a.md"]}');
    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });
    const once = await read(file);

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    assert.equal(await read(file), once, "duplicate array insert must be a zero diff");
  });

  it("is idempotent against the empty-array and absent-key fixtures too", async (t) => {
    const home = await mkHome(t);
    const emptyFile = path.join(home, "empty.json");
    await fs.writeFile(emptyFile, '{"instructions":[]}');
    await jsonArrayInsert({ filePath: emptyFile, element: SKILL_POINTER });
    const emptyOnce = await read(emptyFile);
    await jsonArrayInsert({ filePath: emptyFile, element: SKILL_POINTER });
    assert.equal(await read(emptyFile), emptyOnce);

    const absentFile = path.join(home, "absent.json");
    await fs.writeFile(absentFile, '{"theme":"dark"}');
    await jsonArrayInsert({ filePath: absentFile, element: SKILL_POINTER });
    const absentOnce = await read(absentFile);
    await jsonArrayInsert({ filePath: absentFile, element: SKILL_POINTER });
    assert.equal(await read(absentFile), absentOnce);
    assert.equal(JSON.parse(absentOnce).instructions.length, 1);
  });
});

describe("empty-object mint recognizes internal whitespace (A1)", () => {
  for (const [name, fixture] of [
    ["`{ }` (inner space)", "{ }"],
    ["`{\\n}` (inner newline)", "{\n}"],
  ]) {
    it(`mint branch fires for ${name}: registration succeeds, doc valid, idempotent, unregister removes the element`, async (t) => {
      const home = await mkHome(t);
      const file = path.join(home, "opencode.json");
      await fs.writeFile(file, fixture);

      await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

      const once = await read(file);
      assert.deepEqual(
        JSON.parse(once).instructions,
        [SKILL_POINTER],
        "minted document is valid JSON carrying the pointer",
      );

      await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });
      assert.equal(await read(file), once, "double-run idempotent");

      await jsonArrayRemove({ filePath: file, element: SKILL_POINTER });
      const after = await read(file);
      assert.deepEqual(
        JSON.parse(after).instructions,
        [],
        "unregister removed the element and the file stays valid JSON",
      );
    });
  }
});

describe("JSON-safe element encoding (A5 — escape-requiring elements)", () => {
  it("a Windows-style backslash path inserts as valid JSON and removal round-trips to the original bytes", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    const winPath = "C:\\Users\\dev\\.config\\opencode\\skills\\scoutline\\SKILL.md";
    const original = '{"instructions":["https://example.com/a.md"]}';
    await fs.writeFile(file, original);

    await jsonArrayInsert({ filePath: file, element: winPath });

    const after = await read(file);
    assert.deepEqual(
      JSON.parse(after).instructions,
      ["https://example.com/a.md", winPath],
      "backslash path survives as a proper JSON string element",
    );

    await jsonArrayRemove({ filePath: file, element: winPath });

    assert.equal(await read(file), original, "removal restores the original bytes exactly");
  });
});

describe('top-level key location (A6 — nested "instructions" decoys)', () => {
  it('a nested object with its own "instructions" value does not hijack the insert', async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(
      file,
      '{"mcp":{"instructions":"see [docs] here"},"instructions":["https://example.com/a.md"]}',
    );

    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    const parsed = JSON.parse(await read(file));
    assert.deepEqual(
      parsed.instructions,
      ["https://example.com/a.md", SKILL_POINTER],
      "pointer appended to the TOP-LEVEL array",
    );
    assert.equal(parsed.mcp.instructions, "see [docs] here", "nested value untouched");
  });

  it("the same decoy does not hijack removal", async (t) => {
    const home = await mkHome(t);
    const file = path.join(home, "opencode.json");
    await fs.writeFile(
      file,
      '{"mcp":{"instructions":["nested.md"]},"instructions":["https://example.com/a.md"]}',
    );
    await jsonArrayInsert({ filePath: file, element: SKILL_POINTER });

    await jsonArrayRemove({ filePath: file, element: SKILL_POINTER });

    const parsed = JSON.parse(await read(file));
    assert.deepEqual(
      parsed.instructions,
      ["https://example.com/a.md"],
      "removed from the TOP-LEVEL array",
    );
    assert.deepEqual(parsed.mcp.instructions, ["nested.md"], "nested array untouched");
  });
});


describe("invalid pre-existing JSON (PR #116 round 2)", () => {
  it("a parse failure leaves the untouched file byte-identical — no rollback rewrite", async (t) => {
    // GROUND: validation precedes every write, so the failed insert must
    // not rewrite "original" back (a utf8 round-trip could mangle
    // non-UTF-8 bytes, and the write itself is unguarded I/O).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scoutline-badjson-"));
    t.after(async () => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "opencode.json");
    // Invalid JSON carrying a non-UTF-8 byte sequence.
    const raw = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x20, 0xff, 0x7d]); // {"a": ÿ}
    await fs.writeFile(file, raw);
    await assert.rejects(() => jsonArrayInsert({ filePath: file, element: "/x/SKILL.md" }));
    const after = await fs.readFile(file);
    assert.ok(after.equals(raw), "the file must be byte-identical after the failed insert");
  });
});
