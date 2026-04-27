import { watch, type FSWatcher } from 'node:fs';
import type { App } from '@slack/bolt';
import type { Config } from '../config';
import { paths } from '../paths';
import type { AutomationRunStore } from '../store/automation-run-store';
import { loadAutomations } from './config';
import { runAutomation } from './runner';
import { AutomationManager } from './manager';
import { Scheduler } from './scheduler';
import { TriggerEngine } from './triggers';
import { MentionTriggerEngine } from './mention-trigger-engine';

export * from './config';
export * from './manager';
export * from './runner';
export * from './scheduler';
export * from './triggers';
export * from './mention-trigger-engine';

export interface AutomationsHandle {
  manager: AutomationManager;
  scheduler: Scheduler;
  triggerEngine: TriggerEngine;
  mentionTriggerEngine: MentionTriggerEngine;
  shutdown: () => void;
}

export function initAutomations(
  app: App,
  config: Config,
  runStore?: AutomationRunStore,
): AutomationsHandle {
  const scheduler = new Scheduler(runStore);
  const triggerEngine = new TriggerEngine();
  const mentionTriggerEngine = new MentionTriggerEngine({ ownerUserId: config.ownerUserId });
  let watcher: FSWatcher | undefined;

  function reload(): void {
    const automations = loadAutomations();

    // Re-register all schedules
    scheduler.unregisterAll();
    for (const schedule of automations.schedules) {
      if (!schedule.enabled) continue;
      scheduler.register(schedule, () =>
        runAutomation({
          name: schedule.name,
          prompt: schedule.prompt,
          channel: schedule.channel,
          cwd: schedule.cwd ?? config.claudeCwd,
          botName: config.botName,
          maxTurns: config.maxTurns,
          claudeConfigDir: config.claudeConfigDir,
          slackClient: app.client,
          silent: schedule.silent,
        }),
      );
    }

    // Reload triggers
    triggerEngine.load(automations.triggers);
    mentionTriggerEngine.load(automations.mention_triggers);

    const scheduleCount = automations.schedules.filter((s) => s.enabled).length;
    const triggerCount = automations.triggers.filter((t) => t.enabled).length;
    const mentionCount = automations.mention_triggers.filter((t) => t.enabled).length;
    console.log(
      `[automations] Loaded ${scheduleCount} schedule(s), ${triggerCount} trigger(s), ${mentionCount} mention-trigger(s)`,
    );
  }

  const manager = new AutomationManager(reload);

  reload();

  // Watch YAML file for external changes (e.g. git pull, manual edit)
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    watcher = watch(paths.AUTOMATIONS_FILE, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log('[automations] Config file changed, reloading...');
        reload();
      }, 500);
    });
  } catch {
    // File may not exist yet — that's fine, watcher is optional
  }

  return {
    manager,
    scheduler,
    triggerEngine,
    mentionTriggerEngine,
    shutdown: () => {
      watcher?.close();
      clearTimeout(debounceTimer);
      scheduler.unregisterAll();
    },
  };
}
