#!/usr/bin/env node
/**
 * backfill-h1b.mjs — retrofit canonical H1B tags into legacy Notes.
 *
 * Scans data/applications.md and for every Evaluated/Applied row whose Notes
 * don't already parse as one of {High,Medium,Low,No,Unverified,Unreachable,N/A},
 * looks up the company in data/h1b-cache.tsv and appends the appropriate
 * canonical tag so the dashboard H1B column stops showing `?`.
 *
 * Behaviour is visa-aware and mirrors the runtime:
 *   - Sponsorship users → looks up LCA count, appends `H-1B <label> (N LCAs) (backfilled)`
 *   - Non-sponsorship users → appends `Sponsorship: not required (backfilled)` on every unrecognised row
 *
 * Idempotent: a second run does nothing (rows already tagged are skipped).
 *
 * Usage:
 *   node backfill-h1b.mjs --dry-run    # report what would change
 *   node backfill-h1b.mjs              # apply (creates .bak alongside)
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLICATIONS_MD = join(__dirname, 'data', 'applications.md');
const H1B_CACHE       = join(__dirname, 'data', 'h1b-cache.tsv');
const PROFILE_YML     = join(__dirname, 'config', 'profile.yml');
const DRY_RUN         = process.argv.includes('--dry-run');

function userNeedsSponsorship() {
  if (!existsSync(PROFILE_YML)) return true;
  const m = readFileSync(PROFILE_YML, 'utf-8').match(/visa_status\s*:\s*['"]?([^'"\n]+)['"]?/);
  if (!m) return true;
  return !/no sponsorship needed|us citizen|green card|permanent resident/.test(m[1].toLowerCase());
}

function toSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Mirror of parseH1B (dashboard-server.mjs:391) + parseH1BLabel (queue-eligibility.mjs:44).
// Returns a non-null value → row is already tagged, skip it.
function parseH1B(notes) {
  if (!notes) return null;
  const lower = notes.toLowerCase();
  if (notes.match(/(\d+)\+?\s*(?:cumulative\s+)?(?:h1b\s+)?lca/i)) return 'lca-count';
  if (lower.includes('unreachable')) return 'Unreachable';
  if (lower.match(/h[-\s]?1[-\s]?b\s+(confirmed|unverified|likely|unlikely|friendly|low|no|hard)\b/)) return 'compact';
  if (lower.includes('strong h-1b') || lower.includes('confirmed h-1b') ||
      lower.includes('h-1b confirmed') || lower.includes('h1b confirmed') ||
      lower.includes('fortune 500 sponsor') || lower.includes('sponsor-capable')) return 'High';
  if (lower.includes('h-1b likely') || lower.includes('h1b likely') ||
      lower.includes('h-1b friendly') || lower.includes('h1b friendly')) return 'Medium';
  if (lower.includes('no h-1b') || lower.includes('no h1b') || lower.includes('no lca') ||
      lower.includes('no sponsorship') || lower.includes('no sponsor') ||
      lower.includes('limited h-1b') || lower.includes('limited h1b') ||
      lower.includes('us citizen') || lower.includes('green card only')) return 'No';
  if (lower.includes('h-1b unverified') || lower.includes('h1b unverified') ||
      lower.includes('sponsorship unverified') || lower.includes('verify h-1b') ||
      lower.includes('verify h1b') || lower.includes('sponsorship unclear') ||
      lower.includes('h-1b uncertain') || lower.includes('h-1b unknown') ||
      lower.includes('h1b unknown')) return 'Unverified';
  if (lower.includes('sponsorship: not required') || lower.includes('sponsorship not required')) return 'N/A';
  return null;
}

function loadH1bCache() {
  const cache = new Map();
  if (!existsSync(H1B_CACHE)) return cache;
  for (const line of readFileSync(H1B_CACHE, 'utf-8').split('\n')) {
    const p = line.split('\t');
    if (p.length < 8 || p[0] === 'company_slug' || !p[0]) continue;
    const slug = p[0].trim();
    const count = parseInt(p[5]) || 0;
    // Append-only file → latest entry wins for a given slug
    cache.set(slug, count);
  }
  return cache;
}

function tagFromCount(count) {
  if (count >= 50) return `H-1B confirmed (${count} LCAs)`;
  if (count >= 10) return `H-1B likely (${count} LCAs)`;
  if (count >= 1)  return `H-1B low (${count} LCAs)`;
  return 'No H-1B (0 LCAs)';
}

function main() {
  if (!existsSync(APPLICATIONS_MD)) {
    console.error(`Not found: ${APPLICATIONS_MD}`);
    process.exit(1);
  }

  const needsSponsorship = userNeedsSponsorship();
  console.log(`visa_status → ${needsSponsorship ? 'needs sponsorship (using LCA counts)' : 'no sponsorship needed (using "Sponsorship: not required")'}`);

  const cache = loadH1bCache();
  console.log(`h1b-cache entries: ${cache.size}`);

  const raw = readFileSync(APPLICATIONS_MD, 'utf-8');
  const lines = raw.split('\n');

  let alreadyTagged = 0;
  let backfilled    = 0;
  let noCacheHit    = 0;
  let skippedMalformed = 0;
  const missingCompanies = [];
  const malformedRows = [];
  const sampleChanges = [];

  const outLines = lines.map((line, idx) => {
    if (!line.startsWith('| ') || line.startsWith('|---') || line.startsWith('| #')) return line;
    const parts = line.split('|');
    if (parts.length < 11) return line;

    // Defensive: some legacy rows have anomalous column counts or shifted schema
    // (e.g., an extra id column between # and Date). Skip and log them rather
    // than corrupt them with a misplaced tag.
    const isDateLike = s => /^\s*20\d{2}-\d{2}-\d{2}\s*$/.test(s);
    if (isDateLike(parts[3]) || !isDateLike(parts[2])) {
      skippedMalformed++;
      if (malformedRows.length < 10) malformedRows.push(`  L${idx + 1}: ${line.substring(0, 140)}`);
      return line;
    }

    const company = parts[3].trim();
    // If Notes contains `|`, parts.length > 11 — reconstruct by joining tail.
    const notes = parts.slice(9, parts.length - 1).join('|').trim();

    if (parseH1B(notes)) { alreadyTagged++; return line; }

    let newTag;
    if (needsSponsorship) {
      const slug = toSlug(company);
      const count = cache.get(slug);
      if (count === undefined) {
        noCacheHit++;
        if (missingCompanies.length < 20) missingCompanies.push(company);
        return line; // can't backfill without cache
      }
      newTag = `${tagFromCount(count)} (backfilled)`;
    } else {
      newTag = 'Sponsorship: not required (backfilled)';
    }

    // Append the tag to the existing Notes. Idempotent because parseH1B will
    // recognise the added tag on the next run.
    const separator = notes && !notes.endsWith('.') && !notes.endsWith('·') ? ' · ' : ' ';
    const newNotes = ` ${notes}${separator}${newTag} `;
    // Preserve original column count by collapsing all tail cells into notes.
    const rebuilt = [...parts.slice(0, 9), newNotes, ''];
    backfilled++;
    if (sampleChanges.length < 5) {
      sampleChanges.push({ company, before: notes.substring(0, 100), tag: newTag });
    }
    return rebuilt.join('|');
  });

  console.log('');
  console.log(`Already tagged (skipped):  ${alreadyTagged}`);
  console.log(`Backfilled with new tag:   ${backfilled}`);
  console.log(`No cache hit (left alone): ${noCacheHit}`);
  console.log(`Malformed rows (skipped):  ${skippedMalformed}`);

  if (sampleChanges.length > 0) {
    console.log('');
    console.log('Sample changes (first 5) — what the backfill would append:');
    for (const s of sampleChanges) {
      console.log(`  ${s.company}`);
      console.log(`    before: ${s.before}${s.before.length >= 100 ? '...' : ''}`);
      console.log(`    appended: ${s.tag}`);
    }
  }

  if (malformedRows.length > 0) {
    console.log('');
    console.log('Sample malformed rows (first 10) — these have anomalous column layout:');
    for (const r of malformedRows) console.log(r);
  }

  if (missingCompanies.length > 0) {
    console.log('');
    console.log('Sample companies with no cache entry (first 20):');
    for (const c of missingCompanies) console.log(`  · ${c}`);
  }

  if (DRY_RUN) {
    console.log('');
    console.log('DRY RUN — applications.md not modified. Re-run without --dry-run to apply.');
    return;
  }

  if (backfilled === 0) {
    console.log('');
    console.log('Nothing to write.');
    return;
  }

  const backup = APPLICATIONS_MD + '.bak';
  copyFileSync(APPLICATIONS_MD, backup);
  writeFileSync(APPLICATIONS_MD, outLines.join('\n'));
  console.log('');
  console.log(`Wrote ${APPLICATIONS_MD}`);
  console.log(`Backup at ${backup}`);
}

main();
