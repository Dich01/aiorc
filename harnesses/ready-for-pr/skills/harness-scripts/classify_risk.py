"""Classify the risk of the change on HEAD against its base branch.

A fixed rule, not an opinion: the paths it touches and its size decide.

    python3 classify_risk.py [--profile FILE] [--base REF]

level:  none (nothing to review), split (too big: divide it), sensitive
        (touches a sensitive path: a person must approve), auto (only files
        in auto_paths, such as docs), normal (everything else).
depth:  none | min | full, the review depth prepare_diff.py will use.
"""
import argparse
import os
import sys

sys.dont_write_bytecode = True  # never leave __pycache__ next to the scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile")
    ap.add_argument("--base", default="")
    a = ap.parse_args()
    common.repo_root()
    profile = common.load_profile(a.profile)
    try:
        base = common.resolve_base(profile, a.base)
        result = common.classify(profile, base)
    except common.ScriptError as err:
        common.fail(str(err))
    result["profile_loaded"] = profile["_loaded"]
    result["script"] = common.script_info(__file__)
    common.emit(result)


if __name__ == "__main__":
    main()
