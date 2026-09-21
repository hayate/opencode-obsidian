import { test } from "node:test";
import assert from "node:assert/strict";
import { githubHttpsUrl, remoteVisibility } from "../../core/sync/privacy.ts";

test("githubHttpsUrl maps every GitHub remote form to its anonymous HTTPS URL", () => {
  for (const remote of [
    "git@github.com:hayate/oso-projects.git",
    "ssh://git@github.com/hayate/oso-projects",
    "https://github.com/hayate/oso-projects.git",
  ]) {
    assert.equal(githubHttpsUrl(remote), "https://github.com/hayate/oso-projects.git", remote);
  }
  assert.equal(githubHttpsUrl("git@gitlab.com:a/b.git"), null);
  assert.equal(githubHttpsUrl("/srv/git/projects.git"), null);
});

test("a non-GitHub remote is not probed", async () => {
  assert.equal((await remoteVisibility("/srv/git/projects.git")).visibility, "not-github");
});

// Network probe P6. Opt in: SRO_NETWORK_TESTS=1 npm test
test("public and not-public GitHub repositories are told apart (network)", { skip: process.env.SRO_NETWORK_TESTS !== "1" }, async () => {
  assert.equal((await remoteVisibility("git@github.com:octocat/Hello-World.git")).visibility, "public");
  assert.equal((await remoteVisibility("git@github.com:hayate/does-not-exist-sro-probe.git")).visibility, "not-public");
});
