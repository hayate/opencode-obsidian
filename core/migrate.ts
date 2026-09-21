// Spec 4.5: the explicit, one-time move of each root HANDOFF.md into
// remember/handoffs/legacy-<sha12>.md. Every field derives from the repository,
// so two machines migrating the same file produce byte-identical results.
import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { git, literal } from "./git.ts";
import { checkMemoryDir, createAt, readMemoryFile, renderDoc, vaultName, writeAtomic } from "./store.ts";

export const SCHEMA_FILE = ".sro-schema";
export const SCHEMA_VERSION = 1;

export async function schemaVersion(projectsDir: string): Promise<number> {
  try {
    return Number((await readFile(join(projectsDir, SCHEMA_FILE), "utf8")).trim()) || 0;
  } catch {
    return 0;
  }
}

async function writtenAt(projectsDir: string, rel: string): Promise<string> {
  const r = await git(["log", "-1", "--format=%cI", "--", literal(rel)], { cwd: projectsDir });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return (await stat(join(projectsDir, rel))).mtime.toISOString(); // sync off: no history
}

export interface MigrationReport {
  migrated: string[];
  alreadyDone: string[];
}

// A step on one project's memory, its error naming the project.
async function inProject<T>(name: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw new Error(`Projects/${vaultName(name)}/${(err as Error).message}`);
  }
}

export async function migrateLegacyHandoffs(projectsDir: string): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], alreadyDone: [] };
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    // No Projects/ is nothing to migrate: writing the marker would create the
    // folder and turn "absent" into "nonempty, not a repo" (spec 4.1), blocking
    // the first clone. Any other failure is not "empty".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return report;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const rel = `${entry.name}/HANDOFF.md`;
    const source = join(projectsDir, rel);
    const projectDir = join(projectsDir, entry.name);
    // Through the read boundary (store.ts): a symlinked HANDOFF.md would copy its
    // target into a synced handoff. Any failure but "absent" stops the migration
    // before the marker, so nothing is silently left behind unmigrated.
    const content = await inProject(entry.name, () => readMemoryFile(projectDir, "HANDOFF.md"));
    if (content === null) continue;
    const sha12 = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const doc = renderDoc(
      {
        type: "handoff",
        project: entry.name,
        branch: "legacy",
        machine: "",
        session: "",
        written: await writtenAt(projectsDir, rel),
        supersedes: [],
      },
      content,
    );
    await inProject(entry.name, () => checkMemoryDir(projectDir, "remember/handoffs"));
    const dir = join(projectsDir, entry.name, "remember", "handoffs");
    const target = join(dir, `legacy-${sha12}.md`);
    if (await createAt(target, doc)) {
      report.migrated.push(entry.name);
    } else {
      const existing = await inProject(entry.name, () => readMemoryFile(projectDir, `remember/handoffs/legacy-${sha12}.md`));
      if (existing !== doc) throw new Error(`${target} exists with different content`);
      report.alreadyDone.push(entry.name);
    }
    await rm(source);
  }
  await writeAtomic(join(projectsDir, SCHEMA_FILE), `${SCHEMA_VERSION}\n`);
  return report;
}

// After migration, a root HANDOFF.md means an old client wrote one (spec 4.5).
export async function legacyReappeared(projectsDir: string, project: string): Promise<boolean> {
  if ((await schemaVersion(projectsDir)) < SCHEMA_VERSION) return false;
  return stat(join(projectsDir, project, "HANDOFF.md")).then(() => true, () => false);
}
