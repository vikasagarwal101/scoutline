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
});
