import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { remixProject, parseProjectUrl } from '../dist/remix/remix.js';
import { extractSource } from '../dist/remix/archive.js';
import { parseArguments } from '../dist/cli/arguments.js';
import { createPlaygroundClient } from '../dist/index.js';

const origin = 'https://playgroundvibes.com';
const descriptor = {
  version: 1,
  project_id: 'parent',
  version_id: 'saved-version',
  title: 'Garden',
  summary: 'A local garden game',
  description: 'Grow plants.',
  category: 'Games',
  tags: [],
  license: 'MIT',
  provider_requirements: [],
  creation_details: { tools: [], model: '' },
  archive_root: 'project',
  source_url: '/api/projects/parent/zip?version=saved-version',
};
async function base(t) {
  const folder = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'playground-remix-test-')),
  );
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}
function archive(files) {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])),
  );
}

test('remix URLs and command preserve explicit versions', () => {
  for (const url of [
    '/project/parent?version=saved-version',
    '/#project/parent?version=saved-version',
    '/#/project/parent?version=saved-version',
  ])
    assert.deepEqual(parseProjectUrl(origin + url), {
      projectId: 'parent',
      versionId: 'saved-version',
    });
  assert.throws(() => parseProjectUrl('https://evil.example/project/parent'));
  assert.throws(() => parseProjectUrl(origin + '/project/parent?version=../bad'));
  assert.deepEqual(parseArguments(['remix', origin + '/project/parent', 'my-copy']).command, {
    name: 'remix',
    url: origin + '/project/parent',
    directory: 'my-copy',
  });
});

test('one local download gets fresh identity, keeps attribution and needs no login; two pushes update its own project', async (t) => {
  const folder = await base(t),
    destination = path.join(folder, 'garden'),
    requests = [];
  const zip = archive({
    'index.html': '<h1>Garden</h1>',
    LICENSE: 'MIT original copyright',
    'AGENTS.md': 'Keep this instruction.',
    '.playground/project.json': '{"project_id":"parent"}',
    '.playground/manifest.json': '{"source_id":"original"}',
    '.playground-key': 'original-credential',
    '.git/config': 'original remote',
    'PLAYGROUND.md': 'Original publishing notes',
  });
  const savedFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
  });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return String(url).includes('/remix') ? Response.json(descriptor) : new Response(zip);
  };
  const result = await remixProject(
    origin + '/project/parent?version=saved-version',
    destination,
    path.join(folder, 'config'),
  );
  assert.equal(requests.length, 2);
  assert(requests.every((r) => !r.options.headers.Authorization));
  assert.equal(
    await fs.readFile(path.join(destination, 'LICENSE'), 'utf8'),
    'MIT original copyright',
  );
  assert.match(
    await fs.readFile(path.join(destination, 'AGENTS.md'), 'utf8'),
    /Keep this instruction/,
  );
  assert.match(await fs.readFile(path.join(destination, 'PLAYGROUND.md'), 'utf8'), /saved-version/);
  for (const name of ['.git', '.playground-key', '.playground/project.json'])
    await assert.rejects(fs.stat(path.join(destination, name)), { code: 'ENOENT' });
  const manifestPath = path.join(destination, '.playground/manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath));
  assert.match(manifest.source_id, /^remix-/);
  assert.equal(manifest.share_source, true);
  assert.equal(manifest.remix, true);
  assert.equal(manifest.license, 'MIT');
  manifest.build_dir = '..';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const sent = [];
  const transport = async (endpoint, body) => {
    if (endpoint === '/api/assistant/pair-redeem' || endpoint === '/api/assistant/status')
      return { status: 'connected', account_id: 'remixer' };
    if (endpoint === '/api/assistant/import') {
      sent.push(body);
      return {
        id: 'my-remix',
        status: 'imported',
        version_id: 'new-version',
        url: '/#project/my-remix',
        preview: 'ready',
      };
    }
    throw new Error(endpoint);
  };
  const client = createPlaygroundClient({
    cwd: destination,
    configDir: path.join(folder, 'config'),
    request: transport,
  });
  await client.connect('ABCDEFGH');
  let review = await client.prepare();
  assert.match(review.publication, /enables public downloads/);
  assert.deepEqual(review.metadata.remix_of, { project_id: 'parent', version_id: 'saved-version' });
  await client.deploy(review, { consent: review.digest });
  await fs.writeFile(path.join(destination, 'index.html'), '<h1>My updated garden</h1>');
  review = await client.prepare();
  assert.equal(review.projectId, 'my-remix');
  await client.deploy(review, { consent: review.digest });
  assert.equal(sent[0].project_id, undefined);
  assert.equal(sent.at(-1).project_id, 'my-remix');
  assert.equal(sent[0].projects[0].source_id, sent.at(-1).projects[0].source_id);
  const another = path.join(folder, 'another');
  await remixProject(origin + '/project/parent', another);
  assert.notEqual(
    JSON.parse(await fs.readFile(path.join(another, '.playground/manifest.json'))).source_id,
    manifest.source_id,
  );
  await assert.rejects(remixProject(origin + '/project/parent', destination), /never overwritten/);
  assert.equal(
    await fs.readFile(path.join(destination, 'index.html'), 'utf8'),
    '<h1>My updated garden</h1>',
  );
  assert.match(result.message, /Nothing has been published/);
});

test('archive extraction rejects traversal, case collisions, symlinks, corrupt files and excessive file counts', async (t) => {
  const folder = await base(t);
  const symlink = Buffer.from(archive({ link: 'target' }));
  let central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  symlink.writeUInt32LE((0xa1ff << 16) >>> 0, central + 38);
  const corrupt = Buffer.from(archive({ 'main.txt': 'hello' }));
  central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  corrupt.writeUInt32LE(123, central + 16);
  const candidates = [
    archive({ '../escape': 'x' }),
    archive({ 'A.txt': 'a', 'a.txt': 'b' }),
    archive({ folder: 'a', 'folder/file': 'b' }),
    symlink,
    corrupt,
    archive(Object.fromEntries(Array.from({ length: 501 }, (_, i) => ['f' + i, 'x']))),
  ];
  for (const [i, zip] of candidates.entries()) {
    const file = path.join(folder, 'archive' + i + '.zip'),
      dir = path.join(folder, 'out' + i);
    await fs.writeFile(file, zip);
    await fs.mkdir(dir);
    await assert.rejects(extractSource(file, dir));
  }
  await assert.rejects(fs.stat(path.join(folder, 'escape')), { code: 'ENOENT' });
});

test('repository archives strip only their root and stream a large file intact', async (t) => {
  const folder = await base(t),
    file = path.join(folder, 'archive.zip'),
    dir = path.join(folder, 'out');
  await fs.mkdir(dir);
  const bytes = new Uint8Array(20 * 1024 * 1024).fill(42);
  await fs.writeFile(
    file,
    zipSync({
      'repo-commit/large.bin': bytes,
      'repo-commit/index.html': strToU8('<h1>Hello</h1>'),
    }),
  );
  const result = await extractSource(file, dir, true);
  assert.equal(result.files, 2);
  assert.deepEqual(new Uint8Array(await fs.readFile(path.join(dir, 'large.bin'))), bytes);
});

test('download never follows redirects to arbitrary hosts and cleans failed destinations', async (t) => {
  const folder = await base(t),
    dir = path.join(folder, 'failed');
  const savedFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
  });
  globalThis.fetch = async (url) =>
    String(url).includes('/remix')
      ? Response.json(descriptor)
      : new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/source.zip' },
        });
  await assert.rejects(remixProject(origin + '/project/parent', dir), /exact GitHub commit/);
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});
