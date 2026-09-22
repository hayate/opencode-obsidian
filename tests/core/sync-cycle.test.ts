import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { changedSince, REMOTE_SEEN, runCycle, type CycleResult } from "../../core/sync/cycle.ts";
import { statusFromCycle } from "../../core/session.ts";
import { prepareProjects, REQUIRED_IGNORES } from "../../core/sync/state.ts";
import { acquireLock } from "../../core/lock.ts";
import { git, gitOk } from "../../core/git.ts";
import { GIT_CONFIG, commitFile, initRepo, tempDir, withRewrittenMergeTree, writeRel } from "./helpers.ts";

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
// always carries the required ignores, like any remote a plugin bootstrapped.
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
  return runCycle({ timezone: TZ, projectsDir: x.projects, remote, branch: "main", stateDir: x.state, machine: x.name, quietMs });
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

test("the autostash scenario: a conflicting edit keeps both versions, never pauses, leaves no markers", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/HANDOFF.md", "A state\n");
  await cycle(remote, a);
  await writeRel(b.projects, "x/HANDOFF.md", "B uncommitted\n");
  const rb = await cycle(remote, b);
  assert.equal(rb.outcome, "synced", rb.reason ?? "");
  assert.equal(rb.conflicts.length, 1);
  assert.equal(rb.conflicts[0]?.kind, "both-changed");
  const copy = rb.conflicts[0]?.copy ?? "";
  assert.match(copy, /^x\/HANDOFF\.conflict-\d{4}-\d\d-\d\d-\d{4}-[0-9a-f]{6}\.md$/);
  assert.equal(await read(b, "x/HANDOFF.md"), "B uncommitted\n", "this machine's version stays at the path");
  assert.equal(await read(b, copy), "A state\n");
  assert.equal(await remoteFile(remote, "x/HANDOFF.md"), "B uncommitted");
  assert.equal(await remoteFile(remote, copy), "A state");
  await cycle(remote, a);
  assert.equal(await read(a, "x/HANDOFF.md"), "B uncommitted\n", "the machines converge");
  assert.equal(await read(a, copy), "A state\n");
  for (const x of [a, b]) assert.doesNotMatch(await read(x, "x/HANDOFF.md"), /<<<<<<<|>>>>>>>/);
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
  assert.equal(
    await gitOk(["rev-parse", REMOTE_SEEN], { cwd: b.projects }),
    await gitOk(["rev-parse", "main"], { cwd: remote }),
    "remote-seen follows the remote head even when the live update is refused",
  );

  await cycle(remote, a); // A receives r1, then evolves it
  await writeRel(a.projects, "x/r.md", "r2\n");
  await cycle(remote, a);
  const second = await cycle(remote, b);
  assert.equal(second.outcome, "synced", second.reason ?? "");
  assert.deepEqual(second.conflicts, []);
  assert.equal(await remoteFile(remote, "x/r.md"), "r2");
});

// A ref cannot be both a file and a directory: this makes step 5's fetch into
// refs/sro/integrated fail in the live repo, as if the process died (or the reply
// to an accepted push was lost) between the push landing and the live update.
async function failStepFive(x: Machine): Promise<() => Promise<void>> {
  await gitOk(["update-ref", "refs/sro/integrated/block", "HEAD"], { cwd: x.projects });
  return async () => {
    await gitOk(["update-ref", "-d", "refs/sro/integrated/block"], { cwd: x.projects });
  };
}

test("a state clone rebuilt after a refused live update still checks the remote against what this machine saw", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.projects, "x/t.md", `t0\ntoken ${TOKEN}\n`); // held back: blocks B's live update
  await writeRel(a.projects, "x/t.md", "t-from-a\n");
  await cycle(remote, a);
  await writeRel(b.projects, "x/r.md", "r\n");
  assert.deepEqual((await cycle(remote, b)).blockedBy, ["x/t.md"]);
  // remote-seen now names a commit only the lost clone and the remote hold.
  await rm(join(b.state, "sync.git"), { recursive: true, force: true });
  await writeRel(b.projects, "x/r2.md", "r2\n");
  const r = await cycle(remote, b);
  assert.notEqual(r.outcome, "unsynced", r.reason ?? "");
  assert.ok(r.pushed, r.reason ?? "");
  assert.equal(await remoteFile(remote, "x/r2.md"), "r2");
});

test("a snapshot pushed before step 5 failed is never merged again: the remote's later edit stands", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  // A pushes first, so B's push is a merge commit, not B's own snapshot.
  await writeRel(a.projects, "x/other.md", "a0\n");
  await cycle(remote, a);
  await writeRel(b.projects, "x/shared.md", "b1\n");
  const unblock = await failStepFive(b);
  const first = await cycle(remote, b);
  assert.equal(first.outcome, "aborted", first.reason ?? "");
  assert.equal(await remoteFile(remote, "x/shared.md"), "b1"); // already upstream before the failure
  await unblock();
  await cycle(remote, a); // A receives B's already-pushed change
  await writeRel(a.projects, "x/shared.md", "a1\n"); // the same file, evolved further
  await cycle(remote, a);
  const second = await cycle(remote, b);
  assert.equal(second.outcome, "synced", second.reason ?? "");
  assert.deepEqual(second.conflicts, []);
  assert.equal(await remoteFile(remote, "x/shared.md"), "a1");
});

test("a note deleted after a push whose acknowledgement was lost stays deleted", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/other.md", "a0\n");
  await cycle(remote, a);
  await writeRel(b.projects, "x/note.md", "added on b\n");
  const unblock = await failStepFive(b);
  assert.equal((await cycle(remote, b)).outcome, "aborted");
  assert.equal(await remoteFile(remote, "x/note.md"), "added on b"); // the push landed
  await unblock();
  await rm(join(b.projects, "x/note.md"));
  const r = await cycle(remote, b);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.ok(!(await remoteNames(remote)).includes("x/note.md"), "a single-parent merge would bring it back");
  assert.ok(await absent(b, "x/note.md"));
});

test("a push that loses a race (the remote moved after the fetch) is retried after integrating again", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/notes/first.md", "1\n");
  assert.ok((await cycle(remote, a)).pushed); // builds A's state clone
  const other = join(await tempDir(), "other");
  await gitOk(["clone", "-q", remote, other], { cwd: await tempDir() });
  await commitFile(other, "x/notes/other.md", "o\n", "another machine");
  // Right after the state clone's fetch updates the remote-tracking ref, this hook
  // pushes the other machine's commit, once, so A's push is non-fast-forward.
  const once = join(a.state, "race-once");
  await writeFile(once, "");
  // A push updates the clone's remote-tracking ref itself; set it back so this
  // cycle's fetch moves it (and fires the hook) before A pushes.
  await gitOk(["update-ref", "refs/remotes/origin/main", "refs/remotes/origin/main~1"], { cwd: join(a.state, "sync.git") });
  // Where git looks for the clone's hooks (core.hooksPath, which nothing else creates).
  const hooks = await gitOk(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: join(a.state, "sync.git") });
  await mkdir(hooks, { recursive: true });
  const hook = join(hooks, "reference-transaction");
  await writeFile(
    hook,
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q " refs/remotes/origin/" || exit 0\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\nif [ -f '${once}' ]; then rm -f '${once}'; git -C '${other}' push -q origin HEAD; fi\n`,
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
  const r = await runCycle({ timezone: TZ, projectsDir: join(base, "missing"), remote: join(base, "r.git"), branch: "main", stateDir: join(base, "state"), machine: "a" });
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

test("conflicting file names are reported as spelled, never C-quoted", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/日本.md", "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  await writeRel(b.projects, "x/日本.md", "from b\n");
  const r = await cycle(remote, b);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.equal(r.conflicts[0]?.path, "x/日本.md");
  assert.match(r.conflicts[0]?.copy ?? "", /^x\/日本\.conflict-/);
  assert.equal(await read(b, r.conflicts[0]?.copy ?? ""), "from a\n");
});

test("a conflicting file name holding a raw newline is kept exactly as spelled (the status line quotes it)", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  const name = `x/two${"\n"}lines.md`;
  await writeRel(a.projects, name, "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  await writeRel(b.projects, name, "from b\n");
  const r = await cycle(remote, b);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.equal(r.conflicts[0]?.path, name);
  assert.equal(await read(b, name), "from b\n");
  assert.equal(await read(b, r.conflicts[0]?.copy ?? ""), "from a\n");
});

test("twelve conflicting notes give twelve copies; the raw conflict list is never capped", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  const names = Array.from({ length: 12 }, (_, i) => `x/conflict-${String(i + 1).padStart(2, "0")}.md`);
  for (const name of names) await writeRel(a.projects, name, "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  for (const name of names) await writeRel(b.projects, name, "from b\n");
  const r = await cycle(remote, b);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.equal(r.conflicts.length, 12);
  assert.equal((await remoteNames(remote)).filter((n) => n.includes(".conflict-")).length, 12);
});

test("a busy lock returns busy without touching anything", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const lockDir = await gitOk(["rev-parse", "--path-format=absolute", "--git-path", "sro-sync.lock"], { cwd: a.projects });
  const held = await acquireLock(lockDir);
  assert.ok(held);
  try {
    const r = await runCycle({ timezone: TZ, projectsDir: a.projects, remote, branch: "main", stateDir: a.state, machine: "a", lockWaitMs: 100 });
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

// A name git would read as pathspec magic (":!keep" excludes "keep"): without
// :(literal) git rm refuses on every git version (2.47.3 and 2.50.1 verified), where
// a glob-shaped name like t* only misbehaves on some.
test("an embedded repository named like pathspec magic (:!keep) is untracked and the cycle goes on", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const nested = join(a.projects, ":!keep");
  await initRepo(nested);
  await commitFile(nested, "inside.md", "i\n", "nested");
  await writeRel(a.projects, "x/n.md", "n\n");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.deepEqual(r.embedded, [":!keep"]);
  assert.equal(await remoteFile(remote, "x/n.md"), "n");
  assert.equal(await remoteFile(remote, "x/t.md"), "t0");
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

// How many times the stopped cycle's status line says "sync stopped".
function stoppedMentions(r: CycleResult): number {
  return (statusFromCycle(r)[0]?.text ?? "").split("sync stopped").length - 1;
}

// The remote's history rewritten by hand (a force-push back to an earlier commit,
// dropping everything after it).
async function forcePushBack(remote: string, to: string): Promise<void> {
  await gitOk(["update-ref", "refs/heads/main", to], { cwd: remote });
}

test("a rewritten remote stops the cycle: nothing is merged, deleted here, or pushed back", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const before = await gitOk(["rev-parse", "main"], { cwd: remote });
  await writeRel(a.projects, "x/dropped.md", "sent, then dropped by the rewrite\n");
  assert.ok((await cycle(remote, a)).pushed);
  await forcePushBack(remote, before);
  await writeRel(a.projects, "x/later.md", "written after the rewrite\n");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "stopped", r.reason ?? "");
  assert.match(r.reason ?? "", /rewritten.*adopt the rewritten remote/);
  assert.equal(stoppedMentions(r), 1, statusFromCycle(r)[0]?.text);
  assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), before, "nothing pushed back");
  assert.equal(await read(a, "x/dropped.md"), "sent, then dropped by the rewrite\n", "nothing deleted here");
});

test("a remote-seen that cannot be read stops the cycle instead of skipping the rewrite check", async () => {
  for (const label of ["names a missing object", "names a tree, not a commit", "is a ref file git cannot parse"]) {
    const { remote, m } = await setup(["a"]);
    const [a] = m as [Machine];
    const before = await gitOk(["rev-parse", "main"], { cwd: remote });
    await writeRel(a.projects, "x/dropped.md", "sent, then dropped by the rewrite\n");
    assert.ok((await cycle(remote, a)).pushed);
    const gitDir = await gitOk(["rev-parse", "--absolute-git-dir"], { cwd: a.projects });
    const tree = await gitOk(["rev-parse", "HEAD^{tree}"], { cwd: a.projects });
    const value = { "names a missing object": `${"1".repeat(40)}\n`, "names a tree, not a commit": `${tree}\n`, "is a ref file git cannot parse": "not a ref\n" }[label];
    await writeFile(join(gitDir, "refs/sro/remote-seen"), value ?? "");
    await forcePushBack(remote, before);
    const r = await cycle(remote, a);
    assert.equal(r.outcome, "stopped", `${label}: ${r.reason}`);
    assert.match(r.reason ?? "", /remote-seen/);
    assert.equal(stoppedMentions(r), 1, statusFromCycle(r)[0]?.text);
    assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), before, `${label}: nothing pushed back`);
  }
});

test("adopting a rewritten remote carries over only the changes this machine had not sent", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const before = await gitOk(["rev-parse", "main"], { cwd: remote });
  await writeRel(a.projects, "x/dropped.md", "sent, then dropped by the rewrite\n");
  assert.ok((await cycle(remote, a)).pushed);
  const droppedCommit = await gitOk(["rev-parse", "main"], { cwd: remote });
  await forcePushBack(remote, before);
  await writeRel(a.projects, "x/later.md", "written after the rewrite\n");
  assert.equal((await cycle(remote, a)).outcome, "stopped");
  const r = await runCycle({ timezone: TZ, projectsDir: a.projects, remote, branch: "main", stateDir: a.state, machine: "a", quietMs: 0, adoptRewrite: true });
  assert.equal(r.outcome, "synced", r.reason ?? "");
  const names = await remoteNames(remote);
  assert.ok(names.includes("x/later.md"), "the unsent change is carried over");
  assert.ok(!names.includes("x/dropped.md"), "what was sent before the rewrite stays dropped");
  assert.notEqual(
    (await git(["merge-base", "--is-ancestor", droppedCommit, "main"], { cwd: remote })).code,
    0,
    "none of the dropped history is published again",
  );
  assert.ok(await absent(a, "x/dropped.md"), "the live repo follows the adopted remote");
  assert.equal((await cycle(remote, a)).outcome, "synced", "and later cycles run normally");
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

test("a case-colliding tree no longer wedges a machine that has its own changes to send", async () => {
  const remote = await remoteWithTree({ "x/Note.md": "upper\n", "x/note.md": "lower\n" });
  const a = await machineFor(remote);
  assert.equal((await cycle(remote, a)).outcome, "synced");
  const other = join(await tempDir(), "other");
  await gitOk(["clone", "-q", remote, other], { cwd: await tempDir() });
  await commitFile(other, "x/from-other.md", "o\n", "another machine");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: other });
  await writeRel(a.projects, "x/mine.md", "m\n");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.ok(r.pushed);
  const names = await remoteNames(remote);
  for (const n of ["x/Note.md", "x/note.md", "x/from-other.md", "x/mine.md"]) assert.ok(names.includes(n), `${n}: ${names.join(", ")}`);
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

test("a lock file a killed command left in the state clone is rebuilt away", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/first.md", "1\n");
  await cycle(remote, a);
  for (const leftover of ["HEAD.lock", "config.lock", "refs/remotes/live/main.lock"]) {
    await writeRel(join(a.state, "sync.git"), leftover, "");
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

test("a stopped cycle breaks the blocked-cycle streak", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const before = await gitOk(["rev-parse", "main"], { cwd: remote });
  await writeRel(a.projects, "x/t.md", "t\n");
  assert.ok((await cycle(remote, a)).pushed);
  await forcePushBack(remote, before);
  await writeRel(a.state, "blocked-cycles", "2");
  assert.equal((await cycle(remote, a)).outcome, "stopped");
  assert.equal(await streak(a), "0");
});

test("what the remote already holds never blocks the outbound scan, even when copied", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  // An older client pushed a token-shaped note the scan would hold back here.
  const other = join(await tempDir(), "other");
  await gitOk(["clone", "-q", remote, other], { cwd: await tempDir() });
  await commitFile(other, "x/t.md", `t0\ntoken ${TOKEN}\n`, "an older client");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: other });
  await writeRel(a.projects, "x/t.md", "edited here\n");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.equal(r.conflicts[0]?.kind, "both-changed");
  assert.equal(await remoteFile(remote, "x/t.md"), "edited here");
});

test("a secret that reached a local commit without the snapshot scan stops the cycle, never pushed", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  // Committed by hand in the live repo, so step 2's scan never saw it.
  await commitFile(a.projects, "x/by-hand.md", `token ${TOKEN}\n`, "by hand");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "stopped", r.reason ?? "");
  assert.match(r.reason ?? "", /secret scan flags what this sync would send in "x\/by-hand\.md"/);
  assert.ok(!(await remoteNames(remote)).includes("x/by-hand.md"));
});

test("a live update killed on its timeout is not the user's block, and the next cycle finishes it", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.state, "blocked-cycles", "2");
  await writeRel(a.projects, "x/t.md", "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  await gitOk(["config", "filter.slow.smudge", "sleep 10; cat"], { cwd: b.projects });
  await writeFile(join(b.projects, ".git", "info", "attributes"), "*.md filter=slow\n");
  const slow = { timezone: TZ, projectsDir: b.projects, remote, branch: "main", stateDir: b.state, machine: "b", quietMs: 0, liveUpdateTimeoutMs: 500 };
  const first = await runCycle(slow);
  assert.equal(first.outcome, "unsynced", first.reason ?? "");
  assert.match(first.reason ?? "", /updating the vault timed out/);
  assert.deepEqual(first.blockedBy, []);
  assert.equal(await streak(b), "0", "a timeout never counts toward the escalation");
  await gitOk(["config", "--unset", "filter.slow.smudge"], { cwd: b.projects });
  const second = await runCycle({ ...slow, liveUpdateTimeoutMs: undefined });
  assert.equal(second.outcome, "synced", second.reason ?? "");
  assert.ok(second.liveUpdated);
  assert.equal(await read(b, "x/t.md"), "from a\n");
  assert.equal(await remoteFile(remote, "x/t.md"), "from a", "no half-written file was sent");
});

test("a live update that fails partway (a smudge filter fails) is finished by the next cycle, never sent as local edits", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/s.md", "s from a\n");
  await writeRel(a.projects, "x/t.md", "t from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  // git writes x/s.md, unlinks x/t.md, then its smudge fails (verified, git 2.50.1).
  for (const [key, value] of [["filter.bad.clean", "cat"], ["filter.bad.smudge", "false"], ["filter.bad.required", "true"]]) {
    await gitOk(["config", key ?? "", value ?? ""], { cwd: b.projects });
  }
  await writeFile(join(b.projects, ".git", "info", "attributes"), "x/t.md filter=bad\n");
  const first = await cycle(remote, b);
  assert.equal(first.outcome, "unsynced", first.reason ?? "");
  assert.match(first.reason ?? "", /updating the vault failed/);
  assert.deepEqual(first.blockedBy, []);
  await gitOk(["config", "filter.bad.smudge", "cat"], { cwd: b.projects });
  const second = await cycle(remote, b);
  assert.equal(second.outcome, "synced", second.reason ?? "");
  assert.equal(await read(b, "x/t.md"), "t from a\n");
  assert.equal(await read(b, "x/s.md"), "s from a\n");
  assert.equal(await remoteFile(remote, "x/t.md"), "t from a", "the note the failed update had unlinked is not deleted on the remote");
  assert.deepEqual((await remoteNames(remote)).filter((n) => n.includes(".conflict-")), [], "nor moved to a conflict copy");
});

test("an unfinished live update whose history then moved by hand stops sync with the record kept; undoing what it left and deleting the record lets sync carry on with nothing lost", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/s.md", "s from a\n");
  await writeRel(a.projects, "x/t.md", "t from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  const pushedByA = await gitOk(["rev-parse", "main"], { cwd: remote });
  // git writes x/s.md, unlinks x/t.md, then its smudge fails; then the user commits by hand.
  for (const [key, value] of [["filter.bad.clean", "cat"], ["filter.bad.smudge", "false"], ["filter.bad.required", "true"]]) {
    await gitOk(["config", key ?? "", value ?? ""], { cwd: b.projects });
  }
  await writeFile(join(b.projects, ".git", "info", "attributes"), "x/t.md filter=bad\n");
  assert.match((await cycle(remote, b)).reason ?? "", /updating the vault failed/);
  await gitOk(["config", "filter.bad.smudge", "cat"], { cwd: b.projects });
  await gitOk(["commit", "-q", "--allow-empty", "-m", "by hand"], { cwd: b.projects });
  const record = join(b.state, "interrupted-update.json");
  const stopped = await cycle(remote, b);
  assert.equal(stopped.outcome, "aborted", stopped.reason ?? "");
  assert.ok((stopped.reason ?? "").includes(record), stopped.reason ?? "");
  assert.match(stopped.reason ?? "", /`git status` in Projects\/.*delete that file/s);
  assert.equal(stopped.committed, null, "the half-done update is never snapshotted as the user's own changes");
  assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), pushedByA, "nothing pushed");
  assert.equal(await gitOk(["status", "--porcelain"], { cwd: b.projects }), "D x/t.md\n?? x/s.md", "what git status shows the user");
  // The way out the reason gives: undo what the update left half done, then delete the record.
  await gitOk(["checkout", "--", "x/t.md"], { cwd: b.projects });
  await rm(join(b.projects, "x/s.md"));
  await rm(record);
  const after = await cycle(remote, b);
  assert.equal(after.outcome, "synced", after.reason ?? "");
  assert.equal(await read(b, "x/t.md"), "t from a\n");
  assert.equal(await read(b, "x/s.md"), "s from a\n");
  assert.equal(await remoteFile(remote, "x/t.md"), "t from a", "no deletion was sent");
  assert.deepEqual((await remoteNames(remote)).filter((n) => n.includes(".conflict-")), [], "and no conflict copy made");
});

test("a held-back new note the remote also adds blocks the update by name, and nothing is recorded as interrupted", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.projects, "x/new.md", `token ${TOKEN}\n`); // held back: stays untracked
  await writeRel(a.projects, "x/new.md", "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  const first = await cycle(remote, b);
  assert.deepEqual(first.blockedBy, ["x/new.md"], first.reason ?? "");
  const second = await cycle(remote, b);
  assert.deepEqual(second.blockedBy, ["x/new.md"]);
  assert.deepEqual(second.notices, [], "a refusal changed nothing, so there is nothing to finish");
});

test("a live update that finished leaves nothing to finish, even after a commit made by hand", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/t.md", "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  assert.ok((await cycle(remote, b)).liveUpdated);
  await gitOk(["commit", "-q", "--allow-empty", "-m", "by hand"], { cwd: b.projects });
  assert.deepEqual((await cycle(remote, b)).notices, []);
});

test("a repair that times out stops the cycle before its snapshot; the next cycle finishes it", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/t.md", "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  const pushedByA = await gitOk(["rev-parse", "main"], { cwd: remote });
  await gitOk(["config", "filter.slow.smudge", "sleep 10; cat"], { cwd: b.projects });
  await writeFile(join(b.projects, ".git", "info", "attributes"), "*.md filter=slow\n");
  const slow = { timezone: TZ, projectsDir: b.projects, remote, branch: "main", stateDir: b.state, machine: "b", quietMs: 0, liveUpdateTimeoutMs: 500 };
  assert.match((await runCycle(slow)).reason ?? "", /updating the vault timed out/);
  const started = Date.now();
  const second = await runCycle(slow);
  assert.equal(second.outcome, "aborted", second.reason ?? "");
  assert.ok(Date.now() - started < 8000, "the repair has the live update's own timeout");
  assert.equal(second.committed, null, "no snapshot while the update is unfinished");
  assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), pushedByA, "nothing pushed");
  await gitOk(["config", "--unset", "filter.slow.smudge"], { cwd: b.projects });
  const third = await runCycle({ ...slow, liveUpdateTimeoutMs: undefined });
  assert.equal(third.outcome, "synced", third.reason ?? "");
  assert.equal(await read(b, "x/t.md"), "from a\n");
  assert.equal(await remoteFile(remote, "x/t.md"), "from a");
});

test("a busy cycle, which never ran, leaves the blocked-cycle streak alone", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.state, "blocked-cycles", "2");
  const lockDir = await gitOk(["rev-parse", "--path-format=absolute", "--git-path", "sro-sync.lock"], { cwd: a.projects });
  const held = await acquireLock(lockDir);
  assert.ok(held);
  try {
    const r = await runCycle({ timezone: TZ, projectsDir: a.projects, remote, branch: "main", stateDir: a.state, machine: "a", lockWaitMs: 100 });
    assert.equal(r.outcome, "busy");
  } finally {
    await held.release();
  }
  assert.equal(await streak(a), "2");
});

// Fix round 1 (task 6).

test("a held-back note in a folder the remote replaces with a file blocks the update by the folder's name, up to the escalation", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(b.projects, "x/p/creds.md", `token ${TOKEN}\n`); // held back: stays untracked inside x/p
  await writeRel(a.projects, "x/p", "a file on a\n");
  assert.ok((await cycle(remote, a)).pushed);
  const results: CycleResult[] = [];
  for (let i = 0; i < 3; i++) results.push(await cycle(remote, b));
  for (const r of results) {
    assert.equal(r.outcome, "synced", r.reason ?? "");
    assert.deepEqual(r.blockedBy, ["x/p"], r.reason ?? "");
    assert.deepEqual(r.notices, [], "a refusal changed nothing, so there is nothing to finish");
  }
  assert.deepEqual(results.map((r) => r.blockedCycles), [1, 2, 3]);
  const line = statusFromCycle(results[2] as CycleResult).find((s) => s.text.startsWith("live update blocked"));
  assert.equal(line?.level, "error", "the escalation after 3 blocked cycles");
  assert.equal(await read(b, "x/p/creds.md"), `token ${TOKEN}\n`, "the held-back note is intact");
  assert.ok(!(await remoteNames(remote)).includes("x/p/creds.md"));
});

// Runs `script` in the live repo once, from a reference-transaction hook, as step 5
// sets remote-seen: the last thing before the live update's reset.
async function justBeforeLiveUpdate(x: Machine, script: string): Promise<void> {
  const once = join(x.projects, ".git", "before-update-once");
  await writeFile(once, "");
  const hook = join(x.projects, ".git", "hooks", "reference-transaction");
  await writeFile(
    hook,
    `#!/bin/sh\n[ "$1" = committed ] || exit 0\ngrep -q " ${REMOTE_SEEN}$" || exit 0\n[ -f '${once}' ] || exit 0\nrm -f '${once}'\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ncd '${x.projects}' || exit 1\n${script}\n`,
  );
  await chmod(hook, 0o755);
}

test("an edit staged by hand that the update would overwrite blocks it by name, never taken for an interrupted update", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/t.md", "from a\n");
  assert.ok((await cycle(remote, a)).pushed);
  await justBeforeLiveUpdate(b, "printf 'staged by hand\\n' > x/t.md && git add x/t.md");
  const first = await cycle(remote, b);
  assert.equal(first.outcome, "synced", first.reason ?? "");
  assert.deepEqual(first.blockedBy, ["x/t.md"]);
  assert.equal(first.blockedCycles, 1);
  assert.ok(await stat(join(b.projects, ".git", "hooks", "reference-transaction")));
  assert.ok(await absent(b, ".git/before-update-once"), "the staging ran");
  const second = await cycle(remote, b);
  assert.deepEqual(second.notices, [], "a refusal changed nothing, so there is nothing to finish");
  assert.equal(second.outcome, "synced", second.reason ?? "");
  assert.equal(await read(b, "x/t.md"), "staged by hand\n");
});

test("a deletion staged by hand, the note still on disk, blocks an update that deletes it, by name", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await rm(join(a.projects, "x/t.md"));
  assert.ok((await cycle(remote, a)).pushed);
  await justBeforeLiveUpdate(b, "git rm -q --cached x/t.md");
  const first = await cycle(remote, b);
  assert.equal(first.outcome, "synced", first.reason ?? "");
  assert.deepEqual(first.blockedBy, ["x/t.md"]);
  assert.ok(await absent(b, ".git/before-update-once"), "the staging ran");
  assert.equal(await read(b, "x/t.md"), "t0\n", "the note is untouched");
  const second = await cycle(remote, b);
  assert.deepEqual(second.notices, [], "a refusal changed nothing, so there is nothing to finish");
  assert.equal(second.outcome, "synced", second.reason ?? "");
});

test("a secret one hand commit added and the next removed stops the cycle, naming that commit; nothing reaches the remote", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const before = await gitOk(["rev-parse", "main"], { cwd: remote });
  // Committed by hand, so step 2's scan never saw either commit.
  const added = await commitFile(a.projects, "x/by-hand.md", `token ${TOKEN}\n`, "by hand");
  await gitOk(["rm", "-q", "x/by-hand.md"], { cwd: a.projects });
  await gitOk(["commit", "-q", "-m", "removed by hand"], { cwd: a.projects });
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "stopped", r.reason ?? "");
  const short = await gitOk(["rev-parse", "--short", added], { cwd: a.projects });
  assert.ok((r.reason ?? "").includes(`"x/by-hand.md" (commit ${short})`), r.reason ?? "");
  assert.match(r.reason ?? "", /removing the file is not enough/);
  assert.match(r.reason ?? "", /drop or amend the one that added it/);
  assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), before, "nothing pushed");
  assert.ok(!(await gitOk(["log", "-p", "--all"], { cwd: remote })).includes(TOKEN));
});

test("a secret in commits already on the remote is not scanned again: the cycles that bring them into this history sync", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  // An older client pushed a token, then removed it: both commits are on the remote.
  const other = join(await tempDir(), "other");
  await gitOk(["clone", "-q", remote, other], { cwd: await tempDir() });
  await commitFile(other, "x/old-client.md", `token ${TOKEN}\n`, "an older client");
  await gitOk(["rm", "-q", "x/old-client.md"], { cwd: other });
  await gitOk(["commit", "-q", "-m", "removed"], { cwd: other });
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: other });
  await writeRel(a.projects, "x/mine.md", "m\n");
  const merged = await cycle(remote, a); // a merge commit, whose history holds the token
  assert.equal(merged.outcome, "synced", merged.reason ?? "");
  assert.ok(merged.pushed);
  await writeRel(a.projects, "x/mine-2.md", "m2\n");
  const ahead = await cycle(remote, a); // the vault's history holds it now
  assert.equal(ahead.outcome, "synced", ahead.reason ?? "");
  assert.ok(ahead.pushed);
});

test("an unsent commit that adds only what the remote's tree already holds passes the outbound scan", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const other = join(await tempDir(), "other");
  await gitOk(["clone", "-q", remote, other], { cwd: await tempDir() });
  await commitFile(other, "x/t.md", `t0\ntoken ${TOKEN}\n`, "an older client");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: other });
  assert.ok((await cycle(remote, a)).liveUpdated);
  // By hand, so the snapshot scan (which exempts nothing) never sees the copy.
  await commitFile(a.projects, "x/t-copy.md", `t0\ntoken ${TOKEN}\n`, "a copy by hand");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.equal(await remoteFile(remote, "x/t-copy.md"), `t0\ntoken ${TOKEN}`);
});

test("a conflict is reported only once its copy is on the remote: a refused push reports none", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/HANDOFF.md", "A state\n");
  assert.ok((await cycle(remote, a)).pushed);
  const hook = join(remote, "hooks", "pre-receive");
  await writeFile(hook, `#!/bin/sh\necho "GH013: push declined by repository rules" >&2\nexit 1\n`);
  await chmod(hook, 0o755);
  await writeRel(b.projects, "x/HANDOFF.md", "B state\n");
  const refused = await cycle(remote, b);
  assert.equal(refused.outcome, "unsynced", refused.reason ?? "");
  assert.match(refused.reason ?? "", /GH013/);
  assert.deepEqual(refused.conflicts, []);
  assert.deepEqual(statusFromCycle(refused).filter((s) => s.text.includes("saved as")), []);
  await rm(hook);
  const pushed = await cycle(remote, b);
  assert.ok(pushed.pushed, pushed.reason ?? "");
  assert.equal(pushed.conflicts.length, 1);
  assert.equal(await read(b, pushed.conflicts[0]?.copy ?? ""), "A state\n");
});

test("a merge stop that names no path gives a reason with no dangling colon, and pushes nothing", async () => {
  const { remote, m } = await setup(["a", "b"]);
  const [a, b] = m as [Machine, Machine];
  await writeRel(a.projects, "x/HANDOFF.md", "A state\n");
  assert.ok((await cycle(remote, a)).pushed);
  const before = await gitOk(["rev-parse", "main"], { cwd: remote });
  await writeRel(b.projects, "x/HANDOFF.md", "B state\n");
  let r: CycleResult | undefined;
  await withRewrittenMergeTree("\x001\0x/HANDOFF.md\0CONFLICT (contents)\0", "\x000\0CONFLICT (contents)\0", async () => {
    r = await cycle(remote, b);
  });
  assert.equal(r?.outcome, "stopped", r?.reason ?? "");
  assert.equal(r?.reason, "git reported CONFLICT (contents) without a path");
  assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), before);
});

test("adopting a rewritten remote with nothing unsent pushes nothing, and the vault follows the remote", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const before = await gitOk(["rev-parse", "main"], { cwd: remote });
  await writeRel(a.projects, "x/dropped.md", "sent, then dropped by the rewrite\n");
  assert.ok((await cycle(remote, a)).pushed);
  await forcePushBack(remote, before);
  assert.equal((await cycle(remote, a)).outcome, "stopped");
  const r = await runCycle({ timezone: TZ, projectsDir: a.projects, remote, branch: "main", stateDir: a.state, machine: "a", quietMs: 0, adoptRewrite: true });
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.equal(r.pushed, false);
  assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), before, "no empty commit is pushed");
  assert.equal(await gitOk(["rev-parse", "HEAD"], { cwd: a.projects }), before, "the vault is at the adopted remote");
  assert.ok(await absent(a, "x/dropped.md"));
  assert.equal((await cycle(remote, a)).outcome, "synced", "and later cycles run normally");
});

test("adopting a rewritten remote scans what it carries over: a secret there asks only for the file to go, since no commit of the vault is sent", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  const before = await gitOk(["rev-parse", "main"], { cwd: remote });
  await writeRel(a.projects, "x/dropped.md", "sent, then dropped by the rewrite\n");
  assert.ok((await cycle(remote, a)).pushed);
  await forcePushBack(remote, before);
  await commitFile(a.projects, "x/by-hand.md", `token ${TOKEN}\n`, "by hand, never sent");
  const adopt = { timezone: TZ, projectsDir: a.projects, remote, branch: "main", stateDir: a.state, machine: "a", quietMs: 0, adoptRewrite: true };
  const r = await runCycle(adopt);
  assert.equal(r.outcome, "stopped", r.reason ?? "");
  assert.equal(r.reason, 'the secret scan flags what this sync would send in "x/by-hand.md": nothing was pushed (remove the secret, then sync again)');
  assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), before, "nothing pushed");
  await rm(join(a.projects, "x/by-hand.md"));
  const again = await runCycle(adopt);
  assert.equal(again.outcome, "synced", again.reason ?? "");
  assert.ok(!(await gitOk(["log", "-p", "--all"], { cwd: remote })).includes(TOKEN));
});

test("a temporary index a killed cycle left in the state clone is swept away", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/first.md", "1\n");
  assert.ok((await cycle(remote, a)).pushed);
  const clone = join(a.state, "sync.git");
  // Not a .lock: that would make the whole clone be rebuilt, sweeping it regardless.
  await writeFile(join(clone, "sro-index-0badc0de"), "");
  await writeRel(a.projects, "x/second.md", "2\n");
  const r = await cycle(remote, a);
  assert.equal(r.outcome, "synced", r.reason ?? "");
  assert.deepEqual((await readdir(clone)).filter((n) => n.startsWith("sro-index-")), []);
});

// Runs fn with a git on PATH that fails `merge-base --is-ancestor <pair>` as an
// object git cannot read would (exit 128), and runs the real git for everything
// else: an ancestry git cannot tell is not something a test can set up on demand.
async function withAncestryFailing(pair: string, fn: () => Promise<void>): Promise<void> {
  const dir = await tempDir();
  const real = `${await gitOk(["--exec-path"], { cwd: dir })}/git`;
  const script = `#!/bin/sh\nif [ "$1" = merge-base ] && [ "$2" = --is-ancestor ] && [ "$3 $4" = '${pair}' ]; then\n  echo "fatal: could not parse commit" >&2\n  exit 128\nfi\nexec '${real}' "$@"\n`;
  await writeFile(join(dir, "git"), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    await fn();
  } finally {
    process.env.PATH = path;
  }
}

test("an ancestry git cannot tell leaves the cycle unsynced, with nothing pushed and the vault as it was", async () => {
  const { remote, m } = await setup(["a"]);
  const [a] = m as [Machine];
  await writeRel(a.projects, "x/first.md", "1\n");
  assert.ok((await cycle(remote, a)).pushed);
  const seen = await gitOk(["rev-parse", "main"], { cwd: remote });
  assert.equal(await gitOk(["rev-parse", REMOTE_SEEN], { cwd: a.projects }), seen);
  // By hand: the live snapshot is then known before the cycle, and ahead of the remote.
  const live = await commitFile(a.projects, "x/by-hand.md", "h\n", "by hand");
  const cases: Array<[string, string]> = [
    [`${seen} ${seen}`, "could not tell whether the remote's history was rewritten"],
    [`${live} ${seen}`, "could not compare the live snapshot with the remote"],
    [`${seen} ${live}`, "could not compare the remote with the live snapshot"],
  ];
  for (const [pair, reason] of cases) {
    let r: CycleResult | undefined;
    await withAncestryFailing(pair, async () => {
      r = await cycle(remote, a);
    });
    assert.equal(r?.outcome, "unsynced", `${reason}: ${r?.reason}`);
    assert.equal(r?.reason, reason);
    assert.equal(await gitOk(["rev-parse", "main"], { cwd: remote }), seen, `${reason}: nothing pushed`);
    assert.equal(await gitOk(["rev-parse", "HEAD"], { cwd: a.projects }), live, `${reason}: the vault is as it was`);
  }
  const r = await cycle(remote, a);
  assert.ok(r.pushed, r.reason ?? "");
  assert.equal(await remoteFile(remote, "x/by-hand.md"), "h");
});
