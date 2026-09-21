import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface ResourceReport {
  mode: "preview" | "execution";
  strategy: "positional" | "suffix";
  fixtureBytes: number;
  allocationSamples: Array<{ sampledHeapAllocatedBytes: number }>;
}

interface Result {
  backend: "typescript" | "native";
  bucket: "1m-5m" | "gt5m";
  mode: ResourceReport["mode"];
  strategy: ResourceReport["strategy"];
  fixtureBytes: number;
  medianAllocatedBytes: number;
  p95AllocatedBytes: number;
  minAllocatedBytes: number;
  maxAllocatedBytes: number;
  samples: number[];
}

const runs = Number.parseInt(process.env.PI_EDIT_ALLOCATION_RUNS ?? "20", 10);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("PI_EDIT_ALLOCATION_RUNS must be positive");
const preload = resolve(".artifacts/libpi-edit-allocation-profiler.so");

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    medianAllocatedBytes: percentile(0.5),
    p95AllocatedBytes: percentile(0.95),
    minAllocatedBytes: sorted[0]!,
    maxAllocatedBytes: sorted.at(-1)!,
  };
}

async function runCase(
  backend: Result["backend"],
  bucket: Result["bucket"],
  targetBytes: number,
  mode: Result["mode"],
  strategy: Result["strategy"],
): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-allocation-"));
  const profilePath = join(directory, "samples.txt");
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "benchmark/resources.ts",
        "--mode",
        mode,
        "--strategy",
        strategy,
        "--runs",
        String(runs),
        "--size-bytes",
        String(targetBytes),
        "--allocation-markers",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          LD_PRELOAD: preload,
          PI_EDIT_ALLOC_PROFILE_PATH: profilePath,
          PI_EDIT_ACCELERATOR_NATIVE: backend === "typescript" ? "0" : "1",
        },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (child.status !== 0) {
      throw new Error(`${backend} ${bucket} ${strategy} ${mode} failed:\n${child.stderr || child.stdout}`);
    }
    const report = JSON.parse(child.stdout) as ResourceReport;
    const nativeSamples = (await readFile(profilePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((value) => Number.parseInt(value, 10));
    if (
      nativeSamples.length !== runs ||
      report.allocationSamples.length !== runs ||
      nativeSamples.some((value) => !Number.isSafeInteger(value) || value < 0)
    ) {
      throw new Error(`Expected ${runs} allocation samples, received ${nativeSamples.length}`);
    }
    const samples = nativeSamples.map(
      (value, index) => value + report.allocationSamples[index]!.sampledHeapAllocatedBytes,
    );
    return {
      backend,
      bucket,
      mode,
      strategy,
      fixtureBytes: report.fixtureBytes,
      ...summarize(samples),
      samples,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const results: Result[] = [];
for (const [bucket, targetBytes] of [["1m-5m", 3_000_000], ["gt5m", 6_000_000]] as const) {
  for (const strategy of ["positional", "suffix"] as const) {
    for (const mode of ["preview", "execution"] as const) {
      // Alternate order between adjacent cases to reduce machine-state bias.
      const order: Result["backend"][] = results.length % 2 === 0
        ? ["typescript", "native"]
        : ["native", "typescript"];
      for (const backend of order) {
        results.push(await runCase(backend, bucket, targetBytes, mode, strategy));
      }
    }
  }
}

const comparisons = [];
for (const candidate of results.filter((result) => result.backend === "native")) {
  const baseline = results.find((result) =>
    result.backend === "typescript" &&
    result.bucket === candidate.bucket &&
    result.mode === candidate.mode &&
    result.strategy === candidate.strategy,
  )!;
  comparisons.push({
    bucket: candidate.bucket,
    mode: candidate.mode,
    strategy: candidate.strategy,
    typeScriptMedianAllocatedBytes: baseline.medianAllocatedBytes,
    nativeMedianAllocatedBytes: candidate.medianAllocatedBytes,
    medianChangePct: Number((((candidate.medianAllocatedBytes / baseline.medianAllocatedBytes) - 1) * 100).toFixed(1)),
    gatePassed: candidate.medianAllocatedBytes <= baseline.medianAllocatedBytes * 1.1,
  });
}

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, runsPerCase: runs, comparisons, results }, null, 2)}\n`);
