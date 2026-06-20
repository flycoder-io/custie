import { watch, type FSWatcher } from 'node:fs';
import type { App } from '@slack/bolt';
import type { Config } from '../config';
import { paths } from '../paths';
import { refreshChannelRegistry, resolveCwd } from '../channels';
import type { AutomationRunStore } from '../store/automation-run-store';
import { loadEffectiveAutomations } from './config';
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
  let channelsWatcher: FSWatcher | undefined;

  function reload(): void {
    // Refresh the channel registry first so resolveCwd() and the merged
    // automation loader see the latest channels.yml.
    refreshChannelRegistry();
    const automations = loadEffectiveAutomations();

    // Re-register all schedules
    scheduler.unregisterAll();
    for (const schedule of automations.schedules) {
      if (!schedule.enabled) continue;
      scheduler.register(schedule, () =>
        runAutomation({
          name: schedule.name,
          prompt: schedule.prompt,
          channel: schedule.channel,
          cwd: resolveCwd(schedule.cwd, schedule.channel, config.claudeCwd),
          botName: config.botName,
          model: schedule.model?.trim() || config.model,
          maxBudgetUsd: config.maxBudgetUsd,
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

  // Watch YAML files for external changes (e.g. git pull, manual edit).
  // Both automations.yml and channels.yml trigger the same debounced reload(),
  // which also refreshes the channel registry.
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = (label: string) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log(`[automations] ${label} changed, reloading...`);
      reload();
    }, 500);
  };
  try {
    watcher = watch(paths.AUTOMATIONS_FILE, () => scheduleReload('automations.yml'));
  } catch {
    // File may not exist yet — that's fine, watcher is optional
  }
  try {
    channelsWatcher = watch(paths.CHANNELS_FILE, () => scheduleReload('channels.yml'));
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
      channelsWatcher?.close();
      clearTimeout(debounceTimer);
      scheduler.unregisterAll();
    },
  };
}
