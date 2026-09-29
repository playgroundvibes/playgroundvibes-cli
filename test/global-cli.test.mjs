import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const moduleURL = new URL('../dist/skills/global-cli.js', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

async function script(directory, name, source) {
  const entry = path.join(directory, `${name}.mjs`);
  await writeFile(entry, source);
  const filename = path.join(directory, name + (process.platform === 'win32' ? '.cmd' : ''));
  await writeFile(
    filename,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${entry.replaceAll("'", "'\\''")}' "$@"\n`,
  );
  await chmod(filename, 0o755);
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'playground-global-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const managers = path.join(root, 'manager-bin');
  const globalBin = path.join(root, 'global-bin');
  const localBin = path.join(root, 'npx-cache-bin');
  const packageRoot = path.join(root, 'global-node-modules');
  const npmPackage = path.join(packageRoot, '@playgroundvibes/cli');
  const pnpmPackage = path.join(root, 'isolated-pnpm-package/node_modules/@playgroundvibes/cli');
  const project = path.join(root, 'project');
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'commands.jsonl');
  for (const directory of [managers, globalBin, localBin, npmPackage, pnpmPackage, project])
    await mkdir(directory, { recursive: true });
  await writeFile(path.join(project, '.npmrc'), 'registry=https://project.invalid/\n');
  await writeFile(stateFile, JSON.stringify({ version: options.installedVersion, ...options }));
  await writeFile(logFile, '');
  for (const directory of [npmPackage, pnpmPackage]) {
    await writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: '@playgroundvibes/cli',
        version: options.installedVersion,
        bin: { playgroundvibes: options.normalizedBin ? 'dist/cli.js' : './dist/cli.js' },
      }),
    );
  }
  const managerSource = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(readFileSync(stateFile, 'utf8'));
const manager = path.basename(import.meta.filename, '.mjs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ manager, args, cwd: process.cwd(), projectConfig: existsSync('.npmrc') }) + '\\n');
if (args[0] === 'prefix') console.log(${JSON.stringify(process.platform === 'win32' ? globalBin : root)});
else if (args[0] === 'bin') {
  if (state.binFails) process.exit(3);
  console.log(${JSON.stringify(globalBin)});
} else if (args[0] === 'root') console.log(${JSON.stringify(packageRoot)});
else if (args[0] === 'list') {
  if (state.badInventory) { console.log('invalid inventory'); process.exit(0); }
  if (state.inventoryError) { console.log(JSON.stringify({error:{code:'EFIXTURE'}})); process.exit(1); }
  const dependencies = state.version ? { '@playgroundvibes/cli': { version: state.version, path: ${JSON.stringify(pnpmPackage)} } } : {};
  if (manager === 'pnpm') console.log(JSON.stringify(state.emptyArray && !state.version ? [] : [...(state.multipleRoots ? [{dependencies:{}}] : []), {dependencies}]));
  else console.log(JSON.stringify(state.version ? { dependencies } : {name:'fixture-global'}));
  if (manager === 'npm' && (!state.version || state.inventoryFailureWithPackage)) process.exit(1);
} else if (args[0] === 'install' || args[0] === 'add') {
  console.log('Fixture installation progress on stdout');
  console.error('Fixture installation progress on stderr');
  if (state.installFails) process.exit(2);
  if (!state.noInstallEffect) {
    state.version = args.find(value => value.startsWith('@playgroundvibes/cli@')).slice('@playgroundvibes/cli@'.length);
    writeFileSync(stateFile, JSON.stringify(state));
    for (const directory of ${JSON.stringify([npmPackage, pnpmPackage])}) writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@playgroundvibes/cli', version: state.version, bin: { playgroundvibes: './dist/cli.js' } }));
  }
} else throw new Error('Unexpected fixture manager command');
`;
  for (const manager of ['npm', 'pnpm']) await script(managers, manager, managerSource);
  // npm's POSIX bin is prefix/bin, unlike the independently selected pnpm bin.
  const npmBin = process.platform === 'win32' ? globalBin : path.join(root, 'bin');
  await mkdir(npmBin, { recursive: true });
  const cliSource = `import { readFileSync } from 'node:fs'; const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8')); console.log(state.commandVersion ?? state.version ?? 'missing');`;
  await script(globalBin, 'playgroundvibes', cliSource);
  if (npmBin !== globalBin) await script(npmBin, 'playgroundvibes', cliSource);
  await script(localBin, 'playgroundvibes', `console.log(${JSON.stringify(version)});`);
  const runner = path.join(root, 'runner.mjs');
  await writeFile(
    runner,
    `import { ensureGlobalCLI } from ${JSON.stringify(moduleURL.href)};
try { console.log(JSON.stringify(await ensureGlobalCLI(process.env.FIXTURE_MANAGER || undefined))); }
catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
`,
  );
  return {
    root,
    async run(manager, env = {}) {
      const includeGlobal = options.includeGlobalPath !== false;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [runner], {
          cwd: project,
          env: {
            ...process.env,
            PATH: [
              localBin,
              managers,
              ...(includeGlobal ? [globalBin, npmBin] : []),
              process.env.PATH,
            ].join(path.delimiter),
            npm_config_user_agent: '',
            FIXTURE_MANAGER: manager ?? '',
            ...env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 20_000,
        });
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (data) => {
          stdout += data;
        });
        child.stderr.on('data', (data) => {
          stderr += data;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
      const log = await readFile(logFile, 'utf8');
      return {
        ...result,
        value: JSON.parse(result.stdout.trim()),
        commands: log
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      };
    },
  };
}

test('npm and pnpm reuse an exact verified global installation', async (t) => {
  for (const manager of ['npm', 'pnpm']) {
    const setup = await fixture(t, { installedVersion: version });
    const result = await setup.run(manager);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.value, { packageManager: manager, version, installed: false });
    assert.ok(!result.commands.some((command) => ['install', 'add'].includes(command.args[0])));
    assert.ok(
      result.commands.every((command) => command.cwd !== setup.root && !command.projectConfig),
    );
    for (const directory of new Set(result.commands.map((command) => command.cwd)))
      await assert.rejects(realpath(directory), { code: 'ENOENT' });
  }
});

test('a local or npx command never replaces missing global inventory; exact install is verified', async (t) => {
  for (const manager of ['npm', 'pnpm']) {
    const setup = await fixture(t);
    const result = await setup.run(manager);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(result.value, { packageManager: manager, version, installed: true });
    const installs = result.commands.filter((command) =>
      ['install', 'add'].includes(command.args[0]),
    );
    assert.equal(installs.length, 1);
    assert.deepEqual(installs[0].args, [
      manager === 'pnpm' ? 'add' : 'install',
      '--global',
      `@playgroundvibes/cli@${version}`,
      '--ignore-scripts',
      '--registry=https://registry.npmjs.org/',
    ]);
    assert.match(result.stderr, /progress on stdout/);
    assert.match(result.stderr, /progress on stderr/);
    assert.doesNotMatch(result.stdout, /progress/);
    assert.equal(result.commands.filter((command) => command.args[0] === 'list').length, 2);
  }
});

test('an older global release is replaced with this exact release', async (t) => {
  const setup = await fixture(t, { installedVersion: '0.0.1' });
  const result = await setup.run('pnpm');
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.value.installed, true);
  assert.ok(
    result.commands.some((command) => command.args.includes(`@playgroundvibes/cli@${version}`)),
  );
});

test('pnpm empty and multiple-root inventories and normalized bin manifests are supported', async (t) => {
  for (const options of [
    { emptyArray: true },
    { installedVersion: version, multipleRoots: true, normalizedBin: true },
  ]) {
    const setup = await fixture(t, options);
    const result = await setup.run('pnpm');
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.value.version, version);
  }
});

test('manager selection follows explicit override, then pnpm user agent, then npm', async (t) => {
  for (const [explicit, agent, expected] of [
    [undefined, 'pnpm/12.4.2 npm/? node/v24', 'pnpm'],
    [undefined, '', 'npm'],
    ['npm', 'pnpm/12.4.2', 'npm'],
  ]) {
    const setup = await fixture(t, { installedVersion: version });
    const result = await setup.run(explicit, { npm_config_user_agent: agent });
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.value.packageManager, expected);
  }
});

test('missing persistent global PATH setup blocks installation and permission readiness', async (t) => {
  for (const manager of ['npm', 'pnpm']) {
    const setup = await fixture(t, { installedVersion: version, includeGlobalPath: false });
    const result = await setup.run(manager);
    assert.equal(result.code, 1);
    assert.match(result.value.error, /not on PATH/);
    assert.ok(!result.commands.some((command) => ['install', 'add'].includes(command.args[0])));
  }
  const setup = await fixture(t, { binFails: true });
  const result = await setup.run('pnpm');
  assert.equal(result.code, 1);
  assert.match(result.value.error, /pnpm setup yourself/);
});

test('failed or ineffective installations and mismatched global shims never report success', async (t) => {
  for (const options of [
    { installFails: true },
    { noInstallEffect: true },
    { installedVersion: version, commandVersion: '0.0.1' },
    { badInventory: true },
    { inventoryError: true },
    { installedVersion: version, inventoryFailureWithPackage: true },
  ]) {
    const setup = await fixture(t, options);
    const result = await setup.run('npm');
    assert.equal(result.code, 1, result.stdout);
    assert.ok(result.value.error);
    assert.equal(result.value.installed, undefined);
  }
});
