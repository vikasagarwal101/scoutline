/**
 * Central `--flag=value` normalization (#263).
 *
 * `parseArgs` (index.ts) has no equals-form handling: a `--flag=value`
 * token landed as a boolean flag under a garbage key (`flags["flag=value"]`)
 * and was silently dropped — the accept-and-drop class, but at the parser
 * layer. Two commands (archive, investigate) guarded locally with
 * per-command rejections; this seam replaces both: `--flag=value` is
 * EQUIVALENT to `--flag value` on every command.
 *
 * `main()` runs this over the full argv BEFORE extractGlobalOptions, the
 * strict-flag gate, and every handler's parse, so all downstream token
 * walks (parseArgs, findUnknownStrictFlag, isCommandHelpInvocation,
 * collectLongFlagValues, isDryRunBatchInvocation) observe space-form
 * tokens only. The exported raw-argv parsers (archive's
 * parseArchiveArgs, watch's parseWatchArgs, science's parseScienceArgs)
 * apply it directly because they are callable with raw argv (the tests
 * do); their handlers consume already-normalized tokens via the
 * parse<Tokens> inners, keeping the seam single-application.
 *
 * Semantics (deliberate rulings):
 *   - Splits on the FIRST '=' only, and only in `--`-prefixed tokens
 *     with a non-empty key: `--header=K:V=W` → `--header` `K:V=W` (a
 *     value's internal '='s are never split); `--=x` and bare `--` pass
 *     through untouched (a `=` at index 2 means an empty key).
 *   - `--flag=` → `--flag` `` — parseArgs treats the empty follower as
 *     no value, so the equals form with an empty value is the VALUELESS
 *     flag, exactly like the space form `--flag ""`.
 *   - `--no-cache=1` → `--no-cache` `1`: the no-branch consumes nothing,
 *     so `1` becomes a positional — identical to the space form.
 *   - Short flags (`-O=json`) and non-flag tokens (`a=b`) are untouched:
 *     the contract is the long-flag equals form ≡ space form, nothing
 *     more. Under SCOUTLINE_STRICT_FLAGS a `-O=json` token still rejects
 *     as unknown, same as before.
 */
export function normalizeEqualsFormFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      // eq > 2 ⇒ non-empty key between "--" and "=" (also excludes the
      // -1 no-equals case and the `--=` empty-key case).
      if (eq > 2) {
        out.push(arg.slice(0, eq), arg.slice(eq + 1));
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}
