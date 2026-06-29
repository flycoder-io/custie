import './logger';
import {
  runStart,
  runSetup,
  runInstall,
  runUninstall,
  runPrompt,
  runConfig,
  runUpgrade,
  runAutomationCmd,
  runStop,
  runRestart,
  runLogs,
  runSlackCmd,
  runProfiles,
  runXeroCmd,
  runDashboard,
} from './commands';
import { getProfile } from './profile';

const USAGE = `
  Usage: custie <command> [options]

  Commands:
    start        Start the Slack bot server
    setup        Interactive first-time setup (guided or browser-automated)
    install      Install as a system service (launchd / systemd)
    uninstall    Remove the system service
    stop         Stop the service (without uninstalling)
    restart      Restart the service
    logs         Tail the service log (-e for error log)
    upgrade      Upgrade custie to the latest version
    prompt       Edit the system prompt in $EDITOR
    config       Show resolved config (--edit to edit, --path for file path)
    automation   Manage scheduled tasks and triggers
    slack        Query Slack (channels, users, post messages)
    profiles     List instances and their service status
    xero         Connect to Xero and expose it as an MCP server
    dashboard    Start the read-only management dashboard (web UI)

  Options:
    -p, --profile <name>   Target a named instance (default: the unnamed instance)
    -h, --help             Show this help message
    -v, --version          Show version number
`;

declare const __VERSION__: string;

/**
 * Pull `--profile <name>` / `-p <name>` (and `=` forms) out of the argument
 * list wherever they appear, so every command transparently supports it. The
 * resolved name is published via `CUSTIE_PROFILE` for `paths` and `service`.
 */
function extractProfileFlag(argv: string[]): { profile?: string; args: string[] } {
  const args: string[] = [];
  let profile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--profile' || arg === '-p') {
      profile = argv[i + 1];
      i++;
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
    } else if (arg.startsWith('-p=')) {
      profile = arg.slice('-p='.length);
    } else {
      args.push(arg);
    }
  }

  return { profile, args };
}

async function main(): Promise<void> {
  const { profile, args } = extractProfileFlag(process.argv.slice(2));
  if (profile) {
    process.env['CUSTIE_PROFILE'] = profile;
  }
  // Validate early so an invalid --profile fails fast with a clear message.
  getProfile();

  const command = args[0];

  switch (command) {
    case 'start':
      await runStart();
      break;

    case 'setup':
      await runSetup(args.slice(1));
      break;

    case 'install':
      await runInstall();
      break;

    case 'uninstall':
      await runUninstall();
      break;

    case 'stop':
      await runStop();
      break;

    case 'restart':
      await runRestart();
      break;

    case 'logs':
      await runLogs(args.slice(1));
      break;

    case 'upgrade':
      await runUpgrade();
      break;

    case 'prompt':
      await runPrompt();
      break;

    case 'config':
      await runConfig(args.slice(1));
      break;

    case 'automation':
      await runAutomationCmd(args.slice(1));
      break;

    case 'slack':
      await runSlackCmd(args.slice(1));
      break;

    case 'profiles':
      await runProfiles();
      break;

    case 'xero':
      await runXeroCmd(args.slice(1));
      break;

    case 'dashboard':
      await runDashboard(args.slice(1));
      break;

    case '-v':
    case '--version':
      console.log(__VERSION__);
      break;

    case '-h':
    case '--help':
    case undefined:
      console.log(USAGE);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[custie] Fatal error:', err);
  process.exit(1);
});
