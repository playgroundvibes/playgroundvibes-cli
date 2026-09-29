// Publishing: preparation and explicit consent are the only route to artifact uploads.
export { createPlaygroundClient } from './client.js';
export { ConsentError } from './publishing/consent.js';
export { ScanError } from './filtering/index.js';
export type { ClientOptions, PlaygroundClient } from './client.js';
export type {
  Review,
  ReviewFile,
  ExcludedFile,
  ArtifactKind,
  DeploymentConsent,
  DeploymentResult,
} from './publishing/types.js';
export type { ConnectionInfo, LogoutResult } from './auth/types.js';
export type { PlaygroundTransport, PlaygroundEndpoint } from './api/transport.js';

// Project configuration and validated review metadata.
export type {
  Manifest,
  ProjectMetadata,
  CreationDetails,
  CreationService,
  ProviderRequirement,
  License,
  ProjectCategory,
  CreationTool,
  Provider,
  PrimaryDevice,
} from './project/types.js';

// Skill installation has no publication side effects.
export { getSkillPath, installSkill } from './skills/install.js';
export type { InstallSkillOptions, InstallSkillResult } from './skills/install.js';
