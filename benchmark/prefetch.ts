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
  wallTimeMs: number;
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

async function measure(tool: EditDefinition, prefetch: boolean, streamingDelayMs: number): Promise<Sample> {
  if (!tool.renderCall) throw new Error("Edit tool has no call renderer");
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-prefetch-"));
  const path = join(directory, input.path);
  try {
    await writeFile(path, makeFixture(), "utf8");
    const state = {};
    let resolvePreview!: () => void;
    const preview = new Promise<void>((resolve) => {
      resolvePreview = resolve;
    });
    const context = {
      state,
      lastComponent: undefined,
      argsComplete: false,
      cwd: directory,
      invalidate: resolvePreview,
    } as unknown as RenderContext;
    let component: ReturnType<RenderCall> | undefined;
    if (prefetch) component = tool.renderCall({ path: input.path, edits: [] }, theme, context);
    await new Promise((resolve) => setTimeout(resolve, streamingDelayMs));

    const startedAt = performance.now();
    tool.renderCall(input, theme, {
      ...context,
      argsComplete: true,
      lastComponent: component,
    });
    const result = await tool.execute(
      "prefetch-benchmark-tool-call",
      input,
      undefined,
      undefined,
      { cwd: directory } as ExtensionContext,
    );
    await preview;
    return {
      wallTimeMs: performance.now() - startedAt,
      result,
      content: await readFile(path, "utf8"),
    };
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

const streamingDelayMs = 50;
initTheme("dark");
const tool = loadExtensionTool();
const baseline = await measure(tool, false, streamingDelayMs);
const candidate = await measure(tool, true, streamingDelayMs);
deepStrictEqual(candidate.result, baseline.result);
strictEqual(candidate.content, baseline.content);

for (let index = 0; index < 3; index++) {
  await measure(tool, index % 2 === 0, streamingDelayMs);
  await measure(tool, index % 2 !== 0, streamingDelayMs);
}

const withoutPrefetch: number[] = [];
const withPrefetch: number[] = [];
for (let index = 0; index < 20; index++) {
  if (index % 2 === 0) {
    withoutPrefetch.push((await measure(tool, false, streamingDelayMs)).wallTimeMs);
    withPrefetch.push((await measure(tool, true, streamingDelayMs)).wallTimeMs);
  } else {
    withPrefetch.push((await measure(tool, true, streamingDelayMs)).wallTimeMs);
    withoutPrefetch.push((await measure(tool, false, streamingDelayMs)).wallTimeMs);
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      runs: 20,
      fixtureBytes: Buffer.byteLength(makeFixture()),
      streamingDelayMs,
      withoutPrefetch: summarize(withoutPrefetch),
      withPrefetch: summarize(withPrefetch),
    },
    null,
    2,
  )}\n`,
);
