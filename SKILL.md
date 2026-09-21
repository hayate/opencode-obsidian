---
name: opencode-superpower-obsidian
description: Use the Obsidian "Da Vinci" vault as opencode's single home for memory, handoffs, specs, plans, decisions, and notes. Read, search, create, and edit notes; write and archive handoffs (HANDOFF.md), design specs (specs/), implementation plans (plans/), decisions (decisions/), and notes (notes/). Use when asked to read or write a handoff, note, memory, spec, or plan, or to touch the Obsidian vault / "Da Vinci" folder.
license: MIT
---

# Obsidian Vault (memory + handoff + specs + plans)

Use this skill for filesystem-first work in the Obsidian "Da Vinci" vault:
reading, searching, and writing notes, and carrying state between sessions.
The vault is the default store for everything these systems used to keep
separately: memory (decisions/ and notes/), handoffs (HANDOFF.md), and design
and planning artifacts (specs/ and plans/).

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
- `Projects/<project>/specs/` - design docs / specs (`YYYY-MM-DD-<topic>-design.md`).
- `Projects/<project>/plans/` - implementation plans (`YYYY-MM-DD-<feature-name>.md`).
- `Projects/<project>/decisions/` - durable decisions (`YYYY-MM-DD-slug.md`).
- `Projects/<project>/notes/` - durable notes (gotchas, procedures).
- `Projects/<project>/archive/` - dated copies of superseded handoffs and plans.
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

The vault is git-only, synced across three machines - moonveil (this Mac),
astrolinux, and astromaya - against the bare store
`root@astromaya:/srv/vault.git`. A sync timer on each machine auto-commits and
pushes roughly every 10 minutes. Write files and move on; you do not need to
commit the vault manually. Canonical design lives in
`Agents/astromaya/vault-sync-design.md` (the repo wins over any doc).
