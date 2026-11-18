"""Shared helpers for the ready-for-pr harness scripts.

Python 3.8+, standard library only, plus git. Every script prints one JSON
object on stdout and exits 0 when it produced a result (pass or fail); exit 2
means the script itself could not run (bad arguments, not a git repository).

State lives in <git dir>/aiorc/: never in the working tree, so nothing the
harness writes shows up in the diff under review.

    python3 common.py manifest     # sha256 of every script next to this file
"""
import hashlib
import json
import os
import re
import subprocess
import sys

SEVERITIES = ["info", "low", "medium", "high", "critical"]

DEFAULT_PROFILE = {
    "base_branch": "",
    "checks": [],
    "sensitive_paths": [],
    "auto_paths": ["**/*.md", "docs/**", "LICENSE", "**/*.txt"],
    "test_paths": ["test/**", "tests/**", "**/test_*.*", "**/*_test.*", "**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
    "ci_paths": [".github/workflows/**", ".gitlab-ci.yml", ".circleci/**", "Jenkinsfile", "azure-pipelines.yml", ".buildkite/**"],
    "coverage_config_paths": ["**/jest.config.*", "**/vitest.config.*", "**/.nycrc*", "**/pyproject.toml", "**/setup.cfg", "**/.coveragerc", "**/codecov.yml", "**/.codecov.yml", "**/package.json"],
    "max_changed_lines": 600,
    "max_changed_files": 40,
    "full_review_levels": ["sensitive"],
    "block_severities": ["high", "critical"],
    "owners": [],
    "allow_push": False,
}


class ScriptError(Exception):
    pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, indent=2, sort_keys=True) + "\n")


def fail(message):
    emit({"error": message})
    sys.exit(2)


def script_info(path):
    with open(path, "rb") as f:
        data = f.read()
    return {"name": os.path.basename(path), "sha256": hashlib.sha256(data).hexdigest()}


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ── git ─────────────────────────────────────────────────────────────────────

def git(*args, check=True, env=None):
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    r = subprocess.run(["git"] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=full_env)
    out = r.stdout.decode("utf-8", "replace")
    if check and r.returncode != 0:
        raise ScriptError("git %s failed: %s" % (" ".join(args), r.stderr.decode("utf-8", "replace").strip()))
    return out


def repo_root():
    try:
        return git("rev-parse", "--show-toplevel").strip()
    except ScriptError:
        fail("not inside a git repository")


def state_dir():
    d = git("rev-parse", "--absolute-git-dir").strip()
    path = os.path.join(d, "aiorc")
    os.makedirs(path, exist_ok=True)
    return path


def run_dir(run_id):
    if not run_id or not re.match(r"^[A-Za-z0-9_.-]{1,100}$", run_id):
        fail("--run-id is required (letters, digits, '.', '_' or '-')")
    path = os.path.join(state_dir(), "runs", run_id)
    os.makedirs(path, exist_ok=True)
    return path


def ref_exists(ref):
    return subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref + "^{commit}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def resolve_base(profile, override=""):
    candidates = [override, profile.get("base_branch", "")]
    head = git("symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD", check=False).strip()
    candidates += [head, "origin/main", "origin/master", "main", "master"]
    for ref in candidates:
        if ref and ref_exists(ref):
            return ref
    fail("cannot find the base branch: set base_branch in the profile or pass --base")


def merge_base(base_ref):
    return git("merge-base", base_ref, "HEAD").strip()


def head_sha():
    return git("rev-parse", "HEAD").strip()


def is_dirty():
    return git("status", "--porcelain").strip() != ""


def changed_files(base_sha, head="HEAD"):
    """[{path, old_path, status, added, deleted, binary}] for base_sha..head."""
    numstat = {}
    for line in git("diff", "--numstat", "-M", base_sha, head).splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        path = parts[-1]
        if " => " in path:  # renamed: keep the new path
            path = re.sub(r"\{([^{}]*) => ([^{}]*)\}", r"\2", path)
            if " => " in path:
                path = path.split(" => ")[-1]
            path = path.replace("//", "/")
        binary = parts[0] == "-"
        numstat[path] = (0 if binary else int(parts[0]), 0 if binary else int(parts[1]), binary)
    files = []
    for line in git("diff", "--name-status", "-M", base_sha, head).splitlines():
        parts = line.split("\t")
        if not parts or not parts[0]:
            continue
        status = parts[0][0]
        if status == "R" and len(parts) >= 3:
            old, path = parts[1], parts[2]
        else:
            old, path = None, parts[-1]
        added, deleted, binary = numstat.get(path, (0, 0, False))
        files.append({"path": path, "old_path": old, "status": status, "added": added, "deleted": deleted, "binary": binary})
    return files


def worktree_tree():
    """Tree id of the exact working tree (tracked and untracked, not ignored),
    built in a throwaway index so the real index is never touched."""
    tmp = os.path.join(state_dir(), "tmp-index")
    try:
        env = {"GIT_INDEX_FILE": tmp}
        git("read-tree", "HEAD", env=env)
        git("add", "-A", env=env)
        return git("write-tree", env=env).strip()
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


# ── profile and paths ───────────────────────────────────────────────────────

def load_profile(path):
    profile = dict(DEFAULT_PROFILE)
    if path is None:
        path = os.path.join(state_dir(), "profile.json")
    if not os.path.exists(path):
        profile["_loaded"] = False
        profile["_path"] = path
        return profile
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as err:
        fail("cannot read the profile %s: %s" % (path, err))
    if not isinstance(data, dict):
        fail("the profile must be a JSON object")
    for k, v in data.items():
        if k.startswith("_") or k.startswith("$"):
            continue
        profile[k] = v
    profile["_loaded"] = True
    profile["_path"] = path
    return profile


_glob_cache = {}


def glob_to_regex(pattern):
    if pattern in _glob_cache:
        return _glob_cache[pattern]
    i, out = 0, ""
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
            continue
        if pattern.startswith("**", i):
            out += ".*"
            i += 2
            continue
        if c == "*":
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    # A pattern without a slash matches the file name in any directory.
    if "/" not in pattern:
        out = "(?:.*/)?" + out
    rx = re.compile("^" + out + "$")
    _glob_cache[pattern] = rx
    return rx


def matches(path, patterns):
    return [p for p in (patterns or []) if glob_to_regex(p).match(path)]


def is_test_path(path, profile):
    return bool(matches(path, profile.get("test_paths")))


# ── risk classification (shared by classify_risk.py and prepare_diff.py) ───

def classify(profile, base_ref):
    base = merge_base(base_ref)
    head = head_sha()
    files = changed_files(base)
    added = sum(f["added"] for f in files)
    deleted = sum(f["deleted"] for f in files)
    reasons = []
    paths = [f["path"] for f in files] + [f["old_path"] for f in files if f["old_path"]]

    if not files:
        level = "none"
        reasons.append({"rule": "no-changes", "detail": "HEAD has no changes against %s" % base_ref, "files": []})
    else:
        sensitive = sorted({p for p in paths if matches(p, profile.get("sensitive_paths"))})
        too_many_lines = profile.get("max_changed_lines") and added + deleted > int(profile["max_changed_lines"])
        too_many_files = profile.get("max_changed_files") and len(files) > int(profile["max_changed_files"])
        auto = all(matches(f["path"], profile.get("auto_paths")) for f in files) and not sensitive
        if too_many_lines or too_many_files:
            level = "split"
            reasons.append({"rule": "size", "detail": "%d files, %d changed lines (limits: %s files, %s lines)" % (
                len(files), added + deleted, profile.get("max_changed_files"), profile.get("max_changed_lines")), "files": []})
        elif sensitive:
            level = "sensitive"
            reasons.append({"rule": "sensitive-paths", "detail": "touches paths listed as sensitive", "files": sensitive})
        elif auto:
            level = "auto"
            reasons.append({"rule": "auto-paths", "detail": "every changed file matches auto_paths", "files": [f["path"] for f in files]})
        else:
            level = "normal"
            reasons.append({"rule": "default", "detail": "no sensitive path, within the size limits", "files": []})

    owners = []
    for o in profile.get("owners") or []:
        hit = [p for p in paths if matches(p, o.get("paths"))]
        if hit:
            owners.append({"team": o.get("team", ""), "files": sorted(set(hit))})

    if level in ("none", "split"):
        depth = "none"
    elif level == "auto":
        depth = "none"
    elif level in (profile.get("full_review_levels") or []):
        depth = "full"
    else:
        depth = "min"

    merge_path = {"auto": "auto", "sensitive": "human"}.get(level, "author")
    return {
        "level": level,
        "depth": depth,
        "merge_path": merge_path,
        "requires_human": level == "sensitive",
        "owners": owners,
        "reasons": reasons,
        "base_ref": base_ref,
        "base_sha": base,
        "head_sha": head,
        "dirty": is_dirty(),
        "stats": {"files": len(files), "added": added, "deleted": deleted},
        "changed_files": [f["path"] for f in files],
    }


def manifest():
    here = os.path.dirname(os.path.abspath(__file__))
    return [script_info(os.path.join(here, n)) for n in sorted(os.listdir(here)) if n.endswith(".py")]


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "manifest":
        emit({"scripts": manifest()})
    else:
        sys.stderr.write("usage: python3 common.py manifest\n")
        sys.exit(2)
