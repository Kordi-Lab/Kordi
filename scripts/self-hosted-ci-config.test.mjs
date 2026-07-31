import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runnerSelector =
  "runs-on: [self-hosted, macOS, ARM64, kordi-ci]";

async function workflow(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("every repository check uses the isolated Kordi runner", async () => {
  const ci = await workflow("../.github/workflows/ci.yml");
  const metadata = await workflow("../.github/workflows/pr-metadata.yml");
  const workflows = `${ci}\n${metadata}`;

  assert.doesNotMatch(workflows, /runs-on:\s*(?:ubuntu|macos)-latest/);
  assert.equal(
    workflows.split(runnerSelector).length - 1,
    5,
    "all five current CI jobs must retain the isolated runner selector",
  );
});

test("self-hosted checks do not depend on GitHub-hosted caches", async () => {
  const ci = await workflow("../.github/workflows/ci.yml");

  assert.doesNotMatch(ci, /^\s*cache:\s*pnpm\s*$/m);
  assert.doesNotMatch(ci, /Swatinem\/rust-cache/);
  assert.match(ci, /Configure runner-local Rust build cache/);
});

test("the macOS runner installer stays syntax-valid and account-isolated", async () => {
  const installerUrl = new URL("./install-macos-self-hosted-runner.sh", import.meta.url);
  const plist = await workflow("../deploy/ci/io.kordi.github-actions-runner.plist");

  execFileSync("/bin/bash", ["-n", fileURLToPath(installerUrl)]);
  assert.match(plist, /<key>UserName<\/key>\s*<string>kordi-ci<\/string>/);
  assert.match(plist, /<key>GroupName<\/key>\s*<string>kordi-ci<\/string>/);
});
