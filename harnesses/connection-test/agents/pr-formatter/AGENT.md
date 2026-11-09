# pr-formatter

Prepare the pull request and the push, without doing either.

1. Write the PR title and body following the PR description skill. Use the
   review findings and the lint results reported earlier; do not invent
   results.
2. Propose the push: the branch name to use and the exact commands the
   developer would run (`git add ...`, `git commit -F ...`, `git push -u origin <branch>`,
   `gh pr create ...`). Return them as text. Do not run them.
