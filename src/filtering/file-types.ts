import { identifyBinaryFormat } from './binary-signatures.js';
import { rejectInspection } from './findings.js';

export const MIB = 1024 * 1024;

export const INSPECTION_LIMITS = Object.freeze({
  sourceFileBytes: 4 * MIB,
  buildFileBytes: 3 * MIB,
  sourceTotalBytes: 50 * MIB,
  buildTotalBytes: 10 * MIB,
  sourceFileCount: 2000,
  buildFileCount: 150,
  archiveBytes: 10 * MIB,
});

export const SOURCE_TEXT_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.md',
  '.mdx',
  '.txt',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.vue',
  '.svelte',
  '.astro',
  '.graphql',
  '.gql',
  '.ini',
  '.conf',
  '.properties',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.lock',
]);

export const BUILD_TEXT_EXTENSIONS: readonly string[] = Object.freeze([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.svg',
  '.txt',
  '.csv',
  '.xml',
]);

export const SOURCE_TEXT_FILENAMES: readonly string[] = Object.freeze([
  'README',
  'LICENSE',
  'LICENCE',
  'NOTICE',
  'Dockerfile',
  'Makefile',
  'Procfile',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmignore',
  '.nvmrc',
  '.node-version',
  '.browserslistrc',
  '.prettierrc',
  '.eslintrc',
  '.playgroundignore',
]);

export function supportedTextFile(basename: string, extension: string, build: boolean): boolean {
  const allowedExtensions = build ? BUILD_TEXT_EXTENSIONS : SOURCE_TEXT_EXTENSIONS;
  return (
    allowedExtensions.includes(extension.toLowerCase()) ||
    (!build && SOURCE_TEXT_FILENAMES.includes(basename))
  );
}

export function containsBinaryControls(text: string): boolean {
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

export function decodePlainText(data: Uint8Array, path: string): string {
  if (identifyBinaryFormat(data)) rejectInspection(path, 'inspection/binary-or-archive');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return rejectInspection(path, 'inspection/binary-or-archive');
  }
  if (containsBinaryControls(text)) rejectInspection(path, 'inspection/binary-or-archive');
  return text;
}
