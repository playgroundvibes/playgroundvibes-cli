export type License = 'MIT' | 'Apache-2.0' | 'CC-BY-4.0' | 'All rights reserved';
export type CreationTool = 'Claude' | 'Codex' | 'ChatGPT' | 'Cursor' | 'Other';
export type Provider = 'openai' | 'anthropic' | 'google' | 'tripo';
export type PrimaryDevice = 'desktop' | 'mobile' | 'both' | 'unspecified';

export type ProjectCategory =
  | 'Tools'
  | 'AI Tools'
  | 'AI Agents'
  | 'Generative AI'
  | 'Automations'
  | 'Games'
  | 'Simulations'
  | 'Websites'
  | 'Dashboards'
  | 'Data & Analytics'
  | 'Developer Tools'
  | 'Infrastructure'
  | 'Security & Privacy'
  | 'Hardware & Robotics'
  | 'Productivity'
  | 'Design & Creative'
  | 'Art'
  | 'Generative Art'
  | '3D & Spatial'
  | 'Music & Audio'
  | 'Video & Animation'
  | 'Writing & Content'
  | 'Education'
  | 'Research'
  | 'Science'
  | 'Nature & Environment'
  | 'Crypto'
  | 'Finance'
  | 'Finance & Crypto'
  | 'Commerce'
  | 'Social & Community'
  | 'Health & Fitness'
  | 'Lifestyle & Planning'
  | 'Other';

export interface CreationService {
  readonly name: string;
  readonly purpose: string;
  readonly url?: string;
}

export interface CreationDetails {
  /** Leave empty when the tools are unknown; the CLI does not infer provenance. */
  readonly tools: readonly CreationTool[];
  /** Owner-supplied model name, or empty text when unknown. */
  readonly model: string;
  readonly services?: readonly CreationService[];
  readonly primary_device?: PrimaryDevice;
}

export interface ProviderRequirement {
  readonly provider: Provider;
  readonly model: string;
}

/** The editable, local .playground/manifest.json format. */
export interface Manifest {
  readonly title: string;
  readonly summary: string;
  readonly description?: string;
  readonly category?: ProjectCategory;
  readonly tags?: readonly string[];
  readonly license?: License;
  readonly remix?: boolean;
  readonly repo_url?: string;
  readonly live_url?: string;
  readonly provider_requirements?: readonly ProviderRequirement[] | null;
  readonly creation_details?: CreationDetails | null;
  readonly source_id?: string;
  readonly date?: string;
  readonly source_dir?: string;
  /** Browser output relative to .playground/; omitted paths are detected in dist, build, or out. */
  readonly build_dir?: string;
  /** Explicitly publish without a browser build. Cannot be combined with build_dir. */
  readonly source_only?: boolean;
  readonly cover_file?: string;
}

/** Validated metadata shown in a review and sent with the inspected artifacts. */
export interface ProjectMetadata {
  readonly source_id: string;
  readonly date: string;
  readonly title: string;
  readonly summary: string;
  readonly category: ProjectCategory;
  readonly license: License;
  readonly remix: boolean;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly repo_url?: string;
  readonly live_url?: string;
  readonly provider_requirements?: readonly ProviderRequirement[] | null;
  readonly creation_details?: CreationDetails | null;
}
