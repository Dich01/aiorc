"""Detect a change that weakens the safety net instead of fixing the code.

    python3 detect_weakening.py [--profile FILE] [--base REF]

Looks at base..HEAD for:
  - test files deleted, or renamed out of the test paths;
  - tests skipped or focused (.skip, xit, @pytest.mark.skip, it.only, ...);
  - assertions removed from test files with fewer added back;
  - coverage thresholds lowered;
  - CI steps removed or made non-blocking (continue-on-error, || true, if: false, ...);
  - --no-verify added anywhere.

weakened: true means a person has to accept the change: the harness stops.
It is a heuristic and errs on the side of stopping.
"""
import argparse
import os
import re
import sys

sys.dont_write_bytecode = True  # never leave __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

SKIP_PATTERNS = [
    (r"\.skip\s*\(", "test skipped"),
    (r"\b(xit|xdescribe|xtest)\s*\(", "test skipped"),
    (r"\.only\s*\(", "test focused: the rest of the suite stops running"),
    (r"\b(fit|fdescribe)\s*\(", "test focused: the rest of the suite stops running"),
    (r"@pytest\.mark\.(skip|skipif|xfail)\b", "test skipped"),
    (r"@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b", "test skipped"),
    (r"pytest\.skip\s*\(", "test skipped"),
    (r"@(Disabled|Ignore)\b", "test skipped"),
    (r"\bt\.Skip(Now|f)?\s*\(", "test skipped"),
    (r"#\[ignore\]", "test skipped"),
    (r"\bmarkTestSkipped\s*\(", "test skipped"),
]
ASSERT_RE = re.compile(r"\b(assert\w*|expect|should|require\.\w+|t\.(Error|Fatal)\w*|verify)\b\s*[\(\.\s!]")
CI_WEAK = [
    (r"continue-on-error:\s*true", "CI step made non-blocking"),
    (r"allow_failure:\s*true", "CI job made non-blocking"),
    (r"^\s*if:\s*(false|\$\{\{\s*false\s*\}\})\s*$", "CI step disabled"),
    (r"\|\|\s*(true|exit 0|:)\s*$", "failure of a CI command ignored"),
    (r"when:\s*manual", "CI job made manual"),
    (r"--no-verify", "git hooks bypassed"),
]
THRESHOLD_RE = re.compile(r"[\"']?([A-Za-z_-]*(?:threshold|fail_under|fail-under|minimum|branches|lines|functions|statements|target)[A-Za-z_-]*)[\"']?\s*[:=]\s*[\"']?(\d+(?:\.\d+)?)")


def diff_lines(base, head="HEAD"):
    """{path: {"added": [(line_no, text)], "removed": [(line_no, text)]}}"""
    out, cur, old, old_no, new_no = {}, None, None, 0, 0
    for line in common.git("diff", "-U0", "--no-color", "--no-ext-diff", "-M", base, head).splitlines():
        if line.startswith("diff --git "):
            cur = old = None
            continue
        if line.startswith("--- ") and cur is None:
            p = line[4:]
            old = p[2:] if p.startswith("a/") else None
            continue
        if line.startswith("+++ ") and cur is None:
            p = line[4:]
            cur = p[2:] if p.startswith("b/") else old  # a deleted file keeps its old path
            if cur is not None:
                out.setdefault(cur, {"added": [], "removed": []})
            continue
        m = re.match(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if m:
            old_no, new_no = int(m.group(1)), int(m.group(2))
            continue
        if cur is None:
            continue
        if line.startswith("+"):
            out[cur]["added"].append((new_no, line[1:]))
            new_no += 1
        elif line.startswith("-"):
            out[cur]["removed"].append((old_no, line[1:]))
            old_no += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile")
    ap.add_argument("--base", default="")
    a = ap.parse_args()
    common.repo_root()
    profile = common.load_profile(a.profile)
    items = []
    try:
        base = common.merge_base(common.resolve_base(profile, a.base))
        files = common.changed_files(base)
        lines = diff_lines(base)
    except common.ScriptError as err:
        common.fail(str(err))

    for f in files:
        path, old = f["path"], f["old_path"]
        if f["status"] == "D" and common.is_test_path(path, profile):
            items.append({"kind": "test-deleted", "file": path, "line": None, "detail": "test file deleted"})
        if f["status"] == "R" and old and common.is_test_path(old, profile) and not common.is_test_path(path, profile):
            items.append({"kind": "test-moved-out", "file": path, "line": None, "detail": "test file renamed out of the test paths (was %s)" % old})

    added_asserts = removed_asserts = 0
    for path, d in lines.items():
        is_test = common.is_test_path(path, profile)
        is_ci = bool(common.matches(path, profile.get("ci_paths")))
        is_cov = bool(common.matches(path, profile.get("coverage_config_paths")))
        for no, text in d["added"]:
            if is_test:
                for rx, why in SKIP_PATTERNS:
                    if re.search(rx, text):
                        items.append({"kind": "test-skipped", "file": path, "line": no, "detail": "%s: %s" % (why, text.strip()[:200])})
                        break
            if is_ci:
                for rx, why in CI_WEAK:
                    if re.search(rx, text):
                        items.append({"kind": "ci-weakened", "file": path, "line": no, "detail": "%s: %s" % (why, text.strip()[:200])})
                        break
            elif "--no-verify" in text and not is_test:
                items.append({"kind": "hooks-bypassed", "file": path, "line": no, "detail": "--no-verify added: %s" % text.strip()[:200]})
        if is_test:
            added_asserts += sum(1 for _, t in d["added"] if ASSERT_RE.search(t))
            removed_asserts += sum(1 for _, t in d["removed"] if ASSERT_RE.search(t))
        if is_ci:
            removed_runs = [(no, t) for no, t in d["removed"] if re.match(r"^\s*-?\s*(run|script|uses):", t)]
            added_runs = [t for _, t in d["added"] if re.match(r"^\s*-?\s*(run|script|uses):", t)]
            if len(removed_runs) > len(added_runs):
                no, t = removed_runs[0]
                items.append({"kind": "ci-step-removed", "file": path, "line": no, "detail": "%d CI step(s) removed, %d added: %s" % (len(removed_runs), len(added_runs), t.strip()[:200])})
        if is_cov:
            before = {}
            for _, t in d["removed"]:
                for key, val in THRESHOLD_RE.findall(t):
                    before[key.lower()] = float(val)
            for no, t in d["added"]:
                for key, val in THRESHOLD_RE.findall(t):
                    k = key.lower()
                    if k in before and float(val) < before[k]:
                        items.append({"kind": "coverage-lowered", "file": path, "line": no, "detail": "%s lowered from %s to %s" % (key, before[k], val)})

    if removed_asserts > added_asserts:
        items.append({"kind": "assertions-removed", "file": None, "line": None,
                      "detail": "%d assertion line(s) removed from tests, %d added" % (removed_asserts, added_asserts)})

    common.emit({
        "weakened": bool(items),
        "items": items,
        "assertions": {"added": added_asserts, "removed": removed_asserts},
        "base_sha": base,
        "head_sha": common.head_sha(),
        "script": common.script_info(__file__),
    })


if __name__ == "__main__":
    main()
