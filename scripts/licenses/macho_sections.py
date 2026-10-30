"""Hash loadable Mach-O sections without code-signature or load-command bytes."""
import hashlib
import struct

def section_digest(data, cpu=0x0100000c):
    if len(data) < 32:
        raise ValueError('Truncated native binary')
    if data[:4] == bytes.fromhex('cafebabe'):
        count = struct.unpack_from('>I', data, 4)[0]
        if count > 16:
            raise ValueError('Unexpected universal binary')
        for i in range(count):
            cputype, _, offset, size, _ = struct.unpack_from('>IIIII', data, 8 + i * 20)
            if cputype == cpu:
                if offset + size > len(data):
                    raise ValueError('Truncated universal slice')
                return section_digest(data[offset:offset + size], cpu)
        raise ValueError('Required architecture is absent')
    if data[:4] != bytes.fromhex('cffaedfe'):
        raise ValueError('Expected a little-endian 64-bit Mach-O binary')
    _, cputype, _, _, count, command_bytes, _, _ = struct.unpack_from('<8I', data)
    if cputype != cpu or count > 1024 or 32 + command_bytes > len(data):
        raise ValueError('Invalid native binary header')
    offset = 32
    sections = []
    for _ in range(count):
        command, length = struct.unpack_from('<II', data, offset)
        if length < 8 or offset + length > 32 + command_bytes:
            raise ValueError('Invalid Mach-O command')
        if command == 0x19:
            nsects = struct.unpack_from('<I', data, offset + 64)[0]
            if 72 + nsects * 80 > length:
                raise ValueError('Invalid section table')
            for i in range(nsects):
                pos = offset + 72 + i * 80
                name, segment, _, size, location, _, _, _, flags, _, _, _ = struct.unpack_from('<16s16sQQ8I', data, pos)
                if flags & 0xff in {1, 12, 18}:
                    continue
                if location + size > len(data):
                    raise ValueError('Truncated native section')
                sections.append((segment.rstrip(b'\0') + b'/' + name.rstrip(b'\0'), data[location:location + size]))
        offset += length
    if not any(name.endswith(b'/__text') for name, _ in sections):
        raise ValueError('Native executable code is absent')
    result = hashlib.sha256()
    for name, content in sorted(sections):
        result.update(name + b'\0' + hashlib.sha256(content).digest())
    return result.hexdigest()
