#!/usr/bin/env node
/**
 * schedule-retry.mjs — one-shot: schedule a batch retry at a specific time
 *
 * Use this when THIS interactive Claude Code session hits a session limit
 * and shows a reset time. It creates a temporary launchd plist that fires
 * auto-batch.mjs at the specified time (+ 2-minute buffer).
 *
 * Usage:
 *   node schedule-retry.mjs "3:45 PM"
 *   node schedule-retry.mjs "15:45"
 *
 * Or from within Claude Code:
 *   ! node schedule-retry.mjs "3:45 PM"
 */

import { writeFileSync, existsSync, unlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;
const PROJECT_DIR = __dirname;
const RETRY_PLIST = join(HOME, 'Library/LaunchAgents/com.careerops.batch-retry.plist');
const FANTASTIC_JOBS_API_KEY = process.env.FANTASTIC_JOBS_API_KEY ?? '';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node schedule-retry.mjs "3:45 PM"   or   "15:45"');
  console.error('Example: ! node schedule-retry.mjs "3:45 PM"');
  process.exit(1);
}

// Parse time — supports "3:45 PM", "3:45pm", "15:45"
let hour, minute;
const ampmMatch = arg.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
const h24Match  = arg.match(/^(\d{1,2}):(\d{2})$/);

if (ampmMatch) {
  hour   = parseInt(ampmMatch[1], 10);
  minute = parseInt(ampmMatch[2], 10);
  const ap = ampmMatch[3].toUpperCase();
  if (ap === 'PM' && hour !== 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
} else if (h24Match) {
  hour   = parseInt(h24Match[1], 10);
  minute = parseInt(h24Match[2], 10);
} else {
  console.error(`Could not parse time: "${arg}"`);
  console.error('Examples: "3:45 PM", "3:45pm", "15:45"');
  process.exit(1);
}

if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
  console.error(`Invalid time values: hour=${hour} minute=${minute}`);
  process.exit(1);
}

// Add 2-minute buffer; roll over to next day if already past
const retryDate = new Date();
retryDate.setHours(hour, minute + 2, 0, 0);
if (retryDate <= new Date()) retryDate.setDate(retryDate.getDate() + 1);

const rHour = retryDate.getHours();
const rMin  = retryDate.getMinutes();
const label = retryDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

console.log(`Scheduling batch retry at ${label} (+2 min buffer)`);

// Unload and remove any existing retry plist
if (existsSync(RETRY_PLIST)) {
  spawnSync('launchctl', ['unload', RETRY_PLIST], { stdio: 'ignore' });
  try { unlinkSync(RETRY_PLIST); } catch {}
}

const envBlock = FANTASTIC_JOBS_API_KEY
  ? `    <key>EnvironmentVariables</key>
    <dict>
        <key>FANTASTIC_JOBS_API_KEY</key>
        <string>${FANTASTIC_JOBS_API_KEY}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>`
  : `    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>`;

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.careerops.batch-retry</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
        <string>/usr/local/bin/node</string>
        <string>${PROJECT_DIR}/auto-batch.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
${envBlock}
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>${rHour}</integer>
        <key>Minute</key><integer>${rMin}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/careerops-batch-retry.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/careerops-batch-retry-error.log</string>
</dict>
</plist>`;

writeFileSync(RETRY_PLIST, plist, 'utf-8');
const load = spawnSync('launchctl', ['load', RETRY_PLIST], { stdio: 'pipe' });

if (load.status !== 0) {
  console.error('launchctl load failed:', load.stderr?.toString().trim());
  process.exit(1);
}

console.log(`✅ Retry scheduled — batch will run at ${rHour.toString().padStart(2,'0')}:${rMin.toString().padStart(2,'0')} (local time)`);
console.log(`   Plist: ${RETRY_PLIST}`);
console.log(`   Log:   /tmp/careerops-batch-retry.log`);
