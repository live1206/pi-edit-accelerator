import { describe, expect, it } from "vitest";
import { createEditAcceleratorStats, formatEditAcceleratorStats } from "../src/stats.ts";

describe("edit accelerator statistics", () => {
  it("records only aggregate fast-path and fallback counts", () => {
    const stats = createEditAcceleratorStats();
    stats.recordAccelerated();
    stats.recordAccelerated();
    stats.recordFallback();
    stats.recordPreviewPlanReuse();
    stats.recordPrefetchedFile();
    stats.recordPositionalWrite();
    stats.recordSuffixWrite();

    const snapshot = stats.snapshot();
    expect(snapshot).toMatchObject({
      totalCalls: 3,
      acceleratedCalls: 2,
      fallbackCalls: 1,
      previewPlanReuses: 1,
      prefetchedFiles: 1,
      positionalWrites: 1,
      suffixWrites: 1,
    });
    expect(snapshot.acceleratedPercent).toBeCloseTo(200 / 3);
    expect(formatEditAcceleratorStats(snapshot)).toContain("Preview plans reused: 1");
    expect(formatEditAcceleratorStats(snapshot)).toContain("Prefetched files: 1");
    expect(formatEditAcceleratorStats(snapshot)).toContain("Positional writes: 1");
    expect(formatEditAcceleratorStats(snapshot)).toContain("Suffix writes: 1");
    expect(formatEditAcceleratorStats(snapshot)).toContain("Fast-path rate: 66.7%");
  });

  it("resets all counters", () => {
    const stats = createEditAcceleratorStats();
    stats.recordFallback();
    stats.reset();
    expect(stats.snapshot()).toEqual({
      totalCalls: 0,
      acceleratedCalls: 0,
      fallbackCalls: 0,
      previewPlanReuses: 0,
      prefetchedFiles: 0,
      positionalWrites: 0,
      suffixWrites: 0,
      acceleratedPercent: 0,
    });
  });
});
