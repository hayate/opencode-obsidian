// Single-winner directory lock. Every contender runs on this machine (the sync
// lock lives in the local Projects/.git, the others in the per-machine state
// directory), so staleness is exactly "the holder's PID is dead": no age limit,
// no renewal, and a live holder is never displaced however long it holds.
//
// The lock is a directory D, held iff it contains exactly one entry named
// owner.<host>.<pid>.<token>. The name carries everything needed to judge it:
// no file content is ever read. Every ownership change is one rename:
// - acquire: build <D>.stage.<pid>.<token> holding our owner entry, then rename
//   it onto D. D never exists without its owner, so there is no ownerless state
//   to adopt; an empty D (a crash between release's two steps) is replaced;
// - takeover: inside D, rename the one entry judged dead to our own name;
// - release: unlink our entry, then rmdir D, never a recursive remove.
//
// Invariants:
// - single winner: every transition is one rename of one uniquely named entry,
//   and a directory rename succeeds only onto a missing or an empty path;
// - stale means the PID in the name is dead on this host (process.kill(pid, 0)
//   fails with ESRCH). Anything else in D (an unparseable name, several
//   entries, another host's owner) is judged live and never touched;
// - a live holder is never displaced;
// - the directory is never removed while it holds an owner: rmdir fails on a
//   non-empty directory;
// - a contender can only ever take the exact record it judged dead: that name
//   belonged to one holder, now dead, so it never reappears once taken, and a
//   late rename of it fails with ENOENT.
// Accepted limitation, shared with remember: a recycled PID keeps a dead
// holder's lock until that unrelated process exits.
import { mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export interface LockHandle {
  readonly token: string;
  held(): Promise<boolean>;
  release(): Promise<boolean>;
}

export interface AcquireOptions {
  waitMs?: number;
  pollMs?: number;
}

const OWNER = /^owner\.([A-Za-z0-9-]*)\.([1-9][0-9]*)\.([0-9a-f]{16})$/;

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function host(): string {
  return hostname().replace(/[^A-Za-z0-9-]/g, "-");
}

// Dead only on ESRCH: EPERM is another user's live process, and a PID that
// process.kill refuses outright proves nothing.
function pidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return errCode(err) === "ESRCH";
  }
}

function stale(name: string): boolean {
  const owner = OWNER.exec(name);
  return owner !== null && owner[1] === host() && pidDead(Number(owner[2]));
}

async function removeStaging(staging: string, me: string): Promise<void> {
  for (const remove of [() => unlink(join(staging, me)), () => rmdir(staging)]) {
    try {
      await remove();
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
  }
}

// Puts D in place with our owner already inside it. False when D exists and is
// not empty (held, or holding something else). The staging directory is gone
// when this returns, whatever the outcome.
async function place(dir: string, staging: string, me: string): Promise<boolean> {
  await mkdir(staging);
  try {
    await writeFile(join(staging, me), "", { flag: "wx" });
    await rename(staging, dir);
    return true;
  } catch (err) {
    const code = errCode(err);
    if (code !== "ENOTEMPTY" && code !== "EEXIST") {
      await removeStaging(staging, me).catch(() => undefined); // report the first error, not the cleanup's
      throw err;
    }
  }
  await removeStaging(staging, me);
  return false;
}

// Takes D's one entry over when it is an owner from this host whose PID is dead.
async function takeover(dir: string, me: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return false; // released since; the next attempt places D
    throw err;
  }
  const [only] = names;
  if (names.length !== 1 || only === undefined || !stale(only)) return false;
  try {
    await rename(join(dir, only), join(dir, me));
    return true;
  } catch (err) {
    if (errCode(err) === "ENOENT") return false; // another contender took it first
    throw err;
  }
}

export async function acquireLock(dir: string, opts: AcquireOptions = {}): Promise<LockHandle | null> {
  const token = randomBytes(8).toString("hex");
  const me = `owner.${host()}.${process.pid}.${token}`;
  const staging = `${dir}.stage.${process.pid}.${token}`;
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const pollMs = opts.pollMs ?? 50;
  await mkdir(dirname(dir), { recursive: true }); // the state directory may not exist yet
  for (;;) {
    if ((await place(dir, staging, me)) || (await takeover(dir, me))) return handle(dir, token, me);
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function handle(dir: string, token: string, me: string): LockHandle {
  const mine = join(dir, me);
  return {
    token,
    // Nothing another contender does can remove this name while we live: only a
    // dead holder's entry is ever taken. Failing to see it is not holding it.
    async held(): Promise<boolean> {
      try {
        await stat(mine);
        return true;
      } catch {
        return false;
      }
    },
    async release(): Promise<boolean> {
      // Several sessions can share one process (one PID): the token in the name decides.
      try {
        await unlink(mine);
      } catch (err) {
        if (errCode(err) === "ENOENT") return false;
        throw err;
      }
      try {
        await rmdir(dir);
      } catch (err) {
        // Not empty: a new acquirer already replaced the empty D, or something
        // foreign lives in it. Gone: a new acquirer replaced it and has already
        // released. Our entry is gone either way.
        const code = errCode(err);
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw err;
      }
      return true;
    },
  };
}
