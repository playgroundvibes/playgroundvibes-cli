import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { multipartRequest } from '../dist/publishing/multipart.js';
import { prepareUpload } from '../dist/publishing/prepare.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
test('large artifacts resume exact 5 MiB parts and finalize a small reference envelope', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-parts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 91, 5),
    filename = path.join(root, 'archive.zip');
  await fs.writeFile(filename, bytes);
  const id = 'a'.repeat(36),
    calls = [];
  const request = async (endpoint, body, token) => {
    assert.equal(endpoint, '/api/assistant/artifact');
    assert.equal(token, 'credential');
    calls.push(body);
    if (body.action === 'start') return { id, part_bytes: 5 * 1024 * 1024, parts: [1] };
    if (body.action === 'complete') return { id, complete: true };
    return { id, part: body.number };
  };
  const upload = {
    entry: { title: 'Large', source: '', source_id: 'stable' },
    hashes: { source: sha(bytes) },
    archives: { source: { path: filename, bytes: bytes.length, sha256: sha(bytes) } },
    identity: { project_id: 'existing' },
  };
  const result = await multipartRequest(upload, 'operation', request, 'credential');
  assert.deepEqual(
    calls.map((c) => c.action),
    ['start', 'part', 'complete'],
  );
  assert.equal(calls[1].number, 2);
  assert.deepEqual(Buffer.from(calls[1].data, 'base64'), bytes.subarray(5 * 1024 * 1024));
  assert.deepEqual(result.uploaded_artifacts, { source: id });
  assert.equal(result.project_id, 'existing');
  assert.equal(result.projects[0].source, undefined);
  await fs.writeFile(filename, 'changed snapshot');
  await assert.rejects(
    () => multipartRequest(upload, 'operation', request, 'credential'),
    /changed/,
  );
});
test('browser assets above 3 MiB select multipart without changing reviewed file bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-large-build-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.playground'));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'main.js'), 'export const ready = true;');
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>Large</h1>');
  await fs.writeFile(path.join(root, 'dist/media.bin'), Buffer.alloc(4 * 1024 * 1024));
  await fs.writeFile(
    path.join(root, '.playground/manifest.json'),
    JSON.stringify({ title: 'Large project', summary: 'A large project', build_dir: '../dist' }),
  );
  const prepared = await prepareUpload(root, root + '-private', 'account');
  assert(prepared.archives?.source);
  assert(prepared.archives?.build);
  assert.equal(prepared.entry.source, '');
  assert.equal(prepared.entry.build, undefined);
  assert.equal(
    prepared.review.files.find((f) => f.artifact === 'build' && f.path === 'media.bin').bytes,
    4 * 1024 * 1024,
  );
  assert.equal(prepared.hashes.build, prepared.archives.build.sha256);
  await fs.writeFile(path.join(root, 'large.bin'), Buffer.alloc(4 * 1024 * 1024));
  await fs.writeFile(
    path.join(root, '.playground/manifest.json'),
    JSON.stringify({ title: 'Large source', summary: 'Static game', source_only: true }),
  );
  const sourceOnly = await prepareUpload(root, root + '-private', 'account');
  assert(sourceOnly.archives?.source);
});

test('100 MiB covers upload reviewed snapshots in bounded parts without inline base64', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-large-cover-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.playground'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Cover fixture</h1>');
  await fs.writeFile(path.join(root, '.gitignore'), 'cover.png\n');
  const cover = Buffer.alloc(100 * 1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(cover);
  await fs.writeFile(path.join(root, 'cover.png'), cover);
  await fs.writeFile(
    path.join(root, '.playground/manifest.json'),
    JSON.stringify({
      title: 'Cover fixture',
      summary: 'Large cover',
      source_only: true,
      cover_file: '../cover.png',
    }),
  );
  const prepared = await prepareUpload(root, root + '-private', 'account');
  assert(prepared.archives?.source);
  assert(prepared.archives?.cover);
  assert.equal(prepared.entry.cover, undefined);
  assert.equal(prepared.hashes.cover, sha(cover));
  assert.equal(prepared.review.files.find((f) => f.artifact === 'cover').bytes, cover.length);
  await fs.writeFile(path.join(root, 'cover.png'), 'changed after review');
  const kinds = new Map(),
    chunks = [];
  const result = await multipartRequest(
    prepared,
    'operation',
    async (_endpoint, body) => {
      assert(Buffer.byteLength(JSON.stringify(body)) < 16 * 1024 * 1024);
      if (body.action === 'start') {
        const id = (body.kind === 'cover' ? 'b' : 'a').repeat(36);
        kinds.set(id, body.kind);
        return { id, part_bytes: 5 * 1024 * 1024, parts: [] };
      }
      if (body.action === 'complete') return { id: body.id, complete: true };
      if (kinds.get(body.id) === 'cover') chunks.push(Buffer.from(body.data, 'base64'));
      return { id: body.id, part: body.number };
    },
    'credential',
  );
  assert.equal(chunks.length, 20);
  assert.deepEqual(Buffer.concat(chunks), cover);
  assert.equal(result.uploaded_artifacts.cover, 'b'.repeat(36));
  assert.equal(result.projects[0].cover, undefined);
  assert(Buffer.byteLength(JSON.stringify(result)) < 4000);
});
