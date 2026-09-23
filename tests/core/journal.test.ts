import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildRollups,
  catchUp,
  COOLDOWN_MS,
  journalSession,
  listEntries,
  redactSecrets,
  writeJournalEntry,
  type JournalContext,
} from "../../core/journal.ts";
import type { Harness, SessionRef, TranscriptMessage } from "../../core/harness.ts";
import { tempDir } from "./helpers.ts";

const TZ = "Asia/Tokyo";
const j = (...p: string[]): string => p.join("");

class FakeHarness implements Harness {
  transcripts = new Map<string, TranscriptMessage[]>();
  calls = 0;
  reply = "worked on the sync engine";
  async callModel(): Promise<string> {
    this.calls++;
    return this.reply;
  }
  async readTranscript(sessionId: string, after?: string) {
    const all = this.transcripts.get(sessionId) ?? [];
    const start = after ? all.findIndex((m) => m.id === after) + 1 : 0;
    return { sessionId, messages: all.slice(start) };
  }
  async listSessions(): Promise<SessionRef[]> {
    return [];
  }
  async notify(): Promise<void> {}
}

function msg(id: string, iso: string): TranscriptMessage {
  return { id, role: "user", text: `message ${id}`, time: Date.parse(iso) };
}

async function ctx(harness: FakeHarness, clock: { t: Date }): Promise<JournalContext> {
  const root = await tempDir();
  return {
    harness,
    projectDir: join(root, "Projects", "p"),
    stateFile: join(root, "state", "journal.json"),
    machine: "moonveil.local",
    branch: "feat/x",
    model: "fake/model",
    timezone: TZ,
    now: () => clock.t,
  };
}

test("entries are filed under the vault timezone's day and parsed back", async () => {
  const projectDir = join(await tempDir(), "p");
  const at = new Date("2026-09-21T16:30:05Z"); // 01:30 on the 22nd in Tokyo
  await writeJournalEntry(projectDir, { machine: "moonveil", session: "ses_abcdefgh1", branch: "main", from: at, to: at, model: "m", summary: "did x", timezone: TZ });
  const [entry] = await listEntries(projectDir);
  assert.equal(entry?.day, "2026-09-22");
  assert.match(entry?.id ?? "", /^2026-09-22\/013005-moonveil-ses_abcd-[0-9a-f]{4}$/);
  assert.equal(entry?.meta?.to, "2026-09-22T01:30:05+09:00");
  assert.equal(entry?.body, "did x");
});

test("journalSession writes, respects the cooldown, and only summarizes new messages", async () => {
  const h = new FakeHarness();
  const clock = { t: new Date("2026-09-21T03:00:00Z") };
  const c = await ctx(h, clock);
  h.transcripts.set("s1", [msg("m1", "2026-09-21T02:00:00Z"), msg("m2", "2026-09-21T02:30:00Z")]);
  assert.equal(await journalSession(c, "s1"), "written");
  assert.equal(await journalSession(c, "s1"), "cooldown");
  clock.t = new Date(clock.t.getTime() + COOLDOWN_MS + 1);
  assert.equal(await journalSession(c, "s1"), "nothing-new");
  h.transcripts.get("s1")?.push(msg("m3", "2026-09-21T03:20:00Z"));
  assert.equal(await journalSession(c, "s1"), "written");
  assert.equal(h.calls, 2);
  assert.equal((await listEntries(c.projectDir)).length, 2);
});

test("a summary line that looks like a secret is redacted before it is written", () => {
  const out = redactSecrets(`fixed the deploy\nused ${j("gh", "p_", "Qm7Zr2Kx9Lp4Tw8Vb3Nc6Hd1Fg5Js0YtQm7Z")} to push`);
  assert.equal(out, "fixed the deploy\n[redacted by the secret scan: github-token]");
});

test("catch-up journals sessions whose idle event never completed, newest first, up to the limit", async () => {
  const h = new FakeHarness();
  const clock = { t: new Date("2026-09-21T03:00:00Z") };
  const c = await ctx(h, clock);
  const sessions: SessionRef[] = [];
  for (let i = 0; i < 7; i++) {
    h.transcripts.set(`s${i}`, [msg(`m${i}`, "2026-09-21T02:00:00Z")]);
    sessions.push({ id: `s${i}`, directory: "/code", updated: 1000 + i, parentId: null });
  }
  sessions.push({ id: "child", directory: "/code", updated: 5000, parentId: "s1" });
  assert.equal((await catchUp(c, sessions, 5)).written, 5);
  assert.equal((await catchUp(c, sessions, 5)).written, 2, "the two older sessions are caught up next time");
  assert.equal((await catchUp(c, sessions, 5)).written, 0);
});

async function entryOn(projectDir: string, iso: string, summary: string): Promise<void> {
  const at = new Date(iso);
  await writeJournalEntry(projectDir, { machine: "a", session: "s", branch: "main", from: at, to: at, model: "m", summary, timezone: TZ });
}

function rollupCtx(projectDir: string, digestDir: string, nowIso: string, calls: string[]) {
  return {
    projectDir,
    digestDir,
    timezone: TZ,
    now: new Date(nowIso),
    async summarize(req: { kind: "day" | "month"; label: string; texts: string[] }): Promise<string> {
      calls.push(`${req.kind}:${req.label}`);
      return `${req.kind} ${req.label}: ${req.texts.length} item(s)`;
    },
  };
}

test("rollups: unchanged membership costs no model call and rewrites nothing", async () => {
  const root = await tempDir();
  const projectDir = join(root, "p");
  const digests = join(root, "digests");
  await entryOn(projectDir, "2026-09-18T03:00:00Z", "three days ago");
  await entryOn(projectDir, "2026-08-01T03:00:00Z", "last month");
  await entryOn(projectDir, "2026-09-21T03:00:00Z", "today");
  const calls: string[] = [];
  const first = await buildRollups(rollupCtx(projectDir, digests, "2026-09-21T05:00:00Z", calls));
  assert.equal(first.changed, true);
  assert.deepEqual(calls.sort(), ["day:2026-08-01", "day:2026-09-18", "month:2026-08"]);
  const recent = await readFile(join(projectDir, "remember", "recent.md"), "utf8");
  assert.match(recent, /## 2026-09-18/);
  assert.doesNotMatch(recent, /## 2026-09-21/, "today's entries are injected raw, not digested");

  const again = await buildRollups(rollupCtx(projectDir, digests, "2026-09-21T09:00:00Z", calls));
  assert.deepEqual(again, { changed: false, modelCalls: 0 });
  assert.equal(await readFile(join(projectDir, "remember", "recent.md"), "utf8"), recent);
});

test("rollups: crossing midnight moves days along even when no entry changed", async () => {
  const root = await tempDir();
  const projectDir = join(root, "p");
  const digests = join(root, "digests");
  await entryOn(projectDir, "2026-09-14T03:00:00Z", "eight days before the 22nd");
  await entryOn(projectDir, "2026-09-21T03:00:00Z", "today on the 21st");
  const calls: string[] = [];
  await buildRollups(rollupCtx(projectDir, digests, "2026-09-21T05:00:00Z", calls));
  assert.match(await readFile(join(projectDir, "remember", "recent.md"), "utf8"), /## 2026-09-14/);
  calls.length = 0;
  const next = await buildRollups(rollupCtx(projectDir, digests, "2026-09-22T05:00:00Z", calls));
  assert.equal(next.changed, true);
  assert.deepEqual(calls.sort(), ["day:2026-09-21", "month:2026-09"]);
  assert.doesNotMatch(await readFile(join(projectDir, "remember", "recent.md"), "utf8"), /## 2026-09-14/);
  assert.match(await readFile(join(projectDir, "remember", "archive.md"), "utf8"), /## 2026-09/);
});

test("rollups: a late entry from another machine regenerates only its own day", async () => {
  const root = await tempDir();
  const projectDir = join(root, "p");
  const digests = join(root, "digests");
  await entryOn(projectDir, "2026-09-18T03:00:00Z", "a");
  await entryOn(projectDir, "2026-09-19T03:00:00Z", "b");
  const calls: string[] = [];
  await buildRollups(rollupCtx(projectDir, digests, "2026-09-21T05:00:00Z", calls));
  calls.length = 0;
  await entryOn(projectDir, "2026-09-18T04:00:00Z", "late arrival");
  const r = await buildRollups(rollupCtx(projectDir, digests, "2026-09-21T06:00:00Z", calls));
  assert.equal(r.changed, true);
  assert.deepEqual(calls, ["day:2026-09-18"]);
  assert.match(await readFile(join(projectDir, "remember", "recent.md"), "utf8"), /day 2026-09-18: 2 item\(s\)/);
});

test("listEntries: a journal directory that cannot be listed is an error, never an empty list", async () => {
  const a = join(await tempDir(), "p");
  await mkdir(join(a, "remember"), { recursive: true });
  await writeFile(join(a, "remember", "journal"), "a file where the directory should be");
  await assert.rejects(listEntries(a), /ENOTDIR/);
});

test("listEntries: a day entry that is actually a file (a synced FILE named like a day) is skipped and reported, never fatal", async () => {
  const projectDir = join(await tempDir(), "p");
  const at = new Date("2026-09-20T03:00:00Z");
  await writeJournalEntry(projectDir, { machine: "a", session: "s", branch: "main", from: at, to: at, model: "m", summary: "ok", timezone: TZ });
  await mkdir(join(projectDir, "remember", "journal"), { recursive: true });
  await writeFile(join(projectDir, "remember", "journal", "2026-09-21"), "a file named like a day");
  const problems: string[] = [];
  const entries = await listEntries(projectDir, problems);
  assert.deepEqual(entries.map((e) => e.body), ["ok"]);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /journal day "2026-09-21" skipped: remember\/journal\/2026-09-21 cannot be listed \(ENOTDIR\)/);
  await assert.doesNotReject(listEntries(projectDir), "a caller that does not ask for problems still gets the entries, never throws");
});

test("listEntries: a missing journal directory has no entries", async () => {
  assert.deepEqual(await listEntries(join(await tempDir(), "p")), []);
});

test("listEntries: one entry that cannot be read is skipped and reported; the rest still load", async () => {
  const projectDir = join(await tempDir(), "p");
  const at = new Date("2026-09-21T03:00:00Z");
  await writeJournalEntry(projectDir, { machine: "a", session: "s", branch: "main", from: at, to: at, model: "m", summary: "readable", timezone: TZ });
  await mkdir(join(projectDir, "remember", "journal", "2026-09-21", "000000-bad.md"));
  const problems: string[] = [];
  const entries = await listEntries(projectDir, problems);
  assert.deepEqual(entries.map((e) => e.body), ["readable"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? "", /"2026-09-21\/000000-bad\.md" cannot be read \(EISDIR\)/);
  await assert.doesNotReject(listEntries(projectDir), "a caller that does not ask for problems still gets the entries");
});

test("listEntries: a symlinked day folder or entry is skipped and reported, never read", async () => {
  const outside = await tempDir("sro-outside-");
  const at = new Date("2026-09-21T03:00:00Z");
  await writeJournalEntry(join(outside, "p"), { machine: "a", session: "s", branch: "main", from: at, to: at, model: "m", summary: "OUTSIDE", timezone: TZ });
  const [target] = await listEntries(join(outside, "p"));
  const projectDir = join(await tempDir(), "p");
  await writeJournalEntry(projectDir, { machine: "a", session: "s", branch: "main", from: at, to: at, model: "m", summary: "inside", timezone: TZ });
  await symlink(target?.path ?? "", join(projectDir, "remember", "journal", "2026-09-21", "000000-link.md"));
  await symlink(join(outside, "p", "remember", "journal", "2026-09-21"), join(projectDir, "remember", "journal", "2026-09-20"));
  const problems: string[] = [];
  const entries = await listEntries(projectDir, problems);
  assert.deepEqual(entries.map((e) => e.body), ["inside"]);
  assert.equal(problems.length, 2, problems.join("\n"));
  assert.match(problems.join("\n"), /journal day "2026-09-20" skipped: remember\/journal\/2026-09-20 cannot be listed \(a symbolic link\)/);
  assert.match(problems.join("\n"), /"2026-09-21\/000000-link\.md" cannot be read \(a symbolic link\)/);
});

test("writeJournalEntry never writes through a symlinked journal folder", async () => {
  const outside = await tempDir("sro-outside-");
  const projectDir = join(await tempDir(), "p");
  await mkdir(join(projectDir, "remember", "journal"), { recursive: true });
  await symlink(outside, join(projectDir, "remember", "journal", "2026-09-21"));
  const at = new Date("2026-09-21T03:00:00Z");
  await assert.rejects(
    writeJournalEntry(projectDir, { machine: "a", session: "s", branch: "main", from: at, to: at, model: "m", summary: "x", timezone: TZ }),
    /remember\/journal\/2026-09-21 cannot be written \(a symbolic link\)/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("catch-up continues past a session that fails, and names it", async () => {
  const h = new FakeHarness();
  const c = await ctx(h, { t: new Date("2026-09-21T03:00:00Z") });
  h.transcripts.set("good", [msg("m1", "2026-09-21T02:00:00Z")]);
  const read = h.readTranscript.bind(h);
  h.readTranscript = async (id: string, after?: string) => {
    if (id === "bad") throw new Error("transcript store unavailable");
    return read(id, after);
  };
  const sessions: SessionRef[] = [
    { id: "bad", directory: "/code", updated: 2000, parentId: null },
    { id: "good", directory: "/code", updated: 1000, parentId: null },
  ];
  const r = await catchUp(c, sessions);
  assert.equal(r.written, 1);
  assert.deepEqual(r.failed, [{ session: "bad", error: "transcript store unavailable" }]);
  assert.deepEqual((await listEntries(c.projectDir)).map((e) => e.body), ["worked on the sync engine"]);
});

// A model call the test releases.
class GatedHarness extends FakeHarness {
  release: () => void = () => undefined;
  gate = new Promise<void>((resolve) => (this.release = resolve));
  override async callModel(): Promise<string> {
    this.calls++;
    await this.gate;
    return this.reply;
  }
}

test("a session is journaled once at a time: a call while one waits on the model writes nothing and calls no model", { timeout: 10_000 }, async () => {
  const clock = { t: new Date("2026-09-21T10:00:00Z") };
  const h = new GatedHarness();
  h.transcripts.set("s1", [msg("m1", "2026-09-21T09:00:00Z")]);
  const c = await ctx(h, clock);
  const first = journalSession(c, "s1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await journalSession(c, "s1"), "running");
  h.release();
  assert.equal(await first, "written");
  assert.equal(h.calls, 1);
  assert.equal((await listEntries(c.projectDir)).length, 1);
});

test("a position another writer saved later is never replaced by an older one", { timeout: 10_000 }, async () => {
  const clock = { t: new Date("2026-09-21T10:00:00Z") };
  const h = new GatedHarness();
  h.transcripts.set("s1", [msg("m1", "2026-09-21T09:00:00Z")]);
  const c = await ctx(h, clock);
  const first = journalSession(c, "s1");
  await new Promise((resolve) => setImmediate(resolve));
  // Meanwhile another session journaled s1 further (its catch-up, say).
  await mkdir(join(c.stateFile, ".."), { recursive: true });
  const newer = { lastMessageId: "m2", lastTime: Date.parse("2026-09-21T09:30:00Z"), journaledAt: clock.t.getTime() };
  await writeFile(c.stateFile, JSON.stringify({ sessions: { s1: newer } }));
  h.release();
  await first;
  assert.deepEqual(JSON.parse(await readFile(c.stateFile, "utf8")).sessions.s1, newer);
});

test("sessions journaled at once all keep their positions: no writer loses another's", { timeout: 10_000 }, async () => {
  const clock = { t: new Date("2026-09-21T10:00:00Z") };
  const h = new FakeHarness();
  const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
  for (const id of ids) h.transcripts.set(id, [msg(`${id}-m1`, "2026-09-21T09:00:00Z")]);
  const c = await ctx(h, clock);
  await Promise.all(ids.map((id) => journalSession(c, id)));
  const saved = JSON.parse(await readFile(c.stateFile, "utf8")).sessions;
  assert.deepEqual(Object.keys(saved).sort(), [...ids].sort());
});
