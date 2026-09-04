/**
 * PDF text extraction and structural repair module (ADR-0006).
 *
 * Hybrid architecture:
 *   1. Opportunistic system delegation to `pdftotext` and `qpdf` when installed.
 *   2. Self-contained pure-Node fallback using zlib stream inflation and
 *      PDF text operator extraction (BT/ET, Tj, TJ, Td, hex strings) so Scoutline
 *      runs without mandatory system dependencies.
 */

import * as zlib from "node:zlib";
import { spawn } from "node:child_process";

/**
 * Check whether a buffer begins with a valid PDF header (%PDF-).
 */
export function isPdfBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 5) return false;
  const header = buffer.subarray(0, 1024).toString("latin1").trimStart();
  return header.startsWith("%PDF-");
}

/**
 * Decode a PDF literal string (...), handling escape sequences.
 */
function decodePdfLiteralString(str: string): string {
  let result = "";
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\\") {
      i++;
      if (i >= str.length) break;
      const ch = str[i];
      if (ch === "n") {
        result += "\n";
        i++;
      } else if (ch === "r") {
        result += "\r";
        i++;
      } else if (ch === "t") {
        result += "\t";
        i++;
      } else if (ch === "b") {
        result += "\b";
        i++;
      } else if (ch === "f") {
        result += "\f";
        i++;
      } else if (ch === "(" || ch === ")" || ch === "\\") {
        result += ch;
        i++;
      } else if (/[0-7]/.test(ch!)) {
        // Octal escape \ddd (1 to 3 octal digits)
        let octalStr = ch!;
        i++;
        if (i < str.length && /[0-7]/.test(str[i]!)) {
          octalStr += str[i];
          i++;
          if (i < str.length && /[0-7]/.test(str[i]!)) {
            octalStr += str[i];
            i++;
          }
        }
        result += String.fromCharCode(parseInt(octalStr, 8));
      } else if (ch === "\r" || ch === "\n") {
        // Line continuation
        if (ch === "\r" && i + 1 < str.length && str[i + 1] === "\n") i++;
        i++;
      } else {
        result += ch;
        i++;
      }
    } else {
      result += str[i];
      i++;
    }
  }
  return result;
}

/**
 * Decode a PDF hex string <...>. Returns the decoded text plus a
 * `unmappable` flag: hex bytes that are neither a UTF-16BE BOM sequence
 * nor the 2-byte Identity-H ASCII pattern cannot be authoritatively
 * decoded without the font's ToUnicode/encoding context, so callers
 * treat a document containing them as low-confidence and prefer the
 * external text layer (`pdftotext`) when available.
 */
function decodePdfHexString(hex: string): { text: string; unmappable: boolean } {
  const clean = hex.replace(/\s+/g, "");
  const padded = clean.length % 2 !== 0 ? clean + "0" : clean;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    const byte = parseInt(padded.slice(i, i + 2), 16);
    if (!isNaN(byte)) {
      bytes.push(byte);
    }
  }

  // Check if hex is UTF-16BE with BOM (\xFE\xFF)
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let res = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i]! << 8) | bytes[i + 1]!;
      res += String.fromCharCode(code);
    }
    return { text: res, unmappable: false };
  }

  // Check if 2-byte Identity-H ASCII (e.g. <00480069> -> "Hi")
  if (bytes.length >= 2 && bytes.length % 2 === 0) {
    let isTwoByteAscii = true;
    for (let i = 0; i < bytes.length; i += 2) {
      if (bytes[i] !== 0x00 || bytes[i + 1]! < 0x20 || bytes[i + 1]! > 0x7e) {
        isTwoByteAscii = false;
        break;
      }
    }
    if (isTwoByteAscii) {
      let res = "";
      for (let i = 0; i < bytes.length; i += 2) {
        res += String.fromCharCode(bytes[i + 1]!);
      }
      return { text: res, unmappable: false };
    }
  }

  let result = "";
  for (const byte of bytes) {
    result += String.fromCharCode(byte);
  }
  // High bytes without a recognized 2-byte structure: likely CID or a
  // simple-font encoding we have no table for.
  const unmappable = bytes.some((b) => b > 0x7e);
  return { text: result, unmappable };
}

/**
 * Read a balanced PDF literal string starting at `start` (which must
 * point at the opening "("). Nested parentheses are literal characters
 * per the spec; escapes are decoded. Returns the decoded value, the
 * index just past the closing ")", and an `unmappable` flag set when
 * the decoded text contains high bytes — literal strings share the
 * hex strings' limitation (no font/ToUnicode context), so callers mark
 * the document low-confidence and prefer the external text layer.
 */
function readLiteralStringAt(src: string, start: number): {
  value: string;
  next: number;
  unmappable: boolean;
} {
  let depth = 0;
  let i = start;
  let raw = "";
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      raw += ch + (src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (depth > 1) raw += ch;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
      raw += ch;
      i++;
      continue;
    }
    raw += ch;
    i++;
  }
  const value = decodePdfLiteralString(raw);
  return { value, next: i, unmappable: /[^\x00-\x7e]/.test(value) };
}

/**
 * Read a PDF number at `start` (integer or real, optional sign, leading
 * dot like `-.5` and trailing dot like `4.` per the PDF grammar).
 */
function readNumberAt(src: string, start: number): { value: number; next: number } {
  let i = start;
  if (src[i] === "+" || src[i] === "-") i++;
  while (i < src.length && /[0-9.]/.test(src[i]!)) i++;
  const value = Number(src.slice(start, i));
  return { value: isNaN(value) ? 0 : value, next: i };
}

/**
 * Extract BT ... ET text blocks from a content stream, respecting literal strings
 * and comments so that "ET" occurring inside a string does not prematurely terminate the block.
 */
function extractBtBlocks(streamStr: string): string[] {
  const blocks: string[] = [];
  const len = streamStr.length;
  let i = 0;
  let outerInComment = false;
  let outerInString = false;
  let outerParenDepth = 0;
  let outerInHex = false;

  while (i < len) {
    const ch = streamStr[i];

    if (outerInComment) {
      if (ch === "\r" || ch === "\n") outerInComment = false;
      i++;
      continue;
    }
    if (outerInHex) {
      if (ch === ">") outerInHex = false;
      i++;
      continue;
    }
    if (outerInString) {
      if (ch === "\\") {
        i += 2;
      } else if (ch === "(") {
        outerParenDepth++;
        i++;
      } else if (ch === ")") {
        outerParenDepth--;
        if (outerParenDepth === 0) outerInString = false;
        i++;
      } else {
        i++;
      }
      continue;
    }

    if (ch === "%") {
      outerInComment = true;
      i++;
      continue;
    }
    if (ch === "<") {
      // Consume both characters of a dictionary opener: advancing one
      // char at a time would make the second "<" look like a lone
      // hex-string opener and mask the dictionary body.
      if (streamStr[i + 1] === "<") {
        i += 2;
        continue;
      }
      outerInHex = true;
      i++;
      continue;
    }
    if (ch === "(") {
      outerInString = true;
      outerParenDepth = 1;
      i++;
      continue;
    }

    if (
      (i === 0 || /[\s\[\]<>()/%]/.test(streamStr[i - 1]!)) &&
      streamStr.slice(i, i + 2) === "BT" &&
      (i + 2 === len || /[\s\[\]<>()/%]/.test(streamStr[i + 2]!))
    ) {
      i += 2;
      const start = i;
      let inString = false;
      let parenDepth = 0;
      let inHex = false;
      let inComment = false;

      while (i < len) {
        const c = streamStr[i];

        if (inComment) {
          if (c === "\r" || c === "\n") inComment = false;
        } else if (inHex) {
          if (c === ">") inHex = false;
        } else if (inString) {
          if (c === "\\") {
            i++;
          } else if (c === "(") {
            parenDepth++;
          } else if (c === ")") {
            parenDepth--;
            if (parenDepth === 0) inString = false;
          }
        } else {
          if (c === "%") {
            inComment = true;
          } else if (c === "<" && streamStr[i + 1] === "<") {
            i++; // first "<" of "<<"; the shared tail i++ consumes the second
          } else if (c === "<") {
            inHex = true;
          } else if (c === "(") {
            inString = true;
            parenDepth = 1;
          } else if (
            (i === 0 || /[\s\[\]<>()/%]/.test(streamStr[i - 1]!)) &&
            streamStr.slice(i, i + 2) === "ET" &&
            (i + 2 === len || /[\s\[\]<>()/%]/.test(streamStr[i + 2]!))
          ) {
            blocks.push(streamStr.slice(start, i));
            i += 2;
            break;
          }
        }
        i++;
      }
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Parse text operators from a decompressed PDF content stream using a
 * tokenizer rather than operand regexes: balanced literal strings
 * (arbitrary nesting), hex strings, PDF reals (signed, leading/trailing
 * dot), TJ arrays, and the full set of text-showing operators (Tj, TJ,
 * ', ") are recognized so valid content is not silently dropped.
 * `ctx.sawUnmappable` is set when a hex or literal string cannot be
 * decoded with confidence (CID/unknown encoding, high bytes) so the
 * caller can prefer the external text layer.
 */
function parseContentStreamText(
  streamStr: string,
  ctx: { sawUnmappable: boolean },
): string {
  type Operand =
    | { type: "str"; value: string }
    | { type: "hex"; value: string; unmappable: boolean }
    | { type: "num"; value: number }
    | { type: "array"; items: Operand[] };

  const lines: string[] = [];
  let currentLine = "";

  const pushLine = () => {
    if (currentLine.trim().length > 0) {
      lines.push(currentLine.trim());
      currentLine = "";
    }
  };
  const appendText = (value: string) => {
    if (value.length > 0) currentLine += value;
  };

  for (const block of extractBtBlocks(streamStr)) {
    const stack: Operand[] = [];

    const readHexStringOperand = (index: number): { operand: Operand; next: number } => {
      const end = block.indexOf(">", index);
      const close = end === -1 ? block.length : end;
      const decoded = decodePdfHexString(block.slice(index + 1, close));
      if (decoded.unmappable) ctx.sawUnmappable = true;
      return {
        operand: { type: "hex", value: decoded.text, unmappable: decoded.unmappable },
        next: end === -1 ? block.length : end + 1,
      };
    };

    let i = 0;
    while (i < block.length) {
      const ch = block[i]!;

      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (ch === "%") {
        while (i < block.length && block[i] !== "\r" && block[i] !== "\n") i++;
        continue;
      }
      if (ch === "(") {
        const { value, next, unmappable } = readLiteralStringAt(block, i);
        if (unmappable) ctx.sawUnmappable = true;
        stack.push({ type: "str", value });
        i = next;
        continue;
      }
      if (ch === "<" && block[i + 1] === "<") {
        // Inline dictionary: skip with bracket balance.
        let depth = 1;
        i += 2;
        while (i < block.length && depth > 0) {
          if (block.slice(i, i + 2) === "<<") {
            depth++;
            i += 2;
          } else if (block.slice(i, i + 2) === ">>") {
            depth--;
            i += 2;
          } else {
            i++;
          }
        }
        continue;
      }
      if (ch === "<") {
        const { operand, next } = readHexStringOperand(i);
        stack.push(operand);
        i = next;
        continue;
      }
      if (ch === "[") {
        // TJ array: strings and kerning numbers until the closing "]".
        const items: Operand[] = [];
        i++;
        while (i < block.length && block[i] !== "]") {
          const c = block[i]!;
          if (/\s/.test(c)) {
            i++;
          } else if (c === "(") {
            const { value, next, unmappable } = readLiteralStringAt(block, i);
            if (unmappable) ctx.sawUnmappable = true;
            items.push({ type: "str", value });
            i = next;
          } else if (c === "<") {
            const end = block.indexOf(">", i);
            const close = end === -1 ? block.length : end;
            const decoded = decodePdfHexString(block.slice(i + 1, close));
            if (decoded.unmappable) ctx.sawUnmappable = true;
            items.push({ type: "hex", value: decoded.text, unmappable: decoded.unmappable });
            i = end === -1 ? block.length : end + 1;
          } else if (/[0-9+.\-]/.test(c)) {
            const { value, next } = readNumberAt(block, i);
            items.push({ type: "num", value });
            i = next;
          } else {
            i++;
          }
        }
        i++; // consume "]"
        stack.push({ type: "array", items });
        continue;
      }
      if (/[0-9+.\-]/.test(ch)) {
        const { value, next } = readNumberAt(block, i);
        stack.push({ type: "num", value });
        i = next;
        continue;
      }

      // Operator keyword (letters, apostrophe, double quote, asterisk).
      let j = i;
      while (j < block.length && /[A-Za-z'*"]/.test(block[j]!)) j++;
      const op = block.slice(i, j);
      i = j;
      if (op.length === 0) {
        i++;
        continue;
      }

      const top = stack[stack.length - 1];
      switch (op) {
        case "Tj":
          // Successive Tj operators continue at the current text
          // position: no injected space between operands.
          if (top && (top.type === "str" || top.type === "hex")) appendText(top.value);
          break;
        case "TJ":
          if (top?.type === "array") {
            for (const item of top.items) {
              if (item.type === "str" || item.type === "hex") appendText(item.value);
            }
          }
          break;
        case "T*":
        case "Td":
        case "TD":
          pushLine();
          break;
        case "'":
        case '"': {
          // Move to the next line and show text: aw/ac operands sit
          // below the string on the operand stack.
          pushLine();
          if (top && (top.type === "str" || top.type === "hex")) appendText(top.value + " ");
          break;
        }
        default:
          break; // operators without direct text semantics
      }
    }

    pushLine();
  }

  return lines.join("\n");
}

/**
 * Parse a stream dictionary's /Filter entry into an ordered chain.
 * Handles both `/Filter /Name` and `/Filter [/A /B]` forms; an absent
 * entry yields an empty chain (unfiltered).
 */
function parseFilterChain(dictSlice: string): string[] {
  const arrayMatch = /\/Filter\s*\[([^\]]*)\]/.exec(dictSlice);
  if (arrayMatch) {
    return (arrayMatch[1]!.match(/\/[A-Za-z0-9]+/g) ?? []).map((name) => name.slice(1));
  }
  const single = /\/Filter\s*(\/[A-Za-z0-9]+)/.exec(dictSlice);
  return single ? [single[1]!.slice(1)] : [];
}

/**
 * Heuristic content-role check: streams whose dictionary marks them as
 * embedded images, object/metadata containers, or font programs are
 * not page content and must not contribute text.
 */
function isNonContentDictionary(dictSlice: string): boolean {
  return /\/Subtype\s*\/Image\b|\/Type\s*\/ObjStm\b|\/Type\s*\/Metadata\b|\/Length1\b|\/FontFile\d?\b/.test(
    dictSlice,
  );
}

/**
 * Locate a stream's own dictionary by balancing brackets backward from
 * the ">>" nearest the keyword (within the window). Imperfect for ">>"
 * inside dictionary strings, but /Length sits early in real stream
 * dictionaries and resolveStreamInterval validates before trusting it.
 */
function scanBackwardDictionary(fileStr: string, keywordStart: number, window = 2000): string {
  const beforeStream = fileStr.slice(Math.max(0, keywordStart - window), keywordStart).trimEnd();
  const lastDictEnd = beforeStream.lastIndexOf(">>");
  if (lastDictEnd === -1) return "";
  let depth = 1;
  let pos = lastDictEnd;
  while (pos > 1) {
    if (beforeStream.slice(pos - 2, pos) === ">>") {
      depth++;
      pos -= 2;
    } else if (beforeStream.slice(pos - 2, pos) === "<<") {
      depth--;
      pos -= 2;
      if (depth === 0) {
        return beforeStream.slice(pos, lastDictEnd + 2);
      }
    } else {
      pos--;
    }
  }
  return "";
}

/**
 * Resolve an indirect /Length (N G R) by reading the integer the
 * referenced object holds. Returns null when the reference or object
 * cannot be resolved.
 */
function resolveIndirectLength(fileStr: string, maskedDict: string): number | null {
  const ref = /\/Length\s+(\d+)\s+(\d+)\s+R\b/.exec(maskedDict);
  if (!ref) return null;
  const header = `${ref[1]} ${ref[2]} obj`;
  const at = fileStr.indexOf(header);
  if (at === -1) return null;
  let p = at + header.length;
  while (p < fileStr.length && /\s/.test(fileStr[p]!)) p++;
  const num = /^(\d+)/.exec(fileStr.slice(p, p + 16));
  return num ? Number(num[1]) : null;
}

/**
 * Resolve a stream body interval: [bodyStart, dataEnd) plus the index
 * to resume scanning from (past the real endstream keyword). Primary
 * signal is the dictionary /Length, VALIDATED against a following
 * endstream keyword, so embedded "endstream" bytes inside stream data
 * cannot truncate the stream or leak stream interiors into syntax
 * scans. The textual search is only a fallback for absent or indirect
 * (/Length 12 0 R) or non-validating lengths.
 */
function resolveStreamInterval(
  fileStr: string,
  keywordStart: number,
  dictSlice: string,
): { bodyStart: number; dataEnd: number; resumeAfter: number } {
  let bodyStart = keywordStart + "stream".length;
  if (fileStr[bodyStart] === "\r") bodyStart++;
  if (fileStr[bodyStart] === "\n") bodyStart++;

  let keywordAt = fileStr.indexOf("endstream", bodyStart);
  let dataEnd = keywordAt === -1 ? fileStr.length : keywordAt;

  // Direct /Length N (the lookahead avoids reading the object number of
  // an indirect /Length N G R as a direct length); indirect lengths are
  // resolved from their integer object so generators that use them do
  // not fall back to a textual endstream search that can stop at an
  // embedded "endstream" sequence inside the stream body.
  const lengthMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictSlice);
  const declared =
    lengthMatch !== null
      ? Number(lengthMatch[1])
      : resolveIndirectLength(fileStr, dictSlice);
  if (declared !== null) {
    let probe = bodyStart + declared;
    if (fileStr[probe] === "\r") probe++;
    if (fileStr[probe] === "\n") probe++;
    if (fileStr.startsWith("endstream", probe)) {
      dataEnd = bodyStart + declared;
      keywordAt = probe;
    }
  }
  const resumeAfter = keywordAt === -1 ? fileStr.length : keywordAt + "endstream".length;
  return { bodyStart, dataEnd, resumeAfter };
}

/**
 * Read the dictionary that starts at/after `i` (leading whitespace
 * tolerated), balancing << >> while skipping literal strings, hex
 * strings, and comments so delimiters inside string data cannot
 * unbalance the walk. Returns the dictionary text and the index just
 * past its closing ">>" (or end of input when unterminated).
 */
function readObjectDictionaryAt(fileStr: string, i: number): { text: string; next: number } {
  let p = i;
  while (p < fileStr.length) {
    if (/\s/.test(fileStr[p]!)) {
      p++;
      continue;
    }
    // Object headers may carry comments before the dictionary opener.
    if (fileStr[p] === "%") {
      while (p < fileStr.length && fileStr[p] !== "\r" && fileStr[p] !== "\n") p++;
      continue;
    }
    break;
  }
  if (fileStr.slice(p, p + 2) !== "<<") return { text: "", next: i };
  const start = p;
  let depth = 1;
  p += 2;
  while (p < fileStr.length && depth > 0) {
    const ch = fileStr[p]!;
    if (ch === "%") {
      while (p < fileStr.length && fileStr[p] !== "\r" && fileStr[p] !== "\n") p++;
    } else if (ch === "(") {
      let sDepth = 1;
      p++;
      while (p < fileStr.length && sDepth > 0) {
        const c = fileStr[p]!;
        if (c === "\\") {
          p += 2;
          continue;
        }
        if (c === "(") sDepth++;
        else if (c === ")") sDepth--;
        p++;
      }
    } else if (ch === "<" && fileStr[p + 1] !== "<") {
      const gt = fileStr.indexOf(">", p);
      p = gt === -1 ? fileStr.length : gt + 1;
    } else if (fileStr.slice(p, p + 2) === "<<") {
      depth++;
      p += 2;
    } else if (fileStr.slice(p, p + 2) === ">>") {
      depth--;
      p += 2;
    } else {
      p++;
    }
  }
  return { text: fileStr.slice(start, p), next: p };
}

/**
 * Built-in pure-Node text extraction by scanning PDF streams. Returns
 * the text plus a low-confidence flag set when any hex string could not
 * be decoded with font context (CID/unknown encoding) — such text is a
 * Latin-1 best effort, and callers should prefer the external layer.
 */
function extractPureNodePdfText(buffer: Buffer): { text: string; lowConfidence: boolean } {
  const fileStr = buffer.toString("latin1");
  const extractedSections: string[] = [];
  const ctx = { sawUnmappable: false };
  const MAX_TOTAL_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB across document
  let totalDecompressedBytes = 0;

  // Stream keyword scan; body intervals come from the dictionary
  // /Length via resolveStreamInterval (validated against the real
  // endstream keyword), so embedded "endstream" bytes inside stream
  // data cannot truncate a stream. The "end" prefix guard keeps the
  // tail of "endstream" keywords from matching as stream starts.
  const streamKeywordRegex = /stream\r?\n/g;
  let match: RegExpExecArray | null;

  while ((match = streamKeywordRegex.exec(fileStr)) !== null) {
    const keywordStart = match.index;
    if (fileStr.slice(Math.max(0, keywordStart - 3), keywordStart) === "end") continue;
    const dictSlice = maskStringsAndComments(scanBackwardDictionary(fileStr, keywordStart));
    const interval = resolveStreamInterval(fileStr, keywordStart, dictSlice);
    streamKeywordRegex.lastIndex = interval.resumeAfter;
    const rawStreamSlice = buffer.subarray(interval.bodyStart, interval.dataEnd);

    // Filter-chain classification (R6-C): the pure path can only
    // decode an unfiltered stream or a single FlateDecode. Anything
    // else (e.g. [/ASCII85Decode /FlateDecode]) marks the document
    // low-confidence instead of silently skipping the stream while a
    // nonempty partial result suppresses pdftotext. The dictionary is
    // masked so /Filter or marker text inside strings/comments cannot
    // impersonate the real entries.
    const filterChain = parseFilterChain(dictSlice);
    const flateOnly = filterChain.length === 1 && filterChain[0] === "FlateDecode";

    // Non-content streams (embedded images, object/metadata containers,
    // font programs) must not contribute text even when their bytes
    // look like content syntax. Full page-resource-graph resolution is
    // out of scope for the pure path; dictionary markers cover the
    // common non-content families.
    if (isNonContentDictionary(dictSlice)) {
      continue;
    }

    let streamBytes: Buffer | null = null;
    if (flateOnly) {
      if (totalDecompressedBytes >= MAX_TOTAL_DECOMPRESSED_BYTES) {
        break; // Document-wide decompression budget reached
      }
      const maxStreamOutput = Math.min(
        20 * 1024 * 1024,
        MAX_TOTAL_DECOMPRESSED_BYTES - totalDecompressedBytes,
      );
      try {
        streamBytes = zlib.inflateSync(rawStreamSlice, { maxOutputLength: maxStreamOutput });
        totalDecompressedBytes += streamBytes.length;
      } catch {
        try {
          streamBytes = zlib.inflateRawSync(rawStreamSlice, { maxOutputLength: maxStreamOutput });
          totalDecompressedBytes += streamBytes.length;
        } catch {
          // Stream may be raw or uncompressed
        }
      }
    } else if (filterChain.length === 0) {
      streamBytes = rawStreamSlice;
    } else {
      // Unsupported filter chain: do not attempt to inflate partially
      // encoded bytes; defer to the external text layer.
      ctx.sawUnmappable = true;
    }

    if (streamBytes) {
      const decodedStr = streamBytes.toString("latin1");
      const text = parseContentStreamText(decodedStr, ctx);
      if (text.trim().length > 0) {
        extractedSections.push(text.trim());
      }
    }
  }

  return { text: extractedSections.join("\n\n").trim(), lowConfidence: ctx.sawUnmappable };
}

// External tools process untrusted input; cap accumulated stdout so a
// hostile PDF cannot exhaust the heap through pdftotext/qpdf output.
const MAX_EXTERNAL_TOOL_OUTPUT_BYTES = 50 * 1024 * 1024;

function runExternalTextTool(
  cmd: string,
  args: string[],
  input: Buffer,
  timeoutMs = 5000,
): Promise<string | null> {
  return new Promise((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (val: string | null) => {
      if (!finished) {
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(val);
      }
    };
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, timeoutMs);
      let stdout = "";
      let stdoutBytes = 0;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > MAX_EXTERNAL_TOOL_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(null);
          return;
        }
        stdout += chunk;
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (code === 0 && stdout.trim().length > 0) {
          finish(stdout.trim());
        } else {
          finish(null);
        }
      });
      child.stdin.on("error", () => finish(null));
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      finish(null);
    }
  });
}

function runExternalBinaryTool(
  cmd: string,
  args: string[],
  input: Buffer,
  timeoutMs = 5000,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (val: Buffer | null) => {
      if (!finished) {
        finished = true;
        if (timer) clearTimeout(timer);
        resolve(val);
      }
    };
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, timeoutMs);
      const chunks: Buffer[] = [];
      let stdoutBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_EXTERNAL_TOOL_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (code === 0 && chunks.length > 0) {
          finish(Buffer.concat(chunks));
        } else {
          finish(null);
        }
      });
      child.stdin.on("error", () => finish(null));
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      finish(null);
    }
  });
}

/**
 * Extract text from a PDF buffer using opportunistic delegation or pure-Node fallback.
 */
export async function extractPdfText(buffer: Buffer, timeoutMs = 5000): Promise<string> {
  // 1. Pure Node fast path. Low-confidence results (hex strings the
  // pure path cannot decode with font context) defer to the external
  // text layer when one is installed.
  const pure = extractPureNodePdfText(buffer);
  if (pure.text.length > 0 && !pure.lowConfidence) {
    return pure.text;
  }

  // 2. Opportunistic pdftotext if installed
  const externalText = await runExternalTextTool("pdftotext", ["-", "-"], buffer, timeoutMs);
  if (externalText) {
    return externalText;
  }

  // 3. No external tool available: serve the best-effort pure text.
  if (pure.text.length > 0) {
    return pure.text;
  }

  return "[PDF document with no extractable text layer or scanned raster pages]";
}

/**
 * Blank out literal strings, hex strings, and comments so textual
 * lookalikes inside string data cannot satisfy dictionary probes.
 */
function maskStringsAndComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "%") {
      let j = i;
      while (j < src.length && src[j] !== "\r" && src[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        const c = src[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") depth--;
        j++;
      }
      out += " ".repeat(Math.min(j, src.length) - i);
      i = j;
      continue;
    }
    if (ch === "<") {
      // Dictionary opener: contents must stay visible to probes —
      // do NOT fall through to the hex-string mask on the second "<".
      if (src[i + 1] === "<") {
        out += "<<";
        i += 2;
        continue;
      }
      const gt = src.indexOf(">", i);
      const j = gt === -1 ? src.length : gt + 1;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Attempt structural repair on damaged PDFs (e.g. broken xref table).
 */
export async function repairPdf(buffer: Buffer, timeoutMs = 5000): Promise<Buffer> {
  // 1. Pure Node xref reconstruction
  const MAX_REPAIR_OBJECTS = 500_000;
  const fileStr = buffer.toString("latin1");

  // Lexically scan indirect-object headers OUTSIDE comments, literal and
  // hex strings, and stream bodies: object-like text inside string data
  // must never become an xref entry pointing into that string, and
  // duplicate ids must resolve to the real headers (later occurrences
  // win below, matching incremental-update semantics). /Type /ObjStm is
  // detected in an actual object dictionary, not anywhere in the file.
  const objects: Array<{ id: number; generation: number; offset: number }> = [];
  let overLimit = false;
  let objStmDetected = false;
  {
    let i = 0;
    while (i < fileStr.length) {
      const ch = fileStr[i]!;
      if (ch === "%") {
        while (i < fileStr.length && fileStr[i] !== "\r" && fileStr[i] !== "\n") i++;
        continue;
      }
      if (ch === "(") {
        let depth = 1;
        i++;
        while (i < fileStr.length && depth > 0) {
          const c = fileStr[i]!;
          if (c === "\\") {
            i += 2;
            continue;
          }
          if (c === "(") depth++;
          else if (c === ")") depth--;
          i++;
        }
        continue;
      }
      if (ch === "<" && fileStr[i + 1] === "<") {
        // Dictionary: skip with string awareness — `>>` inside literal
        // or hex strings must not close the walk.
        i = readObjectDictionaryAt(fileStr, i).next;
        continue;
      }
      if (ch === "<") {
        const gt = fileStr.indexOf(">", i);
        i = gt === -1 ? fileStr.length : gt + 1;
        continue;
      }
      if (
        fileStr.startsWith("stream", i) &&
        (i === 0 || fileStr.slice(Math.max(0, i - 3), i) !== "end") &&
        /[\r\n]/.test(fileStr[i + 6] ?? "\n")
      ) {
        // Skip the ENTIRE stream body using the dictionary /Length
        // (validated) so an embedded "endstream" sequence inside the
        // data cannot make the scanner resume mid-stream and index
        // object-like text living inside the stream.
        const interval = resolveStreamInterval(
          fileStr,
          i,
          maskStringsAndComments(scanBackwardDictionary(fileStr, i)),
        );
        i = interval.resumeAfter;
        continue;
      }
      if (/[0-9]/.test(ch)) {
        const header = /^(\d+)\s+(\d+)\s+obj\b/.exec(fileStr.slice(i, i + 32));
        if (header) {
          const id = Number(header[1]);
          const generation = Number(header[2]);
          if (id > 0 && id <= MAX_REPAIR_OBJECTS) {
            objects.push({ id, generation, offset: i });
            if (objects.length > MAX_REPAIR_OBJECTS) {
              overLimit = true;
              break;
            }
          }
          i += header[0].length;
          if (!objStmDetected) {
            // Inspect the object's actual dictionary (no fixed byte
            // window) with strings masked: /Type /ObjStm separated from
            // the header by padding/comments must still be found, while
            // lookalikes inside string data must not match.
            const dict = readObjectDictionaryAt(fileStr, i);
            if (/\/Type\s*\/ObjStm\b/.test(maskStringsAndComments(dict.text))) {
              objStmDetected = true;
            }
          }
          continue;
        }
      }
      i++;
    }
  }

  if (objects.length > 0 && !overLimit && !objStmDetected) {
    objects.sort((a, b) => a.id - b.id);
    const maxId = objects[objects.length - 1]!.id;

    if (maxId <= MAX_REPAIR_OBJECTS) {
      const prefix = buffer.length > 0 && buffer[buffer.length - 1] === 0x0a ? "" : "\n";
      const xrefOffset = buffer.length + prefix.length;
      let xrefStr = `${prefix}xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
      const objMap = new Map(objects.map((o) => [o.id, o]));

      for (let i = 1; i <= maxId; i++) {
        const obj = objMap.get(i);
        if (obj !== undefined) {
          const genStr = String(obj.generation).padStart(5, "0");
          xrefStr += `${String(obj.offset).padStart(10, "0")} ${genStr} n \n`;
        } else {
          xrefStr += `0000000000 65535 f \n`;
        }
      }

      // Search for /Root, /Encrypt, /ID in trailer dictionaries first (last trailer wins)
      let rootMatch: RegExpMatchArray | null = null;
      let encryptMatch: RegExpMatchArray | null = null;
      let idMatch: RegExpMatchArray | null = null;
      const trailerRegex = /trailer\s*<<([\s\S]*?)>>/g;
      let trailerMatch: RegExpExecArray | null;
      while ((trailerMatch = trailerRegex.exec(fileStr)) !== null) {
        const candidateRoot = trailerMatch[1]?.match(/\/Root\s+(\d+\s+\d+\s+R)/);
        if (candidateRoot) rootMatch = candidateRoot;
        const candidateEncrypt = trailerMatch[1]?.match(/\/Encrypt\s+(\d+\s+\d+\s+R)/);
        if (candidateEncrypt) encryptMatch = candidateEncrypt;
        const candidateId = trailerMatch[1]?.match(/\/ID\s*(\[[^\]]*\])/);
        if (candidateId) idMatch = candidateId;
      }
      if (!rootMatch) {
        rootMatch = fileStr.match(/\/Root\s+(\d+\s+\d+\s+R)/);
      }
      if (!encryptMatch) {
        encryptMatch = fileStr.match(/\/Encrypt\s+(\d+\s+\d+\s+R)/);
      }
      if (!idMatch) {
        idMatch = fileStr.match(/\/ID\s*(\[[^\]]*\])/);
      }

      let extraTrailerEntries = "";
      if (rootMatch) extraTrailerEntries += ` /Root ${rootMatch[1]}`;
      if (encryptMatch) extraTrailerEntries += ` /Encrypt ${encryptMatch[1]}`;
      if (idMatch) extraTrailerEntries += ` /ID ${idMatch[1]}`;

      const trailerStr = `trailer\n<< /Size ${maxId + 1}${extraTrailerEntries} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

      return Buffer.concat([buffer, Buffer.from(xrefStr + trailerStr, "latin1")]);
    }
  }

  // 2. Opportunistic qpdf if installed
  const externalRepaired = await runExternalBinaryTool("qpdf", ["--qdf", "-", "-"], buffer, timeoutMs);
  if (externalRepaired) {
    return externalRepaired;
  }

  return buffer;
}
