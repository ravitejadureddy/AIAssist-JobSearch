# AIAssist-JobSearch

> **An extensively enhanced fork of [santifer/career-ops](https://github.com/santifer/career-ops).**
> The upstream provides the core CLI/skill framework. This fork adds the dashboard, validation framework, fill-agent reliability layer, and production lifecycle management for a polished daily-use experience.

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

## Credit

Core skill framework and CLI architecture by [Santiago Fernandez (santifer)](https://github.conal README preserved at [UPSTREAM_README.md](UPSTREAM_README.md).

This fork is MIT licensed (same as upstream).