# Mode: pdf — ATS-Optimized PDF Generation

> **Important — deterministic template fill.** Never write the HTML yourself. Produce a JSON of tailored content, then call `build-tailored-cv.mjs` to substitute it into `templates/cv-template.html` byte-for-byte. The template owns the layout, fonts, colors, gradient, and spacing — that contract guarantees every tailored PDF is visually identical to the generic resume.

## Full pipeline

1. Read `cv.md` as the source of truth
2. Ask the user for the JD if it is not in context (text or URL)
3. Extract 15-20 keywords from the JD
4. Detect JD language → CV language (EN default)
5. Detect company location → paper format:
   - US/Canada → `letter`
   - Rest of the world → `a4`
6. Detect role archetype → adapt framing
7. Rewrite Professional Summary by injecting JD keywords + exit narrative bridge (when applicable to the candidate per `modes/_profile.md`)
8. Select top 3-4 most relevant projects for the job (omit the section if `cv.md` has no Projects)
9. Reorder experience bullets by JD relevance
10. Build competency grid from JD requirements (6-8 keyword phrases)
11. Inject keywords naturally into existing achievements (NEVER invent)
12. Build the JSON content object (see [Content JSON schema](#content-json-schema) below)
13. Determine output folder:
    - If `report_num` is already known from the current session (e.g. from a prior evaluation step) → use `{report_num}-{slug}`
    - Else grep `data/applications.md` for this company+role, extract the report link number → use that as `{report_num}`
    - Fallback (no tracker entry): use `pdf-{slug}-{YYYY-MM-DD}` as the folder name
    - `mkdir -p output/{report_num}-{slug}`
14. Write the JSON content to `output/{report_num}-{slug}/cv-content.json`
15. Run two commands in sequence:
    - `node build-tailored-cv.mjs output/{report_num}-{slug}/cv-content.json output/{report_num}-{slug}/cv-tailored.html --format={letter|a4} --lang={en|es}`
    - `node generate-pdf.mjs output/{report_num}-{slug}/cv-tailored.html output/{report_num}-{slug}/resume.pdf --format={letter|a4}`
16. Report: `output/{report_num}-{slug}/resume.pdf`, number of pages, keyword coverage %

## Content JSON schema

`build-tailored-cv.mjs` expects this exact shape. Keys are strict; missing required keys produce an empty section.

```json
{
  "summary": "3-4 sentences. Weave 3-5 JD keywords naturally. No inventions.",
  "competencies": ["6-8 short keyword phrases from JD that candidate can demonstrate per cv.md"],
  "experience": [
    {
      "company": "Employer (optionally · subtitle)",
      "period": "May 2022 – May 2026",
      "role": "Job title",
      "bullets": ["bullet text — may include <strong>keyword</strong> emphasis"]
    }
  ],
  "projects": [
    { "title": "…", "badge": "Optional badge", "desc": "…", "tech": "…" }
  ],
  "education": [
    { "title": "Degree", "org": "Institution", "year": "Aug 2018 – Dec 2019", "desc": "" }
  ],
  "certifications": [
    { "title": "Cert name", "org": "Issuer", "year": "2024" }
  ],
  "skills": [
    { "category": "Languages", "items": ["Python (advanced)", "SQL (advanced)"] }
  ]
}
```

- For sections with no content in `cv.md`, set the value to an empty array (`"projects": []`, `"certifications": []`). The script removes the section block entirely.
- Static fields — name, email, phone, LinkedIn, portfolio, location — come from `config/profile.yml` automatically; do not include them in the JSON.
- Section labels ("Professional Summary", "Technical Skills", etc.) are filled by the script; do not include them.

## ATS Rules (clean parsing)

- Single-column layout (no sidebars, no parallel columns)
- Standard headers: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects"
- No text in images/SVGs
- No critical info in PDF headers/footers (ATS ignores them)
- UTF-8, selectable text (not rasterized)
- No nested tables
- Distributed JD keywords: Summary (top 5), first bullet of each role, Skills section

## PDF Design

- **Fonts**: Space Grotesk (headings, 600-700) + DM Sans (body, 400-500)
- **Fonts self-hosted**: `fonts/`
- **Header**: name in Space Grotesk 24px bold + gradient line `linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%))` 2px + contact row
- **Section headers**: Space Grotesk 13px, uppercase, letter-spacing 0.05em, color cyan primary
- **Body**: DM Sans 11px, line-height 1.5
- **Company names**: accent purple color `hsl(270,70%,45%)`
- **Margins**: 0.6in
- **Background**: pure white

## Section order (optimized "6-second recruiter scan")

1. Header (large name, gradient, contact, portfolio link)
2. Professional Summary (3-4 lines, keyword-dense)
3. Core Competencies (6-8 keyword phrases in flex-grid)
4. Work Experience (reverse chronological)
5. Projects (top 3-4 most relevant)
6. Education & Certifications
7. Skills (languages + technical)

## Keyword injection strategy (ethical, truth-based)

Examples of legitimate reformulation:
- JD says "RAG pipelines" and CV says "LLM workflows with retrieval" → change to "RAG pipeline design and LLM orchestration workflows"
- JD says "MLOps" and CV says "observability, evals, error handling" → change to "MLOps and observability: evals, error handling, cost monitoring"
- JD says "stakeholder management" and CV says "collaborated with team" → change to "stakeholder management across engineering, operations, and business"

**NEVER add skills that the candidate does not have. Only reword real experience using the exact JD vocabulary.**

## Template ownership (do not write HTML)

The on-disk template `templates/cv-template.html` is the single source of truth for layout, fonts, colors, gradient, spacing, and CSS. `build-tailored-cv.mjs` fills its `{{PLACEHOLDER}}` slots from:

- **Static fields** (read from `config/profile.yml`): `NAME`, `EMAIL`, `PHONE`, `LINKEDIN_URL`, `LINKEDIN_DISPLAY`, `PORTFOLIO_URL`, `PORTFOLIO_DISPLAY`, `LOCATION`. Empty `phone` / `portfolio_url` cause the script to prune their `<span>` + adjacent separator from the contact row.
- **Format fields** (CLI flags): `LANG` from `--lang`, `PAGE_WIDTH` from `--format` (`letter` → `8.5in`, `a4` → `210mm`).
- **Section labels** (English defaults: "Professional Summary", "Core Competencies", "Professional Experience", "Projects", "Education", "Certifications", "Technical Skills"). Override via the `labels` arg when calling as a library; CLI uses English.
- **Tailored content blocks**: `SUMMARY_TEXT`, `COMPETENCIES`, `EXPERIENCE`, `PROJECTS`, `EDUCATION`, `CERTIFICATIONS`, `SKILLS` — built deterministically from the JSON content object in the script using the template's exact class names. Inline `<strong>` / `<em>` / `<br>` are permitted in summary, bullets, project descriptions; everything else is HTML-escaped.

If a tailored block needs a class or layout change, **edit `templates/cv-template.html`**. Do not invent classes inside the JSON — they will not have CSS and the rendered PDF will drift from the generic resume.

## Canva CV Generation (optional)

If `config/profile.yml` has `cv.canva_resume_design_id` set, offer the user a choice before generating:
- **"HTML/PDF (fast, ATS-optimized)"** — existing flow above
- **"Canva CV (visual, design-preserving)"** — new flow below

If the user has no `cv.canva_resume_design_id`, skip this prompt and use the HTML/PDF flow.

### Canva workflow

#### Step 1 — Duplicate the base design

a. `export-design` the base design (using `cv.canva_resume_design_id`) as PDF → get download URL
b. `import-design-from-url` using that download URL → creates a new editable design (the duplicate)
c. Note the new `design_id` for the duplicate

#### Step 2 — Read the design structure

a. `get-design-content` on the new design → returns all text elements (richtexts) with their content
b. Map text elements to CV sections by content matching:
   - Look for the candidate's name → header section
   - Look for "Summary" or "Professional Summary" → summary section
   - Look for company names from cv.md → experience sections
   - Look for degree/school names → education section
   - Look for skill keywords → skills section
c. If mapping fails, show the user what was found and ask for guidance

#### Step 3 — Generate tailored content

Same content generation as the HTML flow (Steps 1-11 above):
- Rewrite Professional Summary with JD keywords + exit narrative
- Reorder experience bullets by JD relevance
- Select top competencies from JD requirements
- Inject keywords naturally (NEVER invent)

**IMPORTANT — Character budget rule:** Each replacement text MUST be approximately the same length as the original text it replaces (within ±15% character count). If tailored content is longer, condense it. The Canva design has fixed-size text boxes — longer text causes overlapping with adjacent elements. Count the characters in each original element from Step 2 and enforce this budget when generating replacements.

#### Step 4 — Apply edits

a. `start-editing-transaction` on the duplicate design
b. `perform-editing-operations` with `find_and_replace_text` for each section:
   - Replace summary text with tailored summary
   - Replace each experience bullet with reordered/rewritten bullets
   - Replace competency/skills text with JD-matched terms
   - Replace project descriptions with top relevant projects
c. **Reflow layout after text replacement:**
   After applying all text replacements, the text boxes auto-resize but neighboring elements stay in place. This causes uneven spacing between work experience sections. Fix this:
   1. Read the updated element positions and dimensions from the `perform-editing-operations` response
   2. For each work experience section (top to bottom), calculate where the bullets text box ends: `end_y = top + height`
   3. The next section's header should start at `end_y + consistent_gap` (use the original gap from the template, typically ~30px)
   4. Use `position_element` to move the next section's date, company name, role title, and bullets elements to maintain even spacing
   5. Repeat for all work experience sections
d. **Verify layout before commit:**
   - `get-design-thumbnail` with the transaction_id and page_index=1
   - Visually inspect the thumbnail for: text overlapping, uneven spacing, text cut off, text too small
   - If issues remain, adjust with `position_element`, `resize_element`, or `format_text`
   - Repeat until layout is clean
e. Show the user the final preview and ask for approval
f. `commit-editing-transaction` to save (ONLY after user approval)

#### Step 5 — Export and download PDF

a. `export-design` the duplicate as PDF (format: a4 or letter based on JD location)
b. **IMMEDIATELY** download the PDF using Bash (same `{report_num}-{slug}` folder from Step 15):
   ```bash
   mkdir -p output/{report_num}-{slug}
   curl -sL -o "output/{report_num}-{slug}/resume.pdf" "{download_url}"
   ```
   The export URL is a pre-signed S3 link that expires in ~2 hours. Download it right away.
c. Verify the download:
   ```bash
   file output/{report_num}-{slug}/resume.pdf
   ```
   Must show "PDF document". If it shows XML or HTML, the URL expired — re-export and retry.
d. Report: `output/{report_num}-{slug}/resume.pdf`, file size, Canva design URL (for manual tweaking)

#### Error handling

- If `import-design-from-url` fails → fall back to HTML/PDF pipeline with message
- If text elements can't be mapped → warn user, show what was found, ask for manual mapping
- If `find_and_replace_text` finds no matches → try broader substring matching
- Always provide the Canva design URL so the user can edit manually if auto-edit fails

## Post-generation

Update tracker if the job is already registered: change PDF from ❌ to ✅.
