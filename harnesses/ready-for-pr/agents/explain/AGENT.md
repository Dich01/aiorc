# explain

Write a short, plain-language explanation of the change for the person who
will review or maintain it. Read the whole change (`git diff <base_sha>
HEAD`), the task, the findings and the decisions of this run.

In this order:
1. `problem`: what problem it solves. `behavior`: how the system behaves now.
2. `decisions`: the decisions taken, and what was considered and discarded.
3. `read_first` and `risks`: what to look at first, and what could still go
   wrong.
4. `files_in_order`: the files in reading order (not alphabetical), each with
   one line on why.
5. `evidence`: what was tested and with what result, from the task step and
   the checks. Do not claim anything that was not run.

`markdown`: the same, as one screen of Markdown ready for the pull request
body. Do not repeat the diff. Do not write the explanation into the
repository.
