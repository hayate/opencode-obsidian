// Spec 5.7: refuse to sync into a public GitHub repository. An anonymous
// ls-remote succeeds only for public repos; private and missing ones both
// answer "could not read Username" (GitHub does not reveal which).
// Probe P6, run 2026-09-21: public exit 0; private and missing exit 128.
import { tmpdir } from "node:os";
import { git, NETWORK_TIMEOUT_MS } from "../git.ts";
import { normalizeOrigin } from "../project.ts";

export type Visibility = "public" | "not-public" | "unknown" | "not-github";

export function githubHttpsUrl(remote: string): string | null {
  const normalized = normalizeOrigin(remote);
  if (!normalized?.startsWith("github.com/")) return null;
  return `https://${normalized}.git`;
}

export async function remoteVisibility(remote: string): Promise<{ visibility: Visibility; detail: string }> {
  const url = githubHttpsUrl(remote);
  if (!url) return { visibility: "not-github", detail: "privacy is the user's responsibility for non-GitHub remotes" };
  const r = await git(["-c", "credential.helper=", "-c", "core.askPass=", "ls-remote", "--heads", url], {
    cwd: tmpdir(),
    timeoutMs: NETWORK_TIMEOUT_MS,
    env: { GIT_ASKPASS: undefined, SSH_ASKPASS: undefined },
  });
  if (r.code === 0 && !r.timedOut) return { visibility: "public", detail: `${url} is readable without credentials` };
  if (/could not read Username|Authentication failed|terminal prompts disabled|Repository not found/i.test(r.stderr)) {
    return { visibility: "not-public", detail: `${url} requires credentials` };
  }
  return { visibility: "unknown", detail: r.stderr.trim().split("\n")[0] || "timed out" };
}
