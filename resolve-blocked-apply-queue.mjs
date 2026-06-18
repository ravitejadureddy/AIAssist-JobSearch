#!/usr/bin/env node
/**
 * resolve-blocked-apply-queue.mjs
 *
 * Resolves 10 Apply Queue jobs that have LinkedIn URLs (ATS 'linkedin' not supported).
 * Navigates each LinkedIn posting, extracts the real external ATS URL from the
 * "Apply on company website" button, and patches the **URL:** field in the report.
 *
 * Run from project directory:
 *   node resolve-blocked-apply-queue.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const SESSION_PATH = join(PROJECT_DIR, 'data', 'linkedin-session.json');
const REPORTS_DIR  = join(PROJECT_DIR, 'reports');

const JOBS = [
  { num: 2062, report: '2062-synechron-2026-06-09.md',      url: 'https://www.linkedin.com/jobs/view/senior-data-engineer-at-synechron-4424332062' },
  { num: 2063, report: '2063-ut-austin-2026-06-09.md',       url: 'https://www.linkedin.com/jobs/view/senior-data-engineer-at-the-university-of-texas-at-austin-4423084998' },
  { num: 2074, report: '2074-intelliswift-2026-06-09.md',    url: 'https://www.linkedin.com/jobs/view/senior-ai-data-engineer-at-intelliswift-an-ltts-company-4423955816' },
  { num: 2114, report: '2114-citiustech-2026-06-09.md',      url: 'https://www.linkedin.com/jobs/view/senior-data-engineer-at-citiustech-4418767803' },
  { num: 2115, report: '2115-komodo-health-2026-06-09.md',   url: 'https://www.linkedin.com/jobs/view/senior-data-engineer-at-komodo-health-4417433180' },
  { num: 2117, report: '2117-charles-schwab-2026-06-09.md',  url: 'https://www.linkedin.com/jobs/view/senior-data-engineer-at-charles-schwab-4349467795' },
  { num: 2120, report: '2120-collabera-2026-06-09.md',       url: 'https://www.linkedin.com/jobs/view/lead-data-engineer-at-collabera-4424617364' },
  { num: 2216, report: '2216-robert-half-2026-06-09.md',     url: 'https://www.linkedin.com/jobs/view/lead-data-engineer-at-robert-half-4423968105' },
  { num: 2277, report: '2277-tek-ninjas-2026-06-10.md',      url: 'https://www.linkedin.com/jobs/view/senior-data-engineer-at-tek-ninjas-4425691130' },
  { num: 2558, report: '2558-oscar-2026-06-10.md',           url: 'https://www.linkedin.com/jobs/view/staff-data-engineer-at-oscar-4422208755' },
];

async function resolveApplyUrl(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
    await page.waitForSelector(
      '.show-more-less-html, #job-details, .jobs-description, .description__text, .jobs-unified-top-card',
      { timeout: 8000 }
    ).catch(() => {});
  } catch {
    return null;
  }

  const applySelectors = [
    'a.apply-button--offsite[href]',
    '.jobs-apply-button--top-card a[href]',
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
      if (href && href.startsWith('http') && !href.includes('linkedin.com')) return href;
    } catch {}
  }

  // Broad fallback: any off-LinkedIn apply link
  try {
    const found = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href || '';
        const text = (a.innerText || a.textContent || '').toLowerCase();
        if (!href.startsWith('http') || href.includes('linkedin.com')) continue;
        if (text.includes('apply') || a.closest('[class*="apply"]') ||
            a.getAttribute('data-tracking-control-name')?.includes('apply')) {
          return href;
        }
      }
      return null;
    });
    if (found) return found;
  } catch {}

  return null;
}

function patchReportUrl(reportFile, newUrl) {
  const content = readFileSync(reportFile, 'utf-8');
  const patched = content.replace(
    /^\*\*URL:\*\*\s*.+$/m,
    `**URL:** ${newUrl}`
  );
  if (patched === content) {
    console.log('  ⚠️  No **URL:** line found to patch');
    return false;
  }
  writeFileSync(reportFile, patched);
  return true;
}

async function main() {
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

  if (hasSession) console.log('Using saved LinkedIn session.\n');

  let patched = 0;
  let failed  = 0;

  for (const job of JOBS) {
    const reportFile = join(REPORTS_DIR, job.report);
    console.log(`[${job.num}] ${job.report}`);
    console.log(`  LinkedIn: ${job.url}`);

    const page = await context.newPage();
    try {
      const applyUrl = await Promise.race([
        resolveApplyUrl(page, job.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45000)),
      ]);

      if (applyUrl) {
        console.log(`  ✅ Resolved → ${applyUrl}`);
        const ok = patchReportUrl(reportFile, applyUrl);
        if (ok) { console.log(`  ✅ Patched report`); patched++; }
        else failed++;
      } else {
        console.log(`  ⚠️  No external apply URL found (Easy Apply or login-walled) — keeping LinkedIn URL`);
        failed++;
      }
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}`);
      failed++;
    } finally {
      await page.close();
      // Brief delay between jobs
      await new Promise(r => setTimeout(r, 2000 + Math.floor(Math.random() * 2000)));
    }
  }

  await browser.close();
  console.log(`\nDone. Patched: ${patched} / Failed: ${failed}`);
}

main().catch(err => { console.error(err); process.exit(1); });
