import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureGitignore, prepareProjects, REQUIRED_IGNORES, syncConfig, type SyncState } from "../../core/sync/state.ts";
import { git, gitOk } from "../../core/git.ts";
import type { Vault } from "../../core/vault.ts";
import { GIT_CONFIG, commitFile, initRepo, tempDir, writeRel } from "./helpers.ts";

const TZ = "Asia/Tokyo";

// Fixtures are assembled at runtime: a literal token-shaped string in this file
// would trip GitHub push protection on the repository itself.
const j = (...parts: string[]): string => parts.join("");
const noise = (n: number): string => {
  const alphabet = "Qm7Zr2Kx9Lp4Tw8Vb3Nc6Hd1Fg5Js0Yt";
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[(i * 7 + 3) % alphabet.length];
  return out;
};

async function vault(): Promise<Vault> {
  const root = await tempDir("sro-vault-");
  await mkdir(join(root, ".obsidian"));
  return { root, projectsDir: join(root, "Projects") };
}

async function bareRemote(initialBranch = "main"): Promise<string> {
  const path = join(await tempDir("sro-remote-"), "projects.git");
  await gitOk(["init", "-q", "--bare", "-b", initialBranch, path], { cwd: await tempDir() });
  return path;
}

async function seededRemote(): Promise<string> {
  const remote = await bareRemote();
  const work = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", remote, work], { cwd: await tempDir() });
  await commitFile(work, "kabin-api/HANDOFF.md", "# kabin-api\n", "seed");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: work });
  return remote;
}

function assertKind(state: SyncState, kind: SyncState["kind"]): void {
  assert.equal(state.kind, kind, JSON.stringify(state));
}

test("syncConfig: unset, empty and whitespace all mean off", () => {
  assert.deepEqual(syncConfig({}), { remote: null });
  assert.deepEqual(syncConfig({ OBSIDIAN_PROJECTS_REMOTE: "" }), { remote: null });
  assert.deepEqual(syncConfig({ OBSIDIAN_PROJECTS_REMOTE: "  " }), { remote: null });
  assert.deepEqual(syncConfig({ OBSIDIAN_PROJECTS_REMOTE: " git@h:o/r.git " }), { remote: "git@h:o/r.git" });
});

test("sync off: no git at all, but a configured clone is reported loudly", async () => {
  const v = await vault();
  assertKind(await prepareProjects(v, { remote: null }, TZ), "off");
  const remote = await seededRemote();
  await gitOk(["clone", "-q", remote, v.projectsDir], { cwd: v.root });
  const state = await prepareProjects(v, { remote: null }, TZ);
  assert.deepEqual(state, { kind: "off-but-configured", origin: remote });
});

test("absent Projects/ is cloned from a populated remote", async () => {
  const v = await vault();
  const remote = await seededRemote();
  const state = await prepareProjects(v, { remote }, TZ);
  assert.deepEqual(state, { kind: "ready", branch: "main", bootstrapped: false });
  assert.equal(await readFile(join(v.projectsDir, "kabin-api", "HANDOFF.md"), "utf8"), "# kabin-api\n");
});

test("Finder litter and empty folders count as empty (mkdir before clone no longer blocks it)", async () => {
  const v = await vault();
  await writeRel(v.projectsDir, ".DS_Store", "x");
  await mkdir(join(v.projectsDir, "kabin-api", "specs"), { recursive: true });
  const state = await prepareProjects(v, { remote: await seededRemote() }, TZ);
  assertKind(state, "ready");
});

test("an empty remote is bootstrapped with push -u origin HEAD, .gitignore and the vault timezone", async () => {
  const v = await vault();
  const remote = await bareRemote();
  const state = await prepareProjects(v, { remote }, TZ);
  assert.deepEqual(state, { kind: "ready", branch: "main", bootstrapped: true });
  const ignore = await readFile(join(v.projectsDir, ".gitignore"), "utf8");
  for (const p of REQUIRED_IGNORES) assert.ok(ignore.includes(p), p);
  assert.deepEqual(JSON.parse(await readFile(join(v.projectsDir, ".sro-config.json"), "utf8")), { timezone: TZ });
  assert.match(await gitOk(["ls-remote", "--heads", remote], { cwd: v.root }), /refs\/heads\/main/);
});

test("bootstrap follows the remote's default branch, so every machine lands on the same one", async () => {
  const remote = await bareRemote("master");
  assert.deepEqual(await prepareProjects(await vault(), { remote }, TZ), { kind: "ready", branch: "master", bootstrapped: true });
  assert.deepEqual(await prepareProjects(await vault(), { remote }, TZ), { kind: "ready", branch: "master", bootstrapped: false });
});

test("a remote whose HEAD names a missing branch stops (the old skill's literal push origin main)", async () => {
  const remote = await bareRemote("master");
  const old = join(await tempDir(), "old-client");
  await initRepo(old);
  await commitFile(old, "x/HANDOFF.md", "x", "old skill bootstrap");
  await gitOk(["push", "-q", remote, "HEAD:refs/heads/main"], { cwd: old });
  const state = await prepareProjects(await vault(), { remote }, TZ);
  assertKind(state, "stopped");
  assert.match(state.kind === "stopped" ? state.reason : "", /HEAD names a missing/);
});

test("notes in a non-repo Projects/ are imported into an empty remote, refused for a populated one", async () => {
  const v = await vault();
  await writeRel(v.projectsDir, "vero/HANDOFF.md", "# vero\n");
  const empty = await bareRemote();
  assertKind(await prepareProjects(v, { remote: empty }, TZ), "ready");
  assert.match(await gitOk(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: v.projectsDir }), /vero\/HANDOFF\.md/);

  const w = await vault();
  await writeRel(w.projectsDir, "vero/HANDOFF.md", "# vero\n");
  const refused = await prepareProjects(w, { remote: await seededRemote() }, TZ);
  assertKind(refused, "stopped");
});

test("an origin that differs from the variable by even a .git suffix stops", async () => {
  const v = await vault();
  const remote = await seededRemote();
  await prepareProjects(v, { remote }, TZ);
  const state = await prepareProjects(v, { remote: remote.replace(/\.git$/, "") }, TZ);
  assertKind(state, "stopped");
  assert.match(state.kind === "stopped" ? state.reason : "", /must match exactly/);
});

test("a vault repository that tracks Projects/ stops before anything is touched", async () => {
  const v = await vault();
  await initRepo(v.root);
  await commitFile(v.root, "Projects/x/HANDOFF.md", "x", "old whole-vault sync");
  const state = await prepareProjects(v, { remote: await seededRemote() }, TZ);
  assertKind(state, "stopped");
  assert.match(state.kind === "stopped" ? state.reason : "", /tracks Projects/);
});

test("missing git identity stops the bootstrap instead of letting git guess one", async () => {
  const v = await vault();
  const emptyConfig = join(await tempDir(), "gitconfig");
  await writeFile(emptyConfig, "[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  try {
    const state = await prepareProjects(v, { remote: await bareRemote() }, TZ);
    assertKind(state, "stopped");
    assert.match(state.kind === "stopped" ? state.reason : "", /user\.name/);
    await assert.rejects(stat(join(v.projectsDir, ".git")));
  } finally {
    process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG;
  }
});

test("an import whose notes hold a credential-shaped string stops before anything is committed or pushed, and retries once redacted", async () => {
  const v = await vault();
  await writeRel(v.projectsDir, "x/ok.md", "just notes\n");
  const token = j("gh", "p_", noise(36));
  await writeRel(v.projectsDir, "x/creds.md", `token: ${token}\n`);
  const remote = await bareRemote();

  const stopped = await prepareProjects(v, { remote }, TZ);
  assertKind(stopped, "stopped");
  assert.match(stopped.kind === "stopped" ? stopped.reason : "", /x\/creds\.md/);
  assert.equal(await gitOk(["ls-remote", "--heads", remote], { cwd: v.root }), "");
  await assert.rejects(stat(join(v.projectsDir, ".git")));

  await writeRel(v.projectsDir, "x/creds.md", "token: revoked and redacted\n");
  const ready = await prepareProjects(v, { remote }, TZ);
  assert.deepEqual(ready, { kind: "ready", branch: "main", bootstrapped: true });
  const files = await gitOk(["ls-tree", "-r", "--name-only", "HEAD"], { cwd: v.projectsDir });
  assert.match(files, /x\/ok\.md/);
  assert.match(files, /x\/creds\.md/);
});

test("the bootstrap scan names the real path even when the global git config sets diff.mnemonicPrefix", async () => {
  const v = await vault();
  const token = j("gh", "p_", noise(36));
  await writeRel(v.projectsDir, "x/creds.md", `token: ${token}\n`);
  const remote = await bareRemote();

  // The import runs `git init` itself, so a repo-local setting cannot be
  // placed in advance: the global config is swapped instead, as the missing
  // identity test above does, and restored in a finally.
  const mnemonicConfig = join(await tempDir(), "gitconfig");
  await writeFile(
    mnemonicConfig,
    "[user]\n\tname = Test\n\temail = test@example.com\n" +
      "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[diff]\n\tmnemonicPrefix = true\n",
  );
  process.env.GIT_CONFIG_GLOBAL = mnemonicConfig;
  try {
    const stopped = await prepareProjects(v, { remote }, TZ);
    assertKind(stopped, "stopped");
    const reason = stopped.kind === "stopped" ? stopped.reason : "";
    assert.match(reason, /x\/creds\.md/);
    assert.doesNotMatch(reason, /i\/x\/creds\.md/);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG;
  }
});

test("a detached HEAD and an in-progress rebase each stop", async () => {
  const v = await vault();
  const remote = await seededRemote();
  await prepareProjects(v, { remote }, TZ);
  await gitOk(["checkout", "-q", "--detach"], { cwd: v.projectsDir });
  assertKind(await prepareProjects(v, { remote }, TZ), "stopped");
  await gitOk(["checkout", "-q", "main"], { cwd: v.projectsDir });

  await mkdir(join(v.projectsDir, ".git", "rebase-merge"));
  const rebasing = await prepareProjects(v, { remote }, TZ);
  assert.match(rebasing.kind === "stopped" ? rebasing.reason : "", /rebase-merge/);
});

test("ensureGitignore appends only the missing patterns, once", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, ".gitignore"), "node_modules\n.DS_Store");
  assert.equal(await ensureGitignore(dir), true);
  assert.equal(await ensureGitignore(dir), false);
  const lines = (await readFile(join(dir, ".gitignore"), "utf8")).split("\n");
  assert.equal(lines.filter((l) => l === ".DS_Store").length, 1);
  assert.ok(lines.includes("*.sro-tmp"));
  await initRepo(dir);
  for (const path of ["kabin-api/remember/recent.md", "kabin-api/remember/archive.md", "x/.a1b2.sro-tmp"]) {
    assert.equal((await git(["check-ignore", "-q", path], { cwd: dir })).code, 0, path);
  }
  assert.equal((await git(["check-ignore", "-q", "kabin-api/remember/handoffs/a.md"], { cwd: dir })).code, 1);
});

test("the emptiness check never follows a symlink, so bootstrap cannot delete outside Projects/", async () => {
  const v = await vault();
  await mkdir(v.projectsDir);
  const outside = await tempDir("sro-outside-");
  await writeFile(join(outside, ".DS_Store"), "outside");
  await symlink(outside, join(v.projectsDir, "escape"));
  // A symlink is content: Projects/ is nonempty, so an empty remote gets an import.
  assertKind(await prepareProjects(v, { remote: await bareRemote() }, TZ), "ready");
  assert.equal(await readFile(join(outside, ".DS_Store"), "utf8"), "outside");
  assert.match(await gitOk(["ls-tree", "HEAD", "escape"], { cwd: v.projectsDir }), /^120000 /, "committed as a link, not followed");
});
