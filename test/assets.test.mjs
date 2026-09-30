import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import ignore from 'ignore';
import { packProject } from '../dist/artifacts/pack-project.js';
import { INSPECTION_LIMITS, MIB } from '../dist/filtering/limits.js';
import { ScanError } from '../dist/filtering/findings.js';
import {
  builtInExclusion,
  matchIgnoreFiles,
  parseIgnoreFile,
} from '../dist/filtering/path-exclusions.js';

const opaqueBytes = Buffer.from([0, 1, 0xff, 0xfe, 4, 0]);
const fakeToken = () => 'sk-proj-' + 'a1'.repeat(24);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'playground-assets-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function credentialFailure(token) {
  return (error) => {
    assert.ok(error instanceof ScanError);
    assert.ok(error.findings.length > 0);
    assert.equal(error.message.includes(token), false);
    assert.equal(JSON.stringify(error.findings).includes(token), false);
    return true;
  };
}

// Exclusion predicate from the owner's supplied src/policy.mjs, plus `.agents`
// (project agent skills). Keeping this independent catches accidental additions
// to the readable rule table.
function originalExcluded(name) {
  return (
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.hg|\.svn|node_modules|vendor|\.venv|venv|__pycache__|\.cache|\.next|\.nuxt|coverage|\.playground|\.sites-runtime|\.wrangler|\.aws|\.ssh|\.gnupg|\.codex|\.claude|\.agents|\.openai|\.npmrc|\.pypirc|\.netrc|credentials[^/]*|secrets?[^/]*|id_rsa|id_ed25519|service[-_]?account[^/]*)(?:\/|$)/i.test(
      name,
    ) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|log)$/i.test(name) ||
    /(?:^|\/)(?:conversations?|chats?|messages?|users?)\.(?:json|jsonl|html|csv|txt)$/i.test(name)
  );
}

test('named exclusions match the original bundle predicate without additional private-file rules', () => {
  const components = [
    '.env',
    '.env.local',
    '.env.',
    '.git',
    '.hg',
    '.svn',
    'node_modules',
    'vendor',
    '.venv',
    'venv',
    '__pycache__',
    '.cache',
    '.next',
    '.nuxt',
    'coverage',
    '.playground',
    '.sites-runtime',
    '.wrangler',
    '.aws',
    '.ssh',
    '.gnupg',
    '.codex',
    '.claude',
    '.agents',
    '.openai',
    '.npmrc',
    '.pypirc',
    '.netrc',
    'credentials',
    'credentials.json',
    'secret',
    'secrets.json',
    'id_rsa',
    'id_ed25519',
    'service-account.json',
    'service_account.json',
    'serviceaccount.json',
    'private.pem',
    'private.key',
    'private.p12',
    'private.pfx',
    'private.jks',
    'private.keystore',
    'output.log',
    'conversations.json',
    'chat.jsonl',
    'messages.html',
    'user.csv',
    'users.txt',
    '.envrc',
    '.git-credentials',
    '.azure',
    '.config',
    '.docker',
    '.kube',
    '.cursor',
    '.aider.conf',
    '.history',
    '.idea',
    '.vscode',
    '.DS_Store',
    'app.js.map',
    'dist',
    'build',
    'out',
    'conversation.md',
    'users.sqlite',
    'README',
    'index.html',
    'mycredentials.json',
  ];
  for (const component of components) {
    for (const name of [
      component,
      component.toUpperCase(),
      `nested/${component}`,
      `${component}/file.txt`,
      `prefix-${component}`,
    ]) {
      assert.equal(Boolean(builtInExclusion(name)), originalExcluded(name), name);
    }
  }
});

test('source and build archives preserve every regular-file format and extension byte for byte', async (t) => {
  const root = await fixture(t);
  const tar = Buffer.alloc(512);
  tar.write('ustar', 257);
  const entries = {
    'picture.PNG': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]),
    'font.woff2': Buffer.concat([Buffer.from('wOF2'), opaqueBytes]),
    'sound.mp3': Buffer.concat([Buffer.from('ID3'), opaqueBytes]),
    'movie.mp4': Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), opaqueBytes]),
    'program.wasm': Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    'model.glb': Buffer.concat([Buffer.from('glTF'), opaqueBytes]),
    'content.custom-format': opaqueBytes,
    'program.exe': Buffer.concat([Buffer.from('MZ'), opaqueBytes]),
    'program.elf': Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), opaqueBytes]),
    'database.sqlite': Buffer.from('SQLite format 3\0'),
    'archive.zip': Buffer.from(zipSync({ 'inside.txt': Buffer.from('Ordinary content') })),
    'archive.tar': tar,
    'archive-disguised.png': Buffer.from(zipSync({ 'inside.txt': opaqueBytes })),
    'fragment.glsl': Buffer.from('void main() { gl_FragColor = vec4(1.0); }\n'),
    'compute.wgsl': Buffer.from('@compute @workgroup_size(1) fn main() {}\n'),
    'scene.gltf': Buffer.from('{"asset":{"version":"2.0"}}'),
    'app.js.map': Buffer.from('{"version":3,"sourcesContent":["console.log(1)"]}'),
    PROJECT_NOTES: Buffer.from('An extensionless UTF-8 file: café and 日本語.\n'),
    'index.html': Buffer.from('<h1>Assets</h1>'),
  };
  for (const build of [false, true]) {
    const directory = build ? path.join(root, 'dist') : root;
    await fs.mkdir(directory, { recursive: true });
    for (const [filename, contents] of Object.entries(entries)) {
      await fs.writeFile(path.join(directory, filename), contents);
    }
    const packed = await packProject(directory, { build, projectRoot: root });
    const archive = unzipSync(Buffer.from(packed.data, 'base64'));
    const orderedNames = Object.keys(entries).sort((a, b) => a.localeCompare(b, 'en'));
    assert.deepEqual(
      packed.files.map((file) => file.path),
      orderedNames,
    );
    for (const [filename, contents] of Object.entries(entries)) {
      assert.deepEqual(Buffer.from(archive[filename]), contents, filename);
      const summary = packed.files.find((file) => file.path === filename);
      assert.equal(summary.bytes, contents.length, filename);
      assert.equal(summary.sha256, createHash('sha256').update(contents).digest('hex'), filename);
    }
    assert.equal(
      packed.bytes,
      Object.values(archive).reduce((bytes, file) => bytes + file.length, 0),
    );
  }
});

test('literal bundle credential patterns still reject text inside arbitrary binary files', async (t) => {
  const root = await fixture(t);
  const token = fakeToken();
  await fs.writeFile(
    path.join(root, 'image.custom'),
    Buffer.concat([opaqueBytes, Buffer.from(`\n${token}\n`), opaqueBytes]),
  );
  await assert.rejects(packProject(root), credentialFailure(token));
});

test('encoded, UTF-16, generic assignments, and credential-shaped filenames match original acceptance', async (t) => {
  const root = await fixture(t);
  const token = fakeToken();
  const utf16 = Buffer.from(token, 'utf16le');
  const entries = {
    'encoded.txt': Buffer.from(`data:text/plain;base64,${Buffer.from(token).toString('base64')}`),
    'utf16.bin': utf16,
    'utf16be.dat': Buffer.from(utf16).swap16(),
    'assignments.txt': Buffer.from('password="example"; api_key="demo"; access_token="ordinary";'),
    [`${token}.txt`]: Buffer.from('The filename is not scanned by the original bundle.'),
  };
  for (const [filename, contents] of Object.entries(entries))
    await fs.writeFile(path.join(root, filename), contents);
  const packed = await packProject(root);
  const archive = unzipSync(Buffer.from(packed.data, 'base64'));
  for (const [filename, contents] of Object.entries(entries))
    assert.deepEqual(Buffer.from(archive[filename]), contents);
});

test('removed exclusions are included while original private paths remain omitted', async (t) => {
  const root = await fixture(t);
  const allowed = [
    '.envrc',
    '.git-credentials',
    '.azure/file',
    '.config/file',
    '.docker/file',
    '.kube/file',
    '.cursor/file',
    '.aider.conf',
    '.history/file',
    '.idea/file',
    '.vscode/file',
    '.DS_Store',
    'app.js.map',
  ];
  const privatePaths = [
    '.env',
    '.aws/file',
    '.claude/file',
    '.agents/skills/playground-upload/SKILL.md',
    'credentials.json',
    'nested/private.key',
    'users.txt',
  ];
  for (const filename of [...allowed, ...privatePaths]) {
    await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
    await fs.writeFile(path.join(root, filename), 'Ordinary fixture data');
  }
  const packed = await packProject(root);
  assert.deepEqual(packed.files.map((file) => file.path).sort(), allowed.sort());
  for (const filename of privatePaths)
    assert.ok(!packed.files.some((file) => file.path === filename));
  assert.ok(packed.skipped.every((file) => file.source === 'built-in' && file.rule));
});

test('explicit build roots use artifact-relative exclusions while project ignores use project-relative paths', async (t) => {
  const root = await fixture(t);
  const buildRoot = path.join(root, 'credentials-output');
  await fs.mkdir(buildRoot);
  await fs.writeFile(path.join(buildRoot, 'index.html'), '<h1>Build</h1>');
  await fs.writeFile(path.join(buildRoot, 'app.js.map'), '{}');
  await fs.writeFile(path.join(buildRoot, 'local.dat'), opaqueBytes);
  await fs.writeFile(path.join(buildRoot, '.env'), fakeToken());
  await fs.writeFile(path.join(root, '.playgroundignore'), 'credentials-output/local.dat\n');
  const packed = await packProject(buildRoot, { build: true, projectRoot: root });
  assert.deepEqual(
    packed.files.map((file) => file.path),
    ['app.js.map', 'index.html'],
  );
  assert.ok(
    packed.skipped.some(
      (file) => file.path === 'credentials-output/.env' && file.source === 'built-in',
    ),
  );
  assert.ok(
    packed.skipped.some(
      (file) => file.path === 'credentials-output/local.dat' && file.source === 'playgroundignore',
    ),
  );
});

test('source build-output omission matches the original case-sensitive directory names', async (t) => {
  for (const name of ['dist', 'build', 'out', 'DIST', 'Build', 'OUT']) {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'main.ts'), 'export {};');
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'index.html'), '<h1>Output</h1>');
    const packed = await packProject(root);
    const present = packed.files.some((file) => file.path === `${name}/index.html`);
    assert.equal(present, !['dist', 'build', 'out'].includes(name), name);
  }
});

test('directory wildcard rules preserve explicit child exceptions using the original matcher behavior', async (t) => {
  const rules = 'foo/*\n!foo/keep/\n';
  assert.equal(ignore().add(rules).test('foo/').ignored, false);
  for (const { filename, source, build } of [
    { filename: '.gitignore', source: 'gitignore', build: false },
    { filename: '.playgroundignore', source: 'playgroundignore', build: false },
    { filename: '.playgroundignore', source: 'playgroundignore', build: true },
  ]) {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, filename), rules);
    await fs.writeFile(path.join(root, 'index.html'), '<h1>Ignore exceptions</h1>');
    for (const folder of ['keep', 'drop']) {
      await fs.mkdir(path.join(root, 'foo', folder), { recursive: true });
      await fs.writeFile(path.join(root, 'foo', folder, 'app.js'), 'console.log(1);');
    }

    const packed = await packProject(root, { build });
    assert.ok(packed.files.some((file) => file.path === 'foo/keep/app.js'));
    assert.equal(
      packed.files.some((file) => file.path === 'foo/drop/app.js'),
      false,
    );
    assert.deepEqual(
      packed.skipped.find((file) => file.path === 'foo/drop'),
      {
        path: 'foo/drop',
        source,
        rule: 'foo/*',
        reason: filename,
        ignoreFile: filename,
        line: 1,
      },
    );
    assert.equal(
      packed.skipped.some((file) => file.path === 'foo'),
      false,
    );
  }
});

test('nested directory negations reverse inherited exclusions as original matcher.test does', async (t) => {
  const root = await fixture(t);
  const inherited = 'foo/\n';
  const nested = '!foo/\n!foo/**\n';
  assert.equal(ignore().add(inherited).test('nested/foo/').ignored, true);
  assert.equal(ignore().add(nested).test('foo/').unignored, true);
  const scopes = [
    parseIgnoreFile(inherited, { directory: root, file: '.gitignore', source: 'gitignore' }),
    parseIgnoreFile(nested, {
      directory: path.join(root, 'nested'),
      file: 'nested/.gitignore',
      source: 'gitignore',
    }),
  ];
  assert.equal(matchIgnoreFiles(path.join(root, 'nested/foo'), true, scopes), undefined);

  await fs.mkdir(path.join(root, 'foo'), { recursive: true });
  await fs.mkdir(path.join(root, 'nested/foo'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), inherited);
  await fs.writeFile(path.join(root, 'nested/.gitignore'), nested);
  await fs.writeFile(path.join(root, 'foo/omitted.txt'), 'Root directory stays ignored');
  await fs.writeFile(path.join(root, 'nested/foo/keep.txt'), 'Nested exception survives');
  const packed = await packProject(root);
  assert.ok(packed.files.some((file) => file.path === 'nested/foo/keep.txt'));
  assert.equal(
    packed.files.some((file) => file.path === 'foo/omitted.txt'),
    false,
  );
  assert.deepEqual(
    packed.skipped.find((file) => file.path === 'foo'),
    {
      path: 'foo',
      source: 'gitignore',
      rule: 'foo/',
      reason: '.gitignore',
      ignoreFile: '.gitignore',
      line: 1,
    },
  );
});

test('ignore-file parsing does not add content checks before normal file selection', async (t) => {
  for (const filename of ['.gitignore', '.playgroundignore']) {
    const root = await fixture(t);
    const token = fakeToken();
    const comment = Buffer.concat([Buffer.from(`# ${token}\n# `), opaqueBytes]);
    await fs.writeFile(path.join(root, 'main.ts'), 'export {};');
    await fs.writeFile(
      path.join(root, filename),
      Buffer.concat([Buffer.from(`${filename}\n`), comment]),
    );
    assert.deepEqual(
      (await packProject(root)).files.map((file) => file.path),
      ['main.ts'],
    );
    await fs.writeFile(path.join(root, filename), comment);
    await assert.rejects(packProject(root), credentialFailure(token));
  }
});

test(
  'unsafe names and nonregular files are omitted without rejecting the project',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fixture(t);
    await fs.writeFile(path.join(root, 'main.ts'), 'export {};');
    await fs.writeFile(path.join(root, 'unsafe:name.txt'), 'Fixture');
    execFileSync('mkfifo', [path.join(root, 'local.pipe')]);
    await fs.symlink(path.join(root, 'main.ts'), path.join(root, 'linked.ts'));
    const packed = await packProject(root);
    assert.deepEqual(
      packed.files.map((file) => file.path),
      ['main.ts'],
    );
    const skipped = Object.fromEntries(packed.skipped.map((file) => [file.path, file.rule]));
    assert.deepEqual(skipped, {
      'linked.ts': 'symbolic-links',
      'local.pipe': 'nonregular-file',
      'unsafe:name.txt': 'unsafe-path',
    });
  },
);

test('source files above the previous 4 MiB restriction are accepted under the bundle limit', async (t) => {
  const root = await fixture(t);
  const contents = Buffer.alloc(5 * MIB);
  await fs.writeFile(path.join(root, 'large.data'), contents);
  const packed = await packProject(root);
  assert.equal(packed.files[0].bytes, contents.length);
  assert.deepEqual(
    Buffer.from(unzipSync(Buffer.from(packed.data, 'base64'))['large.data']),
    contents,
  );
});

test('source and browser per-file limits remain 50 MiB and 3 MiB', async (t) => {
  assert.equal(INSPECTION_LIMITS.sourceFileBytes, 50 * MIB);
  assert.equal(INSPECTION_LIMITS.buildFileBytes, 3 * MIB);
  for (const build of [false, true]) {
    const root = await fixture(t);
    const limit = build ? INSPECTION_LIMITS.buildFileBytes : INSPECTION_LIMITS.sourceFileBytes;
    await fs.writeFile(path.join(root, 'index.html'), '<h1>Limits</h1>');
    const filename = path.join(root, 'large.bin');
    await fs.writeFile(filename, '');
    await fs.truncate(filename, limit + 1);
    await assert.rejects(
      packProject(root, { build }),
      (error) =>
        error instanceof ScanError &&
        error.findings.some((finding) => finding.rule === 'inspection/file-size-limit'),
    );
  }
});

test('browser file-count limits remain unchanged for arbitrary asset types', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Limits</h1>');
  await Promise.all(
    Array.from({ length: INSPECTION_LIMITS.buildFileCount }, (_, index) =>
      fs.writeFile(path.join(root, `asset-${index}.unknown`), opaqueBytes),
    ),
  );
  await assert.rejects(packProject(root, { build: true }), /browser build.*limits/);
});
