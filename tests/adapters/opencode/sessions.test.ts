import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeHarness } from "../../../adapters/opencode/harness.ts";
import { Sessions, STATUS_MARKER, type Core, type Message } from "../../../adapters/opencode/sessions.ts";
import { PAYLOAD_MARKER, type StatusItem } from "../../../core/inject.ts";
import type { InitResult, SessionContext, SessionOptions } from "../../../core/session.ts";
import { FakeClient, type FakeSession } from "./fake-client.ts";

const CONTEXT = { project: "kabin-api" } as unknown as SessionContext;

// A core whose answers the test sets, recording what it was asked.
class FakeCore {
  inits: SessionOptions[] = [];
  idles: Array<{ sessionId: string; journalModel: string }> = [];
  syncs: Array<{ adoptRewrite: boolean | undefined }> = [];
  status: StatusItem[] = [];
  context: SessionContext | null = CONTEXT;
  background: Promise<StatusItem[]> = Promise.resolve([]);
  initGate: Promise<void> = Promise.resolve();
  idleItems: StatusItem[] | Error = [];
  // The context once the background work ends; the context itself unless a test says.
  settled: Promise<SessionContext | null> | null = null;
  // Held until the test opens it: the core's idle is in progress meanwhile.
  idleGate: Promise<void> = Promise.resolve();
  syncItems: StatusItem[] = [];
  core: Core = {
    initialize: async (opts) => {
      this.inits.push(opts);
      await this.initGate;
      return {
        payload: `${PAYLOAD_MARKER}\nPAYLOAD for ${opts.sessionId}`,
        status: this.status,
        context: this.context,
        background: this.background,
        settled: this.settled ?? Promise.resolve(this.context),
      } satisfies InitResult;
    },
    idle: async (_ctx, opts) => {
      this.idles.push({ sessionId: opts.sessionId, journalModel: opts.journalModel });
      await this.idleGate;
      if (this.idleItems instanceof Error) throw this.idleItems;
      return this.idleItems;
    },
    sync: async (_ctx, opts = {}) => {
      this.syncs.push({ adoptRewrite: opts.adoptRewrite });
      return this.syncItems;
    },
  };
}

function setup(sessions: FakeSession[] = [{ id: "ses_top", directory: "/code/kabin-api" }]) {
  const client = new FakeClient(sessions);
  client.cfg = { small_model: "p/small" };
  const harness = new OpenCodeHarness(client, undefined);
  const fake = new FakeCore();
  const registry = new Sessions({ client, harness, directory: "/plugin/dir", bootstrap: "BOOT", env: { X: "1" }, core: fake.core });
  return { client, harness, fake, registry };
}

// A conversation as OpenCode hands it to the transform: fresh objects every call.
function conversation(sessionId: string, users: string[]): Message[] {
  return users.flatMap((id, i) => [
    { info: { id, sessionID: sessionId, role: "user" }, parts: [{ id: `${id}_p`, sessionID: sessionId, messageID: id, type: "text", text: `question ${i}` }] },
    { info: { id: `${id}_a`, sessionID: sessionId, role: "assistant" }, parts: [{ id: `${id}_ap`, sessionID: sessionId, messageID: `${id}_a`, type: "text", text: "answer" }] },
  ]);
}

const texts = (m: Message | undefined): string[] => (m?.parts ?? []).map((p) => p.text ?? "");
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a top-level session is initialized once, in its own directory, with the journal model's name", async () => {
  const { fake, registry } = setup();
  let open!: () => void;
  fake.initGate = new Promise((resolve) => (open = resolve));
  const a = registry.transform(conversation("ses_top", ["u1"]));
  const b = registry.transform(conversation("ses_top", ["u1"]));
  await tick();
  open();
  await Promise.all([a, b]);
  await registry.transform(conversation("ses_top", ["u1", "u2"]));
  assert.equal(fake.inits.length, 1, "single-flight");
  assert.deepEqual(
    { dir: fake.inits[0]?.sessionDir, id: fake.inits[0]?.sessionId, model: fake.inits[0]?.journalModel, boot: fake.inits[0]?.bootstrap, env: fake.inits[0]?.env },
    { dir: "/code/kabin-api", id: "ses_top", model: "p/small", boot: "BOOT", env: { X: "1" } },
  );
});

test("the payload goes first in the first user message, once, and again on every fresh message list", async () => {
  const { registry } = setup();
  const first = conversation("ses_top", ["u1"]);
  await registry.transform(first);
  await registry.transform(first); // the same array again: no second copy
  assert.deepEqual(texts(first[0]), [`${PAYLOAD_MARKER}\nPAYLOAD for ses_top`, "question 0"]);
  assert.equal(first[0]?.parts[0]?.messageID, "u1");
  const later = conversation("ses_top", ["u1", "u2"]);
  await registry.transform(later);
  assert.equal(texts(later[0])[0], `${PAYLOAD_MARKER}\nPAYLOAD for ses_top`);
  assert.deepEqual(texts(later[2]), ["question 1"], "only the first user message carries it");
});

test("a task child and the summarizer's own sessions are never initialized, and a child is looked up once", async () => {
  const { client, harness, fake, registry } = setup([
    { id: "ses_top", directory: "/code" },
    { id: "ses_child", directory: "/code", parentID: "ses_top" },
  ]);
  harness.helpers.add("ses_helper");
  for (const id of ["ses_child", "ses_child", "ses_helper"]) {
    const msgs = conversation(id, ["u1"]);
    await registry.transform(msgs);
    assert.deepEqual(texts(msgs[0]), ["question 0"], id);
  }
  assert.equal(fake.inits.length, 0);
  assert.deepEqual(client.getCalls, ["ses_child"]);
  await registry.idle("ses_child");
  await registry.idle("ses_helper");
  assert.equal(fake.idles.length, 0, "no idle work for sessions never initialized");
});

test("a session whose lookup fails is initialized in the plugin's directory", async () => {
  const { client, fake, registry } = setup([]);
  await registry.transform(conversation("ses_unknown", ["u1"]));
  assert.equal(fake.inits[0]?.sessionDir, "/plugin/dir");
  assert.deepEqual(client.getCalls, ["ses_unknown"]);
});

test("status that arrives later sits on the user message latest when it arrived, and stays there", async () => {
  const { client, fake, registry } = setup();
  let deliver!: (items: StatusItem[]) => void;
  fake.background = new Promise((resolve) => (deliver = resolve));
  await registry.transform(conversation("ses_top", ["u1", "u2"]));
  deliver([{ level: "warn", text: "held back by the secret scan (aws): \"a.md\"" }, { level: "error", text: "sync stopped: x" }]);
  await tick();
  const next = conversation("ses_top", ["u1", "u2", "u3"]);
  await registry.transform(next);
  await registry.transform(next);
  const note = texts(next[2]).filter((t) => t.startsWith(STATUS_MARKER));
  assert.equal(note.length, 1, "on u2, once");
  assert.match(note[0] ?? "", /- \[warn\] held back by the secret scan/);
  assert.match(note[0] ?? "", /- \[error\] sync stopped: x/);
  assert.deepEqual(texts(next[4]), ["question 2"], "u3 is untouched: the note does not move to each new message");
  assert.deepEqual(client.toasts, [{ message: "sync stopped: x", variant: "error" }], "the user is told of the error, once");
});

test("a note whose message a compaction removed moves to the latest user message, and stays on that one", async () => {
  const { fake, registry } = setup();
  fake.background = Promise.resolve([{ level: "warn", text: "late" }]);
  await registry.transform(conversation("ses_top", ["u1"]));
  await tick();
  const compacted = conversation("ses_top", ["u9"]);
  await registry.transform(compacted);
  const hasNote = (m: Message | undefined): boolean => texts(m).some((t) => t.startsWith(STATUS_MARKER) && t.includes("- [warn] late"));
  assert.ok(hasNote(compacted[0]));
  const after = conversation("ses_top", ["u9", "u10"]);
  await registry.transform(after);
  assert.ok(hasNote(after[0]), "still on u9");
  assert.ok(!hasNote(after[2]), "never moved to each new message: that would break the prompt cache every turn");
});

test("the initial status's errors are told to the user; a line already shown is never shown again", async () => {
  const { client, fake, registry } = setup();
  fake.status = [{ level: "error", text: "sync stopped: x" }, { level: "info", text: "fine" }];
  fake.idleItems = [{ level: "error", text: "sync stopped: x" }];
  await registry.transform(conversation("ses_top", ["u1"]));
  await tick();
  await registry.idle("ses_top");
  const msgs = conversation("ses_top", ["u1", "u2"]);
  await registry.transform(msgs);
  assert.ok(!msgs.flatMap(texts).some((t) => t.startsWith(STATUS_MARKER)), "the idle repeated what the payload said");
  assert.deepEqual(client.toasts.map((t) => t.message), ["sync stopped: x"]);
});

test("idle runs the core's idle one at a time: idles during one run it once more, not once each; a failure is a note", async () => {
  const { fake, registry } = setup();
  await registry.transform(conversation("ses_top", ["u1"]));
  let open!: () => void;
  fake.idleGate = new Promise((resolve) => (open = resolve));
  const running = registry.idle("ses_top");
  await tick();
  const during = [registry.idle("ses_top"), registry.idle("ses_top"), registry.idle("ses_top")];
  open();
  await Promise.all([running, ...during]);
  assert.deepEqual(fake.idles, [
    { sessionId: "ses_top", journalModel: "p/small" },
    { sessionId: "ses_top", journalModel: "p/small" },
  ]);
  fake.idles = [];
  fake.idleItems = new Error("disk full");
  await registry.idle("ses_top");
  assert.equal(fake.idles.length, 1);
  const msgs = conversation("ses_top", ["u1"]);
  await registry.transform(msgs);
  assert.ok(texts(msgs[0]).some((t) => t.includes("- [error] idle sync failed: disk full")));
});

test("a session without memory does nothing on idle, and remember_sync answers with why", async () => {
  const { fake, registry } = setup();
  fake.context = null;
  fake.status = [{ level: "error", text: "memory and sync disabled: OBSIDIAN_VAULT_PATH is not set" }];
  await registry.transform(conversation("ses_top", ["u1"]));
  await registry.idle("ses_top");
  assert.equal(fake.idles.length, 0);
  assert.equal(await registry.sync("ses_top", false), "- [error] memory and sync disabled: OBSIDIAN_VAULT_PATH is not set");
  assert.equal(fake.syncs.length, 0);
});

test("remember_sync passes the adopt option, answers with the lines, and a line it gave is not repeated by an idle", async () => {
  const { fake, registry } = setup();
  assert.match(await registry.sync("ses_nobody", false), /^memory is not initialized in this session/);
  await registry.transform(conversation("ses_top", ["u1"]));
  assert.equal(await registry.sync("ses_top", false), "synced: nothing to report");
  fake.syncItems = [{ level: "warn", text: "held back by the secret scan (aws): \"a.md\"" }];
  assert.equal(await registry.sync("ses_top", true), "- [warn] held back by the secret scan (aws): \"a.md\"");
  assert.deepEqual(fake.syncs, [{ adoptRewrite: false }, { adoptRewrite: true }]);
  fake.idleItems = fake.syncItems;
  await registry.idle("ses_top");
  const msgs = conversation("ses_top", ["u1"]);
  await registry.transform(msgs);
  assert.ok(!msgs.flatMap(texts).some((t) => t.startsWith(STATUS_MARKER)));
});

test("a problem that stays is told once; one that clears and comes back is told again", async () => {
  const { client, fake, registry } = setup();
  const stopped: StatusItem = { level: "error", text: "sync stopped: x" };
  await registry.transform(conversation("ses_top", ["u1"]));
  for (const report of [[stopped], [stopped], [], [stopped]]) {
    fake.idleItems = report;
    await registry.idle("ses_top");
  }
  const msgs = conversation("ses_top", ["u1"]);
  await registry.transform(msgs);
  assert.equal(texts(msgs[0]).filter((t) => t.startsWith(STATUS_MARKER) && t.includes("sync stopped: x")).length, 2);
  assert.deepEqual(client.toasts.map((t) => t.message), ["sync stopped: x", "sync stopped: x"]);
});

test("a line remember_sync just gave is taken out of a note not delivered yet", async () => {
  const { fake, registry } = setup();
  const held: StatusItem = { level: "warn", text: "held back by the secret scan (aws): \"a.md\"" };
  let deliver!: (items: StatusItem[]) => void;
  fake.background = new Promise((resolve) => (deliver = resolve));
  await registry.transform(conversation("ses_top", ["u1"]));
  deliver([held, { level: "warn", text: "other" }]);
  await tick();
  fake.syncItems = [held];
  assert.equal(await registry.sync("ses_top", false), `- [warn] ${held.text}`);
  const msgs = conversation("ses_top", ["u1"]);
  await registry.transform(msgs);
  const notes = texts(msgs[0]).filter((t) => t.startsWith(STATUS_MARKER));
  assert.equal(notes.length, 1);
  assert.ok(notes[0]?.includes("- [warn] other") && !notes[0]?.includes("secret scan"), notes[0]);
});

test("a session first taken for top-level on a failed lookup is dropped once a lookup says it is a child", async () => {
  const { client, fake, registry } = setup([]);
  await registry.transform(conversation("ses_x", ["u1"]));
  assert.equal(fake.inits.length, 1, "the failed lookup initialized it, in the plugin's directory");
  await registry.idle("ses_x");
  assert.equal(fake.idles.length, 0, "no idle work while it is not known to be top-level");
  client.sessions.set("ses_x", { id: "ses_x", directory: "/code", parentID: "ses_top" });
  const msgs = conversation("ses_x", ["u1", "u2"]);
  await registry.transform(msgs);
  assert.deepEqual(texts(msgs[0]), ["question 0"], "no payload once it is known to be a child");
  await registry.idle("ses_x");
  assert.equal(fake.idles.length, 0);
  assert.match(await registry.sync("ses_x", false), /^memory is not initialized in this session/);
});

test("a session first taken for top-level on a failed lookup is confirmed by a later one, and idles", async () => {
  const { client, fake, registry } = setup([]);
  await registry.transform(conversation("ses_x", ["u1"]));
  client.sessions.set("ses_x", { id: "ses_x", directory: "/code" });
  await registry.idle("ses_x");
  assert.equal(fake.idles.length, 1);
});

test("idle waits for initialization to settle, and does nothing when the pull disabled memory", async () => {
  const { fake, registry } = setup();
  let settle!: (ctx: SessionContext | null) => void;
  fake.settled = new Promise((resolve) => (settle = resolve));
  fake.background = Promise.resolve([{ level: "error", text: "after sync memory and sync are disabled: x; restart the session" }]);
  await registry.transform(conversation("ses_top", ["u1"]));
  const idle = registry.idle("ses_top");
  await tick();
  assert.equal(fake.idles.length, 0, "not while initialization's work is still running");
  settle(null);
  await idle;
  assert.equal(fake.idles.length, 0);
  assert.match(await registry.sync("ses_top", false), /after sync memory and sync are disabled: x; restart the session/);
  assert.equal(fake.syncs.length, 0);
});

test("a deleted session is forgotten", async () => {
  const { fake, registry } = setup();
  await registry.transform(conversation("ses_top", ["u1"]));
  registry.forget("ses_top");
  await registry.idle("ses_top");
  assert.equal(fake.idles.length, 0);
  assert.match(await registry.sync("ses_top", false), /^memory is not initialized/);
});

test("a note already delivered is never changed by remember_sync, or the prompt cache would break", async () => {
  const { fake, registry } = setup();
  const held: StatusItem = { level: "warn", text: "held back by the secret scan (aws): \"a.md\"" };
  fake.background = Promise.resolve([held]);
  await registry.transform(conversation("ses_top", ["u1"]));
  await tick();
  const before = conversation("ses_top", ["u1"]);
  await registry.transform(before);
  fake.syncItems = [held];
  await registry.sync("ses_top", false);
  const after = conversation("ses_top", ["u1"]);
  await registry.transform(after);
  assert.deepEqual(texts(after[0]), texts(before[0]));
  assert.ok(texts(after[0]).some((t) => t.includes("secret scan")));
});

test("remember_sync's answer when the pull disabled memory is taken out of the note not delivered yet", async () => {
  const { client, fake, registry } = setup();
  const off: StatusItem = { level: "error", text: "after sync memory and sync are disabled: x; restart the session" };
  fake.status = [{ level: "error", text: "sync stopped: y" }];
  fake.settled = Promise.resolve(null);
  fake.background = Promise.resolve([off]);
  await registry.transform(conversation("ses_top", ["u1"]));
  await tick();
  const toasts = client.toasts.length;
  assert.match(await registry.sync("ses_top", false), /after sync memory and sync are disabled/);
  assert.equal(client.toasts.length, toasts, "no second toast for what the user was already told");
  const msgs = conversation("ses_top", ["u1"]);
  await registry.transform(msgs);
  assert.ok(!texts(msgs[0]).some((t) => t.startsWith(STATUS_MARKER)), "not told twice");
});
