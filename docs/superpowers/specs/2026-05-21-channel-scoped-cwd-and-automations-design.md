# Channel-scoped working directory & automations

- **Date:** 2026-05-21
- **Status:** Approved design, pending implementation plan
- **Branch context:** `feat/profiles`

## Problem

Within a single profile, every interactive message and every channel-less
automation spawns Claude in one working directory — `CLAUDE_CWD`. When different
Slack channels map to different repos, Claude can't get a focused working
directory per channel: its context (CLAUDE.md loading, file search, git state)
is anchored to whatever `CLAUDE_CWD` happens to be.

The goal is to let each channel carry its own `cwd` and its own automations,
**without migrating the existing `automations.yml`**.

## Goals

- A channel can declare its own working directory.
- New, channel-specific automations live next to that channel's `cwd`.
- `automations.yml` is untouched — no migration, no risk to existing automations.
- Files stay git-friendly and live-reloaded, consistent with `config.env` and
  `automations.yml`.

## Non-goals

- Per-channel system prompt (natural future extension; `channels.yml` is the
  home for it, but out of scope here).
- Sandboxing / restricting which paths Claude may touch.
- Any change to profiles — `flycoder` / `ignition` stay as they are.

## Design

### 1. New file: `channels.yml`

Lives in the profile config dir (`paths.CONFIG_DIR`), alongside `config.env` and
`automations.yml`. Keyed by Slack **channel ID** (stable; names can change).

```yaml
channels:
  C0B59QDDF8U:
    name: custie-dev                            # optional, human label only
    cwd: ~/Workspaces/Flycoder/Repos/custie      # ~ is expanded
    automations:                                 # optional
      schedules:
        - name: custie-nightly-test
          cron: 0 22 * * *
          prompt: Run the test suite and report failures.
      triggers: []
      mention_triggers: []
```

`cwd` is required per channel; `~` and relative paths are expanded on load.

### 2. cwd resolution

A single resolver, `resolveChannelCwd(channelId): string | undefined`, backed by
the in-memory channel registry. Precedence everywhere:

```
explicit automation.cwd  >  channels[channelId].cwd  >  CLAUDE_CWD
```

Interactive messages have no explicit cwd, so they resolve to
`channels[channelId].cwd ?? CLAUDE_CWD`.

Call sites to update:

| Site | File | Resolve by |
|------|------|------------|
| Interactive `handleMessage` | `src/slack/listeners.ts` | `channelId` |
| Pattern trigger dispatch | `src/slack/listeners.ts` (~376) | `event.channel` |
| Mention-trigger dispatch | `src/slack/listeners.ts` (~442) → `mention-trigger-engine.ts` (~175) | `trigger.target_channel` |
| Scheduler | `src/automations/index.ts` (~50) | `schedule.channel` |
| `custie automation run` | `src/commands/automation.ts` (~209) | `automation.channel` |

### 3. Automation loading (merge)

`automations.yml` and `channels.yml` are merged into one effective list at load
time. The runner, scheduler, and engines consume the merged list and behave
exactly as today.

- `loadAutomations()` — unchanged; reads `automations.yml` only.
- `loadChannels()` — new; reads + parses `channels.yml`.
- `loadEffectiveAutomations()` — new; returns `loadAutomations()` plus every
  channel block's automations, with `channel` and `cwd` injected from the block.

No source tag is stored on the runtime objects — the CLI re-derives an
automation's source file by name when it needs to mutate it.

### 4. Nested automation shape & inheritance

A nested automation uses the same schema as a top-level one, minus the fields
the parent block supplies:

- `channel` — omitted; injected from the block key.
- `cwd` — omitted; inherited from the block's `cwd`. An explicit `cwd` still
  overrides (escape hatch).
- Trigger `channels` — omitted; implicitly `[<blockId>]`. Nested triggers are
  single-channel by definition.
- Mention-trigger `target_channel` — omitted; injected as `<blockId>`.

Validation is relaxed for nested entries: the injected fields are not required
in the YAML.

### 5. CLI routing (`custie automation ...`)

Name uniqueness is enforced **across both files**.

- `list` / `remove` / `enable` / `disable` / `run` / `get` — operate across both
  files: search both, mutate the file the automation actually lives in. This is
  a **must** — otherwise these break for channel-scoped automations.
- `list` — group output by channel, show resolved `cwd`.
- `add` — keeps writing to `automations.yml` by default (no behaviour change).
  A new `--channel-scoped` flag, used with `--channel <id>`, writes the entry
  under that channel's block in `channels.yml`, creating the block if absent.
- `saveChannels()` — new writer for `channels.yml`, mirroring `saveAutomations()`.

### 6. File watching

`src/automations/index.ts` already watches `AUTOMATIONS_FILE` with a debounced
`reload()`. Add a second watcher on `CHANNELS_FILE` wired to the same `reload()`,
which also refreshes the channel registry (so `resolveChannelCwd` stays current).

## Files touched

- `src/paths.ts` — add `CHANNELS_FILE` getter.
- `src/channels.ts` *(new)* — load/parse/expand `channels.yml`, channel registry,
  `resolveChannelCwd()`, `saveChannels()`.
- `src/automations/config.ts` — add `loadChannels()`, `loadEffectiveAutomations()`;
  relax validation for nested entries.
- `src/automations/index.ts` — consume merged loader; watch `CHANNELS_FILE`;
  scheduler cwd gains the channel layer.
- `src/automations/manager.ts` — `remove`/`enable`/`disable`/`get` search both
  files; `add` honours `--channel-scoped`.
- `src/slack/listeners.ts` — interactive + trigger cwd use the resolver.
- `src/automations/mention-trigger-engine.ts` — cwd uses the resolver.
- `src/commands/automation.ts` — `--channel-scoped` flag; `list` grouped output.

## Edge cases

- **`channel` as `#name` vs ID** — the resolver does an ID-keyed lookup only.
  Legacy `automations.yml` entries that use `#name` simply don't inherit a
  channel cwd and fall back to `CLAUDE_CWD` (unchanged from today). Nested
  automations never hit this — their channel is the block key (an ID).
- **`channels: "*"` / multi-channel triggers** — no single owning channel; these
  stay in `automations.yml`. Nested triggers are single-channel only.
- **Name collision across files** — `add` validates uniqueness against both;
  the merge loader logs a warning and skips a duplicate name.
- **`cwd` points to a missing directory** — log a warning on load, fall back to
  `CLAUDE_CWD` for that channel.
- **`channels.yml` missing or empty** — empty registry; everything falls back to
  `CLAUDE_CWD` (current behaviour preserved).

## Testing

- Unit: `resolveChannelCwd` (ID hit / miss / `~` expansion / missing dir).
- Unit: `loadEffectiveAutomations` merges `automations.yml` + channel blocks;
  nested entries inherit `channel` + `cwd`; explicit `cwd` overrides.
- Unit: CLI routing — `add --channel-scoped` writes to `channels.yml`;
  `remove`/`enable`/`disable` find entries in either file.
- Unit: precedence `explicit cwd > channel cwd > CLAUDE_CWD`.
- Manual: start the bot, message a mapped channel, confirm the spawn directory
  in the `[agent] spawning claude CLI in <cwd>` log line.

## Out of scope

Per-channel system prompt, path sandboxing, multi-channel cwd inheritance,
profile-level changes.
