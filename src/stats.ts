export interface EditAcceleratorStatsSnapshot {
  totalCalls: number;
  acceleratedCalls: number;
  fallbackCalls: number;
  previewPlanReuses: number;
  positionalWrites: number;
  acceleratedPercent: number;
}

export interface EditAcceleratorStats {
  recordAccelerated(): void;
  recordFallback(): void;
  recordPreviewPlanReuse(): void;
  recordPositionalWrite(): void;
  reset(): void;
  snapshot(): EditAcceleratorStatsSnapshot;
}

export function createEditAcceleratorStats(): EditAcceleratorStats {
  let acceleratedCalls = 0;
  let fallbackCalls = 0;
  let previewPlanReuses = 0;
  let positionalWrites = 0;
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
    recordPositionalWrite() {
      positionalWrites++;
    },
    reset() {
      acceleratedCalls = 0;
      fallbackCalls = 0;
      previewPlanReuses = 0;
      positionalWrites = 0;
    },
    snapshot() {
      const totalCalls = acceleratedCalls + fallbackCalls;
      return {
        totalCalls,
        acceleratedCalls,
        fallbackCalls,
        previewPlanReuses,
        positionalWrites,
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
    `Positional writes: ${snapshot.positionalWrites}`,
    `Fast-path rate: ${snapshot.acceleratedPercent.toFixed(1)}%`,
  ].join("\n");
}
