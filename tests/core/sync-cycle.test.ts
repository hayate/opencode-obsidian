import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changedSince, LAST_INTEGRATED, runCycle, type CycleResult } from "../../core/sync/cycle.ts";
import { prepareProjects, REQUIRED_IGNORES } from "../../core/sync/state.ts";
import { acquireLock } from "../../core/lock.ts";
import { git, gitOk } from "../../core/git.ts";
import { GIT_CONFIG, commitFile, initRepo, tempDir, writeRel } from "./helpers.ts";

const TZ = "Asia/Tokyo";
const j = (...parts: string[]): string => parts.join("");
const TOKEN = j("gh", "p_", "Qm7Zr2Kx9Lp4Tw8Vb3Nc6Hd1Fg5Js0YtQm7Z");
// A remote a plugin-bootstrapped repository would have: the required ignores
// already committed, so a fresh clone never has to write and commit its own
// before the first cycle can run.
const SEEDED_GITIGNORE = `${REQUIRED_IGNORES.join("\n")}\n`;

interface Machine {
  name: string;
  projects: string;
  state: string;
}

async function setup(names: string[]): Promise<{ remote: string; m: Machine[] }> {
  const remote = join(await tempDir("sro-remote-"), "projects.git");
  await gitOk(["init", "-q", "--bare", "-b", "main", remote], { cwd: await tempDir() });
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", remote, seed], { cwd: await tempDir() });
  await commitFile(seed, ".gitignore", SEEDED_GITIGNORE, "seed gitignore");
  await commitFile(seed, "x/HANDOFF.md", "base\n", "seed");
  await commitFile(seed, "x/plans/old.md", "plan\n", "seed plan");
  await commitFile(seed, "x/t.md", "t0\n", "seed t");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
  const m: Machine[] = [];
  for (const name of names) {
    const root = await tempDir(`sro-${name}-`);
    await mkdir(join(root, ".obsidian"));
    const projects = join(root, "Projects");
    const state = await prepareProjects({ root, projectsDir: projects }, { remote }, TZ);
    assert.equal(state.kind, "ready");
    m.push({ name, projects, state: join(root, "state") });
  }
  return { remote, m };
}

async function machineFor(remote: string): Promise<Machine> {
  const root = await tempDir("sro-a-");
  await mkdir(join(root, ".obsidian"));
  const x: Machine = { name: "a", projects: join(root, "Projects"), state: join(root, "state") };
  assert.equal((await prepareProjects({ root, projectsDir: x.projects }, { remote }, TZ)).kind, "ready");
  return x;
}

// A remote whose tree only a case-sensitive machine could have committed. It
// always carries the required ignores, like any remote a plugin bootstrapped:
// otherwise the fresh clone below would have to write and commit its own
// before the first cycle, forcing the checkout+rebase path in the state clone
// (a known wedge on a case-colliding tree; see the two tests below).
async function remoteWithTree(files: Record<string, string>): Promise<string> {
  const remote = join(await tempDir("sro-remote-"), "projects.git");
  await gitOk(["init", "-q", "--bare", "-b", "main", remote], { cwd: await tempDir() });
  const withGitignore = { ".gitignore": SEEDED_GITIGNORE, ...files };
  const build = async (prefix: string): Promise<string> => {
    const entries = new Map<string, string>();
    for (const [path, content] of Object.entries(withGitignore)) {
      if (!path.startsWith(prefix)) continue;
      const [name = "", ...rest] = path.slice(prefix.length).split("/");
      if (rest.length) entries.set(name, `040000 tree ${await build(`${prefix}${name}/`)}`);
      else entries.set(name, `100644 blob ${await gitOk(["hash-object", "-w", "--stdin"], { cwd: remote, input: content })}`);
    }
    return gitOk(["mktree", "-z"], { cwd: remote, input: [...entries].map(([name, entry]) => `${entry}\t${name}\0`).join("") });
  };
  const commit = await gitOk(["commit-tree", await build(""), "-m", "from a case-sensitive machine"], { cwd: remote });
  await gitOk(["update-ref", "refs/heads/main", commit], { cwd: remote });
  return remote;
}

async function remoteNames(remote: string): Promise<string[]> {
  return (await gitOk(["ls-tree", "-r", "--name-only", "main"], { cwd: remote })).split("\n");
}

function cycle(remote: string, x: Machine, quietMs = 0): Promise<CycleResult> {
  return runCycle({ projectsDir: x.projects, remote, branch: "main", stateDir: x.state, machine: x.name, quietMs });
}

async function remoteFile(remote: string, path: string): Promise<string> {
  return gitOk(["show", `main:${path}`], { cwd: remote });
}

async function read(x: Machine, rel: string): Promise<string> {
  return readFile(join(x.projects, rel), "utf8");
}

async function absent(x: Machine, rel: string): Promise<boolean> {
  return stat(join(x.projects, rel)).then(() => false, () => true);
}

test("a note written on A reaches B", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/notes/n.md", "from a\n");
  const ra = await cycle(remote, a);
  assert.equal(ra.outcome, "synced");
  assert.ok(ra.committed && ra.pushed);
  const rb = await cycle(remote, b);
  assert.equal(rb.outcome, "synced");
  assert.ok(rb.liveUpdated);
  assert.equal(await read(b, "x/notes/n.md"), "from a\n");
});

test("Obsidian edits, new files, moves and deletions are all committed (D9)", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/HANDOFF.md", "edited in obsidian\n");
  await writeRel(a.projects, "x/specs/new.md", "spec\n");
  await mkdir(join(a.projects, "x", "archive"), { recursive: true });
  await rename(join(a.projects, "x/plans/old.md"), join(a.projects, "x/archive/old.md"));
  assert.equal((await cycle(remote, a)).pushed, true);
  await cycle(remote, b);
  assert.equal(await read(b, "x/HANDOFF.md"), "edited in obsidian\n");
  assert.equal(await read(b, "x/specs/new.md"), "spec\n");
  assert.equal(await read(b, "x/archive/old.md"), "plan\n");
  assert.ok(await absent(b, "x/plans/old.md"));
});

test("the autostash scenario: a conflicting edit pauses, leaves no markers, publishes nothing", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/HANDOFF.md", "A state\n");
  await cycle(remote, a);
  await writeRel(b.projects, "x/HANDOFF.md", "B uncommitted\n");
  const rb = await cycle(remote, b);
  assert.equal(rb.outcome, "paused");
  assert.deepEqual(rb.conflicts, ["x/HANDOFF.md"]);
  assert.equal(await read(b, "x/HANDOFF.md"), "B uncommitted\n");
  assert.equal(await remoteFile(remote, "x/HANDOFF.md"), "A state");
  assert.ok(await absent(b, ".git/rebase-merge"));
  assert.doesNotMatch(await read(b, "x/HANDOFF.md"), /<<<<<<<|>>>>>>>/);
});

test("a held-back file stays dirty and does not block unrelated remote changes", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.projects, "x/notes/creds.md", `token ${TOKEN}\n`);
  const first = await cycle(remote, b);
  assert.deepEqual(first.heldBack, [{ file: "x/notes/creds.md", rules: ["github-token"] }]);
  await writeRel(a.projects, "x/notes/y.md", "y\n");
  await cycle(remote, a);
  const second = await cycle(remote, b);
  assert.ok(second.liveUpdated);
  assert.equal(await read(b, "x/notes/y.md"), "y\n");
  assert.equal(await read(b, "x/notes/creds.md"), `token ${TOKEN}\n`);
  await assert.rejects(remoteFile(remote, "x/notes/creds.md"));
});

test("a secret is held back even when the user's git config changes diff prefixes", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  // diff.mnemonicPrefix is a widely recommended setting; it changes +++ headers
  // from "b/x/..." to "i/x/..." (the staged/index side), which the scan must
  // see through regardless, since it never controls the user's git config.
  await gitOk(["config", "diff.mnemonicPrefix", "true"], { cwd: a.projects });
  await writeRel(a.projects, "x/notes/creds.md", `token ${TOKEN}\n`);
  const r = await cycle(remote, a);
  assert.deepEqual(r.heldBack, [{ file: "x/notes/creds.md", rules: ["github-token"] }]);
  // cat-file, not show: it never falls back to interpreting the path as a pathspec.
  assert.notEqual((await git(["cat-file", "-e", "main:x/notes/creds.md"], { cwd: remote })).code, 0);
});

test("a secret is held back even when a textconv driver rewrites the diff", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  // A textconv driver configured through git attributes rewrites the diff a
  // naive `git diff` would show; the scan must disable it, since it never
  // controls the user's git attributes or config either.
  await writeRel(a.projects, ".git/info/attributes", "*.md diff=hide\n");
  await gitOk(["config", "diff.hide.textconv", "sh -c 'echo CLEAN'"], { cwd: a.projects });
  await writeRel(a.projects, "x/notes/creds.md", `token ${TOKEN}\n`);
  const r = await cycle(remote, a);
  assert.deepEqual(r.heldBack, [{ file: "x/notes/creds.md", rules: ["github-token"] }]);
  // cat-file, not show: it never falls back to interpreting the path as a pathspec.
  assert.notEqual((await git(["cat-file", "-e", "main:x/notes/creds.md"], { cwd: remote })).code, 0);
});

test("a note line starting with '++ ' is scanned, not read as a diff header", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  // With -U0 these lines appear as "+++ ..." in the scanned diff.
  await writeRel(a.projects, "x/notes/inline.md", `intro\n++ ${TOKEN}\nafter\n`);
  await writeRel(a.projects, "x/notes/after.md", `intro\n++ harmless\nkey ${TOKEN}\n`);
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.deepEqual(
    [...r.heldBack].sort((p, q) => p.file.localeCompare(q.file)),
    [
      { file: "x/notes/after.md", rules: ["github-token"] },
      { file: "x/notes/inline.md", rules: ["github-token"] },
    ],
  );
  for (const rel of ["x/notes/inline.md", "x/notes/after.md"]) {
    assert.notEqual((await git(["cat-file", "-e", `main:${rel}`], { cwd: remote })).code, 0, rel);
  }
});

test("a synced .gitattributes marking notes -diff cannot hide a secret from the scan", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  // -diff makes a plain `git diff` print "Binary files differ" for every note.
  await writeRel(b.projects, ".gitattributes", "*.md -diff\n");
  assert.ok((await cycle(remote, b)).pushed);
  assert.ok((await cycle(remote, a)).liveUpdated);
  await writeRel(a.projects, "x/notes/creds.md", `token ${TOKEN}\n`);
  const r = await cycle(remote, a);
  assert.deepEqual(r.heldBack, [{ file: "x/notes/creds.md", rules: ["github-token"] }]);
  assert.notEqual((await git(["cat-file", "-e", "main:x/notes/creds.md"], { cwd: remote })).code, 0);
});

test("a pre-commit hook cannot add unscanned content to the snapshot commit", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  // What an auto-formatting hook does (lint-staged style): change and re-add after the scan.
  const hook = join(a.projects, ".git", "hooks", "pre-commit");
  await writeFile(hook, `#!/bin/sh\nprintf 'token %s\\n' '${TOKEN}' > x/notes/hooked.md\ngit add x/notes/hooked.md\n`);
  await chmod(hook, 0o755);
  await writeRel(a.projects, "x/notes/n.md", "n\n");
  const r = await cycle(remote, a);
  assert.ok(r.pushed, r.reason ?? "");
  assert.equal(await remoteFile(remote, "x/notes/n.md"), "n");
  assert.notEqual((await git(["cat-file", "-e", "main:x/notes/hooked.md"], { cwd: remote })).code, 0);
});

test("a held-back file the remote also changed blocks the whole live update", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.projects, "x/t.md", `t0\ntoken ${TOKEN}\n`);
  await writeRel(a.projects, "x/t.md", "t-from-a\n");
  await writeRel(a.projects, "x/z.md", "z\n");
  await cycle(remote, a);
  const rb = await cycle(remote, b);
  assert.equal(rb.outcome, "synced");
  assert.equal(rb.liveUpdated, false);
  assert.deepEqual(rb.blockedBy, ["x/t.md"]);
  assert.ok(await absent(b, "x/z.md"), "reset --keep is all-or-nothing");
});

test("the quiet period defers a file written just now", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/notes/fresh.md", "fresh\n");
  const first = await cycle(remote, a, 2000);
  assert.deepEqual(first.deferred, ["x/notes/fresh.md"]);
  assert.equal(first.committed, null);
  const old = new Date(Date.now() - 10_000);
  await utimes(join(a.projects, "x/notes/fresh.md"), old, old);
  const second = await cycle(remote, a, 2000);
  assert.ok(second.committed && second.pushed);
});

test("a path changing during the snapshot suppresses the push; the next cycle pushes both versions", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  // A post-commit hook (git runs it even with --no-verify) appends to the file just
  // committed: exactly the window between the commit and the re-stat.
  const once = join(a.projects, ".git", "restat-once");
  await writeFile(once, "");
  const hook = join(a.projects, ".git", "hooks", "post-commit");
  await writeFile(hook, `#!/bin/sh\nif [ -f '${once}' ]; then rm -f '${once}'; echo more >> x/notes/n.md; fi\n`);
  await chmod(hook, 0o755);
  await writeRel(a.projects, "x/notes/n.md", "n\n");
  const first = await cycle(remote, a);
  assert.equal(first.outcome, "unsynced", first.reason ?? "");
  assert.ok(first.committed);
  assert.equal(first.pushed, false);
  assert.equal(await gitOk(["rev-parse", "HEAD"], { cwd: a.projects }), first.committed, "the commit stands locally");
  assert.notEqual((await git(["cat-file", "-e", "main:x/notes/n.md"], { cwd: remote })).code, 0, "nothing was pushed");

  const second = await cycle(remote, a);
  assert.ok(second.committed && second.pushed, second.reason ?? "");
  assert.equal(await remoteFile(remote, "x/notes/n.md"), "n\nmore");
  const log = await gitOk(["log", "--format=%H", "main"], { cwd: remote });
  assert.ok(log.split("\n").includes(first.committed), "the intermediate commit was pushed too");
});

test("a note whose mtime is far in the future (a clock corrected backwards) is snapshotted, never deferred forever", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/notes/future.md", "written under a wrong clock\n");
  const future = new Date(Date.now() + 3 * 365 * 24 * 3600 * 1000);
  await utimes(join(a.projects, "x/notes/future.md"), future, future);
  const r = await cycle(remote, a, 2000);
  assert.deepEqual(r.deferred, []);
  assert.ok(r.committed && r.pushed, r.reason ?? "");
  assert.equal(await remoteFile(remote, "x/notes/future.md"), "written under a wrong clock");
});

test("an mtime just ahead of the clock, as a fresh write's usually is, is still inside the quiet period", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/notes/fresh.md", "fresh\n");
  const ahead = new Date(Date.now() + 500);
  await utimes(join(a.projects, "x/notes/fresh.md"), ahead, ahead);
  const r = await cycle(remote, a, 2000);
  assert.deepEqual(r.deferred, ["x/notes/fresh.md"]);
  assert.equal(r.committed, null);
});

test("changedSince reports size, mtime, creation and deletion changes", async () => {
  const dir = await tempDir();
  await writeRel(dir, "a.md", "one");
  await writeRel(dir, "b.md", "two");
  const before = new Map([
    ["a.md", { size: 3, mtimeMs: (await stat(join(dir, "a.md"))).mtimeMs }],
    ["b.md", { size: 3, mtimeMs: (await stat(join(dir, "b.md"))).mtimeMs }],
    ["c.md", null],
  ]);
  assert.deepEqual(await changedSince(dir, before), []);
  await writeFile(join(dir, "a.md"), "one-more");
  await rm(join(dir, "b.md"));
  await writeFile(join(dir, "c.md"), "new");
  assert.deepEqual(await changedSince(dir, before), ["a.md", "b.md", "c.md"]);
});

test("a partly-upstream snapshot is never replayed after a refused live update", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.projects, "x/t.md", `t0\ntoken ${TOKEN}\n`); // held back and blocks B's live update
  await writeRel(a.projects, "x/t.md", "t-from-a\n");
  await writeRel(a.projects, "x/p.md", "same\n");
  await cycle(remote, a);
  await writeRel(b.projects, "x/p.md", "same\n"); // already upstream
  await writeRel(b.projects, "x/r.md", "r1\n");
  const first = await cycle(remote, b);
  assert.ok(first.pushed);
  assert.deepEqual(first.blockedBy, ["x/t.md"]);
  assert.equal(await gitOk(["rev-parse", LAST_INTEGRATED], { cwd: b.projects }), first.committed);

  await cycle(remote, a); // A receives r1, then evolves it
  await writeRel(a.projects, "x/r.md", "r2\n");
  await cycle(remote, a);
  const second = await cycle(remote, b);
  assert.notEqual(second.outcome, "paused", second.reason ?? "");
  assert.equal(await remoteFile(remote, "x/r.md"), "r2");
});

test("last-integrated is set as soon as the push lands, so a step-5 failure never replays an already-pushed snapshot", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];

  // A pushes first, so B's push below needs its own rebase: the commit that
  // lands upstream differs from B's live HEAD. That is exactly the case
  // spec 5.3's last-integrated ref exists for.
  await writeRel(a.projects, "x/other.md", "a0\n");
  await cycle(remote, a);

  await writeRel(b.projects, "x/shared.md", "b1\n");
  const blockedAt = await gitOk(["rev-parse", "HEAD"], { cwd: b.projects });
  // A ref cannot be both a file and a directory: this makes step 5's fetch into
  // refs/sro/integrated fail in B's live repo, simulating the process dying (or
  // the lock being lost) between the push landing and the reset --keep.
  await gitOk(["update-ref", "refs/sro/integrated/block", blockedAt], { cwd: b.projects });

  const first = await cycle(remote, b);
  assert.equal(first.outcome, "aborted", first.reason ?? "");
  assert.equal(await gitOk(["rev-parse", LAST_INTEGRATED], { cwd: b.projects }), first.committed);
  assert.equal(await remoteFile(remote, "x/shared.md"), "b1"); // already upstream before the failure

  await gitOk(["update-ref", "-d", "refs/sro/integrated/block"], { cwd: b.projects });

  await cycle(remote, a); // A receives B's already-pushed change
  await writeRel(a.projects, "x/shared.md", "a1\n"); // the same file, evolved further
  await cycle(remote, a);

  const second = await cycle(remote, b);
  assert.notEqual(second.outcome, "paused", second.reason ?? "");
  assert.equal(await remoteFile(remote, "x/shared.md"), "a1");
});

test("a push that loses a race (the remote moved after the fetch) is retried after integrating again", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/notes/first.md", "1\n");
  assert.ok((await cycle(remote, a)).pushed); // builds A's state clone
  const other = join(await tempDir(), "other");
  await gitOk(["clone", "-q", remote, other], { cwd: await tempDir() });
  await commitFile(other, "x/notes/other.md", "o\n", "another machine");
  // The state clone checks out before it rebases, after the fetch: this hook
  // pushes the other machine's commit there, once, so A's push is non-fast-forward.
  const once = join(a.state, "race-once");
  await writeFile(once, "");
  const hook = join(a.state, "sync", ".git", "hooks", "post-checkout");
  await writeFile(
    hook,
    `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\nif [ -f '${once}' ]; then rm -f '${once}'; git -C '${other}' push -q origin HEAD; fi\n`,
  );
  await chmod(hook, 0o755);
  await writeRel(a.projects, "x/notes/n.md", "n\n");
  const r = await cycle(remote, a);
  assert.equal(r.pushed, true, r.reason ?? "");
  await assert.rejects(stat(once), "the race must have happened");
  assert.equal(await remoteFile(remote, "x/notes/n.md"), "n");
  assert.equal(await remoteFile(remote, "x/notes/other.md"), "o");
});

test("a push the remote refuses (a server-side hook, e.g. push protection) is reported once, never retried as a race", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const attempts = join(remote, "attempts");
  const hook = join(remote, "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\necho attempt >> '${attempts}'\necho "GH013: push declined by repository rules" >&2\nexit 1\n`);
  await chmod(hook, 0o755);
  await writeRel(a.projects, "x/notes/n.md", "n\n");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "unsynced");
  assert.ok(r.committed);
  assert.match(r.reason ?? "", /GH013: push declined by repository rules/);
  assert.equal((await readFile(attempts, "utf8")).trim().split("\n").length, 1);
});

test("runCycle never throws: a Projects/ that does not exist is an aborted cycle", async () => {
  const base = await tempDir();
  const r = await runCycle({ projectsDir: join(base, "missing"), remote: join(base, "r.git"), branch: "main", stateDir: join(base, "state"), machine: "a" });
  assert.equal(r.outcome, "aborted");
  assert.ok(r.reason);
});

test(
  "a sync lock that cannot be released is reported, never thrown over the cycle's result",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const { remote, m } = await setup(["a"]);
    const [a] = m as [Machine];
    const lockDir = await gitOk(["rev-parse", "--path-format=absolute", "--git-path", "sro-sync.lock"], { cwd: a.projects });
    // Runs after the snapshot commit, while the cycle holds the lock: release()
    // then cannot unlink its owner entry.
    const hook = join(a.projects, ".git", "hooks", "post-commit");
    await writeFile(hook, `#!/bin/sh\nchmod 555 '${lockDir}'\n`);
    await chmod(hook, 0o755);
    await writeRel(a.projects, "x/notes/n.md", "n\n");
    let r: CycleResult;
    try {
      r = await cycle(remote, a);
    } finally {
      await chmod(lockDir, 0o755).catch(() => undefined);
    }
    assert.ok(r.pushed, r.reason ?? "");
    assert.match(r.reason ?? "", /releasing the sync lock failed/);
  },
);

test("an unreachable remote keeps the commit local and reports it; the next cycle pushes it", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await rename(remote, `${remote}.away`);
  await writeRel(a.projects, "x/notes/n.md", "n\n");
  const first = await cycle(remote, a);
  assert.equal(first.outcome, "unsynced");
  assert.ok(first.committed);
  // git's own fetch failure here is several lines, including a blank one: the
  // reason must be a single status line, capped like the push and rebase
  // failure reasons, never the raw multi-line stderr.
  const reason = first.reason ?? "";
  assert.match(reason, /^fetch failed: /, reason);
  assert.doesNotMatch(reason, /\n/, reason);
  assert.match(reason, /does not appear to be a git repository/, reason);
  assert.doesNotMatch(reason, /and the repository exists\./, "capped to the first 3 non-blank lines");
  await rename(`${remote}.away`, remote);
  const second = await cycle(remote, a);
  assert.ok(second.pushed);
  assert.equal(await remoteFile(remote, "x/notes/n.md"), "n");
});

test("missing identity aborts before committing anything", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const emptyConfig = join(await tempDir(), "gitconfig");
  await writeFile(emptyConfig, "");
  await writeRel(a.projects, "x/notes/n.md", "n\n");
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  try {
    const r = await cycle(remote, a);
    assert.equal(r.outcome, "aborted");
    assert.match(r.reason ?? "", /user\.name/);
    assert.equal(r.committed, null);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG;
  }
  assert.match(await gitOk(["status", "--porcelain"], { cwd: a.projects }), /x\/notes\//);
});

test("missing identity with nothing to commit still gives the identity instructions, not a raw git error", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const emptyConfig = join(await tempDir(), "gitconfig");
  await writeFile(emptyConfig, "");
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  try {
    const r = await cycle(remote, a);
    assert.equal(r.outcome, "aborted");
    assert.match(r.reason ?? "", /git config --global user\.name/);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG;
  }
});

test("a rebase that fails without a conflict is reported as unsynced with its error, not as a pause", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  assert.equal((await cycle(remote, b)).outcome, "synced"); // builds B's state clone
  const hook = join(b.state, "sync", ".git", "hooks", "pre-rebase");
  await writeFile(hook, "#!/bin/sh\necho 'pre-rebase refuses' >&2\nexit 1\n");
  await chmod(hook, 0o755);
  await writeRel(a.projects, "x/notes/a.md", "a\n");
  assert.ok((await cycle(remote, a)).pushed);
  await writeRel(b.projects, "x/notes/b.md", "b\n");
  const r = await cycle(remote, b);
  assert.equal(r.outcome, "unsynced", r.reason ?? "");
  assert.match(r.reason ?? "", /pre-rebase refuses/);
  assert.deepEqual(r.conflicts, []);
});

test("conflicting file names are reported as spelled, never C-quoted", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/日本.md", "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  await writeRel(b.projects, "x/日本.md", "from b\n");
  const r = await cycle(remote, b);
  assert.equal(r.outcome, "paused", r.reason ?? "");
  assert.deepEqual(r.conflicts, ["x/日本.md"]);
});

test("a conflicting file name holding a raw newline is quoted in the paused reason, so it can never break the status line", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  const name = `x/two${"\n"}lines.md`;
  await writeRel(a.projects, name, "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  await writeRel(b.projects, name, "from b\n");
  const r = await cycle(remote, b);
  assert.equal(r.outcome, "paused", r.reason ?? "");
  // r.conflicts is data, kept exactly as spelled (see the test above); the
  // reason is plugin status text, so the same name must appear quoted there.
  assert.deepEqual(r.conflicts, [name]);
  assert.match(r.reason ?? "", /"x\/two\\nlines\.md"/);
  assert.doesNotMatch(r.reason ?? "", /\n/, r.reason ?? "");
});

test("more than 10 conflicting files cap the paused reason to the first 10 names, then 'and N more'", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  const names = Array.from({ length: 12 }, (_, i) => `x/conflict-${String(i + 1).padStart(2, "0")}.md`);
  for (const name of names) await writeRel(a.projects, name, "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  for (const name of names) await writeRel(b.projects, name, "from b\n");
  const r = await cycle(remote, b);
  assert.equal(r.outcome, "paused", r.reason ?? "");
  assert.equal(r.conflicts.length, 12, "the raw conflict list is never capped, only the reason text");
  const reason = r.reason ?? "";
  for (const name of names.slice(0, 10)) assert.ok(reason.includes(name), `${name} missing from: ${reason}`);
  for (const name of names.slice(10)) assert.ok(!reason.includes(name), `${name} should be dropped from: ${reason}`);
  assert.match(reason, /and 2 more/, reason);
});

test("a busy lock returns busy without touching anything", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const lockDir = await gitOk(["rev-parse", "--path-format=absolute", "--git-path", "sro-sync.lock"], { cwd: a.projects });
  const held = await acquireLock(lockDir);
  assert.ok(held);
  try {
    const r = await runCycle({ projectsDir: a.projects, remote, branch: "main", stateDir: a.state, machine: "a", lockWaitMs: 100 });
    assert.equal(r.outcome, "busy");
  } finally {
    await held.release();
  }
});

test("a deleted state clone is rebuilt", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/notes/1.md", "1\n");
  await cycle(remote, a);
  await rm(a.state, { recursive: true, force: true });
  await writeRel(a.projects, "x/notes/2.md", "2\n");
  const r = await cycle(remote, a);
  assert.ok(r.pushed, r.reason ?? "");
  assert.equal(await remoteFile(remote, "x/notes/2.md"), "2");
});

test("a secret in a file whose name holds a newline is held back, not pushed", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const rel = "x/notes/line\nbreak.md";
  await writeRel(a.projects, rel, `credential ${TOKEN}\n`);
  const r = await cycle(remote, a);
  assert.deepEqual(r.heldBack.map((h) => h.file), [rel]);
  await assert.rejects(remoteFile(remote, rel));
});

test("a secret in a quoted name holding an emoji, or in a name ending in a space, is held back", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const rels = ["x/notes/😀\nsecret.md", "x/notes/trailing "];
  for (const rel of rels) await writeRel(a.projects, rel, `credential ${TOKEN}\n`);
  const r = await cycle(remote, a);
  assert.deepEqual(r.heldBack.map((h) => h.file).sort(), [...rels].sort());
  for (const rel of rels) await assert.rejects(remoteFile(remote, rel));
});

// Paths core passes to git are literal pathspecs: a glob-shaped name never matches its neighbours.
test("a held-back note named a*.md unstages only itself", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/a*.md", `credential ${TOKEN}\n`);
  await writeRel(a.projects, "x/ab.md", "clean\n");
  const r = await cycle(remote, a);
  assert.deepEqual(r.heldBack.map((h) => h.file), ["x/a*.md"]);
  assert.equal(await remoteFile(remote, "x/ab.md"), "clean");
  // cat-file, not show: `git show main:x/a*.md` falls back to a pathspec and exits 0.
  assert.notEqual((await git(["cat-file", "-e", "main:x/a*.md"], { cwd: remote })).code, 0);
});

test("a case-only rename of a note named [ab].md keeps a.md tracked", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/[ab].md", "brackets\n");
  await writeRel(a.projects, "x/a.md", "neighbour\n");
  assert.equal((await cycle(remote, a)).outcome, "synced");
  await rename(join(a.projects, "x/[ab].md"), join(a.projects, "x/hop"));
  await rename(join(a.projects, "x/hop"), join(a.projects, "x/[AB].md"));
  assert.equal((await cycle(remote, a)).outcome, "synced");
  const names = await remoteNames(remote);
  assert.ok(names.includes("x/[AB].md") && names.includes("x/a.md") && !names.includes("x/[ab].md"), names.join(", "));
});

test("a gitlink an old client committed is removed even while its repository was just written", async () => {
  const remote = join(await tempDir("sro-remote-"), "projects.git");
  await gitOk(["init", "-q", "--bare", "-b", "main", remote], { cwd: await tempDir() });
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", remote, seed], { cwd: await tempDir() });
  await commitFile(seed, ".gitignore", SEEDED_GITIGNORE, "seed gitignore");
  await initRepo(join(seed, "x", "nested"));
  await commitFile(join(seed, "x", "nested"), "inside.md", "seeded\n", "nested seed");
  await gitOk(["add", "x/nested"], { cwd: seed });
  await gitOk(["commit", "-q", "-m", "old client committed a gitlink"], { cwd: seed });
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
  const a = await machineFor(remote);
  await initRepo(join(a.projects, "x", "nested"));
  await commitFile(join(a.projects, "x", "nested"), "inside.md", "live\n", "fresh nested repo");
  const r = await cycle(remote, a, 60_000); // everything is inside the quiet period
  assert.deepEqual(r.embedded, ["x/nested"]);
  assert.equal(await gitOk(["ls-tree", "main", "x/nested"], { cwd: remote }), "");
});

test("an embedded repository named t* untracks only itself", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const nested = join(a.projects, "x", "t*");
  await initRepo(nested);
  await commitFile(nested, "inside.md", "i\n", "nested");
  const r = await cycle(remote, a);
  assert.deepEqual(r.embedded, ["x/t*"]);
  assert.equal(await remoteFile(remote, "x/t.md"), "t0");
});

test("spaces, non-ASCII names, binary bytes and symlinks sync intact", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/notes/日本 語.md", "こんにちは\n");
  await writeFile(join(a.projects, "x", "image.bin"), Buffer.from([0, 1, 2, 255]));
  await symlink("notes/日本 語.md", join(a.projects, "x", "note-link"));
  assert.equal((await cycle(remote, a)).outcome, "synced");
  assert.equal(await remoteFile(remote, "x/notes/日本 語.md"), "こんにちは");
  assert.equal(await gitOk(["cat-file", "-s", "main:x/image.bin"], { cwd: remote }), "4");
  assert.match(await gitOk(["ls-tree", "main", "x/note-link"], { cwd: remote }), /^120000 /);
});

test("a file name ending in a space survives the -z listing", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/zz-trailing ", "t\n");
  assert.ok((await cycle(remote, a)).pushed);
  assert.equal(await remoteFile(remote, "x/zz-trailing "), "t");
});

test("a last-integrated ref that is not an ancestor falls back to the merge base", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const tree = await gitOk(["rev-parse", "HEAD^{tree}"], { cwd: a.projects });
  const bogus = await gitOk(["commit-tree", tree, "-m", "unrelated"], { cwd: a.projects });
  await gitOk(["update-ref", LAST_INTEGRATED, bogus], { cwd: a.projects });
  await writeRel(a.projects, "x/after.md", "kept\n");
  assert.equal((await cycle(remote, a)).outcome, "synced");
  assert.equal(await remoteFile(remote, "x/after.md"), "kept");
});

test("a case-only directory rename reaches the remote (case-insensitive filesystems included)", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await rename(join(a.projects, "x/plans"), join(a.projects, "x/hop"));
  await rename(join(a.projects, "x/hop"), join(a.projects, "x/Plans"));
  assert.equal((await cycle(remote, a)).outcome, "synced");
  const names = await remoteNames(remote);
  assert.ok(names.includes("x/Plans/old.md") && !names.includes("x/plans/old.md"), names.join(", "));
});

// On a case-insensitive filesystem these trees check out as one file or one directory.
test("tracked files differing only by case are never inferred as a rename, and are reported", async () => {
  const remote = await remoteWithTree({ "x/Note.md": "upper\n", "x/note.md": "lower\n" });
  const a = await machineFor(remote);
  const insensitive = (await readdir(join(a.projects, "x"))).length === 1;
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.deepEqual(r.caseCollisions, insensitive ? ["x/Note.md", "x/note.md"] : []);
  assert.deepEqual(await remoteNames(remote), [".gitignore", "x/Note.md", "x/note.md"]);
  assert.equal(await remoteFile(remote, "x/Note.md"), "upper");
  assert.equal(await remoteFile(remote, "x/note.md"), "lower");
});

test("tracked directories differing only by case are never merged into one spelling", async () => {
  const remote = await remoteWithTree({ "x/Dir/a.md": "a\n", "x/dir/b.md": "b\n" });
  const a = await machineFor(remote);
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.deepEqual(await remoteNames(remote), [".gitignore", "x/Dir/a.md", "x/dir/b.md"]);
});

test("a case-only rename reaches the remote (case-insensitive filesystems included)", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await rename(join(a.projects, "x/HANDOFF.md"), join(a.projects, "x/hop"));
  await rename(join(a.projects, "x/hop"), join(a.projects, "x/handoff.md"));
  await cycle(remote, a);
  const names = await remoteNames(remote);
  assert.ok(names.includes("x/handoff.md") && !names.includes("x/HANDOFF.md"), names.join(", "));
});

test("a git repository cloned inside Projects/ is reported and never committed as a gitlink", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const nested = join(a.projects, "x", "cloned");
  await initRepo(nested);
  await commitFile(nested, "inside.md", "i\n", "nested");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced");
  assert.deepEqual(r.embedded, ["x/cloned"]);
  assert.equal(await gitOk(["ls-tree", "main", "x/cloned"], { cwd: remote }), "");
});

test("a state clone left mid-rebase by a crash (either backend) is rebuilt", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/first.md", "1\n");
  await cycle(remote, a);
  for (const marker of ["rebase-apply", "rebase-merge"]) {
    await mkdir(join(a.state, "sync", ".git", marker), { recursive: true });
    await writeRel(a.projects, `x/${marker}.md`, "n\n");
    const r = await cycle(remote, a);
    assert.equal(r.outcome, "synced", r.reason ?? "");
    assert.equal(await remoteFile(remote, `x/${marker}.md`), "n");
  }
});

test("a lock file a killed command left in the state clone is rebuilt away", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/first.md", "1\n");
  await cycle(remote, a);
  for (const leftover of ["index.lock", "HEAD.lock", "config.lock", "refs/remotes/live/main.lock"]) {
    await writeRel(join(a.state, "sync", ".git"), leftover, "");
    const note = `x/${leftover.replaceAll("/", "-")}.md`;
    await writeRel(a.projects, note, "n\n");
    const r = await cycle(remote, a);
    assert.equal(r.outcome, "synced", `${leftover}: ${r.reason ?? ""}`);
    assert.equal(await remoteFile(remote, note), "n");
  }
});

test("a lock nobody removes stops the cycle with one plain sentence, and is never deleted", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/new.md", "new\n");
  const lock = join(a.projects, ".git", "index.lock");
  await writeFile(lock, "");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "aborted");
  assert.match(r.reason ?? "", /^git left a lock file behind: '.*\/\.git\/index\.lock' .*delete that file\.$/);
  assert.ok(await stat(lock));
});

test("another process's index.lock during a cycle is waited out", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/new.md", "new\n");
  const lock = join(a.projects, ".git", "index.lock");
  await writeFile(lock, "");
  const removal = new Promise((r) => setTimeout(r, 300)).then(() => rm(lock, { force: true }));
  const r = await cycle(remote, a);
  await removal;
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.equal(await remoteFile(remote, "x/new.md"), "new");
});

test("a blocked live update counts consecutive cycles, for the escalation at 3", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.projects, "x/t.md", `t0\ntoken ${TOKEN}\n`);
  await writeRel(a.projects, "x/t.md", "t-from-a\n");
  await cycle(remote, a);
  const counts: number[] = [];
  for (let i = 0; i < 3; i++) counts.push((await cycle(remote, b)).blockedCycles);
  assert.deepEqual(counts, [1, 2, 3]);
  assert.deepEqual((await readdir(b.state)).filter((n) => n.endsWith(".sro-tmp")), []);
});

// Spec 5.4 step 5 counts blocked cycles in a row: any other cycle that runs breaks the streak.
const streak = (x: Machine): Promise<string> => readFile(join(x.state, "blocked-cycles"), "utf8");

test("an aborted cycle breaks the blocked-cycle streak", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.state, "blocked-cycles", "2");
  await writeRel(a.projects, "x/new.md", "new\n");
  await gitOk(["config", "user.name", ""], { cwd: a.projects });
  await gitOk(["config", "user.email", ""], { cwd: a.projects });
  assert.equal((await cycle(remote, a)).outcome, "aborted");
  assert.equal(await streak(a), "0");
});

test("a paused cycle breaks the blocked-cycle streak", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.state, "blocked-cycles", "2");
  await writeRel(a.projects, "x/t.md", "from a\n");
  assert.equal((await cycle(remote, a)).outcome, "synced");
  await writeRel(b.projects, "x/t.md", "from b\n");
  assert.equal((await cycle(remote, b)).outcome, "paused");
  assert.equal(await streak(b), "0");
});

test("a busy cycle, which never ran, leaves the blocked-cycle streak alone", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.state, "blocked-cycles", "2");
  const lockDir = await gitOk(["rev-parse", "--path-format=absolute", "--git-path", "sro-sync.lock"], { cwd: a.projects });
  const held = await acquireLock(lockDir);
  assert.ok(held);
  try {
    const r = await runCycle({ projectsDir: a.projects, remote, branch: "main", stateDir: a.state, machine: "a", lockWaitMs: 100 });
    assert.equal(r.outcome, "busy");
  } finally {
    await held.release();
  }
  assert.equal(await streak(a), "2");
});
