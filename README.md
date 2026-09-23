# opencode-superpower-obsidian

An OpenCode plugin and a bundle of skills that use an Obsidian vault as
OpenCode's single home for memory, handoffs, specs, plans, decisions, and notes.
The plugin loads each project's memory into the session and keeps the vault's
`Projects/` folder in sync across machines; the skills carry the process.

## Installation

1. Clone the repository into OpenCode's skills directory and install its
   dependencies:

   ```
   git clone https://github.com/<your-fork>/opencode-superpower-obsidian \
     ~/.config/opencode/skills/opencode-superpower-obsidian
   cd ~/.config/opencode/skills/opencode-superpower-obsidian && npm ci
   ```

2. Load the same folder as a plugin: add it to the `plugin` list in
   `~/.config/opencode/opencode.jsonc`, as an absolute `file://` path:

   ```
   "plugin": ["file:///Users/you/.config/opencode/skills/opencode-superpower-obsidian"]
   ```

   To choose the model that writes the journal (see the cost note below), use
   the two-element form instead:

   ```
   "plugin": [["file:///Users/you/.config/opencode/skills/opencode-superpower-obsidian", { "journalModel": "provider/model" }]]
   ```

3. Set `OBSIDIAN_VAULT_PATH` to the absolute path of your Obsidian vault (the
   folder holding `.obsidian/`), for example in `~/.zshrc`:

   ```
   export OBSIDIAN_VAULT_PATH="/path/to/your/Obsidian Vault"
   ```

   Without it the plugin still loads, and every session says, at the top, that
   memory and sync are disabled.

4. (Optional) Set `OBSIDIAN_PROJECTS_REMOTE` to a **private** git repository that
   will hold `Projects/`. It is the on/off switch for syncing across machines:
   unset or empty means off; a URL or path means on. Create the repository
   yourself (a private GitHub repository, or a bare repository on a machine you
   control):

   ```
   export OBSIDIAN_PROJECTS_REMOTE="git@github.com:you/oso-projects.git"
   ```

   SSH is the simplest: your SSH keys cover clone, pull, and push. HTTPS works
   when you have HTTPS credentials set up (a token, Git Credential Manager, or
   the GitHub CLI). A local bare path works on a filesystem the machine reaches
   directly. Every machine should point at the same repository.

   The remote is trusted with everything in `Projects/`: keep it private. For a
   github.com remote, the plugin checks at every session start and refuses to
   sync to a public repository; for any other host, privacy is up to you.

5. Restart OpenCode.

## How sync works

The plugin syncs `Projects/` when a session starts and, best effort, when it
goes idle: it commits what changed (after a secret scan), integrates what other
machines pushed, and pushes. The start's sync runs in every session the plugin
starts (a session OpenCode reports as a subagent's is skipped); the idle sync
and the journal run only in a main session whose memory is on. An idle first writes the session's
journal entry (waiting at most two minutes for the model), then waits a moment
so the notes just written are complete, then syncs; headless `opencode run` can
exit before an idle finishes, in which case the next session's start sends
what it left. `remember_sync` syncs on demand, with the same short wait. On a machine's first session it clones
the remote into `Projects/`, or, when the remote is empty, fills it from the
`Projects/` already there. A note changed on two machines keeps both versions:
yours at the path, the other beside it as a conflict copy, and the session's
status says where both are.

Sync runs only inside OpenCode sessions. A machine you use only to read in
Obsidian stays behind until OpenCode runs there, or until you pull by hand:

```
git -C "$OBSIDIAN_VAULT_PATH/Projects" pull --ff-only
```

What the start's sync did appears as status lines at the top of the session.
A later sync adds a note to the conversation only when it has something new to
say (a clean sync says nothing), and errors also appear as a toast in the TUI.
Headless `opencode run` has no toast: there the status reaches only the model,
and the next session's start.

The journal is written by a model call from the plugin: the `journalModel`
option, else OpenCode's `small_model`, else its default model; a setting that
is not `provider/model` is reported, and OpenCode's default is used. An idle
journals its session at most once every ten minutes, and a session's start
journals other sessions of the project that have new messages since their last
entry; choose a small, cheap model if your default is an expensive one.

## Procedures

### The vault's own repository tracks `Projects/`

`Projects/` is its own repository, so a vault that is itself a git repository
must not track it; the plugin refuses to sync until it does not. Untracking is
a commit to the vault's repository, and every machine that pulls that commit
has git **delete** its copy of `Projects/`. So do it in this order, and do not
let any machine pull the vault in between (turn off automatic vault syncing,
such as the Obsidian Git plugin, on every machine first):

1. On every machine, copy `Projects/` somewhere outside the vault, as a backup.
2. On one machine (the one with the most complete notes), with
   `OBSIDIAN_PROJECTS_REMOTE` set to a new, empty, private repository:

   ```
   cd "$OBSIDIAN_VAULT_PATH"
   printf '\nProjects/\n' >> .gitignore
   git rm -r --cached Projects
   git commit -m "Stop tracking Projects/ (synced on its own)"
   git push
   ```

   Then start an OpenCode session there: the plugin imports `Projects/` into
   the empty remote. Check the remote has the notes before going on.
3. On each other machine, with OpenCode closed there, and **before** pulling
   the vault: move `Projects/` out of the vault
   (`mv Projects ../Projects.before-sync`, or anywhere outside), pull the vault
   (there is now nothing for the pull to delete), set
   `OBSIDIAN_PROJECTS_REMOTE`, and start an OpenCode session: the plugin clones
   `Projects/` from the remote. Close OpenCode again and compare the two:

   ```
   diff -rq "$OBSIDIAN_VAULT_PATH/Projects" ../Projects.before-sync
   ```

   Copy in every file only the backup has. For every file both have with
   different contents (the same note edited on two machines before sync
   existed), merge the backup's version into the clone's copy by hand, or keep
   it beside the note under another name. Then start a session: the sync sends
   what you copied and merged.
4. Delete the backups only when every machine has done step 3 and its merges
   are on the remote (open one merged note on another machine after its next
   session start). Then turn vault syncing back on.

### Two folders claim the same repository

Two machines that first used a repository under different clone names, before
either synced, each create a folder for it. The plugin then disables memory for
that repository and names both folders. Quit OpenCode on every machine, move the
notes of one folder into the other, delete the emptied folder (its
`remember/.origin` included), and start a session: the next sync sends the
merge.

### A repository was renamed

A folder records its repository's origin in `remember/.origin`, and a session
finds its folder by that origin first. After a rename no folder holds the new
origin. If your clone still has the old folder's name, the plugin disables
memory (that folder belongs to another origin); if the clone's name changed
too, it starts a new folder under the new name. To keep one folder,
quit OpenCode on every machine, then, before the next session: replace the one
line in the old folder's `remember/.origin` with the new origin, written the
way the file already writes it (for example `github.com/you/new-name`), rename
the folder if you want the new name, and delete any new folder a session
already started (moving its notes in first). The next sync sends it all
together.

## Troubleshooting

- **Projects don't appear in Obsidian after the first clone.** Obsidian may not
  pick up the freshly cloned `Projects/` directory until it is restarted. Quit
  and reopen Obsidian.
- **A session says memory and sync are disabled.** The line says why: the
  vault variable is missing or points at a folder without `.obsidian/`, the
  repository is bare, or one of the procedures above applies.
- **The vault is missing or unusable.** `OBSIDIAN_VAULT_PATH` is the one setting
  the plugin cannot work without, so it says so as soon as it loads, before any
  message: an error in OpenCode's log straight away, and a toast once the TUI is
  up. The first message says it again. `OBSIDIAN_PROJECTS_REMOTE` is different:
  leaving it unset only turns sync off.
