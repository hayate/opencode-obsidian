import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitOk } from "../../core/git.ts";
import { checkResolved, mergeAndResolve, writeResolved, type MergeFacts, type Resolution } from "../../core/sync/resolve.ts";
import { initRepo, tempDir } from "./helpers.ts";

const WHEN = "2026-09-22-0915";
const TEXT = "long enough text for rename detection, line one\nline two\nline three\n";

interface Side {
  write?: Record<string, string>;
  remove?: string[];
  move?: Array<[string, string]>;
  link?: Record<string, string>;
  exec?: string[];
}

// A repository with branches base, remote (the remote head U) and local (the live
// snapshot L), cloned bare like the state clone.
async function scenario(base: Record<string, string>, remote: Side, local: Side): Promise<string> {
  const dir = await tempDir();
  await initRepo(dir);
  await apply(dir, { write: base });
  await gitOk(["commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
  await gitOk(["branch", "base"], { cwd: dir });
  for (const [name, side] of [["remote", remote], ["local", local]] as const) {
    await gitOk(["checkout", "-q", "-B", name, "base"], { cwd: dir });
    await apply(dir, side);
    await gitOk(["commit", "-q", "--allow-empty", "-m", name], { cwd: dir });
  }
  const clone = join(await tempDir(), "sync.git");
  await gitOk(["clone", "-q", "--bare", dir, clone], { cwd: dir });
  return clone;
}

async function apply(dir: string, side: Side): Promise<void> {
  for (const [from, to] of side.move ?? []) await gitOk(["mv", from, to], { cwd: dir });
  for (const path of side.remove ?? []) await gitOk(["rm", "-q", "-r", path], { cwd: dir });
  for (const [path, content] of Object.entries(side.write ?? {})) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  for (const [path, target] of Object.entries(side.link ?? {})) {
    await rm(join(dir, path), { force: true });
    await symlink(target, join(dir, path));
  }
  for (const path of side.exec ?? []) await chmod(join(dir, path), 0o755);
  await gitOk(["add", "-A"], { cwd: dir });
}

type Tree = Map<string, { mode: string; oid: string }>;

async function treeOf(clone: string, treeish: string): Promise<Tree> {
  const out = await gitOk(["ls-tree", "-r", "-z", treeish], { cwd: clone });
  const tree: Tree = new Map();
  for (const line of out.split("\0").filter(Boolean)) {
    const [meta = "", path = ""] = line.split("\t");
    const [mode = "", , oid = ""] = meta.split(" ");
    tree.set(path, { mode, oid });
  }
  return tree;
}

async function blob(clone: string, oid: string): Promise<string> {
  return gitOk(["cat-file", "blob", oid], { cwd: clone });
}

async function resolved(clone: string): Promise<{ r: Resolution & { kind: "clean" }; tree: Tree }> {
  const r = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
  assert.equal(r.kind, "clean", r.kind === "stop" ? r.reason : "");
  return { r: r as Resolution & { kind: "clean" }, tree: await treeOf(clone, (r as { tree: string }).tree) };
}

test("edits to different lines merge with no conflict", async () => {
  const clone = await scenario({ "n.md": "a\nb\nc\n" }, { write: { "n.md": "A\nb\nc\n" } }, { write: { "n.md": "a\nb\nC\n" } });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts, []);
  assert.equal(await blob(clone, tree.get("n.md")?.oid ?? ""), "A\nb\nC");
});

test("a same-line clash keeps the local text at the path and the remote text as a copy", async () => {
  const clone = await scenario({ "x/n.md": "a\n" }, { write: { "x/n.md": "remote\n" } }, { write: { "x/n.md": "local\n" } });
  const { r, tree } = await resolved(clone);
  const copy = "x/n.conflict-2026-09-22-0915-" ;
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]?.kind, "both-changed");
  assert.equal(r.conflicts[0]?.path, "x/n.md");
  assert.ok(r.conflicts[0]?.copy?.startsWith(copy), r.conflicts[0]?.copy ?? "");
  assert.equal(await blob(clone, tree.get("x/n.md")?.oid ?? ""), "local");
  assert.equal(await blob(clone, tree.get(r.conflicts[0]?.copy ?? "")?.oid ?? ""), "remote");
  assert.equal(tree.size, 2, [...tree.keys()].join(", "));
});

test("two different new notes at one path: the local one keeps it, the remote one is the copy", async () => {
  const clone = await scenario({ "keep.md": "k\n" }, { write: { "new.md": "R\n" } }, { write: { "new.md": "L\n" } });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.kind, "both-changed");
  assert.equal(await blob(clone, tree.get("new.md")?.oid ?? ""), "L");
  assert.equal(await blob(clone, tree.get(r.conflicts[0]?.copy ?? "")?.oid ?? ""), "R");
});

test("a binary file changed on both sides keeps the local version at the path and the remote one as a copy", async () => {
  // A NUL byte makes git's merge say "binary" as well as "contents" for the path.
  const clone = await scenario({ "n.bin": "a\0b\n" }, { write: { "n.bin": "remote\0b\n" } }, { write: { "n.bin": "local\0b\n" } });
  const { r, tree } = await resolved(clone);
  const local = (await treeOf(clone, "local")).get("n.bin");
  const remote = (await treeOf(clone, "remote")).get("n.bin");
  assert.deepEqual(r.conflicts.map((c) => [c.kind, c.path]), [["both-changed", "n.bin"]]);
  const copy = r.conflicts[0]?.copy ?? "";
  assert.ok(copy.startsWith("n.conflict-2026-09-22-0915-") && copy.endsWith(".bin"), copy);
  assert.deepEqual(tree.get("n.bin"), local);
  assert.deepEqual(tree.get(copy), remote);
  assert.deepEqual([...tree.keys()].sort(), [copy, "n.bin"].sort());
});

test("a clash where the other machine also made the note executable keeps the local entry at the path and the executable one as the copy", async () => {
  const clone = await scenario({ "n.md": "a\n" }, { write: { "n.md": "remote\n" }, exec: ["n.md"] }, { write: { "n.md": "local\n" } });
  const { r, tree } = await resolved(clone);
  const local = (await treeOf(clone, "local")).get("n.md");
  const remote = (await treeOf(clone, "remote")).get("n.md");
  assert.equal(remote?.mode, "100755", "the fixture's remote note is executable");
  assert.deepEqual(r.conflicts.map((c) => [c.kind, c.path]), [["both-changed", "n.md"]]);
  assert.deepEqual(tree.get("n.md"), { mode: "100644", oid: local?.oid });
  assert.deepEqual(tree.get(r.conflicts[0]?.copy ?? ""), { mode: "100755", oid: remote?.oid });
  assert.equal(tree.size, 2, [...tree.keys()].join(", "));
});

test("a note deleted here and edited there stays deleted; the edit becomes the copy", async () => {
  const clone = await scenario({ "n.md": "a\n" }, { write: { "n.md": "remote edit\n" } }, { remove: ["n.md"] });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.kind, "deleted-here");
  assert.equal(tree.has("n.md"), false);
  assert.equal(await blob(clone, tree.get(r.conflicts[0]?.copy ?? "")?.oid ?? ""), "remote edit");
});

test("a note edited here and deleted there keeps the edit, and says the other machine deleted it", async () => {
  const clone = await scenario({ "n.md": "a\n" }, { remove: ["n.md"] }, { write: { "n.md": "local edit\n" } });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts, [{ kind: "deleted-there", path: "n.md", copy: null }]);
  assert.equal(await blob(clone, tree.get("n.md")?.oid ?? ""), "local edit");
});

test("a note renamed differently on each side keeps both names", async () => {
  const clone = await scenario({ "n.md": TEXT }, { move: [["n.md", "r.md"]] }, { move: [["n.md", "l.md"]] });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts, [{ kind: "two-names", path: "l.md", copy: null, other: "r.md" }]);
  assert.deepEqual([...tree.keys()].sort(), ["l.md", "r.md"]);
});

test("a note renamed differently and edited on both sides keeps each side's own text under its name", async () => {
  const edited = (side: string): string => TEXT.replace("line two", `line two ${side}`);
  const clone = await scenario({ "n.md": TEXT }, { move: [["n.md", "r.md"]], write: { "r.md": edited("REMOTE") } }, { move: [["n.md", "l.md"]], write: { "l.md": edited("LOCAL") } });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts, [{ kind: "two-names", path: "l.md", copy: null, other: "r.md" }]);
  assert.equal(await blob(clone, tree.get("r.md")?.oid ?? ""), edited("REMOTE").trimEnd());
  assert.equal(await blob(clone, tree.get("l.md")?.oid ?? ""), edited("LOCAL").trimEnd());
  for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /^<{7}/m, "no conflict markers anywhere");
});

test("glob-shaped names in a rename/rename are looked up exactly", async () => {
  const edited = (side: string): string => TEXT.replace("line two", `line two ${side}`);
  const clone = await scenario(
    { "d/n.md": TEXT, "d/lx.md": "a different note\n", "d/rx.md": "another one\n" },
    { move: [["d/n.md", "d/r*.md"]], write: { "d/r*.md": edited("REMOTE") } },
    { move: [["d/n.md", "d/l*.md"]], write: { "d/l*.md": edited("LOCAL") } },
  );
  const { tree } = await resolved(clone);
  assert.equal(await blob(clone, tree.get("d/r*.md")?.oid ?? ""), edited("REMOTE").trimEnd());
  assert.equal(await blob(clone, tree.get("d/l*.md")?.oid ?? ""), edited("LOCAL").trimEnd());
  assert.equal(await blob(clone, tree.get("d/lx.md")?.oid ?? ""), "a different note");
});

test("a note renamed here and edited there, clashing: the local text keeps the new name, the remote text is the copy", async () => {
  const edited = (side: string): string => TEXT.replace("line two", `line two ${side}`);
  const clone = await scenario({ "n.md": TEXT }, { write: { "n.md": edited("REMOTE") } }, { move: [["n.md", "t.md"]], write: { "t.md": edited("LOCAL") } });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.kind, "both-changed");
  assert.equal(r.conflicts[0]?.path, "t.md");
  assert.equal(await blob(clone, tree.get("t.md")?.oid ?? ""), edited("LOCAL").trimEnd());
  assert.equal(await blob(clone, tree.get(r.conflicts[0]?.copy ?? "")?.oid ?? ""), edited("REMOTE").trimEnd());
  assert.equal(tree.has("n.md"), false);
});

test("renamed here and deleted there keeps the renamed note", async () => {
  const clone = await scenario({ "n.md": TEXT }, { remove: ["n.md"] }, { move: [["n.md", "l.md"]] });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts, [{ kind: "deleted-there", path: "l.md", copy: null }]);
  assert.deepEqual([...tree.keys()], ["l.md"]);
});

test("deleted here and renamed there stays deleted; the renamed version becomes the copy", async () => {
  const clone = await scenario({ "n.md": TEXT }, { move: [["n.md", "r.md"]] }, { remove: ["n.md"] });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.kind, "deleted-here");
  assert.equal(r.conflicts[0]?.path, "n.md");
  assert.ok(r.conflicts[0]?.copy?.startsWith("r.conflict-2026-09-22-0915-"), r.conflicts[0]?.copy ?? "");
  assert.equal(tree.has("r.md"), false);
  assert.equal(tree.size, 1);
});

test("deleted here and renamed there onto a name this machine also uses: the local note keeps the name, the renamed one is the copy", async () => {
  const clone = await scenario({ "n.md": TEXT }, { move: [["n.md", "r.md"]] }, { remove: ["n.md"], write: { "r.md": "a different local note\n" } });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts.map((c) => [c.kind, c.path]), [["both-changed", "r.md"]]);
  const copy = r.conflicts[0]?.copy ?? "";
  assert.ok(copy.startsWith("r.conflict-2026-09-22-0915-"), copy);
  assert.equal(await blob(clone, tree.get("r.md")?.oid ?? ""), "a different local note");
  assert.equal(await blob(clone, tree.get(copy)?.oid ?? ""), TEXT.trimEnd());
  assert.deepEqual([...tree.keys()].sort(), ["r.md", copy].sort());
  for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /^<{7}/m);
});

test("renamed here onto a name the other machine also added, deleted there: the renamed note keeps the name, the other note is the copy", async () => {
  const clone = await scenario({ "n.md": TEXT }, { remove: ["n.md"], write: { "r.md": "a different remote note\n" } }, { move: [["n.md", "r.md"]] });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts.map((c) => [c.kind, c.path]), [["both-changed", "r.md"]]);
  const copy = r.conflicts[0]?.copy ?? "";
  assert.ok(copy.startsWith("r.conflict-2026-09-22-0915-"), copy);
  assert.equal(await blob(clone, tree.get("r.md")?.oid ?? ""), TEXT.trimEnd());
  assert.equal(await blob(clone, tree.get(copy)?.oid ?? ""), "a different remote note");
  assert.deepEqual([...tree.keys()].sort(), ["r.md", copy].sort());
  for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /^<{7}/m);
});

test("a local file against a remote folder: the file keeps the path, the folder moves to a copy", async () => {
  const clone = await scenario({ "keep.md": "k\n" }, { write: { "p/n.md": "in dir\n" } }, { write: { p: "file\n" } });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.kind, "file-folder");
  const copy = r.conflicts[0]?.copy ?? "";
  assert.ok(copy.startsWith("p.conflict-2026-09-22-0915-"), copy);
  assert.equal(await blob(clone, tree.get("p")?.oid ?? ""), "file");
  assert.equal(await blob(clone, tree.get(`${copy}/n.md`)?.oid ?? ""), "in dir");
  assert.equal([...tree.keys()].some((p) => p.includes("~")), false, "git's ~side relocation is undone");
});

test("a local folder against a remote file: the folder keeps the path, the file becomes the copy", async () => {
  const clone = await scenario({ "keep.md": "k\n" }, { write: { p: "file\n" } }, { write: { "p/n.md": "in dir\n" } });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.kind, "file-folder");
  assert.equal(await blob(clone, tree.get("p/n.md")?.oid ?? ""), "in dir");
  assert.equal(await blob(clone, tree.get(r.conflicts[0]?.copy ?? "")?.oid ?? ""), "file");
  assert.equal([...tree.keys()].some((p) => p.includes("~")), false);
});

test("a local file against a remote symlink: the file keeps the path, the symlink is the copy", async () => {
  const clone = await scenario({ "n.md": "a\n" }, { link: { "n.md": "target" } }, { write: { "n.md": "local\n" } });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.kind, "type-differs");
  assert.equal(tree.get("n.md")?.mode, "100644");
  assert.equal(tree.get(r.conflicts[0]?.copy ?? "")?.mode, "120000");
  assert.equal([...tree.keys()].some((p) => p.includes("~")), false);
});

test("a note added to a folder the other machine renamed stays where it was added", async () => {
  const clone = await scenario({ "d/a.md": "x\n", "d/b.md": "y\n" }, { move: [["d", "e"]] }, { write: { "d/c.md": "new\n" } });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual([...tree.keys()].sort(), ["d/c.md", "e/a.md", "e/b.md"]);
});

test("a note that quotes conflict markers merges like any other note", async () => {
  const quote = "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n";
  const clone = await scenario({ "git.md": `intro\n${quote}` }, { write: { "git.md": `intro changed\n${quote}` } }, { write: { "other.md": "o\n" } });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts, []);
  assert.match(await blob(clone, tree.get("git.md")?.oid ?? ""), /<<<<<<< ours/);
});

test("a copy of the same version already in the folder is not added twice", async () => {
  const existing = `x/n.conflict-2026-09-20-0800-${"0".repeat(6)}.md`;
  const clone = await scenario({ "x/n.md": "a\n", [existing]: "remote\n" }, { write: { "x/n.md": "remote\n" } }, { write: { "x/n.md": "local\n" } });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.copy, existing);
  assert.equal([...tree.keys()].filter((p) => p.includes(".conflict-")).length, 1);
});

test("a copy name another note already has gets -2", async () => {
  const clone = await scenario({ "x/n.md": "a\n" }, { write: { "x/n.md": "remote\n" } }, { write: { "x/n.md": "local\n" } });
  const first = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
  assert.equal(first.kind, "clean");
  const name = (first as { conflicts: Array<{ copy: string | null }> }).conflicts[0]?.copy ?? "";
  const clone2 = await scenario({ "x/n.md": "a\n", [name]: "someone else's note\n" }, { write: { "x/n.md": "remote\n" } }, { write: { "x/n.md": "local\n" } });
  const { r } = await resolved(clone2);
  assert.equal(r.conflicts[0]?.copy, name.replace(/\.md$/, "-2.md"));
});

test("a submodule conflict stops with nothing resolved, naming the path", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  const fake = (n: string): string => n.repeat(40);
  const commitWith = async (oid: string, msg: string): Promise<void> => {
    await gitOk(["update-index", "--add", "--cacheinfo", `160000,${oid},sub`], { cwd: dir });
    await gitOk(["commit", "-q", "-m", msg], { cwd: dir });
  };
  await commitWith(fake("1"), "base");
  await gitOk(["branch", "base"], { cwd: dir });
  await gitOk(["checkout", "-q", "-B", "remote", "base"], { cwd: dir });
  await commitWith(fake("2"), "remote");
  await gitOk(["checkout", "-q", "-B", "local", "base"], { cwd: dir });
  await commitWith(fake("3"), "local");
  const clone = join(await tempDir(), "sync.git");
  await gitOk(["clone", "-q", "--bare", dir, clone], { cwd: dir });
  const r = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
  assert.equal(r.kind, "stop");
  assert.deepEqual((r as { paths: string[] }).paths, ["sub"]);
});

test("a merge driver named in a synced .gitattributes is never run", async () => {
  const clone = await scenario(
    { ".gitattributes": "*.md merge=evil\n", "n.md": "a\n" },
    { write: { "n.md": "remote\n" } },
    { write: { "n.md": "local\n" } },
  );
  await gitOk(["config", "merge.evil.driver", "echo EVIL > %A"], { cwd: clone });
  // Without attr.tree a bare repository reads no .gitattributes at all; with it
  // (a user can set it globally) git would run the synced driver.
  await gitOk(["config", "attr.tree", "HEAD"], { cwd: clone });
  const { tree } = await resolved(clone);
  for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /EVIL/);
});

type E = { mode: string; oid: string };
const e = (c: string, mode = "100644"): E => ({ mode, oid: c.repeat(40) });

test("the check holds a content conflict to git's records and the two commits, not to the resolution", () => {
  // x/n.md: remote version 1, local version 2, git's marker result 3; u.md and z.md unrelated.
  const facts = {
    records: [{ paths: ["x/n.md"], type: "Auto-merging" }, { paths: ["x/n.md"], type: "CONFLICT (contents)" }],
    stages: new Map([["x/n.md", { 1: e("4"), 2: e("1"), 3: e("2") }]]),
    result: new Map([["x/n.md", e("3")], ["u.md", e("5")], ["z.md", e("3")]]),
    remote: new Map([["x/n.md", e("1")], ["u.md", e("5")], ["z.md", e("3")]]),
    local: new Map([["x/n.md", e("2")], ["u.md", e("5")], ["z.md", e("3")]]),
  };
  const copy = "x/n.conflict-2026-09-22-0915-111111.md";
  const good: Array<[string, E]> = [["x/n.md", e("2")], [copy, e("1")], ["u.md", e("5")], ["z.md", e("3")]];
  const check = (written: Array<[string, E]>, resolution = written): string => checkResolved(new Map(written), new Map(resolution), facts).join("; ");
  assert.equal(check(good), "", "z.md holds the same bytes as git's marker result, and is someone's note");
  const without = (path: string): Array<[string, E]> => good.filter(([p]) => p !== path);
  assert.match(check(without(copy)), /x\/n\.md: a version \(111111111111\) was lost/);
  assert.match(check([...without(copy), ["y/n.md", e("1")]]), /was lost/, "the version at an unrelated path does not count");
  assert.match(
    check([["x/n.md", e("3")], [copy, e("1")], ["x/n.conflict-2026-09-22-0915-222222.md", e("2")], ["u.md", e("5")], ["z.md", e("3")]]),
    /x\/n\.md: git's merged result remains/,
  );
  assert.match(check([...without("u.md"), ["u.md", e("6")]]), /u\.md differs from git's merge/);
  assert.match(check(good, without(copy)), /the written tree differs from the resolution/);
});

test("the check holds a file/folder conflict to git's relocation and the folder that moves aside", () => {
  // Local file p (2) against a remote folder p/ (p/n.md, 1): git moved the file to p~local.
  const facts = {
    records: [{ paths: ["p~local", "p"], type: "CONFLICT (file/directory)" }],
    stages: new Map([["p~local", { 3: e("2") }]]),
    result: new Map([["p~local", e("2")], ["p/n.md", e("1")]]),
    remote: new Map([["p/n.md", e("1")]]),
    local: new Map([["p", e("2")]]),
  };
  const folder = "p.conflict-2026-09-22-0915-666666";
  const good: Array<[string, E]> = [["p", e("2")], [`${folder}/n.md`, e("1")]];
  const check = (written: Array<[string, E]>): string => checkResolved(new Map(written), new Map(written), facts).join("; ");
  assert.equal(check(good), "");
  assert.match(check([...good, ["p~local", e("2")]]), /p~local should be absent/);
  assert.match(check([["p", e("2")]]), /p\/n\.md was not moved with its folder/);
  assert.match(check([["p", e("2")], ["elsewhere/n.md", e("1")]]), /p\/n\.md was not moved with its folder/);
});

test("the check holds a conflict path inside a displaced folder to its own record, and rejects git's merged result at its moved place", () => {
  // q.md renamed to p/b.md there (remote's own text 1) and to z.md here (local's own
  // text 4), and a local file p (2) displaced the folder: git's result at both names
  // is its merge (3).
  const facts = {
    records: [
      { paths: ["p~local", "p"], type: "CONFLICT (file/directory)" },
      { paths: ["q.md", "p/b.md", "z.md"], type: "CONFLICT (rename/rename)" },
    ],
    stages: new Map([["p~local", { 3: e("2") }], ["q.md", { 1: e("9") }], ["p/b.md", { 2: e("3") }], ["z.md", { 3: e("3") }]]),
    result: new Map([["p~local", e("2")], ["p/b.md", e("3")], ["z.md", e("3")], ["keep.md", e("5")]]),
    remote: new Map([["p/b.md", e("1")], ["keep.md", e("5")]]),
    local: new Map([["p", e("2")], ["z.md", e("4")], ["keep.md", e("5")]]),
  };
  const folder = "p.conflict-2026-09-22-0915-666666";
  const good: Array<[string, E]> = [["p", e("2")], [`${folder}/b.md`, e("1")], ["z.md", e("4")], ["keep.md", e("5")]];
  const check = (written: Array<[string, E]>): string => checkResolved(new Map(written), new Map(written), facts).join("; ");
  assert.equal(check(good), "", "git's merge at p/b.md need not move with the folder: the remote's own note did");
  // git's merge moved with the folder in place of the remote's own note.
  const merged = check([["p", e("2")], [`${folder}/b.md`, e("3")], ["z.md", e("4")], ["keep.md", e("5")]]);
  assert.match(merged, /p\/b\.md: a version \(111111111111\) was lost/);
  assert.match(merged, /p\.conflict-2026-09-22-0915-666666\/b\.md: git's merged result remains/);
  // Every version kept, and git's merge at the note's place in a second copy of the folder.
  const other = "p.conflict-2026-09-22-0915-777777";
  assert.equal(check([...good, [`${other}/b.md`, e("3")]]), `${other}/b.md: git's merged result remains`);
});

// q.md renamed into p/ there as p/b.md (1), and a local file p (2) displaced the folder;
// the remote's untouched p/a.md (6) was removed here, so git's result lacks it. The
// records are real git's (2.50.1). Deleted here, git's result at p/b.md is the remote's note.
const renamedInDeletedHere: MergeFacts = {
  records: [
    { paths: ["p/b.md", "q.md"], type: "CONFLICT (rename/delete)" },
    { paths: ["p~local", "p"], type: "CONFLICT (file/directory)" },
  ],
  stages: new Map([["p/b.md", { 1: e("1"), 2: e("1") }], ["p~local", { 3: e("2") }]]),
  result: new Map([["p/b.md", e("1")], ["p~local", e("2")], ["keep.md", e("5")]]),
  remote: new Map([["p/b.md", e("1")], ["p/a.md", e("6")], ["keep.md", e("5")]]),
  local: new Map([["p", e("2")], ["keep.md", e("5")]]),
};
// Edited there (1) and renamed to z.md here (4, the base text): git's result at both
// names is the remote's edit.
const renamedInEditedThere: MergeFacts = {
  records: [
    { paths: ["p~local", "p"], type: "CONFLICT (file/directory)" },
    { paths: ["q.md", "p/b.md", "z.md"], type: "CONFLICT (rename/rename)" },
  ],
  stages: new Map([["p/b.md", { 2: e("1") }], ["p~local", { 3: e("2") }], ["q.md", { 1: e("4") }], ["z.md", { 3: e("1") }]]),
  result: new Map([["p/b.md", e("1")], ["p~local", e("2")], ["z.md", e("1")], ["keep.md", e("5")]]),
  remote: new Map([["p/b.md", e("1")], ["p/a.md", e("6")], ["keep.md", e("5")]]),
  local: new Map([["p", e("2")], ["z.md", e("4")], ["keep.md", e("5")]]),
};
const checkWith = (facts: MergeFacts, written: Array<[string, E]>): string => checkResolved(new Map(written), new Map(written), facts).join("; ");
const aside = "p.conflict-2026-09-22-0915-666666";
const notMoved = "p/b.md was not moved with its folder";

test("the check holds a note renamed into a displaced folder there and deleted here to the moved folder, not to a copy of its old name", () => {
  assert.equal(checkWith(renamedInDeletedHere, [["p", e("2")], [`${aside}/b.md`, e("1")], ["keep.md", e("5")]]), "", "p/a.md was never in git's result");
  assert.equal(checkWith(renamedInDeletedHere, [["p", e("2")], ["q.conflict-2026-09-22-0915-111111.md", e("1")], ["keep.md", e("5")]]), notMoved);
  // Were git's result to lack the note (not seen from real git), the remote's own note
  // would still have to move with the folder.
  const lacking = { ...renamedInDeletedHere, result: new Map([["p~local", e("2")], ["keep.md", e("5")]]) };
  assert.equal(checkWith(lacking, [["p", e("2")], ["q.conflict-2026-09-22-0915-111111.md", e("1")], ["keep.md", e("5")]]), notMoved);
});

test("the check holds a note renamed into a displaced folder and edited there, renamed elsewhere here, to the moved folder, not to a copy of its old name", () => {
  assert.equal(checkWith(renamedInEditedThere, [["p", e("2")], [`${aside}/b.md`, e("1")], ["z.md", e("4")], ["keep.md", e("5")]]), "");
  assert.equal(checkWith(renamedInEditedThere, [["p", e("2")], ["q.conflict-2026-09-22-0915-111111.md", e("1")], ["z.md", e("4")], ["keep.md", e("5")]]), notMoved);
});

test("the check holds a note renamed into a displaced folder and edited there, renamed elsewhere here, to the moved folder, not to a copy of this machine's name", () => {
  assert.equal(checkWith(renamedInEditedThere, [["p", e("2")], ["z.conflict-2026-09-22-0915-111111.md", e("1")], ["z.md", e("4")], ["keep.md", e("5")]]), notMoved);
});

test("the check rejects a displaced folder left in place while the local file moves to a copy", () => {
  const file = "p.conflict-2026-09-22-0915-222222";
  assert.equal(checkWith(renamedInDeletedHere, [["p/b.md", e("1")], [file, e("2")], ["keep.md", e("5")]]), notMoved);
  assert.equal(checkWith(renamedInEditedThere, [["p/b.md", e("1")], [file, e("2")], ["z.md", e("4")], ["keep.md", e("5")]]), notMoved);
});

test("a rename colliding with a new note, with content changed on both sides, keeps all three versions", async () => {
  const edited = (side: string): string => TEXT.replace("line two", `line two ${side}`);
  const clone = await scenario(
    { "old.md": TEXT, "keep.md": "k\n" },
    { move: [["old.md", "dest.md"]], write: { "dest.md": edited("REMOTE") } },
    { write: { "old.md": edited("LOCAL"), "dest.md": "an unrelated new note\n" } },
  );
  const { tree } = await resolved(clone);
  assert.equal(await blob(clone, tree.get("old.md")?.oid ?? ""), edited("LOCAL").trimEnd(), "the local edit stays at its path");
  assert.equal(await blob(clone, tree.get("dest.md")?.oid ?? ""), "an unrelated new note", "the local new note keeps its name");
  const copies = [...tree.keys()].filter((p) => p.startsWith("dest.conflict-"));
  assert.equal(copies.length, 1, [...tree.keys()].join(", "));
  assert.equal(await blob(clone, tree.get(copies[0] ?? "")?.oid ?? ""), edited("REMOTE").trimEnd(), "the remote renamed version is the copy");
  for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /^<{7}/m);
});

test("the mirrored collision (renamed and edited here, edited there, the other machine added the name) keeps all four versions", async () => {
  const edited = (side: string): string => TEXT.replace("line two", `line two ${side}`);
  const clone = await scenario(
    { "old.md": TEXT, "keep.md": "k\n" },
    { write: { "old.md": edited("REMOTE"), "dest.md": "an unrelated remote note\n" } },
    { move: [["old.md", "dest.md"]], write: { "dest.md": edited("LOCAL") } },
  );
  const { r, tree } = await resolved(clone);
  assert.equal(await blob(clone, tree.get("dest.md")?.oid ?? ""), edited("LOCAL").trimEnd(), "the local renamed note keeps its name");
  assert.equal(tree.has("old.md"), false, "renamed away here");
  const copyOf = (path: string): string => r.conflicts.find((c) => c.path === path)?.copy ?? "";
  assert.equal(await blob(clone, tree.get(copyOf("dest.md"))?.oid ?? ""), "an unrelated remote note");
  assert.equal(await blob(clone, tree.get(copyOf("old.md"))?.oid ?? ""), edited("REMOTE").trimEnd());
  for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /^<{7}/m);
});

test("a local file replacing a folder the other machine edited in: the whole remote folder moves aside, edit included", async () => {
  const clone = await scenario({ "p/a.md": "a\n", "keep.md": "k\n" }, { write: { "p/a.md": "a remote edit\n" } }, { remove: ["p"], write: { p: "file\n" } });
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts.map((c) => c.kind), ["file-folder"]);
  const folder = r.conflicts[0]?.copy ?? "";
  assert.equal(await blob(clone, tree.get("p")?.oid ?? ""), "file");
  assert.equal(await blob(clone, tree.get(`${folder}/a.md`)?.oid ?? ""), "a remote edit");
  assert.deepEqual([...tree.keys()].sort(), ["keep.md", "p", `${folder}/a.md`]);
});

test("a local file replacing the folder the other machine renamed a note into (deleted here): the note moves aside with the folder", async () => {
  const clone = await scenario(
    { "q.md": TEXT, "p/a.md": "a\n", "keep.md": "k\n" },
    { move: [["q.md", "p/b.md"]] },
    { remove: ["q.md", "p"], write: { p: "file\n" } },
  );
  const { r, tree } = await resolved(clone);
  assert.deepEqual(r.conflicts.map((c) => c.kind), ["file-folder"]);
  const folder = r.conflicts[0]?.copy ?? "";
  assert.ok(folder.startsWith("p.conflict-2026-09-22-0915-"), folder);
  assert.equal(await blob(clone, tree.get("p")?.oid ?? ""), "file");
  assert.equal(await blob(clone, tree.get(`${folder}/b.md`)?.oid ?? ""), TEXT.trimEnd());
  assert.deepEqual([...tree.keys()].sort(), ["keep.md", "p", `${folder}/b.md`]);
  for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /^<{7}/m);
});

test("a note renamed into a folder there and elsewhere here, with the folder replaced by a file here: each side keeps its name, the folder moves aside", async () => {
  const clone = await scenario(
    { "q.md": TEXT, "p/a.md": "a\n", "keep.md": "k\n" },
    { move: [["q.md", "p/b.md"]] },
    { move: [["q.md", "z.md"]], remove: ["p"], write: { p: "file\n" } },
  );
  const { r, tree } = await resolved(clone);
  const folder = r.conflicts.find((c) => c.kind === "file-folder")?.copy ?? "";
  assert.ok(folder.startsWith("p.conflict-2026-09-22-0915-"), folder);
  // The other name is where the remote's note now is: inside the folder's copy.
  assert.deepEqual(r.conflicts, [
    { kind: "file-folder", path: "p", copy: folder },
    { kind: "two-names", path: "z.md", copy: null, other: `${folder}/b.md` },
  ]);
  assert.equal(await blob(clone, tree.get("p")?.oid ?? ""), "file");
  assert.deepEqual(tree.get(`${folder}/b.md`), (await treeOf(clone, "remote")).get("p/b.md"));
  assert.deepEqual(tree.get("z.md"), (await treeOf(clone, "local")).get("z.md"));
  assert.deepEqual([...tree.keys()].sort(), [`${folder}/b.md`, "keep.md", "p", "z.md"].sort());
  for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /^<{7}/m);
});

test("the same renames with the note edited here, on both sides, or there: each side's own text under its name, nothing merged", async () => {
  const edited = (side: string): string => TEXT.replace("line two", `line two ${side}`);
  // git's result at both names is its rename/rename merge: the local edit, or markers
  // when both sides edited.
  for (const [label, remoteText, localText] of [
    ["edited here", TEXT, edited("LOCAL")],
    ["edited on both sides", edited("REMOTE"), edited("LOCAL")],
    ["edited there", edited("REMOTE"), TEXT],
  ] as const) {
    const clone = await scenario(
      { "q.md": TEXT, "p/a.md": "a\n", "keep.md": "k\n" },
      { move: [["q.md", "p/b.md"]], write: { "p/b.md": remoteText } },
      { move: [["q.md", "z.md"]], remove: ["p"], write: { p: "file\n", "z.md": localText } },
    );
    const r = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
    assert.equal(r.kind, "clean", `${label}: ${JSON.stringify(r)}`);
    const tree = await treeOf(clone, (r as { tree: string }).tree);
    const folder = (r as { conflicts: Array<{ kind: string; copy: string | null }> }).conflicts.find((c) => c.kind === "file-folder")?.copy ?? "";
    assert.ok(folder.startsWith("p.conflict-2026-09-22-0915-"), `${label}: ${folder}`);
    assert.equal(await blob(clone, tree.get("p")?.oid ?? ""), "file", label);
    assert.deepEqual(tree.get(`${folder}/b.md`), (await treeOf(clone, "remote")).get("p/b.md"), label);
    assert.deepEqual(tree.get("z.md"), (await treeOf(clone, "local")).get("z.md"), label);
    assert.equal(await blob(clone, tree.get(`${folder}/b.md`)?.oid ?? ""), remoteText.trimEnd(), label);
    assert.equal(await blob(clone, tree.get("z.md")?.oid ?? ""), localText.trimEnd(), label);
    assert.deepEqual([...tree.keys()].sort(), [`${folder}/b.md`, "keep.md", "p", "z.md"].sort(), label);
    for (const [, entry] of tree) assert.doesNotMatch(await blob(clone, entry.oid), /^<{7}/m, label);
  }
});

test("a note renamed into a folder here and elsewhere there, with the folder replaced by a file there: the folder and both names stay", async () => {
  const clone = await scenario(
    { "q.md": TEXT, "p/a.md": "a\n", "keep.md": "k\n" },
    { move: [["q.md", "z.md"]], remove: ["p"], write: { p: "file\n" } },
    { move: [["q.md", "p/b.md"]] },
  );
  const { r, tree } = await resolved(clone);
  const copy = r.conflicts.find((c) => c.kind === "file-folder")?.copy ?? "";
  assert.ok(copy.startsWith("p.conflict-2026-09-22-0915-"), copy);
  assert.deepEqual(r.conflicts, [
    { kind: "file-folder", path: "p", copy },
    { kind: "two-names", path: "p/b.md", copy: null, other: "z.md" },
  ]);
  assert.equal(await blob(clone, tree.get(copy)?.oid ?? ""), "file");
  assert.deepEqual(tree.get("p/b.md"), (await treeOf(clone, "local")).get("p/b.md"));
  assert.deepEqual(tree.get("z.md"), (await treeOf(clone, "remote")).get("z.md"));
  assert.deepEqual([...tree.keys()].sort(), [copy, "keep.md", "p/b.md", "z.md"].sort());
});

test("a remote file replacing a folder edited here: the local folder keeps its notes, the file becomes the copy", async () => {
  const clone = await scenario({ "p/a.md": "a\n", "keep.md": "k\n" }, { remove: ["p"], write: { p: "file\n" } }, { write: { "p/a.md": "a local edit\n" } });
  const { r, tree } = await resolved(clone);
  assert.equal(await blob(clone, tree.get("p/a.md")?.oid ?? ""), "a local edit");
  const copy = r.conflicts.find((c) => c.kind === "file-folder")?.copy ?? "";
  assert.equal(await blob(clone, tree.get(copy)?.oid ?? ""), "file");
  assert.equal([...tree.keys()].some((p) => p.includes("~")), false);
});

test("a conflicting edit to a note inside a folder the other machine renamed keeps both versions", async () => {
  const edited = (side: string): string => TEXT.replace("line two", `line two ${side}`);
  const clone = await scenario(
    { "d/a.md": TEXT, "d/b.md": "b\n" },
    { move: [["d", "e"]] , write: { "e/a.md": edited("REMOTE") } },
    { write: { "d/a.md": edited("LOCAL") } },
  );
  const { r, tree } = await resolved(clone);
  // git follows the note's own rename, d/a.md to e/a.md, and merges it there.
  assert.deepEqual(r.conflicts.map((c) => [c.kind, c.path]), [["both-changed", "e/a.md"]]);
  const copy = r.conflicts[0]?.copy ?? "";
  assert.ok(copy.startsWith("e/a.conflict-2026-09-22-0915-"), copy);
  assert.equal(await blob(clone, tree.get("e/a.md")?.oid ?? ""), edited("LOCAL").trimEnd());
  assert.equal(await blob(clone, tree.get(copy)?.oid ?? ""), edited("REMOTE").trimEnd());
  assert.deepEqual([...tree.keys()].sort(), [copy, "e/a.md", "e/b.md"].sort());
});

test("a local file against a remote folder of several notes moves every note of the folder", async () => {
  const clone = await scenario({ "keep.md": "k\n" }, { write: { "p/a.md": "a\n", "p/sub/b.md": "b\n", "p/c.md": "c\n" } }, { write: { p: "file\n" } });
  const { r, tree } = await resolved(clone);
  const folder = r.conflicts[0]?.copy ?? "";
  for (const [rel, text] of [["a.md", "a"], ["sub/b.md", "b"], ["c.md", "c"]]) assert.equal(await blob(clone, tree.get(`${folder}/${rel}`)?.oid ?? ""), text);
  assert.equal(await blob(clone, tree.get("p")?.oid ?? ""), "file");
});

test("two new entries of different kinds at one path (git moves the local one aside): the local one keeps the path", async () => {
  const clone = await scenario({ "keep.md": "k\n" }, { link: { "n.md": "target" } }, { write: { "n.md": "local\n" } });
  const { r, tree } = await resolved(clone);
  assert.equal(r.conflicts[0]?.kind, "type-differs");
  assert.equal(tree.get("n.md")?.mode, "100644");
  assert.equal(tree.get(r.conflicts[0]?.copy ?? "")?.mode, "120000");
  assert.equal([...tree.keys()].some((p) => p.includes("~")), false);
});

// Runs fn with a git on PATH that rewrites merge-tree's raw output (NULs and all):
// records git cannot be made to emit here (folder-rename detection is off, and no
// conflict of a notes vault names no path). A rewrite that matches nothing fails.
async function withRewrittenMergeTree(from: string, to: string, fn: () => Promise<void>): Promise<void> {
  const dir = await tempDir();
  const real = (await gitOk(["--exec-path"], { cwd: dir })) + "/git";
  const script = [
    `#!${process.execPath}`,
    `const { spawnSync } = require("node:child_process");`,
    `const args = process.argv.slice(2);`,
    `const r = spawnSync(${JSON.stringify(real)}, args, { stdio: ["inherit", "pipe", "inherit"], maxBuffer: 1 << 30 });`,
    `let out = r.stdout.toString("latin1");`,
    `if (args.includes("merge-tree")) {`,
    `  if (!out.includes(${JSON.stringify(from)})) { process.stderr.write("rewrite matched nothing"); process.exit(99); }`,
    `  out = out.split(${JSON.stringify(from)}).join(${JSON.stringify(to)});`,
    `}`,
    `process.stdout.write(Buffer.from(out, "latin1"));`,
    `process.exitCode = r.status ?? 1;`,
  ].join("\n");
  await writeFile(join(dir, "git"), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    await fn();
  } finally {
    process.env.PATH = path;
  }
}

test("a record type no rule covers stops the cycle, including ones git spells without a space or as information", async () => {
  for (const [from, to] of [
    ["CONFLICT (contents)", "CONFLICT(directory rename collision)"],
    ["CONFLICT (contents)", "CONFLICT(directory rename unclear split)"],
    ["Auto-merging", "Path updated due to directory rename"],
  ]) {
    const clone = await scenario({ "x/n.md": "a\n" }, { write: { "x/n.md": "remote\n" } }, { write: { "x/n.md": "local\n" } });
    let r: Resolution | undefined;
    await withRewrittenMergeTree(`\0${from}\0`, `\0${to}\0`, async () => {
      r = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
    });
    assert.equal(r?.kind, "stop", `${to}: ${JSON.stringify(r)}`);
    assert.match((r as { reason: string }).reason, new RegExp(`git reported ${(to ?? "").replace(/[()]/g, "\\$&")}`));
  }
});

test("a record type no rule covers stops the cycle even when a collision or a folder moved aside covers its paths", async () => {
  const edited = (side: string): string => TEXT.replace("line two", `line two ${side}`);
  const cases: Array<{ clone: () => Promise<string>; from: string; to: string }> = [
    {
      // The add/add record at dest.md, a path of the rename collision.
      clone: () => scenario(
        { "old.md": TEXT, "keep.md": "k\n" },
        { move: [["old.md", "dest.md"]], write: { "dest.md": edited("REMOTE") } },
        { write: { "old.md": edited("LOCAL"), "dest.md": "an unrelated new note\n" } },
      ),
      from: "CONFLICT (contents)",
      to: "CONFLICT(directory rename collision)",
    },
    {
      // The modify/delete record at p/a.md, inside the folder the local file p displaces.
      clone: () => scenario({ "p/a.md": "a\n", "keep.md": "k\n" }, { write: { "p/a.md": "a remote edit\n" } }, { remove: ["p"], write: { p: "file\n" } }),
      from: "CONFLICT (modify/delete)",
      to: "CONFLICT(directory rename unclear split)",
    },
    {
      // The rename/delete record at p/b.md (inside that folder) and q.md (in neither commit).
      clone: () => scenario({ "q.md": TEXT, "p/a.md": "a\n", "keep.md": "k\n" }, { move: [["q.md", "p/b.md"]] }, { remove: ["q.md", "p"], write: { p: "file\n" } }),
      from: "CONFLICT (rename/delete)",
      to: "Path updated due to directory rename",
    },
  ];
  for (const { clone: make, from, to } of cases) {
    const clone = await make();
    let r: Resolution | undefined;
    await withRewrittenMergeTree(`\0${from}\0`, `\0${to}\0`, async () => {
      r = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
    });
    assert.equal(r?.kind, "stop", `${to}: ${JSON.stringify(r)}`);
    assert.match((r as { reason: string }).reason, new RegExp(`git reported ${to.replace(/[()]/g, "\\$&")}, which the plugin cannot resolve`));
  }
});

test("a conflict that names no path stops the cycle", async () => {
  const clone = await scenario({ "x/n.md": "a\n" }, { write: { "x/n.md": "remote\n" } }, { write: { "x/n.md": "local\n" } });
  let r: Resolution | undefined;
  await withRewrittenMergeTree("\x001\0x/n.md\0CONFLICT (contents)\0", "\x000\0CONFLICT (contents)\0", async () => {
    r = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
  });
  assert.equal(r?.kind, "stop", JSON.stringify(r));
  assert.match((r as { reason: string }).reason, /without a path/);
});

test("a rename/delete onto a name both sides hold stops when no content record names that name", async () => {
  const clone = await scenario({ "n.md": TEXT }, { move: [["n.md", "r.md"]] }, { remove: ["n.md"], write: { "r.md": "a different local note\n" } });
  let r: Resolution | undefined;
  // git's add/add record at r.md now names the old path instead.
  await withRewrittenMergeTree("\x001\0r.md\0CONFLICT (contents)\0", "\x001\0n.md\0CONFLICT (contents)\0", async () => {
    r = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
  });
  assert.equal(r?.kind, "stop", JSON.stringify(r));
  assert.match((r as { reason: string }).reason, /rename\/delete\) with an unexpected pair of versions/);
  assert.deepEqual((r as { paths: string[] }).paths, ["r.md", "n.md"]);
});

test("a record naming only paths neither commit holds is not resolved by a folder move it has no path in", async () => {
  const clone = await scenario({ "q.md": TEXT, "p/a.md": "a\n", "keep.md": "k\n" }, { move: [["q.md", "p/b.md"]] }, { remove: ["q.md", "p"], write: { p: "file\n" } });
  let r: Resolution | undefined;
  // git's rename/delete record now names zz.md, outside the folder p/ the local file displaces.
  await withRewrittenMergeTree("\x002\0p/b.md\0q.md\0CONFLICT (rename/delete)\0", "\x002\0zz.md\0q.md\0CONFLICT (rename/delete)\0", async () => {
    r = await mergeAndResolve(clone, "remote", "local", { when: WHEN });
  });
  assert.equal(r?.kind, "stop", JSON.stringify(r));
  assert.match((r as { reason: string }).reason, /rename\/delete\) with an unexpected pair of versions/);
  assert.deepEqual((r as { paths: string[] }).paths, ["zz.md", "q.md"]);
});

test("the check stops a merge whose written tree lost a version", async () => {
  const clone = await scenario({ "x/n.md": "a\n" }, { write: { "x/n.md": "remote\n" } }, { write: { "x/n.md": "local\n" } });
  const r = await mergeAndResolve(clone, "remote", "local", {
    when: WHEN,
    // A tree writer that drops the copy it was asked to write.
    writeTree: async (c, base, from, to) => writeResolved(c, base, from, new Map([...to].filter(([p]) => !p.includes(".conflict-")))),
  });
  assert.equal(r.kind, "stop");
  assert.match((r as { reason: string }).reason, /failed its check/);
});
