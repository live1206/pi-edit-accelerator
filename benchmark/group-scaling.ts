import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createEditToolDefinition,
  type EditToolInput,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { tryExecuteExactEdit } from "../src/exact-edit.ts";

interface Sample {
  wallTimeMs: number;
  result: unknown;
  content: Buffer;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function makeFixture(count: number): { content: string; input: EditToolInput } {
  const content = `${Array.from(
    { length: count * 14 + 10 },
    (_, index) => `entry_${String(index).padStart(6, "0")} = "${"text".repeat(20)}";`,
  ).join("\n")}\n`;
  return {
    content,
    input: {
      path: "fixture.txt",
      edits: Array.from({ length: count }, (_, index) => ({
        oldText: `entry_${String(index * 14 + 5).padStart(6, "0")}`,
        newText: `value_${String(index * 14 + 5).padStart(6, "0")}`,
      })),
    },
  };
}

async function measure(
  directory: string,
  content: string,
  input: EditToolInput,
  builtIn: ReturnType<typeof createEditToolDefinition>,
  candidate: boolean,
): Promise<Sample> {
  const path = join(directory, input.path);
  await writeFile(path, content);
  const startedAt = performance.now();
  const result = candidate
    ? await tryExecuteExactEdit(input, undefined, { cwd: directory } as ExtensionContext)
    : await builtIn.execute(
        "group-scaling-benchmark",
        input,
        undefined,
        undefined,
        { cwd: directory } as ExtensionContext,
      );
  return {
    wallTimeMs: performance.now() - startedAt,
    result,
    content: await readFile(path),
  };
}

const reports = [];
for (const count of [100, 200]) {
  const { content, input } = makeFixture(count);
  const directory = await mkdtemp(join(tmpdir(), `pi-edit-group-scaling-${count}-`));
  try {
    const builtIn = createEditToolDefinition(directory);
    await measure(directory, content, input, builtIn, true);
    await measure(directory, content, input, builtIn, false);
    const candidateSamples: number[] = [];
    const builtInSamples: number[] = [];
    for (let index = 0; index < 3; index++) {
      const firstCandidate = index % 2 === 0;
      const first = await measure(directory, content, input, builtIn, firstCandidate);
      const second = await measure(directory, content, input, builtIn, !firstCandidate);
      const candidate = firstCandidate ? first : second;
      const reference = firstCandidate ? second : first;
      deepStrictEqual(candidate.result, reference.result);
      strictEqual(Buffer.compare(candidate.content, reference.content), 0);
      candidateSamples.push(candidate.wallTimeMs);
      builtInSamples.push(reference.wallTimeMs);
    }
    reports.push({
      edits: count,
      fileBytes: Buffer.byteLength(content),
      candidateMedianMs: median(candidateSamples),
      builtInMedianMs: median(builtInSamples),
      candidateSamplesMs: candidateSamples,
      builtInSamplesMs: builtInSamples,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      runtime: process.version,
      operatingSystem: { platform: platform(), release: release(), arch: process.arch },
      cpu: cpus()[0]?.model ?? "unknown",
      runs: 3,
      reports,
    },
    null,
    2,
  )}\n`,
);
