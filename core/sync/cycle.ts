// Spec 5.3-5.4: one sync cycle. The live repo (Projects/) only ever gets a
// snapshot commit (changes no file) and a `reset --keep` (all-or-nothing). Fetch,
// merge and push happen in a private bare state clone: trees are merged in git's
// object store, so no conflict marker and no case folding ever reach a worktree,
// and a conflict never pauses sync (both versions are kept, resolve.ts).
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOk, literal, NETWORK_TIMEOUT_MS } from "../git.ts";
import { acquireLock, type LockHandle } from "../lock.ts";
import { EMPTY_TREE, redactUrlCredentials, scanRange, scanStaged } from "../secrets.ts";
import { quoted, writeAtomic } from "../store.ts";
import { ensureStateClone } from "./clone.ts";
import { conflictStamp } from "./copies.ts";
import { clearInterrupted, finishInterrupted, recordIntent, recordInterrupted, type Finished } from "./recovery.ts";
import { mergeAndResolve, type Conflict } from "./resolve.ts";
import { identityProblem } from "./state.ts";

export interface CycleInput {
  projectsDir: string;
  remote: string;
  branch: string;
  stateDir: string;
  machine: string;
  // The vault timezone, for the conflict time in copy names.
  timezone: string;
  quietMs?: number;
  lockWaitMs?: number;
  // The live update's own timeout (git.ts LOCAL_TIMEOUT_MS when unset).
  liveUpdateTimeoutMs?: number;
  // remember_sync's "adopt the rewritten remote" (spec 5.4 step 3).
  adoptRewrite?: boolean;
}

export interface CycleResult {
  // stopped: sync cannot go on until the user acts (the reason says how).
  outcome: "synced" | "busy" | "aborted" | "stopped" | "unsynced";
  reason: string | null;
  committed: string | null;
  heldBack: Array<{ file: string; rules: string[] }>;
  deferred: string[];
  pushed: boolean;
  liveUpdated: boolean;
  blockedBy: string[];
  blockedCycles: number;
  conflicts: Conflict[];
  embedded: string[];
  caseCollisions: string[];
  // Things the user should know that did not stop the cycle.
  notices: string[];
}

// The remote head this machine last integrated with (spec 5.3).
export const REMOTE_SEEN = "refs/sro/remote-seen";
const INTEGRATED = "refs/sro/integrated";
const NO_SIGN = ["-c", "commit.gpgsign=false"];
const MAX_PUSH_ATTEMPTS = 3;

type Stamp = { size: number; mtimeMs: number } | null;

async function stampOf(path: string): Promise<Stamp> {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

// Paths whose size or mtime moved since `before` was taken (spec 5.4 step 2).
export async function changedSince(root: string, before: Map<string, Stamp>): Promise<string[]> {
  const changed: string[] = [];
  for (const [file, then] of before) {
    const now = await stampOf(join(root, file));
    if (then === null ? now !== null : now === null || now.size !== then.size || now.mtimeMs !== then.mtimeMs) {
      changed.push(file);
    }
  }
  return changed;
}

// Raw stdout, never gitOk's trimmed form: a -z listing's last name may end in a space.
async function zList(cwd: string, args: string[]): Promise<string[]> {
  const r = await git(["-c", "core.quotePath=false", ...args, "-z"], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.split("\0").filter(Boolean);
}

async function stagedFiles(cwd: string): Promise<string[]> {
  return zList(cwd, ["diff", "--cached", "--name-only"]);
}

const fold = (name: string): string => name.normalize("NFC").toLowerCase();

function prefixes(rel: string): string[] {
  return rel.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
}

// Tracked paths that differ only by case (Note.md and note.md, or Dir/a.md and
// dir/b.md) share one entry on a case-insensitive filesystem, so no rename can be
// inferred for them. Whole files that collide are also reported: this machine
// holds one file for both names.
function caseAmbiguous(tracked: string[]): { ambiguous: Set<string>; collisions: string[] } {
  const spellings = new Map<string, Set<string>>();
  for (const rel of tracked) {
    for (const prefix of prefixes(rel)) {
      const key = fold(prefix);
      spellings.set(key, (spellings.get(key) ?? new Set<string>()).add(prefix));
    }
  }
  const clash = (prefix: string): boolean => (spellings.get(fold(prefix))?.size ?? 0) > 1;
  return { ambiguous: new Set(tracked.filter((rel) => prefixes(rel).some(clash))), collisions: tracked.filter(clash) };
}

// rel as spelled on disk, component by component; null when it is gone.
async function onDisk(dir: string, rel: string, listings: Map<string, string[]>): Promise<string | null> {
  let actual = "";
  for (const part of rel.split("/")) {
    let names = listings.get(actual);
    if (!names) {
      names = await readdir(join(dir, actual)).catch(() => [] as string[]);
      listings.set(actual, names);
    }
    const exact = names.some((n) => n.normalize("NFC") === part.normalize("NFC"));
    const found = exact ? part : names.find((n) => fold(n) === fold(part));
    if (found === undefined) return null;
    actual = actual ? `${actual}/${found}` : found;
  }
  return actual;
}

// On a case-insensitive filesystem git does not see Note.md -> note.md or
// Dir/ -> dir/; stage it. Returns the tracked files that collide by case.
async function stageCaseRenames(dir: string): Promise<string[]> {
  if ((await git(["config", "--bool", "core.ignorecase"], { cwd: dir })).stdout.trim() !== "true") return [];
  const tracked = await zList(dir, ["ls-files"]);
  const { ambiguous, collisions } = caseAmbiguous(tracked);
  const listings = new Map<string, string[]>();
  for (const rel of tracked) {
    if (ambiguous.has(rel)) continue;
    const actual = await onDisk(dir, rel, listings);
    if (actual === null || actual === rel) continue;
    await gitOk(["rm", "-q", "--cached", "--", literal(rel)], { cwd: dir });
    await gitOk(["add", "--", literal(actual)], { cwd: dir });
  }
  return collisions;
}

// A git repository cloned inside Projects/ would be committed as an empty gitlink;
// untrack it and report it instead.
async function dropEmbeddedRepos(dir: string): Promise<string[]> {
  const links = (await zList(dir, ["ls-files", "--stage"]))
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1));
  // --cached -f: index only (the nested repository stays on disk), and it also drops
  // a gitlink an older client already committed.
  for (const path of links) await gitOk(["rm", "-q", "--cached", "-f", "--", literal(path)], { cwd: dir });
  return links;
}

// Spec 5.4 step 5 escalates after 3 blocked live updates in a row.
async function readBlocked(stateDir: string): Promise<number> {
  return Number(await readFile(join(stateDir, "blocked-cycles"), "utf8").catch(() => "0")) || 0;
}

async function writeBlocked(stateDir: string, count: number): Promise<void> {
  await writeAtomic(join(stateDir, "blocked-cycles"), String(count));
}

async function unstage(cwd: string, file: string): Promise<void> {
  await gitOk(["reset", "-q", "--", literal(file)], { cwd });
}

async function rev(cwd: string, ref: string): Promise<string | null> {
  const r = await git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

type Seen = { kind: "absent" } | { kind: "seen"; commit: string } | { kind: "unreadable" } | { kind: "unknown" };

// refs/sro/remote-seen, three ways (verified, git 2.50.1): show-ref --exists says
// present (0) or absent (2), and a present ref must name a commit. show-ref --verify
// and rev-parse read a ref file git cannot parse as absent, which would skip the
// rewrite check and merge or push back what a rewrite dropped.
async function remoteSeen(dir: string): Promise<Seen> {
  const exists = await git(["show-ref", "--exists", REMOTE_SEEN], { cwd: dir });
  if (exists.timedOut) return { kind: "unknown" };
  if (exists.code === 2) return { kind: "absent" };
  if (exists.code !== 0) return { kind: "unreadable" };
  const r = await git(["rev-parse", "-q", "--verify", `${REMOTE_SEEN}^{commit}`], { cwd: dir });
  if (r.timedOut) return { kind: "unknown" };
  return r.code === 0 ? { kind: "seen", commit: r.stdout.trim() } : { kind: "unreadable" };
}

function emptyResult(): CycleResult {
  return {
    outcome: "synced",
    reason: null,
    committed: null,
    heldBack: [],
    deferred: [],
    pushed: false,
    liveUpdated: false,
    blockedBy: [],
    blockedCycles: 0,
    conflicts: [],
    embedded: [],
    caseCollisions: [],
    notices: [],
  };
}

async function snapshot(input: CycleInput, result: CycleResult): Promise<{ ok: boolean; pushAllowed: boolean }> {
  const dir = input.projectsDir;
  await gitOk(["add", "-A"], { cwd: dir });
  result.caseCollisions = await stageCaseRenames(dir);

  // Deferred while its mtime is within the quiet period of now, on either side. A
  // fresh write's sub-millisecond mtime is usually just ahead of Date.now()'s whole
  // milliseconds, and the clock is read after each stat so a write during this
  // pass is never far "ahead". An mtime further in the future (the clock was
  // corrected backwards) is quiet: deferring it would defer the file every cycle,
  // silently, for as long as the skew lasts.
  const quietMs = input.quietMs ?? 2000;
  for (const file of await stagedFiles(dir)) {
    const s = await stampOf(join(dir, file));
    if (s && Math.abs(Date.now() - s.mtimeMs) < quietMs) {
      await unstage(dir, file); // may still be being written; next cycle
      result.deferred.push(file);
    }
  }
  // After the quiet pass: unstaging a freshly written nested repository would
  // otherwise restore the gitlink an older client committed.
  result.embedded = await dropEmbeddedRepos(dir);

  for (const [file, hits] of await scanStaged(dir)) {
    await unstage(dir, file);
    result.heldBack.push({ file, rules: [...new Set(hits.map((h) => h.rule))] });
  }

  // Defense in depth: nothing with a hit is ever committed, even if the unstage
  // above somehow left a hit staged. A guard by construction now that scanStaged
  // pins the diff's prefixes; this should never trigger.
  const stillDirty = await scanStaged(dir);
  if (stillDirty.size) {
    await gitOk(["reset", "-q"], { cwd: dir });
    result.outcome = "aborted";
    result.reason = `the secret scan could not hold back ${[...stillDirty.keys()]
      .sort()
      .map((f) => quoted(f))
      .join(", ")}: nothing was committed`;
    return { ok: false, pushAllowed: false };
  }

  const staged = await stagedFiles(dir);
  if (!staged.length) return { ok: true, pushAllowed: true };

  const identity = await identityProblem(dir);
  if (identity) {
    await gitOk(["reset", "-q"], { cwd: dir });
    result.outcome = "aborted";
    result.reason = identity;
    return { ok: false, pushAllowed: false };
  }

  const before = new Map<string, Stamp>();
  for (const file of staged) before.set(file, await stampOf(join(dir, file)));
  const projects = [...new Set(staged.map((f) => f.split("/")[0]))].sort();
  const message = `sync(${input.machine}): ${staged.length} file${staged.length === 1 ? "" : "s"} [${projects.join(", ")}]`;
  // --no-verify: a pre-commit hook (a formatter that re-adds, lint-staged) would
  // otherwise stage content after the scan above, and it would be pushed unscanned.
  await gitOk([...NO_SIGN, "commit", "-q", "--no-verify", "-m", message], { cwd: dir });
  result.committed = await rev(dir, "HEAD");
  return { ok: true, pushAllowed: (await changedSince(dir, before)).length === 0 };
}

type Ancestry = "yes" | "no" | "unknown";

// merge-base --is-ancestor: 0 is yes, 1 is no, anything else (a missing object, a
// timeout) is "could not tell", which stops the cycle instead of reading as "no".
async function ancestry(cwd: string, a: string, b: string): Promise<Ancestry> {
  const r = await git(["merge-base", "--is-ancestor", a, b], { cwd });
  if (r.timedOut) return "unknown";
  return r.code === 0 ? "yes" : r.code === 1 ? "no" : "unknown";
}

// A status line, not a transcript: at most the first 10 items, then a count of
// what was left out.
const MAX_LISTED = 10;

function listed(shown: string[], total: number): string {
  return (total > shown.length ? [...shown, `and ${total - shown.length} more`] : shown).join(", ");
}

// File names quoted and capped like any other.
function joinNames(names: string[]): string {
  return listed(names.slice(0, MAX_LISTED).map((n) => quoted(n)), names.length);
}

// resolve.ts's stop as one line: the paths it names, when it names any.
function stopReason(stop: { reason: string; paths: string[] }): string {
  return stop.paths.length ? `${stop.reason}: ${joinNames(stop.paths)}` : stop.reason;
}

// A status line, not a transcript: git's first few lines that say something.
function firstLines(stderr: string, count = 3): string {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "remote:" && !line.startsWith("hint:"))
    .slice(0, count)
    .join("; ");
}

type Integration =
  | { kind: "ok"; next: string; needsPush: boolean; conflicts: Conflict[] }
  | { kind: "stopped"; reason: string }
  | { kind: "unsynced"; reason: string };

async function changedBetween(clone: string, from: string, to: string): Promise<string[]> {
  return zList(clone, ["diff", "--name-only", "--no-renames", from, to]);
}

// `sync(<machine>): <n> files [<projects>]` for a commit built in the state clone.
async function mergeMessage(clone: string, machine: string, from: string, tree: string): Promise<string> {
  const files = await changedBetween(clone, from, tree);
  const projects = [...new Set(files.map((f) => f.split("/")[0]))].sort();
  return `sync(${machine}): ${files.length} file${files.length === 1 ? "" : "s"} [${projects.join(", ")}]`;
}

interface OutboundHits {
  // Flagged in a commit of the vault's own history that the push would send.
  inCommits: Array<{ file: string; commit: string }>;
  // Flagged in what the push leaves on the remote (from..to as two trees).
  inTree: string[];
}

// Spec 5.4 step 3: nothing unscanned leaves the machine. The push sends every commit
// in from..to, so each one's additions against its first parent go through the
// step-2 scan (a commit made by hand never met it, and a later commit that removes
// a secret does not unsend it), and so does the tree the push leaves. Exempt: objects
// the remote's tree already holds (a copy of a remote version is inside the trusted
// remote already, and would otherwise block every cycle). `built` is the commit this
// cycle made in the state clone, if `to` is one: its first parent is `from`, so its
// own additions are the tree's, and it is in no history the user can rewrite.
async function outboundHits(clone: string, from: string, to: string, built: boolean): Promise<OutboundHits> {
  let remoteObjects: Promise<Set<string | undefined>> | undefined;
  const exempt = async (commit: string, file: string): Promise<boolean> => {
    remoteObjects ??= zList(clone, ["ls-tree", "-r", from]).then(
      (lines) => new Set(lines.map((line) => line.slice(0, line.indexOf("\t")).split(" ")[2])),
    );
    const oid = (await git(["rev-parse", "-q", "--verify", `${commit}:${file}`], { cwd: clone })).stdout.trim();
    return (await remoteObjects).has(oid);
  };
  const inCommits: OutboundHits["inCommits"] = [];
  // Oldest first, each with its parents; a root commit adds all it holds.
  const commits = (await gitOk(["rev-list", "--reverse", "--topo-order", "--parents", `${from}..${to}`], { cwd: clone })).split("\n");
  for (const line of commits.filter(Boolean)) {
    const [commit = "", parent = EMPTY_TREE] = line.split(" ");
    if (built && commit === to) continue;
    for (const file of [...(await scanRange(clone, parent, commit)).keys()].sort()) {
      if (!(await exempt(commit, file))) inCommits.push({ file, commit });
    }
  }
  const inTree: string[] = [];
  for (const file of (await scanRange(clone, from, to)).keys()) if (!(await exempt(to, file))) inTree.push(file);
  return { inCommits, inTree: inTree.sort() };
}

async function outbound(clone: string, input: CycleInput, from: string, to: string, built: boolean, conflicts: Conflict[]): Promise<Integration> {
  const { inCommits, inTree } = await outboundHits(clone, from, to, built);
  if (inCommits.length) {
    // The short hash as git abbreviates it in the vault, where the user rewrites.
    const shown: string[] = [];
    for (const { file, commit } of inCommits.slice(0, MAX_LISTED)) {
      shown.push(`${quoted(file)} (commit ${await gitOk(["rev-parse", "--short", commit], { cwd: input.projectsDir })})`);
    }
    return {
      kind: "stopped",
      reason: `the secret scan flags what this sync would send in ${listed(shown, inCommits.length)}: nothing was pushed. The secret is in commits of Projects/ that were never sent, so removing the file is not enough: rewrite those commits (for example, drop or amend the one that added it), then sync again`,
    };
  }
  if (inTree.length) {
    return {
      kind: "stopped",
      reason: `the secret scan flags what this sync would send in ${joinNames(inTree)}: nothing was pushed (remove the secret, then sync again)`,
    };
  }
  return { kind: "ok", next: to, needsPush: true, conflicts };
}

async function integrate(clone: string, input: CycleInput, live: string): Promise<Integration> {
  const b = input.branch;
  // Stray temporary index files from a killed cycle (the sync lock is held).
  for (const name of await readdir(clone)) if (name.startsWith("sro-index-")) await rm(join(clone, name), { force: true });
  await gitOk(["fetch", "-q", "live", `+refs/heads/${b}:refs/remotes/live/${b}`], { cwd: clone });
  // remote-seen lives in the live repo, which keeps its commit reachable; a rebuilt
  // clone has it too, since a local clone links the whole object store.
  const seen = await remoteSeen(input.projectsDir);
  if (seen.kind === "unknown") return { kind: "unsynced", reason: `reading ${REMOTE_SEEN} timed out` };
  if (seen.kind === "unreadable") {
    return {
      kind: "stopped",
      reason: `${REMOTE_SEEN} in Projects/ does not name a commit git can read, so a rewritten remote could go unnoticed. If the remote's history was not rewritten, delete it (git update-ref -d ${REMOTE_SEEN}) and sync again.`,
    };
  }
  const fetched = await git(["fetch", "-q", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], {
    cwd: clone,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (fetched.code !== 0 || fetched.timedOut) {
    const detail = firstLines(fetched.stderr) || (fetched.timedOut ? "timed out" : `git exited ${fetched.code}`);
    return { kind: "unsynced", reason: `fetch failed: ${detail}` };
  }
  const upstream = await rev(clone, `refs/remotes/origin/${b}`);
  if (upstream === null) return { kind: "unsynced", reason: `remote has no branch ${b}` };
  const when = conflictStamp(new Date(), input.timezone);

  if (seen.kind === "seen") {
    const kept = await ancestry(clone, seen.commit, upstream);
    if (kept === "unknown") return { kind: "unsynced", reason: "could not tell whether the remote's history was rewritten" };
    if (kept === "no") {
      if (!input.adoptRewrite) {
        return {
          kind: "stopped",
          reason:
            "the remote's history was rewritten (a force-push): nothing the rewrite dropped is deleted here or pushed back. If the rewrite was intended, run remember_sync to adopt the rewritten remote.",
        };
      }
      // Adopt: carry over only this machine's unsent changes, with the single parent
      // upstream, so none of the dropped history is published again.
      const base = await gitOk(["merge-base", seen.commit, live], { cwd: clone });
      const merged = await mergeAndResolve(clone, upstream, live, { mergeBase: base, when });
      if (merged.kind === "stop") return { kind: "stopped", reason: stopReason(merged) };
      // Nothing unsent: the vault moves to the remote as it is, and no empty commit is pushed.
      if (merged.tree === (await gitOk(["rev-parse", `${upstream}^{tree}`], { cwd: clone }))) {
        return { kind: "ok", next: upstream, needsPush: false, conflicts: merged.conflicts };
      }
      const message = await mergeMessage(clone, input.machine, upstream, merged.tree);
      const next = await gitOk([...NO_SIGN, "commit-tree", merged.tree, "-p", upstream, "-m", message], { cwd: clone });
      return outbound(clone, input, upstream, next, true, merged.conflicts);
    }
  }

  const sent = await ancestry(clone, live, upstream);
  if (sent === "unknown") return { kind: "unsynced", reason: "could not compare the live snapshot with the remote" };
  if (sent === "yes") return { kind: "ok", next: upstream, needsPush: false, conflicts: [] };
  const ahead = await ancestry(clone, upstream, live);
  if (ahead === "unknown") return { kind: "unsynced", reason: "could not compare the remote with the live snapshot" };
  if (ahead === "yes") return outbound(clone, input, upstream, live, false, []);

  const merged = await mergeAndResolve(clone, upstream, live, { when });
  if (merged.kind === "stop") return { kind: "stopped", reason: stopReason(merged) };
  // Two parents, remote first: ancestry records that live is on the remote.
  const message = await mergeMessage(clone, input.machine, upstream, merged.tree);
  const next = await gitOk([...NO_SIGN, "commit-tree", merged.tree, "-p", upstream, "-p", live, "-m", message], { cwd: clone });
  return outbound(clone, input, upstream, next, true, merged.conflicts);
}

type Push = { kind: "pushed" } | { kind: "raced"; detail: string } | { kind: "failed"; reason: string };

async function push(clone: string, input: CycleInput, sha: string): Promise<Push> {
  const r = await git(["push", "--porcelain", "origin", `${sha}:refs/heads/${input.branch}`], {
    cwd: clone,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (r.code === 0 && !r.timedOut) return { kind: "pushed" };
  const detail = firstLines(r.stderr) || (r.timedOut ? "timed out" : `git exited ${r.code}`);
  // --porcelain: the verdict is read from git's own per-ref status, not from hints.
  // "[rejected]" is git's non-fast-forward check: the remote moved since the fetch,
  // so integrating again can succeed. "[remote rejected]" is the server refusing
  // (a pre-receive hook, push protection): no retry changes that.
  if (/^!\t.*\[rejected\]/m.test(r.stdout)) return { kind: "raced", detail };
  return { kind: "failed", reason: `push failed: ${detail}` };
}

// git's refusals of `reset --keep`, each printed before it writes anything: a local
// edit, an edit or a deletion staged by hand, an untracked file where a note goes or
// that a deletion would remove, a folder of untracked files where a note goes. Each
// verified (git 2.50.1) to leave HEAD, the index and the worktree exactly as they
// were. Only these: a refusal clears the intent record, so a message counted here
// that git prints after writing would skip the repair of a half-updated vault.
const REFUSED =
  /Entry '(.+)' (?:not uptodate|would be overwritten by merge)|Untracked working tree file '(.+)' would be (?:overwritten|removed) by merge|Updating '(.+)' would lose untracked files in it/g;

// Spec 5.4 step 5: the remote head now known, into the live repo's objects before
// anything refers to it; then remote-seen; then the all-or-nothing reset.
async function updateLive(clone: string, input: CycleInput, live: string, next: string, streak: number, result: CycleResult): Promise<void> {
  const dir = input.projectsDir;
  await gitOk(["update-ref", INTEGRATED, next], { cwd: clone });
  await gitOk(["fetch", "-q", clone, `+${INTEGRATED}:${INTEGRATED}`], { cwd: dir });
  await gitOk(["update-ref", REMOTE_SEEN, next], { cwd: dir });
  if (next === live) {
    result.liveUpdated = true;
    return;
  }
  await recordIntent(input.stateDir, live, next);
  const reset = await git(["reset", "-q", "--keep", next], { cwd: dir, timeoutMs: input.liveUpdateTimeoutMs });
  if (reset.code === 0 && !reset.timedOut) {
    await clearInterrupted(input.stateDir);
    result.liveUpdated = true;
    await gitOk(["update-ref", `refs/remotes/origin/${input.branch}`, next], { cwd: dir });
    return;
  }
  if (reset.timedOut) {
    // Not the user's block, and never counted toward the escalation: the next
    // cycle finishes it before its snapshot (recovery.ts).
    await recordInterrupted(input.stateDir, dir, live, next);
    result.outcome = "unsynced";
    result.reason = "updating the vault timed out; the next sync finishes it";
    return;
  }
  // git's check before it writes anything refuses the whole update and nothing changed.
  const blocked = [...reset.stderr.matchAll(REFUSED)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
  if (!blocked.length) {
    // Any other error (a smudge filter that fails) can stop it partway: the intent
    // stays, and the next cycle finishes it before its snapshot.
    result.outcome = "unsynced";
    result.reason = `updating the vault failed (${firstLines(reset.stderr) || `git exited ${reset.code}`}); the next sync finishes it`;
    return;
  }
  await clearInterrupted(input.stateDir);
  result.blockedBy = blocked;
  result.blockedCycles = streak + 1;
  await writeBlocked(input.stateDir, result.blockedCycles);
}

function describeFinished(done: Finished): string {
  if (done.moved) return "an interrupted vault update was left as it was: the vault's history moved since";
  const parts = ["finished an interrupted vault update"];
  if (done.restored.length) parts.push(`${done.restored.length} file${done.restored.length === 1 ? "" : "s"} set back to update again`);
  if (done.kept.length) parts.push(`your edits since kept in ${joinNames(done.kept)}`);
  return parts.join("; ");
}

// Never throws: every failure, the lock's own included, is an outcome.
export async function runCycle(input: CycleInput): Promise<CycleResult> {
  const result = emptyResult();
  const dir = input.projectsDir;
  let lock: LockHandle | null = null;
  try {
    const lockDir = await gitOk(["rev-parse", "--path-format=absolute", "--git-path", "sro-sync.lock"], { cwd: dir });
    lock = await acquireLock(lockDir, { waitMs: input.lockWaitMs ?? 60_000 });
    if (!lock) return { ...result, outcome: "busy", reason: "another sync holds the lock" };
    const held = lock;
    const stillHeld = async (): Promise<boolean> => {
      if (await held.held()) return true;
      result.outcome = "aborted";
      result.reason = "lost the sync lock";
      return false;
    };
    // Every cycle that runs breaks the streak, whatever its outcome, unless it ends
    // blocked again; a busy cycle never ran and leaves it alone.
    const streak = await readBlocked(input.stateDir);
    await writeBlocked(input.stateDir, 0);
    // An interrupted update is finished before anything is snapshotted.
    const finished = await finishInterrupted(input.stateDir, dir, { timeoutMs: input.liveUpdateTimeoutMs });
    if (finished && (finished.moved || finished.restored.length || finished.kept.length)) result.notices.push(describeFinished(finished));
    const snap = await snapshot(input, result);
    if (!snap.ok || !(await stillHeld())) return result;
    if (!snap.pushAllowed) {
      result.outcome = "unsynced";
      result.reason = "a file changed while the snapshot was taken; it will be pushed next cycle";
      return result;
    }
    // Spec 5.4's instructions even when nothing was staged: the state clone copies
    // the identity below and would otherwise stop the cycle with a raw git error.
    const identity = await identityProblem(dir);
    if (identity) {
      result.outcome = "aborted";
      result.reason = identity;
      return result;
    }

    const live = (await rev(dir, "HEAD")) ?? "";
    const clone = await ensureStateClone(input.stateDir, dir, input.remote);
    let next = "";
    let conflicts: Conflict[] = [];
    for (let attempt = 1; ; attempt++) {
      if (!(await stillHeld())) return result;
      const integration = await integrate(clone, input, live);
      if (integration.kind === "stopped") {
        result.outcome = "stopped";
        result.reason = integration.reason;
        return result;
      }
      if (integration.kind === "unsynced") {
        result.outcome = "unsynced";
        result.reason = integration.reason;
        return result;
      }
      next = integration.next;
      conflicts = integration.conflicts;
      if (!integration.needsPush) break;
      const pushed = await push(clone, input, next);
      if (pushed.kind === "pushed") {
        result.pushed = true;
        break;
      }
      if (pushed.kind === "failed") {
        result.outcome = "unsynced";
        result.reason = pushed.reason;
        return result;
      }
      if (attempt >= MAX_PUSH_ATTEMPTS) {
        result.outcome = "unsynced";
        result.reason = `push rejected ${attempt} times (the remote kept moving): ${pushed.detail}`;
        return result;
      }
    }
    // Only now: a conflict's copy exists once N is on the remote (or nothing needed
    // pushing), and a cycle that ends before that reports none.
    result.conflicts = conflicts;

    if (!(await stillHeld())) return result;
    await updateLive(clone, input, live, next, streak, result);
    return result;
  } catch (err) {
    result.outcome = "aborted";
    result.reason = (err as Error).message;
    return result;
  } finally {
    // A throw here would replace the cycle's result: report it in the reason.
    if (lock) {
      try {
        await lock.release();
      } catch (err) {
        const failed = `releasing the sync lock failed: ${(err as Error).message}`;
        result.reason = result.reason ? `${result.reason}; ${failed}` : failed;
      }
    }
    // git's stderr and a GitError's arguments can hold the remote URL.
    if (result.reason) result.reason = redactUrlCredentials(result.reason);
  }
}
