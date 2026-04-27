import { WebClient } from '@slack/web-api';
import { loadEnvFiles, loadConfig } from '../config';
import {
  resolveChannelId as cachedResolveChannelId,
  refreshCache,
  listMemberChannels,
} from '../store/channel-cache';
import {
  resolveUserId as cachedResolveUserId,
  refreshUserCache,
  listActiveUsers,
  ensureUsersCached,
  displayNameFor,
} from '../store/user-cache';

const USAGE = `
  Usage: custie slack <subcommand> [options]

  Subcommands:
    channels [--refresh]            List channels the bot is in (cached)
    users [--refresh]               List workspace users (cached)
    channel-info <name-or-id>       Show channel details
    user-info <name-or-id>          Show user details
    history <name-or-id>            Show recent channel messages
    post --channel <ch> --text <t>  Post a message to a channel
    delete --channel <ch> --ts <t>  Delete a bot message

  Options:
    --limit <n>                     Max results to return (default: 100)
    --today                         Only show today's messages (history)
    --oldest <timestamp>            Oldest message timestamp (history)
    --latest <timestamp>            Latest message timestamp (history)
    --refresh                       Force refresh of cached channel list
`;

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function createClient(): WebClient {
  loadEnvFiles();
  const config = loadConfig();
  return new WebClient(config.slackBotToken);
}

async function listChannels(client: WebClient, refresh: boolean): Promise<void> {
  if (refresh) await refreshCache(client);
  let channels = listMemberChannels();
  if (channels.length === 0) {
    // Empty cache (or genuinely no member channels) — fall back to a refresh.
    await refreshCache(client);
    channels = listMemberChannels();
  }
  if (!channels.length) {
    console.log('The bot is not a member of any channels.');
    return;
  }

  console.log(`Channels the bot is in (${channels.length}):\n`);
  for (const ch of channels) {
    const purpose = ch.purpose ? ` — ${ch.purpose}` : '';
    console.log(`  #${ch.name} (${ch.id})${purpose}`);
  }
}

async function listUsers(client: WebClient, refresh: boolean): Promise<void> {
  if (refresh) await refreshUserCache(client);
  let users = listActiveUsers();
  if (users.length === 0) {
    await refreshUserCache(client);
    users = listActiveUsers();
  }
  if (!users.length) {
    console.log('No users found.');
    return;
  }

  console.log(`Workspace users (${users.length}):\n`);
  for (const u of users) {
    const displayName = u.real_name || u.display_name || u.name;
    console.log(`  ${displayName} (@${u.name}, ${u.id})`);
  }
}

async function channelInfo(client: WebClient, nameOrId: string): Promise<void> {
  const channelId = await resolveChannelId(client, nameOrId);
  const result = await client.conversations.info({ channel: channelId });
  const ch = result.channel;
  if (!ch) {
    console.error(`Channel "${nameOrId}" not found.`);
    process.exit(1);
  }

  console.log(`Channel: #${ch.name}`);
  console.log(`  ID:       ${ch.id}`);
  console.log(`  Topic:    ${ch.topic?.value || '(none)'}`);
  console.log(`  Purpose:  ${ch.purpose?.value || '(none)'}`);
  console.log(`  Members:  ${ch.num_members ?? 'unknown'}`);
  console.log(`  Private:  ${ch.is_private ? 'yes' : 'no'}`);
  console.log(`  Archived: ${ch.is_archived ? 'yes' : 'no'}`);
  console.log(`  Bot is member: ${ch.is_member ? 'yes' : 'no'}`);
}

async function userInfo(client: WebClient, nameOrId: string): Promise<void> {
  let userId: string;
  try {
    userId = await cachedResolveUserId(client, nameOrId);
  } catch {
    console.error(`User "${nameOrId}" not found.`);
    process.exit(1);
  }

  const result = await client.users.info({ user: userId });
  const u = result.user;
  if (!u) {
    console.error(`User "${nameOrId}" not found.`);
    process.exit(1);
  }

  console.log(`User: ${u.real_name || u.name}`);
  console.log(`  ID:           ${u.id}`);
  console.log(`  Username:     @${u.name}`);
  console.log(`  Display name: ${u.profile?.display_name || '(none)'}`);
  console.log(`  Email:        ${u.profile?.email || '(none)'}`);
  console.log(`  Title:        ${u.profile?.title || '(none)'}`);
  console.log(`  Timezone:     ${u.tz_label || u.tz || '(none)'}`);
  console.log(`  Admin:        ${u.is_admin ? 'yes' : 'no'}`);
  console.log(`  Bot:          ${u.is_bot ? 'yes' : 'no'}`);
}

async function resolveChannelId(client: WebClient, nameOrId: string): Promise<string> {
  try {
    return await cachedResolveChannelId(client, nameOrId);
  } catch {
    console.error(`Channel "${nameOrId}" not found.`);
    process.exit(1);
  }
}

async function channelHistory(client: WebClient, nameOrId: string, args: string[]): Promise<void> {
  const channelId = await resolveChannelId(client, nameOrId);
  const limit = parseInt(getArg(args, '--limit') ?? '100', 10);
  const isToday = args.includes('--today');

  let oldest = getArg(args, '--oldest');
  let latest = getArg(args, '--latest');

  if (isToday) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    oldest = String(startOfDay.getTime() / 1000);
  }

  const historyArgs: Record<string, unknown> = { channel: channelId, limit };
  if (oldest) historyArgs.oldest = oldest;
  if (latest) historyArgs.latest = latest;

  const result = await client.conversations.history(historyArgs);
  const messages = (result.messages ?? []).reverse();

  if (!messages.length) {
    console.log('No messages found.');
    return;
  }

  // Resolve user IDs to display names via cache (one users.list call max).
  const userIds = [...new Set(messages.map((m) => m.user).filter(Boolean))] as string[];
  await ensureUsersCached(client, userIds);

  // Replace raw <@Uxxxx> mentions in message text with display names too.
  const renderText = (raw: string): string =>
    raw.replace(/<@(U[A-Z0-9]+)>/g, (_, uid) => `@${displayNameFor(uid)}`);

  console.log(`Messages (${messages.length}):\n`);
  for (const msg of messages) {
    const ts = msg.ts ? new Date(parseFloat(msg.ts) * 1000) : null;
    const time = ts ? ts.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : '?';
    const author = msg.user ? displayNameFor(msg.user) : msg.bot_id ?? 'unknown';
    const text = renderText(msg.text ?? '').replace(/\n/g, '\n    ');
    const thread = msg.reply_count ? ` [${msg.reply_count} replies]` : '';
    console.log(`  [${time}] ${author} (${msg.user ?? msg.bot_id ?? '?'})${thread}:`);
    console.log(`    ${text}`);
    console.log();
  }
}

async function postMessage(client: WebClient, args: string[]): Promise<void> {
  const channelArg = getArg(args, '--channel');
  const text = getArg(args, '--text');
  const threadTs = getArg(args, '--thread');

  if (!channelArg || !text) {
    console.error('--channel and --text are required');
    process.exit(1);
  }

  // Resolve channel name to ID if needed
  let channelId = channelArg;
  if (!channelArg.startsWith('C')) {
    const name = channelArg.replace(/^#/, '');
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000,
    });
    const match = (result.channels ?? []).find((ch) => ch.name === name);
    if (!match) {
      console.error(`Channel "${channelArg}" not found.`);
      process.exit(1);
    }
    channelId = match.id!;
  }

  const postResult = await client.chat.postMessage({
    channel: channelId,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  console.log(`Message posted to #${channelArg} (ts: ${postResult.ts})`);
}

export async function runSlackCmd(args: string[]): Promise<void> {
  const subcommand = args[0];
  const limit = parseInt(getArg(args, '--limit') ?? '100', 10);

  switch (subcommand) {
    case 'channels': {
      const client = createClient();
      await listChannels(client, args.includes('--refresh'));
      break;
    }

    case 'users': {
      const client = createClient();
      await listUsers(client, args.includes('--refresh'));
      break;
    }

    case 'channel-info': {
      if (!args[1]) {
        console.error('Usage: custie slack channel-info <name-or-id>');
        process.exit(1);
      }
      const client = createClient();
      await channelInfo(client, args[1]);
      break;
    }

    case 'user-info': {
      if (!args[1]) {
        console.error('Usage: custie slack user-info <name-or-id>');
        process.exit(1);
      }
      const client = createClient();
      await userInfo(client, args[1]);
      break;
    }

    case 'history': {
      if (!args[1]) {
        console.error('Usage: custie slack history <name-or-id> [--today] [--limit n]');
        process.exit(1);
      }
      const client = createClient();
      await channelHistory(client, args[1], args.slice(2));
      break;
    }

    case 'post': {
      const client = createClient();
      await postMessage(client, args.slice(1));
      break;
    }

    case 'delete': {
      const channel = getArg(args, '--channel');
      const ts = getArg(args, '--ts');
      if (!channel || !ts) {
        console.error('Usage: custie slack delete --channel <channel-id> --ts <timestamp>');
        process.exit(1);
      }
      const client = createClient();
      const channelId = await resolveChannelId(client, channel);
      await client.chat.delete({ channel: channelId, ts });
      console.log(`Message deleted (channel: ${channelId}, ts: ${ts}).`);
      break;
    }

    default:
      console.log(USAGE);
      break;
  }
}
