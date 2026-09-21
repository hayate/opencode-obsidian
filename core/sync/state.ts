// Spec 5.1-5.2: is sync on, and is Projects/ in a state the cycle may touch?
// Every branch here either returns "ready" or stops with a reason a human can
// act on. Nothing is created under Projects/ before this has run.
import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { git, gitOk, NETWORK_TIMEOUT_MS } from "../git.ts";
import { redactUrlCredentials, scanStaged } from "../secrets.ts";
import { createAt, quoted, writeAtomic } from "../store.ts";
import { CONFIG_FILE, type Vault } from "../vault.ts";

export interface SyncConfig {
  remote: string | null;
}

export type SyncState =
  | { kind: "off" }
  | { kind: "off-but-configured"; origin: string }
  | { kind: "ready"; branch: string; bootstrapped: boolean }
  | { kind: "stopped"; reason: string };

export const REQUIRED_IGNORES = [
  ".DS_Store",
  "*.sro-tmp",
  "*/remember/recent.md",
  "*/remember/archive.md",
  "*(conflict*",
  "*sync-conflict-*",
  "*conflicted copy*",
];

const NO_SIGN = ["-c", "commit.gpgsign=false"];

export function syncConfig(env: Record<string, string | undefined> = process.env): SyncConfig {
  const remote = env.OBSIDIAN_PROJECTS_REMOTE?.trim();
  return { remote: remote ? remote : null };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

// A directory's entries; a missing directory has none. Any other failure (EACCES,
// ENOTDIR) is an error: a folder that cannot be listed is not an empty one.
async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

// Absent, or holding only Finder litter and empty directories, counts as empty.
async function isEffectivelyEmpty(dir: string): Promise<boolean> {
  for (const name of await entries(dir)) {
    if (name === ".DS_Store") continue;
    const path = join(dir, name);
    // lstat: a symlink is content, never a directory to walk (or clean) through.
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !(await isEffectivelyEmpty(path))) return false;
  }
  return true;
}

async function clearLitter(dir: string): Promise<void> {
  for (const name of await entries(dir)) {
    const path = join(dir, name);
    if (name === ".DS_Store") await rm(path, { force: true });
    else {
      await clearLitter(path);
      await rmdir(path).catch(() => undefined);
    }
  }
}

export async function identityProblem(repo: string): Promise<string | null> {
  const name = await git(["config", "user.name"], { cwd: repo });
  const email = await git(["config", "user.email"], { cwd: repo });
  if (name.code === 0 && email.code === 0 && name.stdout.trim() && email.stdout.trim()) return null;
  return 'git user.name / user.email are not configured: run git config --global user.name "..." and user.email "..." (the plugin never lets git guess an identity)';
}

export async function ensureGitignore(projectsDir: string): Promise<boolean> {
  const path = join(projectsDir, ".gitignore");
  // Only a missing file is an empty one: the rewrite below replaces the whole
  // file, so reading any other failure as "" would replace the user's .gitignore
  // with the plugin's lines alone, and the next snapshot would push that.
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch (err) {
    if (!isMissing(err)) throw err;
    current = "";
  }
  const have = new Set(current.split("\n").map((l) => l.trim()));
  const missing = REQUIRED_IGNORES.filter((p) => !have.has(p));
  if (!missing.length) return false;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await writeAtomic(path, `${current}${prefix}# superpower-remember-obsidian\n${missing.join("\n")}\n`);
  return true;
}

async function remoteHasBranches(cwd: string, remote: string): Promise<boolean | string> {
  const r = await git(["ls-remote", "--heads", remote], { cwd, timeoutMs: NETWORK_TIMEOUT_MS });
  if (r.code !== 0 || r.timedOut) return `cannot reach ${remote}: ${r.stderr.trim() || "timed out"}`;
  return r.stdout.trim().length > 0;
}

async function commitAndPushNew(projectsDir: string, timezone: string, message: string): Promise<string | null> {
  const identity = await identityProblem(projectsDir);
  if (identity) return identity;
  await ensureGitignore(projectsDir);
  await createAt(join(projectsDir, CONFIG_FILE), `${JSON.stringify({ timezone }, null, 2)}\n`);
  await gitOk(["add", "-A"], { cwd: projectsDir });
  // Spec 7.5: every staged diff is scanned before commit. At bootstrap there is
  // no later cycle to hold a hit back in, so any hit stops the whole import.
  const hits = await scanStaged(projectsDir);
  if (hits.size) {
    const files = [...hits.keys()].sort();
    return `secret-shaped content in ${files.map((f) => quoted(f)).join(", ")}: redact or move them out of Projects/ and start a new session`;
  }
  // --no-verify: a pre-commit hook (from a global core.hooksPath, or copied in by
  // init.templateDir) could stage content after the scan above, pushed unscanned.
  await gitOk([...NO_SIGN, "commit", "-q", "--no-verify", "-m", message], { cwd: projectsDir });
  // HEAD, never a literal branch name: the local default decides (spec 5.2).
  const push = await git(["push", "-q", "-u", "origin", "HEAD"], { cwd: projectsDir, timeoutMs: NETWORK_TIMEOUT_MS });
  if (push.code !== 0) return `bootstrap push failed: ${push.stderr.trim() || "timed out"}`;
  return null;
}

// A failed bootstrap or import must be retryable: only the .git this call
// created goes, never the user's notes or the .gitignore / config it wrote.
async function removeCreatedGit(projectsDir: string): Promise<void> {
  await rm(join(projectsDir, ".git"), { recursive: true, force: true });
}

// The steps after this call created Projects/.git, up to its first push. Any
// failure there, returned or thrown (git add on an unreadable note, a filter, a
// failed write), removes that .git: a repository with no commit left behind would
// otherwise end every later session "unsynced" (spec 5.2). A thrown error is
// rethrown after the cleanup; session.ts reports it.
async function firstPush(projectsDir: string, remote: string, steps: () => Promise<string | null>): Promise<SyncState> {
  let failed: string | null;
  try {
    failed = await steps();
  } catch (err) {
    await removeCreatedGit(projectsDir).catch((cleanup: unknown) => {
      throw new Error(`${(err as Error).message}; removing the Projects/.git it created also failed: ${(cleanup as Error).message}`);
    });
    throw err;
  }
  if (failed) {
    await removeCreatedGit(projectsDir);
    return { kind: "stopped", reason: failed };
  }
  const ready = await checkRepo(projectsDir, remote);
  return ready.kind === "ready" ? { ...ready, bootstrapped: true } : ready;
}

// An effectively empty Projects/ is cloned into a hidden temporary sibling in the
// vault root and moved into place only once the clone is known good: a failed
// clone, or one killed at its timeout (a killed git cleans nothing up), never
// leaves a half-made Projects/.git. Returns whether the remote had a commit to
// check out, or why it stopped.
// A crash mid-clone (a kill -9, a lost session) leaves its temporary sibling
// behind: the finally block below never runs. Only names matching exactly the
// pattern this function creates are ever removed here.
async function sweepLeftoverClones(root: string, projectsDir: string): Promise<void> {
  const prefix = basename(projectsDir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${prefix}\\.[0-9a-f]+\\.sro-tmp$`);
  for (const name of await entries(root)) {
    if (pattern.test(name)) await rm(join(root, name), { recursive: true, force: true });
  }
}

async function cloneIntoPlace(root: string, projectsDir: string, remote: string): Promise<{ populated: boolean } | string> {
  await sweepLeftoverClones(root, projectsDir);
  const tmp = join(root, `.${basename(projectsDir)}.${randomBytes(4).toString("hex")}.sro-tmp`);
  try {
    const clone = await git(["clone", "-q", remote, tmp], { cwd: root, timeoutMs: NETWORK_TIMEOUT_MS });
    if (clone.code !== 0 || clone.timedOut) {
      return `clone of ${remote} failed: ${clone.stderr.trim() || (clone.timedOut ? "timed out" : `git exited ${clone.code}`)}`;
    }
    const populated = (await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: tmp })).code === 0;
    if (!populated) {
      const branches = await remoteHasBranches(tmp, remote);
      if (typeof branches === "string") return branches;
      if (branches) {
        return "the remote has branches but its HEAD names a missing one (e.g. a master-default bare repo); set the remote's default branch";
      }
    }
    // Projects/ is absent or an empty directory now (its litter was cleared). A
    // directory renames only onto a missing or empty one, so a note written there
    // in the meantime makes this fail instead of being replaced.
    await rename(tmp, projectsDir);
    return { populated };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function vaultTracksProjects(vaultRoot: string): Promise<boolean> {
  if (!(await exists(join(vaultRoot, ".git")))) return false;
  const r = await git(["ls-files", "--", "Projects"], { cwd: vaultRoot });
  return r.code === 0 && r.stdout.trim().length > 0;
}

// A status line, not a transcript: at most the first 10 names, quoted and
// capped like any other, then a count of what was left out. The full list
// (never capped) is always available separately for callers that need it.
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

// True only when the repository is reachable by git at all (so this is not,
// say, a dubious-ownership refusal that blocks every git command) and holds
// no refs whatsoever: exactly what an interrupted clone, init or bootstrap
// leaves behind, and nothing else. An orphan branch checked out in a
// repository that has other branches fails this (their refs are still
// there), as does anything that stops git from running in the first place.
async function repoHasNoRefsAtAll(projectsDir: string): Promise<boolean> {
  const gitDir = await git(["rev-parse", "--git-dir"], { cwd: projectsDir });
  if (gitDir.code !== 0) return false;
  const refs = await git(["for-each-ref", "--count=1"], { cwd: projectsDir });
  return refs.code === 0 && refs.stdout.trim() === "";
}

async function checkRepo(projectsDir: string, remote: string): Promise<SyncState> {
  // A non-zero exit here only means HEAD has no commit; it does not mean the
  // repository has nothing to lose. The "delete Projects/.git" advice is safe
  // only when the repository truly holds no history, branch or stash: an
  // interrupted clone, init or bootstrap that never made a ref. Anything
  // else (an orphan branch checked out where other branches still have
  // commits, git's own dubious-ownership refusal, a timeout) stops with
  // git's own explanation instead, and never advises deleting anything.
  const head = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { cwd: projectsDir });
  if (head.code !== 0) {
    if (await repoHasNoRefsAtAll(projectsDir)) {
      return {
        kind: "stopped",
        reason:
          "Projects/ is a git repository with no commit (left by an interrupted clone, bootstrap or import): delete Projects/.git (the notes stay) and start a new session",
      };
    }
    const detail = firstLines(head.stderr) || (head.timedOut ? "timed out" : `git exited ${head.code}`);
    return { kind: "stopped", reason: `Projects/'s HEAD could not be verified: ${detail}` };
  }
  const origin = await git(["config", "--get", "remote.origin.url"], { cwd: projectsDir });
  if (origin.code !== 0 || origin.stdout.trim() !== remote) {
    return {
      kind: "stopped",
      reason: `Projects/ origin is "${origin.stdout.trim() || "(none)"}" but OBSIDIAN_PROJECTS_REMOTE is "${remote}"; the two must match exactly`,
    };
  }
  const branch = await git(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: projectsDir });
  if (branch.code !== 0) return { kind: "stopped", reason: "Projects/ is on a detached HEAD; check out its branch" };
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
    const path = await gitOk(["rev-parse", "--path-format=absolute", "--git-path", marker], { cwd: projectsDir });
    if (await exists(path)) return { kind: "stopped", reason: `Projects/ has a ${marker} in progress; finish or abort it` };
  }
  const unmerged = await gitOk(["diff", "--name-only", "--diff-filter=U"], { cwd: projectsDir });
  if (unmerged) {
    return { kind: "stopped", reason: `Projects/ has unmerged files: ${joinNames(unmerged.split("\n"))}` };
  }
  // Every repository that comes out ready gets the required ignores, not only
  // one this call bootstrapped or imported: a Projects/ that was a repository
  // before the plugin (it never ran commitAndPushNew) and a fresh clone
  // of an already-populated remote (a plugin session may be the first to ever
  // clone that remote's history) both skip commitAndPushNew, so neither would
  // otherwise ever gain them. The write itself is committed by the next
  // snapshot like any other file.
  await ensureGitignore(projectsDir);
  return { kind: "ready", branch: branch.stdout.trim(), bootstrapped: false };
}

// No status echoes the credentials a remote URL may carry: every reason and origin
// this returns, and the message of anything it throws (session.ts reports it),
// goes through redactUrlCredentials.
export async function prepareProjects(vault: Vault, cfg: SyncConfig, timezone: string): Promise<SyncState> {
  let state: SyncState;
  try {
    state = await prepare(vault, cfg, timezone);
  } catch (err) {
    if (err instanceof Error) err.message = redactUrlCredentials(err.message);
    throw err;
  }
  if (state.kind === "stopped") return { ...state, reason: redactUrlCredentials(state.reason) };
  if (state.kind === "off-but-configured") return { ...state, origin: redactUrlCredentials(state.origin) };
  return state;
}

async function prepare(vault: Vault, cfg: SyncConfig, timezone: string): Promise<SyncState> {
  const dir = vault.projectsDir;
  const isRepo = await exists(join(dir, ".git"));

  if (!cfg.remote) {
    if (isRepo) {
      const origin = await git(["config", "--get", "remote.origin.url"], { cwd: dir });
      if (origin.code === 0 && origin.stdout.trim()) return { kind: "off-but-configured", origin: origin.stdout.trim() };
    }
    return { kind: "off" };
  }

  if (await vaultTracksProjects(vault.root)) {
    return {
      kind: "stopped",
      reason: "the vault's own git repository tracks Projects/; follow the README migration steps before enabling sync",
    };
  }

  if (isRepo) return checkRepo(dir, cfg.remote);

  if (await isEffectivelyEmpty(dir)) {
    await clearLitter(dir);
    const cloned = await cloneIntoPlace(vault.root, dir, cfg.remote);
    if (typeof cloned === "string") return { kind: "stopped", reason: cloned };
    // A clone with a commit is a complete repository on its own: nothing to undo.
    if (cloned.populated) return checkRepo(dir, cfg.remote);
    return firstPush(dir, cfg.remote, () => commitAndPushNew(dir, timezone, "bootstrap Projects/"));
  }

  // Nonempty and not a repository: import only into an empty remote.
  const branches = await remoteHasBranches(vault.root, cfg.remote);
  if (typeof branches === "string") return { kind: "stopped", reason: branches };
  if (branches) {
    return {
      kind: "stopped",
      reason: "Projects/ has notes but is not a git repository, and the remote is not empty: move the notes aside, let the plugin clone, then copy them back",
    };
  }
  const remote = cfg.remote;
  return firstPush(dir, remote, async () => {
    await gitOk(["init", "-q"], { cwd: dir });
    await gitOk(["remote", "add", "origin", remote], { cwd: dir });
    return commitAndPushNew(dir, timezone, "import Projects/");
  });
}
