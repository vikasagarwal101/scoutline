/**
 * Science command abort signal and cancellation hardening (#151).
 *
 * Tests:
 * (a) External abort != timeout: mid-flight external abort surfaces honest
 *     abort error, does NOT match /timed out/ and carries abort wording.
 * (b) Pre-aborted signal -> zero transport calls.
 * (c) SIGINT registration mirrors research precedent: HandleScienceOptions.registerInterrupt
 *     wires handler to controller.abort(), teardown called on success and failure.
 * (d) Fan-out cancel semantics: multi-arm search, shared signal aborts all arms,
 *     honest abort error surfaced, exitCode 1.
 * (e) Journal on full abort: aborted command journals nothing (throw-path).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleScience } from "../dist/commands/science.js";
import { ApiError, TimeoutError } from "../dist/lib/errors.js";
import { fetchArxivQuery } from "../dist/providers/arxiv/client.js";
import { fetchCrossrefJson } from "../dist/providers/crossref/client.js";
import { fetchEuropepmcJson } from "../dist/providers/europepmc/client.js";
import { fetchOpenalexJson } from "../dist/providers/openalex/client.js";
import { fetchPubmedEsearch } from "../dist/providers/pubmed/client.js";
import { readLog } from "../dist/lib/artifacts.js";

const D5_ARM_ORDER = ["openalex", "arxiv", "crossref", "pubmed", "europepmc"];

function makeInvocation() {
  const stdout = [];
  const stderr = [];
  return {
    adapter: {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    },
    stdout,
    stderr,
  };
}

function makeScienceDescriptor(id, opts = {}) {
  const calls = { search: [], get: [] };
  const descriptor = {
    id,
    isConfigured: () => opts.configured?.() ?? true,
    capabilities: () => new Set(opts.caps ?? ["science.search", "science.get"]),
    create() {
      return {
        id,
        science: {
          search: {
            validate() {},
            cacheIdentity: (request) => ({
              supplier: id,
              capability: "science.search",
              credentialFingerprint: "",
              request,
            }),
            async invoke(request, signal) {
              calls.search.push({ request, signal });
              if (opts.search) {
                return opts.search(request, signal);
              }
              return [{ title: `work-from-${id}`, url: `https://example.org/${id}` }];
            },
          },
          get: {
            validate() {},
            cacheIdentity: (request) => ({
              supplier: id,
              capability: "science.get",
              credentialFingerprint: "",
              request,
            }),
            async invoke(request, signal) {
              calls.get.push({ request, signal });
              if (opts.get) {
                return opts.get(request, signal);
              }
              return { title: `work-from-${id}`, url: `https://example.org/${id}` };
            },
          },
        },
      };
    },
    credentialEnvVars: [],
  };
  return { descriptor, calls };
}

describe("science abort signal threading and honest cancellation (#151)", () => {
  it("(a) client-level: external abort mid-flight rejects with ApiError(499), never /timed out/", async () => {
    const clients = [
      {
        name: "arxiv",
        call: (ac) =>
          fetchArxivQuery(
            { search_query: "test" },
            {
              fetch: (_url, init) =>
                new Promise((_res, rej) => {
                  init?.signal?.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    rej(err);
                  });
                }),
            },
            ac.signal,
          ),
      },
      {
        name: "crossref",
        call: (ac) =>
          fetchCrossrefJson(
            { query: "test" },
            {
              fetch: (_url, init) =>
                new Promise((_res, rej) => {
                  init?.signal?.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    rej(err);
                  });
                }),
            },
            ac.signal,
          ),
      },
      {
        name: "europepmc",
        call: (ac) =>
          fetchEuropepmcJson(
            { query: "test" },
            {
              fetch: (_url, init) =>
                new Promise((_res, rej) => {
                  init?.signal?.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    rej(err);
                  });
                }),
            },
            ac.signal,
          ),
      },
      {
        name: "openalex",
        call: (ac) =>
          fetchOpenalexJson(
            { search: "test" },
            {
              fetch: (_url, init) =>
                new Promise((_res, rej) => {
                  init?.signal?.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    rej(err);
                  });
                }),
            },
            ac.signal,
          ),
      },
      {
        name: "pubmed",
        call: (ac) =>
          fetchPubmedEsearch(
            "test",
            {
              fetch: (_url, init) =>
                new Promise((_res, rej) => {
                  init?.signal?.addEventListener("abort", () => {
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    rej(err);
                  });
                }),
            },
            ac.signal,
          ),
      },
    ];

    for (const { name, call } of clients) {
      const ac = new AbortController();
      const p = call(ac);
      ac.abort();
      await assert.rejects(
        p,
        (err) => {
          assert.ok(err instanceof ApiError, `${name} must reject with ApiError, got ${err?.constructor?.name}`);
          assert.equal(err.statusCode, 499, `${name} status must be 499`);
          assert.match(err.message, /request was aborted by the caller/);
          assert.doesNotMatch(err.message, /timed out/i);
          return true;
        },
        `${name} must reject with honest external-abort error`,
      );
    }
  });

  it("(b) pre-aborted signal results in zero transport calls", async () => {
    let fetchCalls = 0;
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      fetchArxivQuery(
        { search_query: "test" },
        {
          fetch: async () => {
            fetchCalls += 1;
            return { ok: true, status: 200, headers: new Map(), text: async () => "" };
          },
        },
        ac.signal,
      ),
      (err) => {
        assert.ok(err instanceof ApiError, `expected ApiError, got ${err?.constructor?.name}`);
        assert.equal(err.statusCode, 499);
        assert.match(err.message, /request was aborted by the caller/);
        assert.doesNotMatch(err.message, /timed out/i);
        return true;
      },
    );
    assert.equal(fetchCalls, 0, "transport must never be called when signal is pre-aborted");
  });

  it("(c) SIGINT registration mirrors research precedent and cleanup runs on success and failure", async () => {
    // 1. Success path: registrar called, cleanup ran
    let registeredHandler = null;
    let cleanupCalls = 0;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {
        cleanupCalls += 1;
      };
    };

    const d1 = makeScienceDescriptor("openalex");
    const inv1 = makeInvocation();
    const deps1 = {
      invocation: inv1.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [d1.descriptor],
      fallbackEnabled: true,
    };

    const status1 = await handleScience(["search", "quantum"], "data", deps1, {
      registerInterrupt: fakeRegistrar,
    });
    assert.equal(status1, 0);
    assert.ok(typeof registeredHandler === "function", "registerInterrupt must be passed handler");
    assert.equal(cleanupCalls, 1, "cleanup must run once on success path");

    // 2. Failure/abort path: handler aborts controller, command settles, cleanup ran
    let registeredHandler2 = null;
    let cleanupCalls2 = 0;
    const fakeRegistrar2 = (handler) => {
      registeredHandler2 = handler;
      return () => {
        cleanupCalls2 += 1;
      };
    };

    const d2 = makeScienceDescriptor("openalex", {
      search: (_req, signal) =>
        new Promise((_res, rej) => {
          assert.ok(signal, "invoke must receive signal");
          signal.addEventListener("abort", () => {
            rej(new ApiError("OpenAlex request was aborted by the caller (Ctrl-C or external signal)", 499));
          });
        }),
    });
    const inv2 = makeInvocation();
    const deps2 = {
      invocation: inv2.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [d2.descriptor],
      fallbackEnabled: true,
    };

    const p2 = handleScience(["search", "quantum"], "data", deps2, {
      registerInterrupt: fakeRegistrar2,
    });
    // Trigger SIGINT interrupt handler
    assert.ok(typeof registeredHandler2 === "function", "handler must be registered before invoke");
    registeredHandler2();
    const status2 = await p2;
    assert.equal(status2, 1, "aborted command must return exitCode 1");
    assert.equal(cleanupCalls2, 1, "cleanup must run once on abort path");
    const errText = inv2.stderr.join("");
    assert.match(errText, /aborted by the caller/i);
    assert.doesNotMatch(errText, /timed out/i);
  });

  it("(d) fan-out cancel semantics: multi-arm search aborts all arms with shared signal", async () => {
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    const armSignals = [];
    const descriptors = ["openalex", "arxiv", "crossref"].map((id) =>
      makeScienceDescriptor(id, {
        search: (_req, signal) => {
          armSignals.push({ id, signal });
          return new Promise((_res, rej) => {
            if (signal.aborted) {
              rej(new ApiError(`${id} request was aborted by the caller (Ctrl-C or external signal)`, 499));
              return;
            }
            signal.addEventListener("abort", () => {
              rej(new ApiError(`${id} request was aborted by the caller (Ctrl-C or external signal)`, 499));
            });
          });
        },
      }),
    );

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: descriptors.map((d) => d.descriptor),
      fallbackEnabled: true,
    };

    const p = handleScience(["search", "quantum"], "data", deps, {
      registerInterrupt: fakeRegistrar,
    });
    assert.ok(typeof registeredHandler === "function");
    // Trigger interrupt
    registeredHandler();
    const exitCode = await p;
    assert.equal(exitCode, 1, "exit code must be 1 on abort");
    assert.equal(armSignals.length, 3, "all 3 arms must have been started");
    assert.ok(armSignals.every((a) => a.signal && a.signal.aborted), "all arms must share aborted signal");
    const stderrText = inv.stderr.join("");
    assert.match(stderrText, /aborted by the caller/i);
    assert.doesNotMatch(stderrText, /timed out/i);
  });

  it("(e) journal on full abort: fully-aborted run writes NO journal entry", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "scoutline-sci-signal-"));
    try {
      let registeredHandler = null;
      const fakeRegistrar = (handler) => {
        registeredHandler = handler;
        return () => {};
      };

      const d = makeScienceDescriptor("openalex", {
        search: (_req, signal) =>
          new Promise((_res, rej) => {
            signal.addEventListener("abort", () => {
              rej(new ApiError("OpenAlex request was aborted by the caller (Ctrl-C or external signal)", 499));
            });
          }),
      });

      const inv = makeInvocation();
      const deps = {
        invocation: inv.adapter,
        env: { SCOUTLINE_ARTIFACTS_DIR: tmp },
        secrets: [],
        providerDescriptors: [d.descriptor],
        fallbackEnabled: true,
        journal: {
          input: {
            command: "science",
            args: { query: "quantum" },
            provider: { mode: "single", effective: "openalex" },
          },
          now: () => Date.now(),
        },
      };

      const p = handleScience(["search", "quantum"], "data", deps, {
        registerInterrupt: fakeRegistrar,
      });
      registeredHandler();
      const exitCode = await p;
      assert.equal(exitCode, 1);

      const logPath = join(tmp, "journal.log");
      if (existsSync(logPath)) {
        const entries = readLog(logPath);
        assert.equal(entries.length, 0, "no entries should be written on abort");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("get subcommand: threads signal to capability and aborts cleanly", async () => {
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    let receivedSignal = null;
    const d = makeScienceDescriptor("openalex", {
      get: (_req, signal) => {
        receivedSignal = signal;
        return new Promise((_res, rej) => {
          signal.addEventListener("abort", () => {
            rej(new ApiError("OpenAlex request was aborted by the caller (Ctrl-C or external signal)", 499));
          });
        });
      },
    });

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [d.descriptor],
      fallbackEnabled: true,
    };

    const p = handleScience(["get", "10.1038/nature12373"], "data", deps, {
      registerInterrupt: fakeRegistrar,
    });
    assert.ok(typeof registeredHandler === "function");
    registeredHandler();
    const exitCode = await p;
    assert.equal(exitCode, 1);
    assert.ok(receivedSignal !== null, "get capability must receive signal");
    assert.ok(receivedSignal.aborted, "get capability signal must be aborted");
    const stderrText = inv.stderr.join("");
    assert.match(stderrText, /aborted by the caller/i);
    assert.doesNotMatch(stderrText, /timed out/i);
  });
});
