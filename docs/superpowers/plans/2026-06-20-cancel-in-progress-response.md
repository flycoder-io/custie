# Cancel In-Progress Response (Keyword Abort) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user abort the Claude run currently in progress for a thread by sending a message whose text is exactly `stop` / `停` / `cancel` / `取消`.

**Architecture:** An in-memory `Map<threadKey, AbortController>` registry tracks the one in-progress run per thread. `runCli` in the agent gains an `AbortSignal` (carried on `CliOptions`) that kills the subprocess (reusing the existing SIGTERM→SIGKILL logic) and resolves with a new `isCancelled` flag. The Slack event handlers intercept exact-match cancel words *before* enqueueing and call `registry.abort(threadKey)`, so the cancel never queues behind the run it is trying to stop.

**Tech Stack:** TypeScript (ESM, strict), Node `child_process`, `@slack/bolt`, `AbortController`/`AbortSignal` (Node built-in).

## Global Constraints

- No new dependencies. Use Node's built-in `AbortController` / `AbortSignal`.
- No test framework (project has none). Verification is `pnpm run build` + `pnpm run lint` per task, plus a final manual Slack run.
- Code style: ES2022, ESM, single quotes, 2-space indent, trailing commas, semicolons; no `.js` suffix on relative imports; `export * from` for re-exports.
- No em dashes / en dashes anywhere in code or comments.
- Cancel words (exact set, lowercased): `stop`, `停`, `cancel`, `取消`. Match only on `text.trim().toLowerCase()` exact equality.
- Cancellation is intentional, not a failure: it must never resolve as `isError`/`isTimeout`, never trigger the retry button (`offerRetry`), self-heal, or session deletion, and must post no message (the 🛑 reaction is the only ack).

---

### Task 1: AbortSignal support in the agent

Add the cancellation plumbing to the Claude subprocess layer so an `AbortSignal` kills the child and surfaces a distinct `isCancelled` result. Pure agent-layer change; nothing in `listeners.ts` uses it yet.

**Files:**
- Modify: `src/claude/agent.ts` (`ClaudeResponse` ~6-31, `CliOptions` 112-115, kill logic 212-224, `runCli` close/error handlers 235-258)

**Interfaces:**
- Produces:
  - `CliOptions.signal?: AbortSignal` — when it fires, `runCli` kills the subprocess.
  - `ClaudeResponse.isCancelled?: boolean` — `true` when the run was aborted via the signal.
  - `askClaude(...)` already forwards `options` (and thus `signal`) into every internal `runCli` call, so no signature change there.

- [ ] **Step 1: Add `isCancelled` to `ClaudeResponse`**

In `src/claude/agent.ts`, add the field to the interface (after `isTimeout?` at line 30):

```typescript
  /**
   * True when the run was deliberately aborted via an AbortSignal (the user
   * sent a cancel keyword). This is NOT a failure: the caller must not retry,
   * self-heal, drop the session, or post anything. Distinct from isTimeout
   * (wall-clock kill) and isError (upstream failure).
   */
  isCancelled?: boolean;
```

- [ ] **Step 2: Add `signal` to `CliOptions`**

Replace the `CliOptions` interface (lines 112-115) with:

```typescript
interface CliOptions {
  model?: string;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}
```

- [ ] **Step 3: Extract the kill logic into a reusable helper inside `runCli`**

In `runCli`, the timeout handler (lines 212-224) currently inlines the SIGTERM→grace→SIGKILL sequence. Replace that handler so it calls a shared `killChild()` defined just above it. Find this block:

```typescript
    const maxDurationMs = getMaxDurationMs();
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[agent] subprocess exceeded ${maxDurationMs / 1000}s — sending SIGTERM (likely stuck on a long-running command)`,
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          console.warn('[agent] subprocess still alive after SIGTERM — sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS).unref();
    }, maxDurationMs);
    timeoutHandle.unref();
```

and replace it with:

```typescript
    // Shared SIGTERM -> grace -> SIGKILL sequence, used by both the wall-clock
    // timeout and the abort-signal (cancel keyword) paths.
    const killChild = (reason: string): void => {
      console.warn(`[agent] killing subprocess (${reason}) — sending SIGTERM`);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          console.warn('[agent] subprocess still alive after SIGTERM — sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS).unref();
    };

    const maxDurationMs = getMaxDurationMs();
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChild(`exceeded ${maxDurationMs / 1000}s, likely stuck on a long-running command`);
    }, maxDurationMs);
    timeoutHandle.unref();

    // Cancellation via AbortSignal (user sent a cancel keyword). Mirrors the
    // timeout path but resolves with isCancelled instead of isTimeout.
    let cancelled = false;
    const signal = options.signal;
    const onAbort = (): void => {
      cancelled = true;
      killChild('aborted by user');
    };
    if (signal) {
      if (signal.aborted) {
        // Already aborted before we even started listening.
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const removeAbortListener = (): void => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
```

- [ ] **Step 4: Resolve with `isCancelled` and clean up the abort listener**

In the `child.on('error', ...)` handler (lines 235-238), add the listener cleanup. Replace:

```typescript
    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });
```

with:

```typescript
    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      removeAbortListener();
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });
```

Then in the `child.on('close', (code) => {...})` handler, after `clearTimeout(timeoutHandle);` (line 241), add the cancel short-circuit so it wins before the timeout/error branches. Change:

```typescript
    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (debug && stderr) {
        console.log(`[agent] stderr: ${stderr.trim()}`);
      }

      if (timedOut) {
```

to:

```typescript
    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      removeAbortListener();
      if (debug && stderr) {
        console.log(`[agent] stderr: ${stderr.trim()}`);
      }

      if (cancelled) {
        resolve({
          sessionId: resumeSessionId ?? '',
          text: '',
          isCancelled: true,
        });
        return;
      }

      if (timedOut) {
```

- [ ] **Step 5: Build and lint**

Run: `pnpm run build && pnpm run lint`
Expected: build succeeds (compiles to `dist/`), lint reports no new errors. The `signal` field and `isCancelled` are now part of the agent API but no caller sets them yet, so behaviour is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/claude/agent.ts
git commit -m "feat: support AbortSignal cancellation in Claude agent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Run registry and `handleMessage` wiring

Add the per-thread registry and make `handleMessage` register an `AbortController` for its run, thread the signal into every `askClaude` call, handle the `isCancelled` result quietly, and always unregister.

**Files:**
- Modify: `src/slack/listeners.ts` (registry near `retryContexts` ~305-320; `handleMessage` body 329-628)

**Interfaces:**
- Consumes: `CliOptions.signal`, `ClaudeResponse.isCancelled` (Task 1).
- Produces (module-local, used by Task 3):
  - `activeRuns: Map<string, AbortController>`
  - `abortRun(threadKey: string): boolean` — aborts and removes the controller for `threadKey`; returns `true` if one was active.
  - Registry key is `` `${channelId}:${sessionKey}` `` — identical to the three `threadKey` values the enqueue sites already compute.

- [ ] **Step 1: Add the registry and `abortRun` helper**

In `src/slack/listeners.ts`, right after the `retryContexts` / `registerRetry` block (after line 320, before `ensureBotUserId`), add:

```typescript
  // In-progress Claude runs, keyed by threadKey (`${channelId}:${sessionKey}`).
  // Lets the cancel-keyword handler abort the run currently executing for a
  // thread. In-memory only: a restart drops it, which is correct because the
  // subprocess dies with the server. At most one entry per thread (the queue
  // serialises per thread, so only one run is ever in progress).
  const activeRuns = new Map<string, AbortController>();
  const abortRun = (threadKey: string): boolean => {
    const ac = activeRuns.get(threadKey);
    if (!ac) return false;
    ac.abort();
    activeRuns.delete(threadKey);
    return true;
  };
```

- [ ] **Step 2: Register/unregister the controller around the run in `handleMessage`**

`handleMessage` (starts line 329) derives the registry key from its `channelId` + `sessionKey` params. Add the controller registration at the very top of the function body, before the `let reacted = false;` line (340):

```typescript
    const threadKey = `${channelId}:${sessionKey}`;
    const abortController = new AbortController();
    activeRuns.set(threadKey, abortController);
```

Then wrap cleanup into the existing `try`. The function has a `try { ... } catch (err) { ... }` (try at 398, catch at 619). Add a `finally` to the catch so the controller is always removed. Change the catch tail (lines 619-628):

```typescript
    } catch (err) {
      console.error('[listener] Error handling message:', err);
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      try {
        await offerRetry(detail);
      } catch (postErr) {
        console.error('[listener] Failed to post retry message:', postErr);
      }
    }
  }
```

to:

```typescript
    } catch (err) {
      console.error('[listener] Error handling message:', err);
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      try {
        await offerRetry(detail);
      } catch (postErr) {
        console.error('[listener] Failed to post retry message:', postErr);
      }
    } finally {
      // Drop our registry entry only if it is still ours. abortRun() may have
      // already deleted it (and a later run for the same thread could have
      // registered a new controller), so never clobber someone else's entry.
      if (activeRuns.get(threadKey) === abortController) {
        activeRuns.delete(threadKey);
      }
    }
  }
```

- [ ] **Step 3: Thread the signal into every `askClaude` call**

Inside the `try`, just after `effectiveModel` is computed (line 416), introduce a single shared options object and use it everywhere. Add after line 416:

```typescript
      // Shared agent options. signal carries cancellation into the subprocess so
      // ALL attempts (first try, transient retry, context-shed retries, poisoned
      // session self-heal) abort together when the user cancels.
      const askOptions = { model: effectiveModel, maxBudgetUsd, signal: abortController.signal };
```

Then replace each occurrence of `{ model: effectiveModel, maxBudgetUsd }` in `handleMessage` with `askOptions`. There are four call sites — lines 426, 438, 490, 519. Each currently reads, e.g.:

```typescript
        response = await askClaude(enrichedPrompt, cwd, botName, { model: effectiveModel, maxBudgetUsd }, claudeConfigDir, sessionId);
```

becomes:

```typescript
        response = await askClaude(enrichedPrompt, cwd, botName, askOptions, claudeConfigDir, sessionId);
```

Apply the same substitution to the two `tryAskFresh` closures (lines 438 and 490) and the transient-retry call (line 519). After this, `grep -n "model: effectiveModel" src/slack/listeners.ts` should return nothing.

- [ ] **Step 4: Handle the cancelled result quietly**

A cancelled run resolves with `isCancelled: true` and is not `isError`, so it sails past the retry/self-heal branches to line 551 (`const resolved: ClaudeResponse = response!;`). Intercept it there. Insert, immediately before line 551 (`const resolved: ClaudeResponse = response!;`):

```typescript
      // User aborted via a cancel keyword. Leave the session untouched (the
      // killed subprocess returns no valid session id, so keep the prior one),
      // post nothing, and skip the retry button. The 🛑 reaction added by the
      // cancel handler is the only acknowledgement.
      if (response?.isCancelled) {
        await clearReaction();
        return;
      }

```

- [ ] **Step 5: Build and lint**

Run: `pnpm run build && pnpm run lint`
Expected: build succeeds, lint clean. `grep -n "model: effectiveModel" src/slack/listeners.ts` returns nothing (all call sites now use `askOptions`).

- [ ] **Step 6: Commit**

```bash
git add src/slack/listeners.ts
git commit -m "feat: track in-progress runs and honour cancellation in handleMessage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Cancel-keyword interception in the event handlers

Intercept exact-match cancel words in both `app_mention` and `message` handlers, before enqueueing, and abort the in-progress run for that thread.

**Files:**
- Modify: `src/slack/listeners.ts` (module-level constant near the top; `app_mention` handler 630-687; `message` handler DM/auto-respond branch 815-850 and thread-followup branch 855-894)

**Interfaces:**
- Consumes: `abortRun(threadKey)` (Task 2).
- Produces: `CANCEL_WORDS: Set<string>` and a `tryCancel(...)` helper used by both handlers.

- [ ] **Step 1: Add the `CANCEL_WORDS` constant and `tryCancel` helper**

Place `CANCEL_WORDS` with the other module-level constants near the top of `listeners.ts` (alongside `THINKING_REACTION`):

```typescript
// Exact-match words (after trim + lowercase) that abort the in-progress run for
// a thread. Matched on the whole message only, so "stop the server" is a normal
// message, not a cancel.
const CANCEL_WORDS = new Set(['stop', '停', 'cancel', '取消']);
```

Add the `tryCancel` helper inside the listener-registration closure, just after the `abortRun` definition from Task 2:

```typescript
  // If `text` is exactly a cancel word AND a run is in progress for this thread,
  // abort it, acknowledge with a 🛑 reaction, and report handled. Returns false
  // (caller proceeds normally) when the text is not a cancel word, or when no run
  // is active — in which case the word is treated as an ordinary message.
  const tryCancel = async (
    client: App['client'],
    channelId: string,
    threadKey: string,
    text: string,
    reactTs: string,
  ): Promise<boolean> => {
    if (!CANCEL_WORDS.has(text.trim().toLowerCase())) return false;
    if (!abortRun(threadKey)) return false;
    try {
      await client.reactions.add({ channel: channelId, timestamp: reactTs, name: 'octagonal_sign' });
    } catch (err) {
      if (debug) console.log('[cancel] Failed to add stop reaction:', err);
    }
    return true;
  };
```

- [ ] **Step 2: Wire `tryCancel` into the `app_mention` handler**

In `app_mention`, the cleaned text is `basePrompt` (line 642) and `threadKey` is already computed (line 633). Insert the cancel check after `basePrompt` is built and before the file download / enqueue. Add immediately after line 642 (`const basePrompt = ...`):

```typescript
    if (await tryCancel(client, channelId, threadKey, basePrompt, event.ts)) return;
```

- [ ] **Step 3: Wire `tryCancel` into the `message` DM / auto-respond branch**

In the `isDM || isAutoRespondChannel` branch, `threadKey` is computed at line 821 and the raw `text` is in scope. Insert the check after line 821 (`const threadKey = ...`) and before the `downloadSlackFiles` call (823):

```typescript
      if (await tryCancel(client, channelId, threadKey, text, event.ts)) return;
```

- [ ] **Step 4: Wire `tryCancel` into the `message` thread-followup branch**

In the trailing channel thread-followup path, `threadKey` is computed at line 865. Insert the check right after it, before `queue.enqueue` (866):

```typescript
    if (await tryCancel(client, channelId, threadKey, text, event.ts)) return;
```

- [ ] **Step 5: Build and lint**

Run: `pnpm run build && pnpm run lint`
Expected: build succeeds, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/slack/listeners.ts
git commit -m "feat: abort in-progress run on exact-match cancel keyword

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Manual verification in Slack

No automated tests exist; verify the real behaviour end-to-end against the running bot.

**Files:** none (manual).

- [ ] **Step 1: Reload the service with the new build**

Run: `pnpm run reload`
Expected: `launchctl kickstart` restarts `io.flycoder.custie` with the freshly built `dist/`. (If two profiles are running, use `pnpm run reload:all`.)

- [ ] **Step 2: Verify a normal request is unaffected**

In a DM or a channel thread with the bot, send a normal message (e.g. "hello"). Expected: the `claude-spark` thinking reaction appears, then a normal reply. Confirms the registry/signal wiring did not change the happy path.

- [ ] **Step 3: Verify cancellation aborts an in-progress run**

Send a request that takes a few seconds (e.g. "count slowly to 20 with a short pause between each"). While the `claude-spark` reaction is still showing, send a second message: `stop`. Expected:
- A 🛑 (`octagonal_sign`) reaction appears on the `stop` message.
- The thinking reaction clears.
- No reply to the original request is posted, and no retry button appears.
- Server log shows `[agent] killing subprocess (aborted by user)`.

- [ ] **Step 4: Verify each cancel word and case-insensitivity**

Repeat Step 3 using `停`, `cancel`, and `取消` (and once with `  STOP  ` to confirm trim + lowercase). Each should abort the same way.

- [ ] **Step 5: Verify a non-exact match does NOT cancel**

Start a slow request, then send `stop the count please`. Expected: NOT treated as a cancel — it is processed as a normal follow-up message (no 🛑 reaction from the cancel path), and the original run is untouched.

- [ ] **Step 6: Verify a cancel word with nothing running is a normal message**

With no request in progress, send `stop` in a DM. Expected: it is handled as an ordinary message and Claude replies normally (no 🛑 reaction).

- [ ] **Step 7: Confirm the branch is clean**

Run: `git status`
Expected: working tree clean, three feature commits on the branch (Tasks 1-3).

---

## Self-Review

- **Spec coverage:** trigger words + exact-match (Task 3 Step 1, Global Constraints); cancel-not-enqueued ordering (Task 3 Steps 2-4 insert before enqueue); abort mechanism + SIGTERM/SIGKILL reuse + `isCancelled` (Task 1); registry register/abort/unregister (Task 2 Steps 1-2); signal through all retries (Task 2 Step 3); quiet handling, no retry/session-change/message (Task 2 Step 4); 🛑 reaction ack (Task 3 Step 1); "no run active -> normal message" (Task 3 `tryCancel` returns false; Task 4 Step 6); race when run just finished (`abortRun` returns false -> falls through). All spec sections map to a task.
- **Placeholder scan:** none — every step has concrete code and exact line anchors.
- **Type consistency:** `signal` lives on `CliOptions` and is read as `options.signal` in `runCli`; `isCancelled` defined on `ClaudeResponse` (Task 1) and read as `response?.isCancelled` (Task 2 Step 4). Registry key string `` `${channelId}:${sessionKey}` `` in `handleMessage` matches the `threadKey` values at the enqueue sites (lines 633, 821, 865). `abortRun` / `tryCancel` / `activeRuns` / `CANCEL_WORDS` / `askOptions` names used consistently across Tasks 2-3.
```
