/**
 * Content extractors for the read command.
 *
 * Pull specific slices out of a markdown/text page so agents don't have to
 * parse the full body themselves. All extractors return arrays.
 *
 *   --extract code       fenced code blocks (with language tag if present)
 *   --extract links      markdown links + bare URLs (deduped)
 *   --extract tables     markdown table blocks (rendered as their raw markdown)
 *   --extract headings   H1/H2/H3 outline with anchor slugs
 */

export type ExtractMode = "code" | "links" | "tables" | "headings";

export const EXTRACT_MODES: ExtractMode[] = ["code", "links", "tables", "headings"];

export function isExtractMode(v: string): v is ExtractMode {
  return (EXTRACT_MODES as string[]).includes(v);
}

export interface CodeBlock {
  language: string | null;
  code: string;
}

export interface Link {
  text: string | null;
  url: string;
}

export interface Heading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  slug: string;
}

export interface Table {
  rows: number;
  markdown: string;
}

export function extractCode(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  // Match fenced blocks: ```lang\n...\n``` or ~~~\n...\n~~~
  const re = /(?:^|\n)(`{3,}|~{3,})\s*([\w+-]*)\s*\n([\s\S]*?)\n\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const lang = m[2]?.trim() || null;
    blocks.push({ language: lang, code: m[3] });
  }
  return blocks;
}

export function extractLinks(content: string): Link[] {
  const links: Link[] = [];
  const seen = new Set<string>();

  // Markdown links: [text](url)
  const mdRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(content)) !== null) {
    const url = m[2];
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ text: m[1] || null, url });
  }

  // Bare URLs (http/https) not already captured as markdown links
  const bareRe = /\bhttps?:\/\/[^\s)\]]+/g;
  while ((m = bareRe.exec(content)) !== null) {
    let url = m[0];
    // strip trailing punctuation
    url = url.replace(/[.,;:!?)]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ text: null, url });
  }

  return links;
}

export function extractTables(content: string): Table[] {
  const tables: Table[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // A table starts with a row of | cells followed by a separator row.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const block: string[] = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].includes("|")) {
        block.push(lines[j]);
        j++;
      }
      tables.push({ rows: block.length, markdown: block.join("\n") });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

export function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const level = m[1].length as Heading["level"];
      const text = m[2];
      // GitHub-style slug: lowercase, strip punctuation, spaces → hyphens
      const slug = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-");
      headings.push({ level, text, slug });
    }
  }
  return headings;
}

export function extract(content: string, mode: ExtractMode): unknown[] {
  switch (mode) {
    case "code":
      return extractCode(content);
    case "links":
      return extractLinks(content);
    case "tables":
      return extractTables(content);
    case "headings":
      return extractHeadings(content);
  }
}
