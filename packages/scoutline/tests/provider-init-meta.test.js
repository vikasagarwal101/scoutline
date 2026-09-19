/**
 * Offline completeness gate for PROVIDER_PROMPT_META (#231).
 *
 * A provider that lands in PROVIDER_IDS without its init-wizard row
 * must fail here instead of exploding only inside `scoutline init` at
 * runtime (providerMeta throws when the row is missing). Same shape as
 * the quota-mapping.test.js completeness check ("every PROVIDER_IDS
 * entry has a policy row").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_IDS } from "../dist/providers/types.js";
import { PROVIDER_PROMPT_META } from "../dist/commands/init.js";

describe("provider init-wizard meta completeness", () => {
  it("every PROVIDER_IDS entry has a PROVIDER_PROMPT_META row", () => {
    assert.deepStrictEqual(
      Object.keys(PROVIDER_PROMPT_META).sort(),
      [...PROVIDER_IDS].sort(),
      "every registry provider needs an init-wizard row in PROVIDER_PROMPT_META (src/commands/init.ts)",
    );
  });
});
