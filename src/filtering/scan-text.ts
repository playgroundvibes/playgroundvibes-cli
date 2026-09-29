import { lintSource } from '@secretlint/core';
import { rules } from '@secretlint/secretlint-rule-preset-recommend';
import { decodedTextVariants } from './encoded-content.js';
import { containsBinaryControls, INSPECTION_LIMITS } from './file-types.js';
import { rejectInspection, ScanError } from './findings.js';
import { collectPatternFindings } from './secret-patterns.js';

// Fixed in this package: repository configuration and ignore comments cannot
// suppress a credential finding.
const scannerRules = rules
  .filter((rule) => rule.meta.id !== '@secretlint/secretlint-rule-filter-comments')
  .map((rule) => ({ id: rule.meta.id, rule }));

export async function scanText(content: string, path: string): Promise<void> {
  if (Buffer.byteLength(content) > INSPECTION_LIMITS.sourceFileBytes) {
    rejectInspection(path, 'inspection/text-size-limit');
  }

  for (const variant of decodedTextVariants(content, path)) {
    if (containsBinaryControls(variant.content)) {
      rejectInspection(path, 'inspection/opaque-content', variant.line);
    }
    const findings = collectPatternFindings(variant.content, path);
    try {
      const result = await lintSource({
        source: { content: variant.content, filePath: path, contentType: 'text' },
        options: { config: { rules: scannerRules }, maskSecrets: true, noPhysicFilePath: true },
      });
      // Secretlint's full messages and data can contain values. Keep locations only.
      for (const message of result.messages) {
        findings.push({ path, line: message.loc.start.line, rule: message.ruleId });
      }
    } catch {
      rejectInspection(path, 'inspection/scanner-failed', variant.line);
    }

    if (findings.length) {
      throw new ScanError(
        findings.slice(0, 20).map((finding) => ({
          ...finding,
          line: variant.depth ? variant.line : finding.line,
          rule: finding.rule + (variant.depth ? '/decoded' : ''),
        })),
      );
    }
  }
}
