import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { conflictPathFor, MAX_REFUSALS, WriteGuard } from "../../core/guard.ts";
import { tempDir, writeRel } from "./helpers.ts";

async function setup(): Promise<{ guard: WriteGuard; projects: string; file: string }> {
  const projects = join(await tempDir(), "Projects");
  const file = join(projects, "x", "plans", "p.md");
  await writeRel(projects, "x/plans/p.md", "v1\n");
  return { guard: new WriteGuard(projects), projects, file };
}

async function read(guard: WriteGuard, session: string, file: string): Promise<void> {
  await guard.afterRead(session, file, await guard.beforeRead(file));
}

test("a new file may be written without a read", async () => {
  const { guard, projects } = await setup();
  assert.deepEqual(await guard.check("s1", join(projects, "x", "new.md")), { allow: true });
});

test("read, then write is allowed; a change in between is refused until re-read", async () => {
  const { guard, file } = await setup();
  await read(guard, "s1", file);
  assert.deepEqual(await guard.check("s1", file), { allow: true });
  await writeFile(file, "v2 from a pull\n");
  const refused = await guard.check("s1", file);
  assert.equal(refused.allow, false);
  assert.match(refused.allow ? "" : refused.message, /changed since you last read it/);
  await read(guard, "s1", file);
  assert.deepEqual(await guard.check("s1", file), { allow: true });
});

test("an existing file the session never read is refused", async () => {
  const { guard, file } = await setup();
  const d = await guard.check("s1", file);
  assert.match(d.allow ? "" : d.message, /never read by this session/);
});

test("a read during which the file changed is not recorded as seen", async () => {
  const { guard, file } = await setup();
  const before = await guard.beforeRead(file);
  await writeFile(file, "changed mid-read\n");
  await guard.afterRead("s1", file, before);
  assert.equal((await guard.check("s1", file)).allow, false);
});

test("the session's own write counts as seen", async () => {
  const { guard, file } = await setup();
  await read(guard, "s1", file);
  await writeFile(file, "mine\n");
  await guard.afterWrite("s1", file);
  assert.deepEqual(await guard.check("s1", file), { allow: true });
});

test("sessions are independent", async () => {
  const { guard, file } = await setup();
  await read(guard, "s1", file);
  assert.equal((await guard.check("s2", file)).allow, false);
});

test(`after ${MAX_REFUSALS} refusals the agent is told to write a conflict file instead`, async () => {
  const { guard, file } = await setup();
  let last;
  for (let i = 0; i < MAX_REFUSALS; i++) {
    await writeFile(file, `churn ${i}\n`);
    last = await guard.check("ses_abcdefgh123", file);
  }
  assert.ok(last && !last.allow);
  assert.equal(last.conflictPath, conflictPathFor(file, "ses_abcdefgh123"));
  assert.match(last.conflictPath ?? "", /p\.conflict-ses_abcd\.md$/);
});

test("paths outside Projects/ are not guarded", async () => {
  const { guard } = await setup();
  const outside = join(await tempDir(), "code", "src.ts");
  await writeRel(join(outside, ".."), "src.ts", "x");
  assert.deepEqual(await guard.check("s1", outside), { allow: true });
});
