import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createEditToolDefinition,
  initTheme,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import editAccelerator from "../extensions/edit-accelerator.ts";

type EditDefinition = ReturnType<typeof createEditToolDefinition>;
type RenderCall = NonNullable<EditDefinition["renderCall"]>;
type Theme = Parameters<RenderCall>[1];
type RenderContext = Parameters<RenderCall>[2];

interface Sample {
  totalMs: number;
  executionMs: number;
  result: Awaited<ReturnType<EditDefinition["execute"]>>;
  content: string;
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

function makeFixture(): string {
  return `FIRST_MARKER\n${"0123456789abcdef0123456789abcdef\n".repeat(158_875)}LAST_MARKER\n`;
}

const input: EditToolInput = {
  path: "large.txt",
  edits: [
    { oldText: "FIRST_MARKER", newText: "FIRST_CHANGED" },
    { oldText: "LAST_MARKER", newText: "LAST_CHANGED" },
  ],
};

async function measure(tool: EditDefinition): Promise<Sample> {
  if (!tool.renderCall) throw new Error("Edit tool has no call renderer");
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-interactive-"));
  const path = join(directory, input.path);
  try {
    await writeFile(path, makeFixture(), "utf8");
    let resolvePreview!: () => void;
    const preview = new Promise<void>((resolve) => {
      resolvePreview = resolve;
    });
    const context = {
      state: {},
      lastComponent: undefined,
      argsComplete: true,
      cwd: directory,
      invalidate: resolvePreview,
    } as unknown as RenderContext;

    const startedAt = performance.now();
    tool.renderCall(input, theme, context);
    const executionStartedAt = performance.now();
    const result = await tool.execute(
      "interactive-benchmark-tool-call",
      input,
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    const executionMs = performance.now() - executionStartedAt;
    await preview;
    const totalMs = performance.now() - startedAt;
    return { totalMs, executionMs, result, content: await readFile(path, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    minMs: sorted[0]!,
    maxMs: sorted[sorted.length - 1]!,
    samplesMs: sorted,
  };
}

initTheme("dark");
const builtIn = createEditToolDefinition(process.cwd());
const extension = loadExtensionTool();
const reference = await measure(builtIn);
const candidate = await measure(extension);
deepStrictEqual(candidate.result, reference.result);
strictEqual(candidate.content, reference.content);

await measure(builtIn);
await measure(extension);
const builtInSamples: Sample[] = [];
const extensionSamples: Sample[] = [];
for (let index = 0; index < 10; index++) {
  if (index % 2 === 0) {
    builtInSamples.push(await measure(builtIn));
    extensionSamples.push(await measure(extension));
  } else {
    extensionSamples.push(await measure(extension));
    builtInSamples.push(await measure(builtIn));
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      runs: 10,
      fixtureBytes: Buffer.byteLength(makeFixture()),
      builtIn: {
        total: summarize(builtInSamples.map((sample) => sample.totalMs)),
        execution: summarize(builtInSamples.map((sample) => sample.executionMs)),
      },
      extension: {
        total: summarize(extensionSamples.map((sample) => sample.totalMs)),
        execution: summarize(extensionSamples.map((sample) => sample.executionMs)),
      },
    },
    null,
    2,
  )}\n`,
);
