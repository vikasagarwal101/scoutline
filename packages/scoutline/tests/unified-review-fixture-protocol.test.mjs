import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "./unified-review-corpus.mjs";
import { offlineDeps } from "./unified-review-offline-deps.mjs";
const root =
  new URL("..", import.meta.url).pathname;
const { validateCandidates } = await import(`${root}/dist/lib/lean-candidates.js`);
for (const c of inputs)
  test(`offline fixture candidate protocol ${c.id}`, async () => {
    const { deps } = offlineDeps(c);
    for (const s of c.sources.filter((s) => !s.readError)) {
      const attempt = await deps.extract({
        sourceId: s.id,
        sourceText: s.content,
        fields: [
          { id: "version", description: "version" },
          { id: "license", description: "license" },
        ],
      });
      const source = {
        evidenceId: s.id,
        url: s.url,
        title: s.title,
        content: s.content,
        byteLength: Buffer.byteLength(s.content),
        origins: [],
      };
      const result = validateCandidates(source, attempt, {
        version: { maxLength: 40 },
        license: { maxLength: 40 },
      });
      assert(result.parsed);
      assert(
        result.fields.every((f) => f.status !== "invalid"),
        JSON.stringify(result),
      );
    }
  });
