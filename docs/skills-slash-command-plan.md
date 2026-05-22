# `/custie` Slash Command — Design & Plan

> Status: plan only — no implementation in this PR.

## Goal

Make Custie's skills discoverable from Slack. Today skills are a Claude CLI
concept injected into the model's context; a Slack user has no way to see or
pick one. Add a `/custie` slash command that appears in Slack's `/` menu, with
a `skills` subcommand that lists the available skills in a searchable dropdown.

## Background

- Custie spawns the `claude` CLI per message (`src/claude/agent.ts`). Skills
  resolve inside the CLI — Custie itself has no skill awareness.
- Custie runs in Socket Mode, so slash commands work via Bolt's
  `app.command()` with no public URL.
- Skills are dynamic and cwd-dependent (channel-scoped working directories),
  so they cannot each be registered as a static slash command.

## Design

### UX

- The `/` menu shows `/custie` with usage hint `skills | help`.
- `/custie skills` → Custie posts a message with a searchable select dropdown
  of every skill available in that channel's working directory. Typing filters
  the list — this is the autocomplete behaviour.
- Selecting a skill → Custie engages it: a prompt is fed into the normal agent
  flow ("the user wants to use the `<skill>` skill — invoke it and ask what
  they need"), and the thread conversation continues in that skill's context.
- `/custie help` → short text listing what Custie can do (skills, automations,
  channels).
- Unknown or empty subcommand → behaves like `help`.

### Skill discovery

Scan the filesystem — fast, no token cost, no Claude round-trip:

- `<claudeConfigDir>/skills/*/SKILL.md` — user skills
- `<channel cwd>/.claude/skills/*/SKILL.md` — project skills
- `<claudeConfigDir>/plugins/cache/*/*/*/skills/*/SKILL.md` — plugin skills

Parse YAML frontmatter for `name` and `description`; dedupe by name.
`claudeConfigDir` comes from the active profile (the value already passed to
the agent); the cwd comes from the channel config.

### Slack 3-second ack

Slash commands must be acknowledged within 3s. The handler calls `ack()`
immediately, then posts the result. The filesystem scan is fast, so there is
no timeout risk.

## Plan

1. **Manifest** — add `/custie` to `slack-app-manifest.yml` under
   `features.slash_commands` (no `url` needed in Socket Mode). Note that the
   app must be reinstalled to register the command.
2. **Skill discovery module** — new `src/claude/skills.ts` exposing
   `listSkills(configDir, cwd)` → `{ name, description, source }[]`. Reuse the
   existing config-dir / cwd resolution.
3. **Command handler** — new `src/slack/commands.ts` registering
   `app.command('/custie')`, parsing the first token as the subcommand and
   routing to `skills` / `help`. Wire it into listener registration.
4. **Blocks** — add a skill-dropdown builder to `src/slack/blocks.ts`
   (Block Kit `static_select`) and a select `action` handler alongside
   `src/slack/buttons.ts` that engages the chosen skill via the existing
   message queue / agent flow.
5. **Help text** — a small static help message.
6. **Docs** — note the manifest change and reinstall step in `README.md`.

## Scope

**In (MVP):** `/custie skills` (dropdown) and `/custie help`.

**Out:** per-skill slash commands; auto-running a skill without a task
description; other subcommands such as `/custie automations` (easy to add
later on the same handler).

## Open question

Selecting a skill currently "engages the skill and asks for the task".
Alternative: just show the skill's description and let the user type their
request. Defaulting to engage.
