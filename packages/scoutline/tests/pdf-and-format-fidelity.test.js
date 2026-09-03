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

    it("safely handles giant object IDs without hanging", async () => {
      const hostilePdf = Buffer.from(`%PDF-1.4\n4000000000 0 obj\n<< /Type /Catalog >>\nendobj\n`, "latin1");
      const repaired = await repairPdf(hostilePdf);
      assert.ok(repaired instanceof Buffer);
    });
  });

  describe("read --raw format fidelity", () => {
    it("rejects invalid --pdf options at validation time", async () => {
      const mockDeps = {
        capability: {},
        execution: {},
      };
      await assert.rejects(
        () => read("https://example.com/doc.pdf", { pdf: "invalid-mode" }, mockDeps),
        { name: "ValidationError" },
      );
    });

    it("preserves raw format and content without markdown conversion when --raw is set", async () => {
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

      const result = await read("https://example.com/atom.xml", { raw: true }, mockDeps);
      assert.equal(result.kind, "data");
      const envelope = result.data;
      assert.equal(envelope.contentFormat, "raw");
      assert.equal(envelope.content, rawXml);
    });
  });
});
