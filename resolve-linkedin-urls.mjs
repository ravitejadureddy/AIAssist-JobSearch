#!/usr/bin/env node
/**
 * resolve-linkedin-urls.mjs
 *
 * For every Apply Queue job whose report **URL:** is a LinkedIn URL:
 *   1. Visits the page using the saved LinkedIn session (data/linkedin-session.json)
 *   2. Extracts the external "Apply on company website" URL if present
 *   3. Updates the report's **URL:** field in-place → Fill button replaces LinkedIn button
 *   4. Detects "No longer accepting applications" → marks job Discarded in tracker
 *
 * Usage:
 *   node resolve-linkedin-urls.mjs             # process all
 *   node resolve-linkedin-urls.mjs --dry-run   # show plan, no writes
 *   node resolve-linkedin-urls.mjs --headed    # show browser window
 *   node resolve-linkedin-urls.mjs --limit 20  # cap at N jobs
 *   node resolve-linkedin-urls.mjs --num 8786  # single job by tracker #
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium as playwrightChromium } from 'playwright';
import { chromium as stealthChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
stealthChromium.use(StealthPlugin());

const __dirname   = dirname(fileURLToPath(import.meta.url));
const TRACKER     = join(__dirname, 'data', 'applications.md');
const SESSION     = join(__dirname, 'data', 'linkedin-session.json');
const REPORTS_DIR = join(__dirname, 'reports');

const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const HEADED    = args.includes('--headed');
const limitIdx  = args.indexOf('--limit');
const LIMIT     = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : Infinity;
const numIdx    = args.indexOf('--num');
const SINGLE    = numIdx >= 0 ? args[numIdx + 1] : null;

// ── ATS domains we care about (resolved URL → Fill button will work or be informative) ──
const KNOWN_ATS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com',
  'myworkdayjobs.com', 'icims.com', 'smartrecruiters.com',
  'jobvite.com', 'taleo.net', 'successfactors.com',
  'oraclecloud.com', 'dayforcehcm.com', 'breezy.hr',
  'paycomonline.net', 'bamboohr.com', 'recruitingbypaycor.com',
  'ultipro.com', 'kronos.net',
];

// ── Aggregator domains that are NOT company career pages ─────────────────────
const AGGREGATORS = [
  'dice.com', 'indeed.com', 'ziprecruiter.com', 'glassdoor.com',
  'monster.com', 'careerbuilder.com', 'jobluxe.in', 'biospace.com',
  'insidehighered.com', 'talentally.com', 'hackajob.com',
  'jobs-via-dice', 'chatgpt-jobs', 'saragossa.',
];

function isAggregator(url) {
  return AGGREGATORS.some(d => url.includes(d));
}

// ── Build job list from tracker ──────────────────────────────────────────────
function loadJobs() {
  const lines = readFileSync(TRACKER, 'utf-8').split('\n');
  const outputDirs = existsSync(join(__dirname, 'output'))
    ? readdirSync(join(__dirname, 'output')) : [];
  const jobs = [];

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map(c => c.trim());
    if (cols.length < 9) continue;
    const num    = cols[1];
    const score  = parseFloat(cols[5]);
    const status = cols[6];
    if (status !== 'Evaluated' || isNaN(score) || score < 3.5) continue;
    if (SINGLE && num !== SINGLE) continue;

    const reportCol = cols[8] || '';
    const m = reportCol.match(/\[(\d+)\]\(([^)]+)\)/);
    if (!m) continue;
    const reportNum  = m[1];
    const reportRel  = m[2].replace(/^(\.\.\/)+/, '');
    const reportPath = join(__dirname, reportRel);
    if (!existsSync(reportPath)) continue;

    const text   = readFileSync(reportPath, 'utf-8');
    const urlM   = text.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/);
    const jobUrl = urlM?.[1]?.trim();
    if (!jobUrl || !jobUrl.includes('linkedin.com')) continue;

    jobs.push({ num, reportNum, reportPath, jobUrl, trackerLine: line });
    if (jobs.length >= LIMIT) break;
  }
  return jobs;
}

// ── Selectors for external apply URL on LinkedIn ──────────────────────────────
const APPLY_SELECTORS = [
  // Logged-in: offsite apply button
  'a.apply-button--offsite[href]',
  // Top-card apply button containing a link
  '.jobs-apply-button--top-card a[href]',
  // data-tracking links to specific ATS
  'a[data-tracking-control-name*="apply"][href*="greenhouse.io"]',
  'a[data-tracking-control-name*="apply"][href*="lever.co"]',
  'a[data-tracking-control-name*="apply"][href*="ashbyhq.com"]',
  'a[data-tracking-control-name*="apply"][href*="myworkdayjobs.com"]',
  'a[data-tracking-control-name*="apply"][href*="icims.com"]',
  'a[data-tracking-control-name*="apply"][href*="smartrecruiters.com"]',
  'a[data-tracking-control-name*="apply"][href*="jobvite.com"]',
  'a[data-tracking-control-name*="apply"][href*="taleo.net"]',
  'a[data-tracking-control-name*="apply"][href*="successfactors.com"]',
  'a[data-tracking-control-name*="apply"][href*="oraclecloud.com"]',
  'a[data-tracking-control-name*="apply"][href*="bamboohr.com"]',
  // Generic href matches
  'a[href*="greenhouse.io"]',
  'a[href*="lever.co"]',
  'a[href*="ashbyhq.com"]',
  'a[href*="myworkdayjobs.com"]',
  'a[href*="icims.com"]',
  'a[href*="smartrecruiters.com"]',
  'a[href*="jobvite.com"]',
  'a[href*="taleo.net"]',
  'a[href*="successfactors.com"]',
  'a[href*="bamboohr.com"]',
  'a[href*="recruitingbypaycor.com"]',
];

async function resolveLinkedInUrl(page, linkedinUrl) {
  try {
    await page.goto(linkedinUrl, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
    await page.waitForSelector(
      '.jobs-unified-top-card, .show-more-less-html, #job-details, .jobs-description',
      { timeout: 8000 }
    ).catch(() => {});
  } catch {
    return { applyUrl: null, expired: false, easyApply: false };
  }

  // ── Check for expired posting ─────────────────────────────────────────────
  const expired = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    return body.includes('No longer accepting applications') ||
           body.includes('no longer accepting') ||
           body.includes('This job is no longer available') ||
           body.includes('posting has expired') ||
           !!document.querySelector('.closed-job, .job-closed, [class*="job-closed"]');
  }).catch(() => false);

  if (expired) return { applyUrl: null, expired: true, easyApply: false };

  // ── Check for Easy Apply (LinkedIn's own form) ────────────────────────────
  const easyApply = await page.evaluate(() => {
    const btn = document.querySelector(
      'button[aria-label*="Easy Apply"], .jobs-apply-button--top-card button'
    );
    if (!btn) return false;
    const text = btn.innerText || btn.textContent || '';
    return text.toLowerCase().includes('easy apply');
  }).catch(() => false);

  // ── Try each ATS selector ─────────────────────────────────────────────────
  let applyUrl = null;
  for (const sel of APPLY_SELECTORS) {
    try {
      const href = await page.$eval(sel, el => el.href || el.getAttribute('href'));
      if (href && href.startsWith('http') && !href.includes('linkedin.com')) {
        applyUrl = href;
        break;
      }
    } catch {}
  }

  // ── Broad fallback: any off-LinkedIn link near an "apply" context ─────────
  if (!applyUrl) {
    applyUrl = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href || '';
        if (!href.startsWith('http') || href.includes('linkedin.com')) continue;
        const text = (a.innerText || a.textContent || '').toLowerCase();
        const trackName = a.getAttribute('data-tracking-control-name') || '';
        if (text.includes('apply') || trackName.includes('apply') ||
            a.closest('[class*="apply"]')) {
          return href;
        }
      }
      return null;
    }).catch(() => null);
  }

  return { applyUrl, expired: false, easyApply };
}

// ── Update **URL:** in report file ───────────────────────────────────────────
function updateReportUrl(reportPath, newUrl) {
  const content = readFileSync(reportPath, 'utf-8');
  const updated = content.replace(
    /^(\*\*URL:\*\*\s*)https?:\/\/\S+/m,
    `$1${newUrl}`
  );
  if (updated === content) return false;
  writeFileSync(reportPath, updated);
  return true;
}

// ── Mark Discarded in tracker ────────────────────────────────────────────────
function markDiscarded(trackerNum) {
  let content = readFileSync(TRACKER, 'utf-8');
  const rowRe  = new RegExp(`^(\\| ${trackerNum} \\|[^\\n]*)$`, 'm');
  const match  = content.match(rowRe);
  if (!match) return false;
  const cols = match[1].split('|');
  if (cols[6] !== undefined) cols[6] = ' Discarded ';
  if (cols[9] !== undefined) {
    const existing = cols[9].trim();
    cols[9] = ` Posting expired${existing ? '; ' + existing : ''} `;
  }
  content = content.replace(rowRe, cols.join('|'));
  writeFileSync(TRACKER, content);
  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const jobs = loadJobs();
  console.log(`LinkedIn URLs to resolve: ${jobs.length}${DRY_RUN ? ' (dry run)' : ''}\n`);

  if (jobs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    jobs.forEach(j => console.log(`  job#${j.num} rpt#${j.reportNum} → ${j.jobUrl.slice(0, 80)}…`));
    return;
  }

  const browser = await stealthChromium.launch({
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const hasSession = existsSync(SESSION);
  const context = await browser.newContext({
    storageState: hasSession ? SESSION : undefined,
    viewport:     { width: 1440, height: 900 },
    userAgent:    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale:       'en-US',
    timezoneId:   'America/Chicago',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });

  if (hasSession) console.log('Using saved LinkedIn session.\n');

  const stats = { resolved: 0, expired: 0, easyApply: 0, aggregator: 0, unchanged: 0, error: 0 };

  for (const job of jobs) {
    process.stdout.write(`job#${job.num} rpt#${job.reportNum} … `);
    const page = await context.newPage();
    try {
      const { applyUrl, expired, easyApply } = await resolveLinkedInUrl(page, job.jobUrl);

      if (expired) {
        console.log('❌ EXPIRED — marking Discarded');
        if (!DRY_RUN) markDiscarded(job.num);
        stats.expired++;
      } else if (easyApply && !applyUrl) {
        console.log('🔵 Easy Apply only — keeping LinkedIn button');
        stats.easyApply++;
      } else if (applyUrl && isAggregator(applyUrl)) {
        console.log(`⚠️  Aggregator: ${applyUrl.slice(0, 70)}`);
        stats.aggregator++;
      } else if (applyUrl) {
        console.log(`✅ → ${applyUrl.slice(0, 80)}`);
        const changed = updateReportUrl(job.reportPath, applyUrl);
        if (changed) stats.resolved++;
        else { console.log('  (URL field not updated — pattern mismatch)'); stats.unchanged++; }
      } else {
        console.log('⚠️  No external URL found');
        stats.unchanged++;
      }
    } catch (err) {
      console.log(`❌ error: ${err.message.slice(0, 80)}`);
      stats.error++;
    } finally {
      await page.close().catch(() => {});
    }

    // Human-like delay between requests
    await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
  }

  await browser.close();

  console.log(`\n── Summary ────────────────────────────────`);
  console.log(`  ✅ Resolved to external URL: ${stats.resolved}  (Fill button now shows)`);
  console.log(`  ❌ Expired → Discarded:      ${stats.expired}`);
  console.log(`  🔵 Easy Apply only:          ${stats.easyApply}  (LinkedIn button correct)`);
  console.log(`  ⚠️  Aggregator (no ATS):     ${stats.aggregator}  (LinkedIn button kept)`);
  console.log(`  ⚠️  No URL found:            ${stats.unchanged}`);
  console.log(`  ❌ Errors:                   ${stats.error}`);
}

main().catch(err => { console.error(err); process.exit(1); });
