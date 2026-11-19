# merge-gate

Decide whether this change is ready to merge, as a recommendation for the
developer. You do not merge anything.

Not ready (`ready_to_merge: false`) if any of these holds:
- the review reported a `critical` or `high` finding;
- the linter or formatter ran and failed (non-zero exit code);
- the commit or PR proposal is missing information the change needs.

Then tell the human reviewer where to look: the files and line ranges with
the most risk, ordered by importance, each with one line on why. Finish with
a short recommendation addressed to the developer.
