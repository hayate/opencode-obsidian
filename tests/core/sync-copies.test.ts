import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictStamp, copyPath, isCopyOf, TreeNames } from "../../core/sync/copies.ts";

const OID = "3f786850e387550fdab836ed7e6dc881de23001b";
const WHEN = "2026-09-22-0915";
const bytes = (s: string): number => new TextEncoder().encode(s).length;
const none = (): boolean => false;

test("a copy sits beside the note: stem, conflict time, six hex of the object, extension", () => {
  assert.equal(copyPath("x/notes/plan.md", OID, WHEN, none), "x/notes/plan.conflict-2026-09-22-0915-3f7868.md");
  assert.equal(copyPath("top.md", OID, WHEN, none), "top.conflict-2026-09-22-0915-3f7868.md");
});

test("a name without an extension, or a dotfile, keeps its whole name as the stem", () => {
  assert.equal(copyPath("x/Makefile", OID, WHEN, none), "x/Makefile.conflict-2026-09-22-0915-3f7868");
  assert.equal(copyPath("x/.gitignore", OID, WHEN, none), "x/.gitignore.conflict-2026-09-22-0915-3f7868");
});

test("a taken name gets -2, then -3, before the extension", () => {
  const taken = new Set(["x/a.conflict-2026-09-22-0915-3f7868.md", "x/a.conflict-2026-09-22-0915-3f7868-2.md"]);
  assert.equal(copyPath("x/a.md", OID, WHEN, (p) => taken.has(p)), "x/a.conflict-2026-09-22-0915-3f7868-3.md");
});

test("a long stem is cut by UTF-8 bytes so every candidate, suffix included, fits in 255 bytes", () => {
  const stem = "日本語".repeat(40); // 360 bytes
  const taken = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const p = copyPath(`x/${stem}.md`, OID, WHEN, (c) => taken.has(c));
    const name = p.slice(2);
    assert.ok(bytes(name) <= 255, `${bytes(name)} bytes`);
    assert.ok(name.startsWith("日"), "the stem is cut whole characters at a time");
    assert.ok(!name.includes("�"));
    taken.add(p);
  }
});

test("when even one stem character does not fit, the name falls back to conflict-<12 hex>", () => {
  const ext = `.${"e".repeat(250)}`;
  assert.equal(copyPath(`x/n${ext}`, OID, WHEN, none), "x/conflict-3f786850e387");
  const taken = new Set(["x/conflict-3f786850e387"]);
  assert.equal(copyPath(`x/n${ext}`, OID, WHEN, (p) => taken.has(p)), "x/conflict-3f786850e387-2");
});

test("the name check sees exact paths, folders, and case or normalization twins in the same folder", () => {
  const names = new TreeNames(["x", "x/Plan.conflict-2026-09-22-0915-3f7868.md", "x/sub", "x/sub/a.md", "x/café.md"]);
  assert.equal(names.taken("x/sub"), true, "an existing folder");
  assert.equal(names.taken("x/plan.conflict-2026-09-22-0915-3f7868.md"), true, "a case twin");
  assert.equal(names.taken("x/café.md"), true, "a normalization twin");
  assert.equal(names.taken("y/plan.conflict-2026-09-22-0915-3f7868.md"), false, "another folder");
  names.add("x/new.md");
  assert.equal(names.taken("x/NEW.md"), true, "a name added during this resolution counts");
});

test("the conflict time is minutes in the vault timezone", () => {
  const at = new Date("2026-09-22T00:15:42Z");
  assert.equal(conflictStamp(at, "Asia/Tokyo"), "2026-09-22-0915");
  assert.equal(conflictStamp(at, "America/Los_Angeles"), "2026-09-21-1715");
});

test("a copy belongs to its own note only, including when the note's name was cut", () => {
  assert.equal(isCopyOf("x/a.md", "x/a.conflict-2026-09-22-0915-3f7868.md"), true);
  assert.equal(isCopyOf("x/a.md", "x/a.conflict-2026-09-22-0915-3f7868-2.md"), true);
  assert.equal(isCopyOf("x/ab.md", "x/a.conflict-2026-09-22-0915-3f7868.md"), false, "a shorter note's copy");
  assert.equal(isCopyOf("x/a.md", "y/a.conflict-2026-09-22-0915-3f7868.md"), false, "another folder");
  assert.equal(isCopyOf("x/a.md", "x/a.md"), false, "the note itself");
  const long = "日本語".repeat(40);
  const cut = copyPath(`x/${long}.md`, OID, WHEN, none);
  assert.equal(isCopyOf(`x/${long}.md`, cut), true, "a copy whose stem was cut to fit");
  assert.equal(isCopyOf(`x/${long}X.md`, cut), true, "(both notes cut to the same stem share it: identical content only)");
  const ext = `.${"e".repeat(250)}`;
  assert.equal(isCopyOf(`x/n${ext}`, copyPath(`x/n${ext}`, OID, WHEN, none)), true, "the hash-only fallback");
});

test("a copy of a conflict copy is recognised as that copy's copy", () => {
  const first = "x/a.conflict-2026-09-20-0800-111111.md";
  const second = "x/a.conflict-2026-09-20-0800-111111.conflict-2026-09-22-0915-3f7868.md";
  assert.equal(isCopyOf(first, second), true);
  assert.equal(isCopyOf("x/a.md", second), false, "not a copy of the note itself");
});
