# opencode-superpower-obsidian

A bundle of skills that use an Obsidian vault as opencode's single home for
memory, handoffs, specs, plans, decisions, and notes.

## Installation

1. Install the bundle into opencode's skills directory:

   ```
   git clone https://github.com/<your-fork>/opencode-superpower-obsidian \
     ~/.config/opencode/skills/opencode-superpower-obsidian
   ```

   Or place the `opencode-superpower-obsidian/` directory anywhere opencode
   scans for skills (e.g. `~/.config/opencode/skills/`, `~/.claude/skills/`,
   or `~/.agents/skills/`).

2. Set the `OBSIDIAN_VAULT_PATH` environment variable to the absolute path of
   your Obsidian vault directory. For example, add this to your shell profile
   (`~/.zshrc` on macOS):

   ```
   export OBSIDIAN_VAULT_PATH="/path/to/your/Obsidian Vault"
   ```

   This variable is required. The skills read it at runtime and fail loudly if
   it is unset or unreachable, so set it before relying on the bundle.

3. (Optional) Set the `OBSIDIAN_PROJECTS_REMOTE` environment variable to the
   URL or path of a git repository that will hold your `Projects/` content.
   This variable acts as the on/off switch for cross-machine syncing: if it is
   unset or empty, sync is off and nothing is pushed or pulled; if it is
   nonempty, sync is on. Create the repo yourself (a bare repo, a GitHub repo,
   or similar), then:

   ```
   export OBSIDIAN_PROJECTS_REMOTE="git@github.com:you/oso-projects.git"
   ```

   Acceptable values are any URL or path `git` can push to, most commonly:

   - SSH (recommended): `git@github.com:you/oso-projects.git` or
     `ssh://host/path/to/projects.git`. Uses your SSH keys for clone, pull,
     and push - one setup, everything works.
   - HTTPS: `https://github.com/you/oso-projects.git`. Public repositories can
     normally be cloned and fetched anonymously; private repositories and every
     push require HTTPS authentication (a personal access token, Git Credential
     Manager, or GitHub CLI auth) - SSH keys do not cover HTTPS. Use HTTPS only
     if you have that authentication set up, otherwise clone and push will fail.
   - Local bare path: `/path/to/projects.git`. Works when the repo is on a
     filesystem the machine can reach directly.

   The trailing `.git` is optional on GitHub but include it to be unambiguous
   on other hosts.

   On first use, opencode clones this repo into `<vault>/Projects/`. On each
   session start it pulls, and after each edit under `Projects/` it commits and
   pushes. Every machine you use should set this to the same repo so they stay
   in sync. If the repo is freshly created and empty, opencode initializes it
   with the first commit.

4. Restart opencode so it picks up the new skills and the environment variables.

The `Projects/` directory (and its per-project subfolders) is created
automatically by opencode on first use if it does not already exist - you do
not need to create it yourself.

## Troubleshooting

- **Projects don't appear in Obsidian after the first clone.** Obsidian may not
  pick up the freshly cloned `Projects/` directory until it is restarted. If
  the files are on disk but missing from Obsidian's file explorer, quit and
  reopen Obsidian.
