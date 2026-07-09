# Debugging Guide

Practical Q&A for things that go wrong. Read [PIPELINE.md](PIPELINE.md) first if you want end-to-end context. Read [ARCHITECTURE.md](ARCHITECTURE.md) for component-oriented docs.

Everything below assumes you're in the project root: `cd ~/Desktop/career-ops` (or wherever you cloned it).

---

## "A job was filtered — why?"

Every filter decision is logged. Trace it in three steps.

**Step 1 — Find the batch ID.** If you have the report number, look at the tracker (`data/applications.md`). If not, grep the JD URL:

```bash
grep -n "linkedin.com/jobs/view/XXXXXXX" batch/batch-input.tsv
```

The first column is the batch ID.

**Step 2 — Check the Gate1 verdict** for that ID:

```bash
awk -F'\t' -v id=BATCH_ID '$1 == id' batch/gate1-results.tsv
```

You get one of:
- `PASS  N  -` — Gate1 passed, filter didn't happen here
- `FILTER  0  lca:0  Company Name` — LCA count filter (H-1B users only)
- `FILTER  0  keyword:no sponsorship  Company Name` — JD had a rejected keyword
- `FILTER  0  cap-exempt: company: Foo University  Company Name` — university/govt name match
- `FILTER  0  cap-exempt: jd: 501(c)(3)  Company Name` — JD content matched cap-exempt pattern
- `FILTER  0  foreign  Company Name` — foreign/anonymous employer detected

**Step 3 — Check the filter log** for date + URL context:

```bash
grep BATCH_ID batch/logs/filtered-*.log
```

### If the LCA filter fired but you disagree

The company might be legitimate but with a different name at h1bdata.info. Try a manual check:

```bash
# Look up as-is
open "https://h1bdata.info/index.php?em=company+name&year=2025"

# Look up with variants
open "https://h1bdata.info/index.php?em=company+name+inc&year=2025"
open "https://h1bdata.info/index.php?em=parent+company+name&year=2025"
```

If a variant returns hits, add an alias to `data/h1b-cache.tsv`:
```
company-slug\tCorrect Full Name\t\t50\t\t50\tLikely\t2026-07-02\tmanual
```

Next run will use the manual entry (30-day freshness). To force immediate re-check, delete the old entry from the cache first.

### If the keyword filter fired but shouldn't have

Look at the JD text in `/tmp/batch-jd-BATCH_ID.txt` (if pre-fetched). The filter uses `HARD_REJECT_KEYWORDS` in `auto-batch.mjs`. If your visa_status shouldn't be gated on the matched pattern, review the pattern list — some are ambiguous (e.g., "US citizen preferred" might not mean "US citizen required").

---

## "The evaluation report exists but no PDF was generated"

Common causes:

### The score was below `auto_pdf_score_threshold`

Check the threshold in `config/profile.yml`:

```yaml
scoring:
  auto_pdf_score_threshold: 3.5
```

Reports below this get skipped for auto-PDF. You can force it:

```bash
node generate-missing-pdfs.mjs --num REPORT_NUM
```

### The Opus worker failed silently

Check the logs. `generate-missing-pdfs.mjs` writes worker output to stderr:

```bash
# Or check /tmp
ls -la /tmp/*.log | tail -5
```

Common failures:
- **Claude Max rate limit** — session cap hit. Wait for reset or use `--model claude-haiku-4-5` to fall back.
- **Missing `output/{N}/` directory** — usually a permissions issue. Recreate: `mkdir -p output/REPORT_NUM`
- **Template not found** — check `templates/cv-template.html` exists.

### The tailored CV JSON was malformed

Look for the JSON:

```bash
cat output/REPORT_NUM/cv-content.json
```

If it's not valid JSON, the Opus worker output was truncated or contained non-JSON preamble. Retry:

```bash
node generate-missing-pdfs.mjs --num REPORT_NUM --force
```

---

## "The dashboard shows old data — how do I refresh?"

The SSE dashboard pushes updates when the underlying files change (validation results, PDF backfills). But if you want to force a full reload:

```bash
# 1. Close the dashboard tab (this quits the server)
# 2. Wait 3 seconds
# 3. Re-launch via CareerOps.app or start.sh
./start.sh
```

Or, without restarting the server, force a browser reload with `Cmd + Shift + R` (hard refresh — bypasses cache).

### The Apply Queue is empty but I expect entries

The Apply Queue filter is: `Evaluated` status + score ≥ 3.5 + recent (last 3 business days).

Common misses:
- Reports older than 3 business days age out even if unchanged. Adjust `businessDayCutoff` in `queue-eligibility.mjs` if you want a longer window.
- Status not exactly `Evaluated` (with capital E) — non-canonical statuses get skipped. Run `node normalize-statuses.mjs` to clean.

---

## "The fill agent isn't filling a field"

### Diagnose in the browser console

Open DevTools on the ATS page (`Cmd + Option + I`). Look for fill-agent log messages:

```
[fill-agent] Filled #input-name with "Ravi Teja"
[fill-agent] Question block skipped: "What excites you about this role?"
```

Skipped question blocks get pushed to `needsAnswer` — the agent asks Claude to answer them via the injected banner. If nothing happens, the ATS-detection step might have picked the wrong handler.

### Check ATS detection

Look at the page URL and match against `smart-apply.mjs:detectATS`. The routing is:
- Contains `greenhouse.io` OR query param `?gh_jid=` → Greenhouse handler
- Contains `lever.co` → Lever handler
- Contains `ashbyhq.com` → Ashby handler
- Contains `myworkdayjobs.com` → Workday handler
- Otherwise → Generic handler

If your ATS is being routed to Generic when it should be a specific handler, add a URL match to `detectATS`.

### The wrapped-ATS trap

Some employers use LinkedIn Job IDs that redirect through their branded domain. The URL might not contain `greenhouse.io` even though the form is Greenhouse. Check for query params: `?gh_jid=1234`, `?lever_id=`, etc. If present, the wrapped-ATS detection should kick in. If not, add a redirect matcher.

### Force a manual re-fill

Use the injected banner's "🔄 Fill Now" button. This is the escape hatch — the fill logic runs synchronously and reports what it did.

---

## "The h1b-cache says the wrong thing about a company"

### Refresh a stale entry

Cache entries are considered fresh for 30 days. Delete the old entry to force a new lookup:

```bash
# Find the entry
grep -n "company-slug" data/h1b-cache.tsv

# Delete the line by number
sed -i.bak '123d' data/h1b-cache.tsv

# Verify
grep "company-slug" data/h1b-cache.tsv
```

Next run of `auto-batch.mjs` will re-fetch from h1bdata.info.

### Manually correct an entry

If h1bdata.info returns wrong data (rare) or you know the truth better (M&A, spinoff, etc.), edit the row directly:

```
company-slug\tCorrect Name\t\t150\t\t150\tConfirmed\t2026-07-02\tmanual
```

Format: `slug \t name \t \t lca_count \t \t total \t label \t date \t source`

The `source` column is informational — putting `manual` signals to future you that this was hand-edited.

### Add a name-collision override

Some names have multiple unrelated companies (e.g., "Fidelity Cooperative Bank" is a small MA community bank, unrelated to Fidelity Investments). Add an explicit override:

```
fidelity-cooperative-bank\tFidelity Cooperative Bank\t\t0\t\t0\tNot Found\t2026-07-02\tmanual-override
```

The `manual-override` source doesn't matter to the code but helps you find it later.

---

## "The batch got stuck — how do I recover?"

### Kill any zombie workers

```bash
pkill -f "claude -p"
pkill -f "playwright"
```

### Clear stale locks

`auto-batch.mjs` and `batch-runner.sh` both create lock files to prevent concurrent runs:

```bash
rm -f batch/batch-runner.pid
rm -rf batch/.batch-state.lock
```

### Reset in-progress jobs to pending

If a batch died mid-job, the state might have jobs stuck at `in-progress`:

```bash
# See what's stuck
awk -F'\t' '$3 == "in-progress"' batch/batch-state.tsv

# Reset them
node -e '
import { readFileSync, writeFileSync } from "fs";
const path = "batch/batch-state.tsv";
const lines = readFileSync(path, "utf-8").split("\n");
const out = lines.map(l => {
  const p = l.split("\t");
  if (p[2] === "in-progress") { p[2] = "pending"; p[3] = ""; }
  return p.join("\t");
});
writeFileSync(path, out.join("\n"));
console.log("Reset in-progress → pending");
'
```

### Re-run the failed jobs

```bash
./batch/batch-runner.sh --retry-failed
```

---

## "Where are the launchd logs?"

The scheduled batches log to `/tmp/`:

```bash
# Main batch (4:35am + 8:20pm)
tail -f /tmp/careerops-batch.log
tail -f /tmp/careerops-batch-error.log

# Daily scan (6pm)
tail -f /tmp/careerops-scan.log
tail -f /tmp/careerops-scan-error.log

# One-shot retry (created when rate-limit hint fires)
tail -f /tmp/careerops-batch-retry.log
```

### Verify launchd jobs are actually loaded

```bash
launchctl list | grep careerops
```

Should show:
```
-  0  com.careerops.batch
-  0  com.careerops.scan
```

Exit code column: 0 = last run succeeded. Non-zero = failed. PID column: `-` = not currently running.

### Manually trigger a launchd job (for testing)

```bash
launchctl start com.careerops.batch
```

Watch the log:
```bash
tail -f /tmp/careerops-batch.log
```

### Reload a plist after editing

```bash
launchctl unload ~/Library/LaunchAgents/com.careerops.batch.plist
launchctl load ~/Library/LaunchAgents/com.careerops.batch.plist
```

---

## "How do I re-evaluate a specific job?"

There's no clean CLI for this (see PIPELINE.md — "what I'd add if I had more time"). Manual approach:

```bash
# 1. Delete the report + PDF + tracker entry
rm reports/{N}-*.md
rm -rf output/{N}
# Manually remove the tracker row for that ID (open data/applications.md)

# 2. Re-add the URL to batch-input.tsv (or pipeline.md)
echo -e "{new_id}\thttps://job-url\tsource\t" >> batch/batch-input.tsv

# 3. Trigger the batch
./batch/batch-runner.sh
```

---

## "The tracker has duplicate rows for the same company"

Usually happens when a company reposts the same role with a different tracking URL. Run:

```bash
node dedup-tracker.mjs
```

This collapses rows where `(company, role)` matches. Keeps the newest by date, preserves highest score, unions any distinct notes. Idempotent.

---

## "Non-canonical statuses in applications.md"

Statuses should match `templates/states.yml` exactly. Occasionally an LLM writes something like "Applied 2026-06-15" (embedding a date in the status column) or "SQL" (a random token). Fix:

```bash
node normalize-statuses.mjs
```

Maps common variations to canonical values. What it can't fix (like "SQL" appearing as a status), you edit manually — it'll log those.

---

## "Chrome won't launch from CareerOps.app"

### Chrome is already running

The launch script kills any existing `--remote-debugging-port=9222` process first. If Chrome is doing something you care about, save your work before clicking the app icon.

### Chrome binary path

The launcher assumes `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. If you have Chromium or a different Chrome location, edit `launch-chrome.sh:CHROME=`.

### Port 9222 is in use

```bash
lsof -i :9222
```

If something else is using it, kill it or change the CDP port in `launch-chrome.sh` + `fill-agent.mjs`.

---

## "Full pipeline health check"

Runs 190+ tests across the codebase. Two failures are known and acceptable (documented in [ARCHITECTURE.md](ARCHITECTURE.md#testing)):

```bash
node test-all.mjs
```

Expected output:
```
📊 Results: 189 passed, 2 failed
```

Any additional failures should be investigated.

Data-hygiene checks specifically:
```bash
node verify-pipeline.mjs
node dedup-tracker.mjs --dry-run
node normalize-statuses.mjs --dry-run
```

---

## "Where do I put a bug report?"

If it's a bug in this fork specifically, open an issue at [ravitejadureddy/AIAssist-JobSearch](https://github.com/ravitejadureddy/AIAssist-JobSearch/issues). For the upstream project, see [santifer/career-ops](https://github.com/santifer/career-ops).

If it's a security issue, do NOT open a public issue. Email raviteja.dureddy@gmail.com directly.
