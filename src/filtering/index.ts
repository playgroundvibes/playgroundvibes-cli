// Public filtering API: readable policies and safe text inspection, never upload payloads.
export { scanText } from './scan-text.js';
export { ScanError, type ScanFinding } from './findings.js';
export {
  BUILT_IN_EXCLUSIONS,
  type PathExclusionRule,
  type ExclusionMatch,
  type ExclusionSource,
} from './path-exclusions.js';
export {
  SOURCE_TEXT_EXTENSIONS,
  BUILD_TEXT_EXTENSIONS,
  SOURCE_TEXT_FILENAMES,
  INSPECTION_LIMITS,
} from './file-types.js';
export {
  BINARY_SIGNATURES,
  ENCODED_CONTAINER_SIGNATURES,
  type BinarySignature,
  type SignaturePart,
} from './binary-signatures.js';
export { DECODING_LIMITS } from './encoded-content.js';
