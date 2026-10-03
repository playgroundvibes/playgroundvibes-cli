import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { createPlaygroundClient, ConsentError, ScanError } from '../dist/index.js';

async function fixture(t, manifest = {}) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'playground-deployment-')),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'app');
  const configDir = path.join(base, 'private');
  await fs.mkdir(path.join(root, '.playground'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'main.ts'), 'export const greeting: string = "hello";\n');
  await fs.writeFile(path.join(root, 'dist', 'index.html'), '<h1>Hello</h1>');
  await fs.writeFile(
    path.join(root, '.playground', 'manifest.json'),
    JSON.stringify({
      title: 'Hello',
      summary: 'A test project',
      build_dir: '../dist',
      ...manifest,
    }),
  );
  const calls = [];
  const control = { account: 'account-fixture', scope: undefined, fail: false, responseFields: {} };
  const request = async (endpoint, body, token) => {
    calls.push({ endpoint, body, token });
    if (endpoint === '/api/assistant/pair-redeem')
      return { account_id: control.account, status: 'connected' };
    if (endpoint === '/api/assistant/status')
      return {
        account_id: control.account,
        status: 'connected',
        ...(control.scope !== undefined ? { project_id: control.scope } : {}),
      };
    if (endpoint === '/api/assistant/import' || endpoint === '/api/assistant/deployment-status') {
      if (control.fail) throw new Error('Simulated network interruption');
      return {
        status: 'imported',
        id: 'project-fixture',
        version_id: 'version-fixture',
        url: '/#project/project-fixture',
        preview: 'ready',
        ...control.responseFields,
      };
    }
    throw new Error('Unexpected test endpoint');
  };
  const client = createPlaygroundClient({ cwd: root, configDir, request });
  return { base, root, configDir, calls, control, client };
}
const imports = (fixture) =>
  fixture.calls.filter((call) => call.endpoint === '/api/assistant/import');

test('offline inspection covers final metadata, source and build without state or network', async (t) => {
  const f = await fixture(t);
  const review = await f.client.inspect();
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.configDir), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.root, '.playground/project.json')), { code: 'ENOENT' });
  assert.ok(review.files.some((file) => file.artifact === 'source' && file.path === 'main.ts'));
  assert.ok(review.files.some((file) => file.artifact === 'build' && file.path === 'index.html'));
  assert.match(review.metadata.source_id, /^cli-/);
  assert.equal(review.metadata.license, 'All rights reserved');
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.metadata), true);
  assert.equal(Object.isFrozen(review.files[0]), true);
  await assert.rejects(f.client.deploy(review, { consent: review.digest }), ConsentError);
});

test('an omitted build_dir includes detected browser files in the review and actual import ZIP', async (t) => {
  const f = await fixture(t, { build_dir: undefined });
  const script = 'document.querySelector("h1").textContent = "Browser build loaded";';
  await fs.writeFile(path.join(f.root, 'dist/app.js'), script);
  const sourceMap = '{"version":3,"sources":["../src/main.ts"],"mappings":""}';
  const model = Buffer.from([0, 0xff, 0x80, 1, 2]);
  const html = '<h1>Hello</h1><script src="./app.js"></script>';
  await fs.writeFile(path.join(f.root, 'dist/app.js.map'), sourceMap);
  await fs.writeFile(path.join(f.root, 'dist/model.custom-binary'), model);
  await fs.writeFile(path.join(f.root, 'dist/index.html'), html);
  await fs.writeFile(path.join(f.root, '.gitignore'), 'dist/\n');
  await f.client.connect('ABCD2345');
  const review = await f.client.prepare();
  assert.deepEqual(
    review.files.filter((file) => file.artifact === 'build').map((file) => file.path),
    ['app.js', 'app.js.map', 'index.html', 'model.custom-binary'],
  );
  assert.equal(
    review.warnings.some((warning) => warning.startsWith('Source only:')),
    false,
  );
  await f.client.deploy(review, { consent: review.digest });
  assert.equal(imports(f).length, 1);
  const entry = imports(f)[0].body.projects[0];
  assert.equal(typeof entry.build, 'string');
  assert.match(entry.build, /^[A-Za-z0-9+/]+={0,2}$/);
  const archive = unzipSync(Buffer.from(entry.build, 'base64'));
  assert.deepEqual(Object.keys(archive), [
    'app.js',
    'app.js.map',
    'index.html',
    'model.custom-binary',
  ]);
  assert.equal(strFromU8(archive['app.js']), script);
  assert.equal(strFromU8(archive['app.js.map']), sourceMap);
  assert.equal(strFromU8(archive['index.html']), html);
  assert.deepEqual(Buffer.from(archive['model.custom-binary']), model);
  assert.ok(
    !review.files.some((file) => file.artifact === 'source' && file.path.startsWith('dist/')),
  );
  assert.equal(Object.hasOwn(entry, 'source_only'), false);
});

test('missing browser output blocks offline inspection and preparation before import or project writes', async (t) => {
  const f = await fixture(t, { build_dir: undefined });
  await fs.rm(path.join(f.root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'index.html'), '<h1>Root is not an automatic build</h1>');
  await assert.rejects(f.client.inspect(), /No browser build.*build_dir.*source_only/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.access(f.configDir), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.root, '.playground/project.json')), {
    code: 'ENOENT',
  });

  await f.client.connect('ABCD2345');
  const connectionPath = path.join(f.configDir, 'connection.json');
  const connection = await fs.readFile(connectionPath);
  await assert.rejects(f.client.prepare(), /No browser build/);
  assert.deepEqual(await fs.readFile(connectionPath), connection);
  assert.equal(imports(f).length, 0);
  await assert.rejects(fs.access(path.join(f.root, '.playground/project.json')), {
    code: 'ENOENT',
  });
});

test('explicit source-only publication omits browser artifacts and the local source_only field', async (t) => {
  const f = await fixture(t, { build_dir: undefined, source_only: true });
  await f.client.connect('ABCD2345');
  const review = await f.client.prepare();
  assert.ok(review.files.every((file) => file.artifact === 'source'));
  assert.ok(review.warnings.some((warning) => warning.startsWith('Source only:')));
  assert.equal(Object.hasOwn(review.metadata, 'source_only'), false);
  await f.client.deploy(review, { consent: review.digest });
  const entry = imports(f)[0].body.projects[0];
  assert.equal(Object.hasOwn(entry, 'build'), false);
  assert.equal(Object.hasOwn(entry, 'source_only'), false);
  assert.equal(typeof entry.source, 'string');
});

test('literal credentials in detected builds block without a source-only fallback', async (t) => {
  const secret = 'sk-proj-' + 'a'.repeat(44);
  for (const [filename, contents] of [
    ['app.js', `const credential = "${secret}";`],
    ['data.sqlite', Buffer.from('SQLite format 3\0' + secret)],
  ]) {
    const f = await fixture(t, { build_dir: undefined });
    await fs.writeFile(path.join(f.root, 'dist', filename), contents);
    await assert.rejects(
      f.client.inspect(),
      (error) => error instanceof ScanError && !error.message.includes(secret),
    );
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.access(f.configDir), { code: 'ENOENT' });
    await f.client.connect('ABCD2345');
    await assert.rejects(f.client.prepare());
    assert.equal(imports(f).length, 0);
    await assert.rejects(fs.access(path.join(f.root, '.playground/project.json')), {
      code: 'ENOENT',
    });
  }
});

test('missing, incorrect and forged consent never post artifacts or write project identity', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  const review = await f.client.prepare();
  await assert.rejects(f.client.deploy(review), ConsentError);
  await assert.rejects(f.client.deploy(review, { consent: 'yes' }), ConsentError);
  await assert.rejects(f.client.deploy({ ...review }, { consent: review.digest }), ConsentError);
  assert.equal(imports(f).length, 0);
  await assert.rejects(fs.stat(path.join(f.root, '.playground/project.json')), { code: 'ENOENT' });
});

test('publication transmits only the exact reviewed snapshot even when local files change', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  const review = await f.client.prepare();
  const original = await fs.readFile(path.join(f.root, 'main.ts'), 'utf8');
  await fs.writeFile(path.join(f.root, 'main.ts'), `const key = "${'sk-proj-' + 'a'.repeat(44)}";`);
  const result = await f.client.deploy(review, { consent: review.digest });
  const entry = imports(f)[0].body.projects[0];
  const archive = unzipSync(Buffer.from(entry.source, 'base64'));
  assert.equal(strFromU8(archive['main.ts']), original);
  assert.equal(result.url, 'https://playgroundvibes.com/#project/project-fixture');
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, '.playground/project.json'), 'utf8'),
  );
  assert.equal(saved.project_id, 'project-fixture');
  await assert.rejects(f.client.deploy(review, { consent: review.digest }), ConsentError);
});

test('changed files invalidate consent on a fresh preparation', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  const first = await f.client.prepare();
  await fs.writeFile(path.join(f.root, 'main.ts'), 'export const greeting = "changed";');
  const second = await f.client.prepare();
  assert.notEqual(first.digest, second.digest);
  await assert.rejects(f.client.deploy(second, { consent: first.digest }), ConsentError);
  assert.equal(imports(f).length, 0);
});

test('changed account or linked project prevents an approved snapshot from uploading', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  const review = await f.client.prepare();
  f.control.account = 'another-account';
  await assert.rejects(f.client.deploy(review, { consent: review.digest }), /account/i);
  f.control.account = 'account-fixture';
  await fs.writeFile(
    path.join(f.root, '.playground/project.json'),
    JSON.stringify({
      version: 1,
      origin: review.origin,
      account_id: f.control.account,
      project_id: 'different-project',
      source_id: review.metadata.source_id,
      date: review.metadata.date,
    }),
  );
  await assert.rejects(
    f.client.deploy(review, { consent: review.digest }),
    /linked project changed/,
  );
  assert.equal(imports(f).length, 0);
});

test('interrupted deployments retain identity, consent digest and operation across preparations', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  const first = await f.client.prepare();
  f.control.fail = true;
  await assert.rejects(f.client.deploy(first, { consent: first.digest }), /network interruption/);
  assert.equal(imports(f).length, 3);
  const second = await f.client.prepare();
  assert.equal(second.digest, first.digest);
  f.control.fail = false;
  await f.client.deploy(second, { consent: second.digest });
  assert.equal(new Set(imports(f).map((call) => call.body.operation_id)).size, 1);
  assert.equal(new Set(imports(f).map((call) => call.body.projects[0].source_id)).size, 1);
});

test('final metadata and browser build findings block publication without exposing values', async (t) => {
  const secret = 'sk-proj-' + 'a'.repeat(44);
  const f = await fixture(t, { source_id: secret });
  await assert.rejects(
    f.client.inspect(),
    (error) => !error.message.includes(secret) && /metadata|secret|credential/i.test(error.message),
  );
  const g = await fixture(t);
  await fs.writeFile(
    path.join(g.root, 'dist/index.html'),
    `<script>const credential = "${secret}"</script>`,
  );
  await assert.rejects(g.client.inspect());
  assert.equal(imports(f).length + imports(g).length, 0);
});

test('unsupported cover formats and in-project credential directories fail closed', async (t) => {
  const f = await fixture(t, { cover_file: '../screenshot.gif' });
  await fs.writeFile(path.join(f.root, 'screenshot.gif'), Buffer.from('GIF89a'));
  await assert.rejects(f.client.inspect(), /cover_file must select a PNG, JPEG, or WebP/);
  const g = await fixture(t);
  await assert.rejects(
    createPlaygroundClient({ cwd: g.root, configDir: path.join(g.root, 'private') }).inspect(),
    /outside the selected project/,
  );
});

test('a mismatched server project ID never replaces the approved project binding', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  const identity = {
    version: 1,
    origin: 'https://playgroundvibes.com',
    account_id: 'account-fixture',
    project_id: 'approved-project',
    source_id: 'stable-source',
    date: '2020-01-01',
  };
  await fs.writeFile(path.join(f.root, '.playground/project.json'), JSON.stringify(identity));
  const review = await f.client.prepare();
  await assert.rejects(
    f.client.deploy(review, { consent: review.digest }),
    /does not match the reviewed project/,
  );
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, '.playground/project.json'), 'utf8'),
  );
  assert.equal(saved.project_id, identity.project_id);
});

test('deployment results expose only typed fields and the whitelisted processing status', async (t) => {
  const f = await fixture(t);
  const echoedValue = 'must-never-appear-in-public-results';
  f.control.responseFields = {
    credential: echoedValue,
    unexpected: { nested: echoedValue },
    processing: { status: 'queued', credential: echoedValue, nested: { credential: echoedValue } },
  };
  await f.client.connect('ABCD2345');
  const review = await f.client.prepare();
  const result = await f.client.deploy(review, { consent: review.digest });
  assert.deepEqual(Object.keys(result).sort(), [
    'bytes',
    'digest',
    'files',
    'id',
    'preview',
    'processing',
    'status',
    'url',
    'version_id',
  ]);
  assert.deepEqual(result.processing, { status: 'queued' });
  assert.equal(result.preview, 'ready');
  assert.equal(JSON.stringify(result).includes(echoedValue), false);
});

test('unknown optional preview and processing shapes do not invalidate completed imports', async (t) => {
  const f = await fixture(t);
  f.control.responseFields = { preview: null, processing: { status: { untrusted: 'value' } } };
  await f.client.connect('ABCD2345');
  const review = await f.client.prepare();
  const result = await f.client.deploy(review, { consent: review.digest });
  assert.equal(result.status, 'imported');
  assert.equal(Object.hasOwn(result, 'preview'), false);
  assert.equal(Object.hasOwn(result, 'processing'), false);
  const saved = JSON.parse(
    await fs.readFile(path.join(f.root, '.playground/project.json'), 'utf8'),
  );
  assert.equal(saved.project_id, 'project-fixture');
});

test('a second completed deployment updates the saved project and preserves its source identity', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  const first = await f.client.prepare();
  await f.client.deploy(first, { consent: first.digest });
  await fs.writeFile(path.join(f.root, 'main.ts'), 'export const greeting = "updated";\n');
  const second = await f.client.prepare();
  assert.equal(second.projectId, 'project-fixture');
  assert.equal(second.metadata.source_id, first.metadata.source_id);
  assert.equal(second.metadata.date, first.metadata.date);
  await f.client.deploy(second, { consent: second.digest });
  assert.equal(imports(f)[0].body.project_id, undefined);
  assert.equal(imports(f)[1].body.project_id, 'project-fixture');
  assert.notEqual(imports(f)[1].body.operation_id, imports(f)[0].body.operation_id);
});

test('project-scoped credentials reject an unlinked or differently linked folder before upload', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  f.control.scope = 'project-fixture';
  await assert.rejects(f.client.prepare(), /project/i);
  const identity = {
    version: 1,
    origin: 'https://playgroundvibes.com',
    account_id: 'account-fixture',
    project_id: 'different-project',
    source_id: 'stable-source',
    date: '2020-01-01',
  };
  await fs.writeFile(path.join(f.root, '.playground', 'project.json'), JSON.stringify(identity));
  await assert.rejects(f.client.prepare(), /project/i);
  assert.equal(imports(f).length, 0);
});

test('project-scoped credentials can update their matching saved project', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  f.control.scope = 'project-fixture';
  await fs.writeFile(
    path.join(f.root, '.playground', 'project.json'),
    JSON.stringify({
      version: 1,
      origin: 'https://playgroundvibes.com',
      account_id: 'account-fixture',
      project_id: 'project-fixture',
      source_id: 'stable-source',
      date: '2020-01-01',
    }),
  );
  const review = await f.client.prepare();
  const result = await f.client.deploy(review, { consent: review.digest });
  assert.equal(result.id, 'project-fixture');
  assert.equal(imports(f)[0].body.project_id, 'project-fixture');
});

test('a credential scope change after approval blocks import without changing local identity', async (t) => {
  const f = await fixture(t);
  await f.client.connect('ABCD2345');
  const identityFile = path.join(f.root, '.playground', 'project.json');
  const identity = {
    version: 1,
    origin: 'https://playgroundvibes.com',
    account_id: 'account-fixture',
    project_id: 'project-fixture',
    source_id: 'stable-source',
    date: '2020-01-01',
  };
  await fs.writeFile(identityFile, JSON.stringify(identity));
  f.control.scope = 'project-fixture';
  const review = await f.client.prepare();
  f.control.scope = 'another-project';
  await assert.rejects(f.client.deploy(review, { consent: review.digest }), /project/i);
  assert.equal(imports(f).length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(identityFile, 'utf8')), identity);
});

test('status keeps publication separate from upload and cannot change account or re-upload', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.deploymentStatus(), /not been uploaded/);
  await f.client.connect('ABCD2345');
  f.control.responseFields = {
    published: false,
    publication: 'processing',
    preview: 'processing',
    message: 'Checking uploaded files.',
    processing: { status: 'queued' },
  };
  const review = await f.client.prepare();
  const result = await f.client.deploy(review, { consent: review.digest });
  assert.equal(result.published, false);
  assert.equal(result.publication, 'processing');
  f.control.responseFields = {
    published: true,
    publication: 'published',
    preview: 'overview',
    processing: { status: 'complete' },
  };
  const completed = await f.client.deploymentStatus(result.version_id);
  assert.equal(completed.published, true);
  assert.equal(completed.preview, 'overview');
  assert.equal(imports(f).length, 1);
  const statusCall = f.calls.find((c) => c.endpoint === '/api/assistant/deployment-status');
  assert.deepEqual(statusCall.body, { project_id: result.id, version_id: result.version_id });
  f.control.responseFields = {
    published: false,
    publication: 'failed',
    processing: { status: 'failed', error: 'Build failed' },
  };
  assert.equal((await f.client.deploymentStatus()).processing.error, 'Build failed');
  f.control.account = 'different-account';
  const count = f.calls.filter((c) => c.endpoint === '/api/assistant/deployment-status').length;
  await assert.rejects(f.client.deploymentStatus(), /account changed|different connected/);
  assert.equal(
    f.calls.filter((c) => c.endpoint === '/api/assistant/deployment-status').length,
    count,
  );
});
