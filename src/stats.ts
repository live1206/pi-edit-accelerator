export interface EditAcceleratorStatsSnapshot {
  totalCalls: number;
  acceleratedCalls: number;
  fallbackCalls: number;
  acceleratedPercent: number;
}

export interface EditAcceleratorStats {
  recordAccelerated(): void;
  recordFallback(): void;
  reset(): void;
  snapshot(): EditAcceleratorStatsSnapshot;
}

export function createEditAcceleratorStats(): EditAcceleratorStats {
  let acceleratedCalls = 0;
  let fallbackCalls = 0;
  return {
    recordAccelerated() {
      acceleratedCalls++;
    },
    recordFallback() {
      fallbackCalls++;
    },
    reset() {
      acceleratedCalls = 0;
      fallbackCalls = 0;
    },
    snapshot() {
      const totalCalls = acceleratedCalls + fallbackCalls;
      return {
        totalCalls,
        acceleratedCalls,
        fallbackCalls,
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
    `Fast-path rate: ${snapshot.acceleratedPercent.toFixed(1)}%`,
  ].join("\n");
}
