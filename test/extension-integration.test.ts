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

describe("edit accelerator extension", () => {
  it("builds an accelerated interactive preview", async () => {
    initTheme("dark");
    const directory = await createDirectory();
    await writeFile(join(directory, "fixture.txt"), "before\nmiddle\n", "utf8");
    const tool = loadExtensionTool();
    if (!tool.renderCall) throw new Error("Extension did not register a call renderer");
    type RenderCall = NonNullable<typeof tool.renderCall>;
    const identity = (text: string): string => text;
    const theme = new Proxy(
      { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: identity },
      { get: (target, property) => Reflect.get(target, property) ?? identity },
    ) as unknown as Parameters<RenderCall>[1];
    const state = {};
    let component: ReturnType<RenderCall>;
    await new Promise<void>((resolvePreview, rejectPreview) => {
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
      component = tool.renderCall!(
        { path: "fixture.txt", edits: [{ oldText: "before", newText: "after" }] },
        theme,
        context,
      );
    });

    expect(component!.render(80).join("\n")).toContain("after");
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

    const extensionResult = await execute(loadExtensionTool(), extensionDirectory, input);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"), "utf8")).toBe(
      await readFile(join(builtInDirectory, "fixture.txt"), "utf8"),
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

    const extensionResult = await execute(loadExtensionTool(), extensionDirectory, input);
    const builtInResult = await execute(createEditToolDefinition(builtInDirectory), builtInDirectory, input);

    expect(extensionResult).toEqual(builtInResult);
    expect(await readFile(join(extensionDirectory, "fixture.txt"), "utf8")).toBe(
      await readFile(join(builtInDirectory, "fixture.txt"), "utf8"),
    );
  });
});
