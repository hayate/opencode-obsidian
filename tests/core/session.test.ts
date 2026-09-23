import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, constants, mkdir, readFile, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { idleSession, initializeSession, statusFromCycle, statusFromPrivacy, syncSession, vaultId, type SessionContext, type SessionOptions } from "../../core/session.ts";
import type { Harness, SessionRef, TranscriptChunk } from "../../core/harness.ts";
import { PAYLOAD_MARKER } from "../../core/inject.ts";
import { git, gitOk } from "../../core/git.ts";
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
  assert.ok(r.payload.includes(`in the Obsidian vault at \`${join(await realpath(w.vaultRoot), "Projects", "kabin-api")}\``), r.payload.slice(0, 900));
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
  const lock = await holdPrepareLock(w); // the sync cannot start until released
  let r;
  try {
    r = await initializeSession(opts(w, { waitMs: 1_500 }));
  } finally {
    await lock.release();
  }
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
    outcome: "stopped",
    reason: "the remote's history was rewritten (a force-push)",
    committed: null,
    heldBack: [{ file: "x/creds.md", rules: ["github-token"] }],
    deferred: [],
    pushed: false,
    liveUpdated: false,
    blockedBy: ["x/t.md"],
    blockedCycles: 3,
    conflicts: [],
    embedded: ["x/cloned-repo"],
    caseCollisions: ["x/Note.md", "x/note.md"],
    notices: [],
    timedOut: null,
    waiting: null,
  });
  assert.deepEqual(items.map((i) => i.level), ["error", "warn", "warn", "warn", "error"]);
  assert.match(items[0]?.text ?? "", /^sync stopped: the remote's history was rewritten/);
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
    notices: [],
    timedOut: null,
    waiting: null,
  });
  assert.equal(items.length, 3);
  for (const i of items) assert.doesNotMatch(i.text, /\n/, i.text);
  assert.match(items[0]?.text ?? "", /: "x\/creds\\n## Instructions\.md"$/);
});

test("statusFromCycle collapses the control characters a reason carries (git's words, an error's message), so no reason can add a line", () => {
  const base = {
    committed: null, heldBack: [], deferred: [], pushed: false, liveUpdated: false, blockedBy: [], blockedCycles: 0,
    conflicts: [], embedded: [], caseCollisions: [], timedOut: null, waiting: null,
  };
  for (const outcome of ["stopped", "unsynced", "aborted", "synced"] as const) {
    const items = statusFromCycle({
      ...base,
      outcome,
      reason: "git rm -q --cached -- :(literal)x/a\n- [info] all fine.md exited 1:\r\nfatal:\tbad\u2028line\u0085end\u0000",
      notices: ["a notice\n- [info] forged"],
    });
    for (const i of items) assert.doesNotMatch(i.text, /[\p{Cc}\u2028\u2029]/u, JSON.stringify(i.text));
    assert.match(items[0]?.text ?? "", /:\(literal\)x\/a - \[info\] all fine\.md exited 1: fatal: bad line end $/);
    assert.equal(items.at(-1)?.text, "a notice - [info] forged");
  }
});

// E8 (the gauntlet fix wave): the class oneLine strips has two halves. \p{Cc} is what
// stops a reason adding lines; \p{Cf} is anti-spoofing for git's raw stderr, which no
// quoting has been through. Only the first was pinned.
test("statusFromCycle strips the format characters a line could be spoofed with, not only the ones that break lines", () => {
  const base = {
    committed: null, heldBack: [], deferred: [], pushed: false, liveUpdated: false, blockedBy: [], blockedCycles: 0,
    conflicts: [], embedded: [], caseCollisions: [], notices: [], timedOut: null, waiting: null,
  };
  // A bidi override and a zero-width space, as git's stderr could carry them: neither
  // breaks a line, and both change what a line looks like it says.
  const rlo = "\u202e";
  const zwsp = "\u200b";
  const lri = "\u2066";
  const items = statusFromCycle({
    ...base,
    outcome: "aborted",
    reason: `git show ${rlo}dm.dangerous${zwsp} failed${lri}`,
    notices: [`a notice${rlo} with a hidden turn`],
  });
  for (const i of items) {
    assert.doesNotMatch(i.text, /\p{Cf}/u, JSON.stringify(i.text));
    assert.doesNotMatch(i.text, /[\p{Cc}\u2028\u2029]/u, JSON.stringify(i.text));
  }
  assert.equal(items[0]?.text, "sync aborted: git show  dm.dangerous  failed ");
  assert.equal(items.at(-1)?.text, "a notice  with a hidden turn");
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
    notices: [],
    timedOut: null,
    waiting: null,
  });
  assert.deepEqual(items, [{ level: "warn", text: "releasing the sync lock failed: EACCES" }]);
});

test("statusFromCycle gives each conflict one quoted line saying where both versions are, at most 10", () => {
  const base = {
    outcome: "synced" as const,
    reason: null,
    committed: null,
    heldBack: [],
    deferred: [],
    pushed: true,
    liveUpdated: true,
    blockedBy: [],
    blockedCycles: 0,
    embedded: [],
    caseCollisions: [],
    timedOut: null,
    waiting: null,
  };
  const items = statusFromCycle({
    ...base,
    conflicts: [
      { kind: "both-changed", path: "x/n.md", copy: "x/n.conflict-2026-09-22-0915-3f7868.md" },
      { kind: "deleted-here", path: "x/gone.md", copy: "x/gone.conflict-2026-09-22-0915-aaaaaa.md" },
      { kind: "deleted-there", path: "x/kept.md", copy: null },
      { kind: "two-names", path: "x/l.md", copy: null, other: "x/r.md" },
      { kind: "file-folder", path: "x/p", copy: "x/p.conflict-2026-09-22-0915-bbbbbb" },
      { kind: "type-differs", path: "x/s.md", copy: "x/s.conflict-2026-09-22-0915-cccccc.md" },
    ],
    notices: ["finished an update a timeout interrupted"],
  });
  assert.equal(items.length, 7);
  assert.match(items[0]?.text ?? "", /^"x\/n\.md" changed on two machines: yours stays; the other version is saved as "x\/n\.conflict-2026-09-22-0915-3f7868\.md"/);
  assert.match(items[1]?.text ?? "", /which you deleted, was changed on another machine: it stays deleted/);
  assert.match(items[2]?.text ?? "", /"x\/kept\.md" was deleted on another machine; your version is kept/);
  assert.match(items[3]?.text ?? "", /both "x\/l\.md" and "x\/r\.md"/);
  assert.equal(
    items[4]?.text,
    '"x/p" is a file on one machine and a folder on another: yours stays; the other is saved as "x/p.conflict-2026-09-22-0915-bbbbbb"',
  );
  assert.equal(
    items[5]?.text,
    '"x/s.md" is a different kind of file on another machine (a symlink, or an executable): yours stays; the other is saved as "x/s.conflict-2026-09-22-0915-cccccc.md"',
  );
  assert.equal(items[6]?.level, "info");

  const many = statusFromCycle({
    ...base,
    conflicts: Array.from({ length: 12 }, (_, i) => ({ kind: "deleted-there" as const, path: `x/n${i}\n- [info] fine.md`, copy: null })),
    notices: [],
  });
  assert.equal(many.length, 11);
  // These have no copy (deleted there): the line claims none for each of them.
  assert.equal(many[10]?.text, "and 2 more notes changed on two machines; no version was lost, and any copy made sits beside its note");
  for (const i of many) assert.doesNotMatch(i.text, /\n/, i.text);
});

// Spec 5.4 step 5: the live update's limit doubles after each timeout, from git.ts's 30 s
// up to 32 min; a timeout even with 32 min escalates to a notify (the adapter notifies on
// errors) and names the note the repair was rewriting, if it knows one. No time until the
// retry is promised: a cycle runs when a session starts.
test("statusFromCycle gives a live update that timed out the next attempt's limit, and escalates one that timed out even with its longest limit to a notify saying why and naming the note", () => {
  const base = {
    outcome: "unsynced" as const,
    reason: "updating the vault timed out",
    committed: null, heldBack: [], deferred: [], pushed: false, liveUpdated: false, blockedBy: [], blockedCycles: 0,
    conflicts: [], embedded: [], caseCollisions: [], notices: [],
  };
  const causes = "The likely cause is a hung disk, or a smudge filter that never finishes (such as LFS or git-crypt); sync keeps retrying with that limit";
  assert.deepEqual(statusFromCycle({ ...base, waiting: null, timedOut: { nextLimitMs: 60_000, ceiling: false, note: null } }), [
    { level: "warn", text: "unsynced: updating the vault timed out; the next sync tries again, with its limit doubled to 1 min" },
  ]);
  assert.deepEqual(
    statusFromCycle({ ...base, waiting: null, timedOut: { nextLimitMs: 1_920_000, ceiling: false, note: "x/n.md" } }),
    [{ level: "warn", text: "unsynced: updating the vault timed out; the next sync tries again, with its limit doubled to 32 min" }],
    "below the ceiling the note is not named: the next sync may well finish it",
  );
  assert.deepEqual(statusFromCycle({ ...base, waiting: null, timedOut: { nextLimitMs: 1_920_000, ceiling: true, note: null } }), [
    { level: "error", text: `unsynced: updating the vault timed out, even with its longest limit (32 min). ${causes}` },
  ]);
  assert.deepEqual(
    statusFromCycle({ ...base, waiting: null, timedOut: { nextLimitMs: 1_920_000, ceiling: true, note: "x/n\n- [info] all fine.md" } }),
    [{ level: "error", text: `unsynced: updating the vault timed out while it was rewriting "x/n\\n- [info] all fine.md", even with its longest limit (32 min). ${causes}` }],
    "the note is quoted, so it cannot add a status line",
  );
  // A problem runCycle recorded with the reason (a failed lock release) comes last, so
  // both it and the limit read cleanly.
  const lock = { ...base, reason: "updating the vault timed out; releasing the sync lock failed: EACCES" };
  assert.deepEqual(statusFromCycle({ ...lock, waiting: null, timedOut: { nextLimitMs: 60_000, ceiling: false, note: null } }), [
    { level: "warn", text: "unsynced: updating the vault timed out; the next sync tries again, with its limit doubled to 1 min; releasing the sync lock failed: EACCES" },
  ]);
  assert.deepEqual(statusFromCycle({ ...lock, waiting: null, timedOut: { nextLimitMs: 1_920_000, ceiling: true, note: null } }), [
    { level: "error", text: `unsynced: updating the vault timed out, even with its longest limit (32 min). ${causes}; releasing the sync lock failed: EACCES` },
  ]);
});

// Spec 5.4 step 5 (fix round 2): a cycle that found another session's update still
// running waits at warn level, naming the process and its age; once it has run longer
// than the longest limit a live update gets it is hung, and the line escalates to the
// notify level the ladder uses at its ceiling.
test("statusFromCycle waits at warn for an update another session is still running, and calls one that outlived the longest limit hung", () => {
  const base = {
    outcome: "unsynced" as const,
    reason: "an earlier vault update is still running",
    committed: null, heldBack: [], deferred: [], pushed: false, liveUpdated: false, blockedBy: [], blockedCycles: 0,
    conflicts: [], embedded: [], caseCollisions: [], notices: [], timedOut: null,
  };
  // The record's boot stamp is this boot's in every case below; the mismatch has its own
  // line and its own test.
  const here = { thisBoot: true, record: "/state/interrupted-update.json", safeToDelete: false };
  assert.deepEqual(statusFromCycle({ ...base, waiting: { group: 4242, runningMs: 12_400, hung: false, ...here } }), [
    { level: "warn", text: "unsynced: an earlier vault update is still running (process group 4242, 12 s so far); sync waits for it. If it is hung, end that process" },
  ]);
  assert.deepEqual(statusFromCycle({ ...base, waiting: { group: 4242, runningMs: 45_000, hung: false, ...here } }), [
    { level: "warn", text: "unsynced: an earlier vault update is still running (process group 4242, 45 s so far); sync waits for it. If it is hung, end that process" },
  ]);
  assert.deepEqual(statusFromCycle({ ...base, waiting: { group: 4242, runningMs: 1_920_000, hung: true, ...here } }), [
    {
      level: "error",
      text: "unsynced: an earlier vault update has been running for 32 min (process group 4242), longer than the longest limit a live update gets: it is hung. End that process, and the next sync tries the update again",
    },
  ]);
  // An age is read in the unit that suits it: a hang can outlast a day, and nobody reads
  // "1440 min". Nothing here promises that the next sync finishes the update: at this
  // point its repair often hangs on the same filter.
  const ages: Array<[number, string]> = [
    [0, "0 s"],
    [12_400, "12 s"],
    [59_600, "1 min"],
    [1_920_000, "32 min"],
    [3_600_000, "1 hour"],
    [7_200_000, "2 hours"],
    [86_400_000, "1 day"],
    [601_200_000, "7 days"],
  ];
  for (const [runningMs, reads] of ages) {
    const [line] = statusFromCycle({ ...base, waiting: { group: 7, runningMs, hung: true, ...here } });
    assert.match(line?.text ?? "", new RegExp(`^unsynced: an earlier vault update has been running for ${reads} \\(process group 7\\)`), `${runningMs} ms`);
  }
  // A problem runCycle recorded with the reason comes last here too.
  const lock = { ...base, reason: "an earlier vault update is still running; releasing the sync lock failed: EACCES" };
  assert.deepEqual(statusFromCycle({ ...lock, waiting: { group: 4242, runningMs: 0, hung: false, ...here } }), [
    {
      level: "warn",
      text: "unsynced: an earlier vault update is still running (process group 4242, 0 s so far); sync waits for it. If it is hung, end that process; releasing the sync lock failed: EACCES",
    },
  ]);
});

// Spec 5.4 step 5 (the gauntlet fix wave; A1 of round 2): the boot stamp is derived from
// os.uptime(), so a clock correction larger than its tolerance reads as another boot. A
// live group is waited for either way; a stamp that does not match only makes the line a
// notify, and adds a way out. That way out is how to look at the process and what ending
// it does - never deleting a record that may be the only thing that can still repair the
// vault, which is a judgement only the cycle, never the user, is in a position to make.
test("statusFromCycle waits at notify for an update whose record is not this boot's, says how to look at the process, and refuses to offer a delete that would strand the vault", () => {
  const base = {
    outcome: "unsynced" as const,
    reason: "an earlier vault update is still running",
    committed: null, heldBack: [], deferred: [], pushed: false, liveUpdated: false, blockedBy: [], blockedCycles: 0,
    conflicts: [], embedded: [], caseCollisions: [], notices: [], timedOut: null,
  };
  const elsewhere = { thisBoot: false, record: "/state/interrupted-update.json", safeToDelete: false };
  assert.deepEqual(statusFromCycle({ ...base, waiting: { group: 4242, runningMs: 12_400, hung: false, ...elsewhere } }), [
    {
      level: "error",
      text: 'unsynced: an earlier vault update is still running (process group 4242, 12 s so far), but its record is from an earlier boot of this machine, or from before its clock was corrected: the process holding that id may be something else. Sync waits for it. `ps -g 4242` shows what it is; if it is not this vault\'s update, ending it lets sync carry on by itself. Do not delete "/state/interrupted-update.json": it is what lets the next sync finish an update that stopped part way, and without it the changes that update left would be sent as yours.',
    },
  ]);
  // Hung or not, the mismatch is what the line is about: the age alone cannot say whether
  // the process is the update at all.
  assert.deepEqual(statusFromCycle({ ...base, waiting: { group: 9, runningMs: 86_400_000, hung: true, ...elsewhere } }), [
    {
      level: "error",
      text: 'unsynced: an earlier vault update is still running (process group 9, 1 day so far), but its record is from an earlier boot of this machine, or from before its clock was corrected: the process holding that id may be something else. Sync waits for it. `ps -g 9` shows what it is; if it is not this vault\'s update, ending it lets sync carry on by itself. Do not delete "/state/interrupted-update.json": it is what lets the next sync finish an update that stopped part way, and without it the changes that update left would be sent as yours.',
    },
  ]);
  // A problem runCycle recorded with the reason comes last here too, and the record's name
  // is quoted like any other name a status line carries.
  const lock = { ...base, reason: "an earlier vault update is still running; releasing the sync lock failed: EACCES" };
  const [line] = statusFromCycle({ ...lock, waiting: { group: 9, runningMs: 0, hung: false, thisBoot: false, record: "/state/a\nb.json", safeToDelete: false } });
  assert.equal(
    line?.text,
    'unsynced: an earlier vault update is still running (process group 9, 0 s so far), but its record is from an earlier boot of this machine, or from before its clock was corrected: the process holding that id may be something else. Sync waits for it. `ps -g 9` shows what it is; if it is not this vault\'s update, ending it lets sync carry on by itself. Do not delete "/state/a\\nb.json": it is what lets the next sync finish an update that stopped part way, and without it the changes that update left would be sent as yours.; releasing the sync lock failed: EACCES',
  );
  // Only where the cycle established that the record protects nothing is a delete offered
  // at all, and then it is offered as a way out rather than refused as a warning.
  const [offered] = statusFromCycle({ ...base, waiting: { group: 9, runningMs: 0, hung: false, thisBoot: false, record: "/state/r.json", safeToDelete: true } });
  assert.equal(offered?.level, "error");
  assert.ok((offered?.text ?? "").endsWith('Nothing of that update has reached the vault, so deleting "/state/r.json" also lets sync carry on.'), offered?.text);
  assert.doesNotMatch(offered?.text ?? "", /Do not delete/);
  assert.match(offered?.text ?? "", /`ps -g 9` shows what it is/);
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
  // The deadline counts from entry, and only the journal step is held: the clone, pull and identity
  // steps before it must finish inside waitMs. 2 s was not enough on a loaded machine (four suites
  // at once failed this assertion every time, alone it passed 5/5), so the budget sits far above
  // what those git steps take; the test lasts waitMs, since the gate holds until the deadline.
  const r = await initializeSession(opts(w, { harness, waitMs: 10_000 }));
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
    // The session still has a context (a non-git session directory is a project too), and no
    // later sync in it may go where initialization refused to.
    if (r.context) {
      assert.match((await syncSession(r.context, { quietMs: 0 })).map((s) => s.text).join("\n"), /sync refused/);
      await assert.rejects(stat(join(vaultRoot, "Projects", ".git")));
    }
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

test("one session that fails catch-up is named, the others are journaled, and the rollups are still built", async () => {
  const w = await localWorld();
  const harness = new ListedHarness([
    { id: "ses_broken", directory: w.code, updated: 3000, parentId: null },
    { id: "ses_fine", directory: w.code, updated: 2000, parentId: null },
  ]);
  const read = harness.readTranscript.bind(harness);
  harness.readTranscript = async (id: string) => {
    if (id === "ses_broken") throw new Error("transcript store unavailable");
    return read(id);
  };
  const r = await initializeSession(localOpts(w, { harness }));
  const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
  assert.match(lines, /\[warn\] journal catch-up failed for session ses_broken: transcript store unavailable/);
  assert.deepEqual((await listEntries(w.projectDir)).map((e) => e.body), ["journal of ses_fine"]);
  await stat(join(w.projectDir, "remember", "recent.md")); // the rollups ran
});

test("sync work that fails outright is reported as 'sync failed', and the payload is still built", async () => {
  const w = await world();
  // The state root is a file, so the machine-wide preparation lock cannot be
  // created: the sync work rejects.
  const stateRoot = join(await tempDir(), "state-is-a-file");
  await writeFile(stateRoot, "");
  const r = await initializeSession(opts({ ...w, stateRoot }));
  const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
  assert.match(lines, /\[error\] sync failed: .*ENOTDIR/);
  assert.equal(r.context?.project, "kabin-api", lines);
});

test("an exception after the sync race gives the 'unexpected error' payload, never a throw", async () => {
  const w = await localWorld();
  let clockBroken = false;
  const harness = new ListedHarness([]);
  harness.listSessions = async () => {
    clockBroken = true; // from the journal step on, every reading of the clock fails
    return [];
  };
  const r = await initializeSession(
    localOpts(w, {
      harness,
      now: () => {
        if (clockBroken) throw new Error("clock failed");
        return new Date("2026-09-21T07:00:00Z");
      },
    }),
  );
  assert.equal(r.context, null);
  assert.match(r.payload, /memory and sync disabled: unexpected error: clock failed/);
});

test("a sync that outlives the wait warns in the background that this repository maps to another folder: restart", async () => {
  const w = await identityWorld();
  const lock = await holdPrepareLock(w); // the work cannot reach the post-pull identity
  let r;
  try {
    r = await initializeSession(opts(w, { waitMs: 1_500 }));
  } finally {
    await lock.release();
  }
  assert.equal(r.context?.project, "different-local-name", "shown with the identity known before the pull");
  assert.match(r.payload, /sync still running/);
  const later = (await r.background).map((s) => s.text).join("\n");
  assert.match(later, /after sync this repository maps to Projects\/canonical, not different-local-name; restart the session/);
  assert.equal(await r.settled, null, "no later sync or journal writes into the folder the session was shown");
});

test("after a timeout, the settled context carries the zone the pulled config gives, and the project it was shown", async () => {
  const zone = systemTimezone() === "Pacific/Kiritimati" ? "UTC" : "Pacific/Kiritimati";
  const w = await world();
  const seed = join(await tempDir(), "seed");
  await gitOk(["clone", "-q", w.remote, seed], { cwd: await tempDir() });
  await commitFile(seed, ".sro-config.json", JSON.stringify({ timezone: zone }), "another zone");
  await gitOk(["push", "-q", "origin", "HEAD"], { cwd: seed });
  const lock = await holdPrepareLock(w);
  let r;
  try {
    r = await initializeSession(opts(w, { waitMs: 1_500 }));
  } finally {
    await lock.release();
  }
  assert.equal(r.context?.timezone, systemTimezone(), "shown before the pull: this machine's zone");
  await r.background;
  const settled = await r.settled;
  assert.equal(settled?.project, "kabin-api");
  assert.equal(settled?.timezone, zone);
});

test("a session initialized in time settles on the context it was given", async () => {
  const r = await initializeSession(opts(await world()));
  assert.ok(r.context);
  assert.equal(await r.settled, r.context);
});

test("a git call that hangs before the sync starts still returns within the wait, saying initialization timed out", async () => {
  const w = await world();
  const marker = join(await tempDir(), "slept");
  // The first git command in the session directory (the early identity) hangs 3 s.
  const slowOnce = `if [ "$here" = ${JSON.stringify(w.code)} ] && mkdir ${JSON.stringify(marker)} 2>/dev/null; then sleep 10; fi`;
  await withGitWrapper(slowOnce, async () => {
    const t0 = Date.now();
    const r = await initializeSession(opts(w, { waitMs: 1_000 }));
    const elapsed = Date.now() - t0;
    // Five times the wait, and a fifth of the 10 s the wrapper sleeps: what this pins is
    // that the deadline is honoured at all, never a millisecond budget, and no scheduling
    // delay on a loaded machine can reach either end of that.
    assert.ok(elapsed < 5_000, `initializeSession returned after ${elapsed} ms for a 1000 ms wait`);
    assert.equal(r.context, null);
    assert.ok(r.payload.startsWith(`${PAYLOAD_MARKER}\nBOOTSTRAP\n`), "the bootstrap is still sent");
    assert.match(r.payload, /memory initialization timed out/);
    const later = (await r.background).map((s) => s.text).join("\n");
    assert.match(later, /after sync this repository maps to Projects\/kabin-api; restart the session/);
  });
});

test("a session that timed out before the sync learns in the background why memory stays off", async () => {
  const w = await twoClaimsWorld();
  const marker = join(await tempDir(), "slept");
  const slowOnce = `if [ "$here" = ${JSON.stringify(w.code)} ] && mkdir ${JSON.stringify(marker)} 2>/dev/null; then sleep 3; fi`;
  await withGitWrapper(slowOnce, async () => {
    const r = await initializeSession(opts(w, { waitMs: 1_000 }));
    assert.match(r.payload, /memory initialization timed out/);
    const later = (await r.background).map((s) => s.text).join("\n");
    assert.match(later, /after sync memory and sync are disabled: .*claimed by several folders/);
  });
});

// C5 (the gauntlet fix wave): the prepare lock was released in a `finally`, so a release
// that threw replaced the reason the session needed with its own. runCycle already keeps
// both for the sync lock; this does the same.
const ownedLockDir = (w: { stateRoot: string; vaultRoot: string }): string => join(w.stateRoot, vaultId(w.vaultRoot), "prepare.lock");

test(
  "a prepare lock that cannot be released is reported beside what preparation did, never instead of it",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const w = await world();
    const lockDir = ownedLockDir(w);
    // While the clone runs, and so while the lock is held: release() then cannot unlink
    // its owner entry.
    const wedge = `for a in "$@"; do if [ "$a" = clone ]; then chmod 555 ${JSON.stringify(lockDir)} 2>/dev/null; fi; done`;
    let r: Awaited<ReturnType<typeof initializeSession>>;
    try {
      r = await withGitWrapper(wedge, () => initializeSession(opts(w)));
    } finally {
      await chmod(lockDir, 0o755).catch(() => undefined);
    }
    const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
    assert.equal(r.context?.project, "kabin-api", lines);
    assert.match(lines, /\[warn\] releasing the prepare lock failed: .*(EACCES|permission denied)/i);
  },
);

test(
  "a prepare that fails while the lock cannot be released keeps its own reason, with the release's appended",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const w = await world();
    // One session prepares Projects/ so the next takes the already-a-repository path.
    assert.equal((await initializeSession(opts(w, { sessionId: "s1" }))).context?.project, "kabin-api");
    const lockDir = ownedLockDir(w);
    const projects = join(w.vaultRoot, "Projects");
    // checkRepo's --git-path lookup fails, and the lock is wedged on the way in.
    const wedge = `if [ "$here" = ${JSON.stringify(projects)} ]; then for a in "$@"; do if [ "$a" = "--git-path" ]; then chmod 555 ${JSON.stringify(lockDir)} 2>/dev/null; echo "fatal: injected failure" >&2; exit 128; fi; done; fi`;
    let r: Awaited<ReturnType<typeof initializeSession>>;
    try {
      r = await withGitWrapper(wedge, () => initializeSession(opts(w, { sessionId: "s2" })));
    } finally {
      await chmod(lockDir, 0o755).catch(() => undefined);
    }
    const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
    assert.match(lines, /\[error\] sync failed: .*injected failure/, lines);
    assert.match(lines, /injected failure.*; releasing the prepare lock failed: /, lines);
  },
);

// C2 (round 2): catchUp and buildRollups run the adapter's own code - listSessions,
// readTranscript, callModel - which can reject with anything at all. `(err as Error)
// .message` on a value that is not an Error renders "journal catch-up: undefined", which
// says nothing and hides which of the host's entry points threw.
function throwingHarness(thrown: unknown): Harness {
  return {
    async callModel(): Promise<string> {
      throw thrown;
    },
    async readTranscript(sessionId: string): Promise<TranscriptChunk> {
      return { sessionId, messages: [] };
    },
    async listSessions(): Promise<SessionRef[]> {
      throw thrown;
    },
    async notify(): Promise<void> {},
  };
}

test("a harness that rejects with something that is not an Error still says what it was, for the catch-up and for the rollups", async () => {
  for (const [thrown, reads] of [
    ["the model refused", "the model refused"],
    [null, "null"],
    [42, "42"],
    [new TypeError("req.system is not a string"), "TypeError: req.system is not a string"],
  ] as Array<[unknown, string]>) {
    const w = await localWorld();
    // A day before today's, so the rollups have something to digest and call the model for.
    const then = new Date("2026-09-18T06:00:00Z");
    await writeJournalEntry(w.projectDir, { machine: "a", session: "s", branch: "main", from: then, to: then, model: "m", summary: "older", timezone: "Asia/Tokyo" });
    const r = await initializeSession(localOpts(w, { harness: throwingHarness(thrown) }));
    const lines = r.status.map((s) => `[${s.level}] ${s.text}`).join("\n");
    assert.ok(lines.includes(`journal catch-up: ${reads}`), lines);
    assert.ok(lines.includes(`journal rollups: ${reads}`), lines);
    assert.doesNotMatch(lines, /: undefined$/m, "never a line that says nothing at all");
    assert.equal(r.status.filter((s) => s.text.startsWith("journal ")).length, 2, lines);
    assert.equal(r.context?.project, "kabin-api", "and the session still starts");
  }
});

// Spec 8: the session's later syncs (remember_sync, idle) go through syncSession.
async function initialized(w: { vaultRoot: string; remote: string; code: string; stateRoot: string }, over: Partial<SessionOptions> = {}): Promise<SessionContext> {
  const r = await initializeSession(opts(w, over));
  assert.ok(r.context, r.status.map((s) => s.text).join("\n"));
  return r.context;
}

// A note written earlier in the session: its mtime is past the cycle's quiet window, which
// defers a file modified in the last QUIET_MS as another session's write in progress.
async function writeEarlier(root: string, rel: string, content: string): Promise<void> {
  await writeRel(root, rel, content);
  const past = new Date(Date.now() - 60_000);
  await utimes(join(root, rel), past, past);
}

async function remoteHas(remote: string, rel: string): Promise<boolean> {
  return (await git(["cat-file", "-e", `main:${rel}`], { cwd: remote })).code === 0;
}

test("syncSession sends what changed since initialization, and a clean sync reports nothing", async () => {
  const w = await world();
  const ctx = await initialized(w);
  await writeEarlier(join(w.vaultRoot, "Projects"), "kabin-api/notes/later.md", "written mid-session\n");
  assert.deepEqual((await syncSession(ctx)).filter((s) => s.level !== "info"), []);
  assert.ok(await remoteHas(w.remote, "kabin-api/notes/later.md"));
  assert.deepEqual((await syncSession(ctx)).filter((s) => s.level !== "info"), [], "nothing to report the second time");
});

test("syncSession never syncs to a remote this session's privacy check found public", async () => {
  const w = await world();
  const ctx = await initialized(w);
  await writeEarlier(join(w.vaultRoot, "Projects"), "kabin-api/notes/secret.md", "must not leave\n");
  const pub: SessionContext = { ...ctx, privacy: Promise.resolve({ visibility: "public", detail: "https://github.com/acme/p.git is readable without credentials" }) };
  const items = await syncSession(pub);
  assert.deepEqual(items.map((i) => i.level), ["error"]);
  assert.match(items[0]?.text ?? "", /^sync refused: .*make the repository private$/);
  assert.equal(await remoteHas(w.remote, "kabin-api/notes/secret.md"), false);
});

test("syncSession passes remember_sync's adopt option to the cycle: a rewritten remote stops, adopting it syncs", async () => {
  const w = await world();
  const before = await gitOk(["rev-parse", "main"], { cwd: w.remote });
  const ctx = await initialized(w);
  await writeEarlier(join(w.vaultRoot, "Projects"), "kabin-api/notes/sent.md", "sent, then dropped by the rewrite\n");
  await syncSession(ctx);
  assert.ok(await remoteHas(w.remote, "kabin-api/notes/sent.md"));
  await gitOk(["update-ref", "refs/heads/main", before], { cwd: w.remote }); // a force-push back
  const stopped = await syncSession(ctx);
  assert.ok(stopped.some((s) => s.level === "error" && /history was rewritten/.test(s.text)), stopped.map((s) => s.text).join("\n"));
  const adopted = await syncSession(ctx, { adoptRewrite: true });
  assert.deepEqual(adopted.filter((s) => s.level !== "info"), [], adopted.map((s) => s.text).join("\n"));
  assert.equal(await remoteHas(w.remote, "kabin-api/notes/sent.md"), false, "the adopted remote is not undone");
});

test("syncSession turns a failure into one status line, whatever was thrown", async () => {
  const w = await world();
  const ctx = await initialized(w);
  const items = await syncSession({ ...ctx, privacy: Promise.reject("no network") });
  assert.deepEqual(items, [{ level: "error", text: "sync failed: no network" }]);
});

test("idleSession journals this session once per cooldown, then syncs the entry and the notes past the quiet window", async () => {
  const w = await world();
  const harness = new ListedHarness([]);
  const ctx = await initialized(w, { harness });
  await writeRel(join(w.vaultRoot, "Projects"), "kabin-api/notes/idle.md", "written in the session's last turn\n");
  const now = () => new Date("2026-09-21T07:00:00Z");
  const items = await idleSession(ctx, { harness, sessionId: "ses_current", journalModel: "fake/model", now });
  assert.deepEqual(items.filter((s) => s.level !== "info"), [], items.map((s) => s.text).join("\n"));
  assert.ok(await remoteHas(w.remote, "kabin-api/notes/idle.md"), "the idle sync sent it");
  const entries = await listEntries(ctx.projectDir);
  assert.deepEqual(entries.map((e) => e.body.trim()), ["journal of ses_current"]);
  const sent = await gitOk(["ls-tree", "-r", "--name-only", "main", "kabin-api/remember/journal"], { cwd: w.remote });
  assert.equal(sent.trim().split("\n").filter(Boolean).length, 1, "the entry this idle wrote went with this idle's sync, past the quiet window");
  await idleSession(ctx, { harness, sessionId: "ses_current", journalModel: "fake/model", now });
  assert.equal((await listEntries(ctx.projectDir)).length, 1, "the cooldown holds the second idle");
});

test("idleSession with sync off only journals, and a journal failure is a line beside the sync's", async () => {
  const w = await world();
  const off = await initialized(w, { env: { OBSIDIAN_VAULT_PATH: w.vaultRoot } });
  assert.equal(off.remote, null);
  const failing = new (class extends ListedHarness {
    override async callModel(): Promise<string> {
      throw "model unavailable";
    }
  })([]);
  const items = await idleSession(off, { harness: failing, sessionId: "ses_current", journalModel: "fake/model" });
  assert.deepEqual(items, [{ level: "warn", text: "journal: model unavailable" }], "no sync line when sync is off");
});

// A model call that never answers.
class HungHarness extends ListedHarness {
  override async callModel(): Promise<string> {
    return new Promise<string>(() => undefined);
  }
}

test("after a timeout, the settled context does not wait for the journal's model calls", async () => {
  const w = await world();
  const lock = await holdPrepareLock(w);
  const harness = new HungHarness([{ id: "ses_other", directory: w.code, updated: Date.parse("2026-09-21T06:00:00Z"), parentId: null }]);
  let r;
  try {
    r = await initializeSession(opts(w, { waitMs: 1_500, harness }));
  } finally {
    await lock.release();
  }
  const settled = await Promise.race([r.settled, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000).unref())]);
  assert.notEqual(settled, "hung", "a sync must not wait on a summary");
  assert.equal(settled === "hung" ? null : settled?.project, "kabin-api");
});

test("an idle whose journal model never answers syncs anyway, past the wait, and says so", async () => {
  const w = await world();
  const harness = new HungHarness([]);
  const ctx = await initialized(w, { harness });
  await writeEarlier(join(w.vaultRoot, "Projects"), "kabin-api/notes/while-hung.md", "sent without the entry\n");
  const items = await idleSession(ctx, { harness, sessionId: "ses_current", journalModel: "fake/model", journalWaitMs: 300, quietMs: 0 });
  assert.deepEqual(items.filter((s) => s.level !== "info"), [
    { level: "warn", text: "journal: the model did not answer within 300 ms; the entry is written when it does, and this sync went ahead without it" },
  ]);
  assert.ok(await remoteHas(w.remote, "kabin-api/notes/while-hung.md"));
});

test("a journal call that fails after the idle stopped waiting for it is let go, never an unhandled rejection", async () => {
  const w = await world();
  const failsLate = new (class extends ListedHarness {
    override async callModel(): Promise<string> {
      await new Promise((resolve) => setTimeout(resolve, 400));
      throw new Error("provider gave up");
    }
  })([]);
  const ctx = await initialized(w, { harness: failsLate });
  const seen: unknown[] = [];
  const onRejection = (err: unknown): void => void seen.push(err);
  process.on("unhandledRejection", onRejection);
  try {
    const items = await idleSession(ctx, { harness: failsLate, sessionId: "ses_current", journalModel: "fake/model", journalWaitMs: 100, quietMs: 0 });
    assert.match(items.find((s) => s.level === "warn")?.text ?? "", /did not answer within 100 ms/);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(seen, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("the session's context carries the privacy check initialization made, for its later syncs", async () => {
  const w = await world();
  const r = await initializeSession(opts(w));
  assert.ok(r.context);
  const verdict = await r.context.privacy;
  assert.equal(verdict?.visibility, "not-github", "the one check, not a stand-in");
  assert.deepEqual(verdict, await remoteVisibility(w.remote));
});

test("remember_sync right after a note is written sends it: the sync waits past the quiet window", async () => {
  const w = await world();
  const ctx = await initialized(w);
  await writeRel(join(w.vaultRoot, "Projects"), "kabin-api/notes/just-written.md", "fixed a moment ago\n");
  const items = await syncSession(ctx);
  assert.deepEqual(items.filter((s) => s.level !== "info"), [], items.map((s) => s.text).join("\n"));
  assert.ok(await remoteHas(w.remote, "kabin-api/notes/just-written.md"), "not deferred as a write in progress");
});

test("an idle's journal entry is the one the next session start's catch-up sees: no second entry, and it carries the branch and day", async () => {
  const w = await world();
  // The session's message is from 15:30 UTC: already the 22nd in the vault's zone (Asia/Tokyo),
  // still the 21st in UTC. An entry is filed under its messages' day in the vault's zone.
  class AfterMidnight extends ListedHarness {
    override async readTranscript(sessionId: string): Promise<TranscriptChunk> {
      return { sessionId, messages: [{ id: `${sessionId}-m1`, role: "user", text: "hello", time: Date.parse("2026-09-21T15:30:00Z") }] };
    }
  }
  const harness = new AfterMidnight([]);
  const now = () => new Date("2026-09-21T16:00:00Z");
  const ctx = await initialized(w, { harness, now });
  await idleSession(ctx, { harness, sessionId: "ses_current", journalModel: "fake/model", now, quietMs: 0 });
  // The next session start lists that session, last updated before its entry was written.
  const later = new AfterMidnight([{ id: "ses_current", directory: w.code, updated: Date.parse("2026-09-21T15:59:00Z"), parentId: null }]);
  await initializeSession(opts(w, { harness: later, sessionId: "ses_next", now }));
  const entries = await listEntries(ctx.projectDir);
  assert.equal(entries.length, 1, entries.map((e) => e.id).join(", "));
  assert.equal(entries[0]?.meta?.branch, "feat/x");
  assert.equal(entries[0]?.day, "2026-09-22", "the vault's day, not UTC's");
});
