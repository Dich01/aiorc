"""Run the repository's checks from the profile, cheapest first.

    python3 checks.py --run-id RUN [--profile FILE]

Each entry of profile.checks is {"name", "command", "required" (default
true), "timeout_seconds" (default 900)}. They run in the listed order from
the repository root; the first required check that fails stops the rest.
"{changed_files}" in a command is replaced by the files changed against the
base branch (shell-quoted), so a linter or a mutation tester can run on the
change only. "{changed_files:*.py}" (comma-separated globs) passes only the
files that match, so a tool never receives a file type it cannot parse. A
check whose placeholder matches no file is skipped.

Each run of this script writes the full output of every check to its own
folder, <git dir>/aiorc/runs/RUN/checks/round-N/<check>.log, so the log of a
failure survives the later rounds (log_file in each result points at it).

When every required check passes, a marker with the exact state that was
checked (HEAD and the tree of the working copy) is written to
<git dir>/aiorc/checked.json. If the code changes afterwards, the marker no
longer matches.

configured: false when the profile defines no checks: nothing was verified.
"""
import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time

sys.dont_write_bytecode = True  # never leave __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

TAIL_LINES = 40
PLACEHOLDER_RE = re.compile(r"\{changed_files(?::([^}]*))?\}")


def run_check(check, root, changed, logs_dir):
    name = str(check.get("name") or "check")
    command = str(check.get("command") or "").strip()
    required = check.get("required", True) is not False
    timeout = int(check.get("timeout_seconds") or 900)
    result = {"name": name, "command": command, "required": required}
    if not command:
        result.update(status="skipped", exit_code=None, seconds=0, output_tail="no command configured", log_sha256="")
        return result
    placeholders = PLACEHOLDER_RE.findall(command)
    if placeholders:
        for pattern in placeholders:
            files = [f for f in changed if not pattern or common.matches(f, [p.strip() for p in pattern.split(",") if p.strip()])]
            if not files:
                result.update(status="skipped", exit_code=None, seconds=0,
                              output_tail="no changed files%s to pass" % (" matching " + pattern if pattern else ""), log_sha256="")
                return result
            token = "{changed_files:%s}" % pattern if pattern else "{changed_files}"
            command = command.replace(token, " ".join(shlex.quote(f) for f in files))
    started = time.time()
    try:
        r = subprocess.run(command, shell=True, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        output = r.stdout.decode("utf-8", "replace")
        code = r.returncode
        status = "passed" if code == 0 else ("unavailable" if code == 127 else "failed")
    except subprocess.TimeoutExpired as err:
        output = (err.stdout or b"").decode("utf-8", "replace") + "\n[timed out after %ds]" % timeout
        code = None
        status = "timeout"
    seconds = round(time.time() - started, 2)
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
    log_path = os.path.join(logs_dir, safe + ".log")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(output)
    tail = "\n".join(output.rstrip().splitlines()[-TAIL_LINES:])
    result.update(status=status, exit_code=code, seconds=seconds, output_tail=tail[-4000:],
                  log_sha256=common.sha256_text(output), log_file=log_path)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--profile")
    ap.add_argument("--base", default="")
    a = ap.parse_args()
    root = common.repo_root()
    profile = common.load_profile(a.profile)
    run_dir = common.run_dir(a.run_id)
    # One folder per round: a later round never overwrites the log of a failure.
    checks_dir = os.path.join(run_dir, "checks")
    os.makedirs(checks_dir, exist_ok=True)
    taken = [int(n[6:]) for n in os.listdir(checks_dir) if n.startswith("round-") and n[6:].isdigit()]
    logs_dir = os.path.join(checks_dir, "round-%d" % (max(taken, default=0) + 1))
    os.makedirs(logs_dir)

    try:
        base = common.resolve_base(profile, a.base)
        changed = [f["path"] for f in common.changed_files(common.merge_base(base)) if f["status"] != "D"]
        checks = [c for c in (profile.get("checks") or []) if isinstance(c, dict)]
        results, failed = [], None
        for c in checks:
            if failed:
                results.append({"name": str(c.get("name") or "check"), "command": str(c.get("command") or ""),
                                "required": c.get("required", True) is not False, "status": "not-run",
                                "exit_code": None, "seconds": 0, "output_tail": "stopped after %s failed" % failed, "log_sha256": ""})
                continue
            r = run_check(c, root, changed, logs_dir)
            results.append(r)
            if r["required"] and r["status"] != "passed" and r["status"] != "skipped":
                failed = r["name"]

        configured = any(c.get("command") for c in checks)
        passed = configured and failed is None
        state = {"head_sha": common.head_sha(), "worktree_tree": common.worktree_tree(), "dirty": common.is_dirty()}
        marker = os.path.join(common.state_dir(), "checked.json")
        if passed:
            with open(marker, "w", encoding="utf-8") as f:
                json.dump(dict(state, run_id=a.run_id, at=int(time.time())), f, indent=2)
        elif os.path.exists(marker):
            os.remove(marker)
    except common.ScriptError as err:
        common.fail(str(err))

    common.emit({
        "configured": configured,
        "passed": passed,
        "failed_check": failed,
        "results": results,
        "state": state,
        "marker_written": passed,
        "profile_loaded": profile["_loaded"],
        "script": common.script_info(__file__),
    })


if __name__ == "__main__":
    main()
