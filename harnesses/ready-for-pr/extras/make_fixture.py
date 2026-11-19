"""Build a throwaway demo repository for one eval case of ready-for-pr.

    python3 make_fixture.py <case> <empty target dir>
    python3 make_fixture.py --list

The repository is a tiny Python package (standard library only) that the
example profile in contexts/repo-profile/profile.json fits. Branch `main` is
the base; branch `feature` holds the change of the case. Run the eval from
inside the target directory.
"""
import os
import subprocess
import sys

BASE = {
    "README.md": "# demo\n\nA tiny service used to test the ready-for-pr harness.\n",
    "docs/guide.md": "# Guide\n\nNothing here yet.\n",
    "app/__init__.py": "",
    "app/calc.py": (
        "def add(a, b):\n"
        "    \"\"\"Return the sum of a and b.\"\"\"\n"
        "    return a + b\n"
        "\n"
        "\n"
        "def subtract(a, b):\n"
        "    return a - b\n"
    ),
    "app/auth/__init__.py": "",
    "app/auth/users.py": (
        "import sqlite3\n"
        "\n"
        "\n"
        "def connect(path=\":memory:\"):\n"
        "    db = sqlite3.connect(path)\n"
        "    db.execute(\"CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, role TEXT)\")\n"
        "    return db\n"
        "\n"
        "\n"
        "def find_user(db, user_id):\n"
        "    row = db.execute(\"SELECT id, name, role FROM users WHERE id = ?\", (user_id,)).fetchone()\n"
        "    return None if row is None else {\"id\": row[0], \"name\": row[1], \"role\": row[2]}\n"
    ),
    "tests/__init__.py": "",
    "tests/test_calc.py": (
        "import unittest\n"
        "\n"
        "from app.calc import add, subtract\n"
        "\n"
        "\n"
        "class CalcTest(unittest.TestCase):\n"
        "    def test_add(self):\n"
        "        self.assertEqual(add(2, 3), 5)\n"
        "\n"
        "    def test_subtract(self):\n"
        "        self.assertEqual(subtract(5, 3), 2)\n"
    ),
    "tests/test_users.py": (
        "import unittest\n"
        "\n"
        "from app.auth.users import connect, find_user\n"
        "\n"
        "\n"
        "class UsersTest(unittest.TestCase):\n"
        "    def setUp(self):\n"
        "        self.db = connect()\n"
        "        self.db.execute(\"INSERT INTO users (id, name, role) VALUES (1, 'ana', 'admin'), (2, 'bo', 'user')\")\n"
        "\n"
        "    def test_find_user(self):\n"
        "        self.assertEqual(find_user(self.db, 2)[\"name\"], \"bo\")\n"
        "        self.assertIsNone(find_user(self.db, 9))\n"
    ),
    ".gitignore": "__pycache__/\n",
}


def case_docs_only(w):
    w("README.md", BASE["README.md"] + "\n## Tests\n\nRun `python3 -m unittest discover -s tests -t .`.\n")


def case_weakened_tests(w, rm):
    w("app/calc.py", "def add(a, b):\n    return a + b\n\n\ndef subtract(a, b):\n    return a - b\n")
    rm("tests/test_calc.py")


def case_failing_check(w):
    w("app/calc.py", BASE["app/calc.py"] + "\n\ndef multiply(a, b):\n    return a + b\n")
    w("tests/test_calc.py", BASE["tests/test_calc.py"].replace("add, subtract", "add, multiply, subtract")
      + "\n    def test_multiply(self):\n        self.assertEqual(multiply(3, 4), 12)\n")


def case_sql_injection(w):
    w("app/auth/users.py", BASE["app/auth/users.py"] + (
        "\n\ndef find_user_by_name(db, name):\n"
        "    row = db.execute(\"SELECT id, name, role FROM users WHERE name = '%s'\" % name).fetchone()\n"
        "    return None if row is None else {\"id\": row[0], \"name\": row[1], \"role\": row[2]}\n"))
    w("tests/test_users.py", BASE["tests/test_users.py"].replace("connect, find_user", "connect, find_user, find_user_by_name")
      + "\n    def test_find_user_by_name(self):\n        self.assertEqual(find_user_by_name(self.db, \"ana\")[\"id\"], 1)\n"
        "        self.assertIsNone(find_user_by_name(self.db, \"nobody\"))\n")


def case_big_change(w):
    rows = "".join("    %d: %d,\n" % (i, i * i) for i in range(700))
    w("app/generated.py", "SQUARES = {\n" + rows + "}\n")


def case_no_changes(w):
    pass


CASES = {
    "docs-only": (case_docs_only, "docs: explain how to run the tests"),
    "weakened-tests": (case_weakened_tests, "refactor: simplify calc"),
    "failing-check": (case_failing_check, "feat: add multiply"),
    "sql-injection": (case_sql_injection, "feat: find users by name"),
    "big-change": (case_big_change, "feat: add the generated lookup table"),
    "no-changes": (case_no_changes, None),
}


def git(cwd, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="demo", GIT_AUTHOR_EMAIL="demo@example.com",
               GIT_COMMITTER_NAME="demo", GIT_COMMITTER_EMAIL="demo@example.com")
    subprocess.run(["git"] + list(args), cwd=cwd, check=True, env=env, stdout=subprocess.DEVNULL)


def build(case, target):
    if case not in CASES:
        sys.exit("unknown case %r; one of: %s" % (case, ", ".join(CASES)))
    if os.path.exists(target) and os.listdir(target):
        sys.exit("target %s is not empty" % target)
    os.makedirs(target, exist_ok=True)

    def w(rel, content):
        path = os.path.join(target, rel)
        os.makedirs(os.path.dirname(path) or target, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    def rm(rel):
        os.remove(os.path.join(target, rel))

    for rel, content in BASE.items():
        w(rel, content)
    git(target, "init", "-q", "-b", "main")
    git(target, "add", "-A")
    git(target, "commit", "-q", "-m", "initial version")
    git(target, "checkout", "-q", "-b", "feature")
    fn, message = CASES[case]
    if fn is case_weakened_tests:
        fn(w, rm)
    else:
        fn(w)
    if message:
        git(target, "add", "-A")
        git(target, "commit", "-q", "-m", message)
    return target


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--list":
        print("\n".join(CASES))
    elif len(sys.argv) == 3:
        print(build(sys.argv[1], sys.argv[2]))
    else:
        sys.exit(__doc__)
