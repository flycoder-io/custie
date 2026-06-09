import { WebClient } from '@slack/web-api';
import { loadEnvFiles, loadConfig } from '../config';
import { AutomationManager } from '../automations/manager';
import { runAutomation } from '../automations/runner';
import { refreshChannelRegistry, resolveCwd, loadChannels } from '../channels';
import {
  DEFAULT_TIMEZONE,
  type ScheduleAutomation,
  type TriggerAutomation,
  type MentionTrigger,
} from '../automations/config';

const USAGE = `
  Usage: custie automation <subcommand> [options]

  Subcommands:
    list                                          List all automations (grouped by channel)
    add --type schedule|trigger|mention-trigger   Add an automation
    remove <name>                                 Remove an automation
    enable <name>                                 Enable an automation
    disable <name>                                Disable an automation
    run <name>                                    Manually run a schedule

  Add (all types):
    --channel-scoped                Write the entry into channels.yml under
                                    --channel's block instead of automations.yml

  Add schedule options:
    --name <name>                   Name of the schedule
    --cron <expression>             Cron expression
    --channel <#channel>            Target Slack channel
    --prompt <text>                 Prompt to send to Claude
    --timezone <tz>                 IANA timezone (default: Australia/Sydney)
    --cwd <path>                    Working directory (optional)
    --catchup                       Fire on startup if last run is older than the most recent cron tick

  Add trigger options:
    --name <name>                   Name of the trigger
    --patterns <p1,p2,...>          Comma-separated patterns
    --channels <c1,c2,...|*>        Comma-separated channels or * for all
    --cooldown <seconds>            Cooldown in seconds (default: 300)
    --prompt <text>                 Prompt to send to Claude

  Add mention-trigger options:
    --name <name>                   Name of the mention trigger
    --user <id|owner>               Slack user ID to watch (or "owner" for OWNER_USER_ID)
    --target-channel <id>           Channel ID where the summary is posted
    --prompt <text>                 Prompt to send to Claude (thread context is prepended)
    --react-with <emoji>            Optional reaction emoji on the source message
    --source-channels <c1,c2,...>   Restrict to these source channels (default: all)
    --no-thread-replies             Don't fire on thread reply mentions
    --no-dedup                      Allow re-summarising the same thread
`;

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function describeSchedule(s: ScheduleAutomation): string {
  const status = s.enabled ? 'active' : 'disabled';
  const tz = s.timezone ?? DEFAULT_TIMEZONE;
  return `  schedule  ${s.name} — ${s.cron} (${tz}) → ${s.channel} (${status})`;
}

function describeTrigger(t: TriggerAutomation): string {
  const status = t.enabled ? 'active' : 'disabled';
  const patterns = t.patterns.join(', ');
  return `  trigger   ${t.name} — patterns: [${patterns}] → cooldown: ${t.cooldown}s (${status})`;
}

function describeMentionTrigger(m: MentionTrigger): string {
  const status = m.enabled ? 'active' : 'disabled';
  const sources = m.source_channels?.length ? m.source_channels.join(',') : '*';
  return `  mention   ${m.name} — @${m.user} in [${sources}] → ${m.target_channel} (${status})`;
}

function printList(manager: AutomationManager): void {
  const config = manager.list();

  if (
    !config.schedules.length &&
    !config.triggers.length &&
    !config.mention_triggers.length
  ) {
    console.log('No automations configured.');
    return;
  }

  // Group every automation by its owning Slack channel. Schedules group by
  // `channel`; mention triggers by `target_channel`; triggers may span
  // multiple channels (or `*`), so they list under each.
  const groups = new Map<string, string[]>();
  const push = (channel: string, line: string) => {
    const list = groups.get(channel) ?? [];
    list.push(line);
    groups.set(channel, list);
  };

  for (const s of config.schedules) push(s.channel || '(none)', describeSchedule(s));
  for (const t of config.triggers) {
    const channels = t.channels.length ? t.channels : ['(none)'];
    for (const c of channels) push(c, describeTrigger(t));
  }
  for (const m of config.mention_triggers) {
    push(m.target_channel || '(none)', describeMentionTrigger(m));
  }

  const { channels } = loadChannels();
  for (const channel of [...groups.keys()].sort()) {
    const entry = channels[channel];
    const label = entry?.name ? `${channel} (${entry.name})` : channel;
    const cwd = entry?.cwd ? ` — cwd: ${entry.cwd}` : '';
    console.log(`\n${label}${cwd}`);
    for (const line of groups.get(channel)!) console.log(line);
  }
  console.log();
}

function handleAdd(manager: AutomationManager, args: string[]): void {
  const type = getArg(args, '--type');
  const name = getArg(args, '--name');
  const channelScoped = args.includes('--channel-scoped');

  if (!name) {
    console.error('--name is required');
    process.exit(1);
  }

  if (type === 'schedule') {
    const cronExpr = getArg(args, '--cron');
    const channel = getArg(args, '--channel');
    const prompt = getArg(args, '--prompt');
    const timezone = getArg(args, '--timezone');
    const cwd = getArg(args, '--cwd');
    const catchup = args.includes('--catchup');

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
      timezone,
      cwd,
      catchup: catchup || undefined,
      created_at: new Date().toISOString(),
    };
    if (channelScoped) {
      manager.addToChannel(channel, 'schedule', schedule);
      console.log(`Schedule "${name}" added to channels.yml under ${channel}.`);
    } else {
      manager.addSchedule(schedule);
      console.log(`Schedule "${name}" added.`);
    }
  } else if (type === 'trigger') {
    const patternsRaw = getArg(args, '--patterns');
    const channelScopedId = getArg(args, '--channel');
    const channelsRaw = getArg(args, '--channels') ?? '*';
    const cooldown = parseInt(getArg(args, '--cooldown') ?? '300', 10);
    const prompt = getArg(args, '--prompt');

    if (!patternsRaw || !prompt) {
      console.error('--patterns and --prompt are required for triggers');
      process.exit(1);
    }
    if (channelScoped && !channelScopedId) {
      console.error('--channel <id> is required with --channel-scoped');
      process.exit(1);
    }

    const trigger: TriggerAutomation = {
      name,
      enabled: true,
      patterns: patternsRaw.split(',').map((p) => p.trim()),
      // For channel-scoped triggers the block key is the channel; the nested
      // entry inherits it, so `channels` is left empty.
      channels: channelScoped ? [] : channelsRaw.split(',').map((c) => c.trim()),
      require_mention: false,
      cooldown,
      prompt,
      created_at: new Date().toISOString(),
    };
    if (channelScoped) {
      manager.addToChannel(channelScopedId!, 'trigger', trigger);
      console.log(`Trigger "${name}" added to channels.yml under ${channelScopedId}.`);
    } else {
      manager.addTrigger(trigger);
      console.log(`Trigger "${name}" added.`);
    }
  } else if (type === 'mention-trigger') {
    const user = getArg(args, '--user');
    const channelScopedId = getArg(args, '--channel');
    const targetChannel = getArg(args, '--target-channel');
    const prompt = getArg(args, '--prompt');
    const reactWith = getArg(args, '--react-with');
    const sourceChannelsRaw = getArg(args, '--source-channels');

    // For channel-scoped mention triggers, --channel supplies the target.
    const effectiveTarget = channelScoped ? channelScopedId : targetChannel;

    if (!user || !effectiveTarget || !prompt) {
      console.error(
        channelScoped
          ? '--user, --channel, and --prompt are required for channel-scoped mention-trigger'
          : '--user, --target-channel, and --prompt are required for mention-trigger',
      );
      process.exit(1);
    }

    const trigger: MentionTrigger = {
      name,
      enabled: true,
      user,
      target_channel: effectiveTarget,
      prompt,
      react_with: reactWith,
      source_channels: sourceChannelsRaw
        ? sourceChannelsRaw.split(',').map((c) => c.trim()).filter(Boolean)
        : undefined,
      include_thread_replies: !args.includes('--no-thread-replies'),
      dedup_per_thread: !args.includes('--no-dedup'),
      created_at: new Date().toISOString(),
    };
    if (channelScoped) {
      manager.addToChannel(channelScopedId!, 'mention-trigger', trigger);
      console.log(`Mention trigger "${name}" added to channels.yml under ${channelScopedId}.`);
    } else {
      manager.addMentionTrigger(trigger);
      console.log(`Mention trigger "${name}" added.`);
    }
  } else {
    console.error('--type must be "schedule", "trigger", or "mention-trigger"');
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

  // Populate the channel registry so resolveCwd() can apply the channel layer.
  refreshChannelRegistry();

  console.log(`Running "${name}"...`);
  await runAutomation({
    name: automation.name,
    prompt: automation.prompt,
    channel: automation.channel,
    cwd: resolveCwd(automation.cwd, automation.channel, config.claudeCwd),
    botName: config.botName,
    model: config.model,
    maxBudgetUsd: config.maxBudgetUsd,
    claudeConfigDir: config.claudeConfigDir,
    slackClient: client,
    silent: automation.silent,
  });
  console.log('Done.');
}

export async function runAutomationCmd(args: string[]): Promise<void> {
  const subcommand = args[0];
  const manager = new AutomationManager();

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
