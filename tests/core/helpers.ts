// Shared test helpers. Every test runs git against a private global config, so
// results never depend on the developer's own ~/.gitconfig.
import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { gitOk } from "../../core/git.ts";

const created: string[] = [];
after(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

// realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var, and
// git reports the resolved form.
export async function tempDir(prefix = "sro-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

const gitHome = await tempDir("sro-githome-");
export const GIT_CONFIG = join(gitHome, "gitconfig");
await writeFile(
  GIT_CONFIG,
  "[user]\n\tname = Test\n\temail = test@example.com\n" +
    "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
);
process.env.GIT_CONFIG_GLOBAL = GIT_CONFIG;
process.env.GIT_CONFIG_NOSYSTEM = "1";

export async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await gitOk(["init", "-q"], { cwd: dir });
}

export async function writeRel(root: string, rel: string, content: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function commitFile(repo: string, rel: string, content: string, message: string): Promise<string> {
  await writeRel(repo, rel, content);
  await gitOk(["add", "--", rel], { cwd: repo });
  await gitOk(["commit", "-q", "-m", message], { cwd: repo });
  return gitOk(["rev-parse", "HEAD"], { cwd: repo });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
