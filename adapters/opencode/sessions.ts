// Spec 7.1-7.2 and 8: what the plugin keeps per OpenCode session. Initialization runs
// once per top-level session (single-flight), its payload is frozen and re-applied on
// every transform, and status that arrives later (the background sync, an idle) is
// appended to the user message that was latest when it arrived.
import { escapeBlockTags, PAYLOAD_MARKER, type StatusItem } from "../../core/inject.ts";
import { idleSession, initializeSession, syncSession, type InitResult } from "../../core/session.ts";
import { errorText } from "../../core/store.ts";
import type { OpenCodeClient, OpenCodeHarness } from "./harness.ts";

// Each note's text starts with this and its own number, so two notes saying the same thing
// (a problem that cleared and came back) are two notes, not one.
export const STATUS_MARKER = "<!-- superpower-remember-obsidian:status";

// The transform's messages, narrowed to what is read. A part the plugin adds is a text
// part carrying the ids of the part it sits beside, as upstream superpowers adds its own.
export type Part = { id: string; sessionID: string; messageID: string; type: string; text?: string };
export type Message = { info: { id: string; sessionID: string; role: string }; parts: Part[] };

export interface Core {
  initialize: typeof initializeSession;
  idle: typeof idleSession;
  sync: typeof syncSession;
}

export interface SessionsInput {
  client: OpenCodeClient;
  harness: OpenCodeHarness;
  // The plugin's instance directory: where a session whose lookup failed is initialized.
  directory: string;
  bootstrap: string;
  env: Record<string, string | undefined>;
  core?: Core;
}

interface Note {
  id: number;
  anchor: string | null;
  items: StatusItem[];
  // Rendered into a message at least once: from then on it never changes, or the prompt
  // cache breaks from there on.
  delivered: boolean;
}

interface Entry {
  init: Promise<InitResult>;
  // A positive lookup said this is a top-level session. Until one does (the lookup
  // failed), every transform and idle asks again, and a child is dropped when found.
  verified: boolean;
  notes: Note[];
  // What the latest report said: a line is new when the report before it did not have
  // it, so a problem that stays is told once, and one that clears and comes back is told
  // again.
  last: Set<string>;
  latestUser: string | null;
  idle: Promise<void> | null;
  // An idle that arrived while one ran: one more runs after it, so what the session wrote
  // after the running one's snapshot is not left for the next session start.
  again: boolean;
}

type Lookup = { kind: "top"; directory: string } | { kind: "child" } | { kind: "unknown" };

const key = (item: StatusItem): string => `${item.level} ${item.text}`;

export function renderStatus(id: number, items: StatusItem[]): string {
  return [`${STATUS_MARKER} ${id} -->`, "Memory status update (superpower-remember-obsidian):", ...items.map((s) => `- [${s.level}] ${escapeBlockTags(s.text)}`)].join("\n");
}

const lines = (items: StatusItem[]): string => items.map((s) => `- [${s.level}] ${s.text}`).join("\n");

export class Sessions {
  private readonly input: SessionsInput;
  private readonly core: Core;
  private readonly entries = new Map<string, Entry>();
  private readonly children = new Set<string>();
  private notesMade = 0;

  constructor(input: SessionsInput) {
    this.input = input;
    this.core = input.core ?? { initialize: initializeSession, idle: idleSession, sync: syncSession };
  }

  // Spec 7.1: a task child (it has a parentID) or one of the summarizer's own sessions is
  // never initialized. Never rejects: a lookup that fails is "unknown".
  private async lookup(sessionId: string): Promise<Lookup> {
    if (this.input.harness.helpers.has(sessionId) || this.children.has(sessionId)) return { kind: "child" };
    try {
      const r = await this.input.client.session.get({ path: { id: sessionId } });
      if (r.data === undefined) throw new Error(errorText(r.error));
      if (r.data.parentID !== undefined) {
        this.children.add(sessionId);
        return { kind: "child" };
      }
      return { kind: "top", directory: r.data.directory };
    } catch {
      return { kind: "unknown" };
    }
  }

  // An entry that is not verified yet asks again: a child is dropped (no idle, no sync, no
  // more payload); "unknown" keeps the entry, unverified.
  private async confirm(sessionId: string, entry: Entry): Promise<boolean> {
    if (entry.verified) return true;
    const found = await this.lookup(sessionId);
    if (found.kind === "child") {
      this.entries.delete(sessionId);
      return false;
    }
    if (found.kind === "top") entry.verified = true;
    return true;
  }

  // A session that is gone (session.deleted) is forgotten, with what was kept for it.
  forget(sessionId: string): void {
    this.entries.delete(sessionId);
    this.children.delete(sessionId);
  }

  private start(sessionId: string, directory: string, verified: boolean): Entry {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    const init = this.input.harness.model().then(({ name }) =>
      this.core.initialize({ env: this.input.env, sessionDir: directory, sessionId, harness: this.input.harness, bootstrap: this.input.bootstrap, journalModel: name }),
    );
    const entry: Entry = { init, verified, notes: [], last: new Set(), latestUser: null, idle: null, again: false };
    this.entries.set(sessionId, entry);
    void init.then(
      (result) => {
        entry.last = new Set(result.status.map(key));
        this.alert(result.status);
        // An empty background is "nothing more" (initialization finished in time, or its
        // late work had nothing to say), not a report that the problems cleared.
        return result.background.then((later) => (later.length > 0 ? this.surface(entry, later) : undefined));
      },
      // initializeSession never throws; anything that does is the plugin's own bug.
      (err: unknown) => this.alert([{ level: "error", text: `memory initialization failed: ${errorText(err)}` }]),
    );
    return entry;
  }

  // The user sees errors as a toast; the model sees every level in the session.
  private alert(items: StatusItem[]): void {
    for (const item of items) {
      if (item.level === "error") void this.input.harness.notify(item.text).catch(() => undefined);
    }
  }

  // A later report: its new lines become a note on the user message latest now (a status
  // change costs one cache break from there on).
  private surface(entry: Entry, items: StatusItem[]): void {
    const fresh = items.filter((item) => !entry.last.has(key(item)));
    entry.last = new Set(items.map(key));
    if (fresh.length === 0) return;
    entry.notes.push({ id: ++this.notesMade, anchor: entry.latestUser, items: fresh, delivered: false });
    this.alert(fresh);
  }

  async transform(messages: Message[]): Promise<void> {
    const first = messages.find((m) => m.info.role === "user");
    if (!first || first.parts.length === 0) return;
    const sessionId = first.info.sessionID;
    let entry = this.entries.get(sessionId);
    if (entry && !(await this.confirm(sessionId, entry))) return;
    if (!entry) {
      const found = await this.lookup(sessionId);
      if (found.kind === "child") return;
      // Two transforms of a new session can both get here; start() is synchronous, so the
      // second finds the first's entry. A failed lookup initializes in the plugin's
      // directory, as upstream superpowers injects when its lookup fails (memory in a child
      // is a cost, none in a real session is a loss), and the next transform asks again.
      entry = this.start(sessionId, found.kind === "top" ? found.directory : this.input.directory, found.kind === "top");
    }
    const result = await entry.init;
    const latest = messages.findLast((m) => m.info.role === "user") ?? first;
    entry.latestUser = latest.info.id;
    const ref = first.parts[0];
    if (ref && !first.parts.some((p) => p.type === "text" && p.text?.includes(PAYLOAD_MARKER))) {
      first.parts.unshift({ id: ref.id, sessionID: ref.sessionID, messageID: ref.messageID, type: "text", text: result.payload });
    }
    for (const note of entry.notes) {
      // A note that arrived before any message was seen, or whose message a compaction
      // removed, sits on the latest user message, and stays there from then on.
      let at = note.anchor === null ? undefined : messages.find((m) => m.info.id === note.anchor);
      if (!at) {
        at = latest;
        note.anchor = latest.info.id;
      }
      const text = renderStatus(note.id, note.items);
      const own = at.parts[0];
      if (own && !at.parts.some((p) => p.type === "text" && p.text === text)) {
        at.parts.push({ id: own.id, sessionID: own.sessionID, messageID: own.messageID, type: "text", text });
      }
      note.delivered = true;
    }
  }

  // Spec 8: idle, best effort, for a verified session whose memory is on once initialization
  // has settled (its background work included, so the two never race for the locks). One at
  // a time; an idle during one runs once more after it.
  async idle(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.idle) {
      entry.again = true;
      return entry.idle;
    }
    const run = async (): Promise<void> => {
      do {
        entry.again = false;
        if (!(await this.confirm(sessionId, entry)) || !entry.verified) return;
        const ctx = await (await entry.init).settled;
        if (ctx === null) return;
        const { name } = await this.input.harness.model();
        this.surface(entry, await this.core.idle(ctx, { harness: this.input.harness, sessionId, journalModel: name }));
      } while (entry.again);
    };
    entry.idle = run()
      .catch((err: unknown) => this.surface(entry, [{ level: "error", text: `idle sync failed: ${errorText(err)}` }]))
      .finally(() => {
        entry.idle = null;
      });
    await entry.idle;
  }

  // remember_sync. Its answer is the tool's output, where the model reads it; the same
  // lines are taken out of notes not delivered yet, and they are the latest report.
  async sync(sessionId: string, adoptRewrite: boolean): Promise<string> {
    const entry = this.entries.get(sessionId);
    if (!entry) return "memory is not initialized in this session (remember_sync runs in the session the memory was loaded into, not in a subagent)";
    const result = await entry.init;
    const ctx = await result.settled;
    // Memory off: the answer is why, which the session may also have queued as a note.
    const items =
      ctx === null
        ? result.context === null
          ? result.status
          : [...result.status, ...(await result.background)]
        : await this.core.sync(ctx, { adoptRewrite });
    const told = new Set(items.map(key));
    for (const note of entry.notes) {
      if (!note.delivered) note.items = note.items.filter((item) => !told.has(key(item)));
    }
    entry.notes = entry.notes.filter((note) => note.items.length > 0);
    const fresh = items.filter((item) => !entry.last.has(key(item)));
    entry.last = told;
    if (ctx !== null) this.alert(fresh); // memory off: the user was told when it happened
    return ctx !== null && items.length === 0 ? "synced: nothing to report" : lines(items);
  }
}
