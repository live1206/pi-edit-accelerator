import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createEditToolDefinition,
  initTheme,
  type EditToolInput,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import editAccelerator from "../extensions/edit-accelerator.ts";

type EditDefinition = ReturnType<typeof createEditToolDefinition>;
type RenderCall = NonNullable<EditDefinition["renderCall"]>;
type Theme = Parameters<RenderCall>[1];
type RenderContext = Parameters<RenderCall>[2];

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

async function measurePreview(tool: EditDefinition): Promise<number> {
  if (!tool.renderCall) throw new Error("Edit tool has no call renderer");
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-preview-"));
  try {
    await writeFile(join(directory, input.path), makeFixture(), "utf8");
    const startedAt = performance.now();
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
    return performance.now() - startedAt;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function summarize(samples: number[]) {
  samples.sort((left, right) => left - right);
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    minMs: samples[0],
    maxMs: samples[samples.length - 1],
    samplesMs: samples,
  };
}

initTheme("dark");
const builtIn = createEditToolDefinition(process.cwd());
const extension = loadExtensionTool();
await measurePreview(builtIn);
await measurePreview(extension);
const builtInSamples: number[] = [];
const extensionSamples: number[] = [];
for (let index = 0; index < 10; index++) {
  if (index % 2 === 0) {
    builtInSamples.push(await measurePreview(builtIn));
    extensionSamples.push(await measurePreview(extension));
  } else {
    extensionSamples.push(await measurePreview(extension));
    builtInSamples.push(await measurePreview(builtIn));
  }
}
process.stdout.write(
  `${JSON.stringify(
    {
      runtime: process.version,
      operatingSystem: { platform: platform(), release: release(), arch: process.arch },
      cpu: cpus()[0]?.model ?? "unknown",
      runs: 10,
      builtIn: summarize(builtInSamples),
      extension: summarize(extensionSamples),
    },
    null,
    2,
  )}\n`,
);
