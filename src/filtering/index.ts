// Public filtering API: readable policies and safe text inspection, never upload payloads.
export { scanText } from './scan-text.js';
export { ScanError, type ScanFinding } from './findings.js';
export {
  BUILT_IN_EXCLUSIONS,
  type PathExclusionRule,
  type ExclusionMatch,
  type ExclusionSource,
} from './path-exclusions.js';
export { INSPECTION_LIMITS } from './limits.js';
export { CREDENTIAL_PATTERNS, type CredentialPattern } from './secret-patterns.js';
