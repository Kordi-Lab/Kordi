import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('native section identity ignores signature bytes but detects executable changes', () => {
  const result = spawnSync('python3', ['-B', '-c', `
import struct,sys
sys.path.insert(0,'scripts/licenses')
from macho_sections import section_digest
payload=b'public-code'
header=struct.pack('<8I',0xfeedfacf,0x100000c,0,6,1,152,0,0)
segment=struct.pack('<II16sQQQQIIII',0x19,152,b'__TEXT',0,4096,0,184+len(payload),7,5,1,0)
section=struct.pack('<16s16sQQ8I',b'__text',b'__TEXT',0,len(payload),184,0,0,0,0,0,0,0)
binary=header+segment+section+payload
assert section_digest(binary)==section_digest(binary+b'synthetic-signature')
assert section_digest(binary)!=section_digest(binary[:-1]+b'X')
fat=struct.pack('>II',0xcafebabe,1)+struct.pack('>IIIII',0x100000c,0,32,len(binary),0)+b'\\0'*4+binary
assert section_digest(fat)==section_digest(binary)
try: section_digest(binary[:40])
except (ValueError,struct.error): pass
else: raise AssertionError('truncated binary accepted')
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
