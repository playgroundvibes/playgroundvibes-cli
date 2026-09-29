import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLAUDE_COMMAND_PERMISSION,
  prepareClaudeCommandPermission,
} from '../dist/skills/claude-permissions.js';

async function project(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'playground-claude-permissions-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, '.claude/settings.local.json') };
}

async function settingsFixture(t, contents) {
  const fixture = await project(t);
  await mkdir(path.dirname(fixture.file));
  await writeFile(fixture.file, contents);
  return fixture;
}

test('preparing is read-only and applying creates only the requested Claude command permission', async (t) => {
  const { root, file } = await project(t);
  const plan = await prepareClaudeCommandPermission(root);
  await assert.rejects(access(path.dirname(file)), { code: 'ENOENT' });
  // The skill installer creates .claude after preparation and before applying permissions.
  await mkdir(path.dirname(file));
  assert.equal(CLAUDE_COMMAND_PERMISSION, 'Bash(playgroundvibes:*)');
  assert.deepEqual(await plan.apply(), {
    path: file,
    added: true,
    rule: CLAUDE_COMMAND_PERMISSION,
  });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    permissions: { allow: [CLAUDE_COMMAND_PERMISSION] },
  });
  assert.deepEqual(await readdir(path.dirname(file)), ['settings.local.json']);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('merge preserves other settings and allow, ask, and deny rules', async (t) => {
  const existing = {
    model: 'chosen-model',
    env: { FIXTURE_VALUE: 'kept-in-settings' },
    permissions: {
      allow: ['Read', 'Bash(git status:*)'],
      ask: ['Bash(playgroundvibes deploy:*)'],
      deny: ['Bash(playgroundvibes logout:*)'],
      defaultMode: 'default',
      additionalDirectories: ['../selected'],
    },
    custom: { nested: true },
  };
  const { root, file } = await settingsFixture(t, JSON.stringify(existing));
  await (await prepareClaudeCommandPermission(root)).apply();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    ...existing,
    permissions: {
      ...existing.permissions,
      allow: [...existing.permissions.allow, CLAUDE_COMMAND_PERMISSION],
    },
  });
});

test('an existing exact permission is not duplicated or rewritten', async (t) => {
  const contents =
    '{\r\n\t"permissions" : {"allow":["Bash(playgroundvibes:*)"], "deny": ["Bash(rm:*)"]}\r\n}\r\n';
  const { root, file } = await settingsFixture(t, contents);
  const before = await stat(file);
  assert.deepEqual(await (await prepareClaudeCommandPermission(root)).apply(), {
    path: file,
    added: false,
    rule: CLAUDE_COMMAND_PERMISSION,
  });
  assert.equal(await readFile(file, 'utf8'), contents);
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('malformed settings and invalid permission shapes are rejected without revealing contents', async (t) => {
  for (const contents of [
    '{"sensitive-fixture":"do-not-echo",',
    'null',
    '[]',
    '{"permissions":null}',
    '{"permissions":[]}',
    '{"permissions":{"allow":"do-not-echo"}}',
    '{"permissions":{"allow":["Read",42]}}',
    '{"permissions":{"ask":[false]}}',
    '{"permissions":{"deny":{}}}',
  ]) {
    const { root, file } = await settingsFixture(t, contents);
    await assert.rejects(prepareClaudeCommandPermission(root), (error) => {
      assert.doesNotMatch(error.message, /do-not-echo|sensitive-fixture/);
      return /Claude settings/.test(error.message);
    });
    assert.equal(await readFile(file, 'utf8'), contents);
  }
});

test('a prepared merge refuses changed or newly created settings', async (t) => {
  for (const existing of [false, true]) {
    const { root, file } = existing ? await settingsFixture(t, '{}') : await project(t);
    const plan = await prepareClaudeCommandPermission(root);
    await mkdir(path.dirname(file), { recursive: true });
    const edited = '{"permissions":{"allow":["Read"]},"edited":true}\n';
    await writeFile(file, edited);
    await assert.rejects(plan.apply(), /settings changed during installation/);
    assert.equal(await readFile(file, 'utf8'), edited);
    assert.deepEqual(await readdir(path.dirname(file)), ['settings.local.json']);
  }
});

test('non-file settings and non-directory parents are rejected', async (t) => {
  const directoryFixture = await project(t);
  await mkdir(directoryFixture.file, { recursive: true });
  await assert.rejects(
    prepareClaudeCommandPermission(directoryFixture.root),
    /regular Claude settings file/,
  );
  const parentFixture = await project(t);
  await writeFile(path.dirname(parentFixture.file), 'parent is a file');
  await assert.rejects(
    prepareClaudeCommandPermission(parentFixture.root),
    /parent is not a directory/,
  );
});

test(
  'symlinked settings, parents, and replacements are refused',
  { skip: process.platform === 'win32' },
  async (t) => {
    const external = await project(t);
    const target = path.join(external.root, 'untouched.json');
    await writeFile(target, '{}');

    const leaf = await project(t);
    await mkdir(path.dirname(leaf.file));
    await symlink(target, leaf.file);
    await assert.rejects(
      prepareClaudeCommandPermission(leaf.root),
      /symlinked Claude settings file/,
    );

    const parent = await project(t);
    await symlink(external.root, path.dirname(parent.file));
    await assert.rejects(
      prepareClaudeCommandPermission(parent.root),
      /symlinked Claude settings directories/,
    );

    const replaced = await settingsFixture(t, '{}');
    const plan = await prepareClaudeCommandPermission(replaced.root);
    await rm(replaced.file);
    await symlink(target, replaced.file);
    await assert.rejects(plan.apply(), /symlinked Claude settings file/);
    assert.equal(await readFile(target, 'utf8'), '{}');
  },
);
