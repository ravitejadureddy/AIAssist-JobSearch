#!/usr/bin/env node
/**
 * linkedin-scan.mjs — LinkedIn job scanner using a saved Playwright session.
 *
 * Searches LinkedIn for target roles posted in the last N days, deduplicates
 * against scan-history.tsv + pipeline.md, and appends new jobs to pipeline.md.
 *
 * Prerequisites: node linkedin-login.mjs  (once, saves data/linkedin-session.json)
 *
 * Usage:
 *   node linkedin-scan.mjs              → last 7 days, 25 results per query
 *   node linkedin-scan.mjs --days=14    → widen to 2-week window
 *   node linkedin-scan.mjs --max=50     → more results per query
 *   node linkedin-scan.mjs --dry-run    → print new jobs without writing files
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

chromium.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_PATH = path.join(__dirname, 'data', 'linkedin-session.json');
const HISTORY_PATH = path.join(__dirname, 'data', 'scan-history.tsv');
const PIPELINE_PATH = path.join(__dirname, 'data', 'pipeline.md');
const PORTALS_PATH  = path.join(__dirname, 'portals.yml');

// ── Argument parsing ──────────────────────────────────────────────────────────
const daysArg  = process.argv.find(a => a.startsWith('--days='));
const maxArg   = process.argv.find(a => a.startsWith('--max='));
const pagesArg = process.argv.find(a => a.startsWith('--pages='));
const dryRun   = process.argv.includes('--dry-run');
const DAYS     = daysArg  ? parseInt(daysArg.split('=')[1],  10) : 2;  // past 48h default; catches boundary jobs missed by single daily run. Override with --days=N
const MAX_HITS = maxArg   ? parseInt(maxArg.split('=')[1],   10) : 25; // results per page
const NUM_PAGES = pagesArg ? parseInt(pagesArg.split('=')[1], 10) : 40; // max pages before stopping (LinkedIn caps at ~40 pages = 1000 results)

if (!fs.existsSync(SESSION_PATH)) {
  console.error('No LinkedIn session found. Run: node linkedin-login.mjs');
  process.exit(1);
}

// ── Title filter from portals.yml ─────────────────────────────────────────────
const portals     = yaml.load(fs.readFileSync(PORTALS_PATH, 'utf8'));
const tf          = portals.title_filter || {};
const positiveKws = (tf.positive || []).map(k => k.toLowerCase());
const negativeKws = (tf.negative || []).map(k => k.toLowerCase());

function passesFilter(title) {
  const t = title.toLowerCase();
  if (negativeKws.length && negativeKws.some(k => t.includes(k))) return false;
  if (positiveKws.length && !positiveKws.some(k => t.includes(k))) return false;
  return true;
}

// ── Dedup set (history + pipeline) ───────────────────────────────────────────
const seenUrls = new Set();

if (fs.existsSync(HISTORY_PATH)) {
  for (const line of fs.readFileSync(HISTORY_PATH, 'utf8').split('\n')) {
    const url = line.split('\t')[0].trim();
    if (url.startsWith('http')) seenUrls.add(normalizeUrl(url));
  }
}
if (fs.existsSync(PIPELINE_PATH)) {
  for (const m of fs.readFileSync(PIPELINE_PATH, 'utf8').matchAll(/https?:\/\/[^\s|)\]]+/g)) {
    seenUrls.add(normalizeUrl(m[0].trim()));
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('linkedin.com') && u.pathname.includes('/jobs/view/')) {
      return u.origin + u.pathname.replace(/\/$/, '');
    }
    return url.split('?')[0];
  } catch {
    return url;
  }
}

// ── Target search queries ─────────────────────────────────────────────────────
// Three title-based sub-queries × 2 passes (broad + salary-filtered) = 6 pools.
// Skills (Snowflake, AWS, Python, SQL) are intentionally excluded from the query:
// they limit results to JDs that explicitly name those tools, missing many well-matched
// roles where the recruiter wrote a generic JD. Stack fit is evaluated by the pipeline
// scoring step which reads the full JD — not by the LinkedIn search query.
// Each pool is capped at ~128 results by LinkedIn's API, giving ~768 unique candidates
// vs the previous ~256 from a single combined query.
const BASE_QUERIES = [
  '"Senior Data Engineer"',
  '"Lead Data Engineer"',
  '"Analytics Engineer"',
];

const QUERIES = BASE_QUERIES.flatMap(q => [
  { q, salaryFilter: false },  // broad pass — all matching jobs
  { q, salaryFilter: true },   // salary-filtered pass — different ranking, different pool
]);

// ── Build LinkedIn internal API URL ──────────────────────────────────────────
// Uses voyagerJobsDashJobCards — the same API LinkedIn's own frontend calls.
// URL format reverse-engineered from captured browser traffic.
function buildApiUrl(keywords, start = 0, salaryFilter = false) {
  // encodeURIComponent leaves ( and ) unencoded by spec — LinkedIn requires them as %28/%29
  const encodedKw = encodeURIComponent(keywords).replace(/\(/g, '%28').replace(/\)/g, '%29');
  // Salary filter f_SA_id_226001:272015 = $100K–$200K+ range from browser URL
  // Adding it changes LinkedIn's ranking, surfacing a different ~150-job pool
  const salaryPart = salaryFilter ? ',salaryBucketV2:List(f_SA_id_226001%3A272015)' : '';
  const timeFilter = DAYS > 0 ? `,selectedFilters:(timePostedRange:List(r${DAYS * 86_400})${salaryPart})` : (salaryFilter ? `,selectedFilters:(${salaryPart.slice(1)})` : '');
  const queryValue = `(origin:JOB_SEARCH_PAGE_JOB_FILTER,keywords:${encodedKw},locationUnion:(geoId:103644278)${timeFilter},spellCorrectionEnabled:true)`;
  return `https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards`
    + `?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220`
    + `&count=${MAX_HITS}`
    + `&q=jobSearch`
    + `&query=${queryValue}`
    + `&sortBy=DD`
    + `&start=${start}`;
}

// ── Call the API from inside the browser (inherits session cookies + CSRF) ───
async function fetchJobsFromApi(page, keywords, start, salaryFilter = false) {
  const apiUrl = buildApiUrl(keywords, start, salaryFilter);
  return page.evaluate(async (url) => {
    const csrf = document.cookie.split(';').map(c => c.trim())
      .find(c => c.startsWith('JSESSIONID='))?.split('=')[1]?.replace(/"/g, '') || '';
    try {
      const res = await fetch(url, {
        headers: {
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
        },
        credentials: 'include',
      });
      if (!res.ok) return { error: res.status, jobs: [] };
      const data = await res.json();

      const jobs = [];
      // included[] contains JobPostingCard items — each has title, company, and job ID
      for (const item of (data.included || [])) {
        if (!(item.$type || '').endsWith('JobPostingCard')) continue;
        const title   = item.jobPostingTitle || item.title?.text || '';
        const company = item.primaryDescription?.text || '';
        // jobPostingUrn = "urn:li:fsd_jobPosting:1234567890"
        const jobId   = (item.jobPostingUrn || item.entityUrn || '').split(':').pop();
        if (!jobId || !title || !/^\d+$/.test(jobId)) continue;
        jobs.push({ title: title.trim(), company: company.trim(), url: `https://www.linkedin.com/jobs/view/${jobId}` });
      }
      return { jobs, total: data.data?.paging?.total ?? 0 };
    } catch (e) {
      return { error: e.message, jobs: [] };
    }
  }, apiUrl);
}

// ── Human-like timing helpers ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function humanPause(minMs = 1500, maxMs = 4000) {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

// ── Main scan ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',  // key flag: removes automation hint
  ],
});

const context = await browser.newContext({
  storageState: SESSION_PATH,
  // Realistic desktop viewport + UA — matches what a real Chrome on macOS sends
  viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  locale: 'en-US',
  timezoneId: 'America/Chicago',
  // Realistic hardware concurrency + device memory
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
});

// Override automation-revealing JS properties (belt-and-suspenders with stealth plugin)
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  window.chrome = { runtime: {} };
});

const page = await context.newPage();

const today   = new Date().toISOString().slice(0, 10);
const newJobs = [];

console.log(`LinkedIn Scan — ${today} (${DAYS > 0 ? `last ${DAYS} days` : 'all-time, sorted by date'})\n`);

// Navigate once to LinkedIn jobs to establish session and load CSRF cookie
await page.goto('https://www.linkedin.com/jobs/', { waitUntil: 'domcontentloaded', timeout: 35_000 });
await humanPause(2000, 3000);

for (const querySpec of QUERIES) {
  const label = querySpec.salaryFilter ? '[salary-filtered pass]' : '[broad pass]';
  process.stdout.write(`Searching ${label}: "${querySpec.q}"… `);

  let totalHits = 0;
  let totalAdded = 0;
  const PAGE_CAP = NUM_PAGES * MAX_HITS;

  for (let start = 0; start < PAGE_CAP; start += MAX_HITS) {
    try {
      const result = await fetchJobsFromApi(page, querySpec.q, start, querySpec.salaryFilter);

      if (result.error) {
        console.log(`\n  API error at start=${start}: ${result.error}`);
        break;
      }
      if (result.jobs.length === 0) break; // no more results

      totalHits += result.jobs.length;
      for (const job of result.jobs) {
        const norm = normalizeUrl(job.url);
        if (seenUrls.has(norm)) continue;
        if (!passesFilter(job.title)) continue;
        seenUrls.add(norm);
        newJobs.push({ ...job, url: norm, query: querySpec.q });
        totalAdded++;
      }

      process.stdout.write(` [p${start / MAX_HITS + 1}:${totalHits}]`);
      await humanPause(1500, 3000); // polite inter-page pause
    } catch (err) {
      console.log(`\n  start=${start} FAILED (${err.message.slice(0, 60)})`);
      break;
    }
  }
  console.log(`\n  → ${totalHits} found, ${totalAdded} new`);
  await humanPause(2000, 4000);
}

await browser.close();

// ── Write results ─────────────────────────────────────────────────────────────
if (newJobs.length === 0) {
  console.log('\nNo new LinkedIn jobs found.');
  process.exit(0);
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`New jobs: ${newJobs.length}\n`);
for (const j of newJobs) {
  console.log(`  + ${j.company || '(unknown)'} | ${j.title}`);
  console.log(`    ${j.url}`);
}

if (dryRun) {
  console.log('\n[dry-run] No files written.');
  process.exit(0);
}

// Append to pipeline.md Pending section
const pipelineContent = fs.readFileSync(PIPELINE_PATH, 'utf8');
const pendingMarker   = /^## (Pending|Pendientes)\n/m;
const pendingLines    = newJobs.map(j =>
  `- [ ] ${j.url} | ${j.company || ''} | ${j.title} | LinkedIn`
).join('\n');

let updatedPipeline;
if (pendingMarker.test(pipelineContent)) {
  updatedPipeline = pipelineContent.replace(pendingMarker, match => `${match}${pendingLines}\n`);
} else {
  updatedPipeline = `${pipelineContent}\n## Pending\n${pendingLines}\n`;
}
fs.writeFileSync(PIPELINE_PATH, updatedPipeline);

// Append to scan-history.tsv
const historyLines = newJobs.map(j =>
  `${j.url}\t${today}\tLinkedIn — ${j.query}\t${j.title}\t${j.company || ''}\tadded`
).join('\n');
const needsNewline = fs.existsSync(HISTORY_PATH) &&
  !fs.readFileSync(HISTORY_PATH, 'utf8').endsWith('\n');
fs.appendFileSync(HISTORY_PATH, (needsNewline ? '\n' : '') + historyLines + '\n');

console.log(`\n✅ Appended ${newJobs.length} jobs to pipeline.md`);
console.log('→ Run /career-ops pipeline to evaluate them.');
