import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOk } from "../../core/git.ts";
import { ensureStateClone } from "../../core/sync/clone.ts";
import { GIT_CONFIG, commitFile, initRepo, tempDir } from "./helpers.ts";

async function world(): Promise<{ live: string; remote: string; stateDir: string }> {
  const live = await tempDir();
  await initRepo(live);
  await commitFile(live, "x/a.md", "a\n", "a");
  const remote = join(await tempDir(), "remote.git");
  await gitOk(["init", "-q", "--bare", remote], { cwd: live });
  return { live, remote, stateDir: join(await tempDir(), "state") };
}

const config = async (clone: string, key: string): Promise<string> => (await git(["config", "--get", key], { cwd: clone })).stdout.trim();

test("the state clone is bare, in the files ref format, with background maintenance off", async () => {
  const w = await world();
  const clone = await ensureStateClone(w.stateDir, w.live, w.remote);
  assert.equal(clone, join(w.stateDir, "sync.git"));
  assert.equal(await gitOk(["rev-parse", "--is-bare-repository"], { cwd: clone }), "true");
  assert.equal(await gitOk(["rev-parse", "--show-ref-format"], { cwd: clone }), "files");
  assert.equal(await config(clone, "remote.live.url"), w.live);
  assert.equal(await config(clone, "remote.origin.url"), w.remote);
  assert.equal(await config(clone, "maintenance.auto"), "false");
  assert.equal(await config(clone, "gc.auto"), "0");
});

test("a reftable default in the user's config still gives a files-format clone", async () => {
  const w = await world();
  await gitOk(["config", "--file", GIT_CONFIG, "init.defaultRefFormat", "reftable"], { cwd: w.live });
  try {
    const clone = await ensureStateClone(w.stateDir, w.live, w.remote);
    assert.equal(await gitOk(["rev-parse", "--show-ref-format"], { cwd: clone }), "files");
  } finally {
    await gitOk(["config", "--file", GIT_CONFIG, "--unset", "init.defaultRefFormat"], { cwd: w.live });
  }
});

test("moving the vault or changing the remote re-points the clone, without a rebuild", async () => {
  const w = await world();
  const clone = await ensureStateClone(w.stateDir, w.live, w.remote);
  const marker = join(clone, "kept");
  await writeFile(marker, "");
  const other = join(await tempDir(), "other.git");
  await ensureStateClone(w.stateDir, w.live, other);
  assert.equal(await config(clone, "remote.origin.url"), other);
  assert.ok((await readdir(clone)).includes("kept"), "re-pointing is not a rebuild");
});

for (const [what, damage] of [
  ["a leftover HEAD.lock", (c: string) => writeFile(join(c, "HEAD.lock"), "")],
  ["a leftover config.lock", (c: string) => writeFile(join(c, "config.lock"), "")],
  ["a leftover ref lock", async (c: string) => {
    await mkdir(join(c, "refs", "remotes", "live"), { recursive: true });
    await writeFile(join(c, "refs", "remotes", "live", "main.lock"), "");
  }],
  ["a leftover temporary index lock", (c: string) => writeFile(join(c, "sro-index-0badf00d.lock"), "")],
  ["a missing refs/", (c: string) => rm(join(c, "refs"), { recursive: true, force: true })],
  ["a missing live remote", (c: string) => gitOk(["remote", "remove", "live"], { cwd: c }).then(() => undefined)],
  ["a missing origin remote", (c: string) => gitOk(["remote", "remove", "origin"], { cwd: c }).then(() => undefined)],
  ["core.bare turned off", (c: string) => gitOk(["config", "core.bare", "false"], { cwd: c }).then(() => undefined)],
  ["its refs migrated to reftable (locks the leftover check cannot see)", (c: string) =>
    gitOk(["refs", "migrate", "--ref-format=reftable"], { cwd: c }).then(() => undefined)],
] as const) {
  test(`a clone with ${what} is rebuilt`, async () => {
    const w = await world();
    const clone = await ensureStateClone(w.stateDir, w.live, w.remote);
    await writeFile(join(clone, "stale-marker"), "");
    await damage(clone);
    await ensureStateClone(w.stateDir, w.live, w.remote);
    assert.equal((await readdir(clone)).includes("stale-marker"), false, "rebuilt from scratch");
    assert.equal(await config(clone, "remote.live.url"), w.live);
    assert.equal(await config(clone, "remote.origin.url"), w.remote);
    assert.equal(await gitOk(["rev-parse", "--is-bare-repository"], { cwd: clone }), "true");
  });
}

test("a clone whose remotes only the user's global config names is rebuilt with its own", async () => {
  const w = await world();
  const clone = await ensureStateClone(w.stateDir, w.live, w.remote);
  await writeFile(join(clone, "stale-marker"), "");
  for (const remote of ["live", "origin"]) await gitOk(["remote", "remove", remote], { cwd: clone });
  const set = (key: string, value: string) => gitOk(["config", "--file", GIT_CONFIG, key, value], { cwd: w.live });
  await set("remote.live.url", w.live);
  await set("remote.origin.url", w.remote);
  try {
    await ensureStateClone(w.stateDir, w.live, w.remote);
    assert.equal((await readdir(clone)).includes("stale-marker"), false, "rebuilt");
    for (const remote of ["live", "origin"]) {
      assert.equal((await git(["config", "--local", "--get", `remote.${remote}.url`], { cwd: clone })).code, 0, remote);
    }
  } finally {
    for (const remote of ["live", "origin"]) await gitOk(["config", "--file", GIT_CONFIG, "--remove-section", `remote.${remote}`], { cwd: w.live });
  }
});

test("maintenance, auto gc and the hooks setting are put back every time, without a rebuild", async () => {
  const w = await world();
  const clone = await ensureStateClone(w.stateDir, w.live, w.remote);
  await writeFile(join(clone, "kept"), "");
  for (const key of ["maintenance.auto", "gc.auto", "core.hooksPath"]) await gitOk(["config", "--unset", key], { cwd: clone });
  await ensureStateClone(w.stateDir, w.live, w.remote);
  assert.ok((await readdir(clone)).includes("kept"), "not a rebuild");
  assert.equal(await config(clone, "maintenance.auto"), "false");
  assert.equal(await config(clone, "gc.auto"), "0");
  assert.notEqual(await config(clone, "core.hooksPath"), "");
});

test("a global hook never runs in the state clone, from the clone command on", async () => {
  const w = await world();
  const hooks = await tempDir();
  const log = join(hooks, "ran");
  // Fails only inside the state directory: the live repo and the remote keep the user's hooks.
  const hook = `#!/bin/sh\ncase "$(git rev-parse --absolute-git-dir)" in "${w.stateDir}"/*) echo "$0" >> "${log}"; exit 1;; esac\n`;
  for (const name of ["reference-transaction", "pre-push", "post-checkout"]) await writeFile(join(hooks, name), hook, { mode: 0o755 });
  await gitOk(["config", "--file", GIT_CONFIG, "core.hooksPath", hooks], { cwd: w.live });
  try {
    const clone = await ensureStateClone(w.stateDir, w.live, w.remote);
    await gitOk(["fetch", "-q", "live", "+refs/heads/*:refs/remotes/live/*"], { cwd: clone });
    await gitOk(["push", "-q", "origin", "refs/remotes/live/main:refs/heads/main"], { cwd: clone });
    await gitOk(["update-ref", "refs/sro/integrated", "refs/remotes/live/main"], { cwd: clone });
    assert.equal(await readFile(log, "utf8").catch(() => ""), "", "no hook ran in the state clone");
  } finally {
    await gitOk(["config", "--file", GIT_CONFIG, "--unset", "core.hooksPath"], { cwd: w.live });
  }
});

test("a rebuild goes through a temporary sibling: leftovers are swept, and a failed one leaves none", async () => {
  const w = await world();
  await mkdir(w.stateDir, { recursive: true });
  await mkdir(join(w.stateDir, ".sync.0badf00d.sro-tmp"));
  await mkdir(join(w.stateDir, ".sync.0badf00d.sro-old"));
  await mkdir(join(w.stateDir, ".sync.keep.sro-tmp"));
  await ensureStateClone(w.stateDir, w.live, w.remote);
  assert.deepEqual((await readdir(w.stateDir)).sort(), [".sync.keep.sro-tmp", "sync.git"], "only its own 8-hex names are swept");

  const fresh = join(await tempDir(), "state");
  await assert.rejects(ensureStateClone(fresh, join(await tempDir(), "not-a-repo"), w.remote));
  assert.deepEqual((await readdir(fresh)).filter((n) => n.endsWith(".sro-tmp")), []);
});

test(
  "a leftover the sweep cannot delete never stops a rebuild: the rebuild uses a fresh name, and a later one sweeps it",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const w = await world();
    const stuck = join(w.stateDir, ".sync.0badf00d.sro-old");
    await mkdir(join(stuck, "locked", "inner"), { recursive: true });
    await chmod(join(stuck, "locked"), 0o555);
    try {
      const clone = await ensureStateClone(w.stateDir, w.live, w.remote);
      assert.equal(await gitOk(["rev-parse", "--is-bare-repository"], { cwd: clone }), "true");
      assert.ok((await readdir(w.stateDir)).includes(".sync.0badf00d.sro-old"), "the leftover it could not delete stays");
    } finally {
      await chmod(join(stuck, "locked"), 0o755);
    }
    await rm(join(w.stateDir, "sync.git"), { recursive: true });
    await ensureStateClone(w.stateDir, w.live, w.remote);
    assert.deepEqual((await readdir(w.stateDir)).sort(), ["sync.git"]);
  },
);

test("a rebuild that fails after the clone (git refuses the remote) leaves no temporary sibling", async () => {
  const w = await world();
  // git remote add reads a URL beginning with "-" as an option and refuses it (exit 129).
  await assert.rejects(ensureStateClone(w.stateDir, w.live, "-not-a-remote"));
  assert.deepEqual((await readdir(w.stateDir)).filter((n) => n.includes(".sro-")), []);
});

test(
  "an old clone that cannot be removed never leaves a half-deleted clone in place: the new one is, whole",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const w = await world();
    await mkdir(join(w.stateDir, "sync.git", "locked", "inner"), { recursive: true });
    await chmod(join(w.stateDir, "sync.git", "locked"), 0o555);
    const aside = async (): Promise<string[]> => (await readdir(w.stateDir)).filter((n) => n.endsWith(".sro-old"));
    try {
      await assert.rejects(ensureStateClone(w.stateDir, w.live, w.remote), /locked/);
      const clone = join(w.stateDir, "sync.git");
      assert.equal(await gitOk(["rev-parse", "--is-bare-repository"], { cwd: clone }), "true");
      assert.equal(await config(clone, "remote.live.url"), w.live);
      assert.deepEqual((await readdir(w.stateDir)).filter((n) => n.endsWith(".sro-tmp")), []);
      assert.equal((await aside()).length, 1, "the old clone was moved aside first");
      assert.equal(await ensureStateClone(w.stateDir, w.live, w.remote), clone, "and the next cycle uses the new clone");
    } finally {
      for (const name of ["sync.git", ...(await aside())]) await chmod(join(w.stateDir, name, "locked"), 0o755).catch(() => undefined);
    }
  },
);
