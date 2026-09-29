import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'dist/cli.js');
const digest = 'a'.repeat(64);

function invoke(args, options = {}) {
  const result = spawnSync(process.execPath, [...(options.nodeArgs ?? []), cli, ...args], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    input: options.input ?? '',
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function events(result) {
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function temporaryDirectory(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'playground-ts-cli-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function mockedGlobalCLI(t, { failure, tty = false, stdinTTY = tty, stderrTTY = tty } = {}) {
  const directory = await temporaryDirectory(t);
  const log = path.join(directory, 'global-calls.jsonl');
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  const result = { packageManager: 'npm', version, installed: true };
  await writeFile(log, '');
  await writeFile(
    path.join(directory, 'fake-global-cli.mjs'),
    `
import { appendFileSync } from 'node:fs';
export async function ensureGlobalCLI(packageManager) {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ packageManager: packageManager ?? null }) + '\\n');
  ${failure ? `throw new Error(${JSON.stringify(failure)});` : `return { ...${JSON.stringify(result)}, packageManager: packageManager ?? 'npm' };`}
}
`,
  );
  await writeFile(
    path.join(directory, 'global-loader.mjs'),
    `
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url === ${JSON.stringify(pathToFileURL(path.join(root, 'dist/skills/global-cli.js')).href)}) {
    return { url: new URL('./fake-global-cli.mjs', import.meta.url).href, shortCircuit: true };
  }
  return resolved;
}
`,
  );
  const register = path.join(directory, 'register-global.mjs');
  await writeFile(
    register,
    `
import { register } from 'node:module';
register(new URL('./global-loader.mjs', import.meta.url));
globalThis.fetch = async () => { throw new Error('Network is forbidden in CLI tests'); };
Object.defineProperty(process.stdin, 'isTTY', { value: ${JSON.stringify(stdinTTY)} });
Object.defineProperty(process.stderr, 'isTTY', { value: ${JSON.stringify(stderrTTY)} });
`,
  );
  return {
    directory,
    result,
    options: { cwd: directory, nodeArgs: ['--import', pathToFileURL(register).href] },
    async calls() {
      const contents = (await readFile(log, 'utf8')).trim();
      return contents ? contents.split('\n').map((line) => JSON.parse(line)) : [];
    },
  };
}

async function mockedClient(t, { tty = false } = {}) {
  const directory = await temporaryDirectory(t);
  const log = path.join(directory, 'calls.jsonl');
  await writeFile(log, '');
  const review = {
    digest,
    origin: 'https://playgroundvibes.com',
    root: directory,
    accountId: 'reviewed-account',
    projectId: 'reviewed-project',
    title: 'Reviewed app',
    summary: 'The exact reviewed project',
    metadata: {
      title: 'Reviewed app',
      summary: 'The exact reviewed project',
      license: 'All rights reserved',
      remix: false,
    },
    files: [{ artifact: 'source', path: 'index.html', bytes: 12, sha256: 'b'.repeat(64) }],
    excluded: [
      {
        artifact: 'source',
        path: '.env',
        reason: 'Sensitive environment file',
        source: 'built-in',
        rule: 'private-environment',
      },
      {
        artifact: 'source',
        path: 'scratch.txt',
        reason: 'Project ignore rule',
        source: 'playgroundignore',
        rule: 'scratch.txt',
        ignoreFile: '.playgroundignore',
        line: 3,
      },
      {
        artifact: 'build',
        path: 'scratch.txt',
        reason: 'Project ignore rule',
        source: 'playgroundignore',
        rule: 'scratch.txt',
        ignoreFile: '.playgroundignore',
        line: 3,
      },
    ],
    bytes: 12,
    warnings: ['No browser build selected'],
    publication: 'Completed imports publish immediately. Source download permission is separate.',
  };
  await writeFile(
    path.join(directory, 'fake-client.mjs'),
    `
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const reviewed = Object.freeze(${JSON.stringify(review)});
function record(method, values = {}) { appendFileSync(log, JSON.stringify({ method, ...values }) + '\\n'); }
export function createPlaygroundClient(options = {}) {
  record('create', { options });
  return {
    loginUrl: 'https://playgroundvibes.com/#new',
    async connect(code) { record('connect', { code }); return { connected: true }; },
    async whoami() { record('whoami'); return { accountId: 'reviewed-account' }; },
    async logout() { record('logout'); return { loggedOut: true }; },
    async inspect() { record('inspect'); return reviewed; },
    async prepare() { record('prepare'); return reviewed; },
    async deploy(review, { consent }) {
      if (review !== reviewed || consent !== reviewed.digest) throw new Error('Unreviewed upload attempted');
      record('deploy', { consent });
      return { url: 'https://playgroundvibes.com/p/reviewed-project', published: true };
    },
  };
}
`,
  );
  await writeFile(
    path.join(directory, 'loader.mjs'),
    `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '../client.js' && context.parentURL === ${JSON.stringify(pathToFileURL(path.join(root, 'dist/cli/commands.js')).href)}) {
    return { url: new URL('./fake-client.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`,
  );
  const register = path.join(directory, 'register.mjs');
  await writeFile(
    register,
    `
import { register } from 'node:module';
register(new URL('./loader.mjs', import.meta.url));
globalThis.fetch = async () => { throw new Error('Network is forbidden in CLI tests'); };
${tty ? "Object.defineProperty(process.stdin, 'isTTY', { value: true }); Object.defineProperty(process.stdout, 'isTTY', { value: true });" : ''}
`,
  );
  return {
    directory,
    review,
    options: { cwd: directory, nodeArgs: ['--import', pathToFileURL(register).href] },
    async calls() {
      const text = await readFile(log, 'utf8');
      return text.trim()
        ? text
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    },
  };
}

test('help and package version are local and explain publication consent', async () => {
  for (const args of [[], ['--help'], ['-h'], ['deploy', '--help']]) {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: playgroundvibes/);
    assert.match(result.stdout, /typing PUBLISH/);
    assert.match(result.stdout, /--consent/);
    assert.match(result.stdout, /Node\.js 22/);
    assert.match(result.stdout, /binary\/archive/);
    assert.match(result.stdout, /--allow-claude-commands/);
    assert.match(result.stdout, /--package-manager npm\|pnpm/);
    assert.match(result.stdout, /same package version is installed\s+globally/);
    assert.match(result.stdout, /current project \[y\/N\]/);
    assert.match(result.stdout, /requires --claude/);
    assert.ok(result.stdout.includes('Bash(playgroundvibes:*)'));
    assert.match(result.stdout, /does not grant\s+publication consent/);
    assert.doesNotMatch(result.stdout, /Python/);
  }
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const result = invoke([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${manifest.version}\n`);
  }
});

test('unknown commands and invalid options fail before an account or deploy operation', async (t) => {
  const mock = await mockedClient(t);
  const globalCLI = await mockedGlobalCLI(t);
  const options = {
    ...mock.options,
    nodeArgs: [...mock.options.nodeArgs, ...globalCLI.options.nodeArgs],
  };
  for (const args of [
    ['unknown'],
    ['deploy', '--yes'],
    ['deploy', '--unknown'],
    ['deploy', '--consent'],
    ['deploy', '--dry-run', '--consent', digest],
    ['deploy', '--json', '--json'],
    ['--config-dir'],
    ['connect'],
    ['connect', 'one', 'two'],
    ['whoami', '--unexpected'],
    ['logout', 'extra'],
    ['login', '--unexpected'],
    ['skill', 'path', 'extra'],
    ['skill', 'install', '--unknown'],
    ['skill', 'install', '--path'],
    ['skill', 'install', '--claude', '--claude'],
    ['skill', 'install', '--claude=false'],
    ['skill', 'install', '--allow-claude-commands'],
    ['skill', 'install', '--allow-claude-commands', '--path', 'invalid-target'],
    ['skill', 'install', '--claude', '--allow-claude-commands', '--allow-claude-commands'],
    ['skill', 'install', '--package-manager', 'npm'],
    ['skill', 'install', '--claude', '--package-manager'],
    ['skill', 'install', '--claude', '--package-manager', 'yarn'],
    ['skill', 'install', '--claude', '--allow-claude-commands', '--package-manager'],
    ['skill', 'install', '--claude', '--allow-claude-commands', '--package-manager', 'yarn'],
    [
      'skill',
      'install',
      '--claude',
      '--allow-claude-commands',
      '--package-manager',
      'npm',
      '--package-manager',
      'pnpm',
    ],
    ['skill', 'path', '--claude'],
    ['skill', 'unknown'],
  ]) {
    const result = invoke(args, options);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}`);
    assert.match(result.stderr || result.stdout, /Error:|"error"/);
  }
  assert.deepEqual(await mock.calls(), []);
  assert.deepEqual(await globalCLI.calls(), []);
  for (const destination of ['.agents', '.claude', 'invalid-target']) {
    await assert.rejects(access(path.join(mock.directory, destination)), { code: 'ENOENT' });
  }
});

test('skill path and explicit default/custom installation work from the compiled package', async (t) => {
  const globalCLI = await mockedGlobalCLI(t, { tty: true });
  const { directory, options } = globalCLI;
  const location = invoke(['skill', 'path'], options);
  assert.equal(location.status, 0, location.stderr);
  assert.equal(location.stderr, '');
  const skillPath = location.stdout.trim();
  assert.equal(path.resolve(skillPath), path.join(root, 'skills/playground-upload'));
  const bundled = await readFile(path.join(skillPath, 'SKILL.md'), 'utf8');
  for (const [args, relative] of [
    [['skill', 'install'], '.agents/skills/playground-upload'],
    [['skill', 'install', '--path', 'my-skill'], 'my-skill'],
  ]) {
    const result = invoke(args, { ...options, input: 'yes\n' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(events(result), [{ path: path.join(directory, relative), installed: true }]);
    const installedFile = path.join(directory, relative, 'SKILL.md');
    assert.equal(await readFile(installedFile, 'utf8'), bundled);

    const again = invoke(args, options);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stderr, '');
    assert.deepEqual(events(again), [{ path: path.join(directory, relative), installed: false }]);

    const edited = `${bundled}\nLocal instructions added by the user.\n`;
    await writeFile(installedFile, edited);
    const conflict = invoke(args, options);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /Refusing to overwrite a different existing skill/);
    assert.equal(await readFile(installedFile, 'utf8'), edited);
  }
  await assert.rejects(access(path.join(directory, '.claude')), { code: 'ENOENT' });
  assert.deepEqual(await globalCLI.calls(), []);
});

test('Claude skill installation selects its default directory without changing permissions', async (t) => {
  const globalCLI = await mockedGlobalCLI(t);
  const { directory, options } = globalCLI;
  const result = invoke(['skill', 'install', '--claude'], options);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /--allow-claude-commands/);
  assert.doesNotMatch(result.stderr, /\[y\/N\]/i);
  assert.deepEqual(events(result), [
    { path: path.join(directory, '.claude/skills/playground-upload'), installed: true },
  ]);
  const bundled = await readFile(path.join(root, 'skills/playground-upload/SKILL.md'), 'utf8');
  assert.equal(
    await readFile(path.join(directory, '.claude/skills/playground-upload/SKILL.md'), 'utf8'),
    bundled,
  );
  await assert.rejects(access(path.join(directory, '.claude/settings.local.json')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await globalCLI.calls(), []);
});

test('interactive Claude installation accepts only yes or y and keeps its permission prompt on stderr', async (t) => {
  for (const { input, packageManager } of [
    { input: 'yes\n' },
    { input: ' Y \n' },
    { input: ' YeS \n', packageManager: 'pnpm' },
  ]) {
    const globalCLI = await mockedGlobalCLI(t, { tty: true });
    const { directory, options } = globalCLI;
    const args = ['skill', 'install', '--claude'];
    if (packageManager) args.push('--package-manager', packageManager);

    const result = invoke(args, { ...options, input });
    assert.equal(result.status, 0, result.stderr);
    const settingsPath = path.join(directory, '.claude/settings.local.json');
    const rule = 'Bash(playgroundvibes:*)';
    assert.deepEqual(events(result), [
      {
        path: path.join(directory, '.claude/skills/playground-upload'),
        installed: true,
        globalCLI: { ...globalCLI.result, packageManager: packageManager ?? 'npm' },
        claudePermissions: { path: settingsPath, added: true, rule },
      },
    ]);
    assert.ok(result.stderr.includes(JSON.stringify(directory)));
    assert.ok(result.stderr.includes(rule));
    assert.match(result.stderr, /global/i);
    assert.match(result.stderr, /publish.*consent/i);
    assert.equal(result.stderr.match(/\[y\/N\]/gi)?.length, 1);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).permissions.allow, [rule]);
    assert.deepEqual(await globalCLI.calls(), [{ packageManager: packageManager ?? null }]);
  }
});

test('declining the Claude prompt or reaching EOF installs only the skill and ignores the manager', async (t) => {
  for (const input of ['no\n', '\n', '', 'maybe\n']) {
    const globalCLI = await mockedGlobalCLI(t, { tty: true });
    const { directory, options } = globalCLI;
    const settingsPath = path.join(directory, '.claude/settings.local.json');
    const original = '{ "permissions": { "allow": ["Read(*)"] }, "userNote": "preserve" }\n';
    if (input === 'no\n') {
      await mkdir(path.dirname(settingsPath));
      await writeFile(settingsPath, original);
    }

    const result = invoke(['skill', 'install', '--claude', '--package-manager', 'pnpm'], {
      ...options,
      input,
    });
    assert.equal(result.status, 0, result.stderr);
    const skillPath = path.join(directory, '.claude/skills/playground-upload');
    assert.deepEqual(events(result), [{ path: skillPath, installed: true }]);
    await access(path.join(skillPath, 'SKILL.md'));
    assert.equal(result.stderr.match(/\[y\/N\]/gi)?.length, 1);
    if (input === 'no\n') assert.equal(await readFile(settingsPath, 'utf8'), original);
    else await assert.rejects(access(settingsPath), { code: 'ENOENT' });
    assert.deepEqual(await globalCLI.calls(), []);
  }
});

test('Ctrl-C at the Claude prompt cancels before installing or granting permissions', async (t) => {
  const globalCLI = await mockedGlobalCLI(t, { tty: true });
  const result = invoke(['skill', 'install', '--claude'], {
    ...globalCLI.options,
    input: '\u0003',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cancelled/i);
  assert.equal(result.stdout, '');
  await assert.rejects(access(path.join(globalCLI.directory, '.claude')), { code: 'ENOENT' });
  assert.deepEqual(await globalCLI.calls(), []);
});

test('Claude permissions require both input and stderr terminals and ignore piped yes', async (t) => {
  for (const tty of [
    { stdinTTY: false, stderrTTY: false },
    { stdinTTY: true, stderrTTY: false },
    { stdinTTY: false, stderrTTY: true },
  ]) {
    const globalCLI = await mockedGlobalCLI(t, tty);
    const { directory, options } = globalCLI;
    const result = invoke(['skill', 'install', '--claude', '--package-manager', 'pnpm'], {
      ...options,
      input: 'yes\n',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events(result), [
      { path: path.join(directory, '.claude/skills/playground-upload'), installed: true },
    ]);
    assert.match(result.stderr, /--allow-claude-commands/);
    assert.doesNotMatch(result.stderr, /\[y\/N\]/i);
    await assert.rejects(access(path.join(directory, '.claude/settings.local.json')), {
      code: 'ENOENT',
    });
    assert.deepEqual(await globalCLI.calls(), []);
  }
});

test('explicit Claude setup forwards package managers and adds project-local permissions idempotently', async (t) => {
  const rule = 'Bash(playgroundvibes:*)';
  for (const { customPath, packageManager, tty } of [
    {},
    { customPath: 'custom-skill', packageManager: 'pnpm', tty: true },
    { packageManager: 'npm', tty: true },
  ]) {
    const globalCLI = await mockedGlobalCLI(t, { tty });
    const { directory, options } = globalCLI;
    const args = ['skill', 'install', '--allow-claude-commands', '--claude'];
    if (customPath) args.push('--path', customPath);
    if (packageManager === 'npm') args.push('--package-manager', packageManager);
    else if (packageManager) args.push(`--package-manager=${packageManager}`);
    const skillPath = path.join(directory, customPath ?? '.claude/skills/playground-upload');
    const settingsPath = path.join(directory, '.claude/settings.local.json');
    const globalResult = { ...globalCLI.result, packageManager: packageManager ?? 'npm' };

    const result = invoke(args, { ...options, input: 'no\n' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(events(result), [
      {
        path: skillPath,
        installed: true,
        claudePermissions: { path: settingsPath, added: true, rule },
        globalCLI: globalResult,
      },
    ]);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.permissions.allow, [rule]);
    await access(path.join(skillPath, 'SKILL.md'));

    const again = invoke(args, options);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stderr, '');
    assert.deepEqual(events(again), [
      {
        path: skillPath,
        installed: false,
        claudePermissions: { path: settingsPath, added: false, rule },
        globalCLI: globalResult,
      },
    ]);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), settings);
    assert.deepEqual(await globalCLI.calls(), [
      { packageManager: packageManager ?? null },
      { packageManager: packageManager ?? null },
    ]);
  }
});

test('malformed Claude settings are preserved and prevent skill installation', async (t) => {
  const globalCLI = await mockedGlobalCLI(t);
  const { directory, options } = globalCLI;
  const settingsPath = path.join(directory, '.claude/settings.local.json');
  const original = Buffer.from('{ "permissions": { "allow": [] }\n');
  await mkdir(path.dirname(settingsPath));
  await writeFile(settingsPath, original);

  const result = invoke(['skill', 'install', '--claude', '--allow-claude-commands'], options);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Claude settings must contain valid UTF-8 JSON/);
  assert.deepEqual(await readFile(settingsPath), original);
  await assert.rejects(access(path.join(directory, '.claude/skills')), { code: 'ENOENT' });
  assert.deepEqual(await globalCLI.calls(), []);
});

test('modified Claude skills block permission changes and preserve existing settings', async (t) => {
  const originalSettings = Buffer.from(
    '{ "permissions": { "allow": ["Read(*)"], "deny": ["Bash(curl:*)"] }, "userNote": "keep" }\n',
  );
  for (const existingSettings of [undefined, originalSettings]) {
    const globalCLI = await mockedGlobalCLI(t);
    const { directory, options } = globalCLI;
    const skillPath = path.join(directory, '.claude/skills/playground-upload/SKILL.md');
    const settingsPath = path.join(directory, '.claude/settings.local.json');
    const localSkill = Buffer.from('# My modified skill\nKeep my local instructions.\n');
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, localSkill);
    if (existingSettings) await writeFile(settingsPath, existingSettings);

    const result = invoke(['skill', 'install', '--claude', '--allow-claude-commands'], options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to overwrite a different existing skill/);
    assert.deepEqual(await readFile(skillPath), localSkill);
    if (existingSettings) assert.deepEqual(await readFile(settingsPath), existingSettings);
    else await assert.rejects(access(settingsPath), { code: 'ENOENT' });
    assert.deepEqual(await globalCLI.calls(), []);
  }
});

test('failed global CLI setup cannot grant Claude command permissions', async (t) => {
  const originalSettings = Buffer.from('{ "permissions": { "allow": ["Read(*)"] } }\n');
  for (const existingSettings of [undefined, originalSettings]) {
    const globalCLI = await mockedGlobalCLI(t, { failure: 'Mock global CLI installation failed' });
    const { directory, options } = globalCLI;
    const settingsPath = path.join(directory, '.claude/settings.local.json');
    if (existingSettings) {
      await mkdir(path.dirname(settingsPath));
      await writeFile(settingsPath, existingSettings);
    }

    const result = invoke(['skill', 'install', '--claude', '--allow-claude-commands'], options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Mock global CLI installation failed/);
    if (existingSettings) assert.deepEqual(await readFile(settingsPath), existingSettings);
    else await assert.rejects(access(settingsPath), { code: 'ENOENT' });
    assert.deepEqual(await globalCLI.calls(), [{ packageManager: null }]);
  }
});

test('real dry-run scans offline without creating configuration or uploading', async (t) => {
  const directory = await temporaryDirectory(t);
  await mkdir(path.join(directory, '.playground'));
  await writeFile(
    path.join(directory, '.playground/manifest.json'),
    JSON.stringify({
      title: 'Offline app',
      summary: 'An offline review fixture',
      source_dir: '..',
    }),
  );
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Offline app</title>');
  await writeFile(path.join(directory, '.env'), 'PRIVATE_VALUE=example-never-upload\n');
  const configDir = path.join(await temporaryDirectory(t), 'private-config');
  const guard = path.join(await temporaryDirectory(t), 'no-network.mjs');
  await writeFile(
    guard,
    "globalThis.fetch = async () => { throw new Error('Unexpected network'); };\n",
  );
  const result = invoke(['--config-dir', configDir, 'deploy', '--dry-run', '--json'], {
    cwd: directory,
    nodeArgs: ['--import', pathToFileURL(guard).href],
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = events(result);
  assert.equal(output.length, 1);
  assert.equal(output[0].type, 'review');
  assert.equal(output[0].dryRun, true);
  assert.ok(output[0].review.files.some((file) => file.path === 'index.html'));
  assert.ok(!output[0].review.files.some((file) => file.path === '.env'));
  assert.ok(output[0].review.excluded.some((file) => file.path === '.env'));
  await assert.rejects(access(configDir), { code: 'ENOENT' });

  for (const filename of ['asset.png', 'binary.txt']) {
    const asset = path.join(directory, filename);
    await writeFile(asset, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    const blocked = invoke(['--config-dir', configDir, 'deploy', '--dry-run', '--json'], {
      cwd: directory,
      nodeArgs: ['--import', pathToFileURL(guard).href],
    });
    assert.equal(blocked.status, 1, blocked.stdout);
    assert.match(events(blocked)[0].error, /\.playgroundignore/);
    await assert.rejects(access(configDir), { code: 'ENOENT' });
    await rm(asset);
  }
});

test('login without a browser is offline and account commands route their arguments', async (t) => {
  const mock = await mockedClient(t);
  const login = invoke(['login', '--no-browser'], mock.options);
  assert.equal(login.status, 0, login.stderr);
  assert.match(login.stdout, /https:\/\/playgroundvibes\.com\/#new/);
  assert.match(login.stdout, /connect CODE/);
  assert.equal((await mock.calls()).length, 1);
  for (const args of [['connect', 'fixture-code'], ['whoami'], ['logout']]) {
    const result = invoke(['--config-dir', 'custom-config', ...args], mock.options);
    assert.equal(result.status, 0, result.stderr);
  }
  const calls = await mock.calls();
  assert.deepEqual(
    calls.filter((call) => call.method !== 'create'),
    [{ method: 'connect', code: 'fixture-code' }, { method: 'whoami' }, { method: 'logout' }],
  );
  assert.ok(
    calls
      .filter((call) => call.method === 'create')
      .slice(1)
      .every((call) => call.options.configDir === 'custom-config'),
  );
});

test('noninteractive deployment shows the complete review but refuses to upload without consent', async (t) => {
  const mock = await mockedClient(t);
  const result = invoke(['deploy'], mock.options);
  assert.equal(result.status, 1);
  for (const value of [
    'reviewed-account',
    'reviewed-project',
    'index.html',
    '.env',
    'Sensitive environment file',
    'All rights reserved',
    '"remix": false',
    'https://playgroundvibes.com',
    digest,
    'source: "playgroundignore"',
    'rule: "scratch.txt"',
    'file: ".playgroundignore":3',
    '[source] "scratch.txt"',
    '[build] "scratch.txt"',
  ]) {
    assert.ok(result.stdout.includes(value), value);
  }
  assert.match(result.stdout, /Source and any browser build files above will be sent/);
  assert.match(result.stderr, /Consent required\. No upload occurred/);
  assert.match(result.stderr, new RegExp(`--consent ${digest}`));
  assert.deepEqual(
    (await mock.calls()).map((call) => call.method),
    ['create', 'prepare'],
  );
});

test('JSON deployment never prompts, even on a terminal, and emits review plus consent error', async (t) => {
  const mock = await mockedClient(t, { tty: true });
  const result = invoke(['deploy', '--json'], { ...mock.options, input: 'PUBLISH\n' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const output = events(result);
  assert.deepEqual(output[0], { type: 'review', dryRun: false, review: mock.review });
  assert.equal(output[1].type, 'error');
  assert.match(output[1].error, /Consent required/);
  assert.doesNotMatch(result.stdout, /Type PUBLISH/);
  assert.deepEqual(
    (await mock.calls()).map((call) => call.method),
    ['create', 'prepare'],
  );
});

test('a mismatched digest displays the fresh review and never invokes deploy', async (t) => {
  const mock = await mockedClient(t);
  const result = invoke(['deploy', '--json', '--consent', 'c'.repeat(64)], mock.options);
  assert.equal(result.status, 1);
  const output = events(result);
  assert.deepEqual(output[0].review, mock.review);
  assert.match(output[1].error, /Consent does not match/);
  assert.deepEqual(
    (await mock.calls()).map((call) => call.method),
    ['create', 'prepare'],
  );
});

test('matching consent deploys the same prepared review exactly once', async (t) => {
  const mock = await mockedClient(t);
  const result = invoke(['deploy', '--json', `--consent=${digest}`], mock.options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = events(result);
  assert.deepEqual(output[0].review, mock.review);
  assert.equal(output[1].type, 'result');
  assert.equal(output[1].result.published, true);
  assert.deepEqual(await mock.calls(), [
    { method: 'create', options: {} },
    { method: 'prepare' },
    { method: 'deploy', consent: digest },
  ]);
});

test('interactive refusal and EOF upload nothing; exact PUBLISH authorizes the reviewed files', async (t) => {
  for (const input of ['publish\n', 'no\n', '', 'PUBLISH\n']) {
    const mock = await mockedClient(t, { tty: true });
    const result = invoke(['deploy'], { ...mock.options, input });
    const expected = input === 'PUBLISH\n';
    assert.equal(result.status, expected ? 0 : 1, result.stderr || result.stdout);
    const deployed = (await mock.calls()).filter((call) => call.method === 'deploy');
    assert.equal(deployed.length, expected ? 1 : 0);
    if (!expected) assert.match(result.stderr, /Publication cancelled\. No upload occurred/);
  }
});

test('dry-run invokes only offline inspection even when a client is available', async (t) => {
  const mock = await mockedClient(t);
  const result = invoke(['deploy', '--dry-run', '--json'], mock.options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(events(result)[0].dryRun, true);
  assert.deepEqual(
    (await mock.calls()).map((call) => call.method),
    ['create', 'inspect'],
  );
});
