import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export type ExclusionSource = 'built-in' | 'gitignore' | 'playgroundignore';

export interface ExclusionMatch {
  reason: string;
  source: ExclusionSource;
  /** Built-in policy ID, or the matching pattern from an ignore file. */
  rule: string;
  ignoreFile?: string;
  line?: number;
}

export interface PathExclusionRule {
  readonly id: string;
  readonly reason: string;
  readonly match: 'component-name' | 'component-pattern' | 'path-pattern';
  readonly patterns: readonly string[];
}

function rule(definition: PathExclusionRule): PathExclusionRule {
  return Object.freeze({ ...definition, patterns: Object.freeze([...definition.patterns]) });
}

/** Mandatory rules run before user ignore files. An ignore negation cannot undo them. */
export const BUILT_IN_EXCLUSIONS: readonly PathExclusionRule[] = Object.freeze([
  rule({
    id: 'environment-files',
    reason: 'environment file',
    match: 'component-pattern',
    patterns: ['^\\.env(?:\\..*)?$', '^\\.envrc$'],
  }),
  rule({
    id: 'version-control',
    reason: 'version-control metadata',
    match: 'component-name',
    patterns: ['.git', '.git-credentials', '.hg', '.svn'],
  }),
  rule({
    id: 'dependencies',
    reason: 'dependency or runtime cache',
    match: 'component-name',
    patterns: ['node_modules', 'vendor', '.venv', 'venv', '__pycache__'],
  }),
  rule({
    id: 'generated-directories',
    reason: 'generated files or local Playground settings',
    match: 'component-name',
    patterns: [
      '.cache',
      '.next',
      '.nuxt',
      'coverage',
      '.playground',
      '.sites-runtime',
      '.wrangler',
    ],
  }),
  rule({
    id: 'private-settings',
    reason: 'private account or tool settings',
    match: 'component-name',
    patterns: [
      '.aws',
      '.azure',
      '.config',
      '.ssh',
      '.gnupg',
      '.openai',
      '.npmrc',
      '.pypirc',
      '.netrc',
      '.docker',
      '.kube',
    ],
  }),
  rule({
    id: 'assistant-settings',
    reason: 'local assistant settings',
    match: 'component-name',
    patterns: ['.codex', '.claude', '.agents', '.cursor'],
  }),
  rule({
    id: 'assistant-history',
    reason: 'local assistant history or settings',
    match: 'component-pattern',
    patterns: ['^\\.aider.*$'],
  }),
  rule({
    id: 'editor-settings',
    reason: 'local editor history or settings',
    match: 'component-name',
    patterns: ['.history', '.idea', '.vscode', '.DS_Store'],
  }),
  rule({
    id: 'credential-filenames',
    reason: 'credential or service account file',
    match: 'component-pattern',
    patterns: [
      '^credentials.*$',
      '^secrets?.*$',
      '^service[-_]?account.*$',
      '^id_rsa$',
      '^id_ed25519$',
    ],
  }),
  rule({
    id: 'private-keys-and-logs',
    reason: 'private key, credential, or log file',
    match: 'path-pattern',
    patterns: ['\\.(?:pem|key|p12|pfx|jks|keystore|log)$'],
  }),
  rule({
    id: 'private-records',
    reason: 'private conversation or user data',
    match: 'path-pattern',
    patterns: ['(?:^|/)(?:conversations?|chats?|messages?|users?)\\.(?:json|jsonl|html|csv|txt)$'],
  }),
  rule({
    id: 'source-maps',
    reason: 'source maps are not uploaded',
    match: 'path-pattern',
    patterns: ['\\.map$'],
  }),
]);

// Compile internal matchers separately from the public, immutable policy descriptions.
const compiledRules = BUILT_IN_EXCLUSIONS.map((definition) => ({
  definition,
  names: new Set(definition.patterns.map((value) => value.toLowerCase())),
  expressions:
    definition.match === 'component-name'
      ? []
      : definition.patterns.map((value) => new RegExp(value, 'i')),
}));

export function builtInExclusion(projectPath: string): ExclusionMatch | undefined {
  const components = projectPath.split('/');
  for (const { definition, names, expressions } of compiledRules) {
    let matched: boolean;
    switch (definition.match) {
      case 'component-name':
        matched = components.some((component) => names.has(component.toLowerCase()));
        break;
      case 'component-pattern':
        matched = components.some((component) =>
          expressions.some((pattern) => pattern.test(component)),
        );
        break;
      case 'path-pattern':
        matched = expressions.some((pattern) => pattern.test(projectPath));
        break;
    }
    if (matched) return { source: 'built-in', rule: definition.id, reason: definition.reason };
  }
  return undefined;
}

export function structuralExclusion(
  artifactPath: string,
  isSymlink: boolean,
  build: boolean,
): ExclusionMatch | undefined {
  if (isSymlink) return { source: 'built-in', rule: 'symbolic-links', reason: 'symbolic link' };
  const topLevel = artifactPath.split('/')[0]?.toLowerCase();
  if (!build && topLevel && ['dist', 'build', 'out'].includes(topLevel)) {
    return {
      source: 'built-in',
      rule: 'separate-build-output',
      reason: 'separate browser build output',
    };
  }
  return undefined;
}

export function safePath(name: string): boolean {
  const forbiddenCharacters = /[\\:\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
  const validComponents = name
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
  return !!name && name.length <= 240 && !forbiddenCharacters.test(name) && validComponents;
}

export interface IgnoreScope {
  directory: string;
  file: string;
  source: 'gitignore' | 'playgroundignore';
  matcher: Ignore;
}

export function parseIgnoreFile(content: string, scope: Omit<IgnoreScope, 'matcher'>): IgnoreScope {
  const matcher = ignore();
  content.split(/\r?\n/).forEach((pattern, index) => {
    matcher.add({ pattern, mark: String(index + 1) });
  });
  return { ...scope, matcher };
}

/** Later nested .gitignore files can reverse earlier matches, as before. */
export function matchIgnoreFiles(
  fullPath: string,
  isDirectory: boolean,
  scopes: readonly IgnoreScope[],
): ExclusionMatch | undefined {
  let match: ExclusionMatch | undefined;
  for (const scope of scopes) {
    const relativePath = path.relative(scope.directory, fullPath).split(path.sep).join('/');
    const result = scope.matcher.checkIgnore(relativePath + (isDirectory ? '/' : ''));
    if (result.ignored) {
      match = {
        source: scope.source,
        rule: result.rule?.pattern ?? '(inherited ignored directory)',
        reason: scope.source === 'gitignore' ? '.gitignore' : '.playgroundignore',
        ignoreFile: scope.file,
        ...(result.rule?.mark ? { line: Number(result.rule.mark) } : {}),
      };
    }
    if (result.unignored) match = undefined;
  }
  return match;
}
