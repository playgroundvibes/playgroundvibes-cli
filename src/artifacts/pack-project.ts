import { zipSync, type Zippable } from 'fflate';
import {
  collectFiles,
  type CollectionOptions,
  type FileExclusion,
  type FileSummary,
} from '../filtering/collect-files.js';
import { INSPECTION_LIMITS } from '../filtering/file-types.js';

export interface PackResult {
  data: string;
  files: FileSummary[];
  bytes: number;
  skipped: FileExclusion[];
}

/** Internal transport artifact: only inspected snapshot bytes enter the ZIP. */
export async function packProject(
  root: string,
  options: CollectionOptions = {},
): Promise<PackResult> {
  const collection = await collectFiles(root, options);
  const entries: Zippable = Object.create(null) as Zippable;
  const files: FileSummary[] = [];
  for (const { contents, ...summary } of collection.files) {
    entries[summary.path] = [contents, { mtime: new Date(1980, 0, 1) }];
    files.push(summary);
  }
  const archive = zipSync(entries, { level: 6 });
  if (archive.length > INSPECTION_LIMITS.archiveBytes)
    throw new Error('Compressed archive exceeds 10 MiB.');
  return {
    data: Buffer.from(archive).toString('base64'),
    files,
    bytes: collection.bytes,
    skipped: collection.skipped,
  };
}
