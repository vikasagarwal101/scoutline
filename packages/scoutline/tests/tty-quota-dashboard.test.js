import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatQuotaDashboard } from "../dist/lib/tty.js";

describe("quota dashboard TTY rendering (#49 ripple)", () => {
  it("renders a percent-less (unknown-limit) window without 'undefined'", () => {
    const out = formatQuotaDashboard({
      providers: [
        {
          provider: "jina",
          status: "ok",
          categories: [
            {
              name: "Requests",
              unit: "requests",
              current: { remaining: 499 },
            },
          ],
        },
      ],
    });
    assert.ok(!out.includes("undefined"), `output must not contain 'undefined': ${out}`);
    assert.ok(out.includes("499 left"), "remaining count still renders");
  });

  it("renders a used-only window's observed count (#99 residue)", () => {
    const out = formatQuotaDashboard({
      providers: [
        {
          provider: "tavily",
          status: "ok",
          categories: [
            {
              name: "requests",
              unit: "requests",
              current: { remainingPercent: 100, used: 123 },
            },
          ],
        },
      ],
    });
    assert.ok(!out.includes("undefined"), `output must not contain 'undefined': ${out}`);
    assert.ok(out.includes("123 used"), `used-only window must surface the observed count: ${out}`);
    assert.ok(!out.includes("123/"), "no limit exists — never fabricate a used/limit pair");
    assert.ok(!out.includes("left"), "no remaining is derivable — never fabricate one");
  });
});
