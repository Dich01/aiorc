"""Prepare what the reviewers read, and decide the review depth.

    python3 prepare_diff.py --run-id RUN [--profile FILE] [--base REF]

Writes, under <git dir>/aiorc/runs/RUN/:
  round-N.diff             the diff to review
  round-N.nocomments.diff  the same diff without comments (for the blind reviewer)

Round 1 reviews base..HEAD. Later rounds of the same run review only what
changed since the previous round (previous HEAD..HEAD), so a fix is reviewed
without re-reviewing the whole change. An empty later round needs no review.

depth comes from the same fixed rule as classify_risk.py, computed on the
whole change: none (no review: auto level, or an empty later round),
min (two reviewers) or full (every reviewer).

A line that held only a comment is kept as an empty line, so line numbers in
the stripped diff match the real file. Comment stripping is a heuristic by
file extension (# , //, /* */, --, <!-- -->)
that leaves string literals alone. It can be wrong on unusual syntax.
"""
import argparse
import json
import os
import re
import sys

sys.dont_write_bytecode = True  # never leave __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

HASH = {".py", ".sh", ".bash", ".zsh", ".rb", ".pl", ".r", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".tf", ".ex", ".exs", ".nim", ".cmake", ".mk", ".dockerfile"}
C_LIKE = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".kt", ".kts", ".scala", ".go", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rs", ".swift", ".dart", ".php", ".m", ".mm", ".groovy", ".gradle", ".proto", ".css", ".scss", ".less", ".sol", ".zig", ".v", ".jsonc"}
DASH = {".sql", ".lua", ".hs", ".elm", ".ada", ".vhd"}
MARKUP = {".html", ".htm", ".xml", ".vue", ".svelte", ".md", ".svg"}
NAMED = {"makefile": HASH, "dockerfile": HASH, "rakefile": HASH, "gemfile": HASH}


def style_of(path):
    base = os.path.basename(path).lower()
    if base in NAMED:
        return "hash"
    ext = os.path.splitext(base)[1]
    if ext in HASH:
        return "hash"
    if ext in C_LIKE:
        return "c" if ext != ".php" else "c+hash"
    if ext in DASH:
        return "dash"
    if ext in MARKUP:
        return "markup"
    return None


class Stripper:
    """Removes comments from a stream of lines, keeping state across lines
    (block comments, multi-line strings) and leaving strings untouched."""

    def __init__(self, style):
        self.style = style
        self.block = False      # inside /* */ or <!-- -->
        self.quote = None       # inside a string that spans lines (` or triple quotes)

    def line(self, text):
        s, out, i = self.style, [], 0
        n = len(text)
        while i < n:
            if self.block:
                end = "-->" if s == "markup" else "*/"
                j = text.find(end, i)
                if j < 0:
                    return "".join(out).rstrip()
                self.block = False
                i = j + len(end)
                continue
            if self.quote:
                j = text.find(self.quote, i)
                if j < 0:
                    out.append(text[i:])
                    return "".join(out)
                out.append(text[i:j + len(self.quote)])
                i = j + len(self.quote)
                self.quote = None
                continue
            c = text[i]
            if s == "markup":
                if text.startswith("<!--", i):
                    self.block = True
                    i += 4
                    continue
                out.append(c)
                i += 1
                continue
            if s == "hash" and text.startswith(('"""', "'''"), i):
                q = text[i:i + 3]
                j = text.find(q, i + 3)
                if j < 0:
                    out.append(text[i:])
                    self.quote = q
                    return "".join(out)
                out.append(text[i:j + 3])
                i = j + 3
                continue
            if c in ("'", '"') or (c == "`" and s.startswith("c")):
                j, esc = i + 1, False
                while j < n:
                    if esc:
                        esc = False
                    elif text[j] == "\\":
                        esc = True
                    elif text[j] == c:
                        break
                    j += 1
                if j >= n and c == "`":
                    out.append(text[i:])
                    self.quote = "`"
                    return "".join(out)
                out.append(text[i:j + 1])
                i = j + 1
                continue
            if s.startswith("c"):
                if text.startswith("//", i):
                    break
                if text.startswith("/*", i):
                    self.block = True
                    i += 2
                    continue
            if (s == "hash" or s == "c+hash") and c == "#":
                break
            if s == "dash" and text.startswith("--", i):
                break
            out.append(c)
            i += 1
        return "".join(out).rstrip()


def strip_diff(diff):
    out, stripper, removed = [], None, 0
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"^diff --git a/(.*) b/(.*)$", line)
            style = style_of(m.group(2)) if m else None
            stripper = (Stripper(style), Stripper(style)) if style else None
            out.append(line)
            continue
        if stripper is None or line.startswith(("+++ ", "--- ", "@@", "index ", "new file", "deleted file", "similarity", "rename ", "old mode", "new mode", "\\")):
            out.append(line)
            if line.startswith("@@") and stripper:
                stripper[0].block = stripper[1].block = False
                stripper[0].quote = stripper[1].quote = None
            continue
        sign, body = line[:1], line[1:]
        if sign == " ":
            stripper[0].line(body)  # context lines exist on both sides
            new = stripper[1].line(body)
        elif sign == "+":
            new = stripper[1].line(body)
        elif sign == "-":
            new = stripper[0].line(body)
        else:
            out.append(line)
            continue
        # A line that was only a comment stays as an empty line, so every hunk
        # keeps its line count and line numbers match the real file.
        if new != body.rstrip():
            removed += 1
        out.append(sign + new)
    return "\n".join(out) + ("\n" if out else ""), removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--profile")
    ap.add_argument("--base", default="")
    a = ap.parse_args()
    common.repo_root()
    profile = common.load_profile(a.profile)
    rdir = common.run_dir(a.run_id)
    state_file = os.path.join(rdir, "prepare.json")
    try:
        base_ref = common.resolve_base(profile, a.base)
        risk = common.classify(profile, base_ref)
        head = risk["head_sha"]
        prev = None
        if os.path.exists(state_file):
            with open(state_file, "r", encoding="utf-8") as f:
                prev = json.load(f)
        rounds = (prev or {}).get("rounds", [])
        n = len(rounds) + 1
        if rounds and _is_ancestor(rounds[-1]["head_sha"], head):
            scope, frm = "incremental", rounds[-1]["head_sha"]
        else:
            scope, frm = "full", risk["base_sha"]
        diff = common.git("diff", "--no-color", "--no-ext-diff", "-M", frm, head)
        files = [f["path"] for f in common.changed_files(frm, head)]
        stripped, removed = strip_diff(diff)
    except common.ScriptError as err:
        common.fail(str(err))

    depth = risk["depth"]
    if scope == "incremental" and not files:
        depth = "none"
    diff_path = os.path.join(rdir, "round-%d.diff" % n)
    nc_path = os.path.join(rdir, "round-%d.nocomments.diff" % n)
    with open(diff_path, "w", encoding="utf-8") as f:
        f.write(diff)
    with open(nc_path, "w", encoding="utf-8") as f:
        f.write(stripped)
    rounds.append({"round": n, "from": frm, "head_sha": head})
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump({"rounds": rounds}, f, indent=2)

    common.emit({
        "round": n,
        "scope": scope,
        "from_sha": frm,
        "head_sha": head,
        "depth": depth,
        "level": risk["level"],
        "files": files,
        "diff_file": diff_path,
        "diff_sha256": common.sha256_text(diff),
        "nocomments_file": nc_path,
        "nocomments_sha256": common.sha256_text(stripped),
        "comment_lines_removed": removed,
        "script": common.script_info(__file__),
    })


def _is_ancestor(a, b):
    import subprocess
    return subprocess.run(["git", "merge-base", "--is-ancestor", a, b],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


if __name__ == "__main__":
    main()
