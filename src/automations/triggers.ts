import type { TriggerAutomation } from './config';

export class TriggerEngine {
  private triggers: TriggerAutomation[] = [];
  private cooldowns = new Map<string, number>();

  load(triggers: TriggerAutomation[]): void {
    this.triggers = triggers;
  }

  match(text: string, channelId: string): TriggerAutomation | undefined {
    const lower = text.toLowerCase();

    for (const trigger of this.triggers) {
      if (!trigger.enabled) continue;

      // Check cooldown
      const lastFired = this.cooldowns.get(trigger.name) ?? 0;
      if (Date.now() - lastFired < trigger.cooldown * 1000) continue;

      // Check channel filter
      if (!trigger.channels.includes('*') && !trigger.channels.includes(channelId)) continue;

      // Check pattern match (case-insensitive substring)
      const matched = trigger.patterns.some((pattern) => lower.includes(pattern.toLowerCase()));
      if (matched) return trigger;
    }

    return undefined;
  }

  recordFired(name: string): void {
    this.cooldowns.set(name, Date.now());
  }
}
