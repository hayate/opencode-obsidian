// The only interface through which core touches a harness (spec 3). The OpenCode
// plugin implements it now; the Claude hooks adapter will implement it later.

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  time: number;
}

export interface TranscriptChunk {
  sessionId: string;
  messages: TranscriptMessage[];
}

export interface SessionRef {
  id: string;
  directory: string;
  updated: number;
  parentId: string | null;
}

export interface Harness {
  callModel(req: { system: string; prompt: string; parentSessionId: string }): Promise<string>;
  readTranscript(sessionId: string, afterMessageId?: string): Promise<TranscriptChunk>;
  listSessions(): Promise<SessionRef[]>;
  notify(message: string): Promise<void>;
}
