// Spec 8: the Harness (core/harness.ts) over OpenCode's SDK client. Core never sees the
// client; this file is the only place the adapter calls it for core.
import type { Harness, SessionRef, TranscriptChunk, TranscriptMessage } from "../../core/harness.ts";
import { errorText } from "../../core/store.ts";

// What an SDK call resolves to when it does not throw: data, or an error (the SDK's
// default). Only the fields the adapter reads are named.
type Result<T> = Promise<{ data?: T; error?: unknown }>;

export type PartLike = { type: string; text?: string; tool?: string; state?: { status: string; input?: unknown; output?: string; error?: string } };
export type ModelRef = { providerID: string; modelID: string };

// The SDK calls the adapter makes, narrowed to what it reads: the plugin's real client
// satisfies this without a cast (index.ts), and the tests fake it.
export interface OpenCodeClient {
  session: {
    get(o: { path: { id: string } }): Result<{ id: string; directory: string; parentID?: string }>;
    list(): Result<Array<{ id: string; directory: string; parentID?: string; time: { updated: number } }>>;
    messages(o: { path: { id: string } }): Result<Array<{ info: { id: string; role: string; time: { created: number } }; parts: PartLike[] }>>;
    create(o: { body: { parentID: string; title: string } }): Result<{ id: string }>;
    prompt(o: {
      path: { id: string };
      body: { model?: ModelRef; system: string; tools: Record<string, boolean>; parts: Array<{ type: "text"; text: string }> };
    }): Result<{ info: { error?: unknown }; parts: PartLike[] }>;
    delete(o: { path: { id: string } }): Result<unknown>;
  };
  tool: { ids(): Result<string[]> };
  config: { get(): Result<{ model?: string; small_model?: string }> };
  tui: { showToast(o: { body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error" } }): Result<unknown> };
}

async function data<T>(call: Result<T>, what: string): Promise<T> {
  const r = await call;
  if (r.error !== undefined || r.data === undefined) {
    const why = r.error === undefined ? "no data" : typeof r.error === "object" ? JSON.stringify(r.error) : errorText(r.error);
    throw new Error(`${what} failed: ${why}`);
  }
  return r.data;
}

// "provider/model", the form OpenCode's config uses; the model id may itself hold a slash.
export function parseModel(value: string | undefined): ModelRef | null {
  const at = value?.indexOf("/") ?? -1;
  if (value === undefined || at <= 0 || at === value.length - 1) return null;
  return { providerID: value.slice(0, at), modelID: value.slice(at + 1) };
}

export class OpenCodeHarness implements Harness {
  // The summarizer's own sessions: never initialized, never journaled (spec 7.1). Each
  // also has its parentID set, which is how sessions.ts skips task children; this set is
  // the second guard, and it is filled before the helper's first prompt.
  readonly helpers = new Set<string>();
  private readonly client: OpenCodeClient;
  private readonly option: string | undefined;
  private chosen: Promise<{ name: string; ref: ModelRef | null }> | null = null;

  constructor(client: OpenCodeClient, journalModelOption: string | undefined) {
    this.client = client;
    this.option = journalModelOption;
  }

  // D7: the journalModel option, else OpenCode's small_model, else its default model, all
  // read from the resolved config (a value such as "{env:X}/m" is substituted there).
  // None of them set is not a failure: the prompt then names no model and OpenCode uses
  // its own default. Read once per process.
  model(): Promise<{ name: string; ref: ModelRef | null }> {
    this.chosen ??= (async () => {
      if (this.option !== undefined) return { name: this.option, ref: parseModel(this.option) };
      // A config that cannot be read leaves OpenCode's own default, which the entry then
      // names: the journal is best effort and never fails for lack of a model (D7).
      const cfg = await data(this.client.config.get(), "reading the OpenCode config").catch(() => ({ model: undefined, small_model: undefined }));
      const name = cfg.small_model ?? cfg.model;
      return name === undefined ? { name: "the default model", ref: null } : { name, ref: parseModel(name) };
    })();
    return this.chosen;
  }

  async callModel(req: { system: string; prompt: string; parentSessionId: string }): Promise<string> {
    const { ref } = await this.model();
    const created = await data(
      this.client.session.create({ body: { parentID: req.parentSessionId, title: "superpower-remember-obsidian journal" } }),
      "creating the summarizer session",
    );
    this.helpers.add(created.id);
    try {
      // D10: the summarizer reads whole transcripts, so it gets no tools at all. OpenCode
      // 1.18.31 reads this map twice: as exact keys (a listed tool named false is dropped),
      // and as the helper session's permission rules, one per key, where "*" denies every
      // tool by wildcard. MCP tools are not in the server's list (measured), so "*" is what
      // turns them off; the listed ids are named too.
      const listed = await data(this.client.tool.ids(), "listing tools");
      const tools: Record<string, boolean> = { "*": false, ...Object.fromEntries(listed.map((id) => [id, false])) };
      const reply = await data(
        this.client.session.prompt({
          path: { id: created.id },
          body: { ...(ref === null ? {} : { model: ref }), system: req.system, tools, parts: [{ type: "text", text: req.prompt }] },
        }),
        "the summarizer",
      );
      // A reply can arrive with the provider's failure on it instead of text: that is a
      // failure, never an empty summary (journal.ts would write it and move past the
      // transcript for good).
      if (reply.info.error !== undefined) throw new Error(`the summarizer failed: ${JSON.stringify(reply.info.error)}`);
      const text = reply.parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      if (text.trim() === "") throw new Error("the summarizer returned no text");
      return text;
    } finally {
      // Housekeeping only: a helper left behind is a child session, which catch-up and
      // initialization both skip. Its id is kept until the session is gone.
      await this.client.session.delete({ path: { id: created.id } }).catch(() => undefined);
      this.helpers.delete(created.id);
    }
  }

  // Spec 6.2 and D10: the whole transcript after the last message journaled, in the order it
  // happened: text, and every tool call with its input and its output, its error, or that it
  // did not finish. A message id no longer in the session (reverted) gives the whole
  // session again: a repeated entry, never a lost one.
  async readTranscript(sessionId: string, afterMessageId?: string): Promise<TranscriptChunk> {
    const all = await data(this.client.session.messages({ path: { id: sessionId } }), `reading session ${sessionId}`);
    const from = afterMessageId === undefined ? 0 : all.findIndex((m) => m.info.id === afterMessageId) + 1;
    // A tool still running in the session's last message is left for the next read: the
    // journal keeps its place by message, so reading it now would move past a result that
    // has not arrived. One in an earlier message never will (the conversation went on).
    const running = (m: (typeof all)[number]): boolean =>
      m.parts.some((p) => p.type === "tool" && p.state !== undefined && p.state.status !== "completed" && p.state.status !== "error");
    const last = all.at(-1);
    const to = last !== undefined && running(last) ? all.length - 1 : all.length;
    const messages: TranscriptMessage[] = [];
    for (const m of all.slice(from, to)) {
      const role = m.info.role === "user" ? "user" : "assistant";
      const time = m.info.time.created;
      for (const p of m.parts) {
        if (p.type === "text" && p.text) messages.push({ id: m.info.id, role, text: p.text, time });
        if (p.type !== "tool" || p.state === undefined) continue;
        const call = `${p.tool ?? "tool"} ${JSON.stringify(p.state.input ?? {})}`;
        const text =
          p.state.status === "completed"
            ? `${call}: ${p.state.output ?? ""}`
            : p.state.status === "error"
              ? `${call} failed: ${p.state.error ?? ""}`
              : `${call} did not finish`;
        messages.push({ id: m.info.id, role: "tool", text, time });
      }
    }
    return { sessionId, messages };
  }

  async listSessions(): Promise<SessionRef[]> {
    const sessions = await data(this.client.session.list(), "listing sessions");
    return sessions.map((s) => ({ id: s.id, directory: s.directory, updated: s.time.updated, parentId: s.parentID ?? null }));
  }

  // The TUI toast (spec 7.2). Headless `opencode run` has no user channel; there the
  // status reaches the model and the next session's payload.
  async notify(message: string): Promise<void> {
    await data(this.client.tui.showToast({ body: { title: "superpower-remember-obsidian", message, variant: "error" } }), "showing a toast");
  }
}
