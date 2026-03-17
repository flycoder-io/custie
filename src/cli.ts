import {
  runStart,
  runSetup,
  runInstall,
  runUninstall,
  runPrompt,
  runConfig,
  runUpgrade,
  runAutomationCmd,
  runPause,
  runResume,
  runLogs,
} from './commands';

const USAGE = `
  Usage: custie <command> [options]

  Commands:
    start        Start the Slack bot server
    setup        Interactive first-time setup (guided or browser-automated)
    install      Install as a system service (launchd / systemd)
    uninstall    Remove the system service
    pause        Temporarily stop the service (without uninstalling)
    resume       Restart a paused service
    logs         Tail the service log (-e for error log)
    upgrade      Upgrade custie to the latest version
    prompt       Edit the system prompt in $EDITOR
    config       Show resolved config (--edit to edit, --path for file path)
    automation   Manage scheduled tasks and triggers

  Options:
    -h, --help      Show this help message
    -v, --version   Show version number
`;

declare const __VERSION__: string;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
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

    case 'pause':
    case 'halt':
      await runPause();
      break;

    case 'resume':
      await runResume();
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
