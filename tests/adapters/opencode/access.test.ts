import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expandHome, GRANT_TIMEOUT_MS, VaultAccess, wildcardMatch, withGrant, type ConfigLike, type Found } from "../../../adapters/opencode/access.ts";
import { gitOk } from "../../../core/git.ts";
import { commitFile, initRepo, tempDir } from "../../core/helpers.ts";

// Expectations come from OpenCode 1.18.32 (its source, quoted in the plan, and the live runs of
// spec 4.4), never from this copy.
const V = "/Users/a/Documents/Da Vinci";
const P = `${V}/Projects/kabin-api`;

test("the matcher: the measured cases of spec 4.4", () => {
  assert.equal(wildcardMatch(`${P}/*`, `${P}/**`), true, "the project root's ask");
  assert.equal(wildcardMatch(`${P}/remember/journal/*`, `${P}/**`), true, "every depth");
  assert.equal(wildcardMatch(`${V}/Projects/kabin-api-other/*`, `${P}/**`), false, "a same-prefix sibling");
  assert.equal(wildcardMatch(`${V}/Articles/*`, `${P}/**`), false, "the rest of the vault");
  assert.equal(wildcardMatch(`/private/tmp/vlink/Projects/kabin-api/*`, `/private/tmp/real/Projects/kabin-api/**`), false, "strings, never resolved");
});

test("the matcher: its source's details", () => {
  assert.equal(wildcardMatch("a\\b/c", "a/b/*"), true, "backslashes read as slashes on the path side");
  assert.equal(wildcardMatch("a/b/c", "a\\b\\*"), true, "and on the pattern side");
  assert.equal(wildcardMatch("x(1)+[y]/z", "x(1)+[y]/*"), true, "regex characters are literal");
  assert.equal(wildcardMatch("ab", "a?"), true, "? is one character");
  assert.equal(wildcardMatch("abc", "a?"), false);
  assert.equal(wildcardMatch("a\nb", "a*"), true, "* crosses a newline (the s flag)");
  assert.equal(wildcardMatch("ls", "ls *"), true, "a trailing ' *' is optional");
  assert.equal(wildcardMatch("ls -la", "ls *"), true);
  assert.equal(wildcardMatch("/A/b", "/a/*"), false, "case-sensitive");
  assert.equal(wildcardMatch("x/a/b", "a/*"), false, "the whole string");
});

test("home expansion: OpenCode's four prefixes, and nothing else", () => {
  assert.equal(expandHome("~/Documents/**", "/Users/a"), "/Users/a/Documents/**");
  assert.equal(expandHome("~", "/Users/a"), "/Users/a");
  assert.equal(expandHome("$HOME/Documents/**", "/Users/a"), "/Users/a/Documents/**");
  assert.equal(expandHome("$HOMELESS/x", "/Users/a"), "/Users/aLESS/x", "any $HOME prefix, as OpenCode does");
  assert.equal(expandHome("${HOME}/x", "/Users/a"), "${HOME}/x");
  assert.equal(expandHome("~user/x", "/Users/a"), "~user/x");
});

test("the grant goes after the user's blanket and before every other user rule, in a new object", () => {
  const user = { "*": "ask", [`${V}/Projects/**`]: "deny", "/srv/**": "allow" };
  const built = withGrant(user, `${P}/**`);
  assert.deepEqual(Object.entries(built), [["*", "ask"], [`${P}/**`, "allow"], [`${V}/Projects/**`, "deny"], ["/srv/**", "allow"]]);
  assert.notEqual(built, user);
  assert.deepEqual(Object.keys(user), ["*", `${V}/Projects/**`, "/srv/**"], "the user's object is untouched");
  assert.deepEqual(Object.entries(withGrant({}, `${P}/**`)), [[`${P}/**`, "allow"]], "no setting: the grant alone");
});

// The plugin reads process.env in production: no test may reach this machine's vault.
delete process.env.OBSIDIAN_VAULT_PATH;

const found = (over: Partial<Extract<Found, { kind: "ok" }>> = {}): Found => ({ kind: "ok", name: "kabin-api", dir: P, ...over });
const NOT_ADDED = "the automatic grant was not added; your permission rules apply as they are";
const named = (rule: string, action: string, repo = "kabin-api") =>
  `vault file access: your permission.external_directory rule "${rule}" (${action}) comes after the grant and applies where it matches in Projects/${repo}`;

function access(result: () => Promise<Found>, extra: { timeoutMs?: number } = {}) {
  const logged: string[] = [];
  const a = new VaultAccess({
    env: {},
    directory: "/code/kabin-api",
    home: "/Users/a",
    log: async (level, m) => void logged.push(`${level}: ${m}`),
    resolve: result,
    timeoutMs: extra.timeoutMs,
  });
  return { a, logged };
}
const ok = (over: Partial<Extract<Found, { kind: "ok" }>> = {}) => access(async () => found(over));

// OpenCode's evaluate over one rule map: the last rule whose pattern matches, else ask.
const decide = (rules: Record<string, string>, path: string): string =>
  Object.entries(rules).filter(([pattern]) => wildcardMatch(path, pattern)).at(-1)?.[1] ?? "ask";

test("the grant goes right after the user's blanket wherever it is, and nothing outside the project changes", () => {
  const cases: Array<[Record<string, string>, string]> = [
    [{ "/srv/**": "allow", "*": "deny" }, "/srv/x/*"],
    [{ [`${V}/Projects/**`]: "deny", "*": "ask" }, `${V}/Projects/other/*`],
    [{ "*": "ask", "/srv/**": "deny" }, "/srv/x/*"],
  ];
  for (const [user, outside] of cases) {
    const built = withGrant(user, `${P}/**`);
    assert.equal(decide(built, outside), decide(user, outside), `${JSON.stringify(user)} at ${outside}`);
    const keys = Object.keys(built);
    assert.deepEqual(keys.filter((k) => k !== `${P}/**`), Object.keys(user), "the user's rules keep their order");
    assert.equal(keys.indexOf(`${P}/**`), keys.indexOf("*") + 1, "right after the blanket");
  }
});

test("vault access: a rule before the user's blanket is not named (the blanket already overrides it)", async () => {
  const { a } = ok();
  const cfg: ConfigLike = { permission: { external_directory: { [`${P}/notes/**`]: "deny", "*": "ask" } } };
  await a.configure(cfg);
  assert.deepEqual(Object.keys(cfg.permission?.external_directory as object), [`${P}/notes/**`, "*", `${P}/**`]);
  assert.deepEqual(a.lines(), []);
});

test("vault access: a long user pattern is named whole", async () => {
  const { a } = ok();
  const long = `${P}/${"x".repeat(200)}/**`;
  await a.configure({ permission: { external_directory: { [long]: "deny" } } });
  assert.ok(a.lines()[0]?.text.includes(JSON.stringify(long)), a.lines()[0]?.text);
});

test("vault access: an error that spans lines is one status line, logged as an error", async () => {
  const { a, logged } = access(async () => {
    throw new Error("fatal: one\n  hint: two\n");
  });
  await a.configure({});
  assert.deepEqual(a.lines(), [{ level: "error", text: `vault file access: fatal: one hint: two, so ${NOT_ADDED}` }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logged, [`error: vault file access: fatal: one hint: two, so ${NOT_ADDED}`]);
});

test("vault access, for real: a directory with no name to give a project (/) is granted nothing", async () => {
  const root = join(await tempDir("sro-access-"), "Da Vinci");
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Projects"));
  const a = new VaultAccess({ env: { OBSIDIAN_VAULT_PATH: root }, directory: "/", log: async () => undefined });
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  assert.equal(cfg.permission, undefined, "never all of Projects/");
});

test("vault access: no setting, the grant alone, no status line", async () => {
  const { a } = ok();
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  assert.deepEqual(cfg.permission, { external_directory: { [`${P}/**`]: "allow" } });
  assert.deepEqual(a.lines(), []);
});

test("vault access: a string setting is the user's blanket, kept first", async () => {
  const { a } = ok();
  const cfg: ConfigLike = { permission: { external_directory: "ask", bash: "allow" } };
  await a.configure(cfg);
  assert.deepEqual(cfg.permission, { external_directory: { "*": "ask", [`${P}/**`]: "allow" }, bash: "allow" });
});

test("vault access: a blanket deny is overridden for the project too, in both forms (Andrea, 2026-09-24)", async () => {
  for (const setting of ["deny", { "*": "deny" }]) {
    const { a } = ok();
    const cfg: ConfigLike = { permission: { external_directory: setting } };
    await a.configure(cfg);
    assert.deepEqual(Object.entries(cfg.permission?.external_directory as object), [["*", "deny"], [`${P}/**`, "allow"]]);
    assert.deepEqual(a.lines(), [], "a blanket is not a rule about the project: nothing to tell");
  }
});

test("vault access: the user's own rules win, and each one about the project is named", async () => {
  const { a, logged } = ok();
  const cfg: ConfigLike = { permission: { external_directory: { "*": "ask", [`${P}/remember/**`]: "ask", [`${P}/specs/**`]: "allow" } } };
  await a.configure(cfg);
  assert.deepEqual(Object.keys(cfg.permission?.external_directory as object), ["*", `${P}/**`, `${P}/remember/**`, `${P}/specs/**`]);
  assert.deepEqual(a.lines(), [{ level: "warn", text: named(`${P}/remember/**`, "ask") }], "an allow takes nothing away: not named");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logged, [`warn: ${named(`${P}/remember/**`, "ask")}`], "logged at its own level");
});

test("vault access: a broad user deny over the project is named", async () => {
  const { a } = ok();
  await a.configure({ permission: { external_directory: { [`${V}/Projects/**`]: "deny" } } });
  assert.deepEqual(a.lines().map((l) => l.text), [named(`${V}/Projects/**`, "deny")]);
});

test("vault access: user rules on hidden and nested folders are named, rules elsewhere are not", async () => {
  const { a } = ok();
  await a.configure({
    permission: {
      external_directory: {
        [`${P}/.private/**`]: "deny",
        [`${P}/notes/private/**`]: "deny",
        [`${V}/Articles/**`]: "deny",
        "/srv/**": "ask",
        [`${V}/Projects/kabin-api-other/**`]: "deny",
        // A wildcard before the project's path: not named (spec 4.4), though it still decides.
        "/Users/*/Documents/Da Vinci/Projects/kabin-api/notes/**": "deny",
      },
    },
  });
  assert.deepEqual(a.lines().map((l) => l.text), [named(`${P}/.private/**`, "deny"), named(`${P}/notes/private/**`, "deny")]);
});

test("vault access: a user rule written with ~/ is expanded as OpenCode does", async () => {
  const { a } = ok();
  await a.configure({ permission: { external_directory: { "~/Documents/**": "ask" } } });
  // home is /Users/a and P is under /Users/a/Documents
  assert.deepEqual(a.lines().map((l) => l.text), [named("~/Documents/**", "ask")]);
});

test("vault access: the user's exact pattern is kept, no rule is added, and that is told", async () => {
  const { a } = ok();
  const user = { [`${V}/Projects/**`]: "allow", [`${P}/**`]: "deny" };
  const cfg: ConfigLike = { permission: { external_directory: user } };
  await a.configure(cfg);
  assert.equal(cfg.permission?.external_directory, user, "untouched");
  assert.deepEqual(a.lines(), [{ level: "warn", text: `vault file access: your permission.external_directory already has "${P}/**", which decides it, so ${NOT_ADDED}` }]);
  assert.equal(a.mismatch("kabin-api"), null, "nothing granted, nothing to compare");
});

test("vault access: a nested config object is never changed in place (two directories, one process)", async () => {
  // OpenCode's merge copies the top level and shares nested objects, and the global config is
  // cached: each instance's config is a top-level copy of the same global.
  const global = { permission: { external_directory: { "*": "ask" } as Record<string, string> } };
  const one = { ...global };
  const two = { ...global };
  await ok({ name: "one", dir: `${V}/Projects/one` }).a.configure(one);
  await ok({ name: "two", dir: `${V}/Projects/two` }).a.configure(two);
  assert.deepEqual(global.permission.external_directory, { "*": "ask" }, "the shared object is untouched");
  assert.deepEqual(Object.keys(two.permission.external_directory), ["*", `${V}/Projects/two/**`], "two carries only its own grant");
  assert.deepEqual(Object.keys(one.permission.external_directory), ["*", `${V}/Projects/one/**`]);
});

test("vault access: a path OpenCode cannot match literally gets no rule", async () => {
  for (const dir of [`${V}/Projects/a*b`, `${V}/Projects/a?b`, `${V}/Projects/a\\b`]) {
    const { a } = ok({ dir });
    const cfg: ConfigLike = {};
    await a.configure(cfg);
    assert.equal(cfg.permission, undefined, dir);
    assert.equal(a.lines()[0]?.text, `vault file access: the path ${JSON.stringify(dir)} contains *, ? or \\, which OpenCode's permission patterns cannot match literally, so ${NOT_ADDED}`);
  }
});

test("vault access: a setting that is neither an action nor a map is left alone and told", async () => {
  for (const value of [["x"], null, 3]) {
    const { a } = ok();
    const cfg: ConfigLike = { permission: { external_directory: value } };
    await a.configure(cfg);
    assert.equal(cfg.permission?.external_directory, value);
    assert.equal(a.lines()[0]?.text, `vault file access: permission.external_directory is neither an action nor a map of patterns, so ${NOT_ADDED}`);
  }
});

test("vault access: past the bound nothing is added, then or later, and the timeout is told", { timeout: 5_000 }, async () => {
  let finish!: (f: Found) => void;
  const pending = new Promise<Found>((resolve) => (finish = resolve));
  const { a } = access(() => pending, { timeoutMs: 30 });
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  finish(found());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cfg.permission, undefined);
  assert.equal(a.lines()[0]?.text, `vault file access: finding this project took longer than 0.03 s, so ${NOT_ADDED}`);
  assert.equal(GRANT_TIMEOUT_MS, 5000);
});

test("vault access: memory off adds nothing and says nothing", async () => {
  const { a } = access(async () => ({ kind: "off", reason: null }));
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  assert.equal(cfg.permission, undefined);
  assert.deepEqual(a.lines(), []);
  assert.equal(a.mismatch("kabin-api"), null, "no vault: the plugin's load already tells it");
});

test("vault access: a project refused before the pull and found by it is told the grant is missing", async () => {
  const { a } = access(async () => ({ kind: "off", reason: "origin x is claimed by several folders" }));
  await a.configure({});
  assert.deepEqual(a.lines(), [], "memory is off at startup: the session's own status says why");
  assert.equal(a.mismatch(null), null, "still off after the pull: nothing to add");
  assert.deepEqual(a.mismatch("kabin-api"), {
    level: "warn",
    text: "vault file access was not granted at startup (origin x is claimed by several folders), and the sync then found this session's project, Projects/kabin-api; restart OpenCode to grant it",
  });
});

test("vault access: a failure is an error line, never a throw", async () => {
  const { a } = access(async () => {
    throw new Error("boom");
  });
  await a.configure({});
  assert.deepEqual(a.lines(), [{ level: "error", text: `vault file access: boom, so ${NOT_ADDED}` }]);
});

test("vault access: a synchronous throw from the resolver or the log is still an error line, with no timer left", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timers();
  const throwing = new VaultAccess({
    env: {},
    directory: "/code/kabin-api",
    log: () => {
      throw new Error("log down");
    },
    resolve: () => {
      throw new Error("sync boom");
    },
    timeoutMs: 60_000,
  });
  await throwing.configure({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(throwing.lines(), [{ level: "error", text: `vault file access: sync boom, so ${NOT_ADDED}` }]);
  assert.equal(timers(), before, "the bound's timer is cleared");
});

test("vault access: a session whose project is not the granted one is told", async () => {
  const { a } = ok();
  await a.configure({});
  assert.equal(a.mismatch("kabin-api"), null);
  assert.equal(a.mismatch("canonical-a")?.text, "vault file access was granted for Projects/kabin-api at startup, but this session's project is Projects/canonical-a; restart OpenCode to move it");
  assert.equal(a.mismatch(null)?.text, "vault file access was granted for Projects/kabin-api at startup, but memory is off in this session (see the lines above)");
  assert.equal(a.mismatch(null)?.level, "warn");
});

test("vault access: odd names and patterns reach a status line quoted", async () => {
  const { a } = ok({ name: "we`ird" });
  await a.configure({ permission: { external_directory: { [`${P}/no\u0007tes/**`]: "deny" } } });
  const text = a.lines().map((l) => l.text).join("\n");
  assert.ok(!text.includes("\u0007"), text);
  assert.ok(text.includes("\\u0007"), text);
  assert.ok(text.endsWith('in Projects/"we`ird"'), text);
});

test("vault access, for real: a vault and a repository on disk (folder absent yet, a space in the path)", async () => {
  const root = join(await tempDir("sro-access-"), "Da Vinci");
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Projects"));
  const code = join(await tempDir(), "kabin-api");
  await initRepo(code);
  await commitFile(code, "README.md", "x\n", "init");
  await gitOk(["remote", "add", "origin", "git@github.com:hayate/kabin-api.git"], { cwd: code });
  const a = new VaultAccess({ env: { OBSIDIAN_VAULT_PATH: root }, directory: code, log: async () => undefined });
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  const dir = join(await realpath(root), "Projects", "kabin-api");
  assert.deepEqual(cfg.permission, { external_directory: { [`${dir}/**`]: "allow" } });
  assert.deepEqual(a.lines(), []);
  await assert.rejects(stat(dir), "read-only: the hook creates no folder");
});

test("vault access, for real: no vault set adds nothing and says nothing (the plugin's load already tells it)", async () => {
  const a = new VaultAccess({ env: {}, directory: "/nonexistent", log: async () => undefined });
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  assert.equal(cfg.permission, undefined);
  assert.deepEqual(a.lines(), []);
});

test("vault access: a rule matching the folder's own ask is named", async () => {
  const { a } = ok();
  await a.configure({ permission: { external_directory: { "*/kabin-api/*": "deny" } } });
  assert.deepEqual(a.lines().map((l) => l.text), [named("*/kabin-api/*", "deny")]);
});

test("vault access: the bound is 5 s by default, for the race and the git calls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let given = 0;
  const a = new VaultAccess({
    env: {},
    directory: "/code/kabin-api",
    log: async () => undefined,
    resolve: (_env, _dir, ms) => {
      given = ms;
      return new Promise<Found>(() => undefined);
    },
  });
  const done = a.configure({});
  t.mock.timers.tick(5000);
  await done;
  assert.equal(given, 5000);
  assert.equal(a.lines()[0]?.text, `vault file access: finding this project took longer than 5 s, so ${NOT_ADDED}`);
});

test("vault access, for real: a vault that fails at startup but works for the session is told the grant is missing", async () => {
  const a = new VaultAccess({ env: { OBSIDIAN_VAULT_PATH: "/nonexistent/vault" }, directory: "/code/kabin-api", log: async () => undefined });
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  assert.equal(cfg.permission, undefined);
  assert.deepEqual(a.lines(), [], "at startup the plugin's load already tells it");
  assert.equal(a.mismatch(null), null, "still off for the session: nothing to add");
  assert.match(a.mismatch("kabin-api")?.text ?? "", /^vault file access was not granted at startup \(OBSIDIAN_VAULT_PATH .*\), and the sync then found this session's project, Projects\/kabin-api; restart OpenCode to grant it$/);
});

test("vault access, for real: a project local state refuses (two folders claim it) is refused with its reason", async () => {
  const root = join(await tempDir("sro-access-"), "Da Vinci");
  for (const folder of ["one", "two"]) {
    await mkdir(join(root, "Projects", folder, "remember"), { recursive: true });
    await writeFile(join(root, "Projects", folder, "remember", ".origin"), "github.com/hayate/kabin-api\n");
  }
  await mkdir(join(root, ".obsidian"));
  const code = join(await tempDir(), "kabin-api");
  await initRepo(code);
  await commitFile(code, "README.md", "x\n", "init");
  await gitOk(["remote", "add", "origin", "git@github.com:hayate/kabin-api.git"], { cwd: code });
  const a = new VaultAccess({ env: { OBSIDIAN_VAULT_PATH: root }, directory: code, log: async () => undefined });
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  assert.equal(cfg.permission, undefined);
  assert.match(a.mismatch("one")?.text ?? "", /^vault file access was not granted at startup \(origin .* is claimed by several folders/);
});

test("vault access, for real: the pattern uses the resolved vault root, not a symlink's spelling", async () => {
  const root = join(await tempDir("sro-access-"), "Da Vinci");
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Projects"));
  const alias = join(await tempDir("sro-alias-"), "vault-link");
  await symlink(root, alias);
  const code = join(await tempDir(), "kabin-api");
  await initRepo(code);
  await commitFile(code, "README.md", "x\n", "init");
  const a = new VaultAccess({ env: { OBSIDIAN_VAULT_PATH: alias }, directory: code, log: async () => undefined });
  const cfg: ConfigLike = {};
  await a.configure(cfg);
  assert.deepEqual(Object.keys(cfg.permission?.external_directory as object), [`${join(await realpath(root), "Projects", "kabin-api")}/**`]);
});
