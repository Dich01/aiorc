# Test run: connection and execution

This project exists to test AIOrc end to end from another repository: a
developer makes some test changes in their repository and calls AIOrc with
this flow.

The flow does not change the developer's code. Its one change to the
repository is the tooling-setup step, which installs ESLint and Prettier if
they are missing so the linter and formatter can be run. Everything else is
read, analyzed and returned as proposals: a commit message, a pull request,
the commands to push, and a merge recommendation. The developer decides
whether to use them. Tooling files are never part of the proposed commit.

The change under review is the difference between the current branch and its
base branch (usually `main`): `git diff <base>...HEAD`, plus uncommitted
changes if there are any (`git diff HEAD`).
