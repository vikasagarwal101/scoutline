/**
 * Jina search empty-URL SearchSource guard (#51).
 * Lives outside jina-adapter.test.js to avoid touching that file's
 * in-flight edits for other issues.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { JinaAdapter } from "../dist/providers/jina/adapter.js";

const TEST_KEY = "jina-test-api-key";

describe("Jina Search empty-URL normalization (#51)", () => {
  it("skips search results without a URL instead of emitting an empty url", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [
          { title: "Has URL", url: "https://example.com/a", description: "with url" },
          { title: "No URL", description: "no url field" },
        ],
      }),
    });

    const adapter = new JinaAdapter(
      { env: { JINA_API_KEY: TEST_KEY } },
      { transport: { fetch: fakeFetch } },
    );

    const results = await adapter.search.invoke({ query: "test" });
    assert.ok(
      results.every((r) => typeof r.url === "string" && r.url.length > 0),
      "no SearchSource may carry an empty url",
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://example.com/a");
  });
});
