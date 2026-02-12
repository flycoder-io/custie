import { App } from '@slack/bolt';
import type { Config } from '../config.js';

export function createSlackApp(config: Config): App {
  return new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true,
  });
}
