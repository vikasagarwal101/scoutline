/**
 * Dispatch-level main() probe rows (#267) — the standing class for the
 * production-only wiring between argv and the descriptor seams.
 *
 * Both M1/M2 escapes from the PR #265 review rounds were invisible to
 * the standing suite because every main()-level row either injected
 * `providerDescriptors` (the keep-full-control branch at the top of
 * main() skips the production zai rebuild entirely) or pinned the
 * adapter directly. This file is the generalized probe shape:
 *
 *   - NO injected providerDescriptors — the production registry path
 *     applies, including the `productionZaiLedgerDescriptors` rebuild
 *     the save/journal chains must build from (M1).
 *   - globalThis.fetch stub routes the layout_parsing REST arm; every
 *     other URL (the MCP fallback endpoint) answers 401 so the
 *     fallback attempt fails fast without a live transport.
 *   - Real argv through an in-process main() invocation; assertions
 *     read observable filesystem/sink state only.
 *   - Channel discipline (#267 AC): rows configure NOTHING through
 *     process.env — the env (credentials, cache dir, artifacts dir)
 *     rides MainDependencies.env, the channel production delivers via
 *     deps. Mutating process.env here is exactly what masked M2 in
 *     review round 1; the isolated row pins the discipline itself.
 *
 * Rows:
 *   (a) `vision extract-text --save` ledger shape — warm run = 1
 *       adapter-owned row, cache hit = 0 rows, 1113+fallback = 2 rows
 *       (the M1 fix generalized).
 *   (b) `--isolated` flag leg — shared cache dir stays empty, the OCR
 *       entry lands under cache/isolated/<pid>, and process.env is
 *       never touched (the R1 flag-leg generalized).
 *
 * 100% hermetic: fetch stubbed, in-memory consumption sink, temp
 * HOME/cache/artifacts isolation per test. No network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { main } from "../dist/index.js";
import { createInMemoryConsumptionSink } from "../dist/lib/consumption.js";
import { hermeticMainDeps } from "./helpers/hermetic-main.js";

const ENV = { Z_AI_API_KEY: "test-zai-api-key-DO-NOT-LEAK" };

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

const WARM = () => jsonResponse({ md_results: "# ledger text" });
const INSUFFICIENT = () =>
  jsonResponse({ error: { code: "1113", message: "Insufficient balance" } }, 429);

/**
 * main()-level run on the PRODUCTION registry path: no injected
 * providerDescriptors, so the zai rebuild (the M1 seam) and the real
 * argv→env merge (the M2 seam) both apply. The layout double and the
 * MCP 401 ride globalThis.fetch — the only transport channel the
 * production descriptor leaves open. Everything else (credentials,
 * cache root, artifacts root) rides deps.env.
 */
async function runMainProduction(args, { env = ENV, cacheDir, artifactsDir } = {}) {
  const writes = [];
  const invocation = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: undefined,
    readStdin: async () => "",
    writeStdout(v) {
      writes.push(["out", v]);
    },
    writeStderr(v) {
      writes.push(["err", v]);
    },
    runQuietly: async (op) => op(),
    setExitCode() {},
  };
  const sink = createInMemoryConsumptionSink();
  const deps = hermeticMainDeps({
    invocation,
    env: {
      ...env,
      ...(cacheDir !== undefined ? { SCOUTLINE_CACHE_DIR: cacheDir } : {}),
      ...(artifactsDir !== undefined ? { SCOUTLINE_ARTIFACTS_DIR: artifactsDir } : {}),
    },
    now: () => 1_700_000_000_000,
    consume: sink,
    searchSleep: async () => {},
    searchRandom: () => 0.5,
  });
  const code = await main(args, deps);
  return {
    code,
    sink,
    stdout: writes.filter((w) => w[0] === "out").map((w) => w[1]).join("\n").trim(),
    stderr: writes.filter((w) => w[0] === "err").map((w) => w[1]).join("\n"),
  };
}

/**
 * Install the dispatch-level fetch double: the layout_parsing REST
 * arm answers from a scripted queue; every other URL (the MCP
 * fallback endpoint) answers 401. Returns an uninstall fn — always
 * call in finally.
 */
function installDispatchStubs(script) {
  const savedGlobalFetch = globalThis.fetch;
  const restCalls = [];
  let scriptStep = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("layout_parsing")) {
      restCalls.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      const respond = script[Math.min(scriptStep, script.length - 1)];
      scriptStep += 1;
      return respond(restCalls.length);
    }
    // MCP endpoint: 401 → the fallback attempt fails TERMINAL (no
    // retries), isolating the ledger-seam shape from retry policy.
    return { ok: false, status: 401, text: async () => "", json: async () => ({}) };
  };
  return () => {
    globalThis.fetch = savedGlobalFetch;
    return restCalls;
  };
}

describe("#267 — --save ledger shape (production descriptor chain, M1 class)", () => {
  it("vision extract-text --save: warm=1 row, cache-hit=0 rows, 1113+fallback=2 rows", async () => {
    const uninstall = installDispatchStubs([WARM, INSUFFICIENT]);
    try {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-probe-save-"));
      const sharedCache = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-probe-cache-"));
      const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-probe-art-"));
      const file = path.join(tmp, "doc.png");
      await fs.writeFile(file, Buffer.from("save-probe"));
      const argsFor = (n, f) => [
        "vision",
        "extract-text",
        f,
        "--save",
        path.join(tmp, `out-${n}.md`),
      ];
      try {
        // Phase 1: warm attempt through the production rebuild — ONE
        // adapter-owned row, and the save export lands on disk.
        const first = await runMainProduction(argsFor(1, file), {
          cacheDir: sharedCache,
          artifactsDir: artifacts,
        });
        assert.strictEqual(first.code, 0, `warm exit 0, stderr: ${first.stderr}`);
        assert.strictEqual(first.sink.events.length, 1, "warm --save run: one adapter row");
        assert.strictEqual(first.sink.events[0].capabilityId, "vision.extract-text");
        const export1 = await fs.readFile(path.join(tmp, "out-1.md"), "utf8");
        assert.ok(export1.includes("# ledger text"), "the save export carries the OCR text");

        // Phase 2: same URL, same shared cache — a cache hit records
        // ZERO rows (the rebuilt seam survives the save-path capture
        // chain; the raw-list build records none of this correctly).
        const second = await runMainProduction(argsFor(2, file), {
          cacheDir: sharedCache,
          artifactsDir: artifacts,
        });
        assert.strictEqual(second.code, 0);
        assert.strictEqual(second.sink.events.length, 0, "--save cache hit: ZERO rows (M1)");

        // Phase 3: fresh (cache-cold) file, 1113 → MCP fallback. The
        // fallback transport 401s, but the ROWS are the pin: the
        // adapter counted REST + fallback = 2 attempts, not 1 executor
        // row — the marker that the save chain kept the rebuilt
        // descriptor.
        const fileB = path.join(tmp, "doc2.png");
        await fs.writeFile(fileB, Buffer.from("save-probe-2"));
        const third = await runMainProduction(argsFor(3, fileB), {
          cacheDir: sharedCache,
          artifactsDir: artifacts,
        });
        assert.strictEqual(
          third.sink.events.length,
          2,
          "--save 1113+fallback: TWO adapter rows (M1)",
        );
        assert.ok(
          third.sink.events.every((e) => e.capabilityId === "vision.extract-text"),
          "both rows are vision.extract-text",
        );
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
        await fs.rm(sharedCache, { recursive: true, force: true });
        await fs.rm(artifacts, { recursive: true, force: true });
      }
    } finally {
      uninstall();
    }
  });
});

describe("#267 — --isolated flag leg (argv→env→descriptor channel, M2 class)", () => {
  it("--isolated run: shared cache empty, isolated/<pid> populated, process.env untouched", async () => {
    const uninstall = installDispatchStubs([WARM]);
    try {
      const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-probe-iso-"));
      const src = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-probe-iso-src-"));
      const file = path.join(src, "flag.png");
      await fs.writeFile(file, Buffer.from("flag-probe"));
      try {
        const out = await runMainProduction(["--isolated", "vision", "extract-text", file], {
          cacheDir: sharedRoot,
        });
        assert.strictEqual(out.code, 0, `--isolated exit 0, stderr: ${out.stderr}`);
        // The warm isolated run still bills exactly one adapter row.
        assert.strictEqual(out.sink.events.length, 1, "isolated warm run: one adapter row");

        // Observable filesystem state: the SHARED cache tree holds no
        // OCR entry; the entry landed under cache/isolated/<pid>.
        const sharedCache = path.join(sharedRoot, "cache");
        const sharedEntries = await fs.readdir(sharedCache).catch(() => []);
        const leaked = sharedEntries.filter(
          (e) => !e.startsWith("isolated") && e.startsWith("v2.vision-ocr-layout-parsing."),
        );
        assert.deepStrictEqual(leaked, [], "--isolated run wrote NOTHING to the shared dir");
        const isolatedRoot = path.join(sharedCache, "isolated");
        const pidDirs = await fs.readdir(isolatedRoot).catch(() => []);
        assert.ok(
          pidDirs.includes(String(process.pid)),
          "--isolated run landed its OCR entry under isolated/<pid>",
        );
        for (const pidDir of pidDirs) {
          const entries = await fs.readdir(path.join(isolatedRoot, pidDir)).catch(() => []);
          assert.ok(
            entries.some((e) => e.startsWith("v2.vision-ocr-layout-parsing.")),
            "the OCR entry exists under the isolated pid dir",
          );
        }

        // Channel discipline pinned: the flag rode the argv→env→
        // descriptor.create({env}) chain; process.env was never the
        // configuration channel (the round-1 M2 masking mistake).
        assert.strictEqual(
          process.env.SCOUTLINE_ISOLATED,
          undefined,
          "main() must not surface --isolated through process.env",
        );
      } finally {
        await fs.rm(sharedRoot, { recursive: true, force: true });
        await fs.rm(src, { recursive: true, force: true });
      }
    } finally {
      uninstall();
    }
  });
});
