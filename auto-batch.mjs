#!/usr/bin/env node
/**
 * auto-batch.mjs
 *
 * Fully automated batch continuation:
 *   1. Sync pipeline.md pending items → batch-input.tsv (new items only)
 *   2. Reset retry counters for rate-limit-failed jobs
 *   3. Playwright pre-fetch for JS-blocked domains (Workday, Taleo, Dayforce, etc.)
 *   4. Run batch-runner.sh (--retry-failed --parallel 3)
 *   5. Merge tracker additions → applications.md
 *   6. Mark processed pipeline items as done (- [x])
 *
 * Called by:
 *   - launchd com.careerops.batch at 4:35am CST daily (after session limit resets)
 *   - launchd com.careerops.scan at 6pm CST (chained after scan, so same-day jobs start processing)
 *   - Manually: node auto-batch.mjs
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, unlinkSync, openSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const BATCH_DIR = join(PROJECT_DIR, 'batch');
const INPUT_FILE = join(BATCH_DIR, 'batch-input.tsv');
const STATE_FILE = join(BATCH_DIR, 'batch-state.tsv');
const PIPELINE_FILE = join(PROJECT_DIR, 'data', 'pipeline.md');
const LOG_DIR = join(BATCH_DIR, 'logs');
const LOCK_FILE = join(BATCH_DIR, 'batch-runner.pid');
const STATE_LOCK = join(BATCH_DIR, '.batch-state.lock');
const RATE_LIMIT_HINT = join(BATCH_DIR, '.rate-limit-hint');
const RETRY_PLIST = join(process.env.HOME, 'Library/LaunchAgents/com.careerops.batch-retry.plist');
const H1B_CACHE_FILE = join(PROJECT_DIR, 'data', 'h1b-cache.tsv');
const GATE1_RESULTS = join(BATCH_DIR, 'gate1-results.tsv');
const FILTER_LOG = join(LOG_DIR, `filtered-${new Date().toISOString().slice(0, 10)}.log`);

mkdirSync(LOG_DIR, { recursive: true });

const now = () => new Date().toISOString();
const log = (...args) => console.log(`[${now()}]`, ...args);

// ── Step 0: Clear stale locks from crashed prior runs ───────────────────────
function clearLocks() {
  try { if (existsSync(LOCK_FILE)) { import('fs').then(m => m.unlinkSync(LOCK_FILE)); } } catch {}
  try {
    if (existsSync(STATE_LOCK)) {
      spawnSync('rmdir', [STATE_LOCK]);
    }
  } catch {}
}

// ── Step 1: Sync pipeline.md → batch-input.tsv ──────────────────────────────
function syncPipeline() {
  if (!existsSync(PIPELINE_FILE)) {
    log('pipeline.md not found — skipping sync');
    return 0;
  }

  // Load existing URLs in batch-input.tsv
  const existingUrls = new Set();
  let maxId = 0;
  if (existsSync(INPUT_FILE)) {
    const lines = readFileSync(INPUT_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 2 && parts[0] !== 'id' && parts[0] !== '') {
        const id = parseInt(parts[0], 10);
        if (!isNaN(id)) maxId = Math.max(maxId, id);
        if (parts[1]) existingUrls.add(parts[1].trim());
      }
    }
  }

  // Parse pipeline.md for pending (- [ ]) items not already in input
  const newItems = [];
  const pipelineLines = readFileSync(PIPELINE_FILE, 'utf-8').split('\n');
  for (const line of pipelineLines) {
    if (!line.startsWith('- [ ] ')) continue;
    const rest = line.slice(6).trim();
    const parts = rest.split(' | ');
    const url = parts[0]?.trim();
    if (!url || existingUrls.has(url)) continue;
    const company = parts[1]?.trim() ?? '';
    const role    = parts[2]?.trim() ?? '';
    const source  = parts[3]?.trim() ?? 'manual';
    newItems.push({ url, source, notes: `${company} - ${role}` });
  }

  if (newItems.length === 0) {
    log(`pipeline sync: no new items (${existingUrls.size} already tracked)`);
    return 0;
  }

  const needsHeader = !existsSync(INPUT_FILE) || maxId === 0;
  let rows = needsHeader ? 'id\turl\tsource\tnotes\n' : '';
  newItems.forEach((item, i) => {
    rows += `${maxId + 1 + i}\t${item.url}\t${item.source}\t${item.notes}\n`;
  });
  appendFileSync(INPUT_FILE, rows);
  log(`pipeline sync: added ${newItems.length} new items (IDs ${maxId + 1}–${maxId + newItems.length})`);
  return newItems.length;
}

// ── Step 2: Reset rate-limit failures ────────────────────────────────────────
function resetRateLimitFailures() {
  if (!existsSync(STATE_FILE)) {
    log('no state file — nothing to reset');
    return 0;
  }

  const lines = readFileSync(STATE_FILE, 'utf-8').split('\n');
  let reset = 0;
  const out = lines.map(line => {
    const parts = line.split('\t');
    // cols: id, url, status, started, completed, report_num, score, error, retries
    if (parts.length >= 9 && (parts[2] === 'failed' || parts[2] === 'rate_limited')) {
      const error = (parts[7] ?? '').toLowerCase();
      if (parts[2] === 'rate_limited' || error.includes('rate') || error.includes('session')) {
        parts[2] = 'failed'; // flip back to failed so batch-runner --retry-failed picks it up
        parts[8] = '0';      // reset retries
        reset++;
      }
    }
    return parts.join('\t');
  });
  writeFileSync(STATE_FILE, out.join('\n'));
  log(`rate-limit reset: cleared retry counters for ${reset} jobs`);
  return reset;
}

// ── Step 3: Check if there's anything to process ─────────────────────────────
function hasPending() {
  if (!existsSync(INPUT_FILE)) return false;
  if (!existsSync(STATE_FILE)) return true; // input exists but no state → all pending

  const stateMap = new Map();
  readFileSync(STATE_FILE, 'utf-8').split('\n').forEach(line => {
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[0] !== 'id') stateMap.set(parts[0], parts[2]);
  });

  const inputLines = readFileSync(INPUT_FILE, 'utf-8').split('\n');
  for (const line of inputLines) {
    const parts = line.split('\t');
    if (parts.length < 2 || parts[0] === 'id') continue;
    const status = stateMap.get(parts[0]);
    if (!status || status === 'pending' || status === 'failed' || status === 'rate_limited') return true;
  }
  return false;
}

// ── Step 3b: Playwright pre-fetch for JS-blocked domains ─────────────────────
function playwrightPrefetch() {
  log('playwright-prefetch: fetching JS-blocked job pages …');
  const result = spawnSync(
    'node',
    ['playwright-prefetch.mjs'],
    { cwd: PROJECT_DIR, stdio: 'inherit' }
  );
  if (result.error) log('playwright-prefetch error:', result.error.message);
}

// ── Step 3b: Sync resolved LinkedIn URLs back into batch-input + batch-state ─
// playwright-prefetch resolves LinkedIn → ATS URL but only writes to pipeline.md
// and /tmp/batch-jd-{id}.txt. batch-input.tsv / batch-state.tsv still have the
// original LinkedIn URLs, which then end up in evaluation reports. Sync them.
function syncResolvedUrlsToBatchState() {
  if (!existsSync(INPUT_FILE)) return;
  const resolvedMap = new Map();

  for (const line of readFileSync(INPUT_FILE, 'utf-8').split('\n')) {
    const parts = line.split('\t');
    if (!parts[0] || parts[0] === 'id' || !parts[1]) continue;
    const id = parts[0].trim();
    const url = parts[1].trim();
    if (!url.includes('linkedin.com')) continue;
    const tmpFile = `/tmp/batch-jd-${id}.txt`;
    if (!existsSync(tmpFile)) continue;
    try {
      const content = readFileSync(tmpFile, 'utf-8');
      const m = content.match(/^RESOLVED_APPLY_URL:\s*(.+)$/m);
      if (!m) continue;
      const resolvedUrl = m[1].trim();
      if (resolvedUrl && resolvedUrl !== url) resolvedMap.set(id, resolvedUrl);
    } catch {}
  }

  if (resolvedMap.size === 0) {
    log('syncResolvedUrls: no LinkedIn URLs resolved');
    return;
  }
  log(`syncResolvedUrls: rewriting ${resolvedMap.size} URLs in batch-input.tsv${existsSync(STATE_FILE) ? ' + batch-state.tsv' : ''}`);

  const inputUpdated = readFileSync(INPUT_FILE, 'utf-8').split('\n').map(line => {
    const parts = line.split('\t');
    if (!parts[0] || parts[0] === 'id') return line;
    const id = parts[0].trim();
    if (resolvedMap.has(id)) { parts[1] = resolvedMap.get(id); return parts.join('\t'); }
    return line;
  }).join('\n');
  writeFileSync(INPUT_FILE, inputUpdated);

  if (!existsSync(STATE_FILE)) return;
  const stateUpdated = readFileSync(STATE_FILE, 'utf-8').split('\n').map(line => {
    const parts = line.split('\t');
    if (!parts[0] || parts[0] === 'id') return line;
    const id = parts[0].trim();
    if (resolvedMap.has(id)) { parts[1] = resolvedMap.get(id); return parts.join('\t'); }
    return line;
  }).join('\n');
  writeFileSync(STATE_FILE, stateUpdated);
}

// ── Step 5c: Resolve LinkedIn URLs in already-generated reports ──────────────
// Pure Playwright — no Claude tokens. Safe to run after batch even if token
// budget is exhausted.
function resolveLinkedInReports() {
  log('resolving LinkedIn URLs in Apply Queue reports (post-batch) …');
  const result = spawnSync('node', ['resolve-linkedin-urls.mjs', '--limit', '50'], {
    cwd: PROJECT_DIR, stdio: 'inherit', timeout: 8 * 60 * 1000,
  });
  if (result.error) log('resolve-linkedin-urls error:', result.error.message);
}

// ── Step 4: Run batch-runner.sh ──────────────────────────────────────────────
function runBatch() {
  log('launching batch-runner.sh …');
  const result = spawnSync(
    'bash',
    [
      join(BATCH_DIR, 'batch-runner.sh'),
      '--parallel', '3',
      '--max-retries', '3',
      '--model', 'claude-haiku-4-5-20251001',
    ],
    { cwd: PROJECT_DIR, stdio: 'inherit' }
  );
  if (result.error) log('batch-runner error:', result.error.message);
  log(`batch-runner exited with code ${result.status}`);
}

// ── Step 5b: Backfill PDFs missed by Haiku batch workers ─────────────────────
function verifyPipeline() {
  log('verifying pipeline integrity …');
  const result = spawnSync('node', ['verify-pipeline.mjs'], {
    cwd: PROJECT_DIR, stdio: 'inherit',
  });
  if (result.error) log('verify-pipeline error:', result.error.message);
}

function dedupTracker() {
  log('deduplicating tracker …');
  const result = spawnSync('node', ['dedup-tracker.mjs'], {
    cwd: PROJECT_DIR, stdio: 'inherit',
  });
  if (result.error) log('dedup-tracker error:', result.error.message);
}

// ── Step 5b: Schedule Apply-Queue PDF backfill (detached) ────────────────────
// Runs AFTER this process exits so it is never nested inside a claude -p session.
// generate-missing-pdfs.mjs spawns its own claude -p workers; nesting two levels
// of claude -p causes all but the first worker to fail silently. Detaching avoids
// that entirely — the child inherits no session context from the parent.
function scheduleQueuePdfs() {
  log('scheduling Apply Queue PDF backfill (detached) …');
  const logFile = join(PROJECT_DIR, 'logs', 'pdf-queue.log');
  mkdirSync(join(PROJECT_DIR, 'logs'), { recursive: true });
  const out = openSync(logFile, 'a');
  const child = spawn('node', ['generate-missing-pdfs.mjs', '--queue-only'], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  log(`PDF backfill detached (pid ${child.pid}), logging to logs/pdf-queue.log`);
}

// ── Step 5: Merge tracker additions ──────────────────────────────────────────
function mergeTracker() {
  log('merging tracker additions …');
  const result = spawnSync('node', ['merge-tracker.mjs'], {
    cwd: PROJECT_DIR, stdio: 'inherit',
  });
  if (result.error) log('merge-tracker error:', result.error.message);
}

// ── Step 6: Mark processed pipeline items as done ────────────────────────────
function markPipelineDone() {
  if (!existsSync(STATE_FILE) || !existsSync(PIPELINE_FILE)) return;

  const processedUrls = new Set();
  readFileSync(STATE_FILE, 'utf-8').split('\n').forEach(line => {
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[0] !== 'id' && parts[1]) {
      processedUrls.add(parts[1].trim());
    }
  });

  let updated = 0;
  const lines = readFileSync(PIPELINE_FILE, 'utf-8').split('\n').map(line => {
    if (!line.startsWith('- [ ] ')) return line;
    const url = line.slice(6).split(' | ')[0].trim();
    if (processedUrls.has(url)) { updated++; return '- [x] ' + line.slice(6); }
    return line;
  });
  writeFileSync(PIPELINE_FILE, lines.join('\n'));
  log(`pipeline.md: marked ${updated} items done`);
}

// ── Gate 1: H1B + keyword filter ─────────────────────────────────────────────

// Canonical name aliases — maps job-portal names to h1bdata.info registered names.
// Keyed by lowercase company name from pipeline notes.
const COMPANY_ALIASES = {
  'pwc':                              'PricewaterhouseCoopers',
  'pricewaterhousecoopers':           'PricewaterhouseCoopers',
  'bristol myers squibb':             'Bristol-Myers Squibb',
  'block labs':                       'Block Inc',
  'globalpoint':                      'GlobalPoint Inc',
  'fanatics betting & gaming':        'Fanatics',
  'dat freight & analytics':          'DAT Solutions',
  'cursor':                           'Anysphere Inc',
  'doma technology llc':              'Doma',
  'doma technology':                  'Doma',
  'healthpartners':                   'Health Partners',
  'w talent (financial services)':    'Phaidon International',
  'selby jennings / tier-1 tradi':    'Phaidon International',
  'alignerr':                         'Labelbox',
  'cerecore':                         'HCA Healthcare',
  'appgate':                          'Cyxtera Technologies',
  'appgate cybersecurity':            'Cyxtera Technologies',
  'garan, incorporated':              'Garan Inc',
  'turing it labs':                   'Turing IT',
  "people's group":                   "People's",
};

// Known foreign companies (no US H-1B filing → always filter)
const FOREIGN_COMPANY_NAMES = new Set([
  'oxio corporation', 'rezdy', 'jobgether', 'intellias', 'qa ltd',
  'sumup', 'epiroc', 'lightspeed', 'caa club group',
]);

// Named cap-exempt employers not caught by pattern matching
const CAP_EXEMPT_NAMED = new Set([
  'aclu', 'american civil liberties union',
  'the nature conservancy',
  'ut md anderson',
  "st. luke's health system",
]);

// Anonymous / undisclosed employer patterns
const ANONYMOUS_EMPLOYER_PATTERNS = [
  /^(global|proprietary|anonymous|undisclosed)\s+(asset manager|trading firm|employer|company|fund)$/i,
  /^chatgpt jobs$/i,
  /not (disclosed|named)$/i,
];

function detectForeignOrAnonymous(company) {
  const lower = company.toLowerCase().trim();
  if (FOREIGN_COMPANY_NAMES.has(lower)) return `foreign: ${company}`;
  if (ANONYMOUS_EMPLOYER_PATTERNS.some(p => p.test(lower))) return `anonymous: ${company}`;
  return null;
}

function detectCapExemptNamed(company) {
  return CAP_EXEMPT_NAMED.has(company.toLowerCase().trim());
}

// Strip safe legal suffixes and parenthetical abbreviations.
// Only removes tokens that are unambiguous — does NOT strip "Group", "Technologies", etc.
function safeNormalize(name) {
  let n = name;
  n = n.replace(/\s*\([^)]{1,10}\)$/, '').trim();
  n = n.replace(/,?\s+(Inc\.?|LLC\.?|Ltd\.?|Corp\.?|Corporation|L\.?P\.?|L\.?L\.?C\.?|Incorporated|Limited|Co\.)$/i, '').trim();
  n = n.replace(/\.$/, '').trim();
  return n;
}

// Suffix variants tried in order when a company returns 0 LCAs.
// The empty string (bare name) is tried first, then common suffixes.
const SUFFIX_VARIANTS = [
  '', ' Inc', ' Inc.', ' LLC', ' Ltd', ' Corp', ' Corporation',
  ' Technologies', ' Technology', ' Solutions', ' Systems', ' Group',
  ' Software', ' Services', ' Consulting',
];

async function trySuffixExpansion(baseName) {
  for (const suffix of SUFFIX_VARIANTS) {
    const candidate = (baseName + suffix).trim();
    const count = await fetchLcaCount(candidate);
    if (count > 0) return { count, foundAs: candidate };
  }
  return { count: 0, foundAs: null };
}

// Sponsorship-rejection patterns apply only if the user actually needs sponsorship;
// clearance-rejection patterns apply for everyone (rare for adopters to hold clearance).
// Driven by visa_status in config/profile.yml; safe-default is "needs sponsorship".
const PROFILE_YML = join(PROJECT_DIR, 'config', 'profile.yml');
function userNeedsSponsorship() {
  if (!existsSync(PROFILE_YML)) return true;
  const m = readFileSync(PROFILE_YML, 'utf-8').match(/visa_status\s*:\s*['"]?([^'"\n]+)['"]?/);
  if (!m) return true;
  return !/no sponsorship needed|us citizen|green card|permanent resident/.test(m[1].toLowerCase());
}
const SPONSORSHIP_REJECT = [
  'no visa sponsorship', 'will not sponsor', 'unable to sponsor', 'cannot sponsor',
  'sponsorship not available', 'us citizens only', 'us citizen only',
  'must be a us citizen', 'must be authorized to work without sponsorship',
  'must not require sponsorship', 'not require sponsorship now or in the future',
  'green card required', 'permanent resident required',
  'must be a permanent resident', 'no sponsorship',
];
const CLEARANCE_REJECT = [
  'security clearance required', 'active security clearance', 'secret clearance',
  'top secret clearance',
];
const HARD_REJECT_KEYWORDS = [
  ...(userNeedsSponsorship() ? SPONSORSHIP_REJECT : []),
  ...CLEARANCE_REJECT,
];

const JS_BLOCKED_DOMAINS = [
  'myworkdayjobs.com', 'taleo.net', 'dayforcehcm.com', 'oraclecloud.com',
  'icims.com', 'adp.com', 'myjobs.adp.com', 'workforcenow.adp.com',
  'paycomonline.net', 'zohorecruit.com', 'breezy.hr', 'smbcgroup.com',
  'searchjobs.libertymutualgroup.com',
];

function isJsBlocked(url) {
  return JS_BLOCKED_DOMAINS.some(d => url.includes(d));
}

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

function isFresh(lastChecked) {
  if (!lastChecked) return false;
  return (Date.now() - new Date(lastChecked).getTime()) < 30 * 24 * 60 * 60 * 1000;
}

function readH1bCache() {
  const cache = new Map();
  if (!existsSync(H1B_CACHE_FILE)) return cache;
  for (const line of readFileSync(H1B_CACHE_FILE, 'utf-8').split('\n')) {
    const p = line.split('\t');
    if (p.length < 8 || p[0] === 'company_slug' || !p[0]) continue;
    cache.set(p[0].trim(), {
      total_lca: parseInt(p[5]) || 0,
      label: p[6]?.trim() || '',
      last_checked: p[7]?.trim() || '',
    });
  }
  return cache;
}

function updateH1bCache(slug, displayName, lcaCount) {
  const today = new Date().toISOString().slice(0, 10);
  const label = lcaCount >= 100 ? 'Confirmed' : lcaCount >= 10 ? 'Likely' : lcaCount > 0 ? 'Limited' : 'Not Found';
  appendFileSync(H1B_CACHE_FILE, `${slug}\t${displayName}\t\t${lcaCount}\t\t${lcaCount}\t${label}\t${today}\th1bdata.info\n`);
}

async function fetchLcaCount(companyName) {
  const encoded = companyName.toLowerCase().replace(/\s+/g, '+');
  let total = 0;
  for (const year of ['2025', '2024']) {
    try {
      const res = await fetch(
        `https://h1bdata.info/index.php?em=${encoded}&job=&city=&year=${year}`,
        { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) continue;
      const html = await res.text();
      const tbody = html.match(/<tbody[\s\S]*?<\/tbody>/i)?.[0] || '';
      total += (tbody.match(/<tr/gi) || []).length;
    } catch { /* network error — skip year */ }
  }
  return total;
}

async function fetchJd(url, id) {
  const tmpFile = `/tmp/batch-jd-${id}.txt`;
  if (existsSync(tmpFile)) return readFileSync(tmpFile, 'utf-8');
  if (isJsBlocked(url)) return null; // playwright-prefetch.mjs handles these
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (!res.ok) return null;
    const text = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 200) { writeFileSync(tmpFile, text); return text; }
  } catch { /* fetch failed — pass through to Phase 1 */ }
  return null;
}

function detectHardReject(jdText) {
  if (!jdText) return null;
  const lower = jdText.toLowerCase();
  return HARD_REJECT_KEYWORDS.find(kw => lower.includes(kw)) || null;
}

// Cap-exempt employer detection — universities, government, non-profits
// These cannot sponsor cap-subject H-1B transfers
const CAP_EXEMPT_NAME_PATTERNS = [
  /\buniversity\b/i, /\bcollege\b/i, /\bcommunity college\b/i,
  /\bschool district\b/i, /\bpublic school\b/i,
  /\bcity of\b/i, /\bcounty of\b/i, /\bstate of\b/i,
  /\bdepartment of\b/i, /\bnational laboratory\b/i, /\bnational lab\b/i,
];

const CAP_EXEMPT_JD_KEYWORDS = [
  '501(c)(3)', '501c3', 'nonprofit organization', 'non-profit organization',
  'not-for-profit organization', 'government employer', 'public institution',
  'cap-exempt employer', 'cap exempt employer',
];

function detectCapExempt(companyName, jdText) {
  for (const pat of CAP_EXEMPT_NAME_PATTERNS) {
    if (pat.test(companyName)) return `company: ${companyName}`;
  }
  if (jdText) {
    const lower = jdText.toLowerCase();
    const kw = CAP_EXEMPT_JD_KEYWORDS.find(k => lower.includes(k));
    if (kw) return `jd: ${kw}`;
  }
  return null;
}

function extractCompany(notes) {
  return (notes || '').split(' - ')[0].trim() || 'unknown';
}

function gate1PendingJobs() {
  if (!existsSync(INPUT_FILE)) return [];
  const stateMap = new Map();
  if (existsSync(STATE_FILE)) {
    readFileSync(STATE_FILE, 'utf-8').split('\n').forEach(l => {
      const p = l.split('\t');
      if (p.length >= 3 && p[0] !== 'id') stateMap.set(p[0], p[2]);
    });
  }
  const alreadyFiltered = new Set();
  if (existsSync(GATE1_RESULTS)) {
    readFileSync(GATE1_RESULTS, 'utf-8').split('\n').forEach(l => {
      const p = l.split('\t');
      if (p[0] && p[0] !== 'id') alreadyFiltered.add(p[0]);
    });
  }
  return readFileSync(INPUT_FILE, 'utf-8').split('\n').flatMap(line => {
    const p = line.split('\t');
    if (!p[0] || p[0] === 'id' || !p[1]) return [];
    const status = stateMap.get(p[0]);
    if (alreadyFiltered.has(p[0])) return []; // already gate1-processed
    if (status && status !== 'pending' && status !== 'failed') return [];
    return [{ id: p[0], url: p[1].trim(), notes: p[3]?.trim() || '' }];
  });
}

async function runGate1() {
  const jobs = gate1PendingJobs();
  if (jobs.length === 0) { log('gate1: no new jobs to screen'); return 0; }
  log(`gate1: screening ${jobs.length} jobs (H1B + keywords) …`);

  const cache = readH1bCache();
  const results = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const slice = jobs.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(slice.map(async job => {
      const company = extractCompany(job.notes);

      // Pre-check A: foreign / anonymous employers — filter without LCA lookup
      const foreignOrAnon = detectForeignOrAnonymous(company);
      if (foreignOrAnon) return { ...job, company, status: 'FILTER', lca: 0, reason: foreignOrAnon };

      // Pre-check B: named cap-exempt employers (hospitals, known non-profits)
      if (detectCapExemptNamed(company)) return { ...job, company, status: 'FILTER', lca: 0, reason: `cap-exempt: ${company}` };

      // Step A: fetch JD (save to /tmp for later phases)
      const jdText = await fetchJd(job.url, job.id);

      // LinkedIn jobs: JD is never available at Gate 1 time (plain HTTP hits a login wall).
      // playwright-prefetch runs after Gate 1 and fetches the real JD for the batch worker.
      // Treat as optimistic pass-through — skip JD-dependent checks, lower LCA threshold to 1.
      const isLinkedInNoJd = job.url.includes('linkedin.com') && !jdText;

      // Step B: hard-reject keyword check (skip if LinkedIn JD not yet available)
      if (!isLinkedInNoJd) {
        const rejectedKw = detectHardReject(jdText);
        if (rejectedKw) return { ...job, company, status: 'FILTER', lca: 0, reason: `keyword: ${rejectedKw}` };

        // Step B2: cap-exempt employer filter (universities, govt, non-profits — pattern-based)
        const capExempt = detectCapExempt(company, jdText);
        if (capExempt) return { ...job, company, status: 'FILTER', lca: 0, reason: `cap-exempt: ${capExempt}` };
      }

      // Step C: LCA check — aliases → normalization → suffix expansion
      const slug = toSlug(company);

      // Resolve canonical name via aliases table
      const aliasName = COMPANY_ALIASES[company.toLowerCase()] || COMPANY_ALIASES[company];
      const lookupName = aliasName || company;
      const lookupSlug = toSlug(lookupName);

      // Check cache for canonical slug first, then original slug
      const cached = cache.get(lookupSlug) || (aliasName ? null : cache.get(slug));
      let lcaCount;
      let searchedAs = lookupName;

      if (cached && isFresh(cached.last_checked)) {
        lcaCount = cached.total_lca;
      } else {
        // Try normalized name (strips ", Inc." / "(AWS)" etc.)
        const normalizedName = safeNormalize(lookupName);
        lcaCount = await fetchLcaCount(normalizedName);
        searchedAs = normalizedName;

        // If normalized returned 0 and it changed the name, also try the original
        if (lcaCount === 0 && normalizedName !== lookupName) {
          const rawCount = await fetchLcaCount(lookupName);
          if (rawCount > 0) { lcaCount = rawCount; searchedAs = lookupName; }
        }

        // Still 0 and no alias found — try suffix variants (self-learning)
        if (lcaCount === 0 && !aliasName) {
          const expanded = await trySuffixExpansion(normalizedName);
          if (expanded.count > 0) {
            lcaCount = expanded.count;
            searchedAs = expanded.foundAs;
            // Auto-learn: persist alias for future Gate 1 runs this session
            COMPANY_ALIASES[company.toLowerCase()] = expanded.foundAs;
          }
        }

        // Write to cache using the slug of the name that actually returned results
        const cacheSlug = toSlug(searchedAs !== lookupName ? searchedAs : lookupSlug);
        updateH1bCache(cacheSlug, searchedAs, lcaCount);
        cache.set(cacheSlug, { total_lca: lcaCount, last_checked: new Date().toISOString().slice(0, 10) });
      }

      // Step D: LCA threshold check — only applies if user needs sponsorship.
      // For LinkedIn without JD: lower threshold to 1 — any LCA history passes.
      // The batch worker will do full keyword + sponsor screening with the real JD.
      // For users who don't need sponsorship (US Citizen / Green Card / Permanent Resident),
      // LCA count is informational only — all companies with legitimate JDs proceed.
      if (userNeedsSponsorship()) {
        const hasExplicitSponsor = jdText && /will sponsor.*h.?1.?b|h.?1.?b.*sponsor|visa sponsorship (provided|available|offered)/i.test(jdText);
        const minLca = isLinkedInNoJd ? 1 : 10;
        if (lcaCount < minLca && !hasExplicitSponsor) {
          return { ...job, company, status: 'FILTER', lca: lcaCount, reason: `lca:${lcaCount}` };
        }
      }

      return { ...job, company, status: 'PASS', lca: lcaCount, reason: '-' };
    }));
    results.push(...batch);
  }

  // Write gate1-results.tsv (appends to existing if partial run)
  const existingIds = new Set();
  if (existsSync(GATE1_RESULTS)) {
    readFileSync(GATE1_RESULTS, 'utf-8').split('\n').forEach(l => {
      const p = l.split('\t');
      if (p[0] && p[0] !== 'id') existingIds.add(p[0]);
    });
  }
  const newRows = results.filter(r => !existingIds.has(r.id))
    .map(r => `${r.id}\t${r.status}\t${r.lca}\t${r.reason}\t${r.company}`).join('\n');

  if (!existsSync(GATE1_RESULTS)) writeFileSync(GATE1_RESULTS, 'id\tstatus\tlca_count\treason\tcompany\n');
  if (newRows) appendFileSync(GATE1_RESULTS, newRows + '\n');

  const filtered = results.filter(r => r.status === 'FILTER');
  const passed   = results.filter(r => r.status === 'PASS');

  if (filtered.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    appendFileSync(FILTER_LOG,
      filtered.map(r => `${today}\t${r.id}\t${r.url}\t${r.company}\t${r.reason}`).join('\n') + '\n'
    );
    log(`gate1: ${filtered.length} filtered → ${FILTER_LOG}`);
  }
  log(`gate1: ${passed.length} passed to Phase 1`);
  return filtered.length;
}

// ── Sync Gate1 FILTER verdicts into batch-state.tsv ──────────────────────────
// After runGate1(), any job marked as FILTER in gate1-results.tsv should also
// be marked as `gate1_filtered` in batch-state.tsv so batch-runner.sh and
// playwright-prefetch.mjs skip them instead of wasting Claude tokens / JD
// fetches on jobs that were already rejected by the LCA/keyword screen.
// Idempotent: does not touch rows already `completed` / `failed` / `gate1_filtered`.
function syncGate1FiltersToState() {
  if (!existsSync(GATE1_RESULTS) || !existsSync(INPUT_FILE)) return 0;

  // Read gate1 FILTER entries: id -> reason
  const filtered = new Map();
  for (const line of readFileSync(GATE1_RESULTS, 'utf-8').split('\n')) {
    const p = line.split('\t');
    if (p.length < 4 || p[0] === 'id' || p[1] !== 'FILTER') continue;
    filtered.set(p[0], p[3]);
  }
  if (filtered.size === 0) return 0;

  // Read batch-input for URLs
  const urls = new Map();
  for (const line of readFileSync(INPUT_FILE, 'utf-8').split('\n')) {
    const p = line.split('\t');
    if (p[0] && p[0] !== 'id') urls.set(p[0], p[1]);
  }

  // Read existing state
  const existing = new Map();
  if (existsSync(STATE_FILE)) {
    for (const line of readFileSync(STATE_FILE, 'utf-8').split('\n')) {
      const p = line.split('\t');
      if (p[0] && p[0] !== 'id') existing.set(p[0], p[2]);
    }
  } else {
    // Initialize state file with header if it doesn't exist yet
    writeFileSync(STATE_FILE, 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n');
  }

  const now = new Date().toISOString();
  const rows = [];
  for (const [id, reason] of filtered) {
    const currentStatus = existing.get(id);
    // Skip if job is already in a terminal or gate1-filtered state
    if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'gate1_filtered') continue;
    const url = urls.get(id) || '';
    rows.push(`${id}\t${url}\tgate1_filtered\t${now}\t${now}\t\t\tgate1:${reason}\t0`);
  }
  if (rows.length) appendFileSync(STATE_FILE, rows.join('\n') + '\n');
  log(`gate1-filter sync: marked ${rows.length} jobs as gate1_filtered in batch-state.tsv`);
  return rows.length;
}

// ── Dynamic retry scheduling based on rate-limit reset hint ──────────────────
function cleanupRetryPlist() {
  if (!existsSync(RETRY_PLIST)) return;
  try {
    spawnSync('launchctl', ['unload', RETRY_PLIST], { stdio: 'ignore' });
    unlinkSync(RETRY_PLIST);
    log('cleaned up stale retry plist');
  } catch {}
}

function scheduleRetryFromRateLimitHint() {
  if (!existsSync(RATE_LIMIT_HINT)) return;
  const hint = readFileSync(RATE_LIMIT_HINT, 'utf-8').trim();
  if (!hint) return;

  let retryDate = null;

  // "resets 3:10pm" / "resets at 3:45 PM" / "try again at 8:10 PM" / "available at 8:15 PM"
  const atMatch = hint.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (atMatch) {
    let h = parseInt(atMatch[1]);
    const m = parseInt(atMatch[2]);
    if (atMatch[3].toUpperCase() === 'PM' && h < 12) h += 12;
    if (atMatch[3].toUpperCase() === 'AM' && h === 12) h = 0;
    retryDate = new Date();
    retryDate.setHours(h, m + 5, 0, 0); // +5 min buffer after reset
    if (retryDate <= new Date()) retryDate.setDate(retryDate.getDate() + 1);
  }

  // "resets in 47 minutes"
  if (!retryDate) {
    const inMatch = hint.match(/in\s+(\d+)\s+minute/i);
    if (inMatch) retryDate = new Date(Date.now() + (parseInt(inMatch[1]) + 5) * 60 * 1000);
  }

  if (!retryDate) { log(`rate-limit hint unparseable: "${hint}"`); return; }

  const hour   = retryDate.getHours();
  const minute = retryDate.getMinutes();
  log(`scheduling retry at ${hour}:${String(minute).padStart(2, '0')} (from hint: "${hint}")`);

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
        <string>${join(PROJECT_DIR, 'auto-batch.mjs')}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>${hour}</integer>
        <key>Minute</key><integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/tmp/careerops-batch-retry.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/careerops-batch-retry-error.log</string>
</dict>
</plist>`;

  try {
    writeFileSync(RETRY_PLIST, plist);
    spawnSync('launchctl', ['load', RETRY_PLIST], { stdio: 'ignore' });
    writeFileSync(RATE_LIMIT_HINT, ''); // clear hint so next run doesn't reschedule
  } catch (e) {
    log('warning: could not write/load retry plist:', e.message);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  log('=== auto-batch.mjs start ===');
  cleanupRetryPlist(); // remove any stale one-shot retry plist from previous run
  clearLocks();

  const newItems   = syncPipeline();
  const resetCount = resetRateLimitFailures();

  if (!hasPending()) {
    log('nothing pending — done');
    process.exit(0);
  }

  log(`pending jobs detected (${newItems} new + ${resetCount} rate-limit resets) — starting batch`);
  await runGate1();              // filter H1B + hard-reject keywords before spawning Claude workers
  syncGate1FiltersToState();     // mark FILTER'd jobs as gate1_filtered so downstream steps skip them
  playwrightPrefetch();          // handles JS-blocked jobs that passed Gate 1
  syncResolvedUrlsToBatchState();// Fix E: rewrite LinkedIn → resolved ATS URLs before evaluator workers run
  runBatch();
  scheduleRetryFromRateLimitHint(); // if session limit hit, schedule retry at reset time
  mergeTracker();
  dedupTracker();
  resolveLinkedInReports();      // Fix D: backfill resolved URLs into reports (zero-token Playwright)
  verifyPipeline();
  markPipelineDone();
  // PDF backfill is handled by dashboard-server.mjs on startup (user session = valid OAuth).
  // scheduleQueuePdfs() was removed — it failed silently from launchd (no active claude session).

  log('=== auto-batch.mjs complete ===');
})();
