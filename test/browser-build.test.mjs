import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveBrowserBuild } from '../dist/project/browser-build.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'playground-build-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.playground'));
  const manifestPath = path.join(root, '.playground/manifest.json');
  return {
    root,
    resolve: (manifest = {}) => resolveBrowserBuild(root, manifest, manifestPath),
    async output(name) {
      const directory = path.join(root, name);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, 'index.html'), '<h1>Browser output</h1>');
      return directory;
    },
  };
}

test('one conventional browser output is detected when build_dir is omitted', async (t) => {
  for (const name of ['dist', 'build', 'out']) {
    const f = await fixture(t);
    const expected = await f.output(name);
    assert.equal(await f.resolve(), expected);
    assert.equal(await f.resolve({ source_only: false }), expected);
  }
});

test('missing output uploads source for automatic preparation without running local build scripts', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'index.html'), '<h1>Unselected project root</h1>');
  await fs.mkdir(path.join(f.root, 'dist'));
  await fs.writeFile(
    path.join(f.root, 'package.json'),
    JSON.stringify({ scripts: { build: 'node create-build.mjs' } }),
  );
  await fs.writeFile(
    path.join(f.root, 'create-build.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('dist/index.html', '<h1>Built</h1>');",
  );
  for (const manifest of [{}, { source_only: false }]) {
    assert.equal(await f.resolve(manifest), undefined);
  }
  await assert.rejects(fs.access(path.join(f.root, 'dist/index.html')), { code: 'ENOENT' });
  assert.equal(await f.resolve({ build_dir: '..' }), f.root);
});

test('source-only mode is explicit, boolean, and incompatible with a selected build', async (t) => {
  const f = await fixture(t);
  await f.output('dist');
  assert.equal(await f.resolve({ source_only: true }), undefined);
  for (const source_only of ['true', 'false', 1, 0, null, [], {}]) {
    await assert.rejects(f.resolve({ source_only }), /source_only must be true or false/);
  }
  for (const build_dir of ['../dist', undefined, null]) {
    await assert.rejects(f.resolve({ source_only: true, build_dir }), /cannot be combined/);
  }
});

test('ambiguous output uses source; an explicit selection still chooses the intended build', async (t) => {
  const f = await fixture(t);
  await f.output('dist');
  const expected = await f.output('build');
  assert.equal(await f.resolve(), undefined);
  assert.equal(await f.resolve({ build_dir: '../build' }), expected);
  const custom = await f.output('web/public');
  assert.equal(await f.resolve({ build_dir: '../web/public' }), custom);
});

test('missing explicit output uses source while unsafe paths remain blocked', async (t) => {
  const f = await fixture(t);
  await f.output('dist');
  await fs.mkdir(path.join(f.root, 'empty'));
  await fs.mkdir(path.join(f.root, 'not-regular/index.html'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'file.txt'), 'Not a browser build directory');
  for (const build_dir of ['../missing', '../empty', '../not-regular', '../file.txt']) {
    assert.equal(await f.resolve({ build_dir }), undefined);
  }
  for (const build_dir of ['', ' ../dist', '../dist ', '../dist\n', null, 1, []]) {
    await assert.rejects(f.resolve({ build_dir }), /build_dir must be a nonempty path/);
  }
  await assert.rejects(f.resolve({ build_dir: '../../outside' }), /inside the selected project/);
});

test('a nonregular conventional index does not qualify as browser output', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'dist/index.html'), { recursive: true });
  assert.equal(await f.resolve(), undefined);
});

test('symlinked build directories are refused even when another candidate is valid', async (t) => {
  const f = await fixture(t);
  const target = await f.output('actual');
  await fs.symlink(target, path.join(f.root, 'dist'), 'junction');
  await f.output('out');
  await assert.rejects(f.resolve(), /symlink/);
  await assert.rejects(f.resolve({ build_dir: '../dist' }), /symlink/);
});

test(
  'symlinked index files cannot select a browser build',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, 'dist'));
    const target = path.join(f.root, 'page.html');
    await fs.writeFile(target, '<h1>Linked page</h1>');
    await fs.symlink(target, path.join(f.root, 'dist/index.html'));
    await assert.rejects(f.resolve(), /symlink/);
    await assert.rejects(f.resolve({ build_dir: '../dist' }), /symlink/);
  },
);
