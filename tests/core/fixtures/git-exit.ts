// A session that starts a slow git through git.ts and then exits normally, for
// tests/core/git.test.ts: what it started must not outlive it. It prints the git's
// process group with writeSync, which process.exit cannot lose.
import { writeSync } from "node:fs";
import { git } from "../../../core/git.ts";

const [dir = "", to = "", waitMs = "300"] = process.argv.slice(2);
void git(["reset", "-q", "--keep", to], {
  cwd: dir,
  timeoutMs: 60_000,
  onSpawn: (pid) => {
    writeSync(1, `${pid}\n`);
  },
}).catch(() => undefined);
// Long enough for git to reach the filter, then an ordinary exit while it still runs.
setTimeout(() => process.exit(0), Number(waitMs));
