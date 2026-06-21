#!/usr/bin/env node
/**
 * generate-missing-pdfs.mjs
 *
 * Post-batch PDF backfill. Finds every report where:
 *   - **PDF:** claims a path  (batch worker said it would generate one)
 *   - The file doesn't actually exist on disk  (Haiku hallucinated the step)
 *   - The score meets the threshold (default 3.5, reads auto_pdf_score_threshold from profile.yml)
 *
 * For each qualifying report, spawns a focused `claude -p` worker whose only
 * job is to generate the tailored CV HTML and run generate-pdf.mjs.
 * Output goes to output/{reportNum}-{slug}/resume.pdf so smart-apply finds it.
 *
 * Usage:
 *   node generate-missing-pdfs.mjs                  # process all missing
 *   node generate-missing-pdfs.mjs --dry-run        # list only, no generation
 *   node generate-missing-pdfs.mjs --queue-only     # only Apply Queue (Evaluated) jobs
 *   node generate-missing-pdfs.mjs --num 903        # specific report number
 *   node generate-missing-pdfs.mjs --limit 5        # cap at N jobs
 *   node generate-missing-pdfs.mjs --min-score 4.0  # override threshold
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, openSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const CAREER_OPS   = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR  = join(CAREER_OPS, 'reports');
const OUTPUT_DIR   = join(CAREER_OPS, 'output');
const CV_FILE      = join(CAREER_OPS, 'cv.md');
const TEMPLATE     = join(CAREER_OPS, 'templates', 'cv-template.html');
const PROFILE_MD   = join(CAREER_OPS, 'modes', '_profile.md');
const PROFILE_YML  = join(CAREER_OPS, 'config', 'profile.yml');
const TRACKER_FILE = join(CAREER_OPS, 'data', 'applications.md');

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const QUEUE_ONLY   = args.includes('--queue-only');
const HTML_ONLY_PDF = args.includes('--html-only-pdf'); // Pass 1: Playwright-only (no Claude tokens)
const numIdx       = args.indexOf('--num');
const numArg       = numIdx >= 0 ? args[numIdx + 1] : null;
const limitIdx     = args.indexOf('--limit');
const limitArg     = limitIdx >= 0 ? args[limitIdx + 1] : null;
const scoreIdx     = args.indexOf('--min-score');
const scoreArg     = scoreIdx >= 0 ? args[scoreIdx + 1] : null;
const sinceIdx     = args.indexOf('--since');
const SINCE        = sinceIdx >= 0 ? args[sinceIdx + 1] : null; // YYYY-MM-DD cutoff
const LIMIT        = limitArg ? parseInt(limitArg) : Infinity;

// ─── Report numbers in Apply Queue (Evaluated + score >= threshold + optional date) ──
function applyQueueReportNums(threshold, since) {
  if (!existsSync(TRACKER_FILE)) return null;
  const nums = new Set();
  for (const line of readFileSync(TRACKER_FILE, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map(c => c.trim());
    const status = cols[6];
    if (status !== 'Evaluated') continue;
    const scoreVal = parseFloat(cols[5]);
    if (isNaN(scoreVal) || scoreVal < threshold) continue;
    // Date filter — cols[2] is the date column (YYYY-MM-DD)
    const dateStr = cols[2];
    if (since && dateStr && dateStr < since) continue;
    const m = cols[8]?.match(/\[(\d+)\]/);
    if (m) nums.add(m[1]);
  }
  return nums;
}

function readThreshold() {
  if (scoreArg) return parseFloat(scoreArg);
  try {
    const yml = readFileSync(PROFILE_YML, 'utf-8');
    const m = yml.match(/auto_pdf_score_threshold:\s*([0-9.]+)/);
    return m ? parseFloat(m[1]) : 3.5;
  } catch { return 3.5; }
}
const THRESHOLD = readThreshold();

// ─── Candidate output path for a report ───────────────────────────────────────
// smart-apply looks here: output/{reportNum}-{slug}/resume.pdf
function outputPdfPath(reportFile) {
  const m = reportFile.match(/^(\d+)-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  if (!m) return null;
  return join(OUTPUT_DIR, `${m[1]}-${m[2]}`, 'resume.pdf');
}

// ─── Parse score from report ──────────────────────────────────────────────────
function parseScore(text) {
  const m = text.match(/\*\*Score:\*\*\s*([0-9.]+)/i) ||
            text.match(/"score":\s*([0-9.]+)/);
  return m ? parseFloat(m[1]) : null;
}

// ─── Scan for missing PDFs ────────────────────────────────────────────────────
function findMissing() {
  if (!existsSync(REPORTS_DIR)) return [];
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort();
  const results = [];
  const queueNums = QUEUE_ONLY ? applyQueueReportNums(THRESHOLD, SINCE) : null;

  for (const file of files) {
    if (numArg && !file.startsWith(numArg + '-')) continue;
    if (queueNums) {
      const m = file.match(/^(\d+)-/);
      if (!m || !queueNums.has(m[1])) continue;
    }

    const outPath = outputPdfPath(file);
    if (!outPath) continue;
    if (existsSync(outPath)) continue; // PDF already exists — nothing to do

    const text = readFileSync(join(REPORTS_DIR, file), 'utf-8');

    // Check score threshold
    const score = parseScore(text);
    if (score === null || score < THRESHOLD) continue;

    // Extract company/role/URL for the prompt
    const urlM  = text.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/i);
    const coM   = text.match(/\*\*(?:Company|Empresa):\*\*\s*(.+)/i) ||
                  text.match(/# (?:Evaluación|Evaluation|Report): (.+?) —/i);
    const roleM = text.match(/\*\*(?:Role|Rol|Position):\*\*\s*(.+)/i) ||
                  text.match(/— (.+)$/m);

    const reportNum = file.match(/^(\d+)/)?.[1];
    const outDir    = join(OUTPUT_DIR, `${reportNum}-${file.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '')}`);
    const htmlPath  = join(outDir, 'cv-tailored.html');
    const hasHtml   = existsSync(htmlPath);

    // Pass 1 (--html-only-pdf): only process jobs where HTML already exists
    if (HTML_ONLY_PDF && !hasHtml) continue;

    results.push({
      file,
      reportPath: join(REPORTS_DIR, file),
      reportNum,
      outPath,
      htmlPath,
      hasHtml,
      score,
      url:     urlM?.[1]?.trim()  || '',
      company: coM?.[1]?.trim()   || file.replace(/^\d+-/, '').replace(/-\d{4}.*$/, ''),
      role:    roleM?.[1]?.trim() || 'Data Engineer',
      reportText: text,
    });

    if (results.length >= LIMIT) break;
  }

  // Sort by report date desc then score desc — matches dashboard display order
  results.sort((a, b) => {
    const dateA = a.file.match(/-(\d{4}-\d{2}-\d{2})\.md$/)?.[1] || '';
    const dateB = b.file.match(/-(\d{4}-\d{2}-\d{2})\.md$/)?.[1] || '';
    if (dateB !== dateA) return dateB.localeCompare(dateA);
    return (b.score || 0) - (a.score || 0);
  });

  return results;
}

// ─── Regenerate PDF from existing HTML (no Sonnet call needed) ───────────────
function regeneratePdfOnly(job) {
  return new Promise((resolve_) => {
    mkdirSync(dirname(job.outPath), { recursive: true });
    const child = spawn('node', [join(CAREER_OPS, 'generate-pdf.mjs'), job.htmlPath, job.outPath], {
      cwd: CAREER_OPS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', () => {
      resolve_({ success: existsSync(job.outPath), stdout: '', stderr: stderr.trim(), code: 0 });
    });
    child.on('error', err => {
      resolve_({ success: false, stdout: '', stderr: err.message, code: -1 });
    });
  });
}

// ─── Generate one PDF via focused claude -p worker ───────────────────────────
function generatePdf(job) {
  return new Promise((resolve_) => {
    const outDir = dirname(job.outPath);
    mkdirSync(outDir, { recursive: true });
    const htmlPath = join(outDir, 'cv-tailored.html');

    const prompt = `You are generating a tailored ATS-optimized CV for a job application. Complete ALL steps in order.

## Step 1 — Read these files NOW (before doing anything else)
- CV: ${CV_FILE}
- CV HTML template: ${TEMPLATE}
- Candidate profile/rules: ${PROFILE_MD}
- Evaluation report: ${job.reportPath}

## Step 2 — Extract from the evaluation report
- Company: ${job.company}
- Role: ${job.role}
- Top 5 required skills/keywords from the JD (look in Block A or B)
- Any gaps the report flagged (to address or omit)
- Archetype/framing recommended (look for archetype line in report)

## Step 3 — Generate the tailored HTML CV
Rules:
- Start from the HTML template exactly (cv-template.html). Do not invent a new layout.
- Reorder skills section to put the most JD-relevant skills first (within each category).
- In the Professional Summary, weave in the top 3 JD keywords naturally.
- For Innovaccer bullets, lead with the proof points most relevant to this role.
- Do NOT invent metrics, tools, or experience not in cv.md.
- Follow ALL formatting rules in modes/_profile.md (skills order, bullet counts per employer, education date format).

## Step 4 — Write the tailored HTML to this exact path
${htmlPath}

Write ONLY the complete HTML file. No explanation.

## Step 5 — Run this exact bash command to generate the PDF
\`\`\`
node ${join(CAREER_OPS, 'generate-pdf.mjs')} ${htmlPath} ${job.outPath}
\`\`\`

## Step 6 — Verify the PDF was created
Run: ls -lh "${job.outPath}"

If the file exists, print only: PDF_SUCCESS: ${job.outPath}
If it does not exist, print only: PDF_FAILED: ${job.outPath}`;

    const child = spawn('claude', ['-p', '--dangerously-skip-permissions', prompt], {
      cwd: CAREER_OPS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      const success = existsSync(job.outPath);
      resolve_({ success, stdout: stdout.trim(), stderr: stderr.trim(), code });
    });

    child.on('error', err => {
      resolve_({ success: false, stdout: '', stderr: err.message, code: -1 });
    });
  });
}

// ─── Update tracker PDF column ✅ ──────────────────────────────────────────────
function markTrackerPdfDone(reportNum) {
  if (!existsSync(TRACKER_FILE)) return;
  let changed = false;
  const lines = readFileSync(TRACKER_FILE, 'utf-8').split('\n').map(line => {
    if (!line.startsWith('|')) return line;
    const cols = line.split('|');
    // Report link column (index 8 in pipe-split) contains the report number
    const reportCol = cols[8]?.trim() || '';
    const numM = reportCol.match(/\[(\d+)\]/);
    if (!numM || numM[1] !== String(reportNum)) return line;
    // PDF column is index 7
    if (cols[7]?.trim() === '❌') {
      cols[7] = ' ✅ ';
      changed = true;
      return cols.join('|');
    }
    return line;
  });
  if (changed) writeFileSync(TRACKER_FILE, lines.join('\n'));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const missing = findMissing();

  if (missing.length === 0) {
    console.log('No missing PDFs found (all reports at or above threshold already have output PDFs).');
    process.exit(0);
  }

  console.log(`Found ${missing.length} report(s) needing PDF generation (threshold: ${THRESHOLD}/5):`);
  for (const j of missing) {
    console.log(`  #${j.reportNum} ${j.company} — ${j.role} (${j.score}/5) → ${j.outPath}`);
  }

  if (DRY_RUN) {
    console.log('\nDry run — no PDFs generated.');
    process.exit(0);
  }

  console.log('\nGenerating…\n');
  let passed = 0, failed = 0;

  for (const job of missing) {
    if (job.hasHtml) {
      // HTML already exists — skip Sonnet, just run Playwright directly
      process.stdout.write(`  #${job.reportNum} ${job.company} (PDF only — HTML exists)… `);
      const result = await regeneratePdfOnly(job);
      if (result.success) {
        console.log('✅');
        markTrackerPdfDone(job.reportNum);
        passed++;
      } else {
        console.log('❌');
        console.log(`    stderr: ${result.stderr?.slice(0, 200) || '(empty)'}`);
        failed++;
      }
    } else {
      process.stdout.write(`  #${job.reportNum} ${job.company}… `);
      const result = await generatePdf(job);
      if (result.success) {
        console.log('✅');
        markTrackerPdfDone(job.reportNum);
        passed++;
      } else {
        console.log('❌');
        console.log(`    stderr: ${result.stderr?.slice(0, 200) || '(empty)'}`);
        failed++;
      }
    }
  }

  console.log(`\nDone: ${passed} generated, ${failed} failed.`);
  process.exit(failed > 0 && passed === 0 ? 1 : 0);
})();
