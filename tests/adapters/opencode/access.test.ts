import { test } from "node:test";
import assert from "node:assert/strict";
import { expandHome, wildcardMatch, withGrant } from "../../../adapters/opencode/access.ts";

// Expectations come from OpenCode 1.18.32 (its source, quoted in the plan, and the live runs of
// spec 4.4), never from this copy.
const V = "/Users/a/Documents/Da Vinci";
const P = `${V}/Projects/kabin-api`;

test("the matcher: the measured cases of spec 4.4", () => {
  assert.equal(wildcardMatch(`${P}/*`, `${P}/**`), true, "the project root's ask");
  assert.equal(wildcardMatch(`${P}/remember/journal/*`, `${P}/**`), true, "every depth");
  assert.equal(wildcardMatch(`${V}/Projects/kabin-api-other/*`, `${P}/**`), false, "a same-prefix sibling");
  assert.equal(wildcardMatch(`${V}/Articles/*`, `${P}/**`), false, "the rest of the vault");
  assert.equal(wildcardMatch(`/private/tmp/vlink/Projects/kabin-api/*`, `/private/tmp/real/Projects/kabin-api/**`), false, "strings, never resolved");
});

test("the matcher: its source's details", () => {
  assert.equal(wildcardMatch("a\\b/c", "a/b/*"), true, "backslashes read as slashes on the path side");
  assert.equal(wildcardMatch("a/b/c", "a\\b\\*"), true, "and on the pattern side");
  assert.equal(wildcardMatch("x(1)+[y]/z", "x(1)+[y]/*"), true, "regex characters are literal");
  assert.equal(wildcardMatch("ab", "a?"), true, "? is one character");
  assert.equal(wildcardMatch("abc", "a?"), false);
  assert.equal(wildcardMatch("a\nb", "a*"), true, "* crosses a newline (the s flag)");
  assert.equal(wildcardMatch("ls", "ls *"), true, "a trailing ' *' is optional");
  assert.equal(wildcardMatch("ls -la", "ls *"), true);
  assert.equal(wildcardMatch("/A/b", "/a/*"), false, "case-sensitive");
  assert.equal(wildcardMatch("x/a/b", "a/*"), false, "the whole string");
});

test("home expansion: OpenCode's four prefixes, and nothing else", () => {
  assert.equal(expandHome("~/Documents/**", "/Users/a"), "/Users/a/Documents/**");
  assert.equal(expandHome("~", "/Users/a"), "/Users/a");
  assert.equal(expandHome("$HOME/Documents/**", "/Users/a"), "/Users/a/Documents/**");
  assert.equal(expandHome("$HOMELESS/x", "/Users/a"), "/Users/aLESS/x", "any $HOME prefix, as OpenCode does");
  assert.equal(expandHome("${HOME}/x", "/Users/a"), "${HOME}/x");
  assert.equal(expandHome("~user/x", "/Users/a"), "~user/x");
});

test("the grant goes after the user's blanket and before every other user rule, in a new object", () => {
  const user = { "*": "ask", [`${V}/Projects/**`]: "deny", "/srv/**": "allow" };
  const built = withGrant(user, `${P}/**`);
  assert.deepEqual(Object.entries(built), [["*", "ask"], [`${P}/**`, "allow"], [`${V}/Projects/**`, "deny"], ["/srv/**", "allow"]]);
  assert.notEqual(built, user);
  assert.deepEqual(Object.keys(user), ["*", `${V}/Projects/**`, "/srv/**"], "the user's object is untouched");
  assert.deepEqual(Object.entries(withGrant({}, `${P}/**`)), [[`${P}/**`, "allow"]], "no setting: the grant alone");
});
