#!/usr/bin/env node
/**
 * validate-resume.mjs — semantic validation of a tailored resume against cv.md + JD.
 *
 * Standalone draft. NOT yet wired into the framework.
 *
 * Inputs (resolved from a single report num or output folder):
 *   - cv.md                        — source of truth, every claim must trace here
 *   - output/{num}-{slug}/cv-content.json (preferred) | cv-tailored.html (fallback)
 *   - reports/{num}-{slug}-{date}.md — the JD context
 *
 * Output: output/{num}-{slug}/validation.json
 *   { score, valid, axes:{jd_alignment, source_fidelity, best_extraction, natural_voice, technical_coherence},
 *     issues:[...], validated_at, model, inputs:{...} }
 *
 * Strict thresholds for valid=true:
 *   - jd_alignment >= 80
 *   - source_fidelity === 100  (any fabrication = auto-fail)
 *   - best_extraction >= 75
 *   - natural_voice >= 80
 *   - technical_coherence === 100  (any implausibility = auto-fail)
 *
 * CLI:
 *   node validate-resume.mjs <num|folder>           — validate one
 *   node validate-resume.mjs --dry-run <num|folder> — validate, print result, don't write
 *   node validate-resume.mjs --model <id> <target>  — override model (default: claude-haiku-4-5)
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = __dirname;
const CV_FILE = join(CAREER_OPS, 'cv.md');
const OUTPUT_DIR = join(CAREER_OPS, 'output');
const REPORTS_DIR = join(CAREER_OPS, 'reports');
const DEFAULT_MODEL = 'claude-haiku-4-5';
const CLAUDE_BIN = '/usr/local/bin/claude';

// ── Argument parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { dryRun: false, model: DEFAULT_MODEL, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--model') args.model = argv[++i];
    else if (!args.target) args.target = a;
  }
  return args;
}

// ── Locate inputs from a report num or folder ────────────────────────────────
function resolveOutputFolder(target) {
  if (existsSync(target) && statSync(target).isDirectory()) return resolve(target);
  // Numeric — find matching subfolder under output/
  const m = String(target).match(/^(\d+)$/);
  if (m) {
    const num = m[1];
    const match = readdirSync(OUTPUT_DIR).find(d => d.startsWith(`${num}-`));
    if (match) return join(OUTPUT_DIR, match);
  }
  // Subfolder name like "13548-ntt-data-services"
  const direct = join(OUTPUT_DIR, target);
  if (existsSync(direct)) return direct;
  throw new Error(`Cannot resolve output folder for: ${target}`);
}

function findReport(num) {
  const matches = readdirSync(REPORTS_DIR).filter(f => f.startsWith(`${num}-`) && f.endsWith('.md'));
  if (matches.length === 0) return null;
  // Prefer the most recent one if multiple dates
  matches.sort();
  return join(REPORTS_DIR, matches[matches.length - 1]);
}

// ── Read tailored content (prefer JSON, fallback to HTML strip) ──────────────
function loadTailoredContent(folder) {
  const jsonPath = join(folder, 'cv-content.json');
  if (existsSync(jsonPath)) {
    return { kind: 'json', text: readFileSync(jsonPath, 'utf-8'), path: jsonPath };
  }
  const htmlPath = join(folder, 'cv-tailored.html');
  if (existsSync(htmlPath)) {
    const html = readFileSync(htmlPath, 'utf-8');
    // Naive HTML strip — good enough for an LLM reader
    const text = html.replace(/<style[\s\S]*?<\/style>/gi, '')
                     .replace(/<script[\s\S]*?<\/script>/gi, '')
                     .replace(/<[^>]+>/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim();
    return { kind: 'html-stripped', text, path: htmlPath };
  }
  return null;
}

// ── Idempotency: skip if validation.json is newer than the tailored content ──
function isAlreadyValid(folder, contentPath) {
  const valPath = join(folder, 'validation.json');
  if (!existsSync(valPath)) return false;
  try {
    const vStat = statSync(valPath);
    const cStat = statSync(contentPath);
    return vStat.mtimeMs >= cStat.mtimeMs;
  } catch { return false; }
}

// ── Build the validation prompt ──────────────────────────────────────────────
function buildPrompt({ cv, tailored, report }) {
  return `You are a strict resume reviewer. Score the TAILORED RESUME against the candidate's CV (source of truth) and the JOB DESCRIPTION. Return ONLY a JSON object, no prose.

Five axes, each 0-100:

1. jd_alignment — Does the tailored resume surface what the JD asks for (must-haves: skills, years, domain, scope)? 80+ if all must-haves are addressed.

2. source_fidelity — Every claim in the tailored resume must trace back to the CV. ANY fabrication, exaggeration, or detail not in the CV = 0. Set 100 only if zero fabrication.

3. best_extraction — Did the writer pick the strongest proof points available in the CV for this JD? If the CV contains a clearly stronger bullet/project that wasn't used, drop below 75. If the strongest evidence was used, 90+.

4. natural_voice — Reads like a human wrote it (not keyword-stuffed, not robotic, not corporate buzzword soup). "Spearheaded synergistic cross-functional initiatives to drive holistic outcomes" = below 60. Clear active verbs + concrete results = 90+.

5. technical_coherence — Tech stacks, tool combinations, claimed scope/title, and timelines must be physically and professionally plausible. "Spark on AWS Lambda", "DynamoDB for ACID workloads", "Director leading 200 engineers with 4 YOE", or anachronisms (using a 2024 tool in 2018) = 0. Set 100 only if everything checks out.

Strict overall valid=true ONLY IF:
  jd_alignment >= 80
  source_fidelity === 100
  best_extraction >= 75
  natural_voice >= 80
  technical_coherence === 100

Output JSON shape (return EXACTLY this, no prose, no markdown fences):
{
  "axes": {
    "jd_alignment": <0-100>,
    "source_fidelity": <0-100>,
    "best_extraction": <0-100>,
    "natural_voice": <0-100>,
    "technical_coherence": <0-100>
  },
  "score": <weighted overall 0-100, average of the 5 axes>,
  "valid": <true|false per strict rule above>,
  "issues": ["specific concrete issue 1", "..."]
}

Keep issues short (one line each), specific (cite the bullet or phrase), and actionable.

=== CV (source of truth) ===
${cv}

=== TAILORED RESUME (${tailored.kind}) ===
${tailored.text}

=== JOB DESCRIPTION + EVALUATION REPORT ===
${report}
`;
}

// ── Call claude -p ───────────────────────────────────────────────────────────
function callClaude(prompt, model) {
  return new Promise((resolve_, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', '--model', model, '--dangerously-skip-permissions', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(-400)}`));
      resolve_(stdout.trim());
    });
    child.on('error', reject);
  });
}

// ── Extract JSON from claude's stdout (it may include extra prose) ────────────
function extractJson(raw) {
  // Try fenced ```json block first
  const fence = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) return JSON.parse(fence[1]);
  // Find first { and last } and try to parse
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`No JSON found in response:\n${raw.slice(0, 500)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function validateOne(target, { dryRun, model }) {
  const folder = resolveOutputFolder(target);
  const folderName = basename(folder);
  const numMatch = folderName.match(/^(\d+)-/);
  if (!numMatch) throw new Error(`Folder name does not start with a report num: ${folderName}`);
  const num = numMatch[1];

  // Inputs
  if (!existsSync(CV_FILE)) throw new Error(`cv.md not found at ${CV_FILE}`);
  const cv = readFileSync(CV_FILE, 'utf-8');

  const tailored = loadTailoredContent(folder);
  if (!tailored) throw new Error(`No cv-content.json or cv-tailored.html in ${folder} — only resume.pdf likely; validator needs the source content`);

  const reportPath = findReport(num);
  if (!reportPath) throw new Error(`No report found in reports/ for num=${num}`);
  const report = readFileSync(reportPath, 'utf-8');

  // Idempotency
  if (!dryRun && isAlreadyValid(folder, tailored.path)) {
    console.log(`[skip] ${folderName}: validation.json already up-to-date`);
    return JSON.parse(readFileSync(join(folder, 'validation.json'), 'utf-8'));
  }

  // Prompt + LLM call
  const prompt = buildPrompt({ cv, tailored, report });
  console.log(`[run] ${folderName}: calling ${model} (~${Math.round(prompt.length / 4)} input tokens)`);
  const t0 = Date.now();
  const raw = await callClaude(prompt, model);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  let parsed;
  try { parsed = extractJson(raw); }
  catch (e) {
    console.error(`[fail] ${folderName}: could not parse JSON response (${elapsed}s)`);
    console.error(raw.slice(0, 800));
    throw e;
  }

  const result = {
    ...parsed,
    validated_at: new Date().toISOString(),
    model,
    elapsed_s: parseFloat(elapsed),
    inputs: {
      cv: 'cv.md',
      tailored: tailored.path.replace(CAREER_OPS + '/', ''),
      report: reportPath.replace(CAREER_OPS + '/', ''),
      tailored_kind: tailored.kind,
    },
  };

  if (dryRun) {
    console.log(`[dry-run] ${folderName} (${elapsed}s):`);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const outPath = join(folder, 'validation.json');
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`[done] ${folderName} (${elapsed}s) → ${result.valid ? '✓' : '✗'} score=${result.score}`);
  }
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (!args.target) {
  console.error('Usage: node validate-resume.mjs [--dry-run] [--model <id>] <num|folder>');
  process.exit(1);
}

validateOne(args.target, args).catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
