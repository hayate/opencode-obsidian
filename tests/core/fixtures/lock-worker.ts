// A contender for tests/core/lock.test.ts: acquire, log enter/exit, release.
import { appendFile } from "node:fs/promises";
import { acquireLock } from "../../../core/lock.ts";

const [dir, log, id, roundsArg, mode] = process.argv.slice(2);
if (!dir || !log || !id) throw new Error("usage: lock-worker <dir> <log> <id> [rounds] [crash]");
const rounds = Number(roundsArg ?? "5");

for (let i = 0; i < rounds; i++) {
  const lock = await acquireLock(dir, { waitMs: 60_000, pollMs: 2 });
  if (!lock) process.exit(2);
  await appendFile(log, `enter ${id}\n`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await appendFile(log, `exit ${id}\n`);
  // "crash": die holding the lock, so the next contender must take it over.
  if (mode === "crash") process.exit(0);
  if (!(await lock.release())) process.exit(3);
}
