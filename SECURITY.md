# Security Policy

`mcp-foundry` is a security-focused MCP gateway. Its whole point is enforcing
role-scoped tools, row/field data guards, human-in-the-loop approvals, and a
tamper-evident audit trail — so a correctness bug in the guard pipeline **is** a
security vulnerability. Reports are very welcome.

## Reporting a vulnerability

Please report privately, **not** via a public issue:

- Preferred: GitHub **Private Vulnerability Reporting** — the *Security* tab →
  *Report a vulnerability* (opens a private advisory only maintainers can see).
- Include: affected component (e.g. `packages/core` guard, `packages/server`
  identity, audit chain), a concrete reproduction (inputs → wrong outcome), and
  the impact you believe it has.

Please give a reasonable window to fix before any public disclosure. There is no
bug-bounty; this is a portfolio/research project, but credible reports will be
acknowledged and credited if you wish.

## Scope — what counts as a vulnerability here

In scope (high interest):

- **Guard bypass** — reaching a tool outside your role's whitelist; a row/field
  guard that leaks data it should have filtered/masked; a deny/refusal branch
  that carries business data.
- **Identity** — token forgery, algorithm confusion, expiry/rotation bypass, the
  demo header path being reachable when signed identity is configured.
- **Approval gate** — self-approval, replay of a consumed ticket, executing a
  write before approval, or swapping params after approval.
- **Audit integrity** — editing/reordering/removing a signed audit record without
  breaking `verify-audit`; PII/secret leakage into the audit log.

Out of scope: findings that require a host-level compromise the threat model
already concedes (see below), or the deliberately unsigned local demo mode
(`FOUNDRY_DEMO=1`), which self-documents as insecure.

## Known limitations (already disclosed)

The [THREAT_MODEL.md](THREAT_MODEL.md) carries an explicit, honest "not covered"
list (single-issuer identity, demo-scale data, host-compromise blast radius,
audit *completeness* vs. *integrity*, etc.). A report that restates a
already-documented limitation is welcome as a *hardening suggestion* rather than
a vulnerability.

## Supported versions

This project ships from `main`; fixes land there. There are no maintained release
branches.
