// Single-winner directory lock, ported from remember's scripts/lib-lock.sh
// (issue #182 there). Every contender runs on this machine, so staleness is
// exactly "the holder's PID is dead": no age limit, no renewal, and a live
// holder is never displaced however long it holds.
//
// Invariants, each one measured in remember before it was adopted:
// - acquisition is mkdir: created or not, one syscall;
// - stale takeover renames the OWNER FILE into a per-contender claim; exactly
//   one rename succeeds. The directory itself is never moved or removed during
//   a takeover: an empty path let a third process's mkdir win (two winners at
//   N=8 in remember);
// - an orphan (no owner, no claim, untouched for adoptAfterMs: a holder killed
//   between mkdir and its owner write) is adopted, and the owner write with
//   O_EXCL is the single-winner gate.
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export interface LockOwner {
  pid: number;
  token: string;
  host: string;
  at: string;
}

export interface LockHandle {
  readonly token: string;
  held(): Promise<boolean>;
  release(): Promise<boolean>;
}

export interface AcquireOptions {
  waitMs?: number;
  pollMs?: number;
  adoptAfterMs?: number;
}

const OWNER = "owner";
const CLAIM_PREFIX = "owner.claim.";
const ADOPT = "adopt";

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === "EPERM";
  }
}

async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    return ""; // unreadable (EACCES, EISDIR...): judged live, never stolen, never thrown
  }
}

function parseOwner(raw: string | null): LockOwner | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof value.pid === "number" && typeof value.token === "string" && typeof value.host === "string") {
      return value as LockOwner;
    }
  } catch {
    // A torn or foreign owner file is judged live: never steal what we cannot read.
  }
  return null;
}

async function ageMs(path: string): Promise<number> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

function newOwner(token: string): string {
  return JSON.stringify({ pid: process.pid, token, host: hostname(), at: new Date().toISOString() });
}

// A claim file whose creator died mid-takeover leaves the lock with no owner.
// The first dead claim becomes the owner again, so it can be judged stale.
async function restoreDeadClaims(dir: string): Promise<boolean> {
  let pendingLiveClaim = false;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.startsWith(CLAIM_PREFIX)) continue;
    const pid = Number(name.slice(CLAIM_PREFIX.length).split(".")[0]);
    if (Number.isInteger(pid) && pidAlive(pid)) {
      pendingLiveClaim = true;
      continue;
    }
    const claimPath = join(dir, name);
    if ((await readRaw(join(dir, OWNER))) === null) {
      await rename(claimPath, join(dir, OWNER)).catch(() => undefined);
    } else {
      await rm(claimPath, { force: true });
    }
  }
  return pendingLiveClaim;
}

async function trySteal(dir: string, token: string): Promise<boolean> {
  const ownerPath = join(dir, OWNER);
  const seen = await readRaw(ownerPath);
  const owner = parseOwner(seen);
  if (seen === null || owner === null) return false;
  if (owner.host !== hostname()) return false; // cannot judge a PID on another host
  if (pidAlive(owner.pid)) return false;

  const claimPath = join(dir, `${CLAIM_PREFIX}${process.pid}.${token}`);
  try {
    await rename(ownerPath, claimPath);
  } catch (err) {
    if (errCode(err) === "ENOENT") return false; // another contender won the rename
    throw err;
  }
  if ((await readRaw(claimPath)) !== seen) {
    // We claimed an owner written after our judgement: hand it back.
    await rename(claimPath, ownerPath).catch(() => undefined);
    return false;
  }
  await writeFile(ownerPath, newOwner(token));
  await rm(claimPath, { force: true });
  return true;
}

async function tryAdopt(dir: string, token: string, adoptAfterMs: number): Promise<boolean> {
  if ((await readRaw(join(dir, OWNER))) !== null) return false;
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.some((n) => n.startsWith(CLAIM_PREFIX))) return false;
  if ((await ageMs(dir)) < adoptAfterMs) return false;

  const marker = join(dir, ADOPT);
  let ownsMarker = false;
  try {
    await mkdir(marker);
    ownsMarker = true;
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
    // An adopter killed while holding the marker strands it; clear it once it is old.
    if ((await ageMs(marker)) < adoptAfterMs) return false;
    const dead = join(dir, `${ADOPT}.dead.${token}`);
    try {
      await rename(marker, dead);
    } catch {
      return false;
    }
    await rm(dead, { recursive: true, force: true });
  }
  let adopted = false;
  try {
    // O_EXCL: if an owner appeared underneath us, someone else legitimately won.
    await writeFile(join(dir, OWNER), newOwner(token), { flag: "wx" });
    adopted = true;
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
  }
  if (ownsMarker) await rmdir(marker).catch(() => undefined);
  return adopted;
}

async function tryOnce(dir: string, token: string, adoptAfterMs: number): Promise<boolean> {
  try {
    await mkdir(dir);
    try {
      await writeFile(join(dir, OWNER), newOwner(token), { flag: "wx" });
      return true;
    } catch (err) {
      if (errCode(err) === "EEXIST") return false;
      throw err;
    }
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw err;
  }
  if (await restoreDeadClaims(dir)) return false;
  if (await trySteal(dir, token)) return true;
  return tryAdopt(dir, token, adoptAfterMs);
}

export async function acquireLock(dir: string, opts: AcquireOptions = {}): Promise<LockHandle | null> {
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const pollMs = opts.pollMs ?? 50;
  const adoptAfterMs = opts.adoptAfterMs ?? 30_000;
  await mkdir(dirname(dir), { recursive: true }); // the state directory may not exist yet
  for (;;) {
    if (await tryOnce(dir, token, adoptAfterMs)) return handle(dir, token);
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function handle(dir: string, token: string): LockHandle {
  const held = async (): Promise<boolean> => parseOwner(await readRaw(join(dir, OWNER)))?.token === token;
  return {
    token,
    held,
    async release(): Promise<boolean> {
      // Several sessions can share one process (one PID): the token decides.
      if (!(await held())) return false;
      await rm(join(dir, OWNER), { force: true });
      await rm(dir, { recursive: true, force: true });
      return true;
    },
  };
}
