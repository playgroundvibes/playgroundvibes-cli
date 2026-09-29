import { ScanError } from './findings.js';
import { collectPatternFindings } from './secret-patterns.js';

/** Apply the supplied uploader's credential patterns to the original text only. */
export async function scanText(content: string, path: string): Promise<void> {
  const findings = collectPatternFindings(content, path);
  if (findings.length) throw new ScanError(findings);
}
