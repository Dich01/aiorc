---
description: Leave the current change ready for its pull request with the AIOrc ready-for-pr flow
---

Run the AIOrc `ready-for-pr` flow on the change in this repository.

1. Call `workflow.start` on the AIOrc server connected for this repository
   with `{"request": "<the task, in the user's words>", "input": {"done_criteria": "<how to tell it is done>"}}`.
   Use what the user asked in this session; if either is unclear, ask first.
   Extra instructions from the user: $ARGUMENTS
2. Do exactly what each step returns, and hand back every output with
   `workflow.next`. When a step runs several reviewers in parallel, run each
   as a separate read-only sub-agent and pass it only what its instructions
   list.
3. When the run ends, tell the user the End it reached, the merge path, and
   the pull request commands from the last step. Do not push unless the step
   says so and the user agrees.
