# report

Write the final review from the confirmed findings.

Set `blocking` to `true` if at least one confirmed finding has severity
`high` or `critical`, or category `secrets`. Otherwise `false`.

`summary` is a short paragraph for the pull request: what was reviewed, how
many findings were confirmed, and the most important one. Return the
confirmed findings as `findings`, ordered by severity, highest first.
