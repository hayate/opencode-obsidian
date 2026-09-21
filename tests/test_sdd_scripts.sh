#!/usr/bin/env bash
# Integration test for the SDD scripts. A plan file lives in a separate
# "vault" git repo; the SDD workspace must be created in the CODE repo
# (selected via SDD_REPO_ROOT), never in the vault, and review-package must
# diff the code repo's commits.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$HERE/../subagent-driven-development/scripts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

code="$TMP/code"
vault="$TMP/vault"

mkdir -p "$code"
git -C "$code" init -q
git -C "$code" config user.email test@example.com
git -C "$code" config user.name test
git -C "$code" commit -q --allow-empty -m base
git -C "$code" tag base
git -C "$code" commit -q --allow-empty -m tip
git -C "$code" tag tip

mkdir -p "$vault/Projects/foo/plans"
git -C "$vault" init -q
printf '# feature-plan\n\n## Task 1\n- [ ] do the thing\n' > "$vault/Projects/foo/plans/feature-plan.md"
plan="$vault/Projects/foo/plans/feature-plan.md"

SDD_REPO_ROOT="$code" "$SCRIPTS/sdd-workspace" "$plan" >/dev/null
[ -d "$code/.superpowers/sdd/feature-plan" ] \
  || { echo "workspace not created in the code repo" >&2; exit 1; }
[ -d "$vault/.superpowers" ] \
  && { echo "workspace leaked into the vault" >&2; exit 1; }

brief="$TMP/brief.md"
SDD_REPO_ROOT="$code" "$SCRIPTS/task-brief" "$plan" 1 "$brief"
[ -s "$brief" ] || { echo "task-brief produced no brief" >&2; exit 1; }
grep -q 'do the thing' "$brief" || { echo "brief missing task text" >&2; exit 1; }

pkg="$TMP/review.diff"
SDD_REPO_ROOT="$code" "$SCRIPTS/review-package" "$plan" base tip "$pkg"
[ -s "$pkg" ] || { echo "review-package produced no package" >&2; exit 1; }
grep -q 'base..tip' "$pkg" || { echo "review-package missing range" >&2; exit 1; }

wt="$TMP/wt"
git -C "$code" worktree add -q "$wt" base
SDD_REPO_ROOT="$wt" "$SCRIPTS/sdd-workspace" "$plan" >/dev/null
[ -d "$wt/.superpowers/sdd/feature-plan" ] \
  || { echo "workspace not created in the linked worktree" >&2; exit 1; }

echo "SDD scripts OK (workspace in code repo/worktree, not the vault)"
