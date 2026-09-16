import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEditToolDefinition,
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
    registerTool(tool) {
      registered = tool as unknown as ReturnType<typeof createEditToolDefinition>;
    },
  } as ExtensionAPI);
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
