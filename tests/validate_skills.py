#!/usr/bin/env python3
"""Validate the opencode-superpower-obsidian skill bundle.

Checks:
1. Every **/SKILL.md has frontmatter with a `name` and non-empty `description`.
2. Each skill `name` matches its folder name (opencode requires this).
3. No `docs/superpowers/` references remain (all redirected to the vault).
4. No stale `opencode-obsidian` name (bundle was renamed).
5. `superpowers:<name>` cross-references resolve to a skill in the bundle.
6. No duplicate skill names.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def find_skill_dirs():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        if "SKILL.md" in filenames:
            yield dirpath


def parse_frontmatter(path):
    text = open(path, encoding="utf-8").read()
    if not text.startswith("---"):
        return None
    m = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        return None
    fm = {}
    for line in m.group(1).split("\n"):
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip().strip("\"'")
    return fm


def walk_text_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for fn in filenames:
            if fn.endswith((".md", ".sh", ".js", ".ts", ".json", ".cjs")):
                yield os.path.join(dirpath, fn)


def main():
    errors = []
    skills = {}

    for dirpath in find_skill_dirs():
        folder = os.path.basename(dirpath)
        skill_md = os.path.join(dirpath, "SKILL.md")
        fm = parse_frontmatter(skill_md)
        if fm is None:
            errors.append(f"{skill_md}: missing or invalid frontmatter")
            continue
        name = fm.get("name")
        desc = fm.get("description")
        if not name:
            errors.append(f"{skill_md}: missing `name`")
        if not desc:
            errors.append(f"{skill_md}: missing `description`")
        if name and name != folder:
            errors.append(
                f"{skill_md}: name '{name}' does not match folder '{folder}'"
            )
        if name == "opencode-obsidian":
            errors.append(f"{skill_md}: stale name 'opencode-obsidian'")
        if name:
            skills[folder] = name

    names = list(skills.values())
    seen = {}
    for n in names:
        seen[n] = seen.get(n, 0) + 1
    for n, c in seen.items():
        if c > 1:
            errors.append(f"duplicate skill name '{n}' ({c}x)")

    cross_ref_re = re.compile(r"superpowers:([a-z0-9-]+)")
    banned = [
        "visual-companion",
        "using-superpowers/references",
        "brainstorming/scripts",
        "start-server",
        "stop-server",
        "server.cjs",
    ]
    for path in walk_text_files():
        text = open(path, encoding="utf-8", errors="ignore").read()
        if "docs/superpowers" in text:
            errors.append(f"{path}: leftover docs/superpowers reference")
        for b in banned:
            if b in text:
                errors.append(f"{path}: reference to dropped path '{b}'")
        for ref in cross_ref_re.findall(text):
            if ref not in names:
                errors.append(
                    f"{path}: cross-ref 'superpowers:{ref}' does not resolve"
                )

    if errors:
        print(f"FAILED: {len(errors)} error(s)")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)

    print(f"OK: {len(skills)} skills valid")
    sys.exit(0)


if __name__ == "__main__":
    main()
