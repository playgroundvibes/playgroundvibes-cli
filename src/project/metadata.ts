import { createHash } from 'node:crypto';
import type { JsonObject } from '../api/transport.js';
import type {
  CreationDetails,
  CreationService,
  CreationTool,
  License,
  PrimaryDevice,
  ProjectCategory,
  ProjectMetadata,
  Provider,
  ProviderRequirement,
} from './types.js';
import { parsePublicHttpsURL } from './public-url.js';

const categories = new Set([
  'Tools',
  'AI Tools',
  'AI Agents',
  'Generative AI',
  'Automations',
  'Games',
  'Simulations',
  'Websites',
  'Dashboards',
  'Data & Analytics',
  'Developer Tools',
  'Infrastructure',
  'Security & Privacy',
  'Hardware & Robotics',
  'Productivity',
  'Design & Creative',
  'Art',
  'Generative Art',
  '3D & Spatial',
  'Music & Audio',
  'Video & Animation',
  'Writing & Content',
  'Education',
  'Research',
  'Science',
  'Nature & Environment',
  'Crypto',
  'Finance',
  'Finance & Crypto',
  'Commerce',
  'Social & Community',
  'Health & Fitness',
  'Lifestyle & Planning',
  'Other',
]);
const licenses = new Set(['MIT', 'Apache-2.0', 'CC-BY-4.0', 'All rights reserved']);
const tools = new Set(['Claude', 'Codex', 'ChatGPT', 'Cursor', 'Other']);
const providers = new Set(['openai', 'anthropic', 'google', 'tripo']);
const devices = new Set(['desktop', 'mobile', 'both', 'unspecified']);

function boundedText(
  value: unknown,
  label: string,
  max: number,
  required = false,
  singleLine = false,
): string | undefined {
  if (value === undefined && !required) return undefined;
  const controls = singleLine
    ? /[\u0000-\u001f\u007f]/u
    : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && !value.trim()) ||
    controls.test(value)
  ) {
    throw new Error(`${label} must be ${required ? 'nonempty ' : ''}text up to ${max} characters.`);
  }
  return value;
}

function shape(value: unknown, label: string, required: string[], allowed: string[]): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  const object = value as JsonObject;
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) => !allowed.includes(key))
  ) {
    throw new Error(`${label} has missing or unsupported fields.`);
  }
  return object;
}

function creationDetails(value: unknown): CreationDetails | null | undefined {
  if (value === undefined || value === null) return value;
  const creation = shape(
    value,
    'creation_details',
    ['tools', 'model'],
    ['tools', 'model', 'services', 'primary_device'],
  );
  if (
    !Array.isArray(creation.tools) ||
    creation.tools.length > 5 ||
    creation.tools.some((tool) => typeof tool !== 'string' || !tools.has(tool))
  ) {
    throw new Error('Choose up to five supported creation tools.');
  }
  // Empty tools/model are permitted by the service when provenance is unknown.
  // Do not infer either from the CLI, machine, or coding assistant running it.
  if (typeof creation.model !== 'string')
    throw new Error('creation_details.model must be a supplied model name or empty text.');
  boundedText(creation.model, 'creation_details.model', 100, false, true);
  if (
    creation.primary_device !== undefined &&
    (typeof creation.primary_device !== 'string' || !devices.has(creation.primary_device))
  ) {
    throw new Error('Choose desktop, mobile, both, or unspecified for primary_device.');
  }
  if (
    creation.services !== undefined &&
    (!Array.isArray(creation.services) || creation.services.length > 12)
  )
    throw new Error('List up to 12 creation services.');
  const seen = new Set<string>();
  const services: CreationService[] = [];
  for (const value of (creation.services as unknown[] | undefined) ?? []) {
    const service = shape(
      value,
      'Creation service',
      ['name', 'purpose'],
      ['name', 'purpose', 'url'],
    );
    const name = boundedText(service.name, 'Service name', 80, true, true)!;
    const purpose = boundedText(service.purpose, 'Service purpose', 240, true, true)!;
    const normalized = name.trim().toLowerCase();
    if (seen.has(normalized)) throw new Error('List each creation service only once.');
    seen.add(normalized);
    const website = boundedText(service.url, 'Service URL', 500, false, true);
    if (website) parsePublicHttpsURL(website, 'Service URL', true);
    services.push({ name, purpose, ...(website !== undefined ? { url: website } : {}) });
  }
  return {
    tools: [...creation.tools] as CreationTool[],
    model: creation.model,
    ...(creation.primary_device !== undefined
      ? { primary_device: creation.primary_device as PrimaryDevice }
      : {}),
    ...(creation.services !== undefined ? { services } : {}),
  };
}

function providerRequirements(value: unknown): readonly ProviderRequirement[] | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.length > 4)
    throw new Error('Choose up to four API providers.');
  const seen = new Set<string>();
  const requirements: ProviderRequirement[] = [];
  for (const item of value) {
    const requirement = shape(
      item,
      'Provider requirement',
      ['provider', 'model'],
      ['provider', 'model'],
    );
    if (
      typeof requirement.provider !== 'string' ||
      !providers.has(requirement.provider) ||
      seen.has(requirement.provider) ||
      typeof requirement.model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(requirement.model)
    ) {
      throw new Error('Set each supported provider once with a valid model ID.');
    }
    seen.add(requirement.provider);
    requirements.push({ provider: requirement.provider as Provider, model: requirement.model });
  }
  return requirements;
}

function validateDate(date: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(date);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    !match ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    !Number.isFinite(Date.parse(date)) ||
    Date.parse(date) > Date.now() + 86_400_000
  ) {
    throw new Error('date must be an ISO creation date, not an invalid or future date.');
  }
}

interface MetadataIdentity {
  readonly source_id?: unknown;
  readonly date?: unknown;
}

/** Construct validated, publishable metadata from untrusted manifest values. */
export function buildMetadata(
  manifest: JsonObject,
  identity: MetadataIdentity,
  root: string,
): ProjectMetadata {
  const title = boundedText(manifest.title, 'title', 100, true)!;
  const summary = boundedText(manifest.summary, 'summary', 240, true)!;
  const description = boundedText(manifest.description, 'description', 12_000);
  const category = manifest.category === undefined ? 'Tools' : manifest.category;
  if (typeof category !== 'string' || !categories.has(category))
    throw new Error('Choose a supported project category.');
  const license = manifest.license === undefined ? 'All rights reserved' : manifest.license;
  if (typeof license !== 'string' || !licenses.has(license))
    throw new Error('Choose a supported source license.');
  const remix = manifest.remix === undefined ? false : manifest.remix;
  if (typeof remix !== 'boolean') throw new Error('remix must be true or false.');
  if (license === 'All rights reserved' && remix)
    throw new Error('All rights reserved projects cannot enable remix.');
  if (
    manifest.tags !== undefined &&
    (!Array.isArray(manifest.tags) ||
      manifest.tags.length > 5 ||
      manifest.tags.some(
        (tag) =>
          typeof tag !== 'string' ||
          tag.length > 36 ||
          /[\u0000-\u001f\u007f]/u.test(tag) ||
          !/[\p{L}\p{N}+#]/u.test(tag.normalize('NFKC')),
      ))
  ) {
    throw new Error('Use up to five meaningful tags of at most 36 characters.');
  }
  const links: { live_url?: string; repo_url?: string } = {};
  for (const key of ['live_url', 'repo_url'] as const) {
    const value = boundedText(manifest[key], key, 2048);
    if (value !== undefined) links[key] = value;
    if (!value) continue;
    const url = parsePublicHttpsURL(value, key, key === 'repo_url');
    if (
      key === 'repo_url' &&
      (url.hostname !== 'github.com' || url.port || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname))
    ) {
      throw new Error('repo_url must be a root GitHub repository URL.');
    }
  }
  const requirements = providerRequirements(manifest.provider_requirements);
  const creation = creationDetails(manifest.creation_details);
  if (
    identity.source_id !== undefined &&
    manifest.source_id !== undefined &&
    identity.source_id !== manifest.source_id
  ) {
    throw new Error('Preserve the source_id of the linked project.');
  }
  const sourceId = boundedText(
    identity.source_id ??
      manifest.source_id ??
      `cli-${createHash('sha256').update(root).digest('hex')}`,
    'source_id',
    500,
    true,
  )!;
  const date = boundedText(
    identity.date ?? manifest.date ?? new Date().toISOString().slice(0, 10),
    'date',
    50,
    true,
  )!;
  validateDate(date);
  return {
    title,
    summary,
    category: category as ProjectCategory,
    license: license as License,
    remix,
    source_id: sourceId,
    date,
    ...links,
    ...(description !== undefined ? { description } : {}),
    ...(manifest.tags !== undefined ? { tags: [...(manifest.tags as string[])] } : {}),
    ...(requirements !== undefined ? { provider_requirements: requirements } : {}),
    ...(creation !== undefined ? { creation_details: creation } : {}),
  };
}
