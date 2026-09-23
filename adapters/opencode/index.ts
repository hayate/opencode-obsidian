// Spec 8: the OpenCode plugin. It loads core into OpenCode: the session starts with its
// memory (the transform), syncs and journals when idle, and exposes remember_sync, the
// tool the status lines name. Every hook catches what it calls: nothing throws into
// OpenCode (spec 7.6).
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import { OpenCodeHarness, type OpenCodeClient } from "./harness.ts";
import { Sessions } from "./sessions.ts";

// Spec 7.3 item 1. The memory it introduces is framed as data by core (inject.ts).
export const BOOTSTRAP = [
  "## Project memory (superpower-remember-obsidian)",
  "This plugin loads the project's memory from the Obsidian vault into this message and keeps `Projects/` in sync across machines.",
  "- Never run git in `Projects/`: the plugin commits, pulls and pushes it at session start and when the session goes idle.",
  "- `remember_sync` syncs now, for example after fixing a file the secret scan held back. Its `adopt_rewrite` option is only for a status line saying the remote's history was rewritten, and only once the user confirms the rewrite was intended.",
  "- A status line tagged [error] needs the user: tell them what it says.",
].join("\n");

// The plugin's working parts, from what OpenCode passes in. A journalModel option that is not
// a string is not ignored: it becomes text, which the harness tells is not provider/model.
export function assemble(input: { client: OpenCodeClient; directory: string }, options?: Record<string, unknown>): { harness: OpenCodeHarness; sessions: Sessions } {
  const option = options?.journalModel;
  const harness = new OpenCodeHarness(input.client, option === undefined ? undefined : String(option));
  const sessions = new Sessions({ client: input.client, harness, directory: input.directory, bootstrap: BOOTSTRAP, env: process.env });
  return { harness, sessions };
}

export const SuperpowerRememberObsidian: Plugin = async (input, options) => {
  const { harness, sessions } = assemble(input, options);
  const report = (what: string, err: unknown): void => {
    void harness.notify(`${what} failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
  };
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        await sessions.transform(output.messages);
      } catch (err) {
        report("loading project memory", err);
      }
    },
    event: async ({ event }) => {
      try {
        if (event.type === "session.deleted") sessions.forget(event.properties.info.id);
        if (event.type === "session.idle") await sessions.idle(event.properties.sessionID);
      } catch (err) {
        report(`handling ${event.type}`, err);
      }
    },
    tool: { remember_sync: rememberSync(sessions, (message) => harness.notify(message)) },
  };
};

// Spec 8: the tool the status lines name. Adopting a rewritten remote happens only when
// the model asks for it by name. A failure is the tool's answer, and the user's toast.
export function rememberSync(sessions: Pick<Sessions, "sync">, notify: (message: string) => Promise<void>) {
  return tool({
    description:
      "Sync the vault's Projects/ folder now: commit what changed, integrate other machines' changes, push. Returns the sync's status lines. Use after fixing what a status line reported, or when a status line says to run remember_sync.",
    args: {
      adopt_rewrite: tool.schema
        .boolean()
        .optional()
        .describe("Adopt a remote whose history was rewritten (a force-push). Only when a status line said so and the user confirmed the rewrite was intended."),
    },
    async execute(args, context) {
      try {
        return await sessions.sync(context.sessionID, args.adopt_rewrite === true);
      } catch (err) {
        const message = `remember_sync failed: ${err instanceof Error ? err.message : String(err)}`;
        await notify(message).catch(() => undefined);
        return message;
      }
    },
  });
}

export default { id: "superpower-remember-obsidian", server: SuperpowerRememberObsidian };
