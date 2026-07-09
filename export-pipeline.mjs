#!/usr/bin/env node
/**
 * export-pipeline.mjs — Export pipeline.md Processed section to CSV.
 *
 * Parses all date-section tables from data/pipeline.md and writes
 * data/pipeline-export.csv — opens natively in Excel/Numbers.
 *
 * Usage:
 *   node export-pipeline.mjs              → exports all processed rows
 *   node export-pipeline.mjs --today      → today's rows only
 *   node export-pipeline.mjs --days=7     → last N days
 *   node export-pipeline.mjs --min=3.5    → only scored rows ≥ threshold
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = path.join(__dirname, 'data', 'pipeline.md');
const OUTPUT_PATH   = path.join(__dirname, 'data', 'pipeline-export.csv');

// ── Argument parsing ──────────────────────────────────────────────────────────
const todayOnly = process.argv.includes('--today');
const daysArg   = process.argv.find(a => a.startsWith('--days='));
const minArg    = process.argv.find(a => a.startsWith('--min='));
const DAYS_BACK = daysArg ? parseInt(daysArg.split('=')[1], 10) : null;
const MIN_SCORE = minArg  ? parseFloat(minArg.split('=')[1])    : null;

const today = new Date().toISOString().slice(0, 10);

// ── Parse pipeline.md ─────────────────────────────────────────────────────────
if (!fs.existsSync(PIPELINE_PATH)) {
  console.error('data/pipeline.md not found.');
  process.exit(1);
}

const content = fs.readFileSync(PIPELINE_PATH, 'utf8');

// Find the ## Processed section
const processedStart = content.search(/^## Processed/m);
if (processedStart === -1) {
  console.error('No ## Processed section found in pipeline.md.');
  process.exit(0);
}
const processedSection = content.slice(processedStart);

// Match each ### YYYY-MM-DD subsection with its table rows
const dateBlockRe = /^### (\d{4}-\d{2}-\d{2})\n([\s\S]*?)(?=^### |\Z)/gm;
const rows = [];

let m;
while ((m = dateBlockRe.exec(processedSection)) !== null) {
  const date  = m[1];
  const block = m[2];

  // Date filter
  if (todayOnly && date !== today) continue;
  if (DAYS_BACK !== null) {
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - DAYS_BACK);
    if (new Date(date) < cutoff) continue;
  }

  // Parse table rows (skip header and separator lines)
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.startsWith('|---') || trimmed.startsWith('| #')) continue;

    const cols = trimmed.split('|').map(c => c.trim()).filter((_, i) => i > 0 && i < 9);
    if (cols.length < 7) continue;

    const [num, company, role, score, cv, cover, notes, urlCol] = cols;
    if (!company || company === 'Company') continue;

    // Extract URL from [link](URL) or plain URL
    const urlMatch = (urlCol || '').match(/\(([^)]+)\)/);
    const url = urlMatch ? urlMatch[1] : (urlCol || '').trim();

    // Determine row type
    let type;
    if (num === 'SKIP')           type = 'Skip (no sponsorship/fit)';
    else if (num === '!')         type = 'Duplicate / Expired';
    else if (/^\d+$/.test(num))  type = 'Evaluated';
    else                          type = 'Other';

    // Parse numeric score (e.g. "4.2/5" → 4.2, "—" → null)
    const scoreNum = score && score !== '—' ? parseFloat(score) : null;

    // Score filter
    if (MIN_SCORE !== null && (scoreNum === null || scoreNum < MIN_SCORE)) continue;

    rows.push({ date, num, type, company, role, score, scoreNum, cv, cover, notes, url });
  }
}

if (rows.length === 0) {
  console.log('No rows match the specified filters.');
  process.exit(0);
}

// Sort: date DESC, then score DESC (nulls last)
rows.sort((a, b) => {
  if (b.date !== a.date) return b.date.localeCompare(a.date);
  if (b.scoreNum !== a.scoreNum) {
    if (a.scoreNum === null) return 1;
    if (b.scoreNum === null) return -1;
    return b.scoreNum - a.scoreNum;
  }
  return 0;
});

// ── Write CSV ─────────────────────────────────────────────────────────────────
function csvCell(val) {
  const s = String(val ?? '').replace(/"/g, '""');
  return `"${s}"`;
}

const header = ['Date', 'Report #', 'Type', 'Company', 'Role', 'Score', 'CV', 'Cover Letter', 'Notes', 'URL'];
const lines  = [header.join(',')];

for (const r of rows) {
  lines.push([
    csvCell(r.date),
    csvCell(r.num),
    csvCell(r.type),
    csvCell(r.company),
    csvCell(r.role),
    csvCell(r.score),
    csvCell(r.cv  === '✅' ? 'Yes' : r.cv  === '❌' ? 'No' : r.cv  || ''),
    csvCell(r.cover === '✅' ? 'Yes' : r.cover === '❌' ? 'No' : r.cover || ''),
    csvCell(r.notes),
    csvCell(r.url),
  ].join(','));
}

fs.writeFileSync(OUTPUT_PATH, lines.join('\n'), 'utf8');

// ── Summary ───────────────────────────────────────────────────────────────────
const evaluated = rows.filter(r => r.type === 'Evaluated');
const high      = evaluated.filter(r => r.scoreNum >= 4.0);
const mid       = evaluated.filter(r => r.scoreNum >= 3.5 && r.scoreNum < 4.0);
const low       = evaluated.filter(r => r.scoreNum !== null && r.scoreNum < 3.5);

console.log(`\n✅ Exported ${rows.length} rows → data/pipeline-export.csv`);
console.log(`   Evaluated: ${evaluated.length} (${high.length} high ≥4.0 | ${mid.length} mid 3.5–3.9 | ${low.length} low <3.5)`);
console.log(`   Skipped:   ${rows.filter(r => r.type.startsWith('Skip')).length}`);
console.log(`   Other:     ${rows.filter(r => r.type === 'Duplicate / Expired').length} duplicates/expired`);
if (high.length > 0) {
  console.log('\n🎯 Top picks (score ≥ 4.0):');
  for (const r of high.sort((a, b) => b.scoreNum - a.scoreNum)) {
    console.log(`   [${r.score}] ${r.company} — ${r.role}`);
    console.log(`   ${r.url}`);
  }
}
console.log(`\n→ Open data/pipeline-export.csv in Excel/Numbers`);
