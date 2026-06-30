# AIAssist-JobSearch

> **An extensively enhanced fork of [santifer/career-ops](https://github.com/santifer/career-ops).**
> The upstream provides the core CLI/skill framework. This fork adds the dashboard, validation framework, fill-agent reliability layer, and production lifecycle management for a polished daily-use experience.

## Why I built this

Evaluating job openings at scale is a high-context decision problem. Each posting needs to be weighed against your CV, your work-authorization situation, your compensation range, and your career trajectory — and doing that manually for hundreds of roles burns hours that should go into interview prep.

I forked [santifer/career-ops](https://github.com/santifer/career-ops) because the CLI/skill architecture was solid, then built the production layer I wanted for daily use: a live SSE dashboard, a 5-axis semantic CV validator, a resilient Playwright fill agent, and a launchd-driven 24/7 pipeline.

Running it through thousands of evaluations and hundreds of tailored CVs has been a forcing function for reliability — every flaky selector, rate limit, and edge case eventually got fixed.

## Quick Start

Requires: macOS or Linux, Node.js 20+, [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) (or any [open-agent-skill](https://agentskills.io) CLI like Gemini, OpenCode, Qwen, Copilot, Codex).

```bash
git clone https://github.com/ravitejadureddy/AIAssist-JobSearch.git
cd AIAssist-JobSearch
node doctor.mjs        # tells you what's missing
claude                 # opens Claude Code — it walks you through CV, profile, portals interactively
```

After ~10 minutes of guided setup, paste any job URL and get a full evaluation report + tailored PDF in ~60 seconds.

> **Heads-up on visa status:** During onboarding you'll set `visa_status` in `config/profile.yml` (e.g. `"US Citizen"`, `"Green Card"`, `"Requires H-1B sponsorship"`). The job scanner and batch filter read this to gate sponsorship-rejection signals. If your value matches `us citizen` / `green card` / `permanent resident` / `no sponsorship needed` (case-insensitive partial match), sponsorship-rejection filters skip — so you don't lose roles requiring US citizenship. Clearance filters always apply.

For 24/7 automation (daily scans + batch evaluation), see [Setup automation](#setup-automation-optional) below.

## What I built on top of the upstream

The core skill framework comes from santifer. The following are my additions:

### 🧪 Semantic resume validation framework
- 5-axis Claude Haiku validator (jd_alignment / source_fidelity / best_extraction / natural_voice / technical_coherence) that scores every tailored CV against `cv.md`
- Strict source-fidelity check (zero-fabrication enforcement)
- Live validation ticks on the dashboard (✓ / ⚠ + score)
- Auto-backfill on dashboard open + per-PDF auto-trigger hook

### 🎯 Live dashboard with SSE
- Server-Sent Events for real-time tick updates (no page refresh)
- History sort by last-clicked timestamp (sidecar metadata)
- Tier badges (tailored ★ / archetype / generic) with resume-path tooltips
- ↩ Revert button for accidental Applied/Skip clicks
- Auto-trigger validation + PDF backfills on dashboard open

### 🤖 Fill-agent reliability (Playwright + CDP)
- Pause/Resume + manual "🔄 Fill Now" controls in an injected page banner
- URL-poll backstop for SPA transitions (Workday, SuccessFactors) framenavigated misses
- Detection of wrapped ATSes (`gh_jid` query param → Greenhouse routing for sites like Samsara)
- Shared per-page mutex prevents concurrent fillPage calls
- Browser-readback attach verification (compares `files[0]` to intended PDF)

### 🎛️ Production lifecycle management
- SSE-disconnect-based fast shutdown (~3s instead of 30s heartbeat watchdog)
- `start.sh` long-running monitor with signal-trap-based Chrome + server cleanup
- Multi-tab + refresh detection (countdown cancellation on reconnect)

### 🚀 Model strategy on Max plan
- Opus 4.7 for tailored CV generation + cover letters (high-stakes content)
- Haiku 4.5 for evaluation + validation (high-volume judgment)
- Explicit `--model` flags eliminate silent CLI default drift

## Tech stack

**Languages** — JavaScript / Node.js, Python
**Browser automation** — Playwright (CDP), MutationObserver-style URL polling
**Data** — Markdown + JSON sidecars (no DB needed)
**AI** — Anthropic Claude API (Opus 4.7, Haiku 4.5) via Claude Code subprocess pattern
**OS integration** — macOS launchd, AppleScript app wrapper, signal-based process orchestration

## Repository structure

.
├── dashboard-server.mjs       # SSE-based dashboard with live updates
├── fill-agent.mjs             # Playwright fill agent with pause/resume + Fill Now controls
├── smart-apply.mjs            # ATS-specific handlers (Greenhouse / Lever / Ashby / Workday /
├── validate-resume.mjs        # 5-axis Haiku semantic validator
├── backfill-validation.mjs    # Bulk validation for Apply Queue rows
├── queue-eligibility.mjs      # H1B + Apply Queue logic
├── generate-missing-pdfs.mjs  # Opus-powered tailored CV generation
├── start.sh                   # Lifecycle orchestrator (3s clean shutdown)
└── launch-chrome.sh           # Dedicated Chrome with fill-agent profile

## Setup automation (optional)

The system works fine as a manual tool, but you can run portal scans and batch evaluations on a daily schedule.

**macOS (launchd)** — two ready-to-use plist templates in `templates/`:

1. Copy `templates/launchd-batch.plist.example` → `~/Library/LaunchAgents/com.careerops.batch.plist`
2. Copy `templates/launchd-scan.plist.example`  → `~/Library/LaunchAgents/com.careerops.scan.plist`
3. In both files, replace `__PROJECT_DIR__` with your absolute checkout path and `__YOUR_FANTASTIC_JOBS_API_KEY__` with your API key (or remove that block if unused).
4. `launchctl load ~/Library/LaunchAgents/com.careerops.batch.plist`
5. `launchctl load ~/Library/LaunchAgents/com.careerops.scan.plist`

**Linux (cron)** — equivalent:
```
35 4,20 * * * cd /path/to/career-ops && FANTASTIC_JOBS_API_KEY=... /usr/bin/node auto-batch.mjs
 0 18    * * * cd /path/to/career-ops && FANTASTIC_JOBS_API_KEY=... /usr/bin/node scan.mjs && /usr/bin/node auto-batch.mjs
```

API keys and other secrets go in `.env` (copy from `.env.example`). `.env` is gitignored — never committed.

## Credit

Core skill framework and CLI architecture by [Santiago Fernandez (santifer)](https://github.com/santifer/career-ops). Original README preserved at [UPSTREAM_README.md](UPSTREAM_README.md).

This fork is MIT licensed (same as upstream).