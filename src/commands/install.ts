import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { paths, ensureDirs } from '../paths';

const PLIST_NAME = 'io.flycoder.custie.plist';
const SYSTEMD_SERVICE = 'custie.service';

function log(msg: string): void {
  console.log(`\n\x1b[36m>\x1b[0m ${msg}`);
}

function success(msg: string): void {
  console.log(`\x1b[32m+\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`\x1b[33m!\x1b[0m ${msg}`);
}

function run(cmd: string, opts: { silent?: boolean } = {}): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: opts.silent ? 'pipe' : 'inherit',
  })
    .toString()
    .trim();
}

function detectCustieBin(): string {
  // Resolve the actual binary path
  const argv1 = process.argv[1];
  if (argv1) {
    return resolve(argv1);
  }
  // Fallback: look for custie in PATH
  try {
    return run('which custie', { silent: true });
  } catch {
    return 'custie';
  }
}

function readEnvFile(): Record<string, string> {
  if (!existsSync(paths.CONFIG_FILE)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(paths.CONFIG_FILE, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (val) vars[key] = val;
  }
  return vars;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function installMacOS(): Promise<void> {
  log('Setting up macOS LaunchAgent...');

  const custieBin = detectCustieBin();
  const nodePath = process.execPath;
  const logDir = paths.LOG_DIR;
  mkdirSync(logDir, { recursive: true });

  const envVars = readEnvFile();

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.flycoder.custie</string>

  <key>ProgramArguments</key>
  <array>
    <string>${custieBin}</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin</string>
${Object.entries(envVars)
  .map(([k, v]) => `    <key>${k}</key>\n    <string>${escapeXml(v)}</string>`)
  .join('\n')}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${join(logDir, 'custie.log')}</string>

  <key>StandardErrorPath</key>
  <string>${join(logDir, 'custie-error.log')}</string>
</dict>
</plist>`;

  const agentDir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(agentDir, { recursive: true });
  const plistPath = join(agentDir, PLIST_NAME);

  // Remove existing
  try {
    run(`launchctl unload "${plistPath}"`, { silent: true });
  } catch {
    /* not loaded */
  }
  try {
    unlinkSync(plistPath);
  } catch {
    /* not present */
  }

  writeFileSync(plistPath, plist);
  run(`launchctl load "${plistPath}"`, { silent: true });

  success('LaunchAgent installed and loaded.');
  console.log(`  Logs: ${logDir}`);
  console.log(`  Check: launchctl list | grep custie`);
}

async function installLinux(): Promise<void> {
  log('Setting up systemd user service...');

  const custieBin = detectCustieBin();
  const nodePath = process.execPath;
  const logDir = paths.LOG_DIR;
  mkdirSync(logDir, { recursive: true });

  const envVars = readEnvFile();
  const envLines = Object.entries(envVars)
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join('\n');

  const unit = `[Unit]
Description=Custie Slack Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${custieBin} start
Restart=on-failure
RestartSec=5
${envLines}
Environment="PATH=${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin"

StandardOutput=append:${join(logDir, 'custie.log')}
StandardError=append:${join(logDir, 'custie-error.log')}

[Install]
WantedBy=default.target
`;

  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, SYSTEMD_SERVICE), unit);

  run('systemctl --user daemon-reload', { silent: true });
  run('systemctl --user enable --now custie', { silent: true });

  success('systemd user service installed and started.');
  console.log(`  Logs: ${logDir}`);
  console.log(`  Check: systemctl --user status custie`);
}

export async function runInstall(): Promise<void> {
  ensureDirs();

  const os = platform();
  if (os === 'darwin') {
    await installMacOS();
  } else if (os === 'linux') {
    await installLinux();
  } else {
    warn(`Unsupported platform: ${os}. You'll need to configure autostart manually.`);
  }
}
