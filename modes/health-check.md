# Mode: health-check — End-to-End Pipeline Health Audit

Run a comprehensive read-only audit of the career-ops pipeline. Verify code integrity, runtime data flow, visa gating consistency across all supported adopter types, and downstream module coherence. Report objectively with PASS / FAIL / WARN per category.

## Flag handling

Parse `$mode` argument for flags:
- `health-check --fast` → run categories 1–12 only (~5 min budget)
- `health-check --deep` → run categories 13–14 only (~15 min budget). Assumes fast pass just ran.
- `health-check` (no flag) → run all 14 categories (~20 min budget)

If no flag specified, default to running everything (all 14 categories).

## Constraints (mandatory)

- **Read-only preferred.** Do NOT modify any tracked files unless the user explicitly asks after seeing findings.
- **Temp files go to `/tmp/audit-*`.** Clean up after each category that creates them.
- **Do NOT spawn `claude -p` workers** during the audit.
- **Do NOT touch or trigger launchd jobs.**
- **Do NOT modify `data/applications.md`, `batch/batch-state.tsv`, or any user data** during dynamic verification (Category 14).
- If a check takes > 5 seconds, report the timing.

---

# FAST PASS (Categories 1–12, ~5 min)

## Category 1 — Static integrity

- `node --check` on every tracked `.mjs` file
- `bash -n` on every tracked `.sh` file
- Every `import` in `.mjs` files resolves to an existing file
- `.yml` and `.json` files with structural requirements parse cleanly (`package.json`, `.github/workflows/*.yml`, `templates/portals.example.yml`)

## Category 2 — User-layer files present and populated

- `cv.md`, `config/profile.yml`, `portals.yml`, `modes/_profile.md` all exist
- **Placeholder detection**: if `modes/_profile.md` contains unresolved template tokens like `<Category 1>`, `<Primary employer>`, `<Second employer>`, report as WARN — the CV Format Standards are incomplete and tailored CVs will be generic
- `config/profile.yml` has required fields: `candidate.full_name`, `candidate.email`, `candidate.location`, `candidate.visa_status`
- `cv.md` has `# PROFESSIONAL EXPERIENCE` and `# EDUCATION` sections
- `modes/_profile.md` has a `## CV Format Standards` section (and its subsections are populated, not placeholder stubs)

## Category 3 — Visa gating with concrete assertions (most critical)

For each `visa_status`, temporarily override in a `/tmp/audit-profile.yml` copy, then verify Gate1 verdicts against real filter logic in `auto-batch.mjs`. Do NOT touch the real `config/profile.yml`.

**Test matrix** — each row is one assertion. Report FAIL with the specific expected/actual mismatch for any row that doesn't match.

| visa_status | Test input | Expected Gate1 verdict |
|---|---|---|
| `Requires H-1B transfer sponsorship` | job lca_count=0 | FILTER (reason: lca:0) |
| `Requires H-1B transfer sponsorship` | JD contains "US Citizens only" | FILTER (reason: keyword) |
| `Requires H-1B transfer sponsorship` | JD contains "TS/SCI required" | FILTER (reason: clearance) |
| `US Citizen` | job lca_count=0 | PASS |
| `US Citizen` | JD contains "US Citizens only" | PASS |
| `US Citizen` | JD contains "TS/SCI required" | FILTER (clearance always applies) |
| `Green Card` | lca_count=0 | PASS (same as US Citizen) |
| `Permanent Resident` | lca_count=0 | PASS |
| `F-1 OPT` | lca_count=0 | FILTER (future sponsorship needed) |
| `L-1 transfer` | lca_count=0 | FILTER |
| (empty / missing) | lca_count=0 | FILTER (conservative default) |

**Queue-eligibility.mjs behavior**:

| visa_status | Test input | Expected |
|---|---|---|
| Needs sponsorship | report with h1bLabel=null | isQueueEligible = false |
| US Citizen | report with h1bLabel=null | isQueueEligible = true |
| US Citizen | report NOT in Apply Queue | isQueueEligible = false |

**Cross-file consistency**: verify all 3 filter files (`auto-batch.mjs`, `fantastic-scan.mjs`, `queue-eligibility.mjs`) reference `userNeedsSponsorship()` — the pattern must be consistent across all three. Any drift = FAIL.

## Category 4 — CV generation pipeline end-to-end

- `loadProfile(config/profile.yml)` returns expected fields
- `parseCV(cv.md)` returns `experience[0].company` matching the first entry in `# PROFESSIONAL EXPERIENCE`
- `buildTailoredCv()` renders a minimal test CV successfully
- Rendered contact line contains all 5 fields (phone, email, LinkedIn, GitHub, location) in the correct order
- Contact line has NO qualifier text next to the GitHub URL
- All template placeholders in `templates/cv-template.html` get filled — no orphaned `{{PLACEHOLDER}}` strings in output

## Category 5 — Gate1 → Phase 2 state flow

- `batch/gate1-results.tsv` is well-formed (5 tab-separated columns)
- The string `gate1_filtered` appears in ALL THREE consumers: `auto-batch.mjs`, `batch/batch-runner.sh`, `playwright-prefetch.mjs`
- Each consumer has explicit skip/handle logic for that status (not just a mention)
- `syncGate1FiltersToState()` runs after `runGate1()` in the `auto-batch.mjs` main IIFE

## Category 6 — Data integrity

- `data/applications.md`: list any non-canonical statuses (must match `templates/states.yml`). Include row numbers.
- Duplicate `(company + role)` tuples in the tracker
- Reports referenced from tracker that don't exist on disk
- Orphaned reports (exist on disk but not referenced in tracker)
- `data/h1b-cache.tsv` well-formed (8+ tab-separated columns per row)

## Category 7 — launchd + lifecycle

- `launchctl list | grep careerops` — both `com.careerops.batch` and `com.careerops.scan` loaded?
- `start.sh` and `launch-chrome.sh` are executable
- No hardcoded personal paths in any tracked source (grep for `/Users/[username]/` patterns using the current shell user)

## Category 8 — Regression tests

- Run `node test-all.mjs`. Baseline: **189 passed, 2 failed** (verify-pipeline data hygiene + dashboard Go build). Any NEW failures beyond those 2 = FAIL.
- Report the exact pass/fail counts.

## Category 9 — Performance / staleness signals

- `data/h1b-cache.tsv` entries older than 60 days (report count)
- `batch/batch-state.tsv` `in-progress` entries stuck > 1 hour
- Stale lock files: `batch/batch-runner.pid`, `batch/.batch-state.lock/`, any `batch/tracker-additions/*.lock`

## Category 10 — Documentation freshness (with drift detection)

**Basic checks**:
- `docs/PIPELINE.md`, `docs/ARCHITECTURE.md`, `docs/DEBUGGING.md` exist
- `README.md` links to all three, each linked path resolves

**Drift detection**:
- `docs/ARCHITECTURE.md` documents the `auto-batch.mjs` main flow order. Verify the actual main IIFE calls those functions in the documented order. Report deviations.
- `docs/PIPELINE.md` Journey 3 references specific line numbers (`auto-batch.mjs:~385` for `trySuffixExpansion`, `auto-batch.mjs:649` for LCA threshold). Verify each cited line still contains the referenced content.
- `docs/DEBUGGING.md` example commands (awk over `batch-state.tsv`, grep over `gate1-results.tsv`). Verify each command's schema assumptions still hold against the current TSV column count.

## Category 11 — Privacy / PII audit

- Search tracked files for:
  - Email addresses (regex)
  - US phone number patterns
  - `/Users/<username>/` paths (with the actual username)
  - API key formats: `ghp_`, `github_pat_`, `sk-`, `sk-ant-`, `AKIA`, `xoxb-`, `xoxp-`, `zpka_`
- Also search full git history via `git log -p -S` for the same patterns
- Report any matches with `file:line`

## Category 12 — Adopter path simulation

- If a US Citizen adopter (`visa_status: "US Citizen"`) ran the pipeline today, would low-LCA and citizen-only jobs make it through Gate1? Cross-check with Category 3 concrete assertions.
- If a fresh clone runs `node doctor.mjs`, does it correctly identify missing user-layer files and report `onboardingNeeded: true` with the correct `missing` list?

---

# DEEP PASS (Categories 13–14, additional ~15 min)

## Category 13 — Hardcoded personalization in system-layer files

User-specific data (employer names, personal metrics, hardcoded company values) should live ONLY in user-layer files: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`.

Read `cv.md` first to extract the actual employer names and metrics for this candidate. Then search tracked SYSTEM-LAYER files (EXCLUDING `cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, and any `*.example.*` or `*.template.*` file) for:

- Specific employer names extracted from `cv.md`
- Personal metrics from `cv.md` (specific record-count numbers, percentages, dollar amounts)
- Specific bullet-count values from `modes/_profile.md` (e.g., `"6-7 bullets"`, `"exactly 2 bullets"`)
- Personal email, phone number, LinkedIn handle

Any match in a system-layer file = FAIL. It should be parameterized from user-layer files at runtime, not hardcoded. Report `file:line` of each hit with the offending substring.

Rationale: personalization in system-layer files means leakage risk during public-repo scrutiny, and any refactor or code update to those files can silently drop the customization.

## Category 14 — Dynamic end-to-end verification

Create `/tmp/audit-test/` with a minimal fresh config, then run a small pipeline pass to verify BEHAVIOR (not just code).

**Setup**:
1. Copy `config/profile.example.yml` → `/tmp/audit-test/profile.yml`
2. Set `visa_status: "US Citizen"` in the temp profile
3. Create minimal `/tmp/audit-test/cv.md` with 1 fictional employer + 3 bullets
4. Create `/tmp/audit-test/batch-input.tsv` with 3 synthetic rows:

| id | url | source | notes |
|---|---|---|---|
| test-001 | `https://example.com/jobs/us-citizens-only` | test | Company X — Senior DE (US Citizens Only in title) |
| test-002 | `https://example.com/jobs/low-lca` | test | Small Regional Bank — Senior DE (fictional low-LCA firm) |
| test-003 | `https://example.com/jobs/tssci` | test | Defense Contractor — Senior DE (TS/SCI required in title) |

**Execute**:
- Point `auto-batch.mjs` at the temp config via env override (e.g., `CAREER_OPS_PROFILE=/tmp/audit-test/profile.yml`)
- Run **Gate1 only** — do NOT spawn Claude workers, do NOT run `runBatch()`
- Capture the resulting `gate1-results.tsv` from a temp batch dir

**Verification**:
- `test-001`: expected status `PASS`, reason `-` (US Citizen shouldn't filter citizens-only jobs)
- `test-002`: expected status `PASS`, reason `-` (US Citizen bypasses LCA threshold)
- `test-003`: expected status `FILTER`, reason contains `clearance` (clearance filter always applies)

Any mismatch = FAIL with expected vs actual.

**Cleanup**: `rm -rf /tmp/audit-test` after.

---

# Output format (mandatory)

Structure the report as:

1. **Per-category report**: `Category N — [PASS | FAIL | WARN] + specific finding`. If FAIL, include the file/line/exact issue.
2. **Summary table**:
   ```
   | Category | Status | Notes |
   |----------|--------|-------|
   | 1. Static integrity | PASS | 47/47 .mjs parse cleanly |
   | 2. User-layer files | WARN | modes/_profile.md has 3 template placeholders |
   | ... |
   ```
3. **Overall verdict**: `READY` (all PASS or only WARN) / `NEEDS ATTENTION` (1-2 FAIL) / `BROKEN` (3+ FAIL or any critical category failed)
4. **Prioritized recommendations**: for each FAIL, one-line description of the fix + which file needs editing.
5. **Timings**: for any check taking > 5 seconds, report `Category N: took Xs`.

# When to run

- Before making any code change to shared modules (`auto-batch`, `batch-runner`, `queue-eligibility`, `fantastic-scan`)
- After making any such change (regression check)
- Before pushing a commit that touches state files
- After a fresh clone / setup to verify onboarding worked
- Before applying to a role where the tailored CV pipeline runs

# Notes for the audit executor

- If a check's underlying command (e.g., `node --check`) fails to run at all (permission, missing binary), mark that check WARN (not FAIL) and note the reason.
- If the pre-existing baseline (test-all.mjs 189/2) has drifted upward (e.g., new tests added since this mode was written), update the baseline in your report but treat it as new-baseline, not regression.
- Prioritize actionable findings over completeness — if you find a critical FAIL early, report it immediately at the top of the summary in addition to its category location.
