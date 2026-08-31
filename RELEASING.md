# Releasing Scoutline

This project uses manual releases with Git tags and release notes derived from CHANGELOG.md.

## Checklist

1. Make sure the working tree is clean.
2. Update `CHANGELOG.md` with the new version and date (retitled from the shared `## [Unreleased]` section).
3. Build and test the CLI (tests import `dist/` — build before test):

```bash
cd packages/scoutline
npm run build
npm test          # full glob: node --test tests/*.test.js
npm run test:offline   # publish gate
```

4. Commit and tag: run `npm version X.Y.Z --no-git-tag-version` from `packages/scoutline/`, commit the version bump together with the CHANGELOG retitle, and tag the release commit `vX.Y.Z`. Tags are plain `v*` (npm's default), matching every existing release tag.

```bash
git tag vX.Y.Z
```

5. Push the branch and tag together:

```bash
git push --follow-tags origin main
```

6. Create a GitHub Release and paste the matching CHANGELOG section as release notes:

```bash
gh release create vX.Y.Z --title "X.Y.Z" --notes-file <notes>
```

7. Publish to npm (`prepublishOnly` runs the offline gate and ships fresh `dist/`):

```bash
cd packages/scoutline
npm publish
```

Wait for the registry to serve the new version before announcing or starting follow-on work.

## Notes

- The npm package name is `scoutline`.
- Use pre-1.0 semantic versioning until the project reaches a stable public contract.
