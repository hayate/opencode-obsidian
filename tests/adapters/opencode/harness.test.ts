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
  assert.deepEqual(await new OpenCodeHarness(client, "b/option").model(), { name: "b/option", ref: { providerID: "b", modelID: "option" } });
  assert.deepEqual(await new OpenCodeHarness(client, undefined).model(), { name: "a/small", ref: { providerID: "a", modelID: "small" } });
  client.cfg = { model: "a/default" };
  assert.deepEqual(await new OpenCodeHarness(client, undefined).model(), { name: "a/default", ref: { providerID: "a", modelID: "default" } });
  client.cfg = {};
  assert.deepEqual(await new OpenCodeHarness(client, undefined).model(), { name: "the default model", ref: null });
  client.cfg = null; // the config cannot be read: OpenCode's default, never a failure (D7)
  assert.deepEqual(await new OpenCodeHarness(client, undefined).model(), { name: "the default model", ref: null });
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
  await assert.rejects(harness.callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" }), /the summarizer failed: .*overloaded/);
  client.replyError = undefined;
  client.reply = [{ type: "text", text: "  \n" }, { type: "reasoning", text: "thinking" }];
  await assert.rejects(harness.callModel({ system: "S", prompt: "P", parentSessionId: "ses_p" }), /the summarizer returned no text/);
  assert.deepEqual(client.deleted, ["ses_helper_1", "ses_helper_2"], "each helper is deleted all the same");
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
  const running = { info: { id: "m2", role: "assistant", time: { created: 2 } }, parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "make" } } }] as PartLike[] };
  const client = new FakeClient([{ id: "ses_a", directory: "/code", messages: [{ info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "build it" }] }, running] }]);
  const harness = new OpenCodeHarness(client, undefined);
  const first = await harness.readTranscript("ses_a");
  assert.deepEqual(first.messages.map((m) => m.id), ["m1"], "the checkpoint stays before the running call");
  running.parts[0] = { type: "tool", tool: "bash", state: { status: "completed", input: { command: "make" }, output: "built" } };
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
