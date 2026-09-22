import { strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  VERSION as PI_VERSION,
  createEditToolDefinition,
  initTheme,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import editAccelerator from "../extensions/edit-accelerator.ts";
import { getNativeBackendStats, type NativeBackendStatsSnapshot } from "../src/native-planner.ts";

type Backend = "built-in" | "typescript" | "rust";
type Lifecycle = "preview" | "fresh-execution" | "preview-reuse-execution";
type Scenario = "single-suffix" | "multi-positional" | "multi-suffix";
type EditDefinition = ReturnType<typeof createEditToolDefinition>;
type RenderCall = NonNullable<EditDefinition["renderCall"]>;
type Theme = Parameters<RenderCall>[1];
type RenderContext = Parameters<RenderCall>[2];

interface Options {
  workerBackend?: Backend;
  runs: number;
  rounds: number;
  warmup: number;
  output?: string;
}

interface CaseResult {
  backend: Backend;
  bucket: string;
  fixtureBytes: number;
  scenario: Scenario;
  editCount: number;
  lifecycle: Lifecycle;
  samplesMs: number[];
}

interface WorkerReport {
  backend: Backend;
  nativeStats: NativeBackendStatsSnapshot;
  results: CaseResult[];
}

interface Statistics {
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

const sizes = [
  { bucket: "lt10kb", bytes: 5 * 1024 },
  { bucket: "10-25kb", bytes: 18 * 1024 },
  { bucket: "25-50kb", bytes: 38 * 1024 },
  { bucket: "50-100kb", bytes: 75 * 1024 },
] as const;
const scenarios: Scenario[] = ["single-suffix", "multi-positional", "multi-suffix"];
const lifecycles: Lifecycle[] = ["preview", "fresh-execution", "preview-reuse-execution"];

function positiveInteger(value: string | undefined, flag: string, allowZero = false): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${flag} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): Options {
  const options: Options = { runs: 50, rounds: 3, warmup: 10 };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--worker-backend") {
      const value = args[++index];
      if (value !== "built-in" && value !== "typescript" && value !== "rust") {
        throw new Error("Invalid --worker-backend");
      }
      options.workerBackend = value;
    } else if (arg === "--runs") options.runs = positiveInteger(args[++index], arg);
    else if (arg === "--rounds") options.rounds = positiveInteger(args[++index], arg);
    else if (arg === "--warmup") options.warmup = positiveInteger(args[++index], arg, true);
    else if (arg === "--output") {
      const value = args[++index];
      if (!value) throw new Error("--output requires a path");
      options.output = resolve(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function makeFixture(targetBytes: number): string {
  const line = (index: number): string =>
    `export function sourceLine${index.toString().padStart(5, "0")}(): number { return ${index}; }\n`;
  const lines: string[] = [];
  let bytes = 0;
  for (let index = 0; bytes < targetBytes; index++) {
    const next = line(index);
    lines.push(next);
    bytes += Buffer.byteLength(next);
  }
  const positions = [Math.floor(lines.length * 0.1), Math.floor(lines.length * 0.5), Math.floor(lines.length * 0.9)];
  lines[positions[0]!] = 'export const PI_EDIT_FIRST = "alpha_before";\n';
  lines[positions[1]!] = 'export const PI_EDIT_MIDDLE = "bravo_before";\n';
  lines[positions[2]!] = 'export const PI_EDIT_LAST = "charlie_before";\n';
  return lines.join("");
}

function makeInput(scenario: Scenario): EditToolInput {
  const definitions = [
    {
      oldText: 'export const PI_EDIT_FIRST = "alpha_before";',
      positional: 'export const PI_EDIT_FIRST = "alpha_change";',
      suffix: 'export const PI_EDIT_FIRST = "alpha_after_with_more_context";',
    },
    {
      oldText: 'export const PI_EDIT_MIDDLE = "bravo_before";',
      positional: 'export const PI_EDIT_MIDDLE = "bravo_change";',
      suffix: 'export const PI_EDIT_MIDDLE = "bravo_after_with_more_context";',
    },
    {
      oldText: 'export const PI_EDIT_LAST = "charlie_before";',
      positional: 'export const PI_EDIT_LAST = "charlie_change";',
      suffix: 'export const PI_EDIT_LAST = "charlie_after_with_more_context";',
    },
  ];
  const selected = scenario === "single-suffix" ? [definitions[1]!] : definitions;
  return {
    path: "representative.ts",
    edits: selected.map(({ oldText, positional, suffix }) => ({
      oldText,
      newText: scenario === "multi-positional" ? positional : suffix,
    })),
  };
}

function expectedContent(fixture: string, input: EditToolInput): string {
  return input.edits.reduce((content, edit) => content.replace(edit.oldText, edit.newText), fixture);
}

const identity = (text: string): string => text;
const theme = new Proxy(
  { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity },
  { get: (target, property) => Reflect.get(target, property) ?? identity },
) as unknown as Theme;

function loadExtensionTool(): EditDefinition {
  let registered: EditDefinition | undefined;
  editAccelerator({
    registerTool(tool: unknown) {
      registered = tool as EditDefinition;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  if (!registered) throw new Error("Extension did not register its edit tool");
  return registered;
}

async function completePreview(tool: EditDefinition, input: EditToolInput, directory: string): Promise<void> {
  if (!tool.renderCall) throw new Error("Edit tool has no call renderer");
  await new Promise<void>((resolvePreview, rejectPreview) => {
    const timeout = setTimeout(() => rejectPreview(new Error("Preview timed out")), 30_000);
    const context = {
      state: {},
      lastComponent: undefined,
      argsComplete: true,
      cwd: directory,
      invalidate() {
        clearTimeout(timeout);
        resolvePreview();
      },
    } as unknown as RenderContext;
    tool.renderCall!(input, theme, context);
  });
}

async function sample(
  tool: EditDefinition,
  fixture: string,
  input: EditToolInput,
  lifecycle: Lifecycle,
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-small-"));
  const path = join(directory, input.path);
  try {
    await writeFile(path, fixture, "utf8");
    if (lifecycle === "preview-reuse-execution") await completePreview(tool, input, directory);
    const startedAt = performance.now();
    if (lifecycle === "preview") {
      await completePreview(tool, input, directory);
      return performance.now() - startedAt;
    }
    const result = await tool.execute(
      "small-file-benchmark",
      input,
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    const wallTimeMs = performance.now() - startedAt;
    strictEqual(await readFile(path, "utf8"), expectedContent(fixture, input));
    if (!result) throw new Error("Edit returned no result");
    return wallTimeMs;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runWorker(options: Options & { workerBackend: Backend }): Promise<WorkerReport> {
  initTheme("dark");
  const tool = options.workerBackend === "built-in"
    ? createEditToolDefinition(process.cwd())
    : loadExtensionTool();
  const results: CaseResult[] = [];
  let caseIndex = 0;
  for (const size of sizes) {
    const fixture = makeFixture(size.bytes);
    for (const scenario of scenarios) {
      const input = makeInput(scenario);
      for (const lifecycle of lifecycles) {
        for (let index = 0; index < options.warmup; index++) {
          await sample(tool, fixture, input, lifecycle);
        }
        const samplesMs: number[] = [];
        for (let index = 0; index < options.runs; index++) {
          samplesMs.push(await sample(tool, fixture, input, lifecycle));
        }
        results.push({
          backend: options.workerBackend,
          bucket: size.bucket,
          fixtureBytes: Buffer.byteLength(fixture),
          scenario,
          editCount: input.edits.length,
          lifecycle,
          samplesMs,
        });
        process.stderr.write(`\r${options.workerBackend}: ${++caseIndex}/${sizes.length * scenarios.length * lifecycles.length}`);
      }
    }
  }
  process.stderr.write("\n");
  return { backend: options.workerBackend, nativeStats: getNativeBackendStats(), results };
}

function summarize(values: readonly number[]): Statistics {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return {
    minMs: sorted[0]!,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1)!,
    meanMs: sorted.reduce((total, value) => total + value, 0) / sorted.length,
  };
}

function comparison(candidate: Statistics, baseline: Statistics) {
  return {
    medianDeltaMs: candidate.medianMs - baseline.medianMs,
    medianChangePct: ((candidate.medianMs / baseline.medianMs) - 1) * 100,
    p95DeltaMs: candidate.p95Ms - baseline.p95Ms,
    p95ChangePct: ((candidate.p95Ms / baseline.p95Ms) - 1) * 100,
  };
}

async function runCoordinator(options: Options): Promise<void> {
  const reports: WorkerReport[] = [];
  const backendOrders: Backend[][] = [
    ["built-in", "typescript", "rust"],
    ["rust", "typescript", "built-in"],
    ["typescript", "built-in", "rust"],
  ];
  for (let round = 0; round < options.rounds; round++) {
    for (const backend of backendOrders[round % backendOrders.length]!) {
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", process.argv[1]!, "--worker-backend", backend, "--runs", String(options.runs), "--warmup", String(options.warmup)],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            PI_EDIT_ACCELERATOR_NATIVE: backend === "typescript" ? "0" : "1",
          },
          maxBuffer: 20 * 1024 * 1024,
        },
      );
      process.stderr.write(`round ${round + 1}/${options.rounds} `);
      process.stderr.write(child.stderr);
      if (child.status !== 0) throw new Error(`${backend} worker failed:\n${child.stdout}\n${child.stderr}`);
      reports.push(JSON.parse(child.stdout) as WorkerReport);
    }
  }

  const merged = new Map<string, CaseResult>();
  for (const report of reports) {
    for (const result of report.results) {
      const key = `${result.backend}\0${result.bucket}\0${result.scenario}\0${result.lifecycle}`;
      const existing = merged.get(key);
      if (existing) existing.samplesMs.push(...result.samplesMs);
      else merged.set(key, { ...result, samplesMs: [...result.samplesMs] });
    }
  }
  const mergedResults = [...merged.values()];
  const summarized = mergedResults.map((result) => ({
    ...result,
    samplesMs: undefined,
    wallTimeMs: summarize(result.samplesMs),
  }));
  const comparisons = [];
  for (const rust of summarized.filter((result) => result.backend === "rust")) {
    const matches = (backend: Backend) => summarized.find((result) =>
      result.backend === backend &&
      result.bucket === rust.bucket &&
      result.scenario === rust.scenario &&
      result.lifecycle === rust.lifecycle,
    )!;
    const builtIn = matches("built-in");
    const typescript = matches("typescript");
    comparisons.push({
      bucket: rust.bucket,
      fixtureBytes: rust.fixtureBytes,
      scenario: rust.scenario,
      editCount: rust.editCount,
      lifecycle: rust.lifecycle,
      builtInMs: builtIn.wallTimeMs,
      typeScriptMs: typescript.wallTimeMs,
      rustMs: rust.wallTimeMs,
      typeScriptVsBuiltIn: comparison(typescript.wallTimeMs, builtIn.wallTimeMs),
      rustVsBuiltIn: comparison(rust.wallTimeMs, builtIn.wallTimeMs),
      rustVsTypeScript: comparison(rust.wallTimeMs, typescript.wallTimeMs),
    });
  }
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    worktreeDirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    piVersion: PI_VERSION,
    runtime: { name: "node", version: process.version },
    operatingSystem: { platform: platform(), release: release(), arch: process.arch },
    cpu: cpus()[0]?.model ?? "unknown",
    configuration: {
      rounds: options.rounds,
      runsPerCasePerRound: options.runs,
      totalRunsPerCase: options.runs * options.rounds,
      warmupPerCasePerRound: options.warmup,
      fixtureKind: "ASCII TypeScript-shaped source",
      timedRegionExcludesFixtureWrite: true,
      previewReuseExecutionExcludesPreview: true,
    },
    comparisons,
    workerNativeStats: reports.map(({ backend, nativeStats }) => ({ backend, nativeStats })),
    rawResults: mergedResults,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(options.output, json);
  else process.stdout.write(json);
}

const options = parseArgs(process.argv.slice(2));
if (options.workerBackend) process.stdout.write(`${JSON.stringify(await runWorker({ ...options, workerBackend: options.workerBackend }))}\n`);
else await runCoordinator(options);
