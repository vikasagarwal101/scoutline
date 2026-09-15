import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { main } from "../dist/index.js";
import {
  resolveResponseCacheDirPure,
  resolveToolCacheDirPure,
  createFileResponseCache,
  defaultResponseCache,
} from "../dist/lib/cache.js";
import {
  buildToolCachePath,
  readToolCache,
  writeToolCache,
} from "../dist/lib/tool-cache.js";
import {
  hermeticMainDeps,
  createInMemoryResponseCache,
} from "./helpers/hermetic-main.js";

function makeSearchDescriptor(id = "zai") {
  let invocations = 0;
  return {
    id,
    isConfigured: () => true,
    capabilities: () => new Set(["search"]),
    getInvocations: () => invocations,
    create: () => ({
      id,
      search: {
        validate() {},
        cacheIdentity(r) {
          return {
            provider: id,
            capability: "search",
            credentialFingerprint: `fp-${id}`,
            request: r,
            legacyCandidates: [],
          };
        },
        async invoke() {
          invocations += 1;
          return [{ title: id, url: `https://${id}/r`, summary: "canned" }];
        },
      },
    }),
  };
}

function makeAdapter() {
  const stdout = [];
  const stderr = [];
  let exitCode = 0;
  const adapter = {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    environmentOutputMode: "data",
    readStdin: async () => "",
    writeStdout: (v) => stdout.push(v),
    writeStderr: (v) => stderr.push(v),
    runQuietly: async (op) => op(),
    setExitCode: (code) => {
      exitCode = code;
    },
    getExitCode: () => exitCode,
  };
  return { adapter, stdout, stderr };
}

describe("N3: Isolated Cache Resolution and Directory Derivation", () => {
  describe("Pure directory resolvers", () => {
    it("resolveResponseCacheDirPure returns <root>/cache by default", () => {
      const dir = resolveResponseCacheDirPure(
        { SCOUTLINE_CACHE_DIR: "/tmp/test-cache" },
        { platform: "linux", homedir: "/home/test" },
      );
      assert.equal(dir, path.join("/tmp/test-cache", "cache"));
    });

    it("resolveResponseCacheDirPure derives <root>/cache/isolated/<pid> when SCOUTLINE_ISOLATED=1", () => {
      const dir = resolveResponseCacheDirPure(
        { SCOUTLINE_CACHE_DIR: "/tmp/test-cache", SCOUTLINE_ISOLATED: "1" },
        { platform: "linux", homedir: "/home/test", pid: 12345 },
      );
      assert.equal(dir, path.join("/tmp/test-cache", "cache", "isolated", "12345"));
    });

    it("resolveToolCacheDirPure returns <root>/tools by default", () => {
      const dir = resolveToolCacheDirPure(
        { SCOUTLINE_CACHE_DIR: "/tmp/test-cache" },
        { platform: "linux", homedir: "/home/test" },
      );
      assert.equal(dir, path.join("/tmp/test-cache", "tools"));
    });

    it("resolveToolCacheDirPure derives <root>/tools/isolated/<pid> when SCOUTLINE_ISOLATED=1", () => {
      const dir = resolveToolCacheDirPure(
        { SCOUTLINE_CACHE_DIR: "/tmp/test-cache", SCOUTLINE_ISOLATED: "1" },
        { platform: "linux", homedir: "/home/test", pid: 12345 },
      );
      assert.equal(dir, path.join("/tmp/test-cache", "tools", "isolated", "12345"));
    });
  });

  describe("createFileResponseCache factory", () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-n3-test-"));
    });

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("scopes get and set to the configured directory", async () => {
      const targetDir = path.join(tempDir, "isolated", "999");
      const cache = createFileResponseCache(targetDir);

      await cache.set("test-key.json", { hello: "isolated" });
      const readBack = await cache.get("test-key.json");
      assert.deepEqual(readBack, { hello: "isolated" });

      // Verify the file landed directly in targetDir
      assert.ok(fs.existsSync(path.join(targetDir, "test-key.json")));
    });

    it("supports call-time directory resolver function", async () => {
      let currentSubdir = "first";
      const cache = createFileResponseCache(() => path.join(tempDir, currentSubdir));

      await cache.set("k1.json", { val: 1 });
      assert.ok(fs.existsSync(path.join(tempDir, "first", "k1.json")));

      currentSubdir = "second";
      await cache.set("k2.json", { val: 2 });
      assert.ok(fs.existsSync(path.join(tempDir, "second", "k2.json")));
    });
  });

  describe("Tools cache isolation threading", () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-n3-tools-"));
    });

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    const dummyConfig = {
      mode: "test",
      baseUrl: "https://test.local",
      endpoints: {},
      enableVision: false,
    };

    const dummyTools = [
      { name: "test_tool", description: "test", inputSchema: { type: "object" } },
    ];

    it("buildToolCachePath lands under tools/isolated/<pid> when env has SCOUTLINE_ISOLATED=1", () => {
      const isolatedEnv = {
        SCOUTLINE_CACHE_DIR: tempDir,
        SCOUTLINE_ISOLATED: "1",
      };
      const p = buildToolCachePath(dummyConfig, isolatedEnv);
      const expectedDir = path.join(tempDir, "tools", "isolated", `${process.pid}`);
      assert.ok(p.startsWith(expectedDir));
    });

    it("readToolCache and writeToolCache write to isolated directory when isolated env is passed", async () => {
      const isolatedEnv = {
        SCOUTLINE_CACHE_DIR: tempDir,
        SCOUTLINE_ISOLATED: "1",
      };

      await writeToolCache(dummyConfig, dummyTools, undefined, isolatedEnv);

      const expectedIsolatedDir = path.join(tempDir, "tools", "isolated", `${process.pid}`);
      assert.ok(fs.existsSync(expectedIsolatedDir));
      const files = fs.readdirSync(expectedIsolatedDir);
      assert.equal(files.length, 1);
      assert.ok(files[0].startsWith("tools-"));

      // Read back with isolated env succeeds
      const cached = await readToolCache(dummyConfig, isolatedEnv);
      assert.ok(cached !== null);
      assert.equal(cached[0].name, "test_tool");

      // Non-isolated read does not find it
      const nonIsolatedRead = await readToolCache(dummyConfig, { SCOUTLINE_CACHE_DIR: tempDir });
      assert.equal(nonIsolatedRead, null);
    });
  });

  describe("Hermetic main() with --isolated", () => {
    let tempCacheDir;
    let prevCacheDir;

    beforeEach(() => {
      tempCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoutline-n3-main-"));
      prevCacheDir = process.env.SCOUTLINE_CACHE_DIR;
      process.env.SCOUTLINE_CACHE_DIR = tempCacheDir;
    });

    afterEach(() => {
      if (prevCacheDir === undefined) delete process.env.SCOUTLINE_CACHE_DIR;
      else process.env.SCOUTLINE_CACHE_DIR = prevCacheDir;
      if (tempCacheDir && fs.existsSync(tempCacheDir)) {
        fs.rmSync(tempCacheDir, { recursive: true, force: true });
      }
    });

    it("main(['--isolated', 'search', 'q'], deps) writes cache entry under <root>/cache/isolated/<pid>/", async () => {
      const { adapter, stderr } = makeAdapter();
      const descriptor = makeSearchDescriptor("zai");

      const deps = hermeticMainDeps({
        invocation: adapter,
        providerDescriptors: [descriptor],
        config: { version: 1, providers: { zai: {} } },
        env: {
          SCOUTLINE_CACHE_DIR: tempCacheDir,
        },
      });

      // Remove the hermeticMainDeps in-memory cache fallbacks so main() exercises defaultCache resolution
      delete deps.searchCache;
      delete deps.repositoryCache;
      delete deps.readerCache;
      delete deps.crawlCache;
      delete deps.mapCache;
      delete deps.researchCache;

      const exitCode = await main(["--isolated", "search", "quantum computing"], deps);
      assert.equal(exitCode, 0, `main failed with stderr: ${stderr.join("")}`);
      assert.equal(descriptor.getInvocations(), 1);

      // Verify cache entry landed under <tempCacheDir>/cache/isolated/<process.pid>/
      const isolatedDir = path.join(tempCacheDir, "cache", "isolated", `${process.pid}`);
      assert.ok(fs.existsSync(isolatedDir), `Expected isolated dir to exist: ${isolatedDir}`);
      const files = fs.readdirSync(isolatedDir);
      assert.equal(files.length, 1, `Expected 1 cache file in isolated dir, found: ${files.join(", ")}`);
      assert.ok(files[0].endsWith(".json"));

      // Non-isolated cache root (<tempCacheDir>/cache/) should NOT contain the entry directly
      const topEntries = fs.readdirSync(path.join(tempCacheDir, "cache"));
      assert.deepEqual(topEntries, ["isolated"]);

      // A second non-isolated run in the same cache root does NOT read the isolated cache
      const { adapter: adapter2, stderr: stderr2 } = makeAdapter();
      const deps2 = hermeticMainDeps({
        invocation: adapter2,
        providerDescriptors: [descriptor],
        config: { version: 1, providers: { zai: {} } },
        env: {
          SCOUTLINE_CACHE_DIR: tempCacheDir,
        },
      });
      delete deps2.searchCache;
      delete deps2.repositoryCache;
      delete deps2.readerCache;
      delete deps2.crawlCache;
      delete deps2.mapCache;
      delete deps2.researchCache;

      const exitCode2 = await main(["search", "quantum computing"], deps2);
      assert.equal(exitCode2, 0, `main failed with stderr: ${stderr2.join("")}`);
      // Because non-isolated run missed the isolated cache, it had to invoke the provider again!
      assert.equal(descriptor.getInvocations(), 2);

      // And the non-isolated run wrote its cache to the top-level cache dir
      const nonIsolatedFiles = fs
        .readdirSync(path.join(tempCacheDir, "cache"))
        .filter((f) => f !== "isolated");
      assert.equal(nonIsolatedFiles.length, 1);
    });

    it("main(['--isolated', 'search', '--no-cache', 'q']) does not write cache entry", async () => {
      const { adapter, stderr } = makeAdapter();
      const descriptor = makeSearchDescriptor("zai");

      const deps = hermeticMainDeps({
        invocation: adapter,
        providerDescriptors: [descriptor],
        config: { version: 1, providers: { zai: {} } },
        env: {
          SCOUTLINE_CACHE_DIR: tempCacheDir,
        },
      });
      delete deps.searchCache;
      delete deps.repositoryCache;
      delete deps.readerCache;
      delete deps.crawlCache;
      delete deps.mapCache;
      delete deps.researchCache;

      const exitCode = await main(["--isolated", "search", "--no-cache", "quantum computing"], deps);
      assert.equal(exitCode, 0, `main failed with stderr: ${stderr.join("")}`);
      assert.equal(descriptor.getInvocations(), 1);

      const isolatedDir = path.join(tempCacheDir, "cache", "isolated", `${process.pid}`);
      assert.ok(!fs.existsSync(isolatedDir), `Expected isolated dir NOT to exist when --no-cache is passed`);
    });

    it("an injected dependencies.searchCache wins over the isolated default", async () => {
      const { adapter, stderr } = makeAdapter();
      const descriptor = makeSearchDescriptor("zai");
      const injectedCache = createInMemoryResponseCache();

      const deps = hermeticMainDeps({
        invocation: adapter,
        providerDescriptors: [descriptor],
        config: { version: 1, providers: { zai: {} } },
        searchCache: injectedCache,
        env: {
          SCOUTLINE_CACHE_DIR: tempCacheDir,
        },
      });

      const exitCode = await main(["--isolated", "search", "quantum computing"], deps);
      assert.equal(exitCode, 0, `main failed with stderr: ${stderr.join("")}`);
      assert.equal(descriptor.getInvocations(), 1);

      // Disk cache was NOT written because injectedCache won
      const isolatedDir = path.join(tempCacheDir, "cache", "isolated", `${process.pid}`);
      assert.ok(!fs.existsSync(isolatedDir));
    });
  });
});
