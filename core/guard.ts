// Spec 5.5, best effort: refuse a write or edit to a Projects/ file that changed
// since this session last saw it (a pull, Obsidian, another session). Not a
// compare-and-swap: an external writer can still slip in between the check and
// the tool's own write. It closes the realistic case, not every race.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";

export type GuardDecision = { allow: true } | { allow: false; message: string; conflictPath: string | null };

export const MAX_REFUSALS = 3;

export async function fileHash(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

export function conflictPathFor(path: string, sessionId: string): string {
  const ext = extname(path);
  return join(dirname(path), `${basename(path, ext)}.conflict-${sessionId.slice(0, 8)}${ext}`);
}

export class WriteGuard {
  private readonly root: string;
  private readonly seen = new Map<string, Map<string, string | null>>();
  private readonly refusals = new Map<string, number>();

  constructor(projectsDir: string) {
    this.root = resolve(projectsDir) + sep;
  }

  guards(path: string): boolean {
    return resolve(path).startsWith(this.root);
  }

  private remember(sessionId: string, path: string, hash: string | null): void {
    let paths = this.seen.get(sessionId);
    if (!paths) this.seen.set(sessionId, (paths = new Map()));
    paths.set(resolve(path), hash);
    this.refusals.delete(`${sessionId}\0${resolve(path)}`);
  }

  // Call around a read. A file that changed while it was being read is not
  // recorded as seen: the model may hold a version that never existed on disk.
  async beforeRead(path: string): Promise<string | null> {
    return this.guards(path) ? fileHash(path) : null;
  }

  async afterRead(sessionId: string, path: string, before: string | null): Promise<void> {
    if (!this.guards(path)) return;
    const after = await fileHash(path);
    if (after === before) this.remember(sessionId, path, after);
  }

  async afterWrite(sessionId: string, path: string): Promise<void> {
    if (this.guards(path)) this.remember(sessionId, path, await fileHash(path));
  }

  async check(sessionId: string, path: string): Promise<GuardDecision> {
    if (!this.guards(path)) return { allow: true };
    const current = await fileHash(path);
    if (current === null) return { allow: true }; // a new file
    const key = resolve(path);
    const known = this.seen.get(sessionId)?.get(key);
    if (known === current) return { allow: true };
    const count = (this.refusals.get(`${sessionId}\0${key}`) ?? 0) + 1;
    this.refusals.set(`${sessionId}\0${key}`, count);
    if (count >= MAX_REFUSALS) {
      const conflictPath = conflictPathFor(path, sessionId);
      return {
        allow: false,
        conflictPath,
        message:
          `${path} keeps changing underneath this session. Write your version to ${conflictPath} ` +
          "instead, and tell the user both files need reconciling.",
      };
    }
    return {
      allow: false,
      conflictPath: null,
      message: `${path} ${known === undefined ? "was never read by this session" : "changed since you last read it"} - read it again before writing.`,
    };
  }
}
