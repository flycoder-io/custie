import type { AutomationStore } from '../store/automation-store';
import {
  validateSchedule,
  validateTrigger,
  type AutomationsConfig,
  type ScheduleAutomation,
  type TriggerAutomation,
} from './config';

export type OnChangeCallback = () => void;

export class AutomationManager {
  private onChange?: OnChangeCallback;

  constructor(
    private store: AutomationStore,
    onChange?: OnChangeCallback,
  ) {
    this.onChange = onChange;
  }

  setOnChange(cb: OnChangeCallback): void {
    this.onChange = cb;
  }

  list(): AutomationsConfig {
    return {
      schedules: this.store.getSchedules(),
      triggers: this.store.getTriggers(),
    };
  }

  addSchedule(schedule: ScheduleAutomation): void {
    const errors = validateSchedule(schedule);
    if (errors.length) throw new Error(`Invalid schedule: ${errors.join(', ')}`);

    if (this.store.getSchedule(schedule.name)) {
      throw new Error(`Schedule "${schedule.name}" already exists`);
    }
    this.store.addSchedule(schedule);
    this.onChange?.();
  }

  addTrigger(trigger: TriggerAutomation): void {
    const errors = validateTrigger(trigger);
    if (errors.length) throw new Error(`Invalid trigger: ${errors.join(', ')}`);

    if (this.store.getTrigger(trigger.name)) {
      throw new Error(`Trigger "${trigger.name}" already exists`);
    }
    this.store.addTrigger(trigger);
    this.onChange?.();
  }

  remove(name: string): void {
    const removed = this.store.removeSchedule(name) || this.store.removeTrigger(name);
    if (!removed) throw new Error(`Automation "${name}" not found`);
    this.onChange?.();
  }

  enable(name: string): void {
    if (!this.store.setEnabled(name, true)) {
      throw new Error(`Automation "${name}" not found`);
    }
    this.onChange?.();
  }

  disable(name: string): void {
    if (!this.store.setEnabled(name, false)) {
      throw new Error(`Automation "${name}" not found`);
    }
    this.onChange?.();
  }

  get(name: string): ScheduleAutomation | TriggerAutomation | undefined {
    return this.store.getSchedule(name) ?? this.store.getTrigger(name);
  }
}
