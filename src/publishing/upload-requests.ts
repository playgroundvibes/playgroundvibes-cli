import { MAX_REQUEST_BYTES, type JsonObject } from '../api/transport.js';
import type { PreparedUpload } from './prepare.js';

/** Split only at artifact boundaries, keeping metadata and operation identity identical. */
export function buildUploadRequests(upload: PreparedUpload, operationId: string): JsonObject[] {
  const { entry, hashes, identity } = upload;
  const base = {
    version: 1,
    operation_id: operationId,
    artifact_hashes: hashes,
    ...(identity?.project_id ? { project_id: identity.project_id } : {}),
  };
  const combined = { ...base, projects: [entry], more_artifacts: false };
  if (Buffer.byteLength(JSON.stringify(combined)) <= MAX_REQUEST_BYTES) return [combined];

  const { source, build, ...metadata } = entry;
  const parts: JsonObject[] = [
    { ...base, projects: [{ ...metadata, source }], more_artifacts: build !== undefined },
  ];
  if (build !== undefined)
    parts.push({ ...base, projects: [{ ...metadata, build }], more_artifacts: false });
  if (parts.some((part) => Buffer.byteLength(JSON.stringify(part)) > MAX_REQUEST_BYTES)) {
    throw new Error('One upload part exceeds 16 MiB. Reduce the project size.');
  }
  return parts;
}
