#!/usr/bin/env node
/**
 * backfill-validation.mjs — One-shot: for every H1B-eligible row in Apply Queue
 * that doesn't yet have validation.json, run validate-resume.mjs.
 *
 * Skips rows that:
 *   - aren't in Apply Queue
 *   - have H1B label outside {High, Medium, Low}
 *   - already have a fresh validation.json
 *   - have no output folder (no tailored CV exists to validate)
 *
 * Usage:
 *   node backfill-validation.mjs                # all eligible
 *   node backfill-validation.mjs --dry-run      # list what would run
 *   node backfill-validation.mjs --limit 5      # cap to 5 rows (for testing)
 *   node backfill-validation.mjs --concurrency 1  # default 1 (serial, safest)
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadQueueMap } from './queue-eligibility.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = __dirname;
const OUTPUT_DIR = join(CAREER_OPS, 'output');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : Infinity;
const concIdx = args.indexOf('--concurrency');
const CONCURRENCY = concIdx >= 0 ? parseInt(args[concIdx + 1]) : 1;

function findOutputFolder(num) {
  if (!existsSync(OUTPUT_DIR)) return null;
  const match = readdirSync(OUTPUT_DIR).find(d => d.startsWith(`${num}-`));
  return match ? join(OUTPUT_DIR, match) : null;
}

function hasFreshValidation(folder) {
  const valPath = join(folder, 'validation.json');
  const contentPath = join(folder, 'cv-content.json');
  if (!existsSync(valPath)) return false;
  if (!existsSync(contentPath)) return true; // val exists, content gone — keep val
  try {
    return statSync(valPath).mtimeMs >= statSync(contentPath).mtimeMs;
  } catch { return false; }
}

function runValidator(num) {
  return new Promise(res => {
    const child = spawn(process.execPath, [join(CAREER_OPS, 'validate-resume.mjs'), String(num)], {
      cwd: CAREER_OPS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => res({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on('error', err => res({ code: -1, stdout: '', stderr: err.message }));
  });
}

async function main() {
  const queue = loadQueueMap();
  const candidates = [...queue.values()]
    .filter(r => ['High', 'Medium', 'Low'].includes(r.h1bLabel))
    .map(r => {
      const folder = findOutputFolder(r.num);
      return { ...r, folder, hasContent: folder && existsSync(join(folder, 'cv-content.json')),
               hasValidation: folder && hasFreshValidation(folder) };
    });

  const toRun = candidates.filter(c => c.folder && c.hasContent && !c.hasValidation).slice(0, LIMIT);
  const skipped = candidates.length - toRun.length;

  console.log(`Apply Queue eligible (H1B High/Med/Low): ${candidates.length}`);
  console.log(`  no output folder:    ${candidates.filter(c => !c.folder).length}`);
  console.log(`  no cv-content.json:  ${candidates.filter(c => c.folder && !c.hasContent).length}`);
  console.log(`  already validated:   ${candidates.filter(c => c.hasValidation).length}`);
  console.log(`To run: ${toRun.length} (limit=${LIMIT})`);

  if (DRY_RUN) {
    for (const c of toRun) console.log(`  #${c.num} ${c.company} — ${c.role} [${c.h1bLabel}]`);
    return;
  }

  if (toRun.length === 0) { console.log('Nothing to validate.'); return; }

  let done = 0, passed = 0, failed = 0;
  const t0 = Date.now();

  async function worker(jobs) {
    while (jobs.length) {
      const c = jobs.shift();
      const r = await runValidator(c.num);
      done++;
      if (r.code === 0) {
        passed++;
        const m = r.stdout.match(/score=(\d+(?:\.\d+)?)/);
        const v = r.stdout.includes('→ ✓') ? '✓' : '✗';
        console.log(`[${done}/${toRun.length}] #${c.num} ${c.company.slice(0, 30)} → ${v} ${m ? m[1] : ''}`);
      } else {
        failed++;
        console.log(`[${done}/${toRun.length}] #${c.num} FAILED — ${r.stderr.slice(0, 100)}`);
      }
    }
  }

  const jobs = [...toRun];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(jobs)));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone: ${passed} passed, ${failed} failed in ${elapsed}s`);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
