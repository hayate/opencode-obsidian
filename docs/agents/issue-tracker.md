# Issue tracker: Obsidian vault

Specs, plans and tickets for this repo live in the Obsidian vault, in
`$OBSIDIAN_VAULT_PATH/Projects/opencode-superpower-obsidian/` (on moonveil:
`~/Documents/Da Vinci/Projects/opencode-superpower-obsidian/`). They are never
committed to this code repo. GitHub Issues is not used.

## Layout

- Specs: `specs/YYYY-MM-DD-<slug>.md`
- Plans: `plans/YYYY-MM-DD-<slug>.md`
- Tickets: `issues/<feature-slug>/NN-<slug>.md`, one file per ticket, numbered from `01`
- Triage state: a `Status:` line near the top of each ticket (strings in `triage-labels.md`)
- Discussion: appended at the bottom under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Write a new file under the layout above (a spec goes to `specs/`, tickets to
`issues/<feature-slug>/`), creating the directory if needed.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path; the user normally passes the path or the
feature slug and number.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `issues/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `issues/<effort>/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `issues/<effort>/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
