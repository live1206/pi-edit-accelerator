import { describe, expect, it } from "vitest";
import { createEditAcceleratorStats, formatEditAcceleratorStats } from "../src/stats.ts";

describe("edit accelerator statistics", () => {
  it("records only aggregate fast-path and fallback counts", () => {
    const stats = createEditAcceleratorStats();
    stats.recordAccelerated();
    stats.recordAccelerated();
    stats.recordFallback();
    stats.recordPreviewPlanReuse();

    const snapshot = stats.snapshot();
    expect(snapshot).toMatchObject({
      totalCalls: 3,
      acceleratedCalls: 2,
      fallbackCalls: 1,
      previewPlanReuses: 1,
    });
    expect(snapshot.acceleratedPercent).toBeCloseTo(200 / 3);
    expect(formatEditAcceleratorStats(snapshot)).toContain("Preview plans reused: 1");
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
      acceleratedPercent: 0,
    });
  });
});
