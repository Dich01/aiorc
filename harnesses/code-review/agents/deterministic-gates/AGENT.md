# deterministic-gates

Before any model-based review, record the results of the deterministic
checks the CI job already ran: secret scanning (gitleaks), static analysis
(semgrep) and the test suite.

Do not run the tools yourself and do not interpret their findings here.
Report, for each tool, exactly what the runner gives you: tool name,
version, exit code, and the SHA-256 of its report file. Set
`secrets_found` to `true` if the secret scanner exited with findings.
