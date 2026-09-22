// Spec 5.4 step 5: a live update (`reset --keep`) that did not finish leaves the
// vault half updated: killed on its timeout, stopped partway by an error (a smudge
// filter that fails), or its process gone. The intent (the old head and the target)
// is recorded before the update starts; after a kill, once the killed process group
// has exited, each path the update was changing is fingerprinted too. The next
// cycle, before its snapshot, puts every path that is still the update's work back
// to the old version (the update then runs again as usual), and never overwrites a
// path that changed since: that is the user's edit.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, gitOk, literal } from "../git.ts";
import { writeAtomic } from "../store.ts";

const RECORD = "interrupted-update.json";

interface Record_ {
  from: string;
  to: string;
  // Each path's fingerprint as the kill left it. A path without one (the process
  // died first, or an error stopped the update) is judged by its content instead.
  prints?: Record<string, string | null>;
}

interface Entry {
  mode: string;
  oid: string;
}

// What is at a path, by content: a file's bytes, a symlink's target, or absence.
async function fingerprint(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return `link:${await readlink(path)}`;
    if (!info.isFile()) return `other:${info.mode}`;
    return `file:${info.mode}:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function changedPaths(dir: string, from: string, to: string): Promise<string[]> {
  const r = await git(["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", "-z", from, to], { cwd: dir });
  if (r.code !== 0 || r.timedOut) throw new Error(`git diff ${from} ${to} failed: ${r.stderr.trim() || (r.timedOut ? "timed out" : `exit ${r.code}`)}`);
  return r.stdout.split("\0").filter(Boolean);
}

// Every entry of a commit's tree by path. An error throws; a path not listed is
// absent (never "absent" because a lookup failed).
async function treeOf(dir: string, commit: string): Promise<Map<string, Entry>> {
  const r = await git(["ls-tree", "-r", "-z", "--full-tree", commit], { cwd: dir });
  if (r.code !== 0 || r.timedOut) throw new Error(`git ls-tree ${commit} failed: ${r.stderr.trim() || (r.timedOut ? "timed out" : `exit ${r.code}`)}`);
  const entries = new Map<string, Entry>();
  for (const line of r.stdout.split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const [mode = "", , oid = ""] = line.slice(0, tab).split(" ");
    entries.set(line.slice(tab + 1), { mode, oid });
  }
  return entries;
}

// With no fingerprint, a path is still the update's work when it holds the old
// version, the target version, or nothing (git removes a file before writing its
// new version, so absence is what an interrupted rewrite leaves). Anything else is
// someone's edit. hash-object --path applies the path's clean filter, as git add does.
async function updatesWork(dir: string, rel: string, old: Entry | undefined, target: Entry | undefined): Promise<boolean> {
  const path = join(dir, rel);
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  let now: Entry;
  if (info.isSymbolicLink()) {
    now = { mode: "120000", oid: await gitOk(["hash-object", "--stdin", "--no-filters"], { cwd: dir, input: await readlink(path) }) };
  } else if (info.isFile()) {
    now = { mode: info.mode & 0o100 ? "100755" : "100644", oid: await gitOk(["hash-object", `--path=${rel}`, "--", path], { cwd: dir }) };
  } else {
    return false;
  }
  return [old, target].some((e) => e?.mode === now.mode && e?.oid === now.oid);
}

// Puts a path the caller found untouched back to the old version, and says false
// when the path changed while that version was being built (someone's edit, which
// it then leaves alone). The old
// version is checked out aside, into a scratch worktree inside the git directory
// (the same filesystem, so the rename into place is atomic), with its own index and
// no hook: a repair that is slow, fails or is killed changes nothing in the vault
// and strands no lock there (git.ts removes no killed checkout's lock, spec 5.6).
// The path is checked again just before the rename, so an edit is lost only if it
// lands in that instant (5.4 step 5's accepted limitation). The vault's own index
// still holds the old entries the killed update never replaced, and the snapshot's
// `git add -A` realigns anything else.
async function setBack(
  dir: string,
  rel: string,
  from: string,
  old: Entry | undefined,
  untouched: () => Promise<boolean>,
  timeoutMs: number | undefined,
): Promise<boolean> {
  const target = join(dir, rel);
  if (!old) {
    await rm(target, { force: true });
    return true;
  }
  const scratch = join(await gitOk(["rev-parse", "--absolute-git-dir"], { cwd: dir }), "sro-repair");
  const tree = join(scratch, "tree");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(tree, { recursive: true });
  try {
    await gitOk(
      [`--git-dir=${dirname(scratch)}`, `--work-tree=${tree}`, "-c", `core.hooksPath=${join(scratch, "no-hooks")}`, "checkout", "-q", from, "--", literal(rel)],
      { cwd: tree, env: { GIT_INDEX_FILE: join(scratch, "index") }, timeoutMs },
    );
    if (!(await untouched())) return false;
    await mkdir(dirname(target), { recursive: true });
    // A folder the update made where the note was, emptied by the removals before.
    await rmdir(target).catch(() => undefined);
    await rename(join(tree, rel), target);
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Written before the live update starts, so a process death or a failed recording
// still leaves a record of what the update was changing.
export async function recordIntent(stateDir: string, from: string, to: string): Promise<void> {
  await writeAtomic(join(stateDir, RECORD), JSON.stringify({ from, to } satisfies Record_));
}

// Called after git() returned for the killed reset, so its process group is gone.
export async function recordInterrupted(stateDir: string, dir: string, from: string, to: string): Promise<void> {
  const prints: Record<string, string | null> = {};
  for (const path of await changedPaths(dir, from, to)) prints[path] = await fingerprint(join(dir, path));
  await writeAtomic(join(stateDir, RECORD), JSON.stringify({ from, to, prints } satisfies Record_));
}

// The update finished, or git refused it as a whole before writing anything.
export async function clearInterrupted(stateDir: string): Promise<void> {
  await rm(join(stateDir, RECORD), { force: true });
}

export interface Finished {
  // Paths put back to the old version, to be updated again by this cycle.
  restored: string[];
  // Paths that changed after the update stopped: the user's edits, left as they are.
  kept: string[];
  // The vault's history moved since (someone ran git by hand): nothing was touched.
  moved: boolean;
}

export interface FinishOptions {
  // A repair is a live update too: the live update's own timeout (git.ts
  // LOCAL_TIMEOUT_MS when unset).
  timeoutMs?: number;
}

// Throws, leaving the record, whenever it cannot tell: a HEAD it cannot read, a
// failed lookup, a repair that did not finish. Until the record is gone no
// snapshot is taken.
export async function finishInterrupted(stateDir: string, dir: string, opts: FinishOptions = {}): Promise<Finished | null> {
  const path = join(stateDir, RECORD);
  let record: Record_;
  try {
    record = JSON.parse(await readFile(path, "utf8")) as Record_;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const head = await gitOk(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: dir });
  const done: Finished = { restored: [], kept: [], moved: false };
  if (head === record.to) {
    // The update had finished (HEAD moves last); nothing is left to repair.
  } else if (head !== record.from) {
    done.moved = true;
  } else {
    const old = await treeOf(dir, record.from);
    const target = await treeOf(dir, record.to);
    const prints = record.prints ?? {};
    const changed = await changedPaths(dir, record.from, record.to);
    // Removals first: a folder the update made where a note was is emptied before
    // the note comes back.
    for (const rel of [...changed.filter((p) => !old.has(p)), ...changed.filter((p) => old.has(p))]) {
      const untouched = async (): Promise<boolean> =>
        rel in prints ? (await fingerprint(join(dir, rel))) === prints[rel] : updatesWork(dir, rel, old.get(rel), target.get(rel));
      let back: boolean;
      try {
        back = (await untouched()) && (await setBack(dir, rel, record.from, old.get(rel), untouched, opts.timeoutMs));
      } catch (err) {
        // Nothing at this path changed. The ones already set back hold the old
        // version now, which the record takes as its own for the next run.
        const now = { ...prints };
        for (const p of done.restored) now[p] = await fingerprint(join(dir, p));
        await writeAtomic(path, JSON.stringify({ ...record, prints: now } satisfies Record_));
        throw err;
      }
      (back ? done.restored : done.kept).push(rel);
    }
  }
  await rm(path, { force: true });
  return done;
}
