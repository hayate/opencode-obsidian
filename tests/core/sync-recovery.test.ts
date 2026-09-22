import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { git, GitError, gitOk } from "../../core/git.ts";
import { fold } from "../../core/sync/copies.ts";
import { bootInstant, clearInterrupted, finishInterrupted, recordIntent, recordInterrupted, RepairTimedOut, runningUpdate } from "../../core/sync/recovery.ts";
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
  assert.deepEqual(done, { restored: ["x/a.md"], kept: [] });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "old\n");
  assert.equal(await head(w.dir), w.from);
  assert.equal(await status(w.dir), "", "HEAD, index and files agree again");
  assert.equal(await finishInterrupted(w.state, w.dir), null, "the record is gone");
});

test("a path the user changed after the kill is kept as it is", async () => {
  const w = await interrupted();
  await writeFile(join(w.dir, "x/a.md"), "the user's edit\n");
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: [], kept: ["x/a.md"] });
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
  assert.deepEqual(done, { restored: [], kept: [] });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "new\n");
});

test("when the history moved since (git by hand), nothing is touched and the record stays: sync stops, naming the record and what to do", async () => {
  const w = await interrupted();
  await gitOk(["commit", "-q", "--allow-empty", "-m", "by hand"], { cwd: w.dir });
  // The kill left x/a.md as it left it (here: unlinked, not yet rewritten).
  const read = (): Promise<string | null> => readFile(join(w.dir, "x/a.md"), "utf8").catch(() => null);
  const before = await read();
  const [name = ""] = await readdir(w.state);
  const record = join(w.state, name);
  const text = await readFile(record, "utf8");
  for (let run = 1; run <= 2; run++) {
    await assert.rejects(finishInterrupted(w.state, w.dir), (err: Error) => {
      assert.ok(err.message.includes(record), err.message);
      assert.match(err.message, /history moved/);
      assert.match(err.message, /`git status` in Projects\//);
      assert.match(err.message, /delete that file/i);
      return true;
    });
    assert.equal(await readFile(record, "utf8"), text, "the record stays");
    assert.equal(await read(), before);
  }
});

test("an update whose fingerprints were never taken (the process died) sets back what is git's and keeps what is not", async () => {
  const w = await interrupted({ "x/0new.txt": "brand new\n", "x/1mine.txt": "from the update\n" }, { prints: false });
  // After the kill: x/0new.txt and x/1mine.txt written in full, x/a.md unlinked (its
  // smudge was hanging). Then the user writes their own text over x/1mine.txt.
  await writeFile(join(w.dir, "x/1mine.txt"), "the user's own text\n");
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: ["x/0new.txt", "x/a.md"], kept: ["x/1mine.txt"] });
  assert.equal(await exists(join(w.dir, "x/0new.txt")), false, "the update's own new file goes");
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "old\n", "a file the update had unlinked comes back");
  assert.equal(await readFile(join(w.dir, "x/1mine.txt"), "utf8"), "the user's own text\n");
  assert.equal(await head(w.dir), w.from);
});

test("a repair that times out saves where it got to: the next run finishes, and nothing it set back is taken for an edit", async () => {
  const w = await interrupted({ "x/0new.txt": "brand new\n" }, { stillSlow: true });
  // The one error that says the repair's own checkout ran past its limit: the cycle
  // takes it for a timeout of the live update (cycle.ts doubles the next limit).
  await assert.rejects(
    finishInterrupted(w.state, w.dir, { timeoutMs: 500 }),
    (err: unknown) =>
      err instanceof RepairTimedOut && err.name === "RepairTimedOut" && err.path === "x/a.md" && /x\/a\.md.*timed out/.test((err as Error).message),
  );
  await gitOk(["config", "--unset", "filter.slow.smudge"], { cwd: w.dir });
  const done = await finishInterrupted(w.state, w.dir);
  assert.deepEqual(done, { restored: ["x/0new.txt", "x/a.md"], kept: [] });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "old\n");
  assert.equal(await status(w.dir), "");
});

test("a HEAD that cannot be read leaves the record for the next run, never read as history that moved", async () => {
  const w = await interrupted();
  const headFile = join(w.dir, ".git", "HEAD");
  const saved = await readFile(headFile, "utf8");
  await writeFile(headFile, "ref: refs/heads/no-such-branch\n");
  // git's own error, never the stop for a history that moved, whose way out is to delete the record,
  // nor a timeout of the repair.
  await assert.rejects(finishInterrupted(w.state, w.dir), (err: unknown) => err instanceof GitError && !(err instanceof RepairTimedOut));
  await writeFile(headFile, saved);
  assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["x/a.md"], kept: [] });
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
  assert.deepEqual(done, { restored: [], kept: ["x/a.md"] });
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
  assert.deepEqual(done, { restored: ["x/p/b.txt", "x/p", "x/z.md"], kept: [] });
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the note\n");
  assert.equal(await status(dir), "");
});

test("a repair runs none of the vault's hooks (it is not the user's checkout)", async () => {
  const w = await interrupted();
  const marker = join(w.dir, "..", `hook-ran-${Date.now()}`);
  await writeFile(join(w.dir, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["x/a.md"], kept: [] });
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
  const { ino } = await stat(join(dir, "x/a.md"));
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/0new.txt", "x/a.md"], kept: [] });
  assert.equal((await stat(join(dir, "x/a.md"))).ino, ino, "a path that already holds the old version is listed, and never rewritten");
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
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/b.txt", "x/p", "x/z.md"], kept: [] });
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
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/z.md"], kept: ["x/p", "x/p/b.txt"] });
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
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/b.txt", "x/z.md"], kept: ["x/p"] });
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
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p", "x/p/b.txt", "x/z.md"], kept: [] });
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
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/q/c.txt", "x/p", "x/z.md"], kept: [] });
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

test("a file the update added in a folder it made goes, and the folder with it, as git's own removal takes the folders it empties", async () => {
  const { dir, from, to } = await history({ "x/a.md": "old\n" }, { "n/new.txt": "brand new\n", "x/a.md": "new\n" });
  const state = await killUpdate(dir, from, to);
  assert.equal(await readFile(join(dir, "n/new.txt"), "utf8"), "brand new\n", "the kill came after the update wrote n/new.txt");
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["n/new.txt", "x/a.md"], kept: [] });
  assert.equal(await exists(join(dir, "n")), false, "the folder the update made is gone");
  assert.equal(await status(dir), "");
});

test("a file gone just before the repair unlinks it leaves the folders around it alone: only a removal that removed something prunes", async () => {
  const { dir, from, to } = await history({ "x/a.md": "old\n" }, { "n/new.txt": "brand new\n", "x/a.md": "new\n" });
  const state = await killUpdate(dir, from, to);
  // Real git cannot time a deletion into the gap between the repair's check and its
  // unlink: the file goes, and the unlink finds nothing, as the repair unlinks it.
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const real = fsp.unlink;
  const target = join(dir, "n/new.txt");
  fsp.unlink = (async (path: string) => {
    await real(path);
    if (path === target) throw Object.assign(new Error(`ENOENT: no such file or directory, unlink '${path}'`), { code: "ENOENT" });
  }) as unknown as typeof real;
  syncBuiltinESMExports();
  let done;
  try {
    done = await finishInterrupted(state, dir);
  } finally {
    fsp.unlink = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(done, { restored: ["n/new.txt", "x/a.md"], kept: [] });
  assert.equal(await exists(join(dir, "n")), true, "the folder stays: the repair removed nothing from it");
});

// The update turned note x/p into x/p/q/c.txt, and was killed after writing it.
const noteIntoDeepFolders = (): Promise<{ dir: string; from: string; to: string }> =>
  history({ "x/p": "the note\n", "x/z.md": "old\n" }, { "x/p": null, "x/p/q/c.txt": "deep in the new folder\n", "x/z.md": "new\n" });

for (const prints of [true, false]) {
  test(`a note whose path holds only empty folders comes back: the empty tree goes (${prints ? "with" : "without"} fingerprints)`, async () => {
    const { dir, from, to } = await noteIntoDeepFolders();
    const state = await killUpdate(dir, from, to, { prints });
    // Gone, its folders left: a repair that died between the unlink and the prune, or the user's deletion.
    // Either way absence is what the set-back leaves there: restored, whatever the fingerprint says.
    await unlink(join(dir, "x/p/q/c.txt"));
    assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/q/c.txt", "x/p", "x/z.md"], kept: [] });
    assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the note\n");
    assert.equal(await status(dir), "");
    assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
  });
}

test("Finder's .DS_Store in the empty tree at a note's path is litter, not content: the note comes back", async () => {
  const { dir, from, to } = await noteIntoDeepFolders();
  const state = await killUpdate(dir, from, to);
  await unlink(join(dir, "x/p/q/c.txt"));
  await writeFile(join(dir, "x/p/q/.DS_Store"), "finder");
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/q/c.txt", "x/p", "x/z.md"], kept: [] });
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the note\n");
  assert.equal(await status(dir), "");
});

test("a note whose path holds a user's file deeper down is kept, and everything of theirs in it stays as it was", async () => {
  const { dir, from, to } = await noteIntoDeepFolders();
  const state = await killUpdate(dir, from, to);
  await writeFile(join(dir, "x/p/q/mine.txt"), "the user's note\n");
  await mkdir(join(dir, "x/p/q/r"));
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/q/c.txt", "x/z.md"], kept: ["x/p"] });
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
  assert.deepEqual(done, { restored: ["x/p/q/c.txt", "x/z.md"], kept: ["x/p"] });
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
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/b.txt", "x/p", "x/z.md"], kept: [] });
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
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/a.md", "x/z.txt"], kept: [] });
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
    assert.deepEqual(await finishInterrupted(v.state, v.dir), { restored: ["Note.md", "note.md", "z.md"], kept: [] });
    assert.deepEqual(await spellings(v.dir), ["Note.md"]);
    assert.equal(await readFile(join(v.dir, "Note.md"), "utf8"), "old note\n");
    assert.equal(await status(v.dir), "");
  });
}

test("a case-only rename whose one file the user changed since is kept as the user's", async (t) => {
  const v = await caseRenamed(t, true);
  if (!v) return;
  await writeFile(join(v.dir, "note.md"), "the user's edit\n");
  assert.deepEqual(await finishInterrupted(v.state, v.dir), { restored: ["z.md"], kept: ["Note.md", "note.md"] });
  assert.deepEqual(await spellings(v.dir), ["note.md"]);
  assert.equal(await readFile(join(v.dir, "note.md"), "utf8"), "the user's edit\n");
});

// A commit whose tree holds exactly `files`, spelled as given: committed as a machine
// where case matters commits it, since git on a disk that ignores case cannot stage a
// case-only rename, or two spellings of one name, by name.
async function exactCommit(dir: string, files: Record<string, string>, parent?: string): Promise<string> {
  const env = { GIT_INDEX_FILE: join(await tempDir(), "index") };
  for (const [rel, content] of Object.entries(files)) {
    const blob = await gitOk(["hash-object", "-w", "--stdin"], { cwd: dir, input: content });
    await gitOk(["-c", "core.ignorecase=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${rel}`], { cwd: dir, env });
  }
  const tree = await gitOk(["write-tree"], { cwd: dir, env });
  return gitOk(["commit-tree", tree, ...(parent === undefined ? [] : ["-p", parent]), "-m", parent === undefined ? "old" : "new"], { cwd: dir });
}

// A vault at `before`, checked out by git itself, and a commit on top of it at `after`,
// both trees holding exactly the paths given. Null (and the test skipped) where
// core.ignorecase is false.
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
  const from = await exactCommit(dir, before);
  await gitOk(["reset", "-q", "--hard", from], { cwd: dir });
  const to = await exactCommit(dir, after, from);
  return { dir, from, to };
}

// Every file under dir but .git, as spelled on disk, with its content.
async function files(dir: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    if (entry.isDirectory()) found.push(...(await files(dir, path)));
    else found.push(`${path}: ${await readFile(join(dir, path), "utf8")}`);
  }
  return found.sort();
}

// The oracle: a second clone of the vault at its current commit, checked out by git itself.
async function checkedOutByGit(dir: string): Promise<string> {
  const clone = join(await tempDir(), "clone");
  await gitOk(["clone", "-q", dir, clone], { cwd: dir });
  return clone;
}

const folderSpellings = async (dir: string): Promise<string[]> => (await readdir(dir)).filter((name) => fold(name) === "x");

test("a case-only rename of a folder the update had made is set back under the old folder's spelling", async (t) => {
  const v = await caseHistory(t, { "X/p.md": "old note\n", "z.md": "old\n" }, { "x/p.md": "new note\n", "z.md": "new\n" });
  if (!v) return;
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.deepEqual(await folderSpellings(v.dir), ["x"], "the kill came after git had made the folder x");
  assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["X/p.md", "x/p.md", "z.md"], kept: [] });
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
  assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["Note.md", "note.md", "z.md"], kept: [] });
  assert.deepEqual(await spellings(v.dir), ["Note.md"]);
  assert.equal(await readFile(join(v.dir, "Note.md"), "utf8"), "old note\n");
  assert.equal(await readFile(join(v.dir, "z.md"), "utf8"), "old\n");
  assert.equal(await status(v.dir), "");
});

for (const prints of [true, false]) {
  test(`a note set back into a folder git made under a new spelling for another path gets the old folder's spelling (${prints ? "with" : "without"} fingerprints)`, async (t) => {
    // The remote renamed folder X to x and X/p.md to x/q.md: two units, not twins.
    const v = await caseHistory(t, { "X/p.md": "old note\n", "z.md": "old\n" }, { "x/q.md": "new q\n", "z.md": "new\n" });
    if (!v) return;
    const state = await killUpdate(v.dir, v.from, v.to, { prints });
    assert.deepEqual(await folderSpellings(v.dir), ["x"], "the kill came after git had made the folder x, during x/q.md");
    assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["x/q.md", "X/p.md", "z.md"], kept: [] });
    assert.deepEqual(await folderSpellings(v.dir), ["X"]);
    assert.equal(await readFile(join(v.dir, "X", "p.md"), "utf8"), "old note\n");
    assert.equal(await status(v.dir), "");
  });
}

test("where the old tree holds both spellings of a note, the repair gives back what git's own checkout of the old tree leaves", async (t) => {
  const v = await caseHistory(t, { "Note.md": "upper\n", "note.md": "lower\n", "z.md": "old\n" }, { "Note.md": "upper\n", "note.md": "lower changed\n", "z.md": "new\n" });
  if (!v) return;
  const oracle = await checkedOutByGit(v.dir);
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.equal(await readFile(join(v.dir, "note.md"), "utf8"), "lower changed\n", "the kill came after git wrote note.md");
  await finishInterrupted(state, v.dir);
  assert.deepEqual(await files(v.dir), await files(oracle));
  assert.equal(await status(v.dir), await status(oracle));
});

test("where the old tree spells a folder two ways, a note set back into it keeps the folder git's own checkout made", async (t) => {
  const v = await caseHistory(t, { "X/a.md": "a\n", "x/b.md": "old b\n", "z.md": "old\n" }, { "X/a.md": "a\n", "x/b.md": "new b\n", "z.md": "new\n" });
  if (!v) return;
  const oracle = await checkedOutByGit(v.dir);
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.equal(await readFile(join(v.dir, "x/b.md"), "utf8"), "new b\n", "the kill came after git wrote x/b.md");
  assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["x/b.md", "z.md"], kept: [] });
  assert.deepEqual(await files(v.dir), await files(oracle));
  assert.equal(await status(v.dir), await status(oracle));
});

test("where the old tree holds two spellings of a note from two Unicode planes, the repair orders them by bytes, as git's own checkout does", async (t) => {
  // U+FA6C's NFC form is U+242EE: one name on this disk. By bytes (git's order) U+FA6C
  // comes first; by UTF-16 code units U+242EE's surrogate pair does. The one file goes
  // back to the last old twin's version, so the order decides what it holds.
  // Escaped, never the raw character: a pass that normalizes the source to NFC would
  // turn it into U+242EE, and the test would pin nothing.
  const compat = "\uFA6C.md";
  const astral = "\u{242EE}.md";
  assert.notEqual(compat, astral);
  const v = await caseHistory(t, { [compat]: "compat\n", [astral]: "astral\n", "z.md": "old\n" }, { [compat]: "compat\n", [astral]: "astral changed\n", "z.md": "new\n" });
  if (!v) return;
  const oracle = await checkedOutByGit(v.dir);
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.equal(await readFile(join(v.dir, astral), "utf8"), "astral\n", "killed on z.md, which git writes first: the one file is as git's checkout of the old tree left it");
  await finishInterrupted(state, v.dir);
  assert.deepEqual(await files(v.dir), await files(oracle));
  assert.equal(await status(v.dir), await status(oracle));
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

// Where case matters, X/a.md and x/b.md sit in two folders. The update changes x/b.md
// and is killed on z.md; then the user deletes folder X, the old tree's first spelling
// of the folder x/b.md goes back into.
for (const stale of [false, true]) {
  test(`where case matters and the old tree spells a folder two ways, the user's deletion of the first spelling never stops a repair into the other (core.ignorecase ${stale ? "a stale true" : "false"})`, async (t) => {
    const before = { "X/a.md": "a\n", "x/b.md": "old b\n", "z.md": "old\n" };
    const after = { "x/b.md": "new b\n", "z.md": "new\n" };
    if (!stale && !(await caseMatters())) {
      t.skip("this disk ignores case: X and x are one folder here");
      return;
    }
    const v = stale ? await staleIgnorecase(t, before, after) : await history(before, after);
    if (!v) return;
    const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
    assert.equal(await readFile(join(v.dir, "x/b.md"), "utf8"), "new b\n", "the kill came after git wrote x/b.md");
    await rm(join(v.dir, "X"), { recursive: true });
    assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["x/b.md", "z.md"], kept: [] });
    assert.equal(await finishInterrupted(state, v.dir), null, "the record is gone");
    assert.equal(await readFile(join(v.dir, "x/b.md"), "utf8"), "old b\n");
    assert.equal(await readFile(join(v.dir, "z.md"), "utf8"), "old\n");
    assert.equal(await exists(join(v.dir, "X")), false, "the user's deletion of X stands");
    assert.equal(await status(v.dir), "D X/a.md", "and it is all that differs from the old version");
  });
}

test("where case matters and the old tree spells a folder two ways, a file the user saved in place of the first spelling never stops a repair into the other", async (t) => {
  if (!(await caseMatters())) {
    t.skip("this disk ignores case: X and x are one folder here");
    return;
  }
  const v = await history({ "X/a.md": "a\n", "x/b.md": "old b\n", "z.md": "old\n" }, { "x/b.md": "new b\n", "z.md": "new\n" });
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.equal(await readFile(join(v.dir, "x/b.md"), "utf8"), "new b\n", "the kill came after git wrote x/b.md");
  await rm(join(v.dir, "X"), { recursive: true });
  await writeFile(join(v.dir, "X"), "the user's file\n");
  assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["x/b.md", "z.md"], kept: [] });
  assert.equal(await finishInterrupted(state, v.dir), null, "the record is gone");
  assert.equal(await readFile(join(v.dir, "x/b.md"), "utf8"), "old b\n");
  assert.equal(await readFile(join(v.dir, "z.md"), "utf8"), "old\n");
  assert.equal(await readFile(join(v.dir, "X"), "utf8"), "the user's file\n", "the user's file stays as it is");
  assert.equal(await status(v.dir), "D X/a.md\n?? X", "and it is all that differs from the old version");
});

test("a repair's respelling walk never goes through a symlink the user put in a folder's place: a folder outside the vault keeps its spelling", async (t) => {
  const v = await caseHistory(t, { "X/Sub/p.md": "old p\n", "z.md": "old\n" }, { "X/Sub/p.md": "new p\n", "z.md": "new\n" });
  if (!v) return;
  const state = await tempDir();
  await recordIntent(state, v.from, v.to); // and the process died
  // The user replaces folder X with a symlink to a folder elsewhere, which holds SUB.
  const outside = await tempDir();
  await mkdir(join(outside, "SUB"));
  await rm(join(v.dir, "X"), { recursive: true });
  await symlink(outside, join(v.dir, "X"));
  // X/Sub/p.md is behind the user's symlink: not in the vault, so it is kept, and nothing is written through it.
  assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["z.md"], kept: ["X/Sub/p.md"] });
  assert.deepEqual(await readdir(outside), ["SUB"]);
  assert.deepEqual(await readdir(join(outside, "SUB")), [], "nothing is written outside the vault");
});

test("a set-back two folders deep walks both real folders, each back to the old tree's spelling", async (t) => {
  const v = await caseHistory(t, { "A/B/p.md": "old p\n", "z.md": "old\n" }, { "a/b/p.md": "new p\n", "z.md": "new\n" });
  if (!v) return;
  const state = await killUpdate(v.dir, v.from, v.to, { slow: "z.md" });
  assert.deepEqual(await readdir(v.dir), [".git", "a"], "the kill came after git made a/b for a/b/p.md");
  assert.deepEqual(await finishInterrupted(state, v.dir), { restored: ["A/B/p.md", "a/b/p.md", "z.md"], kept: [] });
  assert.deepEqual(await files(v.dir), ["A/B/p.md: old p\n", "z.md: old\n"]);
  assert.equal(await status(v.dir), "");
});

// The old tree tracks x/p as a symlink to a folder outside the vault; the target makes
// x/p a real folder holding n.md. Only the intent is recorded, the vault untouched (a
// process death before the reset, or a failure git printed before writing that is not
// one of its refusals).
for (const same of [true, false]) {
  test(`a symlink the old tree has in a folder's place is never gone through: a file outside the vault is never removed (${same ? "the same bytes as" : "other bytes than"} the update's)`, async () => {
    const outside = await tempDir("sro-outside-");
    await writeFile(join(outside, "n.md"), same ? "the note\n" : "outside's own\n");
    const dir = await tempDir();
    await initRepo(dir);
    await writeRel(dir, "x/z.md", "old\n");
    await symlink(outside, join(dir, "x/p"));
    await gitOk(["add", "-A"], { cwd: dir });
    await gitOk(["commit", "-q", "-m", "old"], { cwd: dir });
    const from = await head(dir);
    await gitOk(["rm", "-q", "x/p"], { cwd: dir });
    await writeRel(dir, "x/p/n.md", "the note\n");
    await writeRel(dir, "x/z.md", "new\n");
    await gitOk(["add", "-A"], { cwd: dir });
    await gitOk(["commit", "-q", "-m", "new"], { cwd: dir });
    const to = await head(dir);
    await gitOk(["reset", "-q", "--hard", from], { cwd: dir });
    const state = await tempDir();
    await recordIntent(state, from, to); // and the update never ran
    assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/p/n.md", "x/p", "x/z.md"], kept: [] });
    assert.deepEqual(await readdir(outside), ["n.md"], "a file outside the vault is never removed");
    assert.equal(await readFile(join(outside, "n.md"), "utf8"), same ? "the note\n" : "outside's own\n");
    assert.equal(await status(dir), "");
    // The retried update then runs as usual, and replaces the symlink itself.
    assert.equal((await git(["reset", "-q", "--keep", to], { cwd: dir })).code, 0);
    assert.equal(await readFile(join(dir, "x/p/n.md"), "utf8"), "the note\n");
    assert.equal(await readFile(join(outside, "n.md"), "utf8"), same ? "the note\n" : "outside's own\n");
  });
}

// The old tree holds folder x/p with n.md; the update (the remote's tree) makes x/p a
// symlink to a folder outside the vault, and is killed after making it.
async function symlinkUpdate(outsideHolds: boolean, prints: boolean, relative: boolean): Promise<{ dir: string; state: string; outside: string }> {
  const dir = await tempDir();
  const outside = await tempDir("sro-outside-");
  if (outsideHolds) await writeFile(join(outside, "n.md"), "outside's own\n");
  const { from, to } = await (async () => {
    await initRepo(dir);
    await writeRel(dir, "x/p/n.md", "the note\n");
    await writeRel(dir, "x/z.md", "old\n");
    await gitOk(["add", "-A"], { cwd: dir });
    await gitOk(["commit", "-q", "-m", "old"], { cwd: dir });
    const old = await head(dir);
    await gitOk(["rm", "-q", "-r", "x/p"], { cwd: dir });
    await symlink(relative ? join("..", "..", basename(outside)) : outside, join(dir, "x/p"));
    await writeRel(dir, "x/z.md", "new\n");
    await gitOk(["add", "-A"], { cwd: dir });
    await gitOk(["commit", "-q", "-m", "new"], { cwd: dir });
    const next = await head(dir);
    await gitOk(["reset", "-q", "--hard", old], { cwd: dir });
    return { from: old, to: next };
  })();
  const state = await killUpdate(dir, from, to, { prints });
  assert.equal((await lstat(join(dir, "x/p"))).isSymbolicLink(), true, "the kill came after the update made the symlink");
  return { dir, state, outside };
}

for (const outsideHolds of [false, true]) {
  for (const prints of [true, false]) {
    for (const relative of [false, true]) {
      test(`a symlink the update made in a folder's place is never written or read through (outside ${outsideHolds ? "holds" : "lacks"} n.md, ${prints ? "with" : "without"} fingerprints, ${relative ? "relative" : "absolute"} link)`, async () => {
        const w = await symlinkUpdate(outsideHolds, prints, relative);
        assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["x/p", "x/p/n.md", "x/z.md"], kept: [] });
        assert.equal(await readFile(join(w.dir, "x/p/n.md"), "utf8"), "the note\n", "the note is back in its real folder");
        assert.equal(await status(w.dir), "");
        assert.deepEqual(await readdir(w.outside), outsideHolds ? ["n.md"] : [], "nothing is written outside the vault");
        if (outsideHolds) assert.equal(await readFile(join(w.outside, "n.md"), "utf8"), "outside's own\n");
      });
    }
  }
}

test("a folder the user replaced with a file, after an update that never ran, keeps their file: the note it held is kept, and sync goes on", async () => {
  const { dir, from, to } = await history({ "x/p/b.txt": "in the folder\n", "x/z.md": "old\n" }, { "x/p/b.txt": "changed in the folder\n", "x/z.md": "new\n" });
  const state = await tempDir();
  await recordIntent(state, from, to); // and the process died
  await rm(join(dir, "x/p"), { recursive: true });
  await writeFile(join(dir, "x/p"), "the user's file\n");
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/z.md"], kept: ["x/p/b.txt"] });
  assert.equal(await readFile(join(dir, "x/p"), "utf8"), "the user's file\n");
  assert.equal(await finishInterrupted(state, dir), null, "the record is gone");
});

test("a folder swapped for a symlink between the repair's check and its removal: nothing outside the vault is removed", async () => {
  const { dir, from, to } = await history({ "x/z.md": "old\n" }, { "x/p/n.txt": "brand new\n", "x/z.md": "new\n" });
  const state = await killUpdate(dir, from, to);
  assert.equal(await readFile(join(dir, "x/p/n.txt"), "utf8"), "brand new\n", "the kill came after the update wrote x/p/n.txt");
  const outside = await tempDir("sro-outside-");
  await writeFile(join(outside, "n.txt"), "brand new\n");
  // Real git cannot time a swap into the gap between the repair's check and its
  // unlink: folder x/p becomes a symlink to a folder outside the vault as soon as the
  // repair has read the file there.
  const fsp = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const real = fsp.readFile;
  const target = join(dir, "x/p/n.txt");
  fsp.readFile = (async (path: unknown, ...rest: unknown[]) => {
    const content = await (real as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    if (path === target && (await lstat(join(dir, "x/p"))).isDirectory()) {
      await rm(join(dir, "x/p"), { recursive: true });
      await symlink(outside, join(dir, "x/p"));
    }
    return content;
  }) as unknown as typeof real;
  syncBuiltinESMExports();
  let done;
  try {
    done = await finishInterrupted(state, dir);
  } finally {
    fsp.readFile = real;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readdir(outside), ["n.txt"], "nothing outside the vault is removed");
  assert.deepEqual(done, { restored: ["x/p/n.txt", "x/z.md"], kept: [] });
});

test("a symlink the update made, re-pointed by the user after the kill, is theirs: the note behind it is kept, and nothing is written through it", async () => {
  const w = await symlinkUpdate(false, true, false);
  const other = await tempDir("sro-other-");
  await unlink(join(w.dir, "x/p"));
  await symlink(other, join(w.dir, "x/p"));
  assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["x/z.md"], kept: ["x/p", "x/p/n.md"] });
  assert.deepEqual(await readdir(other), [], "nothing is written outside the vault");
  assert.equal(await readlink(join(w.dir, "x/p")), other);
});

test("a path named like an object's own property (constructor) is judged as any other", async () => {
  const w = await interrupted({ constructor: "from the update\n" }, { prints: false });
  assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["constructor", "x/a.md"], kept: [] });
  assert.equal(await exists(join(w.dir, "constructor")), false);
});

test("a record that cannot be read stops sync with a message that names the file and what to do, and stays", async () => {
  const w = await interrupted();
  const [name = ""] = await readdir(w.state);
  const record = join(w.state, name);
  // A group of 0 or 1 is no update's: process.kill(-1, ...) reaches every process this
  // user may signal, so such a record is read as unreadable like any other.
  const groups = [0, 1, -7, 2.5, "2"].map((group) => JSON.stringify({ from: w.from, to: w.to, group }));
  for (const text of ["{ not json", JSON.stringify({ prints: {} }), JSON.stringify({ from: "HEAD", to: "main" }), ...groups]) {
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
  assert.deepEqual(await finishInterrupted(r.state, r.dir), { restored: ["x/a.md", "x/b.md"], kept: [] });
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
  assert.deepEqual(await finishInterrupted(r.state, r.dir), { restored: ["x/b.md"], kept: ["x/a.md"] });
  assert.equal(await readFile(join(r.dir, "x/a.md"), "utf8"), "old a\n");
  assert.equal(await readFile(join(r.dir, "x/b.md"), "utf8"), "old b\n");
});

test("a stopped repair records a file it had removed as nothing there, so a folder made at that path since is not taken for an edit of it", async () => {
  const { dir, from, to } = await history({ "x/a.md": "old a\n", "x/b.md": "old b\n" }, { "x/0new.txt": "brand new\n", "x/a.md": "new a\n", "x/b.md": "new b\n" });
  const state = await killUpdate(dir, from, to);
  assert.equal(await readFile(join(dir, "x/0new.txt"), "utf8"), "brand new\n", "the kill came after the update wrote x/0new.txt");
  // The repair removes x/0new.txt, sets x/a.md back, then stops on x/b.md, whose filter fails.
  await gitOk(["config", "filter.fails.smudge", "exit 1"], { cwd: dir });
  await gitOk(["config", "filter.fails.required", "true"], { cwd: dir });
  await writeFile(join(dir, ".git", "info", "attributes"), "x/b.md filter=fails\n");
  await assert.rejects(finishInterrupted(state, dir), GitError);
  assert.equal(await exists(join(dir, "x/0new.txt")), false, "the repair had removed it");
  await mkdir(join(dir, "x/0new.txt"));
  await writeFile(join(dir, ".git", "info", "attributes"), "");
  assert.deepEqual(await finishInterrupted(state, dir), { restored: ["x/0new.txt", "x/a.md", "x/b.md"], kept: [] });
  assert.equal(await readFile(join(dir, "x/a.md"), "utf8"), "old a\n");
  assert.equal(await readFile(join(dir, "x/b.md"), "utf8"), "old b\n");
});

// Spec 5.4 step 5 (fix round 2): the boot instant is what makes a recorded group this
// boot's. It must be the same number throughout a boot, and it can never be later than
// this process started, or a record would keep counting after a reboot.
test("the boot instant is the same number at any moment of this boot, and never later than this process started", async () => {
  const first = bootInstant();
  await sleep(1100);
  // The machine booted before this process started, and by now this process has been
  // running for over a second: an instant that is merely "now" cannot satisfy that.
  assert.ok(bootInstant() <= Date.now() - process.uptime() * 1000 + 500, `the machine booted before this process: ${bootInstant()}`);
  // The same number throughout, within the second uptime() is counted in.
  assert.ok(Math.abs(bootInstant() - first) <= 2000, `the same number a second later: ${first} then ${bootInstant()}`);
});

// Spec 5.4 step 5 (fix round 2): process groups here are POSIX, so where the platform has
// none the question cannot be answered and the repair must go ahead rather than wait for
// ever. CI runs ubuntu and macOS; this pins the answer without a Windows path.
test("where the platform has no process groups the check answers gone, so nothing waits on it", async () => {
  const w = await interrupted();
  const alive = spawn("sleep", ["10"], { detached: true, stdio: "ignore" });
  alive.unref();
  const group = alive.pid ?? 0;
  await recordIntent(w.state, w.from, w.to, group);
  const running = await runningUpdate(w.state);
  assert.equal(running?.group, group, "alive on this platform");
  assert.ok((running?.runningMs ?? -1) >= 0 && (running?.runningMs ?? Infinity) < 5000, `just started: ${running?.runningMs} ms`);
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    assert.equal(await runningUpdate(w.state), null);
  } finally {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  }
  process.kill(-group, "SIGKILL");
  await new Promise((done) => alive.on("exit", done));
});

// Spec 5.4 step 5 (fix round 2): a repair whose session died goes on writing its scratch
// worktree. With one fixed path the next repair would delete and recreate that very
// directory under it, and a partial file could land between the new repair's check and
// its rename, to be kept as the user's edit and snapshotted.
const scratches = async (gitDir: string): Promise<string[]> => (await readdir(gitDir)).filter((n) => n.startsWith("sro-repair"));

test("each repair run builds the old version in a scratch worktree of its own, and removes its own when it ends", async () => {
  const w = await interrupted({}, { stillSlow: true });
  const gitDir = join(w.dir, ".git");
  const names: string[] = [];
  for (let run = 0; run < 2; run++) {
    const repairing = assert.rejects(finishInterrupted(w.state, w.dir, { timeoutMs: 700 }), RepairTimedOut);
    const started = Date.now();
    let seen: string | undefined;
    while (seen === undefined) {
      seen = (await scratches(gitDir))[0];
      assert.ok(Date.now() - started < 10_000, "the repair never made its scratch worktree");
      if (seen === undefined) await sleep(10);
    }
    names.push(seen);
    await repairing;
  }
  for (const name of names) assert.match(name, /^sro-repair-[0-9a-f]{8}$/);
  assert.notEqual(names[0], names[1], `each run gets a name of its own: ${names.join(", ")}`);
  assert.deepEqual(await scratches(gitDir), [], "and each run takes its own away");
});

test("a repair sweeps the scratch worktrees earlier runs left behind, whatever they were named", async () => {
  const w = await interrupted();
  const gitDir = join(w.dir, ".git");
  // What a killed repair leaves: this plugin's earlier fixed name, and a named run of its own.
  await mkdir(join(gitDir, "sro-repair", "tree", "x"), { recursive: true });
  await writeFile(join(gitDir, "sro-repair", "tree", "x", "a.md"), "half written\n");
  await mkdir(join(gitDir, "sro-repair-0badf00d", "tree"), { recursive: true });
  assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["x/a.md"], kept: [] });
  assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "old\n");
  assert.deepEqual(await scratches(gitDir), []);
});

test(
  "a leftover the sweep cannot remove never stops a repair: it builds under a name of its own",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const w = await interrupted();
    const gitDir = join(w.dir, ".git");
    const stuck = join(gitDir, "sro-repair-0badf00d");
    await mkdir(join(stuck, "locked", "inner"), { recursive: true });
    await chmod(join(stuck, "locked"), 0o555);
    try {
      assert.deepEqual(await finishInterrupted(w.state, w.dir), { restored: ["x/a.md"], kept: [] });
      assert.equal(await readFile(join(w.dir, "x/a.md"), "utf8"), "old\n");
      assert.deepEqual(await scratches(gitDir), ["sro-repair-0badf00d"], "the one it could not remove stays");
    } finally {
      await chmod(join(stuck, "locked"), 0o755);
    }
  },
);
