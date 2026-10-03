import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let folder: string | undefined;
/** Private snapshots survive until process exit so review and upload use identical bytes. */
export function snapshotPath(): string {
  if (!folder) {
    folder = mkdtempSync(path.join(os.tmpdir(), 'playground-snapshot-'));
    process.once('exit', () => {
      if (folder) rmSync(folder, { recursive: true, force: true });
    });
  }
  return path.join(folder, randomUUID());
}
