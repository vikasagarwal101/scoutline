/**
 * Provider-neutral composed-run stop contract (package-route-boundary).
 *
 * The set of EXACT declared composed-stop roots and the guard that
 * converts an EVAL_STOPPED error into one of them. Production-neutral by
 * design: no transport, no endpoint/model/credential surface. The
 * development transports (dev/lean-candidate-transport.ts) import this
 * module — never the reverse — so no temporary adapter ships in dist.
 */

/**
 * Structured composed-run stop roots carried through normalization.
 * A composed run may stop early ONLY with code EVAL_STOPPED AND a reason
 * EXACTLY in this set; anything else is discarded un-serialized.
 */
export const COMPOSED_STOP_ROOTS: ReadonlySet<string> = new Set([
  "global_extraction_cap",
  "global_judgment_cap",
  "global_deadline",
]);

export function composedStopRootOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  const reason = (error as { reason?: unknown }).reason;
  if (code !== "EVAL_STOPPED") return null;
  if (typeof reason !== "string") return null;
  return COMPOSED_STOP_ROOTS.has(reason) ? reason : null;
}
