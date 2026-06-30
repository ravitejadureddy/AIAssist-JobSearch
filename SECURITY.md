# Security Policy

This is a **personal portfolio fork** of [santifer/career-ops](https://github.com/santifer/career-ops). There is no hosted service, no production deployment, and no shared infrastructure — the system runs entirely on a user's local machine.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

- **For issues specific to this fork** (e.g., a bug introduced by my changes): email `raviteja.dureddy@gmail.com`. I'll respond within 72 hours.
- **For issues in the upstream project** (anything inherited from santifer/career-ops): please follow the upstream [Security Policy](https://github.com/santifer/career-ops/blob/main/SECURITY.md) so the fix lands in the actively-maintained codebase and propagates to all forks.

## Scope

In scope for this fork:
- Scripts (`*.mjs`) — command injection, path traversal, SSRF
- Templates — XSS in generated HTML/PDF
- Configuration — secrets exposure, unsafe defaults

Out of scope:
- Issues in third-party dependencies (report to the dependency upstream)
- Issues requiring physical access to the user's machine
- Social engineering
- Anything specific to the user's local data files (they are gitignored — not part of the codebase)
