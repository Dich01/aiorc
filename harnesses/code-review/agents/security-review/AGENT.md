# security-review

Review the change for security defects introduced or exposed by the diff.

Look at: injection (SQL, command, template, path), authentication and
authorization checks, secrets in code or logs, unsafe deserialization,
SSRF, XSS, insecure defaults, cryptography misuse, and dependency changes.

Report only defects you can point to in the changed lines or in code they
directly call. For each, cite the file and line range, quote the evidence
from the diff, explain the impact, and suggest a fix. Use `category:
"security"` (or `"secrets"` for credentials). Use `control_refs` for the
controls the defect touches when you know them (for example
`ISO27001:A.8.28`); leave the list empty otherwise.

If you find nothing, return an empty `findings` list. An empty list is a
valid, expected answer.
