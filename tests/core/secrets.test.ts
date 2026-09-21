import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDiff, scanText, unquoteGitPath } from "../../core/secrets.ts";

// Fixtures are assembled at runtime: a literal token-shaped string in this file
// would trip GitHub push protection on the repository itself.
const j = (...parts: string[]): string => parts.join("");
const noise = (n: number): string => {
  const alphabet = "Qm7Zr2Kx9Lp4Tw8Vb3Nc6Hd1Fg5Js0Yt";
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[(i * 7 + 3) % alphabet.length];
  return out;
};

test("each credential shape is caught and redacted", () => {
  const samples: Array<[string, string]> = [
    ["private-key", j("-----BEGIN ", "RSA PRIVATE", " KEY-----")],
    ["aws-access-key", j("AK", "IA", "ABCDEFGHIJKLMNOP")],
    ["github-token", j("gh", "p_", noise(36))],
    ["github-pat", j("github", "_pat_", noise(82))],
    ["slack-token", j("xo", "xb-", "1234567890-abcdefghij")],
    ["sk-api-key", j("s", "k-ant-", noise(40))],
    ["google-api-key", j("AI", "za", noise(35))],
    ["stripe-live-key", j("sk", "_live_", noise(24))],
    ["jwt", j("ey", "J", noise(20), ".ey", "J", noise(20), ".", noise(20))],
    ["bearer-token", j("Authorization: Bear", "er ", noise(32))],
    ["url-credentials", j("https://deploy:", noise(14), "@git.example.com/repo.git")],
  ];
  for (const [rule, text] of samples) {
    const hits = scanText(`note\n${text}\n`);
    assert.equal(hits[0]?.rule, rule, text);
    assert.equal(hits[0]?.line, 2);
    assert.ok(!hits[0]?.excerpt.includes(text.slice(8)), "excerpt must be redacted");
  }
});

test("credential assignments need a real-looking value", () => {
  assert.equal(scanText(j("MATERIA_API_TO", "KEN=", noise(24)))[0]?.rule, "credential-assignment");
  assert.equal(scanText(j("db_pass", "word: ", noise(16)))[0]?.rule, "credential-assignment");
  for (const benign of [
    "MATERIA_API_TOKEN=<your token here>",
    "API_KEY=${API_KEY_FROM_ENV}",
    "password: changeme",
    "SECRET_KEY=xxxxxxxxxxxxxxxx",
    "set the *_TOKEN variables in your shell",
    "OBSIDIAN_PROJECTS_REMOTE=git@github.com:you/oso-projects.git",
    "  ClickUp token: ~/Library/Keys/clickup-api-token.txt (runtime only).",
    "API token: https://app.example.com/settings/tokens",
    "SSH_PRIVATE_KEY=/Users/me/.ssh/id_ed25519_deploy",
  ]) {
    assert.deepEqual(scanText(benign), [], benign);
  }
});

test("ordinary notes produce no hits", () => {
  const note = [
    "# materia-api - handoff",
    "- PR #328 merged to main (77fa452..cdb1cec)",
    "- sk-learn upgrade pending; see https://example.com/docs?page=2",
    "- run `git -C \"$OBSIDIAN_VAULT_PATH/Projects\" pull --ff-only`",
  ].join("\n");
  assert.deepEqual(scanText(note), []);
});

test("scanDiff reports only added lines, by file, with new-file line numbers", () => {
  const token = j("gh", "p_", noise(36));
  const diff = [
    "diff --git a/p/notes/a.md b/p/notes/a.md",
    "--- a/p/notes/a.md",
    "+++ b/p/notes/a.md",
    "@@ -3,0 +4,2 @@",
    "+fine line",
    `+token ${token}`,
    "diff --git a/p/old.md b/p/old.md",
    "--- a/p/old.md",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    `-removed ${token}`,
    "diff --git a/p/with space.md b/p/with space.md",
    "--- a/p/with space.md",
    "+++ b/p/with space.md",
    "@@ -0,0 +1 @@",
    "+nothing here",
  ].join("\n");
  const hits = scanDiff(diff);
  assert.deepEqual([...hits.keys()], ["p/notes/a.md"]);
  assert.equal(hits.get("p/notes/a.md")?.[0]?.line, 5);
});

test("git's C-quoted paths are unquoted, so a secret in an odd file name is still attributed", () => {
  assert.equal(unquoteGitPath('"b/a\\nb.md"'), "b/a\nb.md");
  assert.equal(unquoteGitPath('"b/c\\td.md"'), "b/c\td.md");
  assert.equal(unquoteGitPath('"b/\\303\\251.md"'), "b/\u00e9.md");
  assert.equal(unquoteGitPath("b/plain name.md"), "b/plain name.md");
  const token = j("gh", "p_", noise(36));
  const diff = ['+++ "b/x/line\\nbreak.md"', "@@ -0,0 +1 @@", `+${token}`].join("\n");
  assert.deepEqual([...scanDiff(diff).keys()], ["x/line\nbreak.md"]);
});

test("an astral character (two UTF-16 units) in a C-quoted path is kept whole", () => {
  assert.equal(unquoteGitPath('"b/x/😀\\nsecret.md"'), "b/x/😀\nsecret.md");
});

test("git's TAB after a name holding a space is dropped; the name's own spaces are kept", () => {
  const token = j("gh", "p_", noise(36));
  const diff = (header: string): string[] => [...scanDiff([header, "@@ -0,0 +1 @@", `+${token}`].join("\n")).keys()];
  assert.deepEqual(diff("+++ b/x/trailing \t"), ["x/trailing "]);
  assert.deepEqual(diff("+++ b/x/ leading.md\t"), ["x/ leading.md"]);
  assert.deepEqual(diff('+++ "b/x/a b\\n.md"\t'), ["x/a b\n.md"]);
});

test("the scanner stays linear on a 1 MB line and ignores identifiers notes are full of", () => {
  const samples = [
    "commit 0123456789abcdef0123456789abcdef01234567",
    "uuid 550e8400-e29b-41d4-a716-446655440000",
    `![image](data:image/png;base64,${"A".repeat(4000)})`,
    `https://example.test/callback?state=${"abcdef0123456789".repeat(20)}`,
    `integrity=sha512-${"AbCd0123".repeat(20)}`,
  ];
  assert.deepEqual(scanText(samples.join("\n")), []);
  const started = performance.now();
  assert.deepEqual(scanText("a".repeat(1024 * 1024)), []);
  assert.ok(performance.now() - started < 500, "a 1 MB line took over 500 ms");
});
