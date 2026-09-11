/**
 * T11 — init wizard: keyed science supplier opt-in (openalex, pubmed).
 *
 * GROUNDS (TASKS T11, REVISED 2026-09-10; PRD AC-9):
 *   - Owner ruling: keyless suppliers are available already (no init step
 *     needed beyond listing); `scoutline init` asks ONE opt-in question
 *     for the KEYED science suppliers (openalex, pubmed): "enable the
 *     keyed providers?" — copy states keyed providers add more surface
 *     area coverage for better results overall (honest version: higher
 *     limits — keyless 3/s -> 10/s pubmed; openalex keyless ~100
 *     searches/day -> ~100k credits/day keyed — plus polite-pool
 *     priority), and keyless operation is already active without any
 *     step. Final copy wording stays owner-flagged: these tests pin the
 *     structural facts (ONE question, mentions "keyed providers" +
 *     keyless-already-active), not full sentences.
 *   - openalex/pubmed rows: keyless-with-upgrade copy; answering the
 *     opt-in "yes" walks the EXISTING ask-key flow for those two only;
 *     "no" leaves keyless active — changes nothing (no key prompts, no
 *     written provider records).
 *   - Ticket test list: wizard renders keyless trio without key prompt
 *     (positive case already pinned at tests/init.test.js:1324, T2
 *     minimum keyless branch — the trio-side negative here is that the
 *     opt-in question must NOT fire for trio-only or non-science
 *     selections); opt-in yes walks key flow for exactly openalex+pubmed;
 *     opt-in no changes nothing.
 *   - T11 revision: init.ts coexists with agent-registration prompts
 *     (PR #116) — prompt order stable; the coexistence pin asserts the
 *     agent-registration confirm PRECEDES the checklist and the keyed
 *     opt-in PRECEDES the fallback/journal confirms, with agentRules
 *     surviving the wizard's final write.
 *
 * Hermetic: scripted prompt doubles + fake descriptors + real config-store
 * pinned to a temp filePath; agent-registration roots injected as temp
 * dirs. No TTY, no real HOME, no network (fake adapters).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

import { handleInitWithHelp, createDefaultConfigStore } from "../dist/commands/init.js";
import { AuthError } from "../dist/lib/errors.js";
import { withTempDir } from "./helpers/temp-dir.js";
import { useTempConfigDir } from "./helpers/config-dir-pin.js";

useTempConfigDir();

// ---------------------------------------------------------------------------
// Test doubles (same shape as tests/init.test.js — that file's helpers are
// module-local, so the minimal harness is duplicated here).
// ---------------------------------------------------------------------------

function makeFakeDescriptor({ id, credentialEnvVars = [], behaviour = "resolve" }) {
  const canonicalEnvVar = credentialEnvVars[0];
  const invokes = [];
  const descriptor = {
    id,
    credentialEnvVars,
    isConfigured: (env) => {
      const v = env[canonicalEnvVar];
      return typeof v === "string" && v.trim().length > 0;
    },
    capabilities: () => new Set(["science.search", "diagnostics"]),
    create: ({ env }) => {
      return {
        id,
        diagnostics: {
          async invoke({ probe }) {
            invokes.push({ probe, env });
            if (behaviour === "resolve") return undefined;
            if (behaviour === "auth") throw new AuthError("invalid key", canonicalEnvVar);
            throw new Error("unknown behaviour: " + behaviour);
          },
        },
      };
    },
  };
  return { descriptor, invokes };
}

/** The five science suppliers as hermetic fakes. */
function makeScienceDescriptors() {
  return {
    arxiv: makeFakeDescriptor({ id: "arxiv" }),
    openalex: makeFakeDescriptor({ id: "openalex", credentialEnvVars: ["OPENALEX_API_KEY"] }),
    crossref: makeFakeDescriptor({ id: "crossref" }),
    pubmed: makeFakeDescriptor({ id: "pubmed", credentialEnvVars: ["NCBI_API_KEY"] }),
    europepmc: makeFakeDescriptor({ id: "europepmc" }),
  };
}

function createScriptedPrompts() {
  const queue = { checkbox: [], select: [], confirm: [], password: [], input: [] };
  const calls = { checkbox: [], select: [], confirm: [], password: [], input: [] };
  const prompts = {};
  for (const kind of Object.keys(queue)) {
    prompts[kind] = async (message, ...rest) => {
      calls[kind].push({ message, rest });
      if (queue[kind].length === 0) {
        throw new Error(`scripted ${kind} queue exhausted: ${message}`);
      }
      const { answer, cancel } = queue[kind].shift();
      if (cancel) throw new Error("cancel");
      return answer;
    };
  }
  return {
    prompts,
    calls,
    queueCheckbox: (answer) => queue.checkbox.push({ answer }),
    queueConfirm: (answer) => queue.confirm.push({ answer }),
    queuePassword: (answer) => queue.password.push({ answer }),
  };
}

/** Wrap scripted prompts with a unified cross-kind call log (order pins). */
function recordInto(log, prompts) {
  const wrapped = {};
  for (const kind of ["checkbox", "select", "confirm", "password", "input"]) {
    wrapped[kind] = async (message, ...rest) => {
      log.push({ kind, message });
      return prompts[kind](message, ...rest);
    };
  }
  return wrapped;
}

function createInitDeps({ descriptors, prompts, configFilePath, agentRegistrationRoots }) {
  const stderrChunks = [];
  const stdoutChunks = [];
  const deps = {
    descriptors,
    prompts,
    configStore: createDefaultConfigStore({ filePath: configFilePath }),
    env: {},
    now: () => 1_700_000_000_000,
    stdinIsTTY: true,
    writeStderr: (v) => stderrChunks.push(v),
    writeStdout: (v) => stdoutChunks.push(v),
    ...(agentRegistrationRoots !== undefined ? { agentRegistrationRoots } : {}),
  };
  return { deps, stderrChunks, stdoutChunks };
}

const OPTIN_RE = /keyed providers/i;

async function readWrittenConfig(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

// ---------------------------------------------------------------------------
// Opt-in question: fires exactly once, only for keyed science selections
// ---------------------------------------------------------------------------

describe("init wizard: keyed science opt-in question (T11)", () => {
  it("selecting openalex+pubmed asks ONE opt-in question whose copy notes keyless is already active", async (t) => {
    // GROUND: T11 owner ruling — init asks ONE opt-in question for the
    // keyed science suppliers; copy states keyless operation is already
    // active without any step. Structural pins only (final copy wording
    // is owner-flagged): exactly one confirm mentioning "keyed
    // providers", and that message also mentions keyless.
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const science = makeScienceDescriptors();
      const script = createScriptedPrompts();
      script.queueCheckbox(["openalex", "pubmed"]);
      script.queueConfirm(false); // opt-in: no
      script.queueConfirm(true); // fallback
      script.queueConfirm(true); // journal
      const { deps } = createInitDeps({
        descriptors: [science.openalex.descriptor, science.pubmed.descriptor],
        prompts: script.prompts,
        configFilePath: filePath,
      });

      const status = await handleInitWithHelp([], deps);

      const optinCalls = script.calls.confirm.filter((c) => OPTIN_RE.test(c.message));
      assert.equal(optinCalls.length, 1, "exactly ONE keyed opt-in question per run");
      assert.match(
        optinCalls[0].message,
        /keyless/i,
        "opt-in copy must state keyless operation is already active",
      );
      assert.equal(status, 0, "wizard completes with the opt-in answered no");
    });
  });

  it("opt-in NO changes nothing: no key prompts, no written records for openalex/pubmed", async (t) => {
    // GROUND: T11 — "'no' leaves keyless active" / ticket test bullet
    // "opt-in no changes nothing": no ask-key confirm, no password
    // prompt, and no providers record written for the keyed science
    // suppliers (keyless needs no config step).
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const science = makeScienceDescriptors();
      const script = createScriptedPrompts();
      script.queueCheckbox(["openalex", "pubmed"]);
      script.queueConfirm(false); // opt-in: no
      script.queueConfirm(true); // fallback
      script.queueConfirm(true); // journal
      const { deps } = createInitDeps({
        descriptors: [science.openalex.descriptor, science.pubmed.descriptor],
        prompts: script.prompts,
        configFilePath: filePath,
      });

      const status = await handleInitWithHelp([], deps);

      assert.equal(
        script.calls.confirm.filter((c) => /API key/i.test(c.message)).length,
        0,
        "opt-in no must not run the ask-key-first question",
      );
      assert.equal(status, 0, "wizard completes with the opt-in answered no");
      assert.equal(script.calls.password.length, 0, "opt-in no must not prompt for a password");

      const written = await readWrittenConfig(filePath);
      assert.equal(written.providers?.openalex, undefined, "no openalex record under opt-in no");
      assert.equal(written.providers?.pubmed, undefined, "no pubmed record under opt-in no");
    });
  });

  it("opt-in YES walks the existing ask-key flow for exactly openalex+pubmed; trio stays keyless-onboarded", async (t) => {
    // GROUND: T11 — "answering the opt-in with 'yes' walks the existing
    // ask-key flow for those two only": password prompts name OpenAlex
    // and PubMed (never arXiv/Crossref/Europe PMC), candidates are
    // probed through the ephemeral env (never persisted before the
    // atomic write), and the keyless trio keeps the T2 minimum keyless
    // branch (probe, no key entry, record without apiKey).
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const science = makeScienceDescriptors();
      const script = createScriptedPrompts();
      const log = [];
      script.queueCheckbox(["arxiv", "openalex", "crossref", "pubmed", "europepmc"]);
      script.queueConfirm(true); // keyed opt-in: yes
      script.queueConfirm(true); // ask-key-first: openalex
      script.queuePassword("oa-key-1");
      script.queueConfirm(true); // ask-key-first: pubmed
      script.queuePassword("ncbi-key-1");
      script.queueConfirm(true); // fallback
      script.queueConfirm(true); // journal
      const { deps } = createInitDeps({
        descriptors: Object.values(science).map((s) => s.descriptor),
        prompts: recordInto(log, script.prompts),
        configFilePath: filePath,
      });

      const status = await handleInitWithHelp([], deps);
      assert.equal(status, 0, "wizard completes the keyed onboarding");

      // ONE opt-in question; it precedes any password prompt.
      const optinIndexes = log
        .map((e, i) => (e.kind === "confirm" && OPTIN_RE.test(e.message) ? i : -1))
        .filter((i) => i >= 0);
      assert.equal(optinIndexes.length, 1, "exactly one keyed opt-in question");
      const firstPassword = log.findIndex((e) => e.kind === "password");
      assert.ok(optinIndexes[0] < firstPassword, "opt-in fires before key entry");

      // Passwords only for the keyed pair.
      const passwordMessages = script.calls.password.map((c) => c.message).join(" | ");
      assert.equal(script.calls.password.length, 2, "exactly two key-entry prompts");
      assert.match(passwordMessages, /OpenAlex/);
      assert.match(passwordMessages, /PubMed/);
      assert.ok(!/arXiv/.test(passwordMessages), "no key prompt for arXiv");
      assert.ok(!/Crossref/.test(passwordMessages), "no key prompt for Crossref");
      assert.ok(!/Europe PMC/.test(passwordMessages), "no key prompt for Europe PMC");

      // The wizard ends on the standard fallback + journal confirms.
      const confirmMessages = script.calls.confirm.map((c) => c.message);
      assert.match(confirmMessages[confirmMessages.length - 2], /Route automatically/);
      assert.match(confirmMessages[confirmMessages.length - 1], /journal/i);

      // Candidates probed through the ephemeral env.
      const oaProbe = science.openalex.invokes.find(
        (inv) => inv.env.OPENALEX_API_KEY === "oa-key-1",
      );
      assert.ok(oaProbe, "openalex probed with the candidate key in the ephemeral env");
      const pmProbe = science.pubmed.invokes.find(
        (inv) => inv.env.NCBI_API_KEY === "ncbi-key-1",
      );
      assert.ok(pmProbe, "pubmed probed with the candidate key in the ephemeral env");

      // Trio: keyless probe once each, no candidate keys anywhere.
      for (const id of ["arxiv", "crossref", "europepmc"]) {
        assert.equal(science[id].invokes.length, 1, `${id}: one keyless probe`);
        assert.ok(
          science[id].invokes.every((inv) => inv.env.OPENALEX_API_KEY === undefined),
          `${id}: probed without any keyed candidate`,
        );
      }

      // Written config: keyed pair carries keys; trio records without.
      const written = await readWrittenConfig(filePath);
      assert.equal(written.providers.openalex.apiKey, "oa-key-1");
      assert.equal(written.providers.openalex.verification?.status, "verified");
      assert.equal(written.providers.pubmed.apiKey, "ncbi-key-1");
      assert.equal(written.providers.pubmed.verification?.status, "verified");
      for (const id of ["arxiv", "crossref", "europepmc"]) {
        assert.ok(written.providers[id], `${id} keyless record written`);
        assert.equal(written.providers[id].apiKey, undefined, `${id} recorded without a key`);
      }
    });
  });

  it("no keyed science supplier selected: no opt-in question (trio-only and non-science runs)", async (t) => {
    // GROUND: T11 — the ONE opt-in question exists for the keyed science
    // pair only. Trio-only selections (available already, T2 branch) and
    // non-science providers must never see it. Negative placement guard
    // against the question over-firing.
    await withTempDir(t, async (dir) => {
      // Trio-only run.
      const trioPath = path.join(dir, "trio-config.json");
      const science = makeScienceDescriptors();
      const trioScript = createScriptedPrompts();
      trioScript.queueCheckbox(["arxiv", "crossref", "europepmc"]);
      trioScript.queueConfirm(true); // fallback
      trioScript.queueConfirm(true); // journal
      const trioDeps = createInitDeps({
        descriptors: [science.arxiv.descriptor, science.crossref.descriptor, science.europepmc.descriptor],
        prompts: trioScript.prompts,
        configFilePath: trioPath,
      });
      assert.equal(await handleInitWithHelp([], trioDeps.deps), 0);
      assert.equal(
        trioScript.calls.confirm.filter((c) => OPTIN_RE.test(c.message)).length,
        0,
        "trio-only selection asks no keyed opt-in",
      );
      assert.equal(trioScript.calls.password.length, 0, "trio-only selection prompts for no keys");

      // Non-science keyed provider run (existing flow, untouched).
      const zaiPath = path.join(dir, "zai-config.json");
      const zai = makeFakeDescriptor({ id: "zai", credentialEnvVars: ["Z_AI_API_KEY"] });
      const zaiScript = createScriptedPrompts();
      zaiScript.queueCheckbox(["zai"]);
      zaiScript.queueConfirm(true); // ask-key-first
      zaiScript.queuePassword("z-key-1");
      zaiScript.queueConfirm(true); // fallback
      zaiScript.queueConfirm(true); // journal
      const zaiDeps = createInitDeps({
        descriptors: [zai.descriptor],
        prompts: zaiScript.prompts,
        configFilePath: zaiPath,
      });
      assert.equal(await handleInitWithHelp([], zaiDeps.deps), 0);
      assert.equal(
        zaiScript.calls.confirm.filter((c) => OPTIN_RE.test(c.message)).length,
        0,
        "non-science provider asks no keyed opt-in",
      );
      const zaiWritten = await readWrittenConfig(zaiPath);
      assert.equal(zaiWritten.providers.zai.apiKey, "z-key-1");
    });
  });
});

// ---------------------------------------------------------------------------
// Coexistence with the agent-registration step (T11 revision: init.ts is
// hotter than plan-time — PR #116 added the registration prompt in the
// same file; prompt order stable).
// ---------------------------------------------------------------------------

describe("init wizard: keyed opt-in coexists with agent-registration prompts (T11)", () => {
  it("agent confirm precedes the checklist; keyed opt-in precedes fallback/journal; agentRules survive the final write", async (t) => {
    // GROUND: T11 revision — the wizard step must coexist with the
    // agent-registration prompt (PR #116) with a stable prompt order.
    // Sequence pin: agent-registration confirm -> provider checklist ->
    // keyed opt-in -> fallback -> journal, and the wizard's final atomic
    // write preserves the agent step's persisted agentRules.
    await withTempDir(t, async (dir) => {
      const filePath = path.join(dir, "config.json");
      const home = path.join(dir, "home");
      const configRoot = path.join(dir, "scoutline-root");
      // Detectable agent tool home (registry detects ~/.claude).
      await fs.mkdir(path.join(home, ".claude"), { recursive: true });

      const science = makeScienceDescriptors();
      const script = createScriptedPrompts();
      const log = [];
      script.queueConfirm(true); // agent registration: yes
      script.queueCheckbox(["openalex"]);
      script.queueConfirm(false); // keyed opt-in: no
      script.queueConfirm(true); // fallback
      script.queueConfirm(true); // journal
      const { deps } = createInitDeps({
        descriptors: [science.openalex.descriptor],
        prompts: recordInto(log, script.prompts),
        configFilePath: filePath,
        agentRegistrationRoots: { home, configRoot },
      });

      const status = await handleInitWithHelp([], deps);
      assert.equal(status, 0);

      assert.equal(log.length, 5, "exactly five prompts in the flow");
      assert.match(log[0].message, /Register scoutline with claude/i, "agent confirm first");
      assert.equal(log[1].kind, "checkbox", "checklist second");
      assert.ok(
        log[2].kind === "confirm" && OPTIN_RE.test(log[2].message),
        "keyed opt-in third",
      );
      assert.match(log[3].message, /Route automatically/, "fallback fourth");
      assert.match(log[4].message, /journal/i, "journal last");

      const written = await readWrittenConfig(filePath);
      assert.equal(written.agentRules?.claude, true, "agentRules survive the wizard's final write");
      assert.equal(written.providers?.openalex, undefined, "opt-in no writes no openalex record");
    });
  });
});
