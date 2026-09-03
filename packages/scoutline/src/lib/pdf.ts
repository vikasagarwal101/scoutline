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
  const header = buffer.subarray(0, 1024).toString("latin1");
  return header.includes("%PDF-");
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
  let result = "";
  for (let i = 0; i < padded.length; i += 2) {
    const byte = parseInt(padded.slice(i, i + 2), 16);
    if (!isNaN(byte)) {
      result += String.fromCharCode(byte);
    }
  }
  return result;
}

/**
 * Parse text operators from a decompressed PDF content stream.
 */
function parseContentStreamText(streamStr: string): string {
  const lines: string[] = [];
  let currentLine = "";

  // Find all BT (Begin Text) ... ET (End Text) blocks
  const btRegex = /BT\b([\s\S]*?)\bET/g;
  let btMatch: RegExpExecArray | null;

  while ((btMatch = btRegex.exec(streamStr)) !== null) {
    const textBlock = btMatch[1]!;

    // Tokenize text block looking for string operators:
    // 1. (...) Tj
    // 2. [(...)] TJ
    // 3. ' or "
    // 4. Td, TD, T* for line breaks

    const opRegex =
      /\((?:[^()\\]|\\.)*\)\s*Tj|\[((?:(?:\((?:[^()\\]|\\.)*\))|<[0-9a-fA-F\s]+>|[^[\]()])*)\]\s*TJ|<[0-9a-fA-F\s]+>\s*Tj|T\*|(?:\d+(?:\.\d+)?\s+){2}(?:Td|TD)|(?:\((?:[^()\\]|\\.)*\))\s*'/g;

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
      } else if (token.endsWith("'")) {
        if (currentLine.trim().length > 0) {
          lines.push(currentLine.trim());
          currentLine = "";
        }
        const rawStr = token.slice(1, token.lastIndexOf(")")).trim();
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

  // Match stream ... endstream
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(fileStr)) !== null) {
    const streamStart = match.index + match[0].indexOf("\n") + 1;
    const streamLength = match[1]!.length;
    const rawStreamSlice = buffer.subarray(streamStart, streamStart + streamLength);

    // Look backward for stream dictionary before 'stream'
    const dictSlice = fileStr.slice(Math.max(0, match.index - 500), match.index);
    const isFlate = dictSlice.includes("/FlateDecode");

    let streamBytes: Buffer | null = null;
    if (isFlate) {
      try {
        streamBytes = zlib.inflateSync(rawStreamSlice);
      } catch {
        try {
          streamBytes = zlib.inflateRawSync(rawStreamSlice);
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
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
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
      child.stdout.on("data", (chunk: Buffer) => {
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
  const fileStr = buffer.toString("latin1");
  const objRegex = /(\d+)\s+(\d+)\s+obj/g;
  const objects: Array<{ id: number; generation: number; offset: number }> = [];

  let objMatch: RegExpExecArray | null;
  while ((objMatch = objRegex.exec(fileStr)) !== null) {
    objects.push({
      id: Number(objMatch[1]),
      generation: Number(objMatch[2]),
      offset: objMatch.index,
    });
  }

  if (objects.length > 0) {
    objects.sort((a, b) => a.id - b.id);
    const maxId = objects[objects.length - 1]!.id;

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

    let trailerStr = `trailer\n<< /Size ${maxId + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    const rootMatch = fileStr.match(/\/Root\s+(\d+\s+\d+\s+R)/);
    if (rootMatch) {
      trailerStr = `trailer\n<< /Size ${maxId + 1} /Root ${rootMatch[1]} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    }

    return Buffer.concat([buffer, Buffer.from(xrefStr + trailerStr, "latin1")]);
  }

  // 2. Opportunistic qpdf if installed
  const externalRepaired = await runExternalBinaryTool("qpdf", ["--qdf", "-", "-"], buffer, timeoutMs);
  if (externalRepaired) {
    return externalRepaired;
  }

  return buffer;
}
