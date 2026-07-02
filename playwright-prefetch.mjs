#!/usr/bin/env node
/**
 * playwright-prefetch.mjs
 *
 * Pre-fetches JD content for JS-rendered job pages (Workday, Taleo, Dayforce,
 * Oracle HCM, iCIMS, ADP, etc.) that WebFetch cannot access.
 *
 * Reads batch-state.tsv for failed jobs on JS-blocked domains, navigates each
 * URL with a real Playwright browser, extracts the job description text, and
 * saves it to /tmp/batch-jd-{id}.txt — the exact path batch-runner.sh looks for.
 *
 * After this runs, re-running auto-batch.mjs will find the pre-fetched JDs
 * and evaluate them normally without needing to re-fetch the URL.
 *
 * Usage:
 *   node playwright-prefetch.mjs              # prefetch all JS-blocked failures
 *   node playwright-prefetch.mjs --id 42      # single job by batch ID
 *   node playwright-prefetch.mjs --dry-run    # show what would be fetched
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const BATCH_DIR    = join(PROJECT_DIR, 'batch');
const STATE_FILE   = join(BATCH_DIR, 'batch-state.tsv');
const INPUT_FILE   = join(BATCH_DIR, 'batch-input.tsv');
const PIPELINE_FILE = join(PROJECT_DIR, 'data', 'pipeline.md');
const SESSION_PATH  = join(PROJECT_DIR, 'data', 'linkedin-session.json');

const JS_BLOCKED_DOMAINS = [
  'myworkdayjobs.com',
  'taleo.net',
  'dayforcehcm.com',
  'oraclecloud.com',
  'icims.com',
  'adp.com',
  'myjobs.adp.com',
  'workforcenow.adp.com',
  'paycomonline.net',
  'zohorecruit.com',
  'breezy.hr',
  'smbcgroup.com',
  'searchjobs.libertymutualgroup.com',
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINGLE_ID = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;
const maxRtIdx = args.indexOf('--max-runtime');
const MAX_RUNTIME_MS = maxRtIdx >= 0 ? parseInt(args[maxRtIdx + 1]) * 60 * 1000 : null;
const jobTmIdx = args.indexOf('--job-timeout');
const JOB_TIMEOUT_MS = jobTmIdx >= 0 ? parseInt(args[jobTmIdx + 1]) * 1000 : 45000;
const START_TIME = Date.now();
const LOCK_FILE = '/tmp/playwright-prefetch.lock';

// ── PID lock: prevent concurrent runs (manual + launchd firing simultaneously) ──
if (!DRY_RUN) {
  if (existsSync(LOCK_FILE)) {
    const existingPid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim());
    try {
      process.kill(existingPid, 0); // throws if PID is dead
      console.log(`Another playwright-prefetch is already running (pid ${existingPid}). Skipping this run.`);
      process.exit(0);
    } catch {
      // Stale lock — previous run crashed without cleanup, safe to continue
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid));
  const removeLock = () => { try { unlinkSync(LOCK_FILE); } catch {} };
  process.on('exit', removeLock);
  process.on('SIGINT', () => { removeLock(); process.exit(0); });
  process.on('SIGTERM', () => { removeLock(); process.exit(0); });
}

function withJobTimeout(promise, id) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`job timeout after ${JOB_TIMEOUT_MS / 1000}s`)), JOB_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isJsBlocked(url) {
  return JS_BLOCKED_DOMAINS.some(d => url.includes(d));
}

function isLinkedIn(url) {
  return url.includes('linkedin.com/jobs');
}

// ── LinkedIn pending jobs: not yet fetched, not completed/skipped ─────────────
function loadLinkedInPendingJobs() {
  if (!existsSync(INPUT_FILE)) return [];

  // Build a status map from batch-state.tsv
  const statusMap = new Map();
  if (existsSync(STATE_FILE)) {
    for (const line of readFileSync(STATE_FILE, 'utf-8').split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3 || parts[0] === 'id') continue;
      statusMap.set(parts[0], parts[2]);
    }
  }

  const jobs = [];
  for (const line of readFileSync(INPUT_FILE, 'utf-8').split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2 || parts[0] === 'id') continue;
    const id  = parts[0].trim();
    const url = parts[1].trim();
    if (!id || !url || !isLinkedIn(url)) continue;
    if (SINGLE_ID && id !== SINGLE_ID) continue;
    const status  = statusMap.get(id) || 'none';
    if (status === 'completed' || status === 'skipped' || status === 'gate1_filtered') continue;
    const jdFile  = `/tmp/batch-jd-${id}.txt`;
    if (existsSync(jdFile)) continue; // already prefetched
    jobs.push({ id, url });
  }
  return jobs;
}

function loadFailedJobs() {
  if (!existsSync(STATE_FILE)) return [];
  return readFileSync(STATE_FILE, 'utf-8')
    .split('\n')
    .filter(line => {
      const parts = line.split('\t');
      if (parts.length < 3 || parts[0] === 'id') return false;
      if (SINGLE_ID && parts[0] !== SINGLE_ID) return false;
      // Include failed jobs on JS-blocked domains, or jobs with no JD file yet
      const isFailed = parts[2] === 'failed';
      const url = parts[1] ?? '';
      const jdFile = `/tmp/batch-jd-${parts[0]}.txt`;
      const alreadyFetched = existsSync(jdFile);
      return isFailed && isJsBlocked(url) && !alreadyFetched;
    })
    .map(line => {
      const parts = line.split('\t');
      return { id: parts[0], url: parts[1] };
    });
}

async function extractJD(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for JD content to appear (common selectors across platforms)
  const jdSelectors = [
    '[data-automation-id="jobPostingDescription"]', // Workday
    '.job-description',
    '#job-description',
    '.jobDescriptionText',                           // Taleo
    '.jd-info',
    '[class*="description"]',
    '[class*="job-detail"]',
    '[class*="jobDetail"]',
    '.posting-description',
    'article',
    'main',
  ];

  for (const sel of jdSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      const text = await page.$eval(sel, el => el.innerText?.trim());
      if (text && text.length > 200) return text;
    } catch {}
  }

  // Fallback: grab all visible text from body
  const bodyText = await page.evaluate(() => document.body.innerText?.trim());
  return bodyText && bodyText.length > 200 ? bodyText : null;
}

// ── Resolve LinkedIn job → external apply URL + JD text ──────────────────────
async function resolveLinkedInJob(page, url) {
  try {
    // networkidle waits for SPA components to finish rendering (domcontentloaded fires too early)
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    // Extra buffer for React hydration after network goes idle
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
    await page.waitForSelector(
      '.show-more-less-html, #job-details, .jobs-description, .description__text, .jobs-unified-top-card',
      { timeout: 8000 }
    ).catch(() => {});
  } catch {
    return { jd: null, applyUrl: null };
  }

  // ── Try to extract the external "Apply on company website" URL ────────────
  let applyUrl = null;
  const applySelectors = [
    'a.apply-button--offsite[href]',
    '.jobs-apply-button--top-card a[href]',
    // Logged-in view: "Apply on company website" button
    'a[data-tracking-control-name*="apply"][href*="greenhouse.io"]',
    'a[data-tracking-control-name*="apply"][href*="lever.co"]',
    'a[data-tracking-control-name*="apply"][href*="ashbyhq.com"]',
    'a[data-tracking-control-name*="apply"][href*="myworkdayjobs.com"]',
    'a[data-tracking-control-name*="apply"][href*="icims.com"]',
    'a[href*="greenhouse.io"]',
    'a[href*="lever.co"]',
    'a[href*="ashbyhq.com"]',
    'a[href*="myworkdayjobs.com"]',
    'a[href*="icims.com"]',
    'a[href*="smartrecruiters.com"]',
    'a[href*="jobvite.com"]',
    'a[href*="taleo.net"]',
  ];
  for (const sel of applySelectors) {
    try {
      const href = await page.$eval(sel, el => el.href || el.getAttribute('href'));
      if (href && href.startsWith('http') && !href.includes('linkedin.com')) {
        applyUrl = href;
        break;
      }
    } catch {}
  }

  // ── Broad fallback: any "Apply" button/link pointing off LinkedIn ─────────
  if (!applyUrl) {
    try {
      applyUrl = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('a[href]'));
        for (const a of candidates) {
          const href = a.href || '';
          const text = (a.innerText || a.textContent || '').toLowerCase();
          if (!href.startsWith('http')) continue;
          if (href.includes('linkedin.com')) continue;
          // Must look like an apply/job link
          if (text.includes('apply') || a.closest('[class*="apply"]') ||
              a.getAttribute('data-tracking-control-name')?.includes('apply')) {
            return href;
          }
        }
        return null;
      });
    } catch {}
  }

  // ── Extract JD text from LinkedIn page ───────────────────────────────────
  const jdSelectors = [
    '#job-details',                          // logged-in unified view
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.show-more-less-html__markup',
    '.description__text',                    // older logged-out view
    '[class*="jobs-description"]',
  ];
  let jd = null;
  for (const sel of jdSelectors) {
    try {
      const text = await page.$eval(sel, el => el.innerText?.trim());
      if (text && text.length > 200) { jd = text; break; }
    } catch {}
  }

  // ── If external URL found, navigate there and get richer JD ─────────────
  if (applyUrl) {
    try {
      await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const richerJd = await extractJD(page, applyUrl).catch(() => null);
      if (richerJd && richerJd.length > (jd?.length ?? 0)) jd = richerJd;
    } catch {}
  }

  return { jd, applyUrl };
}

// ── Update pipeline.md: replace a LinkedIn URL with its resolved apply URL ──
function updatePipelineUrl(linkedinUrl, resolvedUrl) {
  if (!existsSync(PIPELINE_FILE)) return;
  const content = readFileSync(PIPELINE_FILE, 'utf-8');
  // Match lines like:  - [ ] https://linkedin.com/...  | Company | ...
  const escaped = linkedinUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const updated = content.replace(
    new RegExp(`(- \\[.\\] )${escaped}\\b`, 'g'),
    `$1${resolvedUrl}`
  );
  if (updated !== content) writeFileSync(PIPELINE_FILE, updated);
}

async function main() {
  const jsBlockedJobs  = loadFailedJobs();
  const linkedInJobs   = loadLinkedInPendingJobs();
  const totalJobs      = jsBlockedJobs.length + linkedInJobs.length;

  if (totalJobs === 0) {
    console.log('No JS-blocked or LinkedIn jobs to prefetch.');
    return;
  }

  if (DRY_RUN) {
    if (jsBlockedJobs.length)
      console.log(`Found ${jsBlockedJobs.length} JS-blocked jobs (dry run):`),
      jsBlockedJobs.forEach(j => console.log(`  #${j.id}: ${j.url}`));
    if (linkedInJobs.length)
      console.log(`Found ${linkedInJobs.length} LinkedIn jobs to resolve (dry run):`),
      linkedInJobs.forEach(j => console.log(`  #${j.id}: ${j.url}`));
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const hasSession = existsSync(SESSION_PATH);
  const context = await browser.newContext({
    storageState: hasSession ? SESSION_PATH : undefined,
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
  if (hasSession) console.log('Using saved LinkedIn session for authenticated access.');

  let fetched = 0;
  let failed  = 0;

  const isTimedOut = () => MAX_RUNTIME_MS && (Date.now() - START_TIME) >= MAX_RUNTIME_MS;

  // ── Pass 1: JS-blocked domains (Workday, Taleo, Dayforce, etc.) ─────────────
  if (jsBlockedJobs.length) {
    console.log(`\nJS-blocked prefetch: ${jsBlockedJobs.length} jobs`);
    for (const job of jsBlockedJobs) {
      if (isTimedOut()) { console.log(`  ⏱  Max runtime reached, stopping early.`); break; }
      const jdFile = `/tmp/batch-jd-${job.id}.txt`;
      console.log(`[${job.id}] Fetching: ${job.url}`);
      const page = await context.newPage();
      try {
        const text = await withJobTimeout(extractJD(page, job.url), job.id);
        if (text && text.length > 200) {
          writeFileSync(jdFile, text);
          console.log(`  ✅ Saved ${text.length} chars → ${jdFile}`);
          fetched++;
        } else {
          console.log(`  ⚠️  Page loaded but no JD content found (login wall or empty)`);
          failed++;
        }
      } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        failed++;
      } finally {
        await page.close();
      }
    }
  }

  // ── Pass 2: LinkedIn → resolve external apply URL + prefetch JD ─────────────
  if (linkedInJobs.length && !isTimedOut()) {
    console.log(`\nLinkedIn resolution: ${linkedInJobs.length} jobs`);
    for (const job of linkedInJobs) {
      if (isTimedOut()) { console.log(`  ⏱  Max runtime reached, stopping early.`); break; }
      const jdFile = `/tmp/batch-jd-${job.id}.txt`;
      console.log(`[${job.id}] Resolving: ${job.url}`);
      const page = await context.newPage();
      try {
        const { jd, applyUrl } = await withJobTimeout(resolveLinkedInJob(page, job.url), job.id);
        if (jd && jd.length > 200) {
          // Prepend resolved URL so the batch worker uses it in the report/tracker
          const content = applyUrl
            ? `RESOLVED_APPLY_URL: ${applyUrl}\n\n${jd}`
            : jd;
          writeFileSync(jdFile, content);
          if (applyUrl) {
            updatePipelineUrl(job.url, applyUrl);
            console.log(`  ✅ Resolved → ${applyUrl} (${jd.length} chars)`);
          } else {
            console.log(`  ✅ LinkedIn JD saved (${jd.length} chars, no external apply URL found)`);
          }
          fetched++;
        } else {
          console.log(`  ⚠️  No JD content (login wall or Easy Apply only)`);
          failed++;
        }
      } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        failed++;
      } finally {
        await page.close();
        // Human-like pause between LinkedIn requests to avoid rate-limiting
        if (linkedInJobs.length > 1) {
          await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
        }
      }
    }
  }

  await browser.close();
  console.log(`\nDone: ${fetched} fetched/resolved, ${failed} failed`);

  if (fetched > 0) {
    console.log('\nNext step: run  node auto-batch.mjs  to evaluate the pre-fetched jobs');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
