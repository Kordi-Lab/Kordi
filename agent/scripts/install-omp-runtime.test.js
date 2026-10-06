"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { installRuntime, verify, names } = require("./install-omp-runtime");
const version = require("../package.json").ompRuntimeVersion;

test("CLI installer verifies the compiled worker and addon, and preserves a valid installation", {
  skip: !process.env.KORDI_OMP_TEST_ASSETS,
}, async () => {
  const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kordi-omp-install-test-"));
  const asset = names(triple);
  let downloads = 0;
  const options = { target: triple, version, directory, releaseBase: "https://example.com/synthetic-release",
    download: async (url, destination) => { downloads++; fs.copyFileSync(path.join(process.env.KORDI_OMP_TEST_ASSETS, path.basename(url)), destination); },
  };
  try {
    await installRuntime(options);
    assert.equal(downloads, 2);
    assert.equal(verify(directory, triple, version), true);
    assert.equal(verify(directory, triple, "invalid-version"), false);
    await installRuntime(options);
    assert.equal(downloads, 2, "A verified installation requires no download");
    fs.unlinkSync(path.join(directory, asset.addon));
    assert.equal(verify(directory, triple, version), false);
    await assert.rejects(installRuntime({ ...options, download: async () => { throw Error("synthetic outage"); } }));
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith(".omp-install-")), false);
    await installRuntime(options);
    assert.equal(verify(directory, triple, version), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
