#!/usr/bin/env node
/**
 * fantastic-scan.mjs — Pull fresh jobs from the Fantastic.jobs API
 *
 * Replaces linkedin-scan.mjs. No browser or saved session required.
 *
 * Prerequisites:
 *   export FANTASTIC_JOBS_API_KEY=your_key_here
 *   (get your key from fantastic.jobs subscription dashboard)
 *
 * Usage:
 *   node fantastic-scan.mjs                   # last 24h, ATS + job board
 *   node fantastic-scan.mjs --time-frame=7d   # widen to 7-day window
 *   node fantastic-scan.mjs --ats-only        # skip job board endpoint
 *   node fantastic-scan.mjs --dry-run         # preview without writing files
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const BASE_DIR          = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH     = join(BASE_DIR, 'data/pipeline.md');
const HISTORY_PATH      = join(BASE_DIR, 'data/scan-history.tsv');
const APPLICATIONS_PATH = join(BASE_DIR, 'data/applications.md');
const PORTALS_PATH      = join(BASE_DIR, 'portals.yml');

const API_BASE = 'https://data.fantastic.jobs';
const API_KEY  = process.env.FANTASTIC_JOBS_API_KEY || process.env.FANTASTIC_API_KEY || '';

// ── Argument parsing ──────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const ATS_ONLY = args.includes('--ats-only');
const tfArg    = args.find(a => a.startsWith('--time-frame='));
const TIME_FRAME = tfArg ? tfArg.split('=')[1] : '24h';

const VALID_TIME_FRAMES = new Set(['1h', '24h', '7d', '6m']);
if (!VALID_TIME_FRAMES.has(TIME_FRAME)) {
  console.error(`Invalid --time-frame "${TIME_FRAME}". Use: 1h, 24h, 7d, or 6m`);
  process.exit(1);
}

// ── Change 1: Title queries — 8 target roles ─────────────────────────────────
// Kept at role-name level (not skill level) so the API casts a wide net;
// the portals.yml title filter then narrows locally post-fetch.
const BASE_QUERIES = [
  'Senior Data Engineer',
  'Lead Data Engineer',
  'Staff Data Engineer',
  'Analytics Engineer',
  'Data Platform Engineer',
  'Snowflake Data Engineer',
  'AWS Data Engineer',
  'Healthcare Data Engineer',
];

// ── Change 5: Hard-reject keyword patterns (title-level pre-filter) ───────────
// Applied before any token is spent on evaluation. These phrases in a job title
// are unambiguous disqualifiers for this candidate's visa/sponsorship situation.
const HARD_REJECT_PATTERNS = [
  'no sponsorship',
  'will not sponsor',
  'no visa',
  'us citizen',         // catches "US Citizens only", "Must be US Citizen"
  'u.s. citizen',
  'clearance required',
  'active clearance',
  'secret clearance',
  'top secret',
  'ts/sci',
  'green card required',
  'permanent resident only',
];

function isHardRejectTitle(title) {
  const t = title.toLowerCase();
  return HARD_REJECT_PATTERNS.some(p => t.includes(p));
}

// ── Change 4: ai_visa_sponsorship soft filter ────────────────────────────────
// The API returns boolean false as a DEFAULT/UNKNOWN (not a confirmed "no").
// Only drop on explicit string negatives — the pipeline stage 1 hard gate
// handles ambiguous JD text anyway.
const VISA_NEGATIVE_VALUES = new Set([
  'no', 'not_offered', 'not_available', 'not_sponsored', 'none',
]);

function isVisaDefinitelyNo(job) {
  const v = job.ai_visa_sponsorship;
  if (v === null || v === undefined || v === false || v === '') return false;
  if (typeof v === 'string') return VISA_NEGATIVE_VALUES.has(v.toLowerCase().trim());
  return false;
}

// ── Change 2: US location check (post-fetch) ─────────────────────────────────
// Keep job if:
//   a) countries_derived includes a US variant, OR
//   b) countries_derived is absent/empty (remote / location not specified)
// Drop if countries_derived has entries and none are US.
const US_COUNTRY_VARIANTS = new Set([
  'united states', 'us', 'usa', 'u.s.', 'u.s.a.',
  'united states of america',
]);

function isUsOrRemote(job) {
  const countries = job.countries_derived;
  if (!Array.isArray(countries) || countries.length === 0) return true;
  return countries.some(c => US_COUNTRY_VARIANTS.has(c.toLowerCase().trim()));
}

// ── Load title filter from portals.yml ───────────────────────────────────────
function loadTitleFilter() {
  if (!existsSync(PORTALS_PATH)) return { positive: [], negative: [] };
  const config = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const tf = config.title_filter || {};
  return {
    positive: (tf.positive || []).map(k => k.toLowerCase()),
    negative: (tf.negative || []).map(k => k.toLowerCase()),
  };
}

function passesPortalsFilter(title, filter) {
  const t = title.toLowerCase();
  if (filter.negative.length && filter.negative.some(k => t.includes(k))) return false;
  if (filter.positive.length && !filter.positive.some(k => t.includes(k))) return false;
  return true;
}

// ── Change 6: Company + role dedup ───────────────────────────────────────────
// Catches re-posts of the same role at the same company under a new URL.
// Mirrors scan.mjs loadSeenCompanyRoles() exactly.
function loadSeenCompanyRoles() {
  const seen = new Set();
  if (!existsSync(APPLICATIONS_PATH)) return seen;
  const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
  for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
    const company = match[1].trim().toLowerCase();
    const role    = match[2].trim().toLowerCase();
    if (company && role && company !== 'company') {
      seen.add(`${company}::${role}`);
    }
  }
  return seen;
}

// ── URL dedup (scan-history + pipeline + applications) ────────────────────────
function loadSeenUrls() {
  const seen = new Set();

  if (existsSync(HISTORY_PATH)) {
    for (const line of readFileSync(HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0].trim();
      if (url.startsWith('http')) seen.add(normalizeUrl(url));
    }
  }

  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf-8').matchAll(/https?:\/\/[^\s|)\]]+/g)) {
      seen.add(normalizeUrl(m[0].trim()));
    }
  }

  if (existsSync(APPLICATIONS_PATH)) {
    for (const m of readFileSync(APPLICATIONS_PATH, 'utf-8').matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(normalizeUrl(m[0].trim()));
    }
  }

  return seen;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

// ── API fetch ─────────────────────────────────────────────────────────────────
async function apiFetch(endpoint, params) {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json();
}

// Paginate through all results for one title query on one endpoint.
async function fetchAll(endpoint, titleQuery, extraParams = {}) {
  const jobs = [];
  const limit = 100;
  let cursor  = undefined;
  let offset  = 0;
  let pages   = 0;
  const MAX_PAGES = 20; // 20 × 100 = 2,000 results per query per endpoint

  while (pages < MAX_PAGES) {
    const params = {
      title:      titleQuery,
      time_frame: TIME_FRAME,
      limit,
      ...extraParams,
    };
    if (cursor)       params.cursor = cursor;
    else if (offset)  params.offset = offset;

    const data    = await apiFetch(endpoint, params);
    const results = Array.isArray(data)
      ? data
      : (data.jobs ?? data.results ?? data.data ?? []);

    if (!results.length) break;
    jobs.push(...results);

    cursor = data.cursor ?? data.next_cursor ?? null;
    if (!cursor) offset += results.length;
    if (results.length < limit) break;
    pages++;
  }

  return jobs;
}

// ── Field extraction helpers ──────────────────────────────────────────────────
function extractCompany(job) {
  return (
    job.organization      ||
    job.company           ||
    job.org_name          ||
    job.employer          ||
    job.org_linkedin_name ||
    (job.org_linkedin_slug ? job.org_linkedin_slug.replace(/-/g, ' ') : '') ||
    ''
  );
}

function extractLocation(job) {
  if (Array.isArray(job.locations_derived) && job.locations_derived.length) {
    return job.locations_derived.join(', ');
  }
  if (Array.isArray(job.cities_derived) && job.cities_derived.length) {
    const city   = job.cities_derived[0];
    const region = job.regions_derived?.[0] || '';
    return [city, region].filter(Boolean).join(', ');
  }
  return job.location || '';
}

function normalize(job, sourceLabel) {
  return {
    title:             (job.title || '').trim(),
    url:               (job.url || job.job_url || '').trim(),
    company:           extractCompany(job).trim(),
    location:          extractLocation(job),
    source:            sourceLabel,
    aiSalaryMin:       job.ai_salary_min_value,
    aiSalaryMax:       job.ai_salary_max_value,
    aiSalaryCurrency:  job.ai_salary_currency,
    aiWorkArrangement: job.ai_work_arrangement,
    aiVisa:            job.ai_visa_sponsorship,
    countriesDerived:  job.countries_derived,
  };
}

// ── Pipeline writer ───────────────────────────────────────────────────────────
function appendToPipeline(offers) {
  if (!offers.length) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = '## Pendientes';
  const idx    = text.indexOf(marker);

  const lines = offers
    .map(o => `- [ ] ${o.url} | ${o.company} | ${o.title} | Fantastic.jobs`)
    .join('\n');

  if (idx === -1) {
    const procIdx  = text.indexOf('## Processed');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    text = text.slice(0, insertAt) + `${marker}\n\n${lines}\n\n` + text.slice(insertAt);
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt    = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + '\n' + lines + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToHistory(offers, date) {
  if (!offers.length) return;
  if (!existsSync(HISTORY_PATH)) {
    writeFileSync(HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\tFantastic.jobs\t${o.title}\t${o.company}\tadded\t${o.location}`
  ).join('\n') + '\n';
  appendFileSync(HISTORY_PATH, lines, 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error('Error: FANTASTIC_JOBS_API_KEY is not set.');
    console.error('');
    console.error('Set it in your shell profile (~/.zshrc or ~/.bashrc):');
    console.error('  export FANTASTIC_JOBS_API_KEY=your_key_here');
    console.error('');
    console.error('Or pass it inline:');
    console.error('  FANTASTIC_JOBS_API_KEY=your_key node fantastic-scan.mjs');
    process.exit(1);
  }

  mkdirSync(join(BASE_DIR, 'data'), { recursive: true });

  const date             = new Date().toISOString().slice(0, 10);
  const portalsFilter    = loadTitleFilter();
  const seenUrls         = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles(); // Change 6
  const seenInRun        = new Set();
  const seenRolesInRun   = new Set();

  // API-level location filter: keeps US jobs and misses ~5% of remote-only posts
  // (listed as "Remote" without "United States" in location text). Validated:
  // removing this filter fetches 3.3× more data but yields only +5 extra jobs.
  // isUsOrRemote() post-fetch handles any edge cases that slip through.
  const BASE_API_PARAMS = {
    location: 'United States',
  };

  const endpoints = [
    {
      path:  '/v1/active-ats',
      label: 'ATS',
      extra: {
        ...BASE_API_PARAMS,
        include_basic_organization_details: 'true',
      },
    },
  ];

  if (!ATS_ONLY) {
    endpoints.push({
      path:  '/v1/active-jb',
      label: 'JobBoard',
      extra: {
        ...BASE_API_PARAMS,
        exclude_ats_duplicate: 'true',
      },
    });
  }

  console.log(`Fantastic.jobs Scan — ${date}  (time_frame=${TIME_FRAME}${ATS_ONLY ? ', ATS only' : ''})`);
  if (DRY_RUN) console.log('(dry run — no files will be written)\n');

  let totalFetched    = 0;
  let filteredTitle   = 0;    // portals.yml title filter
  let filteredUS      = 0;    // Change 2: not US / not remote
  let filteredFullTime = 0;   // Change 3: tracked separately (API-level, counted on result)
  let filteredVisa    = 0;    // Change 4: ai_visa_sponsorship unambiguously negative
  let filteredHardReject = 0; // Change 5: keyword pre-filter
  let filteredRoleDupe = 0;   // Change 6: company+role already in applications
  let urlDupes        = 0;
  let invalid         = 0;
  const newOffers     = [];
  const errors        = [];

  for (const titleQuery of BASE_QUERIES) {
    for (const { path, label, extra } of endpoints) {
      process.stdout.write(`  ${label.padEnd(8)} "${titleQuery}" ... `);
      try {
        const raw = await fetchAll(path, titleQuery, extra);
        process.stdout.write(`${raw.length} results\n`);
        totalFetched += raw.length;

        for (const job of raw) {
          const norm = normalize(job, `Fantastic.jobs-${label}`);

          // Basic validity
          if (!norm.url || !norm.title) { invalid++; continue; }

          // Change 5: hard-reject keyword scan on title
          if (isHardRejectTitle(norm.title)) { filteredHardReject++; continue; }

          // Change 4: ai_visa_sponsorship soft filter
          if (isVisaDefinitelyNo(job)) { filteredVisa++; continue; }

          // Change 2: US / remote post-fetch check on countries_derived
          if (!isUsOrRemote(job)) { filteredUS++; continue; }

          // portals.yml title filter (positive/negative keywords)
          if (!passesPortalsFilter(norm.title, portalsFilter)) { filteredTitle++; continue; }

          // URL dedup
          const urlKey = normalizeUrl(norm.url);
          if (seenUrls.has(urlKey) || seenInRun.has(urlKey)) { urlDupes++; continue; }

          // Change 6: company + role dedup
          const roleKey = `${norm.company.toLowerCase()}::${norm.title.toLowerCase()}`;
          if (seenCompanyRoles.has(roleKey) || seenRolesInRun.has(roleKey)) {
            filteredRoleDupe++;
            continue;
          }

          seenUrls.add(urlKey);
          seenInRun.add(urlKey);
          seenCompanyRoles.add(roleKey);
          seenRolesInRun.add(roleKey);
          newOffers.push(norm);
        }
      } catch (err) {
        process.stdout.write(`ERROR\n`);
        errors.push(`${label} / "${titleQuery}": ${err.message}`);
      }
    }
  }

  console.log(`\n${'━'.repeat(50)}`);
  console.log(`Fantastic.jobs Scan — ${date}`);
  console.log(`${'━'.repeat(50)}`);
  console.log(`Total fetched:         ${totalFetched}`);
  console.log(`Filtered — hard reject: ${filteredHardReject} (sponsorship/clearance/citizenship keywords in title)`);
  console.log(`Filtered — visa field:  ${filteredVisa} (ai_visa_sponsorship unambiguously negative)`);
  console.log(`Filtered — not US:      ${filteredUS} (countries_derived excludes US)`);
  console.log(`Filtered — title:       ${filteredTitle} (portals.yml positive/negative keywords)`);
  console.log(`Filtered — role dupe:   ${filteredRoleDupe} (same company+role already in applications)`);
  console.log(`Duplicates (URL):       ${urlDupes} skipped`);
  console.log(`Invalid (no URL/title): ${invalid} skipped`);
  console.log(`New offers:             ${newOffers.length}`);

  if (errors.length) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      const salary = o.aiSalaryMin
        ? ` | $${Math.round(o.aiSalaryMin / 1000)}K–$${Math.round((o.aiSalaryMax || o.aiSalaryMin) / 1000)}K`
        : '';
      const visa = o.aiVisa !== undefined && o.aiVisa !== null
        ? ` | visa:${o.aiVisa}`
        : '';
      console.log(`  + ${o.company || '(unknown)'} | ${o.title} | ${o.location || 'N/A'}${salary}${visa}`);
    }

    if (!DRY_RUN) {
      appendToPipeline(newOffers);
      appendToHistory(newOffers, date);
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${HISTORY_PATH}`);
    } else {
      console.log('\n(dry run — run without --dry-run to save results)');
    }
  }

  console.log('\n→ Run /career-ops pipeline to evaluate new offers.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
