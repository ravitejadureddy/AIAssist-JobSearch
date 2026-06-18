# Stage 1 — Quick Screen Scoring Template

**Token budget: ~1.5K tokens. Be concise. Score only — no full report.**

Use the JD already in context (do NOT re-fetch). Use the Condensed CV from `_profile.md`.

---

## Step 1 — Hard Gate (check first, stop immediately if triggered)

If JD contains ANY of:
- "no sponsorship" / "will not sponsor" / "no visa sponsorship"
- "US citizens only" / "must be a US citizen" / "U.S. citizen required"
- "must not require sponsorship now or in the future"
- "security clearance required" / "active clearance" / "TS/SCI"
- "green card required" / "permanent resident only"

→ Score = **1.0/5** · Status = **SKIP** · Reason = exact phrase found · STOP.

---

## Step 2 — Score Each Factor (1–5)

**Sponsorship (weight 25%) — use only what the JD states:**
| Situation | Score |
|-----------|-------|
| JD explicitly welcomes H-1B OR known large sponsor (UHG, Humana, CVS, Deloitte, Cognizant, IBM, TCS, Infosys, Wipro, Accenture) | 5.0 |
| JD silent, company sounds enterprise/large — likely can sponsor | 3.0 |
| JD silent, company sounds small startup (<100 employees) | 1.5 |
| JD ambiguous ("sponsorship considered on case-by-case") | 2.5 |

Note: Do NOT run h1bgrader.com / myvisajobs.com lookup at Stage 1 — that happens at Stage 2.

**Skills (weight 30%) — core five: SQL, Python, Snowflake, ETL/ELT, AWS/cloud:**
| Match | Score |
|-------|-------|
| All 5 present | 5.0 |
| 4 of 5 | 4.0 |
| 3 of 5 | 3.0 |
| 2 of 5 | 2.0 |
| 1 or 0 | 1.0 |

**Domain (weight 20%):**
| Domain | Score |
|--------|-------|
| Healthcare / clinical / claims / HL7 / FHIR / ADT | 5.0 |
| Fintech / insurance / regulated data / payments | 4.0 |
| Enterprise SaaS / analytics engineering / BI | 3.5 |
| General tech / cloud-first / data infrastructure | 3.0 |
| AI-only / ML research / gaming / crypto / robotics | 1.5 |

**Seniority (weight 15%):**
| Level | Score |
|-------|-------|
| Senior / Staff / Principal Data Engineer | 5.0 |
| Lead Data Engineer / Analytics Engineer | 4.5 |
| Mid-level / Data Engineer II | 2.0 |
| Junior / new grad | 1.0 |
| Director+ (overqualified) / pure ML | 2.0 |

**Comp (weight 10%) — use posted range if available, else 2.0:**
| Range | Score |
|-------|-------|
| ≥ $180K base | 5.0 |
| $160–179K | 4.0 |
| $140–159K | 3.0 |
| $120–139K or unlisted | 2.0 |
| < $120K | 1.0 |

---

## Step 3 — Compute Final Score

```
Final = (skills × 0.30) + (domain × 0.20) + (seniority × 0.15) + (comp × 0.10) + (sponsorship × 0.25)
```

---

## Step 4 — Output (keep short)

```
Stage 1 Score: X.X/5
Reason: [1–2 sentences — top match signal + top concern]
Decision: PROCEED to Stage 2 / SKIP
```

**PROCEED** if score ≥ 3.0
**SKIP** if score < 3.0 — write to tracker as SKIP with the reason, stop.
