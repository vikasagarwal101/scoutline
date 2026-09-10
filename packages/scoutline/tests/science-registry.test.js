/**
 * Science verticals — registry + provider seats (TASKS T2; DESIGN D2/D5;
 * PRD AC-5, AC-9b).
 *
 * GROUND map (per describe below):
 *   - T2 bullet "PROVIDER_IDS += 5 ... registry imports; descriptors
 *     with science capabilities. PROVIDER_IDS insertion order stays the
 *     D2 listing" (DESIGN D2 supplier list).
 *   - T2 bullet "Widen the ProviderCapability union ONLY ...
 *     PROVIDER_CAPABILITIES const stays unchanged".
 *   - T2 bullet "Tests: descriptor capability sets; isConfigured
 *     capability-aware keyless set" (DESIGN D2 isConfigured ruling;
 *     PRD AC-5 round-5 scope pin).
 *   - T2 bullet "Quota authority rows (round 5)" (DESIGN D5 pre-merge
 *     dependency: exclusion from quota-snapshot ranking).
 *   - T2 bullet "Literal provider-list surfaces" — RESEARCH_HELP carries
 *     a hand-written 12-id pipe list (PRD AC-9b: 12→17).
 *   - DESIGN D1: `science.cite` stays OUT of union/const/descriptor
 *     capability sets in v1.
 *
 * Tests import ../dist/... — verification order is build, then test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_IDS,
  PROVIDER_CAPABILITIES,
  getProviderDescriptor,
} from "../dist/providers/types.js";
import { BUILT_IN_PROVIDER_DESCRIPTORS } from "../dist/providers/registry.js";
import {
  CAPABILITY_MAPPINGS,
  PROVIDER_AUTHORITY_POLICIES,
  getCapabilityMapping,
  getProviderAuthorityPolicy,
} from "../dist/lib/quota-mapping.js";
import { RESEARCH_HELP } from "../dist/commands/research.js";

// The D2 insertion order — science ids append after spider, in the
// DESIGN D2 supplier listing order (arxiv, openalex, crossref, pubmed,
// europepmc). Literal on purpose: an implementation-side reordering
// (e.g. openalex-first fan-out order leaking into the registry) fails
// this pin (T2: "PROVIDER_IDS insertion order stays the D2 listing;
// openalex-first is the science fan-out arm order (D5), implemented in
// the executor").
const TWELVE = [
  "zai",
  "minimax",
  "tavily",
  "exa",
  "brave",
  "firecrawl",
  "parallel",
  "perplexity",
  "jina",
  "you",
  "linkup",
  "spider",
];
const SCIENCE_IDS = ["arxiv", "openalex", "crossref", "pubmed", "europepmc"];
const EXPECTED_17 = [...TWELVE, ...SCIENCE_IDS];

describe("science registry seats — PROVIDER_IDS and BUILT_IN registry (T2 bullet 1; D2)", () => {
  it("PROVIDER_IDS is exactly the 12 existing ids plus the five science ids in D2 order", () => {
    assert.deepEqual(PROVIDER_IDS, EXPECTED_17);
  });

  it("BUILT_IN_PROVIDER_DESCRIPTORS lists all 17 ids in the same order", () => {
    assert.deepEqual(
      BUILT_IN_PROVIDER_DESCRIPTORS.map((d) => d.id),
      EXPECTED_17,
    );
  });

  it("every science id is resolvable through getProviderDescriptor", () => {
    for (const id of SCIENCE_IDS) {
      const d = getProviderDescriptor(id);
      assert.equal(d.id, id);
    }
  });
});

describe("science descriptors — capability sets (T2 tests bullet; D1 cite-out)", () => {
  it("each science descriptor advertises science.search, science.get, and diagnostics — nothing else of the shared set", () => {
    for (const id of SCIENCE_IDS) {
      const caps = getProviderDescriptor(id).capabilities();
      // GROUND: T2 "descriptors with science capabilities"; D2
      // round-3 (doctor probes every always-configured supplier →
      // diagnostics advertised).
      assert.ok(caps.has("science.search"), `${id} must advertise science.search`);
      assert.ok(caps.has("science.get"), `${id} must advertise science.get`);
      assert.ok(caps.has("diagnostics"), `${id} must advertise diagnostics`);
      // GROUND: D2 "quota stays unadvertised for science suppliers" —
      // PRD AC-5: no quota rows in v1.
      assert.ok(!caps.has("quota"), `${id} must NOT advertise quota`);
      // Science suppliers are not general-web providers (PRD G5).
      for (const shared of ["search", "reader", "crawl", "map", "research"]) {
        assert.ok(!caps.has(shared), `${id} must not advertise ${shared}`);
      }
      // GROUND: D1 — `science.cite` is typed in the capability file
      // but stays OUT of advertised capabilities in v1.
      assert.ok(!caps.has("science.cite"), `${id} must not advertise science.cite`);
    }
  });

  it("capability set is EXACTLY science.search, science.get, diagnostics — exact-set pin subsumes the sampled negatives", () => {
    // Missing-pin fix: the sampled negative loop above only checks 8 of
    // the 15 non-advertised capabilities; a mutation adding any unchecked
    // member (e.g. vision.video) to SCIENCE_SEAT_CAPABILITIES shipped
    // green. The exact set cannot miss a member. Ticket ground says
    // "FALSE for quota and every non-science capability".
    for (const id of SCIENCE_IDS) {
      const caps = getProviderDescriptor(id).capabilities();
      assert.deepEqual(
        [...caps].sort(),
        ["diagnostics", "science.get", "science.search"],
        `${id} capability set must be exactly the science trio + diagnostics`,
      );
    }
  });

  it("credentialEnvVars: keyless trio empty, openalex/pubmed carry their env keys (T2 bullet; D2)", () => {
    const expected = {
      arxiv: [],
      crossref: [],
      europepmc: [],
      openalex: ["OPENALEX_API_KEY"],
      pubmed: ["NCBI_API_KEY"],
    };
    for (const [id, vars] of Object.entries(expected)) {
      assert.deepEqual(
        getProviderDescriptor(id).credentialEnvVars,
        vars,
        `${id} credentialEnvVars must be ${JSON.stringify(vars)}`,
      );
    }
  });
});

describe("science descriptors — capability-aware keyless isConfigured (T2 tests bullet; D2; PRD AC-5 round-5 scope pin)", () => {
  it("keyless-true for capabilityId undefined, science.search, science.get, diagnostics", () => {
    for (const id of SCIENCE_IDS) {
      const d = getProviderDescriptor(id);
      assert.equal(d.isConfigured({}), true, `${id} isConfigured(env) with no key must be true`);
      assert.equal(
        d.isConfigured({}, "science.search"),
        true,
        `${id} isConfigured(env, "science.search") keyless must be true`,
      );
      assert.equal(
        d.isConfigured({}, "science.get"),
        true,
        `${id} isConfigured(env, "science.get") keyless must be true`,
      );
      assert.equal(
        d.isConfigured({}, "diagnostics"),
        true,
        `${id} isConfigured(env, "diagnostics") keyless must be true`,
      );
    }
  });

  it("configured with a key: openalex/pubmed accept their env var (keyed upgrade stays available)", () => {
    const openalex = getProviderDescriptor("openalex");
    assert.equal(openalex.isConfigured({ OPENALEX_API_KEY: "k" }), true);
    const pubmed = getProviderDescriptor("pubmed");
    assert.equal(pubmed.isConfigured({ NCBI_API_KEY: "k" }), true);
  });

  it("FALSE for quota and every non-science capability — quota dashboard filter must not list science suppliers (D2/AC-5; quota.ts:320 seam)", () => {
    const nonScience = [
      "quota",
      "search",
      "reader",
      "crawl",
      "map",
      "research",
      "repository-exploration",
      "vision.interpret-image",
    ];
    for (const id of SCIENCE_IDS) {
      const d = getProviderDescriptor(id);
      for (const cap of nonScience) {
        assert.equal(
          d.isConfigured({}, cap),
          false,
          `${id} isConfigured(env, "${cap}") must be false`,
        );
      }
    }
  });
});

describe("ProviderCapability surface — union widened, const unchanged (T2 union bullet; D1 cite-out)", () => {
  it("PROVIDER_CAPABILITIES const stays exactly the pre-science 16 literals (union-only widening)", () => {
    // GROUND: T2 "PROVIDER_CAPABILITIES const stays unchanged — the
    // satisfies check needs const ⊆ union, not equality". A runtime
    // member added here would make routing accept science.* (the
    // dead-letter pin lives in config-store tests).
    assert.deepEqual(PROVIDER_CAPABILITIES, [
      "search",
      "vision.interpret-image",
      "vision.ui-artifact",
      "vision.extract-text",
      "vision.diagnose-error",
      "vision.diagram",
      "vision.chart",
      "vision.diff",
      "vision.video",
      "quota",
      "diagnostics",
      "repository-exploration",
      "reader",
      "crawl",
      "map",
      "research",
    ]);
  });
});

describe("quota authority — five always-unknown rows (T2 round-5 bullet; D5 pre-merge exclusion; AC-5)", () => {
  it("every science supplier has an always-unknown policy with a keyless/no-spend reason", () => {
    for (const id of SCIENCE_IDS) {
      const policy = getProviderAuthorityPolicy(id);
      assert.ok(policy, `${id} must have a PROVIDER_AUTHORITY_POLICIES row`);
      assert.equal(policy.kind, "always-unknown", `${id} policy kind must be always-unknown`);
      assert.match(policy.reason, /keyless/i, `${id} reason must name the keyless model`);
      assert.match(policy.reason, /spend|signal/i, `${id} reason must name the no-signal class`);
    }
  });

  it("no CAPABILITY_MAPPINGS rows for science suppliers (always-unknown ⇒ no mapping rows)", () => {
    assert.equal(CAPABILITY_MAPPINGS.filter((m) => SCIENCE_IDS.includes(m.provider)).length, 0);
    assert.equal(getCapabilityMapping("openalex", "science.search"), undefined);
    assert.equal(getCapabilityMapping("pubmed", "science.get"), undefined);
  });
});

describe("RESEARCH_HELP provider enumeration widens 12→17 (T2 literal-surfaces bullet; PRD AC-9b)", () => {
  it("RESEARCH_HELP carries the full 17-id pipe list (hand-written list in research.ts must not stay at 12)", () => {
    const expected =
      "(zai | minimax | tavily | exa | brave | firecrawl | parallel | perplexity | jina | you | linkup | spider | arxiv | openalex | crossref | pubmed | europepmc)";
    assert.ok(
      RESEARCH_HELP.includes(expected),
      `RESEARCH_HELP --provider list must be the 17-id pipe list: ${expected}`,
    );
  });
});
