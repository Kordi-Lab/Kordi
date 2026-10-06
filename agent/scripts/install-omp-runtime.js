"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function names(target) {
  const executable = os.platform() === "win32" ? "kordi-omp.exe" : "kordi-omp";
  const addon = `pi_natives.${os.platform()}-${os.arch()}.node`;
  return { executable, addon, workerAsset: `kordi-omp-${target}${os.platform() === "win32" ? ".exe" : ""}`, addonAsset: `${addon}-${target}` };
}

function verify(directory, target, version) {
  const { executable, addon } = names(target);
  try {
    if (![executable, addon].every(name => fs.lstatSync(path.join(directory, name)).isFile())) return false;
    const options = { encoding: "utf8", input: "", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] };
    const binary = path.join(directory, executable);
    if (execFileSync(binary, ["--version"], options).trim() !== `kordi-omp ${version}`) return false;
    return execFileSync(binary, [], options).trim() === '{"schemaVersion":1,"type":"ready"}';
  } catch { return false; }
}

async function installRuntime({ target, version, directory, releaseBase, download }) {
  if (verify(directory, target, version)) return;
  fs.mkdirSync(directory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(directory, ".omp-install-"));
  const { executable, addon, workerAsset, addonAsset } = names(target);
  try {
    await download(`${releaseBase}/${workerAsset}`, path.join(staging, executable), 0);
    await download(`${releaseBase}/${addonAsset}`, path.join(staging, addon), 0);
    if (os.platform() !== "win32") fs.chmodSync(path.join(staging, executable), 0o755);
    if (!verify(staging, target, version)) throw new Error("The downloaded OMP worker and native addon did not pass verification.");
    // Install the addon first; a worker is never exposed without its dependency.
    for (const name of [addon, executable]) fs.renameSync(path.join(staging, name), path.join(directory, name));
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

module.exports = { installRuntime, verify, names };
