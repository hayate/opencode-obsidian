// Spec 4.4: vault file access for the current project. The config hook grants OpenCode's file
// tools the project's vault folder (an external_directory allow) before any session starts, and
// what it did is told in every session's status. A convenience compared on path strings, not
// isolation: symlinks are followed and bash has its own permission.
import { homedir } from "node:os";
import type { StatusItem } from "../../core/inject.ts";
import { resolveProject } from "../../core/project.ts";
import { errorText, quoted, vaultName } from "../../core/store.ts";
import { resolveVault } from "../../core/vault.ts";

export type Rules = Record<string, string>;

// Copies of OpenCode 1.18.32's Wildcard.match and of the home expansion it applies to a
// permission pattern key (its embedded source, quoted in the plan of 2026-09-24). Only the
// status line uses them; the grant's effect never depends on them.
export function wildcardMatch(str: string, pattern: string): boolean {
  const s = str.replaceAll("\\", "/");
  let p = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (p.endsWith(" .*")) p = `${p.slice(0, -3)}( .*)?`;
  return new RegExp(`^${p}$`, "s").test(s);
}

export function expandHome(pattern: string, home: string): string {
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "~") return home;
  if (pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

// OpenCode takes the last matching rule, and reads a map's rules in the order written. So the
// grant goes right after the user's blanket "*" (first when there is none), and every user rule
// keeps its place: one after the blanket still comes after the grant and decides where it
// matches, and nothing outside the project changes (the grant matches nothing there; moving the
// blanket would). The caller never passes a pattern the user already has (reassigning a key
// keeps its earlier place). A new object: the user's is shared.
export function withGrant(user: Rules, pattern: string): Rules {
  const out: Rules = {};
  if (!("*" in user)) out[pattern] = "allow";
  for (const [key, action] of Object.entries(user)) {
    out[key] = action;
    if (key === "*") out[pattern] = "allow";
  }
  return out;
}

// OpenCode's startup waits on the config hook: past this it adds no rule (spec 4.4).
export const GRANT_TIMEOUT_MS = 5_000;

// What the hook reads and replaces. The pinned SDK types (1.18.31) declare external_directory
// as one action only; OpenCode 1.18.32 takes a map of patterns too (measured), so the config is
// read structurally.
export type ConfigLike = { permission?: Record<string, unknown> };

// "off" with a reason: memory is disabled for the project as local state stands (the pull may
// still resolve it). With none: no usable vault (the plugin's load already tells it).
export type Found = { kind: "ok"; name: string; dir: string } | { kind: "off"; reason: string | null };
export type Resolve = (env: Record<string, string | undefined>, directory: string, timeoutMs: number) => Promise<Found>;

export interface VaultAccessInput {
  env: Record<string, string | undefined>;
  // The instance's directory, as OpenCode passes it to the plugin.
  directory: string;
  log: (level: StatusItem["level"], message: string) => Promise<void>;
  home?: string;
  timeoutMs?: number;
  resolve?: Resolve;
}

const NOT_ADDED = "the automatic grant was not added; your permission rules apply as they are";

// A user pattern is shown whole in a status line, up to this: its tail is what places it in the
// project, and quoted()'s default cap (120) would cut it.
const PATTERN_SHOWN = 1000;

// The project from local state, read-only: no pull, no folder created.
async function resolveLocal(env: Record<string, string | undefined>, directory: string, timeoutMs: number): Promise<Found> {
  let vault;
  try {
    vault = await resolveVault(env);
  } catch {
    return { kind: "off", reason: null };
  }
  const project = await resolveProject(vault, directory, { timeoutMs });
  return project.kind === "ok" ? { kind: "ok", name: project.name, dir: project.dir } : { kind: "off", reason: project.reason };
}

// The user's setting as ordered rules: a string is the blanket "*"; none is no rules; anything
// else is not a setting OpenCode reads as rules, and is left alone.
function userRules(value: unknown): Rules | null {
  if (value === undefined) return {};
  if (typeof value === "string") return { "*": value };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return { ...(value as Rules) };
  return null;
}

export class VaultAccess {
  private readonly input: VaultAccessInput;
  private granted: string | null = null;
  // Why local state refused the project at startup, when it did: a session whose pull then
  // finds a project is told the grant is missing.
  private refused: string | null = null;
  private told: StatusItem[] = [];

  constructor(input: VaultAccessInput) {
    this.input = input;
  }

  // The config hook. Never throws: what went wrong is a status line. The rule is set only here,
  // before the hook returns, so a resolution that ends after the bound adds nothing.
  async configure(cfg: ConfigLike): Promise<void> {
    const ms = this.input.timeoutMs ?? GRANT_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), ms);
      });
      const resolving = (this.input.resolve ?? resolveLocal)(this.input.env, this.input.directory, ms);
      const found = await Promise.race([resolving, late]);
      if (found === "late") return this.tell("warn", `vault file access: finding this project took longer than ${ms / 1000} s, so ${NOT_ADDED}`);
      if (found.kind === "off") {
        this.refused = found.reason;
        return;
      }
      if (/[*?\\]/.test(found.dir)) {
        return this.tell("warn", `vault file access: the path ${quoted(found.dir)} contains *, ? or \\, which OpenCode's permission patterns cannot match literally, so ${NOT_ADDED}`);
      }
      const pattern = `${found.dir}/**`;
      const user = userRules(cfg.permission?.external_directory);
      if (user === null) return this.tell("warn", `vault file access: permission.external_directory is neither an action nor a map of patterns, so ${NOT_ADDED}`);
      if (pattern in user) {
        return this.tell("warn", `vault file access: your permission.external_directory already has ${quoted(pattern, PATTERN_SHOWN)}, which decides it, so ${NOT_ADDED}`);
      }
      const rules = withGrant(user, pattern);
      // A user rule after the grant that takes something away in the project: one matching the
      // folder itself, or one naming a path inside it (any depth, hidden folders included). A
      // rule before the grant is before the blanket too, which already overrides it.
      const home = this.input.home ?? homedir();
      const named: string[] = [];
      const entries = Object.entries(rules);
      for (const [key, action] of entries.slice(entries.findIndex(([k]) => k === pattern) + 1)) {
        if (action === "allow") continue;
        const expanded = expandHome(key, home);
        if (wildcardMatch(`${found.dir}/*`, expanded) || expanded.startsWith(`${found.dir}/`)) {
          named.push(`vault file access: your permission.external_directory rule ${quoted(key, PATTERN_SHOWN)} (${action}) comes after the grant and applies where it matches in Projects/${vaultName(found.name)}`);
        }
      }
      // A new permission object: OpenCode's config merge shares nested objects with the cached
      // global config, so a change inside one would reach other directories' instances.
      cfg.permission = { ...(cfg.permission ?? {}), external_directory: rules };
      this.granted = found.name;
      for (const text of named) this.tell("warn", text);
    } catch (err) {
      // One status line: git's stderr can span several.
      this.tell("error", `vault file access: ${errorText(err).trim().replace(/\s*\n\s*/g, " ")}, so ${NOT_ADDED}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private tell(level: StatusItem["level"], text: string): void {
    this.told.push({ level, text });
    // Through a promise, so a log that throws at once is caught like one that rejects.
    void Promise.resolve()
      .then(() => this.input.log(level, text))
      .catch(() => undefined);
  }

  // What the hook did, for every session's status.
  lines(): StatusItem[] {
    return [...this.told];
  }

  // Spec 4.4: the grant is taken before the session-start pull settles the project. A session
  // whose settled project is another (or none) is told the grant names the wrong folder; one
  // whose project local state refused, and the pull then found, is told there is no grant.
  mismatch(settled: string | null): StatusItem | null {
    if (this.granted === null) {
      if (this.refused === null || settled === null) return null;
      return {
        level: "warn",
        text: `vault file access was not granted at startup (${this.refused}), and the sync then found this session's project, Projects/${vaultName(settled)}; restart OpenCode to grant it`,
      };
    }
    if (settled === this.granted) return null;
    const granted = `vault file access was granted for Projects/${vaultName(this.granted)} at startup`;
    // Memory off: the lines above say why and what to do; a restart is not always it.
    if (settled === null) return { level: "warn", text: `${granted}, but memory is off in this session (see the lines above)` };
    return { level: "warn", text: `${granted}, but this session's project is Projects/${vaultName(settled)}; restart OpenCode to move it` };
  }
}
