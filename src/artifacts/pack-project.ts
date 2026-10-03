import { Zip, ZipDeflate } from 'fflate';
import { createReadStream, openSync, closeSync, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  collectFiles,
  type CollectionOptions,
  type FileExclusion,
  type FileSummary,
} from '../filtering/collect-files.js';
import { INSPECTION_LIMITS } from '../filtering/limits.js';
import { snapshotPath } from './snapshots.js';

export interface ArchiveSnapshot {
  path: string;
  bytes: number;
  sha256: string;
}
export interface PackResult {
  data: string;
  archive: ArchiveSnapshot;
  files: FileSummary[];
  bytes: number;
  skipped: FileExclusion[];
}

/** ZIP from immutable disk snapshots with bounded RAM, including incompressible 1 GiB projects. */
export async function packProject(
  root: string,
  options: CollectionOptions = {},
): Promise<PackResult> {
  const collection = await collectFiles(root, options),
    target = snapshotPath();
  const fd = openSync(target, 'wx', 0o600),
    hash = createHash('sha256');
  let size = 0;
  const zip = new Zip((error, data) => {
    if (error) throw error;
    size += data.length;
    if (size > INSPECTION_LIMITS.archiveBytes)
      throw new Error('Archive exceeds the 1 GiB project limit.');
    hash.update(data);
    writeSync(fd, data);
  });
  const files: FileSummary[] = [];
  try {
    for (const file of collection.files) {
      files.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
      const entry = new ZipDeflate(file.path, { level: 6 });
      entry.mtime = new Date(1980, 0, 1);
      zip.add(entry);
      for await (const chunk of createReadStream(file.snapshotPath!, { highWaterMark: 256 * 1024 }))
        entry.push(chunk as Buffer);
      entry.push(new Uint8Array(), true);
    }
    zip.end();
  } finally {
    closeSync(fd);
  }
  return {
    data: size <= 10 * 1024 * 1024 ? (await fs.readFile(target)).toString('base64') : '',
    archive: { path: target, bytes: size, sha256: hash.digest('hex') },
    files,
    bytes: collection.bytes,
    skipped: collection.skipped,
  };
}
