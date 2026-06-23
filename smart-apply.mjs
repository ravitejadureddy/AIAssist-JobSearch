#!/usr/bin/env node
/**
 * smart-apply.mjs — Playwright-based application auto-fill assistant.
 *
 * Fills Greenhouse / Lever / Ashby application forms deterministically from
 * config/profile.yml, data/application_answers.json, and the job's Recommended CV.
 *
 * Work auth answers (US authorized = Yes, requires H-1B = Yes) are hardcoded
 * and NEVER delegated to LLM.
 *
 * Stops at the final review page — NEVER auto-submits.
 *
 * Usage:
 *   node smart-apply.mjs --num 123
 *   node smart-apply.mjs --url https://boards.greenhouse.io/company/jobs/12345
 *   node smart-apply.mjs --num 123 --headless     (background mode, screenshot only)
 *
 * Status written to: data/apply-status/{num}.json
 * Screenshots saved to: data/apply-screenshots/{num}-{timestamp}.png
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const isMain = resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);

// ─── Status constants (dashboard display only — NOT in states.yml) ────────────
export const APPLY_STATUS = {
  RUNNING:              'RUNNING',
  FILLED_PENDING_REVIEW:'FILLED_PENDING_REVIEW',
  NEEDS_ANSWER:         'NEEDS_ANSWER',
  BLOCKED:              'BLOCKED',
  DUPLICATE:            'DUPLICATE',
  NEEDS_MANUAL:         'NEEDS_MANUAL',
  ERROR:                'ERROR',
};

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}
const numArg    = getArg('--num');
const urlArg    = getArg('--url');
const headless  = args.includes('--headless');

if (isMain && !numArg && !urlArg) {
  console.error('Usage: node smart-apply.mjs --num <num> | --url <url>');
  process.exit(1);
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function statusDir()  { return join(CAREER_OPS, 'data', 'apply-status'); }
function ssDir()      { return join(CAREER_OPS, 'data', 'apply-screenshots'); }

function writeStatus(num, status, extra = {}) {
  mkdirSync(statusDir(), { recursive: true });
  const path = join(statusDir(), `${num}.json`);
  writeFileSync(path, JSON.stringify({ num, status, updatedAt: new Date().toISOString(), ...extra }, null, 2));
}

function readStatus(num) {
  const path = join(statusDir(), `${num}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

// ─── Tracker lookup ───────────────────────────────────────────────────────────
function lookupJob(num) {
  const path = join(CAREER_OPS, 'data', 'applications.md');
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').slice(1, -1).map(s => s.trim());
    if (cols.length < 8) continue;
    const [rowNum, date, company, role, score, status, pdf, report, ...noteParts] = cols;
    if (parseInt(rowNum) !== parseInt(num)) continue;
    const notes = noteParts.join(' | ').trim();
    const cvMatch = notes.match(/Recommended CV:\s*(Resume\/[^\s|]+\.pdf)/i);
    const reportMatch = report.match(/\(([^)]+\.md)\)/);
    return { num: parseInt(rowNum), date, company, role, score, status, notes,
             recommendedCv: cvMatch ? cvMatch[1] : null,
             reportPath: reportMatch ? reportMatch[1] : null };
  }
  return null;
}

// ─── Extract job URL from report file ────────────────────────────────────────
function extractUrlFromReport(reportPath) {
  if (!reportPath) return null;
  const normalized = reportPath.replace(/^(\.\.\/)+/, '');
  const full = resolve(join(CAREER_OPS, normalized));
  if (!existsSync(full)) return null;
  try {
    const text = readFileSync(full, 'utf-8');
    const m = text.match(/\*\*URL:\*\*\s*(https?:\/\/[^\s\n]+)/i);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// ─── ATS detection ────────────────────────────────────────────────────────────
function detectATS(url) {
  if (!url) return 'unknown';
  if (/greenhouse\.io/i.test(url))                                  return 'greenhouse';
  if (/lever\.co/i.test(url))                                       return 'lever';
  if (/ashbyhq\.com/i.test(url) || /ashby\.com/i.test(url))        return 'ashby';
  if (/workday\.com/i.test(url) || /myworkdayjobs\.com/i.test(url)) return 'workday';
  if (/icims\.com/i.test(url))                                      return 'icims';
  if (/taleo\.net/i.test(url))                                      return 'taleo';
  if (/bamboohr\.com/i.test(url))                                   return 'bamboohr';
  if (/smartrecruiters\.com/i.test(url))                            return 'smartrecruiters';
  if (/jobvite\.com/i.test(url))                                    return 'jobvite';
  if (/linkedin\.com\/jobs/i.test(url))                             return 'linkedin';
  if (/rippling\.com/i.test(url))                                   return 'rippling';
  if (/dover\.com/i.test(url))                                      return 'dover';
  if (/successfactors\.com|successfactors\.eu/i.test(url))         return 'successfactors';
  return 'unknown';
}

// ─── Answer matching ──────────────────────────────────────────────────────────
function loadAnswers() {
  const path = join(CAREER_OPS, 'data', 'application_answers.json');
  if (!existsSync(path)) throw new Error('data/application_answers.json not found');
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function matchAnswer(label, answersData) {
  const labelLower = label.toLowerCase().replace(/[*:?]/g, '').trim();
  for (const ans of answersData.answers) {
    for (const pat of ans.patterns) {
      if (labelLower.includes(pat.toLowerCase())) return ans;
    }
  }
  return null;
}

// ─── Work auth detection ──────────────────────────────────────────────────────
function isWorkAuthLabel(label) {
  const l = label.toLowerCase();
  return l.includes('authorized to work') || l.includes('work authorization') ||
         l.includes('sponsorship') || l.includes('require visa') ||
         l.includes('visa sponsorship') || l.includes('us citizen') ||
         l.includes('work in the us') || l.includes('work in the united states') ||
         l.includes('eligible to work') || l.includes('h-1b') || l.includes('h1b') ||
         l.includes('immigration') || l.includes('legal right') ||
         l.includes('permit to work');
}

function workAuthAnswer(label, answersData) {
  const l = label.toLowerCase();
  const auth = answersData.work_auth;

  // Detect negation in the question (e.g., "Do you NOT require sponsorship?",
  // "Are you NOT authorized to work?"). Invert the canonical Yes/No answer.
  // We deliberately don't treat double negatives — those phrasings are rare
  // enough that letting the user fix them manually is safer.
  const negated = /\b(not|don'?t|do not|cannot|won'?t|will not)\b/i.test(l);
  const invert = (yesNoText) => {
    if (!yesNoText) return yesNoText;
    if (/^yes$/i.test(yesNoText.trim())) return 'No';
    if (/^no$/i.test(yesNoText.trim())) return 'Yes';
    return yesNoText;
  };
  const maybeInvert = (text) => negated ? invert(text) : text;

  // "authorized to work in the US?" → Yes (or No if negated)
  if (l.includes('authorized') && !l.includes('sponsor')) return maybeInvert(auth.authorized_to_work_us_text);
  // "will you require sponsorship?" → Yes (or No if negated)
  if (l.includes('sponsorship') || l.includes('sponsor') || l.includes('require visa') ||
      l.includes('h-1b') || l.includes('h1b') || l.includes('immigration')) {
    return maybeInvert(auth.requires_sponsorship_text);
  }
  // "citizen or GC?" → No (or Yes if negated)
  if (l.includes('citizen') || l.includes('green card') || l.includes('permanent resident')) {
    return maybeInvert(auth.citizen_or_gc_text);
  }
  // "work permit" or generic work auth
  if (l.includes('eligible to work') || l.includes('legal right')) return maybeInvert(auth.authorized_to_work_us_text);
  return null;
}

// ─── CV parser ────────────────────────────────────────────────────────────────
function parseCV() {
  const cvPath = join(CAREER_OPS, 'cv.md');
  if (!existsSync(cvPath)) return { experience: [], education: [] };
  const text = readFileSync(cvPath, 'utf-8');

  const expSection = text.match(/^# PROFESSIONAL EXPERIENCE\s*([\s\S]*?)(?=^# )/m)?.[1] || '';
  const eduSection = text.match(/^# EDUCATION\s*([\s\S]*?)(?=^# |$)/m)?.[1] || '';

  const experience = [];
  for (const block of expSection.split(/^## /m).slice(1)) {
    const lines     = block.split('\n');
    const header    = lines[0].trim();
    const pipeIdx   = header.indexOf('|');
    const title     = pipeIdx > -1 ? header.slice(0, pipeIdx).trim() : header;
    const company   = pipeIdx > -1 ? header.slice(pipeIdx + 1).split('·')[0].trim() : '';
    const dateLine  = lines.find(l => /\*\*[A-Z]/.test(l)) || '';
    const dateM     = dateLine.match(/\*\*([^–\-*]+?)\s*[–\-]+\s*([^*]+?)\*\*/);
    const startDate = dateM ? dateM[1].trim() : '';
    const endDate   = dateM ? dateM[2].trim() : '';
    const isCurrent = /present/i.test(endDate);
    const bullets   = lines.filter(l => l.trim().startsWith('*')).map(l => l.replace(/^\s*\*\s*/, '').trim());
    if (title && company) experience.push({ title, company, startDate, endDate, isCurrent, description: bullets.join('\n'), bullets });
  }

  const education = [];
  for (const block of eduSection.split(/^## /m).slice(1)) {
    const lines      = block.split('\n').filter(l => l.trim());
    const heading    = lines[0]?.trim() || '';
    const commaIdx   = heading.indexOf(',');
    const degree     = commaIdx > -1 ? heading.slice(0, commaIdx).trim() : heading;
    const field      = commaIdx > -1 ? heading.slice(commaIdx + 1).trim() : '';
    const schoolLine = lines.find(l => l.includes('|')) || '';
    const [school = '', datePart = ''] = schoolLine.split('|').map(s => s.trim());
    const dateM      = datePart.match(/([A-Z][a-z]+ \d{4})\s*[–\-]+\s*([A-Z][a-z]+ \d{4})/);
    const startDate  = dateM ? dateM[1] : '';
    const endDate    = dateM ? dateM[2] : '';
    if (degree && school) education.push({ degree, field, school, startDate, endDate });
  }

  return { experience, education };
}

function normalizeGhDegree(degree) {
  if (/master/i.test(degree))               return "Master's Degree";
  if (/bachelor|b\.(s|e|a)\./i.test(degree)) return "Bachelor's Degree";
  if (/doctor|ph\.?d/i.test(degree))        return "Doctorate";
  if (/associate/i.test(degree))             return "Associate's Degree";
  return degree;
}

// ─── Greenhouse filler ────────────────────────────────────────────────────────
async function fillGreenhouse(page, job, answersData, resumePath) {
  const p = answersData.profile;
  const needsAnswer = [];

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const bodyText = await page.textContent('body').catch(() => '');
  if (/you('ve| have) already applied/i.test(bodyText) || /application (is )?already submitted/i.test(bodyText)) {
    return { outcome: 'DUPLICATE' };
  }

  // Fill a plain text/tel input by selector, silently skip if not found
  const setField = async (selector, value) => {
    if (!value) return false;
    const el = page.locator(selector).first();
    if (await el.count() > 0) { await el.fill(String(value)).catch(() => {}); return true; }
    return false;
  };

  // Interact with a React-Select dropdown (Greenhouse v2 uses these for custom selects)
  // Clicks the container, waits for options menu, clicks the best match.
  const fillReactSelect = async (containerLocator, value) => {
    try {
      await containerLocator.click();
      await page.waitForTimeout(400);
      // Options appear in a portal outside the container — search globally
      const option = page.locator('[class*="option"]').filter({ hasText: new RegExp(`^${value}$`, 'i') }).first();
      if (await option.count() === 0) {
        // Try partial match
        const partial = page.locator('[class*="option"]').filter({ hasText: value }).first();
        if (await partial.count() > 0) { await partial.click(); return true; }
        // Dismiss and give up
        await page.keyboard.press('Escape');
        return false;
      }
      await option.click();
      return true;
    } catch { return false; }
  };

  // Fuzzy native <select> filler — tries exact labels first, then partial substring match on option text
  const trySelectFuzzy = async (selectEl, candidates) => {
    for (const candidate of candidates) {
      const ok = await selectEl.selectOption({ label: candidate }).then(() => true).catch(() => false);
      if (ok) return true;
    }
    // Enumerate all options and find the best partial match
    const opts = await selectEl.evaluate(el =>
      Array.from(el.options).filter(o => o.value).map(o => ({ value: o.value, text: o.text.trim() }))
    ).catch(() => []);
    for (const candidate of candidates) {
      const cLower = candidate.toLowerCase();
      const best = opts.find(o => o.text.toLowerCase().includes(cLower) || cLower.includes(o.text.toLowerCase().trim()));
      if (best) return await selectEl.selectOption({ value: best.value }).then(() => true).catch(() => false);
    }
    return false;
  };

  // Searchable React-Select — types to filter before picking (needed for school/university pickers)
  const fillReactSelectSearch = async (containerLocator, value) => {
    try {
      await containerLocator.click();
      await page.waitForTimeout(300);
      await page.keyboard.type(value.slice(0, Math.min(value.length, 20)), { delay: 40 });
      await page.waitForTimeout(800);
      const option = page.locator('[class*="option"]').filter({ hasText: new RegExp(`^${value}$`, 'i') }).first();
      if (await option.count() === 0) {
        const partial = page.locator('[class*="option"]').filter({ hasText: value }).first();
        if (await partial.count() > 0) { await partial.click(); return true; }
        await page.keyboard.press('Escape');
        return false;
      }
      await option.click();
      return true;
    } catch { return false; }
  };

  // ── Standard profile fields (v1 and v2 IDs) ─────────────────────────────────
  await setField('input#first_name, input[name="first_name"]', p.first_name);
  await setField('input#last_name,  input[name="last_name"]',  p.last_name);
  await setField('input#email,      input[name="email"]',      p.email);
  // Phone — fill the tel input; country code handled separately below
  await setField('input#phone, input[type="tel"]', p.phone);

  // Phone country code — Greenhouse v2 wraps phone + country in .phone-input
  // The country selector is a React-Select with id="country" inside that wrapper
  const phoneWrapper = page.locator('.phone-input').first();
  if (await phoneWrapper.count() > 0) {
    const countryContainer = phoneWrapper.locator('[class*="-container"]').first();
    if (await countryContainer.count() > 0) await fillReactSelect(countryContainer, 'United States');
  }

  // Location (City) — React-Select on v2 (haspopup=true), plain input on v1
  const locInput = page.locator('input#candidate-location').first();
  if (await locInput.count() > 0) {
    const isReact = (await locInput.getAttribute('aria-haspopup').catch(() => null)) === 'true';
    if (isReact) {
      // Type city to trigger autocomplete then pick first match
      await locInput.click();
      await locInput.type(p.city, { delay: 40 });
      await page.waitForTimeout(700);
      const firstOption = page.locator('[class*="option"]').first();
      if (await firstOption.count() > 0) await firstOption.click();
      else await page.keyboard.press('Escape');
    } else {
      await locInput.fill(p.city).catch(() => {});
    }
  }

  // EEO / demographics with fixed IDs — all React-Selects on v2
  const eeoFields = [
    { id: 'gender',             answerId: 'gender' },
    { id: 'hispanic_ethnicity', answerId: 'race_ethnicity' },
    { id: 'veteran_status',     answerId: 'veteran_status' },
    { id: 'disability_status',  answerId: 'disability_status' },
  ];
  for (const { id, answerId } of eeoFields) {
    // Use attribute selector instead of `#${id}` — bare ID selectors throw
    // SyntaxError when the id starts with a digit (e.g., UUIDs in Ashby /
    // Greenhouse v2 forms). Attribute selector `[id="..."]` works for any value.
    const el = page.locator(`input[id="${id}"]`).first();
    if (await el.count() === 0) continue;
    const isReact = (await el.getAttribute('aria-haspopup').catch(() => null)) === 'true';
    if (!isReact) continue;
    const match = answersData.answers.find(a => a.id === answerId);
    if (!match) continue;
    const container = page.locator(`input[id="${id}"]`).locator('..').locator('[class*="-container"]').first();
    // Greenhouse puts the React-Select container as a sibling/ancestor — locate via label
    const wrapper = page.locator(`.select__container:has([id="${id}"])`).first();
    const cont = await wrapper.count() > 0
      ? wrapper.locator('[class*="-container"]').first()
      : page.locator(`[id="${id}"]`).locator('xpath=ancestor::div[contains(@class,"container")]').first();
    await fillReactSelect(cont, match.answer_short || match.answer).catch(() => {});
  }

  // LinkedIn / Website (v1 IDs — v2 puts these in custom question blocks)
  await setField('input#job_application_linkedin_url, input[aria-label="LinkedIn Profile URL"]', p.linkedin);
  await setField('input#job_application_website', p.website || '');

  // Education (Greenhouse v2 uses school--0 and degree--0 as searchable React-Select IDs)
  // `seen` is declared here so education labels can be pre-populated before the custom loop
  const seen = new Set();
  const cvData = parseCV();
  const primaryEdu = cvData.education[0];
  const eduIds = primaryEdu ? [
    { id: 'school--0', value: primaryEdu.school,                    searchable: true },
    { id: 'degree--0', value: normalizeGhDegree(primaryEdu.degree), searchable: false },
  ] : [];
  for (const edu of eduIds) {
    const el = page.locator(`input[id="${edu.id}"]`).first();
    if (await el.count() === 0) continue;
    // Mark the label as seen so the custom loop skips it
    const wrapper = page.locator(`.select__container:has([id="${edu.id}"]), .input-wrapper:has([id="${edu.id}"])`).first();
    const eduLabel = (await wrapper.locator('label').first().textContent().catch(() => '') || '').replace(/\*/g, '').trim();
    if (eduLabel) seen.add(eduLabel);
    const cont = await wrapper.count() > 0
      ? wrapper.locator('[class*="-container"]').first()
      : el.locator('xpath=ancestor::div[contains(@class,"-container")]').first();
    if (edu.searchable) {
      await fillReactSelectSearch(cont, edu.value).catch(() => {});
    } else {
      await fillReactSelect(cont, edu.value).catch(() => {});
    }
  }

  // Resume upload
  if (resumePath && existsSync(resumePath)) {
    const fileInput = page.locator('input[type="file"]#resume, input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(resumePath);
      await page.waitForTimeout(1500);
    }
  }

  // Work Experience — fill Greenhouse v1 structured fields directly from cv.md
  // Bypasses ATS PDF parsing which mis-formats long resume bullets across lines
  const ghParseMonthYear = (str) => {
    const months = { January:1,February:2,March:3,April:4,May:5,June:6,July:7,
      August:8,September:9,October:10,November:11,December:12,
      Jan:1,Feb:2,Mar:3,Apr:4,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
    const m = str?.match(/([A-Z][a-z]+)\s+(\d{4})/);
    return m ? { month: String(months[m[1]] || ''), year: m[2] } : { month: '', year: '' };
  };
  if (cvData.experience.length > 0) {
    for (let i = 0; i < cvData.experience.length; i++) {
      const exp = cvData.experience[i];
      if (i > 0) {
        const addBtn = page.locator(
          'button:has-text("Add another position"), button:has-text("Add Work Experience"), a:has-text("Add another")'
        ).first();
        if (await addBtn.count() > 0) { await addBtn.click(); await page.waitForTimeout(600); }
      }
      const base = `job_application[work_experiences][${i}]`;
      const coInput = page.locator(`input[name="${base}[company_name]"]`).first();
      if (await coInput.count() > 0) await coInput.fill(exp.company).catch(() => {});
      const titleInput = page.locator(`input[name="${base}[title]"]`).first();
      if (await titleInput.count() > 0) await titleInput.fill(exp.title).catch(() => {});
      const descInput = page.locator(`textarea[name="${base}[description]"]`).first();
      if (await descInput.count() > 0) await descInput.fill(exp.description).catch(() => {});
      const start = ghParseMonthYear(exp.startDate);
      const end   = ghParseMonthYear(exp.endDate);
      const smSel = page.locator(`select[name="${base}[start_date][month]"]`).first();
      const sySel = page.locator(`select[name="${base}[start_date][year]"]`).first();
      if (start.month && await smSel.count() > 0) await smSel.selectOption(start.month).catch(() => {});
      if (start.year  && await sySel.count()  > 0) await sySel.selectOption(start.year).catch(() => {});
      if (exp.isCurrent) {
        const cb = page.locator(`input[name="${base}[current_position]"]`).first();
        if (await cb.count() > 0 && !(await cb.isChecked())) await cb.check().catch(() => {});
      } else {
        const emSel = page.locator(`select[name="${base}[end_date][month]"]`).first();
        const eySel = page.locator(`select[name="${base}[end_date][year]"]`).first();
        if (end.month && await emSel.count() > 0) await emSel.selectOption(end.month).catch(() => {});
        if (end.year  && await eySel.count()  > 0) await eySel.selectOption(end.year).catch(() => {});
      }
    }
  }

  // Cover letter — textarea only; Greenhouse v1 uses input[type=file]#cover_letter
  const clField = page.locator('textarea[name*="cover"], textarea#cover_letter, textarea[placeholder*="cover"]').first();
  if (await clField.count() > 0) {
    const tag = await clField.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
    if (tag === 'textarea') {
      const cl = answersData.answers.find(a => a.id === 'cover_letter');
      if (cl) await clField.fill(cl.answer).catch(() => {});
    }
  }

  // ── Custom question blocks ───────────────────────────────────────────────────
  // Greenhouse v1 uses .field; v2 uses .input-wrapper (text) and .select__container (React-Select)
  const questionBlocks = await page.locator(
    '.field, .application-question, [data-field-type], .input-wrapper, .select__container'
  ).all();

  for (const block of questionBlocks) {
    try {
      const labelEl = block.locator('label').first();
      const label = (await labelEl.textContent().catch(() => '') || '').replace(/\*/g, '').trim();
      if (!label || seen.has(label)) continue;
      seen.add(label);

      const lbl = label.toLowerCase();

      // ── Skip labels already handled deterministically (profile + EEO fields)
      // Prevents them appearing in needsAnswer when .field-wrapper also wraps them
      if (/^(first name|last name|preferred (first )?name|email|phone|country|location|city|state|zip|postal|address|gender|veteran|disability|hispanic|ethnicity|race)/.test(lbl)) continue;

      // ── "City, State" free-text field ───────────────────────────────────────
      if (lbl.includes('city') || (lbl.includes('current location') && lbl.includes('city'))) {
        const inp = block.locator('input[type="text"]').first();
        if (await inp.count() > 0) await inp.fill(`${p.city}, ${p.state_abbr}`).catch(() => {});
        continue;
      }

      // ── Profile URL fields (v2 puts these as custom questions) ──────────────
      if (lbl.includes('linkedin')) {
        await setField(`[id="${await block.locator('input[type="text"]').first().getAttribute('id').catch(() => '__none__')}"]`, p.linkedin);
        // Fallback: fill by aria-label
        await block.locator('input[type="text"]').first().fill(p.linkedin).catch(() => {});
        continue;
      }
      if (lbl === 'website' || lbl.includes('portfolio') || lbl.includes('personal site')) {
        const val = p.website || '';
        if (val) await block.locator('input[type="text"]').first().fill(val).catch(() => {});
        continue;
      }
      if (lbl === 'github' || lbl.includes('github url')) {
        if (p.github) await block.locator('input[type="text"]').first().fill(p.github).catch(() => {});
        continue;
      }

      // ── Export control checkboxes — check "None of the above" ───────────────
      if (lbl.includes('export control') || lbl.includes('sanctioned country') ||
          lbl.includes('export restrictions') ||
          /citizen or permanent resident of (cuba|iran|north korea|syria|crimea)/i.test(lbl)) {
        const checkboxes = await block.locator('input[type="checkbox"]').all();
        for (const cb of checkboxes) {
          const cbId = await cb.getAttribute('id').catch(() => '') || '';
          const cbLabelText = cbId
            ? (await page.locator(`label[for="${cbId}"]`).textContent().catch(() => '') || '')
            : (await cb.locator('xpath=following-sibling::label[1]').textContent().catch(() => '') || '');
          if (/none of the above/i.test(cbLabelText)) { await cb.check().catch(() => {}); break; }
        }
        continue;
      }

      // ── Work auth — hardcoded, never delegate to LLM ────────────────────────
      if (isWorkAuthLabel(label)) {
        const answer = workAuthAnswer(label, answersData);
        if (!answer) continue;

        // Try native radio buttons (v1)
        const yesRadio = block.locator('input[type="radio"][value="Yes"], input[type="radio"][value="true"], input[type="radio"][id*="yes"]').first();
        const noRadio  = block.locator('input[type="radio"][value="No"],  input[type="radio"][value="false"], input[type="radio"][id*="no"]').first();
        if (answer === 'Yes' && await yesRadio.count() > 0) { await yesRadio.check(); continue; }
        if (answer === 'No'  && await noRadio.count()  > 0) { await noRadio.check();  continue; }

        // Try native select (v1 variant)
        const sel = block.locator('select').first();
        if (await sel.count() > 0) {
          await trySelectFuzzy(sel, [answer]);
          continue;
        }

        // Try React-Select (v2) — container is .select-shell or [class*="container"]
        const reactContainer = block.locator('.select-shell, [class*="-container"]').first();
        if (await reactContainer.count() > 0) {
          await fillReactSelect(reactContainer, answer);
        }
        continue;
      }

      // ── Known answer patterns ────────────────────────────────────────────────
      const match = matchAnswer(label, answersData);
      if (match) {
        const textarea      = block.locator('textarea').first();
        const input         = block.locator('input[type="text"], input:not([type])').first();
        const select        = block.locator('select').first();
        const radios        = block.locator('input[type="radio"]');
        const checkboxes    = block.locator('input[type="checkbox"]');
        const reactContainer = block.locator('.select-shell, [class*="-container"]').first();

        if (await textarea.count() > 0) {
          await textarea.fill(match.answer).catch(() => {});
        } else if (await checkboxes.count() > 0) {
          // Checkbox group (e.g. "mark all that apply" race/ethnicity) — find and check matching option
          const answerText = (match.answer_short || match.answer).toLowerCase();
          for (const cb of await checkboxes.all()) {
            const cbId  = await cb.getAttribute('id').catch(() => '') || '';
            const cbLbl = cbId
              ? (await page.locator(`label[for="${cbId}"]`).textContent().catch(() => '') || '')
              : (await cb.locator('xpath=following-sibling::*[1][self::label]').textContent().catch(() => '') || '');
            if (cbLbl.toLowerCase().includes(answerText) || answerText.includes(cbLbl.toLowerCase().trim())) {
              await cb.check().catch(() => {});
              break;
            }
          }
        } else if (await radios.count() > 0) {
          const ans = match.answer_bool != null ? match.answer_bool
            : match.answer === 'Yes' ? true : match.answer === 'No' ? false : null;
          if (ans !== null) await radios.nth(ans ? 0 : 1).check().catch(() => {});
        } else if (await select.count() > 0) {
          const candidates = match.options_priority
            ? match.options_priority
            : [match.answer_short || match.answer];
          await trySelectFuzzy(select, candidates);
        } else if (await reactContainer.count() > 0) {
          // React-Select dropdown
          const val = match.answer_short || match.answer;
          await fillReactSelect(reactContainer, val);
        } else if (await input.count() > 0) {
          await input.fill(match.answer_short || match.answer).catch(() => {});
        }
      } else {
        needsAnswer.push(label);
      }
    } catch (blockErr) {
      console.warn('Question block error (skipped):', blockErr.message);
    }
  }

  return needsAnswer.length > 0
    ? { outcome: 'NEEDS_ANSWER', needsAnswer }
    : { outcome: 'FILLED_PENDING_REVIEW' };
}

// ─── Lever filler ─────────────────────────────────────────────────────────────
async function fillLever(page, job, answersData, resumePath) {
  const p = answersData.profile;
  const needsAnswer = [];

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const bodyText = await page.textContent('body').catch(() => '');
  if (/already applied/i.test(bodyText)) return { outcome: 'DUPLICATE' };

  const setField = async (selector, value) => {
    const el = page.locator(selector).first();
    if (await el.count() > 0) { await el.fill(value); return true; }
    return false;
  };

  await setField('input[name="name"]', p.full_name);
  await setField('input[name="email"]', p.email);
  await setField('input[name="phone"]', p.phone);
  await setField('input[name="org"], input[name="company"]', 'Innovaccer Inc.');
  await setField('input[name="linkedin"], input[placeholder*="LinkedIn"]', p.linkedin);
  await setField('input[name="urls[LinkedIn]"]', p.linkedin);

  // Resume upload
  if (resumePath && existsSync(resumePath)) {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(resumePath);
      await page.waitForTimeout(1500);
    }
  }

  // Lever custom questions — each in a .application-question div
  const questions = await page.locator('.application-question, [data-qa="additional-cards"] .form-item').all();
  for (const q of questions) {
    const labelEl = q.locator('label, .application-label').first();
    const label = await labelEl.textContent().catch(() => '') || '';
    if (!label.trim()) continue;

    if (isWorkAuthLabel(label)) {
      const answer = workAuthAnswer(label, answersData);
      if (answer) {
        const radios = q.locator('input[type="radio"]');
        if (await radios.count() >= 2) {
          const idx = answer === 'Yes' ? 0 : 1;
          await radios.nth(idx).check().catch(() => {});
        } else {
          const sel = q.locator('select').first();
          if (await sel.count() > 0) await sel.selectOption({ label: answer }).catch(() => {});
        }
      }
      continue;
    }

    const match = matchAnswer(label, answersData);
    if (match) {
      const textarea = q.locator('textarea').first();
      const input    = q.locator('input[type="text"], input:not([type])').first();
      const select   = q.locator('select').first();
      if (await textarea.count() > 0) await textarea.fill(match.answer);
      else if (await input.count() > 0) await input.fill(match.answer_short || match.answer);
      else if (await select.count() > 0 && match.options_priority) {
        for (const opt of match.options_priority) {
          const ok = await select.selectOption({ label: opt }).then(() => true).catch(() => false);
          if (ok) break;
        }
      }
    } else {
      needsAnswer.push(label.trim());
    }
  }

  return needsAnswer.length > 0
    ? { outcome: 'NEEDS_ANSWER', needsAnswer }
    : { outcome: 'FILLED_PENDING_REVIEW' };
}

// ─── Ashby filler ────────────────────────────────────────────────────────────
async function fillAshby(page, job, answersData, resumePath) {
  const p = answersData.profile;
  const needsAnswer = [];

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const bodyText = await page.textContent('body').catch(() => '');
  if (/already applied/i.test(bodyText)) return { outcome: 'DUPLICATE' };

  const setByLabel = async (labelText, value) => {
    const label = page.locator(`label:has-text("${labelText}")`).first();
    if (await label.count() === 0) return false;
    const id = await label.getAttribute('for');
    if (id) {
      // Attribute selector — `#${id}` throws when id starts with a digit (UUIDs).
      const inp = page.locator(`[id="${id}"]`).first();
      if (await inp.count() > 0) { await inp.fill(value); return true; }
    }
    const parent = label.locator('..');
    const inp = parent.locator('input, textarea').first();
    if (await inp.count() > 0) { await inp.fill(value); return true; }
    return false;
  };

  await setByLabel('First Name', p.first_name);
  await setByLabel('Last Name',  p.last_name);
  await setByLabel('Email',      p.email);
  await setByLabel('Phone',      p.phone);
  await setByLabel('LinkedIn',   p.linkedin);

  // Resume upload
  if (resumePath && existsSync(resumePath)) {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(resumePath);
      await page.waitForTimeout(1500);
    }
  }

  // Ashby custom fields
  const formFields = await page.locator('[class*="ApplicationForm"] [class*="Field"], .ashby-application-form-field').all();
  for (const field of formFields) {
    const labelEl = field.locator('label').first();
    const label = await labelEl.textContent().catch(() => '') || '';
    if (!label.trim()) continue;

    if (isWorkAuthLabel(label)) {
      const answer = workAuthAnswer(label, answersData);
      if (answer) {
        const sel = field.locator('select').first();
        const radios = field.locator('input[type="radio"]');
        if (await sel.count() > 0) {
          await sel.selectOption({ label: answer }).catch(() =>
            sel.selectOption({ value: answer }).catch(() => {})
          );
        } else if (await radios.count() > 0) {
          const idx = answer === 'Yes' ? 0 : 1;
          await radios.nth(idx).check().catch(() => {});
        }
      }
      continue;
    }

    const match = matchAnswer(label, answersData);
    if (match) {
      const textarea = field.locator('textarea').first();
      const input    = field.locator('input[type="text"], input:not([type="radio"]):not([type="checkbox"]):not([type="file"])').first();
      const select   = field.locator('select').first();
      if (await textarea.count() > 0) await textarea.fill(match.answer);
      else if (await input.count() > 0) await input.fill(match.answer_short || match.answer);
      else if (await select.count() > 0 && match.options_priority) {
        for (const opt of match.options_priority) {
          const ok = await select.selectOption({ label: opt }).then(() => true).catch(() => false);
          if (ok) break;
        }
      }
    } else {
      needsAnswer.push(label.trim());
    }
  }

  return needsAnswer.length > 0
    ? { outcome: 'NEEDS_ANSWER', needsAnswer }
    : { outcome: 'FILLED_PENDING_REVIEW' };
}

// ─── Workday filler ───────────────────────────────────────────────────────────
async function fillWorkday(page, job, answersData, resumePath) {
  const p = answersData.profile;
  const needsAnswer = [];
  let fieldsFound = 0;
  const cvData = parseCV();

  const waitSettle = async (ms = 2500) => {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(ms);
  };

  // ── Helper: fill a Workday text input by data-automation-id ─────────────
  const setWd = async (automationId, value) => {
    if (!value) return false;
    const el = page.locator(`[data-automation-id="${automationId}"]`).first();
    if (await el.count() === 0) return false;
    await el.fill(String(value)).catch(() => {});
    return true;
  };

  // ── Helper: click a button/link by text (case-insensitive) ───────────────
  const clickText = async (...texts) => {
    for (const text of texts) {
      const loc = page.locator(`button:has-text("${text}"), a:has-text("${text}")`).first();
      if (await loc.count() > 0) {
        await loc.click().catch(() => {});
        await waitSettle();
        return true;
      }
    }
    return false;
  };

  const wdParseMonthYear = (str) => {
    const months = { January:1,February:2,March:3,April:4,May:5,June:6,July:7,
      August:8,September:9,October:10,November:11,December:12,
      Jan:1,Feb:2,Mar:3,Apr:4,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
    const m = str?.match(/([A-Z][a-z]+)\s+(\d{4})/);
    return m ? { month: String(months[m[1]] || ''), year: m[2] } : { month: '', year: '' };
  };

  // ── Helper: fill Workday work experience section if present on current page ─
  const fillWorkdayWorkExp = async () => {
    const addBtn = page.locator(
      'button:has-text("Add Work Experience"), button:has-text("Add a Work Experience"), ' +
      'a:has-text("Add Work Experience"), [data-automation-id*="workExperience"] button[data-automation-id*="add"]'
    ).first();
    if (await addBtn.count() === 0) return;
    for (const exp of cvData.experience) {
      try {
        await addBtn.click();
        await page.waitForTimeout(1000);
        const setF = async (id, val) => {
          const el = page.locator(`[data-automation-id="${id}"]`).first();
          if (await el.count() > 0 && val) await el.fill(String(val)).catch(() => {});
        };
        await setF('jobTitle', exp.title);
        await setF('company',  exp.company);
        await setF('description', exp.description);
        const start = wdParseMonthYear(exp.startDate);
        const end   = wdParseMonthYear(exp.endDate);
        await setF('startDate-dateSectionMonth-input', start.month);
        await setF('startDate-dateSectionYear-input',  start.year);
        if (exp.isCurrent) {
          const cb = page.locator('[data-automation-id="currentlyWorkHere"]').first();
          if (await cb.count() > 0) await cb.check().catch(() => {});
        } else {
          await setF('endDate-dateSectionMonth-input', end.month);
          await setF('endDate-dateSectionYear-input',  end.year);
        }
        const saveBtn = page.locator(
          '[data-automation-id="Add-workExperience-save"], button:has-text("OK"), button:has-text("Save")'
        ).first();
        if (await saveBtn.count() > 0) await saveBtn.click().catch(() => {});
        await page.waitForTimeout(800);
      } catch {}
    }
  };

  // ── Helper: fill Workday education section if present on current page ─────
  const fillWorkdayEducation = async () => {
    const addBtn = page.locator(
      'button:has-text("Add Education"), button:has-text("Add a School"), ' +
      'a:has-text("Add Education"), [data-automation-id*="education"] button[data-automation-id*="add"]'
    ).first();
    if (await addBtn.count() === 0) return;
    for (const edu of cvData.education) {
      try {
        await addBtn.click();
        await page.waitForTimeout(1000);
        const setF = async (id, val) => {
          const el = page.locator(`[data-automation-id="${id}"]`).first();
          if (await el.count() > 0 && val) await el.fill(String(val)).catch(() => {});
        };
        await setF('school', edu.school);
        const degreeEl = page.locator('[data-automation-id="degree"]').first();
        if (await degreeEl.count() > 0) {
          const normalized = normalizeGhDegree(edu.degree);
          const tag = await degreeEl.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
          if (tag === 'select') await degreeEl.selectOption({ label: normalized }).catch(() => {});
          else await degreeEl.fill(normalized).catch(() => {});
        }
        await setF('fieldOfStudy', edu.field);
        const saveBtn = page.locator(
          '[data-automation-id*="save"], button:has-text("OK"), button:has-text("Save")'
        ).first();
        if (await saveBtn.count() > 0) await saveBtn.click().catch(() => {});
        await page.waitForTimeout(800);
      } catch {}
    }
  };

  await waitSettle(1500);

  // ── Step 1: Click Apply if still on the job listing page ─────────────────
  const applyBtn = page.locator(
    '[data-automation-id="applyNowButton"], [data-automation-id="applyNowButtonDesktop"]'
  ).first();
  if (await applyBtn.count() > 0) {
    await applyBtn.click();
    await waitSettle(3000);
  }

  // ── Step 2: Handle account / guest-apply dialog (many Workday variants) ──
  // Try selectors in priority order: data-automation-id first, then button text
  const guestSelectors = [
    '[data-automation-id="applyManually"]',
    '[data-automation-id="guest-apply-button"]',
    '[data-automation-id="continueAsGuest"]',
  ];
  let guestClicked = false;
  for (const sel of guestSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      await el.click().catch(() => {});
      await waitSettle();
      guestClicked = true;
      break;
    }
  }
  if (!guestClicked) {
    // Text-based fallbacks (Workday changes button labels between tenants)
    guestClicked = await clickText(
      'Apply Manually', 'Apply Without an Account', 'Continue as Guest',
      'Apply as Guest', 'Skip for now', 'Continue without signing in'
    );
  }

  // ── Step 3: Country / language selection page (some tenants) ─────────────
  // If there's a "Save and Continue" or "Next" on a country-select page, advance past it
  const countryField = page.locator('[data-automation-id="countryDropdown"]').first();
  if (await countryField.count() > 0) {
    await clickText('Save and Continue', 'Next', 'Continue');
    await waitSettle();
  }

  // ── Step 4: Fill personal info (Page 1 of most Workday flows) ────────────
  const filled1 = [
    await setWd('legalNameSection_firstName', p.first_name),
    await setWd('legalNameSection_lastName',  p.last_name),
    await setWd('firstName',  p.first_name),
    await setWd('lastName',   p.last_name),
    await setWd('email',      p.email),
    await setWd('phone',      p.phone),
    await setWd('addressSection_addressLine1', p.street || ''),
    await setWd('addressSection_city',         p.city   || ''),
    await setWd('addressSection_postalCode',   p.zip || p.postal_code || ''),
  ].filter(Boolean).length;
  fieldsFound += filled1;

  // ── Step 5: Resume upload ─────────────────────────────────────────────────
  if (resumePath && existsSync(resumePath)) {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(resumePath).catch(() => {});
      await page.waitForTimeout(2500);
      fieldsFound++;
    }
  }

  // ── Step 6: Work auth + custom questions on current page ─────────────────
  const fillFormFields = async () => {
    const formFields = await page.locator('[data-automation-id^="formField-"]').all();
    for (const field of formFields) {
      try {
        const labelEl = field.locator(
          '[data-automation-id^="questionTitle"], legend, label'
        ).first();
        const label = (await labelEl.textContent().catch(() => '') || '').replace(/\*/g, '').trim();
        if (!label) continue;
        fieldsFound++;

        if (isWorkAuthLabel(label)) {
          const answer = workAuthAnswer(label, answersData);
          if (!answer) continue;
          const radios = field.locator('input[type="radio"]');
          if (await radios.count() >= 2) {
            if (answer === 'Yes') await radios.nth(0).click().catch(() => {});
            else                  await radios.nth(1).click().catch(() => {});
          }
          continue;
        }

        const match = matchAnswer(label, answersData);
        if (match) {
          const textarea = field.locator('textarea').first();
          const input    = field.locator('input[type="text"]').first();
          if (await textarea.count() > 0)      await textarea.fill(match.answer).catch(() => {});
          else if (await input.count() > 0)    await input.fill(match.answer_short || match.answer).catch(() => {});
        } else {
          needsAnswer.push(label);
        }
      } catch {}
    }
  };

  await fillFormFields();
  await fillWorkdayWorkExp();
  await fillWorkdayEducation();

  // ── Step 7: Advance through multi-page form (up to 6 more pages) ─────────
  for (let page_n = 0; page_n < 6; page_n++) {
    const nextBtn = page.locator(
      '[data-automation-id="bottom-navigation-next-button"], ' +
      '[data-automation-id="next-button"], ' +
      'button:has-text("Next"), button:has-text("Save and Continue")'
    ).first();
    if (await nextBtn.count() === 0) break;
    const isDisabled = await nextBtn.isDisabled().catch(() => true);
    if (isDisabled) break;
    await nextBtn.click();
    await waitSettle(2000);
    // Re-fill personal info in case Workday re-shows it on a new page
    await setWd('legalNameSection_firstName', p.first_name);
    await setWd('legalNameSection_lastName',  p.last_name);
    await setWd('email', p.email);
    await fillFormFields();
    await fillWorkdayWorkExp();
    await fillWorkdayEducation();
  }

  if (fieldsFound === 0) {
    // Nothing was reachable — likely stuck on sign-in wall or unsupported dialog
    return { outcome: 'NEEDS_MANUAL', reason: 'Workday form not reached — may require account sign-in' };
  }

  return needsAnswer.length > 0
    ? { outcome: 'NEEDS_ANSWER', needsAnswer }
    : { outcome: 'FILLED_PENDING_REVIEW' };
}

// ─── Generic fallback handler — works on any custom career page ──────────────
// Used when detectATS() returns 'unknown' but the URL looks like an apply page
// (matched by isLikelyApplyUrl in fill-agent.mjs). Walks every form field,
// matches its label against profile / work-auth / answer DB patterns, fills
// what it can. Best-effort: fill rate ~60% on average since custom sites use
// non-standard label associations + custom widgets. Unmatched fields are
// reported as needsAnswer so the in-page banner highlights them.
async function fillGeneric(page, job, answersData, resumePath) {
  const p = answersData.profile;
  const needsAnswer = [];
  let fieldsFound = 0;
  let fieldsFilled = 0;

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const bodyText = await page.textContent('body').catch(() => '');
  if (/you('ve| have) already applied/i.test(bodyText) || /application (is )?already submitted/i.test(bodyText)) {
    return { outcome: 'DUPLICATE' };
  }

  // ── In-page DOM helpers (run inside the browser) ──────────────────────────
  // Returns a list of fillable fields with their derived question label,
  // current value, type, and a stable selector we can target from Node.
  const fields = await page.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) {
        const direct = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (direct?.textContent?.trim()) return direct.textContent;
      }
      const fs = el.closest('fieldset');
      if (fs) { const lg = fs.querySelector('legend'); if (lg?.textContent?.trim()) return lg.textContent; }
      const wrap = el.closest('[class*="wrapper"],[class*="field"],[class*="container"],[class*="question"],[class*="form-row"],[role="group"]');
      const lbl = wrap?.querySelector('label');
      if (lbl?.textContent?.trim()) return lbl.textContent;
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ref = document.getElementById(labelledBy);
        if (ref?.textContent?.trim()) return ref.textContent;
      }
      return el.getAttribute('aria-label') || el.placeholder || el.name || '';
    };
    const clean = (s) => (s || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();

    const out = [];
    let idx = 0;
    const tagSel = (el) => {
      // Build a stable querySelector. Prefer id, then name+type, then nth-of-type.
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      return null;
    };

    document.querySelectorAll('input,textarea,select').forEach(el => {
      if (el.disabled || el.readOnly || el.type === 'hidden') return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return; // invisible
      const label = clean(labelFor(el));
      const selector = tagSel(el);
      // For radio groups we collapse to one entry per name
      const tag = el.tagName.toLowerCase();
      const type = tag === 'input' ? (el.type || 'text') : tag;
      out.push({
        idx: idx++,
        tag, type, name: el.name || '', id: el.id || '',
        selector, label,
        value: el.value || '',
      });
    });

    // ARIA comboboxes — custom React/widget dropdowns. We capture them so the
    // fill loop can click → wait for [role=option] → pick the match.
    document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]').forEach(el => {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const label = clean(labelFor(el));
      // Use id for selector when present, fallback to a positional path.
      let selector = el.id ? `#${CSS.escape(el.id)}` : null;
      if (!selector) {
        // Tag the element so we can find it again from Node (set an attribute Playwright can select).
        const tag = `co-combobox-${idx}`;
        el.setAttribute('data-co-tag', tag);
        selector = `[data-co-tag="${tag}"]`;
      }
      out.push({
        idx: idx++,
        tag: 'div', type: 'combobox',
        name: el.getAttribute('aria-label') || '', id: el.id || '',
        selector, label,
        value: el.textContent?.trim() || '',
      });
    });

    return out;
  });

  // De-duplicate radio groups by (name, type=radio); keep first.
  const seenRadioName = new Set();
  const planned = [];
  for (const f of fields) {
    if (f.type === 'radio') {
      if (!f.name || seenRadioName.has(f.name)) continue;
      seenRadioName.add(f.name);
    }
    planned.push(f);
  }
  fieldsFound = planned.length;

  // Resolve answer for each field. Profile + work-auth take precedence.
  const profilePatterns = [
    [/^first.?name|^given.?name|^fname/i, p.first_name],
    [/^last.?name|^surname|^family.?name|^lname/i, p.last_name],
    [/^full.?name$|^name$|legal name/i, p.full_name],
    [/^email/i, p.email],
    [/phone|mobile|cell/i, p.phone],
    [/^city/i, p.city],
    [/^state|province/i, p.state],
    [/^zip|postal/i, p.zip],
    [/^country/i, p.country],
    [/^address|street/i, p.location],
    [/linkedin/i, p.linkedin],
    [/website|portfolio|personal site/i, p.website],
    [/github/i, p.github],
  ];

  const resolveAnswer = (label, fieldType) => {
    if (!label) return null;
    // Work auth
    if (isWorkAuthLabel(label)) return { value: workAuthAnswer(label, answersData), source: 'work_auth' };
    // Profile patterns
    for (const [re, val] of profilePatterns) {
      if (re.test(label) && val) return { value: val, source: 'profile' };
    }
    // Answer DB patterns
    const m = matchAnswer(label, answersData);
    if (m) return { value: m.answer, source: 'answer_db', type: m.type };
    return null;
  };

  // ── Fill plan ─────────────────────────────────────────────────────────────
  for (const f of planned) {
    if (!f.label || f.label.length < 2) continue;

    // Resume upload
    if (f.type === 'file' && /resume|cv|attach/i.test(f.label + ' ' + (f.name || ''))) {
      if (resumePath && existsSync(resumePath) && f.selector) {
        try {
          await page.locator(f.selector).first().setInputFiles(resumePath);
          fieldsFilled++;
          await page.waitForTimeout(800);
        } catch {}
      }
      continue;
    }

    if (!f.selector) { needsAnswer.push(f.label); continue; }

    const ans = resolveAnswer(f.label, f.type);
    if (!ans?.value) { needsAnswer.push(f.label); continue; }
    const val = String(ans.value);

    const loc = page.locator(f.selector).first();

    try {
      if (f.type === 'text' || f.type === 'tel' || f.type === 'email' || f.type === 'number' || f.type === 'textarea') {
        await loc.fill(val);
        fieldsFilled++;
      } else if (f.type === 'date') {
        // Native <input type="date"> wants YYYY-MM-DD. Convert common phrases.
        let dateVal = val.trim();
        if (/^immediate(ly)?$|^asap$|^right (away|now)$/i.test(dateVal)) {
          dateVal = new Date().toISOString().slice(0, 10);
        } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateVal)) {
          const [m, d, y] = dateVal.split('/');
          dateVal = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
        // Only fill if we ended up with an ISO date — otherwise mark needs-answer.
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
          await loc.fill(dateVal);
          fieldsFilled++;
        } else {
          needsAnswer.push(f.label);
        }
      } else if (f.tag === 'select') {
        // Try selectOption by label first, then by value
        try {
          await loc.selectOption({ label: val });
          fieldsFilled++;
        } catch {
          try { await loc.selectOption({ value: val }); fieldsFilled++; }
          catch { needsAnswer.push(f.label); }
        }
      } else if (f.type === 'combobox') {
        // ARIA combobox / React custom dropdown:
        //   1. Click the combobox to expand the listbox
        //   2. Wait briefly for [role="option"] to render
        //   3. Find an option whose text matches val, click it
        const opened = await (async () => {
          try { await loc.click(); return true; } catch { return false; }
        })();
        if (!opened) { needsAnswer.push(f.label); continue; }
        await page.waitForTimeout(350); // give the listbox time to render
        const wanted = val.toLowerCase().trim();
        const optionClicked = await page.evaluate((wanted) => {
          const opts = [...document.querySelectorAll('[role="option"]:not([aria-disabled="true"])')];
          // Prefer exact case-insensitive match, then word-boundary contains, then loose contains.
          let best = null, bestScore = 0;
          for (const o of opts) {
            const t = (o.textContent || '').trim().toLowerCase();
            let score = 0;
            if (t === wanted) score = 3;
            else if (new RegExp(`\\b${wanted.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`).test(t)) score = 2;
            else if (t.includes(wanted)) score = 1;
            if (score > bestScore) { best = o; bestScore = score; }
          }
          if (best) { best.click(); return true; }
          return false;
        }, wanted);
        if (optionClicked) {
          fieldsFilled++;
          await page.waitForTimeout(150); // let the widget close + state settle
        } else {
          // Couldn't find an option — close the listbox and mark needs-answer.
          await page.keyboard.press('Escape').catch(() => {});
          needsAnswer.push(f.label);
        }
      } else if (f.type === 'radio') {
        // Find the radio in this group whose option-label matches val.
        // CSS.escape lives in the browser, so build the selector inside the eval.
        const clicked = await page.evaluate(({ groupName, val }) => {
          const wanted = val.toLowerCase().trim();
          const wantedIsYesNo = wanted === 'yes' || wanted === 'no';
          const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(groupName)}"]`);

          // Collect option label for each radio first, then rank by match quality.
          const candidates = [];
          for (const r of radios) {
            let optText = '';
            const wrap = r.closest('label');
            if (wrap) {
              const clone = wrap.cloneNode(true);
              clone.querySelectorAll('input').forEach(n => n.remove());
              optText = clone.textContent.trim();
            }
            if (!optText && r.id) {
              optText = document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent?.trim() || '';
            }
            if (!optText) optText = r.value || '';
            candidates.push({ r, optText, low: optText.toLowerCase().trim() });
          }

          // Match priorities (highest wins):
          //   3 — exact case-insensitive match
          //   2 — single-letter Y/N abbreviation when wanted is yes/no
          //   1 — option label is contained in wanted (e.g., "Yes, I am" contains "yes")
          //   0 — wanted is contained in option label (loose — last resort)
          const scoreOf = (c) => {
            if (c.low === wanted)                                    return 3;
            if (wantedIsYesNo && c.low === wanted[0])                return 2; // "y"/"n"
            if (wantedIsYesNo && c.low.split(/\W+/)[0] === wanted)   return 2; // "Yes, I am"
            // Word-boundary contains avoids "yesterday" matching "yes"
            const re = new RegExp(`\\b${wanted.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`);
            if (re.test(c.low))                                      return 1;
            return 0;
          };
          let best = null, bestScore = 0;
          for (const c of candidates) {
            const s = scoreOf(c);
            if (s > bestScore) { best = c; bestScore = s; }
          }
          if (best && bestScore >= 1) { best.r.click(); return true; }
          return false;
        }, { groupName: f.name, val });
        if (clicked) fieldsFilled++;
        else needsAnswer.push(f.label);
      } else if (f.type === 'checkbox') {
        // Yes-ish values → check, otherwise leave alone
        if (/^(yes|true|1|on)$/i.test(val)) {
          await loc.check();
          fieldsFilled++;
        }
      } else {
        needsAnswer.push(f.label);
      }
    } catch {
      needsAnswer.push(f.label);
    }
  }

  // Resume upload fallback: if no labelled file input was matched, attach to
  // the first file input named "resume" / "cv" / "attach".
  if (resumePath && existsSync(resumePath)) {
    try {
      const fileInput = page.locator('input[type="file"][name*="resume" i], input[type="file"][name*="cv" i], input[type="file"][id*="resume" i], input[type="file"][id*="cv" i]').first();
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(resumePath).catch(() => {});
      }
    } catch {}
  }

  // Detect form embedded in iframe — warn the user since this handler
  // doesn't walk into frames. Forms in iframes are rare in modern career
  // sites but still happen (mainly old ATS widgets).
  const iframeForms = await page.evaluate(() => {
    const frames = [...document.querySelectorAll('iframe')];
    return frames
      .filter(f => {
        const r = f.getBoundingClientRect();
        return r.width > 200 && r.height > 200; // skip tiny tracking iframes
      })
      .map(f => f.src || '(blank src)')
      .filter(src => !/google|analytics|doubleclick|facebook|hotjar|recaptcha/i.test(src))
      .slice(0, 3);
  }).catch(() => []);
  if (iframeForms.length > 0) {
    needsAnswer.unshift(`⚠ Form may be embedded in iframe — handler can't reach it: ${iframeForms.join(', ')}`);
  }

  // Detect Next/Continue button — wizard hint
  const nextButton = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')];
    const labels = ['next', 'continue', 'save and continue', 'proceed', 'next step', 'next page'];
    for (const b of buttons) {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const t = (b.textContent || b.value || '').toLowerCase().trim();
      for (const l of labels) {
        if (t === l || t.startsWith(l + ' ') || t.endsWith(' ' + l) || t.includes(l)) {
          return t;
        }
      }
    }
    return null;
  }).catch(() => null);

  let outcome;
  if (fieldsFound === 0)              outcome = 'NEEDS_MANUAL';      // No form-like fields at all
  else if (fieldsFilled === 0)        outcome = 'NEEDS_MANUAL';      // Couldn't fill anything
  else if (needsAnswer.length === 0)  outcome = 'FILLED_PENDING_REVIEW';
  else                                outcome = 'NEEDS_ANSWER';

  const reason = outcome === 'NEEDS_MANUAL'
    ? (fieldsFound === 0 ? 'No fillable form fields found' : 'Generic handler could not fill any field')
    : undefined;

  return { outcome, fieldsFound, fieldsFilled, needsAnswer, reason, hasNextStep: !!nextButton, nextLabel: nextButton };
}

// ─── Screenshot helper ────────────────────────────────────────────────────────
async function screenshot(page, num) {
  mkdirSync(ssDir(), { recursive: true });
  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = join(ssDir(), `${num}-${ts}.png`);
  await page.screenshot({ path: out, fullPage: true }).catch(() => {});
  return out;
}

// ─── Exports (used by fill-agent.mjs when imported as a module) ──────────────
export {
  fillGreenhouse, fillLever, fillAshby, fillWorkday, fillGeneric,
  detectATS, loadAnswers, matchAnswer, workAuthAnswer, isWorkAuthLabel,
  lookupJob, extractUrlFromReport, CAREER_OPS,
};

// ─── Main ─────────────────────────────────────────────────────────────────────
if (isMain) (async () => {
  const answersData = loadAnswers();
  let jobNum = numArg ? parseInt(numArg) : 0;
  let jobUrl = urlArg || null;
  let job    = null;
  let resumePath = null;

  // Resolve job info
  if (jobNum) {
    job = lookupJob(jobNum);
    if (!job) {
      console.error(`Job #${jobNum} not found in applications.md`);
      writeStatus(jobNum, APPLY_STATUS.ERROR, { error: 'Job not found in tracker' });
      process.exit(1);
    }
    jobUrl = jobUrl || extractUrlFromReport(job.reportPath);
    if (!jobUrl) {
      console.error(`No URL found for job #${jobNum}`);
      writeStatus(jobNum, APPLY_STATUS.ERROR, { error: 'Job URL not found in report' });
      process.exit(1);
    }

    // Priority 1: tailored PDF in output/{reportNum}-{slug}/resume.pdf
    // (generated by /career-ops pdf during auto-pipeline)
    if (job.reportPath) {
      const m = job.reportPath.replace(/^(\.\.\/)+/, '').match(/reports\/(\d+)-(.+)-\d{4}-\d{2}-\d{2}\.md/);
      if (m) {
        const tailored = join(CAREER_OPS, 'output', `${m[1]}-${m[2]}`, 'resume.pdf');
        if (existsSync(tailored)) {
          resumePath = tailored;
          console.log(`Using tailored PDF: output/${m[1]}-${m[2]}/resume.pdf`);
        }
      }
    }

    // Priority 2: archetype resume from Recommended CV in tracker notes
    if (!resumePath && job.recommendedCv) {
      const archetypePath = resolve(join(CAREER_OPS, job.recommendedCv));
      if (existsSync(archetypePath)) {
        resumePath = archetypePath;
        console.log(`Using archetype resume: ${job.recommendedCv}`);
      }
    }
  }

  if (!jobNum) jobNum = 0; // URL-only mode, no tracker num

  // Priority 3: generic fallback
  if (!resumePath || !existsSync(resumePath)) {
    const fallback = join(CAREER_OPS, 'Resume', 'generic', 'resume.pdf');
    if (existsSync(fallback)) {
      resumePath = fallback;
      console.log('Using fallback: Resume/generic/resume.pdf');
    }
  }

  const ats = detectATS(jobUrl);
  console.log(`Job #${jobNum} | ATS: ${ats} | URL: ${jobUrl}`);
  console.log(`Resume: ${resumePath || 'none'}`);

  writeStatus(jobNum, APPLY_STATUS.RUNNING, { url: jobUrl, ats });

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  let result = { outcome: APPLY_STATUS.ERROR, error: 'Unknown error' };

  try {
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    if      (ats === 'greenhouse') result = await fillGreenhouse(page, job, answersData, resumePath);
    else if (ats === 'lever')      result = await fillLever(page, job, answersData, resumePath);
    else if (ats === 'ashby')      result = await fillAshby(page, job, answersData, resumePath);
    else if (ats === 'workday')    result = await fillWorkday(page, job, answersData, resumePath);
    else                           result = await fillGeneric(page, job, answersData, resumePath);
  } catch (err) {
    result = { outcome: 'ERROR', error: err.message };
  }

  const ss = await screenshot(page, jobNum);
  console.log(`Screenshot: ${ss}`);
  console.log(`Outcome: ${result.outcome}`);
  if (result.needsAnswer?.length) {
    console.log('Questions needing answers:', result.needsAnswer);
  }

  writeStatus(jobNum, result.outcome, {
    url: jobUrl,
    ats,
    screenshot: ss,
    needsAnswer: result.needsAnswer || [],
    error: result.error || null,
    company: job?.company || '',
    role: job?.role || '',
  });

  // In headed mode, keep browser open so user can review and submit manually.
  // Inject a submit listener that captures the final form state on Submit click.
  // In headless mode, close immediately.
  if (!headless) {
    // Expose a Node.js callback the browser can call with captured field data
    // Build a set of company name tokens to detect company-specific questions
    const companyTokens = (job?.company || '')
      .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 2);

    await page.exposeFunction('_captureFormAnswers', async (fields) => {
      const answersFile = join(CAREER_OPS, 'data', 'application_answers.json');
      try {
        const data = JSON.parse(readFileSync(answersFile, 'utf-8'));
        let added = 0;
        for (const { label, value } of fields) {
          if (!label || !value || !value.trim()) continue;
          const lbl = label.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
          // Skip profile fields (already handled deterministically)
          if (/^(first|last|full.?name|email|phone|city|state|zip|postal|location|country|linkedin|website|github|address)/.test(lbl)) continue;
          // Skip work auth (hardcoded — never override)
          if (/authoriz|sponsor|citizen|visa|h.?1b|green.?card|work.?permit|eligible.?to.?work/.test(lbl)) continue;
          // Skip company-specific questions (label contains company name tokens)
          if (companyTokens.length > 0 && companyTokens.some(t => lbl.includes(t))) continue;
          // Skip if a pattern already covers this label
          const covered = data.answers.some(a =>
            a.patterns?.some(p => lbl.includes(p.toLowerCase()) || p.toLowerCase().includes(lbl.slice(0, 20)))
          );
          if (covered) continue;
          const id = lbl.replace(/\s+/g, '_').slice(0, 50);
          data.answers.push({
            id,
            patterns: [lbl],
            answer: value.trim(),
            answer_short: value.trim().length > 80 ? value.trim().slice(0, 77) + '…' : value.trim(),
            type: value.trim().split(/\s+/).length > 10 ? 'textarea' : 'text',
            _source: 'form-capture',
          });
          added++;
          console.log(`  Captured new answer: "${label}" → "${value.trim().slice(0, 60)}"`);
        }
        if (added > 0) {
          writeFileSync(answersFile, JSON.stringify(data, null, 2));
          console.log(`Saved ${added} new answer(s) to application_answers.json`);
        }
      } catch (e) {
        console.warn('Failed to save captured answers:', e.message);
      }
    });

    // Inject submit listener into the page — fires when user clicks Submit
    await page.evaluate(() => {
      const capture = () => {
        const fields = [];
        // Plain text inputs and textareas
        document.querySelectorAll(
          'input[type="text"], input[type="tel"], input[type="email"], input[type="number"], input:not([type]), textarea'
        ).forEach(el => {
          if (!el.value?.trim()) return;
          const labelEl =
            document.querySelector('label[for="' + el.id + '"]') ||
            el.closest('[class*="wrapper"],[class*="field"],[class*="container"],[class*="question"]')?.querySelector('label');
          const label = (labelEl?.textContent || el.getAttribute('aria-label') || el.placeholder || '')
            .replace(/\*/g, '').trim();
          if (label && label.length > 2) fields.push({ label, value: el.value.trim() });
        });
        // React-Select — read the displayed selected value
        document.querySelectorAll('[class*="single-value"]').forEach(el => {
          const val = el.textContent?.trim();
          if (!val) return;
          const wrap = el.closest('[class*="container"]')?.parentElement;
          const labelEl = wrap?.querySelector('label') || wrap?.parentElement?.querySelector('label');
          const label = (labelEl?.textContent || '').replace(/\*/g, '').trim();
          if (label && label.length > 2) fields.push({ label, value: val });
        });
        window._captureFormAnswers(fields);
      };

      // Attach to submit buttons
      document.querySelectorAll('button[type="submit"], input[type="submit"]').forEach(btn => {
        btn.addEventListener('click', capture, { once: true });
      });
      // Fallback: attach to any button whose text looks like a submit action
      document.querySelectorAll('button').forEach(btn => {
        const t = (btn.textContent || '').toLowerCase().trim();
        if (t === 'submit' || t === 'submit application' || t === 'apply now' || t === 'apply') {
          btn.addEventListener('click', capture, { once: true });
        }
      });
      // Also attach to form submit event as a safety net
      document.querySelectorAll('form').forEach(form => {
        form.addEventListener('submit', capture, { once: true });
      });
    }).catch(() => {}); // non-fatal if page context is gone

    if (result.outcome === 'FILLED_PENDING_REVIEW') {
      console.log('\nForm filled. Browser stays open — review, correct, and submit manually.');
      console.log('New answers you type will be saved to application_answers.json on Submit.');
    } else if (result.outcome === 'NEEDS_MANUAL') {
      console.log(`\nNEEDS_MANUAL — ${result.reason || 'form not reached'}. Browser stays open — fill manually.`);
    } else if (result.outcome === 'NEEDS_ANSWER') {
      console.log('\nNEEDS_ANSWER — some questions need your input. Browser stays open.');
    }
    await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  }

  await browser.close();
  process.exit(0);
})(); // end isMain
