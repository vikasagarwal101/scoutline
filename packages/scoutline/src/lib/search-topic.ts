/**
 * Search topic keyword appendage (DESIGN.md §7 — T03).
 *
 * Providers that lack a native topic parameter (Z.AI, MiniMax) express
 * a non-`general` topic by appending a keyword to the query string.
 * This is adapter-owned field mapping performed inside each Adapter's
 * `invoke()`, never at the command layer. The Tavily adapter passes the
 * topic natively (T04) and does not use this helper.
 *
 * Guard: when the query already ends with the topic word
 * (case-insensitive) the appendage is skipped, so `"rust news"` with
 * `--topic news` stays `"rust news"` rather than `"rust news latest news"`.
 */

import type { SearchTopic } from "../capabilities/search.js";

const TOPIC_APPENDAGES: Readonly<Record<Exclude<SearchTopic, "general">, string>> = {
  news: " latest news",
  finance: " financial",
};

/**
 * Append the topic keyword to `query` unless the topic is `general`,
 * absent, or the query already ends with the topic word. Returns the
 * query unchanged in all skip cases.
 */
export function applySearchTopic(query: string, topic: SearchTopic | undefined): string {
  if (!topic || topic === "general") return query;
  const appendage = TOPIC_APPENDAGES[topic];
  if (appendage === undefined) return query;
  const trimmed = query.trimEnd();
  if (trimmed.length === 0) return query;
  if (trimmed.toLowerCase().endsWith(topic)) return query;
  return trimmed + appendage;
}
