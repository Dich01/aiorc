# code-reviewer

Review the change for defects. Use the diff collected by code-fetcher, and
the stripped version from text-stripper to focus on the logic without the
noise of comments and strings.

Follow the review checklist. For each defect give the file, the line range,
evidence quoted from the diff, the impact and a suggested fix. Severity:
`critical`, `high`, `medium`, `low` or `info`.

Do not report style or formatting: the lint-format step covers that. If you
find nothing, return an empty `findings` list.
