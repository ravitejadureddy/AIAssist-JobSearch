#!/usr/bin/env node
/**
 * fill-agent.mjs — CDP-based auto-fill agent.
 *
 * Connects to a Chrome instance launched with --remote-debugging-port=9222
 * and watches every tab. When the user navigates to a supported ATS application
 * page, it fills the form automatically using profile data + saved answers.
 *
 * Used by dashboard-server.mjs — not meant to be run directly.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import {
  fillGreenhouse, fillLever, fillAshby, fillWorkday, fillGeneric,
  detectATS, loadAnswers, isWorkAuthLabel, workAuthAnswer, CAREER_OPS,
} from './smart-apply.mjs';

const CDP_URL  = 'http://localhost:9222';
const TRACKER  = join(CAREER_OPS, 'data', 'applications.md');
const ANSWERS_FILE = join(CAREER_OPS, 'data', 'application_answers.json');

// ── URL index: maps jobUrl → tracker job (built lazily, refreshed every 60s) ──
let _urlIndex = null;
let _urlIndexAt = 0;
function getUrlIndex() {
  if (_urlIndex && Date.now() - _urlIndexAt < 60_000) return _urlIndex;
  const index = new Map();
  if (!existsSync(TRACKER)) { _urlIndex = index; _urlIndexAt = Date.now(); return index; }
  try {
    const lines = readFileSync(TRACKER, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.startsWith('|')) continue;
      const cols = line.split('|').slice(1, -1).map(s => s.trim());
      if (cols.length < 8) continue;
      const [num, date, company, role, score, status, pdf, report, ...noteParts] = cols;
      const rMatch = report.match(/\(([^)]+\.md)\)/);
      if (!rMatch) continue;
      const rPath = rMatch[1].replace(/^(\.\.\/)+/, '');
      const fullPath = resolve(join(CAREER_OPS, rPath));
      if (!existsSync(fullPath)) continue;
      const text = readFileSync(fullPath, 'utf-8');
      const urlM = text.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/i);
      if (!urlM) continue;
      const jobUrl = urlM[1].trim();
      const notes = noteParts.join(' | ').trim();
      const cvMatch = notes.match(/Recommended CV:\s*(Resume\/[^\s|]+\.pdf)/i);
      index.set(jobUrl, {
        num: parseInt(num), date, company, role, score, status, notes,
        recommendedCv: cvMatch ? cvMatch[1] : null,
        reportPath: rPath,
      });
    }
  } catch {}
  _urlIndex = index;
  _urlIndexAt = Date.now();
  return index;
}

function findJobByUrl(url) {
  const index = getUrlIndex();
  // Exact match
  if (index.has(url)) return index.get(url);
  // Partial match — URL in tracker may have extra query params or be a prefix
  for (const [key, job] of index) {
    if (url.startsWith(key) || key.startsWith(url)) return job;
  }
  return null;
}

function findResume(job) {
  // Tier 1: tailored PDF in output/{reportNum}-{slug}/
  if (job?.reportPath) {
    const m = job.reportPath.match(/(\d+)-([^/]+)\.md$/);
    if (m) {
      const [, rNum, slug] = m;
      const tailored = join(CAREER_OPS, 'output', `${rNum}-${slug}`, 'resume.pdf');
      if (existsSync(tailored)) return tailored;
    }
  }
  // Tier 2: Recommended CV from tracker notes
  if (job?.recommendedCv) {
    const p = join(CAREER_OPS, job.recommendedCv);
    if (existsSync(p)) return p;
  }
  // Tier 3: generic fallback
  const generic = join(CAREER_OPS, 'Resume', 'generic', 'resume.pdf');
  if (existsSync(generic)) return generic;
  return null;
}

// ── In-page status banner ─────────────────────────────────────────────────────
async function injectBanner(page, result) {
  const fieldsFound = result.fieldsFound ?? 0;
  const needsCount  = result.needsAnswer?.length ?? 0;
  const bgColor = result.outcome === 'FILLED_PENDING_REVIEW' ? '#15803d'
                : result.outcome === 'NEEDS_ANSWER'          ? '#b45309'
                : '#991b1b';

  let msg;
  if (result.outcome === 'FILLED_PENDING_REVIEW') {
    msg = `✅ career-ops: filled the form. Review and submit when ready.`;
  } else if (result.outcome === 'NEEDS_ANSWER') {
    msg = `⚡ career-ops: filled what it could — ${needsCount} question(s) highlighted below need your input.`;
  } else if (result.outcome === 'NEEDS_MANUAL') {
    msg = `🖱️ career-ops: ${result.reason || 'form not reached — fill manually.'}`;
  } else {
    msg = `career-ops: ${result.outcome}${result.error ? ' — ' + result.error : ''}`;
  }

  // Append wizard hint: if a Next/Continue button is visible, this is a
  // multi-step form. After review + click Next, the agent re-fires on the
  // new URL/page state.
  if (result.hasNextStep && result.outcome !== 'NEEDS_MANUAL') {
    msg += `  ▶ Multi-step form: after reviewing, click "${result.nextLabel}" to advance.`;
  }

  await page.evaluate(({ msg, bgColor, needsAnswer }) => {
    document.getElementById('_co_banner')?.remove();
    const el = document.createElement('div');
    el.id = '_co_banner';
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      `background:${bgColor}`, 'color:#fff', 'padding:10px 16px',
      'font:600 13px/1.4 -apple-system,sans-serif', 'display:flex',
      'align-items:center', 'gap:10px', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
    ].join(';');
    el.textContent = msg;
    const x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'margin-left:auto;background:none;border:none;color:#fff;cursor:pointer;font-size:16px;padding:0 4px';
    x.onclick = () => el.remove();
    el.appendChild(x);
    document.body.prepend(el);

    // Yellow outline on fields the agent couldn't answer
    if (needsAnswer?.length) {
      needsAnswer.forEach(q => {
        const qLow = q.toLowerCase();
        document.querySelectorAll('label').forEach(lbl => {
          if (!lbl.textContent?.toLowerCase().includes(qLow)) return;
          const field = document.getElementById(lbl.htmlFor) ||
                        lbl.parentElement?.querySelector('input,textarea,select');
          if (field) { field.style.outline = '2px solid #eab308'; field.style.outlineOffset = '2px'; }
        });
      });
    }
  }, { msg, bgColor, needsAnswer: result.needsAnswer || [] }).catch(() => {});
}

// ── Answer capture — fires when user submits the form ────────────────────────
async function setupAnswerCapture(page, job) {
  const companyTokens = (job?.company || '')
    .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 2);

  // Expose a Node callback the page JS can call
  await page.exposeFunction('_coCapture', async (fields) => {
    if (!existsSync(ANSWERS_FILE)) return;
    try {
      const data = JSON.parse(readFileSync(ANSWERS_FILE, 'utf-8'));
      let added = 0;
      for (const { label, value, _type } of fields) {
        if (!label || !value?.trim()) continue;
        const lbl = label.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();

        // Skip profile fields
        if (/^(first|last|full.?name|email|phone|city|state|zip|postal|location|country|linkedin|website|github|address)/.test(lbl)) continue;
        // Skip work auth — hardcoded, never override
        if (isWorkAuthLabel(label)) continue;
        // Skip company-specific (contains company name tokens)
        if (companyTokens.length && companyTokens.some(t => lbl.includes(t))) continue;
        // Skip if already covered
        const covered = data.answers?.some(a =>
          a.patterns?.some(p => lbl.includes(p.toLowerCase()) || p.toLowerCase().includes(lbl.slice(0, 20)))
        );
        if (covered) continue;

        // Persisted answer type. Hint from the page tells us if this was a
        // dropdown / radio / yes-no; for free text we still classify by length
        // to distinguish text vs textarea.
        let persistType;
        if      (_type === 'yesno')    persistType = 'yesno';
        else if (_type === 'dropdown') persistType = 'dropdown_or_text';
        else if (_type === 'radio')    persistType = 'radio_or_text';
        else if (_type === 'textarea') persistType = 'textarea';
        else persistType = value.trim().split(/\s+/).length > 10 ? 'textarea' : 'text';

        const id = lbl.replace(/\s+/g, '_').slice(0, 50);
        data.answers = data.answers || [];
        data.answers.push({
          id, patterns: [lbl], answer: value.trim(),
          answer_short: value.trim().length > 80 ? value.trim().slice(0, 77) + '…' : value.trim(),
          type: persistType,
          _source: 'fill-agent',
        });
        added++;
        console.log(`  [fill-agent] Saved (${persistType}): "${label}" → "${value.trim().slice(0, 60)}"`);
      }
      if (added) writeFileSync(ANSWERS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('[fill-agent] answer capture error:', e.message);
    }
  }).catch(() => {}); // ignore if already exposed

  await page.evaluate(() => {
    // Shared label discovery — finds the question label for any form field
    // by walking up to the wrapper element (works for text, select, radios).
    const labelFor = (el) => {
      // Direct <label for="id"> binding
      const direct = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (direct) return direct.textContent;
      // <fieldset><legend>…</legend>  — common for radio groups
      const fs = el.closest('fieldset');
      if (fs) {
        const legend = fs.querySelector('legend');
        if (legend) return legend.textContent;
      }
      // First label inside the wrapping field/container
      const wrap = el.closest('[class*="wrapper"],[class*="field"],[class*="container"],[class*="question"],[role="group"]');
      const lbl = wrap?.querySelector('label');
      if (lbl) return lbl.textContent;
      // aria-labelledby / aria-label / placeholder fallback
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ref = document.getElementById(labelledBy);
        if (ref) return ref.textContent;
      }
      return el.getAttribute('aria-label') || el.placeholder || '';
    };

    const cleanLabel = (raw) => (raw || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();

    // Placeholder option detection for selects (skip "-- Select --", "Choose…", etc.)
    const isPlaceholderOption = (text) =>
      !text || /^[\s\-—•]*(select|choose|none|please|pick|--)/i.test(text.trim());

    const capture = () => {
      const fields = [];

      // 1. Text inputs + textareas (unchanged behaviour)
      document.querySelectorAll('input[type="text"],input[type="tel"],input[type="email"],input[type="number"],input:not([type]),textarea').forEach(el => {
        if (!el.value?.trim()) return;
        const label = cleanLabel(labelFor(el));
        if (label?.length > 2) fields.push({ label, value: el.value.trim(), _type: el.tagName === 'TEXTAREA' ? 'textarea' : 'text' });
      });

      // 2. Native <select> dropdowns — capture the human-readable text of the
      //    selected option (not the underlying value, which is often a code).
      document.querySelectorAll('select').forEach(el => {
        if (el.disabled || !el.value || el.value === '') return;
        const sel = el.options[el.selectedIndex];
        if (!sel) return;
        const optText = sel.textContent?.trim() || el.value;
        if (isPlaceholderOption(optText)) return;
        const label = cleanLabel(labelFor(el));
        if (label?.length > 2) fields.push({ label, value: optText, _type: 'dropdown' });
      });

      // 3. Radio button groups — one entry per group (by name), use the
      //    checked radio's own label text as the value.
      const seenRadioGroups = new Set();
      document.querySelectorAll('input[type="radio"]:checked').forEach(el => {
        if (el.disabled) return;
        const groupKey = el.name || el.getAttribute('aria-labelledby') || '';
        if (groupKey && seenRadioGroups.has(groupKey)) return;
        if (groupKey) seenRadioGroups.add(groupKey);

        // Option label: <label>Yes</label> wrapping the input, or label[for=id],
        // or the input's value attribute as last resort.
        let optionText = '';
        const wrapLabel = el.closest('label');
        if (wrapLabel) {
          // Clone the label, strip the input itself, then read remaining text
          const clone = wrapLabel.cloneNode(true);
          clone.querySelectorAll('input').forEach(n => n.remove());
          optionText = clone.textContent?.trim() || '';
        }
        if (!optionText && el.id) {
          optionText = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() || '';
        }
        if (!optionText) optionText = el.value || '';
        if (!optionText) return;

        // Question label: prefer fieldset/legend, then wrapper label that doesn't
        // wrap the radio option itself.
        let questionLabelEl = null;
        const fs = el.closest('fieldset');
        if (fs) questionLabelEl = fs.querySelector('legend');
        if (!questionLabelEl) {
          const wrap = el.closest('[class*="wrapper"],[class*="field"],[class*="container"],[class*="question"],[role="group"]');
          if (wrap) {
            for (const l of wrap.querySelectorAll('label')) {
              if (l.contains(el)) continue; // skip the radio's own option label
              questionLabelEl = l; break;
            }
          }
        }
        const label = cleanLabel(questionLabelEl?.textContent);
        if (label?.length > 2) {
          // Detect Yes/No radios — save with type 'yesno' so future filling
          // matches the existing application_answers.json convention.
          const ot = optionText.toLowerCase();
          const _type = (ot === 'yes' || ot === 'no') ? 'yesno' : 'radio';
          fields.push({ label, value: optionText, _type });
        }
      });

      if (window._coCapture) window._coCapture(fields);
    };
    document.querySelectorAll('button[type="submit"],input[type="submit"]').forEach(b => b.addEventListener('click', capture, { once: true }));
    document.querySelectorAll('button').forEach(b => {
      const t = (b.textContent || '').toLowerCase().trim();
      if (['submit','submit application','apply now','apply'].includes(t)) b.addEventListener('click', capture, { once: true });
    });
    document.querySelectorAll('form').forEach(f => f.addEventListener('submit', capture, { once: true }));
  }).catch(() => {});
}

// ── Core fill dispatcher ──────────────────────────────────────────────────────
async function fillPage(page, url, ats) {
  const job         = findJobByUrl(url);
  const answersData = loadAnswers();
  const resumePath  = findResume(job);

  console.log(`[fill-agent] ${ats.toUpperCase()} — ${job ? job.company + ' / ' + job.role : 'unmatched job'}`);

  let result;
  try {
    if      (ats === 'greenhouse')     result = await fillGreenhouse(page, job, answersData, resumePath);
    else if (ats === 'lever')          result = await fillLever(page, job, answersData, resumePath);
    else if (ats === 'ashby')          result = await fillAshby(page, job, answersData, resumePath);
    else if (ats === 'workday')        result = await fillWorkday(page, job, answersData, resumePath);
    else if (isLikelyApplyUrl(url))    result = await fillGeneric(page, job, answersData, resumePath);
    else result = { outcome: 'NEEDS_MANUAL', reason: `ATS "${ats}" not yet supported` };
  } catch (err) {
    result = { outcome: 'ERROR', error: err.message };
  }

  await injectBanner(page, result);
  await setupAnswerCapture(page, job);
  return result;
}

// ── ATS URL filter — only fire for pages that look like application forms ─────
const SKIP_URL_PREFIXES = ['chrome:', 'about:', 'chrome-extension:'];
const SKIP_HOSTS = ['linkedin.com', 'google.com', 'github.com', 'stackoverflow.com'];

// Generic-handler eligibility: URL or hostname strongly suggests an application
// page. Without this the generic handler would fire on any random web page.
function isLikelyApplyUrl(url) {
  if (!url?.startsWith('http')) return false;
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const host = u.hostname.toLowerCase();
    // Path looks like an apply step (matches careers.*/apply, *.com/job/.../apply, etc.)
    if (/\/(apply|application|applicant)(\/|$|\?)/.test(path)) return true;
    if (/\/careers?\/.*(apply|application|job|position|opening)/.test(path)) return true;
    // Host is a careers subdomain AND path mentions the role
    if (/^(careers?|jobs?|recruit|hiring|talent|apply)\./.test(host) && /\/(job|position|career|apply)/.test(path)) return true;
    // Embedded apply widget on the main marketing site
    if (/careers?|jobs?/.test(path) && /(apply|application)/.test(path)) return true;
  } catch {}
  return false;
}

function shouldWatch(url) {
  if (!url?.startsWith('http')) return false;
  if (SKIP_URL_PREFIXES.some(p => url.startsWith(p))) return false;
  try {
    const host = new URL(url).hostname;
    if (SKIP_HOSTS.some(h => host.includes(h))) return false;
  } catch { return false; }
  const ats = detectATS(url);
  if (ats !== 'unknown' && ats !== 'linkedin') return true;
  // Unknown ATS: still watch if the URL looks like an apply page so the
  // generic fallback can fire (custom company career sites).
  return isLikelyApplyUrl(url);
}

// ── FillAgent class ───────────────────────────────────────────────────────────
class FillAgent {
  constructor() {
    this.browser   = null;
    this.connected = false;
    this._listeners = new Set();
    this._pendingPages = new Set(); // debounce rapid navigations
  }

  on(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }
  _emit(event) { for (const cb of this._listeners) { try { cb(event); } catch {} } }

  async connect() {
    try {
      this.browser = await chromium.connectOverCDP(CDP_URL);
      this.connected = true;
      this._emit({ type: 'connected' });
      console.log('[fill-agent] Connected to Chrome.');

      // Watch existing + future pages across all contexts
      const watchCtx = (ctx) => {
        ctx.pages().forEach(p => this._watchPage(p));
        ctx.on('page', p => this._watchPage(p));
      };
      for (const ctx of this.browser.contexts()) watchCtx(ctx);
      this.browser.on('context', ctx => watchCtx(ctx)); // new incognito etc.

      this.browser.on('disconnected', () => {
        this.browser    = null;
        this.connected  = false;
        this._emit({ type: 'disconnected' });
        console.log('[fill-agent] Chrome disconnected.');
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  _watchPage(page) {
    page.on('framenavigated', async frame => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!shouldWatch(url)) return;

      // Debounce: if the same page fires multiple navigations in quick succession
      // (Workday does this during its multi-step flow), only process the final one
      this._pendingPages.add(page);
      await new Promise(r => setTimeout(r, 3500));
      if (!this._pendingPages.has(page)) return; // superseded
      this._pendingPages.delete(page);

      const ats = detectATS(url);
      this._emit({ type: 'filling', url, ats });
      try {
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
        const result = await fillPage(page, url, ats);
        this._emit({ type: 'filled', url, ats, result });
        console.log(`[fill-agent] ${ats} → ${result.outcome}`);
      } catch (err) {
        this._emit({ type: 'error', url, ats, error: err.message });
        console.warn(`[fill-agent] error on ${url}: ${err.message}`);
      }
    });
  }

  // Open a URL in the connected Chrome (for dashboard "Open & Fill" button)
  async openUrl(url) {
    if (!this.browser || !this.connected) return false;
    try {
      const contexts = this.browser.contexts();
      const ctx = contexts[0];
      if (!ctx) return false;
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      return true;
    } catch { return false; }
  }

  disconnect() {
    if (this.browser) { this.browser.close().catch(() => {}); }
    this.browser    = null;
    this.connected  = false;
  }
}

export const fillAgent = new FillAgent();
