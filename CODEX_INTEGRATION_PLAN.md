# Codex Integration Plan

Add OpenAI Codex CLI as a second agent backend alongside the existing Claude CLI.

## Goal

Let users pick between Claude and Codex per-message (or per-channel default) without changing the rest of the Slack/SQLite/automation flow.

## Current State

- `src/claude/agent.ts` — single function `askClaude()` spawns `claude` CLI as a subprocess, parses JSON output, returns `{ sessionId, text }`.
- `src/slack/listeners.ts:233` — only caller of `askClaude`.
- `src/store/session-store.ts` — SQLite table keyed by `(channel_id, thread_ts) → session_id`. Assumes one agent.

## Plan

### 1. Abstract the agent interface

Create `src/agents/` with:

```
src/agents/
  index.ts       # runAgent() dispatcher
  claude.ts      # moved from src/claude/agent.ts
  codex.ts       # new
  types.ts       # shared AgentResponse, AgentKind
```

Shared interface:

```ts
export type AgentKind = 'claude' | 'codex';

export interface AgentResponse {
  sessionId: string;
  text: string;
}

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  botName: string;
  resumeSessionId?: string;
  configDir?: string;
}
```

### 2. Codex adapter (`src/agents/codex.ts`)

- Spawn `codex exec --json <prompt>` (verify exact flag — Codex CLI streams NDJSON by default).
- Parse the final assistant message and session ID from the stream.
- Pass system prompt via `--system` or stdin (whichever Codex supports).
- Resume via `codex exec --resume <session-id>` if available; otherwise treat each call as fresh and store last-N-messages in SQLite as fallback.
- Read `OPENAI_API_KEY` from env; fail clearly if missing.

### 3. Routing — pick agent per message

Two layers, simplest first:

**Per-message prefix** (default):
- `!codex <prompt>` → Codex
- Anything else → Claude

**Per-channel default** (later):
- New `agent_defaults` table: `(channel_id, agent_kind)`
- `custie config set-agent --channel <id> --agent codex`
- Prefix still overrides

### 4. Session store — add `agent_kind`

Migration:

```sql
ALTER TABLE sessions ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'claude';
-- New PK: (channel_id, thread_ts, agent_kind)
```

Reason: same Slack thread could spawn both Claude and Codex sessions if user switches mid-thread. Don't collide their session IDs.

### 5. Update `slack/listeners.ts`

Replace direct `askClaude` import with `runAgent` from `src/agents`. Pass `agentKind` resolved from prefix/default.

### 6. Automations

`src/automations/` triggers also call the agent. Add an optional `agent` field to the YAML schema:

```yaml
- name: morning-summary
  type: schedule
  cron: '50 9 * * 1-5'
  agent: codex   # default: claude
  prompt: ...
```

## Out of Scope (for now)

- Streaming partial output to Slack (Codex supports it, Claude CLI's `--print` doesn't — keep both as one-shot for now).
- Tool/MCP parity — Codex tool ecosystem differs from Claude's.
- Cost reporting per agent.

## Effort Estimate

- Abstract + Claude move: 1h
- Codex adapter + parser: 2-3h (depends on output format quirks)
- Session-store migration: 30m
- Routing + listener wiring: 1h
- Automations YAML: 30m
- Testing both agents in real Slack threads: 1h

**Total: ~half a day** assuming Codex CLI output behaves.

## Open Questions

1. Which Codex CLI exactly? OpenAI's official `codex` (https://github.com/openai/codex) vs. a third-party wrapper?
2. Does Codex CLI support `--resume <session-id>` in non-interactive mode?
3. Auth model — API key only, or does it need `codex login` first like the interactive mode?

These need answers before starting step 2.
