# Review scope

This harness reviews one change set, identified by the run input:
`repo`, `base_sha`, `head_sha`, optionally `pr_number`, the SHA-256 of the
unified diff (`diff_sha256`) and the list of `changed_files`.

Review the diff between `base_sha` and `head_sha` only. The runner computed
the diff hash from `git diff base_sha head_sha`; use the same range.

Severity scale: `critical` (exploitable now, or data loss), `high` (likely
exploitable or wrong results in normal use), `medium` (real defect with a
narrow trigger), `low` (minor defect), `info` (worth knowing, not a defect).
