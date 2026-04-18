import fs from 'node:fs';
import path from 'node:path';

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node scripts/brand-public-beta.mjs <target-directory>');
  process.exit(1);
}

const packageName = process.env.PUBLIC_PACKAGE_NAME ?? 'bridges';
const version = process.env.PUBLIC_VERSION ?? '0.0.1-beta';
const productName = process.env.PUBLIC_PRODUCT_NAME ?? 'bridges';
const readmeTitle = process.env.PUBLIC_README_TITLE ?? productName;
const repoUrl = process.env.PUBLIC_REPO_URL ?? 'https://github.com/shuyhere/Bridges.git';
const cloneDir = process.env.PUBLIC_CLONE_DIR ?? 'bridges';
const cliName = process.env.PUBLIC_CLI_NAME ?? packageName;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceAll(text) {
  return text
    .replace(/npm install -g bridges(?=@|\s|$)/g, `npm install -g ${packageName}`)
    .replace(/npm install -g bridges-bridge(?=@|\s|$)/g, `npm install -g ${packageName}`)
    .replace(/\$\(npm root -g\)\/bridges(?!-)\//g, `$(npm root -g)/${packageName}/`)
    .replace(/https:\/\/github\.com\/shuyhere\/Bridges\.git/g, repoUrl)
    .replace(/https:\/\/github\.com\/shuyhere\/bridges\.git/g, repoUrl)
    .replace(/https:\/\/github\.com\/shuyhere\/bridges\.git/g, repoUrl)
    .replace(/https:\/\/github\.com\/shuyhere\/bridges/g, repoUrl.replace(/\.git$/, ''))
    .replaceAll(`git clone ${repoUrl}`, `git clone ${repoUrl} ${cloneDir}`)
    .replaceAll(`git clone ${repoUrl} ${cloneDir} ~/bridges`, `git clone ${repoUrl} ~/bridges`)
    .replace(/cd bridges\b/g, `cd ${cloneDir}`)
    .replace(/cd bridges\b/g, `cd ${cloneDir}`)
    .replace(/cd bridges\b/g, `cd ${cloneDir}`)
    .replace(/cd bridges\b/g, `cd ${cloneDir}`)
    .replace(/\.\/target\/release\/bridges(?!-)\b/g, `./target/release/${cliName}`)
    .replace(/target\/release\/bridges(?!-)\b/g, `target/release/${cliName}`)
    .replace(/\\release\\bridges(?!-)\.exe/g, `\\release\\${cliName}.exe`)
    .replace(/~\/\.local\/bin\/bridges(?!-)\b/g, `~/.local/bin/${cliName}`)
    .replace(/Usage: bridges\b/g, `Usage: ${cliName}`)
    .replace(/bridges-linux-/g, `${cliName}-linux-`)
    .replace(/bridges-darwin-/g, `${cliName}-darwin-`)
    .replace(/bridges-win32-/g, `${cliName}-win32-`)
    .replace(/\bbridges (?=(setup|create|invite|join|members|ask|debate|broadcast|publish|daemon|service|status|sync|register|serve|contact|session|issue|milestone|pr|watch|ping|init|--version))/g, `${cliName} `)
    .replace(/name = "bridges"/g, `name = "${cliName}"`);
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }

    if (!/\.(md|tsx?|jsx?|json|mjs|cjs|rs|toml|ya?ml|sh)$/.test(entry.name)) {
      continue;
    }

    const original = fs.readFileSync(fullPath, 'utf8');
    let updated = replaceAll(original);

    const relativePath = path.relative(targetDir, fullPath);

    if (relativePath === 'README.md') {
      updated = updated.replace(/^# Bridges$/m, `# ${readmeTitle}`);
      updated = updated.replace(
        /^Bridges is a self-hostable collaboration layer for humans and local AI agents\./m,
        `${productName} is the public self-hosted beta distribution of Bridges for local group testing.`
      );
      updated = updated.replace(
        /^Bridges is the core network component for bridging people, agents, and services\./m,
        `${productName} is the core network component for bridging people, agents, and services.`
      );
      updated = updated.replace(
        /^Bridges is the missing network layer\./m,
        `${productName} is the missing network layer.`
      );
      if (!updated.includes(`CLI command is \`${cliName}\``)) {
        updated = updated.replace(
          new RegExp(`${productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is the public self-hosted beta distribution of Bridges for local group testing\\.\\n`),
          `${productName} is the public self-hosted beta distribution of Bridges for local group testing.\n\n> npm package: \`${packageName}\`  \n> CLI command is \`${cliName}\`\n`
        );
      }
    }

    if (relativePath === path.join('docs', 'self-host-guide.md')) {
      updated = updated.replace(/^# Bridges Self-Host Guide$/m, `# ${productName} Self-Host Guide`);
      updated = updated.replace(
        /^This guide is for beta users who want to run a local or self-hosted Bridges deployment for their own group\./m,
        `This guide is for beta users who want to run a local or self-hosted ${productName} deployment for their own group.`
      );
    }

    if (updated !== original) {
      fs.writeFileSync(fullPath, updated);
    }
  }
}

const packageJsonPath = path.join(targetDir, 'package.json');
const packageLockPath = path.join(targetDir, 'package-lock.json');
const cliCargoTomlPath = path.join(targetDir, 'cli', 'Cargo.toml');

if (fs.existsSync(packageJsonPath)) {
  const pkg = readJson(packageJsonPath);
  pkg.name = packageName;
  pkg.version = version;
  pkg.description = process.env.PUBLIC_PACKAGE_DESCRIPTION ?? 'Core network component for agent identity, coordination, secure communication, membership, sync, and local bridge gateways';
  pkg.bin = { [cliName]: Object.values(pkg.bin ?? { [cliName]: './bin/bridges.js' })[0] ?? './bin/bridges.js' };
  if (pkg.repository?.url) {
    pkg.repository.url = repoUrl;
  }
  writeJson(packageJsonPath, pkg);
}

if (fs.existsSync(packageLockPath)) {
  const lock = readJson(packageLockPath);
  lock.name = packageName;
  lock.version = version;
  if (lock.packages?.['']) {
    lock.packages[''].name = packageName;
    lock.packages[''].version = version;
  }
  writeJson(packageLockPath, lock);
}

if (fs.existsSync(cliCargoTomlPath)) {
  const cargoToml = fs.readFileSync(cliCargoTomlPath, 'utf8');
  const updatedCargoToml = cargoToml
    .replace(/^(name\s*=\s*")[^"]+("\s*)$/m, `$1${cliName}$2`)
    .replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${version}$2`);
  if (updatedCargoToml !== cargoToml) {
    fs.writeFileSync(cliCargoTomlPath, updatedCargoToml);
  }
}

walk(targetDir);

console.log(`Branded public snapshot:`);
console.log(`  package: ${packageName}`);
console.log(`  command: ${cliName}`);
console.log(`  version: ${version}`);
console.log(`  readme:  ${readmeTitle}`);
