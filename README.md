# Custie

A bidirectional chat server that bridges **Slack** and **Claude Code** via the Claude CLI. Mention the bot in a channel or DM it directly to start an AI-powered conversation that persists across messages.

![Architecture](architecture.svg)

## Features

- **Channel mentions** -- `@custie` in any channel starts a threaded conversation
- **Direct messages** -- DM the bot for private sessions
- **Persistent sessions** -- conversations resume automatically using SQLite-backed storage
- **Markdown conversion** -- translates Markdown to Slack's mrkdwn format
- **Message splitting** -- long responses are split at natural boundaries to respect Slack's limits
- **Per-thread queue** -- messages within a thread are processed serially to prevent race conditions
- **Access control** -- restrict usage to specific Slack user IDs (defaults to owner only)

## Prerequisites

- Node.js 18+
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)

## Installation

### Global install (recommended)

```bash
npm install -g custie
```

### From source

```bash
git clone <repo-url> && cd custie
pnpm install
pnpm run build
```

## Quick Start

### 1. Setup Slack App & config

```bash
custie setup
```

This will:

1. Guide you to create a Slack App using the bundled manifest (`slack-app-manifest.yml`)
2. Prompt you for Slack tokens (Bot Token, App Token, Signing Secret)
3. Prompt you for bot config (working directory, bot name, owner ID, allowed users)
4. Write everything to `~/.config/custie/config.env`
5. Copy the default system prompt to `~/.config/custie/prompt.md`

> **Automated mode:** If you have Playwright installed, run `custie setup --browser` to automate the Slack App creation in a browser — you only need to log in.

### 2. Start the bot

```bash
custie start
```

### 3. Install as a system service (optional)

```bash
custie install
```

Installs Custie as a background service that starts automatically:
- **macOS:** LaunchAgent (`launchctl`)
- **Linux:** systemd user service

To remove:

```bash
custie uninstall
```

## CLI Commands

| Command | Description |
|---|---|
| `custie setup` | Interactive first-time setup (Slack App + config) |
| `custie setup --browser` | Automated setup via Playwright browser automation |
| `custie start` | Start the bot in foreground |
| `custie install` | Install as a system service |
| `custie uninstall` | Remove the system service |
| `custie prompt` | Edit the system prompt in `$EDITOR` |
| `custie config` | Show current config (paths, values with masked tokens) |
| `custie config --edit` | Edit config in `$EDITOR` |
| `custie config --path` | Print the config file path |

## Slack App Configuration

The easiest way is `custie setup`, which guides you through everything. If you prefer manual setup:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. Paste the contents of `slack-app-manifest.yml`
3. Generate an App-Level Token with `connections:write` scope
4. Install to your workspace
5. Copy the three tokens into `~/.config/custie/config.env`

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | App-Level Token with `connections:write` (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Yes | Found in your Slack app's Basic Information page |
| `CLAUDE_CWD` | No | Working directory for Claude sessions (defaults to `$HOME`) |
| `CLAUDE_CONFIG_DIR` | No | Custom Claude config directory |
| `BOT_NAME` | No | Display name in system prompt (default: `Custie`) |
| `OWNER_USER_ID` | No | Your Slack user ID for mention monitoring |
| `ALLOWED_USER_IDS` | No | Comma-separated Slack user IDs (defaults to owner; empty = everyone) |

## File Locations

Custie follows [XDG Base Directory](https://specifications.freedesktop.org/basedir-spec/latest/) conventions:

| Path | Contents |
|---|---|
| `~/.config/custie/config.env` | Slack tokens and bot configuration |
| `~/.config/custie/prompt.md` | Customisable system prompt |
| `~/.local/share/custie/custie.db` | SQLite session database |
| `~/.local/share/custie/logs/` | Service logs |

## Interacting with the Bot

- **In a channel:** mention `@custie` with your question. Follow-up messages in the thread continue the conversation (no need to re-mention).
- **In a DM:** just send a message. Every message continues the session for that DM (or thread within the DM).

## Development

```bash
pnpm run dev          # Hot-reload via tsx
pnpm run build        # Compile to dist/
pnpm run lint         # oxlint
pnpm run format       # Prettier
```

## Project Structure

```
src/
  cli.ts                   # CLI entry point (command routing)
  index.ts                 # Server entry (exports startServer)
  paths.ts                 # XDG-compliant path management
  config.ts                # Layered env file loading
  commands/
    setup.ts               # Interactive Slack App setup + config
    start.ts               # Start the bot server
    install.ts             # System service installation
    uninstall.ts           # System service removal
    prompt.ts              # Edit system prompt in $EDITOR
    config.ts              # Show/edit configuration
    index.ts               # Re-exports
  slack/
    app.ts                 # Slack Bolt app factory (Socket Mode)
    listeners.ts           # Event handlers for mentions, DMs, and threads
    formatters.ts          # Markdown-to-Slack conversion and message splitting
  claude/
    agent.ts               # Claude CLI subprocess integration
  queue/
    message-queue.ts       # Per-thread serial message processing
  store/
    session-store.ts       # SQLite session persistence (WAL mode)
```

## Tech Stack

- **TypeScript** with strict mode, ES2022 target
- **@slack/bolt** -- Slack app framework (Socket Mode)
- **Claude CLI** -- Claude Code integration (spawned as subprocess)
- **better-sqlite3** -- session storage with WAL journalling
- **tsup** -- bundler for ESM output
- **oxlint** + **Prettier** -- linting and formatting

## Licence

Private -- all rights reserved.
