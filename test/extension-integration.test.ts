import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditToolDefinition,
  initTheme,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import editAccelerator from "../extensions/edit-accelerator.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-edit-extension-integration-"));
  tempDirectories.push(directory);
  return directory;
}

function loadExtensionTool(): ReturnType<typeof createEditToolDefinition> {
  let registered: ReturnType<typeof createEditToolDefinition> | undefined;
  editAccelerator({
    registerTool(tool: unknown) {
      registered = tool as unknown as ReturnType<typeof createEditToolDefinition>;
    },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  if (!registered) throw new Error("Extension did not register its edit tool");
  return registered;
}

async function execute(
  tool: ReturnType<typeof createEditToolDefinition>,
  directory: string,
  input: EditToolInput,
) {
  return tool.execute("tool-call", input, undefined, undefined, { cwd: directory } as ExtensionContext);
}

function renderPreview(
  tool: ReturnType<typeof createEditToolDefinition>,
  directory: string,
  input: EditToolInput,
  prefetch = false,
) {
  if (!tool.renderCall) throw new Error("Extension did not register a call renderer");
  type RenderCall = NonNullable<typeof tool.renderCall>;
  const identity = (text: string): string => text;
  const theme = new Proxy(
    { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity },
    { get: (target, property) => Reflect.get(target, property) ?? identity },
  ) as unknown as Parameters<RenderCall>[1];
  const state = {};
  let resolvePreview!: () => void;
  let rejectPreview!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolvePreview = resolve;
    rejectPreview = reject;
  });
  const timeout = setTimeout(() => rejectPreview(new Error("Preview timed out")), 2_000);
  const context = {
    state,
    lastComponent: undefined,
    argsComplete: true,
    cwd: directory,
    invalidate() {
      clearTimeout(timeout);
      resolvePreview();
    },
  } as unknown as Parameters<RenderCall>[2];
  const partialComponent = prefetch
    ? tool.renderCall(
        { path: input.path, edits: [] },
        theme,
        { ...context, argsComplete: false },
      )
    : undefined;
  const component = tool.renderCall(input, theme, { ...context, lastComponent: partialComponent });
  return { component, done };
}

describe("edit accelerator extension", () => {
  it("builds an accelerated interactive preview from a streamed path", async () => {
    initTheme("dark");
    const directory = await createDirectory();
    await writeFile(join(directory, "fixture.txt"), "before\nmiddle\n", "utf8");
    const tool = loadExtensionTool();
    const preview = renderPreview(tool, directory, {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after" }],
    }, true);
    await preview.done;

    expect(preview.component.render(80).join("\n")).toContain("after");
  });

  it("shares an in-flight preview with positional execution", async () => {
    initTheme("dark");
    const directory = await createDirectory();
    await writeFile(join(directory, "fixture.txt"), "before\nmiddle\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const tool = loadExtensionTool();

    const preview = renderPreview(tool, directory, input);
    const [result] = await Promise.all([execute(tool, directory, input), preview.done]);

    expect(result.details?.diff).toContain("+1 after!");
    expect(await readFile(join(directory, "fixture.txt"), "utf8")).toBe("after!\nmiddle\n");
  });

  it("registers one edit override with the built-in contract", () => {
    const tool = loadExtensionTool();
    expect(tool.name).toBe("edit");
    expect(tool.prepareArguments).toBeTypeOf("function");
    expect(tool.renderCall).toBeTypeOf("function");
    expect(tool.renderResult).toBeTypeOf("function");
  });

  it("matches the built-in result for an exact edit", async () => {
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    await writeFile(join(extensionDirectory, "fixture.txt"), "before\nmiddle\n", "utf8");
    await writeFile(join(builtInDirectory, "fixture.txt"), "before\nmiddle\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after" }],
    };

    const extensionResult = await execute(loadExtensionTool(), extensionDirectory, input);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"), "utf8")).toBe(
      await readFile(join(builtInDirectory, "fixture.txt"), "utf8"),
    );
  });

  it("matches the built-in result for partial and multiline edits", async () => {
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    const content = "const before = 1;\nold one\nold two\nlast\n";
    await writeFile(join(extensionDirectory, "fixture.txt"), content, "utf8");
    await writeFile(join(builtInDirectory, "fixture.txt"), content, "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [
        { oldText: "before", newText: "after" },
        { oldText: "old one\nold two", newText: "new one\nnew two\nnew three" },
      ],
    };

    const extensionTool = loadExtensionTool();
    const preview = renderPreview(extensionTool, extensionDirectory, input, true);
    const [extensionResult] = await Promise.all([
      execute(extensionTool, extensionDirectory, input),
      preview.done,
    ]);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"), "utf8")).toBe(
      await readFile(join(builtInDirectory, "fixture.txt"), "utf8"),
    );
  });

  it("matches built-in byte behavior for invalid UTF-8", async () => {
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    const content = Buffer.from([0xc0, ...Buffer.from("before\n")]);
    await writeFile(join(extensionDirectory, "fixture.txt"), content);
    await writeFile(join(builtInDirectory, "fixture.txt"), content);
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "before", newText: "after!" }],
    };
    const extensionTool = loadExtensionTool();
    const preview = renderPreview(extensionTool, extensionDirectory, input, true);
    const [extensionResult] = await Promise.all([
      execute(extensionTool, extensionDirectory, input),
      preview.done,
    ]);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"))).toEqual(
      await readFile(join(builtInDirectory, "fixture.txt")),
    );
  });

  it("falls back to built-in fuzzy matching", async () => {
    const extensionDirectory = await createDirectory();
    const builtInDirectory = await createDirectory();
    await writeFile(join(extensionDirectory, "fixture.txt"), "const value = ‘before’;\n", "utf8");
    await writeFile(join(builtInDirectory, "fixture.txt"), "const value = ‘before’;\n", "utf8");
    const input: EditToolInput = {
      path: "fixture.txt",
      edits: [{ oldText: "const value = 'before';", newText: "const value = 'after';" }],
    };

    const extensionTool = loadExtensionTool();
    const preview = renderPreview(extensionTool, extensionDirectory, input);
    const [extensionResult] = await Promise.all([
      execute(extensionTool, extensionDirectory, input),
      preview.done,
    ]);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"), "utf8")).toBe(
      await readFile(join(builtInDirectory, "fixture.txt"), "utf8"),
    );
  });
});
