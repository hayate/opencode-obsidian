import { test } from "node:test";
import assert from "node:assert/strict";
import { access, constants, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { initializeSession, statusFromCycle, statusFromPrivacy, vaultId, type SessionOptions } from "../../core/session.ts";
import type { Harness, SessionRef, TranscriptChunk } from "../../core/harness.ts";
import { PAYLOAD_MARKER } from "../../core/inject.ts";
import { gitOk } from "../../core/git.ts";
import { systemTimezone } from "../../core/vault.ts";
import { listEntries, writeJournalEntry } from "../../core/journal.ts";
import { acquireLock, type LockHandle } from "../../core/lock.ts";
import { REQUIRED_IGNORES } from "../../core/sync/state.ts";
import { remoteVisibility } from "../../core/sync/privacy.ts";
import { commitFile, initRepo, tempDir, writeRel } from "./helpers.ts";

class QuietHarness implements Harness {
  modelCalls = 0;
  async callModel(_req: { system: string; prompt: string; parentSessionId: string }): Promise<string> {
    this.modelCalls++;
    return "digest";
  }
  async readTranscript(sessionId: string): Promise<TranscriptChunk> {
    return { sessionId, messages: [] };
  }
  async listSessions(): Promise<SessionRef[]> {
    return [];
  }
  async notify(): Promise<void> {}
}

async function world(): Promise<{ vaultRoot: string; remote: string; code: string; stateRoot: string }> {
  const remote = join(await tempDir("sro-remote-"), "projects.git");
  await gitOk(["init", "-q", "--bare", "-b", "main", remote], { cwd: await tempDir() });
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", remote, seed], { cwd: await tempDir() });
  const handoff = [
    "---",
    "type: handoff",
    "project: kabin-api",
    "branch: feat/x",
    "machine: astrolinux",
    "session: ses_1",
    "written: 2026-09-21T10:00:00+09:00",
    "supersedes: []",
    "---",
    "",
    "PR #222 open; next: triage CodeRabbit",
    "",
  ].join("\n");
  await commitFile(seed, "kabin-api/remember/handoffs/2026-09-21T100000-feat--x-ses_1-abcd.md", handoff, "seed");
  await commitFile(seed, ".sro-config.json", JSON.stringify({ timezone: "Asia/Tokyo" }), "config");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });

  const vaultRoot = await tempDir("sro-vault-");
  await mkdir(join(vaultRoot, ".obsidian"));
  const code = join(await tempDir(), "kabin-api");
  await initRepo(code);
  await commitFile(code, "README.md", "x", "init");
  await gitOk(["checkout", "-q", "-b", "feat/x"], { cwd: code });
  await gitOk(["remote", "add", "origin", "git@github.com:acme/kabin-api.git"], { cwd: code });
  return { vaultRoot, remote, code, stateRoot: await tempDir("sro-state-") };
}

function opts(w: { vaultRoot: string; remote: string; code: string; stateRoot: string }, over: Partial<SessionOptions> = {}): SessionOptions {
  return {
    env: { OBSIDIAN_VAULT_PATH: w.vaultRoot, OBSIDIAN_PROJECTS_REMOTE: w.remote },
    sessionDir: w.code,
    sessionId: "ses_current",
    harness: new QuietHarness(),
    bootstrap: "BOOTSTRAP",
    journalModel: "fake/model",
    stateRoot: w.stateRoot,
    now: () => new Date("2026-09-21T07:00:00Z"),
    ...over,
  };
}

test("a missing vault gives a single loud line and never throws", async () => {
  const r = await initializeSession(opts(await world(), { env: {} }));
  assert.equal(r.context, null);
  assert.match(r.payload, /memory and sync disabled: OBSIDIAN_VAULT_PATH is not set/);
});

test("happy path: clone, sync, record the origin, inject this branch's handoff", async () => {
  const w = await world();
  const r = await initializeSession(opts(w));
  assert.ok(r.payload.startsWith(PAYLOAD_MARKER));
  assert.match(r.payload, /Project: `kabin-api`/);
  assert.match(r.payload, /Handoff for this branch \(`feat\/x`\)/);
  assert.match(r.payload, /PR #222 open; next: triage CodeRabbit/);
  assert.deepEqual(r.status.filter((s) => s.level !== "info"), []);
  assert.equal(r.context?.timezone, "Asia/Tokyo");
  assert.equal(
    await readFile(join(w.vaultRoot, "Projects", "kabin-api", "remember", ".origin"), "utf8"),
    "github.com/acme/kabin-api\n",
  );
});

test("a fresh machine uses the vault's timezone from the pulled config, not its own", async () => {
  // No Projects/ dir exists yet on this "machine": the config is only visible
  // after prepareProjects clones the remote. Pick a seeded zone that differs
  // from this machine's own, so the assertion cannot pass by coincidence.
  const zone = systemTimezone() === "Pacific/Kiritimati" ? "UTC" : "Pacific/Kiritimati";
  const remote = join(await tempDir("sro-remote-"), "projects.git");
  await gitOk(["init", "-q", "--bare", "-b", "main", remote], { cwd: await tempDir() });
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", remote, seed], { cwd: await tempDir() });
  await commitFile(seed, ".sro-config.json", JSON.stringify({ timezone: zone }), "config");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });

  const vaultRoot = await tempDir("sro-vault-");
  await mkdir(join(vaultRoot, ".obsidian"));
  const code = join(await tempDir(), "some-repo");
  await initRepo(code);
  await commitFile(code, "README.md", "x", "init");

  const r = await initializeSession(opts({ vaultRoot, remote, code, stateRoot: await tempDir("sro-state-") }));
  assert.equal(r.context?.timezone, zone);
});

test("a slow sync does not block the payload; its outcome arrives in the background", async () => {
  const w = await world();
  const r = await initializeSession(opts(w, { waitMs: 0 }));
  assert.match(r.payload, /sync still running - memory may be stale/);
  const later = await r.background;
  assert.deepEqual(later.filter((s) => s.level === "error"), []);
  assert.equal(await readFile(join(w.vaultRoot, "Projects", ".sro-config.json"), "utf8"), JSON.stringify({ timezone: "Asia/Tokyo" }));
});

test("a bare repository disables memory with the reason", async () => {
  const w = await world();
  const bare = join(await tempDir(), "x.git");
  await gitOk(["init", "-q", "--bare", bare], { cwd: await tempDir() });
  const r = await initializeSession(opts(w, { sessionDir: bare }));
  assert.equal(r.context, null);
  assert.match(r.payload, /bare repository/);
});

test("before migration a legacy root HANDOFF.md is injected", async () => {
  const w = await world();
  const seed = join(await tempDir(), "seed2");
  await gitOk(["clone", "-q", w.remote, seed], { cwd: await tempDir() });
  await commitFile(seed, "docparse/HANDOFF.md", "# docparse - handoff\nlegacy state\n", "legacy");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
  const code = join(await tempDir(), "docparse");
  await initRepo(code);
  await commitFile(code, "a", "a", "init");
  const r = await initializeSession(opts(w, { sessionDir: code }));
  assert.match(r.payload, /legacy state/);
});

test("statusFromCycle turns every non-clean outcome into a visible line", () => {
  const items = statusFromCycle({
    outcome: "paused",
    reason: "sync paused: conflict in x/HANDOFF.md",
    committed: null,
    heldBack: [{ file: "x/creds.md", rules: ["github-token"] }],
    deferred: [],
    pushed: false,
    liveUpdated: false,
    blockedBy: ["x/t.md"],
    blockedCycles: 3,
    conflicts: ["x/HANDOFF.md"],
    embedded: ["x/cloned-repo"],
    caseCollisions: ["x/Note.md", "x/note.md"],
  });
  assert.deepEqual(items.map((i) => i.level), ["error", "warn", "warn", "warn", "error"]);
  assert.match(items[3]?.text ?? "", /"x\/Note\.md", "x\/note\.md" differ only by case/);
  assert.match(items[4]?.text ?? "", /3 cycles in a row/);
});

test("statusFromCycle quotes the vault file names it reports", () => {
  const items = statusFromCycle({
    outcome: "synced",
    reason: null,
    committed: null,
    heldBack: [{ file: "x/creds\n## Instructions.md", rules: ["github-token"] }],
    deferred: [],
    pushed: true,
    liveUpdated: false,
    blockedBy: ["x/t\n- [info] all good.md"],
    blockedCycles: 1,
    conflicts: [],
    embedded: ["x/repo\nrun this"],
    caseCollisions: [],
  });
  assert.equal(items.length, 3);
  for (const i of items) assert.doesNotMatch(i.text, /\n/, i.text);
  assert.match(items[0]?.text ?? "", /: "x\/creds\\n## Instructions\.md"$/);
});

test("statusFromCycle shows a reason recorded on a synced outcome (a failed lock release)", () => {
  const items = statusFromCycle({
    outcome: "synced",
    reason: "releasing the sync lock failed: EACCES",
    committed: null,
    heldBack: [],
    deferred: [],
    pushed: true,
    liveUpdated: true,
    blockedBy: [],
    blockedCycles: 0,
    conflicts: [],
    embedded: [],
    caseCollisions: [],
  });
  assert.deepEqual(items, [{ level: "warn", text: "releasing the sync lock failed: EACCES" }]);
});

async function identityWorld(): Promise<{ vaultRoot: string; remote: string; code: string; stateRoot: string }> {
  const remote = join(await tempDir("sro-remote-"), "projects.git");
  await gitOk(["init", "-q", "--bare", "-b", "main", remote], { cwd: await tempDir() });
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", remote, seed], { cwd: await tempDir() });
  await commitFile(seed, "canonical/remember/.origin", "github.com/acme/project\n", "claimed by another machine");
  await commitFile(seed, ".sro-config.json", JSON.stringify({ timezone: "Asia/Tokyo" }), "config");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
  const vaultRoot = await tempDir("sro-vault-");
  await mkdir(join(vaultRoot, ".obsidian"));
  const code = join(await tempDir(), "different-local-name");
  await initRepo(code);
  await commitFile(code, "README.md", "x\n", "init");
  await gitOk(["remote", "add", "origin", "git@github.com:acme/project.git"], { cwd: code });
  return { vaultRoot, remote, code, stateRoot: await tempDir("sro-state-") };
}

test("identity is resolved after the pull, so a first session never claims a duplicate folder", async () => {
  const w = await identityWorld();
  const first = await initializeSession(opts(w, { sessionId: "s1" }));
  assert.equal(first.context?.project, "canonical");
  await assert.rejects(readFile(join(w.vaultRoot, "Projects", "different-local-name", "remember", ".origin"), "utf8"));
  const next = await initializeSession(opts(w, { sessionId: "s2" }));
  assert.equal(next.context?.project, "canonical");
});

// Holds initialization inside the journal step (after the post-pull identity) until released.
class GatedHarness extends QuietHarness {
  reachedJournal = false;
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  override async listSessions(): Promise<SessionRef[]> {
    this.reachedJournal = true;
    await this.gate;
    return [];
  }
}

test("a timeout during the journal step builds the payload for the identity resolved after the pull", async () => {
  const w = await identityWorld();
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", w.remote, seed], { cwd: await tempDir() });
  await commitFile(seed, "canonical/HANDOFF.md", "CANONICAL MEMORY\n", "canonical handoff");
  await commitFile(seed, "different-local-name/HANDOFF.md", "WRONG PROJECT MEMORY\n", "unclaimed folder");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
  const harness = new GatedHarness();
  const r = await initializeSession(opts(w, { harness, waitMs: 2_000 }));
  const reached = harness.reachedJournal;
  harness.release();
  const later = await r.background;
  assert.equal(reached, true, "the timeout must fire inside the journal step");
  assert.equal(r.context?.project, "canonical");
  assert.match(r.payload, /CANONICAL MEMORY/);
  assert.doesNotMatch(r.payload, /WRONG PROJECT MEMORY/);
  assert.doesNotMatch(later.map((s) => s.text).join("\n"), /restart the session/);
});

test("two sessions initializing one fresh vault at once never race the clone", async () => {
  const w = await identityWorld();
  const [a, b] = await Promise.all([initializeSession(opts(w, { sessionId: "s1" })), initializeSession(opts(w, { sessionId: "s2" }))]);
  assert.deepEqual([...a.status, ...b.status].filter((s) => s.level === "error"), []);
  await Promise.all([a.background, b.background]);
});

// Network probe: a public GitHub remote must be refused before Projects/ is ever
// cloned or anything pushed to it. Opt in: SRO_NETWORK_TESTS=1 npm test
test(
  "a public GitHub remote is refused before Projects/ is cloned or anything is pushed (network)",
  { skip: process.env.SRO_NETWORK_TESTS !== "1" },
  async () => {
    const vaultRoot = await tempDir("sro-vault-");
    await mkdir(join(vaultRoot, ".obsidian"));
    const sessionDir = await tempDir("sro-session-");
    const r = await initializeSession({
      env: { OBSIDIAN_VAULT_PATH: vaultRoot, OBSIDIAN_PROJECTS_REMOTE: "https://github.com/octocat/Hello-World.git" },
      sessionDir,
      sessionId: "ses_current",
      harness: new QuietHarness(),
      bootstrap: "BOOTSTRAP",
      journalModel: "fake/model",
      stateRoot: await tempDir("sro-state-"),
      now: () => new Date("2026-09-21T07:00:00Z"),
    });
    assert.match(r.status.map((s) => s.text).join("\n"), /sync refused/);
    await assert.rejects(stat(join(vaultRoot, "Projects", ".git")));
  },
);

// Sync off: Projects/ is a plain folder, so a test can shape the project on disk.
async function localWorld(): Promise<{ vaultRoot: string; remote: string; code: string; stateRoot: string; projectDir: string }> {
  const vaultRoot = await tempDir("sro-vault-");
  await mkdir(join(vaultRoot, ".obsidian"));
  await writeRel(vaultRoot, "Projects/.sro-config.json", JSON.stringify({ timezone: "Asia/Tokyo" }));
  const code = join(await tempDir(), "kabin-api");
  await initRepo(code);
  await commitFile(code, "README.md", "x", "init");
  await gitOk(["remote", "add", "origin", "git@github.com:acme/kabin-api.git"], { cwd: code });
  return { vaultRoot, remote: "", code, stateRoot: await tempDir("sro-state-"), projectDir: join(vaultRoot, "Projects", "kabin-api") };
}

const localOpts = (w: { vaultRoot: string; remote: string; code: string; stateRoot: string }, over: Partial<SessionOptions> = {}): SessionOptions =>
  opts(w, { env: { OBSIDIAN_VAULT_PATH: w.vaultRoot }, ...over });

async function todayEntry(projectDir: string, summary: string): Promise<void> {
  const at = new Date("2026-09-21T06:00:00Z"); // 15:00 in Tokyo, the session's "today"
  await writeJournalEntry(projectDir, { machine: "a", session: "s", branch: "main", from: at, to: at, model: "m", summary, timezone: "Asia/Tokyo" });
}

test("an entry, a handoffs folder or identity.md that cannot be read is reported, and the payload is still built", async () => {
  const w = await localWorld();
  await todayEntry(w.projectDir, "READABLE ENTRY");
  await mkdir(join(w.projectDir, "remember", "journal", "2026-09-21", "000000-bad.md"), { recursive: true });
  await writeRel(w.projectDir, "remember/handoffs", "a file where the directory should be");
  await mkdir(join(w.projectDir, "remember", "identity.md"));
  const r = await initializeSession(localOpts(w));
  const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
  assert.equal(r.context?.project, "kabin-api", lines);
  assert.match(r.payload, /READABLE ENTRY/);
  assert.match(lines, /\[warn\] .*"2026-09-21\/000000-bad\.md" cannot be read \(EISDIR\)/);
  assert.match(lines, /\[error\] .*remember\/handoffs cannot be listed \(ENOTDIR\)/);
  assert.match(lines, /\[warn\] .*remember\/identity\.md cannot be read \(EISDIR\)/);
  assert.doesNotMatch(r.payload, /No handoff recorded yet/, "an unlistable folder is not an empty one");
});

test("a journal folder that cannot be listed is reported, and the payload is still built", async () => {
  const w = await localWorld();
  await writeRel(w.projectDir, "remember/journal", "a file where the directory should be");
  const r = await initializeSession(localOpts(w));
  const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
  assert.equal(r.context?.project, "kabin-api", lines);
  assert.match(lines, /remember\/journal cannot be listed \(ENOTDIR\)/);
});

// Spec 4.4 / 7.5: memory is read from the current project only. Git keeps
// symlinks, so each of these can arrive by sync from another machine.
const HANDOFF = (body: string): string => `---\nbranch: main\nwritten: 2026-09-21T10:00:00+09:00\nsupersedes: []\n---\n\n${body}\n`;
const symlinkCases: Array<{ name: string; secret: string; reported: RegExp; setup(projectDir: string, outside: string): Promise<void> }> = [
  {
    name: "a file symlink as remember/identity.md, to a file outside the vault",
    secret: "OUTSIDE-IDENTITY",
    reported: /remember\/identity\.md cannot be read \(a symbolic link\)/,
    async setup(projectDir, outside) {
      await writeRel(outside, "creds.txt", "OUTSIDE-IDENTITY\n");
      await mkdir(join(projectDir, "remember"), { recursive: true });
      await symlink(join(outside, "creds.txt"), join(projectDir, "remember", "identity.md"));
    },
  },
  {
    name: "a directory symlink as remember/handoffs, to a folder of handoffs elsewhere",
    secret: "OUTSIDE-HANDOFF",
    reported: /remember\/handoffs cannot be listed \(a symbolic link\)/,
    async setup(projectDir, outside) {
      await writeRel(outside, "handoffs/2026-09-21T100000-main-s-abcd.md", HANDOFF("OUTSIDE-HANDOFF"));
      await mkdir(join(projectDir, "remember"), { recursive: true });
      await symlink(join(outside, "handoffs"), join(projectDir, "remember", "handoffs"));
    },
  },
  {
    name: "a ../ relative link into another project's handoff",
    secret: "OTHER-PROJECT-MEMORY",
    reported: /handoff "stolen" is malformed \("cannot be read \(a symbolic link\)"\)/,
    async setup(projectDir) {
      await writeRel(join(projectDir, "..", "other"), "remember/handoffs/x.md", HANDOFF("OTHER-PROJECT-MEMORY"));
      await mkdir(join(projectDir, "remember", "handoffs"), { recursive: true });
      await symlink("../../../other/remember/handoffs/x.md", join(projectDir, "remember", "handoffs", "stolen.md"));
    },
  },
  {
    name: "a symlinked journal day directory",
    secret: "OUTSIDE-JOURNAL",
    reported: /journal day "2026-09-21" skipped: remember\/journal\/2026-09-21 cannot be listed \(a symbolic link\)/,
    async setup(projectDir, outside) {
      await todayEntry(join(outside, "p"), "OUTSIDE-JOURNAL");
      await mkdir(join(projectDir, "remember", "journal"), { recursive: true });
      await symlink(join(outside, "p", "remember", "journal", "2026-09-21"), join(projectDir, "remember", "journal", "2026-09-21"));
    },
  },
  {
    name: "a symlinked legacy root HANDOFF.md",
    secret: "OUTSIDE-LEGACY",
    reported: /handoff "HANDOFF" is malformed \("cannot be read \(a symbolic link\)"\)/,
    async setup(projectDir, outside) {
      await writeRel(outside, "legacy.md", "OUTSIDE-LEGACY\n");
      await mkdir(projectDir, { recursive: true });
      await symlink(join(outside, "legacy.md"), join(projectDir, "HANDOFF.md"));
    },
  },
  {
    name: "a symlinked project folder",
    secret: "OUTSIDE-PROJECT-FOLDER",
    reported: /Projects\/kabin-api\/remember\/\.origin cannot be read \(the project folder is a symbolic link\)/,
    async setup(projectDir, outside) {
      await writeRel(outside, "real/remember/identity.md", "OUTSIDE-PROJECT-FOLDER\n");
      await symlink(join(outside, "real"), projectDir);
    },
  },
];

for (const c of symlinkCases) {
  test(`memory is never read through a symlink: ${c.name}`, async () => {
    const w = await localWorld();
    const outside = await tempDir("sro-outside-");
    await c.setup(w.projectDir, outside);
    const r = await initializeSession(localOpts(w));
    const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
    assert.doesNotMatch(r.payload, new RegExp(c.secret), `the target's content reached the payload:\n${r.payload}`);
    assert.match(lines, c.reported);
  });
}

// Holds the machine-wide preparation lock, so a session's sync work waits (before
// the pull and the post-pull identity) until the test releases it.
async function holdPrepareLock(w: { vaultRoot: string; stateRoot: string }): Promise<LockHandle> {
  const lock = await acquireLock(join(w.stateRoot, vaultId(w.vaultRoot), "prepare.lock"));
  assert.ok(lock, "the test must hold the prepare lock");
  return lock;
}

// The remote holds two folders claiming one origin (first use on two machines
// under different clone names); this machine's vault starts empty.
async function twoClaimsWorld(config = JSON.stringify({ timezone: "Asia/Tokyo" })) {
  const remote = join(await tempDir("sro-remote-"), "projects.git");
  await gitOk(["init", "-q", "--bare", "-b", "main", remote], { cwd: await tempDir() });
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", remote, seed], { cwd: await tempDir() });
  await writeRel(seed, ".gitignore", `${REQUIRED_IGNORES.join("\n")}\n`);
  await writeRel(seed, ".sro-config.json", config);
  for (const f of ["kabin-api", "kabin-api-2"]) await writeRel(seed, `${f}/remember/.origin`, "github.com/acme/kabin-api\n");
  await gitOk(["add", "-A"], { cwd: seed });
  await gitOk(["commit", "-q", "-m", "two claims"], { cwd: seed });
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
  const vaultRoot = await tempDir("sro-vault-");
  await mkdir(join(vaultRoot, ".obsidian"));
  const code = join(await tempDir(), "kabin-api");
  await initRepo(code);
  await commitFile(code, "README.md", "x", "init");
  await gitOk(["remote", "add", "origin", "git@github.com:acme/kabin-api.git"], { cwd: code });
  return { vaultRoot, remote, code, stateRoot: await tempDir("sro-state-"), seed };
}

// Machine A merges the duplicate folders (the documented procedure) and pushes.
async function mergeClaims(seed: string): Promise<void> {
  await gitOk(["pull", "-q", "--rebase"], { cwd: seed });
  await gitOk(["rm", "-rq", "kabin-api-2"], { cwd: seed });
  await gitOk(["commit", "-q", "-m", "merge duplicate"], { cwd: seed });
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
}

test("an identity refusal before the pull does not stop the pull that resolves it", async () => {
  const w = await twoClaimsWorld();
  const first = await initializeSession(opts(w, { sessionId: "s1" }));
  assert.equal(first.context, null);
  assert.match(first.payload, /claimed by several folders \("kabin-api", "kabin-api-2"\)/);
  await mergeClaims(w.seed);
  const next = await initializeSession(opts(w, { sessionId: "s2" }));
  assert.equal(next.context?.project, "kabin-api", next.status.map((s) => s.text).join("\n"));
});

test("a refusal after the pull keeps the sync status lines in the payload", async () => {
  const w = await twoClaimsWorld("{ not json");
  const r = await initializeSession(opts(w));
  assert.equal(r.context, null);
  assert.match(r.payload, /\[error\] memory and sync disabled: .*claimed by several folders/);
  assert.match(r.payload, /\[warn\] \.sro-config\.json is not valid JSON/, "the post-pull warning is kept");
  assert.ok(r.status.some((s) => /is not valid JSON/.test(s.text)));
});

test("a session refused before a slow pull learns in the background that the pull resolved it", async () => {
  const w = await twoClaimsWorld();
  await initializeSession(opts(w, { sessionId: "s1" })); // this machine now has both folders
  await mergeClaims(w.seed);
  const lock = await holdPrepareLock(w);
  let r;
  try {
    r = await initializeSession(opts(w, { sessionId: "s2", waitMs: 1_500 }));
  } finally {
    await lock.release();
  }
  assert.equal(r.context, null);
  assert.match(r.payload, /claimed by several folders/);
  assert.match(r.payload, /sync still running/);
  const later = (await r.background).map((s) => s.text).join("\n");
  assert.match(later, /maps to Projects\/kabin-api; restart the session/);
});

async function realGit(): Promise<string> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "git");
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  throw new Error("git is not on PATH");
}

// Runs `body` with a `git` first on PATH that runs `shell` (sh, with $real set to
// the real git and $here to the physical working directory) before the real git.
// PATH is restored in any case; tests in one file run one at a time.
async function withGitWrapper<T>(shell: string, body: () => Promise<T>): Promise<T> {
  const bin = await tempDir("sro-bin-");
  await writeFile(join(bin, "git"), `#!/bin/sh\nreal=${JSON.stringify(await realGit())}\nhere=$(pwd -P)\n${shell}\nexec "$real" "$@"\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${saved ?? ""}`;
  try {
    return await body();
  } finally {
    process.env.PATH = saved;
  }
}

const failCommonDirIn = (dir: string): string =>
  `if [ "$here" = ${JSON.stringify(dir)} ]; then for a in "$@"; do if [ "$a" = "--git-common-dir" ]; then echo "fatal: injected failure" >&2; exit 128; fi; done; fi`;

test("a post-pull identity that cannot be resolved (git fails) is a refusal, never 'sync failed' with the old identity", async () => {
  const w = await identityWorld();
  assert.equal((await initializeSession(opts(w, { sessionId: "s1" }))).context?.project, "canonical");
  // The claim that let identity skip the checkout lookup goes away with the next pull.
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", w.remote, seed], { cwd: await tempDir() });
  await gitOk(["rm", "-q", "canonical/remember/.origin"], { cwd: seed });
  await gitOk(["commit", "-q", "-m", "drop the claim"], { cwd: seed });
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
  const r = await withGitWrapper(failCommonDirIn(w.code), () => initializeSession(opts(w, { sessionId: "s2" })));
  const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
  assert.equal(r.context, null, lines);
  assert.match(lines, /\[error\] memory and sync disabled: .*--git-common-dir .*injected failure/);
  assert.doesNotMatch(lines, /sync failed/);
});

test("an early identity that cannot be resolved (git fails) does not stop the sync, and the post-pull identity decides", async () => {
  const w = await identityWorld();
  const r = await withGitWrapper(failCommonDirIn(w.code), () => initializeSession(opts(w)));
  const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
  assert.doesNotMatch(lines, /unexpected error/);
  assert.equal(r.context?.project, "canonical", lines);
});

test("a broken .sro-config.json is reported once, not once per read", async () => {
  const w = await localWorld();
  await writeRel(w.vaultRoot, "Projects/.sro-config.json", "{ not json");
  const r = await initializeSession(localOpts(w));
  assert.equal(r.status.filter((s) => /is not valid JSON/.test(s.text)).length, 1, r.status.map((s) => s.text).join("\n"));
});

test("a remote the privacy check cannot look at gets one line saying so", async () => {
  const r = await initializeSession(opts(await world()));
  const lines = r.status.filter((s) => /privacy check did not run/.test(s.text));
  assert.equal(lines.length, 1, r.status.map((s) => s.text).join("\n"));
  assert.equal(lines[0]?.level, "info");
  assert.match(lines[0]?.text ?? "", /a local path/);
  const alias = "git@github-work:acme/projects.git"; // an SSH host alias of github.com
  const items = statusFromPrivacy(alias, await remoteVisibility(alias));
  assert.deepEqual(items.map((i) => i.level), ["info"]);
  assert.match(items[0]?.text ?? "", /privacy check did not run for host github-work/);
});

// Lists the given sessions; every transcript has one message, every journal entry
// names its session.
class ListedHarness extends QuietHarness {
  readonly sessions: SessionRef[];
  readonly transcriptsRead: string[] = [];
  constructor(sessions: SessionRef[]) {
    super();
    this.sessions = sessions;
  }
  override async listSessions(): Promise<SessionRef[]> {
    return this.sessions;
  }
  override async readTranscript(sessionId: string): Promise<TranscriptChunk> {
    this.transcriptsRead.push(sessionId);
    return { sessionId, messages: [{ id: `${sessionId}-m1`, role: "user", text: "hello", time: Date.parse("2026-09-21T05:00:00Z") }] };
  }
  override async callModel(req: { system: string; prompt: string; parentSessionId: string }): Promise<string> {
    return `journal of ${req.parentSessionId}`;
  }
}

test("catch-up journals only the sessions whose directory is this project's repository", async () => {
  const w = await localWorld();
  const other = join(await tempDir(), "other-repo");
  await initRepo(other);
  await commitFile(other, "README.md", "x", "init");
  await gitOk(["remote", "add", "origin", "git@github.com:acme/other.git"], { cwd: other });
  const worktree = join(w.code, "..", "kabin-api-wt");
  await gitOk(["worktree", "add", "-q", "-b", "wt", worktree], { cwd: w.code });
  const harness = new ListedHarness([
    { id: "mine", directory: w.code, updated: 2000, parentId: null },
    { id: "worktree", directory: worktree, updated: 2001, parentId: null },
    { id: "mine-again", directory: w.code, updated: 2002, parentId: null },
    { id: "theirs", directory: other, updated: 3000, parentId: null },
    { id: "gone", directory: join(w.code, "..", "does-not-exist"), updated: 4000, parentId: null },
  ]);
  await initializeSession(localOpts(w, { harness }));
  const bodies = (await listEntries(w.projectDir)).map((e) => e.body).sort();
  assert.deepEqual(bodies, ["journal of mine", "journal of mine-again", "journal of worktree"]);
  assert.deepEqual(harness.transcriptsRead.sort(), ["mine", "mine-again", "worktree"]);
});
