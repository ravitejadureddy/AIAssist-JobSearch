/**
 * queue-eligibility.mjs — shared helper for "is this report num in the Apply Queue
 * AND eligible for semantic resume validation (H1B High/Medium/Low)?"
 *
 * SOURCE OF TRUTH for queue + H1B logic: dashboard-server.mjs (parseH1B and the
 * Apply-Queue filter on line 807). Logic is duplicated here intentionally — this
 * module avoids importing from dashboard-server.mjs to keep the helper light-weight
 * and call-side-effect-free. If dashboard logic changes, update both.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = __dirname;
const APPLICATIONS_MD = join(CAREER_OPS, 'data/applications.md');
const PROFILE_YML = join(CAREER_OPS, 'config', 'profile.yml');

// Read visa_status from config/profile.yml to decide whether H-1B-label gating
// applies. Adopters who don't need sponsorship (US Citizens, Green Card holders,
// etc.) shouldn't have eligibility blocked by missing H-1B labels — for them,
// eligibility is purely score+queue based. Safe-default = "needs sponsorship".
function userNeedsSponsorship() {
  if (!existsSync(PROFILE_YML)) return true;
  const m = readFileSync(PROFILE_YML, 'utf-8').match(/visa_status\s*:\s*['"]?([^'"\n]+)['"]?/);
  if (!m) return true;
  return !/no sponsorship needed|us citizen|green card|permanent resident/.test(m[1].toLowerCase());
}

// Mirror of dashboard-server.mjs:66 — earliest date that still counts as Apply Queue.
export function businessDayCutoff(n = 3) {
  const d = new Date();
  let bizDaysFound = 0;
  while (true) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) { bizDaysFound++; if (bizDaysFound >= n) break; }
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

// Mirror of dashboard-server.mjs:293 — same label categories (High / Medium / Low / No / Unverified / Unreachable).
function parseH1BLabel(notes) {
  if (!notes) return null;
  const lower = notes.toLowerCase();

  const lcaMatch = notes.match(/(\d+)\+?\s*(?:cumulative\s+)?(?:h1b\s+)?lca/i);
  const lcaCount = lcaMatch ? parseInt(lcaMatch[1]) : null;
  if (lcaCount !== null) {
    if (lcaCount >= 50) return 'High';
    if (lcaCount >= 10) return 'Medium';
    if (lcaCount >= 1)  return 'Low';
    return 'No';
  }
  if (lower.includes('h-1b unreachable') || lower.includes('h1b unreachable') || lower.includes('unreachable')) {
    return 'Unreachable';
  }
  const compactM = lower.match(/h[-\s]?1[-\s]?b\s+(confirmed|unverified|likely|unlikely|friendly|low|no|hard)\b/);
  if (compactM) {
    const lbl = compactM[1];
    if (lbl === 'confirmed') return 'High';
    if (lbl === 'likely' || lbl === 'friendly') return 'Medium';
    if (lbl === 'unverified') return 'Unverified';
    return 'No';
  }
  if (lower.includes('strong h-1b') || lower.includes('confirmed h-1b') ||
      lower.includes('h-1b confirmed') || lower.includes('h1b confirmed') ||
      lower.includes('fortune 500 sponsor') || lower.includes('sponsor-capable')) {
    return 'High';
  }
  if (lower.includes('h-1b likely') || lower.includes('h1b likely') ||
      lower.includes('h-1b friendly') || lower.includes('h1b friendly')) {
    return 'Medium';
  }
  if (lower.includes('no h-1b') || lower.includes('no h1b') || lower.includes('no lca') ||
      lower.includes('no sponsorship') || lower.includes('no sponsor') ||
      lower.includes('limited h-1b') || lower.includes('limited h1b') ||
      lower.includes('us citizen') || lower.includes('green card only')) {
    return 'No';
  }
  if (lower.includes('h-1b unverified') || lower.includes('h1b unverified') ||
      lower.includes('sponsorship unverified') || lower.includes('verify h-1b') ||
      lower.includes('verify h1b') || lower.includes('sponsorship unclear') ||
      lower.includes('h-1b uncertain')) {
    return 'Unverified';
  }
  return null;
}

// Parse the report num out of the Report column (which holds "[num](path)") or the # column.
function parseReportNumFromRow(numCell, reportCell) {
  // Report cell looks like: [13548](../reports/13548-foo-2026-06-23.md)
  const m = reportCell?.match(/\[(\d+)\]/);
  if (m) return m[1];
  // Fallback to # column
  const n = String(numCell || '').replace(/[^0-9]/g, '');
  return n || null;
}

let _cachedQueue = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 5000;

/**
 * Read applications.md and build a map of all Apply Queue rows.
 * Apply Queue = Evaluated + scoreVal >= 3.5 + date >= 3-business-day cutoff.
 * Returns Map<reportNum, {num, date, company, role, scoreVal, status, h1bLabel}>.
 */
export function loadQueueMap() {
  const now = Date.now();
  if (_cachedQueue && (now - _cachedAt) < CACHE_TTL_MS) return _cachedQueue;

  if (!existsSync(APPLICATIONS_MD)) { _cachedQueue = new Map(); _cachedAt = now; return _cachedQueue; }
  const md = readFileSync(APPLICATIONS_MD, 'utf-8');
  const lines = md.split('\n').filter(l => l.startsWith('|') && !l.startsWith('|---'));

  const cutoff = businessDayCutoff(3);
  const queue = new Map();

  for (const line of lines) {
    const cells = line.split('|').map(s => s.trim());
    if (cells.length < 10) continue;
    // | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
    const [, numCell, date, company, role, scoreStr, status, , reportCell, notes] = cells;
    if (status !== 'Evaluated') continue;
    const scoreMatch = scoreStr?.match(/(\d+\.?\d*)\s*\/\s*5/);
    const scoreVal = scoreMatch ? parseFloat(scoreMatch[1]) : NaN;
    if (isNaN(scoreVal) || scoreVal < 3.5) continue;
    if (date && date < cutoff) continue;
    const reportNum = parseReportNumFromRow(numCell, reportCell);
    if (!reportNum) continue;
    queue.set(reportNum, {
      num: reportNum,
      date,
      company,
      role,
      scoreVal,
      status,
      h1bLabel: parseH1BLabel(notes),
    });
  }
  _cachedQueue = queue;
  _cachedAt = now;
  return queue;
}

/**
 * Returns { eligible: bool, reason: string, row: object|null } for a given report num.
 * Eligible iff in Apply Queue AND h1bLabel ∈ {High, Medium, Low}.
 */
export function isQueueEligible(reportNum) {
  const queue = loadQueueMap();
  const row = queue.get(String(reportNum));
  if (!row) return { eligible: false, reason: 'not_in_apply_queue', row: null };
  // H-1B label gate only applies if the user needs sponsorship. Adopters who don't
  // (US Citizens, Green Card holders, etc.) get score+queue-based eligibility instead.
  if (userNeedsSponsorship() && !['High', 'Medium', 'Low'].includes(row.h1bLabel)) {
    return { eligible: false, reason: `h1b_label_${row.h1bLabel || 'unknown'}`, row };
  }
  return { eligible: true, reason: userNeedsSponsorship() ? 'in_queue_h1b_sponsor' : 'in_queue_no_sponsorship_needed', row };
}

// CLI mode for spot-checking: node queue-eligibility.mjs [num]
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg) {
    const result = isQueueEligible(arg);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const queue = loadQueueMap();
    const needsSponsor = userNeedsSponsorship();
    const eligible = needsSponsor
      ? [...queue.values()].filter(r => ['High','Medium','Low'].includes(r.h1bLabel))
      : [...queue.values()];
    console.log(`Apply Queue total: ${queue.size}`);
    console.log(`Visa policy: ${needsSponsor ? 'needs sponsorship — H-1B label gate applies' : 'no sponsorship needed — H-1B label gate skipped'}`);
    console.log(`Eligible for validation: ${eligible.length}`);
    if (needsSponsor) {
      const byLabel = eligible.reduce((acc, r) => { acc[r.h1bLabel] = (acc[r.h1bLabel] || 0) + 1; return acc; }, {});
      console.log('H-1B label breakdown:', byLabel);
    }
  }
}
