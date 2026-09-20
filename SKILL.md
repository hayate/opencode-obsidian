---
name: opencode-obsidian
description: Read, search, create, and edit notes in the Obsidian "Da Vinci" vault, and use it as a handoff and memory tool. Write and archive handoff notes (HANDOFF.md plus archive/plans/decisions/notes siblings) to carry session state across sessions. Use when asked to read or write a handoff, note, or memory, or to touch the Obsidian vault / "Da Vinci" folder.
license: MIT
---

# Obsidian Vault (handoff + memory)

Use this skill for filesystem-first work in the Obsidian "Da Vinci" vault:
reading and searching notes, and carrying session state between sessions via
the handoff convention (`HANDOFF.md` plus its `archive/`, `plans/`,
`decisions/`, `notes/` siblings).

## Vault path

The vault is a git-only repo checked out at `~/Documents/Da Vinci` on every
machine. Resolve it from the `OBSIDIAN_VAULT_PATH` environment variable when
set; otherwise use `~/Documents/Da Vinci`. If neither is reachable, ask the
user for the path and set `OBSIDIAN_VAULT_PATH`.

File tools do not expand shell variables and the path contains a space, so
always resolve to a concrete absolute path (e.g. `/Users/andrea/Documents/Da
Vinci` on moonveil) before calling `read`, `write`, `edit`, `glob`, or
`grep`. Use `bash` to check whether the path exists when unsure.

## Layout

- `Projects/<project>/HANDOFF.md` - current in-flight state for that project.
- `Projects/<project>/archive/` - dated copies of superseded handoffs.
- `Projects/<project>/plans/` - dated plan files (`YYYY-MM-DD-slug.md`).
- `Projects/<project>/decisions/` - durable decisions (`YYYY-MM-DD-slug.md`).
- `Projects/<project>/notes/` - durable notes (gotchas, procedures).
- `Agents/<machine>/` - per-machine working notes (astromaya, astrolinux).

The project folder is named after the repo/project. A session working in a
repo maps its state to `Projects/<that-name>/`.

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

The vault is git-only, synced across three machines - moonveil (this Mac),
astrolinux, and astromaya - against the bare store
`root@astromaya:/srv/vault.git`. A sync timer on each machine auto-commits and
pushes roughly every 10 minutes. Write files and move on; you do not need to
commit the vault manually. Canonical design lives in
`Agents/astromaya/vault-sync-design.md` (the repo wins over any doc).
