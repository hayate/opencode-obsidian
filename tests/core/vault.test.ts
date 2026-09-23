import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveVault, readVaultConfig, systemTimezone, VaultError, CONFIG_FILE } from "../../core/vault.ts";
import { addDays, dayStamp, fileStamp, isoWithOffset, monthStamp, timeStamp } from "../../core/time.ts";
import { tempDir } from "./helpers.ts";

async function makeVault(): Promise<string> {
  const root = await tempDir("sro-vault-");
  await mkdir(join(root, ".obsidian"));
  return root;
}

test("resolveVault returns the real path and its Projects dir", async () => {
  const root = await makeVault();
  const link = join(await tempDir(), "vault-link");
  await symlink(root, link);
  const vault = await resolveVault({ OBSIDIAN_VAULT_PATH: link });
  assert.equal(vault.root, root);
  assert.equal(vault.projectsDir, join(root, "Projects"));
});

test("resolveVault fails loudly: unset, relative, missing, not a vault", async () => {
  const notVault = await tempDir();
  const cases: Array<[Record<string, string | undefined>, RegExp]> = [
    [{}, /^OBSIDIAN_VAULT_PATH is not set: this plugin needs it set to the absolute path of your Obsidian vault$/],
    [{ OBSIDIAN_VAULT_PATH: "   " }, /is not set/],
    [{ OBSIDIAN_VAULT_PATH: "relative/vault" }, /must be absolute/],
    [{ OBSIDIAN_VAULT_PATH: join(notVault, "missing") }, /does not exist/],
    [{ OBSIDIAN_VAULT_PATH: notVault }, /no \.obsidian/],
  ];
  for (const [env, message] of cases) {
    await assert.rejects(resolveVault(env), (err: unknown) => err instanceof VaultError && message.test(err.message));
  }
});

test("readVaultConfig: missing file means this machine's zone; a broken file is an error", async () => {
  const projects = await tempDir();
  assert.deepEqual(await readVaultConfig(projects), { timezone: systemTimezone() });
  await writeFile(join(projects, CONFIG_FILE), JSON.stringify({ timezone: "Asia/Tokyo" }));
  assert.deepEqual(await readVaultConfig(projects), { timezone: "Asia/Tokyo" });
  await writeFile(join(projects, CONFIG_FILE), JSON.stringify({ timezone: "Mars/Olympus" }));
  await assert.rejects(readVaultConfig(projects), VaultError);
  await writeFile(join(projects, CONFIG_FILE), "{not json");
  await assert.rejects(readVaultConfig(projects), VaultError);
});

test("readVaultConfig: an oversized synced timezone value never reaches the error message uncapped", async () => {
  const projects = await tempDir();
  const huge = "x".repeat(5000);
  await writeFile(join(projects, CONFIG_FILE), JSON.stringify({ timezone: huge }));
  await assert.rejects(readVaultConfig(projects), (err: unknown) => {
    assert.ok(err instanceof VaultError);
    assert.ok(err.message.length < 300, `message should be capped, was ${err.message.length} chars`);
    assert.doesNotMatch(err.message, new RegExp(huge));
    assert.match(err.message, /\.\.\."/);
    return true;
  });
});

test("readVaultConfig: a config file that exists but cannot be read is an error", async () => {
  const projects = await tempDir();
  await mkdir(join(projects, CONFIG_FILE));
  await assert.rejects(readVaultConfig(projects), VaultError);
});

test("stamps are computed in the given zone, not the machine's", () => {
  const instant = new Date("2026-09-21T16:30:05Z");
  assert.equal(dayStamp(instant, "Asia/Tokyo"), "2026-09-22");
  assert.equal(dayStamp(instant, "America/Los_Angeles"), "2026-09-21");
  assert.equal(fileStamp(instant, "Asia/Tokyo"), "2026-09-22T013005");
  assert.equal(timeStamp(instant, "Asia/Tokyo"), "013005");
  assert.equal(monthStamp(instant, "Asia/Tokyo"), "2026-09");
  assert.equal(isoWithOffset(instant, "Asia/Tokyo"), "2026-09-22T01:30:05+09:00");
  assert.equal(isoWithOffset(instant, "America/Los_Angeles"), "2026-09-21T09:30:05-07:00");
  assert.equal(isoWithOffset(instant, "UTC"), "2026-09-21T16:30:05+00:00");
});

test("addDays crosses month and year boundaries", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2026-09-21", -7), "2026-09-14");
});

// An exported but empty TZ makes node report "Etc/Unknown", a zone Intl itself refuses:
// every stamp the cycle writes would throw, and every sync would abort.
test("a system zone Intl refuses (an empty TZ reads as Etc/Unknown) falls back to UTC", () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = "";
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Etc/Unknown", "the premise: node reads an empty TZ so");
    assert.equal(systemTimezone(), "UTC");
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test(
  "a vault that cannot be read says so, never that it does not exist",
  { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false },
  async () => {
    const root = await tempDir();
    await mkdir(join(root, ".obsidian"));
    await chmod(root, 0o000);
    try {
      await assert.rejects(resolveVault({ OBSIDIAN_VAULT_PATH: root }), (err: unknown) => err instanceof VaultError && /^OBSIDIAN_VAULT_PATH ".*" cannot be read \(EACCES\)$/.test(err.message));
    } finally {
      await chmod(root, 0o755);
    }
  },
);
