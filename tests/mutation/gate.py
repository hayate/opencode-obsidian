#!/usr/bin/env python3
"""The mutation gate: it breaks the code on purpose, one small change at a time, and requires a
test to notice each change. A mutation that survives marks behaviour no test protects.

Run from anywhere (paths resolve against the repository root):

    python3 tests/mutation/gate.py [--shard I/N] [--list]

The mutations are in mutations.py, each matched against exact source text: a change to the code
a mutation targets must update the mutation in the same change. A few are declared to survive on
one platform, with the reason (case handling is only observable on a case-insensitive
filesystem). Exit status: 0 when every mutation met its expectation; 1 when one survived that a
test should catch, or was caught where it is declared to survive (the declaration is stale); 2
when the gate cannot judge at all: a test file fails unmutated (every mutation would read as
caught), or a mutation's target text is gone."""
import argparse, os, pathlib, subprocess, sys
from dataclasses import dataclass
from typing import Optional, Tuple

ROOT = pathlib.Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Mutation:
    path: str
    # Edits applied together: one, or several (a move is two edits).
    old: Tuple[str, ...]
    new: Tuple[str, ...]
    test: str
    # Repeated runs, each of which must catch it (a race-dependent catch is not one).
    runs: int = 1
    network: bool = False
    # A --test-name-pattern: the tests meant to catch it, so no unrelated failure can.
    pattern: Optional[str] = None
    # sys.platform values where no test can catch it, and why.
    survives: Tuple[str, ...] = ()
    why: str = ""

    def label(self) -> str:
        return f"{self.path}: {self.old[0].strip()[:60]!r}"


def load(root: pathlib.Path = ROOT) -> list:
    sys.path.insert(0, str(root / "tests" / "mutation"))
    import mutations
    return mutations.MUTATIONS


def shard_of(mutations: list, shard: Tuple[int, int]) -> list:
    i, n = shard
    return [m for k, m in enumerate(mutations) if k % n == i - 1]


def moved_targets(mutations: list, root: pathlib.Path) -> list:
    texts = {}
    moved = []
    for m in mutations:
        text = texts.setdefault(m.path, (root / m.path).read_text())
        moved += [f"{m.path}: {o.strip()[:80]!r}" for o in m.old if o not in text]
    return moved


def _env(m: Mutation) -> dict:
    return {**os.environ, "SRO_NETWORK_TESTS": "1"} if m.network else dict(os.environ)


def _node_test(m: Mutation, root: pathlib.Path, pattern: Optional[str]) -> subprocess.CompletedProcess:
    args = ["node", "--test"] + (["--test-name-pattern", pattern] if pattern else []) + [m.test]
    return subprocess.run(args, cwd=root, capture_output=True, text=True, env=_env(m))


def _caught(m: Mutation, root: pathlib.Path) -> int:
    path = root / m.path
    original = path.read_text()
    text = original
    for old, new in zip(m.old, m.new):
        text = text.replace(old, new, 1)
    path.write_text(text)
    try:
        return sum(_node_test(m, root, m.pattern).returncode != 0 for _ in range(m.runs))
    finally:
        path.write_text(original)


def verdict(m: Mutation, caught: int, platform: str) -> Optional[str]:
    """None when the result is what the mutation expects, else the problem."""
    declared = platform in m.survives
    if not declared and caught == m.runs:
        return None
    if declared and caught == 0:
        return None
    if declared:
        return f"caught {caught}/{m.runs}, but declared to survive on {platform} ({m.why}): the declaration is stale"
    return f"SURVIVED {m.runs - caught}/{m.runs}: no test notices this change"


def run(mutations: list, shard: Tuple[int, int], root: pathlib.Path, platform: str) -> int:
    mine = shard_of(mutations, shard)
    moved = moved_targets(mine, root)
    if moved:
        print("these mutation targets are gone (update tests/mutation/mutations.py):")
        for line in moved:
            print(f"  {line}")
        return 2
    green = set()
    problems = []
    for m in mine:
        key = (m.test, m.network)
        if key not in green:
            base = _node_test(m, root, None)
            if base.returncode != 0:
                print(f"{m.test} fails unmutated, so no mutation of it can be judged:\n{base.stdout[-3000:]}{base.stderr[-1000:]}")
                return 2
            green.add(key)
        caught = _caught(m, root)
        problem = verdict(m, caught, platform)
        if problem:
            problems.append((m, problem))
            print(f"PROBLEM {m.label()}: {problem}", flush=True)
        elif platform in m.survives:
            print(f"SURVIVED 0/{m.runs} (expected on {platform}: {m.why}): {m.label()}", flush=True)
        else:
            print(f"CAUGHT {caught}/{m.runs}: {m.label()}", flush=True)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        for m, problem in problems:
            print(f"::error file={m.path}::{m.old[0].strip()[:80]!r}: {problem}")
    print(f"{len(mine)} mutations in shard {shard[0]}/{shard[1]}, {len(problems)} problems")
    return 1 if problems else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--shard", default="1/1", help="I/N: run the I-th of N interleaved slices")
    parser.add_argument("--list", action="store_true", help="print the shard's mutations, run nothing")
    args = parser.parse_args()
    i, n = (int(x) for x in args.shard.split("/"))
    if not 1 <= i <= n:
        parser.error("--shard wants I/N with 1 <= I <= N")
    mutations = load()
    if args.list:
        for m in shard_of(mutations, (i, n)):
            print(m.label())
        return
    sys.exit(run(mutations, (i, n), ROOT, sys.platform))


if __name__ == "__main__":
    main()
