import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { builtInExclusion } from '../filtering/path-exclusions.js';

export const SOURCE_LIMIT = 1024 * 1024 * 1024;
export const ARCHIVE_LIMIT = SOURCE_LIMIT + 1024 * 1024;
type Entry = {
  name: string;
  bytes: number;
  packed: number;
  offset: number;
  method: number;
  crc: number;
  executable: boolean;
};
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function safeName(name: string): void {
  if (!name || name.length > 1024 || /[\\:\u0000-\u001f\u007f]/u.test(name) || name.startsWith('/'))
    throw new Error('The source archive contains an unsafe path.');
  const parts = name.replace(/\/$/, '').split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error('The source archive contains an unsafe path.');
}

/** Validate the central directory before extracting; never trust ZIP names, modes or sizes. */
export async function extractSource(
  archive: string,
  directory: string,
  githubRoot = false,
): Promise<{ files: number; bytes: number }> {
  const handle = await fs.open(archive, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size < 22 || size > ARCHIVE_LIMIT)
      throw new Error('Source archive exceeds the download limit or is invalid.');
    async function read(offset: number, length: number): Promise<Buffer> {
      if (offset < 0 || offset + length > size) throw new Error('Source archive is truncated.');
      const data = Buffer.alloc(length);
      const result = await handle.read(data, 0, length, offset);
      if (result.bytesRead !== length) throw new Error('Source archive is truncated.');
      return data;
    }
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (
        tail.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + tail.readUInt16LE(i + 20) === tail.length
      ) {
        end = i;
        break;
      }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6))
      throw new Error('Unsupported source archive.');
    const count = tail.readUInt16LE(end + 10),
      centralSize = tail.readUInt32LE(end + 12),
      centralOffset = tail.readUInt32LE(end + 16);
    if (
      !count ||
      count > 5000 ||
      count !== tail.readUInt16LE(end + 8) ||
      centralSize > 8 * 1024 * 1024 ||
      centralOffset + centralSize !== size - tail.length + end
    )
      throw new Error('Source archive has too many entries or an invalid directory.');
    const central = await read(centralOffset, centralSize);
    const entries: Entry[] = [],
      names = new Map<string, string>(),
      leafNames = new Set<string>();
    let cursor = 0,
      total = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50)
        throw new Error('Invalid source directory.');
      const flags = central.readUInt16LE(cursor + 8),
        method = central.readUInt16LE(cursor + 10),
        packed = central.readUInt32LE(cursor + 20),
        bytes = central.readUInt32LE(cursor + 24);
      const length = central.readUInt16LE(cursor + 28),
        extra = central.readUInt16LE(cursor + 30),
        comment = central.readUInt16LE(cursor + 32),
        mode = (central.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
      if (
        cursor + 46 + length + extra + comment > central.length ||
        flags & 1 ||
        ![0, 8].includes(method) ||
        ![0, 0x8000, 0x4000].includes(mode) ||
        central.readUInt16LE(cursor + 34)
      )
        throw new Error('Source archives must contain ordinary files and directories.');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(
        central.subarray(cursor + 46, cursor + 46 + length),
      );
      safeName(name);
      const base = name.replace(/\/$/, ''),
        key = base.normalize('NFC').toLowerCase();
      if (leafNames.has(key))
        throw new Error('Source archive contains duplicate or conflicting paths.');
      leafNames.add(key);
      const parts = base.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/'),
          lower = prefix.normalize('NFC').toLowerCase();
        if (names.has(lower) && names.get(lower) !== prefix)
          throw new Error('Source archive contains case-conflicting paths.');
        names.set(lower, prefix);
      }
      if (!name.endsWith('/')) {
        total += bytes;
        if (entries.length >= 500 || total > SOURCE_LIMIT)
          throw new Error('Source may contain at most 1 GiB and 500 files.');
        entries.push({
          name,
          bytes,
          packed,
          method,
          offset: central.readUInt32LE(cursor + 42),
          crc: central.readUInt32LE(cursor + 16),
          executable: !!((central.readUInt32LE(cursor + 38) >>> 16) & 0o111),
        });
      } else if (bytes) throw new Error('Invalid source directory entry.');
      cursor += 46 + length + extra + comment;
    }
    if (cursor !== central.length || !entries.length)
      throw new Error('The source archive contains no project files.');
    const files = new Set(entries.map((entry) => entry.name.normalize('NFC').toLowerCase()));
    for (const entry of entries) {
      const parts = entry.name.split('/');
      if (
        parts.slice(0, -1).some((_, i) =>
          files.has(
            parts
              .slice(0, i + 1)
              .join('/')
              .normalize('NFC')
              .toLowerCase(),
          ),
        )
      )
        throw new Error('Source archive contains conflicting files and directories.');
    }
    const prefix = githubRoot ? entries[0]!.name.split('/')[0] + '/' : '';
    if (prefix && entries.some((entry) => !entry.name.startsWith(prefix)))
      throw new Error('Unexpected repository archive layout.');
    let written = 0,
      outputBytes = 0;
    for (const entry of entries) {
      const name = prefix ? entry.name.slice(prefix.length) : entry.name;
      safeName(name);
      if (builtInExclusion(name) || /(^|\/)\.playground-key(?:\.|$)/i.test(name)) continue;
      const local = await read(entry.offset, 30);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) & 1 ||
        local.readUInt16LE(8) !== entry.method
      )
        throw new Error('Invalid source file header.');
      const localName = await read(entry.offset + 30, local.readUInt16LE(26));
      if (new TextDecoder('utf-8', { fatal: true }).decode(localName) !== entry.name)
        throw new Error('Source file names do not match.');
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + entry.packed > centralOffset) throw new Error('Invalid source file bounds.');
      const target = path.join(directory, name);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      let bytes = 0,
        crc = 0xffffffff;
      const check = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > entry.bytes || outputBytes + bytes > SOURCE_LIMIT) {
            callback(new Error('Expanded source exceeds its declared size.'));
            return;
          }
          for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
          callback(null, chunk);
        },
      });
      if (!entry.packed)
        await fs.writeFile(target, '', { flag: 'wx', mode: entry.executable ? 0o700 : 0o600 });
      else {
        const input = createReadStream(archive, { start, end: start + entry.packed - 1 });
        const output = createWriteStream(target, {
          flags: 'wx',
          mode: entry.executable ? 0o700 : 0o600,
        });
        if (entry.method === 8) await pipeline(input, createInflateRaw(), check, output);
        else await pipeline(input, check, output);
      }
      if (bytes !== entry.bytes || (crc ^ 0xffffffff) >>> 0 !== entry.crc)
        throw new Error('Source file integrity check failed.');
      written++;
      outputBytes += bytes;
    }
    if (!written) throw new Error('The source contains no usable project files.');
    return { files: written, bytes: outputBytes };
  } finally {
    await handle.close();
  }
}
