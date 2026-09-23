// Resolve the Obsidian vault from OBSIDIAN_VAULT_PATH, and read the synced
// vault-wide settings in Projects/.sro-config.json.
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { quoted } from "./store.ts";

export interface Vault {
  root: string;
  projectsDir: string;
}

export interface VaultConfig {
  timezone: string;
}

export const CONFIG_FILE = ".sro-config.json";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function resolveVault(env: Record<string, string | undefined> = process.env): Promise<Vault> {
  const raw = env.OBSIDIAN_VAULT_PATH?.trim();
  if (!raw) {
    throw new VaultError("OBSIDIAN_VAULT_PATH is not set: set it to the absolute path of your Obsidian vault");
  }
  if (!isAbsolute(raw)) throw new VaultError(`OBSIDIAN_VAULT_PATH must be absolute, got "${raw}"`);
  if (!(await isDirectory(raw))) throw new VaultError(`OBSIDIAN_VAULT_PATH "${raw}" does not exist or is not a directory`);
  if (!(await isDirectory(join(raw, ".obsidian")))) {
    throw new VaultError(`OBSIDIAN_VAULT_PATH "${raw}" is not an Obsidian vault (no .obsidian/ folder)`);
  }
  const root = await realpath(raw);
  return { root, projectsDir: join(root, "Projects") };
}

// This machine's zone as Intl reports it, or UTC when Intl reports one it then refuses (an
// exported but empty TZ reads as "Etc/Unknown"): every stamp would throw on it.
export function systemTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimezone(zone) ? zone : "UTC";
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Missing file: this machine's zone (the file is written at bootstrap). A file
// that exists but is broken or cannot be read is an error: machines must agree on "today".
export async function readVaultConfig(projectsDir: string): Promise<VaultConfig> {
  let text: string;
  try {
    text = await readFile(join(projectsDir, CONFIG_FILE), "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { timezone: systemTimezone() };
    }
    throw new VaultError(`${CONFIG_FILE} cannot be read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new VaultError(`${CONFIG_FILE} is not valid JSON`);
  }
  const timezone = (parsed as { timezone?: unknown }).timezone;
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) {
    // The value came from the synced config file, so it may be arbitrarily
    // large; quoted() caps and escapes it before it reaches this status line.
    const shown = typeof timezone === "string" ? timezone : (JSON.stringify(timezone) ?? "undefined");
    throw new VaultError(`${CONFIG_FILE} has no valid IANA "timezone" (got ${quoted(shown)})`);
  }
  return { timezone };
}
