import cron from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import type { AutomationRunStore } from '../store/automation-run-store';
import { DEFAULT_TIMEZONE, type ScheduleAutomation } from './config';

export class Scheduler {
  private jobs = new Map<string, cron.ScheduledTask>();
  private caughtUp = new Set<string>();
  private store?: AutomationRunStore;

  constructor(store?: AutomationRunStore) {
    this.store = store;
  }

  register(schedule: ScheduleAutomation, runFn: () => Promise<void>): void {
    this.unregister(schedule.name);
    const timezone = schedule.timezone ?? DEFAULT_TIMEZONE;

    const wrappedRun = () => this.runAndRecord(schedule.name, runFn);

    const task = cron.schedule(
      schedule.cron,
      () => {
        console.log(`[scheduler] Running: ${schedule.name}`);
        wrappedRun();
      },
      { timezone },
    );
    this.jobs.set(schedule.name, task);
    console.log(`[scheduler] Registered: ${schedule.name} (${schedule.cron}, ${timezone})`);

    if (schedule.catchup) {
      this.maybeCatchup(schedule, timezone, wrappedRun);
    }
  }

  private maybeCatchup(
    schedule: ScheduleAutomation,
    timezone: string,
    wrappedRun: () => void,
  ): void {
    if (this.caughtUp.has(schedule.name)) return;
    if (!this.store) {
      console.warn(
        `[scheduler] catchup requested for ${schedule.name} but no store configured — skipping`,
      );
      return;
    }

    let prevExpected: Date;
    try {
      const expression = CronExpressionParser.parse(schedule.cron, { tz: timezone });
      prevExpected = expression.prev().toDate();
    } catch (err) {
      console.error(`[scheduler] Failed to compute prev tick for ${schedule.name}:`, err);
      return;
    }

    const last = this.store.getLastRun(schedule.name);
    if (last && last.lastRunAt >= prevExpected) {
      console.log(
        `[scheduler] ${schedule.name}: last run ${last.lastRunAt.toISOString()} ≥ prev tick ${prevExpected.toISOString()} — no catchup`,
      );
      return;
    }

    const reason = last
      ? `last run ${last.lastRunAt.toISOString()} < prev tick ${prevExpected.toISOString()}`
      : `never run (prev tick ${prevExpected.toISOString()})`;
    console.log(`[scheduler] Catching up ${schedule.name}: ${reason}`);
    this.caughtUp.add(schedule.name);
    wrappedRun();
  }

  private async runAndRecord(name: string, runFn: () => Promise<void>): Promise<void> {
    try {
      await runFn();
      this.store?.recordRun(name, 'ok');
    } catch (err) {
      console.error(`[scheduler] Error in ${name}:`, err);
      this.store?.recordRun(name, 'error');
    }
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
