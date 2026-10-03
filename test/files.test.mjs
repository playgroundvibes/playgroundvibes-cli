import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { packProject as pack } from '../dist/artifacts/pack-project.js';
import { resolveProjectPath as within } from '../dist/filtering/collect-files.js';
import { inspectFileContents } from '../dist/filtering/inspect-file.js';
import { scanText, ScanError, CREDENTIAL_PATTERNS } from '../dist/filtering/index.js';
import { MIB } from '../dist/filtering/limits.js';

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

// Independent fixture copied from the supplied bundle's src/policy.mjs hasSecret.
// Keep this combined expression separate from the package's named pattern table.
const originalHasSecret = (content) =>
  /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY)-----|\b(?:pgimport_[a-f0-9]{64}|pgsync_[a-f0-9]{64}|sk-(?:proj-|ant-api\d+-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(
    content,
  );

test('source packaging is deterministic and reports exact ZIP bytes and exclusions', async (t) => {
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
  for (const name of ['src/main.ts', '.envrc', '.git-credentials']) assert(names.includes(name));
  for (const name of [
    'src/ignored.ts',
    'test.tmp',
    '.env',
    '.env.example',
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

test('custom exclusions affect source and build, while source maps use the normal content check', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'main.ts'), 'export {};');
  await fs.writeFile(path.join(root, 'private.txt'), fakeToken());
  await fs.writeFile(path.join(root, '.playgroundignore'), 'private.txt\ndist/private.json\n');
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>App</h1>');
  await fs.writeFile(path.join(root, 'dist/private.json'), fakeToken());
  await fs.writeFile(
    path.join(root, 'dist/main.js.map'),
    JSON.stringify({ sourcesContent: ['hello'] }),
  );
  assert(!(await pack(root)).files.some((file) => file.path === 'private.txt'));
  const build = await pack(path.join(root, 'dist'), { build: true, projectRoot: root });
  assert.deepEqual(
    build.files.map((file) => file.path),
    ['index.html', 'main.js.map'],
  );
  assert(
    build.skipped.some(
      (file) => file.path === 'dist/private.json' && file.reason === '.playgroundignore',
    ),
  );
  await fs.writeFile(
    path.join(root, 'dist/main.js.map'),
    JSON.stringify({ sourcesContent: [fakeToken()] }),
  );
  await assert.rejects(
    pack(path.join(root, 'dist'), { build: true, projectRoot: root }),
    safeFailure(fakeToken()),
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

test('credential checks match the supplied bundle patterns and word boundaries', async () => {
  const tokens = [
    'pgimport_' + 'a'.repeat(64),
    'pgsync_' + 'b'.repeat(64),
    'sk-' + 'a'.repeat(20),
    'sk-proj-' + 'a'.repeat(20),
    'sk-ant-' + 'a'.repeat(20),
    'sk-ant-api03-' + 'a'.repeat(20),
    ...[...'pousr'].map((letter) => 'gh' + letter + '_' + 'a'.repeat(24)),
    'github_pat_' + 'a_'.repeat(12),
    'AKIA' + 'A1'.repeat(8),
    'ASIA' + 'A1'.repeat(8),
    ...[...'baprs'].map((letter) => 'xox' + letter + '-' + 'a1'.repeat(10)),
    '-----BEGIN ' + 'PRIVATE KEY-----',
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----',
  ];
  const samples = tokens.flatMap((token) => [
    token,
    `before\n${token}\nafter`,
    'x' + token,
    '_' + token,
    token + '_',
    token + '-',
    token.slice(0, -1),
    token.toUpperCase(),
  ]);
  samples.push(
    'pgimport_' + 'A'.repeat(64),
    'pgsync_' + 'a'.repeat(65),
    'ghq_' + 'a'.repeat(40),
    'xoxz-' + 'a'.repeat(40),
    '-----BEGIN PUBLIC KEY-----',
    '-----begin PRIVATE KEY-----',
    'plain text',
  );
  for (const [index, content] of samples.entries()) {
    const expected = originalHasSecret(content);
    assert.equal(
      CREDENTIAL_PATTERNS.some(({ pattern }) => new RegExp(pattern).test(content)),
      expected,
      `pattern fixture ${index}`,
    );
    if (expected) await assert.rejects(scanText(content, 'fixture.txt'), ScanError);
    else await scanText(content, 'fixture.txt');
  }
  assert(Object.isFrozen(CREDENTIAL_PATTERNS));
  assert(CREDENTIAL_PATTERNS.every(Object.isFrozen));
});

test('known raw credentials report locations without their matched values', async () => {
  const token = fakeToken();
  await assert.rejects(
    scanText(`const title = 'app';\nconst value = '${token}';`, 'main.ts'),
    (error) => {
      safeFailure(token)(error);
      assert.deepEqual(error.findings, [
        { path: 'main.ts', line: 2, rule: 'credential/provider-token' },
      ]);
      return true;
    },
  );
  await assert.rejects(
    scanText(JSON.stringify({ source_id: token }), 'project metadata'),
    safeFailure(token),
  );
});

test('generic assignments, URL values, and additional provider formats remain allowed', async () => {
  for (const content of [
    'const apiKey = "opaque-local-test-value";',
    'PASSWORD=opaque-local-test-value',
    'password: opaque-local-test-value',
    'https://example.test/?api_key=opaque-local-test-value',
    'https://person:opaque-local-test-value@example.test',
    'Authorization: Bearer opaque-local-test-value',
    'npm_' + 'a'.repeat(40),
    'AIza' + 'a'.repeat(40),
    'sk_live_' + 'aB3'.repeat(12),
    'eyJ' + 'a'.repeat(10) + '.' + 'a'.repeat(10) + '.' + 'a'.repeat(10),
    'const token = process.env.API_KEY;',
    'token: "${{ secrets.NPM_TOKEN }}"',
  ]) {
    assert.equal(originalHasSecret(content), false);
    await scanText(content, 'config.yaml');
  }
});

test('encoded strings and control characters are not decoded or rejected by the original policy', async () => {
  const token = fakeToken();
  const forms = [
    [...token].map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join(''),
    [...token].map((c) => '\\x' + c.charCodeAt(0).toString(16)).join(''),
    Buffer.from(token).toString('hex'),
    [...token].map((c) => '%' + c.charCodeAt(0).toString(16)).join(''),
    [...token].map((c) => '&#' + c.charCodeAt(0) + ';').join(''),
    Buffer.from(token).toString('base64'),
    Buffer.from(Buffer.from(token).toString('base64')).toString('base64'),
    Buffer.from(token, 'utf16le').toString('utf8'),
    String.raw`metadata %FF%AB%81 \\u{110000} &#x110000;`,
    'raw\0control\x01characters',
  ];
  for (const form of forms) {
    assert.equal(originalHasSecret(form), false);
    await scanText(`const data = '${form}';`, 'main.ts');
  }
  await scanText('a'.repeat(4 * MIB + 1), 'large.ts');
});

test('all file bytes use replacement-decoded UTF-8 and remain unchanged', async () => {
  for (const bytes of [
    Buffer.from([0xff, 0xfe, 0xfd]),
    Buffer.from([0x50, 0x4b, 3, 4, 0, 1, 2]),
    Buffer.from('SQLite format 3\0data'),
    Buffer.from('MZ\0binary payload'),
    Buffer.from(fakeToken(), 'utf16le'),
  ]) {
    const original = Buffer.from(bytes);
    assert.equal(originalHasSecret(bytes.toString('utf8')), false);
    await inspectFileContents(bytes, 'asset.unknown');
    assert.deepEqual(bytes, original);
  }
  const rawToken = Buffer.concat([
    Buffer.from([0xff, 0, 1]),
    Buffer.from(fakeToken()),
    Buffer.from([0xfe]),
  ]);
  assert.equal(originalHasSecret(rawToken.toString('utf8')), true);
  await assert.rejects(inspectFileContents(rawToken, 'asset.unknown'), safeFailure(fakeToken()));
});

test('browser builds include opaque assets and still scan gitignored output for raw credentials', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/');
  await fs.writeFile(path.join(root, 'dist/index.html'), '<h1>App</h1>');
  const bytes = Buffer.from([0xff, 0xfe, 0x50, 0x4b, 3, 4, 0, 1]);
  await fs.writeFile(path.join(root, 'dist/asset.custom'), bytes);
  const packed = await pack(path.join(root, 'dist'), { build: true, projectRoot: root });
  const unpacked = unzipSync(Buffer.from(packed.data, 'base64'));
  assert.deepEqual(Buffer.from(unpacked['asset.custom']), bytes);
  await fs.writeFile(path.join(root, 'dist/main.js'), `const apiKey = '${fakeToken()}';`);
  await assert.rejects(
    pack(path.join(root, 'dist'), { build: true, projectRoot: root }),
    safeFailure(fakeToken()),
  );
});

test('tracked browser builds such as build_dir ".." keep .gitignore rules', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, '.gitignore'), 'config.local.js\npublic/secret.local.js\n');
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Static</h1>');
  await fs.writeFile(path.join(root, 'app.js'), 'console.log(1);');
  await fs.writeFile(path.join(root, 'config.local.js'), 'window.LOCAL = 1;');
  const whole = await pack(root, { build: true, projectRoot: root });
  const wholeFiles = Object.keys(unzipSync(Buffer.from(whole.data, 'base64')));
  assert.ok(wholeFiles.includes('app.js'));
  assert.equal(wholeFiles.includes('config.local.js'), false);
  assert.ok(
    whole.skipped.some((file) => file.path === 'config.local.js' && file.source === 'gitignore'),
  );

  await fs.mkdir(path.join(root, 'public'));
  await fs.writeFile(path.join(root, 'public/index.html'), '<h1>Public</h1>');
  await fs.writeFile(path.join(root, 'public/secret.local.js'), 'window.LOCAL = 2;');
  const nested = await pack(path.join(root, 'public'), { build: true, projectRoot: root });
  assert.deepEqual(Object.keys(unzipSync(Buffer.from(nested.data, 'base64'))), ['index.html']);
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
        if (property === 'createReadStream')
          return (...streamArgs) => {
            reads.set(file, (reads.get(file) ?? 0) + 1);
            const stream = target.createReadStream(...streamArgs);
            return (async function* () {
              for await (const chunk of stream) yield chunk;
              if (file === path.join(root, 'main.ts'))
                await fs.writeFile(file, 'changed after reading');
            })();
          };
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
  // As in the original uploader, ignore rules are read before selected files are inspected.
  assert.equal(reads.get(path.join(root, '.gitignore')), 2);
  assert.equal(
    Buffer.from(unzipSync(Buffer.from(result.data, 'base64'))['main.ts']).toString(),
    originalText,
  );
});
