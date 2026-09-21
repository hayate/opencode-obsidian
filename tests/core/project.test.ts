import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeOrigin, recordOrigin, resolveProject } from "../../core/project.ts";
import { gitOk } from "../../core/git.ts";
import type { Vault } from "../../core/vault.ts";
import { commitFile, initRepo, tempDir, writeRel } from "./helpers.ts";

async function vault(): Promise<Vault> {
  const root = await tempDir("sro-vault-");
  await mkdir(join(root, ".obsidian"));
  await mkdir(join(root, "Projects"));
  return { root, projectsDir: join(root, "Projects") };
}

async function repo(parent: string, name: string, origin?: string): Promise<string> {
  const dir = join(parent, name);
  await initRepo(dir);
  await commitFile(dir, "README.md", "x\n", "init");
  if (origin) await gitOk(["remote", "add", "origin", origin], { cwd: dir });
  return dir;
}

test("normalizeOrigin: scp, ssh, https and case variants converge", () => {
  const want = "github.com/hayate/oso-projects";
  for (const url of [
    "git@github.com:hayate/oso-projects.git",
    "git@GitHub.com:hayate/oso-projects",
    "ssh://git@github.com/hayate/oso-projects.git",
    "ssh://git@github.com:22/hayate/oso-projects.git/",
    "https://github.com/hayate/oso-projects.git",
    "https://user@github.com/hayate/oso-projects",
  ]) {
    assert.equal(normalizeOrigin(url), want, url);
  }
  assert.equal(normalizeOrigin("/srv/git/projects.git"), "file:/srv/git/projects");
  assert.equal(normalizeOrigin("file:///srv/git/projects.git"), "file:/srv/git/projects");
  assert.equal(normalizeOrigin("   "), null);
});

test("a normal checkout maps to its folder name", async () => {
  const v = await vault();
  const code = await repo(await tempDir(), "materia-api", "git@github.com:acme/materia-api.git");
  assert.deepEqual(await resolveProject(v, code), {
    kind: "ok",
    name: "materia-api",
    origin: "github.com/acme/materia-api",
    dir: join(v.projectsDir, "materia-api"),
  });
});

test("a linked worktree maps to the main checkout, not the worktree folder", async () => {
  const v = await vault();
  const code = await repo(await tempDir(), "kabin-api");
  const wt = join(code, ".worktrees", "feat-x");
  await gitOk(["worktree", "add", "-q", "-b", "feat-x", wt], { cwd: code });
  const r = await resolveProject(v, wt);
  assert.equal(r.kind === "ok" && r.name, "kabin-api");
});

test("a subdirectory of a checkout maps to the checkout", async () => {
  const v = await vault();
  const code = await repo(await tempDir(), "docparse");
  await writeRel(code, "src/deep/file.ts", "");
  const r = await resolveProject(v, join(code, "src", "deep"));
  assert.equal(r.kind === "ok" && r.name, "docparse");
});

test("a submodule maps to its own working tree name", async () => {
  const v = await vault();
  const parent = await tempDir();
  const lib = await repo(parent, "shared-lib");
  const sup = await repo(parent, "super");
  await gitOk(["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "vendor/shared-lib"], { cwd: sup });
  const r = await resolveProject(v, join(sup, "vendor", "shared-lib"));
  assert.equal(r.kind === "ok" && r.name, "shared-lib");
});

test("a folder that is not a git repository maps to its own name", async () => {
  const v = await vault();
  const dir = join(await tempDir(), "notes-only");
  await mkdir(dir);
  assert.deepEqual(await resolveProject(v, dir), {
    kind: "ok",
    name: "notes-only",
    origin: null,
    dir: join(v.projectsDir, "notes-only"),
  });
});

test("a bare repository is rejected", async () => {
  const v = await vault();
  const bare = join(await tempDir(), "x.git");
  await gitOk(["init", "-q", "--bare", bare], { cwd: await tempDir() });
  const r = await resolveProject(v, bare);
  assert.equal(r.kind, "disabled");
});

test("lookup by origin finds the folder even when the clone folder name differs", async () => {
  const v = await vault();
  await recordOrigin(join(v.projectsDir, "ai.kabinhotel.com"), "github.com/acme/ai-kabin-web");
  const code = await repo(await tempDir(), "ai-kabin-web-clone", "git@github.com:acme/ai-kabin-web.git");
  const r = await resolveProject(v, code);
  assert.equal(r.kind === "ok" && r.name, "ai.kabinhotel.com");
});

test("two folders claiming one origin are refused, naming both", async () => {
  const v = await vault();
  await recordOrigin(join(v.projectsDir, "alpha"), "github.com/acme/app");
  await recordOrigin(join(v.projectsDir, "beta"), "github.com/acme/app");
  const code = await repo(await tempDir(), "alpha", "git@github.com:acme/app.git");
  const r = await resolveProject(v, code);
  assert.equal(r.kind, "disabled");
  assert.match(r.kind === "disabled" ? r.reason : "", /alpha, beta/);
});

test("a folder recorded for a different origin is refused, never shared", async () => {
  const v = await vault();
  await recordOrigin(join(v.projectsDir, "api"), "github.com/acme/api");
  const code = await repo(await tempDir(), "api", "git@github.com:other/api.git");
  const r = await resolveProject(v, code);
  assert.equal(r.kind, "disabled");
  assert.match(r.kind === "disabled" ? r.reason : "", /belongs to github\.com\/acme\/api/);
});

test("recordOrigin writes once and never overwrites", async () => {
  const dir = join(await tempDir(), "p");
  await recordOrigin(dir, "github.com/a/b");
  await recordOrigin(dir, "github.com/c/d");
  assert.equal(await readFile(join(dir, "remember", ".origin"), "utf8"), "github.com/a/b\n");
});
