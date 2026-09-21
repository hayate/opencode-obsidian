import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { legacyReappeared, migrateLegacyHandoffs, schemaVersion } from "../../core/migrate.ts";
import { computeHeads, listHandoffs } from "../../core/store.ts";
import { gitOk } from "../../core/git.ts";
import { commitFile, initRepo, tempDir, writeRel } from "./helpers.ts";

async function repoWithLegacy(): Promise<string> {
  const projects = join(await tempDir(), "Projects");
  await initRepo(projects);
  await commitFile(projects, "kabin-api/HANDOFF.md", "# kabin-api - handoff\nstate\n", "legacy");
  await commitFile(projects, "vero/HANDOFF.md", "# vero - handoff\n", "legacy");
  return projects;
}

async function legacyFile(projects: string, name: string): Promise<string> {
  const dir = join(projects, name, "remember", "handoffs");
  const [file] = await readdir(dir);
  return readFile(join(dir, file ?? ""), "utf8");
}

test("each root HANDOFF.md becomes a legacy handoff with generated frontmatter, and the marker is written", async () => {
  const projects = await repoWithLegacy();
  const report = await migrateLegacyHandoffs(projects);
  assert.deepEqual(report.migrated.sort(), ["kabin-api", "vero"]);
  assert.equal(await schemaVersion(projects), 1);
  const text = await legacyFile(projects, "kabin-api");
  assert.match(text, /^---\ntype: handoff\nproject: kabin-api\nbranch: legacy\n/);
  assert.match(text, /supersedes: \[\]\n---\n\n# kabin-api - handoff\nstate\n$/);
  const heads = computeHeads(await listHandoffs(join(projects, "kabin-api")));
  assert.equal(heads.byBranch.get("legacy")?.length, 1, "the migrated handoff is a valid head");
  assert.deepEqual((await readdir(join(projects, "kabin-api", "remember", "handoffs"))).filter((n) => n.endsWith(".sro-tmp")), []);
  assert.deepEqual((await readdir(projects)).filter((n) => n.endsWith(".sro-tmp")), []);
});

test("a project folder named p* dates its handoff from its own history, not a neighbour's", async () => {
  const projects = join(await tempDir(), "Projects");
  await initRepo(projects);
  for (const [name, date] of [["p*", "2026-01-01T00:00:00+09:00"], ["pq", "2026-02-01T00:00:00+09:00"]] as const) {
    await writeRel(projects, `${name}/HANDOFF.md`, `# ${name}\n`);
    await gitOk(["add", "-A"], { cwd: projects });
    await gitOk(["commit", "-q", "-m", name], { cwd: projects, env: { GIT_COMMITTER_DATE: date } });
  }
  await migrateLegacyHandoffs(projects);
  assert.match(await legacyFile(projects, "p*"), /\nwritten: "?2026-01-01T00:00:00\+09:00"?\n/);
});

test("two clones migrating the same file produce byte-identical results", async () => {
  const origin = await repoWithLegacy();
  const a = join(await tempDir(), "a");
  const b = join(await tempDir(), "b");
  await gitOk(["clone", "-q", origin, a], { cwd: await tempDir() });
  await gitOk(["clone", "-q", origin, b], { cwd: await tempDir() });
  await migrateLegacyHandoffs(a);
  await migrateLegacyHandoffs(b);
  const names = async (p: string): Promise<string[]> => readdir(join(p, "kabin-api", "remember", "handoffs"));
  assert.deepEqual(await names(a), await names(b));
  assert.equal(await legacyFile(a, "kabin-api"), await legacyFile(b, "kabin-api"));
});

test("migrating content another machine already migrated is harmless", async () => {
  const projects = await repoWithLegacy();
  await migrateLegacyHandoffs(projects);
  await writeRel(projects, "kabin-api/HANDOFF.md", "# kabin-api - handoff\nstate\n"); // same content, not yet removed here
  const second = await migrateLegacyHandoffs(projects);
  assert.deepEqual(second, { migrated: [], alreadyDone: ["kabin-api"] });
  assert.equal((await readdir(join(projects, "kabin-api", "remember", "handoffs"))).length, 1);
});

test("a HANDOFF.md written by an old client after migration is reported", async () => {
  const projects = await repoWithLegacy();
  await migrateLegacyHandoffs(projects);
  assert.equal(await legacyReappeared(projects, "kabin-api"), false);
  await writeRel(projects, "kabin-api/HANDOFF.md", "old client wrote this\n");
  assert.equal(await legacyReappeared(projects, "kabin-api"), true);
});

test("before migration nothing is reported as reappeared", async () => {
  const projects = await repoWithLegacy();
  assert.equal(await legacyReappeared(projects, "kabin-api"), false);
});

test("the migration never reads a symlinked HANDOFF.md, nor writes through a symlinked handoffs folder", async () => {
  const outside = await tempDir("sro-outside-");
  await writeRel(outside, "secret.txt", "OUTSIDE\n");
  const a = join(await tempDir(), "Projects");
  await mkdir(join(a, "p"), { recursive: true });
  await symlink(join(outside, "secret.txt"), join(a, "p", "HANDOFF.md"));
  await assert.rejects(migrateLegacyHandoffs(a), /HANDOFF\.md cannot be read \(a symbolic link\)/);
  assert.equal(await schemaVersion(a), 0, "no marker after a refused migration");

  const b = await repoWithLegacy();
  await mkdir(join(b, "kabin-api", "remember"), { recursive: true });
  await symlink(outside, join(b, "kabin-api", "remember", "handoffs"));
  await assert.rejects(migrateLegacyHandoffs(b), /remember\/handoffs cannot be written \(a symbolic link\)/);
  assert.deepEqual(await readdir(outside), ["secret.txt"], "nothing was written through the link");
});
