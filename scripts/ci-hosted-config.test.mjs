import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const workflowJobs = new Map([
  ["ci.yml", ["frontend", "desktop-visual", "rust", "rust-desktop", "hygiene"]],
  ["pr-metadata.yml", ["linked-issue"]],
]);

async function workflow(name) {
  return readFile(new URL(name, workflowsDirectory), "utf8");
}

function jobBlock(source, job) {
  const marker = `\n  ${job}:\n`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `workflow must define the ${job} job`);
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.match(/\n  [A-Za-z0-9_-]+:\n/);
  return nextJob ? remainder.slice(0, nextJob.index) : remainder;
}

test("no workflow selects a self-hosted runner", async () => {
  const names = (await readdir(workflowsDirectory)).filter((name) => name.endsWith(".yml"));
  assert.ok(names.length > 0, "the repository must define workflows");

  for (const name of names) {
    assert.doesNotMatch(await workflow(name), /self-hosted/,
      `${name} must not select a self-hosted runner`);
  }
});

test("every check runs on a standard GitHub-hosted runner", async () => {
  const ci = await workflow("ci.yml");
  const metadata = await workflow("pr-metadata.yml");
  const expected = [
    [ci, "frontend", "ubuntu-latest"],
    [ci, "desktop-visual", "macos-15"],
    [ci, "rust", "ubuntu-latest"],
    [ci, "rust-desktop", "macos-15"],
    [ci, "hygiene", "ubuntu-latest"],
    [metadata, "linked-issue", "ubuntu-latest"],
  ];

  for (const [source, job, runner] of expected) {
    assert.match(jobBlock(source, job), new RegExp(`runs-on: ${runner}\\n`),
      `${job} must run on ${runner}`);
  }

  const selectors = [...`${ci}\n${metadata}`.matchAll(/runs-on:\s*(\S+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(selectors)].sort(), ["macos-15", "ubuntu-latest"]);
});

test("checkouts drop persisted credentials and every job declares a timeout", async () => {
  for (const [name, jobs] of workflowJobs) {
    const source = await workflow(name);
    const checkouts = source.split("actions/checkout@v4").length - 1;
    const hardened = source.split("persist-credentials: false").length - 1;
    assert.equal(hardened, checkouts, `${name} must disable persisted credentials on every checkout`);

    for (const job of jobs) {
      assert.match(jobBlock(source, job), /timeout-minutes: \d+/,
        `${name} job ${job} must declare an explicit timeout`);
    }
  }
});

test("workflows declare minimal read-only permissions", async () => {
  const ci = await workflow("ci.yml");
  const metadata = await workflow("pr-metadata.yml");

  assert.match(ci, /^permissions:\n  contents: read\n/m);
  assert.match(metadata, /^permissions:\n  contents: read\n  issues: read\n/m);
  assert.doesNotMatch(`${ci}\n${metadata}`, /(?:contents|issues|pull-requests|actions):\s*write/);
});

test("hosted caches replace the retired runner-local cache", async () => {
  const ci = await workflow("ci.yml");

  assert.doesNotMatch(ci, /runner-local|Library\/Caches|CARGO_TARGET_DIR/);
  assert.match(jobBlock(ci, "frontend"), /cache: pnpm/);
  assert.match(jobBlock(ci, "desktop-visual"), /cache: pnpm/);
  for (const job of ["rust", "rust-desktop"]) {
    assert.match(jobBlock(ci, job), /Swatinem\/rust-cache@[0-9a-f]{40}\b/,
      `${job} must use the pinned hosted Rust cache`);
  }
});

test("visual checks keep Chromium-only commands and dynamic loopback ports", async () => {
  const ci = await workflow("ci.yml");
  const commands = ci.split("\n").filter((line) => /(?:test:visual|playwright test)/.test(line));

  assert.ok(commands.some((line) => line.includes("playwright.production.config.ts")),
    "CI must exercise the complete production entrypoints");
  assert.ok(commands.some((line) => line.includes("playwright.trajectory.config.ts")),
    "CI must exercise the minified transcript trajectories");
  for (const command of commands) {
    assert.match(command, /--project chromium(?:\s|$)/,
      "the hosted visual job must select Chromium explicitly");
  }
  assert.match(ci, /KORDI_PRODUCTION_TEST_PORT="\$\(node -e/);
  assert.match(ci, /KORDI_TRAJECTORY_TEST_PORT="\$\(node -e/);
});

test("portable Rust checks stay on Ubuntu and Darwin-only desktop checks on macOS", async () => {
  const ci = await workflow("ci.yml");
  const rust = jobBlock(ci, "rust");

  assert.match(rust, /cargo clippy --workspace --exclude kordi-desktop --all-targets -- -D warnings/);
  assert.doesNotMatch(rust, /prepare-tauri-sidecar-placeholders\.sh/);
  assert.doesNotMatch(rust, /kordi-desktop --no-default-features/);
  assert.match(rust, /bash scripts\/test-cloud-migrations\.sh/);

  const desktop = jobBlock(ci, "rust-desktop");
  const sidecar = desktop.indexOf("bash scripts/prepare-tauri-sidecar-placeholders.sh");
  const clippy = desktop.indexOf("cargo clippy -p kordi-desktop");
  assert.ok(sidecar !== -1 && clippy !== -1 && sidecar < clippy,
    "sidecar placeholders must be prepared before the desktop crate is checked");
  assert.match(desktop, /cargo test -p kordi-desktop --no-default-features/);
});

test("the hygiene privacy baseline fails closed when the denylist is unavailable", async () => {
  const hygiene = jobBlock(await workflow("ci.yml"), "hygiene");

  assert.match(hygiene, /node scripts\/repository-privacy-guard\.mjs --comparison "\$comparison"/);
  assert.match(hygiene, /KORDI_PRIVACY_DENYLIST: \$\{\{ secrets\.KORDI_PRIVACY_DENYLIST \}\}/);
  assert.match(hygiene, /if \[ -z "\$\{KORDI_PRIVACY_DENYLIST:-\}" \]/);
  assert.match(hygiene, /exit 1/);
});

test("the retired self-hosted runner artifacts are absent", () => {
  const removed = [
    "../deploy/ci/io.kordi.github-actions-runner.plist",
    "../scripts/install-macos-self-hosted-runner.sh",
    "../docs/self-hosted-ci.md",
  ];

  for (const path of removed) {
    assert.equal(existsSync(fileURLToPath(new URL(path, import.meta.url))), false,
      `${path} must be removed with the persistent runner`);
  }
});
