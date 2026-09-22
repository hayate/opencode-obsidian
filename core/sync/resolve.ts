// Spec 5.4 step 3: one 3-way merge of trees in the state clone, and the conflict
// rules that keep both versions: the local side stays at the path, the remote
// side is added beside it as a conflict copy. Nothing here touches a worktree.
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git.ts";
import { EMPTY_TREE } from "../secrets.ts";
import { copyPath, isCopyOf, TreeNames } from "./copies.ts";

export interface Entry {
  mode: string;
  oid: string;
}

export type ConflictKind = "both-changed" | "deleted-here" | "deleted-there" | "two-names" | "file-folder" | "type-differs";

export interface Conflict {
  kind: ConflictKind;
  // The note as the user knows it on this machine.
  path: string;
  // Where the other side's version went, or null when nothing needed a copy.
  copy: string | null;
  // rename/rename: the other machine's name for the note.
  other?: string;
}

export type Resolution =
  | { kind: "clean"; tree: string; conflicts: Conflict[] }
  | { kind: "stop"; reason: string; paths: string[] };

type Stages = Partial<Record<1 | 2 | 3, Entry>>;

interface MergeRecord {
  paths: string[];
  type: string;
}

interface Merge {
  tree: string;
  stages: Map<string, Stages>;
  records: MergeRecord[];
}

// The one record type that is information, not a conflict (merge-ort.c, git 2.47.3
// and 2.50.1). Every other type must match a rule below or stop the cycle: git
// also spells some types without the space ("CONFLICT(directory rename collision)").
const INFORMATIONAL = "Auto-merging";
const COLLISION = "CONFLICT (rename involved in collision)";

// The types a rule in mergeAndResolve resolves. A type outside this list stops the
// cycle before any other record's rule can count its paths as resolved: nothing
// says what such a record means.
const RULED = [
  "CONFLICT (contents)",
  "CONFLICT (binary)",
  COLLISION,
  "CONFLICT (modify/delete)",
  "CONFLICT (rename/delete)",
  "CONFLICT (rename/rename)",
  "CONFLICT (file/directory)",
  "CONFLICT (distinct modes)",
] as const;
// Narrows a record's type, so a rule for a type missing from RULED does not compile.
const hasRule = (type: string): type is (typeof RULED)[number] => (RULED as readonly string[]).includes(type);

// Raw stdout, never gitOk's trimmed form: -z output ends in NULs that matter.
async function run(clone: string, args: string[], env?: Record<string, string>, input?: string): Promise<string> {
  const r = await git(args, { cwd: clone, env, input });
  if (r.code !== 0 || r.timedOut) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

// `merge-tree --write-tree -z --messages` output (verified on git 2.47.3 and 2.50.1):
// the tree, NUL; "<mode> <oid> <stage>\t<path>" entries, each NUL-ended; an empty
// field; then records "<count>" NUL <count paths> NUL-separated, "<type>" NUL
// "<message>" NUL.
function parseMerge(stdout: string): Merge {
  const fields = stdout.split("\0");
  let i = 0;
  const tree = fields[i++] ?? "";
  const stages = new Map<string, Stages>();
  for (; i < fields.length && fields[i] !== ""; i++) {
    const field = fields[i] ?? "";
    const tab = field.indexOf("\t");
    const [mode = "", oid = "", stage = ""] = field.slice(0, tab).split(" ");
    const path = field.slice(tab + 1);
    stages.set(path, { ...stages.get(path), [Number(stage)]: { mode, oid } });
  }
  i++;
  const records: Merge["records"] = [];
  while (i < fields.length && fields[i] !== "") {
    const count = Number(fields[i++]);
    const paths = fields.slice(i, i + count);
    i += count;
    const type = fields[i++] ?? "";
    i++; // the human message
    records.push({ paths, type });
  }
  return { tree, stages, records };
}

async function listTree(clone: string, tree: string): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  for (const line of (await run(clone, ["ls-tree", "-r", "-z", tree])).split("\0")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    const [mode = "", , oid = ""] = line.slice(0, tab).split(" ");
    entries.set(line.slice(tab + 1), { mode, oid });
  }
  return entries;
}

function withFolders(paths: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let n = 1; n <= parts.length; n++) all.add(parts.slice(0, n).join("/"));
  }
  return [...all];
}

const same = (a: Entry | undefined, b: Entry | undefined): boolean => a?.mode === b?.mode && a?.oid === b?.oid;
const key = (e: Entry): string => `${e.mode} ${e.oid}`;

// What git's merge said and what the two input commits hold. The check derives its
// requirements from these alone, never from the rules' resolution.
export interface MergeFacts {
  records: MergeRecord[];
  stages: Map<string, Stages>;
  // git's merged tree, marker results and ~<side> relocations included.
  result: Map<string, Entry>;
  // The remote head's tree (ours, stage 2) and the live snapshot's (theirs, stage 3).
  remote: Map<string, Entry>;
  local: Map<string, Entry>;
}

// Each side's commit tree, and the objects in it by mode and id.
function sidesOf(facts: MergeFacts): Record<2 | 3, { tree: Map<string, Entry>; has: Set<string> }> {
  const side = (tree: Map<string, Entry>) => ({ tree, has: new Set([...tree.values()].map(key)) });
  return { 2: side(facts.remote), 3: side(facts.local) };
}

// The merged tree written through a temporary index inside the clone: removals,
// then additions, then write-tree. The index file never outlives the call.
export async function writeResolved(clone: string, base: string, from: Map<string, Entry>, to: Map<string, Entry>): Promise<string> {
  const index = join(clone, `sro-index-${randomBytes(4).toString("hex")}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    await run(clone, ["read-tree", base], env);
    const removed = [...from.keys()].filter((p) => !to.has(p) || !same(from.get(p), to.get(p)));
    const added = [...to].filter(([p, e]) => !same(from.get(p), e));
    if (removed.length) {
      await run(clone, ["update-index", "-z", "--index-info"], env, removed.map((p) => `0 ${"0".repeat(40)}\t${p}\0`).join(""));
    }
    if (added.length) {
      await run(clone, ["update-index", "-z", "--index-info"], env, added.map(([p, e]) => `${e.mode} ${e.oid}\t${p}\0`).join(""));
    }
    return (await run(clone, ["write-tree"], env)).trim();
  } finally {
    await rm(index, { force: true });
    await rm(`${index}.lock`, { force: true });
  }
}

export interface MergeOptions {
  // The adopt-a-rewritten-remote path (5.4 step 3) names its own base.
  mergeBase?: string;
  // The conflict time in copy names (copies.ts conflictStamp).
  when: string;
  // Writes the resolved tree (writeResolved); a test swaps in a faulty writer to
  // prove the check stops what it wrote.
  writeTree?: typeof writeResolved;
}

// Merge ours (the remote head U) with theirs (the live snapshot L). A clean result
// or one resolved by the rules is "clean"; a conflict no rule covers is "stop".
export async function mergeAndResolve(clone: string, ours: string, theirs: string, opts: MergeOptions): Promise<Resolution> {
  const args = [
    // A synced .gitattributes must not choose a merge driver.
    `--attr-source=${EMPTY_TREE}`,
    "-c",
    "merge.directoryRenames=false",
    "merge-tree",
    "--write-tree",
    "-z",
    "--messages",
    ...(opts.mergeBase ? [`--merge-base=${opts.mergeBase}`] : []),
    ours,
    theirs,
  ];
  const r = await git(args, { cwd: clone });
  if ((r.code !== 0 && r.code !== 1) || r.timedOut) {
    throw new Error(`git merge-tree failed: ${r.stderr.trim() || (r.timedOut ? "timed out" : `exit ${r.code}`)}`);
  }
  const merge = parseMerge(r.stdout);
  if (r.code === 0) return { kind: "clean", tree: merge.tree, conflicts: [] };

  const facts: MergeFacts = {
    records: merge.records,
    stages: merge.stages,
    result: await listTree(clone, merge.tree),
    remote: await listTree(clone, ours),
    local: await listTree(clone, theirs),
  };
  const { result } = facts;
  const sides = sidesOf(facts);
  const final = new Map(result);
  const names = new TreeNames(withFolders(result.keys()));
  const conflicts: Conflict[] = [];
  const handled = new Set<string>();
  // A side's version is its stage entry (2 the remote, 3 the local), which follows
  // renames: a note renamed here and edited there has the remote's text at the new
  // name. The two record types whose stages hold git's merged output instead
  // (rename/rename, a rename collision) read the side commits; the check below stops
  // any merged output a rule would leave in place.
  const stage = (path: string, n: 2 | 3): Entry | undefined => merge.stages.get(path)?.[n];
  const stop = (reason: string, paths: string[]): Resolution => ({ kind: "stop", reason, paths });

  const put = (path: string, entry: Entry): void => {
    final.set(path, entry);
    names.add(path);
  };
  // An existing copy of the same version of the same note (original path, mode and
  // object) is reused, never added twice.
  const placeCopy = (original: string, entry: Entry): string => {
    for (const [path, e] of final) if (isCopyOf(original, path) && same(e, entry)) return path;
    const path = copyPath(original, entry.oid, opts.when, (p) => names.taken(p));
    put(path, entry);
    return path;
  };

  // A rename collision resolves all of its paths, and a local file that displaces a
  // remote folder moves the whole folder aside: git's later records on those paths
  // count as resolved. A record on the folder can also name a path neither commit
  // holds (the old name of a note renamed into the folder there and deleted here);
  // neither side has a note there to keep, so the folder move resolves that record too.
  const collided = new Set<string>();
  const displaced: string[] = [];
  // The folder copies the file/directory rule chose, moved after the loop.
  const asideMoves: Array<{ path: string; folder: string }> = [];
  for (const record of merge.records) {
    if (record.type === COLLISION) for (const path of record.paths) collided.add(path);
    if (record.type === "CONFLICT (file/directory)") {
      const moved = record.paths.find((p) => stage(p, 2) || stage(p, 3));
      const path = record.paths.find((p) => p !== moved);
      if (moved && path && stage(moved, 3)) displaced.push(path);
    }
  }
  const movedAside = (path: string): boolean => displaced.some((f) => path.startsWith(`${f}/`));
  const inNeither = (path: string): boolean => !sides[2].tree.has(path) && !sides[3].tree.has(path);
  const resolvedElsewhere = (paths: string[]): boolean =>
    paths.every((p) => collided.has(p) || movedAside(p)) ||
    (paths.some(movedAside) && paths.every((p) => movedAside(p) || inNeither(p)));
  const contentRecordAt = (path: string): boolean =>
    merge.records.some((r) => (r.type === "CONFLICT (contents)" || r.type === "CONFLICT (binary)") && r.paths.includes(path));

  for (const record of merge.records) {
    if (record.type === INFORMATIONAL) continue;
    if (!record.paths.length) return stop(`git reported ${record.type} without a path`, []);
    if (!hasRule(record.type)) return stop(`git reported ${record.type}, which the plugin cannot resolve by itself`, record.paths);
    for (const path of record.paths) handled.add(path);
    if (record.type !== COLLISION && resolvedElsewhere(record.paths)) continue;
    switch (record.type) {
      case "CONFLICT (contents)":
      case "CONFLICT (binary)": {
        const path = record.paths.find((p) => stage(p, 2) && stage(p, 3));
        const local = path && stage(path, 3);
        const remote = path && stage(path, 2);
        if (!path || !local || !remote) return stop(`git reported ${record.type} without both versions`, record.paths);
        // git reports a binary clash twice, as binary and then as contents: one conflict.
        if (conflicts.some((c) => c.kind === "both-changed" && c.path === path)) break;
        put(path, local);
        conflicts.push({ kind: "both-changed", path, copy: placeCopy(path, remote) });
        break;
      }
      case COLLISION: {
        // git merged the renamed note with the other side's source before placing it,
        // so its result can hold nested markers and lack the local source (verified,
        // git 2.50.1). Each version comes from its side's own commit: every local one
        // stays at its path, every remote one that differs becomes a copy of its path.
        // A path the local side lacks is a source it renamed away, which git's result
        // never holds.
        for (const path of record.paths) {
          const local = sides[3].tree.get(path);
          const remote = sides[2].tree.get(path);
          if (local) put(path, local);
          if (remote && !same(remote, local)) {
            conflicts.push({ kind: local ? "both-changed" : "deleted-here", path, copy: placeCopy(path, remote) });
          }
        }
        break;
      }
      case "CONFLICT (modify/delete)":
      case "CONFLICT (rename/delete)": {
        // modify/delete names one path; rename/delete names the new path, then the old.
        const path = record.paths[0] ?? "";
        const known = record.paths[record.paths.length - 1] ?? path;
        const local = stage(path, 3);
        const remote = stage(path, 2);
        if (local && !remote) {
          put(path, local);
          conflicts.push({ kind: "deleted-there", path, copy: null });
        } else if (remote && !local) {
          final.delete(path);
          conflicts.push({ kind: "deleted-here", path: known, copy: placeCopy(path, remote) });
        } else if (local && remote && record.type === "CONFLICT (rename/delete)" && contentRecordAt(path)) {
          // The note was renamed onto a name the other side also uses: the other
          // entry there is that side's own note, and git's contents (or binary)
          // record at the name resolves the pair (the local entry stays, the remote
          // one becomes a copy). Without that record, nothing says what the pair
          // is: stop.
        } else {
          return stop(`git reported ${record.type} with an unexpected pair of versions`, record.paths);
        }
        break;
      }
      case "CONFLICT (rename/rename)": {
        // Each side's text from its own commit, under its own new name.
        const remoteName = record.paths.find((p) => stage(p, 2));
        const localName = record.paths.find((p) => stage(p, 3));
        const remote = remoteName && sides[2].tree.get(remoteName);
        const local = localName && sides[3].tree.get(localName);
        if (!remoteName || !localName || !remote || !local) return stop("git reported a rename/rename without both names", record.paths);
        put(remoteName, remote);
        put(localName, local);
        conflicts.push({ kind: "two-names", path: localName, copy: null, other: remoteName });
        break;
      }
      case "CONFLICT (file/directory)": {
        // git moved the file side to <path>~<side>; the folder side kept <path>.
        const moved = record.paths.find((p) => stage(p, 2) || stage(p, 3));
        const path = record.paths.find((p) => p !== moved);
        if (!moved || !path) return stop("git reported a file/directory conflict without its two paths", record.paths);
        const localFile = stage(moved, 3);
        const remoteFile = stage(moved, 2);
        if (!localFile && !remoteFile) return stop("git reported a file/directory conflict without the file", record.paths);
        final.delete(moved);
        if (localFile) {
          // The local file takes the path; the remote folder moves to a copy once
          // every rule has run (below the loop), so a note another rule puts inside
          // it, such as the remote's name of a note renamed into it, moves too.
          const folder = copyPath(path, (await run(clone, ["rev-parse", `${merge.tree}:${path}`])).trim(), opts.when, (p) => names.taken(p));
          // Its notes arrive after the loop; no copy chosen meanwhile may take its name.
          names.add(folder);
          asideMoves.push({ path, folder });
          put(path, localFile);
          conflicts.push({ kind: "file-folder", path, copy: folder });
        } else if (remoteFile) {
          conflicts.push({ kind: "file-folder", path, copy: placeCopy(path, remoteFile) });
        }
        break;
      }
      case "CONFLICT (distinct modes)": {
        // Used for a file against a symlink too: modes are read from the entries.
        const path = record.paths[0] ?? "";
        const localAt = record.paths.find((p) => stage(p, 3));
        const remoteAt = record.paths.find((p) => stage(p, 2));
        const local = localAt && stage(localAt, 3);
        const remote = remoteAt && stage(remoteAt, 2);
        if (!local || !remote) return stop("git reported distinct modes without both versions", record.paths);
        for (const p of record.paths) if (p !== path) final.delete(p);
        put(path, local);
        conflicts.push({ kind: "type-differs", path, copy: placeCopy(path, remote) });
        break;
      }
    }
  }
  // Each remote folder a local file displaced moves aside whole, with whatever the
  // rules left inside it; a note's other name inside the folder follows the note.
  for (const { path, folder } of asideMoves) {
    const moved = (p: string): string => `${folder}${p.slice(path.length)}`;
    const inside = [...final].filter(([p]) => p.startsWith(`${path}/`));
    for (const [p, e] of inside) {
      final.delete(p);
      put(moved(p), e);
    }
    for (const c of conflicts) if (c.other?.startsWith(`${path}/`)) c.other = moved(c.other);
  }
  const tree = await (opts.writeTree ?? writeResolved)(clone, merge.tree, result, final);
  const problems = checkResolved(await listTree(clone, tree), final, facts);
  if (problems.length) return stop(`the resolved tree failed its check: ${problems.join("; ")}`, [...handled]);
  return { kind: "clean", tree, conflicts };
}

// x is p's own place inside a copy of one of p's folders (a folder moved aside).
function movedWith(p: string, x: string): boolean {
  for (let slash = p.indexOf("/"); slash >= 0; slash = p.indexOf("/", slash + 1)) {
    const rel = p.slice(slash);
    if (x.length > rel.length && x.endsWith(rel) && isCopyOf(p.slice(0, slash), x.slice(0, x.length - rel.length))) return true;
  }
  return false;
}

// x lies inside a copy of the folder p.
function insideCopyOf(p: string, x: string): boolean {
  for (let slash = x.indexOf("/"); slash >= 0; slash = x.indexOf("/", slash + 1)) {
    if (isCopyOf(p, x.slice(0, slash))) return true;
  }
  return false;
}

// What the written tree is held to (spec 5.4 step 3), derived from git's records
// and the two input commits:
// - every side's version of a conflict's paths is at one of those paths, at a copy
//   of one, or at its place inside a folder moved aside;
// - git's merged results (neither side's version) are gone from those paths and are
//   in no new copy of them; an unrelated note with the same bytes is someone's note;
// - git's relocations (conflict paths neither commit has) are gone;
// - every other entry of a remote folder a local file displaced moved aside with it;
// - every other path is exactly git's merge, and the tree is exactly the resolution.
// A note's own text is never inspected, so notes that quote markers pass.
export function checkResolved(written: Map<string, Entry>, resolution: Map<string, Entry>, facts: MergeFacts): string[] {
  const problems = new Set<string>();
  const { result } = facts;
  const sides = sidesOf(facts);
  const entries = [...written];
  if (written.size !== resolution.size || [...resolution].some(([p, e]) => !same(written.get(p), e))) {
    problems.add("the written tree differs from the resolution");
  }
  const records = facts.records.filter((r) => r.type !== INFORMATIONAL);
  const conflictPaths = new Set(records.flatMap((r) => r.paths));
  const displacing = [...conflictPaths].filter((p) => sides[3].tree.has(p));

  for (const record of records) {
    const versions: Array<{ path: string; entry: Entry }> = [];
    const candidates: Entry[] = [];
    for (const path of record.paths) {
      for (const n of [2, 3] as const) {
        const s = facts.stages.get(path)?.[n];
        if (s) (sides[n].has.has(key(s)) ? versions.push({ path, entry: s }) : candidates.push(s));
        const own = sides[n].tree.get(path);
        if (own) versions.push({ path, entry: own });
      }
      const merged = result.get(path);
      if (merged) candidates.push(merged);
    }
    const placed = (at: string): boolean => record.paths.some((p) => at === p || isCopyOf(p, at) || movedWith(p, at));
    for (const { path, entry } of versions) {
      if (!entries.some(([at, e]) => same(e, entry) && placed(at))) problems.add(`${path}: a version (${entry.oid.slice(0, 12)}) was lost`);
    }
    const newCopy = (at: string): boolean =>
      !result.has(at) && record.paths.some((p) => isCopyOf(p, at) || movedWith(p, at));
    for (const made of candidates.filter((c) => !versions.some((v) => same(v.entry, c)))) {
      for (const [at, e] of entries) {
        if (same(e, made) && (record.paths.includes(at) || newCopy(at))) problems.add(`${at}: git's merged result remains`);
      }
    }
    for (const path of record.paths) {
      if (!sides[2].tree.has(path) && !sides[3].tree.has(path) && written.has(path)) problems.add(`${path} should be absent`);
    }
  }

  // A local file at a conflict path displaced the remote folder git merged there.
  // A conflict path inside it is held to its record above instead: git's result
  // there is its own merge, which must not move with the folder.
  const displacedEntry = (x: string): boolean => displacing.some((p) => x.startsWith(`${p}/`));
  for (const [x, entry] of result) {
    if (!displacedEntry(x) || conflictPaths.has(x)) continue;
    if (!entries.some(([at, e]) => same(e, entry) && movedWith(x, at))) problems.add(`${x} was not moved with its folder`);
  }
  const involved = (x: string): boolean =>
    conflictPaths.has(x) ||
    displacedEntry(x) ||
    (!result.has(x) && [...conflictPaths].some((p) => isCopyOf(p, x) || movedWith(p, x) || insideCopyOf(p, x)));
  for (const x of new Set([...result.keys(), ...written.keys()])) {
    if (!involved(x) && !same(written.get(x), result.get(x))) problems.add(`${x} differs from git's merge`);
  }
  return [...problems];
}
