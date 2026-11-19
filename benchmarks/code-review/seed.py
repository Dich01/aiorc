#!/usr/bin/env python3
"""Build one throwaway clone of the source repository per benchmark case, each with one
commit on top of the base branch.

The source repository is only read: `git clone --no-local` copies its objects
through git (no hardlinks, no worktrees, nothing written to its .git).

usage: seed.py <cases.json> <work dir>
env:   BENCH_BASE  commit to build every case on (default origin/<base_branch>),
                    to repeat a benchmark on the same code after the branch moved.
"""
import json
import os
import subprocess
import sys

cases_file, work = sys.argv[1], os.path.abspath(sys.argv[2])
spec = json.load(open(cases_file))
src = spec["source_repo"]
os.makedirs(work, exist_ok=True)
base = os.environ.get("BENCH_BASE") or f"origin/{spec['base_branch']}"
env = {**os.environ, "GIT_AUTHOR_NAME": "bench", "GIT_AUTHOR_EMAIL": "bench@example.com",
       "GIT_COMMITTER_NAME": "bench", "GIT_COMMITTER_EMAIL": "bench@example.com"}

def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()

out = []
for case in spec["cases"]:
    d = os.path.join(work, case["id"])
    if not os.path.exists(d):
        subprocess.run(["git", "clone", "-q", "--no-local", "--branch", spec["base_branch"], src, d], check=True)
    git(d, "checkout", "-q", "-B", f"case/{case['id']}", base)
    for p in case["patches"]:
        path = os.path.join(d, p["file"])
        if "create" in p:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "w").write(p["create"])
            continue
        text = open(path).read()
        n = text.count(p["find"])
        if n != 1:
            sys.exit(f"{case['id']}: expected the anchor exactly once in {p['file']}, found {n}")
        open(path, "w").write(text.replace(p["find"], p["replace"]))
    git(d, "add", "-A")
    git(d, "commit", "-q", "-m", case["commit"])
    out.append({"id": case["id"], "dir": d, "head": git(d, "rev-parse", "HEAD"),
                "files": git(d, "diff", "--name-only", base, "HEAD").split("\n")})
    print(f"{case['id']:24} {out[-1]['head'][:10]}  {', '.join(out[-1]['files'])}")

json.dump(out, open(os.path.join(work, "seeded.json"), "w"), indent=2)
