// Spec 5.3-5.4: one sync cycle. The live repo (Projects/) only ever gets a
// snapshot commit (changes no file) and a `reset --keep` (all-or-nothing). All
// fetch/rebase/push happens in a private state clone nobody else touches, so a
// conflict or a half-applied rebase is never visible in the vault.
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOk, literal, NETWORK_TIMEOUT_MS } from "../git.ts";
import { acquireLock, type LockHandle } from "../lock.ts";
import { redactUrlCredentials, scanStaged } from "../secrets.ts";
import { quoted, writeAtomic } from "../store.ts";
import { identityProblem } from "./state.ts";

export interface CycleInput {
  projectsDir: string;
  remote: string;
  branch: string;
  stateDir: string;
  machine: string;
  quietMs?: number;
  lockWaitMs?: number;
}

export interface CycleResult {
  outcome: "synced" | "busy" | "aborted" | "paused" | "unsynced";
  reason: string | null;
  committed: string | null;
  heldBack: Array<{ file: string; rules: string[] }>;
  deferred: string[];
  pushed: boolean;
  liveUpdated: boolean;
  blockedBy: string[];
  blockedCycles: number;
  conflicts: string[];
  embedded: string[];
  caseCollisions: string[];
}

export const LAST_INTEGRATED = "refs/sro/last-integrated";
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

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return (await git(["merge-base", "--is-ancestor", a, b], { cwd })).code === 0;
}

async function exists(path: string): Promise<boolean> {
  return (await stampOf(path)) !== null;
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

// Nobody else uses the clone and the sync lock is held, so any lock file in it is
// a leftover: a git command killed on its timeout (spec 5.6).
async function leftoverLock(gitDir: string): Promise<boolean> {
  const names = [...(await readdir(gitDir)), ...(await readdir(join(gitDir, "refs"), { recursive: true }))];
  return names.some((name) => name.endsWith(".lock"));
}

async function ensureStateClone(input: CycleInput): Promise<string> {
  const clone = join(input.stateDir, "sync");
  const gitDir = join(clone, ".git");
  // The clone is disposable: a crash mid-rebase (either backend) or a leftover
  // lock means rebuild it.
  if (
    (await exists(gitDir)) &&
    ((await exists(join(gitDir, "rebase-merge"))) || (await exists(join(gitDir, "rebase-apply"))) || (await leftoverLock(gitDir)))
  ) {
    await rm(clone, { recursive: true, force: true });
  }
  if (!(await exists(join(clone, ".git")))) {
    await rm(clone, { recursive: true, force: true });
    await mkdir(input.stateDir, { recursive: true });
    await gitOk(["clone", "-q", "--no-checkout", input.projectsDir, clone], { cwd: input.stateDir });
    await gitOk(["remote", "rename", "origin", "live"], { cwd: clone });
    await gitOk(["remote", "add", "origin", input.remote], { cwd: clone });
  }
  // Re-pointed every cycle: moving the vault or changing the remote cannot strand it.
  await gitOk(["remote", "set-url", "live", input.projectsDir], { cwd: clone });
  await gitOk(["remote", "set-url", "origin", input.remote], { cwd: clone });
  for (const key of ["user.name", "user.email"]) {
    await gitOk(["config", key, await gitOk(["config", key], { cwd: input.projectsDir })], { cwd: clone });
  }
  return clone;
}

// A status line, not a transcript: at most the first 10 names, quoted and
// capped like any other, then a count of what was left out. The full list
// (never capped) is still reported separately in the result.
function joinNames(names: string[], max = 10): string {
  const shown = names.slice(0, max).map((n) => quoted(n));
  if (names.length > max) shown.push(`and ${names.length - max} more`);
  return shown.join(", ");
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
  | { kind: "ok"; next: string; needsPush: boolean }
  | { kind: "conflict"; files: string[] }
  | { kind: "unsynced"; reason: string };

async function integrate(clone: string, input: CycleInput, live: string, last: string | null): Promise<Integration> {
  const b = input.branch;
  await gitOk(["fetch", "-q", "live", `+refs/heads/${b}:refs/remotes/live/${b}`], { cwd: clone });
  const fetched = await git(["fetch", "-q", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], {
    cwd: clone,
    timeoutMs: NETWORK_TIMEOUT_MS,
  });
  if (fetched.code !== 0) {
    const detail = firstLines(fetched.stderr) || (fetched.timedOut ? "timed out" : `git exited ${fetched.code}`);
    return { kind: "unsynced", reason: `fetch failed: ${detail}` };
  }
  const upstream = `refs/remotes/origin/${b}`;
  const upstreamSha = await rev(clone, upstream);
  if (upstreamSha === null) return { kind: "unsynced", reason: `remote has no branch ${b}` };
  if (await isAncestor(clone, live, upstream)) return { kind: "ok", next: upstreamSha, needsPush: false };

  // Replay only what the remote has not seen: commits after last-integrated.
  const base = last && (await isAncestor(clone, last, live)) ? last : await gitOk(["merge-base", live, upstream], { cwd: clone });
  await gitOk(["checkout", "-q", "-f", "--detach", live], { cwd: clone });
  await gitOk(["clean", "-q", "-f", "-d", "-x"], { cwd: clone });
  const rebased = await git([...NO_SIGN, "rebase", "-q", "--onto", upstream, base], { cwd: clone });
  if (rebased.code !== 0) {
    const unmerged = await zList(clone, ["diff", "--name-only", "--diff-filter=U"]);
    await git(["rebase", "--abort"], { cwd: clone });
    if (unmerged.length) return { kind: "conflict", files: unmerged };
    // No conflict (a hook refused, a timeout, a broken clone): nothing for the user
    // to resolve, so it is not a pause. The next cycle tries again.
    const detail = firstLines(rebased.stderr) || (rebased.timedOut ? "timed out" : `git exited ${rebased.code}`);
    return { kind: "unsynced", reason: `rebase failed: ${detail}` };
  }
  const next = (await rev(clone, "HEAD")) ?? upstreamSha;
  return { kind: "ok", next, needsPush: next !== upstreamSha };
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
    const last = await rev(dir, LAST_INTEGRATED);
    const clone = await ensureStateClone(input);
    let next = "";
    for (let attempt = 1; ; attempt++) {
      if (!(await stillHeld())) return result;
      const integration = await integrate(clone, input, live, last);
      if (integration.kind === "conflict") {
        result.outcome = "paused";
        result.conflicts = integration.files;
        result.reason = `sync paused: your local changes conflict with the remote in ${joinNames(integration.files)}`;
        return result;
      }
      if (integration.kind === "unsynced") {
        result.outcome = "unsynced";
        result.reason = integration.reason;
        return result;
      }
      next = integration.next;
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

    // Spec 5.4 step 4: our snapshot is confirmed upstream now (pushed, or already
    // there), so record it before the step-5 lock check. If step 5 never finishes
    // (the lock lost here, the fetch/reset below failing, or the process exiting),
    // the next cycle must not replay a snapshot that is already on the remote.
    await gitOk(["update-ref", LAST_INTEGRATED, live], { cwd: dir });

    if (!(await stillHeld())) return result;
    await gitOk(["update-ref", INTEGRATED, next], { cwd: clone });
    await gitOk(["fetch", "-q", clone, `+${INTEGRATED}:${INTEGRATED}`], { cwd: dir });
    const reset = await git(["reset", "-q", "--keep", next], { cwd: dir });
    if (reset.code === 0) {
      result.liveUpdated = true;
      await gitOk(["update-ref", LAST_INTEGRATED, next], { cwd: dir });
      await gitOk(["update-ref", `refs/remotes/origin/${input.branch}`, next], { cwd: dir });
    } else {
      const blocked = [...reset.stderr.matchAll(/Entry '(.+)' not uptodate/g)].map((m) => m[1] ?? "");
      result.blockedBy = blocked.length ? blocked : [`(reset --keep refused: ${reset.stderr.trim().split("\n")[0]})`];
      result.blockedCycles = streak + 1;
      await writeBlocked(input.stateDir, result.blockedCycles);
      // Our snapshot is on the remote now; never replay it again.
      await gitOk(["update-ref", LAST_INTEGRATED, live], { cwd: dir });
    }
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
