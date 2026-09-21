import { strictEqual } from "node:assert/strict";
import { writeSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { Session } from "node:inspector";
import type {
  EditToolInput,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Mode = "preview" | "execution";
type Strategy = "positional" | "suffix";

interface Options {
  mode: Mode;
  strategy: Strategy;
  runs: number;
  targetBytes: number;
  allocationMarkers: boolean;
}

interface Sample {
  wallTimeMs: number;
  peakRssDeltaBytes: number;
  heapUsedDeltaBytes: number;
  externalDeltaBytes: number;
  arrayBuffersDeltaBytes: number;
  gcPauseMs: number;
  majorGcCount: number;
  sampledHeapAllocatedBytes: number;
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    mode: "preview",
    strategy: "suffix",
    runs: 20,
    targetBytes: 5_242_900,
    allocationMarkers: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--mode") {
      const value = args[++index];
      if (value !== "preview" && value !== "execution") throw new Error("Invalid --mode");
      options.mode = value;
    } else if (arg === "--strategy") {
      const value = args[++index];
      if (value !== "positional" && value !== "suffix") throw new Error("Invalid --strategy");
      options.strategy = value;
    } else if (arg === "--runs") options.runs = positiveInteger(args[++index], arg);
    else if (arg === "--size-bytes") options.targetBytes = positiveInteger(args[++index], arg);
    else if (arg === "--allocation-markers") options.allocationMarkers = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function makeFixture(targetBytes: number): string {
  const first = "FIRST_MARKER\n";
  const line = "0123456789abcdef0123456789abcdef\n";
  const last = "LAST_MARKER\n";
  const repetitions = Math.max(0, Math.floor((targetBytes - first.length - last.length) / line.length));
  return `${first}${line.repeat(repetitions)}${last}`;
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
  return { median: percentile(0.5), p95: percentile(0.95), min: sorted[0]!, max: sorted.at(-1)! };
}

const options = parseArgs(process.argv.slice(2));
const fixture = makeFixture(options.targetBytes);
const input: EditToolInput = {
  path: "large.txt",
  edits: [
    {
      oldText: "FIRST_MARKER",
      newText: options.strategy === "positional" ? "FIRST_CHANGE" : "FIRST_CHANGED",
    },
    {
      oldText: "LAST_MARKER",
      newText: options.strategy === "positional" ? "LAST_CHANGE" : "LAST_CHANGED",
    },
  ],
};
const expected = fixture.replace("FIRST_MARKER", input.edits[0]!.newText).replace("LAST_MARKER", input.edits[1]!.newText);

const moduleLoadStartedAt = performance.now();
const [{ default: editAccelerator }, { initTheme }] = await Promise.all([
  import("../extensions/edit-accelerator.ts"),
  import("@earendil-works/pi-coding-agent"),
]);
const moduleLoadMs = performance.now() - moduleLoadStartedAt;
let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
const registrationStartedAt = performance.now();
editAccelerator({
  registerTool(registered: Parameters<ExtensionAPI["registerTool"]>[0]) {
    tool = registered;
  },
  registerCommand() {},
} as unknown as ExtensionAPI);
const registrationMs = performance.now() - registrationStartedAt;
if (!tool) throw new Error("Extension did not register its edit tool");
initTheme("dark");

const identity = (text: string): string => text;
const theme = new Proxy(
  { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity },
  { get: (target, property) => Reflect.get(target, property) ?? identity },
) as never;

async function operate(directory: string): Promise<void> {
  if (options.mode === "execution") {
    await tool!.execute(
      "resource-benchmark-tool-call",
      input,
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    strictEqual(await readFile(join(directory, input.path), "utf8"), expected);
    return;
  }
  if (!tool!.renderCall) throw new Error("Edit tool has no call renderer");
  await new Promise<void>((resolvePreview, rejectPreview) => {
    const timeout = setTimeout(() => rejectPreview(new Error("Preview timed out")), 30_000);
    tool!.renderCall!(input, theme, {
      state: {},
      lastComponent: undefined,
      argsComplete: true,
      cwd: directory,
      invalidate() {
        clearTimeout(timeout);
        resolvePreview();
      },
    } as never);
  });
}

const allocationResetMarker = "__PI_EDIT_ALLOC_RESET__\n";
const allocationSampleMarker = "__PI_EDIT_ALLOC_SAMPLE__\n";
const inspector = new Session();
if (options.allocationMarkers) inspector.connect();

function inspectorPost(method: string, params?: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolvePost, rejectPost) => {
    inspector.post(method, params ?? {}, (error, result) => {
      if (error) rejectPost(error);
      else resolvePost(result as Record<string, any>);
    });
  });
}

function sampledHeapBytes(node: { selfSize?: number; children?: Array<any> }): number {
  return (node.selfSize ?? 0) + (node.children ?? []).reduce(
    (total, child) => total + sampledHeapBytes(child),
    0,
  );
}

async function sample(recordAllocation = false): Promise<Sample> {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-resources-"));
  try {
    await writeFile(join(directory, input.path), fixture, "utf8");
    globalThis.gc?.();
    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 0));
    const gcEvents: Array<{ duration: number; kind?: number }> = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const detail = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail;
        gcEvents.push({ duration: entry.duration, kind: detail?.kind });
      }
    });
    observer.observe({ entryTypes: ["gc"] });
    const before = process.memoryUsage();
    let peakRss = before.rss;
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 1);
    if (recordAllocation) {
      await inspectorPost("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      writeSync(2, allocationResetMarker);
    }
    const startedAt = performance.now();
    await operate(directory);
    const wallTimeMs = performance.now() - startedAt;
    if (recordAllocation) writeSync(2, allocationSampleMarker);
    const heapProfile = recordAllocation
      ? await inspectorPost("HeapProfiler.stopSampling")
      : undefined;
    const sampledHeapAllocatedBytes = heapProfile
      ? sampledHeapBytes(heapProfile.profile.head)
      : 0;
    clearInterval(sampler);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    observer.disconnect();
    const after = process.memoryUsage();
    return {
      wallTimeMs,
      peakRssDeltaBytes: Math.max(0, peakRss - before.rss),
      heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
      externalDeltaBytes: after.external - before.external,
      arrayBuffersDeltaBytes: after.arrayBuffers - before.arrayBuffers,
      gcPauseMs: gcEvents.reduce((total, event) => total + event.duration, 0),
      majorGcCount: gcEvents.filter((event) => event.kind === 4).length,
      sampledHeapAllocatedBytes,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const cold = await sample();
await sample();
const samples: Sample[] = [];
for (let index = 0; index < options.runs; index++) samples.push(await sample(options.allocationMarkers));

const fields = [
  "wallTimeMs",
  "peakRssDeltaBytes",
  "heapUsedDeltaBytes",
  "externalDeltaBytes",
  "arrayBuffersDeltaBytes",
  "gcPauseMs",
  "majorGcCount",
  "sampledHeapAllocatedBytes",
] as const;
const metrics = Object.fromEntries(fields.map((field) => [field, summarize(samples.map((sample) => sample[field]))]));
process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      nativeDisabled: process.env.PI_EDIT_ACCELERATOR_NATIVE === "0",
      mode: options.mode,
      strategy: options.strategy,
      fixtureBytes: Buffer.byteLength(fixture),
      runs: options.runs,
      moduleLoadMs,
      registrationMs,
      cold,
      metrics,
      allocationSamples: options.allocationMarkers
        ? samples.map(({ sampledHeapAllocatedBytes }) => ({ sampledHeapAllocatedBytes }))
        : undefined,
    },
    null,
    2,
  )}\n`,
);
