import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { git, GitError, gitOk } from "../../core/git.ts";
import { fold } from "../../core/sync/copies.ts";
import { clearInterrupted, finishInterrupted, recordIntent, recordInterrupted } from "../../core/sync/recovery.ts";
import { commitFile, initRepo, sleep, tempDir, writeRel } from "./helpers.ts";

interface Interruption {
  // false: the process died before it could fingerprint (only the intent is recorded).
  prints?: boolean;
  // true: the hang outlasts the kill, so the recovery's own checkout hangs too.
  stillSlow?: boolean;
}

// A live repo whose update from -> to is killed while a smudge filter hangs, recorded
// as the cycle records it: the intent before the update, the fingerprints after the kill.
async function interrupted(extra: Record<string, string> = {}, how: Interruption = {}): Promise<{ dir: string; state: string; from: string; to: string }> {
  const dir = await tempDir();
  await initRepo(dir);
  const from = await commitFile(dir, "x/a.md", "old\n", "old");
  for (const [rel, content] of Object.entries(extra)) await writeRel(dir, rel, content);
  await writeRel(dir, "x/a.md", "new\n");
  await gitOk(["add", "-A"], { cwd: dir });
  await gitOk(["commit", "-q", "-m", "new"], { cwd: dir });
  const to = await gitOk(["rev-parse", "HEAD"], { cwd: dir });
  await gitOk(["reset", "-q", "--hard", from], { cwd: dir });
  await gitOk(["config", "filter.slow.smudge", "sleep 10; cat"], { cwd: dir });
  await writeFile(join(dir, ".git", "info", "attributes"), "*.md filter=slow\n");
  const state = await tempDir();
  await recordIntent(state, from, to);
  const r = await git(["reset", "-q", "--keep", to], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  if (how.prints !== false) await recordInterrupted(state, dir, from, to);
  // Usually the hang was transient: the recovery's own checkout runs the filter normally.
  if (!how.stillSlow) await gitOk(["config", "--unset", "filter.slow.smudge"], { cwd: dir });
  return { dir, state, from, to };
}

const head = (dir: string): Promise<string> => gitOk(["rev-parse", "HEAD"], { cwd: dir });
const status = (dir: string): Promise<string> => gitOk(["status", "--porcelain"], { cwd: dir });
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

// A new vault's two commits: `before`, then `after` on top of it (null removes a path
// first, so a note can become a folder and back). `config` is set before either.
// The vault is left at the first.
async function history(
  before: Record<string, string>,
  after: Record<string, string | null>,
  config: Record<string, string> = {},
): Promise<{ dir: string; from: string; to: string }> {
  const dir = await tempDir();
  await initRepo(dir);
  for (const [key, value] of Object.entries(config)) await gitOk(["config", key, value], { cwd: dir });
  for (const [rel, content] of Object.entries(before)) await writeRel(dir, rel, content);
  await gitOk(["add", "-A"], { cwd: dir });
  await gitOk(["commit", "-q", "-m", "old"], { cwd: dir });
  const from = await head(dir);
  for (const [rel, content] of Object.entries(after)) if (content === null) await gitOk(["rm", "-q", "-r", "--", rel], { cwd: dir });
  for (const [rel, content] of Object.entries(after)) if (content !== null) await writeRel(dir, rel, content);
  await gitOk(["add", "-A"], { cwd: dir });
  await gitOk(["commit", "-q", "-m", "new"], { cwd: dir });
  const to = await head(dir);
  await gitOk(["reset", "-q", "--hard", from], { cwd: dir });
  return { dir, from, to };
}

// The live update from -> to, killed while the smudge filter of the paths `slow`
// matches hangs, and recorded as the cycle records it. Returns the state directory.
async function killUpdate(dir: string, from: string, to: string, how: { slow?: string; prints?: boolean } = {}): Promise<string> {
  await gitOk(["config", "filter.slow.smudge", "sleep 10; cat"], { cwd: dir });
  await writeFile(join(dir, ".git", "info", "attributes"), `${how.slow ?? "*.md"} filter=slow\n`);
  const state = await tempDir();
  await recordIntent(state, from, to);
  assert.equal((await git(["reset", "-q", "--keep", to], { cwd: dir, timeoutMs: 500 })).timedOut, true);
  if (how.prints !== false) await recordInterrupted(state, dir, from, to);
  await gitOk(["config", "--unset", "filter.slow.smudge"], { cwd: dir });
  return state;
}

// Waits for a marker a filter writes, which says how far a repair got.
async function until(ready: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error("the repair never got that far");
    await sleep(20);
  }
}

// A smudge filter that says when it started and holds the repair's checkout until
// told to go on; then it passes the content through (or fails, if `fails`).
async function gate(dir: string, fails = false): Promise<{ started: string; go: string }> {
  const marks = await tempDir();
  const started = join(marks, "started");
  const go = join(marks, "go");
  const finish = fails ? "exit 1" : "cat";
  await gitOk(["config", "filter.gate.smudge", `touch '${started}'; while [ ! -e '${go}' ]; do sleep 0.05; done; ${finish}`], { cwd: dir });
  await gitOk(["config", "filter.gate.required", "true"], { cwd: dir });
  return { started, go };
}

test("a path nobody touched since the kill goes back to the old version, cleanly", async () => {
  const w = await interrupted();
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: ["x/a.md"], kept: [], moved: false });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "old\n");
  assert.equal(await head(w.dir), w.from);
  assert.equal(await status(w.dir), "", "HEAD, index and files agree again");
  assert.equal(await finishInterrupted(w.state, w.dir), null, "the record is gone");
});

test("a path the user changed after the kill is kept as it is", async () => {
  const w = await interrupted();
  await writeFile(join(w.dir, "x/a.md"), "the user's edit\n");
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: [], kept: ["x/a.md"], moved: false });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "the user's edit\n");
});

test("a file the interrupted update had already created is removed with the rest of the update", async () => {
  // Sorted before x/a.md and outside the slow filter: fully written before the hang.
  const w = await interrupted({ "x/0new.txt": "brand new\n" });
  assert.equal(await exists(join(w.dir, "x/0new.txt")), true, "the update got this far");
  const done = await finishInterrupted(w.state, w.dir);
  assert.ok(done?.restored.includes("x/0new.txt"), JSON.stringify(done));
  assert.equal(await exists(join(w.dir, "x/0new.txt")), false);
  assert.equal(await status(w.dir), "");
});

test("an update that had in fact finished is left alone", async () => {
  const w = await interrupted();
  await gitOk(["reset", "-q", "--hard", w.to], { cwd: w.dir });
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: [], kept: [], moved: false });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "new\n");
});

test("when the history moved since (git by hand), nothing is touched", async () => {
  const w = await interrupted();
  await gitOk(["commit", "-q", "--allow-empty", "-m", "by hand"], { cwd: w.dir });
  // The kill left x/a.md as it left it (here: unlinked, not yet rewritten).
  const read = (): Promise<string | null> => readFile(join(w.dir, "x/a.md"), "utf8").catch(() => null);
  const before = await read();
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: [], kept: [], moved: true });
  assert.equal(await read(), before);
});

test("an update whose fingerprints were never taken (the process died) sets back what is git's and keeps what is not", async () => {
  const w = await interrupted({ "x/0new.txt": "brand new\n", "x/1mine.txt": "from the update\n" }, { prints: false });
  // After the kill: x/0new.txt and x/1mine.txt written in full, x/a.md unlinked (its
  // smudge was hanging). Then the user writes their own text over x/1mine.txt.
  await writeFile(join(w.dir, "x/1mine.txt"), "the user's own text\n");
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: ["x/0new.txt", "x/a.md"], kept: ["x/1mine.txt"], moved: false });
  assert.equal(await exists(join(w.dir, "x/0new.txt")), false, "the update's own new file goes");
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "old\n", "a file the update had unlinked comes back");
  assert.equal(await readFile(join(w.dir, "x/1mine.txt"), "utf8"), "the user's own text\n");
  assert.equal(await head(w.dir), w.from);
});

test("a repair that times out saves where it got to: the next run finishes, and nothing it set back is taken for an edit", async () => {
  const w = await interrupted({ "x/0new.txt": "brand new\n" }, { stillSlow: true });
  await assert.rejects(finishInterrupted(w.state, w.dir, { timeoutMs: 500 }), /x\/a\.md|timed out/);
  await gitOk(["config", "--unset", "filter.slow.smudge"], { cwd: w.dir });
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: ["x/0new.txt", "x/a.md"], kept: [], moved: false });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "old\n");
  assert.equal(await status(w.dir), "");
});

test("a HEAD that cannot be read leaves the record for the next run, never read as history that moved", async () => {
  const w = await interrupted();
  const headFile = join(w.dir, ".git", "HEAD");
  const saved = await readFile(headFile, "utf8");
  await writeFile(headFile, "ref: refs/heads/no-such-branch\n");
  await assert.rejects(finishInterrupted(w.state, w.dir));
  await writeFile(headFile, saved);
  assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["x/a.md"], kept: [], moved: false });
});

test("a note the user saves while a slow repair runs is kept: the old version is built aside and put in place only if the path is untouched", async () => {
  const w = await interrupted();
  // The save lands while the old version is being built: after the first check, before the last.
  const { started, go } = await gate(w.dir);
  await writeFile(join(w.dir, ".git", "info", "attributes"), "*.md filter=gate\n");
  const finishing = finishInterrupted(w.state, w.dir);
  finishing.catch(() => undefined);
  await until(() => exists(started));
  await writeFile(join(w.dir, "x/a.md"), "saved during the repair\n");
  await writeFile(go, "");
  const done = await finishing;
  assert.deepEqual(done, { restored: [], kept: ["x/a.md"], moved: false });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "saved during the repair\n");
  assert.equal(await exists(join(w.dir, ".git", "index.lock")), false);
});

test("an update that turned a note into a folder, killed after making the folder, gets the note back", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await commitFile(dir, "x/p", "the note\n", "a note");
  const from = await commitFile(dir, "x/z.md", "old\n", "old");
  await gitOk(["rm", "-q", "x/p"], { cwd: dir });
  await writeRel(dir, "x/p/b.txt", "in the new folder\n");
  await writeRel(dir, "x/z.md", "new\n");
  await gitOk(["add", "-A"], { cwd: dir });
  await gitOk(["commit", "-q", "-m", "new"], { cwd: dir });
  const to = await gitOk(["rev-parse", "HEAD"], { cwd: dir });
  await gitOk(["reset", "-q", "--hard", from], { cwd: dir });
  await gitOk(["config", "filter.slow.smudge", "sleep 10; cat"], { cwd: dir });
  await writeFile(join(dir, ".git", "info", "attributes"), "*.md filter=slow\n");
  const state = await tempDir();
  await recordIntent(state, from, to);
  assert.equal((await git(["reset", "-q", "--keep", to], { cwd: dir, timeoutMs: 500 })).timedOut, true);
  assert.equal(await readFile(join(dir, "x/p/b.txt"), "utf8"), "in the new folder\n", "the kill came after the folder was made");
  await recordInterrupted(state, dir, from, to);
  await gitOk(["config", "--unset", "filter.slow.smudge"], { cwd: dir });
  const done = await finishInterrupted(state, dir);
  assert.deepEqual(done, { restored: ["x/p/b.txt", "x/p", "x/z.md"], kept: [], moved: false });
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the note\n");
  assert.equal(await status(dir), "");
});

test("a repair runs none of the vault's hooks (it is not the user's checkout)", async () => {
  const w = await interrupted();
  const marker = join(w.dir, "..", `hook-ran-${Date.now()}`);
  await writeFile(join(w.dir, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["x/a.md"], kept: [], moved: false });
  assert.equal(await exists(marker), false);
});

test("a cleared record leaves nothing to finish, and clearing when there is none is no error", async () => {
  const w = await interrupted();
  await clearInterrupted(w.state);
  assert.equal(await finishInterrupted(w.state, w.dir), null);
  await clearInterrupted(w.state);
});

test("an update whose intent alone was recorded, with the vault untouched, leaves the vault as it was and clears the record", async () => {
  const { dir, from, to } = await history({ "x/a.md": "old\n" }, { "x/0new.txt": "brand new\n", "x/a.md": "new\n" });
  const state = await tempDir();
  await recordIntent(state, from, to); // and the process died
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/0new.txt", "x/a.md"], kept: [], moved: false });
  assert.equal(await readFile(join(dir, "x/a.md"), "utf8"), "old\n");
  assert.equal(await exists(join(dir, "x/0new.txt")), false);
  assert.equal(await status(dir), "");
  assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
});

test("an update that never started, turning a note into a folder, leaves the note as it was", async () => {
  const { dir, from, to } = await history(
    { "x/p": "the note\n", "x/z.md": "old\n" },
    { "x/p": null, "x/p/b.txt": "in the new folder\n", "x/z.md": "new\n" },
  );
  const state = await tempDir();
  await recordIntent(state, from, to); // and the process died
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/b.txt", "x/p", "x/z.md"], kept: [], moved: false });
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the note\n");
  assert.equal(await status(dir), "");
  assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
});

test("an update that turned a folder into a note, killed after writing the note: the user's edit of it is kept and sync goes on", async () => {
  const { dir, from, to } = await history(
    { "x/p/b.txt": "in the folder\n", "x/z.md": "old\n" },
    { "x/p/b.txt": null, "x/p": "the new note\n", "x/z.md": "new\n" },
  );
  const state = await killUpdate(dir, from, to);
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the new note\n", "the kill came after the note was written");
  await writeFile(join(dir, "x/p"), "the user's edit\n");
  // x/p/b.txt cannot come back without removing the user's note, where its folder was.
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/z.md"], kept: ["x/p", "x/p/b.txt"], moved: false });
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the user's edit\n");
  assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
});

test("a note the user adds in the folder the update made is kept, and the folder with it", async () => {
  const { dir, from, to } = await history(
    { "x/p": "the note\n", "x/z.md": "old\n" },
    { "x/p": null, "x/p/b.txt": "in the new folder\n", "x/z.md": "new\n" },
  );
  const state = await killUpdate(dir, from, to);
  assert.equal(await readFile(join(dir, "x/p/b.txt"), "utf8"), "in the new folder\n", "the kill came after the folder was made");
  await writeFile(join(dir, "x/p/mine.txt"), "the user's note\n");
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/b.txt", "x/z.md"], kept: ["x/p"], moved: false });
  assert.equal(await readFile(join(dir, "x/p/mine.txt"), "utf8"), "the user's note\n");
  assert.equal(await exists(join(dir, "x/p/b.txt")), false, "the update's own file goes");
  assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
});

test("an update stopped before it wrote anything, turning a folder into a note, leaves the folder as it was", async () => {
  const { dir, from, to } = await history(
    { "x/p/b.txt": "in the folder\n", "x/z.md": "old\n" },
    { "x/p/b.txt": null, "x/p": "the new note\n", "x/z.md": "new\n" },
  );
  const state = await tempDir();
  await recordIntent(state, from, to);
  await recordInterrupted(state, dir, from, to); // killed before it had written anything
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p", "x/p/b.txt", "x/z.md"], kept: [], moved: false });
  assert.equal(await readFile(join(dir, "x/p/b.txt"), "utf8"), "in the folder\n");
  assert.equal(await status(dir), "");
  assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
});

test("a note the update turned into nested folders comes back: a removal takes the folders it empties, as git's own does", async () => {
  const { dir, from, to } = await history(
    { "x/p": "the note\n", "x/z.md": "old\n" },
    { "x/p": null, "x/p/q/c.txt": "deep in the new folder\n", "x/z.md": "new\n" },
  );
  const state = await killUpdate(dir, from, to);
  assert.equal(await exists(join(dir, "x/p/q/c.txt")), true, "the kill came after the folders were made");
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/q/c.txt", "x/p", "x/z.md"], kept: [], moved: false });
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the note\n");
  assert.equal(await status(dir), "");
});

test("a removal that finds nothing to remove leaves the folders around it alone, even an empty one the user made", async () => {
  const { dir, from, to } = await history({ "x/a.md": "old\n" }, { "Inbox/new.md": "brand new\n", "x/a.md": "new\n" });
  await mkdir(join(dir, "Inbox"));
  const state = await tempDir();
  await recordIntent(state, from, to); // and the process died
  assert.notEqual(await finishInterrupted(state, dir), null);
  assert.equal((await stat(join(dir, "Inbox"))).isDirectory(), true, "the user's empty folder is still there");
  assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
});

// The update turned note x/p into x/p/q/c.txt, and was killed after writing it.
const noteIntoDeepFolders = (): Promise<{ dir: string; from: string; to: string }> =>
  history({ "x/p": "the note\n", "x/z.md": "old\n" }, { "x/p": null, "x/p/q/c.txt": "deep in the new folder\n", "x/z.md": "new\n" });

for (const prints of [true, false]) {
  test(`a note whose path holds only empty folders comes back: the empty tree goes (${prints ? "with" : "without"} fingerprints)`, async () => {
    const { dir, from, to } = await noteIntoDeepFolders();
    const state = await killUpdate(dir, from, to, { prints });
    // Gone, its folders left: a repair that died between the unlink and the prune, or the user's deletion.
    await unlink(join(dir, "x/p/q/c.txt"));
    const done = await finishInterrupted(state, dir);
    assert.deepEqual(done, prints ? { restored: ["x/p", "x/z.md"], kept: ["x/p/q/c.txt"], moved: false } : { restored: ["x/p/q/c.txt", "x/p", "x/z.md"], kept: [], moved: false });
    assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the note\n");
    assert.equal(await status(dir), "");
    assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
  });
}

test("a note whose path holds a user's file deeper down is kept, and everything of theirs in it stays as it was", async () => {
  const { dir, from, to } = await noteIntoDeepFolders();
  const state = await killUpdate(dir, from, to);
  await writeFile(join(dir, "x/p/q/mine.txt"), "the user's note\n");
  await mkdir(join(dir, "x/p/q/r"));
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/q/c.txt", "x/z.md"], kept: ["x/p"], moved: false });
  assert.equal(await readFile(join(dir, "x/p/q/mine.txt"), "utf8"), "the user's note\n");
  assert.equal((await stat(join(dir, "x/p/q/r"))).isDirectory(), true, "their empty folder beside it stays too");
  assert.equal(await exists(join(dir, "x/p/q/c.txt")), false, "the update's own file goes");
});

test("a file saved into the empty tree while the repair clears it keeps the path: the tree goes by rmdir alone, never a recursive removal", async () => {
  const { dir, from, to } = await noteIntoDeepFolders();
  const state = await killUpdate(dir, from, to);
  await unlink(join(dir, "x/p/q/c.txt"));
  // Real git cannot time a save into the gap between reading the tree and removing
  // it: the save lands as soon as the repair has read the deepest folder empty.
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const real = fsp.readdir;
  const late = join(dir, "x/p/q/late.md");
  fsp.readdir = (async (path: string, ...rest: unknown[]) => {
    const names = await (real as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    if (path === join(dir, "x/p/q") && !(await exists(late))) await writeFile(late, "saved meanwhile\n");
    return names;
  }) as unknown as typeof real;
  syncBuiltinESMExports();
  let done;
  try {
    done = await finishInterrupted(state, dir);
  } finally {
    fsp.readdir = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(done, { restored: ["x/z.md"], kept: ["x/p/q/c.txt", "x/p"], moved: false });
  assert.equal(await readFile(late, "utf8"), "saved meanwhile\n");
});

test("a repair stopped after the emptied folder went, before the note came back, gets the note back next time", async () => {
  const { dir, from, to } = await history(
    { "x/p": "the note\n", "x/z.md": "old\n" },
    { "x/p": null, "x/p/b.txt": "in the new folder\n", "x/z.md": "new\n" },
  );
  const state = await killUpdate(dir, from, to);
  // Real git cannot make the disk refuse one rename: swap node's rename, which every
  // module's import of it follows (syncBuiltinESMExports), for this one path.
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const rename = fsp.rename;
  fsp.rename = async (source, dest) => {
    if (dest === join(dir, "x/p")) throw Object.assign(new Error("the disk refused the rename"), { code: "EIO" });
    return rename(source, dest);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(finishInterrupted(state, dir), /the disk refused the rename/);
  } finally {
    fsp.rename = rename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/b.txt", "x/p", "x/z.md"], kept: [], moved: false });
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the note\n");
  assert.equal(await status(dir), "");
});

test("a repair writes the old version through the filters the vault's committed .gitattributes name", async () => {
  const { dir, from, to } = await history(
    { ".gitattributes": "*.md filter=mark\n", "x/a.md": "old\n", "x/z.txt": "old\n" },
    { "x/a.md": "new\n", "x/z.txt": "new\n" },
    { "filter.mark.smudge": "sed 's/^/SMUDGED:/'", "filter.mark.clean": "sed 's/^SMUDGED://'" },
  );
  assert.equal(await readFile(join(dir, "x/a.md"), "utf8"), "SMUDGED:old\n", "the vault's own checkout runs the filter");
  const state = await killUpdate(dir, from, to, { slow: "x/z.txt" });
  assert.equal(await readFile(join(dir, "x/a.md"), "utf8"), "SMUDGED:new\n", "the kill came after x/a.md was written");
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/a.md", "x/z.txt"], kept: [], moved: false });
  assert.equal(await readFile(join(dir, "x/a.md"), "utf8"), "SMUDGED:old\n");
  assert.equal(await status(dir), "");
});

// A vault whose update renamed Note.md to note.md (and changed it), killed on z.md
// after the rename: on a disk that ignores case, the two names are one file. Null
// (and the test skipped) where the disk tells them apart.
async function caseRenamed(t: TestContext, prints: boolean): Promise<{ dir: string; state: string } | null> {
  const dir = await tempDir();
  await initRepo(dir);
  if ((await git(["config", "--bool", "core.ignorecase"], { cwd: dir })).stdout.trim() !== "true") {
    t.skip("core.ignorecase is false here: the disk holds Note.md and note.md as two files");
    return null;
  }
  await writeRel(dir, "Note.md", "old note\n");
  await writeRel(dir, "z.md", "old\n");
  await gitOk(["add", "-A"], { cwd: dir });
  await gitOk(["commit", "-q", "-m", "old"], { cwd: dir });
  const from = await head(dir);
  // Committed as a case-sensitive machine does: git here cannot stage a case-only rename by name.
  const blob = (text: string): Promise<string> => gitOk(["hash-object", "-w", "--stdin"], { cwd: dir, input: text });
  const tree = await gitOk(["mktree"], { cwd: dir, input: `100644 blob ${await blob("new note\n")}\tnote.md\n100644 blob ${await blob("new\n")}\tz.md\n` });
  const to = await gitOk(["commit-tree", tree, "-p", from, "-m", "new"], { cwd: dir });
  const state = await killUpdate(dir, from, to, { slow: "z.md", prints });
  assert.deepEqual(await spellings(dir), ["note.md"], "the kill came after the rename");
  return { dir, state };
}

const spellings = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((name) => fold(name) === "note.md");

for (const prints of [true, false]) {
  test(`a case-only rename the update had made is set back under the old spelling, never deleted (${prints ? "with" : "without"} fingerprints)`, async (t) => {
    const v = await caseRenamed(t, prints);
    if (!v) return;
    assert.deepEqual(await finishInterrupted(v.state, v.dir), { restored: ["Note.md", "note.md", "z.md"], kept: [], moved: false });
    assert.deepEqual(await spellings(v.dir), ["Note.md"]);
    assert.equal(await readFile(join(v.dir, "Note.md"), "utf8"), "old note\n");
    assert.equal(await status(v.dir), "");
  });
}

test("a case-only rename whose one file the user changed since is kept as the user's", async (t) => {
  const v = await caseRenamed(t, true);
  if (!v) return;
  await writeFile(join(v.dir, "note.md"), "the user's edit\n");
  assert.deepEqual(await finishInterrupted(v.state, v.dir), { restored: ["z.md"], kept: ["Note.md", "note.md"], moved: false });
  assert.deepEqual(await spellings(v.dir), ["note.md"]);
  assert.equal(await readFile(join(v.dir, "note.md"), "utf8"), "the user's edit\n");
});

// A vault at `before`, and a commit on top of it whose tree holds exactly `after`,
// spelled as given: committed as a machine where case matters commits it, since git
// on a disk that ignores case cannot stage a case-only rename by name. Null (and the
// test skipped) where core.ignorecase is false.
async function caseHistory(
  t: TestContext,
  before: Record<string, string>,
  after: Record<string, string>,
): Promise<{ dir: string; from: string; to: string } | null> {
  const dir = await tempDir();
  await initRepo(dir);
  if ((await git(["config", "--bool", "core.ignorecase"], { cwd: dir })).stdout.trim() !== "true") {
    t.skip("core.ignorecase is false here: the disk holds the two spellings as two entries");
    return null;
  }
  for (const [rel, content] of Object.entries(before)) await writeRel(dir, rel, content);
  await gitOk(["add", "-A"], { cwd: dir });
  await gitOk(["commit", "-q", "-m", "old"], { cwd: dir });
  const from = await head(dir);
  const env = { GIT_INDEX_FILE: join(await tempDir(), "index") };
  for (const [rel, content] of Object.entries(after)) {
    const blob = await gitOk(["hash-object", "-w", "--stdin"], { cwd: dir, input: content });
    await gitOk(["-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], { cwd: dir, env });
  }
  const to = await gitOk(["commit-tree", await gitOk(["write-tree"], { cwd: dir, env }), "-p", from, "-m", "new"], { cwd: dir });
  return { dir, from, to };
}

const folderSpellings = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((name) => fold(name) === "x");

test("a case-only rename of a folder the update had made is set back under the old folder's spelling", async (t) => {
  const v = await caseHistory(t, { "X/p.md": "old note\n", "z.md": "old\n" }, { "x/p.md": "new note\n", "z.md": "new\n" });
  if (!v) return;
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.deepEqual(await folderSpellings(v.dir), ["x"], "the kill came after git had made the folder x");
  assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["X/p.md", "x/p.md", "z.md"], kept: [], moved: false });
  assert.deepEqual(await folderSpellings(v.dir), ["X"]);
  assert.deepEqual(await readdir(join(v.dir, "X")), ["p.md"]);
  assert.equal(await readFile(join(v.dir, "X", "p.md"), "utf8"), "old note\n");
  assert.equal(await status(v.dir), "");
});

test("a note the update added beside its unchanged case twin is that one file here: it goes back to the twin's old version, never unlinked", async (t) => {
  const v = await caseHistory(t, { "Note.md": "old note\n", "z.md": "old\n" }, { "Note.md": "old note\n", "note.md": "new note\n", "z.md": "new\n" });
  if (!v) return;
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.equal(await readFile(join(v.dir, "Note.md"), "utf8"), "new note\n", "the kill came after git wrote note.md over the one file");
  assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["Note.md", "note.md", "z.md"], kept: [], moved: false });
  assert.deepEqual(await spellings(v.dir), ["Note.md"]);
  assert.equal(await readFile(join(v.dir, "Note.md"), "utf8"), "old note\n");
  assert.equal(await readFile(join(v.dir, "z.md"), "utf8"), "old\n");
  assert.equal(await status(v.dir), "");
});

// Whether the disk the tests write to tells Note.md and note.md apart, asked of the
// disk itself with a probe file (never read from the platform's name).
async function caseMatters(): Promise<boolean> {
  const probe = await tempDir();
  await writeFile(join(probe, "case-probe"), "");
  return !(await exists(join(probe, "CASE-PROBE")));
}

// A vault on a disk where case matters, whose core.ignorecase says the opposite: the
// setting git wrote on a disk that ignores case, kept when the vault was copied over.
async function staleIgnorecase(
  t: TestContext,
  before: Record<string, string>,
  after: Record<string, string | null>,
): Promise<{ dir: string; from: string; to: string } | null> {
  if (!(await caseMatters())) {
    t.skip("this disk ignores case: Note.md and note.md are one file here, so core.ignorecase=true is not stale");
    return null;
  }
  const v = await history(before, after);
  await gitOk(["config", "core.ignorecase", "true"], { cwd: v.dir });
  return v;
}

test("a stale core.ignorecase=true on a disk where case matters never renames a different file over the note set back", async (t) => {
  const v = await staleIgnorecase(t, { "Note.md": "old note\n", "z.md": "old\n" }, { "Note.md": null, "note.md": "new note\n", "z.md": "new\n" });
  if (!v) return;
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.equal(await readFile(join(v.dir, "note.md"), "utf8"), "new note\n", "the kill came after the rename");
  await finishInterrupted(state, v.dir);
  assert.equal(await readFile(join(v.dir, "Note.md"), "utf8"), "old note\n", "the old version stays where it was set back");
  assert.equal(await readFile(join(v.dir, "note.md"), "utf8"), "new note\n", "the other file is never renamed over it");
});

test("a stale core.ignorecase=true on a disk where case matters never sets an unchanged note back over the user's edit of it", async (t) => {
  const v = await staleIgnorecase(t, { "note.md": "old note\n", "z.md": "old\n" }, { "Note.md": "new note\n", "z.md": "new\n" });
  if (!v) return;
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.equal(await readFile(join(v.dir, "Note.md"), "utf8"), "new note\n", "the kill came after git wrote Note.md");
  await writeFile(join(v.dir, "note.md"), "the user's edit\n");
  await finishInterrupted(state, v.dir);
  assert.equal(await readFile(join(v.dir, "note.md"), "utf8"), "the user's edit\n");
});

test("a path named like an object's own property (constructor) is judged as any other", async () => {
  const w = await interrupted({ constructor: "from the update\n" }, { prints: false });
  assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["constructor", "x/a.md"], kept: [], moved: false });
  assert.equal(await exists(join(w.dir, "constructor")), false);
});

test("a record that cannot be read stops sync with a message that names the file and what to do, and stays", async () => {
  const w = await interrupted();
  const [name = ""] = await readdir(w.state);
  const record = join(w.state, name);
  for (const text of ["{ not json", JSON.stringify({ prints: {} }), JSON.stringify({ from: "HEAD", to: "main" })]) {
    await writeFile(record, text);
    await assert.rejects(finishInterrupted(w.state, w.dir), (err: Error) => {
      assert.ok(err.message.includes(record), err.message);
      assert.match(err.message, /delete that file/i);
      return true;
    });
    assert.equal(await readFile(record, "utf8"), text, "the record stays");
  }
});

// An update of x/a.md and x/b.md killed on x/a.md, and a repair that sets x/a.md back
// and then fails on x/b.md, whose checkout waits at the gate until told to fail.
async function repairFailingOnB(): Promise<{ dir: string; state: string; started: string; go: string }> {
  const { dir, from, to } = await history({ "x/a.md": "old a\n", "x/b.md": "old b\n" }, { "x/a.md": "new a\n", "x/b.md": "new b\n" });
  const state = await killUpdate(dir, from, to);
  const { started, go } = await gate(dir, true);
  await writeFile(join(dir, ".git", "info", "attributes"), "x/b.md filter=gate\n");
  return { dir, state, started, go };
}

test("a repair that stops reports its own error, and the next run takes what it had set back for its own", async () => {
  const r = await repairFailingOnB();
  const finishing = finishInterrupted(r.state, r.dir);
  finishing.catch(() => undefined);
  await until(() => exists(r.started));
  // x/a.md is back by now; unreadable, it could no longer be fingerprinted.
  const a = join(r.dir, "x/a.md");
  const { mode } = await stat(a);
  await chmod(a, 0);
  await writeFile(r.go, "");
  try {
    await assert.rejects(finishing, GitError);
  } finally {
    await chmod(a, mode & 0o7777);
  }
  await writeFile(join(r.dir, ".git", "info", "attributes"), "");
  assert.deepEqual(await finishInterrupted(r.state, r.dir), { restored: ["x/a.md", "x/b.md"], kept: [], moved: false });
  assert.equal(await readFile(a, "utf8"), "old a\n");
  assert.equal(await status(r.dir), "");
});

test("a repair that stops reports its own error even when the record cannot be updated", async () => {
  const r = await repairFailingOnB();
  const finishing = finishInterrupted(r.state, r.dir);
  finishing.catch(() => undefined);
  await until(() => exists(r.started));
  const { mode } = await stat(r.state);
  await chmod(r.state, 0o555);
  await writeFile(r.go, "");
  try {
    await assert.rejects(finishing, GitError);
  } finally {
    await chmod(r.state, mode & 0o7777);
  }
  // The older record errs toward keeping: x/a.md, back to the old version, reads as an edit.
  await writeFile(join(r.dir, ".git", "info", "attributes"), "");
  assert.deepEqual(await finishInterrupted(r.state, r.dir), { restored: ["x/b.md"], kept: ["x/a.md"], moved: false });
  assert.equal(await readFile(join(r.dir, "x/a.md"), "utf8"), "old a\n");
  assert.equal(await readFile(join(r.dir, "x/b.md"), "utf8"), "old b\n");
});
