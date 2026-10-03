export const MIB = 1024 * 1024;

/** File, project, and archive limits from the original Playground CLI bundle. */
export const INSPECTION_LIMITS = Object.freeze({
  sourceFileBytes: 1024 * MIB,
  buildFileBytes: 1024 * MIB,
  sourceTotalBytes: 1024 * MIB,
  buildTotalBytes: 1024 * MIB,
  sourceFileCount: 500,
  buildFileCount: 500,
  archiveBytes: 1026 * MIB,
});
