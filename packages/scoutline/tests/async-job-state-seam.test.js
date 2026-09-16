/**
 * #158 — fail-loud `*StateFile`/`*StateDir` pairing at descriptor
 * construction.
 *
 * The async-job state seam takes TWO knobs: the state-file port and the
 * create-lock dir. Injecting exactly one used to silently half-wire the
 * seam — the classic footgun was an in-memory state file with the lock
 * (and, for exa, the production state default) still resolved against
 * the real cache root (#154). These pins require every descriptor to
 * throw a PLAIN Error (a DI-programmer error, not a CLI ValidationError)
 * naming BOTH knobs whenever exactly one is injected, and to construct
 * cleanly when both or neither are.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFirecrawlDescriptor } from "../dist/providers/firecrawl/adapter.js";
import { createTavilyDescriptor } from "../dist/providers/tavily/adapter.js";
import { createExaDescriptor } from "../dist/providers/exa/adapter.js";
import { createLinkupDescriptor } from "../dist/providers/linkup/adapter.js";
import { createParallelDescriptor } from "../dist/providers/parallel/adapter.js";
import { createInMemoryAsyncJobStateFile } from "../dist/lib/async-job-state.js";
import { ScoutlineError } from "../dist/lib/errors.js";

function tempStateDir() {
  return mkdtempSync(join(tmpdir(), "state-seam-pairing-"));
}

/**
 * One entry per adapter carrying the async-job state seam. `knobs` names
 * the file/dir DI knobs; `make` builds the descriptor with the given
 * dependency object verbatim.
 */
const SEAM_ADAPTERS = [
  {
    id: "tavily",
    file: "researchStateFile",
    dir: "researchStateDir",
    make: (deps) => createTavilyDescriptor(deps),
  },
  {
    id: "exa",
    file: "researchStateFile",
    dir: "researchStateDir",
    make: (deps) => createExaDescriptor(deps),
  },
  {
    id: "linkup",
    file: "researchStateFile",
    dir: "researchStateDir",
    make: (deps) => createLinkupDescriptor(deps),
  },
  {
    id: "parallel",
    file: "researchStateFile",
    dir: "researchStateDir",
    make: (deps) => createParallelDescriptor(deps),
  },
  {
    id: "firecrawl",
    file: "crawlStateFile",
    dir: "crawlStateDir",
    make: (deps) => createFirecrawlDescriptor(deps),
  },
];

describe("#158 async-job state seam — fail-loud knob pairing", () => {
  for (const seam of SEAM_ADAPTERS) {
    describe(seam.id, () => {
      it(`throws when ${seam.file} is injected without ${seam.dir}`, () => {
        assert.throws(
          () => seam.make({ [seam.file]: createInMemoryAsyncJobStateFile() }),
          (err) => {
            // Plain Error — a DI-programmer error at construction time,
            // never a CLI ValidationError with an exit-code contract.
            assert.ok(err instanceof Error, "must throw an Error");
            assert.ok(
              !(err instanceof ScoutlineError),
              "must be a plain Error, not a CLI error class",
            );
            assert.match(err.message, new RegExp(seam.file), "message names the file knob");
            assert.match(err.message, new RegExp(seam.dir), "message names the dir knob");
            assert.match(err.message, /#158/, "message anchors the issue");
            return true;
          },
        );
      });

      it(`throws when ${seam.dir} is injected without ${seam.file}`, () => {
        assert.throws(
          () => seam.make({ [seam.dir]: tempStateDir() }),
          (err) => {
            assert.ok(err instanceof Error, "must throw an Error");
            assert.ok(
              !(err instanceof ScoutlineError),
              "must be a plain Error, not a CLI error class",
            );
            assert.match(err.message, new RegExp(seam.file), "message names the file knob");
            assert.match(err.message, new RegExp(seam.dir), "message names the dir knob");
            assert.match(err.message, /#158/, "message anchors the issue");
            return true;
          },
        );
      });

      it("constructs when NEITHER knob is injected (production path)", () => {
        const descriptor = seam.make();
        assert.equal(descriptor.id, seam.id);
      });

      it("constructs when BOTH knobs are injected", () => {
        const descriptor = seam.make({
          [seam.file]: createInMemoryAsyncJobStateFile(),
          [seam.dir]: tempStateDir(),
        });
        assert.equal(descriptor.id, seam.id);
      });
    });
  }
});
