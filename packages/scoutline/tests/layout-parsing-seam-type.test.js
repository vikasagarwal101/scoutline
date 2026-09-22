/**
 * GLM-OCR layout-parsing fetch seam — TYPE-level pin (wave-3, #266).
 *
 * The seam type `ProviderLayoutParsingFetch` REQUIRES a body stream on
 * its response (refusal of body-less responses is seam policy — the
 * type states it, so an arrayBuffer-only double fails at tsc, before
 * any runtime). The row compiles a fixture against the real
 * `dist/providers/types.d.ts` via the repo's own `tsc` (TS 7 — the
 * JS API no longer exists, so the compiler is spawned as a process):
 *
 *   - a body-carrying double type-checks (the legal shape);
 *   - the legacy arrayBuffer-only shape is a type ERROR (pinned by
 *     `@ts-expect-error` — tsc fails if the error ever disappears);
 *   - `ProviderQuotaFetch` (JSON-only shape) is likewise a type ERROR.
 *
 * Mutation tooth: relaxing the seam type back to optional/absent body
 * makes `@ts-expect-error` unused → tsc exits non-zero → row RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_HEADER = `import type { ProviderLayoutParsingFetch } from "../../dist/providers/types.js";\n`;

test("seam type: body-carrying double compiles; arrayBuffer-only and quota shapes are type errors", async () => {
  const fixture = `${FIXTURE_HEADER}
// Legal: production-like double WITH a body stream.
const withBody: ProviderLayoutParsingFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => "",
  json: async () => ({}),
  headers: { get: () => "image/png" },
  body: new ReadableStream<Uint8Array>(),
});

// Wave-2 refusal is seam policy — the type states it. If the type is
// ever relaxed (body optional, arrayBuffer accepted), the directive
// below becomes unused and tsc FAILS the row.
// @ts-expect-error body stream is REQUIRED: an arrayBuffer-only
// response shape is refused at runtime and must not type-check.
const arrayBufferOnly: ProviderLayoutParsingFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => "",
  json: async () => ({}),
  headers: { get: () => "image/png" },
  arrayBuffer: async () => new ArrayBuffer(0),
});

// @ts-expect-error the JSON-only quota shape lacks body + headers and
// must NOT satisfy the layout-parsing seam.
const quotaShape: ProviderLayoutParsingFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => "",
  json: async () => ({}),
});

void withBody; void arrayBufferOnly; void quotaShape;
`;
  const dir = await mkdtemp(path.join(PACKAGE_ROOT, "tests", ".seam-type-pin-"));
  try {
    const file = path.join(dir, "seam-probe.ts");
    await writeFile(file, fixture);
    let stdout = "";
    try {
      stdout = execFileSync(
        process.execPath,
        [
          path.join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc"),
          "--noEmit",
          "--ignoreConfig",
          "--strict",
          "--skipLibCheck",
          "--module", "nodenext",
          "--target", "es2022",
          "--lib", "es2022,dom",
          file,
        ],
        {
          cwd: PACKAGE_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          // Minimal env: the compiler needs only PATH + HOME; it must
          // not inherit ambient config (SCOUTLINE_*, proxies, etc.).
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        },
      );
    } catch (err) {
      stdout = String(err.stdout ?? err.message);
      assert.fail(
        `seam type fixture failed to compile (an @ts-expect-error is unused — the seam type was relaxed):\n${stdout.slice(0, 2000)}`,
      );
    }
    assert.ok(stdout !== undefined, "tsc ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
