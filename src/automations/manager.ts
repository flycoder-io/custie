import {
  loadAutomations,
  saveAutomations,
  validateSchedule,
  validateTrigger,
  type AutomationsConfig,
  type ScheduleAutomation,
  type TriggerAutomation,
} from './config';

export function listAutomations(): AutomationsConfig {
  return loadAutomations();
}

export function addSchedule(schedule: ScheduleAutomation): void {
  const errors = validateSchedule(schedule);
  if (errors.length) throw new Error(`Invalid schedule: ${errors.join(', ')}`);

  const config = loadAutomations();
  if (config.schedules.some((s) => s.name === schedule.name)) {
    throw new Error(`Schedule "${schedule.name}" already exists`);
  }
  config.schedules.push(schedule);
  saveAutomations(config);
}

export function addTrigger(trigger: TriggerAutomation): void {
  const errors = validateTrigger(trigger);
  if (errors.length) throw new Error(`Invalid trigger: ${errors.join(', ')}`);

  const config = loadAutomations();
  if (config.triggers.some((t) => t.name === trigger.name)) {
    throw new Error(`Trigger "${trigger.name}" already exists`);
  }
  config.triggers.push(trigger);
  saveAutomations(config);
}

export function removeAutomation(name: string): void {
  const config = loadAutomations();
  const scheduleIdx = config.schedules.findIndex((s) => s.name === name);
  const triggerIdx = config.triggers.findIndex((t) => t.name === name);

  if (scheduleIdx === -1 && triggerIdx === -1) {
    throw new Error(`Automation "${name}" not found`);
  }

  if (scheduleIdx !== -1) config.schedules.splice(scheduleIdx, 1);
  if (triggerIdx !== -1) config.triggers.splice(triggerIdx, 1);
  saveAutomations(config);
}

export function enableAutomation(name: string): void {
  const config = loadAutomations();
  const item = findByName(config, name);
  if (!item) throw new Error(`Automation "${name}" not found`);
  item.enabled = true;
  saveAutomations(config);
}

export function disableAutomation(name: string): void {
  const config = loadAutomations();
  const item = findByName(config, name);
  if (!item) throw new Error(`Automation "${name}" not found`);
  item.enabled = false;
  saveAutomations(config);
}

export function getAutomation(name: string): ScheduleAutomation | TriggerAutomation | undefined {
  const config = loadAutomations();
  return findByName(config, name);
}

function findByName(
  config: AutomationsConfig,
  name: string,
): ScheduleAutomation | TriggerAutomation | undefined {
  return (
    config.schedules.find((s) => s.name === name) ?? config.triggers.find((t) => t.name === name)
  );
}
