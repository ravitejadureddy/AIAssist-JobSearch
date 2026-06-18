# Mode: review — Daily Digest & Apply/Skip Decisions

Show all evaluated jobs waiting for a decision, ranked by score. Accept apply/skip commands and update the tracker — no manual markdown editing needed.

## When to use

User says: "review", "show me today's jobs", "what should I apply to", "daily digest", "what's pending", "review jobs"

## Workflow

### Step 1 — Load evaluated jobs

Read `data/applications.md`. Find every row where Status = `Evaluated`. Sort by score descending.

If nothing is pending: say "No evaluated jobs waiting for a decision. Run `/career-ops pipeline` first to evaluate new postings."

### Step 1.5 — Liveness cross-check (MANDATORY before showing digest)

Before displaying any job as actionable, verify it is still a live posting. Do both checks:

**Check A — Pipeline cross-reference (instant, no network)**
Read `data/pipeline.md`. For every Evaluated job from Step 1:
- If the job's URL appears in the Processed section as `[!]` (pruned/expired) → it is dead
- Update its status in `data/applications.md` to `Discarded` with note "Posting expired — pruned by pipeline {date}"
- Remove it from the digest silently (do not show to user as an apply option)

**Check B — Active link verification (network, for jobs not already pruned)**
For every remaining Evaluated job (those that passed Check A):
- Use `node check-liveness.mjs {URL}` if available, OR Playwright `browser_navigate` + `browser_snapshot`
- **Active**: job title + description visible + Apply button present → include in digest
- **Dead**: "no longer available" / 404 / Greenhouse `?error=true` / empty page → mark `Discarded` in tracker ("Posting expired — liveness check {date}") and exclude from digest
- **Unverifiable** (JS render failure, login wall, etc.) → include in digest but flag with ⚠️ "Verify link before applying"

Only jobs confirmed active (or unverifiable with ⚠️ flag) appear in the digest.

### Step 2 — Show digest

```
## Daily Review — {YYYY-MM-DD}

### Ready to Apply (4.0+)
| # | Company | Role | Score | CV | Cover | Notes |
|---|---------|------|-------|----|-------|-------|
| 5  | Precision AQ      | Senior Data Engineer | 4.8/5 | ✅ | ✅ | Snowflake/dbt, life sciences |
| 1  | Imagine Pediatrics | Staff Data Engineer  | 4.9/5 | ✅ | ✅ | Healthcare DE, Snowflake/AWS |

### Apply with Materials (3.5–3.9)
| # | Company | Role | Score | CV | Cover | Notes |
|---|---------|------|-------|----|-------|-------|
| 8  | WellBe  | Senior Data Engineer | 3.6/5 | ✅ | ✅ | Comp below target ($150K vs $160K) |

### Review Only (below 3.5)
| # | Company | Role | Score | Notes |
|---|---------|------|-------|-------|
| 40 | HHAeXchange | Data Engineer | 2.5/5 | Comp far below target |
```

CV column: ✅ if `output/{num}-*-cv.pdf` exists, ❌ if missing (generate on demand).
Cover column: ✅ if `output/{num}-*-cover.pdf` exists, ❌ if missing (generate on demand).

Show count: "X jobs ready to apply, Y with materials, Z to review only."

If CV or Cover is ❌ for any 3.5+ job: offer to generate them before the user applies.

### Step 3 — Ask for decisions

> "Which would you like to act on?
> - `apply 1 5 6` — mark as Applied
> - `apply all 4.0+` — apply to everything scoring 4.0 or above (confirm list first)
> - `apply all 3.5+` — apply to everything with materials (confirm list first)
> - `skip 8` — mark as Discarded
> - `hold 10` — leave as Evaluated (revisit later)
> - `generate 8` — generate missing CV/cover letter for a specific job
> - Or name specific companies: `apply Humana, skip WellBe`"

### Step 4 — Process commands

For each actioned job:

**Apply:**
- Update Status column → `Applied`
- Append today's date to Notes: `Applied {YYYY-MM-DD}`
- Do NOT auto-submit anything — the user submits on the company site

**Skip:**
- Update Status column → `Discarded`

**Hold:**
- Leave as `Evaluated`, no change

Edit `data/applications.md` in-place for each row. Use exact row number (`#` column) to identify rows — never match by position.

### Step 5 — Confirm

Show a summary:
```
Applied  → Precision AQ (#5), Imagine Pediatrics (#1)
Discarded → WellBe (#8)
On hold   → CVS Health (#10)

Next: submit your applications on each company site. Come back and run /career-ops review again to clear the next batch.
```

## Rules

- **NEVER auto-submit** anything. Tracker updates only — the user clicks Apply on the company site.
- **NEVER show expired jobs as apply candidates.** Always run Step 1.5 before presenting the digest.
- If score < 3.0 and user tries to apply: warn first → "This scored X/5 which is below the recommended threshold. Apply anyway?"
- If score = 0.0 (SKIP/no sponsorship): block apply → "This was marked SKIP due to [reason]. Cannot mark as Applied."
- After bulk `apply all 4.0+` or `apply all 3.5+`: confirm the list before updating → "This will mark N jobs as Applied: [list]. Confirm?"
- If CV or Cover Letter PDF is missing for a job the user wants to apply to: generate it on the spot before marking Applied.
- Never mark a Discarded or SKIP row as Applied without explicit user override.
