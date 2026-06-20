# Fork Thread Feature Design

**Date:** 2026-06-16
**Status:** Approved

## Overview

Add a "Fork thread" capability to Custie. When a conversation grows long or diverges in direction, the user can fork it: Custie summarises the current session and opens a new thread in the same channel with that summary as the starter, so the conversation can continue with a clean slate.

## Trigger

A **Slack message shortcut** registered as `custie_fork`.

- Appears in the `...` menu on any message in a thread
- Shortcut payload includes `channel.id` and `message.thread_ts`, giving unambiguous thread identity
- This is preferred over a slash command (which does not include `thread_ts`) and over an in-thread keyword (which is too ambiguous)

The shortcut must be added to the Slack app manifest:
```json
{
  "type": "message",
  "name": "Fork thread",
  "callback_id": "custie_fork"
}
```

## Summary Generation

1. Look up `(channelId, threadTs)` in `SessionStore` to get `sessionId`
2. **Has session:** call `askClaude()` with `--resume <sessionId>` and the fork summary prompt below
3. **No session (fallback):** fetch messages via `conversations.replies()`, format them as a transcript, send to a fresh `askClaude()` call to summarise

Fork summary prompt:
```
Please summarise this conversation concisely for a forked thread. Include:
- Key topics and context
- Decisions or conclusions reached
- Open questions / next steps

Keep it brief — this will be the opening message of the new thread.
```

The `cwd` and model used are the same as for normal interactive messages in that channel.

## New Thread Creation

1. Post the summary as a **root-level** `chat.postMessage` in the same channel (no `thread_ts`). The returned `ts` is the new thread root.
2. No session is pre-created for the new thread. The first `@mention` in the new thread triggers the normal flow; `fetchThreadContext()` pulls the summary and gives Claude the necessary context.

## Original Thread Notification

Post a reply in the original thread:
```
🍴 Forked → <https://workspace.slack.com/archives/{channelId}/p{newTs_no_dot}>
```

The workspace URL is obtained from `client.auth.test().url` (e.g. `https://myteam.slack.com/`). The `ts` dot must be removed for the permalink: `1234567890.123456` → `p1234567890123456`.

## Files Changed

| File | Change |
|------|--------|
| `src/slack/listeners.ts` | Add `app.shortcut('custie_fork', ...)` handler |
| Slack app manifest | Add message shortcut entry |

No changes to `SessionStore`, `agent.ts`, or `formatters.ts`.

## Error Handling

- If summary generation fails, post an ephemeral error message to the user (do not open a new thread)
- Access check: apply the same `isAccessAllowed()` gate as other handlers
- The shortcut is ephemeral-ack'd immediately; all async work runs after `ack()`
