import cron from 'node-cron';
import { DEFAULT_TIMEZONE, type ScheduleAutomation } from './config';

export class Scheduler {
  private jobs = new Map<string, cron.ScheduledTask>();

  register(schedule: ScheduleAutomation, runFn: () => Promise<void>): void {
    this.unregister(schedule.name);
    const timezone = schedule.timezone ?? DEFAULT_TIMEZONE;
    const task = cron.schedule(
      schedule.cron,
      () => {
        console.log(`[scheduler] Running: ${schedule.name}`);
        runFn().catch((err) => {
          console.error(`[scheduler] Error in ${schedule.name}:`, err);
        });
      },
      { timezone },
    );
    this.jobs.set(schedule.name, task);
    console.log(`[scheduler] Registered: ${schedule.name} (${schedule.cron}, ${timezone})`);
  }

  unregister(name: string): void {
    const task = this.jobs.get(name);
    if (task) {
      task.stop();
      this.jobs.delete(name);
      console.log(`[scheduler] Unregistered: ${name}`);
    }
  }

  unregisterAll(): void {
    for (const [name, task] of this.jobs) {
      task.stop();
      console.log(`[scheduler] Stopped: ${name}`);
    }
    this.jobs.clear();
  }

  isRegistered(name: string): boolean {
    return this.jobs.has(name);
  }

  getRegisteredNames(): string[] {
    return [...this.jobs.keys()];
  }
}
