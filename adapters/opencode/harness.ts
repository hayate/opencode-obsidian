// Spec 8: the Harness (core/harness.ts) over OpenCode's SDK client. Core never sees the
// client; this file is the only place the adapter calls it for core.
import type { Harness, SessionRef, TranscriptChunk, TranscriptMessage } from "../../core/harness.ts";
import { errorText } from "../../core/store.ts";

// What an SDK call resolves to when it does not throw: data, or an error (the SDK's
// default). Only the fields the adapter reads are named.
type Result<T> = Promise<{ data?: T; error?: unknown; response?: { status: number } }>;

export type PartLike = { type: string; text?: string; tool?: string; state?: { status: string; input?: unknown; output?: string; error?: string } };
export type ModelRef = { providerID: string; modelID: string };

// The SDK calls the adapter makes, narrowed to what it reads: the plugin's real client
// satisfies this without a cast (index.ts), and the tests fake it.
export interface OpenCodeClient {
  session: {
    get(o: { path: { id: string } }): Result<{ id: string; directory: string; parentID?: string }>;
    list(): Result<Array<{ id: string; directory: string; parentID?: string; time: { updated: number } }>>;
    messages(o: { path: { id: string } }): Result<Array<{ info: { id: string; role: string; time: { created: number; completed?: number } }; parts: PartLike[] }>>;
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
  app: { log(o: { body: { service: string; level: "debug" | "info" | "warn" | "error"; message: string } }): Result<unknown> };
}

// A failure as text: an Error as its message; any other object (the error body the SDK parsed,
// or a value a client threw) as its JSON, which says more than "[object Object]".
function described(err: unknown): string {
  if (err instanceof Error || typeof err !== "object" || err === null) return errorText(err);
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

async function data<T>(call: Result<T>, what: string): Promise<T> {
  // A call that throws (the server cannot be reached) is labelled like one that answers with an
  // error: either way the message says what was being done. The original stays as the cause.
  const r = await call.catch((err: unknown) => {
    throw new Error(`${what} failed: ${described(err)}`, { cause: err });
  });
  if (r.error !== undefined || r.data === undefined) {
    const why = r.error === undefined ? "no data" : described(r.error);
    // An empty-bodied failure reads as {}: the status is what says anything then.
    const status = r.response?.status === undefined ? "" : `HTTP ${r.response.status} `;
    throw new Error(`${what} failed: ${status}${why}`);
  }
  return r.data;
}

// "provider/model", the form OpenCode's config uses; the model id may itself hold a slash.
export function parseModel(value: string | undefined): ModelRef | null {
  const at = value?.indexOf("/") ?? -1;
  if (value === undefined || at <= 0 || at === value.length - 1) return null;
  return { providerID: value.slice(0, at), modelID: value.slice(at + 1) };
}

// The journal's model: its name as the entries record it, the reference the prompt names
// (null: OpenCode's default), the setting it came from (named in a failure, so a model OpenCode
// does not know can be traced to where it was set), and what is wrong with the setting, if anything.
export type Chosen = { name: string; ref: ModelRef | null; source: string; problem: string | null };

const DEFAULT_SOURCE = "OpenCode's default model";

function named(setting: string, value: string): Chosen {
  const ref = parseModel(value);
  if (ref !== null) return { name: value, ref, source: `${setting} "${value}"`, problem: null };
  return {
    name: `${value} (not provider/model: OpenCode's default model ran)`,
    ref: null,
    // The model that ran, and so the one a failure is about, is OpenCode's default.
    source: `${DEFAULT_SOURCE}, as ${setting} "${value}" is not provider/model`,
    problem: `${setting} "${value}" is not provider/model, so OpenCode's default model writes the journal`,
  };
}

export class OpenCodeHarness implements Harness {
  // The summarizer's own sessions: never initialized, never journaled (spec 7.1). Each
  // also has its parentID set, which is how sessions.ts skips task children; this set is
  // the second guard, and it is filled before the helper's first prompt.
  readonly helpers = new Set<string>();
  private readonly client: OpenCodeClient;
  private readonly option: string | undefined;
  private chosen: Promise<Chosen> | null = null;

  constructor(client: OpenCodeClient, journalModelOption: string | undefined) {
    this.client = client;
    this.option = journalModelOption;
  }

  // D7: the journalModel option, else OpenCode's small_model, else its default model, all
  // read from the resolved config (a value such as "{env:X}/m" is substituted there). None of
  // them set is not a failure: the prompt then names no model and OpenCode uses its own
  // default. A value that is not provider/model is told (`problem`), and the name the journal
  // records says OpenCode's default ran. Read once per process, unless the config could not be
  // read: that is told and read again next time.
  model(): Promise<Chosen> {
    this.chosen ??= (async (): Promise<Chosen> => {
      if (this.option !== undefined) return named("journalModel", this.option);
      const read = await data(this.client.config.get(), "reading the OpenCode config").then(
        (cfg) => ({ cfg, problem: null }),
        (err: unknown) => ({ cfg: { model: undefined, small_model: undefined }, problem: `${errorText(err)}; the journal uses OpenCode's default model this time` }),
      );
      if (read.problem !== null) {
        this.chosen = null;
        return { name: "the default model", ref: null, source: DEFAULT_SOURCE, problem: read.problem };
      }
      if (read.cfg.small_model !== undefined) return named("small_model", read.cfg.small_model);
      if (read.cfg.model !== undefined) return named("model", read.cfg.model);
      return { name: "the default model", ref: null, source: DEFAULT_SOURCE, problem: null };
    })();
    return this.chosen;
  }

  async callModel(req: { system: string; prompt: string; parentSessionId: string }): Promise<string> {
    const { ref, source } = await this.model();
    const summarizer = `the summarizer (${source})`;
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
        summarizer,
      );
      // A reply can arrive with the provider's failure on it instead of text: that is a
      // failure, never an empty summary (journal.ts would write it and move past the
      // transcript for good).
      if (reply.info.error !== undefined) throw new Error(`${summarizer} failed: ${JSON.stringify(reply.info.error)}`);
      const text = reply.parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      if (text.trim() === "") throw new Error(`${summarizer} returned no text`);
      return text;
    } finally {
      // Housekeeping only: a helper left behind (the delete failed, or its answer did) is a
      // child session, which catch-up and initialization both skip by its parentID, so its
      // id is let go once the delete was tried.
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
    // The session's last message is left for the next read while it is still going (an
    // assistant message not completed, still streaming, or a tool still running): the journal
    // keeps its place by message, so reading it now would move past what has not arrived. An
    // earlier message never will finish (the conversation went on).
    const running = (m: (typeof all)[number]): boolean =>
      (m.info.role === "assistant" && m.info.time.completed === undefined) ||
      m.parts.some((p) => p.type === "tool" && p.state !== undefined && p.state.status !== "completed" && p.state.status !== "error");
    const last = all.at(-1);
    const to = last !== undefined && running(last) ? all.length - 1 : all.length;
    const messages: TranscriptMessage[] = [];
    for (const m of all.slice(from, to)) {
      const role = m.info.role === "user" ? "user" : "assistant";
      const time = m.info.time.created;
      for (const p of m.parts) {
        if (p.type === "text" && typeof p.text === "string" && p.text) messages.push({ id: m.info.id, role, text: p.text, time });
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

  // OpenCode's own log, which keeps what a toast sent too early would lose.
  async logError(message: string): Promise<void> {
    await this.log("error", message);
  }

  async log(level: "info" | "warn" | "error", message: string): Promise<void> {
    await data(this.client.app.log({ body: { service: "superpower-remember-obsidian", level, message } }), "writing to the OpenCode log");
  }
}
