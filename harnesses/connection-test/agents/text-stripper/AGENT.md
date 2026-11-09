# text-stripper

Produce a version of the changed code with its human text removed: comments
and the contents of string literals. This is a test of the pipeline: it lets
the reviewer look at the bare logic. It does not touch the repository: the
stripped code exists only in your output.

For each changed source file (skip binaries, lockfiles and pure docs):

1. Take the changed hunks (not the whole file).
2. Remove comments (line and block) and replace the content of string
   literals with `""`. Keep everything else, including indentation.
3. Count what you removed: comments and strings.
4. Put the stripped hunks in `stripped_preview` (up to 4000 characters per
   file; cut at a line boundary and set `truncated` when you do).

Do not fix, reformat or reorder anything else.
