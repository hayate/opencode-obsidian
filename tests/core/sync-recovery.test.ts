import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOk } from "../../core/git.ts";
import { finishInterrupted, recordIntent, recordInterrupted } from "../../core/sync/recovery.ts";
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
  const w = await interrupted({}, { stillSlow: true });
  await gitOk(["config", "filter.slow.smudge", "sleep 2; cat"], { cwd: w.dir });
  const finishing = finishInterrupted(w.state, w.dir);
  await sleep(700);
  await writeFile(join(w.dir, "x/a.md"), "saved during the repair\n");
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
