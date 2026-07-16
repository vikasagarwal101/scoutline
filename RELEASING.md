# Releasing Scoutline

This project uses manual releases with Git tags and release notes derived from CHANGELOG.md.

## Checklist

1. Make sure the working tree is clean.
2. Update `CHANGELOG.md` with the new version and date.
3. Bump the version in `packages/scoutline/package.json`.
4. Build and test the CLI:

```bash
cd packages/scoutline
npm ci
npm run build
npm test
```

5. Publish to npm:

```bash
cd packages/scoutline
npm publish --access public
```

6. Create and push a git tag:

```bash
git tag scoutline-vX.Y.Z
git push origin scoutline-vX.Y.Z
```

7. Create a GitHub Release and paste the matching CHANGELOG section as release notes.

## Notes

- The npm package name is `scoutline`.
- Use pre-1.0 semantic versioning until the project reaches a stable public contract.
