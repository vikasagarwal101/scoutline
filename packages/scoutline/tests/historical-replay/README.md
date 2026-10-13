# Historical replay gates — UNAVAILABLE inputs, explicit recovery semantics

## What this directory is

Two **historical recovery gates** replay the frozen sanitized runtime
reports from authorized live evaluations 04/05. They are NOT part of the
ordinary portable test selector (`tests/*.test.mjs`), are not run by
`npm test`, and are **not passed, replaced or attested by any synthetic
suite**. The original 16 recorded-response replay assertions preserved here
remain **unavailable historical evidence** while the exact report bodies
are missing. No test elsewhere claims their outcome.

| Gate | Replays | Expected raw SHA-256 | Original assertions |
| --- | --- | --- | --- |
| `eval04-independent-retention-guards.recovery.mjs` | `/tmp/opencode/unified-private-runtime/evaluation-04/result.json` | `b7d8cfae1c6dd3596d7bfbef473e8d0eec086cfff16eae6354f9aeea054db763` | 6 |
| `eval05-prerequisite-reconciliation-guards.recovery.mjs` | `/tmp/opencode/unified-private-runtime/evaluation-05/result.json` | `3d755ba67573199b86f33107aa098113dacdbf3f4b8fc596c978df6904c3a1c3` | 10 |

## Current status

No authorized copy of either report exists (searched: epic artifacts,
epic scratch, `/tmp/opencode`, opencode snapshot repositories — hash-only
provenance survives in `independent-review/live-outcome-04`,
`independent-review/live-outcome-05` and
`extractor-envelope-instructions/cold-review/verification-hashes.json`;
no payload-bearing derivative exists). Both gates therefore **fail
explicitly** with `EVAL_REPORT_MISSING`. This is the intended state —
never a skip, fallback or synthesized replay.

## Running the gates when authorized sanitized originals are recovered

1. Verify the file's raw SHA-256 matches the expected hash above
   (`sha256sum result.json`). The gate re-verifies and refuses any other
   content with `EVAL_REPORT_HASH_MISMATCH` — no altered derivative may
   drive a replay.
2. Provide the file either via environment:
   ```bash
   EVAL04_REPORT_PATH=/path/to/sanitized-evaluation04-result.json \
     node --test tests/historical-replay/eval04-independent-retention-guards.recovery.mjs
   EVAL05_REPORT_PATH=/path/to/sanitized-evaluation05-result.json \
     node --test tests/historical-replay/eval05-prerequisite-reconciliation-guards.recovery.mjs
   ```
   or by placing it adjacent (never commit it):
   ```
   tests/historical-replay/fixtures/evaluation-04/result.json
   tests/historical-replay/fixtures/evaluation-05/result.json
   ```
3. A pass then replays the original recorded responses against the frozen
   engine and restores the original 16 assertions as live evidence. Do not
   commit the report files; do not lower the hash gate.

## Relation to the active synthetic guards

`tests/historical-replay-synthetic.test.mjs` (ordinary selector) covers the
same **software requirements** — final-context retention, prerequisite
value/provenance reconciliation, stale-context/material-conflict
prohibition, explicit unresolved reasons, cap attribution — against the
in-tree synthetic corpus. It is NEW evidence only:

- it does not attest evaluation04/05 conservation or any historical outcome
  (eval04: six correct accepts/15% fixed eligible coverage; eval05: nine
  correct accepts/22.5% — those recorded facts stay as recorded, UNKNOWN
  incidents stay UNKNOWN);
- its counts are never merged with the unavailable historical gates;
- discrimination is proven by `tests/historical-replay-teeth-check.mjs`
  (run manually with `--experimental-vm-modules`): it evaluates an
  in-memory mutated engine copy with the trusted-history reconciliation
  branch disabled and shows both retention guards fail there while passing
  on the frozen dist `f396d860…90f96210`.
