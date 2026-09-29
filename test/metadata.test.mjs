import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildMetadata } from '../dist/project/metadata.js';

const base = { title: 'Reviewed project', summary: 'A useful project.', date: '2020-02-29' };
const build = (extra = {}, identity = {}) =>
  buildMetadata({ ...base, ...extra }, identity, '/selected/project');

test('metadata preserves supplied provenance, defaults ownership settings, and excludes local paths/artifacts', () => {
  const creation = {
    tools: ['Codex'],
    model: 'Owner-supplied model',
    primary_device: 'desktop',
    services: [
      { name: 'Example', purpose: 'Provides project hosting', url: 'https://example.com/' },
    ],
  };
  const result = build({
    category: 'AI Agents',
    creation_details: creation,
    provider_requirements: [{ provider: 'openai', model: 'owner-supplied-model' }],
    tags: ['AI', 'C++', '日本語'],
    repo_url: 'https://github.com/example/project',
    live_url: 'https://example.com/app',
    source_dir: '..',
    build_dir: '../dist',
    cover_file: '../cover.png',
    source: 'ignored payload',
    unknown: 'ignored field',
  });
  assert.deepEqual(result.creation_details, creation);
  assert.equal(result.category, 'AI Agents');
  assert.equal(result.license, 'All rights reserved');
  assert.equal(result.remix, false);
  assert.equal(
    result.source_id,
    'cli-' + createHash('sha256').update('/selected/project').digest('hex'),
  );
  for (const field of ['source_dir', 'build_dir', 'cover_file', 'source', 'unknown'])
    assert.equal(Object.hasOwn(result, field), false);
  assert.equal(build().creation_details, undefined);
  assert.deepEqual(build({ creation_details: { tools: [], model: '' } }).creation_details, {
    tools: [],
    model: '',
  });
});

test('linked source identity and original date remain stable', () => {
  const identity = { source_id: 'stable-project', date: '2019-01-01' };
  assert.equal(build({ date: '2021-01-01' }, identity).date, '2019-01-01');
  assert.equal(build({}, identity).source_id, 'stable-project');
  assert.throws(
    () => build({ source_id: 'different-project' }, identity),
    /Preserve the source_id/,
  );
});

test('all categories supported by the original helper are accepted', () => {
  for (const category of [
    'AI Agents',
    'Generative AI',
    'Automations',
    'Simulations',
    'Data & Analytics',
    'Infrastructure',
    'Security & Privacy',
    'Hardware & Robotics',
    'Productivity',
    'Art',
    'Generative Art',
    '3D & Spatial',
    'Science',
    'Nature & Environment',
    'Crypto',
    'Finance & Crypto',
    'Lifestyle & Planning',
  ]) {
    assert.equal(build({ category }).category, category);
  }
});

test('invalid scalar metadata is rejected before an upload can be prepared', () => {
  for (const extra of [
    { license: ['MIT'] },
    { license: null },
    { license: 'Invented license' },
    { remix: 'true' },
    { remix: true },
    { category: [] },
    { category: 'Unknown' },
    { title: '' },
    { summary: 'x'.repeat(241) },
    { tags: ['!!!'] },
    { tags: Array(6).fill('tag') },
    { tags: ['😀'.repeat(19)] },
    { date: '2020-02-31' },
    { date: '0000-01-01' },
    { date: '2099-01-01' },
    { source_id: 123 },
  ])
    assert.throws(() => build(extra), undefined, JSON.stringify(extra));
  assert.equal(build({ license: 'MIT', remix: true }).remix, true);
});

test('URLs reject credentials, local addresses, and invalid repository locations without networking', () => {
  for (const live_url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://localhost',
    'https://localhost.example.local',
    'https://127.0.0.1',
    'https://2130706433',
    'https://10.1.2.3',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[fd00::1]',
  ]) {
    assert.throws(() => build({ live_url }), /HTTPS|public/);
  }
  for (const repo_url of [
    'https://gitlab.com/example/project',
    'https://github.com/example/project/tree/main',
    'https://github.com/example/project?token=value',
    'https://github.com/example/project#fragment',
  ]) {
    assert.throws(() => build({ repo_url }), /repository|query parameters/);
  }
  assert.equal(build({ live_url: 'https://8.8.8.8/' }).live_url, 'https://8.8.8.8/');
  assert.equal(
    build({ live_url: 'https://[2001:4860:4860::8888]/' }).live_url,
    'https://[2001:4860:4860::8888]/',
  );
});

test('provider requirements enforce supported providers, models, uniqueness and exact fields', () => {
  for (const provider_requirements of [
    {},
    [{ provider: 'unknown', model: 'model' }],
    [{ provider: 'openai', model: '' }],
    [{ provider: 'openai', model: 'model with spaces' }],
    [{ provider: 'openai', model: 'model', api_key: 'unexpected' }],
    [
      { provider: 'openai', model: 'one' },
      { provider: 'openai', model: 'two' },
    ],
  ])
    assert.throws(() => build({ provider_requirements }), /provider|Provider/);
});

test('creation details require supplied tools and model, known keys, and clean unique service websites', () => {
  const valid = { tools: ['Codex'], model: '' };
  for (const creation_details of [
    [],
    {},
    { tools: ['Codex'] },
    { ...valid, tools: ['Unknown'] },
    { ...valid, model: 123 },
    { ...valid, model: 'line\nbreak' },
    { ...valid, extra: true },
    { ...valid, primary_device: 'tablet' },
    { ...valid, services: Array(13).fill({ name: 'Example', purpose: 'Hosting' }) },
    { ...valid, services: [{ name: 'Example', purpose: 'Hosting', extra: true }] },
    {
      ...valid,
      services: [
        { name: 'Example', purpose: 'Hosting' },
        { name: ' example ', purpose: 'Hosting' },
      ],
    },
    ...[
      'https://example.com/?key=value',
      'https://example.com/#fragment',
      'https://localhost/',
      'https://user:pass@example.com',
    ].map((url) => ({ ...valid, services: [{ name: 'Example', purpose: 'Hosting', url }] })),
  ])
    assert.throws(() => build({ creation_details }), undefined, JSON.stringify(creation_details));
});
