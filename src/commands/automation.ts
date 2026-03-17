import { WebClient } from '@slack/web-api';
import { loadEnvFiles, loadConfig } from '../config';
import { paths } from '../paths';
import { AutomationStore } from '../store/automation-store';
import { AutomationManager } from '../automations/manager';
import { runAutomation } from '../automations/runner';
import type { ScheduleAutomation, TriggerAutomation } from '../automations/config';

const USAGE = `
  Usage: custie automation <subcommand> [options]

  Subcommands:
    list                            List all automations
    add --type schedule|trigger     Add an automation
    remove <name>                   Remove an automation
    enable <name>                   Enable an automation
    disable <name>                  Disable an automation
    run <name>                      Manually run a schedule

  Add schedule options:
    --name <name>                   Name of the schedule
    --cron <expression>             Cron expression
    --channel <#channel>            Target Slack channel
    --prompt <text>                 Prompt to send to Claude
    --cwd <path>                    Working directory (optional)

  Add trigger options:
    --name <name>                   Name of the trigger
    --patterns <p1,p2,...>          Comma-separated patterns
    --channels <c1,c2,...|*>        Comma-separated channels or * for all
    --cooldown <seconds>            Cooldown in seconds (default: 300)
    --prompt <text>                 Prompt to send to Claude
`;

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function createManager(): AutomationManager {
  const store = new AutomationStore(paths.DB_FILE);
  return new AutomationManager(store);
}

function printList(manager: AutomationManager): void {
  const config = manager.list();

  if (!config.schedules.length && !config.triggers.length) {
    console.log('No automations configured.');
    return;
  }

  if (config.schedules.length) {
    console.log('\nSchedules:');
    for (const s of config.schedules) {
      const status = s.enabled ? 'active' : 'disabled';
      console.log(`  ${s.name} — ${s.cron} → ${s.channel} (${status})`);
    }
  }

  if (config.triggers.length) {
    console.log('\nTriggers:');
    for (const t of config.triggers) {
      const status = t.enabled ? 'active' : 'disabled';
      const patterns = t.patterns.join(', ');
      console.log(`  ${t.name} — patterns: [${patterns}] → cooldown: ${t.cooldown}s (${status})`);
    }
  }
  console.log();
}

function handleAdd(manager: AutomationManager, args: string[]): void {
  const type = getArg(args, '--type');
  const name = getArg(args, '--name');

  if (!name) {
    console.error('--name is required');
    process.exit(1);
  }

  if (type === 'schedule') {
    const cronExpr = getArg(args, '--cron');
    const channel = getArg(args, '--channel');
    const prompt = getArg(args, '--prompt');
    const cwd = getArg(args, '--cwd');

    if (!cronExpr || !channel || !prompt) {
      console.error('--cron, --channel, and --prompt are required for schedules');
      process.exit(1);
    }

    const schedule: ScheduleAutomation = {
      name,
      enabled: true,
      cron: cronExpr,
      prompt,
      channel,
      cwd,
      created_at: new Date().toISOString(),
    };
    manager.addSchedule(schedule);
    console.log(`Schedule "${name}" added.`);
  } else if (type === 'trigger') {
    const patternsRaw = getArg(args, '--patterns');
    const channelsRaw = getArg(args, '--channels') ?? '*';
    const cooldown = parseInt(getArg(args, '--cooldown') ?? '300', 10);
    const prompt = getArg(args, '--prompt');

    if (!patternsRaw || !prompt) {
      console.error('--patterns and --prompt are required for triggers');
      process.exit(1);
    }

    const trigger: TriggerAutomation = {
      name,
      enabled: true,
      patterns: patternsRaw.split(',').map((p) => p.trim()),
      channels: channelsRaw.split(',').map((c) => c.trim()),
      require_mention: false,
      cooldown,
      prompt,
      created_at: new Date().toISOString(),
    };
    manager.addTrigger(trigger);
    console.log(`Trigger "${name}" added.`);
  } else {
    console.error('--type must be "schedule" or "trigger"');
    process.exit(1);
  }
}

async function handleRun(manager: AutomationManager, name: string): Promise<void> {
  const automation = manager.get(name);
  if (!automation) {
    console.error(`Automation "${name}" not found.`);
    process.exit(1);
  }

  if (!('cron' in automation)) {
    console.error('Only schedules can be run manually.');
    process.exit(1);
  }

  loadEnvFiles();
  const config = loadConfig();
  const client = new WebClient(config.slackBotToken);

  console.log(`Running "${name}"...`);
  await runAutomation({
    prompt: automation.prompt,
    channel: automation.channel,
    cwd: automation.cwd ?? config.claudeCwd,
    botName: config.botName,
    maxTurns: config.maxTurns,
    claudeConfigDir: config.claudeConfigDir,
    slackClient: client,
  });
  console.log('Done.');
}

export async function runAutomationCmd(args: string[]): Promise<void> {
  const subcommand = args[0];
  const manager = createManager();

  switch (subcommand) {
    case 'list':
      printList(manager);
      break;

    case 'add':
      handleAdd(manager, args.slice(1));
      break;

    case 'remove':
      if (!args[1]) {
        console.error('Usage: custie automation remove <name>');
        process.exit(1);
      }
      manager.remove(args[1]);
      console.log(`Automation "${args[1]}" removed.`);
      break;

    case 'enable':
      if (!args[1]) {
        console.error('Usage: custie automation enable <name>');
        process.exit(1);
      }
      manager.enable(args[1]);
      console.log(`Automation "${args[1]}" enabled.`);
      break;

    case 'disable':
      if (!args[1]) {
        console.error('Usage: custie automation disable <name>');
        process.exit(1);
      }
      manager.disable(args[1]);
      console.log(`Automation "${args[1]}" disabled.`);
      break;

    case 'run':
      if (!args[1]) {
        console.error('Usage: custie automation run <name>');
        process.exit(1);
      }
      await handleRun(manager, args[1]);
      break;

    default:
      console.log(USAGE);
      break;
  }
}
