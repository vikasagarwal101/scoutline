# Plaintext Credential Storage

Status: accepted

Scoutline stores Provider API keys in `~/.scoutline/config.json` as
plaintext JSON. On POSIX systems the file is mode 0600 and the parent
directory is mode 0700 (enforced by atomic-rename writes). Windows does
not apply POSIX permission bits. OS keyring integration
(keytar/libsecret) was considered but rejected for the initial release.

## Context

Every Provider requires a long-lived API key for authentication. The
key must be persisted across invocations so the user does not re-enter
it on every call. The established convention among major CLI tools is
plaintext storage with restrictive file permissions:

- AWS CLI stores credentials in `~/.aws/credentials` (INI, plaintext).
- gcloud stores credentials in `~/.config/gcloud/credentials.db`
  (SQLite, plaintext).
- kubectl stores credentials in `~/.kube/config` (YAML, plaintext).

Alternatives considered:

- **OS keyring (keytar/libsecret).** Adds a native dependency that must
  be compiled per platform, requires a running keyring daemon (not
  available in headless or container environments), and introduces
  cross-platform inconsistency (Windows Credential Manager, macOS
  Keychain, Linux libsecret/Secret Service). Rejected for the initial
  release; deferred until user demand or a security audit requires it.
- **Encrypted file with a passphrase.** Would reduce at-rest exposure
  from backups, cloud sync, and forensic extraction when the passphrase
  is stored separately (not alongside the file). However, it does not
  protect against a compromised same-user process, which can read both
  the passphrase and the file. The usability cost — requiring a
  passphrase on every invocation or storing it in an environment
  variable (which is itself plaintext-at-rest) — outweighed the benefit
  for the initial release.
- **Environment-variable-only (no file).** Forces the user to manage
  keys in shell rc files or process managers — the same plaintext
  exposure with weaker ergonomics and no file-mode protection.
- **OAuth device flow.** Not all Providers support OAuth; those that do
  still issue a refresh token that must be stored at rest.

## Decision

Accept plaintext-at-rest as a CLI tradeoff. Credentials are stored in
`~/.scoutline/config.json` as plain JSON. On POSIX systems the file is
mode 0600 and the directory is 0700. Defer OS-keyring integration
until user demand or a security audit requires it.

## Consequences

- Backups, cloud-sync services, forensic tools, or a compromised
  process running as the same user can extract all keys trivially.
- Users in shared or multi-user environments should use OS-level disk
  encryption (LUKS, FileVault, BitLocker) as the primary protection.
- On POSIX systems, the mode-0600 file and mode-0700 directory protect
  against casual local multi-user access but do not constitute
  encryption. Windows users have no equivalent file-mode protection.
