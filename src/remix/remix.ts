import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ORIGIN } from '../api/transport.js';
import { createAuth } from '../auth/connection.js';
import { buildMetadata } from '../project/metadata.js';
import { ARCHIVE_LIMIT, extractSource } from './archive.js';

export function parseProjectUrl(input: string): { projectId: string; versionId?: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Use a complete Playground project URL.');
  }
  if (url.origin !== ORIGIN || url.username || url.password)
    throw new Error('Use a playgroundvibes.com project URL.');
  const route =
    url.hash.startsWith('#project/') || url.hash.startsWith('#/project/')
      ? url.hash.slice(1).replace(/^\//, '')
      : url.pathname.replace(/^\//, '') + url.search;
  const match = /^project\/([\w-]{1,100})\/?(?:\?(.*))?$/.exec(route);
  if (!match) throw new Error('Use a Playground project URL, optionally with ?version=VERSION.');
  const versionId = new URLSearchParams(match[2] || '').get('version') || undefined;
  if (versionId && !/^[\w-]{1,100}$/.test(versionId)) throw new Error('Invalid project version.');
  return { projectId: match[1]!, ...(versionId ? { versionId } : {}) };
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('Playground returned no remix details.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Remix details exceed the permitted size.');
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid remix details.');
  return value as Record<string, unknown>;
}
async function get(url: string, token?: string): Promise<Response> {
  return fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(600_000),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
async function download(url: string, filename: string, token?: string): Promise<void> {
  let response = await get(url, token);
  for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.status); redirects++) {
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects >= 3) throw new Error('Source download redirected unexpectedly.');
    const target = new URL(location, url);
    if (
      target.protocol !== 'https:' ||
      target.port ||
      target.username ||
      target.password ||
      !(
        (target.hostname === 'github.com' &&
          /^\/[\w.-]+\/[\w.-]+\/archive\/[a-f0-9]{40}\.zip$/.test(target.pathname)) ||
        (target.hostname === 'codeload.github.com' &&
          /^\/[\w.-]+\/[\w.-]+\/zip\/[a-f0-9]{40}$/.test(target.pathname))
      )
    )
      throw new Error('Source must be a saved Playground archive or an exact GitHub commit.');
    url = target.href;
    response = await get(url); // Never forward Playground credentials to GitHub.
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      `Source download is unavailable (HTTP ${response.status}). Ask the creator to share a source ZIP.`,
    );
  }
  const output = await fs.open(filename, 'wx', 0o600);
  let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > ARCHIVE_LIMIT) throw new Error('Source archive exceeds the download limit.');
      await output.writeFile(chunk);
    }
  } finally {
    await output.close();
  }
}

/** Download only. The coding agent inspects and runs the project's documented setup. */
export async function remixProject(
  input: string,
  selectedDirectory?: string,
  configDir?: string,
): Promise<{ directory: string; original: string; files: number; bytes: number; message: string }> {
  const { projectId, versionId } = parseProjectUrl(input);
  const endpoint = `${ORIGIN}/api/projects/${projectId}/remix${versionId ? '?version=' + versionId : ''}`;
  let token: string | undefined;
  let response = await get(endpoint);
  if ([401, 402, 403, 404].includes(response.status)) {
    const status = response.status;
    await response.body?.cancel();
    try {
      token = (await createAuth({ configDir }).account()).token;
    } catch {
      throw new Error(
        `Shared source is unavailable (HTTP ${status}). If this project needs account access, run playgroundvibes login and connect first.`,
      );
    }
    response = await get(endpoint, token);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `This project version cannot be remixed (HTTP ${response.status}). Check its shared source and your access on Playground.`,
    );
  }
  const info = await boundedJson(response);
  if (
    info.version !== 1 ||
    info.project_id !== projectId ||
    typeof info.version_id !== 'string' ||
    !/^[\w-]{1,100}$/.test(info.version_id) ||
    (versionId && info.version_id !== versionId) ||
    !['project', 'github'].includes(String(info.archive_root))
  )
    throw new Error('Playground returned mismatched remix details.');
  const sourcePath = `/api/projects/${projectId}/zip?version=${info.version_id}`;
  if (info.source_url !== sourcePath)
    throw new Error('Playground returned an unexpected source URL.');
  const original = `${ORIGIN}/project/${projectId}?version=${info.version_id}`;
  const title = typeof info.title === 'string' ? info.title : '';
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'project';
  const directory = path.resolve(selectedDirectory || slug + '-remix');
  const metadata = buildMetadata(
    {
      title: (title.slice(0, 90) + ' — remix').slice(0, 100),
      summary: info.summary,
      description: info.description,
      category: info.category,
      tags: info.tags,
      license: info.license,
      remix: true,
      share_source: true,
      provider_requirements: info.provider_requirements,
      creation_details: info.creation_details,
      source_id: 'remix-' + randomUUID(),
      date: new Date().toISOString().slice(0, 10),
      remix_of: { project_id: projectId, version_id: info.version_id },
    },
    {},
    directory,
  );
  const parent = await fs.realpath(path.dirname(directory));
  if (parent !== path.dirname(directory) && process.platform !== 'darwin')
    throw new Error('Choose a destination without symlinked parent directories.');
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch {
    throw new Error(
      'Choose a new remix directory inside an existing folder. Existing directories are never overwritten.',
    );
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'playground-remix-'));
  try {
    const archive = path.join(temporary, 'source.zip');
    await download(ORIGIN + sourcePath, archive, token);
    const extracted = await extractSource(archive, directory, info.archive_root === 'github');
    await fs.mkdir(path.join(directory, '.playground'), { mode: 0o700 });
    await fs.writeFile(
      path.join(directory, '.playground', 'manifest.json'),
      JSON.stringify({ ...metadata, source_dir: '..' }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    const guide = path.join(directory, 'PLAYGROUND.md');
    try {
      await fs.rename(guide, path.join(directory, '.playground', 'original-playground.md'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.writeFile(
      guide,
      `# This project's Playground remix\n\nOriginal: ${original}\n\nThis folder is an independent remix. Preserve the original license and attribution.\n\n## Run locally\n\nRead the project's README and dependency/build configuration. Install dependencies with its package manager, identify required environment variables, and use your own service credentials. Record the verified install and run commands in this section after setup. The download command does not execute project code.\n\n## Push changes to Playground\n\nWhen the user asks to publish or push changes, use the current @playgroundvibes/cli. Preserve .playground/manifest.json (including remix_of and source_id) and .playground/project.json. The first deployment creates your project; later deployments update that same remix.\n\nRun npx @playgroundvibes/cli@latest whoami and reuse the existing connection. Connect via playgroundvibes.com/#new only when needed. Prepare and verify the browser build, update the manifest's build_dir (relative to .playground/), title, summary, services and optional coding-model credits, then run npx @playgroundvibes/cli@latest deploy --dry-run --json. When publication is requested, run deploy --json to obtain its account-bound review, then deploy --json --consent DIGEST with that exact review digest. A source-only upload requires the user's choice; do not silently downgrade a failed build. Check deploy/status output until processing finishes and report the actual publication and preview state.\n\nRemixes default to a public listing, checked source downloads and further remixing under the original license. Review included files and sharing choices when publishing. Playground can improve supported uploads; a later local push replaces those server changes. It does not merge changes back into the original.\n`,
    );
    for (const file of ['AGENTS.md', 'CLAUDE.md'])
      await fs.appendFile(
        path.join(directory, file),
        '\n\n## Playground remix\nRead PLAYGROUND.md for this folder’s original project, local setup and publishing instructions. This folder has its own Playground identity; preserve .playground/manifest.json and any later .playground/project.json.\n',
      );
    await fs.appendFile(
      path.join(directory, '.gitignore'),
      '\n# Local Playground identity and credentials\n/.playground/\n/.playground-key\n',
    );
    return {
      directory,
      original,
      ...extracted,
      message:
        'Local remix downloaded. Read PLAYGROUND.md and the project README to set it up. Nothing has been published; the first deploy creates your linked remix.',
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
