/**
 * SCOUTLINE_STRICT_FLAGS opt-in strict flag mode (#241).
 *
 * Outside `batch` (and `vision batch` / `history clear`, which carry
 * their own gates) unknown CLI flags are silently ignored: a typo like
 * `search "q" --fusio rrf` runs as if the flag were absent and the
 * value is swallowed into flag state. This file pins the opt-in strict
 * mode: SCOUTLINE_STRICT_FLAGS set to any non-empty value rejects
 * unknown `--flags` on EVERY command pre-dispatch with the batch-style
 * error, while the default (unset) stays byte-identical lenient.
 *
 * Also pins the #239 rider: MAIN_HELP's capability prose names every
 * Provider — searchapi and kagi included.
 *
 * Tests import from ../dist (the established convention); build first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fsMod from "node:fs/promises";
import * as osMod from "node:os";
import * as pathMod from "node:path";

import { main, findUnknownStrictFlag, STRICT_FLAG_ALLOWLIST } from "../dist/index.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

useTempConfigDir();

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    invocation: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

async function withTempConfig(t, run) {
  const dir = await fsMod.mkdtemp(pathMod.join(osMod.tmpdir(), "scoutline-strict-"));
  t.after(async () => {
    await fsMod.rm(dir, { recursive: true, force: true });
  });
  await run(dir);
}

// ---------------------------------------------------------------------------
// Pure gate: findUnknownStrictFlag(command, args)
// ---------------------------------------------------------------------------

describe("findUnknownStrictFlag (pure)", () => {
  it("returns undefined for an empty/flagless argv", () => {
    assert.strictEqual(findUnknownStrictFlag("search", ["q"]), undefined);
    assert.strictEqual(findUnknownStrictFlag("cache", ["stats"]), undefined);
  });

  it("returns the offending token for a typo'd flag", () => {
    assert.strictEqual(findUnknownStrictFlag("search", ["q", "--fusio", "rrf"]), "--fusio");
  });

  it("exact-spelling semantics: accepted --no-X does not license bare --X", () => {
    // search accepts --no-journal; the plain --journal spelling is not a flag.
    assert.strictEqual(findUnknownStrictFlag("search", ["q", "--no-journal"]), undefined);
    assert.strictEqual(findUnknownStrictFlag("search", ["q", "--journal"]), "--journal");
  });

  it("short flags are checked too (-h accepted, -x rejected)", () => {
    assert.strictEqual(findUnknownStrictFlag("search", ["--help"]), undefined);
    assert.strictEqual(findUnknownStrictFlag("search", ["-h"]), undefined);
    assert.strictEqual(findUnknownStrictFlag("search", ["q", "-x"]), "-x");
  });

  it("a lone '-' (batch stdin marker) is positional, not a flag", () => {
    assert.strictEqual(findUnknownStrictFlag("batch", ["-"]), undefined);
  });

  it("every dispatched command has an allowlist row", async () => {
    const { DISPATCHED_COMMANDS } = await import("../dist/index.js");
    for (const command of DISPATCHED_COMMANDS) {
      assert.ok(
        STRICT_FLAG_ALLOWLIST[command] instanceof Set,
        `STRICT_FLAG_ALLOWLIST must cover "${command}"`,
      );
    }
  });

  it("representative accepted argv per command passes the gate", () => {
    const vectors = {
      vision: ["analyze", "./shot.png", "prompt", "--focus", "ui"],
      search: [
        "q",
        "--count",
        "5",
        "--topic",
        "news",
        "--domain",
        "example.com",
        "--recency",
        "7d",
        "--fields",
        "title,url",
        "--location",
        "us",
        "--content-size",
        "high",
        "--merge",
        "--max-summary",
        "80",
        "--no-cache",
        "--max-chars",
        "2000",
        "--context",
        "notes.md",
        "--no-journal",
      ],
      read: [
        "https://example.com",
        "--format",
        "markdown",
        "--extract",
        "code",
        "--with-links",
        "--with-images-summary",
        "--no-gfm",
        "--no-images",
        "--keep-img-data-url",
        "--timeout",
        "30",
        "--no-cache",
        "--max-chars",
        "3000",
        "--full-envelope",
        "--no-journal",
      ],
      crawl: [
        "https://example.com",
        "--depth",
        "2",
        "--breadth",
        "10",
        "--limit",
        "20",
        "--select-paths",
        "docs",
        "--exclude-paths",
        "private",
        "--instructions",
        "focus",
        "--format",
        "text",
        "--content-size",
        "high",
        "--timeout",
        "60",
        "--no-cache",
        "--max-chars",
        "2000",
      ],
      map: [
        "https://example.com",
        "--depth",
        "2",
        "--breadth",
        "10",
        "--limit",
        "20",
        "--select-paths",
        "docs",
        "--exclude-paths",
        "private",
        "--instructions",
        "focus",
        "--no-cache",
      ],
      research: [
        "query",
        "--model",
        "m",
        "--citation-format",
        "inline",
        "--output-length",
        "long",
        "--domain",
        "example.com",
        "--timeout",
        "600",
        "--no-cache",
        "--context",
        "notes.md",
        "--context-mode",
        "bias",
        "--context-stdin",
        "--no-journal",
      ],
      repo: [
        "search",
        "owner/repo",
        "q",
        "--language",
        "en",
        "--lang",
        "en",
        "--path",
        "src",
        "--depth",
        "2",
        "--focus",
        "readme",
        "--no-focus",
        "--max-chars",
        "500",
        "--no-cache",
      ],
      batch: ["manifest.json", "--concurrency", "4", "--fail-fast", "--dry-run"],
      tools: ["--filter", "web", "--full", "--typescript", "--ts", "--vision", "--no-vision"],
      tool: ["web_search", "--vision", "--no-vision"],
      call: ["web_search", "--dry-run", "--file", "req.json", "--json", "--stdin", "--vision"],
      doctor: ["--health", "--no-tools", "--available"],
      quota: ["--all-providers"],
      code: ["script.ts", "--logs", "--timeout", "60"],
      cache: ["prune", "--older-than", "24h", "--provider", "tavily", "--capability", "search"],
      usage: ["--days", "7", "--provider", "tavily"],
      history: [
        "list",
        "--since",
        "7",
        "--command",
        "search",
        "--kind",
        "journal",
        "--limit",
        "5",
        "--repeats",
        "on",
        "--all",
        "--capability",
        "search",
        "--as-of",
        "2026-01-01",
        "--tags",
        "x",
      ],
      init: ["--unregister"],
      config: ["get", "routing"],
      fetch: [
        "https://example.com",
        "--md5",
        "--sha256",
        "--out",
        "f.bin",
        "--ua",
        "bot",
        "--user-agent",
        "bot",
        "-A",
        "bot",
        "--method",
        "GET",
        "-X",
        "GET",
        "--data",
        "{}",
        "--header",
        "X: 1",
        "-H",
        "X: 1",
        "--pdf",
        "text",
        "--pdf-repair",
        "--timeout",
        "30",
      ],
      archive: [
        "diff",
        "https://example.com",
        "--since",
        "30d",
        "--at",
        "20230601000000",
        "--from",
        "20230101",
        "--to",
        "20231231",
        "--limit",
        "5",
        "--status",
        "200",
        "--timeout",
        "30",
        "--raw",
      ],
      watch: [
        "add",
        "https://example.com",
        "--name",
        "x",
        "--keep",
        "5",
        "--format",
        "jsonl",
        "--all",
        "--purge",
        "--timeout",
        "30",
      ],
      science: [
        "search",
        "q",
        "--author",
        "Vaswani",
        "--year",
        "2020:2024",
        "--venue",
        "NeurIPS",
        "--type",
        "article",
        "--provider",
        "arxiv",
        "--no-cache",
        "--max-chars",
        "1000",
        "--no-journal",
      ],
    };
    for (const [command, argv] of Object.entries(vectors)) {
      assert.strictEqual(
        findUnknownStrictFlag(command, argv),
        undefined,
        `accepted argv for "${command}" must pass: ${argv.join(" ")}`,
      );
    }
  });

  it("mutation teeth: removing an accepted flag from a set rejects its vector", () => {
    // Direct probe of the gate's dependence on the allowlist contents:
    // `--count` is accepted only because "count" is in search's set.
    assert.strictEqual(findUnknownStrictFlag("search", ["q", "--count", "5"]), undefined);
    const saved = STRICT_FLAG_ALLOWLIST.search;
    STRICT_FLAG_ALLOWLIST.search = new Set([...saved].filter((k) => k !== "count"));
    try {
      assert.strictEqual(findUnknownStrictFlag("search", ["q", "--count", "5"]), "--count");
    } finally {
      STRICT_FLAG_ALLOWLIST.search = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// main() wiring: opt-in gate, lenient default
// ---------------------------------------------------------------------------

describe("SCOUTLINE_STRICT_FLAGS wiring through main()", () => {
  it("default (unset): unknown flag is silently ignored — the probe from #241 stays true", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir },
      });
      const status = await main(["cache", "stats", "--fusio", "rrf"], deps);
      assert.strictEqual(status, 0, "lenient mode accepts-and-drops unknown flags");
      assert.strictEqual(stderr(), "");
    });
  });

  it("strict: unknown flag rejects on a credentialed command (search typo probe)", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stdout, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_STRICT_FLAGS: "1" },
      });
      const status = await main(["search", "q", "--fusio", "rrf", "--count", "1"], deps);
      assert.strictEqual(status, 1);
      assert.match(stderr(), /VALIDATION_ERROR/);
      assert.match(stderr(), /--fusio/);
      assert.match(stderr(), /SCOUTLINE_STRICT_FLAGS/);
      assert.match(stderr(), /scoutline search --help/);
      assert.strictEqual(stdout(), "");
    });
  });

  it("strict: unknown flag rejects on an early-return command (cache) too", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_STRICT_FLAGS: "yes" },
      });
      const status = await main(["cache", "stats", "--frobnicate"], deps);
      assert.strictEqual(status, 1);
      assert.match(stderr(), /--frobnicate/);
    });
  });

  it("strict: known flags still run (cache stats passes)", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stderr } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_STRICT_FLAGS: "1" },
      });
      const status = await main(["cache", "stats"], deps);
      assert.strictEqual(status, 0);
      assert.strictEqual(stderr(), "");
    });
  });

  it("strict: empty-string env value keeps lenient behavior (non-empty = on)", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation } = makeInvocation();
      const deps = hermeticMainDeps({
        invocation,
        env: { SCOUTLINE_CONFIG_DIR: dir, SCOUTLINE_STRICT_FLAGS: "" },
      });
      const status = await main(["cache", "stats", "--frobnicate"], deps);
      assert.strictEqual(status, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// MAIN_HELP documentation + #239 rider (searchapi + kagi prose)
// ---------------------------------------------------------------------------

describe("MAIN_HELP: strict-flags note + provider prose (#241 doc + #239 rider)", () => {
  it("intro documents the silent-accept default and the SCOUTLINE_STRICT_FLAGS opt-in", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stdout } = makeInvocation();
      const deps = hermeticMainDeps({ invocation, env: { SCOUTLINE_CONFIG_DIR: dir } });
      await main(["--help"], deps);
      const help = stdout();
      assert.match(help, /SCOUTLINE_STRICT_FLAGS/);
      assert.match(help, /unknown/i);
    });
  });

  it("capability prose names searchapi and kagi (#239 rider)", async (t) => {
    await withTempConfig(t, async (dir) => {
      const { invocation, stdout } = makeInvocation();
      const deps = hermeticMainDeps({ invocation, env: { SCOUTLINE_CONFIG_DIR: dir } });
      await main(["--help"], deps);
      const prose = stdout().slice(stdout().indexOf("Shared capabilities accept"));
      assert.match(prose, /SearchApi\s+advertises and supplies search/);
      assert.match(prose, /Kagi\s+advertises and supplies search/);
    });
  });
});
