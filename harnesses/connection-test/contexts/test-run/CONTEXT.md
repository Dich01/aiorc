# Test run: connection and execution

This project exists to test AIOrc end to end from another repository: a
developer makes some test changes in their repository and calls AIOrc with
this flow.

The flow never changes the repository. It reads the change, analyzes it,
runs the linter and formatter in check mode, and returns proposals: a commit
message, a pull request, the commands to push, and a merge recommendation.
The developer decides whether to use them.

The change under review is the difference between the current branch and its
base branch (usually `main`): `git diff <base>...HEAD`, plus uncommitted
changes if there are any (`git diff HEAD`).
