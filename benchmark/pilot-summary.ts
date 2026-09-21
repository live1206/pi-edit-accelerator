import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { EditAcceleratorStatsExport } from "../src/stats-export.ts";

async function collect(path: string): Promise<string[]> {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (metadata.isFile()) return [absolute];
  if (!metadata.isDirectory()) return [];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => collect(resolve(absolute, entry.name))));
  return nested.flat().filter((file) => file.endsWith(".json"));
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) throw new Error("Usage: npm run pilot:summary -- <snapshot-file-or-directory> [...]");
const files = (await Promise.all(inputs.map(collect))).flat();
if (files.length === 0) throw new Error("No JSON snapshots found");
const snapshots = await Promise.all(
  files.map(async (file) => ({ file, payload: JSON.parse(await readFile(file, "utf8")) as EditAcceleratorStatsExport })),
);
for (const { file, payload } of snapshots) {
  if (payload.schemaVersion !== 1 || !payload.processSessionId || !payload.snapshotIntervalId) {
    throw new Error(`Invalid pilot snapshot: ${file}`);
  }
}

const processIds = new Set<string>();
const intervalIds = new Set<string>();
for (const { payload } of snapshots) {
  if (intervalIds.has(payload.snapshotIntervalId)) throw new Error(`Duplicate snapshot interval ${payload.snapshotIntervalId}`);
  processIds.add(payload.processSessionId);
  intervalIds.add(payload.snapshotIntervalId);
}

const total = (select: (snapshot: EditAcceleratorStatsExport) => number): number =>
  snapshots.reduce((sum, { payload }) => sum + select(payload), 0);
const totalCalls = total((snapshot) => snapshot.statistics.totalCalls);
const acceleratedCalls = total((snapshot) => snapshot.statistics.acceleratedCalls);
const fallbackCalls = total((snapshot) => snapshot.statistics.fallbackCalls);
const planningAttempts = total((snapshot) => snapshot.nativeBackend.planningAttempts);
const plannedCalls = total((snapshot) => snapshot.nativeBackend.plannedCalls);
const nativeAcceptancePercent = planningAttempts === 0 ? 0 : (plannedCalls / planningAttempts) * 100;
const overallAcceleratedPercent = totalCalls === 0 ? 0 : (acceleratedCalls / totalCalls) * 100;
const eligibleFileSizes = {
  lessThan100Kb: total((snapshot) => snapshot.statistics.eligibleFileSizes.lessThan100Kb),
  from100KbTo1Mb: total((snapshot) => snapshot.statistics.eligibleFileSizes.from100KbTo1Mb),
  from1MbTo5Mb: total((snapshot) => snapshot.statistics.eligibleFileSizes.from1MbTo5Mb),
  greaterThan5Mb: total((snapshot) => snapshot.statistics.eligibleFileSizes.greaterThan5Mb),
};

const result = {
  schemaVersion: 1,
  processCount: processIds.size,
  snapshotCount: snapshots.length,
  totalCalls,
  acceleratedCalls,
  fallbackCalls,
  overallAcceleratedPercent,
  nativePlanningAttempts: planningAttempts,
  nativePlannedCalls: plannedCalls,
  nativeAcceptancePercent,
  nativeDeclines: total((snapshot) => snapshot.nativeBackend.nativeDeclines),
  nativeLoadFailures: total((snapshot) => snapshot.nativeBackend.loadFailures),
  nativeInvocationFailures: total((snapshot) => snapshot.nativeBackend.invocationFailures),
  typeScriptFallbacks: total((snapshot) => snapshot.nativeBackend.typeScriptFallbacks),
  previewPlanReuses: total((snapshot) => snapshot.statistics.previewPlanReuses),
  prefetchedFiles: total((snapshot) => snapshot.statistics.prefetchedFiles),
  positionalWrites: total((snapshot) => snapshot.statistics.positionalWrites),
  suffixWrites: total((snapshot) => snapshot.statistics.suffixWrites),
  eligibleFileSizes,
  gates: {
    multipleProcesses: processIds.size >= 2,
    callTarget: totalCalls >= 100,
    nativeAcceptance: planningAttempts > 0 && nativeAcceptancePercent >= 95,
    noNativeFailures:
      total((snapshot) => snapshot.nativeBackend.loadFailures) === 0 &&
      total((snapshot) => snapshot.nativeBackend.invocationFailures) === 0,
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!Object.values(result.gates).every(Boolean)) process.exitCode = 1;
