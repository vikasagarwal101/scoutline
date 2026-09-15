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
import { createInMemoryResponseCache } from "./helpers/hermetic-main.js";
import { ApiError } from "../dist/lib/errors.js";
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

  it("(a) race tie-break: caller abort wins over raced timer in both callback orders (five clients)", async () => {
    const clients = [
      {
        name: "arxiv",
        call: (ac, deps) =>
          fetchArxivQuery(
            { search_query: "test" },
            deps,
            ac.signal,
          ),
      },
      {
        name: "crossref",
        call: (ac, deps) =>
          fetchCrossrefJson(
            { query: "test" },
            deps,
            ac.signal,
          ),
      },
      {
        name: "europepmc",
        call: (ac, deps) =>
          fetchEuropepmcJson(
            { query: "test" },
            deps,
            ac.signal,
          ),
      },
      {
        name: "openalex",
        call: (ac, deps) =>
          fetchOpenalexJson(
            { search: "test" },
            deps,
            ac.signal,
          ),
      },
      {
        name: "pubmed",
        call: (ac, deps) =>
          fetchPubmedEsearch(
            { term: "test" },
            deps,
            ac.signal,
          ),
      },
    ];

    // Order (1): timer fires, THEN caller aborts (abort caller signal after timer rejection is in flight)
    for (const { name, call } of clients) {
      let timerCb;
      const ac = new AbortController();
      const p = call(ac, {
        setTimeout: (cb) => {
          timerCb = cb;
          return 123;
        },
        clearTimeout: () => {},
        fetch: (_url, init) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              rej(err);
            });
          }),
      });
      assert.ok(typeof timerCb === "function", `${name}: timer callback must be armed`);
      timerCb();
      ac.abort();
      await assert.rejects(
        p,
        (err) => {
          assert.ok(err instanceof ApiError, `${name} order (1) must reject with ApiError, got ${err?.constructor?.name}`);
          assert.equal(err.statusCode, 499, `${name} order (1) status must be 499`);
          assert.match(err.message, /request was aborted by the caller/i);
          assert.doesNotMatch(err.message, /timed out/i);
          return true;
        },
        `${name} order (1): caller abort must win over raced timer`,
      );
    }

    // Order (2): caller aborts, THEN timer fires
    for (const { name, call } of clients) {
      let timerCb;
      const ac = new AbortController();
      const p = call(ac, {
        setTimeout: (cb) => {
          timerCb = cb;
          return 123;
        },
        clearTimeout: () => {},
        fetch: (_url, init) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              rej(err);
            });
          }),
      });
      assert.ok(typeof timerCb === "function", `${name}: timer callback must be armed`);
      ac.abort();
      timerCb();
      await assert.rejects(
        p,
        (err) => {
          assert.ok(err instanceof ApiError, `${name} order (2) must reject with ApiError, got ${err?.constructor?.name}`);
          assert.equal(err.statusCode, 499, `${name} order (2) status must be 499`);
          assert.match(err.message, /request was aborted by the caller/i);
          assert.doesNotMatch(err.message, /timed out/i);
          return true;
        },
        `${name} order (2): caller abort must win over raced timer`,
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
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
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
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
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
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
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
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
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

      // PR #169 review: readLog takes the artifacts DIR and is async — the old
      // call passed a file path, skipped the await, and asserted Promise.length
      // (always 0): a vacuous pin that could never fail.
      if (existsSync(join(tmp, "journal.log"))) {
        const logRes = await readLog(tmp);
        assert.equal(logRes.log.entries.length, 0, "no entries should be written on abort");
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
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
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

  it("get walk: a caller cancel ends the walk — remaining arms are never attempted (review)", async () => {
    // Minor 2: the serial get walk caught the arm's abort and rerouted to
    // the next arm, fast-failing at its pre-abort check and emitting a
    // misleading `— rerouting to <arm>` notice for a user cancel.
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    const attempted = [];
    const descriptors = ["openalex", "crossref", "pubmed"].map((id) =>
      makeScienceDescriptor(id, {
        get: (_req, signal) =>
          new Promise((_res, rej) => {
            attempted.push(id);
            // The walk's abort contract: the in-flight arm rejects with the
            // honest caller-cancel error once the shared signal fires.
            const abortErr = () =>
              rej(new ApiError(`${id} request was aborted by the caller (Ctrl-C or external signal)`, 499));
            if (signal.aborted) {
              abortErr();
              return;
            }
            signal.addEventListener("abort", abortErr);
          }),
      }),
    );

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: descriptors.map((d) => d.descriptor),
      fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
    };

    const p = handleScience(["get", "10.1038/nature12373"], "data", deps, {
      registerInterrupt: fakeRegistrar,
    });
    assert.ok(typeof registeredHandler === "function", "handler must be registered before invoke");
    registeredHandler();
    const exitCode = await p;
    assert.equal(exitCode, 1, "aborted get must return exitCode 1");
    assert.deepEqual(
      attempted,
      ["openalex"],
      "a caller cancel must end the walk — no further arm may be attempted",
    );
    const stderrText = inv.stderr.join("");
    assert.doesNotMatch(
      stderrText,
      /rerouting to/i,
      "a caller cancel must never emit a reroute notice",
    );
    assert.match(stderrText, /aborted by the caller/i);
    assert.doesNotMatch(stderrText, /timed out/i);
  });

  it("pinned-search reroute walk: a caller cancel ends the reroute walk (review)", async () => {
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    const attempted = [];
    const openalex = makeScienceDescriptor("openalex", {
      search: (_req, signal) =>
        new Promise((_res, rej) => {
          attempted.push("openalex");
          const abortErr = () =>
            rej(new ApiError("openalex request was aborted by the caller (Ctrl-C or external signal)", 499));
          if (signal.aborted) {
            abortErr();
            return;
          }
          signal.addEventListener("abort", abortErr);
        }),
    });
    const arxiv = makeScienceDescriptor("arxiv");
    const crossref = makeScienceDescriptor("crossref");

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [openalex.descriptor, arxiv.descriptor, crossref.descriptor],
      fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
    };

    const p = handleScience(["search", "quantum", "--provider", "openalex"], "data", deps, {
      registerInterrupt: fakeRegistrar,
    });
    assert.ok(typeof registeredHandler === "function", "handler must be registered before invoke");
    registeredHandler();
    const exitCode = await p;
    assert.equal(exitCode, 1, "aborted pinned search must return exitCode 1");
    assert.equal(openalex.calls.search.length, 1, "the pinned arm was attempted");
    assert.equal(arxiv.calls.search.length, 0, "reroute target must never be attempted");
    assert.equal(crossref.calls.search.length, 0, "reroute target must never be attempted");
    const stderrText = inv.stderr.join("");
    assert.doesNotMatch(
      stderrText,
      /rerouting to/i,
      "a caller cancel must never emit a reroute notice",
    );
    assert.match(stderrText, /aborted by the caller/i);
    assert.doesNotMatch(stderrText, /timed out/i);
  });

  it("pinned-search reroute walk: a caller cancel during a reroute ATTEMPT ends the walk (review)", async () => {
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    const attempted = [];
    const openalex = makeScienceDescriptor("openalex", {
      search: () => {
        attempted.push("openalex");
        throw new ApiError("openalex search failed (boom)", 500);
      },
    });
    const arxiv = makeScienceDescriptor("arxiv", {
      search: (_req, _signal) =>
        new Promise((_res, rej) => {
          attempted.push("arxiv");
          registeredHandler();
          rej(
            new ApiError(
              "arXiv request was aborted by the caller (Ctrl-C or external signal)",
              499,
            ),
          );
        }),
    });
    const crossref = makeScienceDescriptor("crossref");

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [openalex.descriptor, arxiv.descriptor, crossref.descriptor],
      fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
    };

    const p = handleScience(["search", "quantum", "--provider", "openalex"], "data", deps, {
      registerInterrupt: fakeRegistrar,
    });
    const exitCode = await p;
    assert.equal(exitCode, 1, "cancelled reroute search must return exitCode 1");
    assert.deepEqual(
      attempted,
      ["openalex", "arxiv"],
      "a cancel during a reroute attempt must end the walk — no further arm may be attempted",
    );
    assert.equal(crossref.calls.search.length, 0, "crossref must never be attempted");
    const stderrText = inv.stderr.join("");
    assert.doesNotMatch(stderrText, /rerouting to/i, "no reroute notice after a cancel");
    assert.doesNotMatch(
      stderrText,
      /dropped from this reroute walk/i,
      "no drop notice for a cancelled reroute attempt",
    );
    assert.match(stderrText, /aborted by the caller/i);
    assert.doesNotMatch(stderrText, /timed out/i);
  });

  it("(b) get walk: abort between attempts surfaces honest abort error, not previous arm error", async () => {
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    const attempted = [];
    const openalex = makeScienceDescriptor("openalex", {
      get: () => {
        attempted.push("openalex");
        registeredHandler();
        throw new ApiError("openalex get failed (boom)", 500);
      },
    });
    const crossref = makeScienceDescriptor("crossref", {
      get: () => {
        attempted.push("crossref");
        return { title: "work-from-crossref", url: "https://example.org/crossref" };
      },
    });

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [openalex.descriptor, crossref.descriptor],
      fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
    };

    const p = handleScience(["get", "10.1038/nature12373"], "data", deps, {
      registerInterrupt: fakeRegistrar,
    });
    const exitCode = await p;
    assert.equal(exitCode, 1, "aborted get must return exitCode 1");
    assert.deepEqual(attempted, ["openalex"], "second arm must never run after abort");
    const stderrText = inv.stderr.join("");
    assert.match(stderrText, /science request was aborted by the caller \(Ctrl-C or external signal\)/);
    assert.doesNotMatch(stderrText, /boom/);
    assert.doesNotMatch(stderrText, /rerouting to/i);
  });

  it("(b) pinned-search reroute walk: abort between attempts surfaces honest abort error, not pinned arm error", async () => {
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    const attempted = [];
    const openalex = makeScienceDescriptor("openalex", {
      search: () => {
        attempted.push("openalex");
        registeredHandler();
        throw new ApiError("openalex search failed (boom)", 500);
      },
    });
    const arxiv = makeScienceDescriptor("arxiv", {
      search: () => {
        attempted.push("arxiv");
        return [{ title: "work-from-arxiv", url: "https://example.org/arxiv" }];
      },
    });

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [openalex.descriptor, arxiv.descriptor],
      fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
    };

    const p = handleScience(["search", "quantum", "--provider", "openalex"], "data", deps, {
      registerInterrupt: fakeRegistrar,
    });
    const exitCode = await p;
    assert.equal(exitCode, 1, "aborted search must return exitCode 1");
    assert.deepEqual(attempted, ["openalex"], "reroute arm must never run after abort");
    const stderrText = inv.stderr.join("");
    assert.match(stderrText, /science request was aborted by the caller \(Ctrl-C or external signal\)/);
    assert.doesNotMatch(stderrText, /boom/);
    assert.doesNotMatch(stderrText, /rerouting to/i);
  });

  it("(c) partial fan-out abort: exit 0 and journal survivor arms, suppress misleading dropped notice", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sci-fanout-"));
    try {
      let registeredHandler = null;
      const fakeRegistrar = (handler) => {
        registeredHandler = handler;
        return () => {};
      };

      const openalex = {
        id: "openalex",
        isConfigured: () => true,
        capabilities: () => new Set(["science.search"]),
        create() {
          return {
            id: "openalex",
            science: {
              search: {
                validate() {},
                cacheIdentity: (r) => ({
                  supplier: "openalex",
                  capability: "science.search",
                  credentialFingerprint: "",
                  request: r,
                }),
                async invoke() {
                  return [{ title: "work-1", url: "https://example.org/work-1" }];
                },
              },
            },
          };
        },
      };
      const arxiv = {
        id: "arxiv",
        isConfigured: () => true,
        capabilities: () => new Set(["science.search"]),
        create() {
          return {
            id: "arxiv",
            science: {
              search: {
                validate() {},
                async invoke(_r, signal) {
                  return new Promise((_, rej) => {
                    const abortErr = () =>
                      rej(new ApiError("arXiv request was aborted by the caller (Ctrl-C or external signal)", 499));
                    if (signal?.aborted) return abortErr();
                    signal?.addEventListener("abort", abortErr);
                  });
                },
              },
            },
          };
        },
      };

      const inv = makeInvocation();
      const capture = { servedProvider: "openalex" };
      const deps = {
        invocation: inv.adapter,
        env: { SCOUTLINE_ARTIFACTS_DIR: tmp },
        secrets: [],
        providerDescriptors: [openalex, arxiv],
        fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
        journal: {
          capability: "science",
          capture,
        },
      };

      const p = handleScience(["search", "quantum"], "data", deps, {
        registerInterrupt: fakeRegistrar,
      });

      await new Promise((r) => setTimeout(r, 10));
      assert.ok(typeof registeredHandler === "function");
      registeredHandler();

      const exitCode = await p;
      assert.equal(exitCode, 0, "partial fan-out with fulfilled arm must exit 0");

      const logRes = await readLog(tmp);
      assert.equal(logRes.log.entries.length, 1, "survivor arms must be journaled");
      assert.deepEqual(
        logRes.log.entries[0]?.provider,
        { mode: "fanout", arms: ["openalex"] },
        "journal provider arms must carry survivor arms only",
      );

      const stderrText = inv.stderr.join("");
      assert.doesNotMatch(
        stderrText,
        /dropped from this fan-out/i,
        "suppress misleading dropped from this fan-out notice on abort",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(d) injected registrar that throws surfaces registrar error cleanly without secondary crash", async () => {
    const throwingRegistrar = () => {
      throw new Error("injected registrar failure");
    };

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [],
      fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
    };

    await assert.rejects(
      handleScience(["search", "quantum"], "data", deps, {
        registerInterrupt: throwingRegistrar,
      }),
      (err) => {
        assert.equal(err.message, "injected registrar failure");
        assert.doesNotMatch(err.stack || "", /cleanup is not a function/);
        return true;
      },
    );
  });

  it("(a) partial fan-out abort: genuine pre-abort arm failure notice is preserved while abort-classed arm notice is suppressed (review r2)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sci-fanout-genuine-"));
    try {
      let registeredHandler = null;
      const fakeRegistrar = (handler) => {
        registeredHandler = handler;
        return () => {};
      };

      let openalexSettled = false;
      const openalex = {
        id: "openalex",
        isConfigured: () => true,
        capabilities: () => new Set(["science.search"]),
        create() {
          return {
            id: "openalex",
            science: {
              search: {
                validate() {},
                cacheIdentity: (r) => ({
                  supplier: "openalex",
                  capability: "science.search",
                  credentialFingerprint: "",
                  request: r,
                }),
                async invoke() {
                  openalexSettled = true;
                  throw new ApiError("OpenAlex server error (500)", 500);
                },
              },
            },
          };
        },
      };

      const arxiv = {
        id: "arxiv",
        isConfigured: () => true,
        capabilities: () => new Set(["science.search"]),
        create() {
          return {
            id: "arxiv",
            science: {
              search: {
                validate() {},
                async invoke(_r, signal) {
                  return new Promise((_, rej) => {
                    const abortErr = () =>
                      rej(new ApiError("arXiv request was aborted by the caller (Ctrl-C or external signal)", 499));
                    if (signal?.aborted) return abortErr();
                    signal?.addEventListener("abort", abortErr);
                  });
                },
              },
            },
          };
        },
      };

      const crossref = {
        id: "crossref",
        isConfigured: () => true,
        capabilities: () => new Set(["science.search"]),
        create() {
          return {
            id: "crossref",
            science: {
              search: {
                validate() {},
                cacheIdentity: (r) => ({
                  supplier: "crossref",
                  capability: "science.search",
                  credentialFingerprint: "",
                  request: r,
                }),
                async invoke() {
                  return new Promise((res) => {
                    setTimeout(() => {
                      res([{ title: "work-crossref", url: "https://example.org/crossref" }]);
                    }, 25);
                  });
                },
              },
            },
          };
        },
      };

      const inv = makeInvocation();
      const capture = { servedProvider: "crossref" };
      const deps = {
        invocation: inv.adapter,
        env: { SCOUTLINE_ARTIFACTS_DIR: tmp },
        secrets: [],
        providerDescriptors: [openalex, arxiv, crossref],
        fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
        journal: {
          capability: "science",
          capture,
        },
      };

      const p = handleScience(["search", "quantum"], "data", deps, {
        registerInterrupt: fakeRegistrar,
      });

      for (let i = 0; i < 50 && !openalexSettled; i += 1) {
        await new Promise((r) => setTimeout(r, 2));
      }
      assert.ok(openalexSettled, "openalex must have settled first");
      assert.ok(typeof registeredHandler === "function", "handler must be registered");
      registeredHandler();

      const exitCode = await p;
      assert.equal(exitCode, 0, "partial fan-out with fulfilled arm must exit 0");

      const logRes = await readLog(tmp);
      assert.equal(logRes.log.entries.length, 1, "survivor arms must be journaled");
      assert.deepEqual(
        logRes.log.entries[0]?.provider,
        { mode: "fanout", arms: ["crossref"] },
        "journal provider arms must carry survivor arms [crossref] only",
      );

      const stderrText = inv.stderr.join("");
      assert.match(
        stderrText,
        /scoutline: openalex arm failed \(OpenAlex server error \(500\)\) — dropped from this fan-out\./,
        "genuine pre-abort arm failure notice must be present in stderr",
      );
      assert.doesNotMatch(
        stderrText,
        /arxiv.*dropped from this fan-out/i,
        "abort-classed arm failure notice must be suppressed",
      );
      assert.doesNotMatch(
        stderrText,
        /scoutline: arxiv arm failed/i,
        "arxiv arm failure notice must not be emitted",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(b) fan-out all-rejected envelope: abort wording wins when signal is aborted (order i and ii) (review r2)", async () => {
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    // Order (i): first arm genuinely 500s, then abort, remaining arms reject abort-classed
    {
      let openalexSettled = false;
      const openalex = makeScienceDescriptor("openalex", {
        search: async () => {
          openalexSettled = true;
          throw new ApiError("openalex upstream 500", 500);
        },
      });
      const arxiv = makeScienceDescriptor("arxiv", {
        search: (_req, signal) =>
          new Promise((_res, rej) => {
            const abortErr = () =>
              rej(new ApiError("arXiv request was aborted by the caller (Ctrl-C or external signal)", 499));
            if (signal?.aborted) return abortErr();
            signal?.addEventListener("abort", abortErr);
          }),
      });

      const inv = makeInvocation();
      const deps = {
        invocation: inv.adapter,
        env: {},
        secrets: [],
        providerDescriptors: [openalex.descriptor, arxiv.descriptor],
        fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
      };

      const p = handleScience(["search", "quantum"], "data", deps, {
        registerInterrupt: fakeRegistrar,
      });

      for (let i = 0; i < 50 && !openalexSettled; i += 1) {
        await new Promise((r) => setTimeout(r, 2));
      }
      assert.ok(openalexSettled, "openalex must have settled first");
      assert.ok(typeof registeredHandler === "function");
      registeredHandler();

      const exitCode = await p;
      assert.equal(exitCode, 1, "aborted search must exit 1");
      const stderrText = inv.stderr.join("");
      assert.match(
        stderrText,
        /aborted by the caller/i,
        "envelope must match /aborted by the caller/ when signal was aborted",
      );
      assert.doesNotMatch(
        stderrText,
        /upstream 500/,
        "stale upstream 500 error must not be surfaced as the envelope",
      );
    }

    // Order (ii): first arm rejection IS the abort
    {
      const openalex = makeScienceDescriptor("openalex", {
        search: (_req, signal) =>
          new Promise((_res, rej) => {
            const abortErr = () =>
              rej(new ApiError("openalex request was aborted by the caller (Ctrl-C or external signal)", 499));
            if (signal?.aborted) return abortErr();
            signal?.addEventListener("abort", abortErr);
          }),
      });
      const arxiv = makeScienceDescriptor("arxiv", {
        search: (_req, signal) =>
          new Promise((_res, rej) => {
            const abortErr = () =>
              rej(new ApiError("arxiv request was aborted by the caller (Ctrl-C or external signal)", 499));
            if (signal?.aborted) return abortErr();
            signal?.addEventListener("abort", abortErr);
          }),
      });

      const inv = makeInvocation();
      const deps = {
        invocation: inv.adapter,
        env: {},
        secrets: [],
        providerDescriptors: [openalex.descriptor, arxiv.descriptor],
        fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
      };

      const p = handleScience(["search", "quantum"], "data", deps, {
        registerInterrupt: fakeRegistrar,
      });
      assert.ok(typeof registeredHandler === "function");
      registeredHandler();

      const exitCode = await p;
      assert.equal(exitCode, 1, "aborted search must exit 1");
      const stderrText = inv.stderr.join("");
      assert.match(
        stderrText,
        /aborted by the caller/i,
        "envelope must match /aborted by the caller/",
      );
    }
  });

  it("(c) pinned-search reroute walk: reroute target genuinely 500s while signal aborted normalizes to abort wording (review r2)", async () => {
    let registeredHandler = null;
    const fakeRegistrar = (handler) => {
      registeredHandler = handler;
      return () => {};
    };

    const attempted = [];
    const openalex = makeScienceDescriptor("openalex", {
      search: () => {
        attempted.push("openalex");
        throw new ApiError("openalex search failed (boom)", 500);
      },
    });
    const arxiv = makeScienceDescriptor("arxiv", {
      search: (_req, _signal) =>
        new Promise((_res, rej) => {
          attempted.push("arxiv");
          registeredHandler();
          rej(new ApiError("arxiv 500 upstream server error", 500));
        }),
    });
    const crossref = makeScienceDescriptor("crossref");

    const inv = makeInvocation();
    const deps = {
      invocation: inv.adapter,
      env: {},
      secrets: [],
      providerDescriptors: [openalex.descriptor, arxiv.descriptor, crossref.descriptor],
      fallbackEnabled: true,
      scienceCache: createInMemoryResponseCache(),
      scienceSleep: async () => {},
      scienceRandom: () => 0.5,
    };

    const p = handleScience(["search", "quantum", "--provider", "openalex"], "data", deps, {
      registerInterrupt: fakeRegistrar,
    });
    const exitCode = await p;
    assert.equal(exitCode, 1, "cancelled reroute search must return exitCode 1");
    assert.deepEqual(
      attempted,
      ["openalex", "arxiv"],
      "a cancel during a reroute attempt must end the walk — no further arm may be attempted",
    );
    assert.equal(crossref.calls.search.length, 0, "crossref must never be attempted");
    const stderrText = inv.stderr.join("");
    assert.doesNotMatch(stderrText, /rerouting to/i, "no reroute notice after a cancel");
    assert.doesNotMatch(
      stderrText,
      /dropped from this reroute walk/i,
      "no drop notice for a cancelled reroute attempt",
    );
    assert.match(
      stderrText,
      /science request was aborted by the caller \(Ctrl-C or external signal\)/,
      "normalized abort wording must be surfaced in envelope",
    );
    assert.doesNotMatch(
      stderrText,
      /arxiv 500 upstream server error/,
      "raw non-abort nextError must not leak into envelope when signal aborted",
    );
  });
});
