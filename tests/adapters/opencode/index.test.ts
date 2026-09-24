import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginInput } from "@opencode-ai/plugin";
import plugin, { assemble, BOOTSTRAP, rememberSync, SuperpowerRememberObsidian } from "../../../adapters/opencode/index.ts";
import { PAYLOAD_MARKER } from "../../../core/inject.ts";
import { FakeClient } from "./fake-client.ts";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { commitFile, initRepo, tempDir } from "../../core/helpers.ts";
import type { Message } from "../../../adapters/opencode/sessions.ts";

// The plugin reads process.env: no test may ever reach the vault of the machine it runs on.
delete process.env.OBSIDIAN_VAULT_PATH;
delete process.env.OBSIDIAN_PROJECTS_REMOTE;

async function hooks(client: FakeClient) {
  // The tests' fake client stands in for the SDK client; nothing else of PluginInput is read.
  return SuperpowerRememberObsidian({ client, directory: "/code" } as unknown as PluginInput, { journalModel: "p/m" });
}

// These tests run with no vault, so the plugin's load-time toast (tested below) is left out of
// counts that are about something else.
const besidesVault = (toasts: Array<{ message: string }>) => toasts.filter((t) => !t.message.startsWith("memory and sync disabled: "));

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
  assert.equal(besidesVault(client.toasts).length, 1);
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
  assert.deepEqual(besidesVault(client.toasts).map((t) => t.message).filter((m) => !/failed/.test(m)), []);
});

// Measured with the real TUI (2026-09-23, OpenCode 1.18.32, 5 runs each): a toast sent while the
// plugin loads is never drawn; one sent on the first event that is not the TUI's own always is.
// A tui.* event can come first (another plugin's toast at load), and is not that signal.
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function until(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(cond(), `timed out waiting for ${what}`);
}

test("a missing vault is told as the plugin loads: logged at once, and a toast on the first event that is not the TUI's own", async () => {
  const client = new FakeClient();
  const h = await hooks(client);
  await settle();
  assert.deepEqual(client.logs, [
    { service: "superpower-remember-obsidian", level: "error", message: "memory and sync disabled: OBSIDIAN_VAULT_PATH is not set: this plugin needs it set to the absolute path of your Obsidian vault" },
  ]);
  assert.deepEqual(client.toasts, [], "nothing is drawn yet: the TUI may not be listening");
  for (const type of ["tui.toast.show", "tui.prompt.append", "tui.command.execute"]) {
    await h.event?.({ event: { type, properties: {} } } as never);
  }
  assert.deepEqual(client.toasts, [], "the TUI's own events (every tui.* type the SDK has) are not the signal");
  await h.event?.({ event: { type: "plugin.added", properties: {} } } as never);
  await h.event?.({ event: { type: "catalog.updated", properties: {} } } as never);
  assert.deepEqual(client.toasts, [{ message: client.logs[0]?.message ?? "", variant: "error" }], "once");
});

test("a usable vault is not told at load", async () => {
  const vault = await tempDir();
  await mkdir(join(vault, ".obsidian"));
  process.env.OBSIDIAN_VAULT_PATH = vault;
  try {
    const client = new FakeClient();
    const h = await hooks(client);
    await h.event?.({ event: { type: "plugin.added", properties: {} } } as never);
    // The check reads the disk; give it far longer than it takes before saying nothing came.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual([client.logs, client.toasts], [[], []]);
  } finally {
    delete process.env.OBSIDIAN_VAULT_PATH;
  }
});

test("a vault path that is not a vault is told at load with core's own reason", async () => {
  process.env.OBSIDIAN_VAULT_PATH = await tempDir(); // a directory with no .obsidian/
  try {
    const client = new FakeClient();
    const h = await hooks(client);
    await until("the log", () => client.logs.length > 0);
    await h.event?.({ event: { type: "plugin.added", properties: {} } } as never);
    await until("the toast", () => client.toasts.length > 0);
    assert.match(client.logs[0]?.message ?? "", /^memory and sync disabled: OBSIDIAN_VAULT_PATH ".*" is not an Obsidian vault \(no \.obsidian\/ folder\)$/);
    assert.equal(client.toasts[0]?.message, client.logs[0]?.message);
  } finally {
    delete process.env.OBSIDIAN_VAULT_PATH;
  }
});

test("the first event can come before the load-time check has finished: the toast still follows", async () => {
  process.env.OBSIDIAN_VAULT_PATH = await tempDir(); // not a vault: finding that out reads the disk
  try {
    const client = new FakeClient();
    const h = await hooks(client);
    await h.event?.({ event: { type: "plugin.added", properties: {} } } as never);
    assert.equal(client.logs.length, 0, "precondition: the check is still reading the disk");
    await until("the toast", () => client.toasts.length > 0);
    assert.match(client.toasts[0]?.message ?? "", /is not an Obsidian vault/);
  } finally {
    delete process.env.OBSIDIAN_VAULT_PATH;
  }
});

test("at load, a log that fails still leaves the toast, and a TUI that refuses toasts (headless) still leaves the log; neither throws", async () => {
  const noLog = new FakeClient();
  noLog.logFails = true;
  const a = await hooks(noLog);
  await settle();
  await a.event?.({ event: { type: "plugin.added", properties: {} } } as never);
  await until("the toast", () => noLog.toasts.length > 0);
  const noTui = new FakeClient();
  noTui.toastFails = true;
  const b = await hooks(noTui);
  await b.event?.({ event: { type: "plugin.added", properties: {} } } as never);
  await until("the log", () => noTui.logs.length > 0);
  // An unhandled rejection from either channel would fail this file; give one a turn to surface.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual([noLog.logs.length, noTui.toasts.length], [0, 0]);
});

test("the bootstrap tells the model remember/ is the plugin's", () => {
  assert.match(BOOTSTRAP, /`remember\/` .*written by this plugin only/);
});

test("the config hook grants nothing without a vault", async () => {
  const client = new FakeClient([{ id: "ses_top", directory: "/code" }]);
  const h = await hooks(client);
  assert.ok(h.config, "the plugin has a config hook");
  const cfg = { permission: { external_directory: "ask" } };
  await h.config?.(cfg as never);
  assert.deepEqual(cfg, { permission: { external_directory: "ask" } });
});

test("the config hook grants the project's folder with a vault", async () => {
  const root = join(await tempDir("sro-index-"), "Da Vinci");
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Projects"));
  const code = join(await tempDir(), "kabin-api");
  await initRepo(code);
  await commitFile(code, "README.md", "x\n", "init");
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    const h = await SuperpowerRememberObsidian({ client: new FakeClient([]), directory: code } as unknown as PluginInput, {});
    const cfg: { permission?: Record<string, unknown> } = {};
    await h.config?.(cfg as never);
    const dir = join(await realpath(root), "Projects", "kabin-api");
    assert.deepEqual(cfg.permission, { external_directory: { [`${dir}/**`]: "allow" } });
  } finally {
    delete process.env.OBSIDIAN_VAULT_PATH;
  }
});

test("assemble builds the vault access the sessions tell", () => {
  const { access, sessions } = assemble({ client: new FakeClient([]), directory: "/code" }, {});
  assert.deepEqual(access.lines(), []);
  assert.ok(sessions);
});

test("vault access reaches the sessions: one whose project is not the granted one is told on its first request", async () => {
  const root = join(await tempDir("sro-index-"), "Da Vinci");
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Projects"));
  const parent = await tempDir();
  for (const name of ["kabin-api", "canonical-a"]) {
    await initRepo(join(parent, name));
    await commitFile(join(parent, name), "README.md", "x\n", "init");
  }
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    const client = new FakeClient([{ id: "ses_b", directory: join(parent, "canonical-a") }]);
    client.cfg = { small_model: "p/small" };
    const h = await SuperpowerRememberObsidian({ client, directory: join(parent, "kabin-api") } as unknown as PluginInput, {});
    await h.config?.({} as never);
    const messages = user("ses_b");
    await h["experimental.chat.messages.transform"]?.({}, { messages } as never);
    const all = messages[0]?.parts.map((p) => p.text ?? "").join("\n") ?? "";
    assert.match(all, /vault file access was granted for Projects\/kabin-api at startup, but this session's project is Projects\/canonical-a; restart OpenCode to move it/);
  } finally {
    delete process.env.OBSIDIAN_VAULT_PATH;
  }
});

test("vault access lines reach OpenCode's log at their own level", async () => {
  const root = join(await tempDir("sro-index-"), "Da Vinci");
  await mkdir(join(root, ".obsidian"), { recursive: true });
  await mkdir(join(root, "Projects"));
  const odd = join(await tempDir(), "a*b");
  await mkdir(odd);
  process.env.OBSIDIAN_VAULT_PATH = root;
  try {
    const client = new FakeClient([]);
    const h = await SuperpowerRememberObsidian({ client, directory: odd } as unknown as PluginInput, {});
    await h.config?.({} as never);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(client.logs.some((l) => l.level === "warn" && l.message.startsWith("vault file access: the path")), JSON.stringify(client.logs));
  } finally {
    delete process.env.OBSIDIAN_VAULT_PATH;
  }
});
