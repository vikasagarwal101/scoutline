import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCallerInvestigation as execute } from "../dist/lib/caller-investigation.js";
import { openStore } from "../dist/lib/retained-record-store.js";

async function fixture() {
  const storeRoot = await mkdtemp(join(tmpdir(), "caller-draft-"));
  const options = {
    storeRoot,
    deps: { search: async () => [], read: async () => "", judge: null, now: () => 1000 },
  };
  const handoff = await execute(
    {
      schemaVersion: 1,
      operation: "start",
      dataScope: "synthetic",
      requirements: {
        schemaVersion: 1,
        question: "value?",
        requirements: { v: { question: "value?", schema: { type: "string" } } },
      },
      representations: [{ format: "text", content: "A😀B" }],
    },
    options,
  );
  const page = await execute(
    {
      schemaVersion: 1,
      operation: "inspect",
      investigationRef: handoff.investigationRef,
      collection: "evidence",
    },
    options,
  );
  return { options, handoff, evidence: JSON.parse(page.content)[0] };
}

test("caller cursors reject an unsupported version before reading a page", async () => {
  const { options, handoff } = await fixture();
  const cursor = JSON.parse(Buffer.from(handoff.cursors.evidence, "base64url").toString());
  cursor.v = 9;
  await assert.rejects(
    execute(
      {
        schemaVersion: 1,
        operation: "inspect",
        investigationRef: handoff.investigationRef,
        collection: "evidence",
        cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
      },
      options,
    ),
    /cursor/i,
  );
});

test("explicit evidence ranges reject split surrogate pairs but retain complete characters", async () => {
  const { options, handoff, evidence } = await fixture();
  const request = {
    schemaVersion: 1,
    operation: "readEvidence",
    investigationRef: handoff.investigationRef,
    representationId: evidence.representationId,
    digest: evidence.digest,
  };
  await assert.rejects(execute({ ...request, range: [2, 3] }, options), /surrogate|character/i);
  await assert.rejects(execute({ ...request, range: [1, 2] }, options), /surrogate|character/i);
  assert.equal((await execute({ ...request, range: [1, 3] }, options)).content, "😀");
});

test("an over-cap write without a rollback plan reports unfinished state truthfully", async () => {
  const root = await mkdtemp(join(tmpdir(), "store-draft-"));
  const store = openStore({ root });
  const { investigationRef } = await store.createInvestigation({
    requirements: { schemaVersion: 1, fields: { v: { definition: "value", required: true } } },
  });
  const record = join(root, "investigations", investigationRef);
  const file = join(record, "metadata.json");
  await assert.rejects(
    store.admittedWrite(
      record,
      file,
      "{}",
      {
        chargeBytes: 2,
        rollback: { kind: "none" },
        writeImpl: async (path, value) => {
          await writeFile(path, value);
          await writeFile(join(record, "external-growth.bin"), Buffer.alloc(33 * 1024 * 1024));
        },
      },
      "draft truthfulness probe",
    ),
    (error) => {
      assert.match(error.message, /unfinished|not rolled back/i);
      assert.doesNotMatch(error.message, /; write rolled back\./);
      return true;
    },
  );
  assert.equal(await readFile(file, "utf8"), "{}");
});
