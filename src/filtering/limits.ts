export const MIB = 1024 * 1024;

/** File, project, and archive limits from the original Playground CLI bundle. */
export const INSPECTION_LIMITS = Object.freeze({
  sourceFileBytes: 50 * MIB,
  buildFileBytes: 3 * MIB,
  sourceTotalBytes: 50 * MIB,
  buildTotalBytes: 10 * MIB,
  sourceFileCount: 2000,
  buildFileCount: 150,
  archiveBytes: 10 * MIB,
});
