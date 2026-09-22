// Spec 5.4 step 5: a live update (`reset --keep`) that did not finish leaves the
// vault half updated: killed on its timeout, stopped partway by an error (a smudge
// filter that fails), or its process gone. The intent (the old head and the target)
// is recorded before the update starts; after a kill, once the killed process group
// has exited, each path the update was changing is fingerprinted too. The next
// cycle, before its snapshot, puts every path that is still the update's work back
// to the old version (the update then runs again as usual), and never overwrites a
// path that changed since: that is the user's edit.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, gitOk, literal } from "../git.ts";
import { writeAtomic } from "../store.ts";
import { fold } from "./copies.ts";
import { isEffectivelyEmpty, isFinderLitter } from "./state.ts";

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

const errno = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

// Nothing at the path. ENOTDIR too: a file where one of its folders would be
// leaves nothing below it (a note the update turned into a folder, or back).
const absent = (err: unknown): boolean => errno(err) === "ENOENT" || errno(err) === "ENOTDIR";

// Nothing at all at the path (a folder there is something).
async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (err) {
    if (absent(err)) return true;
    throw err;
  }
}

// What is at a path, by content: a file's bytes, a symlink's target, or nothing.
// A folder is nothing here: its files answer for themselves, and a folder that goes
// once the removals have emptied it never makes the path read as edited.
async function fingerprint(path: string): Promise<string | null> {
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
  const path = join(dir, rel);
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
    try {
      await rmdir(join(dir, rel));
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
  const path = join(dir, rel);
  try {
    if ((await lstat(path)).isDirectory()) return;
    await unlink(path);
  } catch (err) {
    if (absent(err)) return;
    throw err;
  }
  await prune(dir, dirname(rel));
}

// The folder a note goes back into. A file where it must be is someone's (the
// update's own were removed first), so the note cannot come back: false.
async function folderFor(path: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    return true;
  } catch (err) {
    if (errno(err) === "EEXIST" || errno(err) === "ENOTDIR") return false;
    throw err;
  }
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
// back, and where case matters nothing is. The walk ends at a wanted spelling that
// names nothing (where case matters, the old tree's first spelling of a folder the user
// deleted): nothing below it can need a respelling, and walking into it would throw on
// every run and strand sync. Where the disk ignores case every wanted spelling names
// what the set-back just put there (the note and its folders), so the walk never ends
// early there.
async function respell(dir: string, names: string[]): Promise<void> {
  let folder = dir;
  for (const part of names) {
    const wanted = join(folder, part);
    const twin = (await readdir(folder)).find((n) => n !== part && fold(n) === fold(part));
    if (twin !== undefined && (await oneEntry(join(folder, twin), wanted))) await rename(join(folder, twin), wanted);
    if (await missing(wanted)) return;
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
    );
    const built = join(tree, source);
    // The rename keeps the file (inode, mode, bytes), so this is what the path holds after.
    const print = await fingerprint(built);
    if (!(await untouched())) return false;
    const target = join(dir, source);
    if (!(await folderFor(dirname(target))) || !(await roomFor(target))) return false;
    await rename(built, target);
    for (const rel of unit) left.set(rel, print);
    await respell(dir, spell(source));
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
  const prints: [string, string | null][] = [];
  for (const path of await changedPaths(dir, from, to)) prints.push([path, await fingerprint(join(dir, path))]);
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
  // The vault's history moved since (someone ran git by hand): nothing was touched.
  moved: boolean;
}

export interface FinishOptions {
  // A repair is a live update too: the live update's own timeout (git.ts
  // LOCAL_TIMEOUT_MS when unset).
  timeoutMs?: number;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isRecord(value: unknown): value is Record_ {
  if (typeof value !== "object" || value === null) return false;
  const { from, to, prints } = value as Record<string, unknown>;
  if (typeof from !== "string" || typeof to !== "string" || !OBJECT_ID.test(from) || !OBJECT_ID.test(to)) return false;
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
// failed lookup, a repair that did not finish, a record it cannot read. Until the
// record is gone no snapshot is taken.
export async function finishInterrupted(stateDir: string, dir: string, opts: FinishOptions = {}): Promise<Finished | null> {
  const path = join(stateDir, RECORD);
  const record = await readRecord(path);
  if (record === null) return null;
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
          const work = printed(rel) ? (await fingerprint(join(dir, rel))) === prints[rel] : await updatesWork(dir, rel, unit, versions);
          if (!work) return false;
        }
        return true;
      };
      // A path the update added that is gone now is what setting it back leaves, whoever
      // removed it (a repair that died after its unlink, or the user), and the retried
      // update writes it again: restored, whatever its fingerprint says.
      const gone = async (): Promise<boolean> => {
        if (unit.some((rel) => old.has(rel))) return false;
        for (const rel of unit) if (!(await missing(join(dir, rel)))) return false;
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
