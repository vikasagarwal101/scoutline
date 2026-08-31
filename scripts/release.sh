#!/usr/bin/env bash
# Mechanical release driver for scoutline.
#
#   scripts/release.sh <X.Y.Z> [--dry-run]
#
# Encodes the manual flow from RELEASING.md with fail-loud gates at
# every step that has historically failed silently:
#   - the CHANGELOG retitle is verified (a stranded ## [Unreleased]
#     shipped as 0.19.6 with empty release notes once);
#   - release notes are extracted and must be non-empty BEFORE the
#     GitHub release is created;
#   - the tag must land on the release commit and must not already
#     exist on origin.
#
# Prerequisites: clean tree; a `## [Unreleased]` section at the top of
# CHANGELOG.md; gh authenticated; npm authenticated; node via fnm.
# --dry-run runs everything through the gates and then restores the
# tree (no commit, no tag, no push, no publish).
set -euo pipefail

VERSION="${1:-}"
DRY_RUN="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/packages/scoutline"
TODAY="$(date +%F)"

[ -n "$VERSION" ] || { echo "usage: scripts/release.sh <X.Y.Z> [--dry-run]" >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a plain semver: $VERSION" >&2; exit 1; }
[ -z "$DRY_RUN" ] || [ "$DRY_RUN" = "--dry-run" ] || { echo "second arg must be --dry-run" >&2; exit 1; }
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "working tree must be clean" >&2; exit 1; }

step() { echo "== $* =="; }

cd "$ROOT"

step "preconditions"
grep -q "^## \[Unreleased\]" CHANGELOG.md || { echo "no ## [Unreleased] section to retitle" >&2; exit 1; }
if git ls-remote --tags origin "refs/tags/v$VERSION" | grep -q "refs/tags/v$VERSION"; then
  echo "tag v$VERSION already exists on origin" >&2; exit 1
fi

step "retitle CHANGELOG Unreleased -> $VERSION (verified)"
python3 - "$VERSION" "$TODAY" <<'PYEOF'
import sys
version, today = sys.argv[1], sys.argv[2]
p = "CHANGELOG.md"
s = open(p).read()
marker = "## [Unreleased]\n"
assert marker in s, "Unreleased vanished before retitle"
s = s.replace(marker, f"## [{version}] - {today}\n", 1)
assert f"## [{version}]" in s and "## [Unreleased]" not in s, "retitle did not land"
open(p, "w").write(s)
PYEOF

step "bump package version (verified)"
(cd "$PKG" && fnm exec --using 24 npm version "$VERSION" --no-git-tag-version)
grep -q "\"version\": \"$VERSION\"" "$PKG/package.json" || { echo "package.json bump did not land" >&2; exit 1; }

step "gates (offline + glob)"
(cd "$PKG" && fnm exec --using 24 npm run test:offline 2>&1 | grep -E "^ℹ (tests|pass|fail)")
(cd "$PKG" && fnm exec --using 24 node --test tests/*.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)")

step "extract release notes (must be non-empty)"
awk -v sec="## [$VERSION]" 'index($0, sec)==1 {f=1; next} f && /^## /{exit} f' CHANGELOG.md > /tmp/scoutline-release-notes.md
[ -s /tmp/scoutline-release-notes.md ] || { echo "empty release notes — aborting" >&2; exit 1; }
echo "notes: $(wc -c < /tmp/scoutline-release-notes.md) bytes"

if [ "$DRY_RUN" = "--dry-run" ]; then
  step "dry run — restoring tree"
  git checkout -- CHANGELOG.md packages/scoutline/package.json packages/scoutline/package-lock.json
  echo "dry run complete — tree restored, nothing committed/shipped"
  exit 0
fi

step "release commit + tag"
git add CHANGELOG.md "$PKG/package.json" "$PKG/package-lock.json"
git commit -m "chore(release): $VERSION"
git tag "v$VERSION"
[ "$(git tag --points-at HEAD)" = "v$VERSION" ] || { echo "tag not on release commit" >&2; exit 1; }

step "push branch + tag"
git push origin main
git push origin "v$VERSION"

step "github release"
gh release create "v$VERSION" --title "$VERSION" --notes-file /tmp/scoutline-release-notes.md

step "npm publish"
(cd "$PKG" && fnm exec --using 24 npm publish)

step "registry check"
sleep 20
[ "$(npm view scoutline dist-tags.latest)" = "$VERSION" ] || { echo "registry does not serve $VERSION yet (lag)" >&2; exit 1; }
echo "RELEASED scoutline@$VERSION"
