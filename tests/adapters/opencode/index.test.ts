import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginInput } from "@opencode-ai/plugin";
import plugin, { assemble, BOOTSTRAP, rememberSync, SuperpowerRememberObsidian } from "../../../adapters/opencode/index.ts";
import { PAYLOAD_MARKER } from "../../../core/inject.ts";
import { FakeClient } from "./fake-client.ts";
import type { Message } from "../../../adapters/opencode/sessions.ts";

// The plugin reads process.env: no test may ever reach the vault of the machine it runs on.
delete process.env.OBSIDIAN_VAULT_PATH;
delete process.env.OBSIDIAN_PROJECTS_REMOTE;

async function hooks(client: FakeClient) {
  // The tests' fake client stands in for the SDK client; nothing else of PluginInput is read.
  return SuperpowerRememberObsidian({ client, directory: "/code" } as unknown as PluginInput, { journalModel: "p/m" });
}

function user(sessionID: string): Message[] {
  return [{ info: { id: "u1", sessionID, role: "user" }, parts: [{ id: "p1", sessionID, messageID: "u1", type: "text", text: "hello" }] }];
}

test("the module exports the plugin both ways OpenCode 1.x loads one", () => {
  assert.equal(plugin.server, SuperpowerRememberObsidian);
  assert.equal(plugin.id, "superpower-remember-obsidian");
});

test("a session starts with the bootstrap and core's payload, and the user is told memory is off", async () => {
  const client = new FakeClient([{ id: "ses_top", directory: "/code" }]);
  const h = await hooks(client);
  const messages = user("ses_top");
  await h["experimental.chat.messages.transform"]?.({}, { messages } as never);
  const payload = messages[0]?.parts[0]?.text ?? "";
  assert.ok(payload.startsWith(PAYLOAD_MARKER));
  assert.ok(payload.includes(BOOTSTRAP));
  assert.match(payload, /memory and sync disabled: OBSIDIAN_VAULT_PATH/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.toasts.length, 1);
  assert.match(client.toasts[0]?.message ?? "", /memory and sync disabled/);
});

test("remember_sync answers from the session's memory, with the adopt option off unless asked", async () => {
  const client = new FakeClient([{ id: "ses_top", directory: "/code" }]);
  const h = await hooks(client);
  const sync = h.tool?.remember_sync;
  assert.ok(sync);
  assert.deepEqual(Object.keys(sync.args), ["adopt_rewrite"]);
  const context = { sessionID: "ses_top" } as never;
  assert.match(await sync.execute({}, context) as string, /^memory is not initialized in this session/);
  await h["experimental.chat.messages.transform"]?.({}, { messages: user("ses_top") } as never);
  assert.match(await sync.execute({ adopt_rewrite: true }, context) as string, /memory and sync disabled/);
});

test("a hook never throws into OpenCode: a failure is told to the user", async () => {
  const client = new FakeClient();
  const h = await hooks(client);
  const broken = [{ info: { id: "u1", sessionID: "s", role: "user" }, parts: null }];
  await h["experimental.chat.messages.transform"]?.({}, { messages: broken } as never);
  assert.match(client.toasts[0]?.message ?? "", /^loading project memory failed: /);
  await h.event?.({ event: { type: "session.idle", properties: { sessionID: "never-seen" } } } as never);
  await h.event?.({ event: { type: "session.created", properties: {} } } as never);
  assert.equal(client.toasts.length, 1);
});

test("remember_sync adopts a rewritten remote only when the adopt option is given as true", async () => {
  const calls: Array<[string, boolean]> = [];
  const sync = rememberSync({ sync: async (id, adopt) => (calls.push([id, adopt]), "ok") }, async () => {});
  const context = { sessionID: "ses_top" } as never;
  await sync.execute({}, context);
  await sync.execute({ adopt_rewrite: false }, context);
  await sync.execute({ adopt_rewrite: true }, context);
  assert.deepEqual(calls, [["ses_top", false], ["ses_top", false], ["ses_top", true]]);
});

test("remember_sync that fails answers with the failure, and the user is told", async () => {
  const told: string[] = [];
  const sync = rememberSync({ sync: async () => Promise.reject(new Error("lock stranded")) }, async (m) => void told.push(m));
  assert.equal(await sync.execute({}, { sessionID: "ses_top" } as never), "remember_sync failed: lock stranded");
  assert.deepEqual(told, ["remember_sync failed: lock stranded"]);
});

test("a deleted session's memory is let go", async () => {
  const client = new FakeClient([{ id: "ses_top", directory: "/code" }]);
  const h = await hooks(client);
  await h["experimental.chat.messages.transform"]?.({}, { messages: user("ses_top") } as never);
  await h.event?.({ event: { type: "session.deleted", properties: { info: { id: "ses_top" } } } } as never);
  assert.match((await h.tool?.remember_sync?.execute({}, { sessionID: "ses_top" } as never)) as string, /^memory is not initialized/);
});

test("remember_sync that fails while the toast fails too still answers with the failure", async () => {
  const sync = rememberSync({ sync: async () => Promise.reject(new Error("lock stranded")) }, async () => Promise.reject(new Error("no TUI")));
  assert.equal(await sync.execute({}, { sessionID: "ses_top" } as never), "remember_sync failed: lock stranded");
});

test("the journalModel option reaches the journal's model, and one that is not a string is told", async () => {
  const client = new FakeClient();
  assert.deepEqual(await assemble({ client, directory: "/code" }, { journalModel: "p/m" }).harness.model(), { name: "p/m", ref: { providerID: "p", modelID: "m" }, source: 'journalModel "p/m"', problem: null });
  assert.match((await assemble({ client, directory: "/code" }, { journalModel: 42 }).harness.model()).problem ?? "", /journalModel "42" is not provider\/model/);
  client.cfg = { small_model: "a/small" };
  assert.equal((await assemble({ client, directory: "/code" }, {}).harness.model()).name, "a/small");
});

test("a malformed session.deleted event never throws into OpenCode", async () => {
  const client = new FakeClient();
  const h = await hooks(client);
  await h.event?.({ event: { type: "session.deleted", properties: {} } } as never);
  assert.deepEqual(client.toasts.map((t) => t.message).filter((m) => !/failed/.test(m)), []);
});
