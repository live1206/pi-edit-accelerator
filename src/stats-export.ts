import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EditAcceleratorStatsSnapshot } from "./stats.ts";

export interface EditAcceleratorStatsExport {
  schemaVersion: 1;
  processSessionId: string;
  snapshotIntervalId: string;
  collectedAt: string;
  statistics: EditAcceleratorStatsSnapshot;
}

function timestampForFileName(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}

export async function exportEditAcceleratorStats(
  directory: string,
  processSessionId: string,
  snapshotIntervalId: string,
  statistics: EditAcceleratorStatsSnapshot,
  collectedAt = new Date(),
): Promise<string> {
  const trimmedDirectory = directory.trim();
  if (!trimmedDirectory) throw new Error("Usage: /edit-accelerator-export-stats <directory>");
  const outputDirectory = resolve(trimmedDirectory);
  const outputPath = resolve(
    outputDirectory,
    `edit-accelerator-${timestampForFileName(collectedAt)}-${snapshotIntervalId}.json`,
  );
  const payload: EditAcceleratorStatsExport = {
    schemaVersion: 1,
    processSessionId,
    snapshotIntervalId,
    collectedAt: collectedAt.toISOString(),
    statistics,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return outputPath;
}
