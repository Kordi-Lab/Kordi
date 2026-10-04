import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function section(markdown, heading) {
  return markdown.split(/^## /m).find((part) => part.startsWith(heading)) ?? '';
}

function tableRow(markdown, name) {
  return markdown.split('\n').find((line) => line.startsWith(`| ${name} |`)) ?? '';
}

test('the deletion register names abuse report copies that outlive deletion', async () => {
  const [register, reports] = await Promise.all([
    read('docs/data-deletion.md'),
    read('docs/trust-and-safety/abuse-reports.md'),
  ]);
  const kept = section(register, 'What is kept and for how long');

  const abuseReports = tableRow(kept, 'Abuse reports');
  assert.match(abuseReports, /SHA-256/);
  assert.match(abuseReports, /deletes it for everyone/);
  assert.match(abuseReports, /180 days/);
  assert.match(abuseReports, /90 days after closing/);
  assert.match(abuseReports, /\(trust-and-safety\/abuse-reports\.md#retention\)/);
  assert.match(tableRow(kept, 'Files'), /abuse report[^|]*hash included/i);
  assert.match(tableRow(kept, 'Not covered'), /Abuse reports that include the message/);

  const retention = section(reports, 'Retention');
  assert.match(retention, /deletes it for\s+everyone/);
  assert.match(retention, /\(\.\.\/data-deletion\.md#what-is-kept-and-for-how-long\)/);
});
