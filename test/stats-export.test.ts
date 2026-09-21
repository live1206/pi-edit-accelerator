import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportEditAcceleratorStats, type EditAcceleratorStatsExport } from "../src/stats-export.ts";
import type { EditAcceleratorStatsSnapshot } from "../src/stats.ts";

const tempDirectories: string[] = [];

const snapshot: EditAcceleratorStatsSnapshot = {
  totalCalls: 3,
  acceleratedCalls: 2,
  fallbackCalls: 1,
  previewPlanReuses: 1,
  prefetchedFiles: 1,
  positionalWrites: 0,
  suffixWrites: 1,
  eligibleFileSizes: {
    lessThan100Kb: 0,
    from100KbTo1Mb: 1,
    from1MbTo5Mb: 1,
    greaterThan5Mb: 0,
  },
  acceleratedPercent: 200 / 3,
};

const nativeBackend = {
  nativeHits: 2,
  planningAttempts: 2,
  plannedCalls: 2,
  unsupportedInputs: 1,
  nativeDeclines: 0,
  loadFailures: 0,
  invocationFailures: 0,
  disabledFallbacks: 0,
  typeScriptFallbacks: 1,
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("edit accelerator statistics export", () => {
  it("writes a privacy-safe session snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-edit-stats-export-"));
    tempDirectories.push(directory);
    const outputPath = await exportEditAcceleratorStats(
      directory,
      "process-session-id",
      "snapshot-interval-id",
      snapshot,
      nativeBackend,
      new Date("2026-09-20T08:00:00.000Z"),
    );
    const exported = JSON.parse(await readFile(outputPath, "utf8")) as EditAcceleratorStatsExport;

    expect(exported).toEqual({
      schemaVersion: 1,
      processSessionId: "process-session-id",
      snapshotIntervalId: "snapshot-interval-id",
      collectedAt: "2026-09-20T08:00:00.000Z",
      statistics: snapshot,
      nativeBackend,
    });
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain("path");
    expect(serialized).not.toContain("oldText");
    expect(serialized).not.toContain("newText");
  });

  it("requires an output directory and never overwrites a snapshot", async () => {
    await expect(
      exportEditAcceleratorStats(" ", "process", "interval", snapshot, nativeBackend),
    ).rejects.toThrow("Usage:");

    const directory = await mkdtemp(join(tmpdir(), "pi-edit-stats-export-"));
    tempDirectories.push(directory);
    const collectedAt = new Date("2026-09-20T08:00:00.000Z");
    await exportEditAcceleratorStats(directory, "process", "interval", snapshot, nativeBackend, collectedAt);
    await expect(
      exportEditAcceleratorStats(directory, "process", "interval", snapshot, nativeBackend, collectedAt),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });
});
