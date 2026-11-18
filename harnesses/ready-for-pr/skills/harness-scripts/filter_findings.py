"""Filter the verified findings, record what happened to each, summarize.

    python3 filter_findings.py filter  --run-id RUN --findings FILE|- [--profile FILE]
    python3 filter_findings.py decide  --run-id RUN --id FINDING_ID --action fixed|rejected|not-applicable --reason TEXT
    python3 filter_findings.py summary --run-id RUN [--profile FILE] [--base REF]

filter   reads the verifier's output ({"findings": [...]}, from a file or from
         stdin with "-"), makes ids unique, drops the ones the
         verifier discarded, merges duplicates (same file, same category,
         overlapping lines), drops the ones similar to findings the team
         already rejected (<git dir>/aiorc/rejected.json), and sorts by
         severity. It never drops a finding because only one reviewer saw it.
         blocking: a confirmed finding of a blocking severity (profile
         block_severities, default high and critical) or of category secrets.
decide   records the fate of one finding of this run. A rejection with its
         reason also goes to the rejected registry, so later runs stop
         reporting the same thing.
summary  everything the PR needs: final findings, decisions, open blockers,
         the merge path (author, human or auto) recomputed from the fixed rule
         (raised to human by an open blocker or an unconfirmed diagnosis),
         and whether the checks marker still matches the working copy.
"""
import argparse
import json
import os
import re
import sys
import time

sys.dont_write_bytecode = True  # never leave __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

ACTIONS = ("fixed", "rejected", "not-applicable")


def _load(path, default):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(path, value):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=2, sort_keys=True)


def _rank(f):
    s = f.get("severity")
    return common.SEVERITIES.index(s) if s in common.SEVERITIES else -1


def _overlap(a, b, slack=3):
    a1, a2 = int(a.get("line_start") or 0), int(a.get("line_end") or a.get("line_start") or 0)
    b1, b2 = int(b.get("line_start") or 0), int(b.get("line_end") or b.get("line_start") or 0)
    return a1 - slack <= b2 and b1 - slack <= a2


def _words(text):
    return set(w for w in re.findall(r"[a-z0-9]+", str(text or "").lower()) if len(w) > 2)


def _similar_title(a, b):
    wa, wb = _words(a), _words(b)
    return bool(wa and wb) and len(wa & wb) / len(wa | wb) >= 0.5


def same_problem(a, b):
    return a.get("file") == b.get("file") and a.get("category") == b.get("category") and \
        (_overlap(a, b) or _similar_title(a.get("title"), b.get("title")))


def unique_ids(findings):
    """Two reviewers can pick the same id (`corr-1`). Later ones get the
    reviewer appended, so every decision names exactly one finding."""
    seen, out = set(), []
    for f in findings:
        fid = str(f.get("id") or "finding")
        if fid in seen:
            base = "%s-%s" % (fid, re.sub(r"[^A-Za-z0-9_.-]", "", str(f.get("reviewer") or "dup"))[:40] or "dup")
            fid, n = base, 2
            while fid in seen:
                fid, n = "%s-%d" % (base, n), n + 1
            f = dict(f, id=fid)
        seen.add(fid)
        out.append(f)
    return out


def cmd_filter(a):
    profile = common.load_profile(a.profile)
    rdir = common.run_dir(a.run_id)
    try:
        if a.findings == "-":
            doc = json.load(sys.stdin)
        else:
            with open(a.findings, "r", encoding="utf-8") as f:
                doc = json.load(f)
    except (OSError, ValueError) as err:
        common.fail("cannot read the findings %s: %s" % ("from stdin" if a.findings == "-" else a.findings, err))
    raw = doc.get("findings") if isinstance(doc, dict) else doc
    if not isinstance(raw, list):
        common.fail("the findings must be {\"findings\": [...]} or a list")
    raw = unique_ids([f for f in raw if isinstance(f, dict)])
    _save(os.path.join(rdir, "verified-%d.json" % (len(_load(os.path.join(rdir, "filter.json"), {"rounds": []})["rounds"]) + 1)), raw)
    rejected = _load(os.path.join(common.state_dir(), "rejected.json"), [])

    kept, dropped = [], []
    for f in raw:
        if not isinstance(f, dict):
            continue
        if f.get("verification") == "discarded":
            dropped.append({"id": f.get("id"), "reason": "discarded by the verifier: %s" % (f.get("verification_note") or "")})
            continue
        prior = next((r for r in rejected if same_problem(r, f)), None)
        if prior:
            dropped.append({"id": f.get("id"), "reason": "similar to a finding already rejected (%s): %s" % (prior.get("run_id"), prior.get("reason"))})
            continue
        dup = next((k for k in kept if same_problem(k, f)), None)
        if dup:
            reviewers = sorted(set(str(dup.get("reviewer", "")).split("+") + [str(f.get("reviewer", ""))]) - {""})
            winner = dup if (_rank(dup), dup.get("verification") == "confirmed") >= (_rank(f), f.get("verification") == "confirmed") else f
            merged = dict(winner)
            merged["reviewer"] = "+".join(reviewers)
            kept[kept.index(dup)] = merged
            dropped.append({"id": f.get("id") if winner is dup else dup.get("id"), "reason": "duplicate of %s" % merged.get("id")})
            continue
        kept.append(f)

    kept.sort(key=lambda f: (-_rank(f), f.get("file") or "", int(f.get("line_start") or 0)))
    block = set(profile.get("block_severities") or ["high", "critical"])
    blockers = [f for f in kept if f.get("verification") == "confirmed" and (f.get("severity") in block or f.get("category") == "secrets")]

    rounds = _load(os.path.join(rdir, "filter.json"), {"rounds": []})["rounds"]
    n = len(rounds) + 1
    result = {
        "round": n,
        "blocking": bool(blockers),
        "blocking_ids": [f.get("id") for f in blockers],
        "findings": kept,
        "dropped": dropped,
        "counts": {s: sum(1 for f in kept if f.get("severity") == s) for s in common.SEVERITIES},
    }
    rounds.append({"round": n, "blocking_ids": result["blocking_ids"], "findings": kept, "at": int(time.time())})
    _save(os.path.join(rdir, "filter.json"), {"rounds": rounds})
    result["script"] = common.script_info(__file__)
    common.emit(result)


def cmd_decide(a):
    if a.action not in ACTIONS:
        common.fail("--action must be one of %s" % ", ".join(ACTIONS))
    if not (a.reason or "").strip():
        common.fail("--reason is required: say what changed, or why the finding does not apply")
    rdir = common.run_dir(a.run_id)
    rounds = _load(os.path.join(rdir, "filter.json"), {"rounds": []})["rounds"]
    finding = None
    for r in reversed(rounds):
        finding = next((f for f in r["findings"] if f.get("id") == a.id), None)
        if finding:
            break
    if not finding:
        common.fail("no finding %s in this run's filtered findings" % a.id)
    entry = {"id": a.id, "action": a.action, "reason": a.reason.strip(), "file": finding.get("file"),
             "severity": finding.get("severity"), "title": finding.get("title"), "head_sha": common.head_sha(), "at": int(time.time())}
    decisions = _load(os.path.join(rdir, "decisions.json"), [])
    decisions = [d for d in decisions if d.get("id") != a.id] + [entry]
    _save(os.path.join(rdir, "decisions.json"), decisions)
    if a.action == "rejected":
        reg_path = os.path.join(common.state_dir(), "rejected.json")
        reg = _load(reg_path, [])
        reg.append({"file": finding.get("file"), "category": finding.get("category"), "title": finding.get("title"),
                    "line_start": finding.get("line_start"), "line_end": finding.get("line_end"),
                    "reason": a.reason.strip(), "run_id": a.run_id, "at": int(time.time())})
        _save(reg_path, reg)
    common.emit({"recorded": entry, "script": common.script_info(__file__)})


def cmd_summary(a):
    rdir = common.run_dir(a.run_id)
    rounds = _load(os.path.join(rdir, "filter.json"), {"rounds": []})["rounds"]
    decisions = _load(os.path.join(rdir, "decisions.json"), [])
    decided = {d["id"]: d for d in decisions}
    every = {}
    for r in rounds:
        for f in r["findings"]:
            every[f.get("id")] = f
    blockers = set()
    for r in rounds:
        blockers.update(r["blocking_ids"])
    last = rounds[-1]["findings"] if rounds else []
    open_blockers = sorted(i for i in blockers if i not in decided and any(f.get("id") == i for f in last))
    rejected_blockers = sorted(i for i in blockers if decided.get(i, {}).get("action") in ("rejected", "not-applicable"))

    # The merge path is recomputed here from the fixed rule, never copied from
    # an earlier step, and raised to "human" when a blocker was left open or
    # rejected by the author.
    profile = common.load_profile(a.profile)
    try:
        risk = common.classify(profile, common.resolve_base(profile, a.base))
        current = {"head_sha": common.head_sha(), "worktree_tree": common.worktree_tree()}
    except common.ScriptError as err:
        common.fail(str(err))
    marker = _load(os.path.join(common.state_dir(), "checked.json"), None)
    checks_current = bool(marker) and marker.get("head_sha") == current["head_sha"] and marker.get("worktree_tree") == current["worktree_tree"]
    merge_path = risk["merge_path"]
    reasons = [r["detail"] for r in risk["reasons"]]
    if open_blockers or rejected_blockers:
        merge_path = "human"
        reasons.append("blocking finding(s) not fixed: %s" % ", ".join(open_blockers + rejected_blockers))
    # A diagnosis the run could not confirm (the fix is not shown to remove the
    # reported failure) always goes to a person, whatever the path risk says.
    unconfirmed_diagnosis = sorted(
        f.get("id") for f in every.values()
        if f.get("category") == "diagnosis" and f.get("verification") != "discarded"
        and decided.get(f.get("id"), {}).get("action") != "fixed")
    if unconfirmed_diagnosis:
        merge_path = "human"
        reasons.append("diagnosis not confirmed: %s" % ", ".join(unconfirmed_diagnosis))
    if decisions and merge_path == "auto":
        merge_path = "author"

    common.emit({
        "rounds": len(rounds),
        "findings": last,
        "all_findings": list(every.values()),
        "decisions": decisions,
        "open_blockers": open_blockers,
        "rejected_blockers": rejected_blockers,
        "unconfirmed_diagnosis": unconfirmed_diagnosis,
        "level": risk["level"],
        "merge_path": merge_path,
        "merge_path_reasons": reasons,
        "owners": risk["owners"],
        "checks_current": checks_current,
        "head_sha": current["head_sha"],
        "base_sha": risk["base_sha"],
        "script": common.script_info(__file__),
    })


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd")
    f = sub.add_parser("filter")
    f.add_argument("--run-id", required=True)
    f.add_argument("--findings", required=True)
    f.add_argument("--profile")
    d = sub.add_parser("decide")
    d.add_argument("--run-id", required=True)
    d.add_argument("--id", required=True)
    d.add_argument("--action", required=True)
    d.add_argument("--reason", required=True)
    s = sub.add_parser("summary")
    s.add_argument("--run-id", required=True)
    s.add_argument("--profile")
    s.add_argument("--base", default="")
    a = ap.parse_args()
    common.repo_root()
    if a.cmd == "filter":
        cmd_filter(a)
    elif a.cmd == "decide":
        cmd_decide(a)
    elif a.cmd == "summary":
        cmd_summary(a)
    else:
        ap.print_help(sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
