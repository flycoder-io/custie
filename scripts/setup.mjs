#!/usr/bin/env node

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const PLIST_NAME = "io.flycoder.custie.plist";
const SYSTEMD_SERVICE = "custie.service";
const TASK_NAME = "CustieSlackBot";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function log(msg) {
  console.log(`\n\x1b[36m▸\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m✔\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: opts.silent ? "pipe" : "inherit", cwd: REPO_ROOT, ...opts }).toString().trim();
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

async function uninstall() {
  const os = platform();
  log("Uninstalling Custie service…");

  if (os === "darwin") {
    const agentDir = join(homedir(), "Library", "LaunchAgents");
    const plistLink = join(agentDir, PLIST_NAME);
    try { run(`launchctl unload "${plistLink}"`, { silent: true }); } catch { /* not loaded */ }
    try { unlinkSync(plistLink); } catch { /* not present */ }
    // Remove generated plist in repo root
    const plistLocal = join(REPO_ROOT, PLIST_NAME);
    try { unlinkSync(plistLocal); } catch { /* not present */ }
    success("LaunchAgent removed.");
  } else if (os === "linux") {
    try { run("systemctl --user disable --now custie", { silent: true }); } catch { /* not active */ }
    const unitPath = join(homedir(), ".config", "systemd", "user", SYSTEMD_SERVICE);
    try { unlinkSync(unitPath); } catch { /* not present */ }
    try { run("systemctl --user daemon-reload", { silent: true }); } catch { /* ignore */ }
    success("systemd user service removed.");
  } else if (os === "win32") {
    try { run(`schtasks /delete /tn "${TASK_NAME}" /f`, { silent: true }); } catch { /* not registered */ }
    success("Scheduled task removed.");
  } else {
    warn(`Unsupported platform: ${os}`);
  }

  rl.close();
}

// ─── Step 1: Prerequisites ──────────────────────────────────────────────────

function checkPrerequisites() {
  log("Checking prerequisites…");

  // Node.js version
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    error(`Node.js >= 18 is required (you have ${process.versions.node}).`);
    error("Install the latest LTS from https://nodejs.org or use nvm/fnm.");
    process.exit(1);
  }
  success(`Node.js ${process.versions.node}`);

  // npm install
  if (!existsSync(join(REPO_ROOT, "node_modules"))) {
    log("Installing dependencies…");
    run("npm install");
  }
  success("Dependencies installed.");

  // Build
  if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) {
    log("Building project…");
    run("npm run build");
  }
  success("Build artefact exists (dist/index.js).");
}

// ─── Step 2: Interactive .env ───────────────────────────────────────────────

async function setupEnv() {
  const envPath = join(REPO_ROOT, ".env");

  if (existsSync(envPath)) {
    const answer = await ask("\n  .env already exists. Reconfigure? (y/N) ");
    if (answer.trim().toLowerCase() !== "y") {
      success("Keeping existing .env.");
      return;
    }
  }

  log("Let's configure your Slack app tokens.");
  console.log(`
  1. Go to https://api.slack.com/apps and create (or select) your app.
  2. Under "OAuth & Permissions", install the app to your workspace.
     Copy the \x1b[1mBot User OAuth Token\x1b[0m (starts with xoxb-).
  3. Under "Basic Information → App-Level Tokens", create a token with
     the \x1b[1mconnections:write\x1b[0m scope. Copy the token (starts with xapp-).
  4. Under "Basic Information", copy the \x1b[1mSigning Secret\x1b[0m.
  `);

  const botToken = await promptToken("SLACK_BOT_TOKEN", "xoxb-");
  const appToken = await promptToken("SLACK_APP_TOKEN", "xapp-");
  const signingSecret = await promptRequired("SLACK_SIGNING_SECRET");

  const claudeCwd = (await ask(`\n  CLAUDE_CWD (default: ${REPO_ROOT}): `)).trim() || REPO_ROOT;
  const allowedUsers = (await ask("  ALLOWED_USER_IDS (comma-separated, leave blank for everyone): ")).trim();

  const envContent = [
    `# Slack Bot Token (xoxb-...)`,
    `SLACK_BOT_TOKEN=${botToken}`,
    ``,
    `# Slack App-Level Token for Socket Mode (xapp-...)`,
    `SLACK_APP_TOKEN=${appToken}`,
    ``,
    `# Slack Signing Secret`,
    `SLACK_SIGNING_SECRET=${signingSecret}`,
    ``,
    `# Default working directory for Claude sessions (optional)`,
    `CLAUDE_CWD=${claudeCwd}`,
    ``,
    `# Comma-separated Slack user IDs allowed to interact (empty = everyone)`,
    `ALLOWED_USER_IDS=${allowedUsers}`,
    ``,
  ].join("\n");

  writeFileSync(envPath, envContent);
  success(".env written.");
}

async function promptToken(name, prefix) {
  while (true) {
    const value = (await ask(`  ${name}: `)).trim();
    if (!value) { warn("Value is required."); continue; }
    if (!value.startsWith(prefix)) { warn(`Expected value starting with "${prefix}".`); continue; }
    return value;
  }
}

async function promptRequired(name) {
  while (true) {
    const value = (await ask(`  ${name}: `)).trim();
    if (value) return value;
    warn("Value is required.");
  }
}

// ─── Step 3: OS service installation ────────────────────────────────────────

async function installService() {
  const answer = await ask("\n  Install as a system service so Custie starts automatically? (Y/n) ");
  if (answer.trim().toLowerCase() === "n") {
    log("Skipping service installation. Run manually with: npm start");
    return;
  }

  const os = platform();
  if (os === "darwin") await installMacOS();
  else if (os === "linux") await installLinux();
  else if (os === "win32") await installWindows();
  else warn(`Unsupported platform: ${os}. You'll need to configure autostart manually.`);
}

async function installMacOS() {
  log("Setting up macOS LaunchAgent…");

  const nodePath = process.execPath;
  const logDir = join(homedir(), "Library", "Logs", "custie");
  mkdirSync(logDir, { recursive: true });

  // Read .env so we can embed tokens into the plist environment
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
    <string>${nodePath}</string>
    <string>${join(REPO_ROOT, "dist", "index.js")}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin</string>
${Object.entries(envVars).map(([k, v]) => `    <key>${k}</key>\n    <string>${escapeXml(v)}</string>`).join("\n")}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${join(logDir, "custie.log")}</string>

  <key>StandardErrorPath</key>
  <string>${join(logDir, "custie-error.log")}</string>
</dict>
</plist>`;

  const plistPath = join(REPO_ROOT, PLIST_NAME);
  writeFileSync(plistPath, plist);

  const agentDir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agentDir, { recursive: true });
  const symlink = join(agentDir, PLIST_NAME);

  // Remove existing symlink/file
  try { unlinkSync(symlink); } catch { /* not present */ }
  symlinkSync(plistPath, symlink);

  // Unload first in case already loaded
  try { run(`launchctl unload "${symlink}"`, { silent: true }); } catch { /* ignore */ }
  run(`launchctl load "${symlink}"`, { silent: true });

  success("LaunchAgent installed and loaded.");
  console.log(`  Logs: ${logDir}`);
  console.log(`  Check: launchctl list | grep custie`);
}

async function installLinux() {
  log("Setting up systemd user service…");

  const nodePath = process.execPath;
  const logDir = join(homedir(), ".local", "share", "custie", "logs");
  mkdirSync(logDir, { recursive: true });

  const envVars = readEnvFile();
  const envLines = Object.entries(envVars).map(([k, v]) => `Environment="${k}=${v}"`).join("\n");

  const unit = `[Unit]
Description=Custie Slack Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
ExecStart=${nodePath} ${join(REPO_ROOT, "dist", "index.js")}
Restart=on-failure
RestartSec=5
${envLines}
Environment="PATH=${dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin"

StandardOutput=append:${join(logDir, "custie.log")}
StandardError=append:${join(logDir, "custie-error.log")}

[Install]
WantedBy=default.target
`;

  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, SYSTEMD_SERVICE), unit);

  run("systemctl --user daemon-reload", { silent: true });
  run("systemctl --user enable --now custie", { silent: true });

  success("systemd user service installed and started.");
  console.log(`  Logs: ${logDir}`);
  console.log(`  Check: systemctl --user status custie`);
}

async function installWindows() {
  log("Setting up Windows scheduled task…");

  const nodePath = process.execPath;
  const logDir = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "custie", "logs");
  mkdirSync(logDir, { recursive: true });

  // schtasks doesn't support env vars natively, so we create a wrapper script
  const wrapperPath = join(REPO_ROOT, "scripts", "start-custie.bat");
  const envVars = readEnvFile();
  const setLines = Object.entries(envVars).map(([k, v]) => `set "${k}=${v}"`).join("\r\n");

  const bat = `@echo off\r\n${setLines}\r\ncd /d "${REPO_ROOT}"\r\n"${nodePath}" dist\\index.js >> "${join(logDir, "custie.log")}" 2>> "${join(logDir, "custie-error.log")}"\r\n`;
  writeFileSync(wrapperPath, bat);

  // Delete existing task if present
  try { run(`schtasks /delete /tn "${TASK_NAME}" /f`, { silent: true }); } catch { /* ignore */ }

  run(
    `schtasks /create /tn "${TASK_NAME}" /tr "${wrapperPath}" /sc onlogon /rl limited /f`,
    { silent: true },
  );

  // Start it now
  try { run(`schtasks /run /tn "${TASK_NAME}"`, { silent: true }); } catch { /* ignore */ }

  success("Scheduled task installed.");
  console.log(`  Logs: ${logDir}`);
  console.log(`  Check: schtasks /query /tn "${TASK_NAME}"`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function readEnvFile() {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const vars = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (val) vars[key] = val;
  }
  return vars;
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1m🤖 Custie Setup\x1b[0m\n");

  if (process.argv.includes("--uninstall")) {
    await uninstall();
    return;
  }

  checkPrerequisites();
  await setupEnv();
  await installService();

  log("Setup complete! Custie is ready.");
  rl.close();
}

main().catch((err) => {
  error(err.message);
  rl.close();
  process.exit(1);
});
