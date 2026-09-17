/**
 * #181 — the createFake* helpers must fail loud on positional calls.
 * A positional argument (string id etc.) used to silently bind every
 * default, producing a green-looking but wrong-configured double.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createFakeAdapter,
  createFakeRepositoryCapability,
  createFakeRepositoryDescriptor,
  createFakeReaderCapability,
  createFakeReaderDescriptor,
  createFakeCrawlCapability,
  createFakeCrawlDescriptor,
  createFakeMapCapability,
  createFakeMapDescriptor,
  createFakeResearchCapability,
  createFakeResearchDescriptor,
  createFakeSearchCapability,
  createFakeSearchDescriptor,
} from "./helpers/fake-adapter.js";

const HELPERS = [
  ["createFakeAdapter", createFakeAdapter],
  ["createFakeRepositoryCapability", createFakeRepositoryCapability],
  ["createFakeRepositoryDescriptor", createFakeRepositoryDescriptor],
  ["createFakeReaderCapability", createFakeReaderCapability],
  ["createFakeReaderDescriptor", createFakeReaderDescriptor],
  ["createFakeCrawlCapability", createFakeCrawlCapability],
  ["createFakeCrawlDescriptor", createFakeCrawlDescriptor],
  ["createFakeMapCapability", createFakeMapCapability],
  ["createFakeMapDescriptor", createFakeMapDescriptor],
  ["createFakeResearchCapability", createFakeResearchCapability],
  ["createFakeResearchDescriptor", createFakeResearchDescriptor],
  ["createFakeSearchCapability", createFakeSearchCapability],
  ["createFakeSearchDescriptor", createFakeSearchDescriptor],
];

describe("#181 — createFake* helpers reject positional arguments", () => {
  for (const [name, fn] of HELPERS) {
    it(`${name}: a string id throws with usage guidance`, () => {
      assert.throws(() => fn("custom-id"), /options object.*Usage:/s, name);
    });
    it(`${name}: no-arg call still works (all defaults)`, () => {
      assert.ok(fn(), `${name}() must keep working with no argument`);
    });
    it(`${name}: an options object still works`, () => {
      assert.ok(fn({}), `${name}({}) must keep working`);
    });
  }

  it("the original repro: createFakeSearchDescriptor(\"my-id\") no longer silently keeps id \"fake\"", () => {
    assert.throws(() => createFakeSearchDescriptor("my-id"));
  });
});
