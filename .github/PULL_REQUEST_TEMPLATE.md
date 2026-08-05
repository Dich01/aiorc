# What this changes

<!-- One or two sentences. If it closes an issue, write "Closes #123". -->

# Why

<!-- The problem being solved. Skip if it's obvious from the title. -->

# How it was verified

<!-- Which tests cover it, and anything you checked by hand. -->

- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `npm run build:flow` passes (if the flow editor changed)

# Checklist

- [ ] Branched off `development`
- [ ] No database, `.env`, or key files in the diff
- [ ] Tests added or updated for behavior changes
- [ ] No emoji in UI copy or code
- [ ] The AIOrc server still makes no LLM calls

<!--
If this touches the orchestrator, please say explicitly which guarantee it
affects — transition validation, invocation caps, skip classification, or
audit signing. Those are the core promises of the product and get the
closest review.
-->
