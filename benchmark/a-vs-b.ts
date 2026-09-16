import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  VERSION as PI_VERSION,
  createEditToolDefinition,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import editAccelerator from "../extensions/edit-accelerator.ts";

interface Options {
  runs: number;
  warmup: number;
  output?: string;
}

interface Statistics {
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

type EditDefinition = ReturnType<typeof createEditToolDefinition>;

function parsePositiveInteger(value: string | undefined, flag: string, allowZero = false): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): Options {
  const options: Options = { runs: 20, warmup: 3 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--runs") options.runs = parsePositiveInteger(args[++index], arg);
    else if (arg === "--warmup") options.warmup = parsePositiveInteger(args[++index], arg, true);
    else if (arg === "--output") {
      const output = args[++index];
      if (!output) throw new Error("--output requires a path");
      options.output = resolve(output);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

function summarize(values: readonly number[]): Statistics {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0]!,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
  };
}

function loadExtensionTool(): EditDefinition {
  let registered: EditDefinition | undefined;
  editAccelerator({
    registerTool(tool) {
      registered = tool as unknown as EditDefinition;
    },
  } as ExtensionAPI);
  if (!registered) throw new Error("Extension did not register its edit tool");
  return registered;
}

function makeFixture(): string {
  const line = "0123456789abcdef0123456789abcdef\n";
  return `FIRST_MARKER\n${line.repeat(158_875)}LAST_MARKER\n`;
}

const input: EditToolInput = {
  path: "large.txt",
  edits: [
    { oldText: "FIRST_MARKER", newText: "FIRST_CHANGED" },
    { oldText: "LAST_MARKER", newText: "LAST_CHANGED" },
  ],
};

async function executeSample(tool: EditDefinition, fixture: string) {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-ab-"));
  const path = join(directory, input.path);
  try {
    await writeFile(path, fixture, "utf8");
    const startedAt = performance.now();
    const result = await tool.execute(
      "benchmark-tool-call",
      input,
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    const wallTimeMs = performance.now() - startedAt;
    return { wallTimeMs, result, content: await readFile(path, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixture = makeFixture();
  const builtIn = createEditToolDefinition(process.cwd());
  const extension = loadExtensionTool();

  const reference = await executeSample(builtIn, fixture);
  const extensionReference = await executeSample(extension, fixture);
  deepStrictEqual(extensionReference.result, reference.result);
  strictEqual(extensionReference.content, reference.content);

  for (let index = 0; index < options.warmup; index++) {
    if (index % 2 === 0) {
      await executeSample(builtIn, fixture);
      await executeSample(extension, fixture);
    } else {
      await executeSample(extension, fixture);
      await executeSample(builtIn, fixture);
    }
  }

  const builtInSamples: number[] = [];
  const extensionSamples: number[] = [];
  for (let index = 0; index < options.runs; index++) {
    const first = index % 2 === 0 ? builtIn : extension;
    const second = index % 2 === 0 ? extension : builtIn;
    const firstResult = await executeSample(first, fixture);
    const secondResult = await executeSample(second, fixture);
    deepStrictEqual(firstResult.result, reference.result);
    deepStrictEqual(secondResult.result, reference.result);
    strictEqual(firstResult.content, reference.content);
    strictEqual(secondResult.content, reference.content);
    (index % 2 === 0 ? builtInSamples : extensionSamples).push(firstResult.wallTimeMs);
    (index % 2 === 0 ? extensionSamples : builtInSamples).push(secondResult.wallTimeMs);
  }

  const builtInStatistics = summarize(builtInSamples);
  const extensionStatistics = summarize(extensionSamples);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    extensionRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    extensionWorktreeDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    piVersion: PI_VERSION,
    runtime: { name: "node", version: process.version },
    operatingSystem: { platform: platform(), release: release(), arch: process.arch },
    cpu: cpus()[0]?.model ?? "unknown",
    fixture: { bytes: Buffer.byteLength(fixture), edits: input.edits.length },
    configuration: { runs: options.runs, warmup: options.warmup, alternatingOrder: true },
    baselineA: { name: "built-in edit", wallTimeMs: builtInStatistics },
    baselineB: { name: "isolated extension", wallTimeMs: extensionStatistics },
    comparison: {
      medianDeltaMs: extensionStatistics.median - builtInStatistics.median,
      medianRatio: extensionStatistics.median / builtInStatistics.median,
    },
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, json);
  } else process.stdout.write(json);
}

await main();
