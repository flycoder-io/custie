# Custie - Claude Code Project Guide

## What This Is

Slack bot that bridges Slack messages to Claude Code via the Claude CLI. Users mention the bot or DM it; messages are queued per-thread, sent to Claude, and responses are posted back to Slack.

## Architecture

```
Slack (Socket Mode) → listeners.ts → MessageQueue → agent.ts (Claude CLI) → formatters.ts → Slack
                                                        ↕
                                                  session-store.ts (SQLite)
```

- **Entry point:** `src/index.ts`
- **Config:** `src/config.ts` loads from `.env` via dotenv
- **Slack handling:** `src/slack/listeners.ts` registers `app_mention` and `message` event handlers
- **Claude integration:** `src/claude/agent.ts` spawns the Claude CLI (`claude -p`) as a subprocess
- **Session storage:** `src/store/session-store.ts` uses better-sqlite3 with WAL mode
- **Message queue:** `src/queue/message-queue.ts` ensures serial processing per thread
- **Formatters:** `src/slack/formatters.ts` converts Markdown to Slack mrkdwn and splits long messages

## Key Patterns

- **Socket Mode** -- no webhooks or public URLs needed
- **Per-thread queuing** -- `MessageQueue` chains promises per `channelId:threadTs` key to prevent race conditions
- **Session resumption** -- Claude sessions are stored in SQLite keyed by `(channel_id, thread_ts)` and resumed via the CLI's `--resume` flag
- **Typing indicator** -- posts a "Thinking..." message first, then updates it with the response
- **Permission gating** -- `ALLOWED_USER_IDS` env var restricts access; empty means open to all
- **Bypass permissions** -- Claude runs with `--dangerously-skip-permissions` so it can operate autonomously

## Commands

```bash
npm run dev          # Hot-reload development server (tsx watch)
npm run build        # Compile to dist/ (tsup, ESM)
npm start            # Run compiled server
npm run lint         # oxlint
npm run format       # Prettier
npm run setup        # Interactive first-time setup
```

## Code Style

- TypeScript strict mode, ES2022 target, ESM modules
- Prettier: 100 char width, 2-space indent, single quotes, trailing commas, semicolons
- Linting: oxlint
- Use `export * from` for re-exports
- No `.js` suffix on relative imports (bundler module resolution)

## Environment Variables

Required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`
Optional: `CLAUDE_CWD` (working directory for Claude), `ALLOWED_USER_IDS` (comma-separated)

## Database

SQLite file `custie.db` at project root. Single `sessions` table with composite PK `(channel_id, thread_ts)`. WAL journal mode for concurrent reads.

## Important Notes

- The bot only responds in channel threads where it was initially mentioned (won't jump into random threads)
- DMs always create/continue sessions; channel messages require an `@mention` to start
- Large responses are split at ~3900 chars (Slack limit is 4000)
- Bot messages and subtype messages are filtered out to prevent loops
