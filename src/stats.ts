export interface EligibleFileSizeBuckets {
  lessThan100Kb: number;
  from100KbTo1Mb: number;
  from1MbTo5Mb: number;
  greaterThan5Mb: number;
}

export interface EditAcceleratorStatsSnapshot {
  totalCalls: number;
  acceleratedCalls: number;
  fallbackCalls: number;
  previewPlanReuses: number;
  prefetchedFiles: number;
  positionalWrites: number;
  suffixWrites: number;
  eligibleFileSizes: EligibleFileSizeBuckets;
  acceleratedPercent: number;
}

export interface EditAcceleratorStats {
  recordAccelerated(): void;
  recordFallback(): void;
  recordPreviewPlanReuse(): void;
  recordPrefetchedFile(): void;
  recordPositionalWrite(): void;
  recordSuffixWrite(): void;
  recordEligibleFileSize(bytes: number): void;
  reset(): void;
  snapshot(): EditAcceleratorStatsSnapshot;
}

function emptyEligibleFileSizeBuckets(): EligibleFileSizeBuckets {
  return {
    lessThan100Kb: 0,
    from100KbTo1Mb: 0,
    from1MbTo5Mb: 0,
    greaterThan5Mb: 0,
  };
}

export function createEditAcceleratorStats(): EditAcceleratorStats {
  let acceleratedCalls = 0;
  let fallbackCalls = 0;
  let previewPlanReuses = 0;
  let prefetchedFiles = 0;
  let positionalWrites = 0;
  let suffixWrites = 0;
  let eligibleFileSizes = emptyEligibleFileSizeBuckets();
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
    recordEligibleFileSize(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Eligible file size must be a non-negative integer");
      if (bytes < 100_000) eligibleFileSizes.lessThan100Kb++;
      else if (bytes < 1_000_000) eligibleFileSizes.from100KbTo1Mb++;
      else if (bytes <= 5_000_000) eligibleFileSizes.from1MbTo5Mb++;
      else eligibleFileSizes.greaterThan5Mb++;
    },
    reset() {
      acceleratedCalls = 0;
      fallbackCalls = 0;
      previewPlanReuses = 0;
      prefetchedFiles = 0;
      positionalWrites = 0;
      suffixWrites = 0;
      eligibleFileSizes = emptyEligibleFileSizeBuckets();
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
        eligibleFileSizes: { ...eligibleFileSizes },
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
    "Eligible file sizes:",
    `  <100 KB: ${snapshot.eligibleFileSizes.lessThan100Kb}`,
    `  100 KB-1 MB: ${snapshot.eligibleFileSizes.from100KbTo1Mb}`,
    `  1-5 MB: ${snapshot.eligibleFileSizes.from1MbTo5Mb}`,
    `  >5 MB: ${snapshot.eligibleFileSizes.greaterThan5Mb}`,
    `Fast-path rate: ${snapshot.acceleratedPercent.toFixed(1)}%`,
  ].join("\n");
}
