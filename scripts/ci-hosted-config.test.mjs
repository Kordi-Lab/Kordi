import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const requireFromDesktop = createRequire(new URL("../app/desktop/package.json", import.meta.url));
const YAML = requireFromDesktop("yaml");

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

const hostedRunners = new Set(["ubuntu-latest", "macos-15", "macos-26", "xcode-27"]);
const expectedJobs = [
  ["ci-frontend.yml", "frontend", "ubuntu-latest"],
  ["ci-hygiene.yml", "hygiene", "ubuntu-latest"],
  ["ci-rust.yml", "server", "ubuntu-latest"],
  ["ci-rust.yml", "migrations", "ubuntu-latest"],
  ["ci-visual.yml", "visual", "macos-15"],
  ["ci-visual.yml", "browser", "macos-15"],
  ["ci-platforms.yml", "desktop", "macos-15"],
  ["ci-platforms.yml", "ios", "xcode-27"],
  ["pr-metadata.yml", "linked-issue", "ubuntu-latest"],
];
const checkWorkflows = [
  "blocking-ci.yml",
  "ci-frontend.yml",
  "ci-hygiene.yml",
  "ci-platforms.yml",
  "ci-rust.yml",
  "ci-visual.yml",
  "postmerge-ci.yml",
  "pr-metadata.yml",
];

async function workflowSources() {
  const names = (await readdir(workflowsDirectory)).filter((name) => name.endsWith(".yml"));
  assert.ok(names.length > 0, "the repository must define workflows");
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(new URL(name, workflowsDirectory), "utf8")]),
  );
  return new Map(entries);
}

async function parsedWorkflows() {
  const sources = await workflowSources();
  return new Map(
    [...sources].map(([name, source]) => [name, { source, document: YAML.parse(source) }]),
  );
}

function jobSteps(job) {
  return job.steps ?? [];
}

test("every workflow file parses as YAML with declared jobs", async () => {
  for (const [name, { document }] of await parsedWorkflows()) {
    assert.ok(document && typeof document === "object", `${name} must parse as a YAML mapping`);
    assert.ok(document.jobs && Object.keys(document.jobs).length > 0, `${name} must declare jobs`);
  }
});

test("no workflow selects a self-hosted runner", async () => {
  for (const [name, source] of await workflowSources()) {
    assert.doesNotMatch(source, /self-hosted/, `${name} must not select a self-hosted runner`);
  }
});

test("every check runs on a standard GitHub-hosted runner", async () => {
  const workflows = await parsedWorkflows();

  for (const [name, jobId, runner] of expectedJobs) {
    const job = workflows.get(name)?.document?.jobs?.[jobId];
    assert.ok(job, `${name} must define the ${jobId} job`);
    assert.equal(job["runs-on"], runner, `${jobId} must run on ${runner}`);
  }

  for (const [name, { document }] of workflows) {
    for (const [jobId, job] of Object.entries(document.jobs)) {
      if (job.uses) {
        continue;
      }
      const selector = job["runs-on"];
      if (selector === "${{ matrix.os }}") {
        const values = job.strategy?.matrix?.os ?? [];
        assert.ok(
          values.length > 0 && values.every((value) => hostedRunners.has(value)),
          `${name} job ${jobId} must only matrix over hosted runners`,
        );
      } else {
        assert.ok(hostedRunners.has(selector),
          `${name} job ${jobId} must use a hosted runner, found ${selector}`);
      }
    }
  }
});

test("checkouts drop persisted credentials and executable jobs declare a timeout", async () => {
  const workflows = await parsedWorkflows();

  for (const name of checkWorkflows) {
    const { source } = workflows.get(name);
    const checkouts = source.split("actions/checkout@").length - 1;
    const hardened = source.split("persist-credentials: false").length - 1;
    assert.equal(hardened, checkouts, `${name} must disable persisted credentials on every checkout`);
  }

  for (const [name, { document }] of workflows) {
    for (const [jobId, job] of Object.entries(document.jobs)) {
      if (job.uses) {
        continue;
      }
      assert.ok(
        Number.isInteger(job["timeout-minutes"]) && job["timeout-minutes"] > 0,
        `${name} job ${jobId} must declare an explicit timeout`,
      );
    }
  }
});

test("check workflows declare minimal read-only permissions", async () => {
  const workflows = await parsedWorkflows();

  for (const name of checkWorkflows) {
    const permissions = workflows.get(name)?.document?.permissions;
    assert.equal(permissions?.contents, "read", `${name} must declare contents: read`);
    assert.doesNotMatch(JSON.stringify(permissions), /write/,
      `${name} must not request write permissions`);
  }
});

test("hosted caches replace the retired runner-local cache", async () => {
  const workflows = await parsedWorkflows();
  const rustCache = /Swatinem\/rust-cache@[0-9a-f]{40}\b/;
  const rustJobs = [
    ["ci-rust.yml", "server"],
    ["ci-rust.yml", "migrations"],
    ["ci-platforms.yml", "desktop"],
    ["postmerge-ci.yml", "workspace"],
    ["postmerge-ci.yml", "build-smoke"],
  ];

  for (const [name, { source, document }] of workflows) {
    assert.doesNotMatch(source, /runner-local|Library\/Caches|CARGO_TARGET_DIR/,
      `${name} must not rely on runner-local caches`);

    for (const [jobId, job] of Object.entries(document.jobs)) {
      const installs = jobSteps(job).some((step) => /pnpm install/.test(step.run ?? ""));
      const cached = jobSteps(job).some(
        (step) => step.uses?.startsWith("actions/setup-node@") && step.with?.cache === "pnpm",
      );
      if (installs) {
        assert.ok(cached, `${name} job ${jobId} must cache pnpm through actions/setup-node`);
      }
    }
  }

  for (const [name, jobId] of rustJobs) {
    const job = workflows.get(name).document.jobs[jobId];
    assert.ok(
      jobSteps(job).some((step) => rustCache.test(step.uses ?? "")),
      `${name} job ${jobId} must use the pinned hosted Rust cache`,
    );
  }
});

test("visual baselines use Chromium and transcript history also runs in WebKit", async () => {
  const workflows = await parsedWorkflows();
  const visualWorkflow = workflows.get("ci-visual.yml").source;
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const visual = packageJson.scripts["check:visual"];
  const browser = packageJson.scripts["check:browser"];

  assert.match(visualWorkflow, /pnpm --dir app\/desktop exec playwright install chromium/);
  assert.match(visual, /test:visual --project chromium/);
  assert.match(browser, /playwright\.production\.config\.ts --project chromium/);
  assert.match(browser, /playwright\.trajectory\.config\.ts --project chromium/);
  assert.match(browser, /playwright\.history\.config\.ts(?:\s*&&|$)/);
  assert.match(visualWorkflow, /pnpm --dir app\/desktop exec playwright install webkit/);
  const visualJob = workflows.get("ci-visual.yml").document.jobs.visual;
  assert.doesNotMatch(JSON.stringify(visualJob), /firefox|webkit/i, "screenshot baselines stay Chromium-only");
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
