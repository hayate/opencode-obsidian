// An OpenCode client for the adapter's tests: sessions and replies are set by the test,
// and every call is recorded.
import type { ModelRef, OpenCodeClient, PartLike } from "../../../adapters/opencode/harness.ts";

type Result<T> = Promise<{ data?: T; error?: unknown }>;
const ok = <T>(data: T): Result<T> => Promise.resolve({ data });
const fail = <T>(error: unknown): Result<T> => Promise.resolve({ error });

export interface FakeSession {
  id: string;
  directory: string;
  parentID?: string;
  updated?: number;
  messages?: Array<{ info: { id: string; role: string; time: { created: number } }; parts: PartLike[] }>;
}

export interface Prompted {
  session: string;
  model?: ModelRef;
  system: string;
  tools: Record<string, boolean>;
  text: string;
}

export class FakeClient implements OpenCodeClient {
  sessions = new Map<string, FakeSession>();
  toolIds = ["bash", "read", "edit", "remember_sync"];
  config: OpenCodeClient["config"];
  cfg: { model?: string; small_model?: string } | null = {};
  reply: PartLike[] | Error = [{ type: "text", text: "summary" }];
  // The provider's failure, carried on an otherwise successful reply.
  replyError: unknown = undefined;
  // An HTTP failure: the SDK resolves with the error body and the response, it does not throw.
  replyFail: { status: number; error: unknown } | undefined = undefined;
  // A call that rejects with this value (a network failure, or a client that throws its errors).
  replyReject: { value: unknown } | undefined = undefined;
  getCalls: string[] = [];
  created: Array<{ id: string; parentID: string }> = [];
  deleted: string[] = [];
  prompted: Prompted[] = [];
  toasts: Array<{ message: string; variant: string }> = [];
  logs: Array<{ service: string; level: string; message: string }> = [];
  // No TUI (headless opencode run): every toast is refused.
  toastFails = false;
  private next = 0;

  constructor(sessions: FakeSession[] = []) {
    for (const s of sessions) this.sessions.set(s.id, s);
    this.config = { get: () => (this.cfg === null ? fail({ name: "ConfigError", data: { message: "unreadable" } }) : ok(this.cfg)) };
  }

  session: OpenCodeClient["session"] = {
    get: (o) => {
      this.getCalls.push(o.path.id);
      const s = this.sessions.get(o.path.id);
      return s ? ok({ id: s.id, directory: s.directory, ...(s.parentID === undefined ? {} : { parentID: s.parentID }) }) : fail({ name: "NotFoundError" });
    },
    list: () => ok([...this.sessions.values()].map((s) => ({ id: s.id, directory: s.directory, ...(s.parentID === undefined ? {} : { parentID: s.parentID }), time: { updated: s.updated ?? 0 } }))),
    messages: (o) => {
      const s = this.sessions.get(o.path.id);
      return s ? ok(s.messages ?? []) : fail({ name: "NotFoundError" });
    },
    create: (o) => {
      const id = `ses_helper_${++this.next}`;
      this.created.push({ id, parentID: o.body.parentID });
      this.sessions.set(id, { id, directory: "/helper", parentID: o.body.parentID });
      return ok({ id });
    },
    prompt: (o) => {
      this.prompted.push({ session: o.path.id, ...(o.body.model ? { model: o.body.model } : {}), system: o.body.system, tools: o.body.tools, text: o.body.parts.map((p) => p.text).join("") });
      if (this.replyReject !== undefined) return Promise.reject(this.replyReject.value);
      if (this.replyFail !== undefined) return Promise.resolve({ error: this.replyFail.error, response: { status: this.replyFail.status } });
      return this.reply instanceof Error ? Promise.reject(this.reply) : ok({ info: this.replyError === undefined ? {} : { error: this.replyError }, parts: this.reply });
    },
    delete: (o) => {
      this.deleted.push(o.path.id);
      return ok(true);
    },
  };

  tool: OpenCodeClient["tool"] = { ids: () => ok(this.toolIds) };

  app: OpenCodeClient["app"] = {
    log: (o) => {
      this.logs.push({ service: o.body.service, level: o.body.level, message: o.body.message });
      return ok(true);
    },
  };

  tui: OpenCodeClient["tui"] = {
    showToast: (o) => {
      if (this.toastFails) return fail({ name: "NoTUI" });
      this.toasts.push({ message: o.body.message, variant: o.body.variant });
      return ok(true);
    },
  };
}
