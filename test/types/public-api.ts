import {
  createPlaygroundClient,
  ConsentError,
  ScanError,
  type ConnectionInfo,
  type ArtifactKind,
  type DeploymentResult,
  type Manifest,
  type Review,
} from '@playgroundvibes/cli';
import {
  scanText,
  CREDENTIAL_PATTERNS,
  INSPECTION_LIMITS,
  type CredentialPattern,
} from '@playgroundvibes/cli/filtering';
import {
  installSkill,
  type InstallSkillOptions,
  type ClaudePermissionResult,
  type GlobalCLIResult,
  type SkillPackageManager,
} from '@playgroundvibes/cli/skills';

const manifest: Manifest = {
  title: 'Demo',
  summary: 'A browser application',
  license: 'MIT',
  remix: true,
};
const sourceOnlyManifest: Manifest = { ...manifest, source_only: true };
void sourceOnlyManifest;
const coverKind: ArtifactKind = 'cover';
void coverKind;
const installation: InstallSkillOptions = { cwd: '/project' };
const claudeInstallation: InstallSkillOptions = {
  cwd: '/project',
  claude: true,
  allowClaudeCommands: true,
  packageManager: 'pnpm',
};
async function installForClaude(): Promise<ClaudePermissionResult | undefined> {
  return (await installSkill(claudeInstallation)).claudePermissions;
}
void installForClaude;
async function ensureSkillDependency(): Promise<GlobalCLIResult | undefined> {
  const result = await installSkill(claudeInstallation);
  const manager: SkillPackageManager | undefined = result.globalCLI?.packageManager;
  void manager;
  return result.globalCLI;
}
void ensureSkillDependency;
void manifest;
void installation;
void installSkill;
void scanText('export const greeting = "hello";', 'main.ts');
const patterns: readonly CredentialPattern[] = CREDENTIAL_PATTERNS;
const sourceLimit: number = INSPECTION_LIMITS.sourceFileBytes;
void patterns;
void sourceLimit;
// @ts-expect-error The published credential policy cannot be edited.
CREDENTIAL_PATTERNS[0]!.pattern = 'different';

async function consumingApplication(review: Review): Promise<DeploymentResult> {
  const client = createPlaygroundClient({ cwd: '/project' });
  const account: ConnectionInfo = await client.whoami();
  const id: string = account.account_id;
  void id;
  // @ts-expect-error Credentials are not part of the public connection result.
  account.token;
  // @ts-expect-error A reviewed snapshot cannot be edited.
  review.digest = 'different';
  // @ts-expect-error Reviewed files are immutable too.
  review.files.push({ artifact: 'source', path: 'new.ts', bytes: 0, sha256: '' });
  // @ts-expect-error Metadata has known fields rather than an arbitrary dictionary.
  review.metadata.anything;
  // @ts-expect-error Publishing always requires an explicit consent argument.
  await client.deploy(review);
  const result = await client.deploy(review, { consent: review.digest });
  const status: 'imported' | 'existing' = result.status;
  void status;
  return result;
}
void consumingApplication;

function handleError(error: unknown): void {
  if (error instanceof ScanError) error.findings.forEach((finding) => console.error(finding.rule));
  if (error instanceof ConsentError) console.error(error.message);
}
void handleError;
