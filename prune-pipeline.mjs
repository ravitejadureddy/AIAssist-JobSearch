#!/usr/bin/env node
/**
 * prune-pipeline.mjs — Pre-filter dead job links from data/pipeline.md
 *
 * Checks liveness of all pending URLs via Playwright before they enter the
 * evaluation pipeline. Expired or invalid links are moved to the Processed
 * section (marked [!]) so they never waste evaluation tokens.
 *
 * Usage:
 *   node prune-pipeline.mjs           # check all pending URLs
 *   node prune-pipeline.mjs --dry-run # preview without writing
 *
 * Exit code: 0 always — pruning is best-effort; pipeline should still run.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { chromium } from 'playwright';
import { checkUrlLiveness } from './liveness-browser.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(CAREER_OPS, 'data/pipeline.md');
const DRY_RUN = process.argv.includes('--dry-run');

mkdirSync(join(CAREER_OPS, 'data'), { recursive: true });

// Parse a pending line: "- [ ] <url>" or "- [ ] <url> | Company | Role"
function parsePendingLine(line) {
  const match = line.match(/^- \[ \] (.+)$/);
  if (!match) return null;
  const parts = match[1].split('|').map(s => s.trim());
  return {
    url: parts[0],
    company: parts[1] || '',
    role: parts[2] || '',
  };
}

// Detect the pending section header (supports "## Pending", "## Pendientes", etc.)
function isPendingHeader(line) {
  return /^##\s+Pendin/i.test(line) || /^##\s+Pendientes/i.test(line);
}

function isProcessedHeader(line) {
  return /^##\s+Processed/i.test(line);
}

async function main() {
  if (!existsSync(PIPELINE_PATH)) {
    console.error('data/pipeline.md not found — nothing to prune');
    process.exit(0);
  }

  const content = readFileSync(PIPELINE_PATH, 'utf-8');
  const lines = content.split('\n');

  // Collect all pending items with their line index.
  // Skip scanner-tagged URLs that guarantee freshness by API time_frame filter:
  //   | LinkedIn      — verified active by linkedin-scan.mjs within 48h
  //   | Fantastic.jobs — verified fresh by Fantastic.jobs API time_frame filter (24h default)
  const pending = [];
  let scannerSkipped = 0;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parsePendingLine(lines[i]);
    if (!parsed) continue;
    const line = lines[i];
    if (
      line.endsWith('| LinkedIn') || line.includes('| LinkedIn |') ||
      line.endsWith('| Fantastic.jobs') || line.includes('| Fantastic.jobs |')
    ) {
      scannerSkipped++;
      continue;
    }
    pending.push({ ...parsed, lineIdx: i });
  }
  if (scannerSkipped > 0) {
    console.log(`Skipping ${scannerSkipped} scanner-tagged URL(s) (LinkedIn / Fantastic.jobs) — freshness guaranteed by source.\n`);
  }

  if (pending.length === 0) {
    console.log('No pending URLs found in data/pipeline.md — nothing to prune');
    process.exit(0);
  }

  console.log(`Checking ${pending.length} pending URL(s) for liveness...\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const expired = [];
  const kept = [];

  for (const item of pending) {
    const { result, reason } = await checkUrlLiveness(page, item.url);
    const icon = { active: '✅', expired: '❌', uncertain: '⚠️' }[result];
    const label = item.company
      ? `${item.company}${item.role ? ' — ' + item.role : ''}`
      : item.url;
    console.log(`${icon} ${result.padEnd(10)} ${label}`);
    if (result !== 'active') console.log(`           ${reason}`);

    if (result === 'expired') {
      expired.push(item);
    } else {
      // active and uncertain both stay in pending
      kept.push(item);
    }
  }

  await browser.close();

  console.log(`\nResults: ${kept.length} active/uncertain (kept)  ${expired.length} expired (pruned)`);

  if (expired.length === 0) {
    console.log('Nothing to prune — pipeline.md unchanged');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] Would remove from pending:');
    for (const item of expired) {
      const label = item.company ? `${item.company} — ${item.role}` : item.url;
      console.log(`  ❌ ${label}`);
    }
    console.log('\n[dry-run] pipeline.md not modified');
    process.exit(0);
  }

  // Build set of line indices to drop from the pending section
  const expiredIdx = new Set(expired.map(i => i.lineIdx));

  // Build the [!] lines for the Processed section
  const today = new Date().toISOString().slice(0, 10);
  const prunedLines = expired.map(item => {
    const meta = [item.company, item.role].filter(Boolean).join(' | ');
    return `- [!] ${item.url}${meta ? ' | ' + meta : ''} | Pruned: expired/invalid (${today})`;
  });

  // Rebuild lines: drop expired pending entries, insert pruned lines into Processed section
  const newLines = [];
  let insertedIntoProcesed = false;

  for (let i = 0; i < lines.length; i++) {
    // Drop expired pending lines
    if (expiredIdx.has(i)) continue;

    newLines.push(lines[i]);

    // Insert right after "## Processed" heading (before any existing entries)
    if (!insertedIntoProcesed && isProcessedHeader(lines[i])) {
      newLines.push('');
      newLines.push(...prunedLines);
      insertedIntoProcesed = true;
    }
  }

  // No Processed section yet — append one
  if (!insertedIntoProcesed) {
    newLines.push('');
    newLines.push('## Processed');
    newLines.push('');
    newLines.push(...prunedLines);
  }

  writeFileSync(PIPELINE_PATH, newLines.join('\n'), 'utf-8');
  console.log(`\nPruned ${expired.length} dead link(s) from data/pipeline.md`);
  if (kept.length > 0) {
    console.log(`${kept.length} URL(s) remain in pending for evaluation`);
  }
}

main().catch(err => {
  // Non-fatal: log the error but let the pipeline continue
  console.error(`prune-pipeline error: ${err.message}`);
  process.exit(0);
});
