import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git, gitOk, GitError, literal } from "../../core/git.ts";
import { commitFile, initRepo, sleep, tempDir, writeRel } from "./helpers.ts";

const execFileAsync = promisify(execFile);

test("gitOk returns trimmed stdout", async () => {
  const out = await gitOk(["--version"], { cwd: process.cwd() });
  assert.match(out, /^git version \d/);
});

test("gitOk throws a GitError carrying the result on a non-zero exit", async () => {
  const dir = await tempDir();
  await assert.rejects(gitOk(["rev-parse", "HEAD"], { cwd: dir }), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.notEqual(err.result.code, 0);
    assert.equal(err.result.timedOut, false);
    assert.deepEqual(err.args, ["rev-parse", "HEAD"]);
    // An ordinary failure keeps git's own words; only a leftover lock is rephrased.
    assert.match(err.message, /^git rev-parse HEAD exited \d+: fatal: /);
    return true;
  });
});

test("git passes input on stdin", async () => {
  const dir = await tempDir();
  const r = await git(["hash-object", "--stdin"], { cwd: dir, input: "hello\n" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
});

test("a git that exits without reading its input is its own result, not an uncaught EPIPE", async () => {
  const r = await git(["--version"], { cwd: process.cwd(), input: "x".repeat(16 * 1024 * 1024) });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^git version \d/);
});

test("git never prompts: GIT_TERMINAL_PROMPT is 0 and inherited GIT_DIR is dropped", async () => {
  const dir = await tempDir();
  process.env.GIT_DIR = "/nonexistent-git-dir";
  try {
    const r = await git(["-c", "alias.env=!echo \"$GIT_TERMINAL_PROMPT:${GIT_DIR:-unset}\"", "env"], { cwd: dir });
    assert.equal(r.stdout.trim(), "0:unset");
  } finally {
    delete process.env.GIT_DIR;
  }
});

test("a timeout kills git and the processes it started", async () => {
  const dir = await tempDir();
  const pidFile = join(dir, "sleep.pid");
  const r = await git(["-c", `alias.nap=!sleep 30 & echo $! > '${pidFile}'; wait`, "nap"], {
    cwd: dir,
    timeoutMs: 500,
  });
  assert.equal(r.timedOut, true);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  await sleep(200);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("core never spawns synchronously (a sync child would block the event loop)", async () => {
  // fileURLToPath, never .pathname: a checkout path with a space is %20 in a URL.
  const coreDir = fileURLToPath(new URL("../../core/", import.meta.url));
  const files = (await readdir(coreDir, { recursive: true })).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = await readFile(join(coreDir, file), "utf8");
    assert.doesNotMatch(text, /\b(spawnSync|execSync|execFileSync)\b/, `core/${file}`);
  }
});

test("a command that meets another process's index.lock is retried, never the lock deleted", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await writeRel(dir, "a.md", "a");
  const lock = join(dir, ".git", "index.lock");
  await writeFile(lock, "");
  const removal = sleep(300).then(() => rm(lock, { force: true }));
  await gitOk(["add", "a.md"], { cwd: dir });
  await removal;
  assert.match(await gitOk(["diff", "--cached", "--name-only"], { cwd: dir }), /a\.md/);
});

// A hook or filter can print git's index.lock message after it already did work.
const FAKE_LOCK = `echo "fatal: Unable to create '.git/index.lock': File exists." >&2`;

async function countRuns(dir: string): Promise<number> {
  return (await readFile(join(dir, ".git", "runs"), "utf8")).trim().split("\n").length;
}

async function fakeFilter(dir: string, then: string): Promise<void> {
  const script = join(dir, ".git", "fake-filter.sh");
  await writeFile(script, `#!/bin/sh\necho ran >> .git/runs\n${FAKE_LOCK}\n${then}\n`);
  await gitOk(["config", "filter.fake.clean", `sh '${script}'`], { cwd: dir });
  await gitOk(["config", "filter.fake.required", "true"], { cwd: dir });
  await writeRel(dir, ".gitattributes", "*.md filter=fake\n");
}

test("a command that runs hooks is never retried, even with an index.lock really there", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await writeRel(dir, "a.md", "a\n");
  await gitOk(["add", "a.md"], { cwd: dir });
  // The hook leaves a lock behind (a directory git's cleanup cannot unlink), as if
  // another git client took it the moment the commit failed.
  const hook = join(dir, ".git", "hooks", "pre-commit");
  await writeFile(hook, `#!/bin/sh\necho ran >> .git/runs\nrm -f .git/index.lock && mkdir .git/index.lock\n${FAKE_LOCK}\nexit 1\n`);
  await chmod(hook, 0o755);
  const r = await git(["commit", "-q", "-m", "m"], { cwd: dir });
  assert.notEqual(r.code, 0);
  assert.equal(await countRuns(dir), 1);
  // The hook's own message, not git's from a retry (which names the absolute path).
  assert.match(r.stderr, /Unable to create '\.git\/index\.lock'/);
});

test("the index.lock message is not retried when no index.lock exists", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await fakeFilter(dir, "exit 1");
  await writeRel(dir, "a.md", "a\n");
  assert.notEqual((await git(["add", "a.md"], { cwd: dir })).code, 0);
  assert.equal(await countRuns(dir), 1);
});

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

test("an add killed on its timeout has the index.lock it left removed", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await fakeFilter(dir, "exec sleep 10");
  await writeRel(dir, "a.md", "a\n");
  const r = await git(["add", "a.md"], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(await exists(join(dir, ".git", "index.lock")), false);
  assert.match(r.stderr, /removed .*index\.lock/);
});

test("a reset killed on its timeout has the index.lock it left removed", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await commitFile(dir, "a.md", "one\n", "one");
  await commitFile(dir, "a.md", "two\n", "two");
  // The smudge filter hangs while reset writes a.md under the index lock.
  await gitOk(["config", "filter.slow.smudge", "sleep 10; cat"], { cwd: dir });
  await writeRel(dir, ".gitattributes", "*.md filter=slow\n");
  const r = await git(["reset", "-q", "--keep", "HEAD~1"], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(await exists(join(dir, ".git", "index.lock")), false);
  assert.match(r.stderr, /removed .*index\.lock/);
});

// commit and checkout run hooks after they release the index lock, so a lock found
// after killing one proves nothing about who holds it: it is left for the user, even
// when (as here) it is the killed command's own.
test("a killed commit never has a lock removed, even its own", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await commitFile(dir, "a.md", "a\n", "a");
  await fakeFilter(dir, "exec sleep 10");
  await writeRel(dir, "a.md", "changed\n");
  // -a stages the change under the index lock, through the hanging clean filter.
  const r = await git(["commit", "-a", "-q", "-m", "m"], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(await exists(join(dir, ".git", "index.lock")), true);
  assert.doesNotMatch(r.stderr, /removed/);
});

test("a killed checkout never has a lock removed, even its own", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await commitFile(dir, "a.md", "one\n", "one");
  await commitFile(dir, "a.md", "two\n", "two");
  await gitOk(["config", "filter.slow.smudge", "sleep 10; cat"], { cwd: dir });
  await writeRel(dir, ".gitattributes", "*.md filter=slow\n");
  const r = await git(["checkout", "-q", "-f", "--detach", "HEAD~1"], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(await exists(join(dir, ".git", "index.lock")), true);
  assert.doesNotMatch(r.stderr, /removed/);
});

test(
  "a killed command whose index.lock cannot be removed says so, and is still never retried",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const dir = await tempDir();
    await initRepo(dir);
    // The filter prints git's lock message, so only the timeout rule stops a retry
    // once the lock is still there; a read-only .git keeps it there.
    await fakeFilter(dir, "chmod 555 .git; exec sleep 10");
    await writeRel(dir, "a.md", "a\n");
    try {
      const r = await git(["add", "a.md"], { cwd: dir, timeoutMs: 500 });
      assert.equal(r.timedOut, true, "a retry would have returned a later, non-timed-out attempt");
      assert.match(r.stderr, /could not remove .*index\.lock, which this command left when it was stopped: .*EACCES/);
      assert.equal(await exists(join(dir, ".git", "index.lock")), true);
    } finally {
      await chmod(join(dir, ".git"), 0o755);
    }
  },
);

test("a lock taken by another process after a killed reset released its own is never removed", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await commitFile(dir, "a.md", "one\n", "one");
  await commitFile(dir, "a.md", "two\n", "two");
  // reset runs the reference-transaction hook after it has released the index lock
  // (renamed onto the index): another process takes the lock while reset hangs there.
  const hook = join(dir, ".git", "hooks", "reference-transaction");
  await writeFile(hook, '#!/bin/sh\n[ "$1" = committed ] || exit 0\ntouch .git/index.lock\nexec sleep 10\n');
  await chmod(hook, 0o755);
  const r = await git(["reset", "-q", "--keep", "HEAD~1"], { cwd: dir, timeoutMs: 2000 });
  assert.equal(r.timedOut, true);
  assert.equal(await exists(join(dir, ".git", "index.lock")), true);
  assert.doesNotMatch(r.stderr, /removed/);
});

test("a killed rm never has a lock removed: it runs no filters, so it had not reached the lock", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await commitFile(dir, "a.md", "a\n", "a");
  const lock = join(dir, ".git", "index.lock");
  const fifo = join(dir, ".git", "hang.fifo");
  await execFileAsync("mkfifo", [fifo]);
  // rm blocks reading its config; meanwhile another process takes the lock.
  const other = sleep(200).then(() => writeFile(lock, ""));
  const r = await git(["-c", `include.path=${fifo}`, "rm", "-q", "--cached", "a.md"], { cwd: dir, timeoutMs: 1000 });
  await other;
  assert.equal(r.timedOut, true);
  assert.equal(await exists(lock), true);
});

test("an index.lock that was already there when a killed command started is never removed", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await writeRel(dir, "a.md", "a\n");
  const lock = join(dir, ".git", "index.lock");
  await writeFile(lock, "");
  // Reading its config blocks on the pipe, so git is killed before it ever
  // reaches the lock: the lock belongs to someone else.
  const fifo = join(dir, ".git", "hang.fifo");
  await execFileAsync("mkfifo", [fifo]);
  const r = await git(["-c", `include.path=${fifo}`, "add", "a.md"], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(await exists(lock), true);
});

test("looking up the index.lock path honours the caller's timeout", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await writeRel(dir, "a.md", "a\n");
  // Every git command in this repository blocks reading its config.
  const fifo = join(dir, ".git", "hang.fifo");
  await execFileAsync("mkfifo", [fifo]);
  await writeFile(join(dir, ".git", "config"), `${await readFile(join(dir, ".git", "config"), "utf8")}[include]\n\tpath = hang.fifo\n`);
  const started = Date.now();
  const r = await git(["add", "a.md"], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms for a 500 ms timeout`);
});

test("a killed command that does not take the index lock never removes one", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  const lock = join(dir, ".git", "index.lock");
  // Another process takes the lock while this command runs.
  const r = await git(["-c", `alias.nap=!touch '${lock}'; sleep 10`, "nap"], { cwd: dir, timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.equal(await exists(lock), true);
});

test("a lock file nobody removes is named in one plain sentence", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await commitFile(dir, "a.md", "a\n", "a");
  const lock = join(dir, ".git", "refs", "heads", "side.lock");
  await writeFile(lock, "");
  await assert.rejects(gitOk(["update-ref", "refs/heads/side", "HEAD"], { cwd: dir }), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(
      err.message,
      `git left a lock file behind: '${lock}' (a git program stopped before it finished). If no git program is running on this machine, delete that file.`,
    );
    return true;
  });
  assert.equal(await exists(lock), true);
});

test("a vault path with an apostrophe is named whole in the lock sentence", async () => {
  const dir = join(await tempDir(), "Andrea's vault");
  await initRepo(dir);
  await commitFile(dir, "a.md", "a\n", "a");
  const lock = join(dir, ".git", "refs", "heads", "side.lock");
  await writeFile(lock, "");
  await assert.rejects(gitOk(["update-ref", "refs/heads/side", "HEAD"], { cwd: dir }), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.match(err.message, /^git left a lock file behind: '(.+)' /);
    assert.equal(/^git left a lock file behind: '(.+)' \(a git/.exec(err.message)?.[1], lock);
    return true;
  });
});

test("git's lock wording about a file that does not exist keeps git's own message", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  // A filter prints the lock sentence (naming no real file) and fails for its own reason.
  await fakeFilter(dir, "exit 1");
  await writeRel(dir, "a.md", "a\n");
  await assert.rejects(gitOk(["add", "a.md"], { cwd: dir }), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.match(err.message, /^git add a\.md exited \d+: /);
    assert.match(err.message, /clean filter 'fake' failed/);
    return true;
  });
});

test("literal() pathspecs: unstaging a note named a*.md leaves ab.md staged", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await writeRel(dir, "a*.md", "star");
  await writeRel(dir, "ab.md", "b");
  await gitOk(["add", "-A"], { cwd: dir });
  await gitOk(["reset", "-q", "--", literal("a*.md")], { cwd: dir });
  assert.equal(await gitOk(["diff", "--cached", "--name-only"], { cwd: dir }), "ab.md");
});

test("git commands a commit hook runs are not forced into literal-pathspec mode", async () => {
  const dir = await tempDir();
  await initRepo(dir);
  await writeRel(dir, ".gitignore", "ignored.tmp\n");
  await gitOk(["add", ".gitignore"], { cwd: dir });
  // check-ignore refuses literal-pathspec mode, so it fails if the mode leaks into hooks.
  const hook = join(dir, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\ngit check-ignore -q ignored.tmp\n");
  await chmod(hook, 0o755);
  const r = await git(["commit", "-q", "-m", "hook runs check-ignore"], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
});
