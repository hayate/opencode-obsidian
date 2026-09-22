"""Every mutation the gate runs (gate.py): the file, the exact text to change, what to change it
to, and the test file that must catch it, plus runs, network, pattern, survives and why (see
gate.Mutation). A change to code a mutation targets updates the mutation in the same change;
the gate's own test fails fast on a target that moved."""
from gate import Mutation

MUTATIONS = []


def mutate(path, old, new, test, runs=1, network=False, pattern=None, survives=(), why=""):
    # old/new: one string, or tuples of strings applied together (a move is two edits).
    olds, news = (old, new) if isinstance(old, tuple) else ((old,), (new,))
    MUTATIONS.append(Mutation(path, olds, news, test, runs, network, pattern, tuple(survives), why))


# Case handling runs only where core.ignorecase is true: on Linux a case change is an ordinary
# rename, so nothing there can catch these (they are caught on macOS).
CASE = dict(survives=("linux",), why="case handling runs only on a case-insensitive filesystem")
# The mirror: a guard that matters only where the disk tells Note.md and note.md apart (a
# stale core.ignorecase=true). Its tests run only there, and macOS's default disk ignores
# case (they are caught on Linux).
CASE_SENSITIVE = dict(survives=("darwin",), why="its tests run only on a disk that tells case apart")
L = "tests/core/lock.test.ts"; C = "tests/core/sync-cycle.test.ts"; S = "tests/core/sync-state.test.ts"
G = "tests/core/git.test.ts"; SE = "tests/core/session.test.ts"; SEC = "tests/core/secrets.test.ts"; M = "tests/core/migrate.test.ts"
V = "tests/core/vault.test.ts"; P = "tests/core/project.test.ts"
R = "tests/core/sync-resolve.test.ts"; CP = "tests/core/sync-copies.test.ts"; CL = "tests/core/sync-clone.test.ts"; RC = "tests/core/sync-recovery.test.ts"
# The lock (rename-only).
mutate("core/lock.ts", "owner !== null && owner[1] === host() && pidDead(Number(owner[2]))", "owner !== null && owner[1] === host()", L)
mutate("core/lock.ts", "if (names.length !== 1 || only === undefined || !stale(only)) return false;", "if (only === undefined || !stale(only)) return false;", L)
mutate("core/lock.ts", "    await rename(join(dir, only), join(dir, me));\n    return true;", "    await unlink(join(dir, only));\n    await writeFile(join(dir, me), \"\");\n    return true;", L, runs=5)
mutate("core/lock.ts", 'if (errCode(err) === "ENOENT") return false; // another contender took it first',
       'if (errCode(err) === "ENOENT") { const [now] = await readdir(dir); if (now) { await rename(join(dir, now), join(dir, me)); return true; } return false; }', L, runs=3)
mutate("core/lock.ts", "        await stat(mine);\n        return true;", "        return true;", L)
mutate("core/lock.ts", 'if (errCode(err) === "ENOENT") return false;\n', 'if (errCode(err) === "ENOENT") return true;\n', L)
# The git runner.
mutate("core/git.ts", "    if (attempt >= INDEX_LOCK_RETRIES || !(await metIndexLock(result, paths?.lock ?? null))) return result;", "    return result;", G)
mutate("core/git.ts", "  const paths = RETRIED_ON_INDEX_LOCK.has(sub) ? await indexPaths(opts) : null;", "  const paths = await indexPaths(opts);", G)
mutate("core/git.ts", "if (result.code === 0 || result.timedOut) return false;", "if (result.code === 0) return false;", G)
mutate("core/git.ts", "  return lock !== null && (await exists(lock));\n}", "  return true;\n}", G)
# Literal pathspecs at every path core passes.
mutate("core/sync/cycle.ts", '["reset", "-q", "--", literal(file)]', '["reset", "-q", "--", file]', C, pattern='unstages only itself')
mutate("core/sync/cycle.ts", '"--cached", "--", literal(rel)]', '"--cached", "--", rel]', C, pattern='keeps a\\.md tracked', **CASE)
mutate("core/sync/cycle.ts", '"-f", "--", literal(path)]', '"-f", "--", path]', C, pattern='untracks only itself|named like pathspec magic')
mutate("core/migrate.ts", '"--", literal(rel)]', '"--", rel]', M)
# The secret scan.
mutate("core/secrets.ts", "return unquoteGitPath(raw).replace(", 'return raw.replace(/^"|"$/g, "").replace(', C, pattern='a secret in a file whose name holds a newline|in a quoted name holding an emoji')
mutate("core/secrets.ts", "const ch = String.fromCodePoint(body.codePointAt(i) ?? 0);", 'const ch = body[i] ?? "";', SEC)
mutate("core/secrets.ts", r'header.slice(4).replace(/\t$/, "")', "header.slice(4).trim()", SEC)
mutate("core/secrets.ts", '      "--src-prefix=a/",\n      "--dst-prefix=b/",\n', "", C, pattern='changes diff prefixes')
mutate("core/secrets.ts", '      "--no-textconv",\n', "", C, pattern='a textconv driver rewrites the diff')
mutate("core/secrets.ts", "      `--attr-source=${EMPTY_TREE}`,\n", "", C, pattern='marking notes -diff cannot hide')
mutate("core/sync/state.ts", "  if (hits.size) {", "  if (false) {", S)
# The sync cycle.
mutate("core/sync/cycle.ts", '["reset", "-q", "--keep", next]', '["reset", "-q", "--hard", next]', C, pattern='blocks the whole live update|an edit staged by hand that the update would overwrite')
mutate("core/sync/cycle.ts", "for (const [file, hits] of await scanStaged(dir)) {", "for (const [file, hits] of new Map<string, { rule: string }[]>()) {", C, pattern='a held-back file stays dirty and does not block')
mutate("core/sync/cycle.ts", '  if (/^!\\t.*\\[rejected\\]/m.test(r.stdout)) return { kind: "raced", detail };\n', "", C, pattern='a push that loses a race')
mutate("core/sync/cycle.ts", "if (s && Math.abs(Date.now() - s.mtimeMs) < quietMs) {", "if (false) {", C, pattern='the quiet period defers a file written just now|an mtime just ahead of the clock')
mutate("core/sync/cycle.ts", "Math.abs(Date.now() - s.mtimeMs) < quietMs", "Date.now() - s.mtimeMs < quietMs", C, pattern='far in the future')
mutate("core/sync/cycle.ts", "  result.embedded = await dropEmbeddedRepos(dir);\n", "", C, pattern='is reported and never committed as a gitlink|a gitlink an old client committed')
mutate("core/sync/cycle.ts",
       ("  result.caseCollisions = await stageCaseRenames(dir);\n",
        "  // After the quiet pass: unstaging a freshly written nested repository would\n  // otherwise restore the gitlink an older client committed.\n  result.embedded = await dropEmbeddedRepos(dir);\n"),
       ("  result.caseCollisions = await stageCaseRenames(dir);\n  result.embedded = await dropEmbeddedRepos(dir);\n", ""), C, pattern='a gitlink an old client committed')
mutate("core/sync/cycle.ts", "    await writeBlocked(input.stateDir, 0);\n", "", C, pattern='an aborted cycle breaks the blocked-cycle streak|a stopped cycle breaks the blocked-cycle streak')
# Case handling (caught only on a case-insensitive filesystem such as macOS).
mutate("core/sync/cycle.ts", "  result.caseCollisions = await stageCaseRenames(dir);\n", "", C, pattern='a case-only rename reaches the remote|a case-only directory rename reaches the remote', **CASE)
mutate("core/sync/cycle.ts", "    if (ambiguous.has(rel)) continue;\n", "", C, pattern='differing only by case are never', **CASE)
mutate("core/sync/cycle.ts", "const found = exact ? part : names.find((n) => fold(n) === fold(part));",
       'const found = exact ? part : part === rel.split("/").at(-1) ? names.find((n) => fold(n) === fold(part)) : undefined;', C, pattern='a case-only directory rename reaches the remote', **CASE)
mutate("core/sync/cycle.ts", "collisions: tracked.filter(clash) };", "collisions: [] };", C, pattern='tracked files differing only by case are never inferred', **CASE)
# Bootstrap, identity, config and session.
mutate("core/sync/state.ts", "const info = await lstat(path);", "const info = await stat(path);", S)
mutate("core/sync/state.ts", "  if (failed) {\n    await removeCreatedGit(projectsDir);\n", "  if (failed) {\n", S)
mutate("core/sync/state.ts", "    await removeCreatedGit(projectsDir).catch(", "    await Promise.resolve().catch(", S)
mutate("core/sync/state.ts", "  await ensureGitignore(projectsDir);\n  return { kind: \"ready\"", "  return { kind: \"ready\"", S)
mutate("core/vault.ts", 'if (code === "ENOENT") {', "if (true) {", V)
mutate("core/project.ts", "  if (!trimmed) throw new UnreadableClaimError", "  if (false) throw new UnreadableClaimError", P)
mutate("core/project.ts", "    throw new UnreadableClaimError(`${shown} cannot be read (${why}): fix or remove this file, then retry`);", "    return null;", P)
mutate("core/session.ts", "    const project = await resolveSafely(vault, opts.sessionDir);\n    shared.resolved = project;", "    const project = early;\n    shared.resolved = project;", SE)
mutate("core/session.ts", "    shared.resolved = project;\n", "", SE)
mutate("core/session.ts", 'join(stateDir, "prepare.lock")', "join(stateDir, `prepare-${opts.sessionId}.lock`)", SE)
mutate("core/session.ts", "    if (cfg.remote) {\n      const vis = await remoteVisibility(cfg.remote);", "    if (false) {\n      const vis = await remoteVisibility(cfg.remote);", SE, network=True)
# The gauntlet fix wave.
mutate("core/secrets.ts", "    if (oldLeft === 0 && newLeft === 0) {\n      if (line.startsWith(\"+++ \")) file = diffPath(line);", "    if (line.startsWith(\"+++ \")) { file = diffPath(line); continue; }\n    if (oldLeft === 0 && newLeft === 0) {\n      if (line.startsWith(\"+++ \")) file = diffPath(line);", SEC)
mutate("core/sync/cycle.ts", '[...NO_SIGN, "commit", "-q", "--no-verify", "-m", message]', '[...NO_SIGN, "commit", "-q", "-m", message]', C, pattern='a pre-commit hook cannot add unscanned content to the snapshot')
mutate("core/sync/state.ts", '[...NO_SIGN, "commit", "-q", "--no-verify", "-m", message]', '[...NO_SIGN, "commit", "-q", "-m", message]', S)
mutate("core/store.ts", "    if (isLink) throw new MemoryPathError(rel, verb, linkWhy(parts, i), true);", "", "tests/core/store.test.ts")
mutate("core/store.ts", '  if (real !== base && !real.startsWith(base + sep)) throw new MemoryPathError(rel, verb, "resolves outside the project", true);', "", "tests/core/store.test.ts",
       survives=("linux", "darwin"),
       why="defence in depth behind the lstat walk and the O_NOFOLLOW open: it fires only if a component becomes a symlink between the walk and the realpath, a race no deterministic test stages (Plan 1 ruling)")
mutate("core/inject.ts", "  return text.replace(BLOCK_TAG, (tag) => `&lt;${tag.slice(1)}`);", "  return text;", "tests/core/inject.test.ts")
mutate("core/session.ts", "  if (early.kind === \"disabled\" && early.bare) return", "  if (early.kind === \"disabled\") return", SE)
mutate("core/session.ts", "belongs = resolveSafely(vault, s.directory).then((r) => r.kind === \"ok\" && r.name === project);", "belongs = Promise.resolve(true);", SE)
mutate("core/session.ts", "    const pre = await Promise.race([starting.then((value) => ({ kind: \"started\" as const, value })), deadline]);", "    const pre = await starting.then((value) => ({ kind: \"started\" as const, value }));", SE)
# The stranded-lock way out (spec 5.6, 2026-09-22).
mutate("core/git.ts", "const note = await rm(lock, { force: true }).then(", "const note = await Promise.resolve().then(", G, runs=3)
mutate("core/git.ts", "  if (named === undefined || !(await exists(resolvePath(cwd, named)))) return undefined;", "  return undefined;", G)
mutate("core/sync/clone.ts", '    if (names.some((name) => name.endsWith(".lock"))) return false;', "", CL)
mutate("core/sync/clone.ts", '...(await readdir(join(clone, "refs"), { recursive: true }))', "", CL)
mutate("core/git.ts", "  if (named === undefined || !(await exists(resolvePath(cwd, named)))) return undefined;", "  if (named === undefined) return undefined;", G)
mutate("core/git.ts", "/Unable to create '(.+?\\.lock)': File exists/", "/Unable to create '([^']+\\.lock)': File exists/", G)
mutate("core/git.ts", "      cleanup !== null &&\n      !before &&\n", "      cleanup !== null &&\n", G, runs=3)
mutate("core/git.ts", "  const cleanup = CLEANED_AFTER_KILL.has(sub) ? paths : null;", "  const cleanup = paths;", G, runs=3)
mutate("core/git.ts", "      (await exists(cleanup.lock)) &&\n      (await identity(cleanup.index)) === indexBefore\n", "      (await exists(cleanup.lock))\n", G, runs=3)
mutate("core/git.ts", 'const CLEANED_AFTER_KILL = new Set(["add", "reset"]);', 'const CLEANED_AFTER_KILL = new Set(["reset"]);', G, runs=3)
mutate("core/git.ts", 'const CLEANED_AFTER_KILL = new Set(["add", "reset"]);', 'const CLEANED_AFTER_KILL = new Set(["add"]);', G, runs=3)
# Integration without a worktree (spec rev 4c, 2026-09-22).
# resolve.ts: the conflict rules and the check that holds them.
mutate("core/sync/resolve.ts", '        put(path, local);\n        conflicts.push({ kind: "both-changed"', '        put(path, remote);\n        conflicts.push({ kind: "both-changed"', R)
mutate("core/sync/resolve.ts", '          final.delete(path);\n          conflicts.push({ kind: "deleted-here"', '          conflicts.push({ kind: "deleted-here"', R)
mutate("core/sync/resolve.ts", '          put(path, local);\n          conflicts.push({ kind: "deleted-there"', '          final.delete(path);\n          conflicts.push({ kind: "deleted-there"', R)
mutate("core/sync/resolve.ts", "        put(remoteName, remote);\n", "", R)
mutate("core/sync/resolve.ts", "        const remote = remoteName && sides[2].tree.get(remoteName);", "        const remote = remoteName && stage(remoteName, 2);", R)
mutate("core/sync/resolve.ts", "        const remote = path && stage(path, 2);\n        if (!path || !local || !remote) return stop(`git reported ${record.type} without both versions`", "        const remote = path && sides[2].tree.get(path);\n        if (!path || !local || !remote) return stop(`git reported ${record.type} without both versions`", R)
mutate("core/sync/resolve.ts", "    for (const [p, e] of inside) {\n      final.delete(p);", "    for (const [p, e] of []) {\n      final.delete(p);", R,
       pattern="the whole remote folder moves aside|moves every note of the folder")
mutate("core/sync/resolve.ts", '          conflicts.push({ kind: "file-folder", path, copy: placeCopy(path, remoteFile) });', '          conflicts.push({ kind: "file-folder", path, copy: null });', R)
mutate("core/sync/resolve.ts", "        for (const p of record.paths) if (p !== path) final.delete(p);", "", R)
mutate("core/sync/resolve.ts", "    `--attr-source=${EMPTY_TREE}`,\n", "", R)
mutate("core/sync/resolve.ts", '    "-c",\n    "merge.directoryRenames=false",\n', "", R)
mutate("core/sync/resolve.ts", "    if (!hasRule(record.type)) {", "    if (false) {", R, pattern="no rule covers")
mutate("core/sync/resolve.ts", "    for (const [path, e] of final) if (isCopyOf(original, path) && same(e, entry)) return path;", "", R)
mutate("core/sync/resolve.ts", "  if (findings.length) {", "  if (false) {", R)
# copies.ts: names and dedupe.
mutate("core/sync/copies.ts", "    const kept = cutBytes(stem, NAME_MAX - byteLength(suffix) - byteLength(ext));", "    const kept = cutBytes(stem, NAME_MAX);", CP)
mutate("core/sync/copies.ts", "    const name = kept ? `${kept}${suffix}${ext}` : `conflict-${oid.slice(0, 12)}${count}`;", "    const name = `${kept}${suffix}${ext}`;", CP)
mutate("core/sync/copies.ts", "    return this.exact.has(path) || this.folded.has(fold(path));", "    return this.exact.has(path);", CP)
mutate("core/sync/copies.ts", "  if (prefix === stem) return true;\n", "  return true;\n", CP)
mutate("core/sync/copies.ts", "  return prefix !== \"\" && stem.startsWith(prefix) && byteLength(name) > NAME_MAX - 4;", "  return false;", CP)
# clone.ts: bare, files format, no maintenance, rebuilt atomically when unusable.
mutate("core/sync/clone.ts", '"--ref-format=files", ', "", CL)
mutate("core/sync/clone.ts", '  for (const remote of ["live", "origin"]) {', "  for (const remote of [] as string[]) {", CL)
mutate("core/sync/clone.ts", "    if (LEFTOVER.test(name)) await rm(join(stateDir, name), { recursive: true, force: true }).catch(() => undefined);", "", CL)
mutate("core/sync/clone.ts", "  } finally {\n    await rm(tmp, { recursive: true, force: true });", "  } finally {\n    await Promise.resolve();", CL, pattern="git refuses the remote")
# recovery.ts: only untouched paths are repaired.
mutate("core/sync/recovery.ts", "printed(rel) ? (await fingerprint(dir, rel)) === prints[rel] :", "printed(rel) ? true :", RC,
       pattern="a path the user changed after the kill is kept")
mutate("core/sync/recovery.ts", "  } else if (head !== record.from) {\n", "  } else if (false) {\n", RC, pattern="history moved since")
mutate("core/sync/recovery.ts", '    await remove(dir, unit[0] ?? "");\n', "", RC, pattern="already created is removed with the rest")
mutate("core/sync/recovery.ts", "  if (head === record.to) {", "  if (false) {", RC)
# cycle.ts: two parents, the rewrite stop, adopt, the outbound scan, step 5.
mutate("core/sync/cycle.ts", '[...NO_SIGN, "commit-tree", merged.tree, "-p", upstream, "-p", live, "-m", message]', '[...NO_SIGN, "commit-tree", merged.tree, "-p", upstream, "-m", message]', C, pattern='a snapshot pushed before step 5 failed is never merged again|a note deleted after a push whose acknowledgement was lost')
mutate("core/sync/cycle.ts", '    if (kept === "no") {', "    if (false) {", C, pattern='a rewritten remote stops the cycle: nothing is merged')
mutate("core/sync/cycle.ts", '[...NO_SIGN, "commit-tree", merged.tree, "-p", upstream, "-m", message]', '[...NO_SIGN, "commit-tree", merged.tree, "-p", upstream, "-p", live, "-m", message]', C, pattern='adopting a rewritten remote carries over only the changes')
mutate("core/sync/cycle.ts", "if (!(await exempt(to, file))) inTree.push(file);", "inTree.push(file);", C, pattern="what the remote already holds never blocks")
mutate("core/sync/cycle.ts", "  const { inCommits, inTree } = await outboundHits(clone, from, to, built);", "  const { inCommits, inTree } = { inCommits: [], inTree: [] };", C,
       pattern="reached a local commit without the snapshot scan")
mutate("core/sync/cycle.ts", "  await gitOk([\"update-ref\", REMOTE_SEEN, next], { cwd: dir });\n", "", C, pattern='a rewritten remote stops the cycle: nothing is merged')
mutate("core/sync/cycle.ts", "  if (reset.timedOut) {\n    // Not the user's block", "  if (false) {\n    // Not the user's block", C, pattern="a live update killed on its timeout is not the user's block")
mutate("core/sync/cycle.ts", "      finished = await finishInterrupted(input.stateDir, dir, { timeoutMs: limitOf(ladder) });", "      finished = null;", C, pattern="a live update that fails partway|a live update killed on its timeout is not the user's block")
CY = "core/sync/cycle.ts"; K = "core/sync/clone.ts"; F_R = "core/sync/resolve.ts"; F_RC = "core/sync/recovery.ts"; P = "remote-seen that cannot be read"
# resolve
mutate("core/sync/copies.ts", "[0-9a-f]{6}(?:-\\d+)?$/;", "[0-9a-f]{6}(?:-\\d+)?/;", CP, pattern="a copy of a conflict copy is recognised")
mutate(F_R, "if (moved && path && stage(moved, 3)) displaced.push(path);", "if (false) displaced.push(path);", R, pattern="whole remote folder moves aside")
mutate(F_R, "if (remote && !same(remote, local)) {", "if (remote && local && !same(remote, local)) {", R, pattern="mirrored collision")
mutate(F_R, "      case COLLISION: {", "      case \"never\": {", R, pattern="keeps all three versions")
mutate(F_R, "    if (record.type === INFORMATIONAL) continue;\n    if (!record.paths.length)", "    if (!record.type.startsWith(\"CONFLICT (\")) continue;\n    if (!record.paths.length)", R, pattern="no rule covers")
mutate(F_R, "if (!entries.some(([at, e]) => same(e, entry) && placed(at)))", "if (!entries.some(([at, e]) => same(e, entry)))", R, pattern="content conflict to git's records")
mutate(F_R, "if (same(e, made) && (record.paths.includes(at) || newCopy(at)))", "if (same(e, made))", R, pattern="content conflict to git's records")
mutate(F_R, "problems.add(`${at}: git's merged result remains`);", ";", R, pattern="content conflict to git's records")
mutate(F_R, "written.has(path)) problems.add(`${path} should be absent`);", "written.has(path)) {}", R, pattern="file/folder conflict to git's relocation")
mutate(F_R, "problems.add(`${x} was not moved with its folder`);", ";", R, pattern="file/folder conflict to git's relocation")
mutate(F_R, "if (!involved(x) && !same(written.get(x), result.get(x)))", "if (false)", R, pattern="content conflict to git's records")
mutate(F_R, "    problems.add(\"the written tree differs from the resolution\");", "", R, pattern="content conflict to git's records")
mutate(F_R, "    if (!record.paths.length) return stop(`git reported ${record.type} without a path`, [], NO_PATH);\n", "", R)
mutate(F_R, "if (s) (sides[n].has.has(key(s)) ? versions.push({ path, entry: s }) : candidates.push(s));", "if (s) versions.push({ path, entry: s });", R, pattern="keeps all three versions")
mutate(F_R, "if (s) (sides[n].has.has(key(s)) ? versions.push({ path, entry: s }) : candidates.push(s));", "if (s) candidates.push(s);", R, pattern="renamed here and edited there, clashing")
mutate(F_R, "if (record.type !== COLLISION && resolvedElsewhere(record.paths)) continue;", "if (resolvedElsewhere(record.paths)) continue;", R, pattern="keeps all three versions")
# cycle-clone
mutate(CY, '  if (exists.code === 2) return { kind: "absent" };\n  if (exists.code !== 0) return { kind: "unreadable" };', '  if (exists.code !== 0) return { kind: "absent" };', C, pattern=P)
mutate(CY, 'return r.code === 0 ? { kind: "seen", commit: r.stdout.trim() } : { kind: "unreadable" };', 'return r.code === 0 ? { kind: "seen", commit: r.stdout.trim() } : { kind: "absent" };', C, pattern=P)
mutate(CY, '  if (seen.kind === "unreadable") {', '  if (false) {', C, pattern=P)
mutate(K, '  if ((await ask(["rev-parse", "--is-bare-repository"])) !== "true") return false;\n', '', CL, pattern="core.bare turned off")
mutate(K, '  if ((await ask(["rev-parse", "--show-ref-format"])) !== "files") return false;\n', '', CL, pattern="reftable \\(locks")
mutate(K, '["config", "--local", "--get", `remote.${remote}.url`]', '["config", "--get", `remote.${remote}.url`]', CL, pattern="only the user's global config")
mutate(K, "    await rename(clone, old).catch(", "    await rm(clone, { recursive: true, force: true }).catch(", CL, pattern="half-deleted")
mutate(K, '[...noHooks, "clone",', '["clone",', CL, pattern="global hook never runs")
mutate(K, '["gc.auto", "0"], ["core.hooksPath", NO_HOOKS]]', '["gc.auto", "0"]]', CL, pattern="put back every time")
mutate(K, '["maintenance.auto", "false"], ["gc.auto", "0"],', '["gc.auto", "0"],', CL, pattern="put back every time")
mutate(K, "sro-(tmp|old)$/", "sro-tmp$/", CL, pattern="leftovers are swept")
mutate(K, "  await rm(old, { recursive: true, force: true });\n}", "}", CL)
# recovery
mutate(F_RC, "    if (absent(err)) return true;\n    throw err;\n  }\n  if (info.isDirectory()) return true;", "    if (absent(err)) return false;\n    throw err;\n  }\n  if (info.isDirectory()) return true;", RC, pattern="fingerprints were never taken")
mutate(F_RC, "unit.flatMap((rel) => [old.get(rel), target.get(rel)])", "unit.flatMap((rel) => [old.get(rel)])", RC, pattern="fingerprints were never taken")
mutate(F_RC, ": await updatesWork(dir, rel, unit, versions);", ": true;", RC, pattern="fingerprints were never taken")
mutate(F_RC, 'const head = await gitOk(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: dir });', 'const head = (await git(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: dir })).stdout.trim();', RC, pattern="HEAD that cannot be read")
mutate(F_RC, "    if (!(await untouched())) return false;\n    // A folder of the note", "    // A folder of the note", RC, pattern="saves while a slow repair")
mutate(F_RC, "  return [...all.filter((unit) => !restores(unit)), ...all.filter(restores)];", "  return all;", RC, pattern="turned a note into a folder")
mutate(F_RC, "  return (await isEffectivelyEmpty(path)) && clear(path);", "  return isEffectivelyEmpty(path);", RC, pattern="holds only empty folders comes back")
mutate(F_RC, "const now = { ...prints, ...Object.fromEntries(left) };", "const now = { ...prints };", RC, pattern="the next run takes what it had set back")
mutate(F_RC, '      { cwd: tree, env: { GIT_INDEX_FILE: join(scratch, "index") }, timeoutMs },', "      { cwd: tree, timeoutMs },", RC, pattern="repair that times out saves")
mutate(F_RC, '        "-c",\n        `core.hooksPath=${join(scratch, "no-hooks")}`,\n        "checkout",', '        "checkout",', RC, pattern="none of the vault's hooks")
mutate(CY, "    await clearInterrupted(input.stateDir);\n    result.liveUpdated = true;", "    result.liveUpdated = true;", C, pattern="leaves nothing to finish")
mutate(CY, "  await clearInterrupted(input.stateDir);\n  result.blockedBy = blocked;", "  result.blockedBy = blocked;", C, pattern="held-back new note")
mutate(CY, "  if (!blocked.length) {", "  if (false) {", C, pattern="fails partway")
mutate(CY, "would be (?:overwritten|removed) by merge", "would be (?:removed) by merge", C, pattern="held-back new note")
mutate(CY, "    await recordIntent(input.stateDir, live, next);\n    result.outcome = \"unsynced\";", "    result.outcome = \"unsynced\";", C, pattern="fails partway")
# The intent written before git is spawned: the group write repeats it as soon as git exists,
# so only a session death in the instant between them, or a group write that fails, leaves the
# vault changing with no record at all.
mutate(CY, "  await recordIntent(input.stateDir, live, next);\n  const reset = await git(", "  const reset = await git(", C,
       survives=("linux", "darwin"),
       why="defence in depth behind the group write, which records the same intent as soon as git is spawned: what it alone covers is a session death inside that instant, or a group write that fails, neither of which a deterministic test can stage")
mutate(CY, "finishInterrupted(input.stateDir, dir, { timeoutMs: limitOf(ladder) })", "finishInterrupted(input.stateDir, dir)", C, pattern="repair that times out stops")
# The review fix rounds of Tasks 3, 5 and 6 (2026-09-22): each piece a round added, broken
# alone, as its implementer checked it by hand.
# resolve.ts: a rename onto a name both sides use, a folder move over paths neither commit
# holds, a type without a rule, and the check's hold on a displaced folder.
mutate(F_R, '} else if (local && remote && record.type === "CONFLICT (rename/delete)" && contentRecordAt(path)) {', "} else if (false) {", R,
       pattern="onto a name this machine also uses|onto a name the other machine also added")
mutate(F_R, 'record.type === "CONFLICT (rename/delete)" && contentRecordAt(path)) {', 'record.type === "CONFLICT (rename/delete)") {', R, pattern="onto a name both sides hold stops")
mutate(F_R, "    paths.every((p) => collided.has(p) || inDisplacedFolder(p)) ||\n    (paths.some(inDisplacedFolder) && paths.every((p) => inDisplacedFolder(p) || inNeither(p)));",
       "    paths.every((p) => collided.has(p) || inDisplacedFolder(p));", R, pattern="the folder the other machine renamed a note into")
mutate(F_R, "(paths.some(inDisplacedFolder) && paths.every(", "(paths.every(", R, pattern="a record naming only paths neither commit holds")
mutate(F_R, '        if (conflicts.some((c) => c.kind === "both-changed" && c.path === path)) break;\n', "", R, pattern="a binary file changed on both sides")
mutate(F_R, "    for (const c of conflicts) if (c.other?.startsWith(`${path}/`)) c.other = moved(c.other);\n", "", R, pattern="with the folder replaced by a file here")
mutate(F_R, "      !result.has(at) && record.paths.some((p) => isCopyOf(p, at) || movedWith(p, at));", "      !result.has(at) && record.paths.some((p) => isCopyOf(p, at));", R,
       pattern="a conflict path inside a displaced folder to its own record")
mutate(F_R, "const entry = conflictPaths.has(x) ? sides[2].tree.get(x) : result.get(x);", "const entry = result.get(x);", R,
       pattern="a conflict path inside a displaced folder to its own record|the same renames with the note edited here")
mutate(F_R, "const entry = conflictPaths.has(x) ? sides[2].tree.get(x) : result.get(x);", "const entry = sides[2].tree.get(x) ?? result.get(x);", R, pattern="renamed into a displaced folder")
mutate(F_R, "  for (const x of new Set([...result.keys(), ...sides[2].tree.keys()])) {", "  for (const x of result.keys()) {", R, pattern="renamed into a displaced folder there and deleted here")
mutate(F_R, "    const moved = (at: string): boolean => displacing.some((f) => movedAside(f, x, at));", "    const moved = (at: string): boolean => movedWith(x, at);", R,
       pattern="a copy of itself, not of a subfolder")
# recovery.ts: a note turned into a folder and back, case twins and spellings, Finder litter,
# an added path already gone, and a record that cannot be read or written.
mutate(F_RC, "        `--attr-source=${from}`,\n", "", RC, pattern="filters the vault's committed")
mutate(F_RC, "    if (info.isDirectory()) return null;\n    if (info.isSymbolicLink())", "    if (info.isSymbolicLink())", RC, pattern="turned a note into a folder, killed after making|turned into nested folders")
mutate(F_RC, "      if (!(await lstat(folder)).isDirectory()) return null;\n", "      await lstat(folder);\n", RC,
       pattern="never started, turning a note into a folder|turned a folder into a note, killed after writing|never gone through|never written or read through|re-pointed by the user")
mutate(F_RC, "    const target = await onDisk(dir, source);", "    const target = join(dir, source);", RC, pattern="turned a folder into a note, killed after writing|re-pointed by the user")
mutate(F_RC, "await writeAtomic(path, JSON.stringify({ ...record, prints: now } satisfies Record_)).catch(() => undefined);",
       "await writeAtomic(path, JSON.stringify({ ...record, prints: now } satisfies Record_));", RC, pattern="even when the record cannot be updated")
mutate(F_RC, "    for (const rel of unit) left.set(rel, print);\n", "", RC, pattern="the next run takes what it had set back")
mutate(F_RC, "const printed = (rel: string): boolean => Object.hasOwn(prints, rel);", "const printed = (rel: string): boolean => rel in prints;", RC, pattern="constructor")
mutate(F_RC, "  if (!isRecord(record)) {", "  if (false) {", RC, pattern="a record that cannot be read")
mutate(F_RC, "back = (await gone()) || (", "back = false || (", RC, pattern="holds only empty folders comes back|Finder's|saved into the empty tree")
mutate(F_RC, "  return (await isEffectivelyEmpty(path)) && clear(path);", "  return clear(path);", RC, pattern="holds a user's file deeper down")
mutate(F_RC, "  return (await isEffectivelyEmpty(path)) && clear(path);", "  return (await isEffectivelyEmpty(path)) && (await rm(path, { recursive: true, force: true }), true);", RC,
       pattern="saved into the empty tree")
mutate(F_RC, "  return (await isEffectivelyEmpty(path)) && clear(path);",
       "  return (await readdir(path, { recursive: true, withFileTypes: true })).every((e) => e.isDirectory()) && clear(path);", RC, pattern="Finder's")
mutate(F_RC, "    } else if (isFinderLitter(entry.name)) {\n      await unlink(child);\n    }\n", "    }\n", RC, pattern="Finder's")
mutate(F_RC, "    const twins = await ignoresCase(dir);", "    const twins = false;", RC, pattern="case-only rename", **CASE)
mutate(F_RC, "    for (const rel of old.keys()) {\n      const unit = byName.get(fold(rel));\n      if (unit !== undefined && !unit.includes(rel)) unit.push(rel);\n    }\n", "", RC,
       pattern="beside its unchanged case twin", **CASE)
mutate(F_RC, "    for (const unit of byName.values()) unit.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));\n", "", RC, pattern="beside its unchanged case twin", **CASE)
mutate(F_RC, "unit.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))", "unit.sort()", RC, pattern="two Unicode planes", **CASE)
mutate(F_RC, "unit.findLast((rel) => old.has(rel))", "unit.find((rel) => old.has(rel))", RC, pattern="holds both spellings of a note", **CASE)
mutate(F_RC, "    await respell(dir, spell(source));\n", "", RC, pattern="set back under the old spelling", **CASE)
mutate(F_RC, "    await respell(dir, spell(source));", "    if (unit.length > 1) await respell(dir, spell(source));", RC, pattern="gets the old folder's spelling", **CASE)
mutate(F_RC, "    await respell(dir, spell(source));", '    await respell(dir, source.split("/"));', RC, pattern="a note set back into it keeps the folder", **CASE)
mutate(F_RC, "  let folder = dir;\n  for (const part of names) {", "  let folder = join(dir, ...names.slice(0, -1));\n  for (const part of names.slice(-1)) {", RC,
       pattern="a case-only rename of a folder the update had made|the first spelling never stops a repair")
mutate(F_RC, "if (twin !== undefined && (await oneEntry(join(folder, twin), wanted))) await rename", "if (twin !== undefined) await rename", RC,
       pattern="never renames a different file over the note", **CASE_SENSITIVE)
mutate(F_RC, "        for (const rel of unit) {\n          const work = printed(rel) ? (await fingerprint(dir, rel)) === prints[rel] : await updatesWork(dir, rel, unit, versions);\n          if (!work) return false;\n        }\n        return true;",
       '        for (const rel of unit.filter(printed)) if ((await fingerprint(dir, rel)) !== prints[rel]) return false;\n        return unit.every(printed) || updatesWork(dir, unit[0] ?? "", unit, versions);', RC,
       pattern="never sets an unchanged note back over the user's edit", **CASE_SENSITIVE)
# A set-back refuses a note behind a symlink before respell runs (onDisk), so where the disk
# ignores case respell walks only folders the set-back just went through: its guard is left to
# the tests of a disk that tells case apart.
mutate(F_RC, "    if (!(await isFolder(wanted))) return;\n", "", RC, pattern="the first spelling never stops a repair", **CASE_SENSITIVE)
mutate(F_RC, "    if (!(await isFolder(wanted))) return;\n", "    if (await missing(wanted)) return;\n", RC,
       pattern="a file the user saved in place of the first spelling", **CASE_SENSITIVE)
# cycle.ts and session.ts: every unsent commit scanned, git's refusals by name, a conflict
# reported once its copy is pushed, and the status wording.
mutate(CY, "(?:not uptodate|would be overwritten by merge)", "(?:not uptodate)", C, pattern="an edit staged by hand")
mutate(CY, "would be (?:overwritten|removed) by merge", "would be (?:overwritten) by merge", C, pattern="a deletion staged by hand")
mutate(CY, r"|Updating '([\s\S]+?)' would lose untracked files in it)$/gm", r")$/gm", C, pattern="a held-back note in a folder the remote replaces")
mutate(CY, "for (const line of commits.filter(Boolean)) {", "for (const line of commits.filter(Boolean).slice(0, 0)) {", C, pattern="a secret one hand commit added")
mutate(CY, "if (!(await exempt(commit, file))) inCommits.push({ file, commit });", "inCommits.push({ file, commit });", C, pattern="adds only what the remote's tree already holds")
mutate(CY, "    if (built && commit === to) continue;\n", "", C, pattern="scans what it carries over")
mutate(CY, "  for (const file of (await scanRange(clone, from, to)).keys()) if (!(await exempt(to, file))) inTree.push(file);\n", "", C, pattern="scans what it carries over")
mutate(CY, "      conflicts = integration.conflicts;\n", "      conflicts = integration.conflicts;\n      result.conflicts = conflicts;\n", C, pattern="only once its copy is on the remote")
mutate(CY, "(a force-push): nothing the rewrite", "(a force-push): sync stopped, so nothing the rewrite", C, pattern="a rewritten remote stops the cycle")
mutate(CY, "does not name a commit git can read, so a rewritten remote could go unnoticed",
       "does not name a commit git can read: sync stopped, so a rewritten remote cannot go unnoticed", C, pattern="a remote-seen that cannot be read")
mutate(CY, 'const named = stop.paths.length ? `: ${joinNames(stop.paths)}` : "";', "const named = `: ${joinNames(stop.paths)}`;", C, pattern="no dangling colon")
mutate(CY, 'if (merged.tree === (await gitOk(["rev-parse", `${upstream}^{tree}`], { cwd: clone }))) {', 'if (false && merged.tree === (await gitOk(["rev-parse", `${upstream}^{tree}`], { cwd: clone }))) {', C,
       pattern="nothing unsent pushes nothing")
mutate(CY, '  for (const name of await readdir(clone)) if (name.startsWith("sro-index-")) await rm(join(clone, name), { force: true });\n', "", C, pattern="a temporary index a killed cycle left")
mutate(CY, "    if (kept === \"unknown\") return { kind: \"unsynced\", reason: \"could not tell whether the remote's history was rewritten\" };\n", "", C, pattern="an ancestry git cannot tell")
mutate(CY, '  if (sent === "unknown") return { kind: "unsynced", reason: "could not compare the live snapshot with the remote" };\n', "", C, pattern="an ancestry git cannot tell")
mutate(CY, '  if (ahead === "unknown") return { kind: "unsynced", reason: "could not compare the remote with the live snapshot" };\n', "", C, pattern="an ancestry git cannot tell")
mutate(CY, 'return r.code === 0 ? "yes" : r.code === 1 ? "no" : "unknown";', 'return r.code === 0 ? "yes" : "no";', C, pattern="an ancestry git cannot tell")
mutate("core/session.ts", "; no version was lost, and any copy made sits beside its note", ", each with its copy beside it", SE, pattern="statusFromCycle gives each conflict")
# Task 7's review (fix round 1): a candidate the first pass dropped, three guards now pinned
# by tests of their own, and the type check's place before any skip.
mutate(F_RC, '    if (errno(err) === "ENOTEMPTY" || errno(err) === "EEXIST") return false;', '    if (errno(err) === "ENOTEMPTY" || errno(err) === "EEXIST") return true;', RC,
       pattern="saved into the empty tree")
mutate(F_RC, "  await prune(dir, dirname(rel));\n", "", RC, pattern="in a folder it made goes")
mutate(F_RC, "    if (absent(err)) return;\n    throw err;\n  }\n  await prune(dir, dirname(rel));", "    if (!absent(err)) throw err;\n  }\n  await prune(dir, dirname(rel));", RC,
       pattern="gone just before the repair unlinks")
mutate(F_RC, "    for (const rel of unit) left.set(rel, null);\n", "", RC, pattern="records a file it had removed as nothing")
mutate(F_RC, ('import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, unlink } from "node:fs/promises";', "    return (await lstat(path)).isDirectory();"),
       ('import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, stat, unlink } from "node:fs/promises";', "    return (await stat(path)).isDirectory();"), RC,
       pattern="never goes through a symlink", survives=("linux", "darwin"),
       why="defence in depth behind onDisk: respell walks only folders a set-back just went through, so no test meets a symlink there, and where case matters its renames need one file under two spellings")
mutate(F_R, "    if (!hasRule(record.type)) {\n      const todo = record.type.includes(\"submodule\") ? REMOVE_REPOSITORY : MOVE_ASIDE_RETRY;\n      return stop(`git reported ${record.type}, which the plugin cannot resolve by itself`, record.paths, todo);\n    }\n    for (const path of record.paths) handled.add(path);\n    if (record.type !== COLLISION && resolvedElsewhere(record.paths)) continue;\n",
       "    for (const path of record.paths) handled.add(path);\n    if (record.type !== COLLISION && resolvedElsewhere(record.paths)) continue;\n    if (!hasRule(record.type)) {\n      const todo = record.type.includes(\"submodule\") ? REMOVE_REPOSITORY : MOVE_ASIDE_RETRY;\n      return stop(`git reported ${record.type}, which the plugin cannot resolve by itself`, record.paths, todo);\n    }\n", R,
       pattern="even when a collision or a folder moved aside covers its paths")
# The final fix wave (2026-09-22): the repair never goes through a symlink (onDisk lstats each
# folder of a path from the vault root down), and each place that turns a path into a disk path
# asks it, where a test can tell.
mutate(F_RC, ('import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, unlink } from "node:fs/promises";', "      if (!(await lstat(folder)).isDirectory()) return null;"),
       ('import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, stat, unlink } from "node:fs/promises";', "      if (!(await stat(folder)).isDirectory()) return null;"), RC,
       pattern="never gone through|never written or read through|re-pointed by the user|swapped for a symlink between")
mutate(F_RC, '  for (const part of rel.split("/").slice(0, -1)) {', '  for (const part of rel.split("/").slice(0, -2)) {', RC, pattern="never gone through|never written or read through|re-pointed by the user")
mutate(F_RC, "      if (absent(err)) break;", "      if (absent(err)) return null;", RC, pattern="never written or read through")
mutate(F_RC, "  const path = await onDisk(root, rel);\n  if (path === null) return null;\n", "  const path = join(root, rel);\n", RC, pattern="never written or read through|turned a folder into a note, killed after writing")
mutate(F_RC, "async function missing(dir: string, rel: string): Promise<boolean> {\n  const path = await onDisk(dir, rel);\n  if (path === null) return true;\n",
       "async function missing(dir: string, rel: string): Promise<boolean> {\n  const path = join(dir, rel);\n", RC, pattern="never started, turning a note into a folder")
mutate(F_RC, "async function updatesWork(dir: string, rel: string, unit: string[], versions: Entry[]): Promise<boolean> {\n  const path = await onDisk(dir, rel);\n  if (path === null) return true;\n",
       "async function updatesWork(dir: string, rel: string, unit: string[], versions: Entry[]): Promise<boolean> {\n  const path = join(dir, rel);\n", RC, pattern="replaced with a file, after an update that never ran")
mutate(F_RC, "async function remove(dir: string, rel: string): Promise<void> {\n  const path = await onDisk(dir, rel);\n  if (path === null) return;\n",
       "async function remove(dir: string, rel: string): Promise<void> {\n  const path = join(dir, rel);\n", RC, pattern="swapped for a symlink between")
mutate(F_RC, "    if ((await fingerprint(dir, source)) !== print) {", "    if (true) {", RC, pattern="intent alone was recorded")
# A resolver stop says nothing was pushed or lost, names this machine's notes quoted and capped,
# and gives the one thing to do; every cycle line is one line.
mutate(F_R, 'record.type.includes("submodule") ? REMOVE_REPOSITORY : MOVE_ASIDE_RETRY', "MOVE_ASIDE_RETRY", R, pattern="each stop says the one thing")
mutate(F_R, "      mine.length ? mine : [...handled],", "      [...handled],", R, pattern="the check stops names the notes")
mutate(CY, 'const named = stop.paths.length ? `: ${joinNames(stop.paths)}` : "";', 'const named = stop.paths.length ? `: ${stop.paths.join(", ")}` : "";', C, pattern="names each note quoted")
mutate("core/session.ts", "  return out.map((item) => ({ ...item, text: oneLine(item.text) }));", "  return out;", SE, pattern="collapses the control characters")
# A failed check promises no merge (a rule's bug fails it too), and its own findings come last,
# quoted and capped, so such a failure can be diagnosed (2026-09-23).
mutate(F_R, "      MOVE_ASIDE_RETRY,\n      findings,\n", "      MOVE_ASIDE_RETRY,\n      [],\n", R, pattern="the check stops names the notes")
mutate(CY, "Nothing was pushed and nothing was lost. ${stop.todo}${found}`;", "Nothing was pushed and nothing was lost. ${stop.todo}`;", C,
       pattern="a rename that meets the other machine's note|a note renamed into a folder this machine replaced|a stop names each note quoted")
mutate(CY, "in the merge it refused: ${joinNames(stop.findings)}.", "in the merge it refused: ${stop.findings.join(\", \")}.", C, pattern="a stop names each note quoted")
# git's refusals are read as its whole lines, a quoted path spanning a line break.
mutate(CY, (r"/^error: (?:Entry '", r"would lose untracked files in it)$/gm"), (r"/(?:Entry '", r"would lose untracked files in it)/gm"), C, pattern="named with git's refusal wording")
mutate(CY, r"(?:Entry '([\s\S]+?)' (?:not uptodate", r"(?:Entry '(.+?)' (?:not uptodate", C, pattern="whose name holds a line break is named")
# Both scans read renames as git does by default, whatever diff.renames says.
mutate("core/secrets.ts", '      "--find-renames",\n', "", SEC, pattern="read renames as git does")
# The outbound scan reads each unsent commit's message too.
mutate(CY, '    if (scanText(await gitOk(["log", "-1", "--format=%B", commit], { cwd: clone })).length) inCommits.push({ file: null, commit });\n', "", C,
       pattern="in the message of an unsent commit")
# A repository in another object format than sha1 is refused where sync meets it, and the
# plugin's own init makes sha1.
mutate("core/sync/state.ts", '  if (format) return { kind: "stopped", reason: format };\n', "", S, pattern="a sha256 repository is refused")
mutate("core/sync/state.ts", "    if (format) return format;\n", "", S, pattern="a sha256 repository is refused")
mutate("core/sync/state.ts", '["init", "-q", "--object-format=sha1"]', '["init", "-q"]', S, pattern="an import makes a sha1 repository")
# The state clone: a leftover the sweep cannot delete never stops a rebuild, the identity is
# copied in (an includeIf "gitdir:" or the live repository's own config does not reach it), and
# no hook runs in the remote commands of a rebuild.
mutate(K, "{ recursive: true, force: true }).catch(() => undefined);\n  }", "{ recursive: true, force: true });\n  }", CL, pattern="sweep cannot delete")
mutate(K, '  for (const key of ["user.name", "user.email"]) {\n    await gitOk(["config", key, await gitOk(["config", key], { cwd: projectsDir })], { cwd: clone });\n  }\n', "", C,
       pattern="carries the user's identity")
mutate(K, ('[...noHooks, "remote", "rename",', '[...noHooks, "remote", "add",'), ('["remote", "rename",', '["remote", "add",'), CL, pattern="global hook never runs",
       survives=("linux", "darwin"),
       why="defence in depth: a fresh bare clone holds only refs/heads and refs/tags, which neither remote command touches, so neither changes a ref or runs a hook (checked, git 2.50.1)")
# The live update's adaptive limit (spec 5.4 step 5, 2026-09-23): each timeout of the live
# update or its repair doubles the next limit up to 64 times the base, where the status
# escalates to a notify; only a completed update sets it back. runs=5 where the catching test
# needs an update to finish inside its limit, so no timing flake can pass for a catch.
LADDER = "slower than the base limit"; CEILING = "never finishes climbs"; KEPT = "a refusal leaves the live update's limit"
mutate(CY, "level: Math.min(ladder.level + 1, MAX_LEVEL) };", "level: Math.min(ladder.level, MAX_LEVEL) };", C, runs=5, pattern=LADDER)
mutate(CY, "level: Math.min(ladder.level + 1, MAX_LEVEL) };", "level: ladder.level + 1 };", C, pattern=CEILING)
mutate(CY, "ceiling: ladder.level === MAX_LEVEL, note };", "ceiling: false, note };", C, pattern=CEILING)
mutate(CY, "    // The limit was enough: the next update starts again from the base.\n    await writeLevel(input.stateDir, 0);\n", "", C, runs=5, pattern=LADDER)
mutate(CY, "  await clearInterrupted(input.stateDir);\n  result.blockedBy = blocked;", "  await clearInterrupted(input.stateDir);\n  await writeLevel(input.stateDir, 0);\n  result.blockedBy = blocked;", C, pattern=KEPT)
mutate(CY, "  if (!blocked.length) {", "  if (!blocked.length) {\n    await writeLevel(input.stateDir, 0);", C, pattern=KEPT)
mutate(CY, "finishInterrupted(input.stateDir, dir, { timeoutMs: limitOf(ladder) })", "finishInterrupted(input.stateDir, dir, { timeoutMs: ladder.base })", C, runs=5,
       pattern="a repair gets the live update's current limit")
mutate(CY, "    timeoutMs: limitOf(ladder),\n", "    timeoutMs: ladder.base,\n", C, runs=5, pattern=LADDER)
mutate(CY, "      if (!(err instanceof RepairTimedOut)) throw err;\n", "      throw err;\n", C, runs=5, pattern=f"{LADDER}|repair that times out stops")
mutate(CY, "/^[0-6]$/.test(text) ? Number(text) : 0", "Number(text) || 0", C, pattern="cannot be read is the base")
mutate(CY, "/^[0-6]$/.test(text) ? Number(text) : 0", "/^[0-6]$/.test(text.trim()) ? Number(text.trim()) : 0", C, pattern="cannot be read is the base")
mutate(CY, "/^[0-6]$/.test(text)", "/^[0-9]$/.test(text)", C, pattern="cannot be read is the base")
# The repair that timed out stops the cycle before its snapshot: without this return, the
# half-repaired vault would be snapshotted and pushed.
mutate(CY, "      await timedOut(input.stateDir, ladder, result, err.path);\n      return result;", "      await timedOut(input.stateDir, ladder, result, err.path);", C, runs=5,
       pattern="repair that times out stops")
mutate(F_RC, "err instanceof GitError && err.result.timedOut ? new RepairTimedOut(err.args, err.result, source) : err", "err", RC, pattern="a repair that times out saves")
mutate("core/session.ts", "  if (!r.timedOut.ceiling) {", "  if (true) {", SE, pattern="statusFromCycle gives a live update that timed out")
mutate("core/session.ts", "  if (ms % 60_000 === 0) return `${ms / 60_000} min`;\n", "", SE, pattern="statusFromCycle gives a live update that timed out")
# Fix round 1: the ceiling names the note the repair was rewriting, and a problem recorded
# with the reason (a failed lock release) still reaches the line.
mutate(CY, "await timedOut(input.stateDir, ladder, result, err.path);", "await timedOut(input.stateDir, ladder, result);", C, runs=5,
       pattern="never finishes climbs|slower than the base limit")
mutate("core/session.ts", '  const note = r.timedOut.note === null ? "" : ` while it was rewriting ${quoted(r.timedOut.note)}`;',
       '  const note = "";', SE, pattern="statusFromCycle gives a live update that timed out")
mutate("core/session.ts", "  const also = said.startsWith(TIMED_OUT) ? said.slice(TIMED_OUT.length) : `; ${said}`;", '  const also = "";', SE,
       pattern="statusFromCycle gives a live update that timed out")
# Fix round 1, Important 1: an update outlives the session that started it (git is detached,
# and its kill timer dies with the session). The cycle waits for a recorded group that is
# alive, rather than setting its notes back and pushing them, and a normal exit takes the
# groups this process started with it.
WAITS = "waits for a record's live process group"
mutate(F_RC, "  return groupAlive(record.group) ? record.group : null;", "  return null;", C, runs=5, pattern=WAITS)
mutate(CY, "      result.reason = `an earlier vault update is still running (process group ${running}); sync waits for it. If it is hung, end that process.`;\n      return result;",
       "      result.reason = `an earlier vault update is still running (process group ${running}); sync waits for it. If it is hung, end that process.`;", C, runs=5, pattern=WAITS)
mutate(CY, "    onSpawn: (group) => recordIntent(input.stateDir, live, next, group),\n", "", C, pattern="records its process group")
mutate("core/git.ts", '  if (started.size === 0) process.on("exit", killStarted);\n', "", G, pattern="session that exits normally takes the git")
mutate("core/git.ts", "    started.delete(pid);\n", "", G, pattern="session that exits normally takes the git")
# The wait comes before the blocked-cycle bookkeeping, so a cycle that only waited leaves
# the streak where it was, as a busy one does; and a group of 0 or 1 is never a group.
WAIT_BLOCK = """    const running = await runningUpdate(input.stateDir);
    if (running !== null) {
      result.outcome = "unsynced";
      result.reason = `an earlier vault update is still running (process group ${running}); sync waits for it. If it is hung, end that process.`;
      return result;
    }
"""
STREAK_BLOCK = """    const streak = await readBlocked(input.stateDir);
    await writeBlocked(input.stateDir, 0);
"""
mutate(CY, (WAIT_BLOCK, STREAK_BLOCK), ("", STREAK_BLOCK + WAIT_BLOCK), C, pattern=WAITS)
mutate(F_RC, "!Number.isInteger(group) || group < 2", "!Number.isInteger(group) || group < 0", RC, pattern="a record that cannot be read")
