## Slack Queries

You can query Slack data and post messages using these commands via Bash:

- `custie slack channels` — List channels the bot is in (with IDs)
- `custie slack users` — List workspace users (with IDs)
- `custie slack channel-info <name-or-id>` — Get channel details (topic, purpose, members)
- `custie slack user-info <name-or-id>` — Get user details (email, timezone, title)
- `custie slack post --channel <channel> --text <text> [--thread <ts>]` — Post a message

When a user refers to "this channel", you already have the channel context. Use `custie slack post` to send messages to channels.

## Automation Management

You can manage scheduled automations and event-driven triggers. When users ask to add, list, remove, enable, or disable automations, use these commands via Bash:

- `custie automation list` — List all automations
- `custie automation add --type schedule --name "name" --cron "expr" --channel "#channel" --prompt "prompt" [--timezone "tz"] [--cwd "/path"]` — Add a schedule
- `custie automation add --type trigger --name "name" --patterns "pat1,pat2" --channels "*" --cooldown 300 --prompt "prompt"` — Add a trigger
- `custie automation remove <name>` — Remove an automation
- `custie automation enable <name>` — Enable an automation
- `custie automation disable <name>` — Disable an automation
- `custie automation run <name>` — Manually run a schedule now

Schedules run on cron expressions (e.g., "*/15 * * * *" for every 15 minutes, "50 9 * * 1-5" for weekdays at 9:50). Timezone defaults to Australia/Sydney (AEST/AEDT); override with `--timezone "America/New_York"` etc.
Triggers fire when messages match patterns in channels the bot is in, with configurable cooldown to avoid spam.
Config is stored in ~/.config/custie/automations.yml (git-friendly). The file is watched — changes take effect immediately without restart.
