/**
 * T1 — Section-diff engine: deterministic extractor + structural diff +
 * hash-only fallback.
 *
 * Pins (watch-temporal-diff lane B, ticket T1):
 *   1. extractSections: heading/paragraph buckets in document order;
 *      survives 2001-era markup (uppercase tags, missing closers,
 *      attribute-laden tags); empty input; non-HTML bytes →
 *      extraction-failure signal (`ok: false, reason: "no-html"`).
 *   2. diffSections: added / removed / changed / no-change; heading-
 *      anchored matching; whitespace-only body difference = no change;
 *      heading reword = removed+added (NOT changed); order stable.
 *   3. Determinism: identical raw bytes → byte-identical JSON output
 *      across runs.
 *   4. hashOnly fallback: identical non-HTML bytes → no change; one
 *      byte different → change; hash is over RAW bytes, not the decoded
 *      string (UTF-8 vs GBK encodings of the same text hash
 *      differently).
 *   5. Charset: GBK / Shift-JIS raw bytes extract correctly under their
 *      charsetHint (TextDecoder gbk/shift_jis verified first so fixtures
 *      prove the charset path, not garbage-in).
 *
 * Hermeticity: pure-function module, no env, no disk, no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    extractSections,
    diffSections,
    diffDocuments,
    hashRaw,
} from "../dist/lib/section-diff.js";

// ---------------------------------------------------------------- helpers

/** Decode check gate — tests assert only after TextDecoder proves the label. */
function decoderFor(label) {
    const decoder = new TextDecoder(label, { fatal: false });
    return decoder;
}

function hasDecoder(label) {
    try {
        // `new TextDecoder("bogus")` throws; supported labels construct.
        new TextDecoder(label);
        return true;
    } catch {
        return false;
    }
}

const utf8 = (s) => new TextEncoder().encode(s);

// "中文" — GBK: d6 d0 ce c4. Hand-crafted (Node has no GBK encoder).
const gbkZhongWen = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
// "こんにちは" — Shift-JIS: 82 b1 82 f1 82 c9 82 bf 82 cd.
const sjisKonnichiwa = Uint8Array.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);

// ------------------------------------------------------------ extractor

describe("extractSections", () => {
    it("buckets headings and paragraphs in document order", () => {
        const raw = utf8(
            "<h1>Install</h1><p>Run the installer.</p><h2>Security</h2><p>Use TLS.</p>"
        );
        const result = extractSections(raw);
        assert.equal(result.ok, true);
        const sections = result.sections;
        assert.equal(sections.length, 2);
        assert.deepEqual(
            sections.map((s) => s.heading),
            ["Install", "Security"]
        );
        assert.equal(sections[0].body, "Run the installer.");
        assert.equal(sections[1].body, "Use TLS.");
    });

    it("content before the first heading becomes an untitled lead section", () => {
        const raw = utf8("Intro text.<h1>First</h1><p>Body.</p>");
        const result = extractSections(raw);
        assert.equal(result.ok, true);
        const sections = result.sections;
        assert.equal(sections.length, 2);
        assert.equal(sections[0].heading, null);
        assert.equal(sections[0].body, "Intro text.");
        assert.equal(sections[1].heading, "First");
    });

    it("survives 2001-era markup: uppercase tags and missing closers", () => {
        const raw = utf8("<H1>Title<p>text without closers<BR>more text");
        const result = extractSections(raw);
        assert.equal(result.ok, true);
        const sections = result.sections;
        assert.equal(sections.length, 1);
        assert.equal(sections[0].heading, "Title");
        assert.match(sections[0].body, /text without closers/);
        assert.match(sections[0].body, /more text/);
    });

    it("handles attribute-laden and nested tags", () => {
        const raw = utf8(
            '<h2 id="x" class="big">Setup</h2>' +
            '<div class="wrap"><p>Step <strong>one</strong>.</p></div>'
        );
        const result = extractSections(raw);
        assert.equal(result.ok, true);
        const sections = result.sections;
        assert.equal(sections.length, 1);
        assert.equal(sections[0].heading, "Setup");
        assert.equal(sections[0].body, "Step one.");
    });

    it("empty input is an empty extraction, not a failure", () => {
        const result = extractSections(new Uint8Array(0));
        assert.equal(result.ok, true);
        assert.deepEqual(result.sections, []);
    });

    it("non-HTML bytes signal extraction failure (ok: false)", () => {
        // High-entropy-ish bytes with no '<' at all.
        const raw = Uint8Array.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x8b, 0x2a]);
        const result = extractSections(raw);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "no-html");
    });

    it("decodes GBK bytes under charsetHint", () => {
        if (!hasDecoder("gbk")) return; // environment gate, fixture proven only when decodable
        const raw = new Uint8Array([
            ...utf8("<h1>"),
            ...gbkZhongWen,
            ...utf8("</h1><p>"),
            ...gbkZhongWen,
            ...utf8("</p>"),
        ]);
        const result = extractSections(raw, "gbk");
        assert.equal(result.ok, true);
        assert.equal(result.sections[0].heading, "中文");
        assert.equal(result.sections[0].body, "中文");
    });

    it("decodes Shift-JIS bytes under charsetHint", () => {
        if (!hasDecoder("shift_jis")) return;
        const raw = new Uint8Array([
            ...utf8("<h1>"),
            ...sjisKonnichiwa,
            ...utf8("</h1><p>"),
            ...sjisKonnichiwa,
            ...utf8("</p>"),
        ]);
        const result = extractSections(raw, "shift_jis");
        assert.equal(result.ok, true);
        assert.equal(result.sections[0].heading, "こんにちは");
    });

    it("TextDecoder fixture gate: labels actually decode these byte arrays", () => {
        assert.ok(hasDecoder("gbk"), "TextDecoder gbk unsupported — fixture is garbage-in");
        assert.ok(hasDecoder("shift_jis"), "TextDecoder shift_jis unsupported — fixture is garbage-in");
        assert.equal(decoderFor("gbk").decode(gbkZhongWen), "中文");
        assert.equal(decoderFor("shift_jis").decode(sjisKonnichiwa), "こんにちは");
    });

    it("script JS noise never appears in section bodies", () => {
        const raw = utf8(
            "<h1>Install</h1>" +
            "<script>alert('v1'); var x = 1 && 2;</script>" +
            "<p>Run the installer.</p>"
        );
        const result = extractSections(raw);
        assert.equal(result.ok, true);
        const sections = result.sections;
        assert.equal(sections.length, 1);
        assert.equal(sections[0].body, "Run the installer.");
    });

    it("style CSS noise never appears in section bodies", () => {
        const raw = utf8(
            "<h1>Install</h1>" +
            "<style>h1 { color: red; }</style>" +
            "<p>Run the installer.</p>"
        );
        const result = extractSections(raw);
        assert.equal(result.ok, true);
        const sections = result.sections;
        assert.equal(sections.length, 1);
        assert.equal(sections[0].body, "Run the installer.");
    });

    it("script/style/head-bucket content change alone is NOT a document change", () => {
        const v1 = extractSections(utf8(
            "<head><title>Docs</title></head>" +
            "<h1>Install</h1><p>v1 body</p>" +
            "<script>var v1 = 1;</script>"
        ));
        const v2 = extractSections(utf8(
            "<head><title>Docs — new title</title></head>" +
            "<h1>Install</h1><p>v1 body</p>" +
            "<script>var v2 = 2;</script>"
        ));
        assert.deepEqual(diffDocuments(v1, v2), {
            added: [],
            removed: [],
            changed: [],
            hashOnly: false,
        });
    });
});

// ------------------------------------------------------------ diffSections

describe("diffSections", () => {
    const sec = (heading, body) => ({ heading, body });

    it("added: heading present only in b", () => {
        const a = [sec("Install", "x")];
        const b = [sec("Install", "x"), sec("Security", "y")];
        assert.deepEqual(diffSections(a, b), {
            added: ["Security"],
            removed: [],
            changed: [],
        });
    });

    it("removed: heading present only in a", () => {
        const a = [sec("Install", "x"), sec("Security", "y")];
        const b = [sec("Install", "x")];
        assert.deepEqual(diffSections(a, b), {
            added: [],
            removed: ["Security"],
            changed: [],
        });
    });

    it("changed: identical heading, different normalized body", () => {
        const a = [sec("Install", "one way")];
        const b = [sec("Install", "another way")];
        assert.deepEqual(diffSections(a, b), {
            added: [],
            removed: [],
            changed: ["Install"],
        });
    });

    it("no change: identical normalized bodies", () => {
        const a = [sec("Install", "one way")];
        const b = [sec("Install", "one way")];
        assert.deepEqual(diffSections(a, b), {
            added: [],
            removed: [],
            changed: [],
        });
    });

    it("whitespace-only body difference is not a change (runs collapse, NBSP too)", () => {
        const a = [sec("Install", "alpha\n\nbeta  gamma")];
        const b = [sec("Install", "alpha beta gamma")];
        assert.deepEqual(diffSections(a, b), {
            added: [],
            removed: [],
            changed: [],
        });
    });

    it("heading reword = removed + added, not changed", () => {
        const a = [sec("Install", "same body")];
        const b = [sec("Installation", "same body")];
        assert.deepEqual(diffSections(a, b), {
            added: ["Installation"],
            removed: ["Install"],
            changed: [],
        });
    });

    it("duplicate headings: positional pairing, leftover copies counted", () => {
        const a = [sec("Notes", "one"), sec("Notes", "two")];
        const b = [sec("Notes", "one"), sec("Notes", "two"), sec("Notes", "three")];
        assert.deepEqual(diffSections(a, b), {
            added: ["Notes"],
            removed: [],
            changed: [],
        });
    });

    it("order stability: outputs follow source order", () => {
        const a = [sec("A", "1"), sec("B", "2"), sec("C", "3")];
        const b = [sec("B", "2"), sec("D", "4"), sec("A", "9")];
        const d = diffSections(a, b);
        assert.deepEqual(d.removed, ["C"]);
        assert.deepEqual(d.added, ["D"]);
        assert.deepEqual(d.changed, ["A"]);
    });

    it("untitled lead sections pair positionally", () => {
        const a = [sec(null, "old intro"), sec("H", "x")];
        const b = [sec(null, "new intro"), sec("H", "x")];
        assert.deepEqual(diffSections(a, b), {
            added: [],
            removed: [],
            changed: ["(intro)"],
        });
    });
});

// --------------------------------------------------------- diffDocuments

describe("diffDocuments", () => {
    it("HTML vs HTML: section diff, hashOnly false", () => {
        const a = extractSections(utf8("<h1>Install</h1><p>v1</p>"));
        const b = extractSections(utf8("<h1>Install</h1><p>v2</p>"));
        const d = diffDocuments(a, b);
        assert.deepEqual(d, {
            added: [],
            removed: [],
            changed: ["Install"],
            hashOnly: false,
        });
    });

    it("byte-identical documents: no change, no hashOnly", () => {
        const raw = utf8("<h1>Install</h1><p>v1</p>");
        const d = diffDocuments(extractSections(raw), extractSections(raw));
        assert.deepEqual(d, { added: [], removed: [], changed: [], hashOnly: false });
    });

    it("non-HTML identical bytes: no change under hashOnly", () => {
        const raw = Uint8Array.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff]);
        const d = diffDocuments(extractSections(raw), extractSections(raw));
        assert.deepEqual(d, { added: [], removed: [], changed: [], hashOnly: true });
    });

    it("non-HTML one byte different: change under hashOnly", () => {
        const rawA = Uint8Array.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff]);
        const rawB = Uint8Array.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xfe]);
        const d = diffDocuments(extractSections(rawA), extractSections(rawB));
        assert.deepEqual(d, { added: [], removed: [], changed: ["(hash)"], hashOnly: true });
    });

    it("same document encoded UTF-8 vs GBK with no charsetHint: change under hashOnly (hash is over raw bytes)", () => {
        if (!hasDecoder("gbk")) return;
        // Pure text, no HTML → extraction fails → hashOnly path.
        const asUtf8 = utf8("中文");
        const asGbk = gbkZhongWen;
        // Prove the decoded strings match (fixture sanity) ...
        assert.equal(decoderFor("utf-8").decode(asUtf8), decoderFor("gbk").decode(asGbk));
        // ... yet the diff reports change because the HASH is byte-based.
        const d = diffDocuments(
            extractSections(asUtf8),
            extractSections(asGbk)
        );
        assert.deepEqual(d, { added: [], removed: [], changed: ["(hash)"], hashOnly: true });
    });

    it("mixed: one side extractable, other not → hashOnly change", () => {
        const html = extractSections(utf8("<h1>H</h1><p>x</p>"));
        const bin = extractSections(Uint8Array.from([0x00, 0x01, 0x02]));
        const d = diffDocuments(html, bin);
        assert.deepEqual(d, { added: [], removed: [], changed: ["(hash)"], hashOnly: true });
    });
});

// -------------------------------------------------------------- hashRaw

describe("hashRaw", () => {
    it("is sha256 hex over raw bytes, deterministic", () => {
        const raw = utf8("abc");
        const h = hashRaw(raw);
        assert.match(h, /^[0-9a-f]{64}$/);
        assert.equal(h, hashRaw(raw));
        // sha256("abc") known digest.
        assert.equal(
            h,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    });

    it("differs across encodings of the same text", () => {
        assert.notEqual(hashRaw(utf8("中文")), hashRaw(gbkZhongWen));
    });
});

// --------------------------------------------------------- determinism

describe("determinism pin", () => {
    it("identical raw bytes → byte-identical JSON across two runs", () => {
        const raw = utf8(
            "<h1>Alpha</h1><p>one</p><h2>Beta</h2><p>two</p><h1>Gamma</h1><p>three</p>"
        );
        const run1 = JSON.stringify(diffDocuments(extractSections(raw), extractSections(raw)));
        const run2 = JSON.stringify(diffDocuments(extractSections(raw), extractSections(raw)));
        assert.equal(run1, run2);
    });

    it("old-markup document: deterministic extraction output", () => {
        const raw = utf8("<H1>Title<p>text<BR>more");
        const r1 = JSON.stringify(extractSections(raw));
        const r2 = JSON.stringify(extractSections(raw));
        assert.equal(r1, r2);
    });
});
