---
name: health-check
description: Diagnose the custie Slack bot — check whether the service is running, verify config is loadable, and surface recent errors from logs. Use this whenever the user asks "is custie running?", "is the bot up?", "check custie status/health", mentions the bot being down, slow, unresponsive, restarting, or wants to see custie's recent errors/logs. Trigger even when the word "health" is absent — any diagnostic, status, or "why isn't it working" question about custie counts.
---

# Custie Health Check

Custie runs as a long-lived background service (launchd on macOS, systemd --user on Linux) that bridges Slack to the Claude CLI. When something is wrong, the cause is almost always one of four things:

1. The service isn't loaded / crashed on startup
2. The config file is missing required Slack tokens
3. Slack connection is failing (auth, socket mode, rate limits)
4. The underlying `claude` CLI is failing for specific threads

This skill runs a single diagnostic script that covers 1–3 and surfaces symptoms of 4.

## How to use it

Run the bundled script and report the output back to the user. Don't reinvent the checks inline — the script knows the service label, log paths, and required config keys and handles both macOS and Linux.

```bash
bash "$(git rev-parse --show-toplevel)/.claude/skills/health-check/scripts/check.sh"
```

It exits 0 on healthy, 1 when any check fails. It prints six sections:

- **Service** — launchd/systemd state, PID, last exit code, process start time, uptime
- **Config** — `~/.config/custie/config.env` exists and has the three required Slack keys; `custie config` loads without error
- **Logs** — paths and last-write time of `custie.log` and `custie-error.log`, plus a tail of stderr if non-empty
- **Recent connection events** — the last 10 `[custie] starting / started / socket connected / reconnecting / disconnected / shutting down` lines from the stdout log. This is how you see when the bot came back online after the laptop was off or asleep
- **Recent errors in stdout log** — last 10 lines matching `error|fatal|exception|unhandled|uncaught` in the tail of `custie.log`
- **Summary** — `OK` or `ISSUES DETECTED`

## Interpreting the output

Translate the raw report into a short diagnosis for the user. The goal is to answer two questions they actually care about: *is it running right now?* and *what (if anything) is broken?*

- **Service "NOT LOADED"** — the launchd plist isn't installed. Recommend `custie install`.
- **Service "NOT RUNNING" with non-zero last_exit** — it crashed. The stderr tail in the Logs section almost always contains the reason (bad token, port in use, missing `claude` binary on PATH).
- **Config missing keys** — point out exactly which Slack env vars are absent. The bot can't start without all three.
- **`custie config` failed** — config file exists but is malformed (usually a quoting issue in `config.env`). Suggest `custie config --edit`.
- **Healthy service + errors in recent log lines** — the service is up but specific message handlings are failing. Read more of `custie.log` (use `custie logs` or tail `~/.local/share/custie/logs/custie.log`) to see per-thread context before guessing.
- **Healthy service + stale stdout log mtime** — don't treat this alone as a problem. Node fully-buffers stdout when launchd redirects it to a file, so writes can sit in a buffer for a long time. Use uptime + connection events as the source of truth instead. Compare the latest `socket connected` / `socket reconnecting` timestamps with the process uptime: if the process has been running for days and the newest connection event is weeks old, the bot is silent genuinely (check Slack Socket Mode + event subscriptions); if the newest event is recent, the bot is fine and the log mtime is just the buffer.

## When to dig deeper

The script is a first pass. If the user wants to investigate further, the useful follow-ups are:

- `custie logs` — live tail of stdout
- `custie logs --error` — live tail of stderr
- `custie config` — print resolved config with tokens masked
- `launchctl print gui/$(id -u)/io.flycoder.custie` (macOS) — full launchd state including last exit reason and resource limits
- Reading more of `~/.local/share/custie/logs/custie.log` directly when you need context around a specific error line

Don't run these proactively on every invocation — only when the first-pass output points at them.
