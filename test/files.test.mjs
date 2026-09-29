import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import { packProject as pack } from '../dist/artifacts/pack-project.js';
import { resolveProjectPath as within } from '../dist/filtering/collect-files.js';
import { scanText, ScanError } from '../dist/filtering/index.js';
import { MIB } from '../dist/filtering/file-types.js';
import { identifyBinaryFormat } from '../dist/filtering/binary-signatures.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'playground-files-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const fakeToken = () => 'sk-proj-' + 'a1'.repeat(24);
const safeFailure = (value) => (error) => {
  assert(error instanceof ScanError);
  assert(error.findings.length > 0);
  assert(!error.message.includes(value));
  assert(!JSON.stringify(error.findings).includes(value));
  return true;
};

test('TypeScript source packaging is deterministic and reports exact ZIP bytes and exclusions', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/\n*.tmp\n');
  await fs.writeFile(path.join(root, 'src/.gitignore'), 'ignored.ts\n');
  for (const filename of [
    'src/main.ts',
    'src/ignored.ts',
    'test.tmp',
    '.env',
    '.env.example',
    '.envrc',
    '.git-credentials',
    'node_modules/lib.js',
    'dist/index.html',
  ]) {
    await fs.writeFile(
      path.join(root, filename),
      filename === 'src/main.ts' ? 'export const answer: number = 42;\n' : 'example',
    );
  }
  const a = await pack(root),
    b = await pack(root);
  assert.equal(a.data, b.data);
  const names = a.files.map((file) => file.path);
  assert(names.includes('src/main.ts'));
  for (const name of [
    'src/ignored.ts',
    'test.tmp',
    '.env',
    '.env.example',
    '.envrc',
    '.git-credentials',
    'node_modules/lib.js',
    'dist/index.html',
  ])
    assert(!names.includes(name), name);
  const unpacked = unzipSync(Buffer.from(a.data, 'base64'));
  for (const file of a.files) {
    assert.equal(unpacked[file.path].length, file.bytes);
    assert.equal(createHash('sha256').update(unpacked[file.path]).digest('hex'), file.sha256);
  }
  assert(a.skipped.every((file) => file.path && file.reason));
  const build = await pack(path.join(root, 'dist'), { build: true, projectRoot: root });
  assert.deepEqual(
    build.files.map((file) => file.path),
    ['index.html'],
  );
});

test('custom exclusions affect source and build; source maps are excluded with reasons', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'main.ts'), 'export {};');
  await fs.writeFile(path.join(root, 'private.txt'), 'private');
  await fs.writeFile(path.join(root, '.playgroundignore'), 'private.txt\ndist/private.json\n');
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>App</h1>');
  await fs.writeFile(path.join(root, 'dist/private.json'), '{}');
  await fs.writeFile(
    path.join(root, 'dist/main.js.map'),
    JSON.stringify({ sourcesContent: [fakeToken()] }),
  );
  assert(!(await pack(root)).files.some((file) => file.path === 'private.txt'));
  const build = await pack(path.join(root, 'dist'), { build: true, projectRoot: root });
  assert.deepEqual(
    build.files.map((file) => file.path),
    ['index.html'],
  );
  assert(
    build.skipped.some(
      (file) => file.path === 'dist/main.js.map' && /source maps/.test(file.reason),
    ),
  );
  assert(
    build.skipped.some(
      (file) => file.path === 'dist/private.json' && file.reason === '.playgroundignore',
    ),
  );
});

test('exclusion reports identify the built-in rule or exact ignore file and line', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(
    path.join(root, '.gitignore'),
    '# generated files\n*.tmp\n*.ts\n!keep.ts\n!.env\n',
  );
  await fs.writeFile(path.join(root, 'src/.gitignore'), '!keep.ts\nlocal.ts\n');
  await fs.writeFile(
    path.join(root, '.playgroundignore'),
    '# selected exclusions\nsrc/notes.txt\n',
  );
  for (const name of [
    'keep.ts',
    'cache.tmp',
    '.env',
    'src/keep.ts',
    'src/local.ts',
    'src/blocked.ts',
    'src/notes.txt',
  ]) {
    await fs.writeFile(path.join(root, name), 'ordinary fixture content');
  }
  const result = await pack(root);
  const excluded = Object.fromEntries(result.skipped.map((file) => [file.path, file]));
  assert.deepEqual(excluded['.env'], {
    path: '.env',
    source: 'built-in',
    rule: 'environment-files',
    reason: 'environment file',
  });
  assert.deepEqual(excluded['cache.tmp'], {
    path: 'cache.tmp',
    source: 'gitignore',
    rule: '*.tmp',
    reason: '.gitignore',
    ignoreFile: '.gitignore',
    line: 2,
  });
  assert.deepEqual(excluded['src/local.ts'], {
    path: 'src/local.ts',
    source: 'gitignore',
    rule: 'local.ts',
    reason: '.gitignore',
    ignoreFile: 'src/.gitignore',
    line: 2,
  });
  assert.deepEqual(excluded['src/blocked.ts'], {
    path: 'src/blocked.ts',
    source: 'gitignore',
    rule: '*.ts',
    reason: '.gitignore',
    ignoreFile: '.gitignore',
    line: 3,
  });
  assert.deepEqual(excluded['src/notes.txt'], {
    path: 'src/notes.txt',
    source: 'playgroundignore',
    rule: 'src/notes.txt',
    reason: '.playgroundignore',
    ignoreFile: '.playgroundignore',
    line: 2,
  });
  assert(
    result.files.some((file) => file.path === 'src/keep.ts'),
    'nested ignore negation should preserve this file',
  );
});

test('binary format identification distinguishes TAR offsets and RIFF subtypes', () => {
  const tar = Buffer.alloc(512);
  tar.write('ustar', 257);
  assert.equal(identifyBinaryFormat(tar), 'TAR archive');
  assert.equal(identifyBinaryFormat(Buffer.from('ustar')), undefined);
  assert.equal(identifyBinaryFormat(Buffer.from('RIFF1234WEBP')), 'WebP image');
  assert.equal(identifyBinaryFormat(Buffer.from('RIFF1234WAVE')), 'WAVE audio');
  assert.equal(identifyBinaryFormat(Buffer.from('RIFF1234TEXT')), undefined);
});

test('provider tokens, generic assignments, URL credentials, and metadata are blocked without values', async () => {
  const token = fakeToken();
  for (const content of [
    token,
    'const apiKey = "opaque-local-test-value";',
    'PASSWORD=opaque-local-test-value',
    'https://example.test/?api_key=opaque-local-test-value',
    'https://person:opaque-local-test-value@example.test',
    JSON.stringify({ source_id: token }),
  ]) {
    await assert.rejects(
      scanText(content, 'project metadata'),
      safeFailure(content.includes(token) ? token : 'opaque-local-test-value'),
    );
  }
});

test('fixed Secretlint rules cannot be suppressed by inline comments or repository configuration', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.secretlintrc.json'), JSON.stringify({ rules: [] }));
  // Stripe is supplied by Secretlint, not by the supplementary provider regex.
  const token = 'sk_live_' + 'aB3'.repeat(12);
  await fs.writeFile(path.join(root, 'main.ts'), '// secretlint-disable\n// ' + token);
  await assert.rejects(pack(root), (error) => {
    safeFailure(token)(error);
    assert(error.findings.some((finding) => finding.rule === '@secretlint/secretlint-rule-stripe'));
    return true;
  });
});

test('Unicode, hex, percent, base64, and nested base64 tokens are inspected', async () => {
  const token = fakeToken();
  const forms = [
    [...token].map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join(''),
    Buffer.from(token).toString('hex'),
    [...token].map((c) => '%' + c.charCodeAt(0).toString(16)).join(''),
    [...token].map((c) => '&#' + c.charCodeAt(0) + ';').join(''),
    Buffer.from(token).toString('base64'),
    Buffer.from(Buffer.from(token).toString('base64')).toString('base64'),
  ];
  for (const form of forms) {
    await assert.rejects(scanText(`const encoded = '${form}';`, 'main.ts'), safeFailure(token));
  }
});

test('plain config credentials block while runtime environment references stay usable', async () => {
  await assert.rejects(
    scanText('password: opaque-local-test-value', 'config.yaml'),
    safeFailure('opaque-local-test-value'),
  );
  await assert.rejects(
    scanText('const OPENAI_API_KEY = "opaque-local-test-value";', 'main.ts'),
    safeFailure('opaque-local-test-value'),
  );
  await scanText(
    'const token = process.env.API_KEY; const value = Buffer.from("hello");',
    'main.ts',
  );
  await scanText('token: "${{ secrets.NPM_TOKEN }}"', 'workflow.yml');
});

test('archives and databases are blocked, including archives disguised as plain text', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'main.ts'), 'export {};');
  const archive = Buffer.from(zipSync({ '.env': Buffer.from('API_KEY=' + fakeToken()) }));
  await fs.writeFile(path.join(root, 'backup.zip'), archive);
  await assert.rejects(pack(root), /unsupported-file-type/);
  await fs.rename(path.join(root, 'backup.zip'), path.join(root, 'backup.json'));
  await assert.rejects(pack(root), /binary-or-archive/);
  await fs.writeFile(path.join(root, 'backup.json'), Buffer.from('SQLite format 3\0data'));
  await assert.rejects(pack(root), /binary-or-archive/);
});

test('UTF-16, malformed UTF-8, and explicit encoded binary data are blocked', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'main.ts'), Buffer.from(fakeToken(), 'utf16le'));
  await assert.rejects(pack(root), /binary-or-archive/);
  await fs.writeFile(path.join(root, 'main.ts'), Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(pack(root), /binary-or-archive/);
  await assert.rejects(
    scanText('const image = "data:image/png;base64,AAECAwQFBgcICQ==";', 'main.ts'),
    /encoded-binary/,
  );
  const encodedArchive = Buffer.from(
    zipSync({ '.env': Buffer.from('API_KEY=' + fakeToken()) }),
  ).toString('base64');
  await assert.rejects(scanText(`const data = "${encodedArchive}";`, 'main.ts'), /encoded-binary/);
  await assert.rejects(
    scanText(Buffer.from(fakeToken(), 'utf16le').toString('base64'), 'main.ts'),
    safeFailure(fakeToken()),
  );
});

test('incidental source ID hashes do not become binary payloads when decoded heuristically', async () => {
  const root = '/private/tmp/playground-skill-forward-135662/typescript-app';
  const digest = createHash('sha256').update(root).digest('hex');
  assert.equal(digest.slice(0, 4), '4d5a'); // Coincidentally decodes to the weak DOS magic MZ.
  const metadata = {
    title: 'TypeScript app',
    summary: 'A minimal browser greeting built from TypeScript.',
    source_id: 'cli-' + digest,
  };
  await scanText(JSON.stringify(metadata), 'project metadata');
  await scanText(JSON.stringify('0'.repeat(64)), 'project metadata');
  const encoded = Buffer.from(digest, 'hex').toString('base64');
  await scanText(JSON.stringify({ digest: encoded }), 'project metadata');
  // Explicit decoder operands still promise a payload and must be inspectable.
  await assert.rejects(scanText(`atob('${encoded}')`, 'main.ts'), /encoded-binary/);
});

test('encoded binary findings report the original operand line', async () => {
  const source = [
    'const heading = "Browser app";',
    'const count = 1;',
    'const image = "data:image/png;base64,AAECAwQFBgcICQ==";',
  ].join('\n');
  await assert.rejects(scanText(source, 'main.ts'), (error) => {
    assert(error instanceof ScanError);
    assert.deepEqual(error.findings, [
      { path: 'main.ts', line: 3, rule: 'inspection/encoded-binary' },
    ]);
    return true;
  });
});

test('browser builds reject unsupported assets and scan even gitignored output', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/');
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>App</h1>');
  await fs.writeFile(path.join(root, 'dist/photo.png'), Buffer.from([137, 80, 78, 71]));
  await assert.rejects(
    pack(path.join(root, 'dist'), { build: true, projectRoot: root }),
    /unsupported-file-type/,
  );
  await fs.rm(path.join(root, 'dist/photo.png'));
  await fs.writeFile(path.join(root, 'dist/main.js'), `const apiKey = '${fakeToken()}';`);
  await assert.rejects(
    pack(path.join(root, 'dist'), { build: true, projectRoot: root }),
    safeFailure(fakeToken()),
  );
});

test('symlinks cannot escape the project or select an artifact root', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'main.ts'), 'export {};');
  await fs.symlink(os.homedir(), path.join(root, 'outside'), 'junction');
  const result = await pack(root);
  assert(result.skipped.some((file) => file.path === 'outside' && file.reason === 'symbolic link'));
  await assert.rejects(within(root, 'outside/.ssh'), /symlink/);
  await assert.rejects(within(root, '../other'), /inside/);
  await assert.rejects(pack(path.join(root, 'outside'), { projectRoot: root }), /symlink/);
});

test('secret-bearing filenames are detected without leaking the filename', async (t) => {
  const root = await fixture(t);
  const token = fakeToken();
  await fs.writeFile(path.join(root, token + '.ts'), 'export {};');
  await assert.rejects(pack(root), (error) => {
    safeFailure(token)(error);
    assert(error.findings.every((finding) => finding.path === '[filename]'));
    return true;
  });
});

test('uninspectable size and decoding depth fail closed', async () => {
  await assert.rejects(scanText('a'.repeat(4 * MIB + 1), 'large.ts'), /text-size-limit/);
  let content = 'a sufficiently long text fixture without any credentials';
  for (let i = 0; i < 7; i++) content = Buffer.from(content).toString('base64');
  await assert.rejects(scanText(`const encoded = '${content}';`, 'nested.ts'), /decoding-limit/);
});

test('pack reads included files once and packages the inspected snapshot', async (t) => {
  const root = await fixture(t);
  const originalText = 'export const answer: number = 42;\n';
  await fs.writeFile(path.join(root, 'main.ts'), originalText);
  await fs.writeFile(path.join(root, '.gitignore'), '*.tmp\n');
  const originalOpen = fs.open;
  const reads = new Map();
  fs.open = async function (file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'readFile')
          return async (...readArgs) => {
            const result = await target.readFile(...readArgs);
            reads.set(file, (reads.get(file) ?? 0) + 1);
            if (file === path.join(root, 'main.ts'))
              await fs.writeFile(file, 'changed after reading');
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  t.after(() => {
    fs.open = originalOpen;
  });
  const result = await pack(root);
  assert.equal(reads.get(path.join(root, 'main.ts')), 1);
  assert.equal(reads.get(path.join(root, '.gitignore')), 1);
  assert.equal(
    Buffer.from(unzipSync(Buffer.from(result.data, 'base64'))['main.ts']).toString(),
    originalText,
  );
});
