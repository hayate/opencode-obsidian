// Spec 4.4: vault file access for the current project. The config hook grants OpenCode's file
// tools the project's vault folder (an external_directory allow) before any session starts, and
// what it did is told in every session's status. A convenience compared on path strings, not
// isolation: symlinks are followed and bash has its own permission.

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
// user's blanket "*" comes first, the grant next, and every other user rule after it: a rule of
// theirs about the project decides there. The caller never passes a pattern the user already
// has (reassigning a key keeps its earlier place). A new object: the user's is shared.
export function withGrant(user: Rules, pattern: string): Rules {
  const out: Rules = {};
  if ("*" in user) out["*"] = user["*"] as string;
  out[pattern] = "allow";
  for (const [key, action] of Object.entries(user)) if (key !== "*") out[key] = action;
  return out;
}
