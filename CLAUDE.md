# Custie - Claude Code Project Guide

## What This Is

Slack bot that bridges Slack messages to Claude Code via the Claude CLI. Users mention the bot or DM it; messages are queued per-thread, sent to Claude, and responses are posted back to Slack.

## Architecture

```
Slack (Socket Mode) → listeners.ts → MessageQueue → agent.ts (Claude CLI) → formatters.ts → Slack
                                                        ↕
                                                  session-store.ts (SQLite)
```

- **CLI entry:** `src/cli.ts` — parses commands and delegates to `src/commands/`
- **Server entry:** `src/index.ts` — exports `startServer()` for the `start` command
- **Paths:** `src/paths.ts` — XDG-compliant path management (`~/.config/custie/`, `~/.local/share/custie/`)
- **Config:** `src/config.ts` — loads env files (XDG config.env → repo .env → process env)
- **Slack handling:** `src/slack/listeners.ts` registers `app_mention` and `message` event handlers
- **Claude integration:** `src/claude/agent.ts` spawns the Claude CLI (`claude -p`) as a subprocess
- **Session storage:** `src/store/session-store.ts` uses better-sqlite3 with WAL mode
- **Message queue:** `src/queue/message-queue.ts` ensures serial processing per thread
- **Formatters:** `src/slack/formatters.ts` converts Markdown to Slack mrkdwn and splits long messages

## CLI Commands

```bash
custie start             # Start the Slack bot server
custie setup             # Interactive setup (guided or browser-automated)
custie install           # Install as system service (launchd on macOS, systemd on Linux)
custie uninstall         # Remove the system service
custie upgrade           # Upgrade to the latest version
custie prompt            # Edit the system prompt in $EDITOR
custie config            # Show resolved config (paths, loaded values with tokens masked)
custie config --edit     # Open config.env in $EDITOR
custie config --path     # Print the config file path
custie slack channels    # List channels the bot is in
custie slack users       # List workspace users
custie slack channel-info <name-or-id>  # Channel details
custie slack user-info <name-or-id>     # User details
custie slack post --channel <ch> --text <text>  # Post a message
```

## Development Commands

```bash
pnpm run dev             # Hot-reload development server (tsx)
pnpm run build           # Compile to dist/ (tsup, ESM)
pnpm start               # Run compiled CLI (custie start)
pnpm run lint            # oxlint
pnpm run format          # Prettier
```

## Key Patterns

- **Socket Mode** -- no webhooks or public URLs needed
- **Per-thread queuing** -- `MessageQueue` chains promises per `channelId:threadTs` key to prevent race conditions
- **Session resumption** -- Claude sessions are stored in SQLite keyed by `(channel_id, thread_ts)` and resumed via the CLI's `--resume` flag
- **Typing indicator** -- posts a "Thinking..." message first, then updates it with the response
- **Permission gating** -- `ALLOWED_USER_IDS` env var restricts access; empty means open to all
- **Bypass permissions** -- Claude runs with `--dangerously-skip-permissions` so it can operate autonomously
- **XDG paths** -- config in `~/.config/custie/`, data in `~/.local/share/custie/`

## Code Style

- TypeScript strict mode, ES2022 target, ESM modules
- Prettier: 100 char width, 2-space indent, single quotes, trailing commas, semicolons
- Linting: oxlint
- Use `export * from` for re-exports
- No `.js` suffix on relative imports (bundler module resolution)

## Environment Variables

Required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`
Optional: `CLAUDE_CWD` (working directory for Claude), `ALLOWED_USER_IDS` (comma-separated), `OWNER_USER_ID`, `BOT_NAME`, `CLAUDE_CONFIG_DIR`, `MAX_TURNS`

## File Locations

- **Config file:** `~/.config/custie/config.env` (primary) or repo `.env` (fallback)
- **System prompt:** `~/.config/custie/prompt.md` (user-customized) or `system.default.md` (package default). Capabilities from `system.capabilities.md` are always appended at runtime.
- **Database:** `~/.local/share/custie/custie.db`
- **Logs:** `~/.local/share/custie/logs/`

## Database

SQLite file at `~/.local/share/custie/custie.db`. Single `sessions` table with composite PK `(channel_id, thread_ts)`. WAL journal mode for concurrent reads.

## Important Notes

- The bot only responds in channel threads where it was initially mentioned (won't jump into random threads)
- DMs always create/continue sessions; channel messages require an `@mention` to start
- Large responses are split at ~3900 chars (Slack limit is 4000)
- Bot messages and subtype messages are filtered out to prevent loops
