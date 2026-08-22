/**
 * Registry-derived provider-enum pins for command help (2026-08 #82).
 *
 * The `--provider` enumerations in command help must list the FULL
 * built-in registry, derived here from PROVIDER_IDS so a provider that
 * lands in the registry without updating help fails this pin instead of
 * shipping a stale enumeration. Separator style is per-command
 * convention: pipe-separated in read/crawl/map/quota, comma-separated
 * in doctor.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_IDS } from "../dist/providers/types.js";
import { READ_HELP } from "../dist/commands/read.js";
import { CRAWL_HELP } from "../dist/commands/crawl.js";
import { MAP_HELP } from "../dist/commands/map.js";
import { QUOTA_HELP } from "../dist/commands/quota.js";
import { DOCTOR_HELP } from "../dist/commands/doctor.js";
import { SEARCH_HELP } from "../dist/commands/search.js";

const PIPE_ENUM = `(zai | ${PROVIDER_IDS.slice(1).join(" | ")})`;
const COMMA_ENUM = `(${PROVIDER_IDS.join(", ")})`;

describe("command help provider enumerations match the registry (#82)", () => {
  it("read/crawl/map list the full registry, pipe-separated", () => {
    for (const [name, help] of [
      ["READ_HELP", READ_HELP],
      ["CRAWL_HELP", CRAWL_HELP],
      ["MAP_HELP", MAP_HELP],
    ]) {
      assert.ok(
        help.includes(PIPE_ENUM),
        `${name} must list the full registry (${PIPE_ENUM}); got the --provider line wrong or stale`,
      );
    }
  });

  it("quota lists the full registry in its pin-flag enumeration", () => {
    assert.ok(
      QUOTA_HELP.replace(/\s+/g, " ").includes(PIPE_ENUM.replace(/\s+/g, " ")),
      `QUOTA_HELP must list the full registry (${PIPE_ENUM}); the wrapped enum may be stale or malformed`,
    );
  });

  it("doctor lists the full registry, comma-separated", () => {
    assert.ok(
      DOCTOR_HELP.includes(COMMA_ENUM),
      `DOCTOR_HELP must list the full registry (${COMMA_ENUM})`,
    );
  });

  it("read/crawl/map option lines are not joined (each flag on its own line)", () => {
    for (const [name, help] of [
      ["READ_HELP", READ_HELP],
      ["CRAWL_HELP", CRAWL_HELP],
      ["MAP_HELP", MAP_HELP],
    ]) {
      assert.ok(
        help.split("\n").some((l) => l.trim().startsWith("--output-format")),
        `${name}: --output-format must start its own line`,
      );
      assert.ok(
        !/--provider[^\n]*--output-format/.test(help),
        `${name}: the --provider entry must not run into the next option`,
      );
    }
  });
});

describe("provider-count strings match the registry (#83)", () => {
  it("SEARCH_HELP counts the full registry", () => {
    assert.ok(
      SEARCH_HELP.includes(`all ${PROVIDER_IDS.length} Providers`),
      `SEARCH_HELP must say "all ${PROVIDER_IDS.length} Providers" — the count string drifted from the registry`,
    );
  });
});
