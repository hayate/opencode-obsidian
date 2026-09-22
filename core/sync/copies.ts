// Spec 5.4 step 3: where a conflict puts the version that does not stay at the
// path. Names are git paths (forward slashes), checked against the tree being
// built, never against the disk.
import { fileStamp } from "../time.ts";

const NAME_MAX = 255;
const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

// Case and normalization twins share one file on macOS. The generated suffix is
// ASCII, so lower-casing after NFC is enough to find the twin of a copy's name.
export const fold = (path: string): string => path.normalize("NFC").toLowerCase();

// The conflict time in the name: minutes, in the vault timezone.
export function conflictStamp(date: Date, timeZone: string): string {
  return fileStamp(date, timeZone).replace("T", "-").slice(0, 15);
}

// The longest prefix of s within max UTF-8 bytes, whole characters only.
function cutBytes(s: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const size = byteLength(ch);
    if (used + size > max) break;
    out += ch;
    used += size;
  }
  return out;
}

function splitExtension(base: string): [string, string] {
  const dot = base.lastIndexOf(".");
  return dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
}

// <stem>.conflict-<when>-<6 hex><ext> beside original; -2, -3 ... while taken. The
// budget is recomputed for every candidate; when not even one stem character fits
// (a very long extension) the name falls back to conflict-<12 hex>.
export function copyPath(original: string, oid: string, when: string, taken: (path: string) => boolean): string {
  const slash = original.lastIndexOf("/");
  const dir = original.slice(0, slash + 1);
  const [stem, ext] = splitExtension(original.slice(slash + 1));
  for (let n = 1; ; n++) {
    const count = n > 1 ? `-${n}` : "";
    const suffix = `.conflict-${when}-${oid.slice(0, 6)}${count}`;
    const kept = cutBytes(stem, NAME_MAX - byteLength(suffix) - byteLength(ext));
    const name = kept ? `${kept}${suffix}${ext}` : `conflict-${oid.slice(0, 12)}${count}`;
    if (!taken(dir + name)) return dir + name;
  }
}

// Anchored at the end of the name less its extension: a copy of a copy carries two
// suffixes, and only the one nearest the extension is the copy's own.
const COPY_SUFFIX = /\.conflict-\d{4}-\d{2}-\d{2}-\d{4}-[0-9a-f]{6}(?:-\d+)?$/;
const FALLBACK = /^conflict-[0-9a-f]{12}(?:-\d+)?$/;
// ".conflict-YYYY-MM-DD-HHmm-" plus six hex: the suffix every copy name carries.
const SUFFIX_BYTES = 32;

// Whether candidate is a conflict copy of original: beside it, with its stem (or
// the stem cut to fit 255 bytes), a copy suffix and its extension. Dedupe (spec
// 5.4 step 3) needs the original, not just the folder: two notes with the same
// content still get a copy each.
export function isCopyOf(original: string, candidate: string): boolean {
  const slash = original.lastIndexOf("/");
  const dir = original.slice(0, slash + 1);
  if (!candidate.startsWith(dir)) return false;
  const name = candidate.slice(dir.length);
  if (name.includes("/")) return false;
  const [stem, ext] = splitExtension(original.slice(slash + 1));
  if (FALLBACK.test(name)) return cutBytes(stem, NAME_MAX - SUFFIX_BYTES - byteLength(ext)) === "";
  if (!name.endsWith(ext)) return false;
  const match = COPY_SUFFIX.exec(name.slice(0, name.length - ext.length));
  if (!match) return false;
  const prefix = name.slice(0, match.index);
  if (prefix === stem) return true;
  // A cut stem fills the budget: the next character (at most 4 bytes) did not fit.
  return prefix !== "" && stem.startsWith(prefix) && byteLength(name) > NAME_MAX - 4;
}

// Every path of a tree, folders included, plus the ones added while resolving.
export class TreeNames {
  private readonly exact = new Set<string>();
  private readonly folded = new Set<string>();

  constructor(paths: Iterable<string>) {
    for (const path of paths) this.add(path);
  }

  add(path: string): void {
    this.exact.add(path);
    this.folded.add(fold(path));
  }

  taken(path: string): boolean {
    return this.exact.has(path) || this.folded.has(fold(path));
  }
}
