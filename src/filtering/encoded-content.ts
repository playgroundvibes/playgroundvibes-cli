import { MIB, containsBinaryControls } from './file-types.js';
import { identifyBinaryFormat, identifyEncodedContainer } from './binary-signatures.js';
import { lineAt, rejectInspection } from './findings.js';

export const DECODING_LIMITS = Object.freeze({
  totalBytes: 12 * MIB,
  variants: 128,
  depth: 4,
  candidates: 2048,
});

export interface DecodedText {
  content: string;
  depth: number;
  /** Original line containing the encoded value, rather than a decoded-file line. */
  line: number;
}

interface EncodedValue {
  value: string;
  encoding: 'base64' | 'hex';
  explicit: boolean;
  index: number;
  validLength: boolean;
}

function decodeJavaScriptEscapes(content: string, path: string, line: number): string {
  const escapes = /\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([\\"'/]))/gi;
  return content.replace(
    escapes,
    (
      _,
      codePoint: string | undefined,
      unicode: string | undefined,
      hex: string | undefined,
      literal: string | undefined,
    ) => {
      if (literal) return literal;
      const code = Number.parseInt(codePoint ?? unicode ?? hex!, 16);
      if (code > 0x10ffff) rejectInspection(path, 'inspection/invalid-escape', line);
      return String.fromCodePoint(code);
    },
  );
}

function decodePercentEscapes(content: string, path: string, line: number): string {
  return content.replace(/(?:%[0-9a-f]{2})+/gi, (sequence) => {
    try {
      return decodeURIComponent(sequence);
    } catch {
      return rejectInspection(path, 'inspection/invalid-percent-encoding', line);
    }
  });
}

function decodeHtmlEntities(content: string, path: string, line: number): string {
  const named: Record<string, string> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
  const entities = /&(#(?:x[0-9a-f]+|[0-9]+)|quot|apos|amp|lt|gt);/gi;
  return content.replace(entities, (_, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()]!;
    const hexadecimal = entity[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (code > 0x10ffff) rejectInspection(path, 'inspection/invalid-escape', line);
    return String.fromCodePoint(code);
  });
}

/** These expressions explicitly identify their operands as encoded payloads. */
function* explicitEncodedPayloads(content: string): Generator<EncodedValue> {
  const dataUri = /\bdata:[^\s"'<>;,]*?(?:;[^\s"'<>;,]+)*;base64,([A-Za-z0-9+/_=-]+)/gi;
  const atobCall = /\batob\(\s*(["'`])([A-Za-z0-9+/_=-]+)\1\s*\)/g;
  const bufferCall =
    /\bBuffer\.from\(\s*(["'`])([A-Za-z0-9+/_=-]+)\1\s*,\s*(["'`])(base64|base64url|hex)\3\s*\)/g;

  for (const match of content.matchAll(dataUri)) {
    yield {
      value: match[1]!,
      encoding: 'base64',
      explicit: true,
      index: match.index,
      validLength: true,
    };
  }
  for (const match of content.matchAll(atobCall)) {
    yield {
      value: match[2]!,
      encoding: 'base64',
      explicit: true,
      index: match.index,
      validLength: true,
    };
  }
  for (const match of content.matchAll(bufferCall)) {
    const encoding = match[4] === 'hex' ? 'hex' : 'base64';
    yield { value: match[2]!, encoding, explicit: true, index: match.index, validLength: true };
  }
}

/** Bare strings can be ordinary hashes. Only inspectable decoded text is recursed. */
function* incidentalEncodedValues(content: string): Generator<EncodedValue> {
  for (const match of content.matchAll(/\b(?:0x)?[a-f0-9]{32,}\b/gi)) {
    const value = match[0].replace(/^0x/i, '');
    yield {
      value,
      encoding: 'hex',
      explicit: false,
      index: match.index,
      validLength: value.length % 2 === 0,
    };
  }
  for (const match of content.matchAll(/(?<![\w+/-])[A-Za-z0-9+/_-]{20,}={0,2}(?![\w+/-])/g)) {
    const value = match[0];
    yield {
      value,
      encoding: 'base64',
      explicit: false,
      index: match.index,
      validLength: value.length % 4 !== 1,
    };
  }
}

function* encodedValues(content: string): Generator<EncodedValue> {
  yield* explicitEncodedPayloads(content);
  yield* incidentalEncodedValues(content);
}

function decodeRecognizableUtf16(bytes: Buffer): string | undefined {
  if (bytes.length < 8 || bytes.length % 2 !== 0) return undefined;
  const printableAscii = (byte: number) =>
    byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126);
  for (const littleEndian of [true, false]) {
    const textByteOffset = littleEndian ? 0 : 1;
    const recognizable = bytes.every((byte, offset) =>
      offset % 2 === textByteOffset ? printableAscii(byte) : byte === 0,
    );
    if (recognizable) {
      return new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes);
    }
  }
  return undefined;
}

function decodePayload(candidate: EncodedValue, path: string, line: number): string | undefined {
  const bytes = Buffer.from(candidate.value, candidate.encoding);
  const explicitBinary = candidate.explicit && identifyBinaryFormat(bytes);
  if (explicitBinary || identifyEncodedContainer(bytes)) {
    rejectInspection(path, 'inspection/encoded-binary', line);
  }

  // A NUL-heavy hash is not proof of a binary payload. Recognizable UTF-16 text
  // can be scanned, while opaque incidental bytes remain ordinary digest text.
  if (!candidate.explicit) {
    const utf16 = decodeRecognizableUtf16(bytes);
    if (utf16 !== undefined) return utf16;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    if (candidate.explicit) rejectInspection(path, 'inspection/encoded-binary', line);
    return undefined;
  }
  if (containsBinaryControls(decoded)) {
    if (candidate.explicit) rejectInspection(path, 'inspection/encoded-binary', line);
    return undefined;
  }
  return decoded;
}

/** Yield each variant before decoding further so the consumer scans every stage. */
export function* decodedTextVariants(content: string, path: string): Generator<DecodedText> {
  const queue: DecodedText[] = [{ content, depth: 0, line: 1 }];
  const seen = new Set<string>();
  let decodedBytes = 0;
  let candidateCount = 0;

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    if (seen.has(current.content)) continue;
    seen.add(current.content);
    yield current;

    const originalLine = (index: number) =>
      current.depth ? current.line : lineAt(current.content, index);
    const enqueue = (decoded: string, index: number) => {
      if (
        decoded === current.content ||
        seen.has(decoded) ||
        queue.some((item) => item.content === decoded)
      )
        return;
      const line = originalLine(index);
      decodedBytes += Buffer.byteLength(decoded);
      const limitReached =
        current.depth >= DECODING_LIMITS.depth ||
        queue.length >= DECODING_LIMITS.variants ||
        decodedBytes > DECODING_LIMITS.totalBytes;
      if (limitReached) rejectInspection(path, 'inspection/decoding-limit', line);
      queue.push({ content: decoded, depth: current.depth + 1, line });
    };

    enqueue(decodeJavaScriptEscapes(current.content, path, current.line), 0);
    enqueue(decodePercentEscapes(current.content, path, current.line), 0);
    enqueue(decodeHtmlEntities(current.content, path, current.line), 0);

    for (const candidate of encodedValues(current.content)) {
      if (++candidateCount > DECODING_LIMITS.candidates)
        rejectInspection(path, 'inspection/decoding-limit', current.line);
      if (!candidate.validLength) continue;
      const decoded = decodePayload(candidate, path, originalLine(candidate.index));
      if (decoded !== undefined) enqueue(decoded, candidate.index);
    }
  }
}
