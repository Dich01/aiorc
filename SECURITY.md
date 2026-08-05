# Security Policy

## Supported versions

AIOrc is at v0.1 and pre-1.0. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please do not report vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting instead: go to the **Security** tab of this repository and click **Report a vulnerability**. That opens a private channel visible only to the maintainers.

Please include:

- What the issue is and where in the code it lives
- Steps to reproduce, or a proof of concept
- What an attacker could achieve with it

You can expect an initial response within a few days. Since this is a small project maintained in spare time, please allow reasonable time for a fix before any public disclosure.

## Scope

Findings that are especially relevant to AIOrc's threat model:

- **Auth bypass** in JWT middleware (`src/middleware/auth.ts`) or project-key auth (`src/middleware/projectKey.ts`)
- **Cross-tenant data access** — reading or writing another user's or project's agents, skills, contexts, flows or runs
- **Orchestration integrity** — making the engine accept an illegal transition, skip a required step, or exceed invocation caps. The server enforcing the graph is the core guarantee of the product; anything that breaks it is high severity.
- **Audit forgery** — producing a run export that passes HMAC verification but misrepresents what actually ran
- **SSRF** via the MCP gateway's outbound connections to user-configured servers
- **Project API key** leakage or predictability

## Out of scope

- Missing hardening on a deployment you control yourself (no TLS, `JWT_SECRET` left at the development fallback, database file permissions). Deployment configuration is the operator's responsibility — see the README.
- Vulnerabilities in dependencies with no demonstrated exploit path through AIOrc. Please report those upstream.
- Denial of service through sheer volume of requests.
