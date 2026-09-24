import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeHarness, parseModel, type PartLike } from "../../../adapters/opencode/harness.ts";
import { FakeClient } from "./fake-client.ts";

test("parseModel splits at the first slash, and refuses a value with no provider or no model", () => {
  assert.deepEqual(parseModel("anthropic/claude-haiku"), { providerID: "anthropic", modelID: "claude-haiku" });
  assert.deepEqual(parseModel("unsloth/unsloth/Qwen-GGUF"), { providerID: "unsloth", modelID: "unsloth/Qwen-GGUF" });
  for (const bad of [undefined, "", "noslash", "/model", "provider/"]) assert.equal(parseModel(bad), null, String(bad));
});

test("the journal model is the option, else small_model, else the default model, else none named", async () => {
  const client = new FakeClient();
  client.cfg = { model: "a/default", small_model: "a/small" };
  assert.deepEqual(await new OpenCodeHarness(client, "b/option").model(), { name: "b/option", ref: { providerID: "b", modelID: "option" }, source: 'journalModel "b/option"', problem: null });
  assert.deepEqual(await new OpenCodeHarness(client, undefined).model(), { name: "a/small", ref: { providerID: "a", modelID: "small" }, source: 'small_model "a/small"', problem: null });
  client.cfg = { model: "a/default" };
  assert.deepEqual(await new OpenCodeHarness(client, undefined).model(), { name: "a/default", ref: { providerID: "a", modelID: "default" }, source: 'model "a/default"', problem: null });
  client.cfg = {};
  assert.deepEqual(await new OpenCodeHarness(client, undefined).model(), { name: "the default model", ref: null, source: "OpenCode's default model", problem: null });
  client.cfg = null; // the config cannot be read: OpenCode's default, never a failure (D7), and told
  assert.equal((await new OpenCodeHarness(client, undefined).model()).ref, null);
});

test("callModel runs in a child session with every tool off (by wildcard and by id), returns the text, and deletes the helper", async () => {
  const client = new FakeClient();
  client.reply = [{ type: "reasoning", text: "thinking" }, { type: "text", text: "line one" }, { type: "text", text: "line two" }];
  const harness = new OpenCodeHarness(client, "p/m");
  const out = await harness.callModel({ system: "SYS", prompt: "TRANSCRIPT", parentSessionId: "ses_parent" });
  assert.equal(out, "line one\nline two");
  assert.deepEqual(client.created, [{ id: "ses_helper_1", parentID: "ses_parent" }]);
  assert.deepEqual(client.prompted, [
    { session: "ses_helper_1", model: { providerID: "p", modelID: "m" }, system: "SYS", tools: { "*": false, bash: false, read: false, edit: false, remember_sync: false }, text: "TRANSCRIPT" },
  ]);
  assert.deepEqual(client.deleted, ["ses_helper_1"]);
  assert.equal(harness.helpers.size, 0, "the helper's id is released once the helper is gone");
});

test("the helper is known before its first prompt", async () => {
  const client = new FakeClient();
  const harness = new OpenCodeHarness(client, undefined);
  const seen: boolean[] = [];
  const prompt = client.session.prompt;
  client.session.prompt = (o) => (seen.push(harness.helpers.has(o.path.id)), prompt(o));
  await harness.callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" });
  assert.deepEqual(seen, [true]);
});

test("a reply carrying the provider's failure, or no text, is a failure, never an empty summary", async () => {
  const client = new FakeClient();
  const harness = new OpenCodeHarness(client, undefined);
  client.replyError = { name: "APIError", data: { message: "overloaded" } };
  await assert.rejects(harness.callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" }), /the summarizer \(OpenCode's default model\) failed: .*overloaded/);
  client.replyError = undefined;
  client.reply = [{ type: "text", text: "  \n" }, { type: "reasoning", text: "thinking" }];
  await assert.rejects(harness.callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" }), /the summarizer \(OpenCode's default model\) returned no text/);
  assert.deepEqual(client.deleted, ["ses_helper_1", "ses_helper_2"], "each helper is deleted all the same");
});

test("every way the summarizer fails names the model setting it ran on, so a wrong one can be found and fixed", async () => {
  const client = new FakeClient();
  client.cfg = { model: "a/default", small_model: "a/small" };
  const call = (h: OpenCodeHarness) => h.callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" });
  // What a model OpenCode does not know gives (seen live, 2026-09-23): an HTTP 500 whose body names no model.
  client.replyFail = { status: 500, error: { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details." } } };
  await assert.rejects(call(new OpenCodeHarness(client, undefined)), /^Error: the summarizer \(small_model "a\/small"\) failed: HTTP 500 .*Unexpected server error/);
  client.replyFail = undefined;
  client.replyError = { name: "APIError", data: { message: "overloaded" } };
  await assert.rejects(call(new OpenCodeHarness(client, "b/option")), /^Error: the summarizer \(journalModel "b\/option"\) failed: .*overloaded/);
  client.replyError = undefined;
  client.reply = new Error("fetch failed");
  client.cfg = { model: "a/default" };
  await assert.rejects(call(new OpenCodeHarness(client, undefined)), /^Error: the summarizer \(model "a\/default"\) failed: fetch failed$/);
  client.reply = [{ type: "text", text: " " }];
  client.cfg = {};
  await assert.rejects(call(new OpenCodeHarness(client, undefined)), /^Error: the summarizer \(OpenCode's default model\) returned no text$/);
});

test("a call that rejects keeps its cause, and a rejected value that is not an Error reads as its JSON, as an error answer does", async () => {
  const client = new FakeClient();
  const call = () => new OpenCodeHarness(client, "p/m").callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" });
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4096"), { code: "ECONNREFUSED" });
  const fetchFailed = new TypeError("fetch failed", { cause: refused });
  client.replyReject = { value: fetchFailed };
  await assert.rejects(call(), (err: Error) => err.message === 'the summarizer (journalModel "p/m") failed: TypeError: fetch failed' && err.cause === fetchFailed);
  client.replyReject = { value: { name: "APIError", data: { message: "overloaded" } } };
  await assert.rejects(call(), /^Error: the summarizer \(journalModel "p\/m"\) failed: \{"name":"APIError","data":\{"message":"overloaded"\}\}$/);
  const bare = Object.assign(Object.create(null), { name: "Bare" });
  client.replyReject = { value: bare };
  await assert.rejects(call(), /^Error: the summarizer \(journalModel "p\/m"\) failed: \{"name":"Bare"\}$/);
});

test("readTranscript skips a text part whose text is not a string, as the reply does, and the journal still gets the rest", async () => {
  const client = new FakeClient([
    {
      id: "ses_a",
      directory: "/code",
      messages: [
        { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: { odd: true } as unknown as string }, { type: "text", text: "hello" }] },
      ],
    },
  ]);
  assert.deepEqual((await new OpenCodeHarness(client, undefined).readTranscript("ses_a")).messages, [{ id: "m1", role: "user", text: "hello", time: 1 }]);
});

test("callModel names no model when none is configured, and deletes the helper when the prompt fails", async () => {
  const client = new FakeClient();
  client.reply = new Error("provider down");
  const harness = new OpenCodeHarness(client, undefined);
  await assert.rejects(harness.callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" }), /provider down/);
  assert.equal(client.prompted[0]?.model, undefined);
  assert.deepEqual(client.deleted, ["ses_helper_1"]);
});

test("readTranscript keeps everything after the given message in order: text, and each tool call with its input and its output, error, or unfinished state", async () => {
  const client = new FakeClient([
    {
      id: "ses_a",
      directory: "/code",
      messages: [
        { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "old" }] },
        {
          info: { id: "m2", role: "assistant", time: { created: 2 } },
          parts: [
            { type: "text", text: "running it" },
            { type: "tool", tool: "bash", state: { status: "completed", input: { command: "make" }, output: "ok\n" } },
            { type: "tool", tool: "bash", state: { status: "error", input: { command: "make test" }, error: "exit 2: 1 failing" } },
            { type: "text", text: "one test fails" },
            { type: "tool", tool: "read", state: { status: "running", input: { path: "a.ts" } } },
          ],
        },
        { info: { id: "m3", role: "user", time: { created: 3 } }, parts: [{ type: "file" }] },
      ],
    },
  ]);
  const harness = new OpenCodeHarness(client, undefined);
  assert.deepEqual((await harness.readTranscript("ses_a", "m1")).messages, [
    { id: "m2", role: "assistant", text: "running it", time: 2 },
    { id: "m2", role: "tool", text: 'bash {"command":"make"}: ok\n', time: 2 },
    { id: "m2", role: "tool", text: 'bash {"command":"make test"} failed: exit 2: 1 failing', time: 2 },
    { id: "m2", role: "assistant", text: "one test fails", time: 2 },
    { id: "m2", role: "tool", text: 'read {"path":"a.ts"} did not finish', time: 2 },
  ]);
  assert.equal((await harness.readTranscript("ses_a", "gone")).messages.length, 6, "an unknown message id: the whole session");
  await assert.rejects(harness.readTranscript("ses_missing"), /reading session ses_missing failed: \{"name":"NotFoundError"\}/);
});

test("a tool still running in the last message is left for the next read, so its result is journaled when it arrives", async () => {
  const running = { info: { id: "m2", role: "assistant", time: { created: 2 } as { created: number; completed?: number } }, parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "make" } } }] as PartLike[] };
  const client = new FakeClient([{ id: "ses_a", directory: "/code", messages: [{ info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "build it" }] }, running] }]);
  const harness = new OpenCodeHarness(client, undefined);
  const first = await harness.readTranscript("ses_a");
  assert.deepEqual(first.messages.map((m) => m.id), ["m1"], "the checkpoint stays before the running call");
  running.parts[0] = { type: "tool", tool: "bash", state: { status: "completed", input: { command: "make" }, output: "built" } };
  running.info.time.completed = 3; // the step ended
  assert.deepEqual((await harness.readTranscript("ses_a", "m1")).messages.map((m) => m.text), ['bash {"command":"make"}: built']);
});

test("listSessions maps a missing parent to null, and notify shows an error toast", async () => {
  const client = new FakeClient([
    { id: "ses_top", directory: "/code", updated: 5 },
    { id: "ses_child", directory: "/code", parentID: "ses_top", updated: 6 },
  ]);
  const harness = new OpenCodeHarness(client, undefined);
  assert.deepEqual(await harness.listSessions(), [
    { id: "ses_top", directory: "/code", updated: 5, parentId: null },
    { id: "ses_child", directory: "/code", updated: 6, parentId: "ses_top" },
  ]);
  await harness.notify("sync stopped: x");
  assert.deepEqual(client.toasts, [{ message: "sync stopped: x", variant: "error" }]);
});

test("a last assistant message still streaming is left for the next read; its whole text is journaled once complete", async () => {
  const streaming = { info: { id: "m2", role: "assistant", time: { created: 2 } as { created: number; completed?: number } }, parts: [{ type: "text", text: "Starting" }] as PartLike[] };
  const client = new FakeClient([{ id: "ses_a", directory: "/code", messages: [{ info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "decide" }] }, streaming] }]);
  const harness = new OpenCodeHarness(client, undefined);
  assert.deepEqual((await harness.readTranscript("ses_a")).messages.map((m) => m.id), ["m1"]);
  streaming.info.time.completed = 3;
  streaming.parts = [{ type: "text", text: "Starting. Decided: ship it" }];
  assert.deepEqual((await harness.readTranscript("ses_a", "m1")).messages.map((m) => m.text), ["Starting. Decided: ship it"]);
});

test("an SDK failure names the HTTP status, even with an empty body", async () => {
  const client = new FakeClient();
  client.session.list = () => Promise.resolve({ error: {}, response: { status: 503 } });
  await assert.rejects(new OpenCodeHarness(client, undefined).listSessions(), /listing sessions failed: HTTP 503/);
});

test("a journal model that is not provider/model is told, and the entry does not claim it ran", async () => {
  const client = new FakeClient();
  const chosen = await new OpenCodeHarness(client, "haiku").model();
  assert.equal(chosen.ref, null);
  assert.match(chosen.name, /^haiku \(not provider\/model: OpenCode's default model ran\)$/);
  assert.match(chosen.problem ?? "", /journalModel "haiku" is not provider\/model/);
  client.cfg = { small_model: "nomodel" };
  assert.match((await new OpenCodeHarness(client, undefined).model()).problem ?? "", /small_model "nomodel" is not provider\/model/);
  // Its failure names the model that ran, OpenCode's default, and the setting that sent it there.
  assert.equal(chosen.source, `OpenCode's default model, as journalModel "haiku" is not provider/model`);
  client.replyError = { name: "APIError", data: { message: "overloaded" } };
  await assert.rejects(new OpenCodeHarness(client, "haiku").callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" }), /^Error: the summarizer \(OpenCode's default model, as journalModel "haiku" is not provider\/model\) failed: /);
});

test("a config that cannot be read is told, and read again next time", async () => {
  const client = new FakeClient();
  client.cfg = null;
  const harness = new OpenCodeHarness(client, undefined);
  const first = await harness.model();
  assert.equal(first.ref, null);
  assert.equal(first.source, "OpenCode's default model");
  // Said once: the error already says what was being read.
  assert.match(first.problem ?? "", /^reading the OpenCode config failed: .*unreadable.*; the journal uses OpenCode's default model this time$/);
  client.cfg = { small_model: "p/small" };
  assert.deepEqual(await harness.model(), { name: "p/small", ref: { providerID: "p", modelID: "small" }, source: 'small_model "p/small"', problem: null });
});

test("the log writes each line at its own level", async () => {
  const client = new FakeClient([]);
  const harness = new OpenCodeHarness(client, undefined);
  await harness.log("warn", "a warning");
  await harness.logError("an error");
  assert.deepEqual(client.logs.map((l) => [l.level, l.message]), [["warn", "a warning"], ["error", "an error"]]);
});
