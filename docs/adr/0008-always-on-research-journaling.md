# Always-on research journaling

Research memory (`kind:"journal"` entries in the one artifacts store) records
every `search` / `read` / `research` call — including batch-driven ops — by
DEFAULT, not via a per-call opt-in flag. The seed's original `--journal`
opt-in flag was rejected because a recall/export feature built on a corpus
nobody populates is valueless when empty: opt-in flags do not survive user
discipline, and the seed's own motivation ("every result appended … the
difference between a tool and a workspace") describes always-on. Escape
hatches: per-call `--no-journal` (the `--no-fallback` idiom) and top-level
config `"journal": false`. Disclosure is a one-time `setup` prompt (default
enabled) writing that config flag — no runtime stderr notice, because the
journal is a user-serving feature, not a tracker; the store is local-only,
0600, with query text passed through `redactSecrets`.

## Consequences

- Privacy posture shifts honestly: the seed's "opt-in, aligned" line is
  retired. Recording is automatic; the opt-in that remains is content
  RETENTION via explicit `--save` (skeletons are thin and permanent; full
  bodies survive only as save artifacts, never re-fetched).
- Warm/cold cache distinction drives entry size (generations + repeat
  markers): cache miss → full skeleton entry; cache hit → tiny repeat
  marker (`repeatOf` + timestamp); journal-cold-but-cache-warm → full
  entry once. An in-place counter bump was rejected — it breaks the
  append-only store contract and loses per-ask timestamps.
- Journaling changes NO provider-call volume. The response cache alone
  prevents repeat calls; provider-call savings attributed to the journal
  come from users choosing `history recall` over re-running searches.
- A future flip back to opt-in is cheap mechanically but leaves orphaned
  default-written records behind — the privacy expectations set at install
  time are the real lock-in.
