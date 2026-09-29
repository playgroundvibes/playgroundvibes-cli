import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

async function filesIn(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory())
      files.push(...(await filesIn(directory + entry.name + '/', name + '/')));
    else files.push(name);
  }
  return files.sort();
}

const manifest = JSON.parse(await read('package.json'));
assert.equal(manifest.name, '@playgroundvibes/cli');
assert.equal(manifest.publishConfig.access, 'public');
assert.deepEqual(manifest.files, ['dist/', 'skills/', 'examples/', 'docs/', 'NOTICE.md']);
assert.match(await read('dist/cli.js'), /^#!\/usr\/bin\/env node\n/);
assert.match(
  await read('skills/playground-upload/SKILL.md'),
  /^---\r?\nname: playground-upload\r?\n/,
);
await read('docs/filtering.md');

const expectedCompiledFiles = (await filesIn('src/'))
  .flatMap((file) => {
    assert.ok(file.endsWith('.ts') && !file.endsWith('.d.ts'), `Unexpected source file: ${file}`);
    return [file.slice(0, -3) + '.js', file.slice(0, -3) + '.d.ts'];
  })
  .sort();
assert.deepEqual(
  await filesIn('dist/'),
  expectedCompiledFiles,
  'Only current compiled modules may ship.',
);

const expectedExports = {
  '.': ['ConsentError', 'ScanError', 'createPlaygroundClient', 'getSkillPath', 'installSkill'],
  './filtering': [
    'BUILT_IN_EXCLUSIONS',
    'CREDENTIAL_PATTERNS',
    'INSPECTION_LIMITS',
    'ScanError',
    'scanText',
  ],
  './skills': ['getSkillPath', 'installSkill'],
};
assert.deepEqual(
  Object.keys(manifest.exports).sort(),
  [...Object.keys(expectedExports), './package.json'].sort(),
);
for (const [subpath, names] of Object.entries(expectedExports)) {
  const entry = manifest.exports[subpath];
  assert.ok(entry.import.endsWith('.js'));
  assert.ok(entry.types.endsWith('.d.ts'));
  await read(entry.types);
  const api = await import(new URL(entry.import, root));
  assert.deepEqual(Object.keys(api).sort(), names.sort(), `Unexpected API exports at ${subpath}`);
}
await assert.rejects(import('@playgroundvibes/cli/dist/publishing/upload.js'), {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
});
console.log('Compiled modules, public exports, declarations, and packaged skill verified.');
