"""The mutation gate's own behaviour, against a tiny repository with a real node test.

Run: python3 -m unittest discover -s tests/mutation -p 'test_*.py'"""
import contextlib, io, pathlib, sys, tempfile, textwrap, unittest

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

    def run_gate(self, mutations, shard=(1, 1)):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = gate.run(mutations, shard, self.root, sys.platform)
        return status, out.getvalue()

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

    def test_a_target_that_moved_stops_the_gate_before_any_mutation(self):
        status, out = self.run_gate([self.m("a + b", "a - b"), self.m("a * b", "a / b")])
        self.assertEqual(status, 2, out)
        self.assertIn("a * b", out)
        self.assertNotIn("CAUGHT", out)

    def test_shards_split_the_list_exactly(self):
        items = [self.m(f"x{k}", "y") for k in range(11)]
        for n in range(1, 6):
            shards = [gate.shard_of(items, (i, n)) for i in range(1, n + 1)]
            self.assertEqual(sorted(k for s in shards for k in (items.index(x) for x in s)), list(range(11)))

    def test_the_repository_list_loads_and_every_target_is_in_place(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        mutations = gate.load(root)
        self.assertGreater(len(mutations), 100)
        self.assertEqual(gate.moved_targets(mutations, root), [])


if __name__ == "__main__":
    unittest.main()
