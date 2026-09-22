// Shared test helpers. Every test runs git against a private global config, so
// results never depend on the developer's own ~/.gitconfig.
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
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

// Runs fn with a git on PATH that rewrites merge-tree's raw output (NULs and all):
// records git cannot be made to emit here (folder-rename detection is off, and no
// conflict of a notes vault names no path). A rewrite that matches nothing fails.
export async function withRewrittenMergeTree(from: string, to: string, fn: () => Promise<void>): Promise<void> {
  const dir = await tempDir();
  const real = (await gitOk(["--exec-path"], { cwd: dir })) + "/git";
  const script = [
    `#!${process.execPath}`,
    `const { spawnSync } = require("node:child_process");`,
    `const args = process.argv.slice(2);`,
    `const r = spawnSync(${JSON.stringify(real)}, args, { stdio: ["inherit", "pipe", "inherit"], maxBuffer: 1 << 30 });`,
    `let out = r.stdout.toString("latin1");`,
    `if (args.includes("merge-tree")) {`,
    `  if (!out.includes(${JSON.stringify(from)})) { process.stderr.write("rewrite matched nothing"); process.exit(99); }`,
    `  out = out.split(${JSON.stringify(from)}).join(${JSON.stringify(to)});`,
    `}`,
    `process.stdout.write(Buffer.from(out, "latin1"));`,
    `process.exitCode = r.status ?? 1;`,
  ].join("\n");
  await writeFile(join(dir, "git"), script, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    await fn();
  } finally {
    process.env.PATH = path;
  }
}

// Ends a helper process a test started and waits for node to reap it, so a later look at
// its process group cannot find a zombie (a zombie answers process.kill(pid, 0) as alive).
// Tests unreference their helpers, so that a failed assertion never leaves the file
// waiting one out; awaiting an unreferenced child's exit would then leave the event loop
// with nothing referenced at all, and node's test runner cancels the test for it
// ("Promise resolution is still pending but the event loop has already resolved",
// reproduced on Linux with node 22.23.2, where macOS happened to survive the same code).
// So the child is referenced again for the wait itself, which every caller does after the
// assertions that matter. `kill` says what to signal: the child alone, or the process
// group it leads (a detached helper, which may have started children of its own).
export async function endHelper(child: ChildProcess, kill: "child" | "group" = "child"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.ref();
  try {
    if (kill === "group" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // Already gone: the wait below still reaps it.
  }
  await once(child, "exit");
}
