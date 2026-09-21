import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../../core/lock.ts";
import { tempDir } from "./helpers.ts";

const WORKER = new URL("./fixtures/lock-worker.ts", import.meta.url).pathname;

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
  const b = await acquireLock(dir);
  assert.ok(b);
  await b.release();
});

test("8 processes never overlap (ordered entry/exit log, remember's method)", async () => {
  const root = await tempDir();
  const dir = join(root, "sync.lock");
  const log = join(root, "log");
  await writeFile(log, "");
  const codes = await Promise.all(
    Array.from({ length: 8 }, (_, i) => run([WORKER, dir, log, `w${i}`, "5"])),
  );
  assert.deepEqual(codes, Array(8).fill(0));
  assert.equal(assertNoOverlap(await readFile(log, "utf8")), 40);
});

test("8 processes racing to take over one stale lock never overlap", async () => {
  const root = await tempDir();
  const dir = join(root, "sync.lock");
  const log = join(root, "log");
  await writeFile(log, "");
  await mkdir(dir);
  await writeFile(join(dir, "owner"), JSON.stringify({ pid: await deadPid(), token: "dead", host: hostname(), at: "" }));
  const codes = await Promise.all(
    Array.from({ length: 8 }, (_, i) => run([WORKER, dir, log, `w${i}`, "3"])),
  );
  assert.deepEqual(codes, Array(8).fill(0));
  assert.equal(assertNoOverlap(await readFile(log, "utf8")), 24);
});

test("8 contenders taking over from holders that crash never overlap (every entry is a takeover)", async () => {
  // Each worker dies holding the lock, so every acquisition after the first is a
  // stale takeover raced by all remaining contenders. A single stale window per
  // run is too rare to catch a non-atomic takeover; this makes it the main path.
  const root = await tempDir();
  const dir = join(root, "sync.lock");
  const log = join(root, "log");
  await writeFile(log, "");
  await mkdir(dir);
  await writeFile(join(dir, "owner"), JSON.stringify({ pid: await deadPid(), token: "dead", host: hostname(), at: "" }));
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => run([WORKER, dir, log, `w${i}`, "1", "crash"])));
  assert.deepEqual(codes, Array(8).fill(0));
  assert.equal(assertNoOverlap(await readFile(log, "utf8")), 8);
});

test("a stale owner (dead PID on this host) is taken over, and the directory is never absent", async () => {
  const dir = join(await tempDir(), "sync.lock");
  await mkdir(dir);
  await writeFile(join(dir, "owner"), JSON.stringify({ pid: await deadPid(), token: "dead", host: hostname(), at: "" }));
  const before = (await stat(dir)).ino;
  const lock = await acquireLock(dir);
  assert.ok(lock);
  assert.equal((await stat(dir)).ino, before, "takeover must not recreate the directory");
  await lock.release();
});

test("a live holder is never displaced, however old its lock is", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const holder = await acquireLock(dir);
  assert.ok(holder);
  const old = new Date(Date.now() - 3_600_000);
  await utimes(dir, old, old);
  assert.equal(await acquireLock(dir, { waitMs: 200, adoptAfterMs: 1 }), null);
  await holder.release();
});

test("an owner from another host is never judged stale", async () => {
  const dir = join(await tempDir(), "sync.lock");
  await mkdir(dir);
  await writeFile(join(dir, "owner"), JSON.stringify({ pid: await deadPid(), token: "x", host: "some-other-host", at: "" }));
  assert.equal(await acquireLock(dir), null);
});

test("an old orphan (no owner, no claim) is adopted; a fresh one is not", async () => {
  const fresh = join(await tempDir(), "sync.lock");
  await mkdir(fresh);
  assert.equal(await acquireLock(fresh), null);

  const orphan = join(await tempDir(), "sync.lock");
  await mkdir(orphan);
  const old = new Date(Date.now() - 60_000);
  await utimes(orphan, old, old);
  const lock = await acquireLock(orphan);
  assert.ok(lock);
  await lock.release();
});

test("a dead contender's claim is restored so the lock can be recovered", async () => {
  const dir = join(await tempDir(), "sync.lock");
  await mkdir(dir);
  const pid = await deadPid();
  await writeFile(join(dir, `owner.claim.${pid}.abc`), JSON.stringify({ pid, token: "dead", host: hostname(), at: "" }));
  const lock = await acquireLock(dir, { waitMs: 500 });
  assert.ok(lock);
  await lock.release();
});

test("release only succeeds for the current token (two holders can share a PID)", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const a = await acquireLock(dir);
  assert.ok(a);
  await writeFile(join(dir, "owner"), JSON.stringify({ pid: process.pid, token: "someone-else", host: hostname(), at: "" }));
  assert.equal(await a.held(), false);
  assert.equal(await a.release(), false);
  await stat(dir); // still there
});

test("the lock's parent directory is created when missing", async () => {
  const dir = join(await tempDir(), "state", "deeper", "sync.lock");
  const lock = await acquireLock(dir);
  assert.ok(lock);
  await lock.release();
});

test("an unreadable owner file is judged live: never stolen, never thrown", async () => {
  const dir = join(await tempDir(), "sync.lock");
  const held = await acquireLock(dir);
  assert.ok(held);
  await chmod(join(dir, "owner"), 0o000);
  try {
    assert.equal(await acquireLock(dir, { waitMs: 20 }), null);
  } finally {
    await chmod(join(dir, "owner"), 0o600);
    await held.release();
  }
});
