import { lineAt, type ScanFinding } from './findings.js';

const credentialKeyPatterns = [
  'api[_-]?key',
  'access[_-]?key',
  'access[_-]?token',
  'auth[_-]?token',
  'refresh[_-]?token',
  'client[_-]?secret',
  'private[_-]?key',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
];
const credentialKey = '(?:' + credentialKeyPatterns.join('|') + ')';

// Supplemental formats retained alongside Secretlint's recommended provider rules.
const providerTokens = [
  { provider: 'Playground', pattern: /\bpg(?:import|sync)_[a-f0-9]{64}\b/g },
  {
    provider: 'OpenAI / Anthropic',
    pattern: /\bsk-(?:proj-|ant-api\d+-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  { provider: 'GitHub classic', pattern: /\bgh[pousr]_[A-Za-z0-9]{24,}\b/g },
  { provider: 'GitHub fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{24,}\b/g },
  { provider: 'npm', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { provider: 'Google', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { provider: 'AWS', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { provider: 'Slack', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  {
    provider: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

// Quoted source/config values and bare environment/config assignments are distinct
// cases; references to environment variables are not embedded credential values.
const assignmentPattern = new RegExp(
  `(?:["'\\x60]?\\b[\\w-]*?${credentialKey}["'\\x60]?)\\s*[:=]\\s*(["'\\x60])([^\\r\\n]*?)\\1`,
  'gi',
);
const environmentPattern =
  /^(?:\s*export\s+|\s*)(?:[A-Z0-9]+_)*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|APIKEY)\s*=\s*([^\s#"'`]+)/gm;
const unquotedConfigPattern = new RegExp(
  `(?:^|[\\n\\r])\\s*[\\w-]*?${credentialKey}\\s*[:=]\\s*([^\\s#,"'\\x60]+)`,
  'gi',
);
const dynamicReference =
  /^(?:\$\{[A-Za-z_][\w.]*\}|\$\{\{\s*(?:secrets|vars|env)\.[\w.]+\s*\}\}|(?:process\.env|import\.meta\.env)\.[\w]+)$/;

export function collectPatternFindings(content: string, name: string): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const add = (index: number, rule: string) =>
    findings.push({ path: name, line: lineAt(content, index), rule });
  for (const { pattern } of providerTokens) {
    for (const match of content.matchAll(pattern)) add(match.index, 'credential/provider-token');
  }
  for (const match of content.matchAll(/-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY)-----/g))
    add(match.index, 'credential/private-key');
  for (const match of content.matchAll(assignmentPattern)) {
    if (match[2]!.trim() && !dynamicReference.test(match[2]!.trim()))
      add(match.index, 'credential/assignment');
  }
  for (const match of content.matchAll(environmentPattern)) {
    if (!dynamicReference.test(match[1]!)) add(match.index, 'credential/environment-assignment');
  }
  if (/\.(?:ya?ml|toml|ini|conf|properties)$/i.test(name)) {
    for (const match of content.matchAll(unquotedConfigPattern)) {
      if (!dynamicReference.test(match[1]!)) add(match.index, 'credential/config-assignment');
    }
  }
  for (const match of content.matchAll(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{12,}/gi))
    add(match.index, 'credential/authorization');
  for (const match of content.matchAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>`]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password) add(match.index, 'credential/url-userinfo');
      for (const [key, value] of url.searchParams) {
        if (value && new RegExp(`^(?:${credentialKey}|key)$`, 'i').test(key))
          add(match.index, 'credential/url-query');
      }
    } catch {
      /* Non-URL source expressions are covered by the other rules. */
    }
  }
  return findings;
}
