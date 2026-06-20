# Cancel In-Progress Response (Keyword Abort)

Date: 2026-06-20
Status: Approved design, ready for implementation plan

## Problem

When Custie is processing a message (Claude CLI subprocess running, shown by the
`claude-spark` "thinking" reaction), there is currently no way to stop it. The
user must wait for it to finish or time out (up to 10 minutes). We want a way to
abort the run in progress.

## Scope

In scope:
- Abort the single Claude run that is currently in progress for a thread.

Out of scope (explicitly decided against):
- Clearing / resetting the session.
- Flushing messages already queued behind the current one (queued messages
  continue normally — "stop only this one").
- A Stop button. Rejected because rendering a button requires posting a real
  message that later gets edited, which leaves a lingering "new message" state in
  Slack. Slack's `assistant.threads.setStatus` gives a message-less status line
  but cannot carry a button, so button + message-less is not achievable.

## Trigger: exact-match keyword

The next message in the thread aborts the in-progress run if its text, after
trimming whitespace and lowercasing, is **exactly** one of:

- `stop`
- `停`
- `cancel`
- `取消`

Exact equality only. "stop the server" must NOT trigger a cancel. No AI / fuzzy
matching.

Behaviour:
- If the text matches a cancel word **and** there is an in-progress run for this
  thread → abort it. The cancel message is NOT sent to Claude and is NOT
  enqueued.
- If the text matches a cancel word but **no run is in progress** → treat it as a
  normal message (send to Claude as usual). The user may legitimately be saying
  "stop" to the assistant.

## Architecture

```
Slack message event
  └─ listeners.ts event handler
       ├─ [NEW] cancel-keyword check (BEFORE enqueue)
       │     match + active run? → registry.abort(threadKey), 🛑 reaction, return
       └─ enqueue(threadKey, () => handleMessage(...))
                                      └─ [NEW] register AbortController under threadKey
                                           askClaude(..., signal)  → runCli(..., signal)
                                                                          signal aborts → SIGTERM → SIGKILL
                                      └─ finally: unregister
```

### Component 1: Run registry

A small in-memory map of in-progress runs, keyed by `threadKey`
(`${channelId}:${threadTs}`, the same key the queue uses).

- `Map<string, AbortController>`.
- `register(threadKey) -> AbortController` — creates and stores a controller.
- `abort(threadKey) -> boolean` — aborts the controller if present, returns
  whether one was found (so the keyword handler knows if a run was actually
  active).
- `unregister(threadKey)` — removes the entry.

In-memory only. A server restart drops the map, which is correct: the subprocess
dies with the server anyway. Lives in `listeners.ts` alongside `retryContexts`,
or a tiny dedicated module if cleaner.

Note: the registry holds at most one controller per `threadKey`. Because the
queue serialises per thread, only one run per thread is ever in progress, so
there is no key collision.

### Component 2: AbortSignal threaded through the agent

`runCli()` (`src/claude/agent.ts:177`) gains an optional `signal?: AbortSignal`.

- Extract the existing SIGTERM → wait `KILL_GRACE_MS` → SIGKILL logic (currently
  inline in the timeout handler at agent.ts:212-224) into a local `killChild()`
  helper, so both the timeout path and the new abort path reuse it.
- Add an abort listener: when `signal` fires, set a `cancelled = true` flag and
  call `killChild()`.
- On `child.on('close')`, if `cancelled`, resolve with a new flag
  `isCancelled: true` (and a benign text, unused by the caller). Do NOT resolve
  as `isError`/`isTimeout` — cancellation is intentional, not a failure, so it
  must not trigger any retry or self-heal path.
- Remove the abort listener in the close/error handlers to avoid leaks.

`askClaude()` (agent.ts:334) passes `signal` straight through to every `runCli`
call, including its internal fallback re-run.

`ClaudeResponse` gains `isCancelled?: boolean`.

### Component 3: Wiring in handleMessage

`handleMessage()` (`src/slack/listeners.ts:329`) is where the run executes and
retries:

- At the start, `const ac = registry.register(threadKey)`.
- Thread `ac.signal` into every `askClaude(...)` call (the first attempt, the
  context-too-long retries, the poisoned-session self-heal, and the transient
  retry — all of them, so abort halts the whole chain, not just one attempt).
- In a `finally`, call `registry.unregister(threadKey)` and `clearReaction()`.
- After awaiting the response, if `response?.isCancelled` (or any attempt was
  cancelled): skip the normal "post response" path, skip retry/offerRetry, clear
  the thinking reaction, and return quietly. No "已中止" message is posted — the
  🛑 reaction on the user's cancel message is the only acknowledgement (keeps the
  thread clean, consistent with the "no extra message" decision).

`handleMessage` needs `threadKey` available. It currently receives `channelId`
and `sessionKey`/`threadTs`; compute `threadKey` the same way the enqueue site
does, or pass it in.

### Component 4: Cancel-keyword interception

In the `app.event('message')` and `app.event('app_mention')` handlers in
`listeners.ts`, before the `enqueue(threadKey, ...)` call:

```
const normalized = text.trim().toLowerCase();
if (CANCEL_WORDS.has(normalized) && registry.abort(threadKey)) {
  await client.reactions.add({ channel, timestamp: ts, name: 'octagonal_sign' }); // 🛑
  return; // do not enqueue, do not send to Claude
}
```

Critical: this check MUST run synchronously in the event handler, before
`enqueue`. If the cancel word were enqueued, it would serialise behind the
in-progress run in the same thread and never get a chance to abort it.

`CANCEL_WORDS = new Set(['stop', '停', 'cancel', '取消'])`.

The 🛑 reaction is best-effort; failure to add it is logged and ignored, the
abort still happens.

## Edge cases

- **Race: run finishes just as the cancel word arrives.** `registry.abort` finds
  no controller (already unregistered in `finally`), returns `false`, so the
  cancel word falls through and is treated as a normal message. Acceptable: the
  response has already been posted; "stop" then becomes a new turn.
- **Cancel word with nothing running.** Treated as a normal message (sent to
  Claude), per decision.
- **Abort during the 10-second SIGKILL grace.** The existing grace timer already
  handles a stubborn child; reused unchanged.
- **Server restart mid-run.** Registry is gone, subprocess is gone. Nothing to
  clean up beyond the existing `reactionStore` startup recovery for the thinking
  reaction.

## Testing

- Unit: registry `register` / `abort` (found vs not found) / `unregister`.
- Unit: cancel-word normalisation — `"  STOP  "` matches, `"stop the server"`
  does not, each of the four words matches.
- Unit/agent: `runCli` with a pre-aborted signal kills the child and resolves
  with `isCancelled: true`, never `isError`.
- Behavioural: abort halts the run without triggering the retry button or
  self-heal path (assert `offerRetry` / `say` not called with a response).
- Behavioural: cancel word with no active run is enqueued and processed normally.
```
