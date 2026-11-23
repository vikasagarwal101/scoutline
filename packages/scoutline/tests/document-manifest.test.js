import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// v3 structured document extraction first slice — offline RED/GREEN
// checks against the COMPILED lane modules and the shared lean engine.
// All fixtures are synthetic public manifest texts; no network. Named
// .test.js so scripts/run-tests.mjs offline mode discovers it.
const root = new URL("..", import.meta.url).pathname;
const dm = await import(`${root}/dist/lib/document-manifest.js`);
const mi = await import(`${root}/dist/lib/manifest-investigate.js`);
const pure = await import(`${root}/dist/lib/lean-candidates.js`);

const sha256 = (x) => createHash("sha256").update(x, "utf8").digest("hex");
const EXACT = "Version: 2.4.0\nLicense: MIT\n";
const CRLF = "Version: 2.4.0\r\nLicense: MIT\r\n";
const MIXED = "Version: 2.4.0\nLicense: MIT\r\n";
const AMBIGUOUS = "Version: 2.4.0\nVersion: 2.5.0\n";
const DUPLICATE = "Version: 2.4.0\nVersion: 2.4.0\n";
const ASTRAL = "Notes: 🚀\nVersion: 2.4.0\nLicense: MIT\n";
const PROSE = "No structured labels here at all.\n";
const ADMITTED_URL = "https://fixture.invalid/RELEASE-manifest.txt";
const CEILING = 16384;
const SOURCE = (content) => ({
  evidenceId: `manifest-${sha256(content).slice(0, 12)}`,
  url: ADMITTED_URL,
  title: "Release manifest",
  content,
  byteLength: Buffer.byteLength(content, "utf8"),
  origins: [],
});

// Offline judge fixture: supports every proposed candidate with a clean
// conflict answer unless the fixture opts into conflict/unknown.
function offlineJudge({ conflictNoul = 0.01, supportNoul = 0.97 } = {}) {
  const calls = [];
  return {
    calls,
    judge: async (input) => {
      calls.push(structuredClone(input));
      const answers = {};
      input.candidates.forEach((c, i) => {
        answers[`q${i}s`] = { type: "noul", noul: supportNoul };
        answers[`q${i}c`] = { type: "noul", noul: conflictNoul };
      });
      return {
        model: "offline-fixture-judge",
        answers,
        usage: { inputTokens: 10, outputTokens: 5 },
        requestSha256: sha256(JSON.stringify(input)),
        elapsedMs: 1,
      };
    },
  };
}

const request = (text, fields) => ({
  sourceId: SOURCE(text).evidenceId,
  sourceText: text,
  fields: fields.map((id) => ({ id, description: id })),
});

// ---------------------------------------------------------------------------
// Grammar + producer unit behavior
// ---------------------------------------------------------------------------

test("exact manifest lines propose exact original UTF-16 spans", () => {
  const report = dm.parseReleaseManifest(EXACT, ["version", "license"]);
  const version = report.fields.find((f) => f.fieldId === "version");
  const license = report.fields.find((f) => f.fieldId === "license");
  assert.equal(version.status, "proposed");
  assert.equal(version.value, "2.4.0");
  assert.equal(version.quote, "Version: 2.4.0");
  assert.deepEqual(version.charRange, [0, 14]);
  assert.deepEqual(version.valueRange, [9, 14]);
  assert.equal(license.status, "proposed");
  assert.equal(license.value, "MIT");
  assert.deepEqual(license.charRange, [15, 27]);
  assert.deepEqual(license.valueRange, [24, 27]);
  // Spans are exact slices of the ORIGINAL text, not re-serializations.
  assert.equal(EXACT.slice(...version.charRange), version.quote);
  assert.equal(EXACT.slice(...version.valueRange), version.value);
  assert.equal(EXACT.slice(...license.valueRange), license.value);
  // The report binds to one retained representation by digest.
  assert.equal(report.sourceDigest, sha256(EXACT));
});

test("CRLF and mixed line endings keep original offsets (span excludes CR)", () => {
  for (const [text, licRange, mitRange] of [
    [CRLF, [16, 28], [25, 28]],
    [MIXED, [15, 27], [24, 27]],
  ]) {
    const report = dm.parseReleaseManifest(text, ["version", "license"]);
    const version = report.fields.find((f) => f.fieldId === "version");
    const license = report.fields.find((f) => f.fieldId === "license");
    assert.equal(version.status, "proposed");
    assert.deepEqual(version.charRange, [0, 14]);
    assert.equal(license.status, "proposed");
    assert.deepEqual(license.charRange, licRange);
    assert.deepEqual(license.valueRange, mitRange);
    // Round-trips on the ORIGINAL mixed-ending text, byte for byte.
    assert.equal(text.slice(...version.charRange), version.quote);
    assert.equal(text.slice(...license.charRange), license.quote);
    assert.equal(text.slice(...license.valueRange), license.value);
  }
});

test("astral characters count as their two UTF-16 units in offsets", () => {
  // "Notes: 🚀\n" is 10 UTF-16 units (emoji = 2), so Version starts at 10.
  const report = dm.parseReleaseManifest(ASTRAL, ["version", "license"]);
  const version = report.fields.find((f) => f.fieldId === "version");
  const license = report.fields.find((f) => f.fieldId === "license");
  assert.equal(version.status, "proposed");
  assert.deepEqual(version.charRange, [10, 24]);
  assert.deepEqual(version.valueRange, [19, 24]);
  assert.deepEqual(license.charRange, [25, 37]);
  assert.deepEqual(license.valueRange, [34, 37]);
  assert.equal(ASTRAL.slice(...version.charRange), version.quote);
  assert.equal(ASTRAL.slice(...license.valueRange), license.value);
});

test("conflicting AND identical duplicate labels abstain; first label never picked", () => {
  for (const text of [AMBIGUOUS, DUPLICATE]) {
    const report = dm.parseReleaseManifest(text, ["version", "license"]);
    assert.equal(report.fields.find((f) => f.fieldId === "version").status, "ambiguous");
    assert.equal(report.fields.find((f) => f.fieldId === "license").status, "missing");
  }
});

test("a malformed-value duplicate still claims the label: ambiguity, not first-valid-wins", () => {
  // `Version: 2.0.0 (rc)` is not a grammar token, but the line CLAIMS the
  // Version label — two claims means abstain, never propose 2.4.0.
  const report = dm.parseReleaseManifest("Version: 2.4.0\nVersion: 2.0.0 (rc)\n", ["version"]);
  assert.equal(report.fields[0].status, "ambiguous");
  // A single claim with a non-token value is still missing, not guessed.
  const single = dm.parseReleaseManifest("Version: 2.0.0 (rc)\n", ["version"]);
  assert.equal(single.fields[0].status, "missing");
});

test("non-string manifest text fails as ValidationError, never a native TypeError", () => {
  for (const bad of [42, undefined, null, { length: 5 }]) {
    assert.throws(
      () => dm.admitManifestText(bad),
      (error) =>
        /Manifest text must be a string/.test(error.message) && error.code === "VALIDATION_ERROR",
    );
    assert.throws(() => dm.parseReleaseManifest(bad, ["version"]), /must be a string/);
  }
});

test("registered producer descriptor is a frozen singleton", () => {
  const producer = dm.resolveDocumentProducer("release-manifest@1");
  assert.throws(() => {
    producer.id = "mutated@9";
  }, TypeError);
  assert.throws(() => {
    producer.revision = "mutated";
  }, TypeError);
  assert.throws(() => {
    producer.supportedFields.push("smuggled");
  }, TypeError);
  // The registry still resolves the same immutable descriptor.
  assert.equal(dm.resolveDocumentProducer("release-manifest@1"), producer);
  assert.equal(producer.id, "release-manifest@1");
});

test("bare carriage return outside a CRLF pair is refused, not silently parsed", () => {
  // A mid-line CR could otherwise hide what would be a duplicate line.
  assert.throws(
    () => dm.parseReleaseManifest("Version: 2.4.0\rVersion: 2.4.0\n", ["version"]),
    /bare carriage return/,
  );
  assert.throws(() => dm.admitManifestText("Version: 2.4.0\r"), /bare carriage return/);
  assert.throws(() => dm.admitManifestText("a\r\r\n"), /bare carriage return/);
  // CR immediately before LF stays legal (CRLF), including mixed runs.
  assert.doesNotThrow(() => dm.admitManifestText(MIXED));
});

test("producer attempt encodes abstention as the validator's null spelling", async () => {
  const extractor = dm.resolveDocumentProducer("release-manifest@1").create(["version", "license"]);
  const attempt = await extractor.extract(request(AMBIGUOUS, ["version", "license"]));
  assert.equal(attempt.finishReason, "stop");
  assert.equal(attempt.usage, null);
  const parsed = JSON.parse(attempt.rawOutput);
  assert.deepEqual(parsed.version, { value: null, quote: null });
  assert.deepEqual(parsed.license, { value: null, quote: null });
});

test("producer is deterministic: identical request, identical attempt", async () => {
  const extractor = dm.resolveDocumentProducer("release-manifest@1").create(["version", "license"]);
  const a = await extractor.extract(request(EXACT, ["version", "license"]));
  const b = await extractor.extract(request(EXACT, ["version", "license"]));
  assert.equal(a.rawOutput, b.rawOutput);
  assert.equal(a.requestSha256, b.requestSha256);
});

test("admission fails closed on unknown producer, unbound field, duplicate binding", () => {
  assert.throws(() => dm.resolveDocumentProducer("ocr-invoices@9"), /Unknown document producer/);
  assert.throws(() => dm.parseReleaseManifest(EXACT, ["invoice_total"]), /not bound/);
  assert.throws(
    () => dm.resolveDocumentProducer("release-manifest@1").create(["version", "version"]),
    /twice/,
  );
  assert.throws(
    () => dm.resolveDocumentProducer("release-manifest@1").create("version"),
    /must be an array/,
  );
});

test("inherited binding names (constructor, __proto__, toString) are never grammar fields", async () => {
  // Membership is Object.hasOwn, not truthiness: these names exist on
  // every plain object's prototype chain and must fail closed at
  // create, parse AND invoke.
  for (const name of ["constructor", "__proto__", "toString"]) {
    assert.throws(() => dm.parseReleaseManifest(EXACT, [name]), /not bound/);
    assert.throws(() => dm.admitManifestFields([name]), /not bound/);
    const extractor = dm.resolveDocumentProducer("release-manifest@1").create(["version", "license"]);
    await assert.rejects(
      () => extractor.extract(request(EXACT, [name])),
      /not bound/,
    );
  }
});

test("producer refuses any request outside its admitted field subset", async () => {
  const extractor = dm.resolveDocumentProducer("release-manifest@1").create(["version"]);
  await assert.rejects(
    () => extractor.extract(request(EXACT, ["version", "license"])),
    /was not admitted/,
  );
  // A subset of the admitted set stays servable.
  const attempt = await extractor.extract(request(EXACT, ["version"]));
  const parsed = JSON.parse(attempt.rawOutput);
  assert.equal(parsed.version.value, "2.4.0");
  assert.equal("license" in parsed, false);
});

test("invoke-time validation: duplicate ids and inherited ids are refused", async () => {
  const extractor = dm.resolveDocumentProducer("release-manifest@1").create(["version", "license"]);
  await assert.rejects(
    () => extractor.extract(request(EXACT, ["version", "version"])),
    /twice/,
  );
  // A field OBJECT whose id lives on its prototype (not an own property)
  // is a real inherited request id — refused.
  const inherited = Object.create({ id: "version" });
  inherited.description = "d";
  await assert.rejects(
    () => extractor.extract({ sourceId: "s", sourceText: EXACT, fields: [inherited] }),
    /own string id/,
  );
  await assert.rejects(
    () => extractor.extract({ sourceId: "s", sourceText: EXACT, fields: "version" }),
    /fields must be an array/,
  );
});

test("callable boundary: full in-flight mutation and cooperative abort at investigateReleaseManifest", async () => {
  const judge = offlineJudge();
  const input = FLOW_INPUT(EXACT, judge);
  const controller = new AbortController();
  input.externalSignal = controller.signal;
  const inFlight = mi.investigateReleaseManifest(input);
  // Mutate everything mutable MID-FLIGHT (the engine is running on the
  // admitted snapshot); the outcome must bind to admission time.
  input.manifestText = "Version: 9.9.9\n";
  input.admission.claimedUrl = "https://mutated.invalid/other";
  input.admission.title = "mutated";
  const outcome = await inFlight;
  assert.equal(outcome.parse.sourceDigest, sha256(EXACT));
  assert.equal(outcome.record.content, EXACT);
  assert.equal(outcome.claimedUrl, ADMITTED_URL, "echo is the admitted claim, not the mutation");
  assert.equal(outcome.record.title, "Release manifest");
  assert.ok(judge.calls.length > 0, "the admitted judge dispatch ran");
  assert.equal(outcome.result.requirements.version.status, "satisfied", "closed declared source set closes contrary coverage");

  // Cooperative abort at the callable: already-aborted signal → the
  // entry throws before reading ANY input, malformed included.
  const c2 = new AbortController();
  c2.abort();
  const judge2 = offlineJudge();
  await assert.rejects(
    () => mi.investigateReleaseManifest(FLOW_INPUT("\uD800 malformed", judge2, { externalSignal: c2.signal })),
    /aborted before admission/,
  );
  assert.equal(judge2.calls.length, 0);
});

test("callable boundary: exact multibyte 16,384/16,385 bytes; overflow dispatches nothing", async () => {
  // 28 ASCII label bytes + 8,178 two-byte ü = exactly 16,384.
  const atCeiling = `Version: 2.4.0\nLicense: MIT\n${"ü".repeat(8178)}`;
  assert.equal(Buffer.byteLength(atCeiling, "utf8"), CEILING);
  const okJudge = offlineJudge();
  const ok = await mi.investigateReleaseManifest(FLOW_INPUT(atCeiling, okJudge));
  assert.equal(ok.parse.sourceDigest, sha256(atCeiling));
  assert.equal(ok.parse.fields.find((f) => f.fieldId === "version").value, "2.4.0");
  assert.ok(okJudge.calls.length > 0, "exactly-at-ceiling input dispatches judgment");
  // One byte over: refused at admission, ZERO judge dispatches.
  const over = `${atCeiling}a`;
  assert.equal(Buffer.byteLength(over, "utf8"), CEILING + 1);
  const overJudge = offlineJudge();
  await assert.rejects(
    () => mi.investigateReleaseManifest(FLOW_INPUT(over, overJudge)),
    new RegExp(`${CEILING}-byte`),
  );
  assert.equal(overJudge.calls.length, 0, "overflow must abort before any dispatch");
});

// ---------------------------------------------------------------------------
// Bounds BEFORE hashing/parsing (pre-abort): the 16,384-byte engine
// acquisition ceiling, fast length rejection before any string scan
// ---------------------------------------------------------------------------

test("admission enforces the engine's 16,384-byte acquisition ceiling exactly (callable)", () => {
  // Exactly at the ceiling passes on either encoding width...
  assert.equal(Buffer.byteLength("a".repeat(CEILING), "utf8"), CEILING);
  assert.doesNotThrow(() => dm.admitManifestText("a".repeat(CEILING)));
  assert.equal(Buffer.byteLength("🚀".repeat(4096), "utf8"), CEILING);
  assert.doesNotThrow(() => dm.admitManifestText("🚀".repeat(4096)));
  // ...one unit over fails: fast length rejection (length > ceiling).
  assert.equal(Buffer.byteLength("a".repeat(CEILING + 1), "utf8"), CEILING + 1);
  assert.throws(() => dm.admitManifestText("a".repeat(CEILING + 1)), new RegExp(`${CEILING}-byte`));
  // Multibyte that slips the length gate fails the exact byte count.
  assert.equal(Buffer.byteLength("ü".repeat(8193), "utf8"), 16386);
  assert.throws(() => dm.admitManifestText("ü".repeat(8193)), new RegExp(`${CEILING}-byte`));
  assert.equal(Buffer.byteLength("🚀".repeat(4097), "utf8"), 16388);
  assert.throws(() => dm.admitManifestText("🚀".repeat(4097)), new RegExp(`${CEILING}-byte`));
});

test("bounds abort before parsing: over-ceiling AND ambiguous input yields the bounds error", () => {
  const oversized = `Version: 1.0.0\nVersion: 2.0.0\n${"a".repeat(CEILING + 1)}`;
  assert.throws(() => dm.parseReleaseManifest(oversized, ["version"]), new RegExp(`${CEILING}-byte`));
});

test("scan defects beat the multibyte byte count: utf16/bare-CR precede the byte check", () => {
  // Length under the ceiling, bytes over it, AND a scan defect — the
  // scan error wins, proving the scan runs before the byte count.
  assert.throws(() => dm.admitManifestText(`\uD800${"ü".repeat(9000)}`), /not well-formed UTF-16/);
  assert.throws(() => dm.admitManifestText(`\r${"ü".repeat(9000)}`), /bare carriage return/);
  // A lone surrogate inside otherwise-valid manifest content aborts too.
  assert.throws(
    () => dm.parseReleaseManifest(`Version: 2.4.0\nLicense: MIT\n\uD800`, ["version"]),
    /not well-formed UTF-16/,
  );
});

// ---------------------------------------------------------------------------
// Existing validation/acceptance path over producer output
// (caller-declared opposing context — the legitimate direct proof)
// ---------------------------------------------------------------------------

test("exact values pass validateCandidates and acceptCandidate with exact binding", async () => {
  const source = SOURCE(EXACT);
  const attempt = dm.manifestExtractorAttempt(request(EXACT, ["version", "license"]));
  const validation = pure.validateCandidates(
    source,
    { finishReason: attempt.finishReason, rawOutput: attempt.rawOutput },
    { version: {}, license: {} },
  );
  assert.equal(validation.parsed, true);
  const version = validation.fields.find((f) => f.fieldId === "version");
  assert.equal(version.status, "candidate");
  assert.equal(version.value, "2.4.0");
  assert.deepEqual(version.charRange, [0, 14]);
  assert.equal(validation.sourceDigest, sha256(EXACT));

  const judged = await pure.assessCandidates(
    {
      source,
      fieldMeanings: { version: "Release version stated in the manifest." },
      scope: { entity: "ExampleApp", documentType: "release-manifest" },
      candidates: [
        { fieldId: "version", value: version.value, quote: version.quote, charRange: version.charRange },
      ],
      opposingContext: [],
    },
    { judge: offlineJudge().judge },
  );
  assert.equal(judged.error, undefined);
  const accepted = pure.acceptCandidate(
    version,
    judged.judgements[0],
    source,
    validation.sourceDigest,
    {
      fieldMeanings: { version: "Release version stated in the manifest." },
      scope: { entity: "ExampleApp", documentType: "release-manifest" },
      opposingContext: [],
    },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.provenance.value, "2.4.0");
  assert.deepEqual(accepted.provenance.charRange, [0, 14]);
  assert.equal(accepted.provenance.sourceDigest, sha256(EXACT));
});

test("ambiguous and missing values stay unresolved through the same path", () => {
  const source = SOURCE(AMBIGUOUS);
  const attempt = dm.manifestExtractorAttempt(request(AMBIGUOUS, ["version", "license"]));
  const validation = pure.validateCandidates(
    source,
    { finishReason: attempt.finishReason, rawOutput: attempt.rawOutput },
    { version: {}, license: {} },
  );
  const version = validation.fields.find((f) => f.fieldId === "version");
  const license = validation.fields.find((f) => f.fieldId === "license");
  assert.equal(version.status, "abstained");
  assert.equal(version.reason, "extractor_abstained");
  assert.equal(license.status, "abstained");
  const outcome = pure.acceptCandidate(
    version,
    null,
    source,
    validation.sourceDigest,
    { fieldMeanings: { version: "x" }, scope: {}, opposingContext: [] },
  );
  assert.equal(outcome.status, "unresolved");
  assert.equal(outcome.reason, "abstained");
});

test("stale source binding is rejected by the acceptance gates", () => {
  const sourceA = SOURCE(EXACT);
  const attempt = dm.manifestExtractorAttempt(request(EXACT, ["version"]));
  const validation = pure.validateCandidates(
    sourceA,
    { finishReason: attempt.finishReason, rawOutput: attempt.rawOutput },
    { version: {} },
  );
  const version = validation.fields.find((f) => f.fieldId === "version");
  assert.equal(version.status, "candidate");

  // Retained source changed AFTER candidate creation: same evidenceId,
  // different content. Live revalidation must reject every stale shape.
  const tamperedContent = { ...sourceA, content: "Version: 9.9.9\nLicense: MIT\n" };
  const staleDigest = pure.acceptCandidate(
    version,
    null,
    tamperedContent,
    validation.sourceDigest,
    { fieldMeanings: { version: "x" }, scope: {}, opposingContext: [] },
  );
  assert.equal(staleDigest.status, "unresolved");
  assert.equal(staleDigest.reason, "source_digest_mismatch");

  // Wrong quote range: tampering the locator breaks the payload identity.
  const tamperedRange = { ...version, charRange: [0, 13] };
  const staleRange = pure.acceptCandidate(
    tamperedRange,
    null,
    sourceA,
    validation.sourceDigest,
    { fieldMeanings: { version: "x" }, scope: {}, opposingContext: [] },
  );
  assert.equal(staleRange.status, "unresolved");
  assert.equal(staleRange.reason, "candidate_identity_mismatch");

  // A fabricated range fails validation itself before acceptance exists.
  const fabricated = pure.validateCandidates(
    sourceA,
    {
      finishReason: "stop",
      rawOutput: JSON.stringify({ version: { value: "2.4.0", quote: "Version: 2.4.0", charRange: [3, 99] } }),
    },
    { version: {} },
  );
  assert.equal(fabricated.fields[0].status, "invalid");
  assert.equal(fabricated.fields[0].reason, "locator_invalid");
});

test("judge support unknown blocks acceptance (conservative gates hold)", async () => {
  const source = SOURCE(EXACT);
  const attempt = dm.manifestExtractorAttempt(request(EXACT, ["version"]));
  const validation = pure.validateCandidates(
    source,
    { finishReason: attempt.finishReason, rawOutput: attempt.rawOutput },
    { version: {} },
  );
  const version = validation.fields.find((f) => f.fieldId === "version");
  const judged = await pure.assessCandidates(
    {
      source,
      fieldMeanings: { version: "Release version stated in the manifest." },
      scope: { entity: "ExampleApp" },
      candidates: [
        { fieldId: "version", value: version.value, quote: version.quote, charRange: version.charRange },
      ],
      opposingContext: [],
    },
    { judge: offlineJudge({ supportNoul: 0.5 }).judge },
  );
  const accepted = pure.acceptCandidate(
    version,
    judged.judgements[0],
    source,
    validation.sourceDigest,
    { fieldMeanings: { version: "Release version stated in the manifest." }, scope: { entity: "ExampleApp" }, opposingContext: [] },
  );
  assert.equal(accepted.status, "unresolved");
  assert.equal(accepted.reason, "support_unknown");
});

// ---------------------------------------------------------------------------
// Entry-point admission, consent, cancellation, immutable-source controls
// ---------------------------------------------------------------------------

const FLOW_INPUT = (text, judge, extra = {}) => ({
  manifestText: text,
  admission: { materialClass: "synthetic", claimedUrl: ADMITTED_URL, title: "Release manifest" },
  ...(judge !== null ? { judgeTransmission: mi.createOfflineJudgeSeam(judge.judge) } : {}),
  now: () => 0,
  ...extra,
});

test("missing admission consent aborts before any engine work", async () => {
  const judge = offlineJudge();
  await assert.rejects(
    () => mi.investigateReleaseManifest({ manifestText: EXACT, judgeTransmission: mi.createOfflineJudgeSeam(judge.judge) }),
    /admission is required/,
  );
  assert.equal(judge.calls.length, 0, "no judgment may dispatch without consent");
  assert.throws(
    () =>
      mi.buildManifestDeps({
        manifestText: EXACT,
        admission: { materialClass: "private", claimedUrl: ADMITTED_URL, title: "t" },
      }),
    /materialClass must be/,
  );
});

test("judge seam binds by minted identity: copies, inherits and claims all fail", async () => {
  const admission = { materialClass: "synthetic", claimedUrl: ADMITTED_URL, title: "t" };
  // Minted token — a TRUSTED IN-PROCESS TEST SEAM (minting is not proof
  // of offline execution and not production consent; that authorization
  // stays in shared integration).
  const real = mi.createOfflineJudgeSeam(async () => {});
  // A COPIED lookalike carrying a swapped dispatch: same shape, wrong
  // identity — Object.assign spreads the fields but cannot become the
  // WeakMap key the minted instance is.
  const copied = Object.assign({}, real, { dispatch: async () => "swapped" });
  const inherited = Object.create(real);
  for (const masquerade of [
    "offline-test-seam",
    { capability: "offline-test-seam", dispatch: async () => {} },
    { capability: "production", dispatch: async () => {} },
    { dispatch: async () => {} },
    { ...real },
    copied,
    inherited,
    null,
  ]) {
    assert.throws(
      () => mi.buildManifestDeps({ manifestText: EXACT, admission, judgeTransmission: masquerade }),
      (error) =>
        /no other transmission route is admitted/.test(error.message) && error.code === "VALIDATION_ERROR",
    );
  }
  // The factory itself refuses non-functions; the minted token is frozen.
  assert.throws(() => mi.createOfflineJudgeSeam("not-a-function"), /must be a function/);
  assert.throws(() => {
    real.dispatch = async () => {};
  }, TypeError);
  // The REAL token still admits.
  const { deps } = mi.buildManifestDeps({
    manifestText: EXACT,
    admission,
    judgeTransmission: real,
  });
  assert.equal(typeof deps.candidateJudge, "function");
  // Omitted consent (denied): run completes, nothing dispatches, nothing
  // is accepted — candidates stay unjudged.
  const { result } = await mi.investigateReleaseManifest(FLOW_INPUT(EXACT, null));
  assert.deepEqual(result.data, {});
  assert.equal(result.requirements.version.status, "unresolved");
  const extraction = result.requirements.version.attemptedRecords.find(
    (r) => r.metadata?.kind === "extraction",
  );
  assert.ok(extraction, "extraction still ran and left its audit trail");
  assert.equal(
    result.requirements.version.attemptedRecords.some((r) => r.metadata?.kind === "candidate-judgment"),
    false,
    "no candidate judgment may exist without judge consent",
  );
});

test("pre-abort: an already-aborted signal throws before any input is read", async () => {
  const judge = offlineJudge();
  const controller = new AbortController();
  controller.abort();
  // Malformed material + abort: the abort wins — input was never read.
  await assert.rejects(
    () => mi.investigateReleaseManifest(FLOW_INPUT(`\uD800 bad`, judge, { externalSignal: controller.signal })),
    (error) =>
      /aborted before admission/.test(error.message) &&
      error.exitCode === 130 &&
      error.name === "CancellationError" &&
      error.code === "USER_CANCELLED" &&
      error instanceof Error,
  );
  assert.equal(judge.calls.length, 0);
});

test("cancellation envelope pin: serialized shape today, exit 130, no HTTP status", async () => {
  const { formatErrorOutput } = await import(`${root}/dist/lib/output.js`);
  const { getErrorExitCode } = await import(`${root}/dist/lib/errors.js`);
  const judge = offlineJudge();
  const controller = new AbortController();
  controller.abort();
  let thrown;
  try {
    await mi.investigateReleaseManifest(FLOW_INPUT(EXACT, judge, { externalSignal: controller.signal }));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "pre-aborted run must throw");
  const payload = JSON.parse(formatErrorOutput(thrown, "json"));
  assert.deepEqual(payload, {
    success: false,
    error: "Manifest run aborted before admission.",
    code: "USER_CANCELLED",
  });
  assert.equal("statusCode" in payload, false, "a user abort carries no HTTP status");
  assert.equal(getErrorExitCode(thrown), 130);
});

test("in-flight abort witness: a mid-run abort reaches the live dispatch and stops further work", async () => {
  const controller = new AbortController();
  const seen = [];
  let inputObject;
  // The dispatch itself performs the abort WHILE IN FLIGHT — the run is
  // executing, this dispatch is live, and the signal it received is
  // aborted at that moment (the engine bridges the external signal into
  // every dependency dispatch).
  const judge = async (input, options) => {
    seen.push({ signal: options?.signal, field: input.candidates[0]?.fieldId });
    const alreadyAborted = options?.signal?.aborted === true;
    // Abort the ORIGINAL signal, then REPLACE the caller's property with
    // a fresh non-aborted signal mid-flight: the entry point's post-run
    // check must consult the owned captured signal, not the reread
    // property (owned-signal gap).
    controller.abort();
    inputObject.externalSignal = new AbortController().signal;
    seen[seen.length - 1].abortedInside = options?.signal?.aborted === true;
    const answers = {};
    input.candidates.forEach((c, i) => {
      answers[`q${i}s`] = { type: "noul", noul: 0.97 };
      answers[`q${i}c`] = { type: "noul", noul: 0.01 };
    });
    void alreadyAborted;
    return {
      model: "offline-fixture-judge",
      answers,
      usage: { inputTokens: 10, outputTokens: 5 },
      requestSha256: sha256(JSON.stringify(input)),
      elapsedMs: 1,
    };
  };
  inputObject = FLOW_INPUT(EXACT, { judge }, { externalSignal: controller.signal });
  const outcome = await mi.investigateReleaseManifest(inputObject);
  // Exactly ONE dispatch happened — the abort occurred mid-run, inside
  // that dispatch, and the engine performed no further judge work.
  assert.equal(seen.length, 1, "one live dispatch witnessed the abort");
  assert.equal(seen[0].abortedInside, true, "the dispatch's own signal is aborted in flight");
  assert.equal(controller.signal.aborted, true);
  assert.equal(inputObject.externalSignal.aborted, false, "caller property was replaced mid-flight");
  // TYPED RUN-LEVEL cancelled indication (Qodo r4659857463): consumers
  // settle from the marker alone — no field-row scanning, no error
  // envelope, no success:false claim when the signal wins. The marker
  // survives the property replacement because the OWNED captured signal
  // (the one deps bridged) decided.
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.stopReason, "cancelled");
  const { result } = outcome;
  // Preserve the accepted version and the audit trail. The interrupt
  // prevented the license judgment, so the license stays unpublished.
  assert.deepEqual(result.data, { version: "2.4.0" });
  assert.equal(result.requirements.version.status, "satisfied");
  assert.equal(result.requirements.license.status, "unresolved");
  assert.ok(
    result.requirements.version.attemptedRecords.some((r) => r.metadata?.kind === "extraction"),
    "partial evidence: extraction audit retained after abort",
  );
  assert.ok(
    result.requirements.version.attemptedRecords.some((r) => r.metadata?.kind === "candidate-judgment"),
    "partial evidence: the pre-abort judgment audit is retained",
  );
});

test("second-clean-judge control: both fields accepted, abort in the second dispatch does not relabel the result", async () => {
  // The closed basis permits both completed judgments to be accepted.
  // The abort marker requires an incomplete settlement.
  const controller = new AbortController();
  const dispatches = [];
  const judge = async (input) => {
    dispatches.push(input.candidates[0]?.fieldId);
    if (dispatches.length === 2) controller.abort();
    const answers = {};
    input.candidates.forEach((c, i) => {
      answers[`q${i}s`] = { type: "noul", noul: 0.97 };
      answers[`q${i}c`] = { type: "noul", noul: 0.01 };
    });
    return {
      model: "offline-fixture-judge",
      answers,
      usage: { inputTokens: 10, outputTokens: 5 },
      requestSha256: sha256(JSON.stringify(input)),
      elapsedMs: 1,
    };
  };
  const outcome = await mi.investigateReleaseManifest(
    FLOW_INPUT(EXACT, { judge }, { externalSignal: controller.signal }),
  );
  assert.equal(dispatches.length, 2, "both fields dispatched clean before/into the abort");
  assert.equal(controller.signal.aborted, true);
  assert.equal(outcome.cancelled, false);
  assert.equal("stopReason" in outcome, false);
  assert.equal(outcome.result.status, "complete");
  for (const id of ["version", "license"]) {
    assert.ok(
      outcome.result.requirements[id].attemptedRecords.some((r) => r.metadata?.kind === "candidate-judgment"),
      `${id} judgment audit retained`,
    );
  }
  assert.deepEqual(outcome.result.data, { version: "2.4.0", license: "MIT" });
});

test("completed/late controls: settled runs are never relabeled by a post-run abort", async () => {
  // Completed: no abort during the invocation — ordinary outcome.
  const judge = offlineJudge();
  const completed = await mi.investigateReleaseManifest(FLOW_INPUT(EXACT, judge));
  assert.equal(completed.cancelled, false);
  // Late: aborting the signal AFTER the outcome resolved cannot relabel
  // the already-computed settlement (the observer's lifetime ended with
  // the engine invocation).
  const controller = new AbortController();
  const clean = offlineJudge();
  const input = FLOW_INPUT(EXACT, clean, { externalSignal: controller.signal });
  const outcome = await mi.investigateReleaseManifest(input);
  assert.equal(outcome.cancelled, false, "no in-window abort — not cancelled");
  controller.abort();
  assert.equal(outcome.cancelled, false, "a post-run abort never relabels a settled outcome");
  // And the now-aborted signal is handled by the typed pre-admission
  // guard on the next call, not by relabeling this one.
  await assert.rejects(
    () => mi.investigateReleaseManifest(FLOW_INPUT(EXACT, clean, { externalSignal: controller.signal })),
    (error) => error.name === "CancellationError" && error.exitCode === 130,
  );
});

test("abort-rejection control: a judge rejecting on its dispatch signal still reports the owned abort", async () => {
  // Qodo r4659936811: a cancellation-honoring judge REJECTS when its own
  // dispatch signal aborts; the engine then settles the row as
  // judge_unavailable — a row reason that is NOT "cancelled". The owned
  // in-window interruption must still be reported at run level.
  const controller = new AbortController();
  const entered = [];
  const judge = (input, options) => {
    entered.push(input.candidates[0]?.fieldId); // judge-start barrier
    const signal = options?.signal;
    const rejectNow = () =>
      Promise.reject(Object.assign(new Error("judge aborted"), { code: "ABORTED" }));
    if (signal?.aborted) return rejectNow();
    return new Promise((_, reject) => {
      // Arm the abort only AFTER entry: guarantees the rejection is a
      // real entered rejection, not a pre-dispatch skip.
      queueMicrotask(() => controller.abort());
      signal?.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("judge aborted"), { code: "ABORTED" })),
        { once: true },
      );
    });
  };
  const outcome = await mi.investigateReleaseManifest(
    FLOW_INPUT(EXACT, { judge }, { externalSignal: controller.signal }),
  );
  assert.equal(controller.signal.aborted, true);
  // Exactly ONE dispatch actually ENTERED and rejected on the abort.
  assert.equal(entered.length, 1, "one actual entered rejection (judge-start barrier)");
  assert.ok(
    outcome.result.requirements[entered[0]].attemptedRecords.some(
      (r) => r.metadata?.kind === "candidate-judgment",
    ),
    "the entered rejection left its audit row",
  );
  assert.equal(outcome.cancelled, true, "owned in-flight abort reported despite the rejection");
  assert.equal(outcome.stopReason, "cancelled");
  // Row reasons are engine-owned and vary by interleave (judge_unavailable
  // per the finding's trace, or the interrupt reason here) — the marker
  // is deliberately independent of them. Assert only what the contract
  // promises: unresolved rows, nothing accepted.
  for (const id of ["version", "license"]) {
    assert.equal(outcome.result.requirements[id].status, "unresolved");
  }
  assert.deepEqual(outcome.result.data, {});
});

test("teardown microtask control: the disclosed settlement window catches a post-work abort", async () => {
  // Contract disclosure: the marker asserts the owned signal aborted
  // BEFORE the callable's continuation finished settling an incomplete
  // result. The engine aborts its dispatch signal during teardown. Queue
  // the owning abort from that event, after the engine prepared its result.
  const controller = new AbortController();
  const dispatches = [];
  let teardownSeen = false;
  const judge = async (input, options) => {
    dispatches.push(input.candidates[0]?.fieldId);
    if (dispatches.length === 2) {
      options.signal.addEventListener("abort", () => {
        if (!controller.signal.aborted) {
          teardownSeen = true;
          queueMicrotask(() => controller.abort());
        }
      }, { once: true });
    }
    const answers = {};
    input.candidates.forEach((c, i) => {
      // Leave one field unresolved even though both judges returned.
      answers[`q${i}s`] = { type: "noul", noul: c.fieldId === "license" ? 0.05 : 0.97 };
      answers[`q${i}c`] = { type: "noul", noul: 0.01 };
    });
    return {
      model: "offline-fixture-judge",
      answers,
      usage: { inputTokens: 10, outputTokens: 5 },
      requestSha256: sha256(JSON.stringify(input)),
      elapsedMs: 1,
    };
  };
  const outcome = await mi.investigateReleaseManifest(
    FLOW_INPUT(EXACT, { judge }, { externalSignal: controller.signal }),
  );
  assert.equal(dispatches.length, 2);
  assert.equal(teardownSeen, true, "engine teardown preceded the owning abort");
  assert.ok(
    outcome.result.requirements.version.attemptedRecords.some((r) => r.metadata?.kind === "candidate-judgment") &&
      outcome.result.requirements.license.attemptedRecords.some((r) => r.metadata?.kind === "candidate-judgment"),
    "both completed judgments are in the audit",
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(outcome.cancelled, true, "abort inside the disclosed settlement window marks cancelled");
  assert.equal(outcome.stopReason, "cancelled");
  assert.equal(outcome.result.status, "partial");
  assert.deepEqual(outcome.result.data, { version: "2.4.0" });
  assert.equal(outcome.result.requirements.license.status, "unresolved");
});

test("ordinary judge rejection without abort stays non-cancelled", async () => {
  const judge = async () => {
    throw Object.assign(new Error("judge protocol failure"), { code: "PROTOCOL" });
  };
  const outcome = await mi.investigateReleaseManifest(FLOW_INPUT(EXACT, { judge }));
  assert.equal(outcome.cancelled, false, "no signal, no interruption — never cancelled");
  assert.deepEqual(outcome.result.data, {});
  assert.equal(outcome.result.requirements.version.status, "unresolved");
});

test("normal runs keep the ordinary shape: cancelled === false, no stopReason field", async () => {
  const judge = offlineJudge();
  const outcome = await mi.investigateReleaseManifest(FLOW_INPUT(EXACT, judge));
  assert.equal(outcome.cancelled, false);
  assert.equal("stopReason" in outcome, false);
  assert.equal(outcome.result.status, "complete");
  assert.deepEqual(outcome.result.data, { version: "2.4.0", license: "MIT" });
  // The pre-judgement manifest without any abort also settles normally.
  const prose = await mi.investigateReleaseManifest(FLOW_INPUT(PROSE, offlineJudge()));
  assert.equal(prose.cancelled, false);
});

test("entry bounds abort before hashing or engine work (consent alone is not enough)", async () => {
  const judge = offlineJudge();
  await assert.rejects(
    () => mi.investigateReleaseManifest(FLOW_INPUT(`${"ü".repeat(9000)}\uD800`, judge)),
    /not well-formed UTF-16/,
  );
  await assert.rejects(
    () => mi.investigateReleaseManifest(FLOW_INPUT(`Version: 1.0.0\nVersion: 2.0.0\n${"a".repeat(CEILING + 1)}`, judge)),
    new RegExp(`${CEILING}-byte`),
  );
  assert.equal(judge.calls.length, 0);
});

test("admitted snapshot is immutable: full in-flight mutation of the input changes nothing", async () => {
  const judge = offlineJudge();
  const input = FLOW_INPUT(EXACT, judge);
  const built = mi.buildManifestDeps(input);
  // Mutate EVERYTHING mutable on the caller's object after admission.
  input.admission.claimedUrl = "https://mutated.invalid/other";
  input.admission.title = "mutated";
  input.admission.materialClass = "public";
  input.manifestText = "Version: 9.9.9\n";
  input.now = () => 42;
  const replacement = offlineJudge();
  input.judgeTransmission = mi.createOfflineJudgeSeam(replacement.judge);
  assert.equal(built.record.title, "Release manifest");
  assert.equal(built.record.content, EXACT);
  assert.match(built.record.url, /^urn:x-scoutline:manifest:sha256-[0-9a-f]{64}$/);
  assert.notEqual(built.record.url, "https://mutated.invalid/other");
  // Read seam serves the snapshot via the opaque locator only.
  assert.equal(await built.deps.read(built.record.url), EXACT);
  await assert.rejects(() => built.deps.read(ADMITTED_URL), /manifest_only_source/);
  // The clock and the judge dispatch were captured at build time.
  assert.equal(built.deps.now(), 0);
  const engine = await import(`${root}/dist/lib/lean-investigation.js`);
  const result = await engine.runLeanInvestigation(mi.manifestContract(), built.deps);
  assert.equal(judge.calls.length > 0, true, "the admitted dispatch was called");
  assert.equal(replacement.calls.length, 0, "the post-build swap was never wired");
  const extractAudit = result.requirements.version.attemptedRecords.find(
    (r) => r.metadata?.kind === "extraction",
  );
  assert.equal(extractAudit.metadata.sourceId, built.record.evidenceId);
  assert.equal(extractAudit.metadata.sourceDigest, sha256(EXACT));
  // The record itself is frozen (ESM strict mode: assignment throws).
  assert.throws(() => {
    built.record.url = "x";
  }, TypeError);
});

test("judge input is pinned to the digest-derived opaque locator, never the claimed URL", async () => {
  const judge = offlineJudge();
  const { record } = await mi.investigateReleaseManifest(FLOW_INPUT(EXACT, judge));
  assert.ok(judge.calls.length > 0);
  for (const call of judge.calls) {
    assert.equal(call.source.url, record.url);
    assert.match(call.source.url, /^urn:x-scoutline:manifest:sha256-[0-9a-f]{64}$/);
    assert.notEqual(call.source.url, ADMITTED_URL);
    assert.equal(call.source.evidenceId, record.evidenceId);
  }
});

// ---------------------------------------------------------------------------
// Complete first-slice flow through the shared engine
// (closed declared source with no external acquisition)
// ---------------------------------------------------------------------------

const run = (text, judge) => mi.investigateReleaseManifest(FLOW_INPUT(text, judge));

test("flow: closed document set refuses search without recording success", async () => {
  const judge = offlineJudge();
  const { result } = await run(EXACT, judge);
  const failedSearches = result.acquisitionLog.filter((e) => e.kind === "search-failed");
  assert.ok(failedSearches.length > 0, "search refusal must be recorded, not swallowed");
  // No successful search events exist at all — nothing was faked.
  assert.equal(result.acquisitionLog.filter((e) => e.kind === "search").length, 0);
});

test("flow: judged-clean manifest ACCEPTS over the closed declared source set", async () => {
  const judge = offlineJudge();
  const { result, parse } = await run(EXACT, judge);
  // Candidates WERE validated and judged clean — the trail exists...
  assert.ok(judge.calls.length > 0, "candidate judge dispatched on the retained manifest");
  const trusted = result.requirements.version.attemptedRecords.filter((r) => r.trusted === true);
  assert.ok(trusted.length > 0, "the earned acceptance trail is retained in the audit");
  // ...and the engine's closed-evidence capability closes contrary
  // coverage over the one declared retained source: values publish.
  assert.equal(result.requirements.version.status, "satisfied");
  assert.equal(result.requirements.version.value, "2.4.0");
  assert.equal(result.requirements.license.status, "satisfied");
  assert.equal(result.requirements.license.value, "MIT");
  assert.equal(result.data.version, "2.4.0");
  assert.equal(result.data.license, "MIT");
  assert.equal(result.status, "complete");
  // Lane report binds to the same admitted snapshot the engine judged.
  assert.equal(parse.sourceDigest, sha256(EXACT));
});

test("flow: without judgment the closed set still proposes nothing as accepted", async () => {
  const { result } = await run(EXACT, null);
  assert.equal(result.requirements.version.status, "unresolved");
  assert.equal(result.requirements.license.status, "unresolved");
  assert.deepEqual(result.data, {});
  assert.equal(result.status, "partial");
});

test("flow: the authorized runtime judge routes through the options seam, never the caller label", async () => {
  const judge = offlineJudge();
  // Caller JSON asserting the production capability spelling rejects.
  await assert.rejects(
    mi.investigateReleaseManifest({
      ...FLOW_INPUT(EXACT, null),
      judgeTransmission: { capability: "authorized-runtime-judge", dispatch: judge.judge },
    }),
    (error) => error.code === "VALIDATION_ERROR",
  );
  await assert.rejects(
    mi.investigateReleaseManifest(FLOW_INPUT(EXACT, judge), { authorizedRuntimeJudge: judge.judge }),
    /Only one judge transmission route/,
  );
  assert.equal(judge.calls.length, 0);
  // The trusted options seam (CLI wiring) routes the same judge.
  const { result } = await mi.investigateReleaseManifest(FLOW_INPUT(EXACT, null), {
    authorizedRuntimeJudge: judge.judge,
  });
  assert.ok(judge.calls.length > 0, "authorized runtime judge dispatched");
  assert.equal(result.requirements.version.status, "satisfied");
  assert.equal(result.status, "complete");
});

test("flow: ambiguous version and missing license judge nothing and invent nothing", async () => {
  const judge = offlineJudge();
  const { result, parse } = await run(AMBIGUOUS, judge);
  assert.equal(judge.calls.length, 0, "abstained fields never dispatch a judge");
  assert.equal("version" in result.data, false, "first conflicting label must not win");
  assert.equal("license" in result.data, false);
  assert.equal(result.requirements.version.status, "unresolved");
  assert.equal(result.requirements.license.status, "unresolved");
  assert.equal(parse.fields.find((f) => f.fieldId === "version").status, "ambiguous");
  assert.equal(parse.fields.find((f) => f.fieldId === "license").status, "missing");
});

test("flow: non-manifest prose proposes nothing and accepts nothing", async () => {
  const judge = offlineJudge();
  const { result } = await run(PROSE, judge);
  assert.equal(judge.calls.length, 0);
  assert.deepEqual(result.data, {});
  assert.equal(result.requirements.version.status, "unresolved");
  assert.equal(result.requirements.license.status, "unresolved");
});

test("flow: producer disabled reports no_extractor without inventing values", async () => {
  const judge = offlineJudge();
  const { deps } = mi.buildManifestDeps(FLOW_INPUT(EXACT, judge));
  delete deps.extract;
  const engine = await import(`${root}/dist/lib/lean-investigation.js`);
  const result = await engine.runLeanInvestigation(mi.manifestContract(), deps);
  assert.deepEqual(result.data, {});
  assert.equal(result.requirements.version.status, "unresolved");
  assert.equal(result.requirements.version.reason, "no_extractor");
  assert.equal(result.requirements.license.reason, "no_extractor");
});

// Runner discovery is NOT re-asserted here: the proof that this suite is
// selected by the real offline runner is the runner's own log line
// (`[run-tests] mode=offline files=...,tests/document-manifest.test.js,...`
// in the gate logs) and this suite's tests being counted in the offline
// gate totals — not a duplicated selection rule inside the suite.


test("authorized manifest judge settles against the signal captured for the engine", async () => {
  const original = new AbortController();
  const replacement = new AbortController();
  const input = FLOW_INPUT(EXACT, null, { externalSignal: original.signal });
  const judge = offlineJudge();
  const outcome = await mi.investigateReleaseManifest(input, {
    authorizedRuntimeJudge: (request, dispatch) => {
      input.externalSignal = replacement.signal;
      original.abort();
      assert.equal(dispatch.signal.aborted, true);
      return judge.judge(request);
    },
  });
  assert.equal(judge.calls.length, 1);
  assert.equal(replacement.signal.aborted, false);
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.stopReason, "cancelled");
  assert.equal(outcome.record.content, EXACT);
  assert.equal(outcome.parse.sourceDigest, sha256(EXACT));
  assert.ok(Object.values(outcome.result.requirements).some((row) => row.reason === "cancelled"));
});
