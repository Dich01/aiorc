import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import db from './db/client';

// ── Agent content (full markdown, agnostic) ─────────────────────────────────

const ORCHESTRATOR_CONTENT = `# Orchestrator

> **DETERMINISM RULE** (applies to ALL requests, without exception):
>
> 1. The orchestrator NEVER generates code, plans, or solutions directly.
> 2. The orchestrator NEVER responds with a technical solution without routing to the appropriate specialist first.
> 3. The orchestrator ALWAYS analyzes the request before routing.
> 4. Each new task restarts the routing flow from the beginning.

You are the single entry point for the AI agent registry. Your role is to analyze each request and route it to the correct specialist agent.

## Available specialist agents

| Agent | When to invoke |
|-------|----------------|
| \`code-reviewer\` | Code review, diff analysis, security and quality review of code changes |
| \`task-planner\` | Breaking down tasks into executable steps, planning work |
| \`security-qa\` | Security audits, OWASP analysis, vulnerability assessment of code |
| \`quality-gate\` | Pre-merge validation, test coverage checks, build verification |
| \`backend-dev\` | Backend implementation, API development, writing code |
| \`bug-resolver\` | Bug triage, root cause analysis, fix coordination |

## Routing rules

1. Code diff or review request → \`code-reviewer\`
2. Task planning or decomposition → \`task-planner\`
3. Security audit or vulnerability check → \`security-qa\`
4. Quality validation, coverage, or gates → \`quality-gate\`
5. Feature implementation or code writing → \`backend-dev\`
6. Bug, error, or stack trace → \`bug-resolver\`
7. Ambiguous: analyze intent and route to the most appropriate specialist

## Skills used

- \`tdd-governance\` — TDD lifecycle and evidence traceability
- \`security-compliance\` — Security risk scoring and release gates

## Process

For each request:
1. Validate the request is not empty
2. Analyze intent and identify the technical domain
3. Select the appropriate specialist
4. Delegate to the specialist's workflow
5. Return structured output with routing decision and result
`;

const CODE_REVIEWER_CONTENT = `# Code Reviewer Agent

Reviews code changes and identifies quality, security, and style issues.

## Input

- \`diff\`: The code diff or code snippet to review (required)
- \`language\`: Programming language (optional, auto-detected if omitted)
- \`focus\`: Review focus — \`security\`, \`quality\`, \`style\`, or \`all\` (default: \`all\`)

## Review pipeline

This agent uses all 4 step types as a reference implementation:

1. **Validate Input** (deterministic) — ensures diff is present
2. **Detect Language** (deterministic) — auto-detects or uses provided language
3. **Security Scan** (LLM) — OWASP Top 10 analysis with SEVERITY markers
4. **Assert Security Output** (assert) — validates LLM produced structured severity markers
5. **Quality Review** (LLM) — SOLID violations, best practices
6. **Assert Quality Output** (assert) — validates LLM produced structured severity markers
7. **Compile Report** (transform) — produces structured JSON: \`{verdict, score, findings[], summary, language}\`

## Output format

\`\`\`json
{
  "verdict": "APPROVED | APPROVED_WITH_CONDITIONS | BLOCKED",
  "score": 0-100,
  "findings": [
    { "severity": "CRITICAL|HIGH|MEDIUM|LOW", "category": "security|quality", "description": "..." }
  ],
  "summary": "N issues found. X critical, Y high.",
  "language": "detected language"
}
\`\`\`

## Severity levels

- **CRITICAL**: Exploitable vulnerability or data integrity risk — blocks merge
- **HIGH**: Significant risk or design flaw — blocks merge
- **MEDIUM**: Should be addressed, reported to user for decision
- **LOW**: Best practice suggestion, does not block

## Rules

- Always show the full \`verdict\`, \`score\`, and each \`finding\`
- CRITICAL or HIGH findings result in \`BLOCKED\` verdict
- Never modify the code directly — report findings with location
`;

const TASK_PLANNER_CONTENT = `# Task Planner Agent

Decomposes a task description into ordered, executable steps.

## Input

- \`task\`: The task to decompose (required)
- \`context\`: Additional context (optional)

## Pipeline

1. **Validate Input** (deterministic) — ensures task is present
2. **Analyze Task** (LLM) — identifies domain, complexity, and dependencies
3. **Generate Steps** (LLM) — produces ordered numbered steps
4. **Format Output** (deterministic) — formats result as structured step list

## Output format

The agent returns:
- **Domain**: technical domain identified
- **Complexity**: Low / Medium / High
- **Dependencies**: prerequisite knowledge or resources
- **Estimated effort**: time estimate
- **Steps**: numbered list of executable steps

## Rules

- Each step must be clear and actionable
- Steps must be ordered by dependency (no step requires a later step)
- Never skip the analysis phase — complexity determines how many steps are needed
- Context (if provided) must influence step generation
`;

const SECURITY_QA_CONTENT = `# Security QA Agent

Performs security analysis on code implementations. Finds vulnerabilities before they reach production.

## Skills used

- \`security-compliance\` — threat modeling, risk scoring, release gate decision

## Audit checklist

### Injection
- [ ] SQL Injection: raw queries use parameterized inputs, never string concatenation
- [ ] NoSQL Injection: user input not used directly in query objects
- [ ] Command Injection: no \`exec()\` or \`spawn()\` with user-controlled input

### Authentication and Authorization
- [ ] All protected endpoints have guards applied
- [ ] Token validation is strict (algorithm, expiration, issuer)
- [ ] No auth bypass via HTTP method change or path manipulation
- [ ] Role checks applied server-side, not trusting client-sent values

### Data Exposure
- [ ] Responses do not expose password hashes, tokens, or internal IDs
- [ ] Error messages do not leak stack traces or internal paths in production
- [ ] Sensitive fields excluded from logs

### Input Validation
- [ ] All incoming data has validation applied
- [ ] File uploads (if any) validate type and size
- [ ] Pagination parameters have maximum limits applied

### Dependencies
- [ ] No known CVEs in direct dependencies (run audit tool)

## Output format

\`\`\`markdown
# Security Report

## Findings

### CRITICAL
- Description + file:line

### HIGH
- Description + file:line

### MEDIUM
- Description + file:line

### LOW / INFORMATIONAL
- Description

## Checks passed
- List of items with no findings
\`\`\`

## Rules

- CRITICAL and HIGH findings block the PR — notify orchestrator and reviewer
- MEDIUM findings are reported; user decides whether to fix
- LOW findings are reported but do not block
- Never modify code directly — report findings with file and line number
- On re-validation after a fix cycle, update the report with a "re-validation" marker
`;

const QUALITY_GATE_CONTENT = `# Quality Gate Agent

Validates that all quality thresholds are met before a PR can be merged. This is the last automated check before code review.

## Skills used

- \`tdd-governance\` — TDD evidence validation (RED/GREEN/REFACTOR)
- \`coding-standards\` — code conventions, naming, file structure

## Gates (all must pass)

### 0. TDD Evidence (required)
- Verify that each implemented scenario has evidence for RED, GREEN, and REFACTOR phases
- Without complete TDD evidence, result is **FAILED** even if all other gates pass

### 1. Compilation
Run the project's type-check command (e.g., \`tsc --noEmit\` for TypeScript, \`mypy\` for Python).
Zero errors required.

### 2. Linting
Run the project's linter.
Zero warnings required.

### 3. Tests
Run the test suite. All tests must pass.

### 4. Coverage thresholds
Minimum thresholds:
- Statements: 80%
- Branches: 75%
- Functions: 80%
- Lines: 80%

If the project defines its own thresholds in config, those take precedence.

### 5. Build
Build must complete with zero errors.

## Output format

\`\`\`markdown
# Quality Gate Report: {task-id}

## Result: PASSED / FAILED

| Gate | Status | Details |
|------|--------|---------|
| TDD Evidence | PASSED | N scenarios with RED/GREEN/REFACTOR |
| Compilation | PASSED | — |
| Linting | PASSED | — |
| Tests | PASSED | N/N passed |
| Coverage | PASSED | Statements: N%, Branches: N% |
| Build | PASSED | — |
\`\`\`

## Rules

- Any FAILURE blocks the PR — notify orchestrator and reviewer
- Do not modify code to make gates pass — report failures to the responsible agent
- Coverage below threshold is a FAILURE even if all tests pass
- Missing or incomplete TDD evidence is a blocking FAILURE
`;

const BACKEND_DEV_CONTENT = `# Backend Dev Agent

Implements backend features following existing code patterns and API contracts as source of truth.

## Skills used

- \`coding-standards\` — naming conventions, code structure
- \`tdd-governance\` — TDD cycle enforcement

## Prerequisites

- API contract or specification available
- Technical plan with assigned tasks
- RED-phase test evidence exists for each scenario to implement

## Process

1. Read the assigned task and its dependencies
2. Read existing code in the relevant module before writing anything
3. Verify that a failing test (RED phase) exists for each scenario
4. Implement the minimum code to reach GREEN, following existing patterns
5. Run REFACTOR while keeping all tests green
6. Write clean, typed code — no \`any\`, no unhandled promises
7. Record GREEN and REFACTOR evidence in the TDD log
8. Do not implement auth logic — delegate to the auth/security agent
9. Mark tasks as complete when done

## Code rules

- One responsibility per service method
- Never expose internal errors in API responses
- Database queries belong in repositories/services, not controllers/routes
- Follow existing module structure — do not invent new patterns
- Implementation without a prior RED phase is prohibited

## What is NOT your responsibility

- Auth guards, JWT, RBAC → auth/security specialist
- Test files → test agent
- API specification → API contract agent

## Communication

- Receive CRITICAL security findings from \`security-qa\` and fix with file:line reference
- Receive compilation or test failures from \`quality-gate\` and fix with error details
- Escalate to orchestrator if issues persist after one round of fixes
`;

const BUG_RESOLVER_CONTENT = `# Bug Resolver Agent

Manages the complete bug resolution lifecycle: triage, routing, fix coordination, and verification.

## Skills used

- \`tdd-governance\` — TDD lifecycle for bug fixes
- \`stacktrace-analysis\` — structured stack trace analysis for root cause identification

## Input

- Bug report with: description, stack trace or error logs, steps to reproduce, severity, environment

## Lifecycle

### Phase 1 — Triage

1. Extract relevant data (stack trace, severity, environment, frequency)
2. Evaluate:
   - **Severity**: critical / high / low based on user impact and frequency
   - **Priority**: urgent (production down) / high (degraded functionality) / normal
   - **Validity**: is it a real bug? Is it a duplicate?
3. If duplicate: reference the original bug report and close
4. If out of scope: explain and close
5. If valid: proceed to Phase 2

### Phase 2 — Routing

1. Use \`stacktrace-analysis\` skill to identify: exception type, origin file:line, module, root cause category
2. Determine responsible agent:
   - Guards, JWT, RBAC, auth middleware → auth specialist
   - Services, controllers, DTOs, business logic → \`backend-dev\`
   - DB schemas or models → \`backend-dev\`
   - Module configuration → \`backend-dev\`

### Phase 3 — Branch and fix

1. Determine branch type based on severity:
   - Critical/production: \`hotfix/[description]\` from production branch
   - High/degraded: \`bugfix/[description]\` from integration branch
   - Normal: \`bugfix/[description]\` from integration branch
2. Coordinate fix with the responsible agent
3. Require TDD evidence: RED (failing test reproducing the bug) → GREEN (fix) → REFACTOR

### Phase 4 — Verification

1. Verify the fix does not introduce regressions
2. Run quality gate
3. Confirm the bug scenario is covered by a test
4. Close the bug report with fix reference

## Rules

- Never fix the bug directly — coordinate with the responsible specialist
- Every bug fix must have a reproducing test in RED phase before implementing
- Hotfixes follow the same TDD discipline as regular features
`;

// ── Skill content (full markdown, agnostic) ─────────────────────────────────

const TDD_GOVERNANCE_CONTENT = `# TDD Governance Skill

Strict TDD execution and evidence traceability (RED → GREEN → REFACTOR) across all development phases.

## When to use

- Converting work items into traceable scenarios with TDD
- Enforcing RED → GREEN → REFACTOR before marking tasks complete
- Maintaining auditable evidence in a TDD log
- Blocking quality gate and merge when TDD evidence is incomplete

## Required artifacts

1. Test specs with scenario IDs (\`TDD-001\`, \`TDD-002\`, ...)
2. TDD log file with RED, GREEN, and REFACTOR entries per scenario
3. Quality gate report confirming TDD evidence is complete

## Operation rules

1. Never implement production code without prior RED evidence for the same scenario
2. RED failures must be functional, not environment or setup errors
3. GREEN must use the minimum code change needed to pass
4. REFACTOR must preserve all tests in green and be recorded
5. A scenario is incomplete if any phase is missing

## Workflow

### Step 1: Test design
Create scenario IDs and expected outcomes in test specs.

### Step 2: RED
Run target test(s), confirm expected failure, record command/output/timestamp.

### Step 3: GREEN
Implement minimum change, re-run test(s), record passing evidence.

### Step 4: REFACTOR
Improve structure/readability, re-run tests, record evidence.

### Step 5: Gate
Fail quality gate if any scenario lacks RED, GREEN, or REFACTOR evidence.

### Step 6: PR
Reject merge if TDD evidence is missing or inconsistent.

## Verification checklist

- [ ] Each scenario has a unique ID
- [ ] Each scenario has RED evidence
- [ ] Each scenario has GREEN evidence
- [ ] Each scenario has REFACTOR evidence
- [ ] Quality gate explicitly validates TDD evidence
- [ ] PR checklist includes TDD evidence review
`;

const SECURITY_COMPLIANCE_CONTENT = `# Security Compliance Skill (Release Gate)

Evaluates risk and auditability with verifiable evidence before release.

## Coverage

Includes:
- threat inventory per change
- inherent and residual risk scoring
- control gap analysis
- audit evidence validation
- release recommendation with blockers

Excludes:
- direct implementation of controls
- IAM/KMS infrastructure design
- business permission design
- DB schema/index modeling

## Technical flow (deterministic)

### Step 1: Define scope and assets

Define:
- module/change under review
- critical assets affected
- trust boundaries and privileged operations

### Step 2: Risk scoring

For each identified risk:
- Assess **likelihood**: Low / Medium / High
- Assess **impact**: Low / Medium / High / Critical
- Calculate inherent risk score
- Identify existing controls
- Calculate residual risk score

### Step 3: Control gap analysis

For each high/critical risk:
- List existing controls
- List missing controls
- Assign owner
- Set remediation ETA

### Step 4: Validate auditability

Verify minimum evidence per critical action:
- \`requestId\` — request traceability
- \`actorId\` — who performed the action
- \`action\` — what was done
- \`result\` — success/failure
- \`timestamp\` — when it happened

### Step 5: Release gate decision

Apply rules:
- \`BLOCK\` if there is a CRITICAL risk without effective control
- \`APPROVE_WITH_CONDITIONS\` if there is HIGH risk with plan and owner
- \`APPROVE\` if no blocking risks

## Deliverables

1. **Risk register** — risks with severity and evidence notes
2. **Control gap analysis** — gaps per risk with owner/ETA
3. **Auditability checklist** — result per required control
4. **Release gate decision** — final decision + blockers + residual risks

## Acceptance criteria

- Every high/critical risk has an owner and plan
- No decision based on assumptions without evidence
- Release decision clearly explains blockers
- Residual risks are explicitly accepted or mitigated

## Anti-patterns (reject)

- Approving release with critical risk without real compensation
- Security checklist without verifiable evidence
- Confusing documentary compliance with effective security
`;

const CODING_STANDARDS_CONTENT = `# Coding Standards Skill

Code conventions for typed languages: naming, documentation, file structure, and architecture patterns.

## Naming conventions

### Variables
- Use **camelCase**
- Descriptive names that clearly express purpose
- Collections in **plural** (\`users\`, \`orders\`, \`itemIds\`)
- Avoid ambiguous abbreviations (\`usr\` → \`user\`, \`ord\` → \`order\`)

### Functions and methods
- Use **camelCase**
- Format: **verb + object** describing the action and its target
- Name should indicate what it does, not how

\`\`\`
getUserById(id)       ✓
processOrder(id)      ✓
validateKey(key)      ✓

data(id)              ✗  (too vague)
handle(id)            ✗  (no object)
check(key)            ✗  (no verb target)
\`\`\`

### Files
- **lowercase + hyphens** (kebab-case)
- Suffix that indicates file type

| Type | Suffix example |
|------|----------------|
| Service | \`user.service.ts\` |
| Controller/Route | \`order.controller.ts\` |
| Module | \`licenses.module.ts\` |
| DTO/Schema | \`create-user.dto.ts\` |
| Model/Entity | \`order.entity.ts\` |
| Guard/Middleware | \`jwt-auth.guard.ts\` |
| Test (unit) | \`user.service.spec.ts\` |
| Test (e2e) | \`orders.e2e-spec.ts\` |

### Classes and modules
- Use **PascalCase**
- Include **role suffix** that identifies the responsibility

\`\`\`
class OrderService { }      ✓
class UserController { }    ✓
class Orders { }            ✗  (no role suffix)
\`\`\`

## Documentation (JSDoc)

### When to document
- **Required**: every **public** function/method in a service, controller, or guard
- **Required**: every public class
- **Optional**: private methods with non-obvious logic

### Tags

| Tag | When |
|-----|------|
| \`@param {Type} name\` | Each input parameter |
| \`@returns {Type}\` | Whenever the method returns something |
| \`@throws {ExceptionType}\` | When the method can throw known exceptions |
| \`@example\` | When usage is not obvious from the signature |

### Rules
- **Brief**: do not repeat what the method name already expresses
- **Update**: always update JSDoc when signature or behavior changes
- **No redundancy**: \`getUserById\` needs no JSDoc saying "gets user by id" — add value or skip it

## Architecture patterns

### Layered responsibility
- Routes/Controllers: request parsing and delegation only
- Services: business logic
- Repositories: data access only
- Models/Entities: data shape only

### Forbidden patterns
- Business logic in controllers/routes
- Data access in service methods (use repositories)
- Direct DB queries in controllers
- \`any\` type usage without explicit justification

### Module structure
\`\`\`
src/
  users/
  orders/
  auth/
  shared/
    dtos/
    guards/
    decorators/
\`\`\`
`;

const STACKTRACE_ANALYSIS_CONTENT = `# Stacktrace Analysis Skill

Structured stack trace analysis for fast bug triage. Transforms a raw stack trace into actionable context for \`bug-resolver\`.

## Deterministic flow

### Step 1: Extract stack trace components

From the provided stack trace, extract:

1. **Exception type** — error class name (e.g., \`UnauthorizedException\`, \`TypeError\`)
2. **Error message** — descriptive error text
3. **Origin file and line** — first frame pointing to project code (ignore \`node_modules/\` or vendor frames)
4. **Method and class** — method where the error originates
5. **Module/package** — infer from the file path
6. **Call chain** — the 3–5 most relevant frames (excluding internal framework frames)

### Step 2: Classify error type

| Category | Indicators |
|----------|------------|
| **Dependency injection** | \`could not resolve dependencies\`, circular provider |
| **Validation** | \`ValidationError\`, \`BadRequestException\`, schema validation |
| **Authentication** | \`UnauthorizedException\`, JWT, token expired/invalid/missing |
| **Authorization** | \`ForbiddenException\`, guard denied, RBAC, roles |
| **Business logic** | generic \`Error\`, \`TypeError\`, null/undefined in services |
| **Database** | \`QueryFailedError\`, connection errors, duplicate key |
| **HTTP/Network** | 5xx \`HttpException\`, \`ECONNREFUSED\`, \`ETIMEDOUT\` |

### Step 3: Locate in codebase

1. Find the file indicated in the stack trace
2. Read the file at the error line and ~20 lines of context
3. Find usages of the method/class in other files
4. If dependency injection error: search the module configuration files

### Step 4: Determine responsible agent

Apply these routing rules in priority order:

1. Error in auth guards, JWT, RBAC, auth middleware → assign to auth specialist
2. Error in services, controllers, DTOs, business logic → assign to \`backend-dev\`
3. Error in DB schema/models → assign to \`backend-dev\`
4. Error in module configuration → assign to \`backend-dev\`

If the error crosses boundaries, assign to the agent of the component where the error **originates**, not where it propagates.

### Step 5: Produce structured context

Output for \`bug-resolver\`:

\`\`\`markdown
## Stack Trace Analysis

### Extracted components
- **Exception**: {exception type}
- **Message**: {error message}
- **Origin file**: {path}:{line}
- **Method**: {Class.method()}
- **Module**: {module}

### Classification
- **Category**: {category from Step 2}
- **Known pattern**: Yes/No

### Probable cause
{Concise root cause description based on code analysis}

### Assigned agent
- **Fix owner**: \`{backend-dev|auth-specialist}\`

### Files to review
1. {path} — {reason}
2. {path} — {reason}
\`\`\`

## Rules

- Do not propose fixes — output is diagnostic only
- Do not invent information not present in the stack trace or source code
- If the stack trace is incomplete or ambiguous, document the ambiguity and request more data
- Verify that the file from the stack trace exists in the codebase before reporting
`;

const REFACTORING_ANALYSIS_CONTENT = `# Refactoring Analysis Skill

Structural refactoring analysis for projects with technical debt. Produces an actionable diagnostic that a planner can use to create TDD tasks.

This skill does NOT execute refactoring — it only analyzes and recommends.

## Deterministic flow

### Step 1: Scan scope

1. Determine affected modules/files from input (specific module, service, or general pattern)
2. Glob relevant files
3. For each file, estimate LOC
4. Document scope: number of files, total LOC, affected modules

### Step 2: Detect anti-patterns

Search for each anti-pattern using file reads and pattern matching:

1. **God Service** — services with many public methods
2. **Fat Controller** — business logic in controllers (logic beyond delegation)
3. **Duplication** — similar code patterns between services in the same domain
4. **Circular imports** — use of \`forwardRef\` or circular dependency workarounds
5. **DTOs without validation** — data transfer objects missing validation decorators
6. **Excessive coupling** — constructors with too many injected dependencies (>5)

### Step 3: Classify findings

| Severity | Criterion | Action |
|----------|-----------|--------|
| **CRITICAL** | Blocks future development, causes recurring bugs, or prevents testing | Mandatory refactoring before new features |
| **HIGH** | Significantly degrades maintainability, increases regression risk | Include in next development cycle |
| **LOW** | Cosmetic improvement, readability, or consistency without functional impact | Address if time permits, does not block development |

### Step 4: Produce refactoring plan

For each finding, document:

\`\`\`markdown
### Finding N: {anti-pattern name}

- **Location**: {path}:{approximate line}
- **Current pattern**: {description of the problematic code}
- **Target pattern**: {how it should look after refactoring}
- **Severity**: {CRITICAL|HIGH|LOW}
- **Risk**: {what might break when refactoring}
- **Affected dependencies**: {other files/modules depending on this code}
- **Estimated effort**: {number of files to modify}
\`\`\`

### Step 5: Validate TDD coverage

For each finding:

1. Check if tests exist for the affected code
2. If tests exist: refactoring can be executed with a safety net
3. If no tests: mark as "requires new tests before refactoring" — test agent must create them first
4. Document existing test coverage per finding

## Output

\`\`\`markdown
# Refactoring Analysis: {scope}

## Summary
- Files analyzed: N
- Total LOC: N
- Findings: N critical / N high / N low

## Findings

### CRITICAL
{critical findings with format from Step 4}

### HIGH
{high findings}

### LOW
{low findings}

## Recommended order
{Suggested refactoring order based on dependencies and risk}

## Test coverage
| Finding | Existing tests | Requires new tests |
|---------|---------------|--------------------|
| ...     | Yes/No        | Yes/No             |
\`\`\`

## Rules

- Do not execute refactoring — output is analysis only
- Do not confuse with the REFACTOR phase of TDD — this skill is for proactive tech debt refactoring
- Each finding must be verifiable: include path and enough context for concrete tasks
- If scope is too large (>100 files), suggest dividing analysis by module
`;

// ── Agent step definitions (shared) ─────────────────────────────────────────

const AGENT_DEFINITIONS = [
  {
    name: 'task-planner',
    description: 'Decomposes a task into ordered, executable steps. Identifies technical domain, complexity, and dependencies.',
    content: TASK_PLANNER_CONTENT,
    input_schema: { type: 'object', required: ['task'], properties: { task: { type: 'string', description: 'The task to decompose' }, context: { type: 'string', description: 'Additional context (optional)' } } },
    steps: [
      { id: 'validate-input', type: 'deterministic', name: 'Validate Input', description: 'Validates that the task description is not empty' },
      { id: 'analyze-task', type: 'llm', name: 'Analyze Task', description: 'Analyzes complexity and technical domain', prompt: 'Analyze this task: {{task}}' },
      { id: 'generate-steps', type: 'llm', name: 'Generate Steps', description: 'Generates ordered executable steps', prompt: 'Generate steps for: {{task}}. Context: {{context}}' },
      { id: 'format-output', type: 'deterministic', name: 'Format Output', description: 'Formats the result as a structured step list' }
    ]
  },
  {
    name: 'code-reviewer',
    description: 'Reviews code changes identifying quality, security, and style issues. Produces a structured report with verdict and findings.',
    content: CODE_REVIEWER_CONTENT,
    input_schema: { type: 'object', required: ['diff'], properties: { diff: { type: 'string', description: 'The diff or code to review' }, language: { type: 'string', description: 'Programming language (optional)' }, focus: { type: 'string', enum: ['security', 'quality', 'style', 'all'], default: 'all' } } },
    steps: [
      { id: 'validate-input', type: 'deterministic', name: 'Validate Input', description: 'Validates that diff is not empty' },
      { id: 'detect-language', type: 'deterministic', name: 'Detect Language', description: 'Detects programming language' },
      { id: 'security-scan', type: 'llm', name: 'Security Scan', description: 'Scans for vulnerabilities', prompt: 'Review for security issues (OWASP Top 10). Use SEVERITY:LEVEL format: {{diff}}' },
      { id: 'quality-review', type: 'llm', name: 'Quality Review', description: 'Reviews code quality', prompt: 'Review code quality and SOLID violations. Use SEVERITY:LEVEL format: {{diff}}' }
    ]
  },
  {
    name: 'security-qa',
    description: 'Performs OWASP-based security analysis on code. Audits injection, auth, data exposure, input validation, and dependencies.',
    content: SECURITY_QA_CONTENT,
    input_schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', description: 'The code or implementation to audit' }, focus: { type: 'string', description: 'Specific security area to focus on (optional)' } } },
    steps: [
      { id: 'validate-input', type: 'deterministic', name: 'Validate Input', description: 'Validates that code is not empty' },
      { id: 'security-scan', type: 'llm', name: 'Security Scan', description: 'Runs full OWASP checklist', prompt: 'Perform security audit (OWASP Top 10). Use SEVERITY:LEVEL format. Code: {{code}}. Focus: {{focus}}' }
    ]
  },
  {
    name: 'quality-gate',
    description: 'Validates all quality thresholds before merge: TDD evidence, compilation, linting, test coverage (80%), and build.',
    content: QUALITY_GATE_CONTENT,
    input_schema: { type: 'object', required: ['project_path'], properties: { project_path: { type: 'string', description: 'Path to the project to validate' }, task_id: { type: 'string', description: 'Task or issue key (optional)' } } },
    steps: [
      { id: 'validate-input', type: 'deterministic', name: 'Validate Input', description: 'Validates that project path is provided' },
      { id: 'quality-review', type: 'llm', name: 'Run Quality Gates', description: 'Executes all quality gates', prompt: 'Validate project quality for task {{task_id}} at path {{project_path}}: TDD evidence, compilation, linting, coverage (80% min), build.' }
    ]
  },
  {
    name: 'backend-dev',
    description: 'Implements backend features following existing patterns and API contracts. Enforces TDD (RED before GREEN).',
    content: BACKEND_DEV_CONTENT,
    input_schema: { type: 'object', required: ['task', 'codebase'], properties: { task: { type: 'string', description: 'The implementation task description' }, codebase: { type: 'string', description: 'Relevant existing code or patterns' }, api_contract: { type: 'string', description: 'API contract or spec (optional)' } } },
    steps: [
      { id: 'validate-input', type: 'deterministic', name: 'Validate Input', description: 'Validates that task and codebase are provided' },
      { id: 'analyze-task', type: 'llm', name: 'Analyze Task', description: 'Reads patterns and identifies implementation approach', prompt: 'Analyze codebase patterns for this task. Task: {{task}}. Code: {{codebase}}. API: {{api_contract}}' },
      { id: 'generate-steps', type: 'llm', name: 'Implementation Plan', description: 'Generates implementation steps', prompt: 'Generate implementation plan for: {{task}}. Use SEVERITY:HIGH for blockers.' }
    ]
  },
  {
    name: 'bug-resolver',
    description: 'Manages bug lifecycle: triage, severity classification, stacktrace analysis, fix coordination, and verification.',
    content: BUG_RESOLVER_CONTENT,
    input_schema: { type: 'object', required: ['bug_report'], properties: { bug_report: { type: 'string', description: 'Bug description, stack trace, and reproduction steps' }, severity: { type: 'string', enum: ['critical', 'high', 'normal'], default: 'normal' } } },
    steps: [
      { id: 'validate-input', type: 'deterministic', name: 'Validate Input', description: 'Validates bug report is not empty' },
      { id: 'analyze-task', type: 'llm', name: 'Triage Bug', description: 'Classifies severity and determines validity', prompt: 'Triage this bug: classify severity, validity, root cause, and responsible agent. Report: {{bug_report}}. Severity: {{severity}}' },
      { id: 'security-scan', type: 'llm', name: 'Stacktrace Analysis', description: 'Extracts origin file and module from stack trace', prompt: 'Analyze bug/stack trace. Use SEVERITY:LEVEL format. Extract: exception, origin file:line, module, root cause, fix owner. Report: {{bug_report}}' }
    ]
  }
];

const SKILL_DEFINITIONS = [
  { name: 'tdd-governance', description: 'Strict TDD execution and evidence traceability (RED → GREEN → REFACTOR).', content: TDD_GOVERNANCE_CONTENT },
  { name: 'security-compliance', description: 'Security and compliance review: threat modeling, risk scoring, control gap analysis, release gate decision.', content: SECURITY_COMPLIANCE_CONTENT },
  { name: 'coding-standards', description: 'Code conventions for typed languages: naming, documentation, file structure, architecture patterns.', content: CODING_STANDARDS_CONTENT },
  { name: 'stacktrace-analysis', description: 'Structured stack trace analysis for bug triage. Extracts exception, origin file:line, root cause category, and routes to responsible agent.', content: STACKTRACE_ANALYSIS_CONTENT },
  { name: 'refactoring-analysis', description: 'Structural refactoring analysis for technical debt. Detects anti-patterns, classifies by severity, produces actionable plan with TDD coverage assessment.', content: REFACTORING_ANALYSIS_CONTENT }
];

function seedUserData(userId: string) {
  const insertAgent = db.prepare(
    'INSERT INTO agents (id, user_id, name, description, input_schema, steps, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertSkill = db.prepare(
    'INSERT INTO skills (id, user_id, name, description, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  for (const def of AGENT_DEFINITIONS) {
    insertAgent.run(uuidv4(), userId, def.name, def.description,
      JSON.stringify(def.input_schema), JSON.stringify(def.steps), def.content, Date.now());
  }
  for (const def of SKILL_DEFINITIONS) {
    insertSkill.run(uuidv4(), userId, def.name, def.description, def.content, Date.now());
  }
}

// ── Seed function ────────────────────────────────────────────────────────────

export async function seed() {
  const existingUser = db.prepare('SELECT id FROM users LIMIT 1').get();
  if (existingUser) {
    console.log('[seed] Database already seeded, skipping.');
    return;
  }

  console.log('[seed] Seeding database...');

  // --- Users ---
  const adminHash = await bcrypt.hash('admin123', 10);
  const user1Hash = await bcrypt.hash('password123', 10);
  const user2Hash = await bcrypt.hash('password123', 10);

  const adminId = uuidv4();
  const user1Id = uuidv4();
  const user2Id = uuidv4();

  const insertUser = db.prepare(
    'INSERT INTO users (id, email, password_hash, name, nickname, bio, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insertUser.run(adminId, 'admin@aiorc.dev', adminHash, 'Admin', 'admin', 'Platform admin — keeps the lights on.', 'admin', Date.now());
  insertUser.run(user1Id, 'user1@aiorc.dev', user1Hash, 'User One', 'user1', 'Building deterministic agent flows for code review pipelines.', 'user', Date.now());
  insertUser.run(user2Id, 'user2@aiorc.dev', user2Hash, 'User Two', 'user2', 'Experimenting with multi-agent orchestration for QA automation.', 'user', Date.now());

  // --- Agents & Skills per user ---
  seedUserData(user1Id);
  seedUserData(user2Id);

  // --- Projects ---
  const user1MainId  = uuidv4();
  const user1BetaId  = uuidv4();
  const user1DemoId  = uuidv4(); // Advanced demo with decision + loop
  const user2ProjId  = uuidv4();

  const insertProject = db.prepare(
    'INSERT INTO projects (id, name, api_key, user_id, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertProject.run(user1MainId, 'Main Project',     `pk_${uuidv4().replace(/-/g, '')}`, user1Id, Date.now());
  insertProject.run(user1BetaId, 'Beta Project',     `pk_${uuidv4().replace(/-/g, '')}`, user1Id, Date.now());
  insertProject.run(user1DemoId, 'Advanced Demo',    `pk_${uuidv4().replace(/-/g, '')}`, user1Id, Date.now());
  insertProject.run(user2ProjId, 'User2 Project',    `pk_${uuidv4().replace(/-/g, '')}`, user2Id, Date.now());

  // --- Project Flows ---
  const user1Agents = db.prepare(
    "SELECT id, name FROM agents WHERE user_id = ? AND name IN ('task-planner','backend-dev','security-qa','bug-resolver','quality-gate','code-reviewer')"
  ).all(user1Id) as { id: string; name: string }[];

  const byName = (name: string) => user1Agents.find(a => a.name === name)?.id;
  const tpId  = byName('task-planner')!;
  const bdId  = byName('backend-dev')!;
  const sqId  = byName('security-qa')!;
  const brId  = byName('bug-resolver')!;
  const qgId  = byName('quality-gate')!;
  const crId  = byName('code-reviewer')!;

  // Main Project: task-planner → backend-dev → security-qa (linear, backward-compat)
  const mainFlow = {
    nodes: [
      { id: 'n1', agent_id: tpId, agent_name: 'task-planner', node_type: 'agent', x: 100, y: 200 },
      { id: 'n2', agent_id: bdId, agent_name: 'backend-dev',  node_type: 'agent', x: 380, y: 200 },
      { id: 'n3', agent_id: sqId, agent_name: 'security-qa',  node_type: 'agent', x: 660, y: 200 },
    ],
    edges: [
      { id: 'e1', from: 'n1', to: 'n2', priority: 1000, is_loop_back: false },
      { id: 'e2', from: 'n2', to: 'n3', priority: 1000, is_loop_back: false },
    ],
  };

  // Advanced Demo: planner → DECISION (bug | feature) → [bug-resolver | backend-dev]
  //   → GATE (PASS/FAIL) → PASS: quality-gate  /  FAIL: loop(max=2) → code-reviewer → loop_end → quality-gate
  const loopPairId = uuidv4();
  const advancedFlow = {
    nodes: [
      // 1. Entry agent
      { id: 'd1', agent_id: tpId, agent_name: 'task-planner', node_type: 'agent',    x: 60,  y: 200 },
      // 2. Decision
      { id: 'd2', node_type: 'decision', label: 'Bug or Feature?',
        config: { decision_field: 'output.task_type' }, x: 280, y: 200 },
      // 3a. Bug branch
      { id: 'd3', agent_id: brId, agent_name: 'bug-resolver', node_type: 'agent',    x: 180, y: 360 },
      // 3b. Feature branch
      { id: 'd4', agent_id: bdId, agent_name: 'backend-dev',  node_type: 'agent',    x: 380, y: 360 },
      // 4. Gate — receives from both branches
      { id: 'd5', node_type: 'gate', label: 'Quality Gate',
        config: { expected_verdicts: ['PASS', 'FAIL'] }, x: 560, y: 200 },
      // 5. Loop for remediation on FAIL
      { id: 'd6', node_type: 'loop_start', label: 'Remediation Loop',
        config: { max_iterations: 2, loop_pair_id: loopPairId }, x: 740, y: 280 },
      { id: 'd7', agent_id: crId, agent_name: 'code-reviewer', node_type: 'agent',   x: 740, y: 380 },
      { id: 'd8', node_type: 'loop_end', label: 'Loop end',
        config: { loop_pair_id: loopPairId }, x: 740, y: 470 },
      // 6. Final agent
      { id: 'd9', agent_id: qgId, agent_name: 'quality-gate', node_type: 'agent',    x: 920, y: 200 },
    ],
    edges: [
      // planner → decision
      { id: 'de1', from: 'd1', to: 'd2', priority: 1000, is_loop_back: false },
      // decision branches
      { id: 'de2', from: 'd2', to: 'd3', condition: "output.task_type === 'bug'",     priority: 1, is_loop_back: false },
      { id: 'de3', from: 'd2', to: 'd4', condition: "output.task_type === 'feature'", priority: 2, is_loop_back: false },
      // both branches → gate
      { id: 'de4', from: 'd3', to: 'd5', priority: 1000, is_loop_back: false },
      { id: 'de5', from: 'd4', to: 'd5', priority: 1000, is_loop_back: false },
      // gate: PASS → quality-gate, FAIL → loop
      { id: 'de6', from: 'd5', to: 'd9', condition: 'PASS', priority: 1, is_loop_back: false },
      { id: 'de7', from: 'd5', to: 'd6', condition: 'FAIL', priority: 2, is_loop_back: false },
      // loop body: loop_start → code-reviewer → loop_end
      { id: 'de8', from: 'd6', to: 'd7', priority: 1000, is_loop_back: false },
      { id: 'de9', from: 'd7', to: 'd8', priority: 1000, is_loop_back: false },
      // loop back-edge: loop_end → loop_start
      { id: 'de10', from: 'd8', to: 'd6', is_loop_back: true, priority: 1000 },
      // loop exit: loop_end → quality-gate
      { id: 'de11', from: 'd8', to: 'd9', priority: 1000, is_loop_back: false },
    ],
  };

  const insertFlow = db.prepare(
    'INSERT INTO project_flows (project_id, flow_json, updated_at) VALUES (?, ?, ?)'
  );
  insertFlow.run(user1MainId, JSON.stringify(mainFlow),     Date.now());
  insertFlow.run(user1BetaId, JSON.stringify({ nodes: [], edges: [] }), Date.now());
  insertFlow.run(user1DemoId, JSON.stringify(advancedFlow), Date.now());
  insertFlow.run(user2ProjId, JSON.stringify({ nodes: [], edges: [] }), Date.now());

  console.log('[seed] Done. Created 3 users, 4 projects (including Advanced Demo), agents & skills per user, flows seeded.');
}
