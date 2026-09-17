import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

type ProfileMode = "execution" | "preview";

interface Options {
  mode: ProfileMode;
  output: string;
  report: string;
}

function parseArgs(args: string[]): Options {
  let mode: ProfileMode | undefined;
  let output: string | undefined;
  let report: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--mode") {
      const value = args[++index];
      if (value !== "execution" && value !== "preview") throw new Error("--mode must be execution or preview");
      mode = value;
    } else if (arg === "--output") output = args[++index];
    else if (arg === "--report") report = args[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!mode || !output || !report) {
    throw new Error("Usage: profile-candidate.ts --mode <execution|preview> --output <profile> --report <json>");
  }
  return { mode, output: resolve(output), report: resolve(report) };
}

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

const identity = (text: string): string => text;
const theme = new Proxy(
  { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity },
  { get: (target, property) => Reflect.get(target, property) ?? identity },
) as unknown as Theme;

async function withFixture<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-profile-"));
  try {
    await writeFile(join(directory, input.path), makeFixture(), "utf8");
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function execute(tool: EditDefinition, directory: string) {
  return tool.execute(
    "profile-tool-call",
    input,
    undefined,
    undefined,
    { cwd: directory } as ExtensionContext,
  );
}

async function renderPreview(tool: EditDefinition, directory: string): Promise<string> {
  if (!tool.renderCall) throw new Error("Edit tool has no call renderer");
  let component: ReturnType<RenderCall>;
  let context: RenderContext;
  await new Promise<void>((resolvePreview, rejectPreview) => {
    const timeout = setTimeout(() => rejectPreview(new Error("Preview timed out")), 30_000);
    context = {
      state: {},
      lastComponent: undefined,
      argsComplete: true,
      cwd: directory,
      invalidate() {
        clearTimeout(timeout);
        resolvePreview();
      },
    } as unknown as RenderContext;
    component = tool.renderCall!(input, theme, context);
  });
  component = tool.renderCall!(input, theme, { ...context!, lastComponent: component! });
  return component.render(120).join("\n");
}

async function captureProfile(operation: () => Promise<void>): Promise<{ profile: Profiler.Profile; wallTimeMs: number }> {
  const session = new Session();
  session.connect();
  try {
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 10 });
    const profileFinished = new Promise<Profiler.Profile>((resolveProfile) => {
      session.once("Profiler.consoleProfileFinished", (message) => resolveProfile(message.params.profile));
    });
    console.profile("candidate-operation");
    const startedAt = performance.now();
    await operation();
    const wallTimeMs = performance.now() - startedAt;
    console.profileEnd("candidate-operation");
    const profile = await profileFinished;
    const initialDelay = profile.timeDeltas?.[0];
    if (initialDelay !== undefined) {
      profile.samples?.splice(0, 1);
      profile.timeDeltas?.splice(0, 1);
      profile.startTime += initialDelay;
    }
    return { profile, wallTimeMs };
  } finally {
    session.disconnect();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  initTheme("dark");
  const builtIn = createEditToolDefinition(process.cwd());
  const extension = loadExtensionTool();

  if (options.mode === "execution") {
    const builtInReference = await withFixture(async (directory) => ({
      result: await execute(builtIn, directory),
      content: await readFile(join(directory, input.path), "utf8"),
    }));
    const extensionReference = await withFixture(async (directory) => ({
      result: await execute(extension, directory),
      content: await readFile(join(directory, input.path), "utf8"),
    }));
    deepStrictEqual(extensionReference, builtInReference);
  } else {
    const builtInPreview = await withFixture((directory) => renderPreview(builtIn, directory));
    const extensionPreview = await withFixture((directory) => renderPreview(extension, directory));
    strictEqual(builtInPreview.includes("FIRST_CHANGED"), true);
    strictEqual(extensionPreview.includes("FIRST_CHANGED"), true);
    strictEqual(
      extensionPreview.replaceAll(/file:\/\/\/tmp\/pi-edit-profile-[^/]+/g, "file:///tmp/FIXTURE"),
      builtInPreview.replaceAll(/file:\/\/\/tmp\/pi-edit-profile-[^/]+/g, "file:///tmp/FIXTURE"),
    );
  }

  const captured = await withFixture((directory) =>
    captureProfile(async () => {
      if (options.mode === "execution") await execute(extension, directory);
      else await renderPreview(extension, directory);
    }),
  );
  const samples = captured.profile.samples?.length ?? 0;
  const sampledTimeMs = (captured.profile.timeDeltas ?? []).reduce((total, value) => total + value, 0) / 1_000;
  await mkdir(dirname(options.output), { recursive: true });
  await mkdir(dirname(options.report), { recursive: true });
  await writeFile(options.output, JSON.stringify(captured.profile));
  await writeFile(
    options.report,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: options.mode,
        profile: options.output,
        wallTimeMs: captured.wallTimeMs,
        samples,
        sampledTimeMs,
        requestedSamplingIntervalMicros: 10,
        fixtureBytes: Buffer.byteLength(makeFixture()),
        edits: input.edits.length,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
