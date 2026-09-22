/**
 * Issue #268 — the pipe-split grammar and term-length bounds are owned
 * by ONE module each and shared by import, not re-declared:
 *
 *   - `search.ts` owns and exports the `--merge` split grammar
 *     (split on unescaped `|`, unescape `\|`, trim, drop empties).
 *   - `context-file.ts` owns and exports the D2.3 term bounds
 *     (MIN_TERM_CHARS=4 / MAX_TERM_CHARS=40).
 *   - `investigate-planner.ts` imports both; its pinned local
 *     duplicates are deleted.
 *
 * Divergence tooth: if the exported grammar drifts from the rows the
 * planner's determinism table pins, the planner rows go RED (covered
 * by the mutation in the pickup protocol).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MERGE_SPLIT_PATTERN,
  splitMergeSubQueries,
} from "../dist/commands/search.js";
import {
  MIN_TERM_CHARS,
  MAX_TERM_CHARS,
} from "../dist/lib/context-file.js";

test("search exports the merge split grammar (regex + splitter)", () => {
  assert.ok(MERGE_SPLIT_PATTERN instanceof RegExp, "MERGE_SPLIT_PATTERN exported");
  assert.ok(typeof splitMergeSubQueries === "function", "splitMergeSubQueries exported");

  // Grammar rows pinned by the planner's determinism table.
  assert.deepStrictEqual(splitMergeSubQueries("a | b |c"), ["a", "b", "c"]);
  assert.deepStrictEqual(splitMergeSubQueries("rust\\|async | news"), ["rust|async", "news"]);
  assert.deepStrictEqual(splitMergeSubQueries("  x  "), ["x"]);
  assert.throws(() => splitMergeSubQueries(" | | "), /at least one non-empty/);
});

test("context-file exports the D2.3 term bounds", () => {
  assert.strictEqual(MIN_TERM_CHARS, 4);
  assert.strictEqual(MAX_TERM_CHARS, 40);
});
