type Task = () => Promise<void>;

export class MessageQueue {
  private chains = new Map<string, Promise<void>>();

  enqueue(threadKey: string, task: Task): void {
    const prev = this.chains.get(threadKey) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => {
      console.error(`[queue] Error processing ${threadKey}:`, err);
    });
    this.chains.set(threadKey, next);
  }

  // Wait for all currently-enqueued tasks to finish, or until `timeoutMs`
  // elapses. Used during shutdown to give in-flight Claude subprocesses a
  // chance to post their response before the process exits. Resolves to true
  // if everything drained, false on timeout.
  async drain(timeoutMs: number): Promise<boolean> {
    const chains = Array.from(this.chains.values());
    if (chains.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = Promise.all(chains).then(() => true);
    const result = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  pendingCount(): number {
    return this.chains.size;
  }
}
