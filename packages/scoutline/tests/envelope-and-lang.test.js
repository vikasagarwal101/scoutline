import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { invokeCommand } from "../dist/command-invocation.js";
import { formatSuccessOutput } from "../dist/lib/output.js";
import { ValidationError } from "../dist/lib/errors.js";
import { repoSearch } from "../dist/commands/repo.js";

function createMockAdapter() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: undefined,
      readStdin: async () => "",
      writeStdout: (val) => stdout.push(val),
      writeStderr: (val) => stderr.push(val),
      runQuietly: async (fn) => fn(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

describe("Envelope Standardization & Language Parameter Conformance", () => {
  describe("Standardized Output Envelopes", () => {
    it("emits { success: true, data, timestamp } under -O json for DataCommandResult", async () => {
      const { adapter, stdout } = createMockAdapter();
      const fixedNow = () => 1700000000000;

      await invokeCommand(
        adapter,
        async () => ({ kind: "data", data: { foo: "bar" } }),
        "json",
        fixedNow,
      );

      assert.equal(stdout.length, 1);
      const parsed = JSON.parse(stdout[0]);
      assert.equal(parsed.success, true);
      assert.deepEqual(parsed.data, { foo: "bar" });
      assert.equal(parsed.timestamp, 1700000000000);
    });

    it("emits { success: true, data, timestamp } under -O json for TextCommandResult", async () => {
      const { adapter, stdout } = createMockAdapter();
      const fixedNow = () => 1700000000000;

      await invokeCommand(
        adapter,
        async () => ({ kind: "text", text: "plain text output" }),
        "json",
        fixedNow,
      );

      assert.equal(stdout.length, 1);
      const parsed = JSON.parse(stdout[0]);
      assert.equal(parsed.success, true);
      assert.equal(parsed.data, "plain text output");
      assert.equal(parsed.timestamp, 1700000000000);
    });

    it("emits unwrapped data directly under -O data", async () => {
      const { adapter, stdout } = createMockAdapter();

      await invokeCommand(
        adapter,
        async () => ({ kind: "data", data: { count: 42 } }),
        "data",
      );

      assert.equal(stdout.length, 1);
      assert.equal(stdout[0], JSON.stringify({ count: 42 }));
    });
  });

  describe("Repository Search Language Validation", () => {
    it("rejects unsupported language with ValidationError", async () => {
      await assert.rejects(
        async () => {
          await repoSearch(
            "owner/repo",
            "query",
            { language: "fr" },
            {
              capability: {
                search: async () => ({ excerpts: [] }),
              },
              execution: {
                cache: { get: async () => null, set: async () => {} },
                sleep: async () => {},
                random: () => 0.5,
              },
            },
          );
        },
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /Language must be "en" or "zh"/);
          return true;
        },
      );
    });
  });
});
