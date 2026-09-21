---
name: opencode-superpower-obsidian
description: Use your Obsidian vault as opencode's single home for memory, handoffs, specs, plans, decisions, and notes. Read, search, create, and edit notes; write and archive handoffs (HANDOFF.md), design specs (specs/), implementation plans (plans/), decisions (decisions/), and notes (notes/). Use when asked to read or write a handoff, note, memory, spec, or plan, or to touch the Obsidian vault folder.
license: MIT
---

# Obsidian Vault (memory + handoff + specs + plans)

Use this skill for filesystem-first work in your Obsidian vault:
reading, searching, and writing notes, and carrying state between sessions.
The vault is the default store for everything these systems used to keep
separately: memory (decisions/ and notes/), handoffs (HANDOFF.md), and design
and planning artifacts (specs/ and plans/).

## Vault path

Resolve the vault location from the `OBSIDIAN_VAULT_PATH` environment variable.
It is required: if it is unset, fail loudly - stop and
tell the user to set `OBSIDIAN_VAULT_PATH` to the absolute path of their
Obsidian vault (see README.md for setup). Do not guess, and do not fall back to
any default path. If the variable is set but the path is unreachable, stop and
tell the user the path is invalid rather than proceeding.

File tools do not expand shell variables and the path may contain spaces, so
always resolve to a concrete absolute path (e.g. `/Users/<name>/Documents/My
Vault`) before calling `read`, `write`, `edit`, `glob`, or `grep`. Use `bash`
to check whether the path exists when unsure.

The user does not need to create any directory - on first use, opencode creates
a `Projects/` directory at the vault root (and the `<project>/` folder plus its
subfolders) if they do not already exist.

## Layout

- `Projects/<project>/HANDOFF.md` - current in-flight state for that project.
- `Projects/<project>/specs/` - design docs / specs (`YYYY-MM-DD-<topic>-design.md`).
- `Projects/<project>/plans/` - implementation plans (`YYYY-MM-DD-<feature-name>.md`).
- `Projects/<project>/decisions/` - durable decisions (`YYYY-MM-DD-slug.md`).
- `Projects/<project>/notes/` - durable notes (gotchas, procedures).
- `Projects/<project>/archive/` - dated copies of superseded handoffs and plans.
- `Agents/<machine>/` - per-machine working notes.

The project folder is named after the repo/project. A session working in a
repo maps its state to `Projects/<that-name>/`.

Create the `Projects/` directory (and the `<project>/` folder plus its
subfolders) with `bash mkdir -p` if they do not already exist inside the vault
before writing any handoff, spec, plan, decision, or note. The user does not
create these; opencode does.

## Handoff lifecycle

Handoff files carry session state across sessions. Conventions:

- Frontmatter: `type: handoff`, `project: <name>`, `updated: <YYYY-MM-DD>`.
  Fresh projects leave `updated` as a placeholder dash and a short "No work
  recorded yet" body.
- Title: `# <project> - handoff`.
- Read `HANDOFF.md` BEFORE starting work in a project.
- Rewrite `HANDOFF.md` (never append) when stopping: current state only -
  branches and commits, what is in flight, next sequence, blockers. Keep it
  under ~40 lines.
- Move the superseded `HANDOFF.md` content into `archive/` under a dated name
  (e.g. `2026-09-19-handoff.md` or `HANDOFF-2026-09-20-pre28.md`).
- Durable knowledge (decisions, gotchas, procedures) belongs in `decisions/`
  or `notes/`, not in `HANDOFF.md`. Link them with wikilinks.

## Specs and plans

The vault is the default store for design and planning artifacts.
Before implementing a feature:

- Write the spec (design doc) to
  `Projects/<project>/specs/YYYY-MM-DD-<topic>-design.md`.
- Write the implementation plan to
  `Projects/<project>/plans/YYYY-MM-DD-<feature-name>.md`.
- Link HANDOFF.md to its plan and spec with wikilinks; archive superseded
  plans the same way as handoffs.

## Memory

The vault is the default store for memory. Two tiers:

- Durable per-project knowledge -> `decisions/` and `notes/` (what the
  automatic memory plugins used to keep elsewhere).
- Session state -> `HANDOFF.md` (rewritten on stop) plus `archive/`.

## Read a note

Use `read` with the resolved absolute path. It provides line numbers and
pagination; prefer it over shell `cat`.

## List notes

Use `glob` with a `pattern` like `*.md` under the vault path (or a subfolder)
to list notes. Prefer it over `ls` or `find`.

## Search

- Filenames: `glob` with a filename pattern.
- Contents: `grep` with a regex `pattern`, restricted to markdown via
  `include: "*.md"` when you only want notes.

## Create a note

Use `write` with the resolved absolute path and the full markdown content.
Prefer it over shell heredocs or `echo`.

## Append / edit a note

- Read the note with `read`, then use `edit` for a targeted change when the
  current content gives stable anchor text.
- Use `write` to rewrite the whole note when that is clearer than a fragile
  edit.
- A plain append with no stable context may use `bash` when that is the
  clearest safe option.

## Wikilinks

Obsidian links notes with `[[Note Name]]` syntax. When creating notes, link
related content (e.g. link a HANDOFF to its plan with
`[[2026-09-20-cancellations-monthly-yoy]]`).

## Sync

`Projects/` is its own git repository. Syncing is governed by the
`OBSIDIAN_PROJECTS_REMOTE` environment variable, which doubles as the on/off
switch. The rule is the same everywhere: if it is unset or empty, sync is off;
if it is nonempty, sync is on and its value is the remote URL or path. Treat an
exported empty string the same as unset - both mean off.

When sync is off: create `Projects/` and its subfolders with `mkdir -p` as
needed, and do no git operations at all.

When sync is on, follow this ordered procedure on first use and on every session:

1. Determine the `Projects/` state and act accordingly:
   - Absent or empty directory: clone `OBSIDIAN_PROJECTS_REMOTE` into
     `Projects/`. If the remote is an empty repo (no commits yet), bootstrap it:
     create the first commit locally and `git push -u origin main` (use the
     remote's default branch name if it differs).
   - Nonempty but not a git repo: stop and tell the user - their existing notes
     need an explicit import or migration; do not overwrite them with a clone.
   - Already a git repo: verify `origin` matches `OBSIDIAN_PROJECTS_REMOTE`
     before any pull or push. Fail loudly on a mismatch rather than silently
     changing it or pushing to a stale remote. After the first clone, `origin` -
     not the env var - governs pull/push; the env var is only re-read to confirm
     the remote has not changed.
2. On session start, pull before reading or writing anything: `git -C
   <vault>/Projects pull --rebase --autostash`.
3. After edits under `Projects/`, commit noninteractively and push. First confirm
   `user.name` and `user.email` are configured (fail with instructions if not),
   then check `git status`, stage the intended files (`git add -A` only when the
   whole tree is the intended change), `git commit -m "..."`, and `git push`.
4. If the push is rejected as non-fast-forward, fetch and rebase, then retry a
   bounded number of times. If rebasing conflicts, stop, preserve both versions,
   and ask the user to resolve. Simultaneous edits to the same file (a shared
   HANDOFF.md, for example) are not automatically merge-safe.

Because `Projects/` is its own repo, the vault repo (if it is one) must not also
track it. Add `Projects/` to the vault repo's root `.gitignore`. If the vault
already tracks it, remove it from the index without deleting the files
(`git rm -r --cached Projects`), commit that removal, and only then establish
the nested repo.
