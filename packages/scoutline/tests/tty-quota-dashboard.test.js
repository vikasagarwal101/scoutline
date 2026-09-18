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

  it("renders per-tool rows beneath the counts line for a category with toolUsage (#191/Q2)", () => {
    const out = formatQuotaDashboard({
      providers: [
        {
          provider: "zai",
          status: "ok",
          categories: [
            {
              name: "requests",
              unit: "requests",
              current: { used: 750, limit: 1000, remaining: 250, remainingPercent: 25 },
              toolUsage: [
                { tool: "search-prime", usage: 500 },
                { tool: "web-reader", usage: 250 },
              ],
            },
          ],
        },
      ],
    });
    assert.ok(!out.includes("undefined"), `output must not contain 'undefined': ${out}`);
    assert.ok(out.includes("search-prime"), `tool id must render: ${out}`);
    assert.ok(out.includes("web-reader"), `second tool id must render: ${out}`);
    assert.ok(out.includes("500"), "first tool's usage count must render");
    assert.ok(out.includes("250"), "second tool's usage count must render");
    // Per-tool rows come AFTER the category's counts line: they qualify
    // the window, they are not part of it.
    const countsAt = out.indexOf("750/1000");
    const toolAt = out.indexOf("search-prime");
    assert.ok(countsAt !== -1 && toolAt !== -1 && countsAt < toolAt, "tool rows follow the counts line");
  });

  it("renders per-tool rows even when the window itself is corrupt (#191/Q2 independence)", () => {
    // The Q1 guard strips a self-contradictory counter's window, leaving
    // the category percent-less. The per-tool observations are
    // informational and stand on their own filter, so they must still
    // render — a corrupt window is exactly when per-tool detail is most
    // useful for telling which tool burned the budget.
    const out = formatQuotaDashboard({
      providers: [
        {
          provider: "zai",
          status: "ok",
          categories: [
            {
              name: "requests",
              unit: "requests",
              current: {},
              toolUsage: [{ tool: "search-prime", usage: 97 }],
            },
          ],
        },
      ],
    });
    assert.ok(!out.includes("undefined"), `output must not contain 'undefined': ${out}`);
    assert.ok(out.includes("requests"), "category name still renders");
    assert.ok(out.includes("search-prime"), `per-tool row renders under a corrupt window: ${out}`);
    assert.ok(out.includes("97"), "per-tool usage renders");
  });

  it("renders no per-tool rows when toolUsage is absent (no empty scaffolding)", () => {
    // The renderer never prints the literal word "tool", so an absence
    // pin on that string is vacuous. Honest form: render the SAME
    // category with and without toolUsage and require the row count to
    // differ by exactly the number of tool rows — an extra rendered row
    // under the counts line would shift the count.
    const category = {
      name: "requests",
      unit: "requests",
      current: { used: 750, limit: 1000, remaining: 250, remainingPercent: 25 },
    };
    const withTools = formatQuotaDashboard({
      providers: [
        {
          provider: "zai",
          status: "ok",
          categories: [
            {
              ...category,
              toolUsage: [
                { tool: "search-prime", usage: 500 },
                { tool: "web-reader", usage: 250 },
              ],
            },
          ],
        },
      ],
    });
    const withoutTools = formatQuotaDashboard({
      providers: [{ provider: "zai", status: "ok", categories: [{ ...category }] }],
    });
    assert.ok(!withoutTools.includes("undefined"));
    for (const line of withoutTools.split("\n")) {
      assert.doesNotMatch(line, /search-prime|web-reader/, `no tool id in any line: ${line}`);
    }
    assert.strictEqual(
      withoutTools.split("\n").length,
      withTools.split("\n").length - 2,
      `no-toolUsage render must have exactly two fewer lines:\n--- with ---\n${withTools}\n--- without ---\n${withoutTools}`,
    );
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
