// The remember/ store (spec 6): collision-proof file creation, frontmatter, and
// handoffs as a history graph whose heads are what a session sees.
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";
import { parse, stringify } from "yaml";
import { acquireLock } from "./lock.ts";
import { fileStamp, isoWithOffset } from "./time.ts";

export interface HandoffMeta {
  project: string;
  branch: string;
  machine: string;
  session: string;
  written: string;
  supersedes: string[];
}

export interface Handoff {
  id: string;
  path: string;
  meta: HandoffMeta | null; // null when the frontmatter is malformed
  body: string;
  problem: string | null;
}

export interface Heads {
  byBranch: Map<string, Handoff[]>;
  problems: string[];
}

export const MALFORMED_BRANCH = "(malformed)";

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

const STATUS_TEXT_MAX = 120;

// A string read from the vault, shown inside plugin text such as a status line
// (which sits outside the payload's data block): quoted, escaped (JSON, plus the
// line and format characters JSON leaves raw) and capped, so it can neither pass
// for plugin text nor add lines of its own.
export function quoted(value: string): string {
  const chars = [...value];
  const short = chars.length > STATUS_TEXT_MAX ? `${chars.slice(0, STATUS_TEXT_MAX - 3).join("")}...` : value;
  return JSON.stringify(short).replace(/[\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}

// The built-in kinds, which are what a bug of ours throws: their message says what went
// wrong but never where it came from, so "sync aborted: x is not a function" could be read
// as a bad repository. The plugin's own classes (git.ts's GitError and its subclasses,
// this file's MemoryPathError) write their whole message for the user, spec 5.6's
// stranded-lock sentence among them, so naming their kind would only get in the way.
const BUG_KINDS = new Set(["TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError"]);

// What a thrown value says, for a status line. A catch-all catches whatever was thrown,
// and `(err as Error).message` on a value that is not an Error (a string, a rejected
// promise's value, a null from a library) renders "sync aborted: undefined", which says
// nothing at all.
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return BUG_KINDS.has(err.name) ? `${err.name}: ${err.message}` : err.message;
}

// A folder name from the vault, shown as is when it is plain, quoted otherwise.
export function vaultName(name: string): string {
  return /^[^\p{Cc}\p{Cf}\u2028\u2029`]{1,120}$/u.test(name) ? name : quoted(name);
}

export function sanitizeKey(value: string): string {
  return value.replace(/\//g, "--").replace(/[^A-Za-z0-9._-]/g, "-");
}

export function branchKey(branch: string | null, headSha: string | null): string {
  if (branch) return sanitizeKey(branch);
  return `detached-${(headSha ?? "unknown").slice(0, 7)}`;
}

export function renderDoc(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export function parseDoc(text: string): { frontmatter: Record<string, unknown> | null; body: string; problem: string | null } {
  if (!text.startsWith("---\n")) return { frontmatter: null, body: text, problem: "no frontmatter" };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: text, problem: "unterminated frontmatter" };
  const body = text.slice(end + 5).trim();
  try {
    const value: unknown = parse(text.slice(4, end));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { frontmatter: null, body, problem: "frontmatter is not a mapping" };
    }
    return { frontmatter: value as Record<string, unknown>, body, problem: null };
  } catch (err) {
    return { frontmatter: null, body, problem: `frontmatter does not parse: ${(err as Error).message.split("\n")[0]}` };
  }
}

// Create a new file without ever overwriting: write a hidden temp sibling, then
// hard-link it to the final name (link fails if the name exists; retry).
export async function createExclusive(dir: string, makeName: (rand: string) => string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${randomHex(8)}.sro-tmp`);
  await writeFile(tmp, content, { flag: "wx" });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const target = join(dir, makeName(randomHex(2)));
      try {
        await link(tmp, target);
        return target;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new Error(`could not create a unique file in ${dir}`);
  } finally {
    await rm(tmp, { force: true });
  }
}

// Create a file at a fixed path without ever overwriting: write a hidden temp
// sibling, then hard-link it to the final name (link fails if the name exists).
// Returns whether this call created the file; when it did not, the existing
// file is left untouched.
export async function createAt(path: string, content: string): Promise<boolean> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomHex(4)}.sro-tmp`);
  await writeFile(tmp, content);
  try {
    await link(tmp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  } finally {
    await rm(tmp, { force: true });
  }
}

// Rewrite a plugin-owned file: temp sibling, then a checked rename.
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${randomHex(4)}.sro-tmp`);
  await writeFile(tmp, content);
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// A memory path that exists but cannot be used: an I/O failure, or a refusal by
// the read boundary below (`boundary`). `why` is short and never raw vault text
// (an errno code, or which part is a link, named through vaultName), so the
// message can go into a status line.
export class MemoryPathError extends Error {
  readonly why: string;
  readonly boundary: boolean;
  constructor(rel: string, verb: "read" | "listed" | "written", why: string, boundary = false) {
    super(`${rel} cannot be ${verb} (${why})`);
    this.name = "MemoryPathError";
    this.why = why;
    this.boundary = boundary;
  }
}

const errno = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? "error";

function linkWhy(parts: string[], i: number): string {
  if (i === 0) return "the project folder is a symbolic link";
  if (i === parts.length) return "a symbolic link";
  return `${vaultName(parts.slice(0, i).join("/"))} is a symbolic link`;
}

// Spec 4.4 / 7.5: memory is read from the current project only. Git keeps
// symlinks (mode 120000), so a link committed on another machine arrives here,
// and a read that followed it would put its target (a credentials file, another
// project's memory) into the payload. So: no part of the path from the project
// folder down may be a symbolic link (lstat, part by part), and its real path
// must stay inside the project's. False when a part is missing.
async function checkBoundary(projectDir: string, rel: string, verb: "read" | "listed" | "written"): Promise<boolean> {
  const parts = rel.split("/").filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    let isLink: boolean;
    try {
      isLink = (await lstat(join(projectDir, ...parts.slice(0, i)))).isSymbolicLink();
    } catch (err) {
      if (errno(err) === "ENOENT") return false;
      throw new MemoryPathError(rel, verb, errno(err));
    }
    if (isLink) throw new MemoryPathError(rel, verb, linkWhy(parts, i), true);
  }
  let base: string;
  let real: string;
  try {
    base = await realpath(projectDir);
    real = await realpath(join(projectDir, rel));
  } catch (err) {
    if (errno(err) === "ENOENT") return false;
    throw new MemoryPathError(rel, verb, errno(err));
  }
  if (real !== base && !real.startsWith(base + sep)) throw new MemoryPathError(rel, verb, "resolves outside the project", true);
  return true;
}

// Every memory read goes through these two. A missing folder has no entries and
// a missing file is null; any other failure is an error, never "empty": a folder
// that cannot be listed is not an empty one.
export async function listMemoryDir(projectDir: string, rel: string): Promise<string[]> {
  if (!(await checkBoundary(projectDir, rel, "listed"))) return [];
  try {
    return await readdir(join(projectDir, rel));
  } catch (err) {
    if (errno(err) === "ENOENT") return [];
    throw new MemoryPathError(rel, "listed", errno(err));
  }
}

export async function readMemoryFile(projectDir: string, rel: string): Promise<string | null> {
  if (!(await checkBoundary(projectDir, rel, "read"))) return null;
  // O_NOFOLLOW: a link swapped in after the check fails to open (ELOOP).
  let handle;
  try {
    handle = await open(join(projectDir, rel), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (errno(err) === "ENOENT") return null;
    if (errno(err) === "ELOOP") throw new MemoryPathError(rel, "read", "a symbolic link", true);
    throw new MemoryPathError(rel, "read", errno(err));
  }
  try {
    return await handle.readFile("utf8");
  } catch (err) {
    throw new MemoryPathError(rel, "read", errno(err));
  } finally {
    await handle.close();
  }
}

// Writers check the folder they write into the same way: a synced link must not
// send a write out of the project either. Missing parts are fine; the writer
// creates them.
export async function checkMemoryDir(projectDir: string, rel: string): Promise<void> {
  await checkBoundary(projectDir, rel, "written");
}

function toMeta(fm: Record<string, unknown>): HandoffMeta | string {
  const { branch, written, supersedes } = fm;
  if (typeof branch !== "string" || !branch) return "missing branch";
  if (typeof written !== "string" || !written) return "missing written";
  if (!Array.isArray(supersedes) || !supersedes.every((s) => typeof s === "string")) {
    return "supersedes must be a list of handoff ids";
  }
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    project: text(fm.project),
    branch,
    machine: text(fm.machine),
    session: text(fm.session),
    written,
    supersedes: supersedes as string[],
  };
}

function readHandoff(path: string, text: string): Handoff {
  const id = basename(path, ".md");
  const doc = parseDoc(text);
  if (!doc.frontmatter) return { id, path, meta: null, body: doc.body, problem: doc.problem };
  const meta = toMeta(doc.frontmatter);
  if (typeof meta === "string") return { id, path, meta: null, body: doc.body, problem: meta };
  return { id, path, meta, body: doc.body, problem: null };
}

// A file that cannot be read (or vanished since it was listed) never hides the
// others: it becomes a handoff with a problem, shown as its own head.
function unreadable(id: string, path: string, err: unknown): Handoff {
  const why = err instanceof MemoryPathError ? err.why : (err as Error).message;
  return { id, path, meta: null, body: "", problem: `cannot be read (${why})` };
}

// Throws when the handoffs folder exists but cannot be listed (session.ts reports
// it; writeHandoff must not write as if there were no heads).
export async function listHandoffs(projectDir: string, opts: { includeLegacyRoot?: boolean } = {}): Promise<Handoff[]> {
  const out: Handoff[] = [];
  for (const name of await listMemoryDir(projectDir, "remember/handoffs")) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    const rel = `remember/handoffs/${name}`;
    const path = join(projectDir, rel);
    try {
      const text = await readMemoryFile(projectDir, rel);
      out.push(text === null ? unreadable(basename(name, ".md"), path, new MemoryPathError(rel, "read", "ENOENT")) : readHandoff(path, text));
    } catch (err) {
      out.push(unreadable(basename(name, ".md"), path, err));
    }
  }
  if (opts.includeLegacyRoot) {
    // Before migration (spec 4.5) the root HANDOFF.md is the project's single handoff.
    const root = join(projectDir, "HANDOFF.md");
    let text: string | null = null;
    try {
      text = await readMemoryFile(projectDir, "HANDOFF.md");
    } catch (err) {
      out.push(unreadable("HANDOFF", root, err));
    }
    if (text !== null) {
      out.push({
        id: "HANDOFF",
        path: root,
        meta: { project: basename(projectDir), branch: "legacy", machine: "", session: "", written: "", supersedes: [] },
        body: text.trim(),
        problem: null,
      });
    }
  }
  return out;
}

// Heads: valid handoffs no valid handoff supersedes. The rules only ever keep
// more heads visible, never fewer: a malformed file cannot hide a valid one, an
// unknown reference is ignored, and every member of a cycle is a head. Problems
// become status lines, so every vault string in them is quoted.
export function computeHeads(handoffs: Handoff[]): Heads {
  const problems: string[] = [];
  const valid = new Map<string, HandoffMeta>();
  for (const h of handoffs) {
    if (h.meta) valid.set(h.id, h.meta);
    else problems.push(`handoff ${quoted(h.id)} is malformed (${quoted(h.problem ?? "")}); shown as its own head`);
  }
  const superseded = new Set<string>();
  for (const [id, meta] of valid) {
    for (const parent of meta.supersedes) {
      if (valid.has(parent)) superseded.add(parent);
      else problems.push(`handoff ${quoted(id)} supersedes unknown ${quoted(parent)}`);
    }
  }
  const inCycle = new Set<string>();
  for (const start of valid.keys()) {
    const stack = [...(valid.get(start)?.supersedes ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === start) {
        inCycle.add(start);
        break;
      }
      if (seen.has(id) || !valid.has(id)) continue;
      seen.add(id);
      stack.push(...(valid.get(id)?.supersedes ?? []));
    }
  }
  if (inCycle.size) {
    problems.push(`supersedes cycle among ${[...inCycle].sort().map((id) => quoted(id)).join(", ")}; all shown as heads`);
  }

  const byBranch = new Map<string, Handoff[]>();
  for (const h of handoffs) {
    const isHead = !h.meta || !superseded.has(h.id) || inCycle.has(h.id);
    if (!isHead) continue;
    const branch = h.meta?.branch ?? MALFORMED_BRANCH;
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), h]);
  }
  for (const list of byBranch.values()) {
    list.sort((a, b) => (b.meta?.written ?? "").localeCompare(a.meta?.written ?? "") || a.id.localeCompare(b.id));
  }
  return { byBranch, problems };
}

export interface WriteHandoffInput {
  projectDir: string;
  lockDir: string;
  project: string;
  branch: string;
  branchKey: string;
  machine: string;
  session: string;
  timezone: string;
  now: Date;
  body: string;
  seenHeadIds: ReadonlySet<string>;
}

export type WriteHandoffResult =
  | { kind: "written"; handoff: Handoff; superseded: string[] }
  | { kind: "refused"; unseen: Handoff[] };

export async function writeHandoff(input: WriteHandoffInput): Promise<WriteHandoffResult> {
  const lock = await acquireLock(input.lockDir, { waitMs: 10_000 });
  if (!lock) throw new Error(`handoff lock ${input.lockDir} is busy`);
  try {
    const heads = computeHeads(await listHandoffs(input.projectDir)).byBranch.get(input.branch) ?? [];
    const unseen = heads.filter((h) => !input.seenHeadIds.has(h.id));
    if (unseen.length) return { kind: "refused", unseen };
    const supersedes = heads.map((h) => h.id);
    const content = renderDoc(
      {
        type: "handoff",
        project: input.project,
        branch: input.branch,
        machine: input.machine,
        session: input.session,
        written: isoWithOffset(input.now, input.timezone),
        supersedes,
      },
      input.body,
    );
    const stamp = fileStamp(input.now, input.timezone);
    const session8 = sanitizeKey(input.session.slice(0, 8));
    const path = await createExclusive(
      join(input.projectDir, "remember", "handoffs"),
      (rand) => `${stamp}-${input.branchKey}-${session8}-${rand}.md`,
      content,
    );
    return { kind: "written", handoff: readHandoff(path, content), superseded: supersedes };
  } finally {
    await lock.release();
  }
}
