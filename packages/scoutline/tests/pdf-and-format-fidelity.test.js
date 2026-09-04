import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";

import {
  isPdfBuffer,
  extractPdfText,
  repairPdf,
} from "../dist/lib/pdf.js";
import { read } from "../dist/commands/read.js";
import { createFakeReaderCapability } from "./helpers/fake-adapter.js";

describe("PDF Text Extraction & Format Fidelity", () => {
  describe("isPdfBuffer", () => {
    it("identifies valid PDF buffers", () => {
      const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj");
      assert.equal(isPdfBuffer(pdf), true);
      assert.equal(isPdfBuffer(Buffer.from("<html>Hello</html>")), false);
    });

    it("rejects non-PDF buffers that merely contain %PDF- in the middle", () => {
      const htmlWithPdfMarker = Buffer.from("<html><body>Check out this %PDF-1.4 spec</body></html>");
      assert.equal(isPdfBuffer(htmlWithPdfMarker), false);
    });
  });

  describe("extractPdfText (Pure Node fallback)", () => {
    it("extracts text from uncompressed PDF content streams", async () => {
      const pdfString = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 50 >>
stream
BT
72 712 Td
(Hello Evidentiary PDF World!) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
250
%%EOF`;

      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Hello Evidentiary PDF World!/);
    });

    it("extracts text from FlateDecode compressed streams", async () => {
      const contentStream = "BT 100 700 Td (Deflated PDF Stream Content) Tj ET";
      const compressed = zlib.deflateSync(Buffer.from(contentStream, "latin1"));

      const pdfHeader = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog >>
endobj
2 0 obj
<< /Filter /FlateDecode /Length ${compressed.length} >>
stream\n`, "latin1");

      const pdfFooter = Buffer.from(`\nendstream
endobj
trailer
<< /Size 3 >>
startxref
150
%%EOF`, "latin1");

      const fullPdf = Buffer.concat([pdfHeader, compressed, pdfFooter]);
      const text = await extractPdfText(fullPdf);
      assert.match(text, /Deflated PDF Stream Content/);
    });

    it("extracts text from TJ array operator with hex and kerning", async () => {
      const pdfString = `%PDF-1.4
1 0 obj
<< /Length 80 >>
stream
BT
[(Part1 ) -50 (Part2 ) <414243>] TJ
ET
endstream
endobj`;

      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Part1 Part2 ABC/);
    });

    it("extracts text with signed Td/TD operands and double quote operator", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 120 >>\nstream\nBT\n(Line 1) Tj\n0 -16 Td\n(Line 2) Tj\n(Line 3) "\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Line 1/);
      assert.match(text, /Line 2/);
      assert.match(text, /Line 3/);
    });

    it("does not truncate BT block when literal string contains ET", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 120 >>\nstream\nBT\n(see ET for details) Tj\n(second line) Tj\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /see ET for details/);
      assert.match(text, /second line/);
    });

    it("extracts text with double-quote operator with 2 numeric operands", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 120 >>\nstream\nBT\n0 0 (Heading text) "\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Heading text/);
    });

    it("extracts FlateDecode stream with nested DecodeParms dictionary", async () => {
      const streamContent = Buffer.from("BT\n(Nested Dict Text) Tj\nET\n");
      const compressed = zlib.deflateSync(streamContent);
      const prefix = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /DecodeParms << /Columns 4 >> /Length ${compressed.length} >>\nstream\n`);
      const suffix = Buffer.from("\nendstream\nendobj\n");
      const buffer = Buffer.concat([prefix, compressed, suffix]);
      const text = await extractPdfText(buffer);
      assert.match(text, /Nested Dict Text/);
    });

    it("decodes 2-byte Identity-H and UTF-16BE hex strings", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 100 >>\nstream\nBT\n<00480069> Tj\n<FEFF0057006F0072006C0064> Tj\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Hi/);
      assert.match(text, /World/);
    });

    it("extracts literal strings with escaped parentheses in quote operators", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 120 >>\nstream\nBT\n(prefix \\(suffix\\)) '\n0 0 (a \\(b\\) c) "\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /prefix \(suffix\)/);
      assert.match(text, /a \(b\) c/);
    });

    it("extracts text containing balanced nested parentheses in Tj", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 80 >>\nstream\nBT\n(Chapter (draft)) Tj\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Chapter \(draft\)/);
    });

    it("ignores BT ... ET blocks inside comments and metadata literals", async () => {
      // The fake literal ALSO appears inside the stream (outside any
      // BT/ET block) so the doesNotMatch assertion is non-vacuous: a
      // scanner that read string contents as operators would extract it.
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Title (BT Fake Title ET) /Length 120 >>\nstream\n% BT Stale Comment Text ET\nBT\n(Actual Visible Text) Tj\nET\n(BT Fake Title ET) Tj\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Actual Visible Text/);
      assert.doesNotMatch(text, /Fake Title/);
      assert.doesNotMatch(text, /Stale Comment Text/);
    });

    it("extracts literal strings with multiple nested parenthesis levels", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 80 >>\nstream\nBT\n(outer (mid (deep)) text) Tj\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /outer \(mid \(deep\)\) text/);
    });

    it("extracts hex-string operands for the quote operators", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 80 >>\nstream\nBT\n<0048 0069> '\n0 0 <0057 006F 0072> "\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Hi/);
      assert.match(text, /Wor/);
    });

    it("recognizes signed and leading-dot numeric operands for Td", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 120 >>\nstream\nBT\n-.5 4. Td (Line A) Tj\n0 -12.5 Td (Line B) Tj\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /Line A/);
      assert.match(text, /Line B/);
    });

    it("does not inject a space between successive Tj operands", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 80 >>\nstream\nBT\n(Hello) Tj (World) Tj\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.match(text, /HelloWorld/);
    });

    it("still serves best-effort text for unmappable CID hex when no external tool exists", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 80 >>\nstream\nBT\n<90A190A2> Tj\nET\nendstream\nendobj`;
      const buffer = Buffer.from(pdfString, "latin1");
      const text = await extractPdfText(buffer);
      assert.equal(typeof text, "string");
      assert.ok(text.length > 0, "low-confidence pure text must not be dropped when pdftotext is absent");
    });
  });

  describe("repairPdf (xref reconstruction)", () => {
    it("rebuilds xref table and trailer for damaged PDFs", async () => {
      const damagedPdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Count 0 >>
endobj
% missing xref and trailer completely!`, "latin1");

      const repaired = await repairPdf(damagedPdf);
      const repairedStr = repaired.toString("latin1");

      assert.match(repairedStr, /xref\n0 3/);
      assert.match(repairedStr, /trailer\n<< \/Size 3/);
      assert.match(repairedStr, /startxref/);
      assert.match(repairedStr, /%%EOF/);
    });

    it("points startxref directly at the xref keyword", async () => {
      const damagedPdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n`, "latin1");
      const repaired = await repairPdf(damagedPdf);
      const repairedStr = repaired.toString("latin1");
      const startxrefMatch = repairedStr.match(/startxref\n(\d+)\n%%EOF/);
      assert.ok(startxrefMatch, "repaired PDF must contain startxref");
      const offset = Number(startxrefMatch[1]);
      assert.equal(repaired.subarray(offset, offset + 4).toString("latin1"), "xref");
    });

    it("preserves exact byte offsets for objects located after stream bodies in repairPdf", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Length 20 >>\nstream\n12345678901234567890\nendstream\nendobj\n2 0 obj\n<< /Type /Catalog >>\nendobj\n`;
      const buffer = Buffer.from(pdfString, "latin1");
      const expectedOffsetObj2 = pdfString.indexOf("2 0 obj");
      const repaired = await repairPdf(buffer);
      const repairedStr = repaired.toString("latin1");
      const offsetStr = String(expectedOffsetObj2).padStart(10, "0");
      assert.match(repairedStr, new RegExp(`${offsetStr} 00000 n`));
    });

    it("safely handles giant object IDs without hanging", async () => {
      const hostilePdf = Buffer.from(`%PDF-1.4\n4000000000 0 obj\n<< /Type /Catalog >>\nendobj\n`, "latin1");
      const repaired = await repairPdf(hostilePdf);
      assert.ok(repaired instanceof Buffer);
    });

    it("preserves Encrypt and ID entries in repaired trailer", async () => {
      const damagedPdf = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R /ID [<1234><5678>] >>\n%%EOF`, "latin1");
      const repaired = await repairPdf(damagedPdf);
      const repairedStr = repaired.toString("latin1");
      assert.match(repairedStr, /\/Encrypt 2 0 R/);
      assert.match(repairedStr, /\/ID \[<1234><5678>\]/);
    });

    it("skips pure reconstruction for PDFs containing ObjStm", async () => {
      const objStmPdf = Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /ObjStm >>\nstream\n...\nendstream\nendobj\n`, "latin1");
      const repaired = await repairPdf(objStmPdf);
      const repairedStr = repaired.toString("latin1");
      assert.equal(repairedStr, objStmPdf.toString("latin1"));
    });

    it("does not treat /Type /ObjStm inside ordinary string data as an ObjStm object", async () => {
      const pdfString = `%PDF-1.5\n1 0 obj\n<< /Title (/Type /ObjStm lookalike) /Type /Catalog >>\nendobj\n`;
      const buffer = Buffer.from(pdfString, "latin1");
      const repaired = await repairPdf(buffer);
      assert.match(repaired.toString("latin1"), /startxref/, "repair must proceed when no real ObjStm dictionary exists");
    });

    it("does not build xref entries from object-like text inside strings", async () => {
      const pdfString = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Title (fake 2 0 obj endobj noise) >>\nendobj\n2 0 obj\n<< /Type /Pages >>\nendobj\n`;
      const buffer = Buffer.from(pdfString, "latin1");
      const repaired = await repairPdf(buffer);
      const repairedStr = repaired.toString("latin1");
      // The REAL object-2 header is the last occurrence; the first sits
      // inside the /Title string and must never win.
      const realObj2Offset = pdfString.lastIndexOf("2 0 obj");
      const fakeObj2Offset = pdfString.indexOf("2 0 obj");
      assert.notEqual(realObj2Offset, fakeObj2Offset, "fixture must contain both a fake and a real header");
      const offsetStr = String(realObj2Offset).padStart(10, "0");
      assert.match(repairedStr, new RegExp(`${offsetStr} 00000 n`), "xref for object 2 must point at the real header, not the string copy");
    });
  });

  describe("read provider-normalized fidelity", () => {
    it("rejects removed byte-exact modes (--raw/--pdf/--pdf-repair) at validation time", async () => {
      const mockDeps = {
        capability: {},
        execution: {},
      };
      await assert.rejects(
        () => read("https://example.com/doc.pdf", { pdf: "text" }, mockDeps),
        (err) => err.code === "VALIDATION_ERROR" && /fetch/.test(err.message),
      );
      await assert.rejects(
        () => read("https://example.com/doc.pdf", { raw: true }, mockDeps),
        (err) => err.code === "VALIDATION_ERROR" && /fetch/.test(err.message),
      );
      await assert.rejects(
        () => read("https://example.com/doc.pdf", { pdfRepair: true }, mockDeps),
        (err) => err.code === "VALIDATION_ERROR" && /fetch/.test(err.message),
      );
    });

    it("reports provider content and contentFormat verbatim without client-side relabeling", async () => {
      const rawXml = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Sample Feed</title><entry><title>Entry 1</title></entry></feed>`;

      const { capability } = createFakeReaderCapability({
        apiKey: "fake-key",
        provider: "zai",
        fetch: {
          result: {
            url: "https://example.com/atom.xml",
            finalUrl: "https://example.com/atom.xml",
            title: "Atom Feed",
            content: rawXml,
            contentFormat: "markdown",
          },
        },
      });

      const mockDeps = {
        capability,
        execution: {
          cache: { get: async () => null, set: async () => {} },
          sleep: async () => {},
          random: () => 0.5,
        },
      };

      const result = await read("https://example.com/atom.xml", {}, mockDeps);
      assert.equal(result.kind, "data");
      const envelope = result.data;
      // The envelope reports the provider's own format claim verbatim;
      // read no longer relabels normalized content as "raw".
      assert.equal(envelope.contentFormat, "markdown");
      assert.equal(envelope.content, rawXml);
    });
  });
});
