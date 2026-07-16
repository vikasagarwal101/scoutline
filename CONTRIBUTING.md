# Contributing

Thanks for helping improve Scoutline and the skills marketplace.

## Development setup

```bash
cd packages/scoutline
npm install
npm run build
npm test
```

## Project structure

- `packages/scoutline` contains the CLI package.
- `skills/` contains marketplace skills.

## Adding a skill

1. Create a new folder under `skills/` using lowercase letters, numbers, and hyphens.
2. Add a `SKILL.md` with YAML front matter (`name`, `description`) and concise instructions.
3. Add any optional resources in `references/`, `scripts/`, or `assets/`.
4. Update `skills/README.md` with the new skill.

See `skills/scoutline/SKILL.md` for the full format.

## Quality checks

- Keep instructions concise and action-oriented.
- Prefer data-only output formats for CLI examples.
- Validate that all CLI examples work against the current version.

## Reporting issues

Please use the issue templates in GitHub for bugs or feature requests.
