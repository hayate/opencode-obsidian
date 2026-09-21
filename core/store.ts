// The remember/ store (spec 6): collision-proof file creation, frontmatter, and
// handoffs as a history graph whose heads are what a session sees.
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
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

export async function listHandoffs(projectDir: string, opts: { includeLegacyRoot?: boolean } = {}): Promise<Handoff[]> {
  const dir = join(projectDir, "remember", "handoffs");
  const out: Handoff[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    const path = join(dir, name);
    out.push(readHandoff(path, await readFile(path, "utf8")));
  }
  if (opts.includeLegacyRoot) {
    // Before migration (spec 4.5) the root HANDOFF.md is the project's single handoff.
    const root = join(projectDir, "HANDOFF.md");
    const text = await readFile(root, "utf8").catch(() => null);
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
