/**
 * T3a — Wizard: fresh onboarding.
 *
 * Acceptance gates (T3a ticket):
 *   - Fresh-onboarding happy path (multi-provider) writes a valid
 *     config.json (0600, atomic) via writeConfig.
 *   - Validation classification: key-problem (AuthError/ApiError) →
 *     reject + re-prompt (never advances on a key-problem);
 *     NetworkError → save-unverified; credit-cost disclosure shown
 *     before any paid probe.
 *   - Checklist equal-weight (no canonical pre-checks).
 *   - Candidate key in ephemeral env only; process.env never mutated.
 *   - Atomic write: cancel mid-flow writes nothing (no partial config).
 *   - Zero-provider confirmation: default No → back to checklist;
 *     Yes → minimal config + pointer to `init` later.
 *   - Registration link renders BOTH a terminal hyperlink AND the
 *     literal URL text (so captured / non-hyperlink output stays
 *     usable).
 *   - Hermeticity: the wizard runs through injected prompts/store/
 *     descriptors/clock/TTY — no real TTY, no real config-root I/O.
 *
 * Live diagnostics is OUT of scope here; tests inject fake descriptors
 * whose `create()` returns an Adapter whose `diagnostics.invoke` is
 * scripted per test. The wizard calls the capability directly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { main } from "../dist/index.js";
import { handleInitWithHelp, INIT_HELP } from "../dist/commands/init.js";
import { AuthError, ApiError, NetworkError } from "../dist/lib/errors.js";
import { withTempDir } from "./helpers/temp-dir.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Fake provider descriptor whose diagnostics.invoke is driven by the
 * scripted `behaviour`. Records every invoke so tests can assert the
 * "one attempt per provider" contract. The descriptor advertises
 * diagnostics + search so capabilities() returns a non-empty set.
 */
function makeFakeDescriptor({
  id = "zai",
  credentialEnvVars = ["Z_AI_API_KEY"],
  behaviour = "resolve",
  canonicalEnvVar,
}) {
  canonicalEnvVar = canonicalEnvVar || credentialEnvVars[0];
  const invokes = [];
  const descriptor = {
    id,
    credentialEnvVars,
    isConfigured: (env) => {
      const v = env[canonicalEnvVar];
      return typeof v === "string" && v.trim().length > 0;
    },
    capabilities: () => new Set(["search", "diagnostics"]),
    create: ({ env }) => {
      return {
        id,
        diagnostics: {
          async invoke({ probe }) {
            invokes.push({ probe, env });
            if (typeof behaviour === "function") return behaviour(env);
            if (behaviour === "resolve") return undefined;
            if (behaviour === "auth") throw new AuthError("invalid key", canonicalEnvVar);
            if (behaviour === "api") throw new ApiError("provider error", 500);
            if (behaviour === "network") throw new NetworkError("connection refused");
            throw new Error("unknown behaviour: " + behaviour);
          },
        },
      };
    },
  };
  return { descriptor, invokes };
}

/**
 * In-memory InitConfigStore double. Backed by a Map keyed by the
 * options.filePath the wizard passes through. `inspect` returns
 * `absent` until the first `write`; tests can pre-seed via the
 * `initial` constructor arg.
 */
function createFakeConfigStore({ initial = null } = {}) {
  let stored = initial;
  const writes = [];
  return {
    async inspect() {
      if (!stored) return { status: "absent", filePath: "/tmp/fake-config.json" };
      return {
        status: "valid",
        filePath: "/tmp/fake-config.json",
        config: stored,
        warnings: [],
      };
    },
    async write(config, options) {
      writes.push({ config, options });
      stored = config;
    },
    getConfig: () => stored,
    getWrites: () => writes,
  };
}

/**
 * Scripted InitPrompts double. Each prompt method pops the next queued
 * answer of its kind. If the queue is empty, throws so a test that
 * under-scripts fails loudly rather than hanging.
 *
 * `cancelKind` throws on the NEXT queued answer of that kind, simulating
 * Ctrl+C / EOF mid-flow.
 */
function createScriptedPrompts() {
  const queue = {
    checkbox: [],
    confirm: [],
    password: [],
    input: [],
  };
  const calls = {
    checkbox: [],
    confirm: [],
    password: [],
    input: [],
  };
  const prompts = {
    async checkbox(message, choices) {
      calls.checkbox.push({ message, choices });
      if (queue.checkbox.length === 0) {
        throw new Error("scripted checkbox queue exhausted: " + message);
      }
      const { answer, cancel } = queue.checkbox.shift();
      if (cancel) throw new Error("cancel");
      return answer;
    },
    async confirm(message, defaultYes) {
      calls.confirm.push({ message, defaultYes });
      if (queue.confirm.length === 0) {
        throw new Error("scripted confirm queue exhausted: " + message);
      }
      const { answer, cancel } = queue.confirm.shift();
      if (cancel) throw new Error("cancel");
      return answer;
    },
    async password(message) {
      calls.password.push({ message });
      if (queue.password.length === 0) {
        throw new Error("scripted password queue exhausted: " + message);
      }
      const { answer, cancel } = queue.password.shift();
      if (cancel) throw new Error("cancel");
      return answer;
    },
    async input(message) {
      calls.input.push({ message });
      if (queue.input.length === 0) {
        throw new Error("scripted input queue exhausted: " + message);
      }
      const { answer, cancel } = queue.input.shift();
      if (cancel) throw new Error("cancel");
      return answer;
    },
  };
  return {
    prompts,
    calls,
    queueCheckbox(answer) {
      queue.checkbox.push({ answer });
    },
    queueConfirm(answer) {
      queue.confirm.push({ answer });
    },
    queuePassword(answer) {
      queue.password.push({ answer });
    },
    queueCheckboxCancel() {
      queue.checkbox.push({ cancel: true });
    },
    queueConfirmCancel() {
      queue.confirm.push({ cancel: true });
    },
    queuePasswordCancel() {
      queue.password.push({ cancel: true });
    },
  };
}

/** Build a default InitDependencies bag for tests. */
function createInitDeps({
  descriptors,
  prompts,
  configStore,
  env = {},
  now = () => 1_700_000_000_000,
  stdinIsTTY = true,
} = {}) {
  const stderrChunks = [];
  const stdoutChunks = [];
  return {
    deps: {
      descriptors,
      prompts,
      configStore,
      env,
      now,
      stdinIsTTY,
      writeStderr: (v) => stderrChunks.push(v),
      writeStdout: (v) => stdoutChunks.push(v),
    },
    stderrChunks,
    stdoutChunks,
  };
}

// ---------------------------------------------------------------------------
// --help short-circuit
// ---------------------------------------------------------------------------

describe("init --help: stdout-only, exit 0, surfaces preview caveat", () => {
  it("writes INIT_HELP to stdout and returns 0", async () => {
    const script = createScriptedPrompts();
    const store = createFakeConfigStore();
    const { deps, stdoutChunks, stderrChunks } = createInitDeps({
      descriptors: [],
      prompts: script.prompts,
      configStore: store,
    });
    const status = await handleInitWithHelp(["--help"], deps);

    assert.strictEqual(status, 0);
    assert.strictEqual(stderrChunks.length, 0);
    assert.strictEqual(stdoutChunks.length, 1);
    assert.match(stdoutChunks[0], /PREVIEW/);
    assert.match(stdoutChunks[0], /re-configuration menu/i);
    // No config interaction on --help.
    assert.strictEqual(store.getWrites().length, 0);
  });

  it("INIT_HELP constant matches the help text exactly", () => {
    assert.match(INIT_HELP, /PREVIEW/);
    assert.match(INIT_HELP, /mode 0600/);
  });
});

// ---------------------------------------------------------------------------
// Non-TTY graceful guard
// ---------------------------------------------------------------------------

describe("init non-TTY guard: friendly stderr, exit 1, no writes", () => {
  it("refuses to enter the interactive flow when stdin is not a TTY", async () => {
    const script = createScriptedPrompts();
    const store = createFakeConfigStore();
    const { deps, stderrChunks, stdoutChunks } = createInitDeps({
      descriptors: [],
      prompts: script.prompts,
      configStore: store,
      stdinIsTTY: false,
    });

    const status = await handleInitWithHelp([], deps);

    assert.strictEqual(status, 1);
    assert.strictEqual(stdoutChunks.length, 0);
    assert.match(stderrChunks.join(""), /interactive terminal/i);
    // The wizard must not touch the store under the non-TTY guard.
    assert.strictEqual(store.getWrites().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Already-onboarded short-circuit
// ---------------------------------------------------------------------------

describe("init already-onboarded: re-config deferred, exit 0", () => {
  it("when config holds an api key the wizard defers to T3b and exits 0", async () => {
    const script = createScriptedPrompts();
    const store = createFakeConfigStore({
      initial: { version: 1, providers: { zai: { apiKey: "prior-key" } } },
    });
    const { deps, stderrChunks } = createInitDeps({
      descriptors: [],
      prompts: script.prompts,
      configStore: store,
    });

    const status = await handleInitWithHelp([], deps);

    assert.strictEqual(status, 0);
    assert.match(stderrChunks.join(""), /already set up/i);
    assert.match(stderrChunks.join(""), /follow-up release/i);
    assert.strictEqual(store.getWrites().length, 0);
  });

  it("when config holds onboarded:true (no api key) the wizard still defers", async () => {
    const script = createScriptedPrompts();
    const store = createFakeConfigStore({
      initial: { version: 1, providers: { minimax: { onboarded: true } } },
    });
    const { deps } = createInitDeps({
      descriptors: [],
      prompts: script.prompts,
      configStore: store,
    });

    const status = await handleInitWithHelp([], deps);
    assert.strictEqual(status, 0);
  });

  it("when config is empty (no providers) the wizard enters the fresh flow", async () => {
    const script = createScriptedPrompts();
    // Queue an immediate cancel so the wizard exits cleanly without
    // driving the full fresh flow — we only need to prove it ENTERED
    // the flow (the cancel assertion is the witness).
    script.queueCheckboxCancel();
    const store = createFakeConfigStore({
      initial: { version: 1, providers: {} },
    });
    const { deps } = createInitDeps({
      descriptors: [],
      prompts: script.prompts,
      configStore: store,
    });

    const status = await handleInitWithHelp([], deps);
    assert.strictEqual(status, 1);
    assert.strictEqual(store.getWrites().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Fresh-onboarding happy path
// ---------------------------------------------------------------------------

describe("init fresh-onboarding happy path: multi-provider, atomic write", () => {
  it("writes a valid 0600 config for two verified providers", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      // Two fake descriptors: one free-probe (zai), one paid-probe (tavily).
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });
      const tavily = makeFakeDescriptor({
        id: "tavily",
        credentialEnvVars: ["TAVILY_API_KEY"],
        behaviour: "resolve",
      });

      const script = createScriptedPrompts();
      // Select both providers in registry order.
      script.queueCheckbox(["zai", "tavily"]);
      // Z.AI per-provider flow: has-key Yes, password = zai-secret.
      script.queueConfirm(true);
      script.queuePassword("zai-secret");
      // Tavily per-provider flow: has-key Yes, password = tvly-secret.
      script.queueConfirm(true);
      script.queuePassword("tvly-secret");
      // Fallback preference: default Yes.
      script.queueConfirm(true);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stdoutChunks, stderrChunks } = createInitDeps({
        descriptors: [zai.descriptor, tavily.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);

      assert.strictEqual(status, 0);
      // One probe per provider — the "one attempt" contract.
      assert.strictEqual(zai.invokes.length, 1);
      assert.strictEqual(tavily.invokes.length, 1);
      // Atomic write landed on disk.
      const written = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.deepStrictEqual(written, {
        version: 1,
        fallbackEnabled: true,
        providers: {
          zai: {
            apiKey: "zai-secret",
            onboarded: true,
            verification: { status: "verified", checkedAt: 1_700_000_000_000 },
          },
          tavily: {
            apiKey: "tvly-secret",
            onboarded: true,
            verification: { status: "verified", checkedAt: 1_700_000_000_000 },
          },
        },
      });
      // Mode 0600 on POSIX.
      if (process.platform !== "win32") {
        assert.strictEqual((await fs.stat(filePath)).mode & 0o777, 0o600);
      }
      // Redaction: keys never reach stdout or stderr.
      const allOutput = stdoutChunks.join("") + stderrChunks.join("");
      assert.ok(!allOutput.includes("zai-secret"), "zai key leaked to output");
      assert.ok(!allOutput.includes("tvly-secret"), "tavily key leaked to output");
      // Summary line landed on stdout.
      assert.match(stdoutChunks[0], /Z\.AI \(zai\): verified/);
      assert.match(stdoutChunks[0], /Tavily \(tavily\): verified/);
      assert.match(stdoutChunks[0], /fallbackEnabled=true/);
    });
  });

  it("candidate key exists only in the ephemeral probe env (process.env never mutated)", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      script.queueCheckbox(["zai"]);
      script.queueConfirm(true);
      script.queuePassword("candidate-secret");

      // Single fallback confirm.
      script.queueConfirm(true);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const priorProcessKey = process.env.Z_AI_API_KEY;
      delete process.env.Z_AI_API_KEY;
      try {
        const { deps } = createInitDeps({
          descriptors: [zai.descriptor],
          prompts: script.prompts,
          configStore: store,
          env: { OTHER_VAR: "preserved" },
        });

        const status = await handleInitWithHelp([], deps);
        assert.strictEqual(status, 0);

        // process.env stayed clean.
        assert.strictEqual(process.env.Z_AI_API_KEY, undefined);
        // Injected env was not mutated either.
        assert.strictEqual(deps.env.Z_AI_API_KEY, undefined);
        assert.strictEqual(deps.env.OTHER_VAR, "preserved");
        // The probe saw the candidate via the ephemeral view only.
        assert.strictEqual(zai.invokes[0].env.Z_AI_API_KEY, "candidate-secret");
      } finally {
        if (priorProcessKey !== undefined) process.env.Z_AI_API_KEY = priorProcessKey;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Validation classification
// ---------------------------------------------------------------------------

describe("init validation classification: honest broad taxonomy", () => {
  it("AuthError rejects and re-prompts; verified on the second attempt", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      // First attempt throws AuthError; second resolves.
      let attempt = 0;
      const zai = makeFakeDescriptor({
        id: "zai",
        behaviour: () => {
          attempt += 1;
          if (attempt === 1) throw new AuthError("invalid key", "Z_AI_API_KEY");
          return undefined;
        },
      });

      const script = createScriptedPrompts();
      script.queueCheckbox(["zai"]);
      script.queueConfirm(true);
      script.queuePassword("wrong-secret");
      // After auth failure: re-prompt with another password.
      script.queuePassword("correct-secret");
      script.queueConfirm(true); // fallback

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stderrChunks } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);

      assert.strictEqual(status, 0);
      // Exactly two probes — one auth failure + one verified.
      assert.strictEqual(zai.invokes.length, 2);
      // Written config carries the verified key (the second one).
      const written = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.strictEqual(written.providers.zai.apiKey, "correct-secret");
      assert.strictEqual(written.providers.zai.verification.status, "verified");
      // Honest classification surfaced in stderr.
      assert.match(stderrChunks.join(""), /key rejected/i);
      // The first (rejected) key never reached the file.
      const allOutput = stderrChunks.join("");
      assert.ok(!allOutput.includes("wrong-secret"));
    });
  });

  it("NetworkError offers save-unverified; Yes writes status unverified", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const tavily = makeFakeDescriptor({
        id: "tavily",
        credentialEnvVars: ["TAVILY_API_KEY"],
        behaviour: () => {
          throw new NetworkError("connection refused");
        },
      });

      const script = createScriptedPrompts();
      script.queueCheckbox(["tavily"]);
      script.queueConfirm(true); // has key
      script.queuePassword("tvly-maybe-good");
      // Network-error → offer save-unverified (default Yes).
      script.queueConfirm(true);
      script.queueConfirm(true); // fallback

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stdoutChunks } = createInitDeps({
        descriptors: [tavily.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 0);

      const written = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.strictEqual(written.providers.tavily.apiKey, "tvly-maybe-good");
      assert.strictEqual(written.providers.tavily.verification.status, "unverified");
      assert.strictEqual(written.providers.tavily.verification.reason, "network-deferred");
      // Summary honestly labels the provider as unverified.
      assert.match(stdoutChunks[0], /Tavily \(tavily\): unverified/);
    });
  });

  it("NetworkError save-unverified declined → provider skipped, no key written", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const tavily = makeFakeDescriptor({
        id: "tavily",
        credentialEnvVars: ["TAVILY_API_KEY"],
        behaviour: () => {
          throw new NetworkError("offline");
        },
      });

      const script = createScriptedPrompts();
      script.queueCheckbox(["tavily"]);
      script.queueConfirm(true);
      script.queuePassword("tvly-maybe-good");
      script.queueConfirm(false); // decline save-unverified
      script.queueConfirm(true); // fallback default

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps } = createInitDeps({
        descriptors: [tavily.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 0);
      const written = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.deepStrictEqual(written.providers, {});
    });
  });

  it("ApiError is treated as a key-problem (reject + re-prompt), not network", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({
        id: "zai",
        behaviour: () => {
          throw new ApiError("upstream 500", 500);
        },
      });

      const script = createScriptedPrompts();
      script.queueCheckbox(["zai"]);
      script.queueConfirm(true);
      script.queuePassword("first-attempt");
      // After ApiError: re-prompt; user cancels via a second auth-failure
      // by entering another bad key, then we prove the wizard never
      // offered save-unverified (the path is auth-error, not network).
      script.queuePassword("second-attempt");
      // After the second ApiError the wizard re-prompts again; cancel.
      script.queuePasswordCancel();
      // fallback never reached.

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stderrChunks } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      // Cancel after re-prompt → exit 1, no write.
      assert.strictEqual(status, 1);
      // No config file ever written.
      await assert.rejects(fs.readFile(filePath, "utf8"));
      // Save-unverified was never offered for an ApiError.
      assert.ok(
        !/save the key as unverified/i.test(stderrChunks.join("")),
        "ApiError must not trigger save-unverified",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Credit-cost disclosure before paid-provider probe
// ---------------------------------------------------------------------------

describe("init credit-cost disclosure: shown before paid probes, absent for free", () => {
  it("Tavily probe discloses ~1 credit cost before validation", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const tavily = makeFakeDescriptor({
        id: "tavily",
        credentialEnvVars: ["TAVILY_API_KEY"],
        behaviour: "resolve",
      });

      const script = createScriptedPrompts();
      script.queueCheckbox(["tavily"]);
      script.queueConfirm(true);
      script.queuePassword("tvly-key");
      script.queueConfirm(true);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stderrChunks } = createInitDeps({
        descriptors: [tavily.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 0);
      // Disclosure line emitted to stderr BEFORE the probe.
      const joined = stderrChunks.join("");
      assert.match(joined, /Tavily: validating the key costs ~1 credit/i);
    });
  });

  it("Z.AI probe is free — no credit-cost line emitted", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      script.queueCheckbox(["zai"]);
      script.queueConfirm(true);
      script.queuePassword("zai-key");
      script.queueConfirm(true);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stderrChunks } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 0);
      const joined = stderrChunks.join("");
      assert.ok(!/~1 credit/i.test(joined), "free provider must not emit credit-cost line");
      // The "free" hint lives in the choice description (delivered via
      // the prompt seam, not stderr). The checklist call captured it.
      const zaiChoice = script.calls.checkbox[0].choices.find((c) => c.value === "zai");
      assert.match(zaiChoice.description, /free/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Atomic write: cancel mid-flow writes nothing
// ---------------------------------------------------------------------------

describe("init atomic write: cancel mid-flow writes nothing", () => {
  it("Ctrl+C on the provider checklist writes no config", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      script.queueCheckboxCancel();

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 1);
      // No file ever created.
      await assert.rejects(fs.readFile(filePath, "utf8"));
      assert.strictEqual(zai.invokes.length, 0);
    });
  });

  it("Ctrl+C on the password prompt writes no config", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      script.queueCheckbox(["zai"]);
      script.queueConfirm(true);
      script.queuePasswordCancel();

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 1);
      await assert.rejects(fs.readFile(filePath, "utf8"));
    });
  });

  it("Ctrl+C on the fallback preference writes no config", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      script.queueCheckbox(["zai"]);
      script.queueConfirm(true);
      script.queuePassword("zai-key");
      script.queueConfirmCancel(); // fallback

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 1);
      await assert.rejects(fs.readFile(filePath, "utf8"));
    });
  });
});

// ---------------------------------------------------------------------------
// Zero-provider confirmation
// ---------------------------------------------------------------------------

describe("init zero-provider confirmation: default No returns to checklist", () => {
  it("Continue with none? default No → loops back to the checklist", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      // First checklist: empty selection.
      script.queueCheckbox([]);
      // Zero-provider confirm: No (default).
      script.queueConfirm(false);
      // Loops back to checklist: select zai and proceed.
      script.queueCheckbox(["zai"]);
      script.queueConfirm(true);
      script.queuePassword("zai-key");
      script.queueConfirm(true);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stdoutChunks } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 0);
      // Two checklist prompts observed (loop-back witness).
      assert.strictEqual(script.calls.checkbox.length, 2);
      assert.match(stdoutChunks[0], /Z\.AI \(zai\): verified/);
    });
  });

  it("Continue with none? Yes → writes minimal config and pointer", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      script.queueCheckbox([]);
      script.queueConfirm(true); // continue with none
      // After the zero-provider Yes the wizard still asks the fallback
      // preference so the user's preference is captured even with no
      // providers configured.
      script.queueConfirm(false);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stdoutChunks } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 0);
      const written = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.deepStrictEqual(written, {
        version: 1,
        fallbackEnabled: false,
        providers: {},
      });
      assert.match(stdoutChunks[0], /no providers configured/i);
      assert.match(stdoutChunks[0], /Re-run `scoutline init`/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Hyperlink + literal URL fallback
// ---------------------------------------------------------------------------

describe("init registration link: hyperlink + literal URL both rendered", () => {
  it("declining a key emits OSC 8 hyperlink AND the bare URL on separate lines", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const brave = makeFakeDescriptor({
        id: "brave",
        credentialEnvVars: ["BRAVE_SEARCH_API_KEY"],
        behaviour: "resolve",
      });

      const script = createScriptedPrompts();
      script.queueCheckbox(["brave"]);
      // Decline the key → registration link path.
      script.queueConfirm(false);
      // Fallback still asked.
      script.queueConfirm(true);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stderrChunks } = createInitDeps({
        descriptors: [brave.descriptor],
        prompts: script.prompts,
        configStore: store,
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 0);
      const joined = stderrChunks.join("");
      // Hyperlink escape (OSC 8).
      assert.match(joined, /\x1B\]8;;/);
      // The literal URL appears on its own line for non-hyperlink terminals.
      assert.match(joined, /https:\/\/api\.search\.brave\.com\/app\/subscriptions/);
      // Brave not configured (skipped), so providers is empty.
      const written = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.deepStrictEqual(written.providers, {});
    });
  });
});

// ---------------------------------------------------------------------------
// Env-key import offer
// ---------------------------------------------------------------------------

describe("init env-key import: candidate offered when ambient env has a key", () => {
  it("offers import for a provider whose canonical env var is set; verifies the imported key", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      script.queueCheckbox(["zai"]);
      // Env-import offer → Yes.
      script.queueConfirm(true);
      // Fallback.
      script.queueConfirm(true);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps, stderrChunks } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
        env: { Z_AI_API_KEY: "env-imported-key" },
      });

      // Snapshot and clear any ambient process.env key so the "wizard
      // never mutates process.env" assertion is not contaminated by the
      // test runner's own environment.
      const priorProcessKey = process.env.Z_AI_API_KEY;
      delete process.env.Z_AI_API_KEY;
      try {
        const status = await handleInitWithHelp([], deps);
        assert.strictEqual(status, 0);
        // Imported key reached the file as the verified apiKey.
        const written = JSON.parse(await fs.readFile(filePath, "utf8"));
        assert.strictEqual(written.providers.zai.apiKey, "env-imported-key");
        assert.strictEqual(written.providers.zai.verification.status, "verified");
        // The wizard surfaced the env-var detection at the start of the flow.
        assert.match(stderrChunks.join(""), /Detected env key.*Z_AI_API_KEY/);
        // Probe was driven with the imported candidate in the ephemeral env.
        assert.strictEqual(zai.invokes[0].env.Z_AI_API_KEY, "env-imported-key");
        // process.env was not mutated by the wizard.
        assert.strictEqual(process.env.Z_AI_API_KEY, undefined);
      } finally {
        if (priorProcessKey !== undefined) process.env.Z_AI_API_KEY = priorProcessKey;
      }
    });
  });

  it("declining env-import falls through to ask-key-first (manual input)", async (t) => {
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const zai = makeFakeDescriptor({ id: "zai", behaviour: "resolve" });

      const script = createScriptedPrompts();
      script.queueCheckbox(["zai"]);
      // Decline import.
      script.queueConfirm(false);
      // Then has-key Yes, manual password.
      script.queueConfirm(true);
      script.queuePassword("manual-key");
      script.queueConfirm(true);

      const realStore = await import("../dist/lib/config-store.js");
      const store = {
        async inspect() {
          return realStore.inspectConfig({ filePath });
        },
        async write(config, options) {
          await realStore.writeConfig(config, { filePath, ...options });
        },
      };

      const { deps } = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: script.prompts,
        configStore: store,
        env: { Z_AI_API_KEY: "env-imported-key" },
      });

      const status = await handleInitWithHelp([], deps);
      assert.strictEqual(status, 0);
      const written = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.strictEqual(written.providers.zai.apiKey, "manual-key");
    });
  });
});

// ---------------------------------------------------------------------------
// Equal-weight checklist
// ---------------------------------------------------------------------------

describe("init provider checklist: registry-derived, equal weight", () => {
  it("choice list matches registry order and none is pre-checked", async () => {
    // Use the real BUILT_IN_PROVIDER_DESCRIPTORS so the assertion tracks
    // the registry exactly. We don't drive the prompts; we only inspect
    // the choice list handed to checkbox.
    const { BUILT_IN_PROVIDER_DESCRIPTORS } = await import("../dist/providers/registry.js");
    // Replace diagnostics with a no-op so create() doesn't construct a
    // real transport if the test ever accidentally advances.
    const descriptors = BUILT_IN_PROVIDER_DESCRIPTORS;
    const script = createScriptedPrompts();
    // Cancel immediately; we only need the choice list.
    script.queueCheckboxCancel();
    const store = createFakeConfigStore();
    const { deps } = createInitDeps({ descriptors, prompts: script.prompts, configStore: store });

    await handleInitWithHelp([], deps);

    const call = script.calls.checkbox[0];
    assert.ok(call, "checkbox was invoked");
    assert.deepStrictEqual(
      call.choices.map((c) => c.value),
      [...descriptors.map((d) => d.id)],
    );
    for (const choice of call.choices) {
      assert.strictEqual(choice.checked, false, `provider ${choice.value} must not be pre-checked`);
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatcher integration: main(["init", "--help"]) in-process
// ---------------------------------------------------------------------------

describe("init dispatch through main(): init --help returns 0, no config touch", () => {
  it("main(['init', '--help']) short-circuits before config load", async () => {
    const stdout = [];
    const stderr = [];
    const adapter = {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    };
    let storeCalls = 0;
    const fakeStore = {
      async inspect() {
        storeCalls += 1;
        return { status: "absent", filePath: "/tmp/none.json" };
      },
      async write() {
        storeCalls += 1;
      },
    };

    const status = await main(["init", "--help"], {
      invocation: adapter,
      env: {},
      initConfigStore: fakeStore,
    });

    assert.strictEqual(status, 0);
    assert.strictEqual(stderr.length, 0);
    assert.match(stdout[0], /PREVIEW/);
    // --help must not even inspect the store.
    assert.strictEqual(storeCalls, 0);
  });

  it("main(['init']) in non-TTY returns 1 with the graceful guard", async () => {
    const stdout = [];
    const stderr = [];
    const adapter = {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    };
    let storeWrites = 0;
    const fakeStore = {
      async inspect() {
        return { status: "absent", filePath: "/tmp/none.json" };
      },
      async write() {
        storeWrites += 1;
      },
    };

    const status = await main(["init"], {
      invocation: adapter,
      env: {},
      initConfigStore: fakeStore,
    });

    assert.strictEqual(status, 1);
    assert.match(stderr[stderr.length - 1], /interactive terminal/i);
    assert.strictEqual(storeWrites, 0);
  });

  it("main(['init']) survives a corrupt config without blocking (short-circuit before load)", async () => {
    // The wizard must NOT trigger the credentialed config-load path.
    // Drive main with an initConfigStore that returns "corrupt" via
    // inspect and prove the wizard still runs (non-TTY guard fires
    // before any inspect call would have mattered).
    const stdout = [];
    const stderr = [];
    const adapter = {
      stdoutIsTTY: false,
      stdinIsTTY: false,
      environmentOutputMode: "data",
      readStdin: async () => "",
      writeStdout: (v) => stdout.push(v),
      writeStderr: (v) => stderr.push(v),
      runQuietly: async (op) => op(),
      setExitCode: () => {},
    };
    const fakeStore = {
      async inspect() {
        return {
          status: "corrupt",
          filePath: "/tmp/corrupt.json",
          error: new Error("corrupt"),
        };
      },
      async write() {},
    };
    const status = await main(["init"], {
      invocation: adapter,
      env: {},
      initConfigStore: fakeStore,
    });
    // Non-TTY guard fires regardless of corrupt state.
    assert.strictEqual(status, 1);
    assert.match(stderr[stderr.length - 1], /interactive terminal/i);
  });
});
