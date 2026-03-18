import { WebClient } from '@slack/web-api';
import { loadEnvFiles, loadConfig } from '../config';

const USAGE = `
  Usage: custie slack <subcommand> [options]

  Subcommands:
    channels                        List channels the bot is in
    users                           List workspace users
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

async function listChannels(client: WebClient, limit: number): Promise<void> {
  const result = await client.conversations.list({
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit,
  });

  const channels = (result.channels ?? []).filter((ch) => ch.is_member);
  if (!channels.length) {
    console.log('The bot is not a member of any channels.');
    return;
  }

  console.log(`Channels the bot is in (${channels.length}):\n`);
  for (const ch of channels) {
    const purpose = ch.purpose?.value ? ` — ${ch.purpose.value}` : '';
    console.log(`  #${ch.name} (${ch.id})${purpose}`);
  }
}

async function listUsers(client: WebClient, limit: number): Promise<void> {
  const result = await client.users.list({ limit });
  const users = (result.members ?? []).filter(
    (u) => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT',
  );

  if (!users.length) {
    console.log('No users found.');
    return;
  }

  console.log(`Workspace users (${users.length}):\n`);
  for (const u of users) {
    const displayName = u.real_name || u.name || u.id;
    const tz = u.tz_label ? ` [${u.tz_label}]` : '';
    console.log(`  ${displayName} (@${u.name}, ${u.id})${tz}`);
  }
}

async function channelInfo(client: WebClient, nameOrId: string): Promise<void> {
  let channelId = nameOrId;

  // If it looks like a name (not starting with C), resolve it
  if (!nameOrId.startsWith('C')) {
    const name = nameOrId.replace(/^#/, '');
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000,
    });
    const match = (result.channels ?? []).find((ch) => ch.name === name);
    if (!match) {
      console.error(`Channel "${nameOrId}" not found.`);
      process.exit(1);
    }
    channelId = match.id!;
  }

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
  let userId = nameOrId;

  // If it doesn't look like a user ID, search by name
  if (!nameOrId.startsWith('U')) {
    const name = nameOrId.replace(/^@/, '');
    const result = await client.users.list({ limit: 1000 });
    const match = (result.members ?? []).find(
      (u) => u.name === name || u.real_name?.toLowerCase() === name.toLowerCase(),
    );
    if (!match) {
      console.error(`User "${nameOrId}" not found.`);
      process.exit(1);
    }
    userId = match.id!;
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
  if (nameOrId.startsWith('C')) return nameOrId;
  const name = nameOrId.replace(/^#/, '');
  const result = await client.conversations.list({
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 1000,
  });
  const match = (result.channels ?? []).find((ch) => ch.name === name);
  if (!match) {
    console.error(`Channel "${nameOrId}" not found.`);
    process.exit(1);
  }
  return match.id!;
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

  // Build user cache for display names
  const userIds = [...new Set(messages.map((m) => m.user).filter(Boolean))] as string[];
  const userNames = new Map<string, string>();
  for (const uid of userIds) {
    try {
      const u = await client.users.info({ user: uid });
      userNames.set(uid, u.user?.real_name || u.user?.name || uid);
    } catch {
      userNames.set(uid, uid);
    }
  }

  console.log(`Messages (${messages.length}):\n`);
  for (const msg of messages) {
    const ts = msg.ts ? new Date(parseFloat(msg.ts) * 1000) : null;
    const time = ts ? ts.toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : '?';
    const author = msg.user ? userNames.get(msg.user) ?? msg.user : msg.bot_id ?? 'unknown';
    const text = msg.text?.replace(/\n/g, '\n    ') ?? '';
    const thread = msg.reply_count ? ` [${msg.reply_count} replies]` : '';
    console.log(`  [${time}] ${author}${thread}:`);
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
      await listChannels(client, limit);
      break;
    }

    case 'users': {
      const client = createClient();
      await listUsers(client, limit);
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
