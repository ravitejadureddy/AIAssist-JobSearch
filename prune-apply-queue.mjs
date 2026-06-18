#!/usr/bin/env node
/**
 * prune-apply-queue.mjs
 *
 * Checks liveness of all Apply Queue jobs (status=Evaluated, score>=3.5).
 * Reads each job's URL from its report file, checks if the posting is still
 * live, and updates applications.md: Evaluated → Discarded for expired ones.
 *
 * Usage:
 *   node prune-apply-queue.mjs           # check all, update tracker
 *   node prune-apply-queue.mjs --dry-run # show what would be discarded
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { checkUrlLivenessWithFallback, newLivenessPage } from './liveness-browser.mjs';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKER   = join(__dirname, 'data', 'applications.md');
const DRY_RUN   = process.argv.includes('--dry-run');
const HEADED    = process.argv.includes('--headed');

// ── Parse Apply Queue from tracker ───────────────────────────────────────────
function parseApplyQueue() {
  const lines = readFileSync(TRACKER, 'utf-8').split('\n');
  const jobs = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 8) continue;
    const [num, date, company, role, score, status] = cols;
    const scoreVal = parseFloat(score);
    if (status !== 'Evaluated' || isNaN(scoreVal) || scoreVal < 3.5) continue;
    const reportCol = cols[7] || '';
    const m = reportCol.match(/\(([^)]+)\)/);
    jobs.push({ num, company, role, score, reportRel: m ? m[1] : null });
  }
  return jobs;
}

// ── Read URL from report file ─────────────────────────────────────────────────
function readReportUrl(reportRel) {
  if (!reportRel) return null;
  const norm = reportRel.replace(/^\.\.\//, '');
  const path = join(__dirname, norm);
  if (!existsSync(path)) return null;
  try {
    const m = readFileSync(path, 'utf-8').match(/^\*\*URL:\*\*\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// ── Mark a tracker row as Discarded ──────────────────────────────────────────
function markDiscarded(num, note) {
  let content = readFileSync(TRACKER, 'utf-8');
  // Match the row: starts with | <num> |
  const rowRe = new RegExp(`^(\\| ${num} \\|[^\\n]*)$`, 'm');
  const match = content.match(rowRe);
  if (!match) { console.log(`  ⚠️  Row ${num} not found in tracker`); return; }

  let row = match[1];
  // Replace status column (column 6, 0-indexed after splitting by |)
  const cols = row.split('|');
  // cols: ['', num, date, company, role, score, status, pdf, report, notes, '']
  //        0   1    2     3        4     5      6       7    8       9      10
  if (cols[6] !== undefined) {
    cols[6] = ` Discarded `;
  }
  // Append note if notes column exists
  if (cols[9] !== undefined) {
    const existing = cols[9].trim();
    cols[9] = ` Posting expired${existing ? '; ' + existing : ''} `;
  }
  const newRow = cols.join('|');
  content = content.replace(rowRe, newRow);
  writeFileSync(TRACKER, content);
}

async function main() {
  const queue = parseApplyQueue();
  console.log(`Apply Queue: ${queue.length} jobs to check\n`);

  // Attach URL to each job
  for (const job of queue) {
    job.url = readReportUrl(job.reportRel);
  }

  const noUrl = queue.filter(j => !j.url);
  if (noUrl.length) {
    console.log(`⚠️  ${noUrl.length} jobs have no URL in report (skipping): ${noUrl.map(j => j.num).join(', ')}\n`);
  }

  const checkable = queue.filter(j => j.url);
  console.log(`Checking ${checkable.length} URLs...\n`);

  const browser = await chromium.launch({ headless: !HEADED });
  let expired = 0;
  let active  = 0;
  let unknown = 0;

  for (const job of checkable) {
    process.stdout.write(`[${job.num}] ${job.company} — ${job.url.slice(0, 70)}... `);
    const page = await newLivenessPage(browser);
    // Only pass getHeadedPage in headed mode (launchd has no display)
    const fallbackOpts = HEADED ? { getHeadedPage: () => newLivenessPage(browser) } : {};
    try {
      const res = await checkUrlLivenessWithFallback(page, job.url, fallbackOpts);
      const result = res?.result ?? res;
      if (result === 'expired') {
        console.log('❌ EXPIRED');
        if (!DRY_RUN) markDiscarded(job.num, '');
        expired++;
      } else if (result === 'active') {
        console.log('✅ active');
        active++;
      } else {
        console.log(`⚠️  uncertain (${JSON.stringify(res)})`);
        unknown++;
      }
    } catch (err) {
      console.log(`❌ error: ${err.message}`);
      unknown++;
    } finally {
      await page.close().catch(() => {});
    }
    // Brief delay between checks
    await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
  }

  await browser.close();

  console.log(`\n── Summary ──`);
  console.log(`  Active:   ${active}`);
  console.log(`  Expired:  ${expired}${DRY_RUN ? ' (dry run — not written)' : ' → marked Discarded'}`);
  console.log(`  Uncertain: ${unknown}`);
}

main().catch(err => { console.error(err); process.exit(1); });
