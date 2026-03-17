import { createRequire } from 'node:module';
import { runStart, runSetup, runInstall, runUninstall, runPrompt, runConfig, runUpgrade } from './commands';

const USAGE = `
  Usage: custie <command> [options]

  Commands:
    start        Start the Slack bot server
    setup        Interactive first-time setup (--browser for Playwright automation)
    install      Install as a system service (launchd / systemd)
    uninstall    Remove the system service
    upgrade      Upgrade custie to the latest version
    prompt       Edit the system prompt in $EDITOR
    config       Show resolved config (--edit to edit, --path for file path)

  Options:
    -h, --help      Show this help message
    -v, --version   Show version number
`;

function getVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json') as { version: string };
  return pkg.version;
}

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

    case 'upgrade':
      await runUpgrade();
      break;

    case 'prompt':
      await runPrompt();
      break;

    case 'config':
      await runConfig(args.slice(1));
      break;

    case '-v':
    case '--version':
      console.log(getVersion());
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
