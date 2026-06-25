#!/usr/bin/env node
/**
 * dashboard-server.mjs — Local job dashboard at http://localhost:3000
 *
 * Default view: Apply Queue (Evaluated, score ≥ 3.5)
 * Toggle:       Full history (all statuses except SKIP/Discarded, score ≥ 3.5)
 *
 * Usage:
 *   node dashboard-server.mjs
 *   node dashboard-server.mjs --port 4000
 */

import http from 'http';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, watch } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import { fillAgent } from './fill-agent.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3000;
const HOST = '127.0.0.1';

// Fill Agent — try to connect to Chrome CDP on startup (non-blocking)
let agentStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
fillAgent.on(ev => {
  if (ev.type === 'connected')    { agentStatus = 'connected';    broadcastSSE({ type: 'agent', status: 'connected' }); }
  if (ev.type === 'disconnected') { agentStatus = 'disconnected'; broadcastSSE({ type: 'agent', status: 'disconnected' }); }
  if (ev.type === 'filling')      { broadcastSSE({ type: 'agent', status: 'filling', url: ev.url, ats: ev.ats }); }
  if (ev.type === 'filled')       { broadcastSSE({ type: 'agent', status: 'filled', url: ev.url, ats: ev.ats, outcome: ev.result?.outcome }); }
});
fillAgent.connect().then(ok => { if (!ok) agentStatus = 'disconnected'; });

// Retry fill-agent connection every 3 s until Chrome is ready
const agentRetry = setInterval(async () => {
  if (fillAgent.connected) { clearInterval(agentRetry); return; }
  const ok = await fillAgent.connect();
  if (ok) { agentStatus = 'connected'; broadcastSSE({ type: 'agent', status: 'connected' }); clearInterval(agentRetry); }
}, 3000);

// Cover letter generation — in-memory job tracker
const coverLetterJobs = new Map(); // num → { status: 'generating'|'ready'|'error', outputFolder?, error? }

// PDF backfill — auto-started on server startup, tracks progress via SSE
let pdfBackfillProc  = null;
let pdfBackfillStats = { total: 0, done: 0, failed: 0, running: false, pass: 0 };

// SSE clients for server → browser shutdown signal
const sseClients = new Set();

// Heartbeat — updated by browser pings; server shuts down when pings stop
let lastPing = Date.now();
const PING_INTERVAL_MS = 3000;
const PING_TIMEOUT_MS = 10000; // 10s — shut down shortly after browser tab closes
const GRACE_PERIOD_MS = 20000; // wait before starting the watchdog

function broadcastSSE(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const client of sseClients) { try { client.write(data); } catch {} }
}

// ─── Live tick updates — fs.watch on output/ and data/apply-status/ ──────────
// When validate-resume.mjs writes output/{slug}/validation.json, broadcast SSE
// so the dashboard updates the row's tick in place — no refresh needed.
// Same for smart-apply.mjs / fill-agent.mjs writing data/apply-status/{num}.json.
//
// fs.watch fires multiple times per write (atomic-write pattern) — debounce per
// num/file to coalesce into a single broadcast. macOS supports {recursive:true}.
const _liveDebounce = new Map();
function debouncedBroadcast(key, ms, fn) {
  if (_liveDebounce.has(key)) clearTimeout(_liveDebounce.get(key));
  _liveDebounce.set(key, setTimeout(() => { _liveDebounce.delete(key); fn(); }, ms));
}

// Module-level refs so the watchers aren't garbage-collected after setup returns.
const _liveWatchers = [];

function setupLiveTickWatchers() {
  const outputDir = join(CAREER_OPS, 'output');
  const statusDir = join(CAREER_OPS, 'data', 'apply-status');
  mkdirSync(statusDir, { recursive: true });

  // Tick B — validation.json events
  if (existsSync(outputDir)) {
    try {
      const wOut = watch(outputDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (process.env.CO_LIVE_DEBUG) console.log(`[live-debug] output event=${eventType} filename=${filename}`);
        // Path is relative to outputDir: "{num}-{slug}/validation.json"
        const m = filename.replace(/\\/g, '/').match(/^(\d+)-[^/]+\/validation\.json$/);
        if (!m) return;
        const num = parseInt(m[1]);
        const folder = join(outputDir, filename.split(/[\\/]/)[0]);
        debouncedBroadcast(`val:${num}`, 300, () => {
          const v = readValidation(folder);
          if (v) {
            if (process.env.CO_LIVE_DEBUG) console.log(`[live] broadcast validation ${num} score=${v.score}`);
            broadcastSSE({ type: 'validation', num, validation: v });
          }
        });
      });
      wOut.on('error', err => console.warn('[live] output watch error:', err.message));
      _liveWatchers.push(wOut);
      console.log('[live] watching output/ for validation.json updates');
    } catch (e) { console.warn('[live] could not watch output/:', e.message); }
  }

  // Tick A — apply-status/{num}.json events
  try {
    const wStatus = watch(statusDir, (eventType, filename) => {
      if (!filename) return;
      if (process.env.CO_LIVE_DEBUG) console.log(`[live-debug] apply-status event=${eventType} filename=${filename}`);
      const m = filename.match(/^(\d+)\.json$/);
      if (!m) return;
      const num = parseInt(m[1]);
      debouncedBroadcast(`apply:${num}`, 200, () => {
        const st = readApplyStatus(num);
        if (st) {
          if (process.env.CO_LIVE_DEBUG) console.log(`[live] broadcast apply ${num}`);
          broadcastSSE({ type: 'apply', num, fillStatus: st });
        }
      });
    });
    wStatus.on('error', err => console.warn('[live] status watch error:', err.message));
    _liveWatchers.push(wStatus);
    console.log('[live] watching data/apply-status/ for fill updates');
  } catch (e) { console.warn('[live] could not watch apply-status/:', e.message); }
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

function businessDayCutoff(n = 3) {
  const d = new Date();
  let bizDaysFound = 0;
  while (true) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) { bizDaysFound++; if (bizDaysFound >= n) break; }
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

function parseScore(s) {
  if (!s) return null;
  const m = s.match(/(\d+\.?\d*)\s*\/\s*5/);
  return m ? parseFloat(m[1]) : null;
}

function parseReportPath(cell) {
  if (!cell) return null;
  const m = cell.match(/\(([^)]+\.md)\)/);
  return m ? m[1] : null;
}

function resolveReportPath(reportPath) {
  if (!reportPath) return null;
  // Strip leading ../ segments — reports always live at CAREER_OPS/reports/
  // tracker links use ../reports/ (relative to data/) but dashboard resolves from project root
  const normalized = reportPath.replace(/^(\.\.\/)+/, '');
  return resolve(join(CAREER_OPS, normalized));
}

function extractReportUrl(reportPath) {
  if (!reportPath) return null;
  const full = resolveReportPath(reportPath);
  if (!existsSync(full)) return null;
  try {
    const text = readFileSync(full, 'utf-8');
    const m = text.match(/\*\*URL:\*\*\s*(https?:\/\/\S+)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function findOutputFolder(num, reportPath) {
  const outputDir = join(CAREER_OPS, 'output');
  if (!existsSync(outputDir)) return null;
  const padded = String(num).padStart(3, '0') + '-';
  const exact  = String(num) + '-';

  // Also try matching by report number (batch runner names dirs after report #, not app #)
  let reportNum = null;
  if (reportPath) {
    const m = reportPath.match(/reports\/(\d+)-/);
    if (m) reportNum = m[1] + '-';
  }

  try {
    const entries = readdirSync(outputDir, { withFileTypes: true });
    // Report number is canonical — check it first to avoid row-number collisions
    if (reportNum) {
      const byReport = entries.find(e => e.isDirectory() && e.name.startsWith(reportNum));
      if (byReport) return join(outputDir, byReport.name);
    }
    // Fallback: match by tracker row number (padded then exact)
    const byRow = entries.find(e => e.isDirectory() && (e.name.startsWith(padded) || e.name.startsWith(exact)));
    return byRow ? join(outputDir, byRow.name) : null;
  } catch {
    return null;
  }
}



function parseApplications() {
  const path = join(CAREER_OPS, 'data', 'applications.md');
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').split('\n');
  const apps = [];

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').slice(1, -1).map(s => s.trim());
    if (cols.length < 8) continue;
    if (cols[0] === '#' || cols[0].startsWith('--')) continue;

    const [num, date, company, role, score, status, pdf, report, ...noteParts] = cols;
    const notes = noteParts.join(' | ').trim();
    const numInt = parseInt(num);
    if (!numInt || !company) continue;

    const scoreVal = parseScore(score);
    const reportPath = parseReportPath(report);
    const notesStr = notes || '';

    // Derive reportNum from the link target (the canonical reference). When
    // tracker col 1 has drifted from the report file number after re-evals,
    // this is the number that matches the output folder, the report file, and
    // the link bracket — which is what the user expects to see in the # column.
    let reportNum = numInt;
    if (reportPath) {
      const m = reportPath.match(/reports\/(\d+)-/);
      if (m) reportNum = parseInt(m[1]);
    }

    apps.push({
      num: numInt,
      reportNum,
      date: date || '',
      company: company || '',
      role: role || '',
      score: score || '',
      scoreVal,
      status: status || '',
      hasPdf: pdf === '✅',
      reportPath,
      notes: notesStr,
      h1b: parseH1B(notesStr),
      salary: parseSalary(notesStr),
      recommendedCv: parseRecommendedCv(notesStr),
      // Populated lazily for filtered set
      jobUrl: null,
      outputFolder: null,
    });
  }

  return apps;
}

// ─── PDF backfill — count missing + spawn generate-missing-pdfs.mjs ──────────

function countMissingQueuePdfs(cutoffDate) {
  const apps = parseApplications();
  return apps.filter(a => {
    if (a.status !== 'Evaluated' || !a.scoreVal || a.scoreVal < 3.5) return false;
    if (cutoffDate && a.date && a.date < cutoffDate) return false;
    const folder = findOutputFolder(a.num, a.reportPath);
    return !folder || !existsSync(join(folder, 'resume.pdf'));
  }).length;
}

function startPdfBackfill() {
  if (pdfBackfillProc) return;
  const cutoff = businessDayCutoff(3);
  const missing = countMissingQueuePdfs(cutoff);
  if (missing === 0) { console.log(`[pdf-backfill] All Apply Queue PDFs present (cutoff ${cutoff}).`); return; }

  pdfBackfillStats = { total: missing, done: 0, failed: 0, running: true, pass: 1 };
  broadcastSSE({ type: 'pdf_backfill', ...pdfBackfillStats });
  console.log(`[pdf-backfill] Auto-starting: ${missing} missing PDFs · cutoff ${cutoff}`);

  function spawnPass(extraArgs, onDone) {
    // process.execPath is the absolute path of the running node binary.
    // spawn('node', ...) breaks when PATH is empty (Mac .app/launchd context).
    const child = spawn(process.execPath, [
      join(CAREER_OPS, 'generate-missing-pdfs.mjs'),
      '--queue-only', '--since', cutoff, ...extraArgs
    ], { cwd: CAREER_OPS, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    pdfBackfillProc = child;

    // One-shot guard: spawn errors fire both 'error' and 'close', so onDone
    // would otherwise run twice and chain Pass 2 even after Pass 1 errored.
    let finished = false;
    const finish = () => { if (finished) return; finished = true; pdfBackfillProc = null; onDone(); };

    let buf = '';
    child.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop() || '';
      for (const line of lines) {
        if (line.includes('✅')) { pdfBackfillStats.done++; broadcastSSE({ type: 'pdf_backfill', ...pdfBackfillStats }); }
        else if (line.includes('❌')) { pdfBackfillStats.failed++; broadcastSSE({ type: 'pdf_backfill', ...pdfBackfillStats }); }
      }
    });
    // Always drain stderr to prevent pipe buffer fill → server event loop stall
    child.stderr.on('data', d => { const t = d.toString().trim(); if (t) console.warn('[pdf-backfill]', t.slice(0, 300)); });
    child.on('close', finish);
    child.on('error', err => { console.warn('[pdf-backfill] spawn error:', err.message); finish(); });
  }

  // Pass 1: HTML→PDF only (zero tokens, fast)
  spawnPass(['--html-only-pdf'], () => {
    pdfBackfillStats.pass = 2;
    broadcastSSE({ type: 'pdf_backfill', ...pdfBackfillStats });
    // Pass 2: generate HTML for remaining jobs (requires claude -p)
    spawnPass([], () => {
      pdfBackfillStats.running = false;
      broadcastSSE({ type: 'pdf_backfill', ...pdfBackfillStats });
      console.log(`[pdf-backfill] Complete: ${pdfBackfillStats.done} generated, ${pdfBackfillStats.failed} failed.`);
    });
  });
}

// ─── Validation backfill — auto-validate Apply Queue rows that have a PDF ────
// but no validation.json yet AND are H1B-eligible (High/Med/Low). Closes the
// gap for rows whose PDFs predated the validator. Runs detached; backfill-
// validation.mjs already throttles serially (~75s per Haiku call). Live tick
// updates land via the existing fs.watch → SSE pipeline.
let validationBackfillProc = null;
function startValidationBackfill() {
  if (validationBackfillProc) return;
  console.log('[val-backfill] Auto-starting validation backfill for eligible queue rows…');
  const child = spawn(process.execPath, [join(CAREER_OPS, 'backfill-validation.mjs')], {
    cwd: CAREER_OPS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  validationBackfillProc = child;
  child.stdout.on('data', d => {
    for (const line of d.toString().split('\n')) {
      if (line.trim()) console.log('[val-backfill]', line.trim().slice(0, 200));
    }
  });
  child.stderr.on('data', d => { const t = d.toString().trim(); if (t) console.warn('[val-backfill]', t.slice(0, 300)); });
  child.on('close', code => {
    validationBackfillProc = null;
    console.log(`[val-backfill] Complete (exit ${code}).`);
  });
  child.on('error', err => { console.warn('[val-backfill] spawn error:', err.message); validationBackfillProc = null; });
}

// ─── Pipeline pending parser ──────────────────────────────────────────────────

function parsePending() {
  const path = join(CAREER_OPS, 'data', 'pipeline.md');
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').split('\n');
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^- \[ \] (.+)$/);
    if (!match) continue;

    const parts = match[1].split('|').map(s => s.trim());
    const url = parts[0];
    let company = '', role = '', source = '';

    if (parts.length >= 4) {
      company = parts[1]; role = parts[2]; source = parts[3];
    } else if (parts.length === 3) {
      company = parts[1]; source = parts[2];
    } else if (parts.length === 2) {
      source = parts[1];
    }

    items.push({ url, company, role, source });
  }

  return items;
}

// ─── H1B + Salary parsers ─────────────────────────────────────────────────────

function parseH1B(notes) {
  if (!notes) return null;
  const lower = notes.toLowerCase();

  // ── LCA count — written by Gate 1 via auto-batch.mjs ──────────────────────
  const lcaMatch = notes.match(/(\d+)\+?\s*(?:cumulative\s+)?(?:h1b\s+)?lca/i);
  const lcaCount = lcaMatch ? parseInt(lcaMatch[1]) : null;
  if (lcaCount !== null) {
    if (lcaCount >= 50) return { label: 'High',         color: '#16a34a' };
    if (lcaCount >= 10) return { label: 'Medium',       color: '#d97706' };
    if (lcaCount >= 1)  return { label: 'Low',          color: '#dc2626' };
    return              { label: 'No', color: '#374151' }; // 0 LCAs on record
  }

  // ── Unreachable — lookup failed with a network/process error ─────────────
  if (lower.includes('h-1b unreachable') || lower.includes('h1b unreachable') ||
      lower.includes('unreachable')) {
    return { label: 'Unreachable', color: '#7c3aed' };
  }

  // ── Compact summary label written by evaluator ────────────────────────────
  const compactM = lower.match(/h[-\s]?1[-\s]?b\s+(confirmed|unverified|likely|unlikely|friendly|low|no|hard)\b/);
  if (compactM) {
    const lbl = compactM[1];
    if (lbl === 'confirmed')                  return { label: 'High',         color: '#16a34a' };
    if (lbl === 'likely' || lbl==='friendly') return { label: 'Medium',       color: '#d97706' };
    if (lbl === 'unverified')                 return { label: 'Unverified',   color: '#6b7280' };
    // no / unlikely / low / hard → portal/cache indicates no sponsorship
    return                                           { label: 'No', color: '#374151' };
  }

  // ── High / Medium keyword signals ─────────────────────────────────────────
  if (lower.includes('strong h-1b') || lower.includes('confirmed h-1b') ||
      lower.includes('h-1b confirmed') || lower.includes('h1b confirmed') ||
      lower.includes('fortune 500 sponsor') || lower.includes('sponsor-capable')) {
    return { label: 'High', color: '#16a34a' };
  }
  if (lower.includes('h-1b likely') || lower.includes('h1b likely') ||
      lower.includes('h-1b friendly') || lower.includes('h1b friendly')) {
    return { label: 'Medium', color: '#d97706' };
  }

  // ── No — explicit "no sponsorship" signals ───────────────────────────────
  if (lower.includes('no h-1b') || lower.includes('no h1b') || lower.includes('no lca') ||
      lower.includes('no sponsorship') || lower.includes('no sponsor') ||
      lower.includes('limited h-1b') || lower.includes('limited h1b') ||
      lower.includes('us citizen') || lower.includes('green card only')) {
    return { label: 'No', color: '#374151' };
  }

  // ── Unverified — process ran but couldn't determine sponsorship status ─────
  if (lower.includes('h-1b unverified') || lower.includes('h1b unverified') ||
      lower.includes('sponsorship unverified') || lower.includes('verify h-1b') ||
      lower.includes('verify h1b') || lower.includes('sponsorship unclear') ||
      lower.includes('h-1b uncertain')) {
    return { label: 'Unverified', color: '#6b7280' };
  }

  return null;
}

function parseSalary(notes) {
  if (!notes) return null;

  // Standard range: $130K–$150K or $130–150K
  const rangeM = notes.match(/\$(\d+(?:\.\d+)?)[Kk]?(?:,\d+)?[\s]*[–\-]+[\s]*\$?(\d+(?:\.\d+)?)[Kk]?/);
  if (rangeM) {
    const lo = parseFloat(rangeM[1]);
    const hi = parseFloat(rangeM[2]);
    const loK = lo >= 1000 ? Math.round(lo / 1000) : Math.round(lo);
    const hiK = hi >= 1000 ? Math.round(hi / 1000) : Math.round(hi);
    return `$${loK}K–$${hiK}K`;
  }

  // "$X vs $Y" separator (e.g. "$138K vs $160K")
  const vsM = notes.match(/\$(\d+(?:\.\d+)?)[Kk]?\s+vs\s+\$?(\d+(?:\.\d+)?)[Kk]?/i);
  if (vsM) {
    const lo = parseFloat(vsM[1]);
    const hi = parseFloat(vsM[2]);
    const loK = lo >= 1000 ? Math.round(lo / 1000) : Math.round(lo);
    const hiK = hi >= 1000 ? Math.round(hi / 1000) : Math.round(hi);
    return `$${loK}K–$${hiK}K`;
  }

  // Hourly rate: $80/hr → annualize (×2080)
  const hrM = notes.match(/\$(\d+(?:\.\d+)?)\s*\/\s*hr/i);
  if (hrM) {
    const annual = Math.round(parseFloat(hrM[1]) * 2080 / 1000);
    return `~$${annual}K/yr`;
  }

  // Single value with context keyword (base, median, total)
  const singleM = notes.match(/\$(\d+(?:\.\d+)?)[Kk]?\s+(?:base|median|total comp)/i);
  if (singleM) {
    const v = parseFloat(singleM[1]);
    const vK = v >= 1000 ? Math.round(v / 1000) : Math.round(v);
    return `$${vK}K`;
  }

  const lower = notes.toLowerCase();
  if (lower.includes('comp unlisted') || lower.includes('unlisted')) return 'Unlisted';
  if (lower.includes('below target')) return 'Below target';

  return null;
}

function parseRecommendedCv(notes) {
  if (!notes) return null;
  const m = notes.match(/Recommended CV:\s*(Resume\/[^\s|]+\.pdf)/i);
  return m ? m[1] : null;
}

// ─── Sanitization ─────────────────────────────────────────────────────────────

function sanitizeFolderPath(raw) {
  if (!raw) return null;
  const outputDir = resolve(join(CAREER_OPS, 'output'));
  const target = resolve(raw);
  return target.startsWith(outputDir) ? target : null;
}

function sanitizeResumePath(raw) {
  if (!raw) return null;
  const resumeDir = resolve(join(CAREER_OPS, 'Resume'));
  const target = resolve(join(CAREER_OPS, raw));
  return target.startsWith(resumeDir) && target.endsWith('.pdf') ? target : null;
}

function sanitizeReportPath(raw) {
  if (!raw) return null;
  const base = resolve(CAREER_OPS);
  const normalized = raw.replace(/^(\.\.\/)+/, '');
  const target = resolve(join(CAREER_OPS, normalized));
  return target.startsWith(base) && target.endsWith('.md') ? target : null;
}

// ─── Cover letter helpers ─────────────────────────────────────────────────────

function readUserProfile() {
  try {
    const raw = readFileSync(join(CAREER_OPS, 'config', 'profile.yml'), 'utf-8');
    const nameMatch = raw.match(/name:\s*["']?([^"'\n]+)["']?/);
    const emailMatch = raw.match(/email:\s*["']?([^"'\n]+)["']?/);
    return {
      name: nameMatch ? nameMatch[1].trim() : 'Candidate',
      email: emailMatch ? emailMatch[1].trim() : '',
    };
  } catch {
    return { name: 'Candidate', email: '' };
  }
}

function findOrCreateOutputFolder(num, reportPath) {
  const existing = findOutputFolder(num, reportPath);
  if (existing) return existing;
  if (!reportPath) return null;
  const match = reportPath.match(/reports\/(\d+)-(.+)-\d{4}-\d{2}-\d{2}\.md/);
  if (!match) return null;
  // Use report number as folder prefix (matches batch runner + pdf mode convention)
  const folderName = `${match[1]}-${match[2]}`;
  const folderPath = join(CAREER_OPS, 'output', folderName);
  mkdirSync(folderPath, { recursive: true });
  return folderPath;
}

function spawnCoverLetter(num, reportPath, outputFolder) {
  const clOutputPath = join(outputFolder, 'cover-letter.html');
  const { name: userName, email: userEmail } = readUserProfile();
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const reportFull = resolveReportPath(reportPath);
  const cvFull = join(CAREER_OPS, 'cv.md');
  const profileFull = join(CAREER_OPS, 'modes', '_profile.md');

  const prompt = `You are a professional cover letter writer. Complete these steps:

Step 1 — Read these files:
- Evaluation report: "${reportFull}"
- CV: "${cvFull}"
- Profile/context: "${profileFull}"

Step 2 — From the report extract: company name, exact role title, top 3 skill/experience matches from the evaluation blocks, any salary or H-1B details.

Step 3 — From the CV find 2 specific metrics (numbers, percentages, scale) that directly address the top skill matches.

Step 4 — Write the cover letter as an HTML file to: "${clOutputPath}"

Use EXACTLY this HTML template (replace [...] with content):
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Cover Letter</title>
<style>
body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:60px auto;padding:0 48px;color:#1a1a1a;line-height:1.8;font-size:15px}
p{margin:0 0 18px}
</style>
</head>
<body>
<p>${today}</p>
<p>Dear Hiring Manager,</p>
<p>[Opening: 65-80 words. Name the specific role and company. One sentence on why this role fits the candidate's trajectory.]</p>
<p>[Skills paragraph: 90-110 words. Cover the top 2 skill matches with specific metrics from the CV. Be concrete: numbers, scale, outcomes.]</p>
<p>[Closing: 50-65 words. Express enthusiasm. If H-1B sponsorship is needed per the report, include: "I hold H-1B status and will require a transfer from my current employer." End with a call to action.]</p>
<p>Sincerely,<br>${userName}${userEmail ? '<br>' + userEmail : ''}</p>
</body>
</html>

Total letter body: 270-300 words. Write the file only — no commentary, no explanation.`;

  // Hard-coded absolute path — Mac .app / launchd ship an empty PATH.
  const child = spawn('/usr/local/bin/claude', ['-p', prompt], {
    cwd: CAREER_OPS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  child.on('close', code => {
    if (existsSync(clOutputPath)) {
      coverLetterJobs.set(num, { status: 'ready', outputFolder });
    } else {
      coverLetterJobs.set(num, { status: 'error', error: stderr || `exit code ${code}` });
    }
  });

  child.on('error', err => {
    coverLetterJobs.set(num, { status: 'error', error: err.message });
  });
}

// ─── Smart Apply helpers ──────────────────────────────────────────────────────

function applyStatusPath(num) {
  return join(CAREER_OPS, 'data', 'apply-status', `${num}.json`);
}

function readApplyStatus(num) {
  const p = applyStatusPath(num);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

// Read output/{num}-{slug}/validation.json (written by validate-resume.mjs).
// Returns null if not present — dashboard withholds the tick rather than misreport.
function readValidation(outputFolder) {
  if (!outputFolder) return null;
  const p = join(outputFolder, 'validation.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function spawnSmartApply(num) {
  const scriptPath = join(CAREER_OPS, 'smart-apply.mjs');
  // Use osascript to open a new Terminal window — this gives the child process
  // full macOS GUI access so Playwright can open a visible headed browser.
  const script = `tell application "Terminal"
    do script "node '${scriptPath}' --num ${num}"
    activate
  end tell`;
  const child = spawn('osascript', ['-e', script], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  child.on('error', err => {
    const p = applyStatusPath(num);
    mkdirSync(join(CAREER_OPS, 'data', 'apply-status'), { recursive: true });
    writeFileSync(p, JSON.stringify({ num, status: 'ERROR', error: err.message, updatedAt: new Date().toISOString() }, null, 2));
  });
  return child;
}

// ─── HTML helpers ─────────────────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scoreColor(v) {
  if (v === null) return '#475569';
  if (v >= 4.5) return '#16a34a';
  if (v >= 4.0) return '#65a30d';
  if (v >= 3.5) return '#d97706';
  return '#dc2626';
}

function statusColor(s) {
  const map = {
    Evaluated: '#2563eb',
    Applied: '#7c3aed',
    Responded: '#0891b2',
    Interview: '#d97706',
    Offer: '#16a34a',
    Rejected: '#dc2626',
    Discarded: '#475569',
    SKIP: '#475569',
  };
  return map[s] || '#475569';
}

// ─── Markdown → HTML (minimal, for report viewer) ─────────────────────────────

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inTable = false;
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.startsWith('```')) {
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }

    if (line.startsWith('| ') || line.startsWith('|--')) {
      if (!inTable) { out.push('<table>'); inTable = true; }
      if (line.startsWith('|--')) continue;
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const tag = (i === 0 || !lines[i - 1].startsWith('| ')) ? 'th' : 'td';
      out.push(`<tr>${cells.map(c => `<${tag}>${inlinemd(c)}</${tag}>`).join('')}</tr>`);
      continue;
    }
    if (inTable) { out.push('</table>'); inTable = false; }

    if (line.startsWith('### ')) { out.push(`<h3>${inlinemd(line.slice(4))}</h3>`); continue; }
    if (line.startsWith('## ')) { out.push(`<h2>${inlinemd(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('# ')) { out.push(`<h1>${inlinemd(line.slice(2))}</h1>`); continue; }
    if (line.startsWith('---')) { out.push('<hr>'); continue; }
    if (line.startsWith('> ')) { out.push(`<blockquote>${inlinemd(line.slice(2))}</blockquote>`); continue; }
    if (line.startsWith('- ')) { out.push(`<li>${inlinemd(line.slice(2))}</li>`); continue; }
    if (line === '') { out.push('<br>'); continue; }
    out.push(`<p>${inlinemd(line)}</p>`);
  }
  if (inTable) out.push('</table>');
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

function inlinemd(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

// ─── Status updater ───────────────────────────────────────────────────────────

function updateApplicationStatus(num, newStatus) {
  const path = join(CAREER_OPS, 'data', 'applications.md');
  const lines = readFileSync(path, 'utf-8').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const parts = line.split('|');
    // parts[0] = '', parts[1] = num, ..., parts[6] = status
    if (parseInt(parts[1]?.trim()) !== num) continue;
    // Rebuild the line with updated status column (index 6)
    parts[6] = ` ${newStatus} `;
    lines[i] = parts.join('|');
    writeFileSync(path, lines.join('\n'), 'utf-8');
    return { ok: true };
  }
  return { ok: false, error: 'Row not found' };
}

// ─── Skip pipeline item ───────────────────────────────────────────────────────

function skipPipelineItem(url) {
  const path = join(CAREER_OPS, 'data', 'pipeline.md');
  const lines = readFileSync(path, 'utf-8').split('\n');

  const lineIdx = lines.findIndex(l => /^- \[ \]/.test(l) && l.includes(url));
  if (lineIdx === -1) return { ok: false, error: 'Not found' };

  lines.splice(lineIdx, 1);

  const today = new Date().toISOString().slice(0, 10);
  const skipRow = `| SKIP | — | — | — | — | — | Skipped by user | [link](${url}) |`;
  const processedIdx = lines.findIndex(l => /^##\s+Processed/i.test(l));

  if (processedIdx !== -1) {
    let todayIdx = -1;
    for (let i = processedIdx; i < lines.length; i++) {
      if (lines[i] === `### ${today}`) { todayIdx = i; break; }
    }
    if (todayIdx === -1) {
      lines.splice(processedIdx + 1, 0, '', `### ${today}`,
        '| # | Company | Role | Score | CV | Cover | Notes | URL |',
        '|---|---------|------|-------|----|-------|-------|-----|', skipRow);
    } else {
      let insertIdx = todayIdx + 1;
      while (insertIdx < lines.length && lines[insertIdx].startsWith('|')) insertIdx++;
      lines.splice(insertIdx, 0, skipRow);
    }
  } else {
    lines.push('', '## Processed', '', `### ${today}`,
      '| # | Company | Role | Score | CV | Cover | Notes | URL |',
      '|---|---------|------|-------|----|-------|-------|-----|', skipRow);
  }

  writeFileSync(path, lines.join('\n'), 'utf-8');
  return { ok: true };
}

// ─── Page renderers ───────────────────────────────────────────────────────────

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #0f172a; color: #e2e8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
a { color: inherit; text-decoration: none; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; background: #0f172a; border-bottom: 1px solid #1e293b; position: sticky; top: 0; z-index: 10; }
.topbar-left h1 { font-size: 1.2em; font-weight: 700; color: #f8fafc; }
.topbar-left .sub { color: #64748b; font-size: 0.8em; margin-top: 2px; }
.topbar-right { display: flex; gap: 8px; align-items: center; }
.btn { padding: 7px 14px; border-radius: 7px; font-size: 0.82em; font-weight: 600; cursor: pointer; border: none; }
.btn-primary { background: #1d4ed8; color: #fff; }
.btn-primary:hover { background: #2563eb; }
.btn-ghost { background: transparent; color: #64748b; border: 1px solid #334155; }
.btn-ghost:hover { border-color: #60a5fa; color: #60a5fa; }
.content { padding: 0 24px 40px; }
table { width: 100%; border-collapse: collapse; font-size: 0.88em; margin-top: 16px; }
th { text-align: left; padding: 9px 12px; background: #1e293b; color: #64748b; font-weight: 600; font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 2px solid #334155; }
td { padding: 10px 12px; border-bottom: 1px solid #1e293b; vertical-align: middle; }
tr:hover td { background: #162032; }
.badge { display: inline-block; padding: 3px 9px; border-radius: 20px; font-weight: 700; font-size: 0.8em; color: #fff; white-space: nowrap; }
.icon-link { font-size: 1.1em; cursor: pointer; display: inline-block; }
.icon-link:hover { opacity: 0.7; }
.notes-cell { color: #64748b; font-size: 0.8em; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.notes-cell.expanded { white-space: normal; overflow: visible; max-width: 400px; color: #cbd5e1; }
.empty { text-align: center; padding: 80px 24px; color: #475569; }
.apply-btn { background: #16a34a; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-size: 0.8em; font-weight: 600; cursor: pointer; white-space: nowrap; }
.apply-btn:hover { background: #15803d; }
.apply-btn:disabled { background: #475569; cursor: default; }
.tabs { display: flex; gap: 4px; align-items: center; }
.tab { padding: 6px 14px; border-radius: 7px; font-size: 0.82em; font-weight: 600; cursor: pointer; border: 1px solid #334155; color: #64748b; text-decoration: none; }
.tab:hover { border-color: #60a5fa; color: #60a5fa; }
.tab.active { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
.tab .count { opacity: 0.75; margin-left: 4px; font-weight: 400; }
.skip-btn { background: transparent; border: 1px solid #334155; color: #64748b; padding: 3px 10px; border-radius: 5px; font-size: 0.78em; cursor: pointer; }
.skip-btn:hover { border-color: #ef4444; color: #ef4444; }
.discard-btn { background: transparent; border: 1px solid #334155; color: #64748b; padding: 5px 10px; border-radius: 6px; font-size: 0.78em; font-weight: 600; cursor: pointer; }
.discard-btn:hover { border-color: #ef4444; color: #ef4444; }
.fill-btn { background: #0f172a; border: 1px solid #3b82f6; color: #60a5fa; padding: 5px 10px; border-radius: 6px; font-size: 0.78em; font-weight: 600; cursor: pointer; white-space: nowrap; }
.fill-btn:hover:not(:disabled) { background: #1d4ed8; border-color: #60a5fa; color: #fff; }
.fill-btn:disabled { opacity: 0.5; cursor: default; }
.linkedin-btn { background: #0077b5; color: #fff; border: none; padding: 5px 10px; border-radius: 6px; font-size: 0.78em; font-weight: 600; cursor: pointer; white-space: nowrap; text-decoration: none; display: inline-block; }
.linkedin-btn:hover { background: #005885; color: #fff; }
.edit-url-btn { background: transparent; border: 1px solid #475569; color: #94a3b8; padding: 4px 7px; border-radius: 5px; font-size: 0.75em; cursor: pointer; line-height: 1; }
.edit-url-btn:hover { border-color: #3b82f6; color: #60a5fa; }
.fill-status { display:inline-block; font-size:0.72em; font-weight:700; padding:2px 7px; border-radius:12px; white-space:nowrap; }
.fill-status.RUNNING              { background:#1d4ed8; color:#fff; }
.fill-status.FILLED_PENDING_REVIEW{ background:#16a34a; color:#fff; }
.fill-status.NEEDS_ANSWER         { background:#d97706; color:#fff; }
.fill-status.BLOCKED              { background:#dc2626; color:#fff; }
.fill-status.DUPLICATE            { background:#7c3aed; color:#fff; }
.fill-status.NEEDS_MANUAL         { background:#475569; color:#fff; }
.fill-status.ERROR                { background:#dc2626; color:#fff; }
.cover-btn { background: transparent; border: 1px solid #334155; padding: 3px 8px; border-radius: 5px; font-size: 1em; cursor: pointer; line-height: 1; }
.cover-btn:hover:not(:disabled) { border-color: #60a5fa; }
.cover-btn:disabled { opacity: 0.5; cursor: default; }
.source-badge { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 0.75em; font-weight: 600; color: #fff; }
/* Report viewer */
.report-wrap { max-width: 820px; margin: 0 auto; padding: 32px 24px 60px; }
.back-link { display: inline-flex; align-items: center; gap: 6px; color: #60a5fa; font-size: 0.85em; margin-bottom: 24px; }
.report-wrap h1 { font-size: 1.4em; color: #f8fafc; margin: 1em 0 0.4em; }
.report-wrap h2 { font-size: 1.1em; color: #cbd5e1; margin: 1.4em 0 0.4em; border-top: 1px solid #1e293b; padding-top: 1em; }
.report-wrap h3 { font-size: 0.95em; color: #94a3b8; margin: 1em 0 0.3em; }
.report-wrap p { color: #cbd5e1; line-height: 1.7; margin: 0.4em 0; }
.report-wrap li { color: #cbd5e1; line-height: 1.7; margin-left: 1.2em; }
.report-wrap table { border-collapse: collapse; width: 100%; margin: 0.8em 0; font-size: 0.9em; }
.report-wrap th, .report-wrap td { border: 1px solid #334155; padding: 6px 12px; text-align: left; }
.report-wrap th { background: #1e293b; color: #94a3b8; font-size: 0.82em; }
.report-wrap code { background: #1e293b; padding: 1px 5px; border-radius: 4px; font-size: 0.88em; }
.report-wrap pre { background: #1e293b; padding: 12px; border-radius: 8px; overflow-x: auto; }
.report-wrap hr { border: none; border-top: 1px solid #1e293b; margin: 1.5em 0; }
.report-wrap blockquote { border-left: 3px solid #334155; padding: 0 1em; color: #94a3b8; margin: 0.5em 0; }
.report-wrap strong { color: #f1f5f9; }
.report-wrap a { color: #60a5fa; }
`;

function tabBar(mode, queueCount, historyCount, pendingCount) {
  const tabs = [
    { label: 'Apply Queue', count: queueCount, href: '/', key: 'queue' },
    { label: 'History', count: historyCount, href: '/?mode=history', key: 'history' },
    { label: 'Pending', count: pendingCount, href: '/?mode=pending', key: 'pending' },
  ];
  return `<div class="tabs">${tabs.map(t =>
    `<a href="${t.href}" class="tab${mode === t.key ? ' active' : ''}">${t.label}<span class="count">${t.count}</span></a>`
  ).join('')}<a href="javascript:location.reload()" class="tab" style="margin-left:4px">↺</a></div>`;
}

function renderDashboard(apps, mode, pendingCount) {
  const isQueue = mode === 'queue' || mode === 'queue';

  const cutoff = isQueue ? businessDayCutoff(3) : null;
  const filtered = apps
    .filter(a => {
      if (a.status === 'SKIP' || a.status === 'Discarded') return false;
      if (a.scoreVal === null || a.scoreVal < 3.5) return false;
      if (isQueue && a.status !== 'Evaluated') return false;
      if (cutoff && a.date && a.date < cutoff) return false;
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.scoreVal - a.scoreVal);

  // Tab badge counts MUST match the rendered table:
  // - Apply Queue: Evaluated + score ≥ 3.5 + last 3 business days (same as rendered)
  // - History: all active statuses + score ≥ 3.5 (no date cutoff)
  const queueCutoff = businessDayCutoff(3);
  const queueCount = apps.filter(a => a.status === 'Evaluated' && a.scoreVal >= 3.5 && (!a.date || a.date >= queueCutoff)).length;
  const historyCount = apps.filter(a => !['SKIP','Discarded'].includes(a.status) && a.scoreVal >= 3.5).length;

  // Enrich with URL + output folder + resume tier for visible rows
  for (const a of filtered) {
    a.jobUrl = extractReportUrl(a.reportPath);
    a.outputFolder = findOutputFolder(a.num, a.reportPath);
    // Resume tier: which resume will actually be used for this job
    const tailoredExists = a.outputFolder ? existsSync(join(a.outputFolder, 'resume.pdf')) : false;
    if (tailoredExists) {
      a.resumeTier = 'tailored';
      a.resumeSource = null;
    } else if (a.recommendedCv) {
      // Extract subfolder name from "Resume/healthcare/resume.pdf" → "healthcare"
      const m = a.recommendedCv.match(/Resume\/([^/]+)\//i);
      a.resumeTier = 'archetype';
      a.resumeSource = m ? m[1] : 'generic';
    } else {
      a.resumeTier = 'generic';
      a.resumeSource = 'generic';
    }
    // Tick B source: semantic validation (only present for queue-eligible jobs
    // where H1B is High/Med/Low AND validate-resume.mjs has run).
    a.validation = readValidation(a.outputFolder);
  }

  const title = isQueue ? 'Apply Queue' : 'Full History ≥ 3.5';
  const subTitle = isQueue
    ? `${filtered.length} jobs to apply · Last 3 business days · Score ≥ 3.5 · from ${cutoff}`
    : `${filtered.length} jobs · All active statuses · Score ≥ 3.5`;

  const rows = filtered.map(a => {
    const scoreBadge = `<span class="badge" style="background:${scoreColor(a.scoreVal)}">${esc(a.score)}</span>`;
    const statusBadge = `<span class="badge" style="background:${statusColor(a.status)};font-weight:500">${esc(a.status)}</span>`;

    const jobLink = a.jobUrl
      ? `<a href="${esc(a.jobUrl)}" target="_blank" class="icon-link" title="${esc(a.jobUrl)}">🔗</a>`
      : `<span style="color:#f59e0b;font-size:0.75em" title="No URL in report — run resolve-linkedin-urls or edit report manually">⚠️ No URL</span>`;

    const tierColor = a.resumeTier === 'tailored' ? '#22c55e' : a.resumeTier === 'archetype' ? '#f59e0b' : '#64748b';
    const tierLabel = a.resumeTier === 'tailored' ? '★' : a.resumeSource || 'generic';
    const folderTarget = a.resumeTier === 'tailored' && a.outputFolder
      ? a.outputFolder
      : a.resumeTier !== 'generic'
        ? join(CAREER_OPS, 'Resume', a.resumeSource || 'generic')
        : join(CAREER_OPS, 'Resume', 'generic');
    // Tooltip = actual resume path so user knows exactly which file the row uses.
    const tierTitle = a.resumeTier === 'tailored'
      ? join(folderTarget, 'resume.pdf').replace(CAREER_OPS + '/', '')
      : join(folderTarget, 'resume.pdf').replace(CAREER_OPS + '/', '');
    const folderBtn = `<span class="icon-link" onclick="openFolder(this,'${esc(folderTarget)}')" title="${esc(tierTitle)}">📁</span><span style="font-size:0.7em;color:${tierColor};margin-left:2px" title="${esc(tierTitle)}">${esc(tierLabel)}</span>`;

    // Tick B — semantic-validation tick. Shown only on Apply Queue tab, only
    // when validation.json exists AND has a finite numeric score. Strict: ✓
    // only if valid===true. Otherwise ⚠ with issues in tooltip. Withholds on
    // missing/malformed data. Wrapped in #val-tick-{num} so client SSE handler
    // can update it live as new validations land.
    const valInner = (() => {
      if (!isQueue || !a.validation) return '';
      const v = a.validation;
      const scoreNum = Number.isFinite(v.score) ? Math.round(v.score) : null;
      if (scoreNum == null) return '';
      const issuesText = (Array.isArray(v.issues) ? v.issues : []).map(i => `• ${i}`).join('\n');
      const axesText = (v.axes && typeof v.axes === 'object')
        ? Object.entries(v.axes).map(([k, val]) => `${k}: ${val}`).join(' · ')
        : '';
      const fullTitle = `Validator: ${v.valid === true ? 'PASS' : 'WITHHELD'} · score ${scoreNum}\n${axesText}${issuesText ? '\n\nIssues:\n' + issuesText : ''}`;
      const color = v.valid === true ? '#16a34a' : '#d97706';
      const sym = v.valid === true ? '✓' : '⚠';
      return `<span style="color:${color};font-size:0.85em;margin-left:4px;font-weight:600" title="${esc(fullTitle)}">${sym} ${scoreNum}</span>`;
    })();
    // Canonical num = report-link num if present (matches what fs.watch sees in
    // output/{num}-{slug}/validation.json). Tracker display # may drift; we
    // align IDs with the file-path num so live SSE updates land on the right row.
    const valIdNum = (a.reportPath?.match(/reports\/(\d+)-/)?.[1]) || a.num;
    const validationTick = isQueue ? `<span id="val-tick-${valIdNum}">${valInner}</span>` : '';

    const reportFull = a.reportPath ? resolveReportPath(a.reportPath) : null;
    const reportOnDisk = reportFull && existsSync(reportFull);
    const reportLink = reportOnDisk
      ? `<a href="/report?path=${encodeURIComponent(a.reportPath)}" target="_blank" class="icon-link" title="View evaluation report">📄</a>`
      : `<span style="color:#f59e0b;font-size:0.75em" title="${a.reportPath ? 'Report file missing on disk' : 'No report linked in tracker'}">⚠️ Missing</span>`;

    const h1bTitle = a.h1b?.label === 'High'         ? 'Strong H-1B sponsor — 50+ LCA filings on record'
      : a.h1b?.label === 'Medium'       ? 'Likely H-1B sponsor — 10–49 LCA filings on record'
      : a.h1b?.label === 'Low'          ? 'Limited H-1B history — 1–9 LCA filings, verify before applying'
      : a.h1b?.label === 'No'           ? '0 LCA filings on record — company likely does not sponsor H-1B'
      : a.h1b?.label === 'Unverified'   ? 'H-1B check ran with errors — verify manually on h1bdata.info'
      : a.h1b?.label === 'Unreachable'  ? 'H-1B lookup failed — verify manually on h1bdata.info'
      : 'H-1B status unknown';
    const h1bCell = a.h1b
      ? `<span class="badge" style="background:${a.h1b.color};font-size:0.75em" title="${esc(h1bTitle)}">${a.h1b.label}</span>`
      : `<span class="badge" style="background:#374151;font-size:0.75em" title="H1B status not checked — verify manually on h1bdata.info">?</span>`;

    const salaryCell = a.salary
      ? `<span style="font-size:0.82em;color:#94a3b8;white-space:nowrap">${esc(a.salary)}</span>`
      : `<span style="font-size:0.78em;color:#64748b">Unlisted</span>`;

    const fillSt = readApplyStatus(a.num);
    const fillStatusBadge = fillSt ? (() => {
      const st    = fillSt.status;
      const title = esc(fillSt.needsAnswer?.join(', ') || fillSt.error || '');
      const label = st.replace(/_/g, ' ');
      // FILLED_PENDING_REVIEW gets an actionable "Open to Submit" link
      if (st === 'FILLED_PENDING_REVIEW') {
        return `<span class="fill-status ${st}" title="Form filled and browser is open — review and submit in the Terminal window">FILLED — REVIEW &amp; SUBMIT</span>`;
      }
      // NEEDS_ANSWER and other statuses: just show the status badge.
      // Unknown questions are listed in the tooltip; user re-clicks 🌐 Open to
      // fill the form — manually-filled answers get auto-captured on Submit.
      if (st === 'NEEDS_ANSWER') {
        const questionsList = (fillSt.needsAnswer || []).join(', ');
        return `<span class="fill-status ${st}" title="Unknown questions: ${esc(questionsList)}">${label}</span>`;
      }
      return `<span class="fill-status ${st}" title="${title}">${label}</span>`;
    })() : '';

    // Tick A — resume-path / attach verification tick. Wrapped in #attach-tick-{num}
    // so client SSE handler can update it live when smart-apply / fill-agent
    // writes apply-status.json. Strict: ✓ green only if browser confirmed the
    // intended file (name + size). ⚠ amber if no readback. ⚠ red if rejected.
    const attachInner = (() => {
      if (!fillSt?.attach) return '';
      const at = fillSt.attach;
      const tierLine = fillSt.resumeTier ? `Tier: ${fillSt.resumeTier}\n` : '';
      const intendedLine = at.intendedName ? `Intended: ${at.intendedName}\n` : '';
      const attachedLine = at.attachedName ? `Attached: ${at.attachedName}\n` : '';
      const reasonLine = at.reason ? `Reason: ${at.reason}` : '';
      const ttl = `Attach verification\n${tierLine}${intendedLine}${attachedLine}${reasonLine}`;
      if (at.attached === true && at.nameMatches && at.sizeMatches !== false) {
        return `<span style="color:#16a34a;font-size:0.85em;margin-left:4px;font-weight:600" title="${esc(ttl)}">✓</span>`;
      } else if (at.attached === 'unknown') {
        return `<span style="color:#d97706;font-size:0.85em;margin-left:4px;font-weight:600" title="${esc(ttl)}">⚠</span>`;
      } else if (at.attached === false) {
        return `<span style="color:#dc2626;font-size:0.85em;margin-left:4px;font-weight:600" title="${esc(ttl)}">⚠</span>`;
      }
      return '';
    })();
    const attachTick = `<span id="attach-tick-${a.num}">${attachInner}</span>`;
    const isLinkedIn = a.jobUrl?.includes('linkedin.com');
    const agentActive = agentStatus === 'connected';
    const editUrlBtn = `<button class="edit-url-btn" onclick="editUrl(this,${a.num},'${esc(a.jobUrl||'')}')" title="Set real career page URL (replaces LinkedIn URL in report)">✎</button>`;

    // Unified action: always render "🌐 Open" when a URL is available. The
    // click dispatcher (openJob) decides at click time whether to:
    //   - use the connected fill-agent Chrome (auto-fills the form),
    //   - open the LinkedIn URL in a new tab (LinkedIn requires the user to
    //     click "Apply on company website"; nothing to auto-fill upstream),
    //   - or fall back to smart-apply (spawns Playwright in a new Terminal).
    // The user only sees one button. Fallback behavior is invisible.
    let fillOrLinkedIn;
    if (a.jobUrl) {
      const isRunning = fillSt?.status === 'RUNNING';
      const label = isRunning ? '⏳ Filling…' : '🌐 Open';
      const disabled = isRunning ? 'disabled' : '';
      const openTitle = isLinkedIn
        ? 'Open the LinkedIn job — log in and click Apply on company website; form fills automatically when reached'
        : 'Open the job — auto-fills if Fill Agent is connected, otherwise launches via Playwright';
      fillOrLinkedIn = `<button class="fill-btn" id="action-btn-${a.num}"
          onclick="openJob(this,${a.num},'${esc(a.jobUrl)}',${isLinkedIn ? 'true' : 'false'})"
          title="${esc(openTitle)}" ${disabled}
          style="background:#1e3a5f;border-color:#3b82f6;color:#93c5fd">${label}</button>`;
    } else {
      fillOrLinkedIn = `<span style="color:#f59e0b;font-size:0.78em" title="Report has no URL — set it via ✎">⚠ No URL</span>${editUrlBtn}`;
    }
    const actionCell = a.status === 'Evaluated'
      ? `<div style="display:flex;flex-direction:column;align-items:center;gap:4px">
           <div style="display:flex;gap:4px;align-items:center;justify-content:center;flex-wrap:wrap">
             <button class="apply-btn" onclick="applyJob(this,${a.num})" title="Mark as Applied in tracker">Apply</button>
             <button class="discard-btn" onclick="discardJob(this,${a.num})" title="Skip — remove from queue">Skip</button>
             ${fillOrLinkedIn}
           </div>
           <div id="url-edit-row-${a.num}" style="display:none;margin-top:4px;display:none">
             <input id="url-input-${a.num}" type="text" placeholder="Paste career page URL…" style="width:260px;padding:3px 6px;border:1px solid #3b82f6;border-radius:4px;background:#0f172a;color:#e2e8f0;font-size:0.75em" />
             <button onclick="saveUrl(${a.num})" style="background:#1d4ed8;border:none;color:#fff;padding:3px 8px;border-radius:4px;font-size:0.75em;cursor:pointer;margin-left:2px">Save</button>
             <button onclick="cancelEditUrl(${a.num})" style="background:#334155;border:none;color:#cbd5e1;padding:3px 8px;border-radius:4px;font-size:0.75em;cursor:pointer;margin-left:2px">✕</button>
           </div>
           <div id="fill-badge-${a.num}" style="min-height:16px;text-align:center">${isLinkedIn ? '' : fillStatusBadge}${isLinkedIn ? '' : attachTick}</div>
         </div>`
      : `<span style="color:#334155;font-size:0.8em">—</span>`;

    // Cover letter cell — check disk + in-memory status
    const clPath = a.outputFolder ? join(a.outputFolder, 'cover-letter.html') : null;
    const clExists = clPath && existsSync(clPath);
    const clJob = coverLetterJobs.get(a.num);
    let coverCell;
    if (clExists || clJob?.status === 'ready') {
      const folder = clJob?.outputFolder || a.outputFolder;
      coverCell = `<span class="icon-link cover-ready" onclick="openFolder(this,'${esc(folder)}')" title="Cover letter ready — open folder" style="color:#16a34a">✉️</span>`;
    } else if (clJob?.status === 'generating') {
      coverCell = `<button class="cover-btn" disabled title="Generating…">⏳</button>`;
    } else if (clJob?.status === 'error') {
      coverCell = `<button class="cover-btn" onclick="startCoverLetter(this,${a.num})" title="Failed — click to retry" style="opacity:0.7">✉️❌</button>`;
    } else {
      coverCell = a.reportPath
        ? `<button class="cover-btn" onclick="startCoverLetter(this,${a.num})" title="Generate cover letter">✉️</button>`
        : `<span style="color:#334155">—</span>`;
    }

    return `<tr id="row-${a.num}">
  <td style="color:#475569;font-size:0.78em" title="tracker row #${a.num}">${a.reportNum}</td>
  <td style="color:#475569;font-size:0.78em;white-space:nowrap">${esc(a.date)}</td>
  <td style="font-weight:600;white-space:nowrap">${esc(a.company)}</td>
  <td style="color:#cbd5e1">${esc(a.role)}</td>
  <td>${scoreBadge}</td>
  <td style="text-align:center">${h1bCell}</td>
  <td>${salaryCell}</td>
  <td id="status-${a.num}">${statusBadge}</td>
  <td style="text-align:center">${jobLink}</td>
  <td style="text-align:center">${folderBtn}${validationTick}</td>
  <td style="text-align:center" id="cover-${a.num}">${coverCell}</td>
  <td style="text-align:center">${reportLink}</td>
  <td class="notes-cell" onclick="this.classList.toggle('expanded')">${esc(a.notes) || '—'}</td>
  <td style="text-align:center" id="action-${a.num}">${actionCell}</td>
</tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Career Ops — ${title}</title>
<style>${CSS}</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-left">
    <h1>Career Ops</h1>
    <div class="sub">${subTitle}</div>
  </div>
  <div class="topbar-right" style="display:flex;align-items:center;gap:12px">
    <div id="agent-badge" style="display:flex;align-items:center;gap:6px;font-size:0.8em">
      <span id="agent-dot" style="width:8px;height:8px;border-radius:50%;background:${agentStatus === 'connected' ? '#22c55e' : '#475569'};display:inline-block"></span>
      <span id="agent-label" style="color:${agentStatus === 'connected' ? '#86efac' : '#64748b'}">${agentStatus === 'connected' ? 'Fill Agent: Active' : 'Fill Agent: Off'}</span>
      ${agentStatus !== 'connected' ? `<button onclick="launchBrowser()" style="background:#1e3a5f;border:1px solid #3b82f6;color:#93c5fd;padding:3px 10px;border-radius:5px;font-size:0.9em;cursor:pointer">Launch Browser</button>` : ''}
    </div>
    ${tabBar(isQueue ? 'queue' : 'history', queueCount, historyCount, pendingCount)}
  </div>
</div>

<div class="content">
${filtered.length === 0
  ? `<div class="empty"><div style="font-size:2em;margin-bottom:12px">🎉</div><div>No jobs in this view.</div></div>`
  : `<table>
  <thead>
    <tr>
      <th>#</th>
      <th>Date</th>
      <th>Company</th>
      <th>Role</th>
      <th>Score</th>
      <th style="text-align:center">H1B</th>
      <th>Salary</th>
      <th>Status</th>
      <th style="text-align:center">Job</th>
      <th style="text-align:center">Resume</th>
      <th style="text-align:center">Cover</th>
      <th style="text-align:center">Report</th>
      <th>Notes</th>
      <th style="text-align:center">Action</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`}
</div>

<script>
// ── Fill Agent controls ───────────────────────────────────────────────────────
function launchBrowser() {
  fetch('/launch-browser', { method: 'POST' }).catch(() => {});
  const btn = document.querySelector('#agent-badge button');
  if (btn) { btn.disabled = true; btn.textContent = 'Launching…'; }
  // Poll for connection (Chrome takes ~3s to start)
  let tries = 0;
  const poll = setInterval(() => {
    fetch('/fill-agent-status').then(r => r.json()).then(d => {
      if (d.status === 'connected' || ++tries > 15) { clearInterval(poll); location.reload(); }
    }).catch(() => {});
  }, 1500);
}

function openFill(num, jobUrl) {
  fetch('/open-fill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: jobUrl }),
  })
  .then(r => r.json())
  .then(d => { if (!d.ok) alert('Could not open URL: ' + (d.error || 'Fill Agent not connected')); })
  .catch(() => alert('Request failed'));
}

// Unified click dispatcher for the "🌐 Open" action button. Picks the right
// underlying mechanism at click time based on fill-agent connection + URL kind.
// User sees one button label; the dispatch is invisible.
async function openJob(el, num, jobUrl, isLinkedIn) {
  let agentConnected = false;
  try {
    const r = await fetch('/fill-agent-status').then(r => r.json());
    agentConnected = r.status === 'connected';
  } catch {}

  if (agentConnected) {
    // Preferred: fill-agent Chrome opens the URL and auto-fills.
    openFill(num, jobUrl);
    return;
  }
  if (isLinkedIn) {
    // Fill-agent off: LinkedIn can't be auto-filled anyway, just open the link.
    window.open(jobUrl, '_blank');
    return;
  }
  // Fill-agent off + ATS URL: fall back to smart-apply (spawns Playwright in
  // a new Terminal). fillApplication() handles button label + polling.
  fillApplication(el, num);
}

// Live agent status badge updates via SSE
(function() {
  const dot   = document.getElementById('agent-dot');
  const label = document.getElementById('agent-label');
  const badge = document.getElementById('agent-badge');
  // Capture the agent's state at page-load time. If it was disconnected
  // server-side (the "Launch Browser" button rendered), the action-column
  // buttons rendered as 🌐 Open with the smart-apply fallback dispatch.
  // When the agent subsequently connects, behavior auto-upgrades on click —
  // no reload needed. Reload kept as a safety for badge visibility.
  const pageLoadedDisconnected = !!badge?.querySelector('button');
  const _es = window._agentES || (window._agentES = new EventSource('/events'));
  _es.onmessage = ev => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === 'agent') {
        if (d.status === 'connected') {
          if (pageLoadedDisconnected) {
            // First connection after a disconnected page-load — reload so the
            // row buttons re-render with the Fill Agent variant (🌐 Open).
            location.reload();
            return;
          }
          if (dot)   { dot.style.background = '#22c55e'; }
          if (label) { label.style.color = '#86efac'; label.textContent = 'Fill Agent: Active'; }
          badge?.querySelector('button')?.remove();
        } else if (d.status === 'disconnected') {
          if (dot)   { dot.style.background = '#475569'; }
          if (label) { label.style.color = '#64748b'; label.textContent = 'Fill Agent: Off'; }
        } else if (d.status === 'filling') {
          if (label) label.textContent = \`Filling \${d.ats}…\`;
        } else if (d.status === 'filled') {
          if (label) label.textContent = \`Filled (\${d.outcome})\`;
          setTimeout(() => { if (label) label.textContent = 'Fill Agent: Active'; }, 4000);
        }
      } else if (d.type === 'pdf_backfill') {
        let banner = document.getElementById('pdf-backfill-banner');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'pdf-backfill-banner';
          banner.style.cssText = 'background:#1e3a5f;color:#93c5fd;padding:7px 16px;font-size:0.8em;text-align:center;border-bottom:1px solid #2563eb';
          const content = document.querySelector('.content');
          content ? content.insertAdjacentElement('beforebegin', banner) : document.body.prepend(banner);
        }
        if (d.running) {
          const passInfo = d.pass ? \` · Pass \${d.pass}/2\` : '';
          banner.innerHTML = \`⏳ Generating missing resumes… <strong>\${d.done}/\${d.total}</strong> done\${d.failed > 0 ? \` · \${d.failed} failed\` : ''}\${passInfo}\`;
        } else {
          banner.innerHTML = \`✅ Resumes ready: <strong>\${d.done}</strong> generated\${d.failed > 0 ? \` · \${d.failed} failed\` : ''}  — reloading…\`;
          setTimeout(() => location.reload(), 2000);
        }
      } else if (d.type === 'validation') {
        // Tick B live update — render a fresh tick and swap into the placeholder.
        const el = document.getElementById('val-tick-' + d.num);
        if (el) el.innerHTML = renderValidationTick(d.validation);
      } else if (d.type === 'apply') {
        // Tick A live update — fillStatus has the new attach + resumeTier fields.
        const el = document.getElementById('attach-tick-' + d.num);
        if (el) el.innerHTML = renderAttachTick(d.fillStatus);
      }
    } catch {}
  };

  // ── Client-side tick renderers — mirror the server's HTML so SSE updates
  // produce visually identical output to a fresh page load.
  function escAttr(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function renderValidationTick(v) {
    if (!v || typeof v !== 'object') return '';
    const scoreNum = Number.isFinite(v.score) ? Math.round(v.score) : null;
    if (scoreNum == null) return '';
    const issues = Array.isArray(v.issues) ? v.issues.map(i => '• ' + i).join('\\n') : '';
    const axes = (v.axes && typeof v.axes === 'object')
      ? Object.entries(v.axes).map(([k, val]) => k + ': ' + val).join(' · ')
      : '';
    const ttl = 'Validator: ' + (v.valid === true ? 'PASS' : 'WITHHELD') + ' · score ' + scoreNum + '\\n' + axes + (issues ? '\\n\\nIssues:\\n' + issues : '');
    const color = v.valid === true ? '#16a34a' : '#d97706';
    const sym = v.valid === true ? '✓' : '⚠';
    return '<span style="color:' + color + ';font-size:0.85em;margin-left:4px;font-weight:600" title="' + escAttr(ttl) + '">' + sym + ' ' + scoreNum + '</span>';
  }
  function renderAttachTick(fillSt) {
    const at = fillSt?.attach;
    if (!at) return '';
    const tierLine = fillSt.resumeTier ? 'Tier: ' + fillSt.resumeTier + '\\n' : '';
    const intendedLine = at.intendedName ? 'Intended: ' + at.intendedName + '\\n' : '';
    const attachedLine = at.attachedName ? 'Attached: ' + at.attachedName + '\\n' : '';
    const reasonLine = at.reason ? 'Reason: ' + at.reason : '';
    const ttl = 'Attach verification\\n' + tierLine + intendedLine + attachedLine + reasonLine;
    if (at.attached === true && at.nameMatches && at.sizeMatches !== false) {
      return '<span style="color:#16a34a;font-size:0.85em;margin-left:4px;font-weight:600" title="' + escAttr(ttl) + '">✓</span>';
    } else if (at.attached === 'unknown') {
      return '<span style="color:#d97706;font-size:0.85em;margin-left:4px;font-weight:600" title="' + escAttr(ttl) + '">⚠</span>';
    } else if (at.attached === false) {
      return '<span style="color:#dc2626;font-size:0.85em;margin-left:4px;font-weight:600" title="' + escAttr(ttl) + '">⚠</span>';
    }
    return '';
  }

  // One-shot fetch on page load: render the banner from current backfill state
  // immediately, instead of waiting for the next SSE event (which only fires
  // when a PDF completes or state transitions — could take ~60s).
  // GET only — does NOT trigger a backfill. Server's startup setTimeout(10s)
  // handles auto-start.
  fetch('/api/pdf-backfill').then(r => r.json()).then(d => {
    if (!d?.stats) return;
    const { stats, missing } = d;
    // Nothing to show if not running and nothing missing
    if (!stats.running && (stats.done || 0) === 0 && (missing || 0) === 0) return;

    const banner = document.createElement('div');
    banner.id = 'pdf-backfill-banner';
    banner.style.cssText = 'background:#1e3a5f;color:#93c5fd;padding:7px 16px;font-size:0.8em;text-align:center;border-bottom:1px solid #2563eb';
    if (stats.running) {
      const passInfo = stats.pass ? \` · Pass \${stats.pass}/2\` : '';
      banner.innerHTML = \`⏳ Generating missing resumes… <strong>\${stats.done}/\${stats.total}</strong> done\${stats.failed > 0 ? \` · \${stats.failed} failed\` : ''}\${passInfo}\`;
    } else if ((missing || 0) > 0) {
      banner.innerHTML = \`ℹ️ <strong>\${missing}</strong> tailored resume\${missing === 1 ? '' : 's'} pending — backfill will start within ~10s\`;
    } else {
      banner.innerHTML = \`✅ Resumes ready: <strong>\${stats.done}</strong> generated\${stats.failed > 0 ? \` · \${stats.failed} failed\` : ''}\`;
    }
    const content = document.querySelector('.content');
    content ? content.insertAdjacentElement('beforebegin', banner) : document.body.prepend(banner);
  }).catch(() => {});
})();


function applyJob(el, num) {
  el.disabled = true;
  el.textContent = '...';
  fetch('/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ num })
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      const row = document.getElementById('row-' + num);
      if (row) {
        row.style.transition = 'opacity 0.5s';
        row.style.opacity = '0';
        setTimeout(() => row.remove(), 500);
      }
    } else {
      el.textContent = 'Error';
      el.disabled = false;
    }
  })
  .catch(() => { el.textContent = 'Error'; el.disabled = false; });
}
function openFolder(el, path) {
  const orig = el.textContent;
  el.textContent = '⏳';
  fetch('/open-folder?path=' + encodeURIComponent(path))
    .then(() => { el.textContent = '✅'; setTimeout(() => { el.textContent = orig; }, 1500); })
    .catch(() => { el.textContent = '❌'; setTimeout(() => { el.textContent = orig; }, 1500); });
}
function openFile(el, path) {
  const orig = el.textContent;
  el.textContent = '⏳';
  fetch('/open-file?path=' + encodeURIComponent(path))
    .then(() => { el.textContent = '✅'; setTimeout(() => { el.textContent = orig; }, 1500); })
    .catch(() => { el.textContent = '❌'; setTimeout(() => { el.textContent = orig; }, 1500); });
}
function editUrl(btn, num, currentUrl) {
  const row = document.getElementById('url-edit-row-' + num);
  const input = document.getElementById('url-input-' + num);
  row.style.display = 'block';
  input.value = currentUrl || '';
  input.focus();
  input.select();
}
function cancelEditUrl(num) {
  document.getElementById('url-edit-row-' + num).style.display = 'none';
}
function saveUrl(num) {
  const input = document.getElementById('url-input-' + num);
  const url = input.value.trim();
  if (!url || !url.startsWith('http')) { alert('Please enter a valid URL starting with http'); return; }
  input.disabled = true;
  fetch('/update-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ num, url })
  })
  .then(r => r.json())
  .then(d => {
    if (d.ok) { location.reload(); }
    else { alert('Error: ' + (d.error || 'unknown')); input.disabled = false; }
  })
  .catch(() => { alert('Request failed'); input.disabled = false; });
}

function discardJob(el, num) {
  el.disabled = true;
  fetch('/skip-app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ num })
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      const row = document.getElementById('row-' + num);
      if (row) { row.style.transition = 'opacity 0.4s'; row.style.opacity = '0'; setTimeout(() => row.remove(), 400); }
    } else {
      el.disabled = false;
    }
  })
  .catch(() => { el.disabled = false; });
}
function startCoverLetter(el, num) {
  el.disabled = true;
  el.textContent = '⏳';
  fetch('/cover-letter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ num })
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok && data.status === 'ready') {
      setCoverReady(num, data.outputFolder);
    } else if (data.ok) {
      pollCoverLetter(num, el);
    } else {
      el.textContent = '✉️❌';
      el.disabled = false;
      el.title = data.error || 'Failed';
    }
  })
  .catch(() => { el.textContent = '✉️❌'; el.disabled = false; });
}
function pollCoverLetter(num, el) {
  const check = () => {
    fetch('/cover-letter-status?num=' + num)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'ready') {
          setCoverReady(num, data.outputFolder);
        } else if (data.status === 'error') {
          const cell = document.getElementById('cover-' + num);
          if (cell) cell.innerHTML = '<button class="cover-btn" onclick="startCoverLetter(this,' + num + ')" title="Failed — click to retry">✉️❌</button>';
        } else {
          setTimeout(check, 3000);
        }
      })
      .catch(() => setTimeout(check, 5000));
  };
  setTimeout(check, 3000);
}
function setCoverReady(num, folder) {
  const cell = document.getElementById('cover-' + num);
  if (!cell) return;
  cell.innerHTML = '<span class="icon-link cover-ready" onclick="openFolder(this,\\'' + folder.replace(/'/g, "\\\\'") + '\\')" title="Cover letter ready — open folder" style="color:#16a34a;font-size:1.1em">✉️</span>';
}
function fillApplication(el, num) {
  el.disabled = true;
  el.textContent = '⏳ Filling…';
  fetch('/fill-application', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ num })
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      pollFillStatus(num, el);
    } else {
      el.textContent = '🌐 Open';
      el.disabled = false;
      el.title = data.error || 'Failed to launch';
    }
  })
  .catch(() => { el.textContent = '🌐 Open'; el.disabled = false; });
}
function pollFillStatus(num, el) {
  const FILL_STATUS_LABELS = {
    RUNNING: '⏳ Filling…',
    FILLED_PENDING_REVIEW: '✅ Review',
    NEEDS_ANSWER: '⚠️ Needs Answer',
    BLOCKED: '🔴 Blocked',
    DUPLICATE: '♻️ Duplicate',
    NEEDS_MANUAL: '🖱️ Manual',
    ERROR: '❌ Error'
  };
  const FILL_STATUS_COLORS = {
    RUNNING:               '#1d4ed8',
    FILLED_PENDING_REVIEW: '#16a34a',
    NEEDS_ANSWER:          '#d97706',
    BLOCKED:               '#dc2626',
    DUPLICATE:             '#7c3aed',
    NEEDS_MANUAL:          '#475569',
    ERROR:                 '#dc2626'
  };
  const check = () => {
    fetch('/fill-status?num=' + num)
      .then(r => r.json())
      .then(data => {
        const st = data.status;
        if (st === 'RUNNING' || st === 'idle') {
          setTimeout(check, 2000);
          return;
        }
        if (el) {
          el.textContent = '🌐 Open';
          el.disabled = false;
        }
        const badgeWrap = document.getElementById('fill-badge-' + num);
        if (badgeWrap) {
          const title = (data.needsAnswer || []).join(', ') || data.error || '';
          badgeWrap.innerHTML = '<span class="fill-status ' + st + '" title="' + title.replace(/"/g, '&quot;') + '">' + (st || '').replace(/_/g, ' ') + '</span>';
        }
      })
      .catch(() => setTimeout(check, 4000));
  };
  setTimeout(check, 2000);
}
const _hb = () => fetch('/heartbeat', { method: 'POST' }).catch(() => {});
setInterval(_hb, ${PING_INTERVAL_MS});
document.addEventListener('visibilitychange', () => { if (!document.hidden) _hb(); });
const _es = new EventSource('/events');
_es.addEventListener('shutdown', () => {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#64748b;font-family:-apple-system,sans-serif;font-size:1.1em">Dashboard offline — server stopped.</div>';
  window.close();
});

// Answer modal removed — manually-filled form fields are auto-captured on Submit
// via _coCapture (fill-agent) / _captureFormAnswers (smart-apply). The user just
// re-clicks 🌐 Open, fills the remaining questions in the form, and submits.
</script>
</body>
</html>`;
}

function renderReport(rawPath) {
  const safe = sanitizeReportPath(rawPath);
  if (!safe || !existsSync(safe)) return null;

  try {
    const md = readFileSync(safe, 'utf-8');
    const titleMatch = md.match(/^#\s+(.+)/m);
    const pageTitle = titleMatch ? titleMatch[1] : 'Report';
    const body = mdToHtml(md);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(pageTitle)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="report-wrap">
  <a href="javascript:history.back()" class="back-link">← Back</a>
  ${body}
</div>
<script>const _hb=()=>fetch('/heartbeat',{method:'POST'}).catch(()=>{});setInterval(_hb,${PING_INTERVAL_MS});document.addEventListener('visibilitychange',()=>{if(!document.hidden)_hb();});const _es=new EventSource('/events');_es.addEventListener('shutdown',()=>{document.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#64748b;font-family:sans-serif">Dashboard offline — server stopped.</div>';window.close();});</script>
</body>
</html>`;
  } catch {
    return null;
  }
}

function renderPending(items, apps) {
  // Tab badge counts MUST match the rendered table:
  // - Apply Queue: Evaluated + score ≥ 3.5 + last 3 business days (same as rendered)
  // - History: all active statuses + score ≥ 3.5 (no date cutoff)
  const queueCutoff = businessDayCutoff(3);
  const queueCount = apps.filter(a => a.status === 'Evaluated' && a.scoreVal >= 3.5 && (!a.date || a.date >= queueCutoff)).length;
  const historyCount = apps.filter(a => !['SKIP','Discarded'].includes(a.status) && a.scoreVal >= 3.5).length;

  function sourceColor(s) {
    if (!s) return '#475569';
    const l = s.toLowerCase();
    if (l.includes('fantastic')) return '#6366f1';
    if (l.includes('linkedin')) return '#0077b5';
    if (l.includes('greenhouse')) return '#3b82f6';
    if (l.includes('ashby')) return '#7c3aed';
    if (l.includes('lever')) return '#f59e0b';
    return '#475569';
  }

  const rows = items.map((item, idx) => {
    const sourceLabel = item.source || 'Manual';
    const sourceBadge = `<span class="source-badge" style="background:${sourceColor(item.source)}">${esc(sourceLabel)}</span>`;
    const jobLink = `<a href="${esc(item.url)}" target="_blank" class="icon-link" title="${esc(item.url)}">🔗</a>`;
    const skipBtn = `<button class="skip-btn" onclick="skipJob(this,'${esc(item.url)}')" title="Remove from pending">Skip</button>`;

    return `<tr id="pending-${idx}">
  <td style="text-align:center">${jobLink}</td>
  <td style="font-weight:600;white-space:nowrap">${esc(item.company) || '<span style="color:#475569">—</span>'}</td>
  <td style="color:#cbd5e1">${esc(item.role) || '<span style="color:#475569">—</span>'}</td>
  <td>${sourceBadge}</td>
  <td style="text-align:center">${skipBtn}</td>
</tr>`;
  }).join('\n');

  const subTitle = `${items.length} job${items.length !== 1 ? 's' : ''} waiting for pipeline evaluation`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Career Ops — Pending</title>
<style>${CSS}</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-left">
    <h1>Career Ops</h1>
    <div class="sub">${subTitle}</div>
  </div>
  <div class="topbar-right">
    ${tabBar('pending', queueCount, historyCount, items.length)}
  </div>
</div>
<div class="content">
${items.length === 0
  ? `<div class="empty"><div style="font-size:2em;margin-bottom:12px">✅</div><div>No pending jobs — pipeline.md is empty.</div><div style="margin-top:8px;font-size:0.85em;color:#64748b">Run <code style="background:#1e293b;padding:2px 6px;border-radius:4px">/career-ops pipeline</code> in Claude Code to evaluate any jobs.</div></div>`
  : `<div style="padding:12px 0 4px;color:#64748b;font-size:0.82em">Click a job link to preview it, then Skip anything obviously wrong before running <strong style="color:#94a3b8">/career-ops pipeline</strong> in Claude Code.</div>
<table>
  <thead>
    <tr>
      <th style="text-align:center">Job</th>
      <th>Company</th>
      <th>Role</th>
      <th>Source</th>
      <th style="text-align:center">Action</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`}
</div>
<script>
function skipJob(el, url) {
  el.disabled = true; el.textContent = '...';
  fetch('/skip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
    .then(r => r.json())
    .then(d => {
      if (d.ok) { el.closest('tr').style.opacity = '0.3'; el.textContent = 'Skipped'; }
      else { el.textContent = 'Error'; el.disabled = false; }
    })
    .catch(() => { el.textContent = 'Error'; el.disabled = false; });
}
const _hb = () => fetch('/heartbeat', { method: 'POST' }).catch(() => {});
setInterval(_hb, ${PING_INTERVAL_MS});
document.addEventListener('visibilitychange', () => { if (!document.hidden) _hb(); });
const _es = new EventSource('/events');
_es.addEventListener('shutdown', () => {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#64748b;font-family:-apple-system,sans-serif;font-size:1.1em">Dashboard offline — server stopped.</div>';
  window.close();
});
</script>
</body>
</html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (url.pathname === '/heartbeat') {
    lastPing = Date.now();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname === '/skip' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { url: jobUrl } = JSON.parse(body);
        const result = skipPipelineItem(jobUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/skip-app' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { num } = JSON.parse(body);
        const result = updateApplicationStatus(parseInt(num), 'Discarded');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/update-url' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { num, url: newUrl } = JSON.parse(body);
        if (!newUrl || !newUrl.startsWith('http')) throw new Error('Invalid URL');
        // Find report path from tracker
        const lines = readFileSync(join(CAREER_OPS, 'data', 'applications.md'), 'utf-8').split('\n');
        let reportPath = null;
        for (const line of lines) {
          if (!line.startsWith('|')) continue;
          const cols = line.split('|').map(c => c.trim());
          if (cols[1] !== String(num)) continue;
          const m = (cols[8]||'').match(/\[(\d+)\]\(([^)]+)\)/);
          if (m) {
            const rel = m[2].replace(/^(\.\.\/)+/, '');
            reportPath = join(CAREER_OPS, rel);
          }
          break;
        }
        if (!reportPath || !existsSync(reportPath)) throw new Error('Report not found for job #' + num);
        const content = readFileSync(reportPath, 'utf-8');
        const updated = content.replace(/^(\*\*URL:\*\*\s*)https?:\/\/\S+/m, `$1${newUrl}`);
        if (updated === content) throw new Error('URL field not found in report');
        writeFileSync(reportPath, updated);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/apply' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { num } = JSON.parse(body);
        const result = updateApplicationStatus(parseInt(num), 'Applied');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/open-folder') {
    const raw = url.searchParams.get('path') || '';
    const safe = sanitizeFolderPath(raw);
    if (!safe) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    exec(`open "${safe.replace(/"/g, '\\"')}"`, () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    return;
  }

  if (url.pathname === '/open-file') {
    const raw = url.searchParams.get('path') || '';
    const safe = sanitizeResumePath(raw);
    if (!safe) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    exec(`open "${safe.replace(/"/g, '\\"')}"`, () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    return;
  }

  if (url.pathname === '/cover-letter' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { num } = JSON.parse(body);
        const apps = parseApplications();
        const app = apps.find(a => a.num === num);
        if (!app || !app.reportPath) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Job or report not found' }));
          return;
        }

        // Already generating?
        const existing = coverLetterJobs.get(num);
        if (existing?.status === 'generating') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'generating' }));
          return;
        }

        // Already done?
        const outputFolder = findOrCreateOutputFolder(num, app.reportPath);
        if (outputFolder && existsSync(join(outputFolder, 'cover-letter.html'))) {
          coverLetterJobs.set(num, { status: 'ready', outputFolder });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'ready', outputFolder }));
          return;
        }

        if (!outputFolder) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Cannot determine output folder' }));
          return;
        }

        coverLetterJobs.set(num, { status: 'generating' });
        spawnCoverLetter(num, app.reportPath, outputFolder);

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'generating' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/cover-letter-status') {
    const num = parseInt(url.searchParams.get('num'));
    const job = coverLetterJobs.get(num);
    if (job) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(job));
      return;
    }
    // Check disk if no in-memory record
    const apps = parseApplications();
    const app = apps.find(a => a.num === num);
    const folder = app?.reportPath ? findOutputFolder(num) : null;
    if (folder && existsSync(join(folder, 'cover-letter.html'))) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', outputFolder: folder }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'idle' }));
    return;
  }

  if (url.pathname === '/fill-application' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { num } = JSON.parse(body);
        if (!num) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'num required' })); return; }
        // Reject if already running
        const st = readApplyStatus(num);
        if (st?.status === 'RUNNING') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, status: 'RUNNING' }));
          return;
        }
        spawnSmartApply(num);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'RUNNING' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/fill-status') {
    const num = parseInt(url.searchParams.get('num'));
    const st = readApplyStatus(num);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(st || { status: 'idle' }));
    return;
  }

  if (url.pathname === '/fill-agent-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: agentStatus }));
    return;
  }

  if (url.pathname === '/launch-browser' && req.method === 'POST') {
    const script = join(CAREER_OPS, 'launch-chrome.sh');
    exec(`bash "${script}"`, (err) => {
      if (err) console.warn('[dashboard] launch-chrome.sh error:', err.message);
    });
    // Try connecting the agent after a short delay for Chrome to start
    setTimeout(async () => {
      if (!fillAgent.connected) {
        const ok = await fillAgent.connect();
        if (ok) agentStatus = 'connected';
      }
    }, 3000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/open-fill' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { url: jobUrl } = JSON.parse(body);
        if (!jobUrl) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'url required' })); return; }
        if (!fillAgent.connected) { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'Fill Agent not connected' })); return; }
        const ok = await fillAgent.openUrl(jobUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/report') {
    const reportPath = url.searchParams.get('path') || '';
    const html = renderReport(reportPath);
    if (!html) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Report not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (url.pathname === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Shutting down…');
    setTimeout(() => process.exit(0), 200);
    return;
  }

  if (url.pathname === '/') {
    const mode = url.searchParams.get('mode') || 'queue';
    const apps = parseApplications();
    const pending = parsePending();

    if (mode === 'pending') {
      const html = renderPending(pending, apps);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } else {
      const html = renderDashboard(apps, mode, pending.length);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    }
    return;
  }

  if (url.pathname === '/api/pdf-backfill') {
    if (req.method === 'POST') {
      startPdfBackfill();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats: pdfBackfillStats }));
      return;
    }
    // GET — return current status + missing count (scoped to 3-day window)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ missing: countMissingQueuePdfs(businessDayCutoff(3)), stats: pdfBackfillStats }));
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

function broadcastShutdown() {
  for (const client of sseClients) {
    try { client.write('event: shutdown\ndata: bye\n\n'); } catch {}
  }
}

process.on('SIGINT',  () => { broadcastShutdown(); setTimeout(() => process.exit(0), 400); });
process.on('SIGTERM', () => { broadcastShutdown(); setTimeout(() => process.exit(0), 400); });

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Career Ops Dashboard → ${url}`);
  console.log('Press Ctrl+C to stop.\n');

  // Live tick updates: fs.watch the output/ and apply-status/ folders so
  // validation.json + apply-status writes broadcast SSE → dashboard updates in place.
  setupLiveTickWatchers();

  // Auto-start PDF backfill after 10s (let fill-agent connect and Chrome settle first)
  setTimeout(() => startPdfBackfill(), 10000);

  // Auto-start validation backfill after 20s. Runs in parallel to PDF backfill
  // — covers rows that already have tailored PDFs but no validation.json yet
  // (e.g. PDFs generated before the validator existed). New PDFs being created
  // by the PDF backfill above are handled separately by the per-PDF hook in
  // generate-missing-pdfs.mjs (fireValidationIfEligible).
  setTimeout(() => startValidationBackfill(), 20000);

  // Watchdog: shut down when the browser tab is closed (heartbeat stops).
  // Exception: if the PDF backfill is currently running, keep the server
  // alive so it can finish — the user can close the tab and walk away.
  // Normal shutdown resumes once backfill is done and pings still missing.
  let backfillKeepAliveLogged = false;
  setTimeout(() => {
    setInterval(() => {
      if (Date.now() - lastPing <= PING_TIMEOUT_MS) {
        backfillKeepAliveLogged = false; // user is back, reset the log latch
        return;
      }
      if (pdfBackfillStats.running) {
        if (!backfillKeepAliveLogged) {
          console.log(`[heartbeat] browser gone but backfill running (${pdfBackfillStats.done}/${pdfBackfillStats.total}) — keeping server alive`);
          backfillKeepAliveLogged = true;
        }
        return;
      }
      console.log('Browser disconnected — shutting down.');
      process.exit(0);
    }, PING_INTERVAL_MS);
  }, GRACE_PERIOD_MS);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: node dashboard-server.mjs --port 4000`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});
