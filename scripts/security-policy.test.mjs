import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const repoFile = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFile(repoFile(path), 'utf8');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ADVISORY_FORM = 'https://github.com/Kordi-Lab/Kordi/security/advisories/new';
const SECURITY_TXT_PATH = '/.well-known/security.txt';

async function securityTxtFields() {
  const source = await read('bridges/cloud-server/src/security_txt.rs');
  const match = /pub const BODY: &str = "\\\n([\s\S]*?)";/.exec(source);
  assert.ok(match, 'security_txt.rs must define BODY as a string literal');
  return match[1]
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf(': ');
      assert.ok(separator > 0, `malformed security.txt line: ${line}`);
      return { name: line.slice(0, separator).toLowerCase(), value: line.slice(separator + 2) };
    });
}

function values(fields, name) {
  return fields.filter((field) => field.name === name).map((field) => field.value);
}

async function productSiteHosts() {
  const caddyfile = await read('bridges/cloud-server/deploy/Caddyfile.snippet');
  const hosts = [];
  for (const match of caddyfile.matchAll(/^([^\s#(][^{\n]*?)\s*\{\n\s*import kordi_product_site\n\}/gm)) {
    for (const address of match[1].split(/[\s,]+/)) {
      // Port-only addresses such as the private load-balancer origin are not public hosts.
      if (address && !address.startsWith(':')) hosts.push(address);
    }
  }
  return hosts;
}

test('security.txt lists every public product host as a canonical URI', async () => {
  const hosts = await productSiteHosts();
  assert.ok(hosts.includes('kordi.ai'), `expected kordi.ai among ${JSON.stringify(hosts)}`);

  const canonical = values(await securityTxtFields(), 'canonical');
  assert.deepEqual(
    [...canonical].sort(),
    hosts.map((host) => `https://${host}${SECURITY_TXT_PATH}`).sort(),
  );
});

test('security.txt, SECURITY.md, and the issue chooser share one private reporting channel', async () => {
  const fields = await securityTxtFields();
  assert.deepEqual(values(fields, 'contact'), [ADVISORY_FORM]);

  const policy = await read('SECURITY.md');
  assert.ok(policy.includes(ADVISORY_FORM), 'SECURITY.md must link the private advisory form');
  assert.ok(policy.includes(`https://kordi.ai${SECURITY_TXT_PATH}`));

  const chooser = await read('.github/ISSUE_TEMPLATE/config.yml');
  assert.match(chooser, /^blank_issues_enabled: false$/m);
  const firstLink = /contact_links:\n\s+- name: ([^\n]+)\n\s+url: ([^\n]+)\n/.exec(chooser);
  assert.ok(firstLink, 'config.yml must define contact links');
  assert.equal(firstLink[1].trim(), 'Report a security issue privately');
  assert.equal(firstLink[2].trim(), ADVISORY_FORM);
  assert.ok(policy.includes(`**${firstLink[1].trim()}**`), 'SECURITY.md must name the issue chooser link');
});

test('security.txt policy points to the repository security policy', async () => {
  const [policyUrl] = values(await securityTxtFields(), 'policy');
  assert.equal(policyUrl, 'https://github.com/Kordi-Lab/Kordi/blob/main/SECURITY.md');
  await access(repoFile('SECURITY.md'));

  for (const path of ['README.md', 'CONTRIBUTING.md']) {
    assert.match(await read(path), /\]\(SECURITY\.md\)|href="SECURITY\.md"/, `${path} must link SECURITY.md`);
  }
});

test('SECURITY.md fallback names an existing issue template and triage option', async () => {
  const policy = await read('SECURITY.md');
  const fallback = /If the private form is unavailable to you, open a \*\*([^*]+)\*\* issue[\s\S]*?choose `([^`]+)` for \*\*([^*]+)\*\*/.exec(policy);
  assert.ok(fallback, 'SECURITY.md must describe the fallback with a named template');
  const [, templateName, option, fieldLabel] = fallback;

  const template = await read('.github/ISSUE_TEMPLATE/bug_report.yml');
  assert.match(template, new RegExp(`^name: ${escapeRegExp(templateName)}$`, 'm'));
  assert.match(
    template,
    new RegExp(`label: ${escapeRegExp(fieldLabel)}\\n[\\s\\S]*?- ${escapeRegExp(option)}\\n`),
  );
  assert.ok(!/open a public issue that asks/i.test(policy));
});
