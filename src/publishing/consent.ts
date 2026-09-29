import { createHash } from 'node:crypto';

export class ConsentError extends Error {
  constructor(message = 'Explicit consent for this prepared upload is required.') {
    super(message);
    this.name = 'ConsentError';
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable key order makes the digest depend on values, not object construction order. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJSON(item));
    return '{' + fields.join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

export function freezeRecursively<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeRecursively);
    Object.freeze(value);
  }
  return value;
}
