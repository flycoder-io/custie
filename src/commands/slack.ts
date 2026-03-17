import { WebClient } from '@slack/web-api';
import { loadEnvFiles, loadConfig } from '../config';

const USAGE = `
  Usage: custie slack <subcommand> [options]

  Subcommands:
    channels                        List channels the bot is in
    users                           List workspace users
    channel-info <name-or-id>       Show channel details
    user-info <name-or-id>          Show user details
    post --channel <ch> --text <t>  Post a message to a channel

  Options:
    --limit <n>                     Max results to return (default: 100)
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

    case 'post': {
      const client = createClient();
      await postMessage(client, args.slice(1));
      break;
    }

    default:
      console.log(USAGE);
      break;
  }
}
