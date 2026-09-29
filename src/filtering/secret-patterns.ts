import { lineAt, type ScanFinding } from './findings.js';

export interface CredentialPattern {
  readonly name: string;
  readonly rule: 'credential/private-key' | 'credential/provider-token';
  /** JavaScript regular-expression source, with the original word boundaries. */
  readonly pattern: string;
}

/** These are exactly the credential patterns from the supplied uploader's policy. */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = Object.freeze(
  [
    {
      name: 'Private key',
      rule: 'credential/private-key',
      pattern: String.raw`-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY)-----`,
    },
    {
      name: 'Playground import',
      rule: 'credential/provider-token',
      pattern: String.raw`\bpgimport_[a-f0-9]{64}\b`,
    },
    {
      name: 'Playground sync',
      rule: 'credential/provider-token',
      pattern: String.raw`\bpgsync_[a-f0-9]{64}\b`,
    },
    {
      name: 'OpenAI / Anthropic',
      rule: 'credential/provider-token',
      pattern: String.raw`\bsk-(?:proj-|ant-api\d+-|ant-)?[A-Za-z0-9_-]{20,}\b`,
    },
    {
      name: 'GitHub classic',
      rule: 'credential/provider-token',
      pattern: String.raw`\bgh[pousr]_[A-Za-z0-9]{24,}\b`,
    },
    {
      name: 'GitHub fine-grained',
      rule: 'credential/provider-token',
      pattern: String.raw`\bgithub_pat_[A-Za-z0-9_]{24,}\b`,
    },
    {
      name: 'AWS',
      rule: 'credential/provider-token',
      pattern: String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
    },
    {
      name: 'Slack',
      rule: 'credential/provider-token',
      pattern: String.raw`\bxox[baprs]-[A-Za-z0-9-]{20,}\b`,
    },
  ].map((definition) => Object.freeze(definition as CredentialPattern)),
);

export function collectPatternFindings(content: string, path: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const { pattern, rule } of CREDENTIAL_PATTERNS) {
    for (const match of content.matchAll(new RegExp(pattern, 'g'))) {
      findings.push({ path, line: lineAt(content, match.index), rule });
      // Keep diagnostics small without retaining any matched credential values.
      if (findings.length === 20) return findings;
    }
  }
  return findings;
}
