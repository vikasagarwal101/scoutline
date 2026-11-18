import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolveConflict } from '../dist/lib/resolve-conflict.js';
import { ValidationError } from '../dist/lib/errors.js';
import { candidateIdentity, candidateSourceDigest } from '../dist/lib/lean-candidates.js';

// Offline only: no real HTTP may leave this process.
globalThis.fetch = () => { throw new Error('HTTP refused'); };

const ENTITY = 'ExampleApp';
const RELEASE = '2.4.0';
const URL_GPL = 'https://releases.example.test/exampleapp/2.4.0/notice';
const URL_CORRECTION = 'https://releases.example.test/exampleapp/2.4.0/notice-correction';
const URL_CORRECTION_OTHER_HOST = 'https://blog.example.test/exampleapp/correction';
const URL_MIT = 'https://releases.example.test/exampleapp/2.4.0/packaging';
const URL_MIT_AGREE = 'https://releases.example.test/exampleapp/2.4.0/readme';
const URL_APACHE = 'https://releases.example.test/exampleapp/2.3.0/notice';
const URL_OPPOSITION = 'https://packages.example.test/exampleapp/2.4.0/license-note';
const URL_CHANGELOG = 'https://releases.example.test/exampleapp/changelog';
const URL_OTHERAPP = 'https://releases.example.test/otherapp/2.3.0/notice';
const MIRRORS = [
  'https://mirror-a.example.test/exampleapp/2.4.0/notice',
  'https://mirror-b.example.test/exampleapp/2.4.0/notice',
  'https://mirror-c.example.test/exampleapp/2.4.0/notice',
];
const NOTICE_GPL = 'ExampleApp 2.4.0 original release notice. License: GPL-3.0 applies to ExampleApp 2.4.0.';
const NOTICE_APACHE = 'ExampleApp 2.3.0 release notice. License: Apache-2.0 applies to ExampleApp 2.3.0.';
const NOTICE_MIT = 'ExampleApp 2.4.0 packaging page. License: MIT applies to ExampleApp 2.4.0.';
const NOTICE_MIT_AGREE = 'ExampleApp 2.4.0 readme. License: MIT applies to ExampleApp 2.4.0.';
const NOTICE_OPPOSITION = 'ExampleApp 2.4.0 license note. License: Apache-2.0 applies to ExampleApp 2.4.0.';
const NOTICE_CHANGELOG = 'ExampleApp changelog: the 2.3.0 release used Apache-2.0. License: GPL-3.0 applies to ExampleApp 2.4.0.';
const NOTICE_OTHERAPP = 'OtherApp 2.3.0 release notice. License: Apache-2.0 applies to OtherApp 2.3.0.';
const NOTICE_MIXED = 'Historical note: License: Apache-2.0 applies to ExampleApp 2.3.0. Current notice: License: GPL-3.0 applies to ExampleApp 2.4.0.';
const NOTICE_META = 'Maintainer discussion of ExampleApp 2.4.0 licensing. No license statement is made here.';
const NOTICE_OVERSIZE = 'License: Apache-2.0 applies to ExampleApp 2.3.0. ' + 'padding '.repeat(3000);
const NOTICE_LATE = 'Sponsor note. License: MIT applies to ExampleApp 2.4.0.';
const URL_MIXED = 'https://releases.example.test/exampleapp/changelog-history';
const URL_META = 'https://discuss.example.test/exampleapp/license-thread';
const URL_LATE = 'https://releases.example.test/exampleapp/2.4.0/sponsor-note';
const URL_GPL_ALIAS = 'https://releases.example.test:443/exampleapp/2.4.0/notice';
const URL_GPL_COPY = 'https://copies.example.test/exampleapp/2.4.0/notice';
const CORRECTIONS = {
  full: 'Correction to the ExampleApp 2.4.0 release notice. This correction explicitly supersedes the original ExampleApp 2.4.0 licensing notice. License: MIT applies to ExampleApp 2.4.0.',
  missing: 'Correction to the ExampleApp release notice. License: MIT applies to ExampleApp 2.4.0.',
  'wrong-release': 'Correction to the ExampleApp 2.3.0 release notice. This correction explicitly supersedes the original ExampleApp 2.3.0 licensing notice. License: MIT applies to ExampleApp 2.3.0.',
  'other-value': 'Correction to the ExampleApp 2.4.0 release notice. This correction explicitly supersedes the original ExampleApp 2.4.0 licensing notice. License: Apache-2.0 applies to ExampleApp 2.4.0.',
};
const SCOPE_240 = /applies to ExampleApp 2\.4\.0\./;
const LICENSE_OF = text => /License: (\S+) applies/.exec(text)?.[1];

function world({ correction = 'full', correctionUrl = URL_CORRECTION, applicabilityUrl = URL_APACHE, dispute = 'values', searchResults = [], failReads = [], lateTargetFailure = false, docs = {} } = {}) {
  const contents = new Map([
    [URL_GPL, NOTICE_GPL],
    [URL_APACHE, NOTICE_APACHE],
    [URL_MIT, NOTICE_MIT],
    [URL_MIT_AGREE, NOTICE_MIT_AGREE],
    [URL_OPPOSITION, NOTICE_OPPOSITION],
    [URL_CHANGELOG, NOTICE_CHANGELOG],
    [URL_OTHERAPP, NOTICE_OTHERAPP],
    [URL_MIXED, NOTICE_MIXED],
    [URL_META, NOTICE_META],
    [URL_LATE, NOTICE_LATE],
    [URL_GPL_ALIAS, NOTICE_MIT],
    [URL_GPL_COPY, NOTICE_GPL],
    [correctionUrl, CORRECTIONS[correction] ?? CORRECTIONS.full],
    ...MIRRORS.map(url => [url, NOTICE_GPL]),
    ...Object.entries(docs),
  ]);
  const calls = { search: [], read: [], extract: [], candidateJudge: [] };
  const judge = async input => ({
    documents: input.documents.map(d => {
      if (input.fieldId === 'applicability') {
        // Positive applicability proof for the scope subject: refute ON the
        // record when its licensing statement does not apply to the
        // requested scope; support when it does.
        const applies = SCOPE_240.test(d.content);
        if (d.url === applicabilityUrl) return { evidenceId: d.evidenceId, relevant: true, supportsClaim: applies, refutesClaim: !applies };
        return { evidenceId: d.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      }
      if (input.fieldId === 'correction') {
        // Pair-bound question names the target notice; verdicts reflect
        // whether THIS document proves supersession of THAT target.
        if (correction === 'unrelated-supporter') {
          // Dishonest/mistaken judge: an unrelated page supplies the only
          // support; the correcting record itself does not.
          if (d.url === URL_MIT) return { evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false };
          return { evidenceId: d.evidenceId, relevant: d.url === URL_GPL || d.url === correctionUrl, supportsClaim: false, refutesClaim: false };
        }
        if (d.url === correctionUrl) {
          if (correction === 'full' || correction === 'other-value') return { evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false };
          if (correction === 'wrong-release') return { evidenceId: d.evidenceId, relevant: true, supportsClaim: false, refutesClaim: true };
          return { evidenceId: d.evidenceId, relevant: true, supportsClaim: false, refutesClaim: false };
        }
        if (d.url === URL_GPL) return { evidenceId: d.evidenceId, relevant: true, supportsClaim: false, refutesClaim: false };
        return { evidenceId: d.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      }
      if (input.fieldId === 'dispute') {
        // Per-doc verdicts must be STABLE across evidence growth (the
        // engine flags side-flips as inconsistent history), so this row is
        // a weak generic signal: every same-scope value-asserting document
        // marks relevant+supporting. Material two-sided proof — two
        // distinct values exactly bound to distinct retained origins —
        // lives in the consumer's side bindings, never in this row alone.
        return SCOPE_240.test(d.content) && LICENSE_OF(d.content) !== undefined
          ? { evidenceId: d.evidenceId, relevant: true, supportsClaim: true, refutesClaim: false }
          : { evidenceId: d.evidenceId, relevant: false, supportsClaim: false, refutesClaim: false };
      }
      // Value-field relevance gate: the engine's scope authority. A record
      // is relevant only when its license applies to ExampleApp 2.4.0 —
      // merely mentioning another release is NOT exclusion-grade evidence.
      return { evidenceId: d.evidenceId, relevant: SCOPE_240.test(d.content), supportsClaim: false, refutesClaim: false };
    }),
  });
  const extract = async input => {
    calls.extract.push(input.sourceId);
    const out = {};
    for (const f of input.fields) {
      const match = /License: (\S+) applies to (ExampleApp|OtherApp) [0-9.]+\./.exec(input.sourceText);
      out[f.id] = match ? { value: match[1], quote: match[0] } : { value: null, quote: null };
    }
    return { finishReason: 'stop', rawOutput: JSON.stringify(out), usage: { inputTokens: 1, outputTokens: 1 }, observedCost: null, elapsedMs: 0, requestSha256: '0'.repeat(64) };
  };
  const candidateJudge = async input => {
    calls.candidateJudge.push(input);
    const opposing = input.opposingContext.filter(e => e.url !== input.source.url && SCOPE_240.test(e.content));
    // The correcting document removes the GPL notice as material
    // contradiction when it explicitly supersedes it at this release —
    // ONLY that notice, never other opposition. ('unrelated-supporter'
    // content still carries the supersession statement; only the judge's
    // pair-verdict assignment is mistaken there.)
    const shield = input.source.url === correctionUrl && ['full', 'other-value', 'unrelated-supporter'].includes(correction) && opposing.some(e => e.url === URL_GPL);
    const materialOpposing = shield ? opposing.filter(e => e.url !== URL_GPL) : opposing;
    // Passage-honest support: the DESIGNATED PASSAGE (the candidate's own
    // quote) substantiates a value only when it applies to ExampleApp
    // 2.4.0. A wrong-release or other-entity passage supports nothing in
    // this scope even when the surrounding document applies here.
    const answers = {};
    input.candidates.forEach((c, i) => {
      const support = SCOPE_240.test(c.quote ?? '') ? 0.97 : 0.05;
      const conflict = materialOpposing.some(e => LICENSE_OF(e.content) !== c.value) ? 0.97 : 0.02;
      answers[`q${i}s`] = { type: 'noul', noul: support };
      answers[`q${i}c`] = { type: 'noul', noul: conflict };
    });
    return { model: 'offline-conflict-judge-v1', answers, usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: '0'.repeat(64), elapsedMs: 0 };
  };
  const baseCandidateJudge = candidateJudge;
  const wrappedCandidateJudge = lateTargetFailure
    ? async input => {
        // Fail protocol validation exactly when the target candidate is
        // re-judged under the late record's opposing context: the current
        // attempt fails, so an older support verdict must not survive.
        if (input.source.url === URL_GPL && input.opposingContext.some(e => e.url === URL_LATE)) {
          return { model: 'offline-conflict-judge-v1', answers: {}, usage: { inputTokens: 1, outputTokens: 1 }, requestSha256: '0'.repeat(64), elapsedMs: 0 };
        }
        return baseCandidateJudge(input);
      }
    : baseCandidateJudge;
  const deps = {
    now: Date.now,
    search: async query => {
      calls.search.push(query);
      const results = typeof searchResults === 'function' ? searchResults(calls.search.length) : searchResults;
      return results.map(r => ({ ...r }));
    },
    read: async url => {
      calls.read.push(url);
      if (failReads.includes(url)) throw new Error(`offline read failure: ${url}`);
      const content = contents.get(url);
      if (content === undefined) throw new Error(`unexpected read: ${url}`);
      return content;
    },
    judge,
    extract,
    candidateJudge: wrappedCandidateJudge,
    extractorRevision: 'offline-conflict-extractor-v1',
  };
  return { calls, deps, contents };
}

const alt = (id, value, url, release, extra = {}) => ({
  id, value, source: { url, title: `${id} page` }, scope: { entity: ENTITY, release }, ...extra,
});
const correctionInput = (extra = {}) => ({
  schemaVersion: 1,
  scope: { entity: ENTITY, release: RELEASE },
  alternatives: [
    alt('gpl', 'GPL-3.0', URL_GPL, RELEASE),
    alt('mit-correction', 'MIT', URL_CORRECTION, RELEASE, { correctionOf: 'gpl' }),
    alt('apache', 'Apache-2.0', URL_APACHE, '2.3.0'),
  ],
  ...extra,
});
const byId = resolution => Object.fromEntries(resolution.alternatives.map(a => [a.id, a]));

test('explicit same-scope correction selects MIT from the correcting record and explains every alternative', async () => {
  const w = world();
  const { resolution, engineResult, cancelled } = await resolveConflict(correctionInput(), w.deps);
  assert.equal(cancelled, false);
  assert.equal(engineResult.status, 'complete');
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.selected.value, 'MIT');
  assert.equal(resolution.selected.basis.url, URL_CORRECTION);
  assert.equal(resolution.selected.basis.correctingClaimId, 'mit-correction');
  assert.ok(resolution.selected.basis.quote.includes('MIT'));
  assert.deepEqual(resolution.alternatives.map(a => [a.id, a.value]), [['gpl', 'GPL-3.0'], ['mit-correction', 'MIT'], ['apache', 'Apache-2.0']]);
  const ids = byId(resolution);
  assert.equal(ids.apache.explanation.relationship, 'different-scope');
  assert.ok(ids.apache.explanation.detail.includes('2.3.0'));
  assert.equal(ids.gpl.explanation.relationship, 'superseded-by-correction');
  const correctionEvidence = engineResult.evidence.find(e => e.url === URL_CORRECTION);
  assert.ok(ids.gpl.explanation.evidence.some(e => e.evidenceId === correctionEvidence.evidenceId));
  assert.equal(ids['mit-correction'].explanation.relationship, 'selection-source');
  assert.equal(resolution.dispute, undefined, 'license dispute obligation is not declared alongside a correction claim');
  assert.deepEqual(resolution.gaps, []);
});

test('matched negative: dropping only the correction declaration leaves the license verdict intact and blocks selection', async () => {
  const w = world();
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('gpl', 'GPL-3.0', URL_GPL, RELEASE),
      alt('mit-page', 'MIT', URL_CORRECTION, RELEASE),
      alt('apache', 'Apache-2.0', URL_APACHE, '2.3.0'),
    ],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.license.status, 'satisfied');
  assert.equal(engineResult.requirements.license.value, 'MIT', 'license verdict must match the GREEN case');
  assert.equal(resolution.status, 'disputed');
  assert.equal(resolution.selected, undefined);
  assert.equal(resolution.dispute.established, true, 'GPL vs MIT pages assert actual opposite values');
  assert.equal(byId(resolution).gpl.explanation.relationship, 'unexplained-conflict');
});

test('matched negative: accepted value must match the declared correction value from the correcting record', async () => {
  const w = world({ correction: 'other-value' });
  const { resolution, engineResult } = await resolveConflict(correctionInput(), w.deps);
  assert.equal(engineResult.requirements.correction.value, 'supported');
  assert.equal(engineResult.requirements.license.status, 'satisfied');
  assert.equal(engineResult.requirements.license.value, 'Apache-2.0');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction-value-binding' && g.reason.includes('Apache-2.0') && g.reason.includes('MIT')));
});

test('matched negative: an unrelated sole supporter cannot verify the pair even with both originals present', async () => {
  // Both the notice and the correcting record are retained and judged, but
  // the only supporting verdict for the correction question sits on an
  // unrelated packaging page — the pair itself proves nothing.
  const w = world({ correction: 'unrelated-supporter' });
  const input = correctionInput();
  input.alternatives.push(alt('mit-page', 'MIT', URL_MIT, RELEASE));
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.correction.value, 'supported', 'engine accepted the row via the unrelated supporter');
  assert.ok(engineResult.evidence.some(e => e.url === URL_CORRECTION) && engineResult.evidence.some(e => e.url === URL_GPL));
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction' && g.reason.includes('no current relevant/supporting verdict on the correcting record')));
});

test('matched negative: wrong-source same value — accepted MIT from a record that is not the declared corrector', async () => {
  // The caller declares the packaging page as the correcting record; the
  // real correction document surfaces via search. The engine accepts MIT
  // from the real corrector, but the declared pair was never verified.
  const w = world({ searchResults: [{ url: URL_CORRECTION, title: 'Correction' }] });
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('gpl', 'GPL-3.0', URL_GPL, RELEASE),
      alt('wrong-corrector', 'MIT', URL_MIT, RELEASE, { correctionOf: 'gpl' }),
    ],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.license.status, 'satisfied');
  assert.equal(engineResult.requirements.license.value, 'MIT');
  const acceptedUrl = engineResult.evidence.find(e => e.evidenceId === engineResult.requirements.license.provenance.sourceId).url;
  assert.equal(acceptedUrl, URL_CORRECTION, 'value accepted from the real corrector');
  assert.notEqual(acceptedUrl, URL_MIT, 'not from the declared corrector');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction'));
});

test('matched negative: a record that merely mentions another release but applies here cannot be excluded', async () => {
  // Caller declares the changelog out of scope (2.3.0); its content
  // mentions 2.3.0 but asserts GPL-3.0 for 2.4.0. The applicability
  // judgment SUPPORTS application here, so it must stay a material blocker.
  const w = world({ applicabilityUrl: URL_CHANGELOG });
  const input = correctionInput();
  input.alternatives[2] = alt('old-notice', 'Apache-2.0', URL_CHANGELOG, '2.3.0');
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.correction.value, 'supported');
  const rel = byId(resolution)['old-notice'].explanation.relationship;
  assert.notEqual(rel, 'different-scope', 'release-substring exclusion is gone');
  assert.equal(rel, 'unexplained-conflict');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  // The in-scope GPL assertion is genuine opposition: it blocks either by
  // keeping the license value unaccepted or by coverage.
  assert.ok(resolution.gaps.some(g => ['coverage', 'license'].includes(g.requirement)));
});

test('a record for a different entity is excluded by the engine verdict, not by caller scope', async () => {
  const w = world({ applicabilityUrl: URL_OTHERAPP });
  const input = correctionInput();
  input.alternatives[2] = alt('otherapp', 'Apache-2.0', URL_OTHERAPP, '2.3.0');
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.applicability.value, 'refuted');
  assert.equal(byId(resolution).otherapp.explanation.relationship, 'different-scope');
  assert.equal(resolution.status, 'resolved', 'genuinely inapplicable record does not block');
  assert.equal(resolution.selected.value, 'MIT');
});

test('matched regression: wrong-passage support=false never excludes a source that applies here', async () => {
  // The mixed document's extractor picks the historical 2.3.0 passage, so
  // its candidate is judged support=false — but the document's current
  // notice applies to 2.4.0. Only the applicability obligation can
  // exclude; it SUPPORTS application here, so the alternative blocks.
  const w = world({ applicabilityUrl: URL_MIXED });
  const input = correctionInput();
  input.alternatives[2] = alt('mixed', 'Apache-2.0', URL_MIXED, '2.3.0');
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.applicability.value, 'supported');
  const mixed = byId(resolution).mixed;
  assert.notEqual(mixed.explanation.relationship, 'different-scope');
  assert.ok(['unexplained-conflict', 'scope-unverified'].includes(mixed.explanation.relationship));
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
});

test('matched regression: mutating the declared target value breaks supersession', async () => {
  // Same world as GREEN; only the caller's declared value for the target
  // changes (claims the notice said Apache-2.0; it says GPL-3.0). The
  // correction and license obligations still succeed — supersession must
  // not, because the target's own claim is not evidenced.
  const w = world();
  const input = correctionInput();
  input.alternatives[0].value = 'Apache-2.0';
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.correction.value, 'supported');
  assert.equal(engineResult.requirements.license.status, 'satisfied');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction-target-claim' && g.reason.includes('GPL-3.0') && g.reason.includes('Apache-2.0')));
  assert.equal(byId(resolution).gpl.explanation.relationship, 'unverified-correction');
});

test('matched regression: mutated target-record scope blocks the scalar with correction+license gates green', async () => {
  // Only the target record's content is mutated: it is actually a 2.3.0
  // notice while declared in-scope with value GPL-3.0. Its extracted
  // passage cannot support any value at the requested scope, so the
  // payload+assessment witness refuses the target proof even though the
  // correction and license obligations both succeed.
  const w = world({ docs: { [URL_GPL]: 'ExampleApp 2.3.0 original release notice. License: GPL-3.0 applies to ExampleApp 2.3.0.' } });
  const { resolution, engineResult } = await resolveConflict(correctionInput(), w.deps);
  assert.equal(engineResult.requirements.correction.value, 'supported', 'correction gate green');
  assert.equal(engineResult.requirements.license.status, 'satisfied', 'license gate green');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction-target-claim'));
  assert.equal(byId(resolution).gpl.explanation.relationship, 'unverified-correction');
});

test('same-content mirror does not add a dispute side; established sides carry exact slice/digest/assessment identity', async () => {
  // A search-found byte copy of the GPL notice at a distinct URL supports
  // the same value from the same content: it collapses by digest, never
  // counting as a third representation. The surviving two sides must each
  // carry the exact quote slice, content digest, and BOTH engine identity
  // witnesses reproduced independently below.
  const w = world({ searchResults: idx => (idx === 1 ? [{ url: URL_GPL_COPY, title: 'byte copy' }] : []) });
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('gpl', 'GPL-3.0', URL_GPL, RELEASE),
      alt('mit', 'MIT', URL_MIT, RELEASE),
    ],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.ok(engineResult.evidence.some(e => e.url === URL_GPL_COPY), 'the copy was acquired, not suppressed');
  assert.equal(resolution.dispute.established, true);
  assert.equal(resolution.dispute.sides.length, 2, 'duplicate representation collapses to one side');
  const digests = resolution.dispute.sides.map(s => s.sourceDigest);
  assert.equal(new Set(digests).size, 2, 'sides are nonduplicate retained contents');
  const question = `Which license applies to ${ENTITY} ${RELEASE}?`;
  for (const side of resolution.dispute.sides) {
    const record = engineResult.evidence.find(e => e.evidenceId === side.sourceId);
    assert.ok(record, 'side bound to a retained record');
    assert.equal(record.content.slice(side.charRange[0], side.charRange[1]), side.quote, 'quote is the exact content slice');
    assert.equal(createHash('sha256').update(record.content, 'utf8').digest('hex'), side.sourceDigest, 'digest is the exact content hash');
    const expectedAssessment = candidateIdentity(record, candidateSourceDigest(record), 'license', side.value, side.quote, side.charRange, {
      fieldMeaning: question,
      scope: { entity: ENTITY, release: RELEASE },
      opposingContext: engineResult.evidence.filter(e => e.evidenceId !== record.evidenceId),
      depBindings: {},
    });
    assert.equal(side.assessmentId, expectedAssessment, 'assessment identity reproduces from the live final context');
  }
});

test('oversize body at a seeded alternative URL relisted by contrary search stays a visible coverage gap', async () => {
  // Witness, labeled accurately: the oversize body belongs to the
  // out-of-scope DECLARED alternative (its URL is a seeded lead, not a
  // discovery-only result) and is re-listed by the final contrary search
  // round. The correction pair is fully valid and retained; the engine
  // rejects the oversize body; the alternative cannot be partitioned; the
  // run stays unresolved on COVERAGE — not on the correction gates.
  const w = world({
    docs: { [URL_APACHE]: NOTICE_OVERSIZE },
    // The oversize discovery re-lists on the FINAL contrary round (plan
    // query 7 of 7): the pair's own contrary rounds complete first, so
    // the pair gates stay green while the repeated hit stays visible.
    searchResults: idx => (idx >= 7 ? [{ url: URL_APACHE, title: 'apache notice' }] : []),
  });
  const { resolution, engineResult } = await resolveConflict(correctionInput(), w.deps);
  assert.equal(engineResult.requirements.correction.value, 'supported', 'pair gates green');
  assert.equal(engineResult.requirements.license.status, 'satisfied');
  assert.ok(engineResult.evidence.some(e => e.url === URL_GPL) && engineResult.evidence.some(e => e.url === URL_CORRECTION), 'valid retained pair');
  assert.ok(engineResult.acquisitionLog.some(e => /oversize|bytes-cap/.test(e.kind)), 'engine rejects the oversize body');
  assert.ok(engineResult.evidence.every(e => e.url !== URL_APACHE), 'oversize body never retained');
  assert.ok(!resolution.notes.some(n => n.startsWith('search-result-')), 'no suppression of the repeated contrary hit');
  assert.equal(byId(resolution).apache.explanation.relationship, 'scope-unverified');
  assert.ok(resolution.gaps.some(g => g.requirement === 'coverage'), 'unresolved due to coverage');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
});

test('matched regression: failed current target re-judgment voids stale support with other gates green', async () => {
  // The target's GPL candidate is first judged support=true; a late
  // record then changes the opposing context and the re-judgment FAILS
  // protocol validation. Correction and license still succeed — the old
  // target support must NOT be inherited across the failed attempt.
  const w = world({ lateTargetFailure: true, searchResults: idx => (idx >= 2 ? [{ url: URL_LATE, title: 'sponsor note' }] : []) });
  const { resolution, engineResult } = await resolveConflict(correctionInput(), w.deps);
  assert.ok(engineResult.evidence.some(e => e.url === URL_LATE), 'late record retained');
  assert.equal(engineResult.requirements.correction.value, 'supported', 'correction gate green');
  assert.equal(engineResult.requirements.license.status, 'satisfied', 'license gate green');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction-target-claim' && g.reason.includes('current')));
  assert.equal(byId(resolution).gpl.explanation.relationship, 'unverified-correction');
});

test('matched regression: canonical URL aliases cannot count as two dispute origins', async () => {
  // A search-found alias of the GPL notice (same canonical fetch identity,
  // explicit :443) serves MIT content. Two supporting values exist on two
  // records, but they are ONE origin — the dispute cannot be established.
  const w = world({ searchResults: idx => (idx === 1 ? [{ url: URL_GPL_ALIAS, title: 'notice copy' }] : []) });
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [alt('gpl', 'GPL-3.0', URL_GPL, RELEASE)],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.dispute.value, 'supported', 'generic two-record verdict accepted');
  assert.ok(engineResult.evidence.some(e => e.url === URL_GPL) && engineResult.evidence.some(e => e.url === URL_GPL_ALIAS));
  assert.equal(resolution.dispute.established, false, 'alias collapses to one origin');
  assert.ok(resolution.notes.some(n => n.startsWith('dispute-verdict-unverified:')));
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
});

test('matched regression: supported generic dispute without material sides stays unverified audit evidence', async () => {
  // The dispute row is a weak generic signal (one supporting record
  // suffices for the engine row); the meta document asserts no license
  // value at all. Only one value is exactly bound to a retained source,
  // so the dispute is NOT established and the run says why.
  const w = world();
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('gpl', 'GPL-3.0', URL_GPL, RELEASE),
      alt('meta', 'unsettled', URL_META, RELEASE),
    ],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.dispute.value, 'supported', 'generic verdict accepted by the engine');
  assert.equal(resolution.dispute.established, false);
  assert.ok(resolution.notes.some(n => n.startsWith('dispute-verdict-unverified:')));
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
});

test('two out-of-scope alternatives are an unsupported scope shape', async () => {
  const w = world();
  const input = correctionInput();
  input.alternatives.push(alt('otherapp', 'Apache-2.0', URL_OTHERAPP, '2.3.0'));
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.ok(resolution.gaps.some(g => g.requirement === 'scope-shape' && g.reason.includes('at most one')));
  assert.equal(engineResult.requirements.applicability, undefined, 'no applicability obligation declared');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
});

test('matched negative: search-found opposition labeled a mirror is acquired and blocks resolution', async () => {
  // The caller labels a genuine same-scope Apache-2.0 opposition page as a
  // "mirror" of the GPL notice. Suppression is gone: the page is read,
  // judged, and its distinct value keeps the license unresolved.
  const w = world({ searchResults: [{ url: URL_OPPOSITION, title: 'license note' }] });
  const input = correctionInput();
  input.alternatives[0].mirrors = [{ url: URL_OPPOSITION, title: 'claimed mirror' }];
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.ok(w.calls.read.includes(URL_OPPOSITION), 'alleged mirror must be acquired, not suppressed');
  assert.ok(engineResult.evidence.some(e => e.url === URL_OPPOSITION));
  assert.equal(engineResult.requirements.license.status, 'unresolved', 'opposition materially conflicts with MIT');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
});

test('missing supersession statement abstains with unverified identities visible', async () => {
  const w = world({ correction: 'missing' });
  const { resolution, engineResult } = await resolveConflict(correctionInput(), w.deps);
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.equal(engineResult.requirements.correction.status, 'unresolved');
  assert.equal(engineResult.requirements.license.status, 'unresolved');
  const ids = byId(resolution);
  assert.equal(ids.gpl.explanation.relationship, 'unverified-correction');
  assert.equal(ids['mit-correction'].explanation.relationship, 'unverified-correction');
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction'));
});

test('correction for the wrong release is refuted and selects nothing', async () => {
  const w = world({ correction: 'wrong-release' });
  const { resolution, engineResult } = await resolveConflict(correctionInput(), w.deps);
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.equal(engineResult.requirements.correction.value, 'refuted');
  const ids = byId(resolution);
  assert.equal(ids.gpl.explanation.relationship, 'unexplained-conflict');
  assert.equal(ids['mit-correction'].explanation.relationship, 'unexplained-conflict');
  assert.equal(ids.apache.explanation.relationship, 'different-scope');
});

test('correction on another origin host fails the authority policy even when the judge would support it', async () => {
  const w = world({ correctionUrl: URL_CORRECTION_OTHER_HOST });
  const input = correctionInput();
  input.alternatives[1].source.url = URL_CORRECTION_OTHER_HOST;
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.correction, undefined, 'unsupported shape declares no correction obligation');
  assert.equal(engineResult.requirements.license.status, 'satisfied', 'license evidence itself is fine');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction-shape' && g.reason.includes('origin host')));
  assert.equal(byId(resolution)['mit-correction'].explanation.relationship, 'unverified-correction');
});

test('a self-correction (identical fetch identities) is an unsupported shape', async () => {
  const w = world();
  const input = correctionInput();
  input.alternatives[1].source.url = URL_GPL + '#correction';
  const { resolution } = await resolveConflict(input, w.deps);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction-shape' && g.reason.includes('distinct canonical fetch identities')));
  assert.equal(resolution.selected, undefined);
});

test('two correction claims are an unsupported shape and abstain', async () => {
  const w = world();
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('gpl', 'GPL-3.0', URL_GPL, RELEASE),
      alt('c1', 'MIT', URL_CORRECTION, RELEASE, { correctionOf: 'gpl' }),
      alt('c2', 'Apache-2.0', URL_MIT, RELEASE, { correctionOf: 'gpl' }),
    ],
  };
  const { resolution } = await resolveConflict(input, w.deps);
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction-shape' && g.reason.includes('at most one')));
  for (const id of ['c1', 'c2']) assert.equal(byId(resolution)[id].explanation.relationship, 'unverified-correction');
});

test('unexplained same-scope conflict establishes a license dispute while the scalar stays unresolved', async () => {
  const w = world();
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('gpl', 'GPL-3.0', URL_GPL, RELEASE),
      alt('mit', 'MIT', URL_MIT, RELEASE),
    ],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(resolution.status, 'disputed');
  assert.equal(resolution.selected, undefined);
  assert.equal(resolution.dispute.established, true);
  assert.ok(resolution.dispute.sides.length >= 2, 'each side bound to a retained source');
  const sideValues = resolution.dispute.sides.map(s => s.value).sort();
  assert.deepEqual(sideValues, ['GPL-3.0', 'MIT']);
  for (const side of resolution.dispute.sides) {
    assert.ok(side.quote && side.quote.includes(side.value), 'side carries its validated quote');
  }
  assert.equal(engineResult.requirements.license.status, 'unresolved');
  assert.ok(engineResult.requirements.license.candidates.length >= 2);
  for (const a of resolution.alternatives) {
    assert.equal(a.explanation.relationship, 'unexplained-conflict');
    assert.ok(a.explanation.evidence.length >= 1);
  }
});

test('agreeing same-scope sources cannot establish a dispute (opposite values required)', async () => {
  const w = world();
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('mit-a', 'MIT', URL_MIT, RELEASE),
      alt('mit-b', 'MIT', URL_MIT_AGREE, RELEASE),
    ],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(resolution.dispute.established, false, 'same value on two origins is not two sides');
  assert.equal(resolution.dispute.sides, undefined, 'no sides published without establishment');
  assert.equal(engineResult.requirements.license.status, 'satisfied');
  assert.equal(resolution.selected, undefined, 'agreement alone is not a verified authority path');
  assert.equal(resolution.status, 'unresolved');
});

test('matched negative: a lone retained dispute source cannot establish a two-sided dispute', async () => {
  // The GPL notice's read fails; only the MIT page is retained. Whatever
  // the row says, one origin cannot prove opposite values on two sides.
  const w = world({ failReads: [URL_GPL] });
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('gpl', 'GPL-3.0', URL_GPL, RELEASE),
      alt('mit', 'MIT', URL_MIT, RELEASE),
    ],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.ok(engineResult.evidence.every(e => e.url !== URL_GPL));
  assert.equal(engineResult.requirements.license.status, 'satisfied');
  assert.equal(resolution.dispute.established, false);
  assert.equal(resolution.status, 'unresolved', 'one side is absence of evidence, not a dispute');
  assert.equal(resolution.selected, undefined);
});

test('declared mirrors are not acquisition targets; budget end preserves alternatives and gaps; local search results are refused', async () => {
  const w = world({ searchResults: [
    { url: MIRRORS[0], title: 'mirror copy' },
    { url: 'http://10.0.0.5/exampleapp/notice', title: 'local imposter' },
  ] });
  const input = correctionInput({ limits: { maxUniqueReads: 1, maxSearchAttempts: 1 } });
  input.alternatives[0].mirrors = MIRRORS.map(url => ({ url, title: 'mirror' }));
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.deepEqual(w.calls.read, [URL_GPL], 'one origin read from leads; no mirror lead, no refused URL');
  assert.equal(engineResult.usage.readsRetained, 1);
  assert.ok(resolution.notes.some(n => n.startsWith('search-result-refused:') && n.includes('10.0.0.5')));
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  const ids = byId(resolution);
  assert.deepEqual(ids.gpl.mirrors.map(m => m.url), MIRRORS);
  assert.equal(ids.gpl.explanation.relationship, 'unverified-correction');
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction'));
});

test('an unverified mirror claim cannot collapse another material alternative', async () => {
  const w = world();
  const input = {
    schemaVersion: 1,
    scope: { entity: ENTITY, release: RELEASE },
    alternatives: [
      alt('gpl', 'GPL-3.0', URL_GPL, RELEASE, { mirrors: [{ url: URL_MIT, title: 'claimed mirror' }] }),
      alt('mit', 'MIT', URL_MIT, RELEASE),
    ],
  };
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.ok(resolution.notes.some(n => n.startsWith('unverified-mirror-overlap:')));
  assert.deepEqual([...new Set(w.calls.read)].sort(), [URL_GPL, URL_MIT].sort(), 'both origins independently acquired');
  const ids = byId(resolution);
  assert.equal(ids.mit.source.url, URL_MIT, 'the alleged mirror keeps its own identity');
  assert.equal(ids.mit.explanation.relationship, 'unexplained-conflict', 'and stays a material blocker');
  assert.equal(resolution.status, 'disputed');
  assert.equal(resolution.selected, undefined);
  assert.ok(engineResult.evidence.some(e => e.url === URL_MIT));
});

test('out-of-scope claim without an excluding engine verdict stays a blocker', async () => {
  // The 2.3.0 notice's read fails: no retained record, no current engine
  // verdict can exclude it, so it must block selection even though the
  // correction and license obligations both complete.
  const w = world({ failReads: [URL_APACHE] });
  const { resolution, engineResult } = await resolveConflict(correctionInput(), w.deps);
  assert.equal(engineResult.requirements.correction.value, 'supported');
  assert.equal(engineResult.requirements.license.status, 'satisfied');
  assert.ok(engineResult.evidence.every(e => e.url !== URL_APACHE), 'no retained record for the out-of-scope claim');
  const ids = byId(resolution);
  assert.equal(ids.apache.explanation.relationship, 'scope-unverified', 'uncorroborated 2.3.0 claim cannot be partitioned away by assertion');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'coverage'));
});

test('pair-bound correction requires both records retained even when the judge accepts one-sided', async () => {
  // The superseded notice's read fails; the judge sees only the correcting
  // document and accepts one-sided, but the pair was never retained.
  const w = world({ failReads: [URL_GPL] });
  const input = correctionInput();
  input.alternatives = [input.alternatives[1], input.alternatives[0], input.alternatives[2]];
  const { resolution, engineResult } = await resolveConflict(input, w.deps);
  assert.equal(engineResult.requirements.correction.value, 'supported', 'one-sided judge accept happens');
  assert.ok(engineResult.evidence.every(e => e.url !== URL_GPL), 'superseded record never retained');
  assert.equal(resolution.status, 'unresolved');
  assert.equal(resolution.selected, undefined);
  assert.ok(resolution.gaps.some(g => g.requirement === 'correction' && g.reason.includes('not both retained')));
  assert.equal(byId(resolution).gpl.explanation.relationship, 'unverified-correction');
});

test('pre-aborted caller signal vetoes the projection with zero acquisition', async () => {
  const w = world();
  const controller = new AbortController();
  controller.abort();
  const outcome = await resolveConflict(correctionInput(), { ...w.deps, externalSignal: controller.signal });
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.resolution, null);
  assert.ok(Object.values(outcome.engineResult.requirements).every(row => row.reason === 'cancelled'));
  assert.equal(w.calls.read.length, 0, 'pre-aborted signal must mean zero acquisition');
  assert.equal(w.calls.search.length, 0);
});

test('abort after entered work vetoes the projection; retained evidence stays visible for audit', async () => {
  const w = world();
  const controller = new AbortController();
  const abortingRead = async (url, options) => {
    const content = await w.deps.read(url, options);
    if (w.calls.read.length === 1) controller.abort();
    return content;
  };
  const outcome = await resolveConflict(correctionInput(), { ...w.deps, read: abortingRead, externalSignal: controller.signal });
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.resolution, null);
  assert.ok(outcome.engineResult.evidence.length >= 1, 'audit-only evidence retained before the abort');
  assert.ok(Object.values(outcome.engineResult.requirements).some(row => row.reason === 'cancelled'));
});

test('malformed or inadmissible inventory fails before any acquisition', async () => {
  const w = world();
  const cases = [
    { schemaVersion: 2, scope: { entity: ENTITY, release: RELEASE }, alternatives: [alt('a', 'MIT', URL_MIT, RELEASE)] },
    { schemaVersion: 1, scope: { entity: '', release: RELEASE }, alternatives: [alt('a', 'MIT', URL_MIT, RELEASE)] },
    { schemaVersion: 1, scope: { entity: ENTITY, release: RELEASE }, alternatives: [] },
    { schemaVersion: 1, scope: { entity: ENTITY, release: RELEASE }, alternatives: [alt('a', 'MIT', 'ftp://nope/example', RELEASE)] },
    { schemaVersion: 1, scope: { entity: ENTITY, release: RELEASE }, alternatives: [alt('a', 'MIT', 'http://localhost/notice', RELEASE)] },
    { schemaVersion: 1, scope: { entity: ENTITY, release: RELEASE }, alternatives: [alt('a', 'MIT', 'http://192.168.1.4/notice', RELEASE)] },
    { schemaVersion: 1, scope: { entity: ENTITY, release: RELEASE }, alternatives: [
      alt('a', 'MIT', URL_MIT, RELEASE, { correctionOf: 'missing-id' }),
    ] },
    { schemaVersion: 1, scope: { entity: ENTITY, release: RELEASE }, alternatives: [
      alt('a', 'MIT', URL_MIT, RELEASE, { correctionOf: 'b' }),
      alt('b', 'GPL-3.0', URL_GPL, RELEASE, { correctionOf: 'a' }),
    ] },
    { schemaVersion: 1, scope: { entity: ENTITY, release: RELEASE }, alternatives: [
      alt('a', 'MIT', URL_MIT, RELEASE),
      alt('a', 'GPL-3.0', URL_GPL, RELEASE),
    ] },
    { schemaVersion: 1, scope: { entity: ENTITY, release: RELEASE }, limits: { maxUniqueReads: -1 }, alternatives: [alt('a', 'MIT', URL_MIT, RELEASE)] },
  ];
  for (const bad of cases) {
    await assert.rejects(() => resolveConflict(bad, w.deps), ValidationError);
  }
  assert.equal(w.calls.search.length, 0, 'validation failure must not acquire');
  assert.equal(w.calls.read.length, 0);
});
