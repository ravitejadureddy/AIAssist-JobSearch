# User Profile Context -- career-ops

<!-- ============================================================
     THIS FILE IS YOURS. It will NEVER be auto-updated.
     
     Customize everything here: your archetypes, narrative,
     proof points, negotiation scripts, location policy.
     
     The system reads _shared.md (updatable) first, then this
     file (your overrides). Your customizations always win.
     ============================================================ -->

## Your Target Roles

<!-- Replace these with YOUR target roles. Examples:
     - Senior Backend Engineer / Staff Platform Engineer
     - AI Product Manager / Technical PM
     - Data Engineer / ML Engineer
     - DevOps / SRE / Platform
     Whatever you're optimizing for. -->

| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **AI Platform / LLMOps Engineer** | Evaluation, observability, reliability, pipelines | Someone who puts AI in production with metrics |
| **Agentic Workflows / Automation** | HITL, tooling, orchestration, multi-agent | Someone who builds reliable agent systems |
| **Technical AI Product Manager** | GenAI/Agents, PRDs, discovery, delivery | Someone who translates business to AI product |
| **AI Solutions Architect** | Hyperautomation, enterprise, integrations | Someone who designs end-to-end AI architectures |
| **AI Forward Deployed Engineer** | Client-facing, fast delivery, prototyping | Someone who delivers AI solutions to clients fast |
| **AI Transformation Lead** | Change management, adoption, org enablement | Someone who leads AI transformation in an org |

## Your Adaptive Framing

<!-- Map YOUR projects to each archetype. Example:
     | Platform / LLMOps | My monitoring dashboard project | article-digest.md |
     | Agentic | My chatbot with HITL escalation | cv.md section 3 | -->

| If the role is... | Emphasize about you... | Proof point sources |
|-------------------|------------------------|---------------------|
| Platform / LLMOps | Production systems builder, observability, evals | article-digest.md + cv.md |
| Agentic / Automation | Multi-agent orchestration, HITL, reliability | article-digest.md + cv.md |
| Technical AI PM | Product discovery, PRDs, metrics | cv.md + article-digest.md |
| Solutions Architect | System design, integrations, enterprise-ready | article-digest.md + cv.md |
| Forward Deployed Engineer | Fast delivery, client-facing, prototype to prod | cv.md + article-digest.md |
| AI Transformation Lead | Change management, team enablement, adoption | cv.md + article-digest.md |

## Your Exit Narrative

<!-- Replace with YOUR story. This frames everything. -->

Use the candidate's exit story from `config/profile.yml` to frame ALL content:
- **In PDF Summaries:** Bridge from past to future
- **In STAR stories:** Reference proof points from article-digest.md
- **In Draft Answers:** The transition narrative appears in the first response

## Your Cross-cutting Advantage

<!-- What's your "signature move"? What do you do that others can't? -->

Frame profile as **"Technical builder with real-world proof"** that adapts framing to the role.

## Your Portfolio / Demo

<!-- If you have a live demo, dashboard, or public project:
     url: https://yoursite.dev/demo
     password: demo-2026
     when_to_share: "LLMOps, AI Platform roles" -->

If you have a live demo/dashboard (check profile.yml), offer access in applications for relevant roles.

## Your Comp Targets

<!-- Research comp ranges for YOUR target roles -->

**General guidance:**
- Use WebSearch for current market data (Glassdoor, Levels.fyi, Blind)
- Frame by role title, not by skills
- Contractor rates are typically 30-50% higher than employee base

## Your Negotiation Scripts

<!-- Adapt to YOUR situation, currency, location -->

**Salary expectations:**
> "Based on market data for this role, I'm targeting [RANGE from profile.yml]. I'm flexible on structure -- what matters is the total package and the opportunity."

**Geographic discount pushback:**
> "The roles I'm competitive for are output-based, not location-based. My track record doesn't change based on postal code."

**When offered below target:**
> "I'm comparing with opportunities in the [higher range]. I'm drawn to [company] because of [reason]. Can we explore [target]?"

## Your Location Policy

<!-- Adapt to YOUR situation -->

**In forms:**
- Follow your actual availability from profile.yml
- Specify timezone overlap in free-text fields

**In evaluations (scoring):**
- Remote dimension for hybrid outside your country: score **3.0** (not 1.0)
- Only score 1.0 if JD says "must be on-site 4-5 days/week, no exceptions"

## Your CV Format Standards

<!--
Adapt to YOUR situation. The generate-missing-pdfs.mjs tailored-CV worker
reads this section at runtime to validate every generated CV. If you leave
the placeholders unfilled, generated CVs will have no enforced bullet-count
or skills-order constraints — they'll still render, just without the
guardrails described below.
-->

These rules apply to EVERY tailored CV for this candidate. Validate before saving HTML.

### Skills Section Order
Always this exact order:
1. **<Category 1>** — <key items, comma-separated> — ALWAYS FIRST (no JD-based reorder)
2. **<Category 2>** — <key items>
3. **<Category 3>** — <key items>
4. **<Category 4>** — <key items>
<!-- Add 5–8 categories total. Within each category, items may be reordered by JD relevance. Categories themselves never reorder. -->

**Exception (optional):** Define any vertical-specific override here. Example: "For healthcare JDs that mention HL7/FHIR/EDI, 'Healthcare Data' may appear first."

### Per-Employer Minimum Bullet Counts
| Company | Min | Max | Notes |
|---------|-----|-----|-------|
| <Primary / current employer> | 6 | 7 | Never trim — this is your primary role |
| <Second employer> | 4 | 5 |  |
| <Third employer> | 2 | 2 | Always exactly 2 bullets |
<!-- One row per employer that appears in your cv.md. The worker validates bullet counts against these ranges. -->

Never reduce bullets below minimums to save space. If the CV is too long, tighten bullet prose, not bullet count.

### Education Date Format
Always full ranges: "Aug 2018 – Dec 2019". Use en-dash (–), never hyphen. Never year-only.

### Post-Generation Validation Checklist
Before saving generated CV HTML:
- [ ] Skills: first category matches the one defined above
- [ ] Each employer's bullet count is within its declared range
- [ ] Education entries show "Month Year – Month Year" (not bare year)
- [ ] No skills or metrics invented beyond cv.md

Fix any failures before writing the file.
