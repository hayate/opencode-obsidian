// The only place in core that spawns git. Always asynchronous: a synchronous
// child would block the event loop, and with it the 15 s initialization bound.
import { spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GitOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  input?: string;
}

export const LOCAL_TIMEOUT_MS = 30_000;
export const NETWORK_TIMEOUT_MS = 45_000;

// Spec 5.6: a lock git could not create, in one sentence a user can act on.
// git's own paragraph assumes the reader knows what a lock file is.
function leftLockNotice(stderr: string): string | null {
  const lock = /Unable to create '([^']+\.lock)': File exists/.exec(stderr)?.[1];
  return lock === undefined
    ? null
    : `git left a lock file behind: '${lock}' (a git program stopped before it finished). If no git program is running on this machine, delete that file.`;
}

export class GitError extends Error {
  readonly args: string[];
  readonly result: GitResult;

  constructor(args: string[], result: GitResult) {
    const outcome = result.timedOut ? "timed out" : `exited ${result.code}`;
    const detail = result.stderr.trim() || result.stdout.trim();
    super(leftLockNotice(result.stderr) ?? `git ${args.join(" ")} ${outcome}${detail ? `: ${detail}` : ""}`);
    this.name = "GitError";
    this.args = args;
    this.result = result;
  }
}

function gitEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A leaked GIT_DIR (dotfile setups, git hooks) would redirect every command.
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

// Every path core passes to git goes through this: a note named "what?.md" must
// never be read as a glob. Per path, not GIT_LITERAL_PATHSPECS: hooks inherit the
// environment, and some git commands they run refuse literal-pathspec mode.
export function literal(path: string): string {
  return `:(literal)${path}`;
}

function runOnce(args: string[], opts: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: gitEnv(opts.env),
      // Own process group, so a timeout can kill git and everything it started.
      detached: true,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    }, opts.timeoutMs ?? LOCAL_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) {
      // A git that exits before reading all its input closes the pipe, and the
      // write fails with EPIPE: unhandled, that stream error would crash the
      // process. The exit status (the close handler above) is the result.
      child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE") reject(err);
      });
      child.stdin?.end(opts.input);
    }
  });
}

export const INDEX_LOCK_RETRIES = 5;
export const INDEX_LOCK_DELAY_MS = 1000;

// These take the index lock before changing anything and run no hooks, so one that
// met another process's lock has done nothing and can simply run again.
const RETRIED_ON_INDEX_LOCK = new Set(["add", "rm", "reset"]);

// These take the index lock as they start, before any filter, hook or checkout
// work, so one killed on its timeout was holding it: an index.lock that was not
// there when it started is its own leftover (spec 5.6).
const TAKES_INDEX_LOCK = new Set(["add", "rm", "reset", "commit", "checkout"]);

function subcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c") i++;
    else if (!args[i]?.startsWith("-")) return args[i];
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function indexLockPath(opts: GitOptions): Promise<string | null> {
  const r = await runOnce(["rev-parse", "--path-format=absolute", "--git-path", "index.lock"], {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
  });
  return r.code === 0 && !r.timedOut ? r.stdout.trim() : null;
}

// The message alone proves nothing: a hook or a filter can print it after doing
// work. So: a command from the list, not killed on timeout (it may have done
// anything), and the lock really there.
async function metIndexLock(args: string[], result: GitResult, lock: string | null): Promise<boolean> {
  if (result.code === 0 || result.timedOut) return false;
  if (!RETRIED_ON_INDEX_LOCK.has(subcommand(args) ?? "")) return false;
  if (!/index\.lock'?: File exists/.test(result.stderr)) return false;
  return lock !== null && (await exists(lock));
}

// Spec 5.6: the plugin never deletes a lock it did not create. A command that met
// another process's index.lock is retried; one the plugin killed on its timeout
// has its own index.lock removed, so a timeout never strands the repository.
export async function git(args: string[], opts: GitOptions): Promise<GitResult> {
  const lock = TAKES_INDEX_LOCK.has(subcommand(args) ?? "") ? await indexLockPath(opts) : null;
  for (let attempt = 1; ; attempt++) {
    const before = lock !== null && (await exists(lock));
    const result = await runOnce(args, opts);
    if (result.timedOut && lock !== null && !before && (await exists(lock))) {
      const note = await rm(lock, { force: true }).then(
        () => `removed ${lock}, which this command left when it was stopped`,
        (err: Error) => `could not remove ${lock}, which this command left when it was stopped: ${err.message}`,
      );
      result.stderr += `${result.stderr && !result.stderr.endsWith("\n") ? "\n" : ""}${note}\n`;
    }
    if (attempt >= INDEX_LOCK_RETRIES || !(await metIndexLock(args, result, lock))) return result;
    await new Promise((resolve) => setTimeout(resolve, INDEX_LOCK_DELAY_MS));
  }
}

export async function gitOk(args: string[], opts: GitOptions): Promise<string> {
  const result = await git(args, opts);
  if (result.code !== 0 || result.timedOut) throw new GitError(args, result);
  return result.stdout.trim();
}
