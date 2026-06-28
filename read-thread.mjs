import { WebClient } from '@slack/web-api';
import { readFileSync } from 'fs';
import { homedir } from 'os';

const env = readFileSync(`${homedir()}/.config/custie/profiles/flycoder/config.env`, 'utf8');
const token = env.match(/^SLACK_BOT_TOKEN=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
const client = new WebClient(token);

const res = await client.conversations.history({ channel: 'C0B59QDDF8U', oldest: '1779619327.000000', latest: '1779619328.000000', inclusive: true });
for (const m of res.messages) {
  console.log('FULL MSG:', JSON.stringify(m, null, 2));
}
