import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPlaygroundClient, ScanError } from '../dist/index.js';
import { inspectCover, resolveCoverPath } from '../dist/artifacts/inspect-cover.js';
import { MAX_REQUEST_BYTES } from '../dist/api/transport.js';
import { buildUploadRequests } from '../dist/publishing/upload-requests.js';

const MIB = 1024 * 1024;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 1, 2]);

async function fixture(t, extension = '.png') {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'playground-cover-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'app');
  const configDir = path.join(base, 'private');
  const manifestPath = path.join(root, '.playground/manifest.json');
  const filename = `cover${extension}`;
  const coverPath = path.join(root, filename);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(path.join(root, 'main.ts'), 'export const title = "Cover example";');
  // Explicit cover selection works even when the source ignores the file.
  await fs.writeFile(path.join(root, '.gitignore'), 'cover.*\n');
  await fs.writeFile(coverPath, imageBytes);
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      title: 'Cover example',
      summary: 'A reviewed image',
      date: '2020-01-01',
      source_only: true,
      cover_file: `../${filename}`,
    }),
  );
  const calls = [];
  const request = async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint === '/api/assistant/pair-redeem' || endpoint === '/api/assistant/status')
      return { status: 'connected', account_id: 'cover-account' };
    if (endpoint === '/api/assistant/import')
      return {
        status: 'imported',
        id: 'cover-project',
        version_id: 'cover-version',
        url: '/#project/cover-project',
      };
    throw new Error('Unexpected fixture request');
  };
  return {
    root,
    coverPath,
    manifestPath,
    filename,
    calls,
    client: createPlaygroundClient({ cwd: root, configDir, request }),
  };
}

test('covers use the original wire shape, MIME mapping, and exact reviewed byte snapshot', async (t) => {
  for (const [extension, mime] of [
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.JPEG', 'image/jpeg'],
    ['.webp', 'image/webp'],
  ]) {
    const f = await fixture(t, extension);
    await f.client.connect('ABCD2345');
    const review = await f.client.prepare();
    const cover = review.files.find((file) => file.artifact === 'cover');
    assert.deepEqual(cover, {
      artifact: 'cover',
      path: f.filename,
      bytes: imageBytes.length,
      sha256: sha(imageBytes),
    });
    assert.ok(!review.files.some((file) => file.artifact === 'source' && file.path === f.filename));
    assert.equal(
      review.bytes,
      review.files.reduce((bytes, file) => bytes + file.bytes, 0),
    );
    assert.ok(review.warnings.some((warning) => warning.startsWith('Credential checks')));
    assert.equal(Object.hasOwn(review.metadata, 'cover_file'), false);
    assert.ok(!JSON.stringify(review).includes(imageBytes.toString('base64')));

    await fs.writeFile(f.coverPath, Buffer.concat([imageBytes, Buffer.from([3])]));
    const changed = await f.client.inspect();
    assert.notEqual(changed.digest, review.digest);
    await f.client.deploy(review, { consent: review.digest });
    const imports = f.calls.filter((call) => call.endpoint === '/api/assistant/import');
    assert.equal(imports.length, 1);
    assert.deepEqual(imports[0].body.projects[0].cover, {
      mime,
      data: imageBytes.toString('base64'),
    });
    assert.equal(imports[0].body.artifact_hashes.cover, sha(imageBytes.toString('base64')));
    assert.equal(imports[0].body.more_artifacts, false);
  }
});

test('explicit covers use the bundle selection rules independently of archive exclusions', async (t) => {
  const f = await fixture(t);
  for (const folder of ['.claude', '.playground', '.env']) {
    const filename = path.join(f.root, folder, 'image.png');
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, imageBytes);
    const inspected = await inspectCover(f.root, filename);
    assert.deepEqual(Buffer.from(inspected.payload.data, 'base64'), imageBytes);
  }
  await fs.writeFile(path.join(f.root, '.playgroundignore'), 'cover.png\n');
  const review = await f.client.inspect();
  assert.ok(review.files.some((file) => file.artifact === 'cover' && file.path === f.filename));
  assert.ok(!review.files.some((file) => file.artifact === 'source' && file.path === f.filename));

  const nested = path.join(f.root, 'images/cover.png');
  await fs.mkdir(path.dirname(nested));
  await fs.writeFile(nested, imageBytes);
  await fs.writeFile(path.join(f.root, '.playgroundignore'), 'images/\n!images/cover.png\n');
  assert.deepEqual(
    Buffer.from((await inspectCover(f.root, nested)).payload.data, 'base64'),
    imageBytes,
  );
});

test('cover paths validate extension, boundaries, and regular files', async (t) => {
  const f = await fixture(t);
  for (const value of ['', ' ../cover.png', '../cover.png ', null, 1, '../cover.png\n'])
    await assert.rejects(
      resolveCoverPath(f.root, f.manifestPath, value),
      /cover_file must be a nonempty path/,
    );
  await assert.rejects(
    resolveCoverPath(f.root, f.manifestPath, '../../outside.png'),
    /inside the selected project/,
  );
  await fs.writeFile(path.join(f.root, 'cover.gif'), imageBytes);
  await assert.rejects(inspectCover(f.root, path.join(f.root, 'cover.gif')), /PNG, JPEG, or WebP/);
  await fs.mkdir(path.join(f.root, 'directory.png'));
  await assert.rejects(inspectCover(f.root, path.join(f.root, 'directory.png')), /regular file/);
  const credential = 'sk-proj-' + 'x'.repeat(32);
  const filename = path.join(f.root, credential + '.png');
  await fs.writeFile(filename, imageBytes);
  assert.deepEqual(
    Buffer.from((await inspectCover(f.root, filename)).payload.data, 'base64'),
    imageBytes,
  );
});

test('symlinked cover directories and files are refused', async (t) => {
  const f = await fixture(t);
  const images = path.join(f.root, 'images');
  await fs.mkdir(images);
  await fs.writeFile(path.join(images, 'cover.png'), imageBytes);
  await fs.symlink(images, path.join(f.root, 'linked-images'), 'junction');
  await assert.rejects(
    inspectCover(f.root, path.join(f.root, 'linked-images/cover.png')),
    /symlink/,
  );
  if (process.platform !== 'win32') {
    await fs.symlink(f.coverPath, path.join(f.root, 'linked.png'));
    await assert.rejects(inspectCover(f.root, path.join(f.root, 'linked.png')), /symlink/);
  }
});

test('literal credentials block cover uploads without retaining secret values in errors', async (t) => {
  const f = await fixture(t);
  const credential = 'sk-proj-' + 'A'.repeat(32);
  await fs.writeFile(
    f.coverPath,
    Buffer.concat([imageBytes, Buffer.from('\n' + credential + '\n')]),
  );
  await assert.rejects(f.client.inspect(), (error) => {
    assert.ok(error instanceof ScanError);
    assert.ok(error.findings.every((finding) => finding.path === 'cover.png'));
    assert.ok(!error.message.includes(credential));
    return true;
  });
  assert.equal(f.calls.length, 0);
});

test('covers allow the exact 100 MiB limit and reject larger files', async (t) => {
  const f = await fixture(t);
  const limit = Buffer.alloc(100 * MIB);
  await fs.writeFile(f.coverPath, limit);
  const result = await inspectCover(f.root, f.coverPath);
  assert.equal(result.file.bytes, 100 * MIB);
  assert.equal(result.payload.data, '');
  assert.deepEqual(await fs.readFile(result.snapshot.path), limit);
  await fs.appendFile(f.coverPath, Buffer.from([0]));
  await assert.rejects(inspectCover(f.root, f.coverPath), /cover_file exceeds 100 MiB/);
});

test('multipart covers follow source and build and preserve complete hashes and metadata', () => {
  const metadata = {
    title: 'Cover split',
    summary: 'Multipart cover example',
    source_id: 'cover-source',
  };
  const source = 'A'.repeat(9 * MIB);
  const build = 'B'.repeat(9 * MIB);
  const cover = { mime: 'image/png', data: imageBytes.toString('base64') };
  const hashes = { source: sha(source), build: sha(build), cover: sha(cover.data) };
  const upload = {
    entry: { ...metadata, source, build, cover },
    hashes,
    identity: { project_id: 'cover-project' },
  };
  const parts = buildUploadRequests(upload, 'cover-operation');
  assert.equal(parts.length, 3);
  for (const [index, kind] of ['source', 'build', 'cover'].entries()) {
    const part = parts[index];
    assert.ok(Buffer.byteLength(JSON.stringify(part)) <= MAX_REQUEST_BYTES);
    assert.equal(part.operation_id, 'cover-operation');
    assert.equal(part.project_id, 'cover-project');
    assert.deepEqual(part.artifact_hashes, hashes);
    assert.deepEqual(part.projects, [{ ...metadata, [kind]: upload.entry[kind] }]);
    assert.equal(part.more_artifacts, index < 2);
  }

  const withoutBuild = {
    entry: {
      ...metadata,
      source: 'A'.repeat(13 * MIB),
      cover: { ...cover, data: 'A'.repeat(4 * MIB) },
    },
    hashes: { source: 'source-hash', cover: 'cover-hash' },
  };
  const sourceAndCover = buildUploadRequests(withoutBuild, 'source-cover-operation');
  assert.equal(sourceAndCover.length, 2);
  assert.equal(sourceAndCover[0].more_artifacts, true);
  assert.equal(sourceAndCover[1].more_artifacts, false);
  assert.deepEqual(sourceAndCover[1].projects[0].cover, withoutBuild.entry.cover);
  assert.equal(Object.hasOwn(sourceAndCover[0].projects[0], 'cover'), false);
});
