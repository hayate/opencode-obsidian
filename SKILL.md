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

The project folder is the one the session's memory names: the `Project:`
line at the top of the session. The plugin finds it by the repository's
recorded origin first, so it can differ from the clone's folder name; never
derive it from the repository name yourself. If the memory says memory is
disabled, do not write into `Projects/` at all.

Create the project folder's subfolders (`specs/`, `plans/`, `decisions/`,
`notes/`, `archive/`) with `bash mkdir -p` when one you need does not exist yet.
The user does not create these; opencode does.

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

`Projects/` is its own git repository, and the plugin keeps it in sync: at the
start of every OpenCode session and whenever a session goes idle, it commits
what changed under `Projects/`, integrates what other machines pushed, and
pushes. `OBSIDIAN_PROJECTS_REMOTE` is the on/off switch: unset or empty means
sync is off; a URL or path means sync is on, to that remote.

**Never run git in `Projects/`** - no pull, commit, push, stash, or reset. Git
commands there race the plugin's own and can strand changes. Write notes with the
file tools; the plugin sends them.

The plugin reports what it did as status lines at the top of the session, and
later ones beside the message they arrived after:

- A note changed on two machines keeps both versions: yours at the path, the
  other beside it as a conflict copy. The status line names both. Merge what you
  need into the note, then delete the copy.
- A file the secret scan held back is not synced until the secret is gone. Fix
  the file, then run `remember_sync`.
- A line tagged `[error]` needs the user: tell them what it says.
- A line saying the remote's history was rewritten stops sync until the user
  decides. Only when they confirm the rewrite was intended, run
  `remember_sync` with `adopt_rewrite: true`.

Because `Projects/` is its own repository, the vault's own repository (if the
vault is one) must not also track it. The plugin refuses to sync while it does;
the README's migration steps fix it.
