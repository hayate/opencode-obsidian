"""The mutation gate's own behaviour, against a tiny repository with a real node test.

Run: python3 -m unittest discover -s tests/mutation -p 'test_*.py'"""
import contextlib, io, os, pathlib, re, sys, tempfile, textwrap, time, unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import gate  # noqa: E402

LIB = textwrap.dedent("""\
    export function add(a, b) {
      return a + b;
    }
    export function unused() {
      return 1;
    }
""")
TEST = textwrap.dedent("""\
    import { test } from "node:test";
    import assert from "node:assert/strict";
    import { add } from "./lib.mjs";
    test("adds", () => assert.equal(add(2, 2), 4));
    test("other", () => assert.ok(true));
""")


class Gate(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="sro-gate-"))
        (self.root / "lib.mjs").write_text(LIB)
        (self.root / "lib.test.mjs").write_text(TEST)

    def run_gate(self, mutations, shard=(1, 1), **kw):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = gate.run(mutations, shard, self.root, sys.platform, **kw)
        return status, out.getvalue()

    def alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    def m(self, old, new, **kw):
        return gate.Mutation("lib.mjs", (old,), (new,), "lib.test.mjs", **kw)

    def test_a_caught_mutation_passes_and_the_file_is_restored(self):
        status, out = self.run_gate([self.m("a + b", "a - b")])
        self.assertEqual(status, 0, out)
        self.assertIn("CAUGHT 1/1", out)
        self.assertEqual((self.root / "lib.mjs").read_text(), LIB)

    def test_a_survivor_fails_the_gate_and_names_the_mutation(self):
        status, out = self.run_gate([self.m("return 1;", "return 2;")])
        self.assertEqual(status, 1, out)
        self.assertIn("SURVIVED", out)
        self.assertIn("return 1;", out)
        self.assertEqual((self.root / "lib.mjs").read_text(), LIB)

    def test_a_survivor_declared_for_this_platform_passes(self):
        status, out = self.run_gate([self.m("return 1;", "return 2;", survives=(sys.platform,), why="dead code")])
        self.assertEqual(status, 0, out)
        self.assertIn("expected on", out)

    def test_a_declared_survivor_that_is_caught_fails_as_a_stale_declaration(self):
        status, out = self.run_gate([self.m("a + b", "a - b", survives=(sys.platform,), why="said so")])
        self.assertEqual(status, 1, out)
        self.assertIn("declared to survive", out)

    def test_a_declaration_for_another_platform_does_not_excuse_a_survivor(self):
        other = "linux" if sys.platform != "linux" else "darwin"
        status, out = self.run_gate([self.m("return 1;", "return 2;", survives=(other,), why="elsewhere")])
        self.assertEqual(status, 1, out)

    def test_the_pattern_narrows_the_run_to_the_named_tests(self):
        status, out = self.run_gate([self.m("a + b", "a - b", pattern="other")])
        self.assertEqual(status, 1, "only 'other' ran, and it does not call add: " + out)

    def test_every_run_must_catch_it(self):
        # Caught on even calls only: a flaky catch is not a catch.
        (self.root / "lib.test.mjs").write_text(TEST.replace(
            'test("adds", () => assert.equal(add(2, 2), 4));',
            'import { existsSync, writeFileSync, rmSync } from "node:fs";\n'
            'test("adds", () => { const f = new URL("./flip", import.meta.url);'
            ' if (existsSync(f)) { rmSync(f); return; } writeFileSync(f, ""); assert.equal(add(2, 2), 4); });'))
        status, out = self.run_gate([self.m("a + b", "a - b", runs=2)])
        self.assertEqual(status, 1, out)
        self.assertIn("1/2", out)

    def test_a_red_baseline_stops_the_gate_before_any_mutation(self):
        (self.root / "lib.test.mjs").write_text(TEST.replace("add(2, 2), 4", "add(2, 2), 5"))
        status, out = self.run_gate([self.m("a + b", "a - b")])
        self.assertEqual(status, 2, out)
        self.assertIn("fails unmutated", out)
        self.assertNotIn("CAUGHT", out)

    def test_a_mutant_whose_run_times_out_counts_as_caught_and_says_so(self):
        # The mutant makes add loop forever: a hang is a change the test notices. The test
        # process records its pid, and the whole run (node and its test process) is killed.
        pids = self.root / "pids"
        (self.root / "lib.test.mjs").write_text(TEST.replace(
            'test("adds", () => assert.equal(add(2, 2), 4));',
            'import { appendFileSync } from "node:fs";\n'
            'test("adds", () => { appendFileSync(new URL("./pids", import.meta.url), `${process.pid}\\n`);'
            ' let n = 0; while (add(2, 2) !== 4) n++; assert.equal(add(2, 2), 4); });'))
        started = time.monotonic()
        status, out = self.run_gate([self.m("a + b", "a - b")], timeout=3)
        self.assertLess(time.monotonic() - started, 30, out)
        self.assertEqual(status, 0, out)
        self.assertIn("CAUGHT 1/1 (1 timed out): lib.mjs", out)
        self.assertEqual((self.root / "lib.mjs").read_text(), LIB)
        # Killed with its group; as an orphan it is reaped a moment later, so allow for that.
        hung = int(pids.read_text().split()[-1])
        deadline = time.monotonic() + 10
        while self.alive(hung) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(self.alive(hung), "the timed-out run's test process is killed")

    def test_a_baseline_that_times_out_is_red_never_a_pass(self):
        (self.root / "lib.test.mjs").write_text(TEST.replace('test("other", () => assert.ok(true));', 'test("other", () => { for (;;); });'))
        status, out = self.run_gate([self.m("a + b", "a - b")], timeout=3)
        self.assertEqual(status, 2, out)
        self.assertIn("lib.test.mjs timed out unmutated", out)
        self.assertNotIn("CAUGHT", out)

    def test_a_target_that_moved_stops_the_gate_before_any_mutation(self):
        status, out = self.run_gate([self.m("a + b", "a - b"), self.m("a * b", "a / b")])
        self.assertEqual(status, 2, out)
        self.assertIn("a * b", out)
        self.assertNotIn("CAUGHT", out)

    def test_a_target_that_occurs_more_than_once_stops_the_gate_as_a_moved_target(self):
        # "return" is in add and in unused: the gate would mutate only the first, which may
        # not be the code the mutation means.
        status, out = self.run_gate([self.m("return", "throw")])
        self.assertEqual(status, 2, out)
        self.assertIn("'return' (2 times)", out)
        self.assertNotIn("CAUGHT", out)

    def test_shards_split_the_list_exactly(self):
        items = [self.m(f"x{k}", "y") for k in range(11)]
        for n in range(1, 6):
            shards = [gate.shard_of(items, (i, n)) for i in range(1, n + 1)]
            self.assertEqual(sorted(k for s in shards for k in (items.index(x) for x in s)), list(range(11)))

    def test_the_workflow_runs_each_platform_s_shards_1_to_n_once_and_passes_that_n(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        workflow = (root / ".github" / "workflows" / "mutation.yml").read_text()
        rows = re.findall(r"^\s*- \{ os: ([\w.-]+), shard: (\d+), of: (\d+) \}$", workflow, re.M)
        platforms = {os_ for os_, _, _ in rows}
        self.assertEqual(platforms, {"ubuntu-latest", "macos-latest"}, workflow)
        for os_ in platforms:
            mine = [(int(i), int(n)) for o, i, n in rows if o == os_]
            n = mine[0][1]
            self.assertEqual(sorted(mine), [(i, n) for i in range(1, n + 1)], f"{os_}: every shard 1..{n}, once, all of {n}")
        self.assertIn("python3 -u tests/mutation/gate.py --shard ${{ matrix.shard }}/${{ matrix.of }}", workflow)

    def test_the_repository_list_loads_and_every_target_is_in_place(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        mutations = gate.load(root)
        self.assertGreater(len(mutations), 100)
        self.assertEqual(gate.moved_targets(mutations, root), [])


if __name__ == "__main__":
    unittest.main()
