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
}
