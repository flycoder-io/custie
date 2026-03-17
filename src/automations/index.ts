import type { App } from '@slack/bolt';
import type { Config } from '../config';
import { AutomationStore } from '../store/automation-store';
import { paths } from '../paths';
import { runAutomation } from './runner';
import { AutomationManager } from './manager';
import { Scheduler } from './scheduler';
import { TriggerEngine } from './triggers';

export * from './config';
export * from './manager';
export * from './runner';
export * from './scheduler';
export * from './triggers';

export interface AutomationsHandle {
  manager: AutomationManager;
  scheduler: Scheduler;
  triggerEngine: TriggerEngine;
  shutdown: () => void;
}

export function initAutomations(app: App, config: Config): AutomationsHandle {
  const store = new AutomationStore(paths.DB_FILE);
  const scheduler = new Scheduler();
  const triggerEngine = new TriggerEngine();

  function reload(): void {
    const schedules = store.getSchedules();
    const triggers = store.getTriggers();

    // Re-register all schedules
    scheduler.unregisterAll();
    for (const schedule of schedules) {
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

    // Reload triggers
    triggerEngine.load(triggers);

    const scheduleCount = schedules.filter((s) => s.enabled).length;
    const triggerCount = triggers.filter((t) => t.enabled).length;
    console.log(`[automations] Loaded ${scheduleCount} schedule(s), ${triggerCount} trigger(s)`);
  }

  const manager = new AutomationManager(store, reload);

  reload();

  return {
    manager,
    scheduler,
    triggerEngine,
    shutdown: () => {
      scheduler.unregisterAll();
      store.close();
    },
  };
}
