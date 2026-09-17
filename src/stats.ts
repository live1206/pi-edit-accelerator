export interface EditAcceleratorStatsSnapshot {
  totalCalls: number;
  acceleratedCalls: number;
  fallbackCalls: number;
  previewPlanReuses: number;
  prefetchedFiles: number;
  positionalWrites: number;
  suffixWrites: number;
  acceleratedPercent: number;
}

export interface EditAcceleratorStats {
  recordAccelerated(): void;
  recordFallback(): void;
  recordPreviewPlanReuse(): void;
  recordPrefetchedFile(): void;
  recordPositionalWrite(): void;
  recordSuffixWrite(): void;
  reset(): void;
  snapshot(): EditAcceleratorStatsSnapshot;
}

export function createEditAcceleratorStats(): EditAcceleratorStats {
  let acceleratedCalls = 0;
  let fallbackCalls = 0;
  let previewPlanReuses = 0;
  let prefetchedFiles = 0;
  let positionalWrites = 0;
  let suffixWrites = 0;
  return {
    recordAccelerated() {
      acceleratedCalls++;
    },
    recordFallback() {
      fallbackCalls++;
    },
    recordPreviewPlanReuse() {
      previewPlanReuses++;
    },
    recordPrefetchedFile() {
      prefetchedFiles++;
    },
    recordPositionalWrite() {
      positionalWrites++;
    },
    recordSuffixWrite() {
      suffixWrites++;
    },
    reset() {
      acceleratedCalls = 0;
      fallbackCalls = 0;
      previewPlanReuses = 0;
      prefetchedFiles = 0;
      positionalWrites = 0;
      suffixWrites = 0;
    },
    snapshot() {
      const totalCalls = acceleratedCalls + fallbackCalls;
      return {
        totalCalls,
        acceleratedCalls,
        fallbackCalls,
        previewPlanReuses,
        prefetchedFiles,
        positionalWrites,
        suffixWrites,
        acceleratedPercent: totalCalls === 0 ? 0 : (acceleratedCalls / totalCalls) * 100,
      };
    },
  };
}

export function formatEditAcceleratorStats(snapshot: EditAcceleratorStatsSnapshot): string {
  return [
    `Total edit calls: ${snapshot.totalCalls}`,
    `Accelerated: ${snapshot.acceleratedCalls}`,
    `Built-in fallback: ${snapshot.fallbackCalls}`,
    `Preview plans reused: ${snapshot.previewPlanReuses}`,
    `Prefetched files: ${snapshot.prefetchedFiles}`,
    `Positional writes: ${snapshot.positionalWrites}`,
    `Suffix writes: ${snapshot.suffixWrites}`,
    `Fast-path rate: ${snapshot.acceleratedPercent.toFixed(1)}%`,
  ].join("\n");
}
