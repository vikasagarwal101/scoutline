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
 * Decode a PDF hex string <...>.
 */
function decodePdfHexString(hex: string): string {
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
    return res;
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
      return res;
    }
  }

  let result = "";
  for (const byte of bytes) {
    result += String.fromCharCode(byte);
  }
  return result;
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
    if (ch === "<" && streamStr[i + 1] !== "<") {
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
          } else if (c === "<" && streamStr[i + 1] !== "<") {
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
 * Parse text operators from a decompressed PDF content stream.
 */
function parseContentStreamText(streamStr: string): string {
  const lines: string[] = [];
  let currentLine = "";

  const textBlocks = extractBtBlocks(streamStr);

  const literalPattern = "\\((?:[^()\\\\]|\\\\.|(?:\\([^()\\\\]*\\)))*\\)";
  const opRegex = new RegExp(
    `${literalPattern}\\s*Tj|\\[((?:(?:${literalPattern})|<[0-9a-fA-F\\s]+>|[^\\[\\]()])*)\\]\\s*TJ|<[0-9a-fA-F\\s]+>\\s*Tj|T\\*|(?:-?\\d+(?:\\.\\d+)?\\s+){2}(?:Td|TD)|(?:${literalPattern})\\s*'|(?:-?\\d+(?:\\.\\d+)?\\s+){2}(?:${literalPattern})\\s*"|(?:${literalPattern})\\s*"`,
    "g",
  );

  for (const textBlock of textBlocks) {
    let opMatch: RegExpExecArray | null;
    while ((opMatch = opRegex.exec(textBlock)) !== null) {
      const token = opMatch[0]!;

      if (token === "T*" || /Td|TD$/.test(token)) {
        if (currentLine.trim().length > 0) {
          lines.push(currentLine.trim());
          currentLine = "";
        }
      } else if (token.endsWith("Tj") && token.startsWith("(")) {
        const rawStr = token.slice(1, token.lastIndexOf(")")).trim();
        currentLine += decodePdfLiteralString(rawStr) + " ";
      } else if (token.endsWith("Tj") && token.startsWith("<")) {
        const rawHex = token.slice(1, token.lastIndexOf(">")).trim();
        currentLine += decodePdfHexString(rawHex) + " ";
      } else if (token.endsWith("TJ")) {
        const arrayContent = opMatch[1] ?? "";
        const itemRegex = /\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>/g;
        let itemMatch: RegExpExecArray | null;
        while ((itemMatch = itemRegex.exec(arrayContent)) !== null) {
          const item = itemMatch[0]!;
          if (item.startsWith("(")) {
            const rawStr = item.slice(1, -1);
            currentLine += decodePdfLiteralString(rawStr);
          } else if (item.startsWith("<")) {
            const rawHex = item.slice(1, -1);
            currentLine += decodePdfHexString(rawHex);
          }
        }
        currentLine += " ";
      } else if (token.endsWith("'") || token.endsWith('"')) {
        if (currentLine.trim().length > 0) {
          lines.push(currentLine.trim());
          currentLine = "";
        }
        const stringToken = token.replace(/^\s*(?:-?\d+(?:\.\d+)?\s+)*/, "");
        const rawStr = stringToken.slice(1, stringToken.lastIndexOf(")")).trim();
        currentLine += decodePdfLiteralString(rawStr) + " ";
      }
    }

    if (currentLine.trim().length > 0) {
      lines.push(currentLine.trim());
      currentLine = "";
    }
  }

  return lines.join("\n");
}

/**
 * Built-in pure-Node text extraction by scanning PDF streams.
 */
function extractPureNodePdfText(buffer: Buffer): string {
  const fileStr = buffer.toString("latin1");
  const extractedSections: string[] = [];
  const MAX_TOTAL_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB across document
  let totalDecompressedBytes = 0;

  // Match stream ... endstream
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(fileStr)) !== null) {
    const streamStart = match.index + match[0].indexOf("\n") + 1;
    const streamLength = match[1]!.length;
    const rawStreamSlice = buffer.subarray(streamStart, streamStart + streamLength);

    // Look backward for stream's own dictionary << ... >> before 'stream'
    // Bracket-balance backwards from '>>' to find outermost matching '<<'
    const beforeStream = fileStr.slice(Math.max(0, match.index - 2000), match.index).trimEnd();
    let dictSlice = "";
    const lastDictEnd = beforeStream.lastIndexOf(">>");
    if (lastDictEnd !== -1) {
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
            dictSlice = beforeStream.slice(pos, lastDictEnd + 2);
            break;
          }
        } else {
          pos--;
        }
      }
    }
    const isFlate = dictSlice.includes("/FlateDecode");

    let streamBytes: Buffer | null = null;
    if (isFlate) {
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
    } else {
      streamBytes = rawStreamSlice;
    }

    if (streamBytes) {
      const decodedStr = streamBytes.toString("latin1");
      const text = parseContentStreamText(decodedStr);
      if (text.trim().length > 0) {
        extractedSections.push(text.trim());
      }
    }
  }

  return extractedSections.join("\n\n").trim();
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
  // 1. Pure Node fast path
  const text = extractPureNodePdfText(buffer);
  if (text.length > 0) {
    return text;
  }

  // 2. Opportunistic pdftotext if installed
  const externalText = await runExternalTextTool("pdftotext", ["-", "-"], buffer, timeoutMs);
  if (externalText) {
    return externalText;
  }

  return "[PDF document with no extractable text layer or scanned raster pages]";
}

/**
 * Attempt structural repair on damaged PDFs (e.g. broken xref table).
 */
export async function repairPdf(buffer: Buffer, timeoutMs = 5000): Promise<Buffer> {
  // 1. Pure Node xref reconstruction
  const MAX_REPAIR_OBJECTS = 500_000;
  const fileStr = buffer.toString("latin1");

  // Pre-compute stream body intervals [start, end] so we do not match fake objects inside stream data
  // while preserving exact byte offsets in the original file
  const streamIntervals: Array<[number, number]> = [];
  const streamRegex = /stream\r?\n[\s\S]*?\r?\nendstream/g;
  let sMatch: RegExpExecArray | null;
  while ((sMatch = streamRegex.exec(fileStr)) !== null) {
    streamIntervals.push([sMatch.index, sMatch.index + sMatch[0].length]);
  }

  let streamIntervalIndex = 0;
  function isInsideStream(offset: number): boolean {
    while (
      streamIntervalIndex < streamIntervals.length &&
      offset >= streamIntervals[streamIntervalIndex]![1]
    ) {
      streamIntervalIndex++;
    }
    const interval = streamIntervals[streamIntervalIndex];
    return interval !== undefined && offset >= interval[0] && offset < interval[1];
  }

  const objRegex = /(\d+)\s+(\d+)\s+obj/g;
  const objects: Array<{ id: number; generation: number; offset: number }> = [];

  let objMatch: RegExpExecArray | null;
  let overLimit = false;
  while ((objMatch = objRegex.exec(fileStr)) !== null) {
    if (isInsideStream(objMatch.index)) {
      continue;
    }
    const id = Number(objMatch[1]);
    const generation = Number(objMatch[2]);
    if (id > 0 && id <= MAX_REPAIR_OBJECTS) {
      objects.push({
        id,
        generation,
        offset: objMatch.index,
      });
      if (objects.length > MAX_REPAIR_OBJECTS) {
        overLimit = true;
        break;
      }
    }
  }

  if (objects.length > 0 && !overLimit && !/\/Type\s*\/ObjStm\b/.test(fileStr)) {
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
