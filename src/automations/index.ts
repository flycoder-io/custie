import type { App } from '@slack/bolt';
import type { Config } from '../config';
import { loadAutomations } from './config';
import { runAutomation } from './runner';
import { Scheduler } from './scheduler';
import { TriggerEngine } from './triggers';

export * from './config';
export * from './manager';
export * from './runner';
export * from './scheduler';
export * from './triggers';

export interface AutomationsHandle {
  scheduler: Scheduler;
  triggerEngine: TriggerEngine;
  shutdown: () => void;
  reload: () => void;
}

export function initAutomations(app: App, config: Config): AutomationsHandle {
  const scheduler = new Scheduler();
  const triggerEngine = new TriggerEngine();

  function loadAndRegister(): void {
    const automations = loadAutomations();

    // Register schedules
    scheduler.unregisterAll();
    for (const schedule of automations.schedules) {
      if (!schedule.enabled) continue;
      scheduler.register(schedule, () =>
        runAutomation({
          prompt: schedule.prompt,
          channel: schedule.channel,
          cwd: schedule.cwd ?? config.claudeCwd,
          botName: config.botName,
          maxTurns: config.maxTurns,
          claudeConfigDir: config.claudeConfigDir,
          slackClient: app.client,
        }),
      );
    }

    // Load triggers
    triggerEngine.load(automations.triggers);

    const scheduleCount = automations.schedules.filter((s) => s.enabled).length;
    const triggerCount = automations.triggers.filter((t) => t.enabled).length;
    console.log(`[automations] Loaded ${scheduleCount} schedule(s), ${triggerCount} trigger(s)`);
  }

  loadAndRegister();

  return {
    scheduler,
    triggerEngine,
    shutdown: () => scheduler.unregisterAll(),
    reload: loadAndRegister,
  };
}
