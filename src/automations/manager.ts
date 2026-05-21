import {
  loadAutomations,
  saveAutomations,
  loadEffectiveAutomations,
  validateSchedule,
  validateTrigger,
  validateMentionTrigger,
  type AutomationsConfig,
  type ScheduleAutomation,
  type TriggerAutomation,
  type MentionTrigger,
} from './config';
import { loadChannels, saveChannels, type ChannelsConfig } from '../channels';

export type OnChangeCallback = () => void;

export type AnyAutomation = ScheduleAutomation | TriggerAutomation | MentionTrigger;

// Where an automation lives — used by the CLI to mutate the right file.
export type AutomationSource =
  | { file: 'automations' }
  | { file: 'channels'; channelId: string };

export interface LocatedAutomation {
  item: AnyAutomation;
  source: AutomationSource;
}

export class AutomationManager {
  private onChange?: OnChangeCallback;

  constructor(onChange?: OnChangeCallback) {
    this.onChange = onChange;
  }

  setOnChange(cb: OnChangeCallback): void {
    this.onChange = cb;
  }

  /** Merged view of `automations.yml` + every channel block's automations. */
  list(): AutomationsConfig {
    return loadEffectiveAutomations();
  }

  /** Raw `automations.yml` only — used by `add` and direct file mutation. */
  listAutomationsFile(): AutomationsConfig {
    return loadAutomations();
  }

  /** Raw `channels.yml`. */
  listChannels(): ChannelsConfig {
    return loadChannels();
  }

  // --- name uniqueness (across both files) -------------------------------

  private allNames(): Set<string> {
    const merged = loadEffectiveAutomations();
    return new Set<string>([
      ...merged.schedules.map((s) => s.name),
      ...merged.triggers.map((t) => t.name),
      ...merged.mention_triggers.map((m) => m.name),
    ]);
  }

  private assertNameFree(name: string): void {
    if (this.allNames().has(name)) {
      throw new Error(`An automation named "${name}" already exists`);
    }
  }

  // --- add to automations.yml (default) ----------------------------------

  addSchedule(schedule: ScheduleAutomation): void {
    const errors = validateSchedule(schedule);
    if (errors.length) throw new Error(`Invalid schedule: ${errors.join(', ')}`);
    this.assertNameFree(schedule.name);

    const config = loadAutomations();
    config.schedules.push(schedule);
    saveAutomations(config);
    this.onChange?.();
  }

  addTrigger(trigger: TriggerAutomation): void {
    const errors = validateTrigger(trigger);
    if (errors.length) throw new Error(`Invalid trigger: ${errors.join(', ')}`);
    this.assertNameFree(trigger.name);

    const config = loadAutomations();
    config.triggers.push(trigger);
    saveAutomations(config);
    this.onChange?.();
  }

  addMentionTrigger(trigger: MentionTrigger): void {
    const errors = validateMentionTrigger(trigger);
    if (errors.length) throw new Error(`Invalid mention trigger: ${errors.join(', ')}`);
    this.assertNameFree(trigger.name);

    const config = loadAutomations();
    config.mention_triggers.push(trigger);
    saveAutomations(config);
    this.onChange?.();
  }

  // --- add to channels.yml (--channel-scoped) ----------------------------

  /**
   * Add an automation under a channel block in `channels.yml`. The block is
   * created if absent. Channel-supplied fields (`channel`/`channels`/
   * `target_channel`) are stripped so they inherit from the block.
   */
  addToChannel(
    channelId: string,
    type: 'schedule' | 'trigger' | 'mention-trigger',
    automation: AnyAutomation,
  ): void {
    if (type === 'schedule') {
      const errors = validateSchedule(automation as ScheduleAutomation, { nested: true });
      if (errors.length) throw new Error(`Invalid schedule: ${errors.join(', ')}`);
    } else if (type === 'trigger') {
      const errors = validateTrigger(automation as TriggerAutomation, { nested: true });
      if (errors.length) throw new Error(`Invalid trigger: ${errors.join(', ')}`);
    } else {
      const errors = validateMentionTrigger(automation as MentionTrigger, { nested: true });
      if (errors.length) throw new Error(`Invalid mention trigger: ${errors.join(', ')}`);
    }
    this.assertNameFree(automation.name);

    const config = loadChannels();
    const entry = config.channels[channelId];
    if (!entry) {
      throw new Error(
        `Channel "${channelId}" has no entry in channels.yml — add one with a "cwd" first`,
      );
    }
    entry.automations ??= {};

    if (type === 'schedule') {
      const { channel: _channel, ...rest } = automation as ScheduleAutomation;
      void _channel;
      (entry.automations.schedules ??= []).push(rest);
    } else if (type === 'trigger') {
      const { channels: _channels, ...rest } = automation as TriggerAutomation;
      void _channels;
      (entry.automations.triggers ??= []).push(rest);
    } else {
      const { target_channel: _target, ...rest } = automation as MentionTrigger;
      void _target;
      (entry.automations.mention_triggers ??= []).push(rest);
    }

    saveChannels(config);
    this.onChange?.();
  }

  // --- locate / mutate across both files ---------------------------------

  /** Find an automation by name in either file, with its source location. */
  locate(name: string): LocatedAutomation | undefined {
    const automations = loadAutomations();
    const inFile = findByName(automations, name);
    if (inFile) return { item: inFile, source: { file: 'automations' } };

    const { channels } = loadChannels();
    for (const [channelId, entry] of Object.entries(channels)) {
      const a = entry.automations;
      if (!a) continue;
      const item =
        a.schedules?.find((s) => s.name === name) ??
        a.triggers?.find((t) => t.name === name) ??
        a.mention_triggers?.find((m) => m.name === name);
      if (item) return { item: item as AnyAutomation, source: { file: 'channels', channelId } };
    }
    return undefined;
  }

  remove(name: string): void {
    const located = this.locate(name);
    if (!located) throw new Error(`Automation "${name}" not found`);

    if (located.source.file === 'automations') {
      const config = loadAutomations();
      config.schedules = config.schedules.filter((s) => s.name !== name);
      config.triggers = config.triggers.filter((t) => t.name !== name);
      config.mention_triggers = config.mention_triggers.filter((m) => m.name !== name);
      saveAutomations(config);
    } else {
      const config = loadChannels();
      const a = config.channels[located.source.channelId]?.automations;
      if (a) {
        if (a.schedules) a.schedules = a.schedules.filter((s) => s.name !== name);
        if (a.triggers) a.triggers = a.triggers.filter((t) => t.name !== name);
        if (a.mention_triggers) {
          a.mention_triggers = a.mention_triggers.filter((m) => m.name !== name);
        }
      }
      saveChannels(config);
    }
    this.onChange?.();
  }

  enable(name: string): void {
    this.setEnabled(name, true);
  }

  disable(name: string): void {
    this.setEnabled(name, false);
  }

  private setEnabled(name: string, enabled: boolean): void {
    const located = this.locate(name);
    if (!located) throw new Error(`Automation "${name}" not found`);

    if (located.source.file === 'automations') {
      const config = loadAutomations();
      const item = findByName(config, name);
      if (!item) throw new Error(`Automation "${name}" not found`);
      item.enabled = enabled;
      saveAutomations(config);
    } else {
      const config = loadChannels();
      const a = config.channels[located.source.channelId]?.automations;
      const item =
        a?.schedules?.find((s) => s.name === name) ??
        a?.triggers?.find((t) => t.name === name) ??
        a?.mention_triggers?.find((m) => m.name === name);
      if (!item) throw new Error(`Automation "${name}" not found`);
      item.enabled = enabled;
      saveChannels(config);
    }
    this.onChange?.();
  }

  /**
   * Get an automation by name from the merged (effective) view, so inherited
   * `channel`/`cwd` fields are populated. Use `locate()` when the source file
   * matters.
   */
  get(name: string): AnyAutomation | undefined {
    return findByName(loadEffectiveAutomations(), name);
  }
}

function findByName(config: AutomationsConfig, name: string): AnyAutomation | undefined {
  return (
    config.schedules.find((s) => s.name === name) ??
    config.triggers.find((t) => t.name === name) ??
    config.mention_triggers.find((m) => m.name === name)
  );
}
