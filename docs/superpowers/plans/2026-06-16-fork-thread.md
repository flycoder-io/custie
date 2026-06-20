# Fork Thread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Fork thread" Slack message shortcut that summarises the current Custie session and opens a new thread in the same channel with that summary as context.

**Architecture:** A `app.shortcut('custie_fork', ...)` handler is added inside `registerListeners()` in `src/slack/listeners.ts`. It resolves the thread root from the shortcut payload, calls Claude to generate a summary (resuming the existing session if one exists, otherwise building context from Slack thread messages), posts the summary as a new root-level message, and notifies the original thread with a permalink.

**Tech Stack:** `@slack/bolt` shortcut handler, existing `askClaude()` + `fetchThreadContext()` + `markdownToBlocks()` utilities already imported in `listeners.ts`.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/slack/listeners.ts` | Modify | Add `app.shortcut('custie_fork', ...)` inside `registerListeners()` |
| Slack app config | Manual step | Register the message shortcut in the Slack app dashboard |

---

### Task 1: Register the Slack message shortcut in the app dashboard

This is a one-time manual config step — no code changes.

- [ ] **Step 1: Open the Slack app config**

Go to `https://api.slack.com/apps`, select the Custie app, then navigate to **Features → Interactivity & Shortcuts → Shortcuts**.

- [ ] **Step 2: Add a new message shortcut**

Click "Create New Shortcut" → "On messages". Fill in:

| Field | Value |
|-------|-------|
| Name | Fork thread |
| Short description | Summarise and fork this conversation into a new thread |
| Callback ID | `custie_fork` |

Click "Save Changes", then **reinstall the app** (Slack requires reinstall after shortcut changes).

- [ ] **Step 3: Verify the shortcut appears**

Open any Slack channel where Custie is present, hover a message, click `...` — "Fork thread" should appear in the list.

---

### Task 2: Add the `custie_fork` shortcut handler to `listeners.ts`

The handler goes inside `registerListeners()`, after the existing `app.action(SKILL_SELECT_ACTION_ID, ...)` block and before the `return` statement.

- [ ] **Step 1: Add the handler**

In `src/slack/listeners.ts`, insert the following block just before the final `return { drain: ..., pendingCount: ... }` statement:

```typescript
  // "Fork thread" message shortcut. Summarises the current session (or Slack
  // thread messages as fallback) and opens a new root-level thread in the same
  // channel with the summary as context.
  app.shortcut('custie_fork', async ({ shortcut, ack, client }) => {
    await ack();

    if (shortcut.type !== 'message_action') return;

    const userId = shortcut.user.id;
    const channelId = shortcut.channel.id;
    if (!isAccessAllowed(userId, channelId)) return;

    // Resolve thread root: if the shortcut was invoked on a reply, thread_ts
    // is the root; if invoked on the root itself, fall back to message ts.
    const messageTs = shortcut.message.ts;
    const threadTs = (shortcut.message as { thread_ts?: string }).thread_ts ?? messageTs;

    const session = store.getSession(channelId, threadTs);
    const cwd = resolveCwd(undefined, channelId, claudeCwd);

    const FORK_PROMPT =
      'Please summarise this conversation concisely for a forked thread. Include:\n' +
      '- Key topics and context\n' +
      '- Decisions or conclusions reached\n' +
      '- Open questions / next steps\n\n' +
      'Keep it brief — this will be the opening message of the new thread.';

    // Primary path: resume existing Claude session to generate the summary.
    let summaryResponse: ClaudeResponse | null = null;
    if (session?.sessionId) {
      try {
        summaryResponse = await askClaude(
          FORK_PROMPT,
          cwd,
          botName,
          { model, maxBudgetUsd },
          claudeConfigDir,
          session.sessionId,
        );
        if (summaryResponse.isError) summaryResponse = null;
      } catch {
        summaryResponse = null;
      }
    }

    // Fallback: compile Slack thread messages and summarise from scratch.
    if (!summaryResponse) {
      const botId = await ensureBotUserId(client);
      const threadContext = await fetchThreadContext(client, channelId, threadTs, botId);
      if (!threadContext) {
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: '找不到這個 thread 的對話內容，無法 fork。',
        });
        return;
      }
      try {
        summaryResponse = await askClaude(
          threadContext + '\n\n' + FORK_PROMPT,
          cwd,
          botName,
          { model, maxBudgetUsd },
          claudeConfigDir,
        );
        if (summaryResponse.isError) summaryResponse = null;
      } catch {
        summaryResponse = null;
      }
    }

    if (!summaryResponse) {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: '摘要產生失敗，請稍後再試。',
      });
      return;
    }

    // Post summary as a new root-level message (no thread_ts = new thread root).
    const rtBlocks = markdownToBlocks(summaryResponse.text);
    const newMsg = rtBlocks.length > 0
      ? await client.chat.postMessage({
          channel: channelId,
          text: blockToFallbackText(rtBlocks[0]!),
          blocks: rtBlocks as never,
        })
      : await client.chat.postMessage({
          channel: channelId,
          text: toSlackMarkdown(summaryResponse.text),
        });

    const newTs = (newMsg as { ts: string }).ts;
    const newTsForLink = newTs.replace('.', '');
    const authInfo = await client.auth.test();
    const workspaceUrl = (authInfo.url as string).replace(/\/$/, '');
    const permalink = `${workspaceUrl}/archives/${channelId}/p${newTsForLink}`;

    // Notify the original thread.
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🍴 Forked → <${permalink}>`,
    });
  });
```

- [ ] **Step 2: Verify the import for `ClaudeResponse` is already in scope**

Check the top of `listeners.ts` — the line `import { askClaude, type ClaudeResponse } from '../claude/agent'` must include `ClaudeResponse`. If it only imports `askClaude`, add `type ClaudeResponse` to the import. No other new imports are needed — `markdownToBlocks`, `blockToFallbackText`, `toSlackMarkdown`, `resolveCwd`, `fetchThreadContext`, `ensureBotUserId`, `store`, `isAccessAllowed`, `botName`, `model`, `maxBudgetUsd`, `claudeCwd`, `claudeConfigDir` are all already in scope inside `registerListeners()`.

- [ ] **Step 3: Build to catch type errors**

```bash
pnpm run build
```

Expected: clean build, no TypeScript errors. If `shortcut.message` type does not expose `thread_ts`, the cast `(shortcut.message as { thread_ts?: string }).thread_ts` handles it — no change needed.

- [ ] **Step 4: Reload the running service**

```bash
pnpm run reload
```

Expected: service restarts without errors. Check logs at `~/.local/share/custie/logs/` if it fails.

- [ ] **Step 5: Commit**

```bash
git add src/slack/listeners.ts
git commit -m "feat: add Fork thread message shortcut (custie_fork)"
```

---

### Task 3: Manual verification

- [ ] **Step 1: Test happy path (active session)**

In any Slack channel where Custie is running:
1. Start a thread with `@Custie` and exchange at least 2-3 messages so a session is created in SQLite.
2. Hover any message in that thread, click `...` → "Fork thread".
3. Expected:
   - A new root-level message appears in the channel containing a concise summary.
   - The original thread receives a reply: `🍴 Forked → <link>`.
   - Clicking the link jumps to the new thread.

- [ ] **Step 2: Test fallback (no session)**

1. Manually delete the session row from SQLite:
   ```bash
   sqlite3 ~/.local/share/custie/custie.db \
     "DELETE FROM sessions WHERE channel_id = '<channelId>' AND thread_ts = '<threadTs>';"
   ```
2. Use the "Fork thread" shortcut on the same thread.
3. Expected: same result as Step 1 — summary is generated from Slack messages instead of the Claude session.

- [ ] **Step 3: Test empty thread (error path)**

1. Post a plain message in a channel (not via Custie, so no session), then immediately use "Fork thread" before any replies exist.
2. Expected: ephemeral message to you only — "找不到這個 thread 的對話內容，無法 fork。"

- [ ] **Step 4: Verify new thread continues normally**

After forking, `@mention` Custie in the new thread with a follow-up question.

Expected: Custie responds with context from the summary (no session yet — it uses `fetchThreadContext()` to pick up the summary, then saves a fresh session for the new thread).
