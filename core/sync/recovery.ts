// Spec 5.4 step 5: a live update (`reset --keep`) that did not finish leaves the
// vault half updated: killed on its timeout, stopped partway by an error (a smudge
// filter that fails), or its process gone. The intent (the old head and the target)
// is recorded before the update starts; after a kill, once the killed process group
// has exited, each path the update was changing is fingerprinted too. The next
// cycle, before its snapshot, puts every path that is still the update's work back
// to the old version (the update then runs again as usual), and never overwrites a
// path that changed since: that is the user's edit.
import { createHash } from "node:crypto";
import { uptime } from "node:os";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, GitError, gitOk, literal, type GitResult } from "../git.ts";
import { writeAtomic } from "../store.ts";
import { fold } from "./copies.ts";
import { isEffectivelyEmpty, isFinderLitter } from "./state.ts";

const RECORD = "interrupted-update.json";

// The repair's own checkout ran past its limit (FinishOptions.timeoutMs): the one timeout
// of the repair that the live update's limit governs, so the cycle takes it for a
// timeout of the live update (cycle.ts doubles the next limit). Every other error of the
// repair, a timeout of a git call with the default limit included, is a GitError or an
// Error as before. It carries the note whose filters it was running, which the status
// names at the ceiling.
export class RepairTimedOut extends GitError {
  readonly path: string;

  constructor(args: string[], result: GitResult, path: string) {
    super(args, result);
    this.name = "RepairTimedOut";
    this.path = path;
  }
}

interface Record_ {
  from: string;
  to: string;
  // The update's process group while it runs, so a session that starts after this one
  // dies can see it running (spec 5.4 step 5). Absent once the process is known to be
  // gone, and absent in a record an older client wrote.
  group?: number;
  // The boot that group belongs to, and when the update started. A record outlives a
  // reboot, after which any process may hold that id, so the group counts only while the
  // boot still matches; the start is how long it has been running, which the status says
  // once that passes the longest limit a live update gets.
  boot?: number;
  startedAt?: number;
  // Each path's fingerprint as the kill left it. A path without one (the process
  // died first, or an error stopped the update) is judged by its content instead.
  prints?: Record<string, string | null>;
}

interface Entry {
  mode: string;
  oid: string;
}

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

// Nothing at the path. A file or a symlink where one of its folders would be is
// onDisk's to find, before any path under it is read.
const absent = (err: unknown): boolean => errno(err) === "ENOENT";

// rel's path under root, or null when rel is not in the vault: the repair never goes
// through a symlink. lstat reads a symlink as itself only as a path's last component
// and follows it anywhere before, so each of rel's folders is lstat'ed from root
// down, and one that is anything but a real folder (a symlink, even to a folder; a
// file, where the update turned a note into a folder or back) puts rel outside the
// vault. Judged, nothing is there; removed, nothing goes; set back, nothing is
// written and rel is kept. Otherwise a symlink in a folder's place, the old tree's,
// the update's or one the user made, would have the repair read, unlink or write a
// file outside the vault. A folder that is absent holds nothing below it: rel is in
// the vault, with nothing at it.
async function onDisk(root: string, rel: string): Promise<string | null> {
  let folder = root;
  for (const part of rel.split("/").slice(0, -1)) {
    folder = join(folder, part);
    try {
      if (!(await lstat(folder)).isDirectory()) return null;
    } catch (err) {
      if (absent(err)) break;
      throw err;
    }
  }
  return join(root, rel);
}

// Nothing at all at rel (a folder there is something).
async function missing(dir: string, rel: string): Promise<boolean> {
  const path = await onDisk(dir, rel);
  if (path === null) return true;
  try {
    await lstat(path);
    return false;
  } catch (err) {
    if (absent(err)) return true;
    throw err;
  }
}

// A folder at the path itself: lstat, so a symlink, even to a folder, is not one.
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (err) {
    if (absent(err)) return false;
    throw err;
  }
}

// What is at rel under root, by content: a file's bytes, a symlink's target, or
// nothing. A folder is nothing here: its files answer for themselves, and a folder
// that goes once the removals have emptied it never makes the path read as edited.
async function fingerprint(root: string, rel: string): Promise<string | null> {
  const path = await onDisk(root, rel);
  if (path === null) return null;
  try {
    const info = await lstat(path);
    if (info.isDirectory()) return null;
    if (info.isSymbolicLink()) return `link:${await readlink(path)}`;
    if (!info.isFile()) return `other:${info.mode}`;
    return `file:${info.mode}:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  } catch (err) {
    if (absent(err)) return null;
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

// Case twins (Note.md and note.md, a case-only rename) are one file where the disk
// ignores case, which git records at init as core.ignorecase (unset: case matters).
async function ignoresCase(dir: string): Promise<boolean> {
  const r = await git(["config", "--type=bool", "--get", "core.ignorecase"], { cwd: dir });
  if (r.code === 1 && !r.timedOut) return false;
  if (r.code !== 0 || r.timedOut) throw new Error(`git config core.ignorecase failed: ${r.stderr.trim() || (r.timedOut ? "timed out" : `exit ${r.code}`)}`);
  return r.stdout.trim() === "true";
}

// The changed paths as the disk holds them: case twins are one file, judged and set
// back together; every other path alone. The twins of a changed path are every path
// that folds to its name: the changed ones and those of the old tree the update left
// unchanged (a tree with Note.md beside note.md, committed where case matters, is one
// file here, which the update rewrote). Removals first, so that a folder the update
// made where a note was is emptied before the note comes back.
function units(changed: string[], old: Map<string, Entry>, twins: boolean): string[][] {
  const byName = new Map<string, string[]>();
  for (const rel of changed) {
    const name = twins ? fold(rel) : rel;
    byName.set(name, [...(byName.get(name) ?? []), rel]);
  }
  if (twins) {
    for (const rel of old.keys()) {
      const unit = byName.get(fold(rel));
      if (unit !== undefined && !unit.includes(rel)) unit.push(rel);
    }
    // Index order (bytes, as git compares names): which old twin goes back depends on it.
    for (const unit of byName.values()) unit.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  }
  const restores = (unit: string[]): boolean => unit.some((rel) => old.has(rel));
  const all = [...byName.values()];
  return [...all.filter((unit) => !restores(unit)), ...all.filter(restores)];
}

// With no fingerprint, a path is still the update's work when it holds the old
// version, the target version, or nothing (git removes a file before writing its
// new version, so absence is what an interrupted rewrite leaves; a folder holds no
// file here either). Case twins are one file: any twin's version counts. Anything
// else is someone's edit. hash-object --path applies the path's clean filter, as
// git add does.
async function updatesWork(dir: string, rel: string, unit: string[], versions: Entry[]): Promise<boolean> {
  const path = await onDisk(dir, rel);
  if (path === null) return true;
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if (absent(err)) return true;
    throw err;
  }
  if (info.isDirectory()) return true;
  const now: Entry[] = [];
  if (info.isSymbolicLink()) {
    now.push({ mode: "120000", oid: await gitOk(["hash-object", "--stdin", "--no-filters"], { cwd: dir, input: await readlink(path) }) });
  } else if (info.isFile()) {
    const mode = info.mode & 0o100 ? "100755" : "100644";
    for (const twin of unit) now.push({ mode, oid: await gitOk(["hash-object", `--path=${twin}`, "--", path], { cwd: dir }) });
  } else {
    return false;
  }
  return now.some((n) => versions.some((e) => e.mode === n.mode && e.oid === n.oid));
}

// Git removes the folders a removal empties, and so does a repair: a note can then
// come back where the update had made a folder for it. Stops at the first folder
// that holds anything; a folder that cannot be removed is left (an empty folder is
// nothing git records), never a reason to stop sync.
async function prune(dir: string, folder: string): Promise<void> {
  for (let rel = folder; rel !== "."; rel = dirname(rel)) {
    const path = await onDisk(dir, rel);
    if (path === null) return;
    try {
      await rmdir(path);
    } catch {
      return;
    }
  }
}

// Removes the file the update wrote at rel (case twins: one file, removed once).
// A folder there is not the update's work: nothing to remove. Only a removal prunes:
// with nothing at rel, the folders around it are as they were (an empty one may be
// the user's).
async function remove(dir: string, rel: string): Promise<void> {
  const path = await onDisk(dir, rel);
  if (path === null) return;
  try {
    if ((await lstat(path)).isDirectory()) return;
    await unlink(path);
  } catch (err) {
    if (absent(err)) return;
    throw err;
  }
  await prune(dir, dirname(rel));
}

// Takes apart a folder found effectively empty, deepest first: each piece of Finder
// litter by a single-file unlink, each folder by rmdir, never a recursive removal.
// Anything else found now (a note saved meanwhile) is left where it is, its folder's
// rmdir fails, and so does this: false.
async function clear(path: string): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!(await clear(child))) return false;
    } else if (isFinderLitter(entry.name)) {
      await unlink(child);
    }
  }
  try {
    await rmdir(path);
    return true;
  } catch (err) {
    if (errno(err) === "ENOTEMPTY" || errno(err) === "EEXIST") return false;
    throw err;
  }
}

// Clears the path for the note. Nothing there, or a file (which the rename replaces):
// true. A folder whose whole subtree holds only folders and Finder litter (empty as
// state.ts reads a folder) goes, and the note comes back: the old tree held a file
// here, so those folders appeared after the update began (the update's, emptied by the
// removals before, or left by a repair that died before its prune), and a path left
// empty would reach the snapshot as a deletion. A folder holding anything else is
// someone's: false, and nothing in it is touched.
async function roomFor(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if (absent(err)) return true;
    throw err;
  }
  if (!info.isDirectory()) return true;
  return (await isEffectivelyEmpty(path)) && clear(path);
}

// Whether two spellings name one entry on disk (same device and inode). Where the disk
// ignores case, a twin and the wanted spelling do; where it tells case apart they are
// two files, or the wanted one is not there.
async function oneEntry(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = [await lstat(a), await lstat(b)];
    return x.dev === y.dev && x.ino === y.ino;
  } catch (err) {
    if (absent(err)) return false;
    throw err;
  }
}

// How git's own checkout of the old tree spells a path of it on this disk, component
// by component. Git writes the entries in index order: a folder is made under the
// first spelling that needs it, and a file is replaced by each later spelling (so the
// last one's name and content stay; setBack picks that one). Checked against git's
// clone of such trees on a disk that ignores case: two and three spellings of a
// note, a folder spelled two ways, a folder and a note each spelled two ways. Where
// case matters the spellings name separate entries, and respell renames none.
function spellings(old: Map<string, Entry>): (rel: string) => string[] {
  const first = new Map<string, string>();
  for (const rel of old.keys()) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = fold(parts.slice(0, i).join("/"));
      if (!first.has(folder)) first.set(folder, parts[i - 1] ?? "");
    }
  }
  return (rel) => rel.split("/").map((part, i, parts) => (i < parts.length - 1 ? (first.get(fold(parts.slice(0, i + 1).join("/"))) ?? part) : part));
}

// A rename onto a case twin keeps the twin's spelling (APFS, verified), and a folder
// git made for a new spelling keeps it: each component of the path set back, folders
// included, takes the spelling git's own checkout of the old tree gives it (`names`),
// walked from the vault root as the cycle's snapshot reads spellings. Only an entry
// that is the wanted one under another spelling is renamed: a different file (a stale
// core.ignorecase=true on a disk where case matters) is never renamed over the one set
// back, and where case matters nothing is. The walk goes down only into a folder, never
// through a symlink: it ends at a wanted spelling that names nothing or anything else
// (where case matters, the old tree's first spelling of a folder the user deleted, or
// replaced with a file). Nothing below it can need a respelling, and walking into it
// would throw on every run and strand sync. Where the disk ignores case each wanted
// folder spelling names a folder the set-back went through, so the walk ends early
// there only at a symlink the user put in a folder's place.
async function respell(dir: string, names: string[]): Promise<void> {
  let folder = dir;
  for (const part of names) {
    const wanted = join(folder, part);
    const twin = (await readdir(folder)).find((n) => n !== part && fold(n) === fold(part));
    if (twin !== undefined && (await oneEntry(join(folder, twin), wanted))) await rename(join(folder, twin), wanted);
    if (!(await isFolder(wanted))) return;
    folder = wanted;
  }
}

// Puts a unit the caller found untouched back to the old version, and says false
// when it changed while that version was being built (someone's edit, which it then
// leaves alone) or when something that is not the update's is in the way. What it
// leaves at each path goes into `left`, for the record if the repair stops. The old
// version is checked out aside, into a scratch worktree inside the git directory
// (the same filesystem, so the rename into place is atomic), with its own index, no
// hook, and the old version's own .gitattributes (--attr-source: the scratch tree
// has none, and a filter they name, LFS or git-crypt, would otherwise be skipped): a
// repair that is slow, fails or is killed changes nothing in the vault and strands
// no lock there (git.ts removes no killed checkout's lock, spec 5.6). The path is
// checked again just before the rename, so an edit is lost only if it lands in that
// instant (5.4 step 5's accepted limitation). The vault's own index still holds the
// old entries the killed update never replaced, and the snapshot's `git add -A`
// realigns anything else.
async function setBack(
  dir: string,
  unit: string[],
  from: string,
  old: Map<string, Entry>,
  untouched: () => Promise<boolean>,
  timeoutMs: number | undefined,
  left: Map<string, string | null>,
  spell: (rel: string) => string[],
): Promise<boolean> {
  // Case twins: a twin the old version had (never a removal of the file another twin
  // names). Where the old tree held several, the last in index order, as git's own
  // checkout of it leaves (see spellings).
  const source = unit.findLast((rel) => old.has(rel));
  if (source === undefined) {
    await remove(dir, unit[0] ?? "");
    for (const rel of unit) left.set(rel, null);
    return true;
  }
  const scratch = join(await gitOk(["rev-parse", "--absolute-git-dir"], { cwd: dir }), "sro-repair");
  const tree = join(scratch, "tree");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(tree, { recursive: true });
  try {
    await gitOk(
      [
        `--attr-source=${from}`,
        `--git-dir=${dirname(scratch)}`,
        `--work-tree=${tree}`,
        "-c",
        `core.hooksPath=${join(scratch, "no-hooks")}`,
        "checkout",
        "-q",
        from,
        "--",
        literal(source),
      ],
      { cwd: tree, env: { GIT_INDEX_FILE: join(scratch, "index") }, timeoutMs },
    ).catch((err: unknown) => {
      throw err instanceof GitError && err.result.timedOut ? new RepairTimedOut(err.args, err.result, source) : err;
    });
    const built = join(tree, source);
    // The rename keeps the file (inode, mode, bytes), so this is what the path holds after.
    const print = await fingerprint(tree, source);
    if (!(await untouched())) return false;
    // A folder of the note that is not a real folder (a symlink, a file) is someone's:
    // the note cannot come back without writing through it or over it (onDisk).
    const target = await onDisk(dir, source);
    if (target === null) return false;
    // A path that already holds the old version (an update that never reached it) is
    // left as it is: nothing to rewrite, and it counts as set back.
    if ((await fingerprint(dir, source)) !== print) {
      await mkdir(dirname(target), { recursive: true });
      if (!(await roomFor(target))) return false;
      await rename(built, target);
    }
    for (const rel of unit) left.set(rel, print);
    await respell(dir, spell(source));
    return true;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Written before the live update starts, so a process death or a failed recording still
// leaves a record of what the update was changing, and again with the update's process
// group as soon as git is spawned (cycle.ts), with the boot that group belongs to and the
// moment it started. The instant between the spawn and that second write is not covered:
// a session that dies inside it leaves a record with no group, which the next cycle
// repairs as it always has.
export async function recordIntent(stateDir: string, from: string, to: string, group?: number): Promise<void> {
  const record: Record_ = group === undefined ? { from, to } : { from, to, group, boot: bootInstant(), startedAt: Date.now() };
  await writeAtomic(join(stateDir, RECORD), JSON.stringify(record));
}

// When this machine booted, as a wall-clock instant to the second: os.uptime() is the
// seconds since boot, so now minus it is the same number in every process of this boot.
// Exported for the tests that write a record by hand.
export function bootInstant(): number {
  return Math.round((Date.now() - uptime() * 1000) / 1000) * 1000;
}

// How far a record's boot may sit from this one and still be this boot: uptime() counts
// whole seconds and the clock can be adjusted under it, so two readings differ by a
// second or two, while a reboot moves this by far more.
const BOOT_TOLERANCE_MS = 5000;

// Spec 5.6's model for the lock's pid, applied to a process group: ESRCH means it is
// gone, EPERM means it is alive under another user, and anything else is treated as
// alive, since nothing may repair over an update that might still be running. A group id
// this boot has since given to something else therefore reads as alive and sync waits for
// a process that is not ours: the accepted limitation, as for the lock, and bounded by
// the boot check above, since a record from an earlier boot names no group at all.
function groupAlive(group: number): boolean {
  // The plugin's process groups are POSIX: git.ts spawns detached and kills -pgid on a
  // timeout, and CI runs ubuntu and macOS. Where the platform has none the question
  // cannot be answered at all, and answering "gone" lets the repair run, rather than
  // leaving sync waiting for ever. There is no Windows path.
  if (process.platform === "win32") return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch (err) {
    return errno(err) !== "ESRCH";
  }
}

export interface RunningUpdate {
  // The update's process group, which the status names.
  group: number;
  // How long it has been running. A start in the future (the clock moved back under it)
  // reads as just started, never as long-running.
  runningMs: number;
}

// The live update that may still be running, or null: no record, a record with no group,
// a group of an earlier boot (any process may hold that id now, so it counts for
// nothing), or a group that has exited. Read before the repair (cycle.ts): repairing or
// snapshotting over a running update would set its notes back under it and push the old
// versions as this machine's change.
export async function runningUpdate(stateDir: string): Promise<RunningUpdate | null> {
  const record = await readRecord(join(stateDir, RECORD));
  if (record?.group === undefined) return null;
  if (record.boot === undefined || Math.abs(bootInstant() - record.boot) > BOOT_TOLERANCE_MS) return null;
  if (!groupAlive(record.group)) return null;
  return { group: record.group, runningMs: Math.max(0, Date.now() - (record.startedAt ?? Date.now())) };
}

// Called after git() returned for the killed reset, so its process group is gone.
export async function recordInterrupted(stateDir: string, dir: string, from: string, to: string): Promise<void> {
  const prints: [string, string | null][] = [];
  for (const path of await changedPaths(dir, from, to)) prints.push([path, await fingerprint(dir, path)]);
  // fromEntries: a path named __proto__ is a key like any other.
  await writeAtomic(join(stateDir, RECORD), JSON.stringify({ from, to, prints: Object.fromEntries(prints) } satisfies Record_));
}

// The update finished, or git refused it as a whole before writing anything.
export async function clearInterrupted(stateDir: string): Promise<void> {
  await rm(join(stateDir, RECORD), { force: true });
}

export interface Finished {
  // Paths put back to the old version, to be updated again by this cycle.
  restored: string[];
  // Paths that changed after the update stopped: the user's edits, left as they are
  // (also a path that could come back only over the user's files: a note of theirs
  // where its folder would be, or a folder they put a note in).
  kept: string[];
}

export interface FinishOptions {
  // A repair is a live update too: the live update's own limit (git.ts
  // LOCAL_TIMEOUT_MS when unset). Its checkout run past it throws RepairTimedOut.
  timeoutMs?: number;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isRecord(value: unknown): value is Record_ {
  if (typeof value !== "object" || value === null) return false;
  const { from, to, group, boot, startedAt, prints } = value as Record<string, unknown>;
  if (typeof from !== "string" || typeof to !== "string" || !OBJECT_ID.test(from) || !OBJECT_ID.test(to)) return false;
  // A group of 0 or 1 is no update's: process.kill(-1, ...) signals every process this
  // user may signal, so a record naming one is read as unreadable, like any other.
  if (group !== undefined && (typeof group !== "number" || !Number.isInteger(group) || group < 2)) return false;
  for (const stamp of [boot, startedAt]) if (stamp !== undefined && (typeof stamp !== "number" || !Number.isFinite(stamp))) return false;
  if (prints === undefined) return true;
  return typeof prints === "object" && prints !== null && !Array.isArray(prints) && Object.values(prints).every((p) => p === null || typeof p === "string");
}

// The record, or null when there is none. One that cannot be read is never guessed
// at (without its two commits nothing can be judged): it stops sync with a message
// that says which file and what to do.
async function readRecord(path: string): Promise<Record_ | null> {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (errno(err) === "ENOENT") return null;
    throw err;
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    record = undefined;
  }
  if (!isRecord(record)) {
    throw new Error(
      `the record of an interrupted vault update cannot be read: '${path}' (it does not name the update's two commits). Delete that file to let sync carry on; \`git status\` in the vault shows what that update had changed.`,
    );
  }
  return record;
}

// Throws, leaving the record, whenever it cannot tell: a HEAD it cannot read, a
// failed lookup, a repair that did not finish, a record it cannot read, a history
// that moved since. Until the record is gone no snapshot is taken.
export async function finishInterrupted(stateDir: string, dir: string, opts: FinishOptions = {}): Promise<Finished | null> {
  const path = join(stateDir, RECORD);
  const record = await readRecord(path);
  if (record === null) return null;
  const head = await gitOk(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: dir });
  const done: Finished = { restored: [], kept: [] };
  if (head === record.to) {
    // The update had finished (HEAD moves last); nothing is left to repair.
  } else if (head !== record.from) {
    // Someone moved the vault's history by hand (a commit, a reset) after the update
    // stopped partway: its record no longer says what the old version is, so nothing
    // can be judged. Dropped, the record would let the next snapshot send what the
    // update left half done (a note it had unlinked) as the user's own change: it is
    // kept, and sync stops until the user has looked.
    throw new Error(
      `an interrupted vault update cannot be finished: the vault's history moved since it began (git by hand), and its record '${path}' is kept. Check \`git status\` in Projects/: it shows what that update left half done, which sync would send as your own changes. Undo what you did not change yourself, then delete that file to let sync carry on.`,
    );
  } else {
    const old = await treeOf(dir, record.from);
    const target = await treeOf(dir, record.to);
    const prints = record.prints ?? {};
    const printed = (rel: string): boolean => Object.hasOwn(prints, rel);
    const twins = await ignoresCase(dir);
    const spell = spellings(old);
    // What the repair has left at each path it set back.
    const left = new Map<string, string | null>();
    for (const unit of units(await changedPaths(dir, record.from, record.to), old, twins)) {
      const versions = unit.flatMap((rel) => [old.get(rel), target.get(rel)]).filter((e) => e !== undefined);
      // Each path of the unit: unchanged since the kill where it has a fingerprint, the
      // update's work by content where it has none (as an unchanged twin, which the kill
      // never fingerprints).
      // Where the disk ignores case every path names the one file; where core.ignorecase
      // is stale they are separate files, and each must be the update's to be set back.
      const untouched = async (): Promise<boolean> => {
        for (const rel of unit) {
          const work = printed(rel) ? (await fingerprint(dir, rel)) === prints[rel] : await updatesWork(dir, rel, unit, versions);
          if (!work) return false;
        }
        return true;
      };
      // A path the update added that is gone now is what setting it back leaves, whoever
      // removed it (a repair that died after its unlink, or the user), and the retried
      // update writes it again: restored, whatever its fingerprint says.
      const gone = async (): Promise<boolean> => {
        if (unit.some((rel) => old.has(rel))) return false;
        for (const rel of unit) if (!(await missing(dir, rel))) return false;
        return true;
      };
      let back: boolean;
      try {
        back = (await gone()) || ((await untouched()) && (await setBack(dir, unit, record.from, old, untouched, opts.timeoutMs, left, spell)));
      } catch (err) {
        // What the repair left becomes the record's fingerprint there, so the next
        // run never takes its own work for an edit. A record that cannot be written
        // leaves the older one, which errs toward keeping; either way the caller
        // gets the error that stopped the repair.
        const now = { ...prints, ...Object.fromEntries(left) };
        await writeAtomic(path, JSON.stringify({ ...record, prints: now } satisfies Record_)).catch(() => undefined);
        throw err;
      }
      (back ? done.restored : done.kept).push(...unit);
    }
  }
  await rm(path, { force: true });
  return done;
}
