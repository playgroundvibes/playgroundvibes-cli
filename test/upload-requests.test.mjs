import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { MAX_REQUEST_BYTES } from '../dist/api/transport.js';
import { buildUploadRequests } from '../dist/publishing/upload-requests.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const metadata = Object.freeze({
  source_id: 'stable-source',
  date: '2020-01-01',
  title: 'Reviewed project ✨',
  summary: 'Unicode bytes count too.',
  category: 'Tools',
  license: 'All rights reserved',
  remix: false,
  creation_details: Object.freeze({
    tools: Object.freeze(['Codex']),
    model: 'Owner-supplied model',
  }),
});

function prepared(source, build, projectId = 'linked-project') {
  return Object.freeze({
    entry: Object.freeze({ ...metadata, source, ...(build !== undefined ? { build } : {}) }),
    hashes: Object.freeze({
      source: sha(source),
      ...(build !== undefined ? { build: sha(build) } : {}),
    }),
    identity: projectId ? Object.freeze({ project_id: projectId }) : undefined,
  });
}

test('small uploads combine inspected artifacts with the same metadata and complete hashes', () => {
  const upload = prepared('c291cmNl', 'YnVpbGQ=');
  const parts = buildUploadRequests(upload, 'operation-fixture');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0], {
    version: 1,
    operation_id: 'operation-fixture',
    project_id: 'linked-project',
    artifact_hashes: upload.hashes,
    projects: [upload.entry],
    more_artifacts: false,
  });
  assert.deepEqual(buildUploadRequests(upload, 'operation-fixture'), parts);
  assert.equal(parts[0].artifact_hashes.source, sha(upload.entry.source));
  assert.equal(parts[0].artifact_hashes.build, sha(upload.entry.build));
});

test('multipart splitting preserves operation, project, metadata and hashes in every bounded request', () => {
  const upload = prepared('A'.repeat(9 * 1024 * 1024), 'B'.repeat(9 * 1024 * 1024));
  const parts = buildUploadRequests(upload, 'operation-multipart');
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= MAX_REQUEST_BYTES);
    assert.equal(part.operation_id, 'operation-multipart');
    assert.equal(part.project_id, 'linked-project');
    assert.equal(part.version, 1);
    assert.deepEqual(part.artifact_hashes, upload.hashes);
    const { source, build, ...entryMetadata } = part.projects[0];
    assert.deepEqual(entryMetadata, metadata);
  }
  assert.equal(parts[0].projects[0].source, upload.entry.source);
  assert.equal(Object.hasOwn(parts[0].projects[0], 'build'), false);
  assert.equal(parts[0].more_artifacts, true);
  assert.equal(parts[1].projects[0].build, upload.entry.build);
  assert.equal(Object.hasOwn(parts[1].projects[0], 'source'), false);
  assert.equal(parts[1].more_artifacts, false);
  assert.deepEqual(buildUploadRequests(upload, 'operation-multipart'), parts);
});

test('source-only requests honor the exact UTF-8 byte limit and never invent a project binding', () => {
  const empty = prepared('', undefined, null);
  const overhead = Buffer.byteLength(
    JSON.stringify(buildUploadRequests(empty, 'operation-boundary')[0]),
  );
  const source = 'A'.repeat(MAX_REQUEST_BYTES - overhead);
  const exact = prepared(source, undefined, null);
  const parts = buildUploadRequests(exact, 'operation-boundary');
  assert.equal(parts.length, 1);
  assert.equal(Buffer.byteLength(JSON.stringify(parts[0])), MAX_REQUEST_BYTES);
  assert.equal(Object.hasOwn(parts[0], 'project_id'), false);
  assert.equal(parts[0].more_artifacts, false);
  const oversized = prepared(source + 'A', undefined, null);
  assert.throws(
    () => buildUploadRequests(oversized, 'operation-boundary'),
    /One upload part exceeds 16 MiB/,
  );
});
