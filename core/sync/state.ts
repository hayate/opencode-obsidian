// Spec 5.1-5.2: is sync on, and is Projects/ in a state the cycle may touch?
// Every branch here either returns "ready" or stops with a reason a human can
// act on. Nothing is created under Projects/ before this has run.
import { lstat, readFile, readdir, rm, rmdir, stat, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOk, NETWORK_TIMEOUT_MS } from "../git.ts";
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

// Absent, or holding only Finder litter and empty directories, counts as empty.
async function isEffectivelyEmpty(dir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return true;
  }
  for (const name of names) {
    if (name === ".DS_Store") continue;
    const path = join(dir, name);
    // lstat: a symlink is content, never a directory to walk (or clean) through.
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !(await isEffectivelyEmpty(path))) return false;
  }
  return true;
}

async function clearLitter(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
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
  const current = await readFile(path, "utf8").catch(() => "");
  const have = new Set(current.split("\n").map((l) => l.trim()));
  const missing = REQUIRED_IGNORES.filter((p) => !have.has(p));
  if (!missing.length) return false;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await appendFile(path, `${prefix}# superpower-remember-obsidian\n${missing.join("\n")}\n`);
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
  if (!(await exists(join(projectsDir, CONFIG_FILE)))) {
    await writeFile(join(projectsDir, CONFIG_FILE), `${JSON.stringify({ timezone }, null, 2)}\n`);
  }
  await gitOk(["add", "-A"], { cwd: projectsDir });
  await gitOk([...NO_SIGN, "commit", "-q", "-m", message], { cwd: projectsDir });
  // HEAD, never a literal branch name: the local default decides (spec 5.2).
  const push = await git(["push", "-q", "-u", "origin", "HEAD"], { cwd: projectsDir, timeoutMs: NETWORK_TIMEOUT_MS });
  if (push.code !== 0) return `bootstrap push failed: ${push.stderr.trim() || "timed out"}`;
  return null;
}

async function vaultTracksProjects(vaultRoot: string): Promise<boolean> {
  if (!(await exists(join(vaultRoot, ".git")))) return false;
  const r = await git(["ls-files", "--", "Projects"], { cwd: vaultRoot });
  return r.code === 0 && r.stdout.trim().length > 0;
}

async function checkRepo(projectsDir: string, remote: string): Promise<SyncState> {
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
  if (unmerged) return { kind: "stopped", reason: `Projects/ has unmerged files: ${unmerged.split("\n").join(", ")}` };
  return { kind: "ready", branch: branch.stdout.trim(), bootstrapped: false };
}

export async function prepareProjects(vault: Vault, cfg: SyncConfig, timezone: string): Promise<SyncState> {
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
    const clone = await git(["clone", "-q", cfg.remote, dir], { cwd: vault.root, timeoutMs: NETWORK_TIMEOUT_MS });
    if (clone.code !== 0) return { kind: "stopped", reason: `clone of ${cfg.remote} failed: ${clone.stderr.trim() || "timed out"}` };
    const head = await git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: dir });
    if (head.code === 0) return checkRepo(dir, cfg.remote);
    const branches = await remoteHasBranches(dir, cfg.remote);
    if (typeof branches === "string") return { kind: "stopped", reason: branches };
    if (branches) {
      return {
        kind: "stopped",
        reason: "the remote has branches but its HEAD names a missing one (e.g. a master-default bare repo); set the remote's default branch",
      };
    }
    const failed = await commitAndPushNew(dir, timezone, "bootstrap Projects/");
    if (failed) return { kind: "stopped", reason: failed };
    const ready = await checkRepo(dir, cfg.remote);
    return ready.kind === "ready" ? { ...ready, bootstrapped: true } : ready;
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
  await gitOk(["init", "-q"], { cwd: dir });
  await gitOk(["remote", "add", "origin", cfg.remote], { cwd: dir });
  const failed = await commitAndPushNew(dir, timezone, "import Projects/");
  if (failed) return { kind: "stopped", reason: failed };
  const ready = await checkRepo(dir, cfg.remote);
  return ready.kind === "ready" ? { ...ready, bootstrapped: true } : ready;
}
