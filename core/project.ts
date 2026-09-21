// Which Projects/<name>/ folder a session belongs to (spec 4.2). The folder name
// is the plain repo name; remember/.origin makes it stable across machines.
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { git, gitOk } from "./git.ts";
import { createAt, quoted, vaultName } from "./store.ts";
import type { Vault } from "./vault.ts";

export type ProjectResolution =
  | { kind: "ok"; name: string; origin: string | null; dir: string }
  | { kind: "disabled"; reason: string };

export const ORIGIN_FILE = ".origin";

// A claim resolveProject cannot trust: unlike a missing file (ENOENT, "no claim"),
// this must never be read as "unclaimed", or a broken claim would silently switch
// off spec 4.2's ambiguity and collision refusals.
class UnreadableClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableClaimError";
  }
}

// host/owner/repo, host lowercased, user and port dropped, trailing .git and / removed.
// ssh://, https://, git://, scp-style (git@host:owner/repo) and local paths all converge.
export function normalizeOrigin(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  const clean = (path: string): string => path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (raw.startsWith("/") || raw.startsWith("file://")) {
    return `file:${clean(raw.replace(/^file:\/\//, "")).replace(/^/, "/")}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return `${u.hostname.toLowerCase()}/${clean(decodeURIComponent(u.pathname))}`;
    } catch {
      return null;
    }
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
  if (scp?.[1] && scp[2]) return `${scp[1].toLowerCase()}/${clean(scp[2])}`;
  return null;
}

// A missing .origin (ENOENT) is "no origin recorded": null. Anything else that
// stops us reading it (EISDIR, EACCES...), or a file that exists but is empty or
// whitespace-only (a torn write), is a claim we cannot trust: refuse, never guess.
// Messages become status lines: the vault folder name in them is quoted when odd.
async function readOrigin(projectDir: string): Promise<string | null> {
  const path = join(projectDir, "remember", ORIGIN_FILE);
  const shown = `Projects/${vaultName(basename(projectDir))}/remember/${ORIGIN_FILE}`;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new UnreadableClaimError(`${shown} cannot be read (${code}): fix or remove this file, then retry`);
  }
  const trimmed = raw.trim();
  if (!trimmed) throw new UnreadableClaimError(`${shown} is empty: fix or remove this file, then retry`);
  return trimmed;
}

async function foldersClaiming(projectsDir: string, origin: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new UnreadableClaimError(`${projectsDir} cannot be listed (${code}): fix or remove this directory, then retry`);
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if ((await readOrigin(join(projectsDir, entry.name))) === origin) matches.push(entry.name);
  }
  return matches.sort();
}

async function checkoutName(sessionDir: string): Promise<string> {
  const common = await gitOk(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: sessionDir });
  // Main checkout or any of its linked worktrees: <repo>/.git -> <repo>.
  if (basename(common) === ".git") return basename(dirname(common));
  // Submodule (<super>/.git/modules/<name>): its own working tree names it.
  return basename(await gitOk(["rev-parse", "--show-toplevel"], { cwd: sessionDir }));
}

export async function resolveProject(vault: Vault, sessionDir: string): Promise<ProjectResolution> {
  const bare = await git(["rev-parse", "--is-bare-repository"], { cwd: sessionDir });
  let name: string;
  let origin: string | null = null;

  try {
    if (bare.code !== 0) {
      name = basename(sessionDir); // not a git repository
    } else if (bare.stdout.trim() === "true") {
      return { kind: "disabled", reason: `${sessionDir} is a bare repository: memory and sync are disabled` };
    } else {
      const remote = await git(["config", "--get", "remote.origin.url"], { cwd: sessionDir });
      origin = remote.code === 0 ? normalizeOrigin(remote.stdout) : null;
      if (origin) {
        const claimed = await foldersClaiming(vault.projectsDir, origin);
        if (claimed.length > 1) {
          return {
            kind: "disabled",
            reason: `origin ${origin} is claimed by several folders (${claimed.map((c) => quoted(c)).join(", ")}): merge them (see README)`,
          };
        }
        const only = claimed[0];
        if (only) return { kind: "ok", name: only, origin, dir: join(vault.projectsDir, only) };
      }
      name = await checkoutName(sessionDir);
    }

    const dir = join(vault.projectsDir, name);
    const existing = await readOrigin(dir);
    if (existing !== null && existing !== origin) {
      return {
        kind: "disabled",
        reason:
          `Projects/${vaultName(name)} belongs to ${quoted(existing)}, but this repository is ${origin ?? "without an origin"}: ` +
          "rename one of them, or run the repo-rename procedure (see README)",
      };
    }
    return { kind: "ok", name, origin, dir };
  } catch (err) {
    if (err instanceof UnreadableClaimError) return { kind: "disabled", reason: err.message };
    throw err;
  }
}

// Written once, on first use; never overwritten. createAt's temp sibling + link
// means a crash between create and write never leaves an empty, permanently-torn
// .origin; a false return means another writer recorded it first.
export async function recordOrigin(projectDir: string, origin: string): Promise<void> {
  await createAt(join(projectDir, "remember", ORIGIN_FILE), `${origin}\n`);
}
