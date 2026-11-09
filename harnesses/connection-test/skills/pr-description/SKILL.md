# Pull request description

Title: the same style as the commit subject, at most 72 characters.

Body sections, in this order:

1. **Summary**: two or three sentences: what changes and why.
2. **Changes**: bullet list by file or area.
3. **How to test**: concrete steps a reviewer can follow.
4. **Checks**: linter and formatter results (tool, exit code, issue count).
5. **Review focus**: the files and line ranges the reviewer should look at
   first, and why.
6. **Risks**: anything that could break, or "None identified".

Do not invent tests that were not run or results that were not reported by
an earlier step.
