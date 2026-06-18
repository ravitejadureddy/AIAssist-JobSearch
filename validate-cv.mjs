#!/usr/bin/env node
/**
 * validate-cv.mjs — Structural validator for generated resume HTML files.
 *
 * Checks:
 *   1. Skills section starts with "Languages:" or "Healthcare Data:"
 *   2. Bullet counts per employer (Innovaccer ≥6, Optum ≥4, Deloitte =2, Accenture =2)
 *   3. Education dates use full ranges ("Aug 2018 – Dec 2019"), not bare year
 *
 * Usage:
 *   node validate-cv.mjs                  → check all output/<slug>/resume.html
 *   node validate-cv.mjs 136-quanata-senior-de  → check one subfolder
 *   node validate-cv.mjs --fail-fast      → stop on first failure
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'output');

const COMPANY_RULES = {
  'Innovaccer': { min: 6, max: 7 },
  'Optum':      { min: 4, max: 5 },
  'Deloitte':   { min: 2, max: 2 },
  'Accenture':  { min: 2, max: 2 },
};

function validateHTML(filepath) {
  const html = fs.readFileSync(filepath, 'utf8');
  const errors = [];

  // ── 1. Skills section order ──────────────────────────────────────────────
  const skillsMatch = html.match(/class="skills-block">([\s\S]*?)<\/div>/);
  if (skillsMatch) {
    const firstStrong = skillsMatch[1].match(/<strong>(.*?)<\/strong>/);
    if (firstStrong) {
      const label = firstStrong[1].trim();
      if (!label.startsWith('Languages:') && !label.startsWith('Healthcare Data:')) {
        errors.push(`Skills: first label is "${label}" — must be "Languages:" or "Healthcare Data:"`);
      }
    } else {
      errors.push('Skills: no <strong> label found in skills-block');
    }
  }

  // ── 2. Bullet counts per employer ────────────────────────────────────────
  const jobParts = html.split('<div class="job">').slice(1);
  for (const part of jobParts) {
    const companyMatch = part.match(/class="job-company">(.*?)<\/span>/);
    if (!companyMatch) continue;
    const companyRaw = companyMatch[1].replace(/<[^>]+>/g, '').trim();

    const ruleName = Object.keys(COMPANY_RULES).find(c => companyRaw.includes(c));
    if (!ruleName) continue;

    const rule = COMPANY_RULES[ruleName];
    const ulMatch = part.match(/<ul>([\s\S]*?)<\/ul>/);
    if (!ulMatch) {
      errors.push(`${ruleName}: no bullet list found`);
      continue;
    }
    const count = (ulMatch[1].match(/<li>/g) || []).length;
    if (count < rule.min) {
      errors.push(`${ruleName}: ${count} bullet${count === 1 ? '' : 's'} (minimum ${rule.min})`);
    } else if (count > rule.max) {
      errors.push(`${ruleName}: ${count} bullets (maximum ${rule.max})`);
    }
  }

  // ── 3. Education date format ─────────────────────────────────────────────
  const eduMatches = [...html.matchAll(/class="edu-year">(.*?)<\/span>/g)];
  for (const m of eduMatches) {
    const raw = m[1].trim();
    const clean = raw.replace(/&[a-z]+;/g, ' ').replace(/<[^>]+>/g, '').trim();
    if (/^\d{4}$/.test(clean)) {
      errors.push(`Education: "${raw}" is year-only — needs "Month Year – Month Year" format`);
    }
  }

  return errors;
}

function findResumeFiles() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'archive')
    .map(d => path.join(OUTPUT_DIR, d.name, 'resume.html'))
    .filter(f => fs.existsSync(f));
}

// ── Argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const failFast = flags.includes('--fail-fast');

let files;
if (args.length > 0) {
  files = args.map(a => {
    const resolved = path.isAbsolute(a) ? a : path.join(OUTPUT_DIR, a, 'resume.html');
    return resolved;
  });
} else {
  files = findResumeFiles();
}

if (files.length === 0) {
  console.log('No resume.html files found in output/*/');
  process.exit(0);
}

// ── Run validation ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let totalIssues = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`⚠️  Not found: ${file}`);
    continue;
  }

  const slug = path.basename(path.dirname(file));
  const errors = validateHTML(file);

  if (errors.length === 0) {
    console.log(`✅  ${slug}`);
    passed++;
  } else {
    console.log(`❌  ${slug}`);
    for (const err of errors) {
      console.log(`    • ${err}`);
    }
    failed++;
    totalIssues += errors.length;
    if (failFast) break;
  }
}

const total = passed + failed;
console.log(`\n${total} CV${total === 1 ? '' : 's'} checked — ${passed} passed, ${failed} failed (${totalIssues} issue${totalIssues === 1 ? '' : 's'})`);

if (failed > 0) process.exit(1);
