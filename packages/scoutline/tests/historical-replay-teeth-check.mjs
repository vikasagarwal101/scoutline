// TEETH PROOF for tests/historical-replay-synthetic.test.mjs — not a test,
// not part of any selector. Demonstrates the synthetic guards FAIL against
// a simulated pre-fix mechanism: the engine is evaluated from an in-memory
// mutated copy (no source or dist file is touched) with the
// trusted-history prerequisite-reconciliation branch disabled, reproducing
// the retained-accept-loss shape recorded in the evaluation04/05 audits.
// The frozen-dist hash is pinned first so the proof cannot silently run
// against an unexpected engine.
// Run: node --experimental-vm-modules tests/historical-replay-teeth-check.mjs
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const enginePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../dist/lib/lean-investigation.js",
);
const source = await readFile(enginePath, "utf8");
assert.equal(
  (await import("node:crypto"))
    .createHash("sha256")
    .update(source)
    .digest("hex"),
  "f396d8604af4966ae8a62c0930723373f5c5e7c324bda0fb8fa5823290f96210",
  "teeth proof must run against the exact frozen dist identity",
);

// Simulated pre-fix mechanism: the reconciliation branch that re- authorizes
// dependent work from a trusted history accept judged on the exact current
// context is the fix under test. Disabling it reproduces the audit-recorded
// loss (later unknown candidate clears the active accept; history can no
// longer unblock dependants).
const PRE_FIX = source.replace(
  /return d\.trustedAccepts\.some\(\(t\) => liveIdentityOf\(t\)\);/,
  "return false;",
);
assert.notEqual(PRE_FIX, source, "mutation must have applied");

const { SourceTextModule } = await import("node:vm");
const context = vm.createContext({
  console,
  URL,
  process,
  TextEncoder,
  TextDecoder,
  structuredClone,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  AbortController,
  performance,
  Buffer,
  __req: (s) => require(s),
});

async function builtinModule(spec) {
  const ns = require(spec);
  const src =
    `const ns = __req(${JSON.stringify(spec)});\n` +
    Object.keys(ns)
      .map((n) => `export const ${n} = ns[${JSON.stringify(n)}];`)
      .join("\n");
  const m = new SourceTextModule(src, {
    identifier: `${spec}#bridge`,
    context,
  });
  await m.link(() => {
    throw new Error("bridge modules import nothing");
  });
  await m.evaluate();
  return m;
}

async function load(spec, referencingIdentifier) {
  if (spec.startsWith("node:")) return builtinModule(spec);
  const resolved = new URL(
    spec,
    `file://${dirname(referencingIdentifier)}/`,
  ).href;
  const m = new SourceTextModule(await readFile(new URL(resolved).pathname, "utf8"), {
    identifier: new URL(resolved).pathname,
    context,
  });
  await m.link((s2, r2) => load(s2, r2.identifier));
  await m.evaluate();
  return m;
}

const mod = new SourceTextModule(PRE_FIX, { identifier: enginePath, context });
await mod.link((spec, ref) => load(spec, ref.identifier));
await mod.evaluate();
const { runLeanInvestigation } = mod.namespace;

const { inputs } = await import("./unified-review-corpus.mjs");
const { offlineDeps } = await import("./unified-review-offline-deps.mjs");

let fired = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  TEETH-GAP (guard did NOT fire on pre-fix copy): ${name}`);
  } catch {
    fired++;
    console.log(`  teeth confirmed: ${name}`);
  }
}

// Guard: final-context retention despite later unknown candidate.
await check("retention: unknown candidate must not lose trusted final-context license", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "birch-progressive"));
  const { deps } = offlineDeps(c);
  const judge = deps.candidateJudge;
  deps.candidateJudge = async (input) => {
    const r = await judge(input);
    if (
      input.source.evidenceId === "e2" &&
      input.opposingContext.length >= 1 &&
      input.candidates.some((x) => x.fieldId === "license")
    ) {
      const i = input.candidates.findIndex((x) => x.fieldId === "license");
      r.answers[`q${i}s`] = { type: "noul", noul: 0.5 };
    }
    return r;
  };
  const result = await runLeanInvestigation(c.contract, deps);
  assert(["e2", "e3"].includes(result.requirements.license?.provenance?.sourceId));
  assert.equal(result.data.license, "Apache-2.0");
});

// Guard: dependent work stays bound to the reconciled prerequisite accept.
await check("reconciliation: dependent license resolves against reconciled prerequisite", async () => {
  const c = structuredClone(inputs.find((x) => x.id === "birch-progressive"));
  const { deps } = offlineDeps(c);
  const result = await runLeanInvestigation(c.contract, deps);
  assert.equal(result.data.license, "Apache-2.0");
  assert.equal(result.requirements.license.status, "satisfied");
});

console.log(
  fired === 2
    ? "TEETH OK: both guards fire on the pre-fix copy (assertions fail) and pass on the real engine"
    : `TEETH INCOMPLETE: only ${fired}/2 guards discriminated — report the gap, do not claim coverage`,
);
process.exitCode = fired === 2 ? 0 : 1;
