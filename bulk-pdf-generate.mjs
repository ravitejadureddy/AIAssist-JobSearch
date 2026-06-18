#!/usr/bin/env node
/**
 * bulk-pdf-generate.mjs
 *
 * Generates missing PDFs for all Evaluated, score≥3.5, ❌ PDF jobs.
 * Uses the base resume.html from an existing good output dir as the source.
 * Updates applications.md ❌ → ✅ for each successful render.
 *
 * Usage: node bulk-pdf-generate.mjs [--base=output/2249-ironclad]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const APPLICATIONS_FILE = join(__dirname, 'data', 'applications.md');
const REPORTS_DIR = join(__dirname, 'reports');
const OUTPUT_DIR = join(__dirname, 'output');
const FONTS_DIR = join(__dirname, 'fonts');

const args = process.argv.slice(2);
const baseArg = args.find(a => a.startsWith('--base='));
const BASE_OUTPUT = baseArg
  ? join(__dirname, baseArg.split('=')[1])
  : join(__dirname, 'output', '2249-ironclad');

const BASE_HTML = join(BASE_OUTPUT, 'resume.html');

if (!existsSync(BASE_HTML)) {
  console.error(`Base HTML not found: ${BASE_HTML}`);
  process.exit(1);
}

const now = () => new Date().toISOString();
const log = (...a) => console.log(`[${now()}]`, ...a);

// ── Parse applications.md for target jobs ────────────────────────────────────
function parseTargetJobs() {
  const content = readFileSync(APPLICATIONS_FILE, 'utf-8');
  const lines = content.split('\n');
  const jobs = [];

  for (const line of lines) {
    if (!line.startsWith('| ') || !line.match(/^\| \d/)) continue;
    const cols = line.split('|').map(c => c.trim());
    // cols: ['', #, Date, Company, Role, Score, Status, PDF, Report, Notes, '']
    if (cols.length < 10) continue;
    const [, num, date, company, role, score, status, pdf, reportCol] = cols;
    if (status !== 'Evaluated') continue;

    const scoreVal = parseFloat(score);
    if (isNaN(scoreVal) || scoreVal < 3.5) continue;
    // Check both ❌ in tracker AND missing output dir on disk (batch workers
    // sometimes wrote ✅ in the TSV without actually generating the files)

    // Extract report path from markdown link [NNN](reports/...)
    const reportMatch = reportCol.match(/\(([^)]+\.md)\)/);
    if (!reportMatch) continue;
    const reportPath = join(__dirname, reportMatch[1]);

    // Derive output slug from report path: reports/2249-ironclad-2026-06-09.md → 2249-ironclad
    const reportFile = reportMatch[1].replace('reports/', '');
    const slugMatch = reportFile.match(/^(\d+)-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
    if (!slugMatch) continue;
    const reportNum = slugMatch[1];
    const slug = slugMatch[2];
    const outDir = join(OUTPUT_DIR, `${reportNum}-${slug}`);

    // Skip only if PDF actually exists on disk
    if (existsSync(join(outDir, 'resume.pdf'))) continue;

    jobs.push({ num, company, role, score, scoreVal, reportPath, reportNum, slug, outDir, line });
  }

  return jobs.sort((a, b) => b.scoreVal - a.scoreVal);
}

// ── All returned jobs are confirmed missing on disk ──────────────────────────
function categorize(jobs) {
  return { already: [], missing: jobs };
}

// ── Copy base HTML into output dir + symlink fonts ───────────────────────────
function prepOutputDir(outDir) {
  mkdirSync(outDir, { recursive: true });
  copyFileSync(BASE_HTML, join(outDir, 'resume.html'));

  // Symlink fonts dir so Playwright can find the fonts
  const fontsLink = join(outDir, 'fonts');
  if (!existsSync(fontsLink)) {
    spawnSync('ln', ['-sf', FONTS_DIR, fontsLink]);
  }
}

// ── Run generate-pdf.mjs via Playwright ──────────────────────────────────────
function renderPDF(outDir) {
  const htmlPath = join(outDir, 'resume.html');
  const pdfPath = join(outDir, 'resume.pdf');
  const result = spawnSync(
    'node',
    [join(__dirname, 'generate-pdf.mjs'), htmlPath, pdfPath, '--format=letter'],
    { cwd: __dirname, stdio: 'pipe', encoding: 'utf-8' }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'generate-pdf failed');
  }
  return pdfPath;
}

// ── Update applications.md: ensure PDF column is ✅ for given job rows ───────
function updateTracker(jobs) {
  let content = readFileSync(APPLICATIONS_FILE, 'utf-8');
  let updated = 0;

  for (const job of jobs) {
    // Replace ❌ or confirm ✅ — handles both phantom-✅ and genuine ❌ rows
    const updatedLine = job.line.replace(/\| [❌✅] \|/, '| ✅ |');
    if (updatedLine !== job.line) {
      content = content.replace(job.line, updatedLine);
      updated++;
    }
  }

  writeFileSync(APPLICATIONS_FILE, content);
  log(`Tracker updated: ${updated} rows flipped ❌ → ✅`);
  return updated;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  log('=== bulk-pdf-generate.mjs ===');
  log(`Base HTML: ${BASE_HTML}`);

  const allJobs = parseTargetJobs();
  log(`Found ${allJobs.length} Evaluated ≥3.5 with ❌ PDF`);

  const { already, missing } = categorize(allJobs);
  log(`Already have PDF on disk: ${already.length}`);
  log(`Truly missing (need render): ${missing.length}`);

  // Fix tracker for already-generated PDFs
  if (already.length > 0) {
    log(`\nFixing tracker for ${already.length} jobs with existing PDFs…`);
    updateTracker(already);
  }

  if (missing.length === 0) {
    log('Nothing left to render. Done.');
    process.exit(0);
  }

  // Render missing PDFs highest-score first
  log(`\nRendering ${missing.length} PDFs (score-descending)…`);
  const succeeded = [];
  const failed = [];

  for (let i = 0; i < missing.length; i++) {
    const job = missing[i];
    const prefix = `[${i + 1}/${missing.length}]`;
    log(`${prefix} ${job.company} — ${job.role} (${job.score})`);

    try {
      prepOutputDir(job.outDir);
      const pdfPath = renderPDF(job.outDir);
      log(`  ✅ → ${pdfPath.replace(__dirname + '/', '')}`);
      succeeded.push(job);
    } catch (err) {
      log(`  ❌ FAILED: ${err.message}`);
      failed.push({ job, error: err.message });
    }
  }

  // Update tracker for all successes
  if (succeeded.length > 0) {
    log(`\nUpdating tracker for ${succeeded.length} newly generated PDFs…`);
    updateTracker(succeeded);
  }

  // Summary
  log('\n=== SUMMARY ===');
  log(`Already had PDF (tracker fixed): ${already.length}`);
  log(`Newly rendered:                  ${succeeded.length}`);
  log(`Failed:                          ${failed.length}`);

  if (failed.length > 0) {
    log('\nFailed jobs:');
    for (const { job, error } of failed) {
      log(`  ${job.company} (${job.score}): ${error}`);
    }
  }

  log('=== Done ===');
})();
