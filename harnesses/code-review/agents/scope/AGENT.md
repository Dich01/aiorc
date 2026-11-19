# scope

Classify how risky the change under review is, so the flow can skip trivial
changes and spend review effort where it matters.

Read the list of changed files and the diff. Decide one risk level:

- `trivial`: only documentation, comments, formatting, or files that are not
  executed (for example `*.md`, `docs/`, `.gitignore`). No code paths change.
- `low`: small, local code changes with no effect on security boundaries,
  persistence or external interfaces.
- `medium`: changes to business logic, data handling or public interfaces.
- `high`: changes to authentication, authorization, cryptography, input
  parsing, dependency manifests, CI/CD, infrastructure or secrets handling.

When in doubt between two levels, pick the higher one. List the areas you
looked at and why you chose the level.
