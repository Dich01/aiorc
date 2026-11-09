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
- **Orchestration integrity** — making the engine accept an illegal transition, complete a step without a schema-valid output, skip a required step or fork branch, advance twice on a retry, or exceed invocation caps. The server enforcing the graph is the core guarantee of the product; anything that breaks it is high severity.
- **Audit forgery** — producing a run export that passes `npm run audit:verify` (Ed25519 signature and hash chain) but misrepresents what actually ran, or changing `run_events` without breaking the chain
- **Snapshot bypass** — making a run execute instructions other than the ones frozen at `workflow.start`
- **SSRF** via the MCP gateway's outbound connections to user-configured servers (DNS resolution, IPv6 and IPv4-mapped forms, redirects, rebinding)
- **Identity spoofing** — a run recorded with a verified caller that did not present that caller's personal access token
- **Project keys and personal tokens** leakage or predictability (both are stored only as SHA-256 hashes)
- **Stored XSS** in the web UI (session tokens live in `localStorage`)
- **Prompt injection that changes what the server records** — content in a diff can mislead the model, which is expected and why findings are advisory; it must not be able to change the flow, the transitions the server decides, or the audit trail

## Out of scope

- Missing hardening on a deployment you control yourself (no TLS, secret or key files readable by other users, `AIORC_GATEWAY_ALLOW_PRIVATE=1` on an exposed instance, open registration). Deployment configuration is the operator's responsibility — see the README.
- A model producing wrong but schema-valid findings. The server does not claim to judge the quality of the work; evals measure it.
- Vulnerabilities in dependencies with no demonstrated exploit path through AIOrc. Please report those upstream.
- Denial of service through sheer volume of requests.
