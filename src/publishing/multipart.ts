import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ArchiveSnapshot } from '../artifacts/pack-project.js';
import { APIError, type JsonObject, type PlaygroundTransport } from '../api/transport.js';
import type { PreparedUpload } from './prepare.js';

async function send(request: PlaygroundTransport, body: JsonObject, token: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request('/api/assistant/artifact', body, token);
    } catch (error) {
      if (attempt === 2 || (error instanceof APIError && error.status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
}
async function artifact(
  request: PlaygroundTransport,
  token: string,
  kind: string,
  file: ArchiveSnapshot,
) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file.path)) hash.update(chunk);
  if (hash.digest('hex') !== file.sha256)
    throw new Error('The reviewed archive changed. Prepare and approve it again.');
  const started = await send(
    request,
    { action: 'start', kind, bytes: file.bytes, sha256: file.sha256 },
    token,
  );
  if (
    typeof started.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(started.id) ||
    started.part_bytes !== 5 * 1024 * 1024 ||
    !Array.isArray(started.parts)
  )
    throw new Error('Invalid multipart upload response.');
  if (started.complete === true) return started.id;
  const handle = await fs.open(file.path, 'r');
  try {
    for (let offset = 0, number = 1; offset < file.bytes; offset += 5 * 1024 * 1024, number++) {
      if (started.parts.includes(number)) continue;
      const size = Math.min(5 * 1024 * 1024, file.bytes - offset),
        chunk = Buffer.alloc(size);
      const { bytesRead } = await handle.read(chunk, 0, size, offset);
      if (bytesRead !== size) throw new Error('The reviewed archive was truncated.');
      await send(
        request,
        { action: 'part', id: started.id, number, data: chunk.toString('base64') },
        token,
      );
    }
  } finally {
    await handle.close();
  }
  const completed = await send(request, { action: 'complete', id: started.id }, token);
  if (completed.complete !== true)
    throw new Error('Upload completion could not be verified. Retry the same project.');
  return started.id;
}
export async function multipartRequest(
  upload: PreparedUpload,
  operationId: string,
  request: PlaygroundTransport,
  token: string,
): Promise<JsonObject> {
  const refs: Record<string, string> = {};
  for (const [kind, file] of Object.entries(upload.archives!))
    refs[kind] = await artifact(request, token, kind, file);
  const { source: _source, build: _build, ...metadata } = upload.entry;
  return {
    version: 1,
    operation_id: operationId,
    artifact_hashes: upload.hashes,
    uploaded_artifacts: refs,
    projects: [metadata],
    ...(upload.identity?.project_id ? { project_id: upload.identity.project_id } : {}),
  };
}
