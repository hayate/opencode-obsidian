// Spec 5.3: the state clone. Bare (integration merges trees and never checks out),
// in the files ref format, with git's background maintenance and every hook off,
// and the plugin's alone: rebuilt whenever it cannot be used, and a rebuild never
// leaves a half-made or half-deleted clone in place.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOk } from "../git.ts";

export const CLONE_NAME = "sync.git";
const LEFTOVER = /^\.sync\.[0-9a-f]{8}\.sro-(tmp|old)$/;
// Relative, so git resolves it inside the clone wherever the clone is (verified, git
// 2.50.1: it survives the rename into place). Nothing ever creates it, so no hook,
// the user's global core.hooksPath included, runs in the clone.
const NO_HOOKS = "sro-no-hooks";

// Nobody else uses the clone and the sync lock is held, so any lock file in it is a
// leftover (spec 5.6). --local: its own remotes, not ones a user's global config
// happens to name.
async function usable(clone: string): Promise<boolean> {
  try {
    const names = [...(await readdir(clone)), ...(await readdir(join(clone, "refs"), { recursive: true }))];
    if (names.some((name) => name.endsWith(".lock"))) return false;
  } catch {
    return false; // absent, or not something we can use: rebuild it
  }
  const ask = async (args: string[]): Promise<string | null> => {
    const r = await git(args, { cwd: clone });
    return r.code === 0 && !r.timedOut ? r.stdout.trim() : null;
  };
  if ((await ask(["rev-parse", "--is-bare-repository"])) !== "true") return false;
  // A reftable clone keeps its locks under reftable/, which the check above does not scan.
  if ((await ask(["rev-parse", "--show-ref-format"])) !== "files") return false;
  for (const remote of ["live", "origin"]) {
    if ((await ask(["config", "--local", "--get", `remote.${remote}.url`])) === null) return false;
  }
  return true;
}

async function rebuild(stateDir: string, clone: string, projectsDir: string, remote: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  for (const name of await readdir(stateDir)) {
    if (LEFTOVER.test(name)) await rm(join(stateDir, name), { recursive: true, force: true });
  }
  const id = randomBytes(4).toString("hex");
  const tmp = join(stateDir, `.sync.${id}.sro-tmp`);
  const old = join(stateDir, `.sync.${id}.sro-old`);
  try {
    // Local and hard-linked, no network; files format, so the leftover-lock check
    // above knows every lock it can hold; no hook runs in the clone command (the
    // setting itself is put in place below, before anything else could run one).
    await gitOk(["-c", `core.hooksPath=${join(tmp, NO_HOOKS)}`, "clone", "-q", "--bare", "--ref-format=files", projectsDir, tmp], {
      cwd: stateDir,
    });
    await gitOk(["remote", "rename", "origin", "live"], { cwd: tmp });
    await gitOk(["remote", "add", "origin", remote], { cwd: tmp });
    // Two renames, then the old clone goes: the path holds the old clone, nothing, or
    // the new one, never a half-deleted one. Nothing needs putting back if the second
    // rename fails: an absent clone is rebuilt next cycle.
    await rename(clone, old).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    await rename(tmp, clone);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  // The new clone is in place: a failure here only leaves a leftover the next rebuild sweeps.
  await rm(old, { recursive: true, force: true });
}

export async function ensureStateClone(stateDir: string, projectsDir: string, remote: string): Promise<string> {
  const clone = join(stateDir, CLONE_NAME);
  if (!(await usable(clone))) await rebuild(stateDir, clone, projectsDir, remote);
  // Put back every cycle, before anything could start maintenance or run a hook:
  // moving the vault or changing the remote cannot strand the clone, and a setting
  // changed by hand cannot leave it not the plugin's alone.
  await gitOk(["remote", "set-url", "live", projectsDir], { cwd: clone });
  await gitOk(["remote", "set-url", "origin", remote], { cwd: clone });
  // git fetch would otherwise start a detached `git maintenance run --auto`.
  for (const [key, value] of [["maintenance.auto", "false"], ["gc.auto", "0"], ["core.hooksPath", NO_HOOKS]]) {
    await gitOk(["config", key ?? "", value ?? ""], { cwd: clone });
  }
  for (const key of ["user.name", "user.email"]) {
    await gitOk(["config", key, await gitOk(["config", key], { cwd: projectsDir })], { cwd: clone });
  }
  return clone;
}
