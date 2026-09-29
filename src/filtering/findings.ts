export interface ScanFinding {
  path: string;
  line: number;
  rule: string;
}

/** Safe to show to users: no matched values or source excerpts are retained. */
export class ScanError extends Error {
  readonly findings: ScanFinding[];

  constructor(findings: ScanFinding[]) {
    const locations = findings.map(
      (finding) => `${finding.path}:${finding.line} [${finding.rule}]`,
    );
    super('Upload blocked by inspection: ' + locations.join(', '));
    this.name = 'ScanError';
    this.findings = findings;
  }
}

export function rejectInspection(path: string, rule: string, line = 1): never {
  throw new ScanError([{ path, line, rule }]);
}

export function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
