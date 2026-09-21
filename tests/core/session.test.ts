import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { initializeSession, statusFromCycle, type SessionOptions } from "../../core/session.ts";
import type { Harness, SessionRef } from "../../core/harness.ts";
import { PAYLOAD_MARKER } from "../../core/inject.ts";
import { gitOk } from "../../core/git.ts";
import { systemTimezone } from "../../core/vault.ts";
import { commitFile, initRepo, tempDir } from "./helpers.ts";

class QuietHarness implements Harness {
  modelCalls = 0;
  async callModel(): Promise<string> {
    this.modelCalls++;
    return "digest";
  }
  async readTranscript(sessionId: string) {
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
  assert.match(items[3]?.text ?? "", /x\/Note\.md, x\/note\.md differ only by case/);
  assert.match(items[4]?.text ?? "", /3 cycles in a row/);
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
