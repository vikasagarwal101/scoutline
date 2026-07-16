# Skills Marketplace

This directory contains skills for AI agents. Each skill has a `SKILL.md` file with YAML frontmatter and markdown instructions.

## Available Skills

| Skill | Description |
|-------|-------------|
| [scoutline](scoutline/SKILL.md) | Z.AI vision, search, reader, and GitHub repo exploration |

## Install Skills

**OpenSkills** (universal):
```bash
npx openskills install vikasagarwal101/scoutline
```

**Claude Code**:
```bash
claude skill install vikasagarwal101/scoutline --skill scoutline
```

## Add a Skill

1. Create a folder under `skills/` (lowercase, hyphens)
2. Add `SKILL.md` with YAML frontmatter (`name`, `description`)
3. Keep instructions concise - point to CLI `--help` for details
4. Update this README
