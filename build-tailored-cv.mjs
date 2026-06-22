#!/usr/bin/env node
/**
 * build-tailored-cv.mjs
 *
 * Deterministic template-fill: takes a JSON of tailored CV content + reads
 * config/profile.yml + the canonical templates/cv-template.html, then does a
 * pure String.replace for every {{PLACEHOLDER}}.
 *
 * The LLM never writes HTML — it only produces structured JSON of the
 * tailored content. The structure, fonts, colors, gradient, spacing, and CSS
 * all come from the on-disk template, byte-for-byte. Style cannot drift.
 *
 * Used by:
 *   - generate-missing-pdfs.mjs   (dashboard backfill)
 *   - modes/pdf.md                (manual /career-ops pdf flow)
 *
 * Library usage:
 *   import { buildTailoredCv, loadProfile } from './build-tailored-cv.mjs';
 *   const html = buildTailoredCv({ template, profile, content });
 *
 * CLI usage:
 *   node build-tailored-cv.mjs <content.json> <output.html> [--format=letter|a4] [--lang=en|es]
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'templates', 'cv-template.html');
const PROFILE_PATH  = join(__dirname, 'config', 'profile.yml');

// ── profile.yml parsing (only the candidate.* keys we need) ───────────────────
export function loadProfile(path = PROFILE_PATH) {
  const text = readFileSync(path, 'utf-8');
  const grab = (key) => {
    const m = text.match(new RegExp(`^\\s{2}${key}:\\s*"?([^"\\n#]*)"?`, 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    name:      grab('full_name'),
    email:     grab('email'),
    phone:     grab('phone'),
    location:  grab('location'),
    linkedin:  grab('linkedin'),
    portfolio: grab('portfolio_url'),
  };
}

// ── minimal HTML escaping ─────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── sub-HTML builders — all use template's exact class names ─────────────────
// Bullets and rich-text fields permit a curated subset of inline tags (<strong>,
// <em>, <br>) so the LLM can highlight JD keywords. Everything else is escaped.
function escAllowInline(s) {
  if (s == null) return '';
  const escaped = esc(s);
  return escaped
    .replace(/&lt;(\/?)(strong|em|b|i|br)\s*\/?&gt;/gi, '<$1$2>')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
}

export function buildCompetenciesHtml(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map(k => `      <span class="competency-tag">${esc(k)}</span>`).join('\n');
}

export function buildExperienceHtml(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return '';
  return jobs.map(job => {
    const bullets = (job.bullets || []).map(b => `        <li>${escAllowInline(b)}</li>`).join('\n');
    return `
    <div class="job">
      <div class="job-header">
        <span class="job-company">${esc(job.company)}</span>
        <span class="job-period">${esc(job.period)}</span>
      </div>
      <div class="job-role">${esc(job.role)}</div>
      <ul>
${bullets}
      </ul>
    </div>`;
  }).join('\n');
}

export function buildProjectsHtml(projects) {
  if (!Array.isArray(projects) || projects.length === 0) return '';
  return projects.map(p => {
    const badge = p.badge ? ` <span class="project-badge">${esc(p.badge)}</span>` : '';
    const desc  = `<div class="project-desc">${escAllowInline(p.desc || '')}</div>`;
    const tech  = p.tech ? `\n      <div class="project-tech">${esc(p.tech)}</div>` : '';
    return `
    <div class="project">
      <div class="project-title">${esc(p.title)}${badge}</div>
      ${desc}${tech}
    </div>`;
  }).join('\n');
}

export function buildEducationHtml(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map(e => {
    const desc = e.desc ? `\n      <div class="edu-desc">${escAllowInline(e.desc)}</div>` : '';
    return `
    <div class="edu-item">
      <div class="edu-header">
        <div>
          <div class="edu-title">${esc(e.title)}</div>
          <div class="edu-org">${esc(e.org)}</div>
        </div>
        <span class="edu-year">${esc(e.year)}</span>
      </div>${desc}
    </div>`;
  }).join('\n');
}

export function buildCertificationsHtml(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items.map(c => `
    <div class="cert-item">
      <div class="cert-title">${esc(c.title)} <span class="cert-org">${esc(c.org)}</span></div>
      <span class="cert-year">${esc(c.year)}</span>
    </div>`).join('\n');
}

// Inline skills format per modes/_profile.md CV Format Standards:
//   <div class="skills-block">
//     <strong>Languages:</strong> Python (advanced), SQL (advanced), PySpark<br>
//     <strong>Data Platform:</strong> Snowflake, dbt, ...<br>
//   </div>
// First category must be "Languages" (or "Healthcare Data" for healthcare roles).
export function buildSkillsHtml(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  const lines = categories.map((cat, i) => {
    const itemList = Array.isArray(cat.items) ? cat.items.join(', ') : String(cat.items || '');
    const br = i < categories.length - 1 ? '<br>' : '';
    return `      <strong>${esc(cat.category)}:</strong> ${esc(itemList)}${br}`;
  }).join('\n');
  return `    <div class="skills-block">\n${lines}\n    </div>`;
}

// ── drop the entire <!-- KEY:START -->…<!-- KEY:END --> block when content is empty
function dropSection(template, key) {
  const re = new RegExp(
    `\\n?\\s*<!-- ${key}:START -->[\\s\\S]*?<!-- ${key}:END -->\\n?`
  );
  return template.replace(re, '');
}

// ── contact-row conditional pruning (phone + portfolio may be empty) ─────────
// Removes the field's <span> AND its following separator span, regardless of
// the separator's literal content (e.g. " &nbsp;|&nbsp; " vs "|").
function pruneContactRow(html, profile) {
  let out = html;
  if (!profile.phone) {
    out = out.replace(
      /\s*<span>\{\{PHONE\}\}<\/span>\s*<span class="separator">[^<]*<\/span>/,
      ''
    );
  }
  if (!profile.portfolio) {
    out = out.replace(
      /\s*<a href="\{\{PORTFOLIO_URL\}\}">\{\{PORTFOLIO_DISPLAY\}\}<\/a>\s*<span class="separator">[^<]*<\/span>/,
      ''
    );
  }
  return out;
}

// ── main builder ──────────────────────────────────────────────────────────────
export function buildTailoredCv({ template, profile, content, format = 'letter', lang = 'en', labels = null }) {
  if (!template) throw new Error('template required');
  if (!profile)  throw new Error('profile required');
  if (!content)  throw new Error('content required');

  const pageWidth = format === 'a4' ? '210mm' : '8.5in';

  // Default section labels (English). Match Resume/<archetype>/ baselines:
  // short, single-word where possible. CSS text-transform uppercases them.
  // Caller can override for i18n.
  const L = {
    SUMMARY:        'Summary',
    COMPETENCIES:   'Core Competencies', // unused in current template; kept for back-compat
    EXPERIENCE:     'Experience',
    PROJECTS:       'Projects',
    EDUCATION:      'Education',
    CERTIFICATIONS: 'Certifications',
    SKILLS:         'Technical Skills',
    ...(labels || {}),
  };

  let html = template;

  // 1. Prune contact-row fields the candidate doesn't have
  html = pruneContactRow(html, profile);

  // 2. Drop optional sections (Projects, Certifications) if content empty
  const hasProjects = Array.isArray(content.projects) && content.projects.length > 0;
  const hasCerts    = Array.isArray(content.certifications) && content.certifications.length > 0;
  if (!hasProjects) html = dropSection(html, 'PROJECTS');
  if (!hasCerts)    html = dropSection(html, 'CERTIFICATIONS');

  // 3. Normalize linkedin / portfolio to a full URL (template uses bare host in display)
  const linkedinUrl = profile.linkedin
    ? (profile.linkedin.startsWith('http') ? profile.linkedin : `https://${profile.linkedin}`)
    : '';
  const portfolioUrl = profile.portfolio
    ? (profile.portfolio.startsWith('http') ? profile.portfolio : `https://${profile.portfolio}`)
    : '';

  // 4. Build the substitution map. Static fields are escaped; sub-HTML blocks
  //    are pre-built with the template's exact class names.
  const fills = {
    LANG:               lang,
    PAGE_WIDTH:         pageWidth,
    NAME:               esc(profile.name),
    PHONE:              esc(profile.phone),
    EMAIL:              esc(profile.email),
    LINKEDIN_URL:       linkedinUrl,
    LINKEDIN_DISPLAY:   esc(profile.linkedin || ''),
    PORTFOLIO_URL:      portfolioUrl,
    PORTFOLIO_DISPLAY:  esc(profile.portfolio || ''),
    LOCATION:           esc(profile.location),

    SECTION_SUMMARY:        L.SUMMARY,
    SECTION_COMPETENCIES:   L.COMPETENCIES,
    SECTION_EXPERIENCE:     L.EXPERIENCE,
    SECTION_PROJECTS:       L.PROJECTS,
    SECTION_EDUCATION:      L.EDUCATION,
    SECTION_CERTIFICATIONS: L.CERTIFICATIONS,
    SECTION_SKILLS:         L.SKILLS,

    SUMMARY_TEXT:   escAllowInline(content.summary || ''),
    COMPETENCIES:   buildCompetenciesHtml(content.competencies || []),
    EXPERIENCE:     buildExperienceHtml(content.experience || []),
    PROJECTS:       hasProjects ? buildProjectsHtml(content.projects) : '',
    EDUCATION:      buildEducationHtml(content.education || []),
    CERTIFICATIONS: hasCerts ? buildCertificationsHtml(content.certifications) : '',
    SKILLS:         buildSkillsHtml(content.skills || []),
  };

  // 5. Pure String.replace for each placeholder. split/join handles duplicates.
  for (const [key, value] of Object.entries(fills)) {
    html = html.split(`{{${key}}}`).join(value);
  }

  return html;
}

// ── CLI entry point ──────────────────────────────────────────────────────────
const isCli = process.argv[1] && process.argv[1].endsWith('build-tailored-cv.mjs');
if (isCli) {
  const args = process.argv.slice(2);
  const [contentPath, outputPath] = args.filter(a => !a.startsWith('--'));
  const format = (args.find(a => a.startsWith('--format='))?.split('=')[1] || 'letter').toLowerCase();
  const lang   = args.find(a => a.startsWith('--lang='))?.split('=')[1] || 'en';

  if (!contentPath || !outputPath) {
    console.error('Usage: node build-tailored-cv.mjs <content.json> <output.html> [--format=letter|a4] [--lang=en|es]');
    process.exit(2);
  }

  let content;
  try {
    content = JSON.parse(readFileSync(contentPath, 'utf-8'));
  } catch (e) {
    console.error(`Cannot parse ${contentPath}: ${e.message}`);
    process.exit(1);
  }

  const template = readFileSync(TEMPLATE_PATH, 'utf-8');
  const profile  = loadProfile();
  const html     = buildTailoredCv({ template, profile, content, format, lang });
  writeFileSync(outputPath, html);
  console.log(`✓ Wrote ${outputPath} (${(html.length / 1024).toFixed(1)} KB)`);
}
