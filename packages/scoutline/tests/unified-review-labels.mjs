// Independently authored developer labels. NEVER import in an engine/model runner.
export const labelRevision = "sol-unified-developer-v1";
export const labels = [
  ["aster-clean", "2.4", "MIT", "supported"],
  ["aster-wrong-release", "3.0", null, "supported"],
  ["birch-progressive", "5.1", "Apache-2.0", "supported"],
  ["birch-unknown-prerequisite", null, null, "supported"],
  ["cedar-challenge-retained", "1.7", "BSD-3-Clause", "supported"],
  ["cedar-challenge-failed", null, null, null],
  ["dune-late-adverse", "2.0", null, "disputed"],
  ["dune-late-irrelevant", "2.0", "MIT", "supported"],
  ["ember-refuted", "8.2", "ISC", "refuted"],
  ["ember-unknown-support", "8.2", "ISC", "supported"],
  ["fjord-unicode", "β-2.0", "許可-É", "supported"],
  ["fjord-injection", "6.0", "Apache-2.0", "refuted"],
  ["grove-reverse-dependencies", "9.3", "MIT", "supported"],
  ["grove-transitive-chain", "9.4", "Apache-2.0", "supported"],
  ["harbor-dispute", "4.0", "BSD-2-Clause", "disputed"],
  ["harbor-scalar-conflict", "4.0", "BSD-2-Clause", null],
].map(([id, version, license, csv]) => ({ id, fields: { version, license, csv } }));
export const rationale = {
  "aster-wrong-release": "The source gives only a historical license; never borrow it for 3.0.",
  "birch-unknown-prerequisite":
    "Missing version blocks its dependent license; CSV is independently documented.",
  "cedar-challenge-failed":
    "Required contrary evidence was not read, retained and assessed; provisional support cannot finalize.",
  "dune-late-adverse":
    "Same-release license conflict remains unresolved; documented CSV opposition permits scoped dispute. Neither source supersedes the other.",
  "dune-late-irrelevant": "The old-release limitations cannot refute current scoped values.",
  "ember-unknown-support":
    "Uncertain independent support with clearly absent refutation does not erase existing positive support.",
  "fjord-injection":
    "Script instructions are not release evidence; article and independent verification agree.",
  "harbor-scalar-conflict":
    "Both sides are evidenced; a scalar-only enum cannot be satisfied by choosing a side.",
};
export const denominators = Object.freeze({
  cases: 16,
  sourceFamilies: 8,
  requestedFields: 48,
  eligibleFields: 40,
  goldAbstentions: 8,
  reservedCases: 4,
  firstLiveCases: 8,
});
// Label-owned attribution: wrong-release exclusion text is not support.
export const exclusions = {
  "birch-progressive": ["birch-junk"],
  "dune-late-irrelevant": ["dune-other"],
};
export const abstentionEvidence = {
  "aster-wrong-release": [
    {
      field: "license",
      sourceId: "aster-mixed",
      quote: "No license for release 3.0 is documented.",
    },
  ],
  "birch-unknown-prerequisite": [
    {
      field: "version",
      sourceId: "birch-unspecified",
      quote: "No current release identifier is given.",
    },
    { field: "license", sourceId: "birch-unspecified", quote: "Historical license: MIT." },
  ],
  "cedar-challenge-failed": [
    {
      field: "version,license,csv",
      sourceId: "cedar-failed-review",
      failure: "fixture_read_failed",
      quote: null,
    },
  ],
  "dune-late-adverse": [
    { field: "license", sourceId: "dune-guide", quote: "License for release 2.0: MIT." },
    { field: "license", sourceId: "dune-late", quote: "License for release 2.0: GPL-3.0." },
  ],
  "harbor-scalar-conflict": [
    { field: "csv", sourceId: "harbor-scalar-guide", quote: "Release 4.0 supports CSV export." },
    {
      field: "csv",
      sourceId: "harbor-scalar-limitations",
      quote: "Release 4.0 does not support CSV export.",
    },
  ],
};
