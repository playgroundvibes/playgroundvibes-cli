export type SignaturePart = Readonly<
  { offset: number; ascii: string } | { offset: number; bytes: readonly number[] }
>;

export interface BinarySignature {
  readonly format: string;
  /** Every part must match. Offsets are measured from the start of the file. */
  readonly parts: readonly SignaturePart[];
}

function signature(format: string, ...parts: SignaturePart[]): BinarySignature {
  return Object.freeze({
    format,
    parts: Object.freeze(
      parts.map((part) =>
        Object.freeze(
          'bytes' in part ? { ...part, bytes: Object.freeze([...part.bytes]) } : { ...part },
        ),
      ),
    ),
  });
}

/** File headers checked even when a file has an allowed text extension. */
export const BINARY_SIGNATURES: readonly BinarySignature[] = Object.freeze([
  signature('ZIP local file', { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }),
  signature('ZIP empty archive', { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] }),
  signature('ZIP data descriptor', { offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08] }),
  signature('gzip', { offset: 0, bytes: [0x1f, 0x8b] }),
  signature('XZ', { offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }),
  signature('bzip2', { offset: 0, ascii: 'BZh' }),
  signature('RAR', { offset: 0, ascii: 'Rar!' }),
  signature('7-Zip', { offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf] }),
  signature('SQLite', { offset: 0, ascii: 'SQLite format 3' }),
  signature('PDF', { offset: 0, ascii: '%PDF-' }),
  signature('Unix ar archive', { offset: 0, ascii: '!<arch>' }),
  signature('DOS executable', { offset: 0, ascii: 'MZ' }),
  signature('GIF', { offset: 0, ascii: 'GIF8' }),
  signature('PNG', { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }),
  signature('JPEG', { offset: 0, bytes: [0xff, 0xd8, 0xff] }),
  signature('ELF executable', { offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46] }),
  signature('WebAssembly', { offset: 0, bytes: [0x00, 0x61, 0x73, 0x6d] }),
  signature('WOFF font', { offset: 0, ascii: 'wOFF' }),
  signature('WOFF2 font', { offset: 0, ascii: 'wOF2' }),
  signature('WebP image', { offset: 0, ascii: 'RIFF' }, { offset: 8, ascii: 'WEBP' }),
  signature('WAVE audio', { offset: 0, ascii: 'RIFF' }, { offset: 8, ascii: 'WAVE' }),
  signature('TAR archive', { offset: 257, ascii: 'ustar' }),
]);

/** Longer signatures used for incidental encoded strings, which may just be hashes. */
export const ENCODED_CONTAINER_SIGNATURES: readonly BinarySignature[] = Object.freeze([
  signature('XZ', { offset: 0, bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }),
  signature('7-Zip', { offset: 0, bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] }),
  signature('RAR', { offset: 0, bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] }),
  signature('SQLite', { offset: 0, ascii: 'SQLite format 3\0' }),
  signature('PNG', { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }),
]);

function matchesSignature(data: Uint8Array, candidate: BinarySignature): boolean {
  return candidate.parts.every((part) => {
    const expected = 'ascii' in part ? Buffer.from(part.ascii, 'ascii') : Buffer.from(part.bytes);
    return expected.every((byte, index) => data[part.offset + index] === byte);
  });
}

export function identifyBinaryFormat(data: Uint8Array): string | undefined {
  return BINARY_SIGNATURES.find((candidate) => matchesSignature(data, candidate))?.format;
}

function hasZipLocalHeader(data: Buffer): boolean {
  if (data.length < 30 || !data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    return false;
  const filenameBytes = data.readUInt16LE(26);
  const extraFieldBytes = data.readUInt16LE(28);
  return filenameBytes > 0 && 30 + filenameBytes + extraFieldBytes <= data.length;
}

function hasZipEndRecord(data: Buffer): boolean {
  if (data.length < 22 || !data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06])))
    return false;
  const commentBytes = data.readUInt16LE(20);
  return 22 + commentBytes === data.length;
}

function hasGzipHeader(data: Buffer): boolean {
  const minimumArchiveBytes = 18;
  const deflateMethod = 8;
  const reservedFlagBits = 0xe0;
  return (
    data.length >= minimumArchiveBytes &&
    data[0] === 0x1f &&
    data[1] === 0x8b &&
    data[2] === deflateMethod &&
    (data[3]! & reservedFlagBits) === 0
  );
}

/** Do not reject an arbitrary digest merely because decoded bytes start with MZ. */
export function identifyEncodedContainer(data: Uint8Array): string | undefined {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (hasZipLocalHeader(bytes) || hasZipEndRecord(bytes)) return 'ZIP';
  if (hasGzipHeader(bytes)) return 'gzip';
  return ENCODED_CONTAINER_SIGNATURES.find((candidate) => matchesSignature(data, candidate))
    ?.format;
}
