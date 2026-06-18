#!/usr/bin/env node
/**
 * linkedin-login.mjs — One-time LinkedIn session setup for job scanning.
 *
 * Opens a real browser, lets you log in to LinkedIn manually,
 * then saves the authenticated session to data/linkedin-session.json.
 * That session is reused by linkedin-scan.mjs on every subsequent run.
 *
 * Usage: node linkedin-login.mjs
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, 'data', 'linkedin-session.json');

console.log('Opening browser for LinkedIn login...');
console.log('1. Log in to LinkedIn in the browser window that opens.');
console.log('2. Once you see your feed, wait a moment, then close the browser window.');
console.log('3. Your session will be saved automatically.\n');

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

await page.goto('https://www.linkedin.com/login');

// Wait for user to complete login and land on feed (up to 3 minutes)
try {
  await page.waitForURL('**/feed/**', { timeout: 180_000 });
} catch {
  // Also accept if they're already logged in and land elsewhere
  const url = page.url();
  if (!url.includes('linkedin.com')) {
    console.error('Navigation left LinkedIn. Please restart and stay on LinkedIn after logging in.');
    await browser.close();
    process.exit(1);
  }
}

// Give cookies a moment to settle
await page.waitForTimeout(3000);

await context.storageState({ path: SESSION_PATH });
await browser.close();

console.log(`\nSession saved → ${SESSION_PATH}`);
console.log('Run: node linkedin-scan.mjs');
