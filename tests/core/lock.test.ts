import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireLock } from "../../core/lock.ts";
import { sleep, tempDir } from "./helpers.ts";

const WORKER = fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url));
const LOCK_SOURCE = fileURLToPath(new URL("../../core/lock.ts", import.meta.url));
const HOST = hostname().replace(/[^A-Za-z0-9-]/g, "-");

function run(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("close", resolve));
  return child.pid!;
}

function token(): string {
  return randomBytes(8).toString("hex");
}

function ownerName(pid: number, host = HOST, tok = token()): string {
  return `owner.${host}.${pid}.${tok}`;
}

// A lock left behind by a holder that died holding it, in whatever form the lock
// under test writes: a real process acquires it and exits without releasing.
async function crashedHolder(dir: string): Promise<void> {
  assert.equal(await run([WORKER, dir, join(dirname(dir), "crashed.log"), "crashed", "1", "crash"]), 0);
}

async function stagingLeft(dir: string): Promise<string[]> {
  return (await readdir(dirname(dir))).filter((name) => name.includes(".stage."));
}

function assertNoOverlap(log: string): number {
  let holder: string | null = null;
  let entries = 0;
  for (const line of log.trim().split("\n")) {
    const [kind, id] = line.split(" ");
    if (kind === "enter") {
      assert.equal(holder, null, `enter ${id} while ${holder} holds the lock`);
      holder = id ?? null;
      entries++;
    } else {
      assert.equal(holder, id, `exit ${id} but holder is ${holder}`);
      holder = null;
    }
  }
  return entries;
}

test("acquire, refuse a second holder, release, reacquire", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const a = await acquireLock(dir);
  assert.ok(a);
  assert.equal(await acquireLock(dir), null);
  assert.equal(await a.held(), true);
  assert.equal(await a.release(), true);
  await assert.rejects(stat(dir), { code: "ENOENT" }, "release removes the lock directory");
  const b = await acquireLock(dir);
  assert.ok(b);
  assert.equal(await b.release(), true);
});

test("the lock directory holds exactly one entry, named owner.<host>.<pid>.<token>", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const lock = await acquireLock(dir);
  assert.ok(lock);
  assert.match(lock.token, /^[0-9a-f]{16}$/);
  assert.deepEqual(await readdir(dir), [`owner.${HOST}.${process.pid}.${lock.token}`]);
  await lock.release();
});

test("8 processes never overlap (ordered entry/exit log, remember's method)", async () => {
  const root = await tempDir();
  const dir = join(root, "sync.lock");
  const log = join(root, "log");
  await writeFile(log, "");
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => run([WORKER, dir, log, `w${i}`, "5"])));
  assert.deepEqual(codes, Array(8).fill(0));
  assert.equal(assertNoOverlap(await readFile(log, "utf8")), 40);
});

test("8 processes racing to take over one stale lock never overlap", async () => {
  const root = await tempDir();
  const dir = join(root, "sync.lock");
  const log = join(root, "log");
  await writeFile(log, "");
  await crashedHolder(dir);
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => run([WORKER, dir, log, `w${i}`, "3"])));
  assert.deepEqual(codes, Array(8).fill(0));
  assert.equal(assertNoOverlap(await readFile(log, "utf8")), 24);
});

test("8 contenders taking over from holders that crash never overlap (every entry is a takeover)", async () => {
  // Each worker dies holding the lock, so every acquisition is a stale takeover
  // raced by all remaining contenders. A single stale window per run is too rare
  // to catch a non-atomic takeover; this makes it the main path.
  const root = await tempDir();
  const dir = join(root, "sync.lock");
  const log = join(root, "log");
  await writeFile(log, "");
  await crashedHolder(dir);
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => run([WORKER, dir, log, `w${i}`, "1", "crash"])));
  assert.deepEqual(codes, Array(8).fill(0));
  assert.equal(assertNoOverlap(await readFile(log, "utf8")), 8);
});

test("a stale owner (dead PID on this host) is taken over, and the directory is never absent", async () => {
  const dir = join(await tempDir(), "sync.lock");
  await mkdir(dir);
  await writeFile(join(dir, ownerName(await deadPid())), "");
  const before = (await stat(dir)).ino;
  const lock = await acquireLock(dir);
  assert.ok(lock);
  assert.equal((await stat(dir)).ino, before, "takeover must not recreate the directory");
  assert.deepEqual(await readdir(dir), [`owner.${HOST}.${process.pid}.${lock.token}`]);
  await lock.release();
});

test("a live holder is never displaced, however old its lock is", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const holder = await acquireLock(dir);
  assert.ok(holder);
  const old = new Date(Date.now() - 3_600_000);
  await utimes(dir, old, old);
  assert.equal(await acquireLock(dir, { waitMs: 200 }), null);
  assert.equal(await holder.held(), true);
  assert.equal(await holder.release(), true);
});

test("an owner from another host is never judged stale", async () => {
  const dir = join(await tempDir(), "sync.lock");
  await mkdir(dir);
  const foreign = ownerName(await deadPid(), "some-other-host");
  await writeFile(join(dir, foreign), "");
  assert.equal(await acquireLock(dir), null);
  assert.deepEqual(await readdir(dir), [foreign]);
});

test("release succeeds only for the current token (two holders can share a PID)", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const a = await acquireLock(dir);
  assert.ok(a);
  assert.equal(await a.release(), true);
  const b = await acquireLock(dir); // same process, so same PID as a
  assert.ok(b);
  assert.equal(await a.held(), false);
  assert.equal(await a.release(), false, "a stale handle must not release the current holder");
  assert.equal(await b.held(), true);
  await stat(dir); // still there
  assert.equal(await b.release(), true);
  assert.equal(await b.release(), false, "a second release is refused");
});

test("the lock's parent directory is created when missing", async () => {
  const dir = join(await tempDir(), "state", "deeper", "sync.lock");
  const lock = await acquireLock(dir);
  assert.ok(lock);
  await lock.release();
});

test("an unparseable entry in the lock directory is judged live: never stolen, never thrown", async () => {
  const dead = await deadPid();
  const cases: string[][] = [
    ["garbage"],
    ["owner"], // a fixed-name slot, as the previous lock wrote
    [`owner.${HOST}.${dead}.not-a-token`],
    [`owner.${HOST}.0.${token()}`], // PID 0 would signal the whole process group
    [`owner.${HOST}.99999999999.${token()}`], // beyond what process.kill accepts
    [`owner.${HOST}.${dead}.${token()}.extra`],
    [ownerName(dead), "extra"], // two entries: something else lives here
    [ownerName(dead), ownerName(dead)],
  ];
  for (const entries of cases) {
    const dir = join(await tempDir(), "sync.lock");
    await mkdir(dir);
    for (const name of entries) await writeFile(join(dir, name), "");
    assert.equal(await acquireLock(dir, { waitMs: 20 }), null, `stole ${entries.join(", ")}`);
    assert.deepEqual((await readdir(dir)).sort(), [...entries].sort(), `touched ${entries.join(", ")}`);
  }
});

test("an empty lock directory (a crash between release's two steps) is acquired", async () => {
  const dir = join(await tempDir(), "sync.lock");
  await mkdir(dir);
  const lock = await acquireLock(dir);
  assert.ok(lock);
  assert.deepEqual(await readdir(dir), [`owner.${HOST}.${process.pid}.${lock.token}`]);
  await lock.release();
});

test("a leftover staging directory from a dead process does not block acquisition", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const dead = await deadPid();
  // One from a dead process, and one whose PID is ours now (a crashed earlier
  // process with a recycled PID): neither may collide with a new staging name.
  for (const pid of [dead, process.pid]) {
    const tok = token();
    const staging = `${dir}.stage.${pid}.${tok}`;
    await mkdir(staging);
    await writeFile(join(staging, ownerName(pid, HOST, tok)), "");
  }
  const lock = await acquireLock(dir);
  assert.ok(lock);
  assert.deepEqual(await readdir(dir), [`owner.${HOST}.${process.pid}.${lock.token}`]);
  await lock.release();
});

test("the staging directory never outlives acquireLock (success, refusal, takeover)", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const a = await acquireLock(dir);
  assert.ok(a);
  assert.deepEqual(await stagingLeft(dir), [], "after a success");
  assert.equal(await acquireLock(dir, { waitMs: 30, pollMs: 5 }), null);
  assert.deepEqual(await stagingLeft(dir), [], "after a refusal");
  await a.release();

  await mkdir(dir);
  await writeFile(join(dir, ownerName(await deadPid())), "");
  const b = await acquireLock(dir);
  assert.ok(b);
  assert.deepEqual(await stagingLeft(dir), [], "after a takeover");
  await b.release();
});

test("a lock path that is not a directory is an error, not a lock that stays busy forever", async () => {
  const dir = join(await tempDir(), "sync.lock");
  await writeFile(dir, "");
  await assert.rejects(acquireLock(dir, { waitMs: 20 }), { code: "ENOTDIR" });
  assert.deepEqual(await stagingLeft(dir), [], "the staging directory is removed on the error path too");
});

test("release never removes the lock directory recursively", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const lock = await acquireLock(dir);
  assert.ok(lock);
  await writeFile(join(dir, "foreign"), "");
  assert.equal(await lock.release(), true);
  assert.deepEqual(await readdir(dir), ["foreign"]);
});

// Deterministic interleavings: a copy of core/lock.ts whose node:fs/promises
// import is swapped for a wrapper that pauses at test-set breakpoints (before or
// after a call). The copy runs the real algorithm; only the scheduling is forced.
const GATED_FS = `
import * as fs from "node:fs/promises";
export * from "node:fs/promises";
const points = [];
export function breakpoint(op, phase, match) {
  let hit;
  let go;
  const reached = new Promise((resolve) => (hit = resolve));
  const released = new Promise((resolve) => (go = resolve));
  points.push({ op, phase, match, hit, released });
  return { reached, go };
}
export function clearBreakpoints() {
  points.splice(0);
}
async function pause(op, phase, args) {
  const i = points.findIndex((p) => p.op === op && p.phase === phase && p.match(...args.map(String)));
  if (i < 0) return;
  const [p] = points.splice(i, 1);
  p.hit();
  await p.released;
}
function gated(op) {
  return async (...args) => {
    await pause(op, "before", args);
    try {
      return await fs[op](...args);
    } finally {
      await pause(op, "after", args);
    }
  };
}
export const access = gated("access");
export const link = gated("link");
export const lstat = gated("lstat");
export const mkdir = gated("mkdir");
export const open = gated("open");
export const readFile = gated("readFile");
export const readdir = gated("readdir");
export const rename = gated("rename");
export const rm = gated("rm");
export const rmdir = gated("rmdir");
export const stat = gated("stat");
export const unlink = gated("unlink");
export const writeFile = gated("writeFile");
`;

type LockModule = typeof import("../../core/lock.ts");
interface Breakpoint {
  reached: Promise<void>;
  go(): void;
}
interface GateModule {
  breakpoint(op: string, phase: "before" | "after", match: (...args: string[]) => boolean): Breakpoint;
  clearBreakpoints(): void;
}

let gatedCopy: Promise<{ lock: LockModule; gate: GateModule }> | undefined;
function gatedLock(): Promise<{ lock: LockModule; gate: GateModule }> {
  gatedCopy ??= (async () => {
    const root = await tempDir("sro-gatedlock-");
    const source = await readFile(LOCK_SOURCE, "utf8");
    const imports = source.match(/from "node:fs\/promises"/g) ?? [];
    assert.equal(imports.length, 1, "core/lock.ts must import node:fs/promises exactly once for the gate to wrap it");
    await writeFile(join(root, "package.json"), '{ "type": "module" }\n');
    await writeFile(join(root, "gatedfs.mjs"), GATED_FS);
    await writeFile(join(root, "lock.ts"), source.replace('from "node:fs/promises"', 'from "./gatedfs.mjs"'));
    const gate = (await import(pathToFileURL(join(root, "gatedfs.mjs")).href)) as GateModule;
    const lock = (await import(pathToFileURL(join(root, "lock.ts")).href)) as LockModule;
    return { lock, gate };
  })();
  return gatedCopy;
}

async function within<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// A rename from one entry of the lock directory to another: a takeover.
function takeoverIn(dir: string): (from: string, to?: string) => boolean {
  return (from, to) => dirname(from) === dir && to !== undefined && dirname(to) === dir;
}

test("race: a contender that judged a record dead cannot take it after another contender has (was a stuck lock)", async () => {
  const { lock, gate } = await gatedLock();
  const dir = join(await tempDir(), "sync.lock");
  await crashedHolder(dir);
  try {
    // S2 lists the directory, judges the crashed holder dead, and stops right
    // before its takeover rename.
    const s2AtRename = gate.breakpoint("rename", "before", takeoverIn(dir));
    const s2P = lock.acquireLock(dir);
    await within(s2AtRename.reached, "S2 reaches its takeover rename");
    // S1 takes the same dead record over and holds.
    const s1 = await lock.acquireLock(dir);
    assert.ok(s1, "S1 takes over the dead record");
    const heldBefore = await s1.held();
    // S2 resumes; stop it again right after its rename has run, and release S1
    // there (the window in which the previous lock handed a live record back).
    const s2Renamed = gate.breakpoint("rename", "after", takeoverIn(dir));
    s2AtRename.go();
    await within(s2Renamed.reached, "S2's takeover rename runs");
    const heldInWindow = await s1.held();
    const released = await s1.release();
    s2Renamed.go();
    const s2 = await within(s2P, "S2 finishes");
    const fresh = await lock.acquireLock(dir, { waitMs: 300 });
    const observed = {
      s2Acquired: s2 !== null,
      heldBefore,
      heldInWindow,
      released,
      freshAcquired: fresh !== null,
    };
    await fresh?.release();
    assert.deepEqual(observed, {
      s2Acquired: false,
      heldBefore: true,
      heldInWindow: true,
      released: true,
      freshAcquired: true,
    });
  } finally {
    gate.clearBreakpoints();
  }
});

test("race: two contenders that judged the same record dead: exactly one takes it and keeps it", async () => {
  const { lock, gate } = await gatedLock();
  const dir = join(await tempDir(), "sync.lock");
  await crashedHolder(dir);
  try {
    // Both contenders judge the crashed holder dead and stop at their takeover rename.
    const k1AtRename = gate.breakpoint("rename", "before", takeoverIn(dir));
    const k1P = lock.acquireLock(dir, { waitMs: 5_000, pollMs: 5 });
    await within(k1AtRename.reached, "K1 reaches its takeover rename");
    const k2AtRename = gate.breakpoint("rename", "before", takeoverIn(dir));
    const k2P = lock.acquireLock(dir, { waitMs: 5_000, pollMs: 5 });
    await within(k2AtRename.reached, "K2 reaches its takeover rename");
    // The one that started second renames first, and wins.
    k2AtRename.go();
    const k2 = await within(k2P, "K2 takes the record over");
    assert.ok(k2);
    // K1's rename of the record it judged runs now; check the winner right after.
    const k1Renamed = gate.breakpoint("rename", "after", takeoverIn(dir));
    k1AtRename.go();
    await within(k1Renamed.reached, "K1's takeover rename runs");
    const winnerHeldInWindow = await k2.held();
    k1Renamed.go();
    const loserWhileWinnerHolds = await Promise.race([
      k1P.then((h) => (h ? "acquired" : "gave up")),
      sleep(150).then(() => "polling"),
    ]);
    const winnerHeldAfter = await k2.held();
    const released = await k2.release();
    const k1 = await within(k1P, "K1 acquires once K2 releases");
    const observed = {
      winnerHeldInWindow,
      loserWhileWinnerHolds,
      winnerHeldAfter,
      released,
      loserAcquiredAfterRelease: k1 !== null,
      loserHeld: k1 ? await k1.held() : false,
      winnerHeldAtEnd: await k2.held(),
    };
    await k1?.release();
    assert.deepEqual(observed, {
      winnerHeldInWindow: true,
      loserWhileWinnerHolds: "polling",
      winnerHeldAfter: true,
      released: true,
      loserAcquiredAfterRelease: true,
      loserHeld: true,
      winnerHeldAtEnd: false,
    });
  } finally {
    gate.clearBreakpoints();
  }
});
